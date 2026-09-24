import {randomUUID} from 'node:crypto';
import {TerminalStore} from '../terminal/store.js';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type Recipe} from './contracts.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {redact} from '../terminal/contracts.js';
import {DecisionMemory} from '../decision-plane/memory.js';
import {type CodingPlan} from '../coding/contracts.js';
import {type LocalGitCheckpoint} from '../coding/local-checkpoint.js';
import {clientHandoffSchema,makeClientHandoff,type ClientHandoff,type ClientRouteEvent} from '../integrations/client-handoff.js';

export interface PackRun {id:string;project_id:string;request_id:string;binding:string;recipe:Recipe;status:string;result:unknown;task_id:string|null;}
export interface PackExecution {run_id:string;attempts:number;auth_waits:number;owner:string|null;lease_until_ms:number;retry_at_ms:number;checkpoint:Record<string,unknown>;}
export const PACK_LEASE_MS=15_000;
export const PACK_MAX_ATTEMPTS=3;
export interface SwarmActivity {id:number;project_id:string;run_id:string;revision:number;worker_id:string|null;kind:string;body:unknown;created_at:string;}
export type DecisionLayer='llm'|'jev'|'code';
export interface RuntimeActivity {id:number;project_id:string;owner_kind:'pack'|'task'|'terminal';owner_id:string;actor_id:string|null;kind:string;summary:string;endpoint:string|null;surface_id:string|null;decision_layer:DecisionLayer|null;created_at:string;}
export interface RuntimePresence {id:string;project_id:string;kind:'mcp'|'dashboard';state:'active'|'stopped';started_at:string;heartbeat_at:string;stopped_at:string|null;metadata:Record<string,unknown>;}
export interface ManagedControlSurface {id:string;project_id:string;run_id:string;worker_id:string;kind:'browser';preview_endpoint:string;state:'active'|'closed'|'failed';updated_at:string;}
export interface OfficeControl {project_id:string;run_id:string;paused:boolean;revision:number;paused_at_ms:number|null;updated_at:string;}
export interface OfficeEvent {id:number;run_id:string;worker_id:string|null;kind:string;detail:string;created_at:string;}
export interface IntakeWork {
  id:string;project_id:string;request_id:string;prompt:string;mode:'quick'|'guided';status:string;
  revision:number;spec:unknown|null;questions:unknown[];answers:Record<string,string>;
  paused:boolean;created_at:string;updated_at:string;
}
export interface CodingRun {id:string;project_id:string;request_id:string;work_id:string;project_ref:string;project_root:string;config_fingerprint:string;plan:CodingPlan;status:string;revision:number;paused:boolean;created_at:string;updated_at:string;}
export interface CodingStageRow {run_id:string;stage_id:string;ordinal:number;status:string;session_id:string|null;attempts:number;summary:string|null;receipt:unknown|null;started_at:string|null;finished_at:string|null;owner:string|null;lease_until_ms:number;}
export interface CodingCheckpointRow {run_id:string;project_id:string;revision:number;head:string;state_sha256:string;changed_paths:string[];updated_at:string;}
const safeEndpoint=(value:string|null)=>{if(value===null)return null;try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;const path=url.pathname.split('/').map((part,index,all)=>part&&(/^(?:token|secret|password|api-?key|auth|session)$/iu.test(all[index-1]??'')||part.length>64||/^[A-Za-z0-9_-]{32,}$/u.test(part))?':redacted':part).join('/');return `${url.origin}${path}`;}catch{return null;}};
const safeSummary=(value:string)=>redact(value).replace(/https?:\/\/[^\s<>"']+/giu,url=>safeEndpoint(url)??'[REDACTED_URL]').replace(/((?:token|secret|password|api.?key)\s*[:=]\s*)\S+/giu,'$1[REDACTED]');
export class PackStore extends TerminalStore {
  get decisionMemory(){return new DecisionMemory(this.connection);}
  constructor(path:string){super(path);this.connection.exec(`
    CREATE TABLE IF NOT EXISTS family_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,task_id TEXT,UNIQUE(project_id,request_id));
    CREATE TABLE IF NOT EXISTS family_spec(project_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,PRIMARY KEY(project_id,prompt_hash));
    CREATE TABLE IF NOT EXISTS family_execution(run_id TEXT PRIMARY KEY REFERENCES family_run(id),attempts INTEGER NOT NULL DEFAULT 0,auth_waits INTEGER NOT NULL DEFAULT 0,owner TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,retry_at_ms INTEGER NOT NULL DEFAULT 0,checkpoint TEXT NOT NULL DEFAULT '{}');
    CREATE TABLE IF NOT EXISTS family_watch(run_id TEXT PRIMARY KEY,next_ms INTEGER NOT NULL,paused INTEGER NOT NULL DEFAULT 0,baseline TEXT NOT NULL,cycle INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS family_event(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,run_id TEXT NOT NULL,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS swarm_plan(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,binding TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS swarm_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,binding TEXT NOT NULL,plan_id TEXT NOT NULL,revision INTEGER NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_id));
    CREATE TABLE IF NOT EXISTS swarm_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,run_id TEXT NOT NULL,revision INTEGER NOT NULL,worker_id TEXT,kind TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS swarm_activity_project_id ON swarm_activity(project_id,id);
    CREATE INDEX IF NOT EXISTS swarm_activity_run_id ON swarm_activity(run_id,id);
    CREATE TABLE IF NOT EXISTS runtime_activity(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,owner_kind TEXT NOT NULL,owner_id TEXT NOT NULL,actor_id TEXT,kind TEXT NOT NULL,summary TEXT NOT NULL,endpoint TEXT,surface_id TEXT,decision_layer TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runtime_activity_project_id ON runtime_activity(project_id,id);
    CREATE INDEX IF NOT EXISTS runtime_activity_owner_id ON runtime_activity(owner_kind,owner_id,id);
    CREATE TABLE IF NOT EXISTS runtime_presence(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,started_at TEXT NOT NULL,heartbeat_at TEXT NOT NULL,stopped_at TEXT,metadata TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS runtime_presence_project_id ON runtime_presence(project_id,heartbeat_at);
    CREATE TABLE IF NOT EXISTS control_surface(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,run_id TEXT NOT NULL,worker_id TEXT NOT NULL,kind TEXT NOT NULL,preview_endpoint TEXT NOT NULL,state TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,run_id,worker_id));
    CREATE TABLE IF NOT EXISTS swarm_observed_url(project_id TEXT NOT NULL,run_id TEXT NOT NULL,worker_id TEXT NOT NULL,url TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(project_id,run_id,worker_id,url));
    CREATE TABLE IF NOT EXISTS browser_auth(project_id TEXT NOT NULL,profile TEXT NOT NULL,site TEXT NOT NULL,state TEXT NOT NULL,handoff INTEGER NOT NULL DEFAULT 0,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,profile,site));
    CREATE TABLE IF NOT EXISTS office_control(project_id TEXT NOT NULL,run_id TEXT NOT NULL,paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,paused_at_ms INTEGER,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,run_id));
    CREATE TABLE IF NOT EXISTS office_work(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,goal TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS office_work_project_updated ON office_work(project_id,updated_at);
    CREATE TABLE IF NOT EXISTS office_intake(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,prompt TEXT NOT NULL,spec TEXT NOT NULL,questions TEXT NOT NULL,answers TEXT NOT NULL,define_owner TEXT,define_lease_until_ms INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_id));
    CREATE INDEX IF NOT EXISTS office_intake_project_updated ON office_intake(project_id,updated_at);
    CREATE TABLE IF NOT EXISTS office_work_revision(work_id TEXT NOT NULL REFERENCES office_work(id),revision INTEGER NOT NULL,kind TEXT NOT NULL,spec TEXT NOT NULL,answers TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(work_id,revision));
    CREATE TABLE IF NOT EXISTS office_run(project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),source_kind TEXT NOT NULL,source_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,source_kind,source_id));
    CREATE TABLE IF NOT EXISTS office_step_instruction(project_id TEXT NOT NULL,run_id TEXT NOT NULL,worker_id TEXT NOT NULL,version INTEGER NOT NULL,instruction TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,run_id,worker_id,version));
    CREATE TABLE IF NOT EXISTS office_event(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,run_id TEXT NOT NULL,worker_id TEXT,kind TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS office_event_run_id ON office_event(project_id,run_id,id);
    CREATE TABLE IF NOT EXISTS client_handoff(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT,run_id TEXT,stage_id TEXT,source TEXT NOT NULL,target TEXT,source_model TEXT NOT NULL,target_model TEXT,reason TEXT NOT NULL,effect_state TEXT NOT NULL,status TEXT NOT NULL,input_sha256 TEXT,created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS client_handoff_work ON client_handoff(project_id,work_id,created_at);
    CREATE INDEX IF NOT EXISTS client_handoff_run ON client_handoff(project_id,run_id,created_at);
    CREATE TABLE IF NOT EXISTS coding_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),project_ref TEXT NOT NULL,project_root TEXT NOT NULL,config_fingerprint TEXT NOT NULL,plan TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_id));
    CREATE TABLE IF NOT EXISTS coding_stage(run_id TEXT NOT NULL REFERENCES coding_run(id),stage_id TEXT NOT NULL,ordinal INTEGER NOT NULL,status TEXT NOT NULL,session_id TEXT,attempts INTEGER NOT NULL DEFAULT 0,summary TEXT,receipt TEXT,started_at TEXT,finished_at TEXT,owner TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(run_id,stage_id),UNIQUE(run_id,ordinal));
    CREATE TABLE IF NOT EXISTS coding_checkpoint(run_id TEXT PRIMARY KEY REFERENCES coding_run(id),project_id TEXT NOT NULL,revision INTEGER NOT NULL,head TEXT NOT NULL,state_sha256 TEXT NOT NULL,changed_paths TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS coding_run_work ON coding_run(project_id,work_id,created_at);
  `);
    const columns=new Set((this.connection.prepare('PRAGMA table_info(runtime_activity)').all() as Array<{name:string}>).map(column=>column.name));
    if(!columns.has('surface_id'))this.connection.exec('ALTER TABLE runtime_activity ADD COLUMN surface_id TEXT');
    if(!columns.has('decision_layer'))this.connection.exec('ALTER TABLE runtime_activity ADD COLUMN decision_layer TEXT');
    const executionColumns=new Set((this.connection.prepare('PRAGMA table_info(family_execution)').all() as Array<{name:string}>).map(column=>column.name));
    if(!executionColumns.has('auth_waits'))this.connection.exec('ALTER TABLE family_execution ADD COLUMN auth_waits INTEGER NOT NULL DEFAULT 0');
    const codingColumns=new Set((this.connection.prepare('PRAGMA table_info(coding_stage)').all() as Array<{name:string}>).map(column=>column.name));
    if(!codingColumns.has('owner'))this.connection.exec('ALTER TABLE coding_stage ADD COLUMN owner TEXT');
    if(!codingColumns.has('lease_until_ms'))this.connection.exec('ALTER TABLE coding_stage ADD COLUMN lease_until_ms INTEGER NOT NULL DEFAULT 0');
  }
  packRuns(project:string,limit=30):PackRun[]{
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=100,'PACK_RUN_LIMIT_INVALID');
    return this.connection.prepare('SELECT * FROM family_run WHERE project_id=? ORDER BY rowid DESC LIMIT ?').all(project,limit).map(row=>({...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))})) as unknown as PackRun[];
  }
  browserAuthEntries(project:string,profile:string){return this.connection.prepare('SELECT site,state,handoff,updated_at FROM browser_auth WHERE project_id=? AND profile=? ORDER BY site').all(project,profile);}
  setBrowserAuth(project:string,profile:string,site:string,state:string,handoff:boolean){this.connection.prepare('INSERT INTO browser_auth VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,profile,site) DO UPDATE SET state=excluded.state,handoff=excluded.handoff,updated_at=excluded.updated_at').run(project,profile,site,state,Number(handoff),new Date().toISOString());}
  claimBrowserHandoff(project:string,profile:string,site:string){this.transaction(()=>{
    const runs=this.connection.prepare('SELECT snapshot FROM swarm_run WHERE project_id=?').all(project).map(row=>JSON.parse(String(row.snapshot)) as SwarmRunSnapshot);
    requireCondition(!runs.some(run=>['running','needs_human'].includes(run.status)&&run.plan.workers.some(def=>def.source_urls.length>0&&run.workers[def.id]?.status==='leased'&&(run.workers[def.id]?.lease_expires_at_ms??0)>Date.now())),'AUTH_WAIT_FOR_ACTIVE_WORKERS');
    requireCondition(!this.controlSurfaces(project).some(surface=>surface.state==='active'),'AUTH_WAIT_FOR_ACTIVE_WORKERS');
    this.setBrowserAuth(project,profile,site,'needs_login',true);
  });}
  packRun(project:string,id:string):PackRun{
    const row=this.connection.prepare('SELECT * FROM family_run WHERE project_id=? AND id=?').get(project,id);requireCondition(row,'PACK_RUN_NOT_FOUND');
    return {...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))} as unknown as PackRun;
  }
  beginPack(project:string,requestId:string,recipe:Recipe,fingerprint:string,workId?:string){
    const binding=snapshotHash({recipe,fingerprint});
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id,binding FROM family_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){requireCondition(old.binding===binding,'PACK_REQUEST_ID_CONFLICT');if(workId)requireCondition((this.officeWork(project,'pack',String(old.id)) as {id:string}|null)?.id===workId,'WORK_RUN_BINDING_CONFLICT');return {run:this.packRun(project,String(old.id)),created:false};}
      const assignedWork=this.assertWorkRunBinding(project,requestId,'pack',recipe.family,workId);
      const id=randomUUID();this.connection.prepare('INSERT INTO family_run VALUES (?,?,?,?,?,?,?,?)').run(id,project,requestId,binding,JSON.stringify(recipe),'running','null',null);
      this.registerOfficeRun(project,'pack',id,recipe.request,undefined,requestId,assignedWork??undefined);
      this.recordRuntimeActivity(project,'pack',id,null,'run.started',`Started ${recipe.family}`,null);
      return {run:this.packRun(project,id),created:true};
    });
  }
  finishPack(project:string,id:string,status:string,result:unknown,taskId:string|null=null){
    const before=this.packRun(project,id);this.connection.prepare('UPDATE family_run SET status=?,result=?,task_id=COALESCE(?,task_id) WHERE id=? AND project_id=?').run(status,JSON.stringify(result),taskId,id,project);
    if(before.status!==status)this.recordRuntimeActivity(project,'pack',id,null,`run.${status}`,`Pack ${status}`,null);
    return this.packRun(project,id);
  }
  packExecution(project:string,id:string):PackExecution|null{
    this.packRun(project,id);const row=this.connection.prepare('SELECT * FROM family_execution WHERE run_id=?').get(id);
    return row?{...row,checkpoint:JSON.parse(String(row.checkpoint))} as unknown as PackExecution:null;
  }
  claimPackExecution(project:string,id:string,now=Date.now()){
    return this.transaction(()=>{
      this.packRun(project,id);this.connection.prepare('INSERT OR IGNORE INTO family_execution(run_id) VALUES (?)').run(id);
      const current=this.packExecution(project,id)!;
      if(current.owner!==null&&current.lease_until_ms>now)return {claimed:false as const,reason:'active_owner' as const,execution:current};
      if(current.attempts-current.auth_waits>=PACK_MAX_ATTEMPTS)return {claimed:false as const,reason:'attempts_exhausted' as const,execution:current};
      const owner=randomUUID();this.connection.prepare('UPDATE family_execution SET owner=?,lease_until_ms=?,attempts=attempts+1,retry_at_ms=0 WHERE run_id=?').run(owner,now+PACK_LEASE_MS,id);
      this.connection.prepare("UPDATE family_run SET status='running' WHERE id=?").run(id);
      this.recordRuntimeActivity(project,'pack',id,null,current.attempts?'run.resumed':'run.claimed',`Execution attempt ${current.attempts+1}`,null);
      return {claimed:true as const,owner,execution:this.packExecution(project,id)!};
    });
  }
  renewPackExecution(project:string,id:string,owner:string,now=Date.now()){
    this.packRun(project,id);return this.connection.prepare('UPDATE family_execution SET lease_until_ms=? WHERE run_id=? AND owner=? AND lease_until_ms>?').run(now+PACK_LEASE_MS,id,owner,now).changes===1;
  }
  assertPackExecution(project:string,id:string,owner:string){
    const state=this.packExecution(project,id);requireCondition(state?.owner===owner&&state.lease_until_ms>Date.now(),'PACK_EXECUTION_LEASE_LOST');
  }
  checkpointPack(project:string,id:string,owner:string,checkpoint:Record<string,unknown>){
    this.transaction(()=>{this.assertPackExecution(project,id,owner);this.connection.prepare('UPDATE family_execution SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),id);});
  }
  linkPackTask(project:string,id:string,owner:string,taskId:string){
    this.assertPackExecution(project,id,owner);requireCondition(this.task(taskId).project_id===project,'TASK_SCOPE_MISMATCH');
    this.connection.prepare('UPDATE family_run SET task_id=? WHERE project_id=? AND id=?').run(taskId,project,id);
  }
  settlePackExecution(project:string,id:string,owner:string,status:string,result:unknown,taskId:string|null=null,retryAt=0){
    return this.transaction(()=>{
      this.assertPackExecution(project,id,owner);const run=this.finishPack(project,id,status,result,taskId);
      this.connection.prepare('UPDATE family_execution SET owner=NULL,lease_until_ms=0,retry_at_ms=?,auth_waits=auth_waits+? WHERE run_id=?').run(retryAt,Number(status==='waiting_auth'),id);return run;
    });
  }
  recoverablePacks(project:string,now:number){
    return this.connection.prepare(`SELECT r.* FROM family_run r LEFT JOIN family_execution e ON r.id=e.run_id
      WHERE r.project_id=? AND
      ((r.status='retryable_failure' AND (e.attempts IS NULL OR e.attempts-e.auth_waits<?) AND e.retry_at_ms<=?) OR (r.status='running' AND (e.owner IS NULL OR e.lease_until_ms<=?)))
      ORDER BY r.rowid LIMIT 5`).all(project,PACK_MAX_ATTEMPTS,now,now).map(row=>({...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))})) as unknown as PackRun[];
  }
  pausePackForConfig(project:string,id:string,expectedBinding:string,now=Date.now()){
    return this.transaction(()=>{
      const run=this.packRun(project,id),execution=this.packExecution(project,id);
      if(run.binding===expectedBinding||!['running','retryable_failure'].includes(run.status)||execution?.owner&&execution.lease_until_ms>now)return false;
      this.finishPack(project,id,'paused_config',{error:'CONFIG_CHANGED',previous_status:run.status,previous_result:run.result,dispatch_allowed:false});
      this.connection.prepare('UPDATE family_execution SET owner=NULL,lease_until_ms=0,retry_at_ms=0 WHERE run_id=?').run(id);return true;
    });
  }
  cachePack(project:string,recipe:Recipe,fingerprint:string){
    this.connection.prepare('INSERT INTO family_spec VALUES (?,?,?,?) ON CONFLICT(project_id,prompt_hash) DO UPDATE SET binding=excluded.binding,recipe=excluded.recipe').run(project,snapshotHash(recipe.request),fingerprint,JSON.stringify(recipe));
  }
  cachedPack(project:string,prompt:string,fingerprint:string):Recipe|null{
    const row=this.connection.prepare('SELECT * FROM family_spec WHERE project_id=? AND prompt_hash=? AND binding=?').get(project,snapshotHash(prompt),fingerprint);return row?JSON.parse(String(row.recipe)) as Recipe:null;
  }
  scheduleWatch(runId:string,interval:number,baseline:unknown,now=Date.now()){
    this.connection.prepare('INSERT OR IGNORE INTO family_watch(run_id,next_ms,baseline) VALUES (?,?,?)').run(runId,now+interval,JSON.stringify(baseline));
  }
  pauseWatch(project:string,id:string,paused:boolean){
    this.packRun(project,id);const result=this.connection.prepare('UPDATE family_watch SET paused=? WHERE run_id=?').run(Number(paused),id);requireCondition(result.changes===1,'PACK_WATCH_NOT_FOUND');
  }
  dueWatches(project:string,now:number){return this.connection.prepare('SELECT w.run_id,w.baseline,w.cycle FROM family_watch w JOIN family_run r ON r.id=w.run_id WHERE r.project_id=? AND w.paused=0 AND w.next_ms<=? ORDER BY w.next_ms LIMIT 5').all(project,now);}
  claimWatch(id:string,cycle:number,now:number,interval:number){
    // Claim before I/O. Crash skips one interval, never replays a write or storms missed intervals.
    return this.connection.prepare('UPDATE family_watch SET next_ms=?,cycle=cycle+1 WHERE run_id=? AND cycle=? AND paused=0 AND next_ms<=?').run(now+interval,id,cycle,now).changes===1;
  }
  settleWatch(project:string,id:string,cycle:number,baseline:unknown,kind:string|null,body:unknown){
    return this.transaction(()=>{
      const row=this.connection.prepare('SELECT cycle,paused FROM family_watch WHERE run_id=?').get(id);if(row?.cycle!==cycle||row.paused!==0)return false;
      this.connection.prepare('UPDATE family_watch SET baseline=? WHERE run_id=?').run(JSON.stringify(baseline),id);
      if(kind)this.connection.prepare('INSERT INTO family_event(project_id,run_id,kind,body,created_at) VALUES (?,?,?,?,?)').run(project,id,kind,JSON.stringify(body),new Date().toISOString());return true;
    });
  }
  packEvents(project:string,after:number,limit:number){return this.connection.prepare('SELECT * FROM family_event WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(project,after,limit).map(row=>({...row,body:JSON.parse(String(row.body)) as unknown}));}
  taskEventsReadOnly(project:string,limit=1000){
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=2000,'TASK_EVENT_LIMIT_INVALID');this.project(project);
    return this.connection.prepare('SELECT id,project_id,task_id,kind,data_json,created_at FROM event WHERE project_id=? ORDER BY id DESC LIMIT ?').all(project,limit).reverse().map(row=>({...row,id:Number(row.id),data:JSON.parse(String(row.data_json)) as unknown,data_json:undefined}));
  }
  terminalTurns(project:string,limit=100){
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=500,'TERMINAL_TURN_LIMIT_INVALID');
    return this.connection.prepare('SELECT t.id,t.session_id,t.status,t.created_at FROM terminal_turn t JOIN terminal_session s ON s.id=t.session_id WHERE s.project_id=? ORDER BY t.created_at DESC,t.id DESC LIMIT ?').all(project,limit);
  }
  recordRuntimeActivity(project:string,ownerKind:RuntimeActivity['owner_kind'],ownerId:string,actorId:string|null,kind:string,summary:string,endpoint:string|null,createdAt=new Date().toISOString(),surfaceId:string|null=null,decisionLayer:DecisionLayer|null=null){
    requireCondition(summary.length>=1&&summary.length<=500&&/^[a-z][a-z0-9._-]{0,79}$/u.test(kind),'RUNTIME_ACTIVITY_INVALID');
    requireCondition(surfaceId===null||/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(surfaceId),'RUNTIME_SURFACE_INVALID');
    requireCondition(decisionLayer===null||['llm','jev','code'].includes(decisionLayer),'RUNTIME_DECISION_LAYER_INVALID');
    if(ownerKind==='pack')this.packRun(project,ownerId);
    else if(ownerKind==='task')requireCondition(this.task(ownerId).project_id===project,'TASK_SCOPE_MISMATCH');
    else requireCondition(this.session(ownerId).project_id===project,'SESSION_SCOPE_MISMATCH');
    return Number(this.connection.prepare('INSERT INTO runtime_activity(project_id,owner_kind,owner_id,actor_id,kind,summary,endpoint,surface_id,decision_layer,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(project,ownerKind,ownerId,actorId,kind,safeSummary(summary),safeEndpoint(endpoint),surfaceId,decisionLayer,createdAt).lastInsertRowid);
  }
  runtimeActivities(project:string,after=0,limit=1000):RuntimeActivity[]{
    requireCondition(Number.isSafeInteger(after)&&after>=0&&Number.isInteger(limit)&&limit>=1&&limit<=2000,'RUNTIME_ACTIVITY_QUERY_INVALID');
    return this.connection.prepare('SELECT * FROM runtime_activity WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(project,after,limit).map(row=>({...row,id:Number(row.id)})) as unknown as RuntimeActivity[];
  }
  startPresence(project:string,kind:RuntimePresence['kind'],metadata:Record<string,unknown>={}){
    this.project(project);const id=randomUUID(),now=new Date().toISOString();
    this.connection.prepare("INSERT INTO runtime_presence(id,project_id,kind,state,started_at,heartbeat_at,metadata) VALUES (?,?,?,'active',?,?,?)").run(id,project,kind,now,now,JSON.stringify(metadata));return id;
  }
  heartbeatPresence(project:string,id:string){
    const result=this.connection.prepare("UPDATE runtime_presence SET heartbeat_at=? WHERE project_id=? AND id=? AND state='active'").run(new Date().toISOString(),project,id);requireCondition(result.changes===1,'PRESENCE_NOT_ACTIVE');
  }
  stopPresence(project:string,id:string){const now=new Date().toISOString();this.connection.prepare("UPDATE runtime_presence SET state='stopped',heartbeat_at=?,stopped_at=? WHERE project_id=? AND id=? AND state='active'").run(now,now,project,id);}
  presences(project:string,limit=50):RuntimePresence[]{
    return this.connection.prepare('SELECT * FROM runtime_presence WHERE project_id=? ORDER BY heartbeat_at DESC LIMIT ?').all(project,limit).map(row=>({...row,metadata:JSON.parse(String(row.metadata))})) as unknown as RuntimePresence[];
  }
  controlSurfaces(project:string):ManagedControlSurface[]{
    return this.connection.prepare('SELECT * FROM control_surface WHERE project_id=? ORDER BY updated_at DESC LIMIT 1000').all(project) as unknown as ManagedControlSurface[];
  }
  bindControlSurface(project:string,runId:string,workerId:string,leaseToken:string,id:string,endpoint:string){
    const snapshot=this.swarmRun(project,runId).snapshot as SwarmRunSnapshot,worker=snapshot.workers[workerId];
    requireCondition(['running','needs_human'].includes(snapshot.status)&&worker?.status==='leased'&&worker.lease_token===leaseToken&&(worker.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
    const url=endpoint?new URL(endpoint):null;
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(id)&&(!url||url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)>=1024&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[a-f0-9]{48}\/frame\/[a-zA-Z0-9._-]+$/u.test(url.pathname)),'CONTROL_MANAGED_ENDPOINT_INVALID');
    this.connection.prepare("INSERT INTO control_surface VALUES (?,?,?,?,?,?,'active',?) ON CONFLICT(project_id,run_id,worker_id) DO UPDATE SET id=excluded.id,preview_endpoint=excluded.preview_endpoint,state='active',updated_at=excluded.updated_at").run(id,project,runId,workerId,'browser',endpoint,new Date().toISOString());
  }
  endControlSurface(project:string,runId:string,workerId:string,state:'closed'|'failed'){
    this.connection.prepare('UPDATE control_surface SET state=?,updated_at=? WHERE project_id=? AND run_id=? AND worker_id=?').run(state,new Date().toISOString(),project,runId,workerId);
  }
  recordObservedUrl(project:string,runId:string,workerId:string,leaseToken:string,url:string){
    const snapshot=this.swarmRun(project,runId).snapshot as SwarmRunSnapshot,worker=snapshot.workers[workerId];
    requireCondition(['running','needs_human'].includes(snapshot.status)&&worker?.status==='leased'&&worker.lease_token===leaseToken&&(worker.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
    const parsed=new URL(url);requireCondition(['http:','https:'].includes(parsed.protocol)&&!parsed.username&&!parsed.password&&url.length<=4096,'CONTROL_OBSERVED_URL_INVALID');
    this.connection.prepare('INSERT OR IGNORE INTO swarm_observed_url VALUES (?,?,?,?,?)').run(project,runId,workerId,url,new Date().toISOString());
  }
  observedUrls(project:string,runId:string,workerId:string):string[]{
    return this.connection.prepare('SELECT url FROM swarm_observed_url WHERE project_id=? AND run_id=? AND worker_id=? ORDER BY observed_at LIMIT 200').all(project,runId,workerId).map(row=>String(row.url));
  }
  saveSwarmPlan(project:string,plan:{plan_id:string},fingerprint:string){
    const binding=snapshotHash({plan,fingerprint}),now=new Date().toISOString();
    this.connection.prepare('INSERT INTO swarm_plan VALUES (?,?,?,?,?)').run(plan.plan_id,project,binding,JSON.stringify(plan),now);
  }
  swarmPlan(project:string,id:string){
    const row=this.connection.prepare('SELECT binding,body FROM swarm_plan WHERE project_id=? AND id=?').get(project,id);requireCondition(row,'SWARM_PLAN_NOT_FOUND');return {plan:JSON.parse(String(row.body)) as unknown,binding:String(row.binding)};
  }
  beginSwarmRun(project:string,requestId:string,planId:string,snapshot:SwarmRunSnapshot,fingerprint:string,workId?:string){
    const binding=snapshotHash({plan:snapshot.plan,fingerprint});
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id,binding,snapshot FROM swarm_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){requireCondition(old.binding===binding,'SWARM_REQUEST_ID_CONFLICT');if(workId)requireCondition((this.officeWork(project,'swarm',String(old.id)) as {id:string}|null)?.id===workId,'WORK_RUN_BINDING_CONFLICT');return {snapshot:JSON.parse(String(old.snapshot)) as unknown,binding:String(old.binding)};}
      const assignedWork=this.assertWorkRunBinding(project,requestId,'swarm',undefined,workId);
      this.connection.prepare('INSERT INTO swarm_run VALUES (?,?,?,?,?,?,?,?,?)').run(snapshot.run_id,project,requestId,binding,planId,snapshot.revision,JSON.stringify(snapshot),snapshot.created_at,snapshot.updated_at);
      this.registerOfficeRun(project,'swarm',snapshot.run_id,snapshot.plan.goal,snapshot.created_at,requestId,assignedWork??undefined);
      this.appendSwarmActivity(project,snapshot.run_id,snapshot.revision,null,'run.started',{status:snapshot.status,worker_count:Object.keys(snapshot.workers).length,mode:snapshot.mode},snapshot.created_at);
      return {snapshot,binding};
    });
  }
  swarmRun(project:string,id:string){
    const row=this.connection.prepare('SELECT binding,snapshot FROM swarm_run WHERE project_id=? AND id=?').get(project,id);requireCondition(row,'SWARM_RUN_NOT_FOUND');return {snapshot:JSON.parse(String(row.snapshot)) as unknown,binding:String(row.binding)};
  }
  swarmRuns(project:string,limit=20):SwarmRunSnapshot[]{
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=100,'SWARM_RUN_LIMIT_INVALID');
    return this.connection.prepare('SELECT snapshot FROM swarm_run WHERE project_id=? ORDER BY updated_at DESC,id DESC LIMIT ?').all(project,limit).map(row=>JSON.parse(String(row.snapshot)) as SwarmRunSnapshot);
  }
  officeControl(project:string,runId:string):OfficeControl{
    this.swarmRun(project,runId);
    const row=this.connection.prepare('SELECT * FROM office_control WHERE project_id=? AND run_id=?').get(project,runId);
    return row?{...row,paused:Boolean(row.paused),revision:Number(row.revision),paused_at_ms:row.paused_at_ms===null?null:Number(row.paused_at_ms)} as unknown as OfficeControl:{project_id:project,run_id:runId,paused:false,revision:0,paused_at_ms:null,updated_at:''};
  }
  beginWork(project:string,requestId:string,prompt:string,mode:'quick'|'guided'):{work:IntakeWork;created:boolean}{
    const hash=snapshotHash(prompt);
    return this.transaction(()=>{
      const previous=this.connection.prepare('SELECT work_id,prompt_hash,mode FROM office_intake WHERE project_id=? AND request_id=?').get(project,requestId);
      if(previous){
        requireCondition(String(previous.prompt_hash)===hash&&String(previous.mode)===mode,'WORK_REQUEST_ID_CONFLICT');
        return {work:this.intakeWork(project,String(previous.work_id)),created:false};
      }
      const id=randomUUID(),at=new Date().toISOString();
      this.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run(id,project,'새 업무',prompt,at,at);
      this.connection.prepare('INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,requestId,hash,mode,'defining',0,prompt,'null','[]','{}',at,at);
      this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(id,0,'received','null','{}',at);
      return {work:this.intakeWork(project,id),created:true};
    });
  }
  intakeWork(project:string,id:string):IntakeWork{
    const row=this.connection.prepare('SELECT * FROM office_intake WHERE project_id=? AND work_id=?').get(project,id);
    requireCondition(row,'WORK_NOT_FOUND');
    return {id:String(row.work_id),project_id:project,request_id:String(row.request_id),prompt:String(row.prompt),mode:String(row.mode) as IntakeWork['mode'],status:String(row.status),revision:Number(row.revision),spec:JSON.parse(String(row.spec)),questions:JSON.parse(String(row.questions)),answers:JSON.parse(String(row.answers)),paused:Boolean(row.paused),created_at:String(row.created_at),updated_at:String(row.updated_at)};
  }
  intakeWorks(project:string,limit=100):IntakeWork[]{
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=200,'WORK_LIMIT_INVALID');
    const ids=this.connection.prepare('SELECT work_id FROM office_intake WHERE project_id=? ORDER BY updated_at DESC LIMIT ?').all(project,limit);
    return ids.map(row=>this.intakeWork(project,String(row.work_id)));
  }
  claimWorkDefinition(project:string,id:string,now=Date.now()){
    const owner=randomUUID(),until=now+90_000;
    const result=this.connection.prepare("UPDATE office_intake SET define_owner=?,define_lease_until_ms=? WHERE project_id=? AND work_id=? AND status IN ('defining','needs_model') AND (define_owner IS NULL OR define_lease_until_ms<=?)").run(owner,until,project,id,now);
    return result.changes===1?owner:null;
  }
  finishWorkDefinition(project:string,id:string,owner:string,spec:unknown,questions:unknown[],status:'ready'|'awaiting_details'){
    return this.transaction(()=>{
      const current=this.intakeWork(project,id),at=new Date().toISOString();
      const changed=this.connection.prepare('UPDATE office_intake SET status=?,revision=revision+1,spec=?,questions=?,define_owner=NULL,define_lease_until_ms=0,updated_at=? WHERE project_id=? AND work_id=? AND define_owner=? AND define_lease_until_ms>?').run(status,JSON.stringify(spec),JSON.stringify(questions),at,project,id,owner,Date.now());
      requireCondition(changed.changes===1,'WORK_DEFINITION_LEASE_LOST');
      const title=typeof spec==='object'&&spec!==null&&'title' in spec?String(spec.title):'새 업무';
      const outcome=typeof spec==='object'&&spec!==null&&'desired_outcome' in spec?String(spec.desired_outcome):current.prompt;
      this.connection.prepare('UPDATE office_work SET title=?,goal=?,updated_at=? WHERE id=? AND project_id=?').run(title,outcome,at,id,project);
      this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(id,current.revision+1,'defined',JSON.stringify(spec),JSON.stringify(current.answers),at);
      return this.intakeWork(project,id);
    });
  }
  failWorkDefinition(project:string,id:string,owner:string){
    this.connection.prepare("UPDATE office_intake SET status='needs_model',define_owner=NULL,define_lease_until_ms=0,updated_at=? WHERE project_id=? AND work_id=? AND define_owner=?").run(new Date().toISOString(),project,id,owner);
    return this.intakeWork(project,id);
  }
  answerWork(project:string,id:string,expected:number,answers:Record<string,string>){
    return this.transaction(()=>{
      const work=this.intakeWork(project,id);requireCondition(work.revision===expected,'WORK_REVISION_CONFLICT');
      requireCondition(work.status==='awaiting_details','WORK_NOT_AWAITING_DETAILS');
      const questions=work.questions as Array<{id:string;required:boolean;options:Array<{id:string}>}>;
      requireCondition(Object.keys(answers).every(key=>questions.some(question=>question.id===key)),'WORK_ANSWER_UNKNOWN');
      requireCondition(questions.every(question=>!question.required||Boolean(answers[question.id])),'WORK_REQUIRED_ANSWER_MISSING');
      const at=new Date().toISOString(),next={...work.answers,...answers};
      const changed=this.connection.prepare("UPDATE office_intake SET status='defining',revision=revision+1,answers=?,questions='[]',updated_at=? WHERE project_id=? AND work_id=? AND revision=?").run(JSON.stringify(next),at,project,id,expected);
      requireCondition(changed.changes===1,'WORK_REVISION_CONFLICT');
      this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(id,expected+1,'answered',JSON.stringify(work.spec),JSON.stringify(next),at);
      return this.intakeWork(project,id);
    });
  }
  workRevisions(project:string,id:string){
    this.intakeWork(project,id);
    return this.connection.prepare('SELECT revision,kind,created_at FROM office_work_revision WHERE work_id=? ORDER BY revision').all(id);
  }
  workDirections(project:string,id:string){
    this.intakeWork(project,id);
    return this.connection.prepare("SELECT spec FROM office_work_revision WHERE work_id=? AND kind='direction_changed' ORDER BY revision DESC LIMIT 20").all(id).reverse().map(row=>JSON.parse(String(row.spec)) as {run_id:string;step_id:string;instruction:string;created_at:string});
  }
  setIntakePaused(project:string,id:string,expectedRevision:number,paused:boolean){
    return this.transaction(()=>{
      const work=this.intakeWork(project,id);
      requireCondition(work.revision===expectedRevision,'WORK_REVISION_CONFLICT');
      requireCondition(work.paused!==paused,'WORK_PAUSE_STATE_UNCHANGED');
      requireCondition(['ready','running','needs_model'].includes(work.status),'WORK_NOT_PAUSABLE');
      const latest=this.officeRuns(project,id)[0];
      if(latest?.source_kind==='swarm')requireCondition(!['running','needs_human'].includes((this.swarmRun(project,latest.source_id).snapshot as SwarmRunSnapshot).status),'WORK_ACTIVE_RUN_USE_STEP_CONTROL');
      if(latest?.source_kind==='pack')requireCondition(!['running','retryable_failure','waiting_auth','waiting_approval','approved','reconciliation_required'].includes(this.packRun(project,latest.source_id).status),'WORK_ACTIVE_PACK_NOT_PAUSABLE');
      if(latest?.source_kind==='coding')requireCondition(!['ready','running','reconciliation_required'].includes(this.codingRun(project,latest.source_id).status),'WORK_ACTIVE_CODING_USE_RUN_CONTROL');
      const at=new Date().toISOString(),revision=work.revision+1;
      this.connection.prepare('UPDATE office_intake SET paused=?,revision=?,updated_at=? WHERE project_id=? AND work_id=?').run(Number(paused),revision,at,project,id);
      this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(id,revision,paused?'paused':'resumed',JSON.stringify(work.spec),JSON.stringify(work.answers),at);
      return this.intakeWork(project,id);
    });
  }
  officeWorkSummaries(project:string,limit=100){
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=200,'WORK_LIMIT_INVALID');
    return this.connection.prepare(`SELECT w.id,w.title,w.goal,w.created_at,w.updated_at,i.mode,i.status AS intake_status,i.revision AS intake_revision,i.paused,
      r.source_kind,r.source_id,fr.status AS pack_status,json_extract(sr.snapshot,'$.status') AS swarm_status,cr.status AS coding_status,COALESCE(sr.revision,cr.revision) AS run_revision,
      COALESCE(sr.updated_at,cr.updated_at,i.updated_at,w.updated_at) AS display_updated_at FROM office_work w
      LEFT JOIN office_intake i ON i.work_id=w.id AND i.project_id=w.project_id
      LEFT JOIN office_run r ON r.rowid=(SELECT recent.rowid FROM office_run recent WHERE recent.project_id=w.project_id AND recent.work_id=w.id ORDER BY recent.created_at DESC,recent.rowid DESC LIMIT 1)
      LEFT JOIN family_run fr ON r.source_kind='pack' AND fr.id=r.source_id AND fr.project_id=w.project_id
      LEFT JOIN swarm_run sr ON r.source_kind='swarm' AND sr.id=r.source_id AND sr.project_id=w.project_id
      LEFT JOIN coding_run cr ON r.source_kind='coding' AND cr.id=r.source_id AND cr.project_id=w.project_id
      WHERE w.project_id=? ORDER BY COALESCE(r.created_at,w.updated_at) DESC,w.id DESC LIMIT ?`).all(project,limit) as Array<{id:string;title:string;goal:string;created_at:string;updated_at:string;mode:string|null;intake_status:string|null;intake_revision:number|null;paused:number|null;source_kind:string|null;source_id:string|null;pack_status:string|null;swarm_status:string|null;coding_status:string|null;run_revision:number|null;display_updated_at:string}>;
  }
  intakeWorkOptional(project:string,id:string):IntakeWork|null{
    const row=this.connection.prepare('SELECT work_id FROM office_intake WHERE project_id=? AND work_id=?').get(project,id);
    return row?this.intakeWork(project,id):null;
  }
  assertWorkRunBinding(project:string,requestId:string,kind:'pack'|'swarm'|'coding',family?:string,workId?:string){
    const byRequest=this.connection.prepare('SELECT work_id FROM office_intake WHERE project_id=? AND request_id=?').get(project,requestId);
    if(workId&&byRequest)requireCondition(String(byRequest.work_id)===workId,'WORK_RUN_BINDING_CONFLICT');
    const row=workId?this.intakeWork(project,workId):byRequest;
    if(!row)return null;
    const work='work_id' in row?this.intakeWork(project,String(row.work_id)):row as IntakeWork;
    requireCondition(['ready','running'].includes(work.status),'WORK_NOT_READY');
    requireCondition(!work.paused,'WORK_PAUSED');
    const spec=work.spec as {route?:{kind?:string;pack_family?:string|null}}|null;
    requireCondition(spec?.route?.kind===(kind==='coding'?'pack':kind),'WORK_ROUTE_MISMATCH');
    if(kind==='pack'||kind==='coding')requireCondition(spec?.route?.pack_family===family,'WORK_PACK_FAMILY_MISMATCH');
    return work.id;
  }
  registerOfficeRun(project:string,kind:'pack'|'swarm'|'coding',runId:string,goal:string,at=new Date().toISOString(),requestId?:string,workId?:string){
    // An immutable plan ID is a safe repeat identity. Never merge by similar titles.
    const previous=kind==='swarm'?this.connection.prepare(`SELECT o.work_id FROM office_run o JOIN swarm_run current ON current.id=? AND current.project_id=o.project_id JOIN swarm_run prior ON prior.id=o.source_id AND prior.project_id=o.project_id WHERE o.project_id=? AND o.source_kind='swarm' AND prior.plan_id=current.plan_id ORDER BY o.created_at,o.source_id LIMIT 1`).get(runId,project):null;
    const intakeId=workId??(requestId?this.connection.prepare('SELECT work_id FROM office_intake WHERE project_id=? AND request_id=?').get(project,requestId)?.work_id as string|undefined:undefined);
    const assignedId=intakeId??(previous?.work_id?String(previous.work_id):`${kind}:${runId}`);
    this.connection.prepare('INSERT OR IGNORE INTO office_work VALUES (?,?,?,?,?,?)').run(assignedId,project,kind==='swarm'?'Swarm 업무':kind==='coding'?'코딩 업무':'Task Pack 업무',goal,at,at);
    this.connection.prepare('INSERT OR IGNORE INTO office_run VALUES (?,?,?,?,?)').run(project,assignedId,kind,runId,at);
    if(intakeId)this.connection.prepare("UPDATE office_intake SET status='running',updated_at=? WHERE work_id=? AND project_id=?").run(at,assignedId,project);
    return assignedId;
  }
  officeWork(project:string,kind:'pack'|'swarm'|'coding',runId:string){
    return this.connection.prepare('SELECT w.id,w.project_id,w.title,w.goal,w.created_at,w.updated_at FROM office_run r JOIN office_work w ON w.id=r.work_id WHERE r.project_id=? AND r.source_kind=? AND r.source_id=?').get(project,kind,runId)??null;
  }
  officeWorkById(project:string,id:string){
    const row=this.connection.prepare('SELECT id,project_id,title,goal,created_at,updated_at FROM office_work WHERE project_id=? AND id=?').get(project,id);
    requireCondition(row,'WORK_NOT_FOUND');return row as {id:string;project_id:string;title:string;goal:string;created_at:string;updated_at:string};
  }
  officeRuns(project:string,workId:string){
    return this.connection.prepare('SELECT source_kind,source_id,created_at FROM office_run WHERE project_id=? AND work_id=? ORDER BY created_at DESC,source_id DESC').all(project,workId) as Array<{source_kind:string;source_id:string;created_at:string}>;
  }
  recordClientHandoff(project:string,event:ClientRouteEvent):ClientHandoff{
    const handoff=makeClientHandoff({project_id:project,...event});
    this.connection.prepare('INSERT INTO client_handoff VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(handoff.id,handoff.project_id,handoff.work_id,handoff.run_id,handoff.stage_id,handoff.source,handoff.target,handoff.source_model,handoff.target_model,handoff.reason,handoff.effect_state,handoff.status,handoff.input_sha256,handoff.created_at);
    return handoff;
  }
  clientHandoffs(project:string,workId:string):ClientHandoff[]{
    return this.connection.prepare('SELECT * FROM client_handoff WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 50').all(project,workId).map(row=>clientHandoffSchema.parse(row));
  }
  codingRun(project:string,id:string):CodingRun{
    const row=this.connection.prepare('SELECT * FROM coding_run WHERE project_id=? AND id=?').get(project,id);
    requireCondition(row,'CODING_RUN_NOT_FOUND');
    return {...row,plan:JSON.parse(String(row.plan)),paused:Boolean(row.paused)} as unknown as CodingRun;
  }
  lastCodingRun(project:string,projectRef:string):CodingRun|null{
    const row=this.connection.prepare("SELECT id FROM coding_run WHERE project_id=? AND project_ref=? AND status<>'completed' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(project,projectRef);
    return row?this.codingRun(project,String(row.id)):null;
  }
  codingStages(project:string,id:string):CodingStageRow[]{
    this.codingRun(project,id);
    return this.connection.prepare('SELECT * FROM coding_stage WHERE run_id=? ORDER BY ordinal').all(id).map(row=>({...row,receipt:row.receipt===null?null:JSON.parse(String(row.receipt))})) as unknown as CodingStageRow[];
  }
  codingCheckpoint(project:string,id:string):CodingCheckpointRow|null{
    this.codingRun(project,id);
    const row=this.connection.prepare('SELECT * FROM coding_checkpoint WHERE project_id=? AND run_id=?').get(project,id);
    return row?{...row,changed_paths:JSON.parse(String(row.changed_paths))} as CodingCheckpointRow:null;
  }
  noteCodingCheckpointProjectionFailure(project:string,id:string){
    this.codingRun(project,id);
    this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,id,null,'coding.checkpoint_projection_failed','Local Git handoff file was not refreshed; durable stage receipt remains authoritative',new Date().toISOString());
  }
  beginCoding(project:string,requestId:string,workId:string,projectRef:string,root:string,fingerprint:string,plan:CodingPlan,git:LocalGitCheckpoint){
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id FROM coding_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){const run=this.codingRun(project,String(old.id));requireCondition(run.work_id===workId&&run.project_ref===projectRef&&run.project_root===root,'CODING_REQUEST_ID_CONFLICT');return {run,created:false};}
      this.assertWorkRunBinding(project,requestId,'coding','coding.orchestrate',workId);
      const id=randomUUID(),at=new Date().toISOString();
      this.connection.prepare('INSERT INTO coding_run VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,requestId,workId,projectRef,root,fingerprint,JSON.stringify(plan),'ready',0,0,at,at);
      for(let i=0;i<plan.stages.length;i++)this.connection.prepare("INSERT INTO coding_stage(run_id,stage_id,ordinal,status) VALUES (?,?,?,'pending')").run(id,plan.stages[i]!.id,i);
      this.connection.prepare('INSERT INTO coding_checkpoint VALUES (?,?,?,?,?,?,?)').run(id,project,0,git.head,git.state_sha256,JSON.stringify(git.changed_paths),at);
      this.registerOfficeRun(project,'coding',id,plan.goal,at,requestId,workId);
      return {run:this.codingRun(project,id),created:true};
    });
  }
  claimCodingStage(project:string,id:string,expectedRevision:number){
    return this.transaction(()=>{
      const run=this.codingRun(project,id);requireCondition(run.revision===expectedRevision,'CODING_REVISION_CONFLICT');
      requireCondition(!run.paused,'CODING_RUN_PAUSED');requireCondition(['ready','running'].includes(run.status),'CODING_RUN_NOT_EXECUTABLE');
      const stages=this.codingStages(project,id);requireCondition(!stages.some(stage=>stage.status==='running'),'CODING_STAGE_UNCERTAIN');
      const next=stages.find(stage=>stage.status==='pending');requireCondition(next,'CODING_NO_PENDING_STAGE');
      requireCondition(stages.slice(0,next.ordinal).every(stage=>stage.status==='succeeded'),'CODING_PREVIOUS_STAGE_NOT_VERIFIED');
      const at=new Date().toISOString(),owner=randomUUID();
      this.connection.prepare("UPDATE coding_stage SET status='running',attempts=attempts+1,started_at=?,owner=?,lease_until_ms=? WHERE run_id=? AND stage_id=? AND status='pending'").run(at,owner,Date.now()+30_000,id,next.stage_id);
      this.connection.prepare("UPDATE coding_run SET status='running',revision=revision+1,updated_at=? WHERE id=?").run(at,id);
      this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,id,next.stage_id,'coding.stage_started',`Started ${next.stage_id}`,at);
      return {run:this.codingRun(project,id),stage:this.codingStages(project,id)[next.ordinal]!,owner};
    });
  }
  renewCodingStage(project:string,id:string,stageId:string,owner:string){
    this.codingRun(project,id);return this.connection.prepare("UPDATE coding_stage SET lease_until_ms=? WHERE run_id=? AND stage_id=? AND status='running' AND owner=? AND lease_until_ms>?").run(Date.now()+30_000,id,stageId,owner,Date.now()).changes===1;
  }
  markExpiredCodingStage(project:string,id:string){
    return this.transaction(()=>{
      const run=this.codingRun(project,id),stage=this.codingStages(project,id).find(item=>item.status==='running'&&item.lease_until_ms<=Date.now());
      if(!stage)return run;
      const at=new Date().toISOString();
      this.connection.prepare("UPDATE coding_stage SET status='reconciliation_required',owner=NULL,lease_until_ms=0,summary='Execution owner expired; inspect effects before continuing',finished_at=? WHERE run_id=? AND stage_id=? AND status='running'").run(at,id,stage.stage_id);
      this.connection.prepare("UPDATE coding_run SET status='reconciliation_required',revision=revision+1,updated_at=? WHERE id=?").run(at,id);
      this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,id,stage.stage_id,'coding.owner_expired','Execution owner expired; no automatic replay',at);
      return this.codingRun(project,id);
    });
  }
  expireCodingStages(project:string){
    const expired=this.connection.prepare("SELECT DISTINCT cr.id FROM coding_run cr JOIN coding_stage cs ON cs.run_id=cr.id WHERE cr.project_id=? AND cr.status='running' AND cs.status='running' AND cs.lease_until_ms<=? LIMIT 50").all(project,Date.now());
    for(const row of expired)this.markExpiredCodingStage(project,String(row.id));
    return expired.length;
  }
  codingSession(project:string,id:string,stageId:string,owner:string,sessionId:string){
    this.codingRun(project,id);
    const result=this.connection.prepare("UPDATE coding_stage SET session_id=? WHERE run_id=? AND stage_id=? AND status='running' AND owner=? AND (session_id IS NULL OR session_id=?)").run(sessionId,id,stageId,owner,sessionId);
    requireCondition(result.changes===1,'CODING_STAGE_NOT_RUNNING');
  }
  clearCodingSession(project:string,id:string,stageId:string,owner:string){
    this.codingRun(project,id);
    requireCondition(this.connection.prepare("UPDATE coding_stage SET session_id=NULL WHERE run_id=? AND stage_id=? AND status='running' AND owner=?").run(id,stageId,owner).changes===1,'CODING_STAGE_NOT_RUNNING');
  }
  finishCodingStage(project:string,id:string,stageId:string,owner:string,status:'succeeded'|'failed'|'reconciliation_required',summary:string,receipt:unknown,git:LocalGitCheckpoint|null=null){
    return this.transaction(()=>{
      this.codingRun(project,id);const stage=this.codingStages(project,id).find(item=>item.stage_id===stageId);
      requireCondition(stage?.status==='running'&&stage.owner===owner&&stage.lease_until_ms>Date.now(),'CODING_STAGE_OWNER_LOST');
      const at=new Date().toISOString();
      this.connection.prepare('UPDATE coding_stage SET status=?,summary=?,receipt=?,finished_at=?,owner=NULL,lease_until_ms=0 WHERE run_id=? AND stage_id=?').run(status,safeSummary(summary).slice(0,1500),JSON.stringify(receipt),at,id,stageId);
      const all=this.codingStages(project,id),runStatus=status==='succeeded'?all.every(item=>item.status==='succeeded')?'completed':'ready':status;
      this.connection.prepare('UPDATE coding_run SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(runStatus,at,id);
      if(git)this.connection.prepare('UPDATE coding_checkpoint SET revision=?,head=?,state_sha256=?,changed_paths=?,updated_at=? WHERE run_id=? AND project_id=?').run(this.codingRun(project,id).revision,git.head,git.state_sha256,JSON.stringify(git.changed_paths),at,id,project);
      this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,id,stageId,`coding.stage_${status}`,safeSummary(summary).slice(0,240),at);
      return this.codingRun(project,id);
    });
  }
  pauseCoding(project:string,id:string,expectedRevision:number,paused:boolean){
    return this.transaction(()=>{
      const run=this.codingRun(project,id);requireCondition(run.revision===expectedRevision,'CODING_REVISION_CONFLICT');
      requireCondition(run.paused!==paused,'CODING_PAUSE_STATE_UNCHANGED');requireCondition(['ready','running'].includes(run.status),'CODING_RUN_NOT_PAUSABLE');
      const at=new Date().toISOString();this.connection.prepare('UPDATE coding_run SET paused=?,revision=revision+1,updated_at=? WHERE id=?').run(Number(paused),at,id);
      return this.codingRun(project,id);
    });
  }
  codingDirection(project:string,id:string,expectedRevision:number,stageId:string,instruction:string){
    requireCondition(instruction.trim().length>=3&&instruction.length<=2000&&!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})\b/u.test(instruction),'CODING_DIRECTION_INVALID');
    return this.transaction(()=>{
      const run=this.codingRun(project,id);requireCondition(run.revision===expectedRevision,'CODING_REVISION_CONFLICT');
      requireCondition(['ready','running'].includes(run.status),'CODING_RUN_NOT_EDITABLE');
      const stage=this.codingStages(project,id).find(item=>item.stage_id===stageId);requireCondition(stage?.status==='pending','CODING_STAGE_NOT_PENDING');
      const plan=structuredClone(run.plan),target=plan.stages.find(item=>item.id===stageId);requireCondition(target,'CODING_STAGE_NOT_FOUND');
      target.instruction=instruction.trim();const at=new Date().toISOString();
      this.connection.prepare('UPDATE coding_run SET plan=?,revision=revision+1,updated_at=? WHERE id=?').run(JSON.stringify(plan),at,id);
      this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,id,stageId,'coding.direction_changed',safeSummary(instruction).slice(0,240),at);
      return this.codingRun(project,id);
    });
  }
  officeEvents(project:string,runId:string):OfficeEvent[]{
    requireCondition(this.connection.prepare('SELECT 1 FROM office_run WHERE project_id=? AND source_id=?').get(project,runId),'OFFICE_RUN_NOT_FOUND');
    return this.connection.prepare('SELECT id,run_id,worker_id,kind,detail,created_at FROM office_event WHERE project_id=? AND run_id=? ORDER BY id DESC LIMIT 100').all(project,runId).reverse() as unknown as OfficeEvent[];
  }
  officeInstructions(project:string,runId:string):Array<{worker_id:string;version:number;instruction:string;created_at:string}>{
    this.swarmRun(project,runId);
    return this.connection.prepare('SELECT worker_id,version,instruction,created_at FROM office_step_instruction WHERE project_id=? AND run_id=? ORDER BY created_at,version').all(project,runId) as Array<{worker_id:string;version:number;instruction:string;created_at:string}>;
  }
  officeInstructionVersion(project:string,runId:string,workerId:string){return Number(this.connection.prepare('SELECT COALESCE(MAX(version),0) AS version FROM office_step_instruction WHERE project_id=? AND run_id=? AND worker_id=?').get(project,runId,workerId)?.version??0);}
  officeAction(project:string,runId:string,action:'pause'|'resume'|'edit',expectedRevision:number,workerId?:string,instruction?:string){
    requireCondition(Number.isSafeInteger(expectedRevision)&&expectedRevision>=0,'OFFICE_REVISION_INVALID');
    return this.transaction(()=>{
      const row=this.connection.prepare('SELECT revision,paused,paused_at_ms FROM office_control WHERE project_id=? AND run_id=?').get(project,runId);
      const currentRevision=Number(row?.revision??0);requireCondition(currentRevision===expectedRevision,'OFFICE_REVISION_CONFLICT');
      const snapshot=this.swarmRun(project,runId).snapshot as SwarmRunSnapshot;
      requireCondition(['running','needs_human'].includes(snapshot.status),'OFFICE_RUN_NOT_ACTIVE');
      const now=Date.now(),at=new Date(now).toISOString(),wasPaused=Boolean(row?.paused),previousSnapshotRevision=snapshot.revision;
      let detail='';
      if(action==='pause'){
        requireCondition(!wasPaused,'OFFICE_ALREADY_PAUSED');
        const revoked:string[]=[];const outstanding:string[]=[];
        for(const definition of snapshot.plan.workers){const worker=snapshot.workers[definition.id];if(worker?.status!=='leased')continue;
          if(definition.effect==='read_only'){worker.status='pending';worker.lease_token=null;worker.lease_expires_at_ms=null;revoked.push(worker.id);}
          else outstanding.push(worker.id);
        }
        detail=`New dispatch blocked. Read-only leases revoked: ${revoked.join(', ')||'none'}. In-flight effects awaiting reconciliation: ${outstanding.join(', ')||'none'}.`;
      }else if(action==='resume'){
        requireCondition(wasPaused,'OFFICE_NOT_PAUSED');
        requireCondition(snapshot.status==='running','OFFICE_RECOVERY_REQUIRED');
        requireCondition(!snapshot.plan.workers.some(def=>def.effect!=='read_only'&&snapshot.workers[def.id]?.status==='leased'),'OFFICE_INFLIGHT_EFFECT_UNRESOLVED');
        const elapsed=Math.max(0,now-Number(row?.paused_at_ms??now));
        if(snapshot.target_deadline_at_ms!==null)snapshot.target_deadline_at_ms+=elapsed;
        if(snapshot.hard_deadline_at_ms!==null)snapshot.hard_deadline_at_ms+=elapsed;
        detail=`Dispatch resumed after ${elapsed} ms pause; retained verified results.`;
      }else{
        requireCondition(Boolean(workerId)&&Boolean(instruction),'OFFICE_EDIT_INVALID');
        const definition=snapshot.plan.workers.find(item=>item.id===workerId),worker=definition&&snapshot.workers[definition.id];
        requireCondition(definition&&worker,'OFFICE_STEP_NOT_FOUND');
        requireCondition(worker.status==='pending','OFFICE_STEP_NOT_PENDING');
        requireCondition(definition.effect==='read_only','OFFICE_EDIT_REQUIRES_REPLAN');
        const affected=new Set<string>([definition.id]);
        let changed=true;while(changed){changed=false;for(const next of snapshot.plan.workers){if(!affected.has(next.id)&&next.depends_on.some(id=>affected.has(id))){affected.add(next.id);changed=true;}}}
        const descendants=snapshot.plan.workers.filter(next=>next.id!==definition.id&&affected.has(next.id));
        requireCondition(descendants.every(next=>snapshot.workers[next.id]?.status==='pending'),'OFFICE_EDIT_DOWNSTREAM_STARTED');
        requireCondition(instruction!.length<=2000&&!/(?:api[_-]?key|password|secret|token)\s*[:=]/iu.test(instruction!),'OFFICE_EDIT_INVALID');
        const old=definition.objective;definition.objective=instruction!;definition.completion_evidence=[`Verified result follows the updated user instruction: ${instruction!.slice(0,400)}`];
        if(definition.stage==='synthesis'&&!snapshot.plan.workers.some(item=>item.depends_on.includes(definition.id))){snapshot.plan.goal=instruction!;this.connection.prepare('UPDATE office_work SET goal=?,updated_at=? WHERE id=(SELECT work_id FROM office_run WHERE project_id=? AND source_kind=? AND source_id=?)').run(instruction!,at,project,'swarm',runId);}
        const version=Number(this.connection.prepare('SELECT COALESCE(MAX(version),0) AS version FROM office_step_instruction WHERE project_id=? AND run_id=? AND worker_id=?').get(project,runId,workerId!)?.version??0)+1;
        this.connection.prepare('INSERT INTO office_step_instruction VALUES (?,?,?,?,?,?)').run(project,runId,workerId!,version,instruction!,at);
        const linked=this.connection.prepare("SELECT i.work_id FROM office_run r JOIN office_intake i ON i.work_id=r.work_id AND i.project_id=r.project_id WHERE r.project_id=? AND r.source_kind='swarm' AND r.source_id=?").get(project,runId);
        if(linked){const work=this.intakeWork(project,String(linked.work_id)),nextRevision=work.revision+1;
          this.connection.prepare("UPDATE office_intake SET status='needs_model',revision=?,define_owner=NULL,define_lease_until_ms=0,updated_at=? WHERE project_id=? AND work_id=?").run(nextRevision,at,project,work.id);
          this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(work.id,nextRevision,'direction_changed',JSON.stringify({run_id:runId,step_id:workerId,instruction,created_at:at}),JSON.stringify(work.answers),at);
        }
        detail=`Step instruction v${version} replaced the pending objective (${old.length} previous characters); the next dispatch uses the new instruction. Pending downstream steps to review: ${descendants.map(item=>item.id).join(', ')||'none'}. Previously verified evidence was retained.`;
      }
      snapshot.revision=previousSnapshotRevision+1;snapshot.updated_at=at;
      const changed=this.connection.prepare('UPDATE swarm_run SET revision=?,snapshot=?,updated_at=? WHERE project_id=? AND id=? AND revision=?').run(snapshot.revision,JSON.stringify(snapshot),at,project,runId,previousSnapshotRevision);
      requireCondition(changed.changes===1,'SWARM_REVISION_CONFLICT');
      this.connection.prepare('INSERT INTO office_control(project_id,run_id,paused,revision,paused_at_ms,updated_at) VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,run_id) DO UPDATE SET paused=excluded.paused,revision=excluded.revision,paused_at_ms=excluded.paused_at_ms,updated_at=excluded.updated_at').run(project,runId,action==='pause'?1:action==='resume'?0:Number(wasPaused),currentRevision+1,action==='pause'?now:action==='resume'?null:row?.paused_at_ms??null,at);
      if(action==='pause'||action==='resume'){
        const linked=this.connection.prepare("SELECT i.work_id FROM office_run r JOIN office_intake i ON i.work_id=r.work_id AND i.project_id=r.project_id WHERE r.project_id=? AND r.source_kind='swarm' AND r.source_id=?").get(project,runId);
        if(linked){const work=this.intakeWork(project,String(linked.work_id)),nextRevision=work.revision+1;
          this.connection.prepare('UPDATE office_intake SET paused=?,revision=?,updated_at=? WHERE project_id=? AND work_id=?').run(action==='pause'?1:0,nextRevision,at,project,work.id);
          this.connection.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(work.id,nextRevision,action==='pause'?'paused':'resumed',JSON.stringify(work.spec),JSON.stringify(work.answers),at);
        }
      }
      this.connection.prepare('INSERT INTO office_event(project_id,run_id,worker_id,kind,detail,created_at) VALUES (?,?,?,?,?,?)').run(project,runId,workerId??null,`user.${action}`,detail,at);
      this.appendSwarmActivity(project,runId,snapshot.revision,workerId??null,`office.${action}`,{detail},at);
      return {control:this.officeControl(project,runId),run_revision:snapshot.revision,detail};
    });
  }
  swarmActivities(project:string,after=0,limit=500,runId?:string):SwarmActivity[]{
    requireCondition(Number.isSafeInteger(after)&&after>=0&&Number.isInteger(limit)&&limit>=1&&limit<=2000,'SWARM_ACTIVITY_QUERY_INVALID');
    const rows=runId
      ?this.connection.prepare('SELECT * FROM swarm_activity WHERE project_id=? AND run_id=? AND id>? ORDER BY id LIMIT ?').all(project,runId,after,limit)
      :this.connection.prepare('SELECT * FROM swarm_activity WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(project,after,limit);
    return rows.map(row=>({...row,id:Number(row.id),revision:Number(row.revision),worker_id:row.worker_id===null?null:String(row.worker_id),body:JSON.parse(String(row.body))})) as unknown as SwarmActivity[];
  }
  recordSwarmActivity(project:string,runId:string,revision:number,workerId:string,kind:string,body:unknown,createdAt=new Date().toISOString()){
    const result=this.connection.prepare('INSERT INTO swarm_activity(project_id,run_id,revision,worker_id,kind,body,created_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM swarm_run WHERE project_id=? AND id=? AND revision=?)').run(project,runId,revision,workerId,kind,JSON.stringify(body),createdAt,project,runId,revision);
    requireCondition(result.changes===1,'SWARM_REVISION_CONFLICT');return Number(result.lastInsertRowid);
  }
  updateSwarmRun(project:string,id:string,expectedRevision:number,snapshot:SwarmRunSnapshot,authProfile?:string|null){
    requireCondition(snapshot.revision===expectedRevision+1,'SWARM_REVISION_INVALID');
    this.transaction(()=>{
      const previousRow=this.connection.prepare('SELECT snapshot FROM swarm_run WHERE project_id=? AND id=? AND revision=?').get(project,id,expectedRevision);requireCondition(previousRow,'SWARM_REVISION_CONFLICT');
      const previous=JSON.parse(String(previousRow.snapshot)) as SwarmRunSnapshot;
      if(authProfile&&snapshot.plan.workers.some(def=>def.source_urls.length&&snapshot.workers[def.id]?.status==='leased'&&previous.workers[def.id]?.status!=='leased'))requireCondition(!this.browserAuthEntries(project,authProfile).some(site=>site.handoff),'AUTH_HANDOFF_IN_PROGRESS');
      const result=this.connection.prepare('UPDATE swarm_run SET revision=?,snapshot=?,updated_at=? WHERE project_id=? AND id=? AND revision=?').run(snapshot.revision,JSON.stringify(snapshot),snapshot.updated_at,project,id,expectedRevision);
      requireCondition(result.changes===1,'SWARM_REVISION_CONFLICT');
      for(const [workerId,current] of Object.entries(snapshot.workers)){
        const before=previous.workers[workerId];
        if(before&&before.status!==current.status)this.appendSwarmActivity(project,id,snapshot.revision,workerId,`worker.${current.status}`,{from:before.status,to:current.status,attempts:current.attempts},snapshot.updated_at);
      }
      for(const review of snapshot.reviews.slice(previous.reviews.length))this.appendSwarmActivity(project,id,snapshot.revision,review.worker_id,'review.added',{review_id:review.id,review_kind:review.kind,reason:review.reason},review.created_at);
      for(const eventId of snapshot.decision_events.slice(previous.decision_events.length))this.appendSwarmActivity(project,id,snapshot.revision,null,'decision.recorded',{decision_event_id:eventId},snapshot.updated_at);
      if(previous.status!==snapshot.status)this.appendSwarmActivity(project,id,snapshot.revision,null,`run.${snapshot.status}`,{from:previous.status,to:snapshot.status},snapshot.updated_at);
    });
  }
  private appendSwarmActivity(project:string,runId:string,revision:number,workerId:string|null,kind:string,body:unknown,createdAt:string){
    this.connection.prepare('INSERT INTO swarm_activity(project_id,run_id,revision,worker_id,kind,body,created_at) VALUES (?,?,?,?,?,?,?)').run(project,runId,revision,workerId,kind,JSON.stringify(body),createdAt);
  }
}
