import {randomUUID} from 'node:crypto';
import {RuntimeStore} from '../store/runtime-store.js';
import {requireCondition,type Verification} from '../core/contracts.js';
import {bootClock,type ProcessIdentity} from './identity.js';
import {type SupervisorRecord,type SubmissionRecord} from './contracts.js';

const terminal=new Set(['succeeded','failed','cancelled']);
export function remainingBudget(row:SubmissionRecord):number{
  const clock=bootClock(),payload=JSON.parse(row.payload_json) as {deadline_ms:number};
  if(clock.bootId==='unknown'||clock.bootId!==row.accepted_boot_id||row.accepted_uptime_ms===null)return 0;
  const elapsed=clock.uptimeMs-row.accepted_uptime_ms;
  return elapsed<0?0:Math.max(0,payload.deadline_ms-elapsed);
}
export class RecoveryStore extends RuntimeStore{
  supervisor(project:string){return this.connection.prepare('SELECT * FROM supervisor WHERE project_id=?').get(project) as unknown as SupervisorRecord|undefined;}
  submission(task:string){const row=this.connection.prepare('SELECT * FROM submission WHERE task_id=?').get(task);requireCondition(row,'SUBMISSION_NOT_FOUND');return row as unknown as SubmissionRecord;}
  submissions(project:string){return this.connection.prepare('SELECT * FROM submission WHERE project_id=? ORDER BY accepted_at,task_id').all(project) as unknown as SubmissionRecord[];}
  own(project:string,nonce:string){const owner=this.supervisor(project);requireCondition(owner?.active===1&&owner.nonce===nonce&&!owner.stop_requested,'STALE_SUPERVISOR');}
  claimSupervisor(project:string,hash:string,identity:ProcessIdentity,previousNonce:string|null){
    return this.transaction(()=>{
      const old=this.supervisor(project);requireCondition((old?.nonce??null)===previousNonce,'SUPERVISOR_RACE');
      const nonce=randomUUID();
      this.connection.prepare('INSERT INTO supervisor VALUES (?,?,?,?,1,0,?) ON CONFLICT(project_id) DO UPDATE SET nonce=excluded.nonce,identity_json=excluded.identity_json,config_hash=excluded.config_hash,active=1,stop_requested=0,started_at=excluded.started_at').run(project,nonce,JSON.stringify(identity),hash,new Date().toISOString());return nonce;
    });
  }
  stopSupervisor(project:string,nonce:string){this.connection.prepare('UPDATE supervisor SET stop_requested=1 WHERE project_id=? AND nonce=?').run(project,nonce);}
  retireSupervisor(project:string,nonce:string){this.connection.prepare('UPDATE supervisor SET active=0 WHERE project_id=? AND nonce=?').run(project,nonce);}
  reserve(project:string,nonce:string,task:string){
    return this.transaction(()=>{
      this.own(project,nonce);const row=this.submission(task);requireCondition(row.project_id===project,'TASK_SCOPE_MISMATCH');
      requireCondition(row.recovery_state==='pending'&&this.task(task).status==='queued','TASK_NOT_DISPATCHABLE');
      requireCondition(!this.submissions(project).some(s=>['reserved','running','reconcile'].includes(s.recovery_state)),'WORKER_ACTIVE');
      requireCondition(row.attempt_count<3&&remainingBudget(row)>0&&row.retry_after_ms<=bootClock().uptimeMs,'RETRY_NOT_ALLOWED');
      const ticket=randomUUID();
      this.connection.prepare("UPDATE submission SET recovery_state='reserved',launch_nonce=?,launch_owner=?,dispatch_generation=dispatch_generation+1,attempt_count=attempt_count+1,last_error=NULL,retry_after_ms=? WHERE task_id=?").run(ticket,nonce,bootClock().uptimeMs+5000,task);
      this.event(task,'worker.reserved',{dispatch_generation:row.dispatch_generation+1,attempt:row.attempt_count+1});return this.submission(task);
    });
  }
  claimWorker(task:string,hash:string,ticket:string,generation:number,identity:ProcessIdentity){
    return this.transaction(()=>{
      const row=this.submission(task);requireCondition(row.config_hash===hash,'CONFIG_CHANGED');
      requireCondition(row.recovery_state==='reserved'&&row.launch_nonce===ticket&&row.dispatch_generation===generation&&!row.worker_nonce,'STALE_LAUNCH');
      this.own(row.project_id,row.launch_owner!);
      requireCondition(this.task(task).status==='queued'&&!this.task(task).cancel_requested&&remainingBudget(row)>0,'TASK_NOT_DISPATCHABLE');
      this.connection.prepare("UPDATE submission SET recovery_state='running',worker_nonce=?,worker_identity_json=?,worker_pid=?,worker_started_at=? WHERE task_id=?").run(randomUUID(),JSON.stringify(identity),identity.pid,new Date().toISOString(),task);
      this.event(task,'worker.claimed',{dispatch_generation:generation,pid:identity.pid});return this.submission(task);
    });
  }
  noteLaunch(row:SubmissionRecord,nonce:string,identity:ProcessIdentity){
    this.transaction(()=>{
      this.own(row.project_id,nonce);
      this.connection.prepare("UPDATE submission SET worker_identity_json=? WHERE task_id=? AND recovery_state='reserved' AND launch_nonce=? AND launch_owner=?").run(JSON.stringify(identity),row.task_id,row.launch_nonce,nonce);
    });
  }
  workerFinished(task:string,ticket:string,generation:number){
    this.transaction(()=>{
      const row=this.submission(task);requireCondition(row.launch_nonce===ticket&&row.dispatch_generation===generation,'STALE_LAUNCH');
      // Keep identity until death is independently observed, even after normal close.
      this.event(task,'worker.context_closed',{dispatch_generation:generation});
    });
  }
  hasIntent(task:string){return !!this.connection.prepare('SELECT id FROM command_intent WHERE task_id=?').get(task);}
  resourceBusy(project:string){return !!this.connection.prepare('SELECT resource FROM lease WHERE project_id=? AND (active=1 OR inflight_intent IS NOT NULL)').get(project);}
  private same(row:SubmissionRecord,nonce:string){
    this.own(row.project_id,nonce);const current=this.submission(row.task_id);
    requireCondition(current.dispatch_generation===row.dispatch_generation&&current.recovery_state===row.recovery_state&&current.worker_nonce===row.worker_nonce&&current.recovery_generation===row.recovery_generation,'RECOVERY_RACE');return current;
  }
  block(row:SubmissionRecord,nonce:string,reason:string){
    this.transaction(()=>{this.same(row,nonce);const task=this.task(row.task_id);
      this.connection.prepare("UPDATE submission SET recovery_state='blocked',last_error=? WHERE task_id=?").run(reason,row.task_id);
      if(!terminal.has(task.status)&&!this.hasIntent(task.id))this.state(task.id,'paused_dependency',reason);
      this.event(task.id,'recovery.blocked',{reason});
    });
  }
  // Caller proves recorded worker dead and configured profile clear before entering.
  recoverDead(row:SubmissionRecord,nonce:string,policy:'auto_resume'|'prepare_only',hash:string){
    this.transaction(()=>{
      this.same(row,nonce);const task=this.task(row.task_id);
      if(terminal.has(task.status)){
        this.connection.prepare('UPDATE lease SET active=0 WHERE task_id=? AND inflight_intent IS NULL').run(task.id);
        this.connection.prepare("UPDATE submission SET recovery_state='done' WHERE task_id=?").run(task.id);return;
      }
      if(this.hasIntent(task.id)){
        this.connection.prepare("UPDATE submission SET recovery_state='reconcile',recovery_generation=recovery_generation+1,last_error=NULL WHERE task_id=?").run(task.id);
        this.state(task.id,'reconciliation_required','read_authoritative_result_no_write_retry','unknown');return;
      }
      this.connection.prepare('UPDATE lease SET active=0 WHERE task_id=? AND inflight_intent IS NULL').run(task.id);
      const reason=row.config_hash!==hash?'CONFIG_CHANGED':remainingBudget(row)<=0?'DEADLINE_OR_BOOT_CHANGED':row.attempt_count>=3?'RESTART_BUDGET_EXHAUSTED':null;
      const prepared=policy==='prepare_only';
      this.connection.prepare('UPDATE submission SET recovery_state=?,recovery_generation=recovery_generation+1,worker_nonce=NULL,worker_identity_json=NULL,worker_pid=NULL,launch_nonce=NULL,launch_owner=NULL,retry_after_ms=?,last_error=? WHERE task_id=?').run(reason?'blocked':prepared?'prepared':'pending',bootClock().uptimeMs+Math.min(2000,200*2**row.attempt_count),reason,task.id);
      this.state(task.id,reason?'paused_dependency':prepared?'ready_to_resume':'queued',reason??(prepared?'explicit_resume_required':'supervisor_retry'));
    });
  }
  prepare(task:string,generation:number){
    return this.transaction(()=>{
      const row=this.submission(task);requireCondition(row.recovery_generation===generation,'STALE_RECOVERY_GENERATION');
      requireCondition(row.recovery_state==='prepared','RECOVERY_NOT_PREPARED');
      return {...this.outcome(task),prepared_kind:'handoff',automatic_execution:false};
    });
  }
  resume(task:string,generation:number,hash:string){
    this.transaction(()=>{
      const row=this.submission(task);requireCondition(row.recovery_generation===generation,'STALE_RECOVERY_GENERATION');
      requireCondition(row.recovery_state==='prepared'&&this.task(task).status==='ready_to_resume'&&!this.hasIntent(task),'UNSAFE_RESUME');
      requireCondition(row.config_hash===hash&&remainingBudget(row)>0&&row.attempt_count<3,'RESUME_PRECONDITION_FAILED');
      this.connection.prepare("UPDATE submission SET recovery_state='pending',recovery_generation=recovery_generation+1 WHERE task_id=?").run(task);this.state(task,'queued','supervisor_resume');
    });
  }
  reconcile(row:SubmissionRecord,nonce:string,verification:Verification){
    this.transaction(()=>{
      this.same(row,nonce);requireCondition(row.recovery_state==='reconcile','RECONCILIATION_NOT_EXPECTED');
      const task=this.task(row.task_id),intent=this.connection.prepare('SELECT * FROM command_intent WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(task.id);
      requireCondition(intent&&intent.generation===verification.generation&&task.target_ref===verification.targetRef&&this.project(task.project_id).accountRef===verification.accountRef,'VERIFICATION_BINDING_MISMATCH');
      const matched=verification.result==='MATCH';
      this.connection.prepare('UPDATE command_intent SET status=?,verification_json=? WHERE id=?').run(matched?'verified':'uncertain',JSON.stringify(verification),String(intent.id));
      this.connection.prepare('UPDATE submission SET recovery_state=?,last_error=? WHERE task_id=?').run(matched?'done':'blocked',matched?null:'READBACK_UNRESOLVED',task.id);
      if(matched){
        this.state(task.id,task.cancel_requested?'cancelled':'succeeded',task.cancel_requested?'effect_observed_before_cancel':'none','observed');
        this.connection.prepare('UPDATE lease SET active=0,inflight_intent=NULL WHERE task_id=? AND inflight_intent=? AND generation=?').run(task.id,String(intent.id),verification.generation);
      }else this.state(task.id,'reconciliation_required','read_authoritative_result_no_write_retry','unknown');
      this.event(task.id,'recovery.readback',{result:verification.result,source:verification.source});
    });
  }
  intentGeneration(task:string){return Number(this.connection.prepare('SELECT generation FROM command_intent WHERE task_id=? ORDER BY created_at DESC LIMIT 1').get(task)?.generation);}
}
