import {PackStore} from '../packs/store.js';
import {FileExplorer} from '../files/explorer.js';
import {FamilyRuntime,PACK_ENGINE_VERSION} from '../packs/runtime.js';
import {CustomPackRegistry} from '../packs/custom-registry.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {CustomPackRepeats,assertCustomPackInvocation,customPackVersionsSchema,customPackWorkBinding} from '../work/custom-pack-repeat.js';
import {sealCollectionContract,assertSealedCollectionRecipe} from '../work/collection-contract.js';
import {workExecutionBinding} from '../work/contracts.js';
import {CustomPackSchedules,assertCustomPackScheduledRun} from '../work/custom-pack-schedule.js';
import {WorkSchedules} from '../work/schedule.js';
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
import {workAutonomy,loadHostConfig,type HostConfig} from './config.js';
import {codingManifest,draftManifest,terminalManifest,startRequest,tools} from './catalog.js';
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
import {safeControlText} from '../observability/safe-text.js';
import {sanitizeSwarmEndpoint} from '../swarm/dashboard.js';
import {SwarmVisualExecutor} from '../swarm/visual-executor.js';
import {ConfiguredStructuredModel} from '../onboarding/configured-model.js';
import {effectiveModelEnvironment,modelSettingsPath,readModelSettings} from '../onboarding/model-settings.js';
import {WorkRuntime} from '../work/runtime.js';
import {workControlSchema,workExecuteSchema,workStartSchema} from '../work/contracts.js';
import {type WorkSupervisor} from '../work/supervisor.js';
import {WorkResults,workResultGetSchema,workResultsListSchema} from '../work/results.js';
import {WorkDeliverySettings} from '../work/delivery-settings.js';
import {SEMANTIC_DECISION_CATALOG} from '../decision-plane/semantic.js';
import {WorkImportRuntime} from '../work/import-runtime.js';
import {workImportExecutionOwner} from '../work/import-authority.js';
import {assertWorkConnected} from '../work/lifecycle.js';
import {CodingRuntime,type CodingRuntimeOptions} from '../coding/runtime.js';
import {CodingDialogRuntime} from '../coding/conversation.js';
import {codingTools} from '../coding/contracts.js';
import {HermesMigrationRuntime,migrationPreview} from '../work/hermes-migration.js';
import {RemoteOffice,remotePropose,remoteDiscover} from '../work/remote.js';
import {z} from 'zod';
import {WindowsWorkflowRuntime,type WindowsRuntimeOptions} from '../desktop/windows-runtime.js';
import {CuaFieldDriver} from '../desktop/cua-field-driver.js';
import {CuaDesktopDriver} from '../desktop/cua-desktop-driver.js';
import {WorkflowCompatibility} from '../integrations/workflow-compatibility.js';
import {WINDOWS_DECISION_CATALOG} from '../desktop/windows-decision.js';
import {browserCatalog,BROWSER_DECISION_CATALOG,inspectBrowserTargets} from '../browser/executor-routing.js';
import {RoutedSwarmBrowser} from '../swarm/routed-browser.js';

export type SwarmBrowserCommand={action:'navigate';url:string}|{action:'observe'}|{action:'scroll';direction:'up'|'down'};
export interface SwarmVisualAdapter{
  assign(runId:string,workerId:string,leaseToken:string):Promise<{surface_id:string;kind:'browser'}>;
  perform(runId:string,workerId:string,leaseToken:string,command:SwarmBrowserCommand):Promise<unknown>;
  release(runId:string,workerId:string):Promise<void>;
  close():Promise<void>;
}
type SwarmDispatch=Awaited<ReturnType<SwarmRuntime['tick']>>['dispatches'][number];
export interface RuntimeApiOptions {channelTransport?:JevSystemOneTransport;approval?:PackApprovalDispatcher;swarmModel?:StructuredModel;swarmJev?:JevSystemOneTransport;swarmProviders?:SwarmRuntimeProviders;swarmVisual?:SwarmVisualAdapter;coding?:CodingRuntimeOptions;windows?:WindowsRuntimeOptions;}

export class RuntimeApi{
  readonly workflowCompatibility:WorkflowCompatibility;
  readonly store:PackStore;
  readonly files:FileExplorer;
  readonly windows:WindowsWorkflowRuntime;
  readonly packs:FamilyRuntime;
  readonly customPacks:CustomPackRegistry;
  readonly customPackRepeats:CustomPackRepeats;
  readonly customPackSchedules:CustomPackSchedules;
  readonly work:WorkRuntime;
  readonly workResults:WorkResults;
  readonly imports:WorkImportRuntime;
  readonly migrations:HermesMigrationRuntime;
  readonly remote:RemoteOffice;
  readonly coding:CodingRuntime;
  readonly codingDialog:CodingDialogRuntime;
  readonly swarm:SwarmRuntime;
  readonly visual:SwarmVisualAdapter|null;
  private closing:Promise<void>|null=null;
  private closed=false;
  private model:StructuredModel;
  private explicitProviders:boolean;
  private workSupervisor:WorkSupervisor|null=null;
  private workSupervisorLoading:Promise<WorkSupervisor>|null=null;
  private workSupervisorStopping:Promise<void>|null=null;
  private workAdmissionClosed=false;
  private readonly deliveryJobs=new Map<string,Promise<void>>();
  private readonly deliveryRecoveryTimer:NodeJS.Timeout;
  constructor(readonly config:HostConfig,readonly options:RuntimeApiOptions={}){
    this.workflowCompatibility=new WorkflowCompatibility(config);
    this.store=new PackStore(config.dbPath);try{this.store.registerProject(config.project);}catch(e){this.store.close();throw e;}
    this.workResults=new WorkResults(this.store,[],WorkDeliverySettings.fromConfig(config));
    this.files=this.store.localFileExplorer(config.project.id,dirname(config.dbPath));
    this.model=options.swarmModel??new ConfiguredStructuredModel(modelSettingsPath(config),process.env,{},event=>{this.store.recordClientHandoff(config.project.id,event);});
    const windowsDriver=options.windows?.driver??(config.windowsExecutor?(config.windowsExecutor.kind==='cua-desktop'?new CuaDesktopDriver(config.windowsExecutor,this.store.desktopState):new CuaFieldDriver(config.windowsExecutor,this.store.desktopState)):undefined);
    this.windows=new WindowsWorkflowRuntime(this.store,config,{...options.windows,
      ...(windowsDriver?{driver:windowsDriver}:{}),llm:options.windows?.llm??this.model});
    this.work=new WorkRuntime(this.store,config,this.model,()=>{const native=this.windows.catalog();return {browser_executors:browserCatalog(this.config),windows:{connection:native.native_executor,dynamic_planning:native.dynamic_planning,profiles_required:false}};},(id,input,created)=>{if(created)this.workResults.setSelection(config.project.id,id,{revision:0,target_ids:input.delivery_target_ids??this.workResults.settings!.publicState().default_target_ids});});
    this.imports=new WorkImportRuntime(this.store,config,this.model);
    this.migrations=new HermesMigrationRuntime(this.store,config);
    this.remote=new RemoteOffice(this.store,config);
    this.coding=new CodingRuntime(this.store,config,this.model,options.coding);
    this.codingDialog=new CodingDialogRuntime(this.store,config,this.model,options.coding);
    this.packs=new FamilyRuntime(this.store,config,{approval:options.approval??new LocalApprovalDispatcher(this.store),llm:this.model});
    this.customPacks=new CustomPackRegistry(this.store);
    this.customPackRepeats=new CustomPackRepeats(this.store,this.customPacks,(work,prepared)=>{
      sealCollectionContract(this.store,config,work.id,work.spec as import('../work/contracts.js').WorkProposal);
      this.workResults.setSelection(config.project.id,work.id,{revision:0,target_ids:prepared.completion_contract.delivery_target_ids??this.workResults.settings!.publicState().default_target_ids});
    });
    this.customPackSchedules=new CustomPackSchedules(this.store,config.project.id,this.customPacks,this.customPackRepeats,new WorkSchedules(this.store,config.project.id));
    let jev=options.swarmJev;if(!jev&&config.swarm?.enabled)jev=optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment()).transport??undefined;
    this.explicitProviders=options.swarmProviders!==undefined;
    this.swarm=new SwarmRuntime(this.store,config,options.swarmProviders??{planner:new LlmSwarmPlanner(this.model),llm_fallback:new LlmSwarmDecisionFallback(this.model),...(jev?{decision:{id:'typesafe-jev',systemOne:(request,settings)=>jev!.systemOne(request,settings)}}:{})});
    this.visual=config.swarm?.enabled&&config.swarm.visual.enabled?(options.swarmVisual??(config.browserExecutors?new RoutedSwarmBrowser(this.store,config,()=>{
      const saved=readModelSettings(modelSettingsPath(config)),approved=config.swarm?.model_data_approved===true,allowed=approved&&saved?.selection.jev!=='off';
      return {jev:allowed?(options.swarmJev??optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment()).transport??undefined):undefined,llm:approved?this.model:undefined};
    }):new SwarmVisualExecutor(this.store,config))):null;
    this.deliveryRecoveryTimer=setInterval(()=>this.recoverPendingDeliveries(),3_000);
    this.deliveryRecoveryTimer.unref();
    queueMicrotask(()=>this.recoverPendingDeliveries());
  }
  attachClientSampling(sampling:McpSamplingStructuredModel){
    if(this.explicitProviders)return;
    if(this.options.swarmModel)return;
    for(const model of [this.model,this.coding.model,this.codingDialog.model])if(model instanceof ConfiguredStructuredModel)model.sampling=sampling;
    this.packs.providers.llm=this.model;this.swarm.providers.planner=new LlmSwarmPlanner(this.model);this.swarm.providers.llm_fallback=new LlmSwarmDecisionFallback(this.model);
  }
  private modelEnvironment(){return effectiveModelEnvironment(readModelSettings(modelSettingsPath(this.config)));}
  private customPackHostBinding(){
    requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    return {config_fingerprint:this.config.fingerprint,engine_binding:snapshotHash({config:this.config.fingerprint,engine:PACK_ENGINE_VERSION})};
  }
  private recoverPendingDeliveries(){
    if(this.closed||this.workAdmissionClosed||this.deliveryJobs.size>=4)return;
    try{for(const workId of this.workResults.pendingWorkIds(this.config.project.id,4-this.deliveryJobs.size))this.dispatchWorkPending(workId);}catch{/* Malformed stored settings cannot grant delivery authority. */}
  }
  private dispatchWorkPending(workId:string){
    if(this.closed||this.workAdmissionClosed||this.deliveryJobs.has(workId))return;
    const job=this.workResults.dispatchPending(this.config.project.id,workId,()=>!this.closed&&!this.workAdmissionClosed).then(()=>undefined).catch(()=>undefined).finally(()=>this.deliveryJobs.delete(workId));this.deliveryJobs.set(workId,job);
  }
  private deliverWorkOutput(workId:string){
    this.workResults.capture(this.config.project.id,workId);
    this.dispatchWorkPending(workId);
  }
  /** Execution/control imports the operating loop lazily; status and ordinary tools never start its timer. */
  private async supervisedWork(){
    requireCondition(!this.closed,'RUNTIME_API_CLOSED');requireCondition(!this.workAdmissionClosed,'WORK_SUPERVISOR_CLOSED');
    if(this.workSupervisor)return this.workSupervisor;
    if(!this.workSupervisorLoading){
      const loading=import('../work/supervisor.js').then(({WorkSupervisor})=>{
        requireCondition(!this.closed,'RUNTIME_API_CLOSED');requireCondition(!this.workAdmissionClosed,'WORK_SUPERVISOR_CLOSED');
        const supervisor=new WorkSupervisor(this.store,this.config,this.model,{api:this,auto_start:false,onResult:workId=>this.deliverWorkOutput(workId)});this.workSupervisor=supervisor;return supervisor;
      });
      this.workSupervisorLoading=loading;
    }
    try{return await this.workSupervisorLoading;}catch(error){this.workSupervisorLoading=null;throw error;}
  }
  private stopSupervisedWork(){
    this.workAdmissionClosed=true;
    if(!this.workSupervisorStopping){
      // close() synchronously fences the loop before its first await, preserving any completed in-flight receipt.
      this.workSupervisorStopping=this.workSupervisor?this.workSupervisor.close():this.workSupervisorLoading?this.workSupervisorLoading.then(supervisor=>supervisor.close(),()=>{}):Promise.resolve();
    }
    return this.workSupervisorStopping;
  }
  close(){
    if(this.closed)return;this.closed=true;clearInterval(this.deliveryRecoveryTimer);const workClosing=this.stopSupervisedWork();this.packs.close();this.coding.close();this.codingDialog.close();this.windows.close();
    this.closing=(async()=>{await workClosing;await Promise.allSettled([...this.deliveryJobs.values()]);await this.workflowCompatibility.drain();await this.windows.drain();await this.packs.drain();await this.coding.drain();await this.codingDialog.drain();await this.remote.drain();if(this.visual)await this.visual.close();this.store.close();})().catch(()=>{process.exitCode=1;this.store.close();});
  }
  async drain(){
    // Start admission fences together, before yielding to any one runtime.
    await Promise.all([this.stopSupervisedWork(),this.workflowCompatibility.drain(),this.windows.drain(),this.packs.drain(),this.coding.drain(),this.codingDialog.drain(),this.remote.drain()]);
    await Promise.allSettled([...this.deliveryJobs.values()]);
    if(this.closing)await this.closing;
  }
  private async releaseFinishedVisuals(runId:string){
    if(!this.visual)return;
    const status=this.swarm.status(runId);
    await Promise.all(status.workers.filter(worker=>worker.status!=='leased'||!['running','needs_human'].includes(status.status)).map(worker=>this.visual!.release(runId,worker.id)));
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
      // These leases were already admitted. A sibling's allocation failure
      // must not hide healthy dispatches from the client or orphan their work.
      const failedIds=new Set(failures.map(failure=>failure.worker_id));
      const admitted=dispatches.filter(dispatch=>!failedIds.has(dispatch.worker_id));
      return {...result,status:this.swarm.status(runId).status,dispatches:admitted,dispatch:admitted[0]??null,visual_failures:failures,next_action:'inspect_visual_executor_failure'};
    }
    return {...result,dispatches,dispatch:dispatches[0]??null};
  }
  private scoped(taskId:string){const task=this.store.task(taskId);requireCondition(task.project_id===this.config.project.id,'TASK_SCOPE_MISMATCH');return task;}
  /** Detachment is an Office admission fence, not a command to its original bot. */
  private assertWorkToolConnection(name:string,args:unknown){
    const tool=tools[name as keyof typeof tools];
    if(!tool||tool.readOnly&&name!=='runtime_pack_plan'&&name!=='runtime_work_remote_refresh'&&!name.startsWith('runtime_files_'))return;
    const input=tool.schema.parse(args) as Record<string,unknown>,workIds=new Set<string>();
    if(typeof input.work_id==='string')workIds.add(input.work_id);
    if(typeof input.run_id==='string'){
      const kind=name.startsWith('runtime_swarm_')?'swarm':name.startsWith('runtime_pack_')?'pack':name.startsWith('runtime_coding_')?'coding':null;
      if(kind){const bound=this.store.officeWork(this.config.project.id,kind,input.run_id) as {id:string}|null;if(bound)workIds.add(bound.id);}
      if(name.startsWith('runtime_windows_')){const bound=this.store.desktopState.prepare('SELECT work_id FROM windows_workflow_run WHERE project_id=? AND id=?').get(this.config.project.id,input.run_id);if(bound)workIds.add(String(bound.work_id));}
    }
    if(name.startsWith('runtime_coding_')&&typeof input.dialog_id==='string'){const bound=this.store.officeWork(this.config.project.id,'coding_dialog',input.dialog_id) as {id:string}|null;if(bound)workIds.add(bound.id);}
    for(const id of workIds)assertWorkConnected(this.store,this.config.project.id,id);
  }
  async call(name:string,args:unknown):Promise<unknown>{
    requireCondition(!this.closed,'RUNTIME_API_CLOSED');
    this.assertWorkToolConnection(name,args);
    if(name.startsWith('runtime_custom_pack_')){
      switch(name){
        case 'runtime_custom_pack_list':z.object({}).strict().parse(args);return {packs:this.customPacks.list(this.config.project.id),result_reuse:false};
        case 'runtime_custom_pack_versions':{const input=customPackVersionsSchema.parse(args);return {key:input.key,versions:this.customPacks.versions(this.config.project.id,input.key)};}
        case 'runtime_custom_pack_publish':return this.customPacks.publishVerified(this.config.project.id,args,this.customPackHostBinding());
        case 'runtime_custom_pack_schedule_configure':{
          requireCondition(!this.workAdmissionClosed,'WORK_SUPERVISOR_CLOSED');
          const result=this.customPackSchedules.configure(args,this.customPackHostBinding());
          const supervisor=await this.supervisedWork();supervisor.activate();
          return result;
        }
        case 'runtime_custom_pack_schedule_status':return this.customPackSchedules.status(z.object({parent_work_id:z.string().uuid()}).strict().parse(args).parent_work_id);
        case 'runtime_custom_pack_schedule_disable':return this.customPackSchedules.disable(args);
        case 'runtime_custom_pack_prepare_repeat':{
          requireCondition(!this.workAdmissionClosed,'WORK_SUPERVISOR_CLOSED');
          const result=this.customPackRepeats.prepare(this.config.project.id,args,this.customPackHostBinding(),prepared=>{
            const targetIds=prepared.completion_contract.delivery_target_ids??this.workResults.settings!.publicState().default_target_ids;
            requireCondition(targetIds.every(id=>id==='app'||this.workResults.settings?.target(id)),'RESULT_DELIVERY_TARGET_UNAVAILABLE');
          });
          return {...result.prepared,work_id:result.work.id,revision:result.work.revision,execution_binding:workExecutionBinding(result.work),work:this.work.status({work_id:result.work.id}),created:result.created,execution_started:false,schedule_enabled:false,execute_arguments:{work_id:result.work.id,revision:result.work.revision,executor:'client',current_run_only:true,cost_acknowledged:false},next_action:'runtime_work_execute',next_cycle:'runtime_custom_pack_prepare_repeat_with_new_cycle_id'};
        }
        default:throw Error('UNKNOWN_TOOL');
      }
    }
    if(name.startsWith('runtime_workflow_'))return this.workflowCompatibility.call(name,args);
    if(name.startsWith('runtime_windows_'))return this.windows.call(name,args);
    if(name.startsWith('runtime_files_'))return this.files.call(name,args);
      if(name.startsWith('runtime_work_')){
        switch(name){
          case 'runtime_work_remote_targets':z.object({}).strict().parse(args);return this.remote.targets().map(t=>({id:t.id,name:t.name,provider:'openclaw'}));
          case 'runtime_work_remote_discover':return this.remote.discover(remoteDiscover.parse(args));
          case 'runtime_work_remote_status':return this.remote.status(z.object({work_id:z.string().uuid()}).strict().parse(args).work_id);
          case 'runtime_work_remote_refresh':return this.remote.refresh(z.object({work_id:z.string().uuid()}).strict().parse(args).work_id);
          case 'runtime_work_remote_propose':return this.remote.propose(remotePropose.parse(args));
        case 'runtime_work_migration_discover':return this.migrations.discover(z.object({offset:z.number().int().min(0).max(10000).optional()}).strict().parse(args));
        case 'runtime_work_migration_preview':return this.migrations.preview(migrationPreview.omit({home:true}).parse(args));
        case 'runtime_work_migration_status':return this.migrations.status(args);
        case 'runtime_work_import_prompt':return this.imports.prompt();
        case 'runtime_work_import_paste':return this.imports.paste(args);
        case 'runtime_work_import_status':return this.imports.status(args);
        case 'runtime_work_import_scan':{
          const input=args as {project_ref?:unknown;scope?:string};
          const item=this.config.coding?.projects.find(project=>project.id===input.project_ref);
          requireCondition(item,'WORK_IMPORT_PROJECT_NOT_REGISTERED');
          return this.imports.scan({path:item.root,...(input.scope!==undefined?{scope:input.scope}:{})});
        }
        case 'runtime_work_start':{
          const input=workStartSchema.parse(args),targetIds=input.delivery_target_ids??this.workResults.settings!.publicState().default_target_ids;
          requireCondition(targetIds.every(id=>id==='app'||this.workResults.settings?.target(id)),'RESULT_DELIVERY_TARGET_UNAVAILABLE');
          const started=await this.work.start(input);
          // Delegated autonomy (plan B1): a Work the owner's agent submits runs to its result in the same call;
          // no second runtime_work_execute round trip. Per-run installs keep the two-step admission.
          if(workAutonomy(this.config)!=='delegated'||started.definition_status!=='ready'||started.paused)return started;
          try{const admission=(await this.supervisedWork()).start(started.work_id,started.revision,true,undefined,false);return {...this.work.status({work_id:started.work_id}),admission:{requested:true,...admission},autonomy:'delegated'};}
          catch(error){return {...started,admission:{requested:true,accepted:false,reason:error instanceof Error&&/^[A-Z][A-Z0-9_]{1,100}$/u.test(error.message)?error.message:'WORK_EXECUTION_REQUEST_FAILED'},autonomy:'delegated'};}
        }
        case 'runtime_work_define':return this.work.define(args);
        case 'runtime_work_answer':return this.work.answer(args);
        case 'runtime_work_execute':{
          const input=workExecuteSchema.parse(args);requireCondition(input.executor==='client','WORK_EXECUTOR_CHANGED');
          requireCondition(input.cost_acknowledged||workAutonomy(this.config)==='delegated','WORK_MODEL_USAGE_CONSENT_REQUIRED');
          requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
          // Invalid admission must not allocate a timer or awaken another queued Work.
          const work=this.store.intakeWork(this.config.project.id,input.work_id);
          const custom=assertCustomPackInvocation(this.store,this.config.project.id,work.id,'runtime_work_execute',{},this.customPackHostBinding());
          requireCondition(!custom||input.current_run_only,'CUSTOM_PACK_NEW_CYCLE_REQUIRED');
          if(custom)assertCustomPackScheduledRun(this.store,this.config.project.id,work.id,this.customPackHostBinding());
          requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');
          requireCondition(!work.paused&&work.spec&&['ready','running'].includes(work.status),'WORK_NOT_READY');
          requireCondition(workImportExecutionOwner(this.store,this.config.project.id,input.work_id)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
          const supervisor=await this.supervisedWork();return supervisor.start(input.work_id,input.revision,input.cost_acknowledged||workAutonomy(this.config)==='delegated',input.timezone,input.current_run_only);
        }
        case 'runtime_work_control':{
          const input=workControlSchema.parse(args);requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
          const work=this.store.intakeWork(this.config.project.id,input.work_id);requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');
          if(input.action==='resume'||input.action==='retry')requireCondition(workImportExecutionOwner(this.store,this.config.project.id,input.work_id)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
          const supervisor=await this.supervisedWork(),result=supervisor.action(input);
          // Pause/edit remain passive. Explicit resume/retry continues the
          // already approved durable run even when this MCP session is new.
          // SQLite leases prevent it from duplicating another live owner.
          if(input.action==='resume'||input.action==='retry')supervisor.activate();
          return result;
        }
        case 'runtime_work_status':{const result=this.work.status(args);return {...result,windows_runs:this.windows.forWork(z.object({work_id:z.string().uuid()}).passthrough().parse(args).work_id)};}
        case 'runtime_work_results':{const input=workResultsListSchema.parse(args);return {work_id:input.work_id,results:this.workResults.list(this.config.project.id,input.work_id,input.limit)};}
        case 'runtime_work_result':{const input=workResultGetSchema.parse(args);return this.workResults.get(this.config.project.id,input.work_id,input.result_id);}
        case 'runtime_work_context':return this.packs.context(args);
        case 'runtime_work_list':return this.work.list(args);
        case 'runtime_work_pause':return this.work.pause(args);
        default:throw Error('UNKNOWN_TOOL');
      }
    }
    if(name.startsWith('runtime_coding_')){
      switch(name){
        case 'runtime_coding_projects':return this.coding.projects(args);
        case 'runtime_coding_last':return this.coding.last(args);
        case 'runtime_coding_start':return this.coding.start(args);
        case 'runtime_coding_step':return this.coding.step(args);
        case 'runtime_coding_status':return this.coding.status(args);
        case 'runtime_coding_pause':return this.coding.pause(args);
        case 'runtime_coding_reconcile':return this.coding.reconcile(args);
        case 'runtime_coding_dialog_sessions':return this.codingDialog.sessions(args);
        case 'runtime_coding_dialog_attach':return this.codingDialog.attach(args);
        case 'runtime_coding_dialog_turn':return this.codingDialog.turn(args);
        case 'runtime_coding_dialog_status':return this.codingDialog.status(args);
        case 'runtime_coding_dialog_stop':return this.codingDialog.stop(args);
        case 'runtime_coding_dialog_reconcile':return this.codingDialog.reconcile(codingTools.runtime_coding_dialog_reconcile.schema.parse(args));
        default:throw Error('UNKNOWN_TOOL');
      }
    }
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
      const tool=tools[name as keyof typeof tools];requireCondition(tool,'UNKNOWN_TOOL');
      const input=tool.schema.parse(args) as Record<string,unknown>;
      const explicitOwner=typeof input.work_id==='string'?input.work_id:undefined;
      const runOwner=typeof input.run_id==='string'?(this.store.officeWork(this.config.project.id,'pack',input.run_id) as {id:string}|null)?.id:undefined;
      const inferredOwners=new Set<string>(runOwner?[runOwner]:[]);
      // PackStore also binds calls without work_id by the canonical request.
      // Resolve that same authority before custom-version preflight so omitting
      // a redundant work_id cannot sidestep the immutable contract gate.
      if(name==='runtime_pack_run'&&typeof input.request_id==='string'){
        const intake=this.store.hermesState.prepare('SELECT work_id FROM office_intake WHERE project_id=? AND request_id=?').get(this.config.project.id,input.request_id);
        if(intake)inferredOwners.add(String(intake.work_id));
        const prior=this.store.hermesState.prepare('SELECT id FROM family_run WHERE project_id=? AND request_id=?').get(this.config.project.id,input.request_id);
        const bound=prior?this.store.officeWork(this.config.project.id,'pack',String(prior.id)) as {id:string}|null:null;
        if(bound)inferredOwners.add(bound.id);
      }
      requireCondition(inferredOwners.size<=1&&(!explicitOwner||[...inferredOwners].every(owner=>owner===explicitOwner)),'WORK_RUN_BINDING_CONFLICT');
      const owner=explicitOwner??inferredOwners.values().next().value;
      const candidate=owner?customPackWorkBinding(this.store,this.config.project.id,owner):null;
      const historicalOrPause=name==='runtime_pack_status'||name==='runtime_pack_events'||name==='runtime_pack_watch_pause'&&input.paused===true;
      if(name==='runtime_pack_run'&&typeof input.request_id==='string'){
        const expected=this.store.hermesState.prepare('SELECT 1 FROM office_custom_pack_cycle WHERE project_id=? AND request_id=?').get(this.config.project.id,input.request_id);
        requireCondition(!expected||owner&&candidate,'CUSTOM_PACK_WORK_BINDING_MISSING');
      }
      const host=candidate&&!historicalOrPause?this.customPackHostBinding():undefined;
      const binding=owner?assertCustomPackInvocation(this.store,this.config.project.id,owner,name,input,host):null;
      if(owner&&name==='runtime_pack_run'&&this.store.hermesState.prepare('SELECT 1 FROM office_intake WHERE project_id=? AND work_id=?').get(this.config.project.id,owner)){
        assertSealedCollectionRecipe(this.store,this.config,owner,input.recipe as import('../packs/contracts.js').Recipe);
      }
      if(binding&&owner&&host)assertCustomPackScheduledRun(this.store,this.config.project.id,owner,host);
      const ledger=this.store.storage(this.config),writes=['runtime_pack_run','runtime_pack_execute_approved','runtime_pack_watch_tick'].includes(name),reservation=writes?ledger.reserve('pack_execution',16_777_216):null;
      let failed=false;try{
        const result=await this.packs.call(name,input);
        if(binding&&name==='runtime_pack_plan')return {...result as Record<string,unknown>,status:'ready_to_run',procedure_state:'ready',original_work_verified:true,completion_verified:false,cache_hit:false,recipe:binding.recipe,custom_pack:{key:binding.key,version:binding.version,cycle_id:binding.cycle_id,parameters:binding.parameters,immutable:true,result_reuse:false},next_action:'runtime_pack_run_with_execution_binding'};
        if(name==='runtime_pack_plan')return {...result as Record<string,unknown>,procedure_state:'draft',original_work_verified:false,completion_verified:false,reuse_scope:'unverified_family_recipe_hint'};
        if(name==='runtime_pack_catalog')return {...result as Record<string,unknown>,custom_packs:{ready:this.customPacks.list(this.config.project.id),legacy_recipe_state:'draft',ready_requires:'independently_verified_original_work',execution:'prepare_repeat_then_normal_work_execution'}};
        return result;
      }catch(e){failed=true;if(storageError(e)==='STORAGE_FULL')throw Error('STORAGE_FULL',{cause:e});throw e;}
      finally{try{ledger.release(reservation);}catch(e){if(!failed)throw e;}}
    }
    if(name.startsWith('runtime_swarm_')){
      const tool=swarmTools[name as keyof typeof swarmTools];requireCondition(tool,'UNKNOWN_TOOL');const input=tool.schema.parse(args) as Record<string,unknown>,writes=!tool.readOnly,reservation=writes?this.store.storage(this.config).reserve('swarm_execution',4_194_304):null;let failed=false;
      try{switch(name){
        case 'runtime_swarm_start':{
          const args=[String(input.request_id),String(input.goal),input.context as Record<string,string|number|boolean|null>,input.mode as 'standard'] as const;
          const result=input.work_id===undefined?await this.swarm.start(...args):await this.swarm.start(...args,String(input.work_id));
          return this.visual?await this.attachVisualDispatches(result,result.run.run_id):result;
        }
        case 'runtime_swarm_plan':return this.swarm.plan(String(input.goal),input.context as Record<string,string|number|boolean|null>);
        case 'runtime_swarm_replan':return this.swarm.replan(String(input.run_id),String(input.reason));
        case 'runtime_swarm_recover':return this.swarm.recover(String(input.run_id));
        case 'runtime_swarm_run':return input.work_id===undefined?this.swarm.run(String(input.request_id),String(input.plan_id)):this.swarm.run(String(input.request_id),String(input.plan_id),String(input.work_id));
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
      case 'runtime_browser_executors':return {executors:input.probe?await inspectBrowserTargets(this.config,input.target_id as string|undefined):browserCatalog(this.config).filter(t=>!input.target_id||t.id===input.target_id),permissions_granted:false};
      case 'runtime_activity_report':{
        const report=runtimeActivityReport.parse(input),endpoint=report.activity.endpoint?sanitizeSwarmEndpoint(report.activity.endpoint):null;
        if(report.activity.surface_id)requireCondition(this.config.observability?.surfaces.some(surface=>surface.id===report.activity.surface_id),'CONTROL_SURFACE_UNDELEGATED');
        const activity_id=this.store.recordRuntimeActivity(this.config.project.id,report.owner_kind,report.owner_id,report.actor_id,report.activity.kind,safeControlText(report.activity.summary,500),endpoint,new Date().toISOString(),report.activity.surface_id??null,report.activity.decision_layer??null);
        return {activity_id,recorded:true,authority_granted:false,completion_verified:false};
      }
      case 'runtime_storage_status':return ledger.status();
      case 'runtime_decision_status':{
        const root=join(dirname(this.config.dbPath),'decisions'),registry=new DecisionProfileRegistry(join(root,'registry')),scope=this.config.environment==='fixture'?'fixture' as const:'production' as const,entries=[{catalog:ROW_DECISION_CATALOG,journal:'family.jsonl'},{catalog:ONE_LINE_DECISION_CATALOG,journal:'intake.jsonl'},{catalog:ADAPTIVE_DECISION_CATALOG,journal:'adaptive.jsonl'},{catalog:SWARM_DECISION_CATALOG,journal:'swarm.jsonl'},{catalog:WINDOWS_DECISION_CATALOG,journal:'windows.jsonl'},{catalog:SEMANTIC_DECISION_CATALOG,journal:'semantic.jsonl'},{catalog:BROWSER_DECISION_CATALOG,journal:'browser.jsonl'}],decisions=[];
        for(const entry of entries)try{const profile=await registry.status(entry.catalog,scope),audit=await auditDecisionJournal(join(root,entry.journal)),report=decisionOperationsReport(entry.catalog,'jev-latest',audit);decisions.push({catalog_id:entry.catalog.id,profile,events:report.events,judgments:report.judgments,labeled:report.labels.valid,journal_errors:report.journal_errors.length,provider:report.provider,by_decision:report.by_decision});}catch(error){decisions.push({catalog_id:entry.catalog.id,profile:{status:'invalid'},error:error instanceof Error&&/^DECISION_[A-Z_]+$/u.test(error.message)?error.message:'DECISION_STATUS_UNAVAILABLE'});}
        return {scope,decisions,memory:this.store.decisionMemory.summary(this.config.project.id),mutation_allowed:false,profile_promotion_exposed:false};
      }
      case 'runtime_storage_plan':return this.store.retention(this.config).plan();
      case 'runtime_storage_prune':return this.store.retention(this.config).execute(String(input.plan_sha256));
      case 'runtime_storage_recover_reservations':return ledger.reapDeadOwners();
      case 'runtime_health':{
        const resource_boundary=await resourceHealth(this.config);
        const storage_boundary=ledger.status();
        const model_boundary=this.model instanceof SubscriptionAwareStructuredModel||this.model instanceof ConfiguredStructuredModel?await this.model.status():{mcp_sampling:'unobserved',clients:[],fallback:'configured',credentials_exposed:false};
        const jev=optionalTypeSafeTransportFromHostEnvironment(this.modelEnvironment());
        return {health:this.config.environment==='fixture'&&process.platform==='linux'&&resource_boundary.status!=='unavailable_or_changed'&&!['blocked','unavailable'].includes(storage_boundary.status)?'ready':'degraded',verified_for_environment:false,environment:this.config.environment,execution_scope:this.config.coding?'configured_coding_projects':this.config.packs?'configured_pack_sources_and_targets':this.config.terminal?.files?'configured_fixture_and_owned_cli_scoped_files':this.config.terminal?'configured_fixture_and_owned_cli_protocol':'configured_fixture_only',execution_platform_supported:process.platform==='linux'||process.platform==='win32',model_execution_enabled:this.config.terminal!==null||(this.config.packs!==null&&this.config.packs.models!=='off')||Boolean(this.config.swarm?.enabled)||Boolean(this.config.coding?.model_data_approved),autonomous_planning_enabled:Boolean(this.config.swarm?.enabled||this.config.coding?.model_data_approved),
          swarm_boundary:this.config.swarm?{status:this.config.swarm.enabled?'configured':'disabled',planner:'llm_required',max_logical_workers:this.config.swarm.max_logical_workers,max_concurrency:this.config.swarm.max_concurrency,worker_execution:'orchestrator_pull_adapter'}:{status:'not_configured'},pack_boundary:this.config.packs?{status:'connected',sources:this.config.packs.sources.length,targets:this.config.packs.targets.length,models:this.config.packs.models,model_data_approved:this.config.packs.model_data_approved}:{status:'not_connected'},decision_providers:{jev:{status:jev.status,reason:jev.reason},llm:model_boundary,cascade:['mcp_client_subscription','native_client_subscription','configured_fallback','code_validation']},resource_boundary,storage_boundary};
      }
      case 'runtime_capabilities_list':return {capabilities:[draftManifest,terminalManifest,codingManifest].filter(m=>this.config.project.capabilities.includes(m.id))};
      case 'runtime_capability_describe':requireCondition(this.config.project.capabilities.includes(String(input.capability)),'CAPABILITY_NOT_DELEGATED');return input.capability==='coding.session'?terminalManifest:input.capability==='coding.orchestrate'?codingManifest:draftManifest;
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
