import {type PackStore} from '../packs/store.js';
import {safeControlText} from '../observability/safe-text.js';
import {z} from 'zod';
import {AsyncLocalStorage} from 'node:async_hooks';

const activityMetadataSchema=z.object({
  run_id:z.string().max(100).optional(),operation_id:z.string().max(100).optional(),stage_binding:z.string().max(64).optional(),target_url:z.string().url().max(2048).optional(),
  stage_id:z.string().max(100).optional(),worker_id:z.string().max(100).optional(),tool_name:z.string().max(100).optional(),status:z.string().max(80).optional(),
  pack_family:z.string().max(100).optional(),route_kind:z.string().max(40).optional(),executor:z.string().max(160).optional(),
  engine:z.string().max(40).optional(),environment:z.string().max(80).optional(),reason:z.string().max(160).optional(),
  validation:z.object({code:z.enum(['WORK_CLIENT_DECISION_OUTPUT_INVALID','WORK_CLIENT_DECISION_CORRECTION_FAILED']),output_sha256:z.string().regex(/^[a-f0-9]{64}$/),issues:z.array(z.object({path:z.string().max(100),code:z.string().max(60),message:z.string().max(180)}).strict()).max(8)}).strict().optional(),
  model_provider:z.string().max(60).optional(),model_name:z.string().max(200).optional(),model_effort:z.enum(['low','medium','high']).optional(),
  model_role:z.enum(['planner','worker','verifier','synthesis']).optional(),model_continuity:z.enum(['new_session','resumed_session','checkpoint_only']).optional(),
  source:z.object({url:z.string().url().max(2048),title:z.string().max(200),observed_at:z.string().datetime()}).strict().optional(),
}).strict();
export type WorkActivityMetadata=z.infer<typeof activityMetadataSchema>;
type ActivityContext={project_id:string;work_id:string;run_id:string;stage_id:string;operation_id?:string;stage_binding?:string;worker_id?:string};
const activityContext=new AsyncLocalStorage<ActivityContext>();
/** Async-local attribution prevents parallel workers from borrowing each other's stage. */
export function withWorkActivityContext<T>(context:ActivityContext,action:()=>T):T{return activityContext.run(context,action);}
/** Only explicit host fields, never arguments, page bodies or provider reasoning. */
function safeMetadata(raw:unknown):WorkActivityMetadata|undefined{
  const parsed=activityMetadataSchema.safeParse(raw);if(!parsed.success)return undefined;
  const metadata=Object.fromEntries(Object.entries(parsed.data).filter(([key])=>key!=='source'&&key!=='validation').map(([key,value])=>[key,safeControlText(String(value),key==='target_url'?2048:160)])) as WorkActivityMetadata;
  if(parsed.data.validation){const validation=parsed.data.validation;metadata.validation={code:validation.code,output_sha256:validation.output_sha256,issues:validation.issues.map(issue=>({path:safeControlText(issue.path,100),code:safeControlText(issue.code,60),message:safeControlText(issue.message,180)}))};}
  if(parsed.data.source){const source=parsed.data.source,url=safeControlText(source.url,2048);try{new URL(url);metadata.source={url,title:safeControlText(source.title,200),observed_at:source.observed_at};}catch{/* Sensitive or invalid URLs are not public source evidence. */}}
  return metadata;
}

export function initWorkExecution(store:PackStore){
  store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_execution(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,owner TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,reason TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS office_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,work_id TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL,metadata TEXT);
    CREATE INDEX IF NOT EXISTS office_activity_work ON office_activity(project_id,work_id,id);
    CREATE INDEX IF NOT EXISTS runtime_activity_owner ON runtime_activity(project_id,owner_kind,owner_id,id);`);
  if(!store.hermesState.prepare('PRAGMA table_info(office_activity)').all().some(column=>column.name==='metadata'))store.hermesState.exec('ALTER TABLE office_activity ADD COLUMN metadata TEXT');
}
export function hasExecutionTable(store:PackStore){return Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_execution'").get());}
export function executionRecord(store:PackStore,project:string,id:string){
  return hasExecutionTable(store)?store.hermesState.prepare('SELECT owner,lease_until_ms,state,reason,updated_at FROM office_execution WHERE project_id=? AND work_id=?').get(project,id) as {owner:string|null;lease_until_ms:number;state:string;reason:string|null;updated_at:string}|undefined:undefined;
}
export function workActivity(store:PackStore,project:string,id:string,kind:string,summary:string,metadata?:WorkActivityMetadata){
  const context=activityContext.getStore();
  const scoped=context?.project_id===project&&context.work_id===id?Object.fromEntries(Object.entries(context).filter(([key])=>key!=='project_id'&&key!=='work_id')):undefined;
  const safe=metadata||scoped?safeMetadata({...metadata,...scoped}):undefined;
  store.hermesState.prepare('INSERT INTO office_activity(project_id,work_id,kind,summary,created_at,metadata) VALUES(?,?,?,?,?,?)').run(project,id,kind,safeControlText(summary,800),new Date().toISOString(),safe?JSON.stringify(safe):null);
}
export interface WorkLog {id:string;kind:string;summary:string;created_at:string;source:string;metadata?:WorkActivityMetadata;}
/** Saved worker states are live evidence only while their run and lease remain valid. */
export function activeSwarmWorkerCount(snapshot:{status:string;workers:Record<string,{status:string;lease_token?:string|null;lease_expires_at_ms?:number|null}>},atMs=Date.now()){
  if(snapshot.status!=='running')return 0;
  return Object.values(snapshot.workers).filter(worker=>worker.status==='leased'&&typeof worker.lease_token==='string'&&worker.lease_token.trim().length>0&&typeof worker.lease_expires_at_ms==='number'&&Number.isFinite(worker.lease_expires_at_ms)&&worker.lease_expires_at_ms>atMs).length;
}
/** Bounded reads of this Work only. No raw provider stdout, credentials or reasoning. */
export function workTail(store:PackStore,project:string,id:string):WorkLog[]{
  store.officeWorkById(project,id);
  const db=store.hermesState,rows:WorkLog[]=[];
  const read=(table:string,sql:string,params:(string|number)[])=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return;
    for(const row of db.prepare(sql).all(...params)){let metadata:WorkActivityMetadata|undefined;try{metadata=typeof row.metadata==='string'?safeMetadata(JSON.parse(row.metadata)):undefined;}catch{/* Historical malformed telemetry is not execution evidence. */}rows.push({id:`${table}:${row.id}`,kind:safeControlText(String(row.kind),100),summary:safeControlText(String(row.summary??''),800),created_at:String(row.created_at),source:table,...(metadata?{metadata}:{})});}
  };
  const hasMetadata=db.prepare('PRAGMA table_info(office_activity)').all().some(column=>column.name==='metadata');
  read('office_activity',`SELECT id,kind,summary,created_at${hasMetadata?',metadata':''} FROM office_activity WHERE project_id=? AND work_id=? ORDER BY id DESC LIMIT 80`,[project,id]);
  read('office_work_revision',"SELECT revision AS id,kind,kind AS summary,created_at FROM office_work_revision WHERE work_id=? ORDER BY revision DESC LIMIT 20",[id]);
  for(const run of store.officeRuns(project,id).slice(0,3)){
    read('office_event','SELECT id,kind,detail AS summary,created_at FROM office_event WHERE project_id=? AND run_id=? ORDER BY id DESC LIMIT 50',[project,run.source_id]);
    if(run.source_kind==='pack')read('runtime_activity',"SELECT id,kind,summary,created_at FROM runtime_activity WHERE project_id=? AND owner_kind='pack' AND owner_id=? ORDER BY id DESC LIMIT 80",[project,run.source_id]);
    if(run.source_kind==='swarm')read('swarm_activity',"SELECT id,kind,COALESCE(json_extract(body,'$.summary'),json_extract(body,'$.activity.summary'),kind) AS summary,created_at FROM swarm_activity WHERE project_id=? AND run_id=? ORDER BY id DESC LIMIT 80",[project,run.source_id]);
  }
  for(const table of ['hermes_event','office_remote_event'])read(table,`SELECT ${table==='hermes_event'?'id':'id'},kind,summary,created_at FROM ${table} WHERE project_id=? AND work_id=? ORDER BY id DESC LIMIT 60`,[project,id]);
  return rows.sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id)).slice(-100);
}
export function workObservation(store:PackStore,project:string,id:string,storedStatus:string,now=Date.now()){
  const dispatch=executionRecord(store,project,id),run=store.officeRuns(project,id)[0];
  let live=false,workers=0,basis='no_active_lease';
  if(dispatch?.owner&&dispatch.lease_until_ms>now){live=true;workers=1;basis='office_dispatch_lease';}
  if(run?.source_kind==='pack'){
    const lease=store.packExecution(project,run.source_id);
    if(lease?.owner&&lease.lease_until_ms>now){live=true;workers=1;basis='pack_execution_lease';}
  }else if(run?.source_kind==='swarm'){
    const snapshot=store.swarmRun(project,run.source_id).snapshot as Parameters<typeof activeSwarmWorkerCount>[0];
    workers=activeSwarmWorkerCount(snapshot,now);
    if(workers){live=true;basis='swarm_worker_lease';}
  }else if(run?.source_kind==='coding'){
    workers=store.codingStages(project,run.source_id).filter(s=>s.status==='running'&&s.owner&&s.lease_until_ms>now).length;
    if(workers){live=true;basis='coding_stage_lease';}
  }else if(run?.source_kind==='coding_dialog'){
    workers=store.codingDialogTurns(project,run.source_id).filter(t=>t.status==='running'&&t.owner&&t.lease_until_ms>now).length;
    if(workers){live=true;basis='coding_turn_lease';}
  }
  const intake=store.hermesState.prepare('SELECT define_owner,define_lease_until_ms FROM office_intake WHERE project_id=? AND work_id=?').get(project,id);
  const supervisor=store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get()?store.hermesState.prepare('SELECT state,owner,lease_until_ms FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,id):null;
  if(supervisor?.state==='running'&&supervisor.owner&&Number(supervisor.lease_until_ms)>now){live=true;workers=Math.max(1,workers);basis='work_supervisor_lease';}
  if(storedStatus==='defining'&&intake?.define_owner&&Number(intake.define_lease_until_ms)>now){live=true;workers=1;basis='definition_lease';}
  const unconfirmed=['running','leased','defining','queued','advising'].includes(storedStatus);
  const status=live?(storedStatus==='defining'?'defining':'running'):supervisor?String(supervisor.state):unconfirmed||dispatch?.owner?'execution_unobserved':storedStatus;
  return {status,stored_status:storedStatus,live,active_workers:live?workers:0,basis,dispatch:dispatch?{state:dispatch.state,reason:dispatch.reason,updated_at:dispatch.updated_at}:null};
}
export function shortWorkTitle(value:string){
  const text=safeControlText(value,200).replace(/^이전 업무\s*[·:—-]\s*/u,'').replace(/\s+/gu,' ').trim();
  if([...text].length<=28)return text;
  const head=[...text].slice(0,27).join('');const boundary=head.lastIndexOf(' ');
  return (boundary>=16?head.slice(0,boundary):head)+'…';
}
