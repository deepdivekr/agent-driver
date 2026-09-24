import {type HostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {decisionHash,type DecisionBatchResult,type DecisionMemoryBinding,type DecisionFeatures,type DecisionMemoryExample,type DecisionPlane} from '../decision-plane/index.js';
import {type SwarmRunSnapshot} from './contracts.js';

export type SwarmLearningMode='off'|'collect'|'reuse';
/** Only control-plane facts, never inferred article truth or user credential state. */
export function verifiedWorkflowAnswer(facts:DecisionFeatures):'COMPLETE'|'CONTINUE'|null{
  if(facts.review_count!==0||facts.failed_workers!==0||facts.partial_evidence!==false)return null;
  if(!Number.isSafeInteger(facts.ready_readonly_workers)||Number(facts.ready_readonly_workers)<0||!Number.isSafeInteger(facts.active_workers)||Number(facts.active_workers)<0)return null;
  if(facts.all_workers_verified===true&&facts.ready_readonly_workers===0&&facts.active_workers===0)return 'COMPLETE';
  if(facts.all_workers_verified===false&&typeof facts.ready_readonly_workers==='number'&&typeof facts.active_workers==='number'&&facts.ready_readonly_workers+facts.active_workers>0)return 'CONTINUE';
  return null;
}

export class SwarmDecisionLearning {
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly mode:SwarmLearningMode='reuse'){}
  binding(snapshot:SwarmRunSnapshot,plane:DecisionPlane,questions:unknown):DecisionMemoryBinding{
    // The recipe/goal and connection are private hashes. Runs and timestamps are
    // intentionally excluded so a new execution of the same pack can learn.
    return {project_id:this.config.project.id,pack_sha256:decisionHash({host:this.config.fingerprint,goal:snapshot.plan.goal,workers:snapshot.plan.workers,engine:'swarm-memory-v1'}),catalog_sha256:plane.catalogSha,question_sha256:decisionHash(questions),profile_sha256:plane.profileSha,provider:plane.options.primary.id,requested_model:plane.profile.model,contract_version:'verified-memory-v1'};
  }
  eligible(snapshot:SwarmRunSnapshot){return this.mode!=='off'&&snapshot.plan.workers.every(worker=>worker.effect==='read_only');}
  references(snapshot:SwarmRunSnapshot,binding:DecisionMemoryBinding,facts:DecisionFeatures):DecisionMemoryExample[]{
    if(this.mode!=='reuse'||!this.eligible(snapshot))return [];
    return this.store.decisionMemory.examples(binding,snapshot.run_id,facts);
  }
  qualityCandidate(snapshot:SwarmRunSnapshot,workerId:string,binding:DecisionMemoryBinding,evaluation:DecisionBatchResult|null,answer:{relevance:number;evidence:number;usability:number},facts:DecisionFeatures){
    if(!this.eligible(snapshot)||!evaluation||evaluation.event.primary.model==='unobserved')return;
    const id=this.store.decisionMemory.propose(binding,{run_id:snapshot.run_id,event_id:evaluation.event.event_id,model:evaluation.event.primary.model,features:facts,answer});
    this.event(snapshot,workerId,'candidate_saved',{memory_id:id,decision:'artifact.quality',independent_verification:'not_available',applied:false});
  }
  async confirmWorkflow(snapshot:SwarmRunSnapshot,workerId:string,binding:DecisionMemoryBinding,plane:DecisionPlane,evaluation:DecisionBatchResult|null,teacher:'COMPLETE'|'CONTINUE'|'REOBSERVE'|'LLM_REPLAN'|'HUMAN_REVIEW'|'HOLD'|null,facts:DecisionFeatures){
    if(!this.eligible(snapshot)||!evaluation||evaluation.event.primary.model==='unobserved')return;
    const expected=verifiedWorkflowAnswer(facts);if(!expected)return;
    const saved=this.store.swarmRun(this.config.project.id,snapshot.run_id).snapshot as SwarmRunSnapshot;
    // Proof is a committed runtime transition, not the worker's own verified flag.
    if(saved.revision!==snapshot.revision||expected==='COMPLETE'&&saved.status!=='completed'||expected==='CONTINUE'&&saved.status!=='running')return;
    const judgment=evaluation.judgments.find(item=>item.question_id==='next_step');
    if(judgment)await plane.label(evaluation.event.event_id,{question_id:'next_step',decision_id:'workflow.next_step',correct:judgment.value===expected,expected,source:'readback',evidence_level:this.config.environment==='fixture'?'fixture':'user_environment',split:'unassigned'});
    if(teacher===null)return;
    this.store.transaction(()=>{
      const id=this.store.decisionMemory.propose(binding,{run_id:snapshot.run_id,event_id:evaluation.event.event_id,model:evaluation.event.primary.model,features:facts,answer:{next_step:teacher}});
      const proof=this.store.decisionMemory.verify(binding,id,{features:facts,expected:{next_step:expected},receipt_sha256:decisionHash({run:saved.run_id,revision:saved.revision,status:saved.status,features:facts})});
      this.event(snapshot,workerId,'outcome_checked',{memory_id:id,decision:'workflow.next_step',status:proof.status,applied:false});
    });
  }
  audit(snapshot:SwarmRunSnapshot,workerId:string,binding:DecisionMemoryBinding,examples:DecisionMemoryExample[],evaluation:DecisionBatchResult,facts:DecisionFeatures){
    if(!examples.length)return true;
    const judgment=evaluation.judgments.find(item=>item.question_id==='next_step');
    if(evaluation.event.primary.status!=='accepted'||evaluation.event.primary.model==='unobserved'||!judgment||['invalid','unavailable'].includes(judgment.status)){
      this.event(snapshot,workerId,'references_audited',{examples:examples.length,applied:false,audit:'provider_unavailable_or_invalid'});return false;
    }
    const sameModel=examples.every(item=>item.model===evaluation.event.primary.model),expected=verifiedWorkflowAnswer(facts),actual=evaluation.judgments.find(item=>item.question_id==='next_step')?.value;
    const okay=sameModel&&(expected===null||actual===expected);
    if(!okay)this.store.decisionMemory.revoke(binding,examples.map(item=>item.id),sameModel?'audit_mismatch':'model_changed');
    this.event(snapshot,workerId,'references_audited',{examples:examples.length,applied:okay,audit:okay?'matched':sameModel?'mismatch':'model_changed'});return okay;
  }
  event(snapshot:SwarmRunSnapshot,workerId:string,kind:string,body:Record<string,unknown>){this.store.recordSwarmActivity(this.config.project.id,snapshot.run_id,snapshot.revision,workerId,'worker.learning',{kind,...body});}
}
