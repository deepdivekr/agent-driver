import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';
import {type IncomingMessage,type ServerResponse} from 'node:http';
import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {displayOptionsHtml,sidebarHtml,themeScript,uiCss} from './ui-shell.js';
import {i18nScript} from './i18n.js';
import {loginVmStatus} from '../swarm/login-vm.js';
import {BrowserLoginBroker,authSites,knownLoginSites} from '../swarm/browser-auth.js';

async function openViewer(port:number){
  // Only a local user's explicit Open login click may invoke a foreground viewer.
  const candidates=process.platform==='win32'?['C:\\Program Files\\TigerVNC\\vncviewer.exe']:process.env.WSL_DISTRO_NAME?['/mnt/c/Program Files/TigerVNC/vncviewer.exe']:[];
  for(const executable of candidates){try{await access(executable);await new Promise<void>((resolve,reject)=>{const child=spawn(executable,[`127.0.0.1::${port}`],{shell:false,detached:true,stdio:'ignore',windowsHide:false});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return true;}catch{}}
  return false;
}
export class BrowserConnections {
  readonly broker:BrowserLoginBroker;
  private busy=false;
  private vmSnapshot:{state:string;at:number}|null=null;
  private async vmState(){if(!this.vmSnapshot||Date.now()-this.vmSnapshot.at>2000)this.vmSnapshot={state:await loginVmStatus(this.config),at:Date.now()};return this.vmSnapshot.state;}
  constructor(readonly store:PackStore,readonly config:HostConfig){this.broker=new BrowserLoginBroker(store,config);}
  async handle(request:IncomingMessage,response:ServerResponse,suffix:string,host:string){
    if(!suffix.startsWith('connections'))return false;
    const nonce=randomBytes(18).toString('base64url');
    const send=(code:number,body:unknown,html=false)=>{response.writeHead(code,{'Content-Type':html?'text/html; charset=utf-8':'application/json; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Content-Security-Policy':`default-src 'none'; connect-src 'self'; font-src 'self'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});response.end(html?String(body):JSON.stringify(body));};
    if(suffix==='connections'&&request.method==='GET'){send(200,connectionHtml(nonce),true);return true;}
    if(suffix==='connections/status'&&request.method==='GET'){
      const vm=this.config.swarm?.visual.owned_vm;send(200,{sites:authSites(this.store,this.config).map(site=>({...site,label:knownLoginSites[site.site as keyof typeof knownLoginSites]?.label??site.site})),vnc:vm?`127.0.0.1:${vm.vnc_port}`:null,profile_preserved:!!vm,vm_state:await this.vmState(),busy:this.busy,login_guaranteed:false});return true;
    }
    const action=/^connections\/(open|check|retry)\/([a-z0-9.-]+)$/u.exec(suffix);
    if(!action||request.method!=='POST'){send(405,{error:'METHOD_NOT_ALLOWED'});return true;}
    if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-connection'||request.headers['sec-fetch-site']==='cross-site'){send(403,{error:'LOCAL_USER_ACTION_REQUIRED'});return true;}
    if(this.busy){send(409,{error:'CONNECTION_ACTION_IN_PROGRESS'});return true;}
    this.busy=true;
    try{
      const site=action[2]!;
      const vm=this.config.swarm?.visual.owned_vm;if(!vm){send(409,{error:'PERSISTENT_BROWSER_NOT_CONFIGURED'});return true;}
      if(action[1]==='open'){const result=await this.broker.open(site);send(200,{...result,viewer_opened:await openViewer(vm.vnc_port)});}
      else if(action[1]==='check')send(200,await this.broker.check(site));
      else send(200,this.broker.retry(site));
    }catch(error){send(409,{error:error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'CONNECTION_UNAVAILABLE'});}finally{this.busy=false;this.vmSnapshot=null;}
    return true;
  }
  async close(){await this.broker.close();}
}
function connectionHtml(nonce:string){return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>사이트 로그인 · Agent Office</title><style>${uiCss}
.wrap{max-width:760px}.site{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,2fr);align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.site-info{min-width:0;display:grid;gap:8px;justify-items:center;text-align:center}.site h2{font-size:14px;font-weight:500;margin:0;overflow-wrap:anywhere}.site .badge{white-space:normal}.actions{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px;align-items:stretch}.actions button{width:auto;min-width:0;white-space:normal;line-height:1.4}.empty-line{color:var(--dim);padding:12px 0}@media(max-width:620px){.site{grid-template-columns:1fr}.site-info{grid-template-columns:repeat(2,minmax(0,1fr));align-items:center}}
</style></head><body><div class="app">${sidebarHtml('connections')}<main class="main"><div class="wrap"><header class="top"><h1>사이트 로그인</h1><span class="muted">로그인 화면: <code id="vnc">—</code></span>${displayOptionsHtml}</header><div class="panel"><p class="muted keep">현재 작업에 필요한 사이트만 표시됩니다.</p><div id="sites"></div><small>로그인이나 사용자 확인이 끝날 때까지 해당 worker는 대기합니다.</small></div><div id="notice" class="notice" role="status">연결 상태 확인 중…</div></div></main></div><script nonce="${nonce}">
${i18nScript}
${themeScript}

const labels={unchecked:'확인 필요',needs_login:'로그인 필요',login_limited:'사이트가 로그인 일시 제한',challenge:'사용자 확인 필요',ready:'준비됨',unknown:'확인 필요',retry_requested:'재시도 대기',policy_blocked:'확인 필요'};let busy=false,last='';
const errors={AUTH_LOGIN_PAGE_NOT_OPEN:'현재 연결된 로그인 탭이 없습니다. 로그인 창 열기로 연결한 뒤 확인하세요.',AUTH_LOGIN_LIMITED:'사이트에서 로그인을 일시 제한했습니다. 로그인 시도를 멈추고 나중에 상태를 확인하세요.',AUTH_OWNED_VM_NOT_RUNNING:'브라우저가 꺼져 있습니다. 로그인 창 열기를 누르면 시작합니다.',AUTH_VM_BROWSER_NOT_READY:'브라우저를 시작했지만 아직 준비되지 않았습니다. 잠시 후 로그인 창 열기를 다시 누르세요.',AUTH_VM_START_IN_PROGRESS:'다른 연결에서 브라우저를 준비 중입니다. 잠시 후 다시 시도하세요.',AUTH_VM_MANIFEST_MISMATCH:'저장된 브라우저 설정이 일치하지 않습니다. 연결 및 설정에서 확인하세요.',CONNECTION_UNAVAILABLE:'로그인 화면에 연결하지 못했습니다. 브라우저 상태와 연결 설정을 확인하세요.'};
async function refresh(){try{const response=await fetch('connections/status');if(!response.ok)throw Error('연결 상태를 읽지 못했습니다.');const data=await response.json();document.getElementById('vnc').textContent=data.vm_state==='stopped'?'브라우저 꺼짐':data.vm_state==='starting'?'브라우저 준비 중…':data.vm_state==='unavailable'?'준비되지 않음':data.vnc||'준비되지 않음';const next=JSON.stringify([data.sites,data.profile_preserved,data.vm_state,data.busy]);if(next===last)return true;last=next;const root=document.getElementById('sites');root.replaceChildren();for(const site of data.sites){const card=document.createElement('section');card.className='site';const info=document.createElement('div'),title=document.createElement('h2'),state=document.createElement('div');info.className='site-info';title.textContent=site.label;state.className='badge '+(site.state==='ready'?'ok':site.state==='retry_requested'?'run':'warn');state.textContent=(labels[site.state]||site.state)+(site.handoff&&data.vm_state==='running'?' · 직접 로그인 중':'');info.append(title,state);const actions=document.createElement('div');actions.className='actions';for(const [action,label] of [['open','로그인 창 열기'],['check','로그인 확인'],['retry','다시 시도']]){const button=document.createElement('button');button.textContent=action==='open'&&data.vm_state==='stopped'?'브라우저 시작·로그인':label;if(action==='open')button.className='primary';button.disabled=busy||data.busy||!data.profile_preserved||data.vm_state==='unavailable'||(action==='check'&&data.vm_state!=='running')||(action==='retry'&&site.state==='login_limited');button.onclick=()=>act(action,site.site);actions.append(button);}card.append(info,actions);root.append(card);}if(!data.sites.length){const empty=document.createElement('p');empty.className='empty-line';empty.textContent='현재 로그인이 필요한 사이트가 없습니다.';root.append(empty);}return true;}catch(error){document.getElementById('notice').textContent=error.message;return false;}}
async function act(action,site){if(busy)return;busy=true;const controls=[...document.querySelectorAll('#sites button')].map(button=>[button,button.disabled]);controls.forEach(([button])=>button.disabled=true);const notice=document.getElementById('notice');notice.textContent=action==='open'?'기존 브라우저를 준비하고 로그인 화면을 여는 중…':action==='check'?'로그인 상태를 확인하는 중…':'작업의 재시도를 요청하는 중…';try{const response=await fetch('connections/'+action+'/'+encodeURIComponent(site),{method:'POST',headers:{'X-Agent-Driver':'human-connection'}});const data=await response.json();if(!response.ok)throw Error(errors[data.error]||data.error);notice.textContent=action==='open'?(data.viewer_opened?'로그인 창을 열었습니다. 인증을 마친 뒤 로그인 확인을 누르세요.':'VNC '+data.vnc+'에서 로그인하세요.'):action==='retry'?'작업에서 다시 접근합니다.':data.state==='login_limited'?errors.AUTH_LOGIN_LIMITED:data.verified?'로그인 상태를 확인했습니다.':'아직 로그인 완료를 확인하지 못했습니다.';}catch(error){notice.textContent=error.message;}finally{busy=false;last='';await refresh();controls.forEach(([button,disabled])=>{if(button.isConnected)button.disabled=disabled;});}}
refresh().then(ok=>{if(ok)document.getElementById('notice').textContent='';});setInterval(()=>{if(!document.hidden)refresh();},2500);
</script></body></html>`;}
