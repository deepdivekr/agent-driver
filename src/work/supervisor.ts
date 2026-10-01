import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {loadHostConfig,type HostConfig} from '../interface/config.js';
import {RuntimeApi} from '../interface/api.js';
import {hashJson,modelForRole,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {allocateWorkModels} from './task-models.js';
import {ConfiguredStructuredModel} from '../onboarding/configured-model.js';
import {modelSettingsPath,readModelSettings} from '../onboarding/model-settings.js';
import {requireCondition} from '../core/contracts.js';
import {safeControlText} from '../observability/safe-text.js';
import {workProposalSchema,workControlSchema as supervisorActionSchema,type WorkProposal} from './contracts.js';
import {validateOrCorrectWorkProposal,workPlanningContext,WORK_REPLANNING_INSTRUCTIONS,WORK_INTAKE_REQUIREMENTS_INSTRUCTIONS,WORK_COLLECTION_CONTRACT_INSTRUCTIONS} from './runtime.js';
import {readWorkIntakeOptions} from './intake-options.js';
import {BoundedWorkClientExecutor,boundWorkToolValue,workClientCheckpointSchema,type WorkClientCheckpoint,type WorkClientResult} from './client-executor.js';
import {packTools} from '../packs/contracts.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {activeSwarmWorkerCount,initWorkExecution,workActivity,withWorkActivityContext} from './activity.js';
import {businessSteps,currentStageReports,stageBinding} from './stages.js';
import {WorkExecutionTools} from './execution-tools.js';
import {executeSupervisedSwarm,assessSupervisedStages,type SupervisedSwarmCheckpoint,type SupervisedSwarmHooks} from './swarm-executor.js';
import {WorkSchedules} from './schedule.js';
import {captureWorkRunAdmissionCheckpoint,createWorkCompletionVerifier,createWorkRunTraceEvidence,hasObservableCompletionLeaves} from './completion.js';
import {workImportExecutionOwner} from './import-authority.js';
import {assertWorkConnected,readWorkLifecycle} from './lifecycle.js';
import {connectedSourceCatalog,observedWorkSourceSchemas} from '../packs/source-catalog.js';
import {createNativeCompletionResolver} from './native-completion.js';
import {assertCustomPackInvocation} from './custom-pack-repeat.js';
import {assertCustomPackScheduledRun} from './custom-pack-schedule.js';
import {PACK_ENGINE_VERSION} from '../packs/runtime.js';
import {sealCollectionContract,readSealedCollectionContract,createCollectionCompletionResolver} from './collection-contract.js';

const now=()=>new Date().toISOString();
const activeStates=['queued','running','retry_wait'];
type Row={run_id:string;project_id:string;work_id:string;work_revision:number;state:string;owner:string|null;lease_until_ms:number;attempts:number;retry_at_ms:number;checkpoint:string;result:string|null;reason:string|null;config_hash:string;model_revision:number;resume_wait:number;replan_required:number;current_run_only:number;timezone:string|null;created_at:string;updated_at:string};
export {workControlSchema as supervisorActionSchema} from './contracts.js';
type CompletionClaim=Parameters<NonNullable<Parameters<BoundedWorkClientExecutor['execute']>[1]['verifyCompletion']>>[2];
/** A receipt's aliases select that same receipt; they never add more evidence or hide an invalid claim. */
export function supervisorCompletionClaim(observations:WorkClientCheckpoint['observations'],claim:CompletionClaim,traceId:string,_originalRequestGate=false):CompletionClaim{
  requireCondition(observations.length<=32,'WORK_COMPLETION_OBSERVATION_LIMIT');
  const aliases=new Map<string,string>(),canonical=new Set<string>();
  for(const observation of observations){
    if(observation.receipt.status!=='succeeded'||observation.receipt.effect_state==='uncertain'||!hasObservableCompletionLeaves(observation.receipt.value))continue;
    const first=observation.receipt.evidence_ids[0];if(!first)continue;canonical.add(first);
    for(const id of observation.receipt.evidence_ids){requireCondition(!aliases.has(id)||aliases.get(id)===first,'WORK_COMPLETION_EVIDENCE_ALIAS_CONFLICT');aliases.set(id,first);}
  }
  requireCondition(canonical.size<=32&&!aliases.has(traceId),'WORK_COMPLETION_EVIDENCE_ID_CONFLICT');
  return {...claim,completed_checks:claim.completed_checks.map(check=>{
    const claimed=check.evidence_ids.map(id=>{const mapped=aliases.get(id);requireCondition(mapped,'WORK_COMPLETION_CLAIM_EVIDENCE_NOT_OBSERVED');return mapped;});
    // Compound checks can require source and output receipts from different
    // stages. A worker's narrow citations must not hide either supporting or
    // contradictory evidence, even when a separate original-request gate runs.
    return {...check,evidence_ids:[...new Set([...claimed,...canonical,traceId])]};
  })};
}
export function initWorkSupervisor(store:PackStore){initWorkExecution(store);store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),work_revision INTEGER NOT NULL,state TEXT NOT NULL,owner TEXT,lease_until_ms INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,retry_at_ms INTEGER NOT NULL DEFAULT 0,checkpoint TEXT NOT NULL DEFAULT 'null',result TEXT,reason TEXT,config_hash TEXT NOT NULL,model_revision INTEGER NOT NULL,resume_wait INTEGER NOT NULL DEFAULT 0,replan_required INTEGER NOT NULL DEFAULT 0,current_run_only INTEGER NOT NULL DEFAULT 0,timezone TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE INDEX IF NOT EXISTS office_supervisor_work ON office_supervisor(project_id,work_id,created_at);`);const columns=new Set(store.hermesState.prepare('PRAGMA table_info(office_supervisor)').all().map(c=>String(c.name)));for(const key of ['resume_wait','replan_required','current_run_only'])if(!columns.has(key))store.hermesState.exec(`ALTER TABLE office_supervisor ADD COLUMN ${key} INTEGER NOT NULL DEFAULT 0`);if(!columns.has('timezone'))store.hermesState.exec('ALTER TABLE office_supervisor ADD COLUMN timezone TEXT');}
/** A narrow historical bug: FamilyRuntime.fresh rejected absent Pack settings
 * before run()/beginPack(). Read-only proof; generic write errors stay unknown. */
function rejectedPackBeforeExecution(store:PackStore,row:Row,config?:HostConfig):WorkClientCheckpoint|null{
  try{
    if(!config||row.state!=='reconciliation_required'||row.reason!=='PACKS_NOT_CONNECTED'||row.owner!==null||row.lease_until_ms!==0||config.project.id!==row.project_id||config.packs!==null||row.config_hash!==config.fingerprint||resolve(config.dbPath)!==store.databasePath)return null;
    const current=loadHostConfig(config.path);if(current.fingerprint!==row.config_hash||current.packs!==null||resolve(current.dbPath)!==store.databasePath)return null;
    const work=store.intakeWork(row.project_id,row.work_id),spec=work.spec as WorkProposal|null;
    if(work.revision!==row.work_revision||spec?.requested_effect!=='read_only'||spec.route.kind!=='pack'||workImportExecutionOwner(store,row.project_id,row.work_id)==='original_runtime'||readWorkLifecycle(store,row.project_id,row.work_id).state!=='connected')return null;
    const checkpoint=workClientCheckpointSchema.parse(JSON.parse(row.checkpoint)),pending=checkpoint.pending;
    if(checkpoint.work_id!==row.work_id||checkpoint.run_id!==row.run_id||!pending||pending.tool_name!=='runtime_pack_run'||pending.effect!=='local_write'||pending.dispatched!==true||pending.turn!==checkpoint.turn||checkpoint.turn>=128||checkpoint.observations.length>=32)return null;
    const requestId=`work-tool-${hashJson({run_id:row.run_id,turn:pending.turn,tool:pending.tool_name,args:pending.arguments}).slice(0,48)}`;
    if(pending.request_id!==requestId||pending.arguments.work_id!==undefined&&pending.arguments.work_id!==row.work_id)return null;
    if(!packTools.runtime_pack_run.schema.safeParse({...pending.arguments,request_id:requestId,work_id:row.work_id}).success)return null;
    if(checkpoint.observations.some(item=>item.invocation.request_id===requestId||item.receipt.effect_state==='uncertain'||item.receipt.status==='reconciliation_required'))return null;
    const result=row.result?JSON.parse(row.result) as Record<string,unknown>:null;
    if(result?.completion_verified!==false||result.observations!==checkpoint.observations.length||result.summary!==checkpoint.summary)return null;
    const db=store.hermesState;
    if(db.prepare('SELECT 1 FROM family_run WHERE project_id=? AND request_id=?').get(row.project_id,requestId))return null;
    if(db.prepare("SELECT 1 FROM office_run o LEFT JOIN family_run f ON f.project_id=o.project_id AND f.id=o.source_id WHERE o.project_id=? AND o.work_id=? AND o.source_kind='pack' AND f.id IS NULL").get(row.project_id,row.work_id))return null;
    const started=db.prepare("SELECT id,metadata FROM office_activity WHERE project_id=? AND work_id=? AND kind='tool.started' AND created_at>=? ORDER BY id DESC LIMIT 1").get(row.project_id,row.work_id,row.created_at);
    const finished=db.prepare("SELECT id,metadata FROM office_activity WHERE project_id=? AND work_id=? AND kind='supervisor.result' AND created_at>=? ORDER BY id DESC LIMIT 1").get(row.project_id,row.work_id,row.created_at);
    if(!started||!finished||Number(finished.id)<=Number(started.id))return null;
    const startedMeta=JSON.parse(String(started.metadata)),finishedMeta=JSON.parse(String(finished.metadata));
    if(startedMeta.tool_name!==pending.tool_name||startedMeta.stage_id!==pending.stage_id||startedMeta.status!=='running'||finishedMeta.status!=='reconciliation_required'||finishedMeta.reason!=='PACKS_NOT_CONNECTED')return null;
    if(db.prepare("SELECT 1 FROM office_activity WHERE project_id=? AND work_id=? AND id>? AND kind='tool.result'").get(row.project_id,row.work_id,started.id!))return null;
    return checkpoint;
  }catch{return null;}
}
function preserveRejectedPackCall(store:PackStore,row:Row,checkpoint:WorkClientCheckpoint,at:string){
  const pending=checkpoint.pending!,reconciled:WorkClientCheckpoint={...checkpoint,pending:null,turn:pending.turn+1,observations:[...checkpoint.observations,{invocation:pending,receipt:{status:'retryable_failure',effect_state:'none',evidence_ids:[],retry_safe:false,value:{status:'pack_not_started',error:'PACKS_NOT_CONNECTED',prior_dispatched:true,reconciled_before_pack_execution:true,retry_not_attempted:true,correction_required:true,input_fingerprint:hashJson({tool_name:pending.tool_name,arguments:pending.arguments}),proof:{config_sha256:row.config_hash,checkpoint_sha256:hashJson(checkpoint),packs_absent:true,pack_request_absent:true,orphan_pack_bindings_absent:true}}},observed_at:at}]};
  const updated=store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE project_id=? AND run_id=? AND checkpoint=?').run(JSON.stringify(reconciled),row.project_id,row.run_id,row.checkpoint);
  requireCondition(updated.changes===1,'WORK_RECONCILIATION_REQUIRED');
  workActivity(store,row.project_id,row.work_id,'supervisor.refusal_reconciled','The original Pack call was rejected before Pack execution. Matching configuration, request identity and absent Pack records were verified; the original call was not replayed.',{stage_id:pending.stage_id,tool_name:pending.tool_name,status:'retryable_failure',reason:'PACKS_NOT_CONNECTED'});
}
/** Explicit, pause-only maintenance action. No executor, API or model is created.
 * The original dispatched invocation and failed supervisor result are retained;
 * only the independently proven pre-Pack refusal gains a no-effect receipt. */
export function reconcileUnstartedPackExecution(store:PackStore,config:HostConfig,raw:unknown){
  const input=z.object({work_id:z.string().uuid(),revision:z.number().int().nonnegative()}).strict().parse(raw),project=config.project.id,db=store.hermesState;
  db.exec('BEGIN IMMEDIATE');try{
    const work=store.intakeWork(project,input.work_id);requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');assertWorkConnected(store,project,work.id);
    const row=db.prepare('SELECT * FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,work.id) as Row|undefined;
    const checkpoint=row?rejectedPackBeforeExecution(store,row,config):null;requireCondition(row&&checkpoint,'WORK_RECONCILIATION_REQUIRED');
    const at=now(),revision=work.revision+1;preserveRejectedPackCall(store,row,checkpoint,at);
    const updated=db.prepare('UPDATE office_intake SET paused=1,revision=?,updated_at=? WHERE project_id=? AND work_id=? AND revision=?').run(revision,at,project,work.id,work.revision);requireCondition(updated.changes===1,'WORK_REVISION_CONFLICT');
    db.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(work.id,revision,'paused',JSON.stringify(work.spec),JSON.stringify(work.answers),at);
    db.prepare("UPDATE office_supervisor SET work_revision=?,state='paused',reason='PACK_NOT_STARTED_RECONCILED',retry_at_ms=0,resume_wait=0,updated_at=? WHERE project_id=? AND run_id=?").run(revision,at,project,row.run_id);
    db.prepare('UPDATE office_work SET updated_at=? WHERE project_id=? AND id=?').run(at,project,work.id);
    workActivity(store,project,work.id,'supervisor.pause','The proven pre-execution Pack refusal was preserved. This run remains paused until an explicit resume.',{status:'paused',reason:'PACK_NOT_STARTED_RECONCILED'});
    db.exec('COMMIT');
  }catch(error){db.exec('ROLLBACK');throw error;}
  return {reconciled:true,execution_started:false,original_invocation_replayed:false,...supervisorStatus(store,project,input.work_id,config)};
}
export function supervisorStatus(store:PackStore,project:string,workId:string,config?:HostConfig){
  if(!store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get())return null;
  const row=store.hermesState.prepare('SELECT * FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,workId) as Row|undefined;
  if(!row)return null;const cp=row.checkpoint!=='null'?JSON.parse(row.checkpoint) as WorkClientCheckpoint|SupervisedSwarmCheckpoint:null,swarm=cp&&'kind' in cp&&cp.kind==='swarm'?cp:null;
  const observations=swarm?Object.entries(swarm.workers).flatMap(([worker,cp])=>cp.observations.map(o=>({...o,worker}))):cp&&'observations' in cp?cp.observations:[];
  const observedAtMs=Date.now(),live=row.state==='running'&&!!row.owner&&row.lease_until_ms>observedAtMs,pending=cp&&'pending' in cp?cp.pending:null;
  let activeWorkers=0;if(swarm&&live){const snapshot=store.swarmRun(project,swarm.run_id).snapshot as SwarmRunSnapshot;activeWorkers=activeSwarmWorkerCount(snapshot,observedAtMs);}
  const steps:Array<{id:string;tool:string;status:string;effect_state:string;observed_at:string|null}>=observations.map(o=>({id:o.invocation.stage_id,tool:o.invocation.tool_name,status:o.receipt.status,effect_state:o.receipt.effect_state,observed_at:o.observed_at}));
  // A dispatched call without a receipt is not a completed step. Expose the
  // real interruption, preserving its unknown effect rather than inventing one.
  if(pending)steps.push({id:pending.stage_id,tool:pending.tool_name,status:live?'running':row.state==='running'?'execution_unobserved':row.state,effect_state:'unobserved',observed_at:null});
  const plan=(store.intakeWork(project,workId).spec as WorkProposal|null)?.plan;
  const reports=plan&&cp&&'stage_reports' in cp?currentStageReports(plan,cp.stage_reports??[]):[];
  return {run_id:row.run_id,work_id:row.work_id,revision:row.work_revision,state:row.state,current_run_only:row.current_run_only===1,live,attempts:row.attempts,reason:row.reason,updated_at:row.updated_at,result:row.result?JSON.parse(row.result):null,kind:swarm?'swarm':'client',active_workers:activeWorkers,steps,stage_reports:reports,pending,current_stage:pending?.stage_id??null,can_pause:activeStates.includes(row.state),can_resume:['paused','awaiting_review','waiting_auth','waiting_approval','waiting_model','waiting_connection','retry_wait','failed'].includes(row.state)||rejectedPackBeforeExecution(store,row,config)!==null,can_edit:row.state!=='reconciliation_required'};
}

/** Only a host-verified no-effect tick for this connected Work may sleep until due.
 * A model's wait text, an unscoped tick or an unknown write never sets a timer. */
function watchDueWait(store:PackStore,row:Row,result:WorkClientResult):number|null{
  try{
    if(result.status!=='retryable_failure'||result.reason!=='WORK_CLIENT_WATCH_NOT_DUE')return null;
    const cp=result.checkpoint,last=cp.observations.at(-1),invocation=last?.invocation,receipt=last?.receipt;
    if(cp.work_id!==row.work_id||cp.run_id!==row.run_id||cp.pending!==null||!invocation||!receipt||invocation.tool_name!=='runtime_pack_watch_tick'||invocation.effect!=='local_write'||invocation.dispatched!==true||receipt.status!=='retryable_failure'||receipt.effect_state!=='none'||receipt.evidence_ids.length!==0||cp.observations.some(item=>item.receipt.effect_state==='uncertain'))return null;
    const value=receipt.value&&typeof receipt.value==='object'&&!Array.isArray(receipt.value)?receipt.value as Record<string,unknown>:null;
    const runId=invocation.arguments.run_id;
    if(typeof runId!=='string'||value?.run_id!==runId||value.status!=='not_due'||value.pending!==true||!Array.isArray(value.processed)||value.processed.length!==0||!Array.isArray(value.recovered)||value.recovered.length!==0||!store.officeRuns(row.project_id,row.work_id).some(item=>item.source_kind==='pack'&&item.source_id===runId))return null;
    const run=store.packRun(row.project_id,runId),state=store.watchState(row.project_id,runId),reported=value.watch&&typeof value.watch==='object'&&!Array.isArray(value.watch)?value.watch as Record<string,unknown>:null;
    if(run.recipe.family!=='monitor.watch'||run.status!=='watching'||state.paused||reported?.run_id!==runId||reported.next_ms!==state.next_ms||reported.cycle!==state.cycle||reported.paused!==false||value.ready_at!==new Date(state.next_ms).toISOString())return null;
    return state.next_ms;
  }catch{return null;}
}

/** Durable admission and bounded retries share the same Work ID and receipts. */
export class WorkSupervisor {
  private stopped=false;private active=new Map<string,Promise<void>>();private controllers=new Map<string,AbortController>();
  private timer:NodeJS.Timeout|null=null;private activated=false;private api:RuntimeApi|null=null;
  readonly schedules:WorkSchedules;
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly model:StructuredModel,readonly options:{api?:RuntimeApi;tick_ms?:number;max_parallel?:number;auto_start?:boolean;can_start?:()=>boolean;onResult?:(workId:string)=>void;verifyCompletion?:Parameters<BoundedWorkClientExecutor['execute']>[1]['verifyCompletion']}={}){
    initWorkSupervisor(store);this.api=options.api??null;this.schedules=new WorkSchedules(store,config.project.id);
    if(options.auto_start!==false)this.activate();
  }
  activate(){requireCondition(!this.stopped,'WORK_SUPERVISOR_CLOSED');if(this.activated)return;this.activated=true;this.timer=setInterval(()=>this.tick(),this.options.tick_ms??1000);this.timer.unref();this.tick();}
  suspendForReload(){requireCondition(this.active.size===0,'WORK_EXECUTION_ACTIVE');this.activated=false;if(this.timer)clearInterval(this.timer);this.timer=null;}
  start(workId:string,revision:number,costAcknowledged:boolean,timezone?:string,currentRunOnly=true){
    requireCondition(!this.stopped,'WORK_SUPERVISOR_CLOSED');requireCondition(costAcknowledged,'WORK_MODEL_USAGE_CONSENT_REQUIRED');
    assertWorkConnected(this.store,this.config.project.id,workId);
    const host={config_fingerprint:this.config.fingerprint,engine_binding:hashJson({config:this.config.fingerprint,engine:PACK_ENGINE_VERSION})};
    const custom=assertCustomPackInvocation(this.store,this.config.project.id,workId,'runtime_work_execute',{},host);
    requireCondition(currentRunOnly||!custom,'CUSTOM_PACK_NEW_CYCLE_REQUIRED');
    assertCustomPackScheduledRun(this.store,this.config.project.id,workId,host);
    const work=this.store.intakeWork(this.config.project.id,workId);requireCondition(work.revision===revision,'WORK_REVISION_CONFLICT');requireCondition(!work.paused&&work.spec&&['ready','running'].includes(work.status),'WORK_NOT_READY');
    requireCondition(workImportExecutionOwner(this.store,this.config.project.id,workId)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
    const prior=supervisorStatus(this.store,this.config.project.id,workId,this.config);
    if(prior){if(activeStates.includes(prior.state)||prior.live){this.activate();return {accepted:false,deduplicated:true,...prior};}throw Error('WORK_USE_EXISTING_EXECUTION_CONTROL');}
    const id=randomUUID(),at=now();this.store.hermesState.exec('BEGIN IMMEDIATE');try{
      const existing=this.store.hermesState.prepare('SELECT 1 FROM office_supervisor WHERE project_id=? AND work_id=?').get(this.config.project.id,workId);requireCondition(!existing,'WORK_ALREADY_EXECUTING');
      if(timezone){requireCondition(timezone==='UTC'||timezone.includes('/'),'SCHEDULE_TIMEZONE_INVALID');new Intl.DateTimeFormat('en',{timeZone:timezone}).format();}
      this.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,timezone,current_run_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,this.config.project.id,workId,revision,'queued',this.config.fingerprint,readModelSettings(modelSettingsPath(this.config))?.revision??0,timezone??null,Number(currentRunOnly),at,at);
      workActivity(this.store,this.config.project.id,workId,'supervisor.queued','업무를 실행 대기열에 넣었습니다. 실행 연결과 저장된 진행 지점을 확인합니다.');this.store.hermesState.exec('COMMIT');
    }catch(error){this.store.hermesState.exec('ROLLBACK');throw error;}this.activate();this.tick();return {accepted:true,...supervisorStatus(this.store,this.config.project.id,workId,this.config)};
  }
  action(raw:unknown){
    const input=supervisorActionSchema.parse(raw),project=this.config.project.id,work=this.store.intakeWork(project,input.work_id),status=supervisorStatus(this.store,project,work.id,this.config);
    assertWorkConnected(this.store,project,work.id);
    requireCondition(status,'WORK_EXECUTION_NOT_FOUND');requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');
    const semantic=businessSteps((work.spec as WorkProposal|null)?.plan);
    if(input.stage_id&&semantic.length)requireCondition(semantic.some(step=>step.id===input.stage_id),'WORK_CLIENT_STAGE_UNKNOWN');
    const reconcilePackRefusal=status.state==='reconciliation_required'&&['resume','retry'].includes(input.action)&&status.can_resume;
    requireCondition(status.state!=='reconciliation_required'||reconcilePackRefusal,'WORK_RECONCILIATION_REQUIRED');
    if(['resume','retry'].includes(input.action))requireCondition(workImportExecutionOwner(this.store,project,work.id)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
    if(input.action==='edit')requireCondition(input.instruction&&safeControlText(input.instruction,4000)===input.instruction,'WORK_INSTRUCTION_INVALID');
    if(input.action==='pause')requireCondition(status.can_pause,'WORK_NOT_PAUSABLE');
    if(['resume','retry'].includes(input.action))requireCondition(status.can_resume,'WORK_NOT_RESUMABLE');
    this.store.hermesState.exec('BEGIN IMMEDIATE');try{
      const revision=work.revision+1,at=now(),paused=input.action==='pause'||input.action==='edit';
      if(reconcilePackRefusal){
        const row=this.store.hermesState.prepare('SELECT * FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(project,work.id,status.run_id) as Row|undefined;
        const checkpoint=row?rejectedPackBeforeExecution(this.store,row,this.config):null;
        requireCondition(row&&checkpoint&&(!this.api||this.api.config.fingerprint===this.config.fingerprint&&this.api.store.databasePath===this.store.databasePath),'WORK_RECONCILIATION_REQUIRED');
        preserveRejectedPackCall(this.store,row,checkpoint,at);
      }
      this.store.hermesState.prepare('UPDATE office_intake SET paused=?,revision=?,updated_at=? WHERE project_id=? AND work_id=? AND revision=?').run(Number(paused),revision,at,project,work.id,work.revision);
      const direction={run_id:status.run_id,step_id:input.stage_id??'next',instruction:input.instruction??'',created_at:at};
      this.store.hermesState.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(work.id,revision,input.action==='edit'?'direction_changed':paused?'paused':'resumed',JSON.stringify(input.action==='edit'?direction:work.spec),JSON.stringify(work.answers),at);
      this.store.hermesState.prepare('UPDATE office_supervisor SET work_revision=?,state=?,reason=NULL,retry_at_ms=0,resume_wait=?,replan_required=CASE WHEN ? THEN 1 ELSE replan_required END,model_revision=?,updated_at=? WHERE project_id=? AND run_id=?').run(revision,paused?'paused':'queued',Number(!paused),Number(input.action==='edit'),readModelSettings(modelSettingsPath(this.config))?.revision??0,at,project,status.run_id);
      this.store.hermesState.prepare('UPDATE office_work SET updated_at=? WHERE project_id=? AND id=?').run(at,project,work.id);
      const selected=semantic.find(step=>step.id===input.stage_id);
      workActivity(this.store,project,work.id,`supervisor.${input.action}`,input.action==='edit'?`지침 변경 · ${input.instruction}`:paused?'실행 중단을 요청했습니다. 완료한 단계는 보존됩니다.':'저장한 진행 지점에서 실행을 재개합니다.',{run_id:status.run_id,...(selected?{stage_id:selected.id,stage_binding:stageBinding(selected)}:{})});
      this.store.hermesState.exec('COMMIT');
    }catch(error){this.store.hermesState.exec('ROLLBACK');throw error;}
    if(input.action==='pause'||input.action==='edit')this.controllers.get(status.run_id)?.abort();this.tick();return supervisorStatus(this.store,project,work.id,this.config);
  }
  tick(){
    if(this.stopped||!this.activated||this.options.can_start?.()===false)return;const project=this.config.project.id,db=this.store.hermesState,at=Date.now();
    // Custom cycle preparation is an effect-free, durable registration outside
    // the slot savepoint. Claim, enqueue and the exact child binding are atomic.
    for(const due of this.schedules.due(at)){
      const latest=supervisorStatus(this.store,project,due.work_id,this.config);
      try{
        if(!this.api)this.api=new RuntimeApi(this.config,{swarmModel:this.model});
        const custom=this.api.customPackSchedules.binding(due.work_id);
        requireCondition(!this.schedules.customPackRequired(due.work_id)||custom,'CUSTOM_PACK_SCHEDULE_BINDING_MISSING');
        if((custom&&latest&&!['succeeded','failed'].includes(latest.state))||(!custom&&(!latest||!['succeeded','failed','awaiting_review'].includes(latest.state))))continue;
        let executionWorkId=due.work_id,executionRevision=due.work_revision;
        if(custom){
          requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
          const prepared=this.api.customPackSchedules.prepareDue(due,{config_fingerprint:this.config.fingerprint,engine_binding:hashJson({config:this.config.fingerprint,engine:PACK_ENGINE_VERSION})});
          executionWorkId=prepared.work.id;executionRevision=prepared.work.revision;
        }
        db.exec('SAVEPOINT supervisor_schedule');
        try{
          const claim=this.schedules.claim(due);
          if(claim){
            const previous=custom?db.prepare('SELECT run_id,work_revision,config_hash FROM office_supervisor WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,executionWorkId):null;
            requireCondition(!previous||Number(previous.work_revision)===executionRevision&&previous.config_hash===this.config.fingerprint,'CUSTOM_PACK_SCHEDULE_RUN_CHANGED');
            const inherited=latest?db.prepare('SELECT timezone FROM office_supervisor WHERE run_id=?').get(latest.run_id):null;
            const id=previous?String(previous.run_id):randomUUID(),stamp=now(),zone=custom?this.schedules.status(due.work_id)?.timezone??null:inherited?.timezone??null;
            if(!previous)db.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,timezone,current_run_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,project,executionWorkId,executionRevision,'queued',this.config.fingerprint,readModelSettings(modelSettingsPath(this.config))?.revision??0,zone,custom?1:0,stamp,stamp);
            this.schedules.markStarted(claim,id,custom?executionWorkId:undefined);
          }
          db.exec('RELEASE supervisor_schedule');
        }catch(error){db.exec('ROLLBACK TO supervisor_schedule; RELEASE supervisor_schedule');if(custom)throw error;}
      }catch(error){
        const reason=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,100}$/u.test(error.message)?error.message:'CUSTOM_PACK_SCHEDULE_UNAVAILABLE';
        // Repeated blocked ticks retain one useful diagnosis rather than
        // generating the same activity every second. No slot or effect exists.
        const prior=db.prepare("SELECT summary FROM office_activity WHERE project_id=? AND work_id=? AND kind='schedule.blocked' ORDER BY id DESC LIMIT 1").get(project,due.work_id);
        if(prior?.summary!==reason)workActivity(this.store,project,due.work_id,'schedule.blocked',reason);
      }
    }
    for(const row of db.prepare("SELECT * FROM office_supervisor WHERE project_id=? AND state IN ('queued','running','retry_wait') ORDER BY created_at LIMIT 50").all(project) as Row[]){
      if(this.active.size>=(this.options.max_parallel??2))break;if(this.active.has(row.run_id)||row.owner&&row.lease_until_ms>at||row.retry_at_ms>at)continue;
      if(readWorkLifecycle(this.store,project,row.work_id).state!=='connected')continue;
      const work=this.store.intakeWork(project,row.work_id);if(work.paused){db.prepare("UPDATE office_supervisor SET state='paused',owner=NULL,lease_until_ms=0 WHERE run_id=?").run(row.run_id);continue;}
      const owner=randomUUID();const claim=db.prepare("UPDATE office_supervisor SET state='running',owner=?,lease_until_ms=?,attempts=attempts+1,updated_at=? WHERE project_id=? AND run_id=? AND state IN ('queued','running','retry_wait') AND (owner IS NULL OR lease_until_ms<=?) AND (SELECT COUNT(*) FROM office_supervisor WHERE project_id=? AND state='running' AND owner IS NOT NULL AND lease_until_ms>?)<?").run(owner,at+30000,now(),project,row.run_id,at,project,at,this.options.max_parallel??2);if(!claim.changes)continue;
      const operation=this.execute({...row,owner,state:'running',attempts:row.attempts+1});this.active.set(row.run_id,operation);void operation.finally(()=>{this.active.delete(row.run_id);this.controllers.delete(row.run_id);}).catch(()=>{});
    }
  }
  private async execute(row:Row){
    const db=this.store.hermesState,project=this.config.project.id,controller=new AbortController();this.controllers.set(row.run_id,controller);
    const heartbeat=setInterval(()=>{try{db.prepare('UPDATE office_supervisor SET lease_until_ms=? WHERE project_id=? AND run_id=? AND owner=?').run(Date.now()+30000,project,row.run_id,row.owner);}catch{}},3000);heartbeat.unref();
    const guard=()=>{
      requireCondition(!this.stopped,'WORK_SUPERVISOR_STOPPED');assertWorkConnected(this.store,project,row.work_id);const current=db.prepare('SELECT state,owner,lease_until_ms FROM office_supervisor WHERE project_id=? AND run_id=?').get(project,row.run_id);const work=this.store.intakeWork(project,row.work_id);
      const host={config_fingerprint:this.config.fingerprint,engine_binding:hashJson({config:this.config.fingerprint,engine:PACK_ENGINE_VERSION})};
      assertCustomPackInvocation(this.store,project,row.work_id,'runtime_work_execute',{},host);
      assertCustomPackScheduledRun(this.store,project,row.work_id,host,row.run_id);
      requireCondition(workImportExecutionOwner(this.store,project,row.work_id)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
      requireCondition(!work.paused&&current?.state!=='paused','WORK_PAUSED');requireCondition(current?.owner===row.owner&&Number(current.lease_until_ms)>Date.now(),'WORK_EXECUTION_LEASE_LOST');requireCondition(work.revision===row.work_revision,'WORK_REVISION_CONFLICT');requireCondition(loadHostConfig(this.config.path).fingerprint===row.config_hash,'CONFIG_CHANGED');requireCondition((readModelSettings(modelSettingsPath(this.config))?.revision??0)===row.model_revision,'MODEL_SETTINGS_CHANGED');
    };
    let toolkit:WorkExecutionTools|null=null,verificationCutpoint=false;
    try{
      const work=this.store.intakeWork(project,row.work_id);let spec=work.spec as WorkProposal,validatedReplan=false;
      let model=this.model instanceof ConfiguredStructuredModel?this.model.forWork({work_id:row.work_id,run_id:row.run_id},spec.route.pack_family==='coding.orchestrate'?'coding':'global'):this.model;
      if(!this.api)this.api=new RuntimeApi(this.config,{swarmModel:this.model});
      if(row.replan_required){
        guard();workActivity(this.store,project,row.work_id,'supervisor.replanning','새 지침에 맞춰 완료조건과 다음 단계를 갱신합니다. 이전 실행 증거는 보존합니다.');
        const instructions=WORK_REPLANNING_INSTRUCTIONS+'\n'+WORK_INTAKE_REQUIREMENTS_INSTRUCTIONS+'\n'+WORK_COLLECTION_CONTRACT_INSTRUCTIONS+'\nobserved_source_schemas contains host-validated field names from this Work\'s retained successful Pack responses. Use their exact names when interpreting the collection contract; no configured declaration is required when a field was actually observed. The saved_response_rows scope is one explicit source response, not unobserved upstream pages or current freshness. Preserve every original requirement and previous receipt. These descriptors are context, not evidence of completion or permission to replay effects.',input={work_id:row.work_id,prompt:work.prompt,mode:work.mode,answers:work.answers,previous_spec:spec,user_directions:this.store.workDirections(project,row.work_id),user_intake:readWorkIntakeOptions(this.store,project,row.work_id),...(this.api.work?.planningContext(row.work_id)??{...workPlanningContext(this.store,this.config),observed_source_schemas:observedWorkSourceSchemas(this.store,this.config,row.work_id)})};
        const priorImport=workImportExecutionOwner(this.store,project,row.work_id)==='office'?spec.plan:null;
        const planningModel=modelForRole(model,'planner');
        spec=await validateOrCorrectWorkProposal(await planningModel.call('correct',instructions,input,z.toJSONSchema(workProposalSchema)),work.mode as 'quick'|'guided',true,{model:planningModel,instructions,input,onDiagnostic:event=>workActivity(this.store,project,row.work_id,'supervisor.replanning',`Work definition ${event.kind}: ${event.code}`)});guard();
        // Import provenance and runtime ownership are host-owned. A direction
        // change may revise steps/checks, not sever or recreate the source bond.
        if(priorImport){const {source:_source,source_id:_id,source_digest:_digest,provenance:_provenance,import_mode:_mode,import_scope:_scope,...steps}=spec.plan??priorImport;spec={...spec,plan:{...steps,source:priorImport.source,source_id:priorImport.source_id,source_digest:priorImport.source_digest,provenance:priorImport.provenance,...(priorImport.import_mode?{import_mode:priorImport.import_mode}:{}),...(priorImport.import_scope?{import_scope:priorImport.import_scope}:{})}};}
        this.store.transaction(()=>{
          const at=now(),changed=db.prepare('UPDATE office_intake SET spec=?,updated_at=? WHERE project_id=? AND work_id=? AND revision=?').run(JSON.stringify(spec),at,project,row.work_id,row.work_revision);
          requireCondition(changed.changes===1,'WORK_REVISION_CONFLICT');
          sealCollectionContract(this.store,this.config,row.work_id,spec);
          db.prepare('UPDATE office_work SET title=?,goal=?,updated_at=? WHERE project_id=? AND id=?').run(spec.title,spec.desired_outcome,at,project,row.work_id);
          db.prepare('UPDATE office_supervisor SET replan_required=0 WHERE project_id=? AND run_id=? AND owner=?').run(project,row.run_id,row.owner);
        });validatedReplan=true;
      }
      readSealedCollectionContract(this.store,this.config,row.work_id,spec);
      // The first interpretation uses the user's default model. Allocate only
      // after a valid task exists, before any tool or independently run worker.
      if(model instanceof ConfiguredStructuredModel)model=model.forScope(spec.route.pack_family==='coding.orchestrate'?'coding':'global');
      model=await allocateWorkModels(this.store,project,row.work_id,model,{prompt:work.prompt,spec,directions:this.store.workDirections(project,row.work_id)},guard);
      if(spec.recurrence.kind==='recurring'&&row.current_run_only!==1){
        guard();const schedule=await this.schedules.prepare(row.work_id,row.work_revision,model,{...(row.timezone?{default_timezone:row.timezone}:{})});guard();if(schedule?.state==='disabled')this.schedules.enable(row.work_id,row.work_revision,{acknowledged:true});
        if(schedule?.state==='waiting_config')throw Error('SCHEDULE_CONFIGURATION_REQUIRED');
      }
      else if(spec.recurrence.kind==='recurring')workActivity(this.store,project,row.work_id,'schedule.not_enabled','This request starts the current run only. Future recurring executions were not enabled.',{stage_id:'admission',status:'not_enabled'});
      toolkit=new WorkExecutionTools(this.store,this.config,this.api,row.work_id,row.run_id,spec,work.prompt,guard,model);
      workActivity(this.store,project,row.work_id,'supervisor.started',row.attempts>1?'저장한 체크포인트를 읽고 실행을 이어갑니다.':'연결된 AI와 실행 도구로 업무를 시작합니다.');
      let checkpoint=row.checkpoint==='null'?null:JSON.parse(row.checkpoint) as WorkClientCheckpoint|SupervisedSwarmCheckpoint;
      const directions=this.store.workDirections(project,row.work_id),userIntake=readWorkIntakeOptions(this.store,project,row.work_id);
      const originalUserRequest={prompt:work.prompt,...userIntake,user_directions:directions};
      const saveCheckpoint=(cp:WorkClientCheckpoint|SupervisedSwarmCheckpoint)=>{checkpoint=cp;const encoded=JSON.stringify(cp);requireCondition(Buffer.byteLength(encoded)<=1_000_000,'WORK_CHECKPOINT_TOO_LARGE');db.prepare('UPDATE office_supervisor SET checkpoint=?,updated_at=? WHERE project_id=? AND run_id=? AND owner=?').run(encoded,now(),project,row.run_id,row.owner);};
      guard();let admissionCheckpoint=captureWorkRunAdmissionCheckpoint(this.store,project,{work_id:row.work_id,run_id:row.run_id,owner:row.owner!});
      let completionDenial:{code:'WORK_COMPLETION_CHECK_NOT_SUPPORTED'|'WORK_COMPLETION_BATCH_CONTRADICTS'|'WORK_COMPLETION_BATCH_UNRESOLVED_MATERIAL';check_id:string;verdict:'unsupported'|'unknown'}|null=null;
      let verificationTransportUnavailable:string|null=null;
      const independentVerifier=createWorkCompletionVerifier(model,{guard,originalUserRequest,literalRefMode:true,nativeResolver:createNativeCompletionResolver(this.store,this.config,row.work_id),collectionResolver:createCollectionCompletionResolver(this.store,this.config,row.work_id),progress:event=>workActivity(this.store,project,row.work_id,'supervisor.verification',event.summary),audit:event=>{
        workActivity(this.store,project,row.work_id,'supervisor.verification.audit',JSON.stringify(event));
        if(event.status==='unavailable'&&['STRUCTURED_MODEL_TIMEOUT','STRUCTURED_MODEL_UNAVAILABLE','CLIENT_TIMEOUT','MCP_SAMPLING_UNAVAILABLE','MODEL_PROVIDER_UNAVAILABLE'].includes(event.code))verificationTransportUnavailable=event.code;
        else if(event.status==='accepted'||event.status==='rejected')verificationTransportUnavailable=null;
        const id=event.issue?.check_id;
        if(event.status==='rejected'&&id&&event.code==='WORK_COMPLETION_CHECK_NOT_SUPPORTED'){
          const verdict=event.checks.find(check=>check.id===id)?.verdict;
          if(verdict==='unsupported'||verdict==='unknown')completionDenial={code:event.code,check_id:id,verdict};
        }else if(event.status==='rejected'&&id&&(event.code==='WORK_COMPLETION_BATCH_CONTRADICTS'||event.code==='WORK_COMPLETION_BATCH_UNRESOLVED_MATERIAL'))completionDenial={code:event.code,check_id:id,verdict:event.code==='WORK_COMPLETION_BATCH_CONTRADICTS'?'unsupported':'unknown'};
      }});
      const verifyCompletion:NonNullable<Parameters<BoundedWorkClientExecutor['execute']>[1]['verifyCompletion']>=this.options.verifyCompletion??(async(checks,observations,claim)=>{
        guard();verificationCutpoint=true;completionDenial=null;verificationTransportUnavailable=null;
        const verifierCallStart=model.calls.length;
        const verifierBoundary=()=>{
          const failures=model.calls.slice(verifierCallStart).filter(call=>call.status==='failed').map(call=>call.failure_kind);
          if(failures.includes('auth_error'))return 'CLIENT_AUTH_EXPIRED';
          if(failures.includes('quota_exhausted'))return 'CLIENT_QUOTA_EXHAUSTED';
          if(failures.includes('rate_limited'))return 'CLIENT_RATE_LIMITED';
          if(failures.includes('model_unsupported'))return 'STRUCTURED_MODEL_UNSUPPORTED';
          if(failures.includes('schema_invalid'))return 'CLIENT_SCHEMA_INVALID';
          if(failures.some(kind=>kind==='invalid_output'||kind==='refusal'||kind==='json_decode'))return 'CLIENT_STRUCTURED_OUTPUT_INVALID';
          return null;
        };
        try{
          // No capability dispatch can occur after this cutpoint. Read the owned
          // durable checkpoint independently; absent history stays unknown.
          const saved=db.prepare('SELECT checkpoint FROM office_supervisor WHERE project_id=? AND run_id=? AND owner=?').get(project,row.run_id,row.owner);
          requireCondition(saved,'WORK_EXECUTION_LEASE_LOST');
          const trace=createWorkRunTraceEvidence(this.store,project,{work_id:row.work_id,run_id:row.run_id,owner:row.owner!,checkpoint:JSON.parse(String(saved.checkpoint)),observations,admission_closed:true,admission_checkpoint:admissionCheckpoint});
          const traceId=trace.receipt.evidence_ids[0]!;
          // Independent verification must see the original successful receipts,
          // including inherited sources and possible contradictory evidence. An
          // executor's narrow citation list is not the complete evidence record.
          let verified:Awaited<ReturnType<typeof independentVerifier>>;
          try{verified=await independentVerifier(checks,[...observations,trace],supervisorCompletionClaim(observations,claim,traceId,true));}
          catch(error){const boundary=verifierBoundary();if(boundary)throw Error(boundary);throw error;}
          guard();
          const boundary=verifierBoundary();if(!verified&&boundary)throw Error(boundary);
          if(!verified&&verificationTransportUnavailable)throw Error(verificationTransportUnavailable);
          if(!verified&&completionDenial)return {verified:false,repair:completionDenial};
          return verified;
        }finally{verificationCutpoint=false;}
      });
      if(spec.route.kind==='swarm'){
        const swarmHooks:SupervisedSwarmHooks={guard,checkpoint:saveCheckpoint,progress:event=>workActivity(this.store,project,row.work_id,event.source?'source.observed':event.kind,`${event.worker_id??'swarm'} · ${event.summary}`,{run_id:row.run_id,stage_id:event.stage_id,...(spec.plan.steps.find(step=>step.id===event.stage_id)?{stage_binding:stageBinding(spec.plan.steps.find(step=>step.id===event.stage_id)!)}:{}),...(event.provider?{model_provider:event.provider}:{}),...(event.model?{model_name:event.model}:{}),...(event.role?{model_role:event.role}:{}),...(event.continuity?{model_continuity:event.continuity}:{}),...(event.worker_id?{worker_id:event.worker_id}:{}),...(event.tool_name?{tool_name:event.tool_name}:{}),...(event.source?{source:event.source,status:'succeeded'}:{})})};
        const swarmRequest={work_id:row.work_id,request_id:`office-${row.run_id}`,goal:work.prompt,plan:spec.plan,revision:row.work_revision,directions,completion_checks:spec.completion_checks,...(checkpoint?{checkpoint}:{}),max_parallel:3};
        const swarm=await executeSupervisedSwarm(this.api,model,swarmRequest,swarmHooks);
        let verified=false;
        if(swarm.status==='succeeded'){
          guard();const snapshot=this.store.swarmRun(project,swarm.run_id).snapshot as SwarmRunSnapshot;
          const outputStep=businessSteps(spec.plan).find(step=>step.id===snapshot.plan.work_output_stage_id);
          if(businessSteps(spec.plan).length)requireCondition(outputStep&&['draft_only','local_write'].includes(outputStep.effect),'SWARM_OUTPUT_STAGE_UNBOUND');
          const outputStage={stage_id:outputStep?.id??'completion.verify',...(outputStep?{stage_binding:stageBinding(outputStep)}:{})};
          requireCondition(snapshot.status==='completed'&&Object.values(snapshot.workers).every(worker=>worker.status==='succeeded'&&worker.result?.readback?.verified&&worker.quality?.accepted),'SWARM_FINAL_READBACK_UNVERIFIED');
          const finalWorkers=snapshot.plan.workers.length===1?snapshot.plan.workers:snapshot.plan.workers.filter(worker=>worker.stage==='synthesis'),cards=finalWorkers.flatMap(worker=>snapshot.workers[worker.id]!.result!.fact_cards);
          const sourceCoverage=snapshot.plan.workers.filter(worker=>worker.source_urls.length>0).map(worker=>({worker_id:worker.id,source_urls:[...new Set(snapshot.workers[worker.id]!.result!.fact_cards.map(card=>card.source_url))],readback:snapshot.workers[worker.id]!.result!.readback}));
          const observedAt=now(),readId=`swarm-readback-${hashJson({run:swarm.run_id,revision:row.work_revision}).slice(0,24)}`;
          const readback={invocation:{request_id:readId,turn:0,stage_id:'completion.verify',tool_name:'office_swarm_readback',arguments:{},effect:'read_only' as const,dispatched:true},receipt:{status:'succeeded' as const,value:boundWorkToolValue({summary:swarm.summary,fact_cards:cards,source_coverage:sourceCoverage,verified_workers:Object.values(snapshot.workers).map(worker=>worker.id),required_workers:snapshot.plan.workers.length,verified_worker_stages:snapshot.plan.workers.map(worker=>({worker_id:worker.id,stage:worker.stage,source_urls:worker.source_urls,status:snapshot.workers[worker.id]!.status,readback_verified:snapshot.workers[worker.id]!.result!.readback!.verified,quality_accepted:snapshot.workers[worker.id]!.quality!.accepted})),host_concurrency_limit:snapshot.plan.max_concurrency,observed_peak_active_workers:swarm.checkpoint.peak_active_workers}),evidence_ids:[readId],effect_state:'none' as const,retry_safe:true},observed_at:observedAt};
          // A result file is Office-owned output, never another message or bot run.
          const reportText=[swarm.summary,...cards.map(card=>`${card.source_url}\n${card.claim}\n${card.evidence_excerpt}`),'Sources',...[...new Set(sourceCoverage.flatMap(source=>source.source_urls))]].join('\n\n');
          requireCondition(reportText.length<=16000,'SWARM_FINAL_OUTPUT_BUDGET_EXCEEDED');
          // Same owned report after a pause/crash uses the same exclusive-write
          // path. A new Work revision alone must not create a duplicate file.
          const draftId=`swarm-output-${hashJson({run:swarm.run_id,text:reportText}).slice(0,32)}`;
          const outputClaim={request_id:draftId,content_sha256:hashJson(reportText),work_revision:row.work_revision,...outputStage};
          const priorOutput=swarm.checkpoint.final_output_claim;
          requireCondition(!priorOutput||priorOutput.work_revision!==row.work_revision||priorOutput.content_sha256===outputClaim.content_sha256&&priorOutput.request_id===draftId,'SWARM_OUTPUT_CLAIM_CHANGED');
          swarm.checkpoint.final_output_claim=outputClaim;saveCheckpoint(swarm.checkpoint);guard();
          workActivity(this.store,project,row.work_id,'tool.started','office_result_draft · Swarm output',{run_id:row.run_id,...outputStage,tool_name:'office_result_draft',status:'running'});
          const value=await toolkit.execute('office_result_draft',{text:reportText,label:spec.title},draftId),receipt=await toolkit.receipt('office_result_draft',value,draftId);
          const output={invocation:{request_id:draftId,turn:1,...outputStage,tool_name:'office_result_draft',arguments:{},effect:'local_write' as const,dispatched:true},receipt:{...receipt,value:boundWorkToolValue(receipt.value)},observed_at:now()};
          swarm.checkpoint.final_observations=[readback,output];saveCheckpoint(swarm.checkpoint);guard();
          workActivity(this.store,project,row.work_id,'tool.result',`office_result_draft: ${receipt.status}`,{run_id:row.run_id,...outputStage,tool_name:'office_result_draft',status:receipt.status});
          if(outputStep){
            const artifactReadId=`${draftId}-read`,artifactValue=await toolkit.execute('office_result_read',{request_id:draftId},artifactReadId),artifactReceipt=await toolkit.receipt('office_result_read',artifactValue,artifactReadId);
            swarm.checkpoint.final_observations.push({invocation:{request_id:artifactReadId,turn:2,...outputStage,tool_name:'office_result_read',arguments:{request_id:draftId},effect:'read_only',dispatched:true},receipt:{...artifactReceipt,value:boundWorkToolValue(artifactReceipt.value)},observed_at:now()});saveCheckpoint(swarm.checkpoint);guard();
            await assessSupervisedStages(this.api,model,swarmRequest,swarm.checkpoint,swarmHooks);
            if(!businessSteps(spec.plan).every(step=>swarm.checkpoint.stage_reports.some(report=>report.stage_id===step.id&&report.binding===stageBinding(step)))){
              this.finish(row,'awaiting_review','SWARM_WORK_STAGES_INCOMPLETE',{summary:swarm.summary,text:swarm.summary,completion_verified:false,checks:spec.completion_checks,swarm_run_id:swarm.run_id});return;
            }
          }
          verified=(await verifyCompletion(spec.completion_checks,swarm.checkpoint.final_observations,{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:swarm.summary,wait_reason:null,completed_checks:spec.completion_checks.map(check=>({id:check.id,evidence_ids:[readId,draftId]}))}))===true;guard();
        }
        this.finish(row,swarm.status==='succeeded'&&!verified?'awaiting_review':swarm.status,swarm.status==='succeeded'&&!verified?'WORK_CLIENT_COMPLETION_REQUIRES_VERIFICATION':swarm.reason,{summary:swarm.summary,text:swarm.summary,completion_verified:verified,checks:spec.completion_checks,swarm_run_id:swarm.run_id});return;
      }
      requireCondition(!checkpoint||!('kind' in checkpoint),'WORK_EXECUTOR_CHANGE_REQUIRES_REVIEW');
      if(checkpoint&&(row.replan_required||row.resume_wait)){
        requireCondition(!checkpoint.pending?.dispatched||checkpoint.pending.effect==='read_only','WORK_RECONCILIATION_REQUIRED');
        const pending=checkpoint.pending;
        if(pending?.dispatched){
          // A historical dispatched read without a received result is not erased
          // by explicit resume. Preserve the interruption as a failed observation,
          // never successful evidence or an instruction to replay the old read.
          const error=row.reason??'WORK_CLIENT_READ_INTERRUPTED';
          checkpoint={...checkpoint,turn:Math.max(checkpoint.turn,pending.turn+1),observations:[...checkpoint.observations,{invocation:pending,receipt:{status:'retryable_failure' as const,effect_state:'none' as const,evidence_ids:[],retry_safe:false,value:{status:'read_interrupted',error,prior_dispatched:true,result_observation:'unobserved',retry_not_attempted:true,...(pending.tool_name==='runtime_pack_local_record_inspect'?{new_validated_read_allowed:true,new_request_id_required:true}:{})}},observed_at:now()}].slice(-32)};
          workActivity(this.store,project,row.work_id,'tool.result',`${pending.tool_name}: interrupted read preserved without replay.`,{stage_id:pending.stage_id,tool_name:pending.tool_name,status:'retryable_failure',reason:error});
        }
        const nextBinding=hashJson({work_id:row.work_id,run_id:row.run_id,prompt:work.prompt,checks:spec.completion_checks,tools:toolkit.catalog()});
        const staleRepair=validatedReplan||checkpoint.binding!==nextBinding?checkpoint.completion_repair:undefined;
        if(staleRepair)workActivity(this.store,project,row.work_id,'supervisor.completion_repair_superseded',`Host-validated replan or task-binding change superseded correction episode ${staleRepair.code}/${staleRepair.check_id} (attempt ${staleRepair.attempts}); old binding ${hashJson(checkpoint.binding)}, new binding ${hashJson(nextBinding)}. Original denial and receipts remain in history.`,{run_id:row.run_id,stage_id:'completion.verify',status:'superseded',reason:staleRepair.code});
        checkpoint={...checkpoint,pending:null,binding:nextBinding};
        if(staleRepair)delete checkpoint.completion_repair;
        saveCheckpoint(checkpoint);
      }
      if(checkpoint&&row.resume_wait){
        // Older builds classified every Pack quality review as human approval.
        // Re-read only its original receipt and durable owned Pack result. No
        // invocation is replayed and real approval/uncertain effects stay put.
        for(const observation of checkpoint.observations){
          if(observation.invocation.tool_name!=='runtime_pack_run'||observation.receipt.status!=='waiting_approval'||observation.receipt.effect_state==='uncertain')continue;
          guard();const current=await toolkit.receipt(observation.invocation.tool_name,observation.receipt.value,observation.invocation.request_id);
          const correction=current.value&&typeof current.value==='object'&&'correction' in current.value?current.value.correction:null;
          if(current.status==='retryable_failure'&&current.effect_state!=='uncertain'&&correction&&typeof correction==='object'&&'kind' in correction&&correction.kind==='data_quality'){
            observation.receipt={...current,value:boundWorkToolValue(current.value)};saveCheckpoint(checkpoint);
            workActivity(this.store,project,row.work_id,'supervisor.receipt_rechecked','A preserved read-only Pack quality failure was rechecked against its original result. The connected AI can correct the recipe; no approval or operation was replayed.');
          }
        }
      }
      // The executor binds immutable initial task/checks. New direction is live context.
      guard();admissionCheckpoint=captureWorkRunAdmissionCheckpoint(this.store,project,{work_id:row.work_id,run_id:row.run_id,owner:row.owner!});
      const result=await new BoundedWorkClientExecutor(model).execute({work_id:row.work_id,run_id:row.run_id,prompt:work.prompt,plan:spec.plan,completion_checks:spec.completion_checks,context:{spec,user_intake:userIntake,user_directions:directions,connected_source_catalog:connectedSourceCatalog(this.config),execution_policy:'Follow the latest user direction. Keep existing verified receipts. The user_intake completion_condition is the original user requirement; do not narrow it to generated checks. Use this Work ID for all tools. A registered source fitting the requested dataset is a candidate for Pack reads, not evidence or permission to bypass a challenge. Use its exact declared field names. Missing connections need a concrete wait reason. If spec.collection_contract exists, use its exact recipe through runtime_pack_run without a new runtime_pack_plan. The host verifies every matching observed source row and actual output in code; do not read source pages just to obtain another model approval of covered checks. Reuse an unchanged same-Work receipt via runtime_pack_status for completion-only recovery; never rewrite a successful artifact just for verification. Remaining semantic checks still need their own evidence.'},...(checkpoint?{checkpoint:checkpoint as WorkClientCheckpoint}:{}),resume_wait:row.resume_wait===1,max_turns:16,model_scope:spec.route.pack_family==='coding.orchestrate'?'coding':'global'},
        {tools:toolkit.catalog(),guard,signal:controller.signal,
          toolRequestId:(name,args,fallback)=>toolkit!.requestId(name,args,fallback),
          packRequestRecovery:(invocation,prior)=>toolkit!.packRequestRecovery(invocation,prior),
          checkpoint:saveCheckpoint,
          progress:event=>workActivity(this.store,project,row.work_id,event.kind,event.summary,{run_id:row.run_id,stage_id:event.stage_id,...(spec.plan.steps.find(step=>step.id===event.stage_id)?{stage_binding:stageBinding(spec.plan.steps.find(step=>step.id===event.stage_id)!)}:{}),...(event.provider?{model_provider:event.provider}:{}),...(event.model?{model_name:event.model}:{}),...(event.role?{model_role:event.role}:{}),...(event.continuity?{model_continuity:event.continuity}:{}),...(event.tool_name?{tool_name:event.tool_name}:{}),...(event.reason?{reason:event.reason}:{}),...(event.validation?{validation:event.validation}:{}),...(event.kind==='tool.started'?{status:'running'}:event.kind==='tool.result'?{status:event.status??'unknown'}:{})}),
          validateTool:async(name,args,context)=>{await toolkit!.validate(name,args,context.request_id);},
          executeTool:async(name,args,context)=>{
            requireCondition(!verificationCutpoint,'WORK_VERIFICATION_ADMISSION_CLOSED');const step=spec.plan.steps.find(value=>value.id===context.stage_id);return withWorkActivityContext({project_id:project,work_id:row.work_id,run_id:row.run_id,stage_id:context.stage_id,operation_id:context.request_id,...(step?{stage_binding:stageBinding(step)}:{})},async()=>{const value=await toolkit!.execute(name,args,context.request_id);return toolkit!.receipt(name,value,context.request_id);});
          },verifyCompletion});
      const watchReadyAt=watchDueWait(this.store,row,result);
      const verificationRetry=result.reason==='WORK_CLIENT_VERIFICATION_TRANSIENT'&&result.checkpoint.verification_pending!==undefined&&result.checkpoint.verification_pending.transient_failures<3;
      let state:string=watchReadyAt!==null||verificationRetry?'retry_wait':result.status==='retryable_failure'&&row.attempts<3?'retry_wait':result.status;
      if(watchReadyAt===null&&!verificationRetry&&result.status==='retryable_failure'&&row.attempts>=3)state='failed';
      if(this.stopped&&result.status==='paused')state='queued';
      this.finish(row,state,result.reason,{summary:result.summary,text:result.summary,completion_verified:result.completion_verified,checks:spec.completion_checks,model_calls:result.model_calls.length,observations:result.checkpoint.observations.length},watchReadyAt);
    }catch(error){const reason=error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'WORK_EXECUTION_FAILED';const state=this.stopped?'queued':['WORK_RECONCILIATION_REQUIRED'].includes(reason)?'reconciliation_required':['WORK_PAUSED','WORK_REVISION_CONFLICT'].includes(reason)?'paused':['CONFIG_CHANGED','MODEL_SETTINGS_CHANGED','SCHEDULE_CONFIGURATION_REQUIRED','SWARM_DIRECTION_REQUIRES_REVIEW','WORK_EXECUTOR_CHANGE_REQUIRES_REVIEW','ORIGINAL_RUNTIME_CONNECTION_REQUIRED'].includes(reason)?'waiting_connection':reason==='STRUCTURED_MODEL_UNSUPPORTED'?'waiting_model':'failed';this.finish(row,state,reason,null);workActivity(this.store,project,row.work_id,'supervisor.stopped',reason,{stage_id:'execution',status:state,reason});
    }finally{clearInterval(heartbeat);await toolkit?.close();}
  }
  private finish(row:Row,state:string,reason:string|null,result:unknown,watchReadyAt:number|null=null){
    const db=this.store.hermesState,current=db.prepare('SELECT state,work_revision FROM office_supervisor WHERE run_id=? AND owner=?').get(row.run_id,row.owner);if(!current)return;
    if(current.work_revision!==row.work_revision&&state!=='reconciliation_required'){db.prepare('UPDATE office_supervisor SET owner=NULL,lease_until_ms=0 WHERE run_id=? AND owner=?').run(row.run_id,row.owner);return;}
    if(current.state==='paused'&&state!=='reconciliation_required')state='paused';
    db.prepare('UPDATE office_supervisor SET state=?,reason=?,result=COALESCE(?,result),owner=NULL,lease_until_ms=0,resume_wait=0,retry_at_ms=?,attempts=attempts-?,updated_at=? WHERE project_id=? AND run_id=? AND owner=?').run(state,reason,result?JSON.stringify(result):null,watchReadyAt!==null?Math.max(Date.now()+250,watchReadyAt):state==='retry_wait'?Date.now()+Math.min(30000,row.attempts*2000):0,Number(watchReadyAt!==null),now(),row.project_id,row.run_id,row.owner);
    workActivity(this.store,row.project_id,row.work_id,'supervisor.result',`${state} · ${result&&typeof result==='object'&&'summary' in result?String(result.summary):reason??'진행 지점을 저장했습니다.'}`,{stage_id:'execution',status:state,...(reason?{reason}:{})});this.options.onResult?.(row.work_id);
  }
  async close(){this.stopped=true;if(this.timer)clearInterval(this.timer);for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.active.values()]);if(this.api&&!this.options.api){this.api.close();await this.api.drain();}}
}
