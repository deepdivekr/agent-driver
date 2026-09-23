import {randomBytes} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {redact} from '../terminal/contracts.js';
import {PackStore,type SwarmActivity} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {type SwarmRunSnapshot,type SwarmWorkerState} from './contracts.js';

export type DashboardLane='queued'|'running'|'done'|'attention';
export interface DashboardWorker {
  id:string;role:string;task:string;stage:string;executor:string;status:SwarmWorkerState['status'];lane:DashboardLane;
  endpoints:string[];current_endpoint:string|null;current_activity:string|null;last_activity_at:string|null;depends_on:string[];attempts:number;lease_expires_at_ms:number|null;quality:number|null;
}
export interface DashboardRun {
  run_id:string;status:SwarmRunSnapshot['status'];revision:number;goal:string;mode:string|null;started_at_ms:number;updated_at:string;
  target_deadline_at_ms:number|null;hard_deadline_at_ms:number|null;worker_count:number;active_count:number;workers:DashboardWorker[];
}
export interface DashboardSnapshot {format:1;project_id:string;generated_at:string;runs:DashboardRun[];activities:SwarmActivity[];latest_event_id:number;read_only:true;}
export interface SwarmDashboardServer {url:string;closed:Promise<void>;close():Promise<void>;}

const lane=(status:SwarmWorkerState['status']):DashboardLane=>status==='pending'?'queued':status==='leased'?'running':status==='succeeded'?'done':'attention';
const compact=(value:string,max=240)=>{const safe=redact(value)
  .replace(/https?:\/\/[^\s<>"']+/giu,url=>sanitizeSwarmEndpoint(url)??'[REDACTED_URL]')
  .replace(/((?:token|secret|password|api.?key)\s*[:=]\s*)\S+/giu,'$1[REDACTED]');return safe.length<=max?safe:`${safe.slice(0,max-1)}…`;};

/** Dashboard endpoints never retain userinfo, query, fragment or high-entropy path segments. */
export function sanitizeSwarmEndpoint(value:string):string|null{
  try{
    const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;
    const segments=url.pathname.split('/').map((part,index,all)=>{
      if(!part)return part;
      const previous=all[index-1]??'';
      if(/^(?:token|secret|password|api-?key|auth|session)$/iu.test(previous))return ':redacted';
      if(part.length>64||/^[A-Za-z0-9_-]{32,}$/u.test(part))return ':redacted';
      return part;
    });
    return `${url.origin}${segments.join('/')}`;
  }catch{return null;}
}

function safeActivity(activity:SwarmActivity):SwarmActivity{
  const body=activity.body&&typeof activity.body==='object'
    ?Object.fromEntries(Object.entries(activity.body as Record<string,unknown>).map(([key,value])=>[key,key==='endpoint'&&typeof value==='string'?sanitizeSwarmEndpoint(value):typeof value==='string'?compact(value,300):value]))
    :{};
  return {...activity,body};
}

export function projectSwarmRun(snapshot:SwarmRunSnapshot):DashboardRun{
  const definitions=new Map(snapshot.plan.workers.map(worker=>[worker.id,worker]));
  const workers=Object.values(snapshot.workers).map(worker=>{
    const definition=definitions.get(worker.id),legacy=definition as unknown as Partial<{role:string;objective:string;stage:string;executor:string;source_urls:string[];depends_on:string[]}>|undefined;
    return {id:worker.id,role:compact(legacy?.role??worker.id,120),task:compact(legacy?.objective??'이전 버전 작업 — 세부 설명 없음'),stage:legacy?.stage??'legacy',executor:legacy?.executor??'unknown',status:worker.status,lane:lane(worker.status),
      endpoints:(legacy?.source_urls??[]).map(sanitizeSwarmEndpoint).filter((value):value is string=>value!==null),current_endpoint:null,current_activity:null,last_activity_at:null,depends_on:legacy?.depends_on??[],attempts:worker.attempts,
      lease_expires_at_ms:worker.lease_expires_at_ms,quality:worker.quality?.score??null};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  const legacy=snapshot as unknown as Partial<{started_at_ms:number;created_at:string;target_deadline_at_ms:number;hard_deadline_at_ms:number;mode:string}>;
  const started=Number.isFinite(legacy.started_at_ms)?Number(legacy.started_at_ms):Date.parse(legacy.created_at??snapshot.updated_at);
  return {run_id:snapshot.run_id,status:snapshot.status,revision:snapshot.revision,goal:compact(snapshot.plan.goal,500),mode:legacy.mode??null,started_at_ms:Number.isFinite(started)?started:Date.now(),updated_at:snapshot.updated_at,
    target_deadline_at_ms:legacy.target_deadline_at_ms??null,hard_deadline_at_ms:legacy.hard_deadline_at_ms??null,worker_count:workers.length,active_count:workers.filter(worker=>worker.status==='leased').length,workers};
}

export function readSwarmDashboard(store:PackStore,projectId:string):DashboardSnapshot{
  const activities=store.swarmActivities(projectId,0,1000).map(safeActivity),latest=new Map<string,SwarmActivity>();
  for(const activity of activities)if(activity.kind==='worker.activity'&&activity.worker_id)latest.set(`${activity.run_id}:${activity.worker_id}`,activity);
  const runs=store.swarmRuns(projectId,20).map(projectSwarmRun).map(run=>({...run,workers:run.workers.map(worker=>{
    const activity=latest.get(`${run.run_id}:${worker.id}`),body=activity?.body as Record<string,unknown>|undefined,currentEndpoint=typeof body?.endpoint==='string'?body.endpoint:null;
    return {...worker,current_endpoint:currentEndpoint??worker.endpoints[0]??null,current_activity:typeof body?.activity_kind==='string'?body.activity_kind:null,last_activity_at:activity?.created_at??null};
  })}));
  return {format:1,project_id:projectId,generated_at:new Date().toISOString(),runs,activities,latest_event_id:activities.at(-1)?.id??0,read_only:true};
}

const html=(nonce:string,initial:DashboardSnapshot)=>{const initialJson=JSON.stringify(initial).replace(/[<>&]/gu,character=>character==='<'?'\\u003c':character==='>'?'\\u003e':'\\u0026');return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Driver · Swarm</title>
<style>
:root{color-scheme:dark;--bg:#091019;--panel:#111c28;--line:#263748;--muted:#91a4b7;--text:#edf5fc;--accent:#65d1ff;--queued:#8193a7;--running:#4db9ff;--done:#56d69b;--attention:#ffb65c}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 20% 0,#142c40 0,#091019 36%);color:var(--text);font:14px/1.45 ui-sans-serif,system-ui,sans-serif}header{height:64px;padding:0 24px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);background:#091019dd;position:sticky;top:0;z-index:5;backdrop-filter:blur(14px)}h1{font-size:17px;margin:0;letter-spacing:.02em}.live{display:flex;align-items:center;gap:8px;color:var(--muted)}.dot{width:9px;height:9px;border-radius:50%;background:var(--done);box-shadow:0 0 14px var(--done)}main{display:grid;grid-template-columns:minmax(0,1fr) 320px;min-height:calc(100vh - 64px)}.workspace{padding:22px;min-width:0}.sidebar{border-left:1px solid var(--line);background:#0c151f;padding:18px;overflow:auto}.summary{display:grid;grid-template-columns:repeat(5,minmax(110px,1fr));gap:10px;margin-bottom:18px}.metric,.lane,.event,.run-button{border:1px solid var(--line);background:#101c28;border-radius:12px}.metric{padding:13px}.metric b{font-size:24px;display:block}.metric span{color:var(--muted)}.goal{font-size:18px;margin:6px 0 16px}.lanes{display:grid;grid-template-columns:repeat(4,minmax(190px,1fr));gap:12px;align-items:start}.lane{min-height:420px;padding:12px}.lane h2{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.11em;margin:2px 3px 12px}.nodes{display:grid;gap:9px}.node{border:1px solid var(--line);border-left:4px solid var(--queued);border-radius:10px;padding:11px;background:#0b151f;cursor:pointer;transition:transform .45s cubic-bezier(.2,.8,.2,1),opacity .3s}.node[data-lane=running]{border-left-color:var(--running);box-shadow:0 0 0 1px #4db9ff22,0 8px 30px #0005}.node[data-lane=done]{border-left-color:var(--done)}.node[data-lane=attention]{border-left-color:var(--attention)}.node strong{display:block;margin-bottom:4px}.node small,.endpoint{color:var(--muted)}.endpoint{font:11px/1.35 ui-monospace,monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:8px}.badge{display:inline-flex;padding:2px 6px;border-radius:999px;background:#1a2a38;color:#b9d8ee;font-size:10px;margin-right:4px}.node[data-lane=running] .badge:first-child{animation:pulse 1.2s ease-in-out infinite}.empty{color:#526579;text-align:center;padding:40px 4px}.sidebar h2{font-size:13px;text-transform:uppercase;letter-spacing:.09em;color:var(--muted);margin:16px 0 8px}.run-button{display:block;width:100%;text-align:left;color:var(--text);padding:10px;margin:7px 0;cursor:pointer}.run-button.selected{border-color:var(--accent)}.run-button small{color:var(--muted)}.event{padding:9px;margin:7px 0}.event b{font-size:12px}.event time{float:right;color:var(--muted);font-size:10px}.event p{margin:5px 0 0;color:var(--muted);font-size:12px}.detail{position:fixed;inset:auto 22px 22px auto;width:min(420px,calc(100vw - 44px));padding:18px;background:#142232;border:1px solid #395168;border-radius:14px;box-shadow:0 24px 80px #0009;display:none;z-index:8}.detail.open{display:block}.detail button{float:right;border:0;background:transparent;color:var(--text);font-size:20px}.detail pre{white-space:pre-wrap;color:#bad1e3;font:12px/1.5 ui-monospace,monospace}.offline .dot{background:var(--attention);box-shadow:none}@keyframes pulse{50%{opacity:.45}}@media(max-width:1100px){main{grid-template-columns:1fr}.sidebar{border-left:0;border-top:1px solid var(--line)}.lanes{grid-template-columns:repeat(2,1fr)}}@media(max-width:680px){.summary{grid-template-columns:repeat(2,1fr)}.lanes{grid-template-columns:1fr}.workspace{padding:14px}}@media(prefers-reduced-motion:reduce){.node{transition:none!important}.node .badge{animation:none!important}}
</style></head><body><header><h1>Agent Driver <span style="color:var(--accent)">Swarm</span></h1><div id="live" class="live"><i class="dot"></i><span>연결 중</span></div></header><main><section class="workspace"><div id="summary" class="summary"></div><div id="goal" class="goal">실행을 기다리는 중입니다.</div><div class="lanes" id="lanes"></div></section><aside class="sidebar"><h2>실행 목록</h2><div id="runs"></div><h2>활동 기록</h2><div id="events"></div></aside></main><section id="detail" class="detail"><button aria-label="닫기">×</button><h3></h3><pre></pre></section>
<script nonce="${nonce}">
const names={queued:'대기',running:'실행 중',done:'완료',attention:'확인 필요'},order=['queued','running','done','attention'];let state=${initialJson},selected=null,positions=new Map();
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));const elapsed=ms=>{const s=Math.max(0,Math.floor(ms/1000));return s<60?s+'초':Math.floor(s/60)+'분 '+s%60+'초'};
function choose(runId){selected=runId;render()}
function render(){if(!state)return;const run=state.runs.find(x=>x.run_id===selected)||state.runs[0];selected=run?.run_id||null;document.getElementById('runs').innerHTML=state.runs.map(x=>'<button class="run-button '+(x.run_id===selected?'selected':'')+'" data-run="'+esc(x.run_id)+'" title="'+esc(x.goal)+'"><b>'+esc(x.goal.length>100?x.goal.slice(0,99)+'…':x.goal)+'</b><br><small>'+esc(x.status)+' · '+x.worker_count+' nodes · rev '+x.revision+'</small></button>').join('')||'<p class="empty">기록 없음</p>';document.querySelectorAll('[data-run]').forEach(b=>b.onclick=()=>choose(b.dataset.run));
if(!run){document.getElementById('summary').innerHTML='';document.getElementById('lanes').innerHTML='<p class="empty">아직 Swarm 실행이 없습니다.</p>';return}document.getElementById('goal').textContent=run.goal;const counts=Object.fromEntries(order.map(k=>[k,run.workers.filter(w=>w.lane===k).length]));document.getElementById('summary').innerHTML=[['전체',run.worker_count],['동시 실행',run.active_count],['대기',counts.queued],['완료',counts.done],['경과',elapsed(Date.now()-run.started_at_ms)]].map(x=>'<div class="metric"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>').join('');
document.querySelectorAll('.node').forEach(n=>positions.set(n.dataset.node,n.getBoundingClientRect()));document.getElementById('lanes').innerHTML=order.map(k=>'<section class="lane"><h2>'+names[k]+' · '+counts[k]+'</h2><div class="nodes">'+(run.workers.filter(w=>w.lane===k).map(w=>'<article class="node" tabindex="0" data-node="'+esc(w.id)+'" data-lane="'+k+'"><strong>'+esc(w.role)+'</strong><span class="badge">'+esc(w.stage)+'</span><span class="badge">'+esc(w.executor)+'</span>'+(w.current_activity?'<span class="badge">'+esc(w.current_activity)+'</span>':'')+'<small>'+esc(w.status)+' · '+w.attempts+'회</small><div class="endpoint">'+esc(w.current_endpoint||'local / no endpoint')+'</div></article>').join('')||'<div class="empty">없음</div>')+'</div></section>').join('');
document.querySelectorAll('.node').forEach(n=>{const before=positions.get(n.dataset.node),after=n.getBoundingClientRect();if(before){n.style.transform='translate('+(before.left-after.left)+'px,'+(before.top-after.top)+'px)';requestAnimationFrame(()=>{n.style.transform='translate(0,0)'})}const open=()=>show(run.workers.find(w=>w.id===n.dataset.node));n.onclick=open;n.onkeydown=e=>{if(e.key==='Enter')open()}});const events=state.activities.filter(e=>e.run_id===run.run_id).slice(-80).reverse();document.getElementById('events').innerHTML=events.map(e=>'<article class="event"><time>'+esc(new Date(e.created_at).toLocaleTimeString())+'</time><b>'+esc(e.kind)+'</b><p>'+(e.worker_id?esc(e.worker_id)+' · ':'')+(e.body?.summary?esc(e.body.summary)+' · ':'')+'revision '+e.revision+'</p></article>').join('')||'<p class="empty">활동 없음</p>'}
function show(w){if(!w)return;const d=document.getElementById('detail'),br=String.fromCharCode(10);d.querySelector('h3').textContent=w.role;d.querySelector('pre').textContent=['상태: '+w.status,'현재 활동: '+(w.current_activity||'미보고'),'단계: '+w.stage,'실행기: '+w.executor,'시도: '+w.attempts,'품질: '+(w.quality??'미평가'),'현재 endpoint: '+(w.current_endpoint||'local / no endpoint'),'','작업',w.task,'','선행 node',w.depends_on.join(', ')||'없음'].join(br);d.classList.add('open')}document.querySelector('#detail button').onclick=()=>document.getElementById('detail').classList.remove('open');
async function load(){const r=await fetch('snapshot',{cache:'no-store'});if(!r.ok)throw Error('snapshot');state=await r.json();render()}const live=document.getElementById('live');render();load().catch(()=>live.classList.add('offline'));const stream=new EventSource('events');stream.addEventListener('snapshot',e=>{state=JSON.parse(e.data);render();live.classList.remove('offline');live.querySelector('span').textContent='실시간'});stream.onerror=()=>{live.classList.add('offline');live.querySelector('span').textContent='재연결 중'};setInterval(()=>{if(state)render()},1000);
</script></body></html>`;};

function headers(nonce?:string){return {'cache-control':'no-store','content-security-policy':`default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src ${nonce?`'nonce-${nonce}'`:`'none'`}; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY','cross-origin-opener-policy':'same-origin'};}
function reply(response:ServerResponse,status:number,body:string,type='text/plain; charset=utf-8',nonce?:string){response.writeHead(status,{'content-type':type,...headers(nonce)});response.end(body);}
function signature(snapshot:DashboardSnapshot){return `${snapshot.latest_event_id}:${snapshot.runs.map(run=>`${run.run_id}:${run.revision}`).join(',')}`;}

/** Starts a read-only, capability-addressed dashboard on loopback. It owns no executor or approval methods. */
export async function startSwarmDashboard(config:HostConfig,options:{port?:number;poll_ms?:number}={}):Promise<SwarmDashboardServer>{
  const token=randomBytes(24).toString('hex'),store=new PackStore(config.dbPath),clients=new Set<ServerResponse>(),pollMs=options.poll_ms??500;
  let expectedHost='',closedResolve:()=>void=()=>undefined,isClosed=false;const closed=new Promise<void>(resolve=>{closedResolve=resolve;});
  const server=createServer((request:IncomingMessage,response:ServerResponse)=>{
    if(request.headers.host!==expectedHost){reply(response,403,'forbidden');return;}
    if(request.method!=='GET'){reply(response,405,'method not allowed');return;}
    const url=new URL(request.url??'/','http://127.0.0.1');const base=`/${token}/`;
    if(!url.pathname.startsWith(base)){reply(response,404,'not found');return;}
    const suffix=url.pathname.slice(base.length);
    if(suffix==='') {const nonce=randomBytes(18).toString('base64url');reply(response,200,html(nonce,readSwarmDashboard(store,config.project.id)),'text/html; charset=utf-8',nonce);return;}
    if(suffix==='snapshot') {reply(response,200,JSON.stringify(readSwarmDashboard(store,config.project.id)),'application/json; charset=utf-8');return;}
    if(suffix==='events'){
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','connection':'keep-alive',...headers()});clients.add(response);
      let last='';const emit=()=>{if(response.destroyed)return;try{const snapshot=readSwarmDashboard(store,config.project.id),next=signature(snapshot);if(next!==last){last=next;response.write(`event: snapshot\nid: ${snapshot.latest_event_id}\ndata: ${JSON.stringify(snapshot)}\n\n`);}}catch{response.end();}};
      emit();const timer=setInterval(emit,pollMs),heartbeat=setInterval(()=>{if(!response.destroyed)response.write(': keep-alive\n\n');},15_000);request.once('close',()=>{clearInterval(timer);clearInterval(heartbeat);clients.delete(response);});return;
    }
    reply(response,404,'not found');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',resolve);});
  const address=server.address();if(address===null||typeof address==='string'){store.close();throw Error('SWARM_DASHBOARD_BIND_FAILED');}expectedHost=`127.0.0.1:${address.port}`;
  const close=async()=>{if(isClosed)return;isClosed=true;for(const client of clients)client.end();clients.clear();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));store.close();closedResolve();};
  return {url:`http://${expectedHost}/${token}/`,closed,close};
}
