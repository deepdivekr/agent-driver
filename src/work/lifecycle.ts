import {z} from 'zod';
import {type SQLInputValue} from 'node:sqlite';
import {type PackStore} from '../packs/store.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {requireCondition} from '../core/contracts.js';

const workIdSchema=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u);
export const lifecycleActionSchema=z.object({
  work_id:workIdSchema,revision:z.number().int().min(0),work_revision:z.number().int().min(0).nullable(),
  action:z.enum(['disconnect','remove']),confirmed:z.literal(true),
}).strict();
export type WorkLifecycle={state:'connected'|'disconnected'|'removed';revision:number;work_revision:number|null;updated_at:string|null};

const table=(store:PackStore,name:string)=>Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const row=(store:PackStore,sql:string,...args:SQLInputValue[])=>store.hermesState.prepare(sql).get(...args);
/** History remains readable. Connected is implicit for databases predating this table. */
export function readWorkLifecycle(store:PackStore,project:string,id:string):WorkLifecycle{
  store.officeWorkById(project,id);
  const state=row(store,'SELECT state,revision,updated_at FROM office_work_lifecycle WHERE project_id=? AND work_id=?',project,id);
  const revisionSource=table(store,'office_remote_work')?row(store,'SELECT revision FROM office_remote_work WHERE project_id=? AND work_id=?',project,id):null;
  const hermesRevision=table(store,'hermes_work')?row(store,'SELECT revision FROM hermes_work WHERE project_id=? AND work_id=?',project,id):null;
  const intakeRevision=row(store,'SELECT revision FROM office_intake WHERE project_id=? AND work_id=?',project,id);
  const workRevision=revisionSource?.revision??hermesRevision?.revision??intakeRevision?.revision??null;
  return {state:state?String(state.state) as WorkLifecycle['state']:'connected',revision:state?Number(state.revision):0,work_revision:workRevision===null?null:Number(workRevision),updated_at:state?String(state.updated_at):null};
}
export function assertWorkConnected(store:PackStore,project:string,id:string):void{
  store.officeWorkById(project,id);
  const state=row(store,'SELECT state FROM office_work_lifecycle WHERE project_id=? AND work_id=?',project,id)?.state;
  requireCondition(state!=='disconnected','WORK_DISCONNECTED');
  requireCondition(state!=='removed','WORK_REMOVED');
}
/** A bound tool run must not revive a disconnected Work; standalone runs are unchanged. */
export function assertBoundRunConnected(store:PackStore,project:string,kind:string,runId:string):void{
  const binding=row(store,'SELECT work_id FROM office_run WHERE project_id=? AND source_kind=? AND source_id=?',project,kind,runId);
  if(binding)assertWorkConnected(store,project,String(binding.work_id));
}

function hasUncertain(value:unknown):boolean{
  if(!value||typeof value!=='object')return false;
  if(Array.isArray(value))return value.some(hasUncertain);
  const record=value as Record<string,unknown>;
  if(record.effect_state==='uncertain'||record.state==='reconciliation_required'||record.status==='reconciliation_required')return true;
  const pending=record.pending as Record<string,unknown>|null|undefined;
  if(pending?.dispatched===true&&pending.effect!=='read_only')return true;
  const workers=record.workers;if(workers&&typeof workers==='object'&&Object.values(workers).some(hasUncertain))return true;
  return ['checkpoint','observations','final_observations','receipt'].some(key=>hasUncertain(record[key]));
}
function blockedReason(store:PackStore,project:string,id:string,now:number):string|null{
  const read=(name:string,sql:string,...args:SQLInputValue[])=>table(store,name)?row(store,sql,...args):null;
  const uncertain=(name:string,sql:string,...args:SQLInputValue[])=>Boolean(read(name,sql,...args));
  if(uncertain('office_supervisor',"SELECT 1 FROM office_supervisor WHERE project_id=? AND work_id=? AND state='reconciliation_required'",project,id)
    ||uncertain('office_remote_turn',"SELECT 1 FROM office_remote_turn WHERE project_id=? AND work_id=? AND status IN ('uncertain','reconciliation_required')",project,id)
    ||uncertain('hermes_turn',"SELECT 1 FROM hermes_turn WHERE project_id=? AND work_id=? AND status IN ('uncertain','reconciliation_required')",project,id)
    ||uncertain('office_result_delivery',"SELECT 1 FROM office_result_delivery WHERE project_id=? AND work_id=? AND status='reconciliation_required'",project,id)
    ||uncertain('coding_dialog',"SELECT 1 FROM coding_dialog WHERE project_id=? AND work_id=? AND status='reconciliation_required'",project,id)
    ||uncertain('coding_run',"SELECT 1 FROM coding_run WHERE project_id=? AND work_id=? AND status='reconciliation_required'",project,id))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
  if(uncertain('file_explorer_record',"SELECT 1 FROM file_explorer_record WHERE project=? AND kind='plan' AND json_extract(body,'$.work_id')=? AND json_extract(body,'$.state') IN ('applying','undoing','needs_review')",project,id)
    ||uncertain('windows_workflow_run',"SELECT 1 FROM windows_workflow_run WHERE project_id=? AND work_id=? AND (json_extract(body,'$.status') IN ('executing','reconciliation_required') OR json_extract(body,'$.pending_command') IS NOT NULL)",project,id))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
  if(table(store,'office_supervisor')){
    const snapshots=store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE project_id=? AND work_id=?').all(project,id);
    if(snapshots.some(item=>{try{return hasUncertain(JSON.parse(String(item.checkpoint)));}catch{return true;}}))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
  }
  const bindings=store.officeRuns(project,id);
  for(const binding of bindings){
    if(binding.source_kind==='pack'){
      const run=store.packRun(project,binding.source_id),execution=store.packExecution(project,binding.source_id);
      if(run.status==='reconciliation_required'||hasUncertain(execution?.checkpoint))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
      if(run.task_id){
        const task=store.task(run.task_id);
        if(task.effect_state==='unknown'||task.status==='reconciliation_required'||row(store,"SELECT 1 FROM command_intent WHERE task_id=? AND status IN ('dispatched','response_recorded','uncertain')",run.task_id))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
        if(row(store,'SELECT 1 FROM lease WHERE task_id=? AND active=1',run.task_id))return 'WORK_LIFECYCLE_BUSY';
      }
      if(execution?.owner&&execution.lease_until_ms>now)return 'WORK_LIFECYCLE_BUSY';
    }else if(binding.source_kind==='swarm'){
      const snapshot=store.swarmRun(project,binding.source_id).snapshot as SwarmRunSnapshot;
      if(hasUncertain(snapshot))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
      if(snapshot.status==='running'&&Object.values(snapshot.workers).some(worker=>worker.status==='leased'&&Boolean(worker.lease_token)&&(worker.lease_expires_at_ms??0)>now))return 'WORK_LIFECYCLE_BUSY';
    }else if(binding.source_kind==='coding'){
      const run=store.codingRun(project,binding.source_id);
      const stages=store.codingStages(project,run.id);
      if(run.status==='reconciliation_required'||stages.some(stage=>stage.status==='reconciliation_required'||stage.status==='running'&&(!stage.owner||stage.lease_until_ms<=now)))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
      if(stages.some(stage=>stage.owner&&stage.lease_until_ms>now))return 'WORK_LIFECYCLE_BUSY';
    }else if(binding.source_kind==='coding_dialog'){
      const dialog=store.codingDialog(project,binding.source_id);
      const turns=store.codingDialogTurns(project,dialog.id,100);
      if(dialog.status==='reconciliation_required'||turns.some(turn=>turn.status==='uncertain'||turn.status==='running'&&(!turn.owner||turn.lease_until_ms<=now)))return 'WORK_LIFECYCLE_RECONCILIATION_REQUIRED';
      if(turns.some(turn=>turn.owner&&turn.lease_until_ms>now))return 'WORK_LIFECYCLE_BUSY';
    }
  }
  if(uncertain('office_intake','SELECT 1 FROM office_intake WHERE project_id=? AND work_id=? AND define_owner IS NOT NULL AND define_lease_until_ms>?',project,id,now)
    ||uncertain('office_execution','SELECT 1 FROM office_execution WHERE project_id=? AND work_id=? AND owner IS NOT NULL AND lease_until_ms>?',project,id,now)
    ||uncertain('office_supervisor','SELECT 1 FROM office_supervisor WHERE project_id=? AND work_id=? AND owner IS NOT NULL AND lease_until_ms>?',project,id,now)
    ||uncertain('office_remote_turn',"SELECT 1 FROM office_remote_turn WHERE project_id=? AND work_id=? AND status IN ('sending','running')",project,id)
    ||uncertain('hermes_turn',"SELECT 1 FROM hermes_turn WHERE project_id=? AND work_id=? AND status IN ('starting','running','needs_human')",project,id)
    ||uncertain('office_result_delivery',"SELECT 1 FROM office_result_delivery WHERE project_id=? AND work_id=? AND status='sending'",project,id))return 'WORK_LIFECYCLE_BUSY';
  return null;
}

/** Office-only soft detachment: original runtime bindings and all receipts stay intact. */
export function changeWorkLifecycle(store:PackStore,project:string,raw:unknown){
  const input=lifecycleActionSchema.parse(raw);
  return store.transaction(()=>{
    const current=readWorkLifecycle(store,project,input.work_id);
    requireCondition(current.revision===input.revision,'WORK_LIFECYCLE_REVISION_CONFLICT');
    requireCondition(current.work_revision===input.work_revision,'WORK_REVISION_CONFLICT');
    const next=input.action==='remove'?'removed':'disconnected';
    requireCondition(current.state!=='removed'||next==='removed','WORK_REMOVED');
    if(current.state===next)return {work_id:input.work_id,lifecycle:current,deduplicated:true,original_runtime_unchanged:true,records_preserved:true};
    const reason=blockedReason(store,project,input.work_id,Date.now());requireCondition(!reason,reason??'WORK_LIFECYCLE_BUSY');
    const at=new Date().toISOString();
    store.hermesState.prepare("INSERT INTO office_work_lifecycle(work_id,project_id,state,revision,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET state=excluded.state,revision=excluded.revision,updated_at=excluded.updated_at WHERE project_id=excluded.project_id").run(input.work_id,project,next,current.revision+1,at);
    return {work_id:input.work_id,lifecycle:readWorkLifecycle(store,project,input.work_id),deduplicated:false,original_runtime_unchanged:true,records_preserved:true};
  });
}
