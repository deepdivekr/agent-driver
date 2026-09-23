import {randomUUID} from 'node:crypto';
import {Runtime} from '../core/runtime.js';
import {type Capability,type Lease,type ProjectBinding,type RuntimeAdapter,requireCondition} from '../core/contracts.js';
import {browserResource,guard} from '../policy/dispatch-guard.js';
import {type PersonalAgentComputer} from '../isolation/personal-agent-computer.js';
import {type RuntimeStore} from '../store/runtime-store.js';
import {snapshotHash,type TaskPackManifest} from './contracts.js';
import {resolveTargetedLlmExtraction,type JevAcceptancePolicy,type OneLineJevDecider,type OneLineJevDecision,type OneLineJevInput,type SourceAnchoredFieldValue,type TargetedLlmExtractor} from './typesafe-jev.js';

export type BrowserGate='ready'|'waiting_auth'|'waiting_orchestrator';
export interface BrowserPreparation {gate:BrowserGate;snapshot:unknown;capture_ref:string;detail:Record<string,unknown>;}
export interface ApprovedBrowserAdapter<T> extends RuntimeAdapter {
  readonly adapterId:string;
  bind(binding:{taskId:string;lease:Lease;targetRef:string}):void;
  prepare(input:T):Promise<BrowserPreparation>;
  close():Promise<void>;
}
export interface PreparedApproval {
  task_id:string; proposal_hash:string; expires_at_ms:number; approval_token:string; capture_ref:string;
  timing:readonly {stage:string;executor:string;elapsed_ms:number}[];
}
/** Binds a reviewed candidate compiler to a specific Task Pack normalizer. */
export interface OneLineTaskPackIntake<T> {
  compile(prompt:string):OneLineJevInput;
  materialize(routeId:string,fields:Readonly<Record<string,string>>,extracted?:Readonly<Record<string,SourceAnchoredFieldValue>>):T;
}
export type OneLinePreparation =
  | {status:'prepared';prepared:PreparedApproval|{task_id:string;status:'waiting_auth'|'waiting_orchestrator';timing:readonly {stage:string;executor:string;elapsed_ms:number}[]}}
  | {status:'intake_needs_extraction'|'intake_needs_clarification'|'intake_unsupported'|'intake_jev_unavailable';decision:Exclude<OneLineJevDecision,{status:'PROPOSED'}>};
export type OneLineExtractionPreparation=OneLinePreparation
  | {status:'intake_llm_unavailable'|'intake_llm_rejected';decision:Extract<OneLineJevDecision,{status:'NEEDS_EXTRACTION'}>};

/**
 * The write path is intentionally two calls: preparation produces a durable,
 * captured proposal; a separate trusted channel may approve it.  No model or
 * normal API caller receives an approval-granting method.
 */
export class ApprovedBrowserProtocol<T> {
  constructor(readonly store:RuntimeStore,readonly manifest:TaskPackManifest,readonly capability:Capability,readonly adapter:ApprovedBrowserAdapter<T>,readonly agentComputer?:PersonalAgentComputer) {
    requireCondition(manifest.adapter_id===adapter.adapterId,'TASKPACK_ADAPTER_MISMATCH');
    requireCondition(manifest.effect===capability.effect,'TASKPACK_EFFECT_MISMATCH');
    if(agentComputer!==undefined)requireCondition(agentComputer.available_surfaces.includes('browser'),'AGENT_COMPUTER_SURFACE_UNAVAILABLE');
  }
  /** A VM-backed browser pack serializes the whole persistent agent computer. */
  private resourceFor(project:ProjectBinding){return this.agentComputer?.lease_resource??browserResource(project);}
  /**
   * A Jev decision can only select from code-built candidates.  It has no
   * approval or execution authority: only a materialized, pack-normalized
   * input reaches the existing durable prepare/capture boundary.
   */
  async prepareFromOneLine(projectId:string,callerRef:string,prompt:string,intake:OneLineTaskPackIntake<T>,jev:OneLineJevDecider,policy?:JevAcceptancePolicy,approvalTtlMs=10*60_000):Promise<OneLinePreparation>{
    const decision=await jev.decide(intake.compile(prompt),policy);
    if(decision.status==='PROPOSED'){
      const prepared=await this.prepare(projectId,callerRef,intake.materialize(decision.route_id,decision.fields),approvalTtlMs);
      this.store.recordTaskStage(prepared.task_id,'intake_jev_decision','typesafe',decision.trace.elapsed_ms,{provider:decision.trace.provider,model:decision.trace.model,input_sha256:decision.trace.input_sha256,provider_status:decision.trace.status,route_id:decision.route_id,field_candidate_ids:Object.keys(decision.fields).sort()});
      return {status:'prepared',prepared};
    }
    if(decision.status==='NEEDS_EXTRACTION')return {status:'intake_needs_extraction',decision};
    if(decision.status==='NEEDS_CLARIFICATION')return {status:'intake_needs_clarification',decision};
    if(decision.status==='UNSUPPORTED')return {status:'intake_unsupported',decision};
    return {status:'intake_jev_unavailable',decision};
  }
  /** A targeted LLM may supply only source-anchored values that Jev reported as unrepresented. */
  async prepareFromOneLineWithExtraction(projectId:string,callerRef:string,prompt:string,intake:OneLineTaskPackIntake<T>,jev:OneLineJevDecider,extractor:TargetedLlmExtractor,policy?:JevAcceptancePolicy,approvalTtlMs=10*60_000):Promise<OneLineExtractionPreparation>{
    const packet=intake.compile(prompt),decision=await jev.decide(packet,policy);
    if(decision.status!=='NEEDS_EXTRACTION'){
      if(decision.status==='PROPOSED'){
        const prepared=await this.prepare(projectId,callerRef,intake.materialize(decision.route_id,decision.fields),approvalTtlMs);
        this.store.recordTaskStage(prepared.task_id,'intake_jev_decision','typesafe',decision.trace.elapsed_ms,{provider:decision.trace.provider,model:decision.trace.model,input_sha256:decision.trace.input_sha256,provider_status:decision.trace.status,route_id:decision.route_id,field_candidate_ids:Object.keys(decision.fields).sort()});
        return {status:'prepared',prepared};
      }
      if(decision.status==='NEEDS_CLARIFICATION')return {status:'intake_needs_clarification',decision};
      if(decision.status==='UNSUPPORTED')return {status:'intake_unsupported',decision};
      return {status:'intake_jev_unavailable',decision};
    }
    const correction=await resolveTargetedLlmExtraction(packet,decision,extractor);
    if(correction.status!=='EXTRACTED'){
      if(correction.status==='LLM_UNAVAILABLE')return {status:'intake_llm_unavailable',decision};
      return {status:'intake_llm_rejected',decision};
    }
    const prepared=await this.prepare(projectId,callerRef,intake.materialize(correction.route_id,{},correction.values),approvalTtlMs);
    this.store.recordTaskStage(prepared.task_id,'intake_jev_decision','typesafe',decision.trace.elapsed_ms,{provider:decision.trace.provider,model:decision.trace.model,input_sha256:decision.trace.input_sha256,provider_status:decision.trace.status,route_id:decision.route_id,field_candidate_ids:decision.field_ids.slice().sort(),decision_status:'NEEDS_EXTRACTION'});
    this.store.recordTaskStage(prepared.task_id,'intake_llm_extraction','llm',correction.trace.elapsed_ms,{provider:correction.trace.provider,model:correction.trace.model,input_sha256:correction.trace.input_sha256,provider_status:correction.trace.status,route_id:correction.route_id,field_ids:Object.keys(correction.values).sort()});
    return {status:'prepared',prepared};
  }
  async prepare(projectId:string,callerRef:string,input:T,approvalTtlMs=10*60_000,onTaskCreated?:(taskId:string)=>void):Promise<PreparedApproval|{task_id:string;status:'waiting_auth'|'waiting_orchestrator';timing:readonly {stage:string;executor:string;elapsed_ms:number}[]}> {
    requireCondition(Number.isSafeInteger(approvalTtlMs)&&approvalTtlMs>=60_000&&approvalTtlMs<=60*60_000,'INVALID_APPROVAL_TTL');
    const created=this.store.createTaskProposal(projectId,this.capability.id,{packId:this.manifest.id,packVersion:this.manifest.version,adapterId:this.adapter.adapterId,callerRef,normalized:input});
    // Persist the owning workflow link before the first browser operation.
    onTaskCreated?.(created.task.id);
    const task=created.task,targetRef=`owned-page:${randomUUID()}`,lease=this.store.acquire(task.id,this.resourceFor(this.store.project(projectId)),targetRef);
    const timing:{stage:string;executor:string;elapsed_ms:number}[]=[];
    try {
      this.adapter.bind({taskId:task.id,lease,targetRef});
      const preparedStarted=performance.now(),prepared=await this.adapter.prepare(input),elapsed=performance.now()-preparedStarted;
      timing.push({stage:'browser_prepare_capture',executor:this.adapter.adapterId,elapsed_ms:elapsed});this.store.recordTaskStage(task.id,'browser_prepare_capture',this.adapter.adapterId,elapsed,prepared.detail);
      if(prepared.gate!=='ready'){
        this.store.holdTaskProposal(task.id,prepared.gate,prepared.gate==='waiting_auth'?'logged_in_state_unobserved':'unknown_or_security_modal');
        return {task_id:task.id,status:prepared.gate,timing};
      }
      const observeStarted=performance.now(),observation=await this.adapter.observe();
      guard(this.store,{taskId:task.id,callerRef,lease,capability:this.capability,observation,maxObservationAgeMs:3_000},performance.now(),false,this.resourceFor(this.store.project(projectId)));
      const observed=performance.now()-observeStarted;timing.push({stage:'owned_browser_observation',executor:this.adapter.adapterId,elapsed_ms:observed});this.store.recordTaskStage(task.id,'owned_browser_observation',this.adapter.adapterId,observed,{origin:observation.origin,account_ref:observation.accountRef});
      const request=this.store.requestProposalApproval(task.id,prepared.snapshot,Date.now()+approvalTtlMs);
      return {...request,capture_ref:prepared.capture_ref,timing};
    } catch(error) {
      const current=this.store.task(task.id);
      if(['queued','running'].includes(current.status))this.store.pauseBeforeDispatch(task.id,error instanceof Error&&/^[A-Z_]+$/.test(error.message)?error.message:'PREPARE_FAILED');
      throw error;
    } finally {
      try {await this.adapter.close();} finally {const current=this.store.task(task.id);if(['waiting_approval','waiting_auth','waiting_orchestrator','paused_dependency'].includes(current.status))this.store.release(lease);}
    }
  }
  async executeApproved(taskId:string):Promise<unknown> {
    const proposal=this.store.proposal(taskId),task=this.store.task(taskId),project=this.store.project(task.project_id);
    requireCondition(proposal.pack_id===this.manifest.id&&proposal.pack_version===this.manifest.version&&proposal.adapter_id===this.adapter.adapterId,'TASKPACK_BINDING_MISMATCH');
    requireCondition(proposal.state==='approved'&&proposal.snapshot_hash!==null,'APPROVAL_NOT_CONSUMABLE');
    const targetRef=`owned-page:${randomUUID()}`,lease=this.store.acquire(taskId,this.resourceFor(project),targetRef);
    let consumed=false;
    try {
      this.adapter.bind({taskId,lease,targetRef});
      const current=await this.adapter.prepare(proposal.normalized as T);
      requireCondition(current.gate==='ready','WRITE_GATE_NOT_READY');
      requireCondition(snapshotHash(current.snapshot)===proposal.snapshot_hash,'APPROVAL_SNAPSHOT_MISMATCH');
      this.store.consumeProposalApproval(taskId,proposal.snapshot_hash);consumed=true;
      const result=await new Runtime(this.store,[this.capability]).execute(taskId,project.callerRef,lease,this.capability.route,proposal.normalized,this.adapter,{releaseLeaseOnComplete:false});
      this.store.recordTaskStage(taskId,'external_write_readback',this.adapter.adapterId,0,{status:(result as {status?:unknown}).status,approval_consumed:true});
      return result;
    } catch(error) {
      const current=this.store.task(taskId);
      if(!consumed&&['queued','running','ready_to_resume'].includes(current.status))this.store.invalidateProposal(taskId,'pre_dispatch_snapshot_or_browser_changed');
      throw error;
    } finally {
      try {await this.adapter.close();} finally {const current=this.store.task(taskId);if(['succeeded','cancelled','paused_dependency'].includes(current.status))this.store.release(lease);}
    }
  }
}
