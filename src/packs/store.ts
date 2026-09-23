import {randomUUID} from 'node:crypto';
import {TerminalStore} from '../terminal/store.js';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type Recipe} from './contracts.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {redact} from '../terminal/contracts.js';

export interface PackRun {id:string;project_id:string;request_id:string;binding:string;recipe:Recipe;status:string;result:unknown;task_id:string|null;}
export interface SwarmActivity {id:number;project_id:string;run_id:string;revision:number;worker_id:string|null;kind:string;body:unknown;created_at:string;}
export type DecisionLayer='llm'|'jev'|'code';
export interface RuntimeActivity {id:number;project_id:string;owner_kind:'pack'|'task'|'terminal';owner_id:string;actor_id:string|null;kind:string;summary:string;endpoint:string|null;surface_id:string|null;decision_layer:DecisionLayer|null;created_at:string;}
export interface RuntimePresence {id:string;project_id:string;kind:'mcp'|'dashboard';state:'active'|'stopped';started_at:string;heartbeat_at:string;stopped_at:string|null;metadata:Record<string,unknown>;}
export interface ManagedControlSurface {id:string;project_id:string;run_id:string;worker_id:string;kind:'browser';preview_endpoint:string;state:'active'|'closed'|'failed';updated_at:string;}
const safeEndpoint=(value:string|null)=>{if(value===null)return null;try{const url=new URL(value);if(!['http:','https:'].includes(url.protocol))return null;const path=url.pathname.split('/').map((part,index,all)=>part&&(/^(?:token|secret|password|api-?key|auth|session)$/iu.test(all[index-1]??'')||part.length>64||/^[A-Za-z0-9_-]{32,}$/u.test(part))?':redacted':part).join('/');return `${url.origin}${path}`;}catch{return null;}};
const safeSummary=(value:string)=>redact(value).replace(/https?:\/\/[^\s<>"']+/giu,url=>safeEndpoint(url)??'[REDACTED_URL]').replace(/((?:token|secret|password|api.?key)\s*[:=]\s*)\S+/giu,'$1[REDACTED]');
export class PackStore extends TerminalStore {
  constructor(path:string){super(path);this.connection.exec(`
    CREATE TABLE IF NOT EXISTS family_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,status TEXT NOT NULL,result TEXT NOT NULL,task_id TEXT,UNIQUE(project_id,request_id));
    CREATE TABLE IF NOT EXISTS family_spec(project_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,binding TEXT NOT NULL,recipe TEXT NOT NULL,PRIMARY KEY(project_id,prompt_hash));
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
  `);
    const columns=new Set((this.connection.prepare('PRAGMA table_info(runtime_activity)').all() as Array<{name:string}>).map(column=>column.name));
    if(!columns.has('surface_id'))this.connection.exec('ALTER TABLE runtime_activity ADD COLUMN surface_id TEXT');
    if(!columns.has('decision_layer'))this.connection.exec('ALTER TABLE runtime_activity ADD COLUMN decision_layer TEXT');
  }
  packRuns(project:string,limit=30):PackRun[]{
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=100,'PACK_RUN_LIMIT_INVALID');
    return this.connection.prepare('SELECT * FROM family_run WHERE project_id=? ORDER BY rowid DESC LIMIT ?').all(project,limit).map(row=>({...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))})) as unknown as PackRun[];
  }
  browserAuthEntries(project:string,profile:string){return this.connection.prepare('SELECT site,state,handoff,updated_at FROM browser_auth WHERE project_id=? AND profile=? ORDER BY site').all(project,profile);}
  setBrowserAuth(project:string,profile:string,site:string,state:string,handoff:boolean){this.connection.prepare('INSERT INTO browser_auth VALUES (?,?,?,?,?,?) ON CONFLICT(project_id,profile,site) DO UPDATE SET state=excluded.state,handoff=excluded.handoff,updated_at=excluded.updated_at').run(project,profile,site,state,Number(handoff),new Date().toISOString());}
  claimBrowserHandoff(project:string,profile:string,site:string){this.transaction(()=>{
    const runs=this.connection.prepare('SELECT snapshot FROM swarm_run WHERE project_id=?').all(project).map(row=>JSON.parse(String(row.snapshot)) as SwarmRunSnapshot);
    requireCondition(!runs.some(run=>run.status==='running'&&run.plan.workers.some(def=>def.source_urls.length>0&&run.workers[def.id]?.status==='leased'&&(run.workers[def.id]?.lease_expires_at_ms??0)>Date.now())),'AUTH_WAIT_FOR_ACTIVE_WORKERS');
    requireCondition(!this.controlSurfaces(project).some(surface=>surface.state==='active'),'AUTH_WAIT_FOR_ACTIVE_WORKERS');
    this.setBrowserAuth(project,profile,site,'needs_login',true);
  });}
  packRun(project:string,id:string):PackRun{
    const row=this.connection.prepare('SELECT * FROM family_run WHERE project_id=? AND id=?').get(project,id);requireCondition(row,'PACK_RUN_NOT_FOUND');
    return {...row,recipe:JSON.parse(String(row.recipe)),result:JSON.parse(String(row.result))} as unknown as PackRun;
  }
  beginPack(project:string,requestId:string,recipe:Recipe,fingerprint:string){
    const binding=snapshotHash({recipe,fingerprint});
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id,binding FROM family_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){requireCondition(old.binding===binding,'PACK_REQUEST_ID_CONFLICT');return {run:this.packRun(project,String(old.id)),created:false};}
      const id=randomUUID();this.connection.prepare('INSERT INTO family_run VALUES (?,?,?,?,?,?,?,?)').run(id,project,requestId,binding,JSON.stringify(recipe),'running','null',null);
      this.recordRuntimeActivity(project,'pack',id,null,'run.started',`Started ${recipe.family}`,null);
      return {run:this.packRun(project,id),created:true};
    });
  }
  finishPack(project:string,id:string,status:string,result:unknown,taskId:string|null=null){
    const before=this.packRun(project,id);this.connection.prepare('UPDATE family_run SET status=?,result=?,task_id=COALESCE(?,task_id) WHERE id=? AND project_id=?').run(status,JSON.stringify(result),taskId,id,project);
    if(before.status!==status)this.recordRuntimeActivity(project,'pack',id,null,`run.${status}`,`Pack ${status}`,null);
    return this.packRun(project,id);
  }
  cachePack(project:string,recipe:Recipe,fingerprint:string){
    this.connection.prepare('INSERT INTO family_spec VALUES (?,?,?,?) ON CONFLICT(project_id,prompt_hash) DO UPDATE SET binding=excluded.binding,recipe=excluded.recipe').run(project,snapshotHash(recipe.request),fingerprint,JSON.stringify(recipe));
  }
  cachedPack(project:string,prompt:string,fingerprint:string):Recipe|null{
    const row=this.connection.prepare('SELECT * FROM family_spec WHERE project_id=? AND prompt_hash=? AND binding=?').get(project,snapshotHash(prompt),fingerprint);return row?JSON.parse(String(row.recipe)) as Recipe:null;
  }
  scheduleWatch(runId:string,interval:number,baseline:unknown,now=Date.now()){
    this.connection.prepare('INSERT INTO family_watch(run_id,next_ms,baseline) VALUES (?,?,?)').run(runId,now+interval,JSON.stringify(baseline));
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
    requireCondition(snapshot.status==='running'&&worker?.status==='leased'&&worker.lease_token===leaseToken&&(worker.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
    const url=new URL(endpoint);
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u.test(id)&&url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Number(url.port)>=1024&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/[a-f0-9]{48}\/frame\/[a-zA-Z0-9._-]+$/u.test(url.pathname),'CONTROL_MANAGED_ENDPOINT_INVALID');
    this.connection.prepare("INSERT INTO control_surface VALUES (?,?,?,?,?,?,'active',?) ON CONFLICT(project_id,run_id,worker_id) DO UPDATE SET id=excluded.id,preview_endpoint=excluded.preview_endpoint,state='active',updated_at=excluded.updated_at").run(id,project,runId,workerId,'browser',endpoint,new Date().toISOString());
  }
  endControlSurface(project:string,runId:string,workerId:string,state:'closed'|'failed'){
    this.connection.prepare('UPDATE control_surface SET state=?,updated_at=? WHERE project_id=? AND run_id=? AND worker_id=?').run(state,new Date().toISOString(),project,runId,workerId);
  }
  recordObservedUrl(project:string,runId:string,workerId:string,leaseToken:string,url:string){
    const snapshot=this.swarmRun(project,runId).snapshot as SwarmRunSnapshot,worker=snapshot.workers[workerId];
    requireCondition(snapshot.status==='running'&&worker?.status==='leased'&&worker.lease_token===leaseToken&&(worker.lease_expires_at_ms??0)>Date.now(),'STALE_SWARM_LEASE');
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
  beginSwarmRun(project:string,requestId:string,planId:string,snapshot:SwarmRunSnapshot,fingerprint:string){
    const binding=snapshotHash({plan:snapshot.plan,fingerprint});
    return this.transaction(()=>{
      const old=this.connection.prepare('SELECT id,binding,snapshot FROM swarm_run WHERE project_id=? AND request_id=?').get(project,requestId);
      if(old){requireCondition(old.binding===binding,'SWARM_REQUEST_ID_CONFLICT');return {snapshot:JSON.parse(String(old.snapshot)) as unknown,binding:String(old.binding)};}
      this.connection.prepare('INSERT INTO swarm_run VALUES (?,?,?,?,?,?,?,?,?)').run(snapshot.run_id,project,requestId,binding,planId,snapshot.revision,JSON.stringify(snapshot),snapshot.created_at,snapshot.updated_at);
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
