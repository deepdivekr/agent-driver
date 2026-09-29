import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,chmodSync} from 'node:fs';
import {delimiter,dirname,join,basename} from 'node:path';
import {homedir} from 'node:os';
import {createRequire} from 'node:module';
import {HostConfigSchema,type HostConfig} from '../interface/config.js';
import {browserTargetSchema,type BrowserTarget} from '../browser/executor-contracts.js';
import {nativeProcessRunner,type SafeProcessRunner} from '../integrations/subscription-auth.js';

type Engine='playwright'|'aside'|'neo';
export const browserSetupGuides={
  playwright:{label:'Playwright',docs:'https://playwright.dev/docs/browsers',setup:'기본 백그라운드 브라우저입니다. 브라우저 파일이 없으면 준비 버튼을 누르세요.',auth:'별도 서비스 계정은 필요 없습니다. 사이트 로그인은 업무가 요청할 때 진행합니다.'},
  aside:{label:'Aside',docs:'https://docs.aside.com/help/get-started',download:'https://aside.com/download',connection:'https://docs.aside.com/help/developers',setup:'사용할 컴퓨터에 Aside를 설치·실행한 뒤 Settings → Developers에서 CLI를 설치하세요.',auth:'Aside의 첫 실행·로그인은 Aside에서 완료하세요. 로컬 연결은 --host local을 사용하며, 사이트 로그인은 별도입니다.'},
  neo:{label:'BrowserOS Neo',docs:'https://www.browseros.com/',download:'https://www.browseros.com/',connection:'https://docs.browseros.com/',setup:'사용할 컴퓨터에 Neo를 설치·실행하고 로컬 MCP 연결을 켜세요. 기본 주소는 127.0.0.1:9010/mcp입니다.',auth:'필요한 첫 실행·로그인은 Neo에서 완료하세요. Agent Office는 비밀번호나 로그인 토큰을 복사하지 않습니다.'},
} as const;

const revision=(text:string)=>createHash('sha256').update(text).digest('hex');
function fail(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message);}
interface Dependencies {runner?:SafeProcessRunner;detectAside?:()=>Promise<string|null>;probe?:(target:BrowserTarget)=>Promise<void>;platform?:NodeJS.Platform;environment?:NodeJS.ProcessEnv;}
/** Optional local browsers. GET never launches an app or prompts for authentication. */
export class BrowserSetupController {
  private checks=new Map<Engine,{target:BrowserTarget|null;health:'ready'|'unavailable';reason:'ready'|'cli_missing'|'connection_unavailable';at:number;elapsed_ms:number}>();
  private readonly platform:NodeJS.Platform;private readonly environment:NodeJS.ProcessEnv;private readonly runner:SafeProcessRunner;
  private readonly initialRevision:string;
  constructor(readonly config:HostConfig,readonly dependencies:Dependencies={}){this.platform=dependencies.platform??process.platform;this.environment=dependencies.environment??process.env;this.runner=dependencies.runner??nativeProcessRunner;this.initialRevision=revision(readFileSync(config.path,'utf8'));}
  private raw(){const entry=lstatSync(this.config.path);fail(entry.isFile()&&!entry.isSymbolicLink()&&entry.nlink===1&&entry.size<=16_384,'BROWSER_SETUP_UNSAFE_CONFIG');const text=readFileSync(this.config.path,'utf8');return {text,raw:HostConfigSchema.parse(JSON.parse(text))};}
  view(){const {text,raw}=this.raw();return {revision:revision(text),default_engine:'playwright',optional:true,rows:(['playwright','aside','neo'] as const).map(engine=>{const checked=this.checks.get(engine),fresh=checked&&Date.now()-checked.at<300_000;return {engine,...browserSetupGuides[engine],registered:engine==='playwright'&&!raw.browser_executors||Boolean(raw.browser_executors?.targets.some(t=>t.engine===engine&&(engine==='playwright'?t.environment==='owned_headless':t.environment==='host_foreground'))),health:fresh?checked.health:'unchecked',reason:fresh?checked.reason:'unchecked',elapsed_ms:checked?.elapsed_ms??null,checked_at:checked?new Date(checked.at).toISOString():null,verified_for_environment:false};}),restart_required:revision(text)!==this.initialRevision,site_login_deferred:true,credentials_exposed:false};}
  private defaultTarget(){return browserTargetSchema.parse({id:'playwright',engine:'playwright',environment:'owned_headless',platform:this.platform,profile_ref:'default',priority:50});}
  private async aside(){
    if(this.dependencies.detectAside)return this.dependencies.detectAside();
    const name=this.platform==='win32'?'aside.exe':'aside',candidates=(this.environment.PATH??'').split(delimiter).filter(Boolean).map(dir=>join(dir,name));
    if(this.platform==='win32'&&this.environment.LOCALAPPDATA)candidates.unshift(join(this.environment.LOCALAPPDATA,'Aside','CLI','current','aside.exe'));
    candidates.push(join(homedir(),'.local','bin',name));
    if(this.platform==='linux'&&this.environment.WSL_DISTRO_NAME){
      const executable='/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
      if(existsSync(executable))try{const result=await this.runner.run({executable,args:['-NoProfile','-NonInteractive','-Command','[Environment]::GetFolderPath("LocalApplicationData")'],timeout_ms:5000});const path=result.stdout.trim();if(result.code===0&&/^[A-Za-z]:\\[^\r\n]+$/u.test(path))candidates.unshift(`/mnt/${path[0]!.toLowerCase()}/${path.slice(3).replaceAll('\\','/')}/Aside/CLI/current/aside.exe`);}catch{/* WSL interop is optional. */}
    }
    return candidates.find(path=>existsSync(path)&&/^aside(?:\.exe)?$/iu.test(basename(path)))??null;
  }
  private async target(engine:Engine){
    const existing=this.raw().raw.browser_executors?.targets.find(t=>t.engine===engine&&(engine==='playwright'?t.environment==='owned_headless':t.environment==='host_foreground'));
    if(existing)return existing;
    if(engine==='playwright')return this.defaultTarget();
    const executable=engine==='aside'?await this.aside():null;if(engine==='aside'&&!executable)return null;
    return browserTargetSchema.parse({id:`office-${engine}`,engine,environment:'host_foreground',platform:executable?.endsWith('.exe')||engine==='neo'&&this.environment.WSL_DISTRO_NAME?'win32':this.platform,profile_ref:`${engine}-local`,priority:engine==='aside'?70:80,...(engine==='aside'?{executable}:{endpoint:'http://127.0.0.1:9010/mcp'})});
  }
  async check(engine:Engine){
    const start=performance.now(),target=await this.target(engine);let health:'ready'|'unavailable'='unavailable';
    if(target)try{
      if(this.dependencies.probe)await this.dependencies.probe(target);
      else if(engine==='playwright'){const {chromium}=await import('playwright');const browser=await chromium.launch({headless:true,timeout:15000});await browser.close();}
      else {const {McpBrowserExecutor}=await import('../browser/mcp-executor.js');const port=new McpBrowserExecutor(target);try{await port.probe();}finally{await port.close();}}
      health='ready';
    }catch{/* Raw provider output may contain profile or account data. */}
    this.checks.set(engine,{target,health,reason:health==='ready'?'ready':!target?'cli_missing':'connection_unavailable',at:Date.now(),elapsed_ms:Math.round(performance.now()-start)});return this.view();
  }
  async installPlaywright(){
    const cli=join(dirname(createRequire(import.meta.url).resolve('playwright/package.json')),'cli.js');
    const result=await this.runner.run({executable:process.execPath,args:[cli,'install','chromium'],timeout_ms:180_000});
    fail(result.code===0,'BROWSER_SETUP_INSTALL_FAILED');return this.check('playwright');
  }
  register(engine:'aside'|'neo',expected:string,consent:boolean){
    fail(consent===true,'BROWSER_SETUP_CONSENT_REQUIRED');
    const checked=this.checks.get(engine);fail(checked?.health==='ready'&&checked.target&&Date.now()-checked.at<300_000,'BROWSER_SETUP_CHECK_REQUIRED');
    const {text,raw}=this.raw();fail(revision(text)===expected,'BROWSER_SETUP_CONFLICT');
    const targets=[...raw.browser_executors?.targets??[]];
    if(targets.some(t=>JSON.stringify(t)===JSON.stringify(checked.target)))return this.view();
    if(!targets.some(t=>t.engine==='playwright'&&t.environment==='owned_headless')){const fallback=this.defaultTarget();if(targets.some(t=>t.id===fallback.id))fallback.id='office-playwright';fail(!targets.some(t=>t.id===fallback.id),'BROWSER_SETUP_TARGET_CONFLICT');targets.push(fallback);}
    fail(!targets.some(t=>t.id===checked.target!.id),'BROWSER_SETUP_TARGET_CONFLICT');
    // Registration augments the host policy, never replaces an existing VM/profile or drops Playwright.
    const next={...JSON.parse(text) as Record<string,unknown>,browser_executors:{targets:[...targets,checked.target]}};HostConfigSchema.parse(next);const output=JSON.stringify(next,null,2)+'\n';
    fail(Buffer.byteLength(output)<=16_384,'BROWSER_SETUP_CONFIG_TOO_LARGE');
    const backup=join(dirname(this.config.path),`.browser-setup-${randomUUID()}.backup.json`),temporary=backup+'.tmp';
    writeFileSync(backup,text,{flag:'wx',mode:0o600});
    try{writeFileSync(temporary,output,{flag:'wx',mode:0o600});fail(readFileSync(this.config.path,'utf8')===text,'BROWSER_SETUP_CONFLICT');renameSync(temporary,this.config.path);chmodSync(this.config.path,0o600);}finally{if(existsSync(temporary))unlinkSync(temporary);}
    return this.view();
  }
}
