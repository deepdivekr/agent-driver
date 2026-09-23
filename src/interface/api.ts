import {PackStore} from '../packs/store.js';
import {FamilyRuntime} from '../packs/runtime.js';
import {LocalApprovalDispatcher} from '../packs/local-approval.js';
import {ensureTerminalHost} from '../terminal/manager.js';
import {terminalSubmit,terminalList,terminalHistory,terminalOutput} from '../terminal/contracts.js';
import {readTerminalOutput} from '../terminal/output.js';
import {prepareTerminalHandoff} from '../terminal/handoff.js';
import {verifyFiles} from '../terminal/verify-files.js';
import {ScopedFiles} from '../terminal/scoped-files.js';
import {liveness,type ProcessIdentity} from '../supervisor/identity.js';
import {ensureSupervisor} from '../supervisor/manager.js';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig,type HostConfig} from './config.js';
import {draftManifest,terminalManifest,startRequest,tools} from './catalog.js';
import {intake} from './intake.js';
import {resourceHealth} from '../resources/configured.js';
import {storageError} from '../storage/budget.js';
import {routeHumanChannelMessage} from '../integrations/human-channel.js';
import {type JevSystemOneTransport,optionalTypeSafeTransportFromHostEnvironment,typeSafeTransportFromHostEnvironment} from '../taskpack/typesafe-jev.js';
import {ONE_LINE_DECISION_CATALOG,oneLineDecisionProfile} from '../taskpack/typesafe-jev.js';
import {type PackApprovalDispatcher} from '../packs/runtime.js';
import {dirname,join} from 'node:path';
import {DecisionPlane,DecisionProfileRegistry,FileDecisionJournal} from '../decision-plane/index.js';
import {auditDecisionJournal,decisionOperationsReport} from '../decision-plane/index.js';
import {ROW_DECISION_CATALOG} from '../packs/judgment.js';
import {ADAPTIVE_DECISION_CATALOG} from '../taskpack/adaptive-decision.js';
import {type StructuredModel} from '../taskpack/adaptive-spec.js';
import {McpSamplingStructuredModel,SubscriptionAwareStructuredModel} from '../integrations/subscription-auth.js';
import {LlmSwarmDecisionFallback,LlmSwarmPlanner,SWARM_DECISION_CATALOG,SwarmRuntime,swarmTools,type SwarmRuntimeProviders} from '../swarm/index.js';
import {runtimeActivityReport} from '../observability/contracts.js';
import {safeControlText} from '../observability/control-center.js';
import {sanitizeSwarmEndpoint} from '../swarm/dashboard.js';
import {SwarmVisualExecutor} from '../swarm/visual-executor.js';
import {ConfiguredStructuredModel} from '../onboarding/configured-model.js';
import {effectiveModelEnvironment,modelSettingsPath,readModelSettings} from '../onboarding/model-settings.js';

export type SwarmBrowserCommand={action:'navigate';url:string}|{action:'observe'}|{action:'scroll';direction:'up'|'down'};
export interface SwarmVisualAdapter{
  assign(runId:string,workerId:string,leaseToken:string):Promise<{surface_id:string;kind:'browser'}>;
  perform(runId:string,workerId:string,leaseToken:string,command:SwarmBrowserCommand):Promise<unknown>;
  release(runId:string,workerId:string):Promise<void>;
  close():Promise<void>;
}
type SwarmDispatch=Awaited<ReturnType<SwarmRuntime['tick']>>['dispatches'][number];
export interface RuntimeApiOptions {channelTransport?:JevSystemOneTransport;approval?:PackApprovalDispatcher;swarmModel?:StructuredModel;swarmJev?:JevSystemOneTransport;swarmProviders?:SwarmRuntimeProviders;swarmVisual?:SwarmVisualAdapter;}

export class RuntimeApi{
  readonly store:PackStore;
  readonly packs:FamilyRuntime;
  readonly swarm:SwarmRuntime;
  readonly visual:SwarmVisualAdapter|null;
  private closing:Promise<void>|null=null;
  private closed=false;
  private model:StructuredModel;
  private explicitProviders:boolean;
  constructor(readonly config:HostConfig,readonly options:RuntimeApiOptions={}){
    this.store=new PackStore(config.dbPath);try{this.store.registerProject(config.project);}catch(e){this.store.close();throw e;}
    this.model=options.swarmModel??new ConfiguredStructuredModel(modelSettingsPath(config));
    this.packs=new FamilyRuntime(this.store,config,{approval:options.approval??new LocalApprovalDispatcher(this.store),llm:this.model});
    let jev=options.swarmJev;if(!jev&&config.swarm?.enabled)jev=optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment()).transport??undefined;
    this.explicitProviders=options.swarmProviders!==undefined;
    this.swarm=new SwarmRuntime(this.store,config,options.swarmProviders??{planner:new LlmSwarmPlanner(this.model),llm_fallback:new LlmSwarmDecisionFallback(this.model),...(jev?{decision:{id:'typesafe-jev',systemOne:(request,settings)=>jev!.systemOne(request,settings)}}:{})});
    this.visual=config.swarm?.enabled&&config.swarm.visual.enabled?(options.swarmVisual??new SwarmVisualExecutor(this.store,config)):null;
  }
  attachClientSampling(sampling:McpSamplingStructuredModel){
    if(this.explicitProviders)return;
    if(this.options.swarmModel)return;
    if(this.model instanceof ConfiguredStructuredModel)this.model.sampling=sampling;
    this.packs.providers.llm=this.model;this.swarm.providers.planner=new LlmSwarmPlanner(this.model);this.swarm.providers.llm_fallback=new LlmSwarmDecisionFallback(this.model);
  }
  private modelEnvironment(){return effectiveModelEnvironment(readModelSettings(modelSettingsPath(this.config)));}
  close(){
    if(this.closed)return;this.closed=true;this.packs.close();
    if(this.visual)this.closing=this.visual.close().catch(()=>{process.exitCode=1;}).finally(()=>this.store.close());
    else this.store.close();
  }
  async drain(){await this.packs.drain();if(this.closing)await this.closing;}
  private async releaseFinishedVisuals(runId:string){
    if(!this.visual)return;
    const status=this.swarm.status(runId);
    await Promise.all(status.workers.filter(worker=>worker.status!=='leased'||status.status!=='running').map(worker=>this.visual!.release(runId,worker.id)));
  }
  private async attachVisualDispatches<T extends {dispatches:SwarmDispatch[];dispatch:SwarmDispatch|null}>(result:T,runId:string){
    if(!this.visual)return result;
    await this.releaseFinishedVisuals(runId);
    const failures:Array<{worker_id:string;error_code:string}>=[];
    const dispatches=await Promise.all(result.dispatches.map(async dispatch=>{
      if(!['discovery','source_read','verification'].includes(dispatch.stage)||dispatch.source_urls.length===0)return dispatch;
      try{return {...dispatch,...await this.visual!.assign(runId,dispatch.worker_id,dispatch.lease_token),visual_status:'assigned' as const};}
      catch(error){
        const errorCode=error instanceof Error&&/^[A-Z][A-Z0-9_]{0,79}$/u.test(error.message)?error.message:'SWARM_VISUAL_ASSIGNMENT_FAILED';
        failures.push({worker_id:dispatch.worker_id,error_code:errorCode});
        return dispatch;
      }
    }));
    if(failures.length){
      for(const failure of failures){
        const dispatch=result.dispatches.find(item=>item.worker_id===failure.worker_id)!;
        await this.swarm.report(runId,dispatch.worker_id,dispatch.lease_token,{status:'needs_human',summary:'The independent visual executor could not be assigned.',error_code:failure.error_code});
      }
      await this.releaseFinishedVisuals(runId);
      return {...result,status:this.swarm.status(runId).status,dispatches:[],dispatch:null,visual_failures:failures,next_action:'inspect_visual_executor_failure'};
    }
    return {...result,dispatches,dispatch:dispatches[0]??null};
  }
  private scoped(taskId:string){const task=this.store.task(taskId);requireCondition(task.project_id===this.config.project.id,'TASK_SCOPE_MISMATCH');return task;}
  async call(name:string,args:unknown):Promise<unknown>{
    requireCondition(!this.closed,'RUNTIME_API_CLOSED');
    if(name.startsWith('runtime_swarm_')&&!this.explicitProviders&&!this.options.swarmJev){
      const jev=optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment()).transport;
      if(jev)this.swarm.providers.decision={id:'typesafe-jev',systemOne:(request,settings)=>jev.systemOne(request,settings)};else delete this.swarm.providers.decision;
    }
    if(name==='runtime_task_intake')return intake(args);
    if(name==='runtime_channel_route'){
      let transport=this.options.channelTransport;
      if(!transport&&this.config.packs?.models!=='off'&&this.config.packs?.model_data_approved)try{transport=typeSafeTransportFromHostEnvironment(this.modelEnvironment());}catch{}
      if(!transport)return routeHumanChannelMessage(args);
      const registry=new DecisionProfileRegistry(join(dirname(this.config.dbPath),'decisions','registry')),profile=(await registry.resolve(ONE_LINE_DECISION_CATALOG,this.config.environment==='fixture'?'fixture':'production',oneLineDecisionProfile())).profile,plane=new DecisionPlane({catalog:ONE_LINE_DECISION_CATALOG,profile,primary:{id:'typesafe-jev',systemOne:(request,settings)=>transport!.systemOne(request,settings)},journal:new FileDecisionJournal(join(dirname(this.config.dbPath),'decisions','intake.jsonl')),timeout_ms:1_500});
      return routeHumanChannelMessage(args,transport,plane);
    }
    if(name.startsWith('runtime_pack_')){
      const ledger=this.store.storage(this.config),writes=['runtime_pack_run','runtime_pack_execute_approved','runtime_pack_watch_tick'].includes(name),reservation=writes?ledger.reserve('pack_execution',16_777_216):null;
      let failed=false;try{return await this.packs.call(name,args);}catch(e){failed=true;if(storageError(e)==='STORAGE_FULL')throw Error('STORAGE_FULL',{cause:e});throw e;}
      finally{try{ledger.release(reservation);}catch(e){if(!failed)throw e;}}
    }
    if(name.startsWith('runtime_swarm_')){
      const tool=swarmTools[name as keyof typeof swarmTools];requireCondition(tool,'UNKNOWN_TOOL');const input=tool.schema.parse(args) as Record<string,unknown>,writes=!tool.readOnly,reservation=writes?this.store.storage(this.config).reserve('swarm_execution',4_194_304):null;let failed=false;
      try{switch(name){
        case 'runtime_swarm_start':{
          const result=await this.swarm.start(String(input.request_id),String(input.goal),input.context as Record<string,string|number|boolean|null>,input.mode as 'standard');
          return this.visual?await this.attachVisualDispatches(result,result.run.run_id):result;
        }
        case 'runtime_swarm_plan':return this.swarm.plan(String(input.goal),input.context as Record<string,string|number|boolean|null>);
        case 'runtime_swarm_replan':return this.swarm.replan(String(input.run_id),String(input.reason));
        case 'runtime_swarm_run':return this.swarm.run(String(input.request_id),String(input.plan_id));
        case 'runtime_swarm_tick':return await this.attachVisualDispatches(await this.swarm.tick(String(input.run_id)),String(input.run_id));
        case 'runtime_swarm_browser':{
          requireCondition(this.visual,'SWARM_VISUAL_NOT_ENABLED');
          try{return await this.visual.perform(String(input.run_id),String(input.worker_id),String(input.lease_token),input.command as SwarmBrowserCommand);}
          catch(error){if(!(error instanceof Error)||error.message!=='BROWSER_AUTH_REQUIRED')throw error;const result=await this.swarm.deferForAuth(String(input.run_id),String(input.worker_id),String(input.lease_token));await this.visual.release(String(input.run_id),String(input.worker_id));return result;}
        }
        case 'runtime_swarm_activity':return this.swarm.activity(String(input.run_id),String(input.worker_id),String(input.lease_token),input.activity as {kind:'started'|'navigating'|'observing'|'tool_call'|'checkpoint';summary:string;endpoint:string|null;surface_id:string|null;decision_layer:'llm'|'jev'|'code'|null});
        case 'runtime_swarm_report':{
          const result=await this.swarm.report(String(input.run_id),String(input.worker_id),String(input.lease_token),input.report);
          await this.releaseFinishedVisuals(String(input.run_id));return result;
        }
        case 'runtime_swarm_status':return this.swarm.status(String(input.run_id));
        default:throw Error('NOT_IMPLEMENTED');
      }}catch(e){failed=true;throw e;}finally{try{this.store.storage(this.config).release(reservation);}catch(e){if(!failed)throw e;}}
    }
    requireCondition(Object.hasOwn(tools,name),'UNKNOWN_TOOL');
    const tool=tools[name as keyof typeof tools],input=tool.schema.parse(args) as Record<string,unknown>;
    if(name.startsWith('runtime_storage_')&&!tool.readOnly)requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    requireCondition(tool.implemented,'NOT_IMPLEMENTED');
    if('task_id'in input)this.scoped(String(input.task_id));
    if(name.startsWith('runtime_terminal_')){
      requireCondition(this.config.terminal,'TERMINAL_DISABLED');
      if('session_ref'in input)requireCondition(this.store.session(String(input.session_ref)).project_id===this.config.project.id,'SESSION_SCOPE_MISMATCH');
      if(!tool.readOnly)requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    }
    const writes = ['runtime_terminal_start','runtime_terminal_submit_prompt','runtime_terminal_resume','runtime_task_start','runtime_task_resume'];
    const ledger = this.store.storage(this.config), reservation = writes.includes(name) ? ledger.reserve('request_admission', 1048576) : null;
    let failed = false;
    try {switch(name){
      case 'runtime_activity_report':{
        const report=runtimeActivityReport.parse(input),endpoint=report.activity.endpoint?sanitizeSwarmEndpoint(report.activity.endpoint):null;
        if(report.activity.surface_id)requireCondition(this.config.observability?.surfaces.some(surface=>surface.id===report.activity.surface_id),'CONTROL_SURFACE_UNDELEGATED');
        const activity_id=this.store.recordRuntimeActivity(this.config.project.id,report.owner_kind,report.owner_id,report.actor_id,report.activity.kind,safeControlText(report.activity.summary,500),endpoint,new Date().toISOString(),report.activity.surface_id??null,report.activity.decision_layer??null);
        return {activity_id,recorded:true,authority_granted:false,completion_verified:false};
      }
      case 'runtime_storage_status':return ledger.status();
      case 'runtime_decision_status':{
        const root=join(dirname(this.config.dbPath),'decisions'),registry=new DecisionProfileRegistry(join(root,'registry')),scope=this.config.environment==='fixture'?'fixture' as const:'production' as const,entries=[{catalog:ROW_DECISION_CATALOG,journal:'family.jsonl'},{catalog:ONE_LINE_DECISION_CATALOG,journal:'intake.jsonl'},{catalog:ADAPTIVE_DECISION_CATALOG,journal:'adaptive.jsonl'},{catalog:SWARM_DECISION_CATALOG,journal:'swarm.jsonl'}],decisions=[];
        for(const entry of entries)try{const profile=await registry.status(entry.catalog,scope),audit=await auditDecisionJournal(join(root,entry.journal)),report=decisionOperationsReport(entry.catalog,'jev-latest',audit);decisions.push({catalog_id:entry.catalog.id,profile,events:report.events,judgments:report.judgments,labeled:report.labels.valid,journal_errors:report.journal_errors.length,provider:report.provider,by_decision:report.by_decision});}catch(error){decisions.push({catalog_id:entry.catalog.id,profile:{status:'invalid'},error:error instanceof Error&&/^DECISION_[A-Z_]+$/u.test(error.message)?error.message:'DECISION_STATUS_UNAVAILABLE'});}
        return {scope,decisions,mutation_allowed:false,profile_promotion_exposed:false};
      }
      case 'runtime_storage_plan':return this.store.retention(this.config).plan();
      case 'runtime_storage_prune':return this.store.retention(this.config).execute(String(input.plan_sha256));
      case 'runtime_storage_recover_reservations':return ledger.reapDeadOwners();
      case 'runtime_health':{
        const resource_boundary=await resourceHealth(this.config);
        const storage_boundary=ledger.status();
        const model_boundary=this.model instanceof SubscriptionAwareStructuredModel||this.model instanceof ConfiguredStructuredModel?await this.model.status():{mcp_sampling:'unobserved',clients:[],fallback:'configured',credentials_exposed:false};
        const jev=optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment());
        return {health:this.config.environment==='fixture'&&process.platform==='linux'&&resource_boundary.status!=='unavailable_or_changed'&&!['blocked','unavailable'].includes(storage_boundary.status)?'ready':'degraded',verified_for_environment:false,environment:this.config.environment,execution_scope:this.config.packs?'configured_pack_sources_and_targets':this.config.terminal?.files?'configured_fixture_and_owned_cli_scoped_files':this.config.terminal?'configured_fixture_and_owned_cli_protocol':'configured_fixture_only',execution_platform_supported:process.platform==='linux',model_execution_enabled:this.config.terminal!==null||(this.config.packs!==null&&this.config.packs.models!=='off')||Boolean(this.config.swarm?.enabled),autonomous_planning_enabled:Boolean(this.config.swarm?.enabled),
          swarm_boundary:this.config.swarm?{status:this.config.swarm.enabled?'configured':'disabled',planner:'llm_required',max_logical_workers:this.config.swarm.max_logical_workers,max_concurrency:this.config.swarm.max_concurrency,worker_execution:'orchestrator_pull_adapter'}:{status:'not_configured'},pack_boundary:this.config.packs?{status:'connected',sources:this.config.packs.sources.length,targets:this.config.packs.targets.length,models:this.config.packs.models,model_data_approved:this.config.packs.model_data_approved}:{status:'not_connected'},decision_providers:{jev:{status:jev.status,reason:jev.reason},llm:model_boundary,cascade:['mcp_client_subscription','native_client_subscription','configured_fallback','code_validation']},resource_boundary,storage_boundary};
      }
      case 'runtime_capabilities_list':return {capabilities:[draftManifest,terminalManifest].filter(m=>this.config.project.capabilities.includes(m.id))};
      case 'runtime_capability_describe':requireCondition(this.config.project.capabilities.includes(String(input.capability)),'CAPABILITY_NOT_DELEGATED');return input.capability==='coding.session'?terminalManifest:draftManifest;
      case 'runtime_terminal_start':{
        await ensureTerminalHost(this.config);const result=this.store.startSession(this.config,String(input.request_id));
        return {...this.store.terminalStatus(result.session.id),deduplicated:!result.created};
      }
      case 'runtime_terminal_status':return this.store.terminalStatus(String(input.session_ref));
      case 'runtime_terminal_sessions_list':return this.store.sessionPage(this.config.project.id,terminalList.parse(input));
      case 'runtime_terminal_history':return this.store.history(this.config.project.id,terminalHistory.parse(input));
      case 'runtime_terminal_output_read':return readTerminalOutput(this.store,this.config,terminalOutput.parse(input));
      case 'runtime_terminal_handoff':return prepareTerminalHandoff(this.store,this.config,String(input.session_ref),Number(input.expected_generation),Boolean(input.include_diff));
      case 'runtime_terminal_verify':return verifyFiles(this.store,this.config,String(input.session_ref),Number(input.expected_generation),String(input.expected_turn_id),String(input.request_id));
      case 'runtime_terminal_reconcile_files':return this.store.reconcileFiles(this.config,String(input.session_ref),Number(input.expected_generation),path=>new ScopedFiles(this.config).read(path));
      case 'runtime_terminal_submit_prompt':{
        requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(String(input.prompt)),'CREDENTIAL_LIKE_INPUT');
        await ensureTerminalHost(this.config);const result=this.store.submit(this.config,terminalSubmit.parse(input));
        return {...this.store.terminalStatus(String(input.session_ref)),turn_id:result.turn.id,deduplicated:!result.created};
      }
      case 'runtime_terminal_interrupt':this.store.requestInterrupt(String(input.session_ref),Number(input.expected_generation));return this.store.terminalStatus(String(input.session_ref));
      case 'runtime_terminal_resume':{
        await ensureTerminalHost(this.config);const session=this.store.session(String(input.session_ref));
        requireCondition(session.process_identity_json&&await liveness(JSON.parse(session.process_identity_json) as ProcessIdentity)==='dead','CLI_STILL_ALIVE_OR_UNKNOWN');
        this.store.requestResume(session.id,Number(input.expected_generation),this.config);return this.store.terminalStatus(session.id);
      }
      case 'runtime_task_start':{
        const request=startRequest.parse(input);requireCondition(request.account_ref===this.config.project.accountRef,'ACCOUNT_NOT_DELEGATED');
        requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(JSON.stringify(request.input)),'CREDENTIAL_LIKE_INPUT');
        requireCondition(this.config.project.capabilities.includes(request.capability),'CAPABILITY_NOT_DELEGATED');
        await ensureSupervisor(this.config);
        const accepted=this.store.enqueue(this.config.project.id,request.request_id,request.capability,request,this.config.fingerprint);
        return {...this.store.outcome(accepted.task.id),request_id:request.request_id,deduplicated:!accepted.created};
      }
      case 'runtime_task_status':return this.store.outcome(String(input.task_id));
      case 'runtime_task_cancel':this.store.cancel(String(input.task_id));return this.store.outcome(String(input.task_id));
      case 'runtime_recovery_status':return {tasks:this.store.tasks(this.config.project.id).filter(t=>['reconciliation_required','paused_dependency','ready_to_resume'].includes(t.status)).map(t=>this.store.outcome(t.id)),automatic_resume:this.config.recoveryPolicy==='auto_resume'};
      case 'runtime_recovery_prepare':return this.store.prepare(String(input.task_id),Number(input.expected_recovery_generation));
      case 'runtime_task_resume':await ensureSupervisor(this.config);this.store.resume(String(input.task_id),Number(input.expected_recovery_generation),this.config.fingerprint);return this.store.outcome(String(input.task_id));
      case 'runtime_artifacts_list':return {task_id:input.task_id,artifacts:[],supported:false,reason:'NO_ARTIFACT_CAPABILITY_REGISTERED'};
      case 'runtime_events_read':return {events:this.store.events(this.config.project.id,String(input.consumer_id),Number(input.limit))};
      case 'runtime_events_ack':this.store.ack(this.config.project.id,String(input.consumer_id),Number(input.event_id));return {acknowledged:true};
      default:throw Error('NOT_IMPLEMENTED');
    }} catch (e) {failed = true; if(storageError(e)==='STORAGE_FULL')throw Error('STORAGE_FULL',{cause:e});throw e;}
    finally {try {ledger.release(reservation);} catch (e) {if (!failed) throw e;}}
  }
}
