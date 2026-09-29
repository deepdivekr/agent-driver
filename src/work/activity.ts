import {type PackStore} from '../packs/store.js';
import {safeControlText} from '../observability/safe-text.js';

export function initWorkExecution(store:PackStore){
  store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_execution(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,owner TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,reason TEXT,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS office_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,work_id TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS office_activity_work ON office_activity(project_id,work_id,id);
    CREATE INDEX IF NOT EXISTS runtime_activity_owner ON runtime_activity(project_id,owner_kind,owner_id,id);`);
}
export function hasExecutionTable(store:PackStore){return Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_execution'").get());}
export function executionRecord(store:PackStore,project:string,id:string){
  return hasExecutionTable(store)?store.hermesState.prepare('SELECT owner,lease_until_ms,state,reason,updated_at FROM office_execution WHERE project_id=? AND work_id=?').get(project,id) as {owner:string|null;lease_until_ms:number;state:string;reason:string|null;updated_at:string}|undefined:undefined;
}
export function workActivity(store:PackStore,project:string,id:string,kind:string,summary:string){
  store.hermesState.prepare('INSERT INTO office_activity(project_id,work_id,kind,summary,created_at) VALUES(?,?,?,?,?)').run(project,id,kind,safeControlText(summary,800),new Date().toISOString());
}
export interface WorkLog {id:string;kind:string;summary:string;created_at:string;source:string;}
/** Bounded reads of this Work only. No raw provider stdout, credentials or reasoning. */
export function workTail(store:PackStore,project:string,id:string):WorkLog[]{
  store.officeWorkById(project,id);
  const db=store.hermesState,rows:WorkLog[]=[];
  const read=(table:string,sql:string,params:(string|number)[])=>{
    if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))return;
    for(const row of db.prepare(sql).all(...params))rows.push({id:`${table}:${row.id}`,kind:safeControlText(String(row.kind),100),summary:safeControlText(String(row.summary??''),800),created_at:String(row.created_at),source:table});
  };
  read('office_activity','SELECT id,kind,summary,created_at FROM office_activity WHERE project_id=? AND work_id=? ORDER BY id DESC LIMIT 80',[project,id]);
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
    const snapshot=store.swarmRun(project,run.source_id).snapshot as {status:string;workers:Record<string,{status:string;lease_expires_at_ms:number|null}>};
    workers=Object.values(snapshot.workers).filter(w=>w.status==='leased'&&(w.lease_expires_at_ms??0)>now).length;
    if(workers&&snapshot.status==='running'){live=true;basis='swarm_worker_lease';}
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
