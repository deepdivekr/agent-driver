import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {type IncomingMessage,type ServerResponse} from 'node:http';
import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {displayOptionsHtml,sidebarHtml,themeScript,uiCss} from './ui-shell.js';
import {i18nScript} from './i18n.js';
import {loginVmStatus} from '../swarm/login-vm.js';
import {BrowserLoginBroker,authSite,authSites,knownLoginSites,migrateOwnedProfileAuthMode,siteLoginTargets} from '../swarm/browser-auth.js';
import {McpBrowserExecutor} from '../browser/mcp-executor.js';
import {browserHostCompatible,type BrowserTarget} from '../browser/executor-contracts.js';
import {hasHeadedDisplay} from '../browser/persistent-profile.js';
import {BrowserSetupController} from '../onboarding/browser-setup.js';

type LoginChoice={id:string;environment:'windows'|'owned_headless'|'ubuntu'|'windows_vm';engine:'playwright'|'neo'|'aside'|null;label:string;availability:'ready'|'available'|'stopped'|'unavailable'|'unsupported'|'not_configured'|'profile_setup_required'|'display_required'|'browser_required';profile_preserved:boolean;profile_preservation_basis:'configuration_only';session_mode:'isolated'|'persistent'|'external'|null;can_enable_profile:boolean;display_observed:boolean|null;reason:string|null};

async function openViewer(port:number){
  // Only a local user's explicit Open login click may invoke a foreground viewer.
  const candidates=process.platform==='win32'?['C:\\Program Files\\TigerVNC\\vncviewer.exe']:process.env.WSL_DISTRO_NAME?['/mnt/c/Program Files/TigerVNC/vncviewer.exe']:[];
  for(const executable of candidates){try{await access(executable);await new Promise<void>((resolve,reject)=>{const child=spawn(executable,[`127.0.0.1::${port}`],{shell:false,detached:true,stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return true;}catch{}}
  return false;
}
export class BrowserConnections {
  readonly broker:BrowserLoginBroker;
  readonly setup:BrowserSetupController;
  private busy=false;
  private vmSnapshot:{state:string;at:number}|null=null;
  private targetSnapshot:{targets:LoginChoice[];at:number}|null=null;
  private async vmState(){if(!this.vmSnapshot||Date.now()-this.vmSnapshot.at>2000)this.vmSnapshot={state:await loginVmStatus(this.config),at:Date.now()};return this.vmSnapshot.state;}
  private async targets(){
    if(this.targetSnapshot&&Date.now()-this.targetSnapshot.at<15_000)return this.targetSnapshot.targets;
    const configured=siteLoginTargets(this.config);
    const targets:LoginChoice[]=await Promise.all(configured.map(async (target:BrowserTarget):Promise<LoginChoice>=>{
      const environment:LoginChoice['environment']=target.environment==='windows_vm'?'windows_vm':target.environment==='ubuntu_vm'?'ubuntu':target.environment==='owned_headless'?'owned_headless':'windows';
      const platformLabel=target.platform==='win32'?'Windows':target.platform==='darwin'?'macOS':'Linux';
      const label=`${environment==='windows'?platformLabel:environment==='ubuntu'?'Ubuntu VM':environment==='owned_headless'?process.env.WSL_DISTRO_NAME&&target.platform==='linux'?'WSL':platformLabel:'Windows VM'} · ${target.engine==='playwright'?'Playwright':target.engine==='neo'?'BrowserOS Neo':'Aside'}`;
      const owned=target.environment==='owned_headless'&&target.engine==='playwright',supported=target.environment!=='windows_vm'&&!(target.environment==='host_foreground'&&target.engine==='playwright')&&!(target.environment==='ubuntu_vm'&&target.engine!=='playwright');
      const choice={id:target.id,environment,engine:target.engine,label,profile_preserved:supported&&(!owned||target.session_mode==='persistent'),profile_preservation_basis:'configuration_only' as const,session_mode:owned?target.session_mode??'isolated':supported?'external' as const:null,can_enable_profile:owned&&browserHostCompatible(target),display_observed:owned?hasHeadedDisplay():null,reason:null};
      if(!supported)return {...choice,availability:'unsupported',reason:'AUTH_BROWSER_TRANSPORT_UNAVAILABLE'};
      if(owned){
        if(!browserHostCompatible(target))return {...choice,availability:'unavailable',reason:'AUTH_BROWSER_TRANSPORT_UNAVAILABLE'};
        try{const {chromium}=await import('playwright');await access(chromium.executablePath());}catch{return {...choice,availability:'browser_required',reason:'AUTH_BROWSER_INSTALL_REQUIRED'};}
        if(!hasHeadedDisplay())return {...choice,availability:'display_required',reason:'AUTH_HEADED_DISPLAY_UNAVAILABLE'};
        return {...choice,availability:target.session_mode==='persistent'?'available':'profile_setup_required',reason:target.session_mode==='persistent'?null:'AUTH_PERSISTENT_PROFILE_REQUIRED'};
      }
      if(target.environment==='ubuntu_vm'){
        const state=await this.vmState();return {...choice,availability:state==='running'?'ready' as const:state==='stopped'?'stopped' as const:'unavailable' as const};
      }
      if(!browserHostCompatible(target))return {...choice,availability:'unavailable' as const};
      const port=new McpBrowserExecutor(target);
      try{await port.probe();return {...choice,availability:'ready' as const};}
      catch{return {...choice,availability:'unavailable' as const};}
      finally{await port.close().catch(()=>{});}
    }));
    for(const [environment,label] of [['windows','Windows 브라우저'],['owned_headless','WSL · Playwright'],['ubuntu','Ubuntu VM'],['windows_vm','Windows VM']] as const){
      if(!targets.some(item=>item.environment===environment))targets.push({id:'',environment,engine:null,label,availability:environment==='windows_vm'?'unsupported':'not_configured',profile_preserved:false,profile_preservation_basis:'configuration_only',session_mode:null,can_enable_profile:false,display_observed:null,reason:environment==='windows_vm'?'AUTH_BROWSER_TRANSPORT_UNAVAILABLE':null});
    }
    this.targetSnapshot={targets,at:Date.now()};return targets;
  }
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly options:{reloadAvailable?:boolean}={}){this.broker=new BrowserLoginBroker(store,config);this.setup=new BrowserSetupController(config);}
  get reloadBlockedReason(){return this.busy?'CONNECTION_ACTION_IN_PROGRESS':[undefined,...siteLoginTargets(this.config)].some(target=>authSites(this.store,this.config,target).some(site=>site.handoff))?'BROWSER_LOGIN_IN_PROGRESS':null;}
  async handle(request:IncomingMessage,response:ServerResponse,suffix:string,host:string){
    if(!suffix.startsWith('connections'))return false;
    const nonce=randomBytes(18).toString('base64url');
    const send=(code:number,body:unknown,html=false)=>{response.writeHead(code,{'Content-Type':html?'text/html; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});response.end(html?String(body):JSON.stringify(body));};
    if(suffix==='connections'&&request.method==='GET'){send(200,connectionHtml(nonce),true);return true;}
    if(suffix==='connections/status'&&request.method==='GET'){
      const vm=this.config.swarm?.visual.owned_vm,targets=await this.targets(),configured=siteLoginTargets(this.config),setup=this.setup.view();
      const profiles=new Map(configured.map(target=>[target.id,authSites(this.store,this.config,target)])),sites=new Map(authSites(this.store,this.config).map(site=>[site.site,site]));
      for(const rows of profiles.values())for(const site of rows)if(!sites.has(site.site))sites.set(site.site,site);
      send(200,{sites:[...sites.values()].map(site=>({...site,label:knownLoginSites[site.site as keyof typeof knownLoginSites]?.label??site.site,automatic_verification:Object.hasOwn(knownLoginSites,site.site),profiles:Object.fromEntries(configured.map(target=>[target.id,profiles.get(target.id)?.find(row=>row.site===site.site)??null]))})),targets,configuration_revision:setup.revision,restart_required:setup.restart_required,runtime_reload_available:this.options.reloadAvailable===true,vnc:vm?`127.0.0.1:${vm.vnc_port}`:null,profile_preserved:!!vm,vm_state:await this.vmState(),busy:this.busy,login_guaranteed:false});return true;
    }
    const settingsAction=suffix==='connections/register'||suffix==='connections/profile',action=/^connections\/(open|recheck|check|retry|finish)\/([a-z0-9.-]+)(?:\/([a-z][a-z0-9_-]{0,63}))?$/u.exec(suffix);
    if((!action&&!settingsAction)||request.method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return true;}
    if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-connection'||request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'LOCAL_USER_ACTION_REQUIRED'});return true;}
    if(this.busy){send(409,{error:'CONNECTION_ACTION_IN_PROGRESS'});return true;}
    this.busy=true;
    try{
      if(settingsAction){
        if(request.headers['content-type']?.split(';')[0]!=='application/json'){send(400,{error:'AUTH_REQUEST_INVALID'});return true;}
        let body='';for await(const chunk of request){body+=String(chunk);if(Buffer.byteLength(body)>4096)throw Error('AUTH_REQUEST_TOO_LARGE');}
        const input=JSON.parse(body) as Record<string,unknown>,targetId=input.target_id;
        if(typeof targetId!=='string'||!siteLoginTargets(this.config).some(target=>target.id===targetId))throw Error('AUTH_BROWSER_NOT_CONFIGURED');
        if(suffix==='connections/register'){
          if(Object.keys(input).some(key=>!['url','target_id'].includes(key))||typeof input.url!=='string'||input.url.length>2048)throw Error('AUTH_REQUEST_INVALID');
          if(this.setup.view().restart_required)throw Error('BROWSER_SETUP_RELOAD_REQUIRED');
          const site=authSite(input.url);send(200,await this.broker.register(site,targetId));
        }else{
          if(Object.keys(input).some(key=>!['target_id','revision','session_mode','consent'].includes(key))||typeof input.revision!=='string'||!['persistent','isolated'].includes(String(input.session_mode))||typeof input.consent!=='boolean')throw Error('AUTH_REQUEST_INVALID');
          if([undefined,...siteLoginTargets(this.config)].some(target=>authSites(this.store,this.config,target).some(site=>site.handoff)))throw Error('BROWSER_LOGIN_IN_PROGRESS');
          const result=this.setup.setSessionMode(targetId,input.revision,input.session_mode as 'persistent'|'isolated',input.consent,(before,after)=>{if([before,after].some(target=>authSites(this.store,this.config,target).some(site=>site.handoff)))throw Error('BROWSER_LOGIN_IN_PROGRESS');});
          if(result.transition)migrateOwnedProfileAuthMode(this.store,this.config,result.transition.before,result.transition.after);
          send(200,{configuration_revision:result.revision,restart_required:result.restart_required,target_id:targetId,session_mode:input.session_mode,execution_started:false});
        }
        return true;
      }
      if(action![1]!=='finish'&&this.setup.view().restart_required)throw Error('BROWSER_SETUP_RELOAD_REQUIRED');
      const site=action![2]!,targetId=action![3],target=targetId?siteLoginTargets(this.config).find(item=>item.id===targetId):undefined;
      if(targetId&&!target){send(409,{error:'AUTH_BROWSER_NOT_CONFIGURED'});return true;}
      if(action![1]==='open'||action![1]==='recheck'){
        const result=await this.broker.open(site,targetId,action![1]==='recheck'?{recheck_restricted:true}:{});
        send(200,{...result,viewer_opened:result.environment==='ubuntu_vm'?await openViewer(this.config.swarm!.visual.owned_vm!.vnc_port):true});
      }else if(action![1]==='check')send(200,await this.broker.check(site,targetId));
      else if(action![1]==='finish')send(200,await this.broker.finish(site,targetId,{explicit_release:true}));
      else send(200,this.broker.retry(site,targetId));
    }catch(error){send(409,{error:error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'CONNECTION_UNAVAILABLE'});}finally{this.busy=false;this.vmSnapshot=null;this.targetSnapshot=null;}
    return true;
  }
  async close(){await this.broker.close();}
}
export function connectionHtml(nonce:string){return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>사이트 로그인 · Agent Office</title><style>${uiCss}
.wrap{max-width:820px}.site{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--line)}.site-info{min-width:0;display:grid;gap:8px;justify-items:center;text-align:center}.site h2{font-size:14px;font-weight:500;margin:0;overflow-wrap:anywhere}.site .badge{white-space:normal}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:stretch}.actions button{width:auto;min-width:0;white-space:normal;line-height:1.4}.browser-choice,.site-url{width:100%;min-width:0;padding:9px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--text)}.registration-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:12px;margin:12px 0}.registration-fields label{display:grid;gap:6px;min-width:0}.empty-line{color:var(--dim);padding:12px 0}.login-help{margin:10px 0;font-size:13px;line-height:1.65}.login-help p{margin:8px 0;overflow-wrap:anywhere}.site .login-help{grid-column:1/-1;margin:0}.profile-setup{padding:10px 0;display:grid;gap:8px}.profile-setup label{display:flex;align-items:flex-start;gap:8px;line-height:1.5}.profile-setup input{width:auto}.profile-setup[hidden],#apply-login-settings[hidden],#reload-help[hidden]{display:none}.profile-setup button{justify-self:end}.registration-fields label,.profile-setup label{font-size:13px}.site-register-actions{margin-top:10px}.site-help-time{font-variant-numeric:tabular-nums}@media(max-width:620px){.site,.registration-fields{grid-template-columns:1fr}.site-info{grid-template-columns:repeat(2,minmax(0,1fr));align-items:center}.actions button{max-width:100%}}
</style></head><body><div class="app">${sidebarHtml('connections')}<main class="main"><div class="wrap"><header class="top"><h1>사이트 로그인</h1>${displayOptionsHtml}</header><section class="panel"><h2>사이트 미리 등록</h2><div class="registration-fields"><label for="site-url">사이트 주소 (HTTPS)<input id="site-url" class="site-url" type="url" placeholder="https://www.google.com" autocomplete="url" spellcheck="false"></label><label for="site-target">로그인 환경<select id="site-target" class="browser-choice"></select></label></div><div id="profile-setup" class="profile-setup" hidden><label><input id="profile-consent" type="checkbox"><span>선택한 브라우저의 로그인 유지 허용</span></label><button id="save-login-profile" type="button" disabled>프로필 설정 저장</button></div><div class="actions site-register-actions"><button id="register-site" class="primary" type="button">사이트 추가</button><button id="apply-login-settings" type="button" hidden>설정 다시 적용</button></div><p id="reload-help" class="muted" hidden>저장된 프로필 설정을 적용한 뒤 로그인할 수 있습니다.</p><details class="login-help" id="prelogin-help"><summary>로그인 유지 설명</summary><p>업무를 만들기 전에 사이트를 등록하고 로그인할 수 있습니다. 로그인은 선택한 환경의 프로필에만 저장됩니다.</p><p>주소에서는 도메인만 저장합니다. 입력한 경로·쿼리는 저장하지 않으며 사이트 홈에서 로그인합니다.</p><p>전용 브라우저는 로그인 유지를 허용한 프로필만 재사용합니다. 쿠키·비밀번호를 다른 환경으로 복사하지 않습니다.</p><p>사이트 정책과 세션 만료에 따라 재인증이 필요할 수 있습니다. 일반 사이트는 프로필을 유지해도 로그인 완료를 자동 확인하지 못할 수 있습니다.</p><p>WSL 로그인 창에는 WSLg 같은 화면 환경이 필요합니다. Windows VM은 연결기가 지원되기 전까지 사용할 수 없습니다.</p></details></section><section class="panel"><div id="sites"></div><small>로그인이나 사용자 확인이 끝날 때까지 해당 worker는 대기합니다.</small></section><div id="notice" class="notice" role="status">연결 상태 확인 중…</div></div></main></div><script nonce="${nonce}">
${i18nScript}
${themeScript}

const labels={unchecked:'로그인 미확인',needs_login:'로그인 필요',login_limited:'사이트가 로그인 일시 제한',challenge:'사용자 확인 필요',ready:'로그인 확인됨',unknown:'로그인 미확인',retry_requested:'재시도 대기',policy_blocked:'확인 필요'};
const availability={ready:'연결됨',available:'화면 환경 감지',stopped:'꺼짐 · 시작 가능',unavailable:'연결 불가',unsupported:'미지원',not_configured:'연결 필요',profile_setup_required:'로그인 유지 설정 필요',display_required:'WSLg 설치·실행 필요',browser_required:'브라우저 설치 필요'};
const errors={AUTH_LOGIN_PAGE_NOT_OPEN:'현재 연결된 로그인 탭이 없습니다. 로그인 창 열기로 연결한 뒤 확인하세요.',AUTH_LOGIN_LIMITED:'사이트에서 로그인을 일시 제한했습니다. 로그인 시도를 멈추고 나중에 상태를 확인하세요.',AUTH_OWNED_VM_NOT_RUNNING:'브라우저가 꺼져 있습니다. 로그인 창 열기를 누르면 시작합니다.',AUTH_VM_BROWSER_NOT_READY:'브라우저를 시작했지만 아직 준비되지 않았습니다. 잠시 후 로그인 창 열기를 다시 누르세요.',AUTH_VM_START_IN_PROGRESS:'다른 연결에서 브라우저를 준비 중입니다. 잠시 후 다시 시도하세요.',AUTH_VM_MANIFEST_MISMATCH:'저장된 브라우저 설정이 일치하지 않습니다. 연결 및 설정에서 확인하세요.',AUTH_BROWSER_TRANSPORT_UNAVAILABLE:'이 환경의 로그인 연결기는 아직 사용할 수 없습니다.',AUTH_BROWSER_NOT_CONFIGURED:'등록된 로그인 브라우저가 아닙니다.',AUTH_HEADED_DISPLAY_UNAVAILABLE:'WSLg 같은 화면 환경을 설치·실행한 뒤 다시 확인하세요.',AUTH_PERSISTENT_PROFILE_REQUIRED:'선택한 브라우저의 로그인 유지 설정을 먼저 저장하세요.',AUTH_URL_INVALID:'계정 정보가 없는 공개 HTTPS 사이트 주소를 입력하세요.',AUTH_SITE_INVALID:'계정 정보가 없는 공개 HTTPS 사이트 주소를 입력하세요.',AUTH_SITE_NOT_PUBLIC:'내부 주소는 사이트 로그인에 등록할 수 없습니다.',AUTH_REQUEST_INVALID:'사이트 주소와 로그인 환경을 확인하세요.',BROWSER_SETUP_RELOAD_REQUIRED:'저장된 프로필 설정을 적용한 뒤 로그인할 수 있습니다.',BROWSER_SETUP_CONFLICT:'설정이 변경됐습니다. 다시 확인한 뒤 연결하세요.',BROWSER_SETUP_CONSENT_REQUIRED:'로그인 유지 허용을 선택한 뒤 저장하세요.',BROWSER_LOGIN_IN_PROGRESS:'열린 로그인 창에서 작업을 마친 뒤 로그인 종료를 누르세요.',CONTROL_CENTER_RELOAD_UNAVAILABLE:'이 실행 환경에서는 설정을 자동 적용할 수 없습니다. Agent Office를 다시 연결하세요.',WORK_EXECUTION_ACTIVE:'실행 중인 업무가 끝난 뒤 설정을 다시 적용하세요.',CONNECTION_UNAVAILABLE:'로그인 화면에 연결하지 못했습니다. 브라우저 상태와 연결 설정을 확인하세요.'};
errors.BROWSER_LOGIN_IN_PROGRESS=errors.AUTH_LOGIN_IN_PROGRESS='열린 로그인 창에서 작업을 마친 뒤 로그인 마침을 누르세요.';
errors.AUTH_USER_VERIFICATION_REQUIRED='브라우저에서 사용자 확인을 마친 뒤 로그인 확인을 누르세요.';
let busy=false,last='',latest=null,targetSignature='';const selected=new Map(),expanded=new Set();const $=id=>document.getElementById(id),t=value=>window.officeText(value);
const profileManagement=document.createElement('details');profileManagement.id='profile-management';profileManagement.className='login-help';profileManagement.hidden=true;const profileSummary=document.createElement('summary');profileSummary.textContent='로그인 프로필 관리';const profileNote=document.createElement('p');profileNote.textContent='저장 파일은 삭제하지 않고 다음 실행부터 사용하지 않습니다.';const profileDisable=document.createElement('button');profileDisable.id='disable-login-profile';profileDisable.type='button';profileDisable.textContent='로그인 유지 끄기';profileManagement.append(profileSummary,profileNote,profileDisable);$('profile-setup').after(profileManagement);
const openable=target=>target?.id&&['ready','available','stopped'].includes(target.availability);
const selectable=target=>target?.id&&['ready','available','stopped','profile_setup_required','display_required','browser_required'].includes(target.availability);
function fillChoices(choice,targets,wanted){choice.replaceChildren();for(const target of targets){const option=document.createElement('option');option.value=target.id;option.textContent=target.label+' · '+(availability[target.availability]||target.availability);option.disabled=!selectable(target);choice.append(option);}const viable=targets.filter(selectable),target=viable.find(item=>item.id===wanted)||viable.find(item=>item.environment==='windows'&&item.engine==='aside'&&item.availability==='ready')||viable.find(openable)||viable[0];if(target)choice.value=target.id;return target;}
function registrationState(){const target=latest?.targets.find(item=>item.id===$('site-target').value),persistent=target?.can_enable_profile&&target.session_mode==='persistent',handoff=latest?.sites.some(site=>site.handoff||Object.values(site.profiles||{}).some(profile=>profile?.handoff));$('profile-setup').hidden=!target?.can_enable_profile||persistent;$('profile-management').hidden=!persistent;$('disable-login-profile').disabled=busy||latest?.busy||handoff||!!latest?.restart_required;$('save-login-profile').disabled=busy||latest?.busy||handoff||!$('profile-consent').checked||!!latest?.restart_required;$('register-site').disabled=busy||latest?.busy||!selectable(target)||!!latest?.restart_required;$('apply-login-settings').hidden=!latest?.restart_required||!latest?.runtime_reload_available;$('apply-login-settings').disabled=busy||latest?.busy||handoff;$('reload-help').hidden=!latest?.restart_required;if(latest?.restart_required)$('reload-help').textContent=latest.runtime_reload_available?'저장된 프로필 설정을 적용한 뒤 로그인할 수 있습니다.':errors.CONTROL_CENTER_RELOAD_UNAVAILABLE;}
async function refresh(){try{
  const response=await fetch('connections/status');if(!response.ok)throw Error('연결 상태를 읽지 못했습니다.');const data=await response.json();
  latest=data;const signature=JSON.stringify(data.targets);if(signature!==targetSignature){fillChoices($('site-target'),data.targets,$('site-target').value);targetSignature=signature;}registrationState();
  const next=JSON.stringify([data.sites,data.targets,data.vm_state,data.busy,data.restart_required]);if(next===last)return true;last=next;
  const root=document.getElementById('sites');root.replaceChildren();
  for(const site of data.sites){
    const card=document.createElement('section');card.className='site';card.dataset.site=site.site;
    const info=document.createElement('div'),title=document.createElement('h2'),state=document.createElement('div');info.className='site-info';title.textContent=site.label;info.append(title,state);
    const actions=document.createElement('div'),choice=document.createElement('select');actions.className='actions';choice.className='browser-choice';choice.setAttribute('aria-label','로그인 브라우저');
    const target=fillChoices(choice,data.targets,selected.get(site.site)??data.targets.find(item=>site.profiles?.[item.id]?.handoff)?.id);choice.onchange=()=>{selected.set(site.site,choice.value);last='';refresh();};
    const row=site.profiles?.[target?.id]||{state:'unchecked',handoff:false},siteLimited=site.state==='login_limited'||Object.values(site.profiles||{}).some(profile=>profile?.state==='login_limited');
    state.className='badge '+(siteLimited?'warn':row.state==='ready'?'ok':row.state==='retry_requested'?'run':'warn');state.textContent=(siteLimited?labels.login_limited:labels[row.state]||row.state)+(row.handoff?' · 직접 로그인 중':'');
    actions.append(choice);
    for(const [action,label] of [['open','로그인 창 열기'],['recheck','직접 다시 확인'],['check',site.automatic_verification===false?'자동 확인 미지원':'로그인 확인'],['finish','로그인 마침'],['retry','재시도 허용']]){
      if(action==='finish'&&!row.handoff)continue;
      if(action==='recheck'&&(row.state!=='login_limited'||row.handoff))continue;
      const button=document.createElement('button');button.textContent=action==='open'&&target?.availability==='stopped'?'브라우저 시작·로그인':label;if(action==='open')button.className='primary';
      button.disabled=busy||data.busy||!target?.id||(action!=='finish'&&(!openable(target)||data.restart_required))||(action==='check'&&(target.availability==='stopped'||site.automatic_verification===false))||(action==='retry'&&(row.handoff||['challenge','policy_blocked'].includes(row.state)))||(siteLimited&&!['check','finish','recheck'].includes(action));
      button.onclick=()=>act(action,site.site,target.id);actions.append(button);
    }
    const help=document.createElement('details');help.className='login-help';help.open=expanded.has(site.site);help.ontoggle=()=>{if(help.open)expanded.add(site.site);else expanded.delete(site.site);};const summary=document.createElement('summary');summary.textContent='로그인 유지 설명';help.append(summary);
    const notes=[target?.profile_preserved?'로그인 유지가 켜져 있습니다. 아직 저장된 로그인이나 인증 성공을 뜻하지 않습니다.':'선택한 환경은 로그인 유지 설정이 필요합니다.',site.automatic_verification===false?'자동 로그인 확인을 지원하지 않는 사이트입니다. 로그인 마침 후에도 상태는 미확인으로 남습니다.':'표시된 로그인 상태는 마지막 관측입니다. 사이트 정책과 세션 만료에 따라 재인증이 필요할 수 있습니다.','로그인 마침은 Office의 제어 대기를 해제합니다. 사이트에서 로그아웃하거나 기존 사용자 탭을 닫지 않습니다.'];
    if(row.state==='login_limited')notes.push('직접 다시 확인은 제한된 같은 환경의 창만 엽니다. 제한을 지우거나 업무를 자동 재개하지 않습니다.');
    if(target?.reason&&errors[target.reason])notes.push(errors[target.reason]);for(const text of notes){const p=document.createElement('p');p.textContent=text;help.append(p);}
    const observed=document.createElement('p'),caption=document.createElement('span'),stamp=document.createElement('span');caption.textContent='마지막 로그인 상태 관측';stamp.className='site-help-time';stamp.textContent=row.updated_at&&!['unchecked','retry_requested'].includes(row.state)?row.updated_at:t('관측 없음');observed.append(caption,document.createTextNode(' · '),stamp);help.append(observed);
    card.append(info,actions,help);root.append(card);
  }
  if(!data.sites.length){const empty=document.createElement('p');empty.className='empty-line';empty.textContent='등록한 사이트가 없습니다. 위에서 미리 추가할 수 있습니다.';root.append(empty);}return true;
}catch(error){document.getElementById('notice').textContent=error.message;return false;}}
async function operation(callback){if(busy)return;busy=true;for(const button of document.querySelectorAll('main button'))if(!['theme-toggle','lang-toggle'].includes(button.id))button.disabled=true;try{await callback();}catch(error){$('notice').textContent=errors[error.message]||error.message;}finally{busy=false;last='';await refresh();}}
async function post(path,body,header='human-connection'){const response=await fetch(path,{method:'POST',headers:{'X-Agent-Driver':header,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw Error(data.error||'CONNECTION_UNAVAILABLE');return data;}
async function act(action,site,target){await operation(async()=>{$('notice').textContent=['open','recheck'].includes(action)?'선택한 브라우저에서 로그인 화면을 여는 중…':action==='check'?'로그인 상태를 확인하는 중…':action==='finish'?'로그인 마침을 처리하는 중…':'재시도 허용을 요청하는 중…';const data=await post('connections/'+action+'/'+encodeURIComponent(site)+'/'+encodeURIComponent(target));$('notice').textContent=['open','recheck'].includes(action)?(data.viewer_opened?'로그인 창을 열었습니다. 인증을 마친 뒤 로그인 마침을 누르세요.':'VNC '+data.vnc+'에서 로그인하세요.'):action==='finish'?(data.handoff?errors.AUTH_LOGIN_IN_PROGRESS:'로그인 대기를 해제했습니다. 프로필 유지와 로그인 확인은 별개입니다.'):action==='retry'?'재시도 허용됨 · 업무에서 재개하세요.':data.state==='login_limited'?errors.AUTH_LOGIN_LIMITED:data.verified?'로그인 상태를 확인했습니다.':'아직 로그인 완료를 확인하지 못했습니다.';});}
$('site-target').onchange=()=>{$('profile-consent').checked=false;registrationState();};$('profile-consent').onchange=registrationState;
$('register-site').onclick=()=>operation(async()=>{const input=$('site-url').value.trim();let url;try{url=new URL(input);}catch{throw Error('AUTH_URL_INVALID');}if(url.protocol!=='https:'||url.username||url.password)throw Error('AUTH_URL_INVALID');const target=$('site-target').value;const data=await post('connections/register',{url:input,target_id:target});if(data.site)selected.set(data.site,target);$('site-url').value='';$('notice').textContent='사이트를 등록했습니다.';});
$('save-login-profile').onclick=()=>operation(async()=>{if(!$('profile-consent').checked)throw Error('BROWSER_SETUP_CONSENT_REQUIRED');await post('connections/profile',{target_id:$('site-target').value,revision:latest.configuration_revision,session_mode:'persistent',consent:true});$('profile-consent').checked=false;$('notice').textContent='프로필 설정을 저장했습니다. 설정 다시 적용을 누르세요.';});
$('disable-login-profile').onclick=()=>operation(async()=>{await post('connections/profile',{target_id:$('site-target').value,revision:latest.configuration_revision,session_mode:'isolated',consent:true});$('notice').textContent='로그인 유지 사용을 껐습니다. 저장 파일은 보존되며 설정 적용 후 반영됩니다.';});
$('apply-login-settings').onclick=()=>operation(async()=>{await post('work/reconnect',{},'human-office');$('notice').textContent='저장된 프로필 설정을 적용하는 중입니다. 업무는 실행하지 않습니다.';});
refresh().then(ok=>{if(ok)document.getElementById('notice').textContent='';});setInterval(()=>{if(!document.hidden)refresh();},2500);
</script></body></html>`;}
