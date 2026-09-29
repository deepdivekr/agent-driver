import {randomUUID} from 'node:crypto';
import {type PackStore} from '../packs/store.js';
import {FamilyRuntime} from '../packs/runtime.js';
import {recipeSchema} from '../packs/contracts.js';
import {loadHostConfig,workModelDataApproved,type HostConfig} from '../interface/config.js';
import {type StructuredModel} from '../taskpack/adaptive-spec.js';
import {requireCondition} from '../core/contracts.js';
import {workExecutionBinding,workExecuteSchema,type WorkProposal} from './contracts.js';
import {initWorkExecution,executionRecord,workActivity,workObservation} from './activity.js';
import {importedConnectionReadiness} from './import-runtime.js';
import {type HermesWorkRuntime,bindIntakeHermes} from './hermes.js';
import {modelSettingsPath,readModelSettings} from '../onboarding/model-settings.js';
import {WorkSupervisor,supervisorStatus} from './supervisor.js';
import {workImportExecutionOwner} from './import-authority.js';

export {workExecuteSchema} from './contracts.js';
const readFamilies=new Set(['research.search','portal.collect','file.pipeline','inbox.triage','monitor.watch']);
export function workDispatchOptions(store:PackStore,config:HostConfig,id:string){
  const work=store.intakeWorkOptional(config.project.id,id),spec=work?.spec as WorkProposal|null;
  const latest=store.officeRuns(config.project.id,id)[0];
  const observation=workObservation(store,config.project.id,id,latest?.source_kind==='pack'?store.packRun(config.project.id,latest.source_id).status:work?.status??'unobserved');
  const unavailable=(reason:string)=>({can_execute:false,executor:null,reason,model_usage:false});
  if(!work)return unavailable('LEGACY_RUN_REQUIRES_ORCHESTRATOR');
  if(importedConnectionReadiness(store,config,id))return unavailable('ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
  if(workImportExecutionOwner(store,config.project.id,id)==='original_runtime')return unavailable('USE_EXISTING_RUNTIME_CONTROL');
  if(work.paused)return unavailable('WORK_PAUSED');
  if(!['ready','running'].includes(work.status)||!spec)return unavailable('WORK_DEFINITION_REQUIRED');
  if(observation.live)return unavailable('WORK_ALREADY_EXECUTING');
  const supervisor=supervisorStatus(store,config.project.id,id);
  if(supervisor)return unavailable('WORK_USE_EXISTING_EXECUTION_CONTROL');
  if(latest&&latest.source_kind!=='pack')return unavailable('USE_EXISTING_RUNTIME_CONTROL');
  if(latest){const run=store.packRun(config.project.id,latest.source_id);if(!['running','retryable_failure','waiting_auth','paused_work','paused_config'].includes(run.status))return unavailable('RUN_RESULT_REQUIRES_REVIEW');if('target' in run.recipe)return unavailable('USE_EXISTING_RUNTIME_CONTROL');}
  const officeManaged=Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get());
  if(!officeManaged&&spec.route.kind==='pack'&&readFamilies.has(spec.route.pack_family??'')&&config.packs?.sources.length)return {can_execute:true,executor:'pack',reason:null,model_usage:!latest};
  if(latest)return unavailable('PACKS_NOT_CONNECTED');
  return {can_execute:true,executor:'client',reason:null,model_usage:true};
}
/** Explicit UI dispatch. Work creation alone does not grant a new execution. */
export class WorkDispatcher{
  private active=new Set<Promise<void>>();private stopped=false;readonly family:FamilyRuntime;
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly model:StructuredModel,readonly hermes:HermesWorkRuntime,readonly supervisor?:WorkSupervisor){initWorkExecution(store);this.family=new FamilyRuntime(store,config,{llm:model});}
  start(raw:unknown){
    const input=workExecuteSchema.parse(raw),project=this.config.project.id,work=this.store.intakeWork(project,input.work_id);
    requireCondition(!this.stopped,'WORK_DISPATCH_CLOSED');
    const previous=executionRecord(this.store,project,work.id);
    if(previous?.owner&&previous.lease_until_ms>Date.now())return {accepted:false,deduplicated:true,state:previous.state};
    requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');
    const supervised=supervisorStatus(this.store,project,work.id);
    if(input.executor==='client'&&supervised&&['queued','running','retry_wait'].includes(supervised.state))return {accepted:false,deduplicated:true,...supervised};
    const route=workDispatchOptions(this.store,this.config,work.id);
    requireCondition(route.can_execute,route.reason??'WORK_NOT_READY');requireCondition(route.executor===input.executor||!this.supervisor&&input.executor==='hermes'&&route.executor==='client','WORK_EXECUTOR_CHANGED');
    requireCondition(input.cost_acknowledged,'WORK_MODEL_USAGE_CONSENT_REQUIRED');
    requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    if(input.executor==='client'){requireCondition(this.supervisor,'WORK_SUPERVISOR_NOT_CONNECTED');return this.supervisor.start(work.id,input.revision,input.cost_acknowledged,input.timezone);}
    if(input.executor==='hermes'){
      const id=bindIntakeHermes(this.store,this.config,work.id,input.revision),bound=this.hermes.status(id)!;
      return this.hermes.action({work_id:id,revision:bound.revision,action:'send',request_id:randomUUID(),cost_acknowledged:true,instruction:'이 업무의 지침과 완료조건에 따라 이번 회차를 실행해 주세요. 이미 실행한 작업은 재실행하지 말고 기록을 먼저 확인하세요. 예약 생성·변경, 메시지 전송, 외부 제출은 별도 승인을 요청하세요. 연결이나 권한이 없으면 필요한 항목을 구체적으로 보고하세요.'});
    }
    requireCondition(this.active.size<2,'WORK_DISPATCH_CAPACITY');
    const owner=randomUUID(),db=this.store.hermesState,now=Date.now();
    const claimed=db.prepare(`INSERT INTO office_execution(work_id,project_id,owner,lease_until_ms,state,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET owner=excluded.owner,lease_until_ms=excluded.lease_until_ms,state=excluded.state,reason=NULL,updated_at=excluded.updated_at WHERE office_execution.owner IS NULL OR office_execution.lease_until_ms<=?`).run(work.id,project,owner,now+30000,'preparing',new Date(now).toISOString(),now);
    if(!claimed.changes)return {accepted:false,deduplicated:true};
    workActivity(this.store,project,work.id,'dispatch.started','실행 요청을 접수했습니다. 연결된 실행 경로를 준비합니다.');
    const operation=this.execute(work.id,work.revision,owner);this.active.add(operation);void operation.finally(()=>this.active.delete(operation));
    return {accepted:true,state:'preparing'};
  }
  private async execute(id:string,revision:number,owner:string){
    const project=this.config.project.id,db=this.store.hermesState,settingsRevision=readModelSettings(modelSettingsPath(this.config))?.revision??0;
    const heartbeat=setInterval(()=>{try{db.prepare('UPDATE office_execution SET lease_until_ms=? WHERE project_id=? AND work_id=? AND owner=?').run(Date.now()+30000,project,id,owner);}catch{/* The execution fence below rejects a lost lease. */}},3000);heartbeat.unref();
    try{
      const work=this.store.intakeWork(project,id),spec=work.spec as WorkProposal,latest=this.store.officeRuns(project,id)[0];
      const prior=latest?.source_kind==='pack'?this.store.packRun(project,latest.source_id):null;
      let recipe=prior?.recipe;
      if(!recipe){
        const plan=await this.family.call('runtime_pack_plan',{work_id:id,prompt:work.prompt}) as {recipe:unknown;instructions:string;recipe_schema:Record<string,unknown>;connections:unknown};
        if(plan.recipe)recipe=recipeSchema.parse(plan.recipe);
        else{
          requireCondition(workModelDataApproved(this.config),'MODEL_DATA_APPROVAL_REQUIRED');
          workActivity(this.store,project,id,'dispatch.planning','AI가 연결된 데이터와 선택된 Pack으로 실행 절차를 구성합니다.');
          recipe=recipeSchema.parse(await this.model.call('design',plan.instructions,{work:spec,connections:plan.connections,prompt:work.prompt},plan.recipe_schema));
        }
      }
      const lease=executionRecord(this.store,project,id);requireCondition(lease?.owner===owner&&lease.lease_until_ms>Date.now(),'WORK_EXECUTION_LEASE_LOST');
      requireCondition(workImportExecutionOwner(this.store,project,id)!=='original_runtime','ORIGINAL_RUNTIME_CONNECTION_REQUIRED');
      requireCondition(this.store.intakeWork(project,id).revision===revision,'WORK_REVISION_CONFLICT');
      requireCondition((readModelSettings(modelSettingsPath(this.config))?.revision??0)===settingsRevision,'MODEL_SETTINGS_CHANGED');
      requireCondition(readFamilies.has(recipe.family)&&!('target' in recipe),'WORK_USE_REVIEWED_WRITE_CONTROL');
      requireCondition(recipe.family===spec.route.pack_family,'WORK_PACK_FAMILY_MISMATCH');
      workActivity(this.store,project,id,'dispatch.executing','Pack 실행을 시작합니다. 수집·검증 결과를 이 업무에 기록합니다.');
      const result=await this.family.call('runtime_pack_run',{...workExecutionBinding(work),...(prior?{request_id:prior.request_id}:{}),recipe}) as {status:string};
      workActivity(this.store,project,id,'dispatch.result',`Pack result: ${result.status}`);
      db.prepare('UPDATE office_execution SET state=?,reason=NULL,owner=NULL,lease_until_ms=0,updated_at=? WHERE project_id=? AND work_id=? AND owner=?').run(result.status,new Date().toISOString(),project,id,owner);
    }catch(error){
      const reason=error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'WORK_EXECUTION_FAILED';
      workActivity(this.store,project,id,'dispatch.failed',reason);
      db.prepare("UPDATE office_execution SET state='failed',reason=?,owner=NULL,lease_until_ms=0,updated_at=? WHERE project_id=? AND work_id=? AND owner=?").run(reason,new Date().toISOString(),project,id,owner);
    }finally{clearInterval(heartbeat);}
  }
  async close(){this.stopped=true;await Promise.allSettled([...this.active]);await this.family.drain();}
}
