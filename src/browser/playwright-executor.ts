import {join} from 'node:path';
import {access} from 'node:fs/promises';
import {type Browser,type BrowserContext,type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {connectOwnedBrowser} from '../swarm/browser-auth.js';
import {type BrowserPort,type BrowserTarget,type BrowserExtraction,observationScript,extractionScript,browserObservationSchema} from './executor-contracts.js';
import {acquirePersistentProfile,assertPersistentProfileAutomationAllowed,isPersistentProfile,persistentProfileError,type PersistentProfileLease} from './persistent-profile.js';

export class PlaywrightBrowserExecutor implements BrowserPort {
  private static pools=new Map<string,{browser:Promise<Browser>;refs:number}>();
  private poolKey:string|null=null;
  private unknownDialog=false;
  private savedProfile:PersistentProfileLease|null=null;
  private context:BrowserContext|null=null;private browser:Browser|null=null;private page:Page|null=null;
  constructor(readonly target:BrowserTarget,readonly config:HostConfig,readonly profileKey:string,readonly ephemeral=false){}
  async probe(){
    requireCondition(this.target.platform===process.platform,'BROWSER_HOST_PLATFORM_MISMATCH');
    requireCondition(this.target.environment!=='windows_vm','BROWSER_GUEST_TRANSPORT_UNVERIFIED');
    if(this.target.environment==='ubuntu_vm'){
      requireCondition(this.config.swarm?.visual.owned_vm,'BROWSER_VM_NOT_CONFIGURED');
      this.browser??=await connectOwnedBrowser(this.config);
    }else await access((await import('playwright')).chromium.executablePath());
  }
  async open(url:string){
    await this.probe();requireCondition(!this.page,'BROWSER_TAB_ALREADY_OPEN');
    if(this.target.environment==='ubuntu_vm'){
      this.context=this.browser!.contexts()[0]!;requireCondition(this.context,'BROWSER_VM_CONTEXT_MISSING');this.page=await this.context.newPage();
    }else if(isPersistentProfile(this.target)){
      this.savedProfile=await acquirePersistentProfile(this.config,this.target,'automation');
      this.context=this.savedProfile.context;this.page=await this.context.newPage();
    }else if(this.ephemeral&&this.target.environment==='owned_headless'){
      const key=`${this.config.dbPath}:${this.target.id}`;let pool=PlaywrightBrowserExecutor.pools.get(key);
      if(!pool){pool={browser:import('playwright').then(({chromium})=>chromium.launch({headless:true})),refs:0};PlaywrightBrowserExecutor.pools.set(key,pool);}
      pool.refs++;this.poolKey=key;this.context=await (await pool.browser).newContext({acceptDownloads:false,serviceWorkers:'block'});this.page=await this.context.newPage();
    }else{
      try{this.context=await (await import('playwright')).chromium.launchPersistentContext(join(this.config.project.profileRef,'browser-executors',this.target.profile_ref,this.profileKey),{headless:this.target.environment==='owned_headless',acceptDownloads:false,serviceWorkers:'block'});}
      catch(error){persistentProfileError(error);}
      this.page=this.context.pages()[0]??await this.context.newPage();
    }
    // Collection/Swarm port never submits a form, posts a record or opens a new uncontrolled window.
    await this.page.route('**/*',route=>['GET','HEAD','OPTIONS'].includes(route.request().method())?route.continue():route.abort('blockedbyclient'));
    this.page.on('dialog',dialog=>{this.unknownDialog=true;void dialog.dismiss();});this.page.on('popup',page=>{void page.close();});this.page.on('download',download=>{void download.cancel();});
    await this.navigate(url);
  }
  async navigate(url:string){requireCondition(this.page,'BROWSER_TAB_NOT_OPEN');assertPersistentProfileAutomationAllowed(this.config,this.target);await this.page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});}
  async observe(){
    requireCondition(this.page,'BROWSER_TAB_NOT_OPEN');
    assertPersistentProfileAutomationAllowed(this.config,this.target);
    const page=this.page,deadline=Date.now()+3000;
    // A read can race a redirect after domcontentloaded. Only wait/read the same
    // live page; this never reopens a URL, changes executor, or grants an origin.
    for(let attempt=0;attempt<3;attempt++){
      requireCondition(this.page===page&&!page.isClosed(),'BROWSER_TAB_NOT_OPEN');
      requireCondition(!this.unknownDialog,'PACK_UNKNOWN_DIALOG');
      const remaining=deadline-Date.now();requireCondition(remaining>0,'BROWSER_OBSERVATION_NAVIGATING');
      try{
        await page.waitForFunction(()=>document.readyState!=='loading'&&document.body!==null,{},{timeout:remaining});
        const observation=await page.evaluate(`(() => {
          if(document.readyState==='loading'||!document.body)return null;
          return (${observationScript()})();
        })()`);
        requireCondition(this.page===page&&!page.isClosed(),'BROWSER_TAB_NOT_OPEN');
        requireCondition(!this.unknownDialog,'PACK_UNKNOWN_DIALOG');
        requireCondition(observation!==null,'BROWSER_OBSERVATION_NAVIGATING');
        return browserObservationSchema.parse(observation);
      }catch(error){
        if(!(error instanceof Error)||!error.message.includes('Execution context was destroyed, most likely because of a navigation'))throw error;
        if(attempt===2)requireCondition(false,'BROWSER_OBSERVATION_NAVIGATING');
      }
    }
    throw new Error('BROWSER_OBSERVATION_NAVIGATING');
  }
  async extract(spec:BrowserExtraction){
    requireCondition(this.page,'BROWSER_TAB_NOT_OPEN');requireCondition(!this.unknownDialog,'PACK_UNKNOWN_DIALOG');
    assertPersistentProfileAutomationAllowed(this.config,this.target);
    // Authentication and dialogs are terminal observations, not missing-ready
    // timeouts. Use the same visibility rule as extraction before reading rows.
    await this.page.waitForFunction(({ready,auth_gate})=>{
      const visible=(element:Element)=>!!element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden';
      return [auth_gate,'[role="dialog"],dialog[open]',ready].some(selector=>Array.from(document.querySelectorAll(selector)).some(visible));
    },{ready:spec.ready,auth_gate:spec.auth_gate},{timeout:10000});
    requireCondition(!this.unknownDialog,'PACK_UNKNOWN_DIALOG');
    try{return await this.page.evaluate(`(${extractionScript(spec)})()`) as Array<Record<string,string>>;}
    catch(error){
      // Playwright wraps page errors with an API prefix and stack. Preserve only
      // our exact domain codes so an auth/account gate cannot become a retry.
      const code=error instanceof Error?error.message.match(/(?:^|\n|: )(PACK_WAITING_AUTH|PACK_UNKNOWN_DIALOG|PACK_ACCOUNT_MISMATCH|BROWSER_NOT_READY|SOURCE_TOO_MANY_ROWS|SOURCE_FIELD_AMBIGUOUS)(?=\n|$)/u)?.[1]:undefined;
      if(code)throw Error(code,{cause:error});throw error;
    }
  }
  async scroll(direction:'up'|'down'){requireCondition(this.page,'BROWSER_TAB_NOT_OPEN');assertPersistentProfileAutomationAllowed(this.config,this.target);await this.page.mouse.wheel(0,direction==='down'?480:-480);}
  async close(){
    if(this.savedProfile){try{await this.page?.close().catch(()=>{});}finally{await this.savedProfile.release();this.savedProfile=null;}}
    else if(this.browser){await this.page?.close().catch(()=>{});await this.browser.close().catch(()=>{});}else await this.context?.close().catch(()=>{});
    if(this.poolKey){const pool=PlaywrightBrowserExecutor.pools.get(this.poolKey);if(pool&&--pool.refs===0){PlaywrightBrowserExecutor.pools.delete(this.poolKey);await (await pool.browser.catch(()=>null))?.close().catch(()=>{});}this.poolKey=null;}
    this.page=null;this.context=null;this.browser=null;
  }
}
