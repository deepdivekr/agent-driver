import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,chmodSync,lstatSync,realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MIGRATION_1, MIGRATION_2, MIGRATION_3, MIGRATION_4, MIGRATION_5, MIGRATION_6, MIGRATION_7, MIGRATION_8 } from './migration.js';
import {StorageLedger} from '../storage/budget.js';
import {type HostConfig} from '../interface/config.js';
import {bootClock} from '../supervisor/identity.js';
import { requireCondition, type ProjectBinding, type TaskRecord, type TaskStatus, type Lease, type Effect, type Verification } from '../core/contracts.js';

const terminal = new Set<TaskStatus>(['succeeded','failed','cancelled']);
const timestamp = () => new Date().toISOString();
const canonicalJson=(value:unknown):string=>{
  const visit=(input:unknown):unknown=>{
    if(input===null||typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='number'){requireCondition(Number.isFinite(input),'NONFINITE_PROPOSAL_VALUE');return input;}
    if(Array.isArray(input))return input.map(visit);
    requireCondition(typeof input==='object'&&input!==null,'INVALID_PROPOSAL_VALUE');
    return Object.fromEntries(Object.entries(input as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,visit(item)]));
  };
  return JSON.stringify(visit(value));
};
const proposalHash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const secretHash=(value:string)=>createHash('sha256').update(value).digest('hex');
const equalSecret=(a:string,b:string)=>{
  const left=Buffer.from(a),right=Buffer.from(b);
  return left.length===right.length&&timingSafeEqual(left,right);
};
export interface TaskProposalRecord {
  task_id:string; pack_id:string; pack_version:number; adapter_id:string; caller_ref:string;
  normalized:unknown; normalized_hash:string; snapshot:unknown|null; snapshot_hash:string|null;
  state:'draft'|'waiting_approval'|'approved'|'consumed'|'cancelled'|'expired'|'invalidated';
  approval_channel:string|null; approval_receipt_hash:string|null; expires_at_ms:number|null;
  approved_at:string|null; consumed_at:string|null; created_at:string;
}
export class RuntimeStore {
  readonly #db: DatabaseSync;
  #instanceId: string | null = null;
  readonly databasePath: string;
  protected get connection(){this.assertRuntimeIdentity(); return this.#db;}
  constructor(path: string) {
    requireCondition(path!==':memory:', 'DURABLE_DATABASE_REQUIRED');
    this.databasePath = resolve(path);
    mkdirSync(dirname(resolve(path)), {recursive:true,mode:0o700});
    requireCondition(realpathSync(dirname(this.databasePath)) === dirname(this.databasePath), 'STORAGE_ROOT_REDIRECTED');
    // Durable staging marker precedes even the first snapshot byte. Interrupted
    // maintenance must never become an executable runtime by opening its path.
    try {lstatSync(dirname(this.databasePath)+'/.agent-driver-maintenance.json');throw Error('RESTORE_RECONCILIATION_REQUIRED');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    try {const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'STORAGE_DATABASE_REDIRECTED');}
    catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
    this.#db=new DatabaseSync(path,{enableForeignKeyConstraints:true,allowExtension:false,timeout:2000});
    try {
    const identityTable=this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='runtime_identity'").get();
    if(identityTable)requireCondition(this.#db.prepare('SELECT mode FROM runtime_identity WHERE singleton=1').get()?.mode==='active','RESTORE_RECONCILIATION_REQUIRED');
    chmodSync(path,0o600);
    if (this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal') this.#db.exec('PRAGMA journal_mode=WAL;');
    this.#db.exec('PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    const exists = this.#db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'").get();
    const current = exists ? this.#db.prepare('SELECT version FROM schema_version').all() : [];
    if (!(current.length === 1 && current[0]?.version === 8)) this.transaction(()=>{
      this.#db.exec(MIGRATION_1);
      const versions=this.#db.prepare('SELECT version FROM schema_version').all();
      requireCondition(versions.length===0 || (versions.length===1&&[1,2,3,4,5,6,7,8].includes(Number(versions[0]?.version))),'UNSUPPORTED_SCHEMA');
      if(!versions.length)this.#db.prepare('INSERT INTO schema_version VALUES (1)').run();
      if(!versions.length||versions[0]?.version===1)this.#db.exec(MIGRATION_2);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===2)this.#db.exec(MIGRATION_3);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===3)this.#db.exec(MIGRATION_4);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===4)this.#db.exec(MIGRATION_5);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===5)this.#db.exec(MIGRATION_6);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===6)this.#db.exec(MIGRATION_7);
      if(Number(this.#db.prepare('SELECT version FROM schema_version').get()?.version)===7)this.#db.exec(MIGRATION_8);
    });
    const identity=this.#db.prepare('SELECT instance_id,mode FROM runtime_identity WHERE singleton=1').get();
    requireCondition(identity?.mode==='active'&&typeof identity.instance_id==='string','RUNTIME_IDENTITY_INVALID');this.#instanceId=identity.instance_id;
    } catch(error){this.#db.close();throw error;}
  }
  private assertRuntimeIdentity() {
    if(this.#instanceId===null)return; // Only the constructor's migration transaction.
    const row=this.#db.prepare('SELECT instance_id,mode FROM runtime_identity WHERE singleton=1').get();
    requireCondition(row?.mode==='active'&&row.instance_id===this.#instanceId,'RUNTIME_IDENTITY_REVOKED');
  }
  close() { this.#db.close(); }
  storage(config: HostConfig) {requireCondition(resolve(config.dbPath) === this.databasePath, 'STORAGE_DATABASE_MISMATCH'); return new StorageLedger(this.#db, fn => this.transaction(fn), config);}
  enqueue(projectId:string,requestId:string,capability:string,payload:unknown,configHash:string) {
    const encoded=JSON.stringify(payload),digest=createHash('sha256').update(encoded).digest('hex');
    requireCondition(this.project(projectId).capabilities.includes(capability),'CAPABILITY_NOT_DELEGATED');
    return this.transaction(()=>{
      const old=this.#db.prepare('SELECT * FROM submission WHERE project_id=? AND request_id=?').get(projectId,requestId);
      if(old){requireCondition(old.request_hash===digest&&old.config_hash===configHash,'REQUEST_ID_CONFLICT');return {task:this.task(String(old.task_id)),created:false};}
      const active=this.#db.prepare("SELECT COUNT(*) AS count FROM task WHERE project_id=? AND status IN ('queued','running','verifying')").get(projectId);
      requireCondition(Number(active?.count)<16,'PROJECT_QUEUE_FULL');
      const taskId=randomUUID(),at=timestamp();
      this.#db.prepare("INSERT INTO task(id,project_id,capability,status,next_action,created_at,updated_at) VALUES (?,?,?,'queued','worker_start',?,?)").run(taskId,projectId,capability,at,at);
      const clock=bootClock();
      this.#db.prepare('INSERT INTO submission(project_id,request_id,task_id,request_hash,payload_json,config_hash,accepted_at,accepted_boot_id,accepted_uptime_ms) VALUES (?,?,?,?,?,?,?,?,?)').run(projectId,requestId,taskId,digest,encoded,configHash,at,clock.bootId,clock.uptimeMs);
      this.event(taskId,'task.accepted',{request_id:requestId,input_hash:digest});
      return {task:this.task(taskId),created:true};
    });
  }
  claimSubmission(taskId:string,configHash:string,nonce:string) {
    return this.transaction(()=>{
      const row=this.#db.prepare('SELECT * FROM submission WHERE task_id=?').get(taskId);requireCondition(row,'SUBMISSION_NOT_FOUND');
      requireCondition(row.config_hash===configHash,'CONFIG_CHANGED');requireCondition(!row.worker_nonce,'WORKER_ALREADY_CLAIMED');
      requireCondition(this.task(taskId).status==='queued','TASK_NOT_DISPATCHABLE');
      this.#db.prepare("UPDATE submission SET worker_nonce=?,worker_pid=?,worker_started_at=?,recovery_state='legacy_unknown' WHERE task_id=?").run(nonce,process.pid,timestamp(),taskId);
      this.event(taskId,'worker.claimed',{worker_nonce:nonce,pid:process.pid});
      return {payload:JSON.parse(String(row.payload_json)) as unknown,acceptedAt:String(row.accepted_at)};
    });
  }
  outcome(taskId:string) {
    const task=this.task(taskId),intent=this.#db.prepare('SELECT verification_json FROM command_intent WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(taskId);
    const recovery=this.#db.prepare('SELECT recovery_generation,recovery_state,last_error FROM submission WHERE task_id=?').get(taskId);
    return {task_id:task.id,project_id:task.project_id,status:task.status,selected_route:task.selected_route,session_ref:task.target_ref,effect_state:task.effect_state,
      verification:intent?.verification_json?JSON.parse(String(intent.verification_json)) as unknown:{result:'UNKNOWN',source:'unobserved'},artifacts:[],next_action:task.next_action,
      recovery_generation:recovery?.recovery_generation??0,recovery_state:recovery?.recovery_state??'unmanaged',recovery_reason:recovery?.last_error??null};
  }
  transaction<T>(fn:()=>T):T {
    this.#db.exec('BEGIN IMMEDIATE');
    try { this.assertRuntimeIdentity(); const result=fn(); this.#db.exec('COMMIT'); return result; }
    catch(error) { try {this.#db.exec('ROLLBACK');} catch {/* SQLITE_FULL may already have rolled back. Preserve the original failure. */} throw error; }
  }
  durability() { return {journal_mode:this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode,synchronous:this.#db.prepare('PRAGMA synchronous').get()?.synchronous}; }
  registerProject(binding:ProjectBinding) {
    this.assertRuntimeIdentity();
    requireCondition(binding.id&&binding.callerRef&&binding.accountRef&&binding.profileRef,'INVALID_PROJECT');
    for(const origin of binding.allowedOrigins){const url=new URL(origin);requireCondition(url.origin===origin&&!url.username&&!url.password&&['http:','https:'].includes(url.protocol),'INVALID_ORIGIN');}
    const payload=JSON.stringify(binding),existing=this.#db.prepare('SELECT binding_json FROM project WHERE id=?').get(binding.id);
    requireCondition(!existing || existing.binding_json===payload,'PROJECT_BINDING_IMMUTABLE');
    this.#db.prepare('INSERT OR IGNORE INTO project VALUES (?,?)').run(binding.id,payload);
  }
  project(id:string):ProjectBinding {
    const row=this.#db.prepare('SELECT binding_json FROM project WHERE id=?').get(id);
    requireCondition(row,'PROJECT_NOT_FOUND'); return JSON.parse(String(row.binding_json)) as ProjectBinding;
  }
  createTask(projectId:string,capability:string):TaskRecord {
    const project=this.project(projectId);requireCondition(project.capabilities.includes(capability),'CAPABILITY_NOT_DELEGATED');
    return this.transaction(()=>{const id=randomUUID(),at=timestamp();this.#db.prepare('INSERT INTO task(id,project_id,capability,status,next_action,created_at,updated_at) VALUES (?,?,?,\'queued\',\'bind_owned_target\',?,?)').run(id,projectId,capability,at,at);this.event(id,'task.created',{});return this.task(id);});
  }
  /**
   * Create a task whose only authority is to prepare a proposal.  This is not a
   * command intent and cannot dispatch an external write.  The normalized input
   * is immutable: changing it means cancelling and proposing a new task.
   */
  createTaskProposal(projectId:string,capability:string,proposal:{packId:string;packVersion:number;adapterId:string;callerRef:string;normalized:unknown}) {
    const project=this.project(projectId);
    requireCondition(project.capabilities.includes(capability),'CAPABILITY_NOT_DELEGATED');
    requireCondition(project.callerRef===proposal.callerRef,'CALLER_NOT_DELEGATED');
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposal.packId),'INVALID_PACK_ID');
    requireCondition(Number.isInteger(proposal.packVersion)&&proposal.packVersion>0,'INVALID_PACK_VERSION');
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proposal.adapterId),'INVALID_ADAPTER_ID');
    const normalized=canonicalJson(proposal.normalized),normalizedHash=proposalHash(proposal.normalized);
    return this.transaction(()=>{
      const id=randomUUID(),at=timestamp();
      this.#db.prepare("INSERT INTO task(id,project_id,capability,status,next_action,created_at,updated_at) VALUES (?,?,?,'queued','prepare_owned_browser',?,?)").run(id,projectId,capability,at,at);
      this.#db.prepare("INSERT INTO task_proposal(task_id,pack_id,pack_version,adapter_id,caller_ref,normalized_json,normalized_hash,state,created_at) VALUES (?,?,?,?,?,?,?,'draft',?)").run(id,proposal.packId,proposal.packVersion,proposal.adapterId,proposal.callerRef,normalized,normalizedHash,at);
      this.event(id,'proposal.created',{pack_id:proposal.packId,pack_version:proposal.packVersion,adapter_id:proposal.adapterId,normalized_hash:normalizedHash});
      return {task:this.task(id),proposal:this.proposal(id)};
    });
  }
  proposal(taskId:string):TaskProposalRecord {
    const row=this.#db.prepare('SELECT * FROM task_proposal WHERE task_id=?').get(taskId);requireCondition(row,'PROPOSAL_NOT_FOUND');
    const state=String(row.state) as TaskProposalRecord['state'];
    return {task_id:String(row.task_id),pack_id:String(row.pack_id),pack_version:Number(row.pack_version),adapter_id:String(row.adapter_id),caller_ref:String(row.caller_ref),normalized:JSON.parse(String(row.normalized_json)),normalized_hash:String(row.normalized_hash),snapshot:row.snapshot_json?JSON.parse(String(row.snapshot_json)):null,snapshot_hash:row.snapshot_hash?String(row.snapshot_hash):null,state,approval_channel:row.approval_channel?String(row.approval_channel):null,approval_receipt_hash:row.approval_receipt_hash?String(row.approval_receipt_hash):null,expires_at_ms:row.expires_at_ms===null||row.expires_at_ms===undefined?null:Number(row.expires_at_ms),approved_at:row.approved_at?String(row.approved_at):null,consumed_at:row.consumed_at?String(row.consumed_at):null,created_at:String(row.created_at)};
  }
  /** Mark a form snapshot as ready and return a one-time capability for a trusted channel adapter. */
  requestProposalApproval(taskId:string,snapshot:unknown,expiresAtMs:number) {
    requireCondition(Number.isSafeInteger(expiresAtMs)&&expiresAtMs>Date.now(),'INVALID_APPROVAL_EXPIRY');
    const encoded=canonicalJson(snapshot),digest=proposalHash(snapshot),token=`apv_${randomUUID().replaceAll('-','')}${randomUUID().replaceAll('-','')}`;
    return this.transaction(()=>{
      const task=this.task(taskId),proposal=this.proposal(taskId);
      requireCondition(proposal.state==='draft','PROPOSAL_NOT_PREPARABLE');
      requireCondition(task.status==='running'||task.status==='queued','TASK_NOT_PREPARABLE');
      this.#db.prepare("UPDATE task_proposal SET snapshot_json=?,snapshot_hash=?,state='waiting_approval',approval_token_hash=?,expires_at_ms=? WHERE task_id=?").run(encoded,digest,secretHash(token),expiresAtMs,taskId);
      this.state(taskId,'waiting_approval','await_bound_external_approval');
      this.event(taskId,'proposal.approval_requested',{snapshot_hash:digest,expires_at_ms:expiresAtMs});
      return {task_id:taskId,proposal_hash:digest,expires_at_ms:expiresAtMs,approval_token:token};
    });
  }
  /** This entrypoint is intended for a trusted approval-channel adapter, not MCP. */
  acceptProposalApproval(taskId:string,approvalToken:string,channel:string,receipt:unknown) {
    requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(channel),'INVALID_APPROVAL_CHANNEL');
    requireCondition(typeof approvalToken==='string'&&approvalToken.length>=32,'INVALID_APPROVAL_TOKEN');
    const receiptHash=proposalHash(receipt);
    return this.transaction(()=>{
      const proposal=this.proposal(taskId),task=this.task(taskId);
      requireCondition(proposal.state==='waiting_approval','APPROVAL_NOT_PENDING');
      requireCondition(proposal.expires_at_ms!==null&&proposal.expires_at_ms>Date.now(),'APPROVAL_EXPIRED');
      const row=this.#db.prepare('SELECT approval_token_hash FROM task_proposal WHERE task_id=?').get(taskId);
      requireCondition(typeof row?.approval_token_hash==='string'&&equalSecret(String(row.approval_token_hash),secretHash(approvalToken)),'APPROVAL_TOKEN_MISMATCH');
      requireCondition(task.status==='waiting_approval','TASK_NOT_WAITING_APPROVAL');
      this.#db.prepare("UPDATE task_proposal SET state='approved',approval_channel=?,approval_receipt_hash=?,approved_at=? WHERE task_id=?").run(channel,receiptHash,timestamp(),taskId);
      this.state(taskId,'ready_to_resume','approval_bound_write_ready');
      this.event(taskId,'proposal.approved',{snapshot_hash:proposal.snapshot_hash,channel,receipt_hash:receiptHash});
      return this.proposal(taskId);
    });
  }
  /**
   * Consuming precedes the dispatch intent.  If the process dies afterwards the
   * approval is intentionally unavailable for replay; reconciliation/new approval
   * is required instead of a second click.
   */
  consumeProposalApproval(taskId:string,expectedSnapshotHash:string) {
    return this.transaction(()=>{
      const proposal=this.proposal(taskId),task=this.task(taskId);
      requireCondition(proposal.state==='approved','APPROVAL_NOT_CONSUMABLE');
      requireCondition(proposal.expires_at_ms!==null&&proposal.expires_at_ms>Date.now(),'APPROVAL_EXPIRED');
      requireCondition(proposal.snapshot_hash===expectedSnapshotHash,'APPROVAL_SNAPSHOT_MISMATCH');
      // Binding an owned browser changes the task to running before the final
      // form snapshot can be checked.  No command intent exists at this point.
      requireCondition(task.status==='ready_to_resume'||task.status==='running','TASK_NOT_APPROVED_FOR_WRITE');
      requireCondition(!this.#db.prepare('SELECT id FROM command_intent WHERE task_id=?').get(taskId),'APPROVAL_AFTER_INTENT_FORBIDDEN');
      this.#db.prepare("UPDATE task_proposal SET state='consumed',consumed_at=? WHERE task_id=?").run(timestamp(),taskId);
      this.event(taskId,'proposal.consumed',{snapshot_hash:expectedSnapshotHash});
      return this.proposal(taskId);
    });
  }
  invalidateProposal(taskId:string,reason:string) {
    return this.transaction(()=>{
      const proposal=this.proposal(taskId),task=this.task(taskId);
      requireCondition(['draft','waiting_approval','approved','consumed'].includes(proposal.state),'PROPOSAL_NOT_INVALIDATABLE');
      requireCondition(!terminal.has(task.status),'TASK_TERMINAL');
      this.#db.prepare("UPDATE task_proposal SET state='invalidated' WHERE task_id=?").run(taskId);
      this.state(taskId,'paused_dependency',reason);
      this.event(taskId,'proposal.invalidated',{reason,snapshot_hash:proposal.snapshot_hash});
      return this.proposal(taskId);
    });
  }
  holdTaskProposal(taskId:string,status:'waiting_auth'|'waiting_orchestrator',reason:string) {
    return this.transaction(()=>{
      const proposal=this.proposal(taskId),task=this.task(taskId);
      requireCondition(proposal.state==='draft','PROPOSAL_NOT_HOLDABLE');
      requireCondition(task.status==='running'||task.status==='queued','TASK_NOT_HOLDABLE');
      this.state(taskId,status,reason);
      this.event(taskId,'proposal.hold',{status,reason});
      return this.task(taskId);
    });
  }
  expireProposal(taskId:string) {
    return this.transaction(()=>{
      const proposal=this.proposal(taskId),task=this.task(taskId);
      requireCondition(proposal.state==='waiting_approval'||proposal.state==='approved','PROPOSAL_NOT_EXPIRABLE');
      requireCondition(proposal.expires_at_ms!==null&&proposal.expires_at_ms<=Date.now(),'APPROVAL_NOT_EXPIRED');
      requireCondition(!terminal.has(task.status),'TASK_TERMINAL');
      this.#db.prepare("UPDATE task_proposal SET state='expired' WHERE task_id=?").run(taskId);
      this.state(taskId,'paused_dependency','approval_expired_reproposal_required');
      this.event(taskId,'proposal.expired',{snapshot_hash:proposal.snapshot_hash});
      return this.proposal(taskId);
    });
  }
  recordTaskStage(taskId:string,stage:string,executor:string,elapsedMs:number,detail:Record<string,unknown>={}) {
    requireCondition(/^[a-z][a-z0-9._-]{0,79}$/.test(stage),'INVALID_STAGE');
    requireCondition(/^[a-z][a-z0-9._-]{0,79}$/.test(executor),'INVALID_EXECUTOR');
    requireCondition(Number.isFinite(elapsedMs)&&elapsedMs>=0,'INVALID_STAGE_DURATION');
    const encoded=canonicalJson(detail);this.transaction(()=>{this.task(taskId);this.#db.prepare('INSERT INTO task_stage_timing(task_id,stage,executor,elapsed_ms,detail_json,created_at) VALUES (?,?,?,?,?,?)').run(taskId,stage,executor,elapsedMs,encoded,timestamp());this.event(taskId,'task.stage',{stage,executor,elapsed_ms:elapsedMs,detail});});
  }
  taskStages(taskId:string) {this.task(taskId);return this.#db.prepare('SELECT stage,executor,elapsed_ms,detail_json,created_at FROM task_stage_timing WHERE task_id=? ORDER BY id').all(taskId).map(row=>({stage:String(row.stage),executor:String(row.executor),elapsed_ms:Number(row.elapsed_ms),detail:JSON.parse(String(row.detail_json)),created_at:String(row.created_at)}));}
  task(id:string):TaskRecord {
    const row=this.#db.prepare('SELECT * FROM task WHERE id=?').get(id);requireCondition(row,'TASK_NOT_FOUND');return row as unknown as TaskRecord;
  }
  tasks(projectId:string):TaskRecord[] {this.project(projectId);return this.#db.prepare('SELECT * FROM task WHERE project_id=? ORDER BY created_at,id').all(projectId) as unknown as TaskRecord[];}
  protected event(taskId:string,kind:string,data:Record<string,unknown>) {
    const task=this.task(taskId),id=this.#db.prepare('INSERT INTO event(project_id,task_id,kind,data_json,created_at) VALUES (?,?,?,?,?)').run(task.project_id,taskId,kind,JSON.stringify(data),timestamp()).lastInsertRowid;
    this.#db.prepare('INSERT INTO outbox VALUES (?)').run(id);
  }
  protected state(taskId:string,status:TaskStatus,nextAction:string,effect?:'none'|'unknown'|'observed') {
    const old=this.task(taskId);requireCondition(!terminal.has(old.status),'TASK_TERMINAL');
    this.#db.prepare('UPDATE task SET status=?,next_action=?,effect_state=?,updated_at=? WHERE id=?').run(status,nextAction,effect??old.effect_state,timestamp(),taskId);
    this.event(taskId,'task.state',{from:old.status,to:status,next_action:nextAction,effect_state:effect??old.effect_state});
  }
  acquire(taskId:string,resource:string,targetRef:string):Lease {
    return this.transaction(()=>{
      const task=this.task(taskId);requireCondition(task.status==='queued'||task.status==='ready_to_resume','TASK_NOT_BINDABLE');
      const old=this.#db.prepare('SELECT * FROM lease WHERE resource=?').get(resource);
      requireCondition(!old||(!old.active&&!old.inflight_intent),'RESOURCE_BUSY');
      const generation=Number(old?.generation??0)+1,token=randomUUID();
      this.#db.prepare('INSERT INTO lease VALUES (?,?,?,?,?,1,NULL) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,task_id=excluded.task_id,generation=excluded.generation,token=excluded.token,active=1').run(resource,task.project_id,taskId,generation,token);
      this.#db.prepare('UPDATE task SET target_ref=? WHERE id=?').run(targetRef,taskId);this.state(taskId,'running','dispatch');
      return {resource,projectId:task.project_id,taskId,generation,token};
    });
  }
  assertLease(lease:Lease) {
    this.assertRuntimeIdentity();
    const row=this.#db.prepare('SELECT * FROM lease WHERE resource=?').get(lease.resource);
    requireCondition(row?.active===1&&row.project_id===lease.projectId&&row.task_id===lease.taskId&&row.generation===lease.generation&&row.token===lease.token,'STALE_FENCE');
  }
  release(lease:Lease) {
    this.transaction(()=>{this.assertLease(lease);const row=this.#db.prepare('SELECT inflight_intent FROM lease WHERE resource=?').get(lease.resource);requireCondition(row?.inflight_intent===null,'UNRESOLVED_INTENT');this.#db.prepare('UPDATE lease SET active=0 WHERE resource=?').run(lease.resource);this.event(lease.taskId,'lease.released',{});});
  }
  begin(lease:Lease,capability:string,effect:Effect,input:unknown,route:string):string {
    return this.transaction(()=>{
      this.assertLease(lease);const task=this.task(lease.taskId);requireCondition(task.status==='running'&&!task.cancel_requested,'TASK_NOT_DISPATCHABLE');requireCondition(task.capability===capability,'CAPABILITY_MISMATCH');
      requireCondition(this.#db.prepare('SELECT inflight_intent FROM lease WHERE resource=?').get(lease.resource)?.inflight_intent===null,'INFLIGHT_WRITER');
      const id=randomUUID(),step=randomUUID(),digest=createHash('sha256').update(JSON.stringify(input)).digest('hex');
      this.#db.prepare('INSERT INTO step VALUES (?,?,?)').run(step,task.id,capability);
      this.#db.prepare('INSERT INTO command_intent(id,step_id,task_id,resource,generation,effect,input_hash,status,created_at) VALUES (?,?,?,?,?,?,?,\'dispatched\',?)').run(id,step,task.id,lease.resource,lease.generation,effect,digest,timestamp());
      this.#db.prepare('UPDATE lease SET inflight_intent=? WHERE resource=?').run(id,lease.resource);
      this.#db.prepare('UPDATE task SET selected_route=?,effect_state=? WHERE id=?').run(route,effect==='write_external'?'unknown':'none',task.id);
      this.event(task.id,'command.intent',{intent_id:id,capability,effect,input_hash:digest,generation:lease.generation});return id;
    });
  }
  response(lease:Lease,intentId:string,ok:boolean) {
    this.transaction(()=>{this.assertIntent(lease,intentId);this.#db.prepare('UPDATE command_intent SET status=\'response_recorded\',response_json=? WHERE id=?').run(JSON.stringify({ok}),intentId);this.state(lease.taskId,'verifying','independent_readback');this.event(lease.taskId,'command.response',{intent_id:intentId,ok});});
  }
  private assertIntent(lease:Lease,intentId:string) {
    this.assertLease(lease);requireCondition(this.#db.prepare('SELECT inflight_intent FROM lease WHERE resource=?').get(lease.resource)?.inflight_intent===intentId,'INTENT_BINDING_MISMATCH');
  }
  complete(lease:Lease,intentId:string,verification:Verification) {
    return this.transaction(()=>{
      this.assertIntent(lease,intentId);const task=this.task(lease.taskId);
      requireCondition(task.status==='verifying'||task.status==='reconciliation_required','VERIFICATION_NOT_EXPECTED');
      const matched=verification.result==='MATCH',writes=this.#db.prepare('SELECT effect FROM command_intent WHERE id=?').get(intentId)?.effect==='write_external';
      this.#db.prepare('UPDATE command_intent SET status=?,verification_json=? WHERE id=?').run(matched?'verified':'uncertain',JSON.stringify(verification),intentId);
      this.event(task.id,'command.verification',{intent_id:intentId,result:verification.result,source:verification.source});
      if(matched){this.state(task.id,task.cancel_requested?'cancelled':'succeeded',task.cancel_requested&&writes?'effect_observed_before_cancel':'none',writes?'observed':'none');this.#db.prepare('UPDATE lease SET inflight_intent=NULL WHERE resource=?').run(lease.resource);}
      else this.state(task.id,'reconciliation_required','read_authoritative_result_no_write_retry',writes?'unknown':'none');
      return this.task(task.id);
    });
  }
  cancel(taskId:string) {
    return this.transaction(()=>{requireCondition(!this.#db.prepare('SELECT task_id FROM terminal_session WHERE task_id=?').get(taskId),'MANAGED_CANCELLATION_REQUIRES_TERMINAL_HOST');const task=this.task(taskId);if(terminal.has(task.status))return task;this.#db.prepare('UPDATE task SET cancel_requested=1 WHERE id=?').run(taskId);const pending=this.#db.prepare('SELECT id FROM command_intent WHERE task_id=? AND status!=\'verified\'').get(taskId);if(!pending){this.state(taskId,'cancelled','none');this.#db.prepare('UPDATE lease SET active=0 WHERE task_id=? AND inflight_intent IS NULL AND NOT EXISTS (SELECT 1 FROM submission WHERE task_id=? AND worker_nonce IS NOT NULL)').run(taskId,taskId);}else this.event(taskId,'task.cancel_requested',{effect_not_rolled_back:true});return this.task(taskId);});
  }
  pauseBeforeDispatch(taskId:string,reason:string) {
    return this.transaction(()=>{const pending=this.#db.prepare('SELECT id FROM command_intent WHERE task_id=?').get(taskId);requireCondition(!pending,'INTENT_ALREADY_EXISTS');this.state(taskId,'paused_dependency',reason);return this.task(taskId);});
  }
  recoverTask(taskId:string) {
    // Explicit operator-selected task only. Never called implicitly by opening a DB.
    return this.transaction(()=>{
      requireCondition(!this.#db.prepare('SELECT task_id FROM submission WHERE task_id=?').get(taskId),'MANAGED_RECOVERY_REQUIRES_SUPERVISOR');
      requireCondition(!this.#db.prepare('SELECT task_id FROM terminal_session WHERE task_id=?').get(taskId),'MANAGED_RECOVERY_REQUIRES_TERMINAL_HOST');
      const task=this.task(taskId);if(terminal.has(task.status))return task;
      const pending=this.#db.prepare('SELECT id,effect FROM command_intent WHERE task_id=? AND status!=\'verified\'').get(taskId);
      if(pending)this.state(taskId,'reconciliation_required','read_authoritative_result_no_write_retry',pending.effect==='write_external'?'unknown':'none');
      else {this.state(taskId,'ready_to_resume','rebind_owned_target');this.#db.prepare('UPDATE lease SET active=0 WHERE task_id=? AND inflight_intent IS NULL').run(taskId);}
      return this.task(taskId);
    });
  }
  markUncertain(lease:Lease){
    this.transaction(()=>{
      this.assertLease(lease);
      requireCondition(this.#db.prepare('SELECT inflight_intent FROM lease WHERE resource=?').get(lease.resource)?.inflight_intent,'INTENT_REQUIRED');
      this.state(lease.taskId,'reconciliation_required','read_authoritative_result_no_write_retry','unknown');
    });
  }
  events(projectId:string,consumerId:string,limit=100) {
    requireCondition(Number.isInteger(limit)&&limit>0&&limit<=1000,'INVALID_LIMIT');this.project(projectId);
    return this.transaction(()=>{
      this.#db.prepare('INSERT OR IGNORE INTO consumer_cursor(project_id,consumer_id) VALUES (?,?)').run(projectId,consumerId);
      const cursor=Number(this.#db.prepare('SELECT cursor FROM consumer_cursor WHERE project_id=? AND consumer_id=?').get(projectId,consumerId)?.cursor);
      const events=this.#db.prepare('SELECT event.* FROM event JOIN outbox ON event.id=outbox.event_id WHERE project_id=? AND event.id>? ORDER BY event.id LIMIT ?').all(projectId,cursor,limit);
      if(events.length)this.#db.prepare('UPDATE consumer_cursor SET delivered=MAX(delivered,?) WHERE project_id=? AND consumer_id=?').run(Number(events.at(-1)?.id),projectId,consumerId);
      return events.map(e=>({...e,data:JSON.parse(String(e.data_json)) as unknown}));
    });
  }
  ack(projectId:string,consumerId:string,eventId:number) {
    this.transaction(()=>{const row=this.#db.prepare('SELECT * FROM consumer_cursor WHERE project_id=? AND consumer_id=?').get(projectId,consumerId);requireCondition(row&&Number.isSafeInteger(eventId)&&eventId>=Number(row.cursor)&&eventId<=Number(row.delivered),'INVALID_ACK');requireCondition(this.#db.prepare('SELECT id FROM event WHERE id=? AND project_id=?').get(eventId,projectId),'EVENT_PROJECT_MISMATCH');this.#db.prepare('UPDATE consumer_cursor SET cursor=? WHERE project_id=? AND consumer_id=?').run(eventId,projectId,consumerId);});
  }
}
