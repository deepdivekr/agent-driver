import {randomUUID} from 'node:crypto';
import {dirname,join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {DecisionPlane,DecisionProfileRegistry,FileDecisionJournal,type DecisionProvider,type DecisionBatchResult} from '../decision-plane/index.js';
import {type HostConfig,loadHostConfig} from '../interface/config.js';
import {type PackStore} from '../packs/store.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {redact} from '../terminal/contracts.js';
import {sanitizeSwarmEndpoint} from './dashboard.js';
import {authProfile,authSites,authSite,blockedAuthSites,requireSiteAuth} from './browser-auth.js';
import {ARTIFACT_QUALITY_WEIGHTS,SWARM_DECISION_CATALOG,artifactQualityRequest,dispatchRequest,swarmDecisionProfile,workflowRequest} from './decision.js';
import {swarmPlanSchema,swarmWorkerReportSchema,type SwarmResearchMode,type SwarmReviewItem,type SwarmRunSnapshot} from './contracts.js';
import {type SwarmLlmDecisionFallback,type SwarmPlanner} from './planner.js';
import {SwarmDecisionLearning,type SwarmLearningMode} from './learning.js';

export interface SwarmRuntimeProviders {planner?:SwarmPlanner;llm_fallback?:SwarmLlmDecisionFallback;decision?:DecisionProvider;learning?:SwarmLearningMode;}
type StoredRun={snapshot:SwarmRunSnapshot;binding:string};
const credential=/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u;
const safe=(error:unknown)=>error instanceof Error&&/^[A-Z][A-Z0-9_]+$/u.test(error.message)?error.message:'SWARM_DECISION_UNAVAILABLE';
// Authentication, permissions, uncertain writes and quality rejection are not
// transient infrastructure errors. Only bounded, read-only retries are allowed.
const retryableWorkerErrors=new Set(['CLIENT_TIMEOUT','CLIENT_MODEL_UNAVAILABLE','STRUCTURED_MODEL_UNAVAILABLE','SOURCE_WORKER_DEADLINE','SWARM_BROWSER_TIMEOUT','SWARM_BROWSER_DISCONNECTED','UNOBSERVED_EVIDENCE_SPAN','DERIVED_EVIDENCE_REFERENCE_INVALID']);

export class SwarmRuntime{
  private readonly runLocks=new Map<string,Promise<void>>();
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly providers:SwarmRuntimeProviders={}){}
  private async serial<T>(runId:string,operation:()=>Promise<T>):Promise<T>{
    const previous=this.runLocks.get(runId)??Promise.resolve();let unlock!:()=>void;
    const current=new Promise<void>(resolve=>{unlock=resolve;});this.runLocks.set(runId,current);
    await previous;
    try{return await operation();}finally{unlock();if(this.runLocks.get(runId)===current)this.runLocks.delete(runId);}
  }
  private policy(){requireCondition(this.config.swarm?.enabled,'SWARM_NOT_ENABLED');return this.config.swarm!;}
  private fresh(){this.policy();requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');}
  private decisionActivity(runId:string,workerId:string,layer:'llm'|'jev'|'code',summary:string){
    const snapshot=(this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot;
    const surface=this.store.controlSurfaces(this.config.project.id).find(item=>item.run_id===runId&&item.worker_id===workerId&&item.state==='active');
    const endpoint=this.store.observedUrls(this.config.project.id,runId,workerId).at(-1)??snapshot.plan.workers.find(item=>item.id===workerId)?.source_urls[0];
    this.store.recordSwarmActivity(this.config.project.id,runId,snapshot.revision,workerId,'worker.activity',{activity_kind:layer==='code'?'checkpoint':'tool_call',summary,endpoint:endpoint?sanitizeSwarmEndpoint(endpoint):null,surface_id:surface?.id??null,decision_layer:layer});
  }
  private async decisionCall<T>(runId:string,workerId:string,layer:'llm'|'jev',summary:string,call:()=>Promise<T>):Promise<T>{
    this.decisionActivity(runId,workerId,layer,summary);
    try{return await call();}finally{this.decisionActivity(runId,workerId,'code','Decision response returned; code validation resumed.');}
  }
  private async plane(runId:string,actor?:{runId:string;workerId:string}){
    const office=this.store.officeWork(this.config.project.id,'swarm',runId) as {id:string}|null;
    const boundWork=office?this.store.intakeWorkOptional(this.config.project.id,office.id):null;
    if(boundWork&&!boundWork.jev_enabled)return null;
    const provider=this.providers.decision;if(!provider)return null;
    const root=join(dirname(this.config.dbPath),'decisions'),registry=new DecisionProfileRegistry(join(root,'registry')),fallback=swarmDecisionProfile(),scope=this.config.environment==='fixture'?'fixture' as const:'production' as const;
    let profile:ReturnType<typeof swarmDecisionProfile>;
    try{profile=(await registry.resolve(SWARM_DECISION_CATALOG,scope,fallback)).profile;}
    catch(error){
      // A question upgrade must not inherit an old calibration or strand the
      // task. Keep the old profile intact and use the existing LLM path.
      if(error instanceof Error&&error.message==='DECISION_ACTIVE_CATALOG_MISMATCH'){
        if(actor)this.decisionActivity(actor.runId,actor.workerId,'code','Stored calibration targets an older question catalog; continuing with LLM review.');
        return null;
      }
      throw error;
    }
    const primary:DecisionProvider=actor?{id:provider.id,systemOne:(request,settings)=>this.decisionCall(actor.runId,actor.workerId,'jev','Jev decision provider is evaluating this worker result.',()=>provider.systemOne(request,settings))}:provider;
    return new DecisionPlane({catalog:SWARM_DECISION_CATALOG,profile,primary,journal:new FileDecisionJournal(join(root,'swarm.jsonl')),timeout_ms:1_500});
  }
  async plan(goal:string,context:Record<string,string|number|boolean|null>,mode?:SwarmResearchMode){
    const policy=this.policy();requireCondition(policy.model_data_approved,'MODEL_DATA_APPROVAL_REQUIRED');requireCondition(!credential.test(JSON.stringify({goal,context})),'CREDENTIAL_LIKE_INPUT');requireCondition(this.providers.planner,'SWARM_LLM_PLANNER_REQUIRED');
    const profile=mode?policy.standard:null;
    const concurrency=Math.min(profile?.max_concurrency??policy.max_concurrency,policy.visual.enabled?policy.visual.max_contexts:Number.POSITIVE_INFINITY);
    const plan=await this.providers.planner.plan(goal,context,{max_workers:profile?.max_workers??policy.max_logical_workers,max_concurrency:concurrency,capabilities:this.config.project.capabilities,...(mode&&profile?{mode,target_wall_ms:profile.target_wall_ms,hard_deadline_ms:profile.hard_deadline_ms,worker_timeout_ms:profile.worker_timeout_ms,synthesis_reserve_ms:profile.synthesis_reserve_ms,max_sources_per_worker:profile.max_sources_per_worker}:{})});
    this.fresh();this.store.saveSwarmPlan(this.config.project.id,plan,this.config.fingerprint);const source_auth=requireSiteAuth(this.store,this.config,plan.workers.flatMap(worker=>worker.source_urls));return {status:'planned',plan,source_auth,mandatory_sub_agent_tasks:plan.workers.length,execution_started:false,next_action:'runtime_swarm_run'};
  }
  async start(requestId:string,goal:string,context:Record<string,string|number|boolean|null>,mode:SwarmResearchMode='standard',workId?:string){
    const planned=await this.plan(goal,context,mode),run=this.run(requestId,planned.plan.plan_id,workId),batch=await this.batchTick(run.run_id);
    return {status:batch.status,mode,plan:planned.plan,run,dispatches:batch.dispatches,dispatch:batch.dispatch,next_action:batch.next_action,execution_authority:false,approval_granted:false};
  }
  async replan(runId:string,reason:string){
    const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot;
    requireCondition(snapshot.status==='needs_human'||snapshot.status==='running'||snapshot.status==='partial_evidence','SWARM_REPLAN_NOT_ALLOWED');
    return this.plan(snapshot.plan.goal,{replan_reason:reason,prior_plan_id:snapshot.plan.plan_id,prior_run_status:snapshot.status,worker_statuses:JSON.stringify(Object.values(snapshot.workers).map(worker=>({id:worker.id,status:worker.status,quality:worker.quality?.score??null})))});
  }
  async recover(runId:string){return this.serial(runId,async()=>{
    this.fresh();const snapshot=(this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot,expected=snapshot.revision;
    requireCondition(snapshot.status==='needs_human','SWARM_RECOVERY_NOT_REQUIRED');
    requireCondition(snapshot.hard_deadline_at_ms===null||Date.now()<snapshot.hard_deadline_at_ms,'SWARM_RECOVERY_DEADLINE');
    requireCondition(snapshot.reviews.length>0&&snapshot.reviews.every(review=>review.kind==='lease_expired'&&review.worker_id!==null),'SWARM_RECOVERY_REQUIRES_REVIEW');
    const ids=[...new Set(snapshot.reviews.map(review=>review.worker_id!))];
    requireCondition(ids.every(id=>snapshot.plan.workers.find(w=>w.id===id)?.effect==='read_only'&&snapshot.workers[id]?.status==='needs_human'&&snapshot.workers[id]!.attempts<2),'SWARM_RECOVERY_UNSAFE_OR_EXHAUSTED');
    // Preserve the original review in the append-only activity journal. A new
    // dispatch issues a new lease, so old workers cannot submit or operate.
    for(const id of ids)this.store.recordSwarmActivity(this.config.project.id,runId,snapshot.revision,id,'worker.recovery',{reason:'read_only_lease_expired',reviews:snapshot.reviews.filter(review=>review.worker_id===id)});
    for(const id of ids){const worker=snapshot.workers[id]!;worker.status='pending';worker.lease_token=null;worker.lease_expires_at_ms=null;}
    snapshot.reviews=[];snapshot.status='running';this.persist(snapshot,expected);
    return {...this.public(snapshot),recovered_workers:ids,next_action:'runtime_swarm_tick'};
  });}
  run(requestId:string,planId:string,workId?:string){
    this.fresh();const storedPlan=this.store.swarmPlan(this.config.project.id,planId) as {plan:unknown;binding:string},plan=swarmPlanSchema.parse(storedPlan.plan);requireCondition(storedPlan.binding===snapshotHash({plan,fingerprint:this.config.fingerprint}),'CONFIG_CHANGED');
    requireSiteAuth(this.store,this.config,plan.workers.flatMap(worker=>worker.source_urls));
    const startedAt=Date.now(),now=new Date(startedAt).toISOString(),profile=plan.execution_profile,snapshot:SwarmRunSnapshot={format:1,run_id:randomUUID(),request_id:requestId,plan,revision:0,status:'running',workers:Object.fromEntries(plan.workers.map(worker=>[worker.id,{id:worker.id,status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}])),mode:plan.research_mode,started_at_ms:startedAt,target_deadline_at_ms:profile?startedAt+profile.target_wall_ms:null,hard_deadline_at_ms:profile?startedAt+profile.hard_deadline_ms:null,synthesis_reserve_ms:profile?.synthesis_reserve_ms??0,reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};
    const stored=this.store.beginSwarmRun(this.config.project.id,requestId,planId,snapshot,this.config.fingerprint,workId) as StoredRun;
    return {...this.public(stored.snapshot),deduplicated:stored.snapshot.run_id!==snapshot.run_id,next_action:'runtime_swarm_tick'};
  }
  status(runId:string){return this.public((this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot);}
  private public(snapshot:SwarmRunSnapshot){
    const workers=Object.values(snapshot.workers).map(worker=>({...worker,lease_token:worker.lease_token?'redacted':null}));
    const requestedSites=new Set(snapshot.plan.workers.flatMap(worker=>worker.source_urls.flatMap(url=>{try{return [authSite(url)];}catch{return [];}}))),source_auth=authSites(this.store,this.config).filter(site=>requestedSites.has(site.site));
    const office=this.store.officeControl(this.config.project.id,snapshot.run_id);
    return {run_id:snapshot.run_id,status:snapshot.status,paused_by_user:office.paused,revision:snapshot.revision,plan_id:snapshot.plan.plan_id,goal:snapshot.plan.goal,max_concurrency:snapshot.plan.max_concurrency,mode:snapshot.mode,started_at_ms:snapshot.started_at_ms,target_deadline_at_ms:snapshot.target_deadline_at_ms,hard_deadline_at_ms:snapshot.hard_deadline_at_ms,synthesis_reserve_ms:snapshot.synthesis_reserve_ms,workers,source_auth,reviews:snapshot.reviews,decision_events:snapshot.decision_events,execution_authority:false,approval_granted:false,
      next_action:office.paused?'resume_in_control_center':snapshot.status==='running'?'runtime_swarm_tick':snapshot.status==='needs_human'?'human_review_or_llm_replan':snapshot.status==='completed'?'inspect_verified_results':snapshot.status==='partial_evidence'?'inspect_partial_evidence_or_replan':'inspect_failure'};
  }
  private persist(snapshot:SwarmRunSnapshot,expected:number){snapshot.revision=expected+1;snapshot.updated_at=new Date().toISOString();this.store.updateSwarmRun(this.config.project.id,snapshot.run_id,expected,snapshot,authProfile(this.config));}
  private review(snapshot:SwarmRunSnapshot,kind:SwarmReviewItem['kind'],workerId:string|null,reason:string){
    if(!snapshot.reviews.some(item=>item.kind===kind&&item.worker_id===workerId&&item.reason===reason))snapshot.reviews.push({id:randomUUID(),kind,worker_id:workerId,reason,created_at:new Date().toISOString()});snapshot.status='needs_human';
  }
  private deadlineReview(snapshot:SwarmRunSnapshot,reason:string){if(!snapshot.reviews.some(item=>item.kind==='deadline'&&item.reason===reason))snapshot.reviews.push({id:randomUUID(),kind:'deadline',worker_id:null,reason,created_at:new Date().toISOString()});}
  private dispatch(snapshot:SwarmRunSnapshot,workerId:string,now:number,decider:'code'|'jev'|'llm'){
    const definition=snapshot.plan.workers.find(item=>item.id===workerId)! ,worker=snapshot.workers[workerId]!;
    const instructionVersion=this.store.officeInstructionVersion(this.config.project.id,snapshot.run_id,workerId);
    worker.status='leased';worker.attempts+=1;worker.lease_token=randomUUID();
    worker.lease_expires_at_ms=Math.min(now+this.policy().lease_ms,now+definition.timeout_ms,snapshot.hard_deadline_at_ms??Number.POSITIVE_INFINITY);
    return {run_id:snapshot.run_id,worker_id:workerId,lease_token:worker.lease_token,lease_expires_at_ms:worker.lease_expires_at_ms,role:definition.role,objective:definition.objective,instruction_version:instructionVersion,stage:definition.stage,source_urls:definition.source_urls,executor:definition.executor,required_capabilities:definition.required_capabilities,effect:definition.effect,completion_evidence:definition.completion_evidence,max_steps:definition.max_steps,timeout_ms:definition.timeout_ms,spawn_sub_agent_required:true,decider};
  }
  private applyDeadline(snapshot:SwarmRunSnapshot,now:number){
    if(snapshot.hard_deadline_at_ms!==null&&now>=snapshot.hard_deadline_at_ms){
      snapshot.status='partial_evidence';
      for(const worker of Object.values(snapshot.workers))if(['pending','leased'].includes(worker.status)){worker.status='skipped_deadline';worker.lease_token=null;worker.lease_expires_at_ms=null;}
      this.deadlineReview(snapshot,'Swarm hard deadline exceeded; completed evidence is retained but the run is not completed.');return true;
    }
    if(snapshot.hard_deadline_at_ms===null)return false;
    const remaining=snapshot.hard_deadline_at_ms-now;
    for(const definition of snapshot.plan.workers){
      const worker=snapshot.workers[definition.id]!;
      if(worker.status==='pending'&&['discovery','source_read','verification'].includes(definition.stage)&&remaining<=definition.timeout_ms+snapshot.synthesis_reserve_ms)worker.status='skipped_deadline';
    }
    if(Object.values(snapshot.workers).some(worker=>worker.status==='skipped_deadline'))this.deadlineReview(snapshot,'New evidence acquisition stopped to preserve the synthesis reserve.');
    return false;
  }
  private ready(snapshot:SwarmRunSnapshot){
    const definitions=new Map(snapshot.plan.workers.map(worker=>[worker.id,worker]));
    return Object.values(snapshot.workers).filter(worker=>worker.status==='pending'&&!blockedAuthSites(this.store,this.config,definitions.get(worker.id)!.source_urls).length&&definitions.get(worker.id)!.depends_on.every(id=>['succeeded','skipped_deadline'].includes(snapshot.workers[id]?.status??'')));
  }
  deferForAuth(runId:string,workerId:string,leaseToken:string){
    return this.serial(runId,async()=>{this.fresh();const snapshot=(this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot,worker=snapshot.workers[workerId];requireCondition(snapshot.status==='running'&&worker?.status==='leased'&&worker.lease_token===leaseToken,'STALE_SWARM_LEASE');worker.status='pending';worker.lease_token=null;worker.lease_expires_at_ms=null;this.persist(snapshot,snapshot.revision);return {status:'waiting_for_auth',run_id:runId,worker_id:workerId,source_auth:blockedAuthSites(this.store,this.config,snapshot.plan.workers.find(item=>item.id===workerId)!.source_urls),next_action:'open_control_center_connections_then_runtime_swarm_tick'};});
  }
  private settleNoRunnable(snapshot:SwarmRunSnapshot){
    const workers=Object.values(snapshot.workers),active=workers.some(worker=>worker.status==='leased');
    if(active)return 'WAITING_FOR_LEASED_WORKERS';
    if(workers.every(worker=>worker.status==='succeeded'))snapshot.status='completed';
    else if(workers.every(worker=>['succeeded','skipped_deadline'].includes(worker.status))){snapshot.status='partial_evidence';this.deadlineReview(snapshot,'Synthesis finished with deadline-skipped evidence workers.');}
    else if(workers.some(worker=>worker.status==='needs_human'))this.review(snapshot,'worker_failure',null,'No runnable worker remains.');
    else if(workers.some(worker=>worker.status==='failed'))snapshot.status='failed';
    return snapshot.status==='completed'?'ALL_WORKERS_VERIFIED':snapshot.status==='partial_evidence'?'PARTIAL_EVIDENCE':'NO_RUNNABLE_WORKER';
  }
  async tick(runId:string,now=Date.now()){return this.serial(runId,()=>this.lease(runId,now,true,true));}
  async batchTick(runId:string,now=Date.now()){return this.serial(runId,()=>this.lease(runId,now,true,false));}
  activity(runId:string,workerId:string,leaseToken:string,activity:{kind:'started'|'navigating'|'observing'|'tool_call'|'checkpoint';summary:string;endpoint:string|null;surface_id?:string|null;actor_id?:string|null;decision_layer?:'llm'|'jev'|'code'|null}){
    this.fresh();const snapshot=(this.store.swarmRun(this.config.project.id,runId) as StoredRun).snapshot,worker=snapshot.workers[workerId];
    requireCondition(['running','needs_human'].includes(snapshot.status),'SWARM_RUN_NOT_ACTIVE');requireCondition(worker,'SWARM_WORKER_NOT_FOUND');requireCondition(worker.status==='leased'&&worker.lease_token===leaseToken&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms>Date.now(),'STALE_SWARM_LEASE');
    requireCondition(!credential.test(activity.summary),'CREDENTIAL_LIKE_INPUT');const endpoint=activity.endpoint===null?null:sanitizeSwarmEndpoint(activity.endpoint);requireCondition(activity.endpoint===null||endpoint,'SWARM_ACTIVITY_ENDPOINT_INVALID');
    if(activity.surface_id)requireCondition(this.config.observability?.surfaces.some(surface=>surface.id===activity.surface_id)||this.store.controlSurfaces(this.config.project.id).some(surface=>surface.id===activity.surface_id&&surface.run_id===runId&&surface.worker_id===workerId&&surface.state==='active'),'CONTROL_SURFACE_UNDELEGATED');
    const event_id=this.store.recordSwarmActivity(this.config.project.id,runId,snapshot.revision,workerId,'worker.activity',{activity_kind:activity.kind,summary:redact(activity.summary),endpoint,surface_id:activity.surface_id??null,actor_id:activity.actor_id??null,decision_layer:activity.decision_layer??null});
    return {recorded:true,event_id,run_id:runId,worker_id:workerId,revision:snapshot.revision,activity_kind:activity.kind,endpoint,execution_authority:false,approval_granted:false};
  }
  private async lease(runId:string,now:number,batch:boolean,singleFallback=false){
    this.fresh();const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot,expected=snapshot.revision;requireCondition(snapshot.status==='running','SWARM_RUN_NOT_ACTIVE');
    if(this.store.officeControl(this.config.project.id,runId).paused)return {...this.public(snapshot),dispatch:null,dispatches:[],reason:'USER_PAUSED',next_action:'resume_in_control_center'};
    if(snapshot.auth_wait_started_at_ms!==undefined){const waited=Math.max(0,now-snapshot.auth_wait_started_at_ms);if(snapshot.target_deadline_at_ms!==null)snapshot.target_deadline_at_ms+=waited;if(snapshot.hard_deadline_at_ms!==null)snapshot.hard_deadline_at_ms+=waited;delete snapshot.auth_wait_started_at_ms;}
    const waitingOnly=!Object.values(snapshot.workers).some(worker=>worker.status==='leased')&&this.ready(snapshot).length===0&&snapshot.plan.workers.some(worker=>snapshot.workers[worker.id]?.status==='pending'&&blockedAuthSites(this.store,this.config,worker.source_urls).length>0);
    if(waitingOnly){snapshot.auth_wait_started_at_ms=now;this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason:'WAITING_FOR_SITE_AUTH',next_action:'open_control_center_connections_then_runtime_swarm_tick'};}
    const skippedBefore=Object.values(snapshot.workers).filter(worker=>worker.status==='skipped_deadline').length;
    if(this.applyDeadline(snapshot,now)){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason:'HARD_DEADLINE_EXCEEDED'};}
    const deadlineChanged=Object.values(snapshot.workers).filter(worker=>worker.status==='skipped_deadline').length!==skippedBefore;
    let expired=false;for(const worker of Object.values(snapshot.workers))if(worker.status==='leased'&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms<=now){expired=true;worker.status='needs_human';worker.lease_token=null;worker.lease_expires_at_ms=null;this.review(snapshot,'lease_expired',worker.id,'Worker lease expired; blind retry is disabled.');}
    if(expired){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[]};}
    const active=Object.values(snapshot.workers).filter(worker=>worker.status==='leased').length;
    if(active>=snapshot.plan.max_concurrency){if(deadlineChanged)this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason:'CONCURRENCY_LIMIT'};}
    const definitions=new Map(snapshot.plan.workers.map(worker=>[worker.id,worker])),runnable=this.ready(snapshot);
    if(runnable.length===0){
      const auth=snapshot.plan.workers.filter(worker=>snapshot.workers[worker.id]?.status==='pending').flatMap(worker=>blockedAuthSites(this.store,this.config,worker.source_urls));
      if(auth.length){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason:'WAITING_FOR_SITE_AUTH',source_auth:auth,next_action:'open_control_center_connections_then_runtime_swarm_tick'};}
      const reason=this.settleNoRunnable(snapshot);this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason};
    }
    const available=snapshot.plan.max_concurrency-active,safeReads=runnable.filter(worker=>definitions.get(worker.id)!.effect==='read_only');
    if(batch&&safeReads.length>0){
      const dispatches=[...safeReads].sort((a,b)=>a.id.localeCompare(b.id)).slice(0,available).map(worker=>this.dispatch(snapshot,worker.id,now,'code'));
      this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:dispatches[0]??null,dispatches,next_action:'spawn_sub_agents_in_parallel_then_runtime_swarm_report'};
    }
    if(batch){
      const guarded=runnable.find(worker=>['external_effect','irreversible'].includes(definitions.get(worker.id)!.effect));
      if(guarded)this.review(snapshot,'external_effect',guarded.id,'Existing snapshot-bound human approval is required before dispatch.');
      if(guarded||!singleFallback){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[],reason:guarded?'EXTERNAL_EFFECT_REVIEW_REQUIRED':'NO_BATCH_SAFE_WORKER'};}
    }
    const state={goal:snapshot.plan.goal,runnable:runnable.map(worker=>definitions.get(worker.id)),completed:Object.values(snapshot.workers).filter(worker=>worker.status==='succeeded').map(worker=>worker.id),reviews:snapshot.reviews},plane=await this.plane(snapshot.run_id);let selected:string|null=null,eventId:string|null=null,decider:'code'|'jev'|'llm'='llm';
    const equivalent=runnable.every(worker=>{const item=definitions.get(worker.id)!;return item.effect==='read_only'&&item.executor==='sub_agent'&&item.required_capabilities.length===0;});
    if(equivalent){selected=[...runnable].map(worker=>worker.id).sort()[0]??null;decider='code';}
    else if(plane)try{const evaluated=await plane.evaluate(dispatchRequest(state,runnable.map(worker=>definitions.get(worker.id)!)),{context_id:`${snapshot.run_id}:dispatch:${snapshot.revision}`,bindings:[{question_id:'next_actor',decision_id:'dispatch.next_actor'}]});eventId=evaluated.event.event_id;const judgment=evaluated.judgments[0];if(judgment?.status==='accepted'&&typeof judgment.value==='string'&&runnable.some(worker=>worker.id===judgment.value)){selected=judgment.value;decider='jev';}}catch{/* LLM fallback below. */}
    if(!selected){requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');try{const choice=await this.providers.llm_fallback.dispatch(state,runnable.map(worker=>worker.id));if(runnable.some(worker=>worker.id===choice))selected=choice;else this.review(snapshot,'decision',null,choice==='REVIEW'?'LLM requested review.':'No safe worker selected.');}catch(error){this.review(snapshot,'decision',null,safe(error));}}
    if(eventId)snapshot.decision_events.push(eventId);
    if(!selected){this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[]};}
    const definition=definitions.get(selected)!;
    if(['external_effect','irreversible'].includes(definition.effect)){this.review(snapshot,'external_effect',selected,'Existing snapshot-bound human approval is required before dispatch.');this.persist(snapshot,expected);return {...this.public(snapshot),dispatch:null,dispatches:[]};}
    const dispatch=this.dispatch(snapshot,selected,now,decider);this.persist(snapshot,expected);
    return {...this.public(snapshot),dispatch,dispatches:[dispatch],next_action:'spawn_sub_agent_then_runtime_swarm_report'};
  }
  async report(runId:string,workerId:string,leaseToken:string,raw:unknown){
    const receivedAt=Date.now();
    return this.serial(runId,()=>this.reportLocked(runId,workerId,leaseToken,raw,receivedAt));
  }
  private async reportLocked(runId:string,workerId:string,leaseToken:string,raw:unknown,receivedAt:number){
    this.fresh();const stored=this.store.swarmRun(this.config.project.id,runId) as StoredRun,snapshot=stored.snapshot,expected=snapshot.revision;requireCondition(['running','needs_human'].includes(snapshot.status),'SWARM_RUN_NOT_ACTIVE');
    if(this.applyDeadline(snapshot,Date.now())){this.persist(snapshot,expected);return this.public(snapshot);}
    // Internal verification queue time must not invalidate an on-time report.
    // Generation fencing and the global hard deadline still apply.
    const worker=snapshot.workers[workerId];requireCondition(worker,'SWARM_WORKER_NOT_FOUND');requireCondition(worker.status==='leased'&&worker.lease_token===leaseToken&&worker.lease_expires_at_ms!==null&&worker.lease_expires_at_ms>receivedAt,'STALE_SWARM_LEASE');
    requireCondition(!credential.test(JSON.stringify(raw)),'CREDENTIAL_LIKE_INPUT');const report=swarmWorkerReportSchema.parse(raw),definition=snapshot.plan.workers.find(item=>item.id===workerId)!;
    if(snapshot.mode==='standard'&&definition.stage==='source_read'&&report.status==='succeeded'){
      requireCondition(report.fact_cards.length>0,'SWARM_STANDARD_FACT_CARD_REQUIRED');
      const observed=new Set(this.store.observedUrls(this.config.project.id,runId,workerId));
      requireCondition(report.fact_cards.every(card=>definition.source_urls.includes(card.source_url)||observed.has(card.source_url)),'SWARM_STANDARD_FACT_CARD_SOURCE_MISMATCH');
    }
    worker.lease_token=null;worker.lease_expires_at_ms=null;worker.result=report;
    if(report.status!=='succeeded'){
      const technical=report.status==='failed'&&definition.effect==='read_only'&&retryableWorkerErrors.has(report.error_code??'');
      if(technical){
        const canRetry=worker.attempts<2&&(snapshot.hard_deadline_at_ms===null||Date.now()+1_000<snapshot.hard_deadline_at_ms);
        this.store.recordSwarmActivity(this.config.project.id,runId,snapshot.revision,workerId,'worker.recovery',{reason:report.error_code,attempt:worker.attempts,action:canRetry?'retry_read_only_worker':'technical_retry_exhausted',report});
        worker.status=canRetry?'pending':'failed';
        // The old token was cleared above. A new dispatch is a new attempt;
        // successful siblings and the original failure journal remain intact.
        if(!canRetry&&!Object.values(snapshot.workers).some(item=>item.status==='leased')&&this.ready(snapshot).length===0)snapshot.status='failed';
      }else{worker.status=report.status==='failed'?'failed':'needs_human';this.review(snapshot,'worker_failure',workerId,report.error_code??report.summary);}
      this.persist(snapshot,expected);return this.public(snapshot);
    }
    const ancestorIds=new Set<string>();const addAncestor=(id:string)=>{if(ancestorIds.has(id))return;ancestorIds.add(id);for(const parent of snapshot.plan.workers.find(item=>item.id===id)?.depends_on??[])addAncestor(parent);};for(const parent of definition.depends_on)addAncestor(parent);
    const upstreamCoverage=[...ancestorIds].map(id=>{const state=snapshot.workers[id]!,task=snapshot.plan.workers.find(item=>item.id===id)!;return {worker_id:id,stage:task.stage,status:state.status,source_urls:task.source_urls,observed_urls:this.store.observedUrls(this.config.project.id,runId,id),readback_verified:state.result?.readback?.verified??null,fact_cards_count:state.result?.fact_cards.length??null};});
    const qualityState={goal:snapshot.plan.goal,worker:definition,evaluation_scope:{current_worker_only:true,upstream_coverage_is_execution_evidence_not_automatic_quality_acceptance:true},upstream_coverage:upstreamCoverage,result:{summary:report.summary,artifacts:report.artifacts,evidence:report.evidence,fact_cards:report.fact_cards,readback:report.readback}},plane=await this.plane(runId,{runId,workerId});let dimensions:{relevance:number;evidence:number;usability:number}|null=null,eventId:string|null=null;
    const learning=new SwarmDecisionLearning(this.store,this.config,this.providers.learning),qualityRequest=artifactQualityRequest(qualityState);let qualityEvaluation:DecisionBatchResult|null=null;
    if(plane)try{const evaluated=await plane.evaluate(qualityRequest,{context_id:`${snapshot.run_id}:quality:${workerId}:${snapshot.revision}`,bindings:[{question_id:'relevance',decision_id:'artifact.quality.relevance'},{question_id:'evidence',decision_id:'artifact.quality.evidence'},{question_id:'usability',decision_id:'artifact.quality.usability'}]});qualityEvaluation=evaluated;eventId=evaluated.event.event_id;if(evaluated.judgments.every(item=>item.status==='accepted'&&typeof item.value==='number'))dimensions={relevance:Number(evaluated.judgments[0]!.value),evidence:Number(evaluated.judgments[1]!.value),usability:Number(evaluated.judgments[2]!.value)};}catch{/* LLM fallback below. */}
    if(!dimensions){requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');try{dimensions=await this.decisionCall(runId,workerId,'llm','LLM is reviewing artifact quality.',()=>this.providers.llm_fallback!.quality(qualityState));if(plane)try{learning.qualityCandidate(snapshot,workerId,learning.binding(snapshot,plane,qualityRequest.questions),qualityEvaluation,dimensions,{fact_cards:report.fact_cards.length,upstream_workers:upstreamCoverage.length,evidence_items:report.evidence.length,reported_readback_verified:report.readback?.verified??null});}catch{learning.event(snapshot,workerId,'memory_unavailable',{stage:'quality_candidate'});}}catch(error){this.review(snapshot,'quality',workerId,safe(error));}}
    if(eventId)snapshot.decision_events.push(eventId);
    const normalized=dimensions?Object.fromEntries(Object.entries(dimensions).map(([key,value])=>[key,value/4])) as Record<keyof typeof ARTIFACT_QUALITY_WEIGHTS,number>:null,quality=normalized?normalized.relevance*ARTIFACT_QUALITY_WEIGHTS.relevance+normalized.evidence*ARTIFACT_QUALITY_WEIGHTS.evidence+normalized.usability*ARTIFACT_QUALITY_WEIGHTS.usability:null,hasDependent=snapshot.plan.workers.some(item=>item.depends_on.includes(workerId)),requiredScore=hasDependent?0:.75,requiredEvidence=hasDependent?0:.75,accepted=hasDependent?report.readback?.verified===true&&report.evidence.length>0:quality!==null&&quality>=requiredScore&&normalized!.evidence>=requiredEvidence;
    worker.quality={score:quality,accepted,decision_event_id:eventId,dimensions:normalized??{relevance:null,evidence:null,usability:null},required_score:requiredScore,required_evidence:requiredEvidence};
    if(!accepted){
      const canCorrect=definition.effect==='read_only'&&worker.attempts<2&&quality!==null&&report.readback?.verified===true&&report.evidence.length>0&&(snapshot.hard_deadline_at_ms===null||Date.now()+1_000<snapshot.hard_deadline_at_ms);
      if(canCorrect){worker.status='pending';this.store.recordSwarmActivity(this.config.project.id,runId,snapshot.revision,workerId,'worker.recovery',{reason:'artifact_quality_below_threshold',action:'bounded_llm_correction',attempt:worker.attempts,quality:worker.quality,report});}
      else{worker.status='needs_human';this.review(snapshot,'quality',workerId,'Artifact quality or independent evidence is below the code-owned acceptance threshold.');}
      this.persist(snapshot,expected);return this.public(snapshot);
    }
    worker.status='succeeded';
    // Artifact scoring was settled above. Passing fluctuating quality scores to
    // a progress checkpoint reopens that judgment and confounds repeat-run state.
    const states=Object.values(snapshot.workers),allDone=states.every(item=>item.status==='succeeded'),allTerminal=states.every(item=>['succeeded','skipped_deadline'].includes(item.status)),workflowState={goal:snapshot.plan.goal,reported_worker:workerId,all_workers_verified:allDone,partial_evidence:allTerminal&&!allDone,workers:states.map(item=>({id:item.id,status:item.status}))};let next:'CONTINUE'|'REOBSERVE'|'LLM_REPLAN'|'HUMAN_REVIEW'|'COMPLETE'|'HOLD'=allDone?'COMPLETE':'CONTINUE',workflowAccepted=false;
    const workflowFacts={all_workers_verified:allDone,partial_evidence:allTerminal&&!allDone,review_count:snapshot.reviews.length,failed_workers:states.filter(item=>['failed','needs_human','skipped_deadline'].includes(item.status)).length,ready_readonly_workers:this.ready(snapshot).filter(item=>snapshot.plan.workers.find(task=>task.id===item.id)?.effect==='read_only').length,active_workers:states.filter(item=>item.status==='leased').length};
    const enrichedWorkflowState={...workflowState,runtime_facts:workflowFacts},workflowPacket=workflowRequest(enrichedWorkflowState),workflowBinding=plane?learning.binding(snapshot,plane,workflowPacket.questions):null;
    let workflowEvaluation:DecisionBatchResult|null=null,workflowTeacher:'COMPLETE'|'CONTINUE'|'REOBSERVE'|'LLM_REPLAN'|'HUMAN_REVIEW'|'HOLD'|null=null;
    if(plane&&workflowBinding)try{
      let examples:ReturnType<SwarmDecisionLearning['references']>=[];try{examples=learning.references(snapshot,workflowBinding,workflowFacts);}catch{learning.event(snapshot,workerId,'memory_unavailable',{stage:'read'});}
      if(examples.length){workflowPacket.state={...enrichedWorkflowState,verified_previous_cases:examples.map(({features,verified_answer})=>({runtime_facts:features,verified_answer})),reference_policy:'Past cases are examples only. Decide from current runtime_facts; do not copy a past answer when facts differ.'};learning.event(snapshot,workerId,'references_loaded',{examples:examples.length});}
      const evaluated=await plane.evaluate(workflowPacket,{context_id:`${snapshot.run_id}:workflow:${workerId}:${snapshot.revision}`,bindings:[{question_id:'next_step',decision_id:'workflow.next_step'}]});workflowEvaluation=evaluated;snapshot.decision_events.push(evaluated.event.event_id);const judgment=evaluated.judgments[0];
      const memoryValid=learning.audit(snapshot,workerId,workflowBinding,examples,evaluated,workflowFacts);
      if(memoryValid&&judgment?.status==='accepted'&&typeof judgment.value==='string'){next=judgment.value as typeof next;workflowAccepted=true;}
    }catch{/* LLM fallback below; unavailable memory must not stop the task. */}
    if(!workflowAccepted||['HOLD','HUMAN_REVIEW'].includes(next))try{requireCondition(this.providers.llm_fallback,'SWARM_LLM_DECISION_REQUIRED');next=await this.decisionCall(runId,workerId,'llm','LLM is selecting the next workflow step.',()=>this.providers.llm_fallback!.workflow(enrichedWorkflowState));workflowTeacher=next;}catch{next='HUMAN_REVIEW';}
    if(next==='COMPLETE'&&allDone)snapshot.status='completed';else if(allTerminal&&!allDone){snapshot.status='partial_evidence';this.deadlineReview(snapshot,'Synthesis finished with deadline-skipped evidence workers.');}else if(next==='LLM_REPLAN'){this.review(snapshot,'replan',workerId,'LLM supervisor replan requested; create a new bound plan.');}else if(['HUMAN_REVIEW','HOLD'].includes(next)){this.review(snapshot,'decision',workerId,`Workflow selected ${next}.`);}else if(allDone)snapshot.status='completed';
    this.persist(snapshot,expected);
    if(plane&&workflowBinding)try{await learning.confirmWorkflow(snapshot,workerId,workflowBinding,plane,workflowEvaluation,workflowTeacher,workflowFacts);}catch{learning.event(snapshot,workerId,'memory_unavailable',{stage:'outcome'});}
    return this.public(snapshot);
  }
}
