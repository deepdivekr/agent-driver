import {randomBytes,randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {type SurfaceFrame} from '../observability/surfaces.js';
import {type SwarmRunSnapshot} from './contracts.js';
import {sanitizeSwarmEndpoint} from './dashboard.js';
import {authSite,authSites,connectOwnedBrowser,detectAuthGate,setSiteAuth} from './browser-auth.js';
import {assertAutomatedBrowserAllowed} from './account-browser-policy.js';

export type VisualCommand={action:'navigate';url:string}|{action:'observe'}|{action:'scroll';direction:'up'|'down'};
export interface VisualObservation {surface_id:string;url:string;title:string;text:string;links:Array<{text:string;url:string}>;captured_at:string;}
interface Slot {id:string;run:string;worker:string;lease:string;context:BrowserContext;page:Page;links:Set<string>;steps:number;frame:SurfaceFrame|null;capturing:Promise<void>|null;busy:boolean;closed:boolean;}
interface VisualOptions {max_contexts?:number;frame_interval_ms?:number;/** Native fixture only; production never permits loopback pages or injected owned browsers. */ fixture_origins?:string[];fixture_owned_connect?:()=>Promise<Browser>;}
const privateAddress=(address:string)=>{
  if(address.includes(':'))return !/^2[0-9a-f]{3}:/iu.test(address)&&!/^3[0-9a-f]{3}:/iu.test(address);
  const parts=address.split('.').map(Number),a=parts[0]!,b=parts[1]!;
  return a===0||a===10||a===127||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a>=224||a===198&&(b===18||b===19);
};

/** A page + non-persistent BrowserContext per lease, not a separate security VM. */
export class SwarmVisualExecutor {
  #slots=new Map<string,Promise<Slot>>();#browser:Promise<Browser>|null=null;#server:Promise<{server:Server;origin:string}>|null=null;
  #token=randomBytes(24).toString('hex');#timer:ReturnType<typeof setInterval>;#closed=false;#active=0;
  #dns=new Map<string,{at:number;allowed:boolean}>();readonly maxContexts:number;
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly options:VisualOptions={}){
    this.maxContexts=options.max_contexts??config.swarm?.visual.max_contexts??16;
    requireCondition(Number.isInteger(this.maxContexts)&&this.maxContexts>=1&&this.maxContexts<=32,'CONTROL_POOL_CAPACITY_INVALID');
    requireCondition(!options.fixture_origins?.length||config.environment==='fixture','CONTROL_FIXTURE_ORIGIN_FORBIDDEN');
    requireCondition(!options.fixture_owned_connect||config.environment==='fixture','CONTROL_FIXTURE_CONNECT_FORBIDDEN');
    this.#timer=setInterval(()=>{for(const pending of this.#slots.values())void pending.then(slot=>{
      if(slot.closed)return;
      try{this.lease(slot.run,slot.worker,slot.lease);}catch{void this.release(slot.run,slot.worker);return;}
      void this.capture(slot);
    }).catch(()=>{});},options.frame_interval_ms??config.swarm?.visual.frame_interval_ms??1_000);this.#timer.unref();
  }
  private lease(runId:string,workerId:string,token:string){
    const snapshot=this.store.swarmRun(this.config.project.id,runId).snapshot as SwarmRunSnapshot,worker=snapshot.workers[workerId];
    requireCondition(snapshot.status==='running'&&worker?.status==='leased'&&worker.lease_token===token&&(worker.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
    const definition=snapshot.plan.workers.find(item=>item.id===workerId)!;
    requireCondition(definition.effect==='read_only'&&['discovery','source_read','verification'].includes(definition.stage)&&definition.source_urls.length>0,'CONTROL_VISUAL_WORKER_UNSUPPORTED');
    return {snapshot,definition};
  }
  private async publicUrl(value:string){
    const url=new URL(value);requireCondition(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&value.length<=4096,'CONTROL_BROWSER_URL_INVALID');
    if(this.config.environment==='fixture'&&this.options.fixture_origins?.includes(url.origin))return url;
    requireCondition(!url.port||['80','443'].includes(url.port),'CONTROL_BROWSER_PORT_FORBIDDEN');
    const host=url.hostname.replace(/^\[|\]$/gu,'').toLowerCase();
    requireCondition(!host.endsWith('.localhost')&&!host.endsWith('.local')&&host!=='localhost'&&host.includes('.'),'CONTROL_BROWSER_PRIVATE_ADDRESS');
    if(isIP(host)){requireCondition(!privateAddress(host),'CONTROL_BROWSER_PRIVATE_ADDRESS');return url;}
    const cached=this.#dns.get(host);if(cached&&Date.now()-cached.at<30_000){requireCondition(cached.allowed,'CONTROL_BROWSER_PRIVATE_ADDRESS');return url;}
    const addresses=await lookup(host,{all:true});const allowed=addresses.length>0&&addresses.every(item=>!privateAddress(item.address));
    this.#dns.set(host,{at:Date.now(),allowed});requireCondition(allowed,'CONTROL_BROWSER_PRIVATE_ADDRESS');return url;
  }
  private server(){
    return this.#server??=new Promise<{server:Server;origin:string}>((resolve,reject)=>{
      const server=createServer(async(request,response)=>{
        const address=server.address();if(!address||typeof address==='string'){response.writeHead(503).end();return;}
        if(request.method!=='GET'||request.headers.host!==`127.0.0.1:${address.port}`||request.headers.origin){response.writeHead(403).end();return;}
        const prefix=`/${this.#token}/frame/`,path=request.url??'';
        if(!path.startsWith(prefix)){response.writeHead(404).end();return;}
        const id=path.slice(prefix.length);const slots=await Promise.allSettled([...this.#slots.values()]);
        const slot=slots.flatMap(item=>item.status==='fulfilled'?[item.value]:[]).find(item=>item.id===id);
        if(!slot?.frame){response.writeHead(503,{'Cache-Control':'no-store'}).end();return;}
        response.writeHead(200,{'Content-Type':'image/jpeg','Content-Length':slot.frame.body.length,'Cache-Control':'no-store','X-Captured-At':slot.frame.captured_at,'X-Surface-State':slot.closed?'closed':'active','X-Content-Type-Options':'nosniff'}).end(slot.frame.body);
      });server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){reject(Error('CONTROL_PREVIEW_LISTEN_FAILED'));return;}server.unref();resolve({server,origin:`http://127.0.0.1:${address.port}`});});
    });
  }
  private async capture(slot:Slot){
    if(slot.closed)return;
    if(this.config.swarm?.visual.owned_vm){
      if(authSites(this.store,this.config).some(site=>site.handoff)||await slot.page.locator('input[type="password"]').first().isVisible().catch(()=>true)||/\/(?:login|signin|i\/flow\/login)(?:\/|$)/u.test(new URL(slot.page.url()).pathname)){slot.frame=null;return;}
    }
    return slot.capturing??=(async()=>{try{const body=await slot.page.screenshot({type:'jpeg',quality:52,scale:'css',timeout:2_000});if(body.length<=4_194_304)slot.frame={content_type:'image/jpeg',body,captured_at:new Date().toISOString()};}catch{/* Keep timestamped last frame; never invent a fresh frame. */}finally{slot.capturing=null;}})();
  }
  private activity(slot:Slot,kind:'started'|'navigating'|'observing',summary:string){
    const {snapshot}=this.lease(slot.run,slot.worker,slot.lease);
    this.store.recordSwarmActivity(this.config.project.id,slot.run,snapshot.revision,slot.worker,'worker.activity',{activity_kind:kind,summary,endpoint:sanitizeSwarmEndpoint(slot.page.url()),surface_id:slot.id,decision_layer:'code'});
  }
  async assign(runId:string,workerId:string,leaseToken:string){
    requireCondition(!this.#closed,'CONTROL_POOL_CLOSED');const leased=this.lease(runId,workerId,leaseToken);for(const url of leased.definition.source_urls)assertAutomatedBrowserAllowed(url);const key=`${runId}:${workerId}`;
    const previous=this.#slots.get(key);if(previous){const slot=await previous;if(slot.closed)this.#slots.delete(key);else{requireCondition(slot.lease===leaseToken,'CONTROL_SURFACE_LEASE_CONFLICT');return {surface_id:slot.id,kind:'browser' as const};}}
    requireCondition(this.#active<this.maxContexts,'CONTROL_POOL_CAPACITY_EXCEEDED');this.#active++;
    const pending=(async()=>{
      let context:BrowserContext|undefined,page:Page|undefined;const persistent=!!this.config.swarm?.visual.owned_vm;
      try{
        const [browser,server]=await Promise.all([this.#browser??=(persistent?(this.options.fixture_owned_connect?.()??connectOwnedBrowser(this.config)):chromium.launch({headless:true})),this.server()]);
        requireCondition(!this.#closed,'CONTROL_POOL_CLOSED');
        context=persistent?browser.contexts()[0]:await browser.newContext({viewport:{width:1024,height:640},locale:'en-US',acceptDownloads:false,serviceWorkers:'block'});
        requireCondition(context,'AUTH_PROFILE_MISSING');page=await context!.newPage();await page.setViewportSize({width:1024,height:640});
        await page.route('**/*',async route=>{try{await this.publicUrl(route.request().url());if(route.request().isNavigationRequest())requireCondition(route.request().method()==='GET','CONTROL_READ_ONLY_NAVIGATION');await route.continue();}catch{await route.abort('blockedbyclient').catch(()=>{});}});
        page.on('popup',popup=>{void popup.close();});page.on('download',download=>{void download.cancel();});
        const slot:Slot={id:`browser-${randomUUID()}`,run:runId,worker:workerId,lease:leaseToken,context:context!,page,links:new Set(),steps:0,frame:null,capturing:null,busy:false,closed:false};
        this.lease(runId,workerId,leaseToken);requireCondition(!this.#closed,'CONTROL_POOL_CLOSED');
        this.store.bindControlSurface(this.config.project.id,runId,workerId,leaseToken,slot.id,`${server.origin}/${this.#token}/frame/${slot.id}`);
        this.activity(slot,'started',persistent?'Independent page assigned in the persistent owned VM profile':'Independent headless browser assigned');await this.capture(slot);return slot;
      }catch(error){if(persistent)await page?.close().catch(()=>{});else await context?.close().catch(()=>{});this.#active--;throw error;}
    })();this.#slots.set(key,pending);
    try{const slot=await pending;return {surface_id:slot.id,kind:'browser' as const};}catch(error){this.#slots.delete(key);throw error;}
  }
  async perform(runId:string,workerId:string,leaseToken:string,command:VisualCommand):Promise<VisualObservation>{
    const {definition}=this.lease(runId,workerId,leaseToken);await this.assign(runId,workerId,leaseToken);const slot=await this.#slots.get(`${runId}:${workerId}`)!;
    requireCondition(!slot.busy,'CONTROL_BROWSER_BUSY');requireCondition(slot.steps<definition.max_steps,'CONTROL_BROWSER_STEP_LIMIT');slot.busy=true;slot.steps++;
    try{
      if(command.action==='navigate'){
        const url=await this.publicUrl(command.url);requireCondition(definition.source_urls.includes(command.url)||slot.links.has(command.url),'CONTROL_BROWSER_URL_NOT_OBSERVED');
        this.activity(slot,'navigating',`Opening ${sanitizeSwarmEndpoint(command.url)??url.hostname}`);
        await slot.page.goto(command.url,{waitUntil:'domcontentloaded',timeout:20_000});
        // Hydrated pages may be empty at DOMContentLoaded. Wait on evidence, not a fixed sleep.
        await slot.page.waitForFunction(()=>Boolean(document.body&&document.body.innerText.trim().length>=60),null,{timeout:5_000}).catch(()=>{});
      }else if(command.action==='scroll'){this.activity(slot,'observing','Scrolling the assigned page');await slot.page.mouse.wheel(0,command.direction==='down'?480:-480);}
      this.lease(runId,workerId,leaseToken);requireCondition(slot.page.url()!=='about:blank','CONTROL_BROWSER_PAGE_EMPTY');
      await this.publicUrl(slot.page.url());
      const raw=await slot.page.evaluate(()=>({url:location.href,title:document.title,text:document.body?.innerText.slice(0,24_000)??'',links:Array.from(document.querySelectorAll('a[href]')).map(a=>({text:(a.textContent??'').trim().slice(0,160),url:(a as HTMLAnchorElement).href})).filter(a=>a.text&&/^https?:/u.test(a.url)).slice(0,120)}));
      if(this.config.swarm?.visual.owned_vm){
        const gate=detectAuthGate(raw.url,raw.title,raw.text,await slot.page.locator('input[type="password"]').first().isVisible().catch(()=>false));
        if(gate){slot.frame=null;setSiteAuth(this.store,this.config,authSite(command.action==='navigate'?command.url:definition.source_urls[0]!),gate);throw Error('BROWSER_AUTH_REQUIRED');}
      }
      const links=raw.links.filter(link=>{try{const url=new URL(link.url);return !url.username&&!url.password&&link.url.length<=4096;}catch{return false;}});
      for(const link of links)slot.links.add(link.url);
      requireCondition(slot.links.size<=2_000,'CONTROL_BROWSER_LINK_LIMIT');
      this.store.recordObservedUrl(this.config.project.id,runId,workerId,leaseToken,raw.url);
      this.activity(slot,'observing','Page text and observed links read');await this.capture(slot);
      return {...raw,links,surface_id:slot.id,captured_at:new Date().toISOString()};
    }finally{slot.busy=false;}
  }
  async release(runId:string,workerId:string){
    const pending=this.#slots.get(`${runId}:${workerId}`);if(!pending)return;let slot:Slot;try{slot=await pending;}catch{return;}
    if(slot.closed)return;slot.closed=true;this.#active--;this.store.endControlSurface(this.config.project.id,runId,workerId,'closed');if(this.config.swarm?.visual.owned_vm)await slot.page.close().catch(()=>{});else await slot.context.close().catch(()=>{});
  }
  async close(){
    if(this.#closed)return;this.#closed=true;clearInterval(this.#timer);
    await Promise.allSettled([...this.#slots.keys()].map(key=>{const split=key.indexOf(':');return this.release(key.slice(0,split),key.slice(split+1));}));
    if(this.#browser)await (await this.#browser.catch(()=>null))?.close().catch(()=>{});
    if(this.#server){const service=await this.#server.catch(()=>null);if(service)await new Promise<void>(resolve=>{service.server.close(()=>resolve());service.server.closeAllConnections();});}
  }
}
