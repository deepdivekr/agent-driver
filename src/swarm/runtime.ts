import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {DecisionPlane,DecisionProfileRegistry,FileDecisionJournal,type DecisionProvider} from '../decision-plane/index.js';
import {type HostConfig,loadHostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {ARTIFACT_QUALITY_WEIGHTS,SWARM_DECISION_CATALOG,artifactQualityRequest,dispatchRequest,swarmDecisionProfile,workflowRequest} from './decision.js';
import {swarmPlanSchema,swarmWorkerReportSchema,type SwarmReviewItem,type SwarmRunSnapshot} from './contracts.js';
import {type SwarmLlmDecisionFallback,type SwarmPlanner} from './planner.js';

export interface SwarmRuntimeProviders {planner?:SwarmPlanner;llm_fallback?:SwarmLlmDecisionFallback;decision?:DecisionProvider;}
type StoredRun={snapshot:SwarmRunSnapshot;binding:string};
const credential=/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u;
const safe=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'SWARM_DECISION_UNAVAILABLE';

export class SwarmRuntime{
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly providers:SwarmRuntimeProviders={}){}
  private policy(){requireCondition(this.config.swarm?.enabled,'SWARM_NOT_ENABLED');return this.config.swarm!;}
  private fresh(){this.policy();requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');}
  private async plane(){
    if(!this.providers.decision)return null;
    const root=join(dirname(this.config.dbPath),'decisions'),registry=new DecisionProfileRegistry(join(root,'registry')),fallback=swarmDecisionProfile(),scope=this.config.environment==='fixture'?'fixture' as const:'production' as const;
    const profile=(await registry.resolve(SWARM_DECISION_CATALOG,scope,fallback)).profile;
    return new DecisionPlane({catalog:SWARM_DECISION_CATALOG,profile,primary:this.providers.decision,journal:new FileDecisionJournal(join(root,'swarm.jsonl')),timeout_ms:1_500});
  }
  async plan(goal:string,context:Record<string,string|number|boolean|null>){
    const policy=this.policy();requireCondition(policy.model_data_approved,'MODEL_DATA_APPROVAL_REQUIRED');requireCondition(!credential.test(JSON.stringify({goal,context})),'CREDENTIAL_LIKE_INPUT');requireCondition(this.providers.planner,'SWARM_LLM_PLANNER_REQUIRED');
    const plan=await this.providers.planner.plan(goal,context,{max_workers:policy.max_logical_workers,max_concurrency:policy.max_concurrency,capabilities:this.config.project.capabilities});
    this.fresh();this.store.saveSwarmPlan(this.config.project.id,plan,this.config.fingerprint);return {status:'planned',plan,mandatory_sub_agent_tasks:plan.workers.length,execution_started:false,next_action:'runtime_swarm_run'};
  }
  async replan(runId:string,reason:string){
    const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot;
    requireCondition(snapshot.status==='needs_human'||snapshot.status==='running','SWARM_REPLAN_NOT_ALLOWED');
    return this.plan(snapshot.plan.goal,{replan_reason:reason,prior_plan_id:snapshot.plan.plan_id,prior_run_status:snapshot.status,worker_statuses:JSON.stringify(Object.values(snapshot.workers).map(worker=>({id:worker.id,status:worker.status,quality:worker.quality?.score??null})))});
  }
  run(requestId:string,planId:string){
    this.fresh();const storedPlan=this.store.swarmPlan(this.config.project.id,planId) as {plan:unknown;binding:string},plan=swarmPlanSchema.parse(storedPlan.plan);requireCondition(storedPlan.binding===snapshotHash({plan,fingerprint:this.config.fingerprint}),'CONFIG_CHANGED');
    const now=new Date().toISOString(),snapshot:SwarmRunSnapshot={format:1,run_id:randomUUID(),request_id:requestId,plan,revision:0,status:'running',workers:Object.fromEntries(plan.workers.map(worker=>[worker.id,{id:worker.id,status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}])),reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};
    const stored=this.store.beginSwarmRun(this.config.project.id,requestId,planId,snapshot,this.config.fingerprint) as StoredRun;
    return {...this.public(stored.snapshot),deduplicated:stored.snapshot.run_id!==snapshot.run_id,next_action:'runtime_swarm_tick'};
  }
  status(runId:string){return this.public((this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot);}
  private public(snapshot:SwarmRunSnapshot){
    const workers=Object.values(snapshot.workers).map(worker=>({...worker,lease_token:worker.lease_token?'redacted':null}));
    return {run_id:snapshot.run_id,status:snapshot.status,revision:snapshot.revision,plan_id:snapshot.plan.plan_id,goal:snapshot.plan.goal,max_concurrency:snapshot.plan.max_concurrency,workers,reviews:snapshot.reviews,decision_events:snapshot.decision_events,execution_authority:false,approval_granted:false,
      next_action:snapshot.status==='running'?'runtime_swarm_tick':snapshot.status==='needs_human'?'human_review_or_llm_replan':snapshot.status==='completed'?'inspect_verified_results':'inspect_failure'};
  }
  private persist(snapshot:SwarmRunSnapshot,expected:number){snapshot.revision=expected+1;snapshot.updated_at=new Date().toISOString();this.store.updateSwarmRun(this.config.project.id,snapshot.run_id,expected,snapshot);}
  private review(snapshot:SwarmRunSnapshot,kind:SwarmReviewItem['kind'],workerId:string|null,reason:string){
    if(!snapshot.reviews.some(item=>item.kind===kind&&item.worker_id===workerId&&item.reason===reason))snapshot.reviews.push({id:randomUUID(),kind,worker_id:workerId,reason,created_at:new Date().toISOString()});snapshot.status='needs_human';
  }
  async tick(runId:string,now=Date.now()){
    this.fresh();const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot,expected=snapshot.revision;requireCondition(snapshot.status==='running','SWARM_RUN_NOT_ACTIVE');
    let expired=false;for(const worker of Object.values(snapshot.workers))if(worker.status==='leased'&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms<=now){expired=true;worker.status='needs_human';worker.lease_token=null;worker.lease_expires_at_ms=null;this.review(snapshot,'lease_expired',worker.id,'Worker lease expired; blind retry is disabled.');}
    if(expired){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null};}
    const active=Object.values(snapshot.workers).filter(worker=>worker.status==='leased').length;
    if(active>=snapshot.plan.max_concurrency)return {...this.public(snapshot),dispatch:null,reason:'CONCURRENCY_LIMIT'};
    const definitions=new Map(snapshot.plan.workers.map(worker=>[worker.id,worker])),runnable=Object.values(snapshot.workers).filter(worker=>worker.status==='pending'&&definitions.get(worker.id)!.depends_on.every(id=>snapshot.workers[id]?.status==='succeeded'));
    if(runnable.length===0){
      if(Object.values(snapshot.workers).every(worker=>worker.status==='succeeded'))snapshot.status='completed';
      else if(Object.values(snapshot.workers).some(worker=>['failed','needs_human'].includes(worker.status)))this.review(snapshot,'worker_failure',null,'No runnable worker remains.');
      this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,reason:snapshot.status==='completed'?'ALL_WORKERS_VERIFIED':'NO_RUNNABLE_WORKER'};
    }
    const state={goal:snapshot.plan.goal,runnable:runnable.map(worker=>definitions.get(worker.id)),completed:Object.values(snapshot.workers).filter(worker=>worker.status==='succeeded').map(worker=>worker.id),reviews:snapshot.reviews},plane=await this.plane();let selected:string|null=null,eventId:string|null=null,decider:'jev'|'llm'='llm';
    if(plane)try{const evaluated=await plane.evaluate(dispatchRequest(state,runnable.map(worker=>definitions.get(worker.id)!)),{context_id:`${snapshot.run_id}:dispatch:${snapshot.revision}`,bindings:[{question_id:'next_actor',decision_id:'dispatch.next_actor'}]});eventId=evaluated.event.event_id;const judgment=evaluated.judgments[0];if(judgment?.status==='accepted'&&typeof judgment.value==='string'&&runnable.some(worker=>worker.id===judgment.value)){selected=judgment.value;decider='jev';}}catch{/* LLM fallback below. */}
    if(!selected){requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');try{const choice=await this.providers.llm_fallback.dispatch(state,runnable.map(worker=>worker.id));if(runnable.some(worker=>worker.id===choice))selected=choice;else this.review(snapshot,'decision',null,choice==='REVIEW'?'LLM requested review.':'No safe worker selected.');}catch(error){this.review(snapshot,'decision',null,safe(error));}}
    if(eventId)snapshot.decision_events.push(eventId);
    if(!selected){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null};}
    const definition=definitions.get(selected)!;
    if(['external_effect','irreversible'].includes(definition.effect)){this.review(snapshot,'external_effect',selected,'Existing snapshot-bound human approval is required before dispatch.');this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null};}
    const worker=snapshot.workers[selected]!;worker.status='leased';worker.attempts+=1;worker.lease_token=randomUUID();worker.lease_expires_at_ms=now+this.policy().lease_ms;this.persist(snapshot,expected);
    return {...this.public(snapshot),dispatch:{run_id:snapshot.run_id,worker_id:selected,lease_token:worker.lease_token,lease_expires_at_ms:worker.lease_expires_at_ms,role:definition.role,objective:definition.objective,executor:definition.executor,required_capabilities:definition.required_capabilities,effect:definition.effect,completion_evidence:definition.completion_evidence,max_steps:definition.max_steps,timeout_ms:definition.timeout_ms,spawn_sub_agent_required:true,decider},next_action:'spawn_sub_agent_then_runtime_swarm_report'};
  }
  async report(runId:string,workerId:string,leaseToken:string,raw:unknown){
    this.fresh();const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot,expected=snapshot.revision;requireCondition(snapshot.status==='running','SWARM_RUN_NOT_ACTIVE');const worker=snapshot.workers[workerId];requireCondition(worker,'SWARM_WORKER_NOT_FOUND');requireCondition(worker.status==='leased'&&worker.lease_token===leaseToken&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms>Date.now(),'STALE_SWARM_LEASE');
    requireCondition(!credential.test(JSON.stringify(raw)),'CREDENTIAL_LIKE_INPUT');const report=swarmWorkerReportSchema.parse(raw),definition=snapshot.plan.workers.find(item=>item.id===workerId)!;worker.lease_token=null;worker.lease_expires_at_ms=null;worker.result=report;
    if(report.status!=='succeeded'){worker.status=report.status==='failed'?'failed':'needs_human';this.review(snapshot,'worker_failure',workerId,report.error_code??report.summary);this.persist(snapshot,expected);return this.public(snapshot);}
    const qualityState={goal:snapshot.plan.goal,worker:definition,result:{summary:report.summary,artifacts:report.artifacts,readback:report.readback}},plane=await this.plane();let dimensions:{relevance:number;evidence:number;usability:number}|null=null,eventId:string|null=null;
    if(plane)try{const evaluated=await plane.evaluate(artifactQualityRequest(qualityState),{context_id:`${snapshot.run_id}:quality:${workerId}:${snapshot.revision}`,bindings:[{question_id:'relevance',decision_id:'artifact.quality.relevance'},{question_id:'evidence',decision_id:'artifact.quality.evidence'},{question_id:'usability',decision_id:'artifact.quality.usability'}]});eventId=evaluated.event.event_id;if(evaluated.judgments.every(item=>item.status==='accepted'&&typeof item.value==='number'))dimensions={relevance:Number(evaluated.judgments[0]!.value),evidence:Number(evaluated.judgments[1]!.value),usability:Number(evaluated.judgments[2]!.value)};}catch{/* LLM fallback below. */}
    if(!dimensions){requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');try{dimensions=await this.providers.llm_fallback.quality(qualityState);}catch(error){this.review(snapshot,'quality',workerId,safe(error));}}
    if(eventId)snapshot.decision_events.push(eventId);
    const normalized=dimensions?Object.fromEntries(Object.entries(dimensions).map(([key,value])=>[key,value/4])) as Record<keyof typeof ARTIFACT_QUALITY_WEIGHTS,number>:null,quality=normalized?normalized.relevance*ARTIFACT_QUALITY_WEIGHTS.relevance+normalized.evidence*ARTIFACT_QUALITY_WEIGHTS.evidence+normalized.usability*ARTIFACT_QUALITY_WEIGHTS.usability:null,accepted=quality!==null&&quality>=.75&&normalized!.evidence>=.75;
    worker.quality={score:quality,accepted,decision_event_id:eventId,dimensions:normalized??{relevance:null,evidence:null,usability:null}};
    if(!accepted){worker.status='needs_human';this.review(snapshot,'quality',workerId,'Artifact quality or independent evidence is below the code-owned acceptance threshold.');this.persist(snapshot,expected);return this.public(snapshot);}
    worker.status='succeeded';
    const allDone=Object.values(snapshot.workers).every(item=>item.status==='succeeded'),workflowState={goal:snapshot.plan.goal,reported_worker:workerId,all_workers_verified:allDone,workers:Object.values(snapshot.workers).map(item=>({id:item.id,status:item.status,quality:item.quality?.score??null}))};let next:'CONTINUE'|'REOBSERVE'|'LLM_REPLAN'|'HUMAN_REVIEW'|'COMPLETE'|'HOLD'=allDone?'COMPLETE':'CONTINUE';
    if(plane)try{const evaluated=await plane.evaluate(workflowRequest(workflowState),{context_id:`${snapshot.run_id}:workflow:${workerId}:${snapshot.revision}`,bindings:[{question_id:'next_step',decision_id:'workflow.next_step'}]});snapshot.decision_events.push(evaluated.event.event_id);const judgment=evaluated.judgments[0];if(judgment?.status==='accepted'&&typeof judgment.value==='string')next=judgment.value as typeof next;}catch{/* LLM fallback below. */}
    if(!plane||['HOLD','HUMAN_REVIEW'].includes(next))try{requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');next=await this.providers.llm_fallback.workflow(workflowState);}catch{next='HUMAN_REVIEW';}
    if(next==='COMPLETE'&&allDone)snapshot.status='completed';else if(next==='LLM_REPLAN'){this.review(snapshot,'replan',workerId,'LLM supervisor replan requested; create a new bound plan.');}else if(['HUMAN_REVIEW','HOLD'].includes(next)){this.review(snapshot,'decision',workerId,`Workflow selected ${next}.`);}else if(allDone)snapshot.status='completed';
    this.persist(snapshot,expected);return this.public(snapshot);
  }
}
