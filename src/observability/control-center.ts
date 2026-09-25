import {serveUiAsset} from './ui-assets.js';
import {randomBytes} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {redact} from '../terminal/contracts.js';
import {PackStore,type RuntimeActivity} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {readSwarmDashboard,sanitizeSwarmEndpoint} from '../swarm/dashboard.js';
import {BrowserConnections} from './browser-connections.js';
import {ControlSettings} from './control-settings.js';
import {authSites,blockedAuthSites} from '../swarm/browser-auth.js';
import {readOffice} from './office.js';
import {workHtml} from './work-ui.js';
import {readWorkBoard,readWorkDetail} from './work-view.js';
import {workStartSchema,workDefineSchema,workAnswerSchema,workPauseSchema,workJevSchema} from '../work/contracts.js';
import {WorkRuntime} from '../work/runtime.js';
import {WorkImportRuntime,importedCodingReadiness,workImportPasteSchema,workImportScanSchema,workImportAcceptSchema,workImportCodingStartSchema,workImportCodingStepSchema} from '../work/import-runtime.js';
import {scanProject} from '../work/project-scan.js';
import {CodingRuntime,type CodingRuntimeOptions} from '../coding/runtime.js';
import {CodingDialogRuntime} from '../coding/conversation.js';
import {codingDialogAttachSchema,codingDialogTurnSchema} from '../coding/contracts.js';
import {ConfiguredStructuredModel} from '../onboarding/configured-model.js';
import {modelSettingsPath} from '../onboarding/model-settings.js';
import {type StructuredModel} from '../taskpack/adaptive-spec.js';

export type ControlRunKind='swarm'|'pack'|'task'|'terminal';
export type ControlLane='queued'|'running'|'done'|'attention';
export type ControlDecisionLayer='llm'|'jev'|'code';
export interface ControlSurfaceRef {id:string;kind:'vnc'|'browser'|'terminal'|'status';label:string;frame_path:string|null;state:'active'|'closed'|'failed'|'unobserved';}
export interface ControlActor {id:string;label:string;detail:string;stage:string;executor:string;lane:ControlLane;status:string;endpoint:string|null;activity:string|null;updated_at:string|null;decision_layer:ControlDecisionLayer|null;layer_activity_at?:Partial<Record<ControlDecisionLayer,string>>;surface:ControlSurfaceRef;lease_expires_at_ms?:number|null;lease_stale?:boolean;run_status?:string;}
export interface ControlRun {id:string;kind:ControlRunKind;title:string;status:string;lane:ControlLane;started_at:string|null;updated_at:string|null;actors:ControlActor[];decision_count:number;}
export interface ControlActivity {id:string;run_id:string;run_kind:ControlRunKind;actor_id:string|null;kind:string;summary:string;endpoint:string|null;decision_layer:ControlDecisionLayer|null;created_at:string;}
export interface ControlHealth {id:string;label:string;state:'active'|'configured'|'optional'|'stale'|'unobserved'|'not_configured';detail:string;}
export interface ControlCenterSnapshot {format:1;project_id:string;generated_at:string;health:ControlHealth[];runs:ControlRun[];activities:ControlActivity[];latest_revision:string;coverage:{agent_driver_only:true;outside_runtime:'unobserved'};read_only:true;website_connections?:ReturnType<typeof authSites>;}
export interface ControlCenterServer {url:string;closed:Promise<void>;close():Promise<void>;}

const terminalStatuses=new Set(['succeeded','cancelled','failed','session_closed','process_exited']);
const lane=(status:string):ControlLane=>['queued','pending','starting','input_ready','waiting_orchestrator'].includes(status)?'queued':['running','streaming','leased','verifying'].includes(status)?'running':['succeeded','completed','turn_completed','approved'].includes(status)?'done':'attention';
export const safeControlText=(value:string,max=240)=>{const safe=redact(value).replace(/https?:\/\/[^\s<>"']+/giu,url=>sanitizeSwarmEndpoint(url)??'[REDACTED_URL]').replace(/((?:token|secret|password|api.?key)\s*[:=]\s*)\S+/giu,'$1[REDACTED]');return safe.length<=max?safe:`${safe.slice(0,max-1)}…`;};
const latestBy=<T>(items:T[],key:(value:T)=>string,time:(value:T)=>string)=>{const map=new Map<string,T>();for(const item of items){const previous=map.get(key(item));if(!previous||time(previous)<time(item))map.set(key(item),item);}return map;};

export function readControlCenter(store:PackStore,config:HostConfig,now=Date.now()):ControlCenterSnapshot{
  const project=config.project.id,swarm=readSwarmDashboard(store,project),runtimeActivities=store.runtimeActivities(project,0,1000);
  const taskEvents=store.taskEventsReadOnly(project,1000) as unknown as Array<{id:number;task_id:string;kind:string;created_at:string}>;
  const packs=store.packRuns(project,50),sessions=store.sessions(project),packTaskIds=new Set(packs.flatMap(run=>run.task_id?[run.task_id]:[])),terminalTaskIds=new Set(sessions.map(session=>session.task_id)),terminalByTask=new Map(sessions.map(session=>[session.task_id,session.id]));
  const latestRuntime=latestBy(runtimeActivities,a=>`${a.owner_kind}:${a.owner_id}:`,a=>a.created_at);
  const configuredSurfaces=new Map((config.observability?.surfaces??[]).map(surface=>[surface.id,surface])),managedSurfaces=store.controlSurfaces(project);
  const managedByWorker=latestBy(managedSurfaces,item=>`${item.run_id}:${item.worker_id}`,item=>item.updated_at);
  const surface=(surfaceId:string|null|undefined,fallback:'terminal'|'status'='status'):ControlSurfaceRef=>{const configured=surfaceId?configuredSurfaces.get(surfaceId):undefined;return configured?{id:configured.id,kind:configured.kind,label:configured.label,frame_path:null,state:'unobserved'}:{id:fallback,label:fallback==='terminal'?'Terminal stream':'No visual surface',kind:fallback,frame_path:null,state:'unobserved'};};
  const swarmWorkerActivity=latestBy(swarm.activities.filter(activity=>activity.worker_id!==null&&activity.kind==='worker.activity'),activity=>`${activity.run_id}:${activity.worker_id}`,activity=>activity.created_at);
  const runs:ControlRun[]=[];
  for(const run of swarm.runs)runs.push({id:run.run_id,kind:'swarm',title:run.goal,status:run.status,lane:lane(run.status),started_at:new Date(run.started_at_ms).toISOString(),updated_at:run.updated_at,decision_count:swarm.activities.filter(a=>a.run_id===run.run_id&&a.kind==='decision.recorded').length,actors:run.workers.map(worker=>{const key=`${run.run_id}:${worker.id}`,activity=swarmWorkerActivity.get(key),managed=managedByWorker.get(key),body=(activity?.body??{}) as Record<string,unknown>,decision=['llm','jev','code'].includes(String(body.decision_layer))?body.decision_layer as ControlDecisionLayer:null,leaseStale=worker.status==='leased'&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms<=now;return {id:worker.id,label:worker.role,detail:worker.task,stage:worker.stage,executor:worker.executor,lane:leaseStale||run.status!=='running'&&worker.lane==='running'?'attention':worker.lane,status:worker.status,endpoint:worker.current_endpoint,activity:worker.current_activity,updated_at:worker.last_activity_at,decision_layer:decision,lease_expires_at_ms:worker.lease_expires_at_ms,lease_stale:leaseStale,run_status:run.status,surface:managed?{id:managed.id,kind:managed.kind,label:`${worker.role} browser`,frame_path:null,state:managed.state}:surface(typeof body.surface_id==='string'?body.surface_id:null)};})});
  for(const run of packs){const latest=latestRuntime.get(`pack:${run.id}:`) as RuntimeActivity|undefined;const started=runtimeActivities.find(a=>a.owner_kind==='pack'&&a.owner_id===run.id)?.created_at??null;runs.push({id:run.id,kind:'pack',title:safeControlText(run.recipe.request,300),status:run.status,lane:lane(run.status),started_at:started,updated_at:latest?.created_at??started,decision_count:0,actors:[{id:run.recipe.family,label:run.recipe.family,detail:'Task Pack execution',stage:run.status,executor:'pack-runtime',lane:lane(run.status),status:run.status,endpoint:latest?.endpoint??null,activity:latest?.kind??null,updated_at:latest?.created_at??null,decision_layer:latest?.decision_layer??null,surface:surface(latest?.surface_id)}]});}
  for(const task of store.tasks(project) as Array<ReturnType<PackStore['task']>&{created_at?:string;updated_at?:string}>){if(packTaskIds.has(task.id)||terminalTaskIds.has(task.id))continue;const latest=latestRuntime.get(`task:${task.id}:`) as RuntimeActivity|undefined;runs.push({id:task.id,kind:'task',title:safeControlText(task.capability,180),status:task.status,lane:lane(task.status),started_at:task.created_at??null,updated_at:latest?.created_at??task.updated_at??task.created_at??null,decision_count:0,actors:[{id:'runtime',label:task.next_action||task.capability,detail:task.selected_route??'route unselected',stage:task.next_action,status:task.status,executor:task.selected_route??'runtime',lane:lane(task.status),endpoint:latest?.endpoint??null,activity:latest?.kind??null,updated_at:latest?.created_at??null,decision_layer:latest?.decision_layer??null,surface:surface(latest?.surface_id)}]});}
  for(const session of sessions){const latest=latestRuntime.get(`terminal:${session.id}:`) as RuntimeActivity|undefined;runs.push({id:session.id,kind:'terminal',title:`CLI session · ${safeControlText(session.request_id,120)}`,status:session.state,lane:lane(session.state),started_at:session.created_at,updated_at:latest?.created_at??session.created_at,decision_count:0,actors:[{id:'cli',label:'Coding CLI',detail:`generation ${session.generation} · turns ${session.turn_count}`,stage:session.state,executor:'terminal-host',lane:lane(session.state),status:session.state,endpoint:latest?.endpoint??null,activity:latest?.kind??null,updated_at:latest?.created_at??null,decision_layer:latest?.decision_layer??null,surface:surface(latest?.surface_id,'terminal')}]});}
  const activities:ControlActivity[]=[
    ...swarm.activities.map(activity=>{const body=(activity.body??{}) as Record<string,unknown>;return {id:`swarm:${activity.id}`,run_id:activity.run_id,run_kind:'swarm' as const,actor_id:activity.worker_id,kind:activity.kind,summary:safeControlText(typeof body.summary==='string'?String(body.summary):activity.kind),endpoint:typeof body.endpoint==='string'?String(body.endpoint):null,decision_layer:['llm','jev','code'].includes(String(body.decision_layer))?body.decision_layer as ControlDecisionLayer:null,created_at:activity.created_at};}),
    ...runtimeActivities.map(activity=>({id:`runtime:${activity.id}`,run_id:activity.owner_id,run_kind:activity.owner_kind,actor_id:activity.actor_id,kind:activity.kind,summary:safeControlText(activity.summary),endpoint:activity.endpoint,decision_layer:activity.decision_layer,created_at:activity.created_at})),
    ...taskEvents.filter(event=>!packTaskIds.has(event.task_id)).map(event=>({id:`task:${event.id}`,run_id:terminalByTask.get(event.task_id)??event.task_id,run_kind:(terminalTaskIds.has(event.task_id)?'terminal':'task') as 'terminal'|'task',actor_id:null,kind:event.kind,summary:event.kind,endpoint:null,decision_layer:null,created_at:event.created_at})),
  ].sort((a,b)=>a.created_at.localeCompare(b.created_at)).slice(-1500);
  const layerActivity=new Map<string,Partial<Record<ControlDecisionLayer,string>>>();
  for(const activity of activities){if(!activity.decision_layer||activity.run_kind==='swarm'&&activity.actor_id===null)continue;const key=`${activity.run_kind}:${activity.run_id}:${activity.run_kind==='swarm'?activity.actor_id:'*'}`,times=layerActivity.get(key)??{},previous=times[activity.decision_layer];if(!previous||previous<activity.created_at)times[activity.decision_layer]=activity.created_at;layerActivity.set(key,times);}
  for(const run of runs)for(const actor of run.actors)actor.layer_activity_at=layerActivity.get(`${run.kind}:${run.id}:${run.kind==='swarm'?actor.id:'*'}`)??{};
  runs.sort((a,b)=>(b.started_at??b.updated_at??'').localeCompare(a.started_at??a.updated_at??'')||(b.updated_at??'').localeCompare(a.updated_at??''));
  const presences=store.presences(project,50),activeMcp=presences.filter(p=>p.kind==='mcp'&&p.state==='active'&&now-Date.parse(p.heartbeat_at)<=10_000),staleMcp=presences.filter(p=>p.kind==='mcp'&&p.state==='active'&&now-Date.parse(p.heartbeat_at)>10_000);
  const activeCli=sessions.filter(s=>!terminalStatuses.has(s.state)).length,browserConfigured=Boolean(config.swarm?.visual.enabled||managedSurfaces.length||config.observability?.surfaces.length||config.packs?.sources.some(s=>s.kind==='browser')||config.packs?.targets.length);
  const health:ControlHealth[]=[
    {id:'mcp',label:'MCP',state:activeMcp.length?'active':staleMcp.length?'stale':'unobserved',detail:activeMcp.length?`${activeMcp.length} gateway connected`:staleMcp.length?`${staleMcp.length} heartbeat stale`:'no live gateway observed'},
    {id:'browser',label:'Browser / VM',state:browserConfigured?'configured':'not_configured',detail:browserConfigured?'configured; live process not probed':'no browser source or target'},
    {id:'cli',label:'CLI',state:activeCli?'active':config.terminal?'configured':'not_configured',detail:activeCli?`${activeCli} session active`:config.terminal?'configured; no active session':'not configured'},
    {id:'decision',label:'Decision Plane',state:config.packs?.models&&config.packs.models!=='off'||config.swarm?.enabled?'configured':'optional',detail:config.swarm?.enabled?'LLM planner configured; provider health unobserved':'Jev/LLM optional'},
  ];
  const latestRevision=[swarm.latest_event_id,runtimeActivities.at(-1)?.id??0,taskEvents.at(-1)?.id??0,...swarm.runs.map(run=>`${run.run_id}:${run.revision}`),...managedSurfaces.map(item=>`${item.id}:${item.state}:${item.updated_at}`),...runs.flatMap(run=>run.actors.filter(actor=>actor.lease_stale).map(actor=>`${run.id}:${actor.id}:stale`)),...presences.map(p=>Date.parse(p.heartbeat_at)||0)].join(':');
  const website_connections=authSites(store,config);
  for(const run of runs.filter(run=>run.kind==='swarm'&&run.status==='running')){const snapshot=store.swarmRun(project,run.id).snapshot as import('../swarm/contracts.js').SwarmRunSnapshot;for(const actor of run.actors.filter(actor=>actor.status==='pending')){const definition=snapshot.plan.workers.find(worker=>worker.id===actor.id);if(definition&&blockedAuthSites(store,config,definition.source_urls).length){actor.status='waiting_for_auth';actor.lane='attention';actor.activity='Sign in via Website connections';}}}
  return {format:1,project_id:project,generated_at:new Date(now).toISOString(),health,runs,activities,website_connections,latest_revision:latestRevision+JSON.stringify(website_connections),coverage:{agent_driver_only:true,outside_runtime:'unobserved'},read_only:true};
}

function headers(nonce?:string){return {'cache-control':'no-store','content-security-policy':`default-src 'none'; connect-src 'self'; font-src 'self'; img-src 'self' blob:; style-src 'unsafe-inline'; script-src ${nonce?`'nonce-${nonce}'`:`'none'`}; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,'referrer-policy':'no-referrer','x-content-type-options':'nosniff','x-frame-options':'DENY'};}
function reply(response:ServerResponse,status:number,body:string,type='text/plain; charset=utf-8',nonce?:string){response.writeHead(status,{'content-type':type,...headers(nonce)});response.end(body);}
export async function startControlCenter(config:HostConfig,options:{port?:number;poll_ms?:number;capability_token?:string;workModel?:StructuredModel;coding?:CodingRuntimeOptions}={}):Promise<ControlCenterServer>{
  if(options.capability_token!==undefined&&!/^[a-f0-9]{48}$/u.test(options.capability_token))throw Error('CONTROL_CENTER_CAPABILITY_INVALID');
  const token=options.capability_token??randomBytes(24).toString('hex'),store=new PackStore(config.dbPath);try{store.registerProject(config.project);}catch(error){store.close();throw error;}const presence=store.startPresence(config.project.id,'dashboard',{transport:'loopback-read-only'}),clients=new Set<ServerResponse>(),lightClients=new Set<ServerResponse>(),poll=options.poll_ms??500;let host='',done:()=>void=()=>undefined,stopped=false;const closed=new Promise<void>(resolve=>done=resolve);
  const connections=new BrowserConnections(store,config),settings=new ControlSettings(config);
  const workModel=options.workModel??new ConfiguredStructuredModel(modelSettingsPath(config));
  const workRuntime=new WorkRuntime(store,config,workModel),imports=new WorkImportRuntime(store,config,workModel),codingRuntime=new CodingRuntime(store,config,workModel,options.coding),codingDialog=new CodingDialogRuntime(store,config,workModel,options.coding);
  const server=createServer(async (request:IncomingMessage,response:ServerResponse)=>{
    if(request.headers.host!==host){reply(response,403,'forbidden');return;}
    const url=new URL(request.url??'/','http://127.0.0.1'),base=`/${token}/`;if(!url.pathname.startsWith(base)){reply(response,404,'not found');return;}const suffix=url.pathname.slice(base.length);
    if(await serveUiAsset(request,response,suffix))return;
    if(await settings.handle(request,response,suffix,host))return;
    if(await connections.handle(request,response,suffix,host))return;
    if(['work/coding/attach','work/coding/turn','work/coding/stop','work/coding/reconcile'].includes(suffix)){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>8_192)throw Error('CODING_DIALOG_REQUEST_TOO_LARGE');}
        const raw=JSON.parse(body) as unknown;
        if(suffix==='work/coding/attach'){
          const input=codingDialogAttachSchema.parse(raw),source=store.workImportForWork(config.project.id,input.work_id);
          if(source?.kind==='project'){
            const ready=importedCodingReadiness(store,config,input.work_id);
            if(!ready?.can_start||ready.project_ref!==input.project_ref)throw Error('WORK_IMPORT_CODING_NOT_READY');
            const observed=await scanProject(ready.project_path);
            if(observed.content_sha256!==source.source_digest)throw Error('WORK_IMPORT_SOURCE_CHANGED_RESCAN');
            store.approveImportedCodingPlan(config.project.id,input.work_id,input.project_ref);
          }
        }
        if(suffix==='work/coding/turn'){
          const input=codingDialogTurnSchema.parse(raw),dialog=store.codingDialog(config.project.id,input.dialog_id);
          const source=store.workImportForWork(config.project.id,dialog.work_id);
          if(source?.kind==='project'&&!store.codingDialogTurnByRequestId(config.project.id,input.dialog_id,input.request_id)){
            store.approveImportedCodingDialogTurn(config.project.id,input.dialog_id,input.expected_revision,input.instruction);
          }
        }
        const result=suffix==='work/coding/attach'?await codingDialog.attach(raw):suffix==='work/coding/turn'?await codingDialog.turn(raw):suffix==='work/coding/stop'?codingDialog.stop(raw):await codingDialog.reconcile(raw);
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:safeControlText(error instanceof Error?error.message:'CODING_DIALOG_FAILED',300)}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/import/paste'||suffix==='work/import/scan'||suffix==='work/import/accept'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';const max=suffix==='work/import/paste'?70_000:4_096;for await(const chunk of request){body+=String(chunk);if(body.length>max)throw Error('WORK_IMPORT_REQUEST_TOO_LARGE');}
        const raw=JSON.parse(body) as unknown;
        const result=suffix==='work/import/paste'?imports.paste(workImportPasteSchema.parse(raw)):suffix==='work/import/scan'?await imports.scan(workImportScanSchema.parse(raw)):await imports.accept(workImportAcceptSchema.parse(raw));
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_IMPORT_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/import/coding/start'||suffix==='work/import/coding/step'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>2_048)throw Error('WORK_IMPORT_CODING_REQUEST_TOO_LARGE');}
        const raw=JSON.parse(body) as unknown,project=config.project.id;
        if(suffix==='work/import/coding/start'){
          const input=workImportCodingStartSchema.parse(raw),ready=importedCodingReadiness(store,config,input.work_id);
          if(!ready?.can_start||!ready.project_ref)throw Error('WORK_IMPORT_CODING_NOT_READY');
          const source=store.workImportForWork(project,input.work_id)!;
          const observed=await scanProject(ready.project_path);
          if(observed.content_sha256!==source.source_digest)throw Error('WORK_IMPORT_SOURCE_CHANGED_RESCAN');
          store.approveImportedCodingPlan(project,input.work_id,ready.project_ref);
          const result=await codingRuntime.start({request_id:`import-${input.work_id}`,work_id:input.work_id,project_ref:ready.project_ref});
          reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
        }else{
          const input=workImportCodingStepSchema.parse(raw),ready=importedCodingReadiness(store,config,input.work_id);
          if(!ready?.can_step||ready.run_id!==input.run_id||ready.run_revision!==input.expected_revision)throw Error('WORK_IMPORT_CODING_STAGE_NOT_READY');
          store.approveImportedCodingStage(project,input.run_id,input.expected_revision);
          const result=await codingRuntime.step({run_id:input.run_id,expected_revision:input.expected_revision});
          reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
        }
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_IMPORT_CODING_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/start'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>12_288)throw Error('WORK_REQUEST_TOO_LARGE');}
        const input=workStartSchema.parse(JSON.parse(body));
        const result=await workRuntime.start(input);
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_START_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/define'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>1024)throw Error('WORK_REQUEST_TOO_LARGE');}
        const input=workDefineSchema.parse(JSON.parse(body));
        const result=await workRuntime.define(input);
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_DEFINE_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/answer'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>8192)throw Error('WORK_REQUEST_TOO_LARGE');}
        const input=workAnswerSchema.parse(JSON.parse(body));
        if(Object.values(input.answers).some(value=>/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(value)))throw Error('CREDENTIAL_LIKE_INPUT');
        const result=await workRuntime.answer(input);
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_ANSWER_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/pause'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>2048)throw Error('WORK_REQUEST_TOO_LARGE');}
        const input=workPauseSchema.parse(JSON.parse(body)),work=store.setIntakePaused(config.project.id,input.work_id,input.revision,input.paused);
        reply(response,200,JSON.stringify({work_id:work.id,paused:work.paused,revision:work.revision,scope:'future_dispatch'}),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_PAUSE_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='work/jev'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>2048)throw Error('WORK_REQUEST_TOO_LARGE');}
        const input=workJevSchema.parse(JSON.parse(body)),result=workRuntime.jev(input);
        reply(response,200,JSON.stringify({work_id:result.work_id,revision:result.revision,jev:result.jev,scope:'future_decisions'}),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'WORK_JEV_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(suffix==='office/action'){
      if(request.method!=='POST'){reply(response,405,'method not allowed');return;}
      if(request.headers.origin!==`http://${host}`||request.headers['x-agent-driver']!=='human-office'||request.headers['sec-fetch-site']==='cross-site'||!String(request.headers['content-type']??'').startsWith('application/json')){reply(response,403,'forbidden');return;}
      try{let body='';for await(const chunk of request){body+=String(chunk);if(body.length>8192)throw Error('OFFICE_REQUEST_TOO_LARGE');}
        const input=JSON.parse(body) as Record<string,unknown>;if(typeof input.run_id!=='string'||!/^[a-f0-9-]{36}$/u.test(input.run_id)||!['pause','resume','edit'].includes(String(input.action))||!Number.isSafeInteger(input.revision)||input.worker_id!==undefined&&typeof input.worker_id!=='string'||input.instruction!==undefined&&typeof input.instruction!=='string')throw Error('OFFICE_REQUEST_INVALID');
        const runId=String(input.run_id),revision=input.revision as number,action=input.action as 'pause'|'resume'|'edit';
        const result=store.officeWork(config.project.id,'coding',runId)?action==='edit'?store.codingDirection(config.project.id,runId,revision,String(input.worker_id??''),String(input.instruction??'')):store.pauseCoding(config.project.id,runId,revision,action==='pause'):store.officeAction(config.project.id,runId,action,revision,input.worker_id as string|undefined,input.instruction as string|undefined);
        reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');
      }catch(error){reply(response,409,JSON.stringify({error:error instanceof Error?error.message:'OFFICE_ACTION_FAILED'}),'application/json; charset=utf-8');}return;
    }
    if(request.method!=='GET'){reply(response,405,'method not allowed');return;}
    if(suffix==='work/coding/sessions'){
      try{const project_ref=url.searchParams.get('project_ref');const result=await codingDialog.sessions({project_ref});reply(response,200,JSON.stringify(result),'application/json; charset=utf-8');}
      catch(error){reply(response,409,JSON.stringify({error:safeControlText(error instanceof Error?error.message:'CODING_DIALOG_SESSIONS_FAILED',300)}),'application/json; charset=utf-8');}return;
    }
    if(suffix===''){const nonce=randomBytes(18).toString('base64url');reply(response,200,workHtml(nonce),'text/html; charset=utf-8',nonce);return;}
    if(suffix==='work/import/prompt'){reply(response,200,JSON.stringify(imports.prompt()),'application/json; charset=utf-8');return;}
    if(suffix==='work/board'){reply(response,200,JSON.stringify(readWorkBoard(store,config)),'application/json; charset=utf-8');return;}
    if(suffix==='work/detail'){
      const id=url.searchParams.get('id');if(!id||id.length>128){reply(response,400,'work id required');return;}
      try{reply(response,200,JSON.stringify(readWorkDetail(store,config,id)),'application/json; charset=utf-8');}catch{reply(response,404,'work not found');}return;
    }
    if(suffix==='work/events'){
      response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','connection':'keep-alive',...headers()});clients.add(response);lightClients.add(response);
      try{response.write(`event: board\ndata: ${JSON.stringify(readWorkBoard(store,config))}\n\n`);}catch{response.end();lightClients.delete(response);clients.delete(response);return;}
      request.once('close',()=>{lightClients.delete(response);clients.delete(response)});return;
    }
    if(suffix==='office/snapshot'){reply(response,200,JSON.stringify(readOffice(store,config,readControlCenter(store,config))),'application/json; charset=utf-8');return;}
    if(suffix==='office/events'){response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','connection':'keep-alive',...headers()});clients.add(response);let last='';const emit=()=>{if(response.destroyed)return;try{const snapshot=readOffice(store,config,readControlCenter(store,config)),next=snapshot.latest_revision;if(next!==last){last=next;response.write(`event: snapshot\nid: ${Date.now()}\ndata: ${JSON.stringify(snapshot)}\n\n`);}}catch{response.end();}};emit();const timer=setInterval(emit,poll),keep=setInterval(()=>{if(!response.destroyed)response.write(': keep-alive\n\n');},15_000);request.once('close',()=>{clearInterval(timer);clearInterval(keep);clients.delete(response)});return;}
    if(suffix==='snapshot'){reply(response,200,JSON.stringify(readControlCenter(store,config)),'application/json; charset=utf-8');return;}
    if(suffix==='events'){response.writeHead(200,{'content-type':'text/event-stream; charset=utf-8','connection':'keep-alive',...headers()});clients.add(response);let last='';const emit=()=>{if(response.destroyed)return;try{const snapshot=readControlCenter(store,config),next=snapshot.latest_revision;if(next!==last){last=next;response.write(`event: snapshot\nid: ${Date.now()}\ndata: ${JSON.stringify(snapshot)}\n\n`);}}catch{response.end();}};emit();const timer=setInterval(emit,poll),keep=setInterval(()=>{if(!response.destroyed)response.write(': keep-alive\n\n');},15_000);request.once('close',()=>{clearInterval(timer);clearInterval(keep);clients.delete(response)});return;}
    reply(response,404,'not found');
  });
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',resolve)});const address=server.address();if(address===null||typeof address==='string'){store.stopPresence(config.project.id,presence);store.close();throw Error('CONTROL_CENTER_BIND_FAILED');}host=`127.0.0.1:${address.port}`;const heartbeat=setInterval(()=>{try{store.heartbeatPresence(config.project.id,presence);}catch{}},2_000);heartbeat.unref();
  let lastBoard='',lastKeep=Date.now();const lightTick=setInterval(()=>{if(!lightClients.size)return;try{const board=readWorkBoard(store,config),payload=JSON.stringify({works:board.works,auth_attention_count:board.auth_attention_count});if(payload!==lastBoard){lastBoard=payload;for(const client of lightClients)if(!client.destroyed)client.write(`event: board\ndata: ${JSON.stringify(board)}\n\n`);}if(Date.now()-lastKeep>=15_000){lastKeep=Date.now();for(const client of lightClients)if(!client.destroyed)client.write(': keep-alive\n\n');}}catch{for(const client of lightClients)client.end();lightClients.clear();}},Math.max(1000,poll));lightTick.unref();
  const close=async()=>{if(stopped)return;stopped=true;clearInterval(heartbeat);clearInterval(lightTick);settings.close();codingRuntime.close();codingDialog.close();store.stopPresence(config.project.id,presence);for(const client of clients)client.end();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await codingRuntime.drain();await codingDialog.drain();await connections.close();store.close();done()};return {url:`http://${host}/${token}/`,closed,close};
}
