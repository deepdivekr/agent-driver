import {RecoveryStore} from '../supervisor/store.js';
import {ensureSupervisor} from '../supervisor/manager.js';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from './config.js';
import {draftManifest,startRequest,tools} from './catalog.js';
import {intake} from './intake.js';

export class RuntimeApi{
  readonly store:RecoveryStore;
  constructor(readonly config:HostConfig){this.store=new RecoveryStore(config.dbPath);try{this.store.registerProject(config.project);}catch(e){this.store.close();throw e;}}
  close(){this.store.close();}
  private scoped(taskId:string){const task=this.store.task(taskId);requireCondition(task.project_id===this.config.project.id,'TASK_SCOPE_MISMATCH');return task;}
  async call(name:string,args:unknown):Promise<unknown>{
    if(name==='runtime_task_intake')return intake(args);
    requireCondition(Object.hasOwn(tools,name),'UNKNOWN_TOOL');
    const tool=tools[name as keyof typeof tools],input=tool.schema.parse(args) as Record<string,unknown>;
    requireCondition(tool.implemented,'NOT_IMPLEMENTED');
    if('task_id'in input)this.scoped(String(input.task_id));
    switch(name){
      case 'runtime_health':return {health:this.config.environment==='fixture'&&process.platform==='linux'?'ready':'degraded',verified_for_environment:false,environment:this.config.environment,execution_scope:'configured_fixture_only',execution_platform_supported:process.platform==='linux',model_execution_enabled:false};
      case 'runtime_capabilities_list':return {capabilities:this.config.project.capabilities.length?[draftManifest]:[]};
      case 'runtime_capability_describe':requireCondition(this.config.project.capabilities.includes(String(input.capability)),'CAPABILITY_NOT_DELEGATED');return draftManifest;
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
    }
  }
}
