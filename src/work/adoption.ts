import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WorkProposal} from './contracts.js';
import {HermesWorkRuntime,hermesWorkDetail,type HermesWorkDefinition} from './hermes.js';
import {RemoteOffice,remoteDetail} from './remote.js';
import {initWorkExecution,workActivity,workTail} from './activity.js';
import {safeControlText} from '../observability/safe-text.js';
import {workImportExecutionOwner} from './import-authority.js';
import {assertWorkConnected,readWorkLifecycle} from './lifecycle.js';

const uuid=z.string().uuid(),revision=z.number().int().nonnegative(),fingerprint=z.string().regex(/^[a-f0-9]{64}$/u);
export const workAdoptionTargetsSchema=z.object({work_id:uuid}).strict();
export const workAdoptionBindSchema=z.object({work_id:uuid,revision,target_work_id:uuid,target_revision:revision,target_fingerprint:fingerprint,acknowledged:z.literal(true)}).strict();
export const workAdoptionActionSchema=z.object({work_id:uuid,revision,binding_revision:revision,target_revision:revision,action:z.enum(['refresh','send','pause','resume','review','permission']),request_id:uuid.optional(),instruction:z.string().trim().min(3).max(4000).optional(),permission_id:uuid.optional(),option_id:z.string().max(120).optional(),cost_acknowledged:z.boolean().optional()}).strict();
type Binding={work_id:string;project_id:string;target_work_id:string;runtime:'hermes'|'remote';target_fingerprint:string;revision:number;created_at:string};
const table=(store:PackStore,name:string)=>Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function binding(store:PackStore,project:string,id:string):Binding|null{return table(store,'office_work_adoption')?store.hermesState.prepare('SELECT * FROM office_work_adoption WHERE project_id=? AND work_id=?').get(project,id) as Binding??null:null;}

/** Only registered, project-scoped control bridges are candidates. Source access is not a control bridge. */
function runtimeTarget(store:PackStore,project:string,id:string){
  const hermes=hermesWorkDetail(store,project,id);
  if(hermes){
    const row=store.hermesState.prepare('SELECT import_key,definition,updated_at FROM hermes_work WHERE project_id=? AND work_id=?').get(project,id)!;
    const definition=JSON.parse(String(row.definition)) as HermesWorkDefinition,at=String(row.updated_at);
    const last=hermes.hermes.turns[0],active=['queued','starting','running','needs_human'].includes(last?.status??'');
    const state=active&&Date.now()-Date.parse(last!.updated_at)>60_000?'execution_unobserved':hermes.run_status;
    const identity=snapshotHash({runtime:'hermes',project,work_id:id,import_key:row.import_key,definition});
    return {id,runtime:'hermes' as const,title:safeControlText(hermes.title,160),revision:hermes.revision,fingerprint:identity,state,
      observed_at:at,live:active&&state!=='execution_unobserved',scope:'office_managed_session' as const,
      capabilities:{observe:true,send:hermes.hermes.can_send,pause:!hermes.hermes.detached&&!hermes.hermes.paused,resume:!hermes.hermes.detached&&hermes.hermes.paused,review:hermes.hermes.needs_review,permission:Boolean(hermes.hermes.permission)},
      snapshot:{reply:last?.reply??null,turn_status:last?.status??null,permission:hermes.hermes.permission,completion_verified:false},
      connection:hermes.hermes.detached?'detached':'registered',schedule_owner:'original' as const,delivery_owner:'original' as const};
  }
  const remote=remoteDetail(store,project,id);
  if(remote){
    const row=store.hermesState.prepare('SELECT target_id,kind,source_id FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,id)!;
    const target=store.hermesState.prepare('SELECT definition FROM office_remote_target WHERE project_id=? AND id=?').get(project,String(row.target_id))!;
    const identity=snapshotHash({runtime:'remote',project,work_id:id,target_id:row.target_id,kind:row.kind,source_id:row.source_id,target:JSON.parse(String(target.definition))});
    const stale=remote.remote.stale||Boolean(remote.remote.error);
    return {id,runtime:'remote' as const,title:safeControlText(remote.title,160),revision:remote.revision,fingerprint:identity,
      state:stale?'execution_unobserved':remote.run_status,observed_at:remote.remote.observed_at,live:false,
      scope:remote.remote.kind==='job'?'original_remote_job' as const:'original_remote_session' as const,
      capabilities:{observe:true,send:remote.remote.can_send,pause:remote.remote.can_stop,resume:false,review:remote.remote.needs_review,permission:false},
      snapshot:{...remote.remote.snapshot,reply:remote.remote.snapshot.messages?.filter((m:{role:string})=>m.role==='assistant').at(-1)?.text??null,completion_verified:false},
      connection:remote.remote.error?'unreachable':stale?'refresh_required':'observed',schedule_owner:'original' as const,delivery_owner:'original' as const};
  }
  return null;
}

/** Pure bounded observation, safe for board/detail reads and process restart. */
export function importedWorkAdoption(store:PackStore,config:HostConfig,id:string){
  const link=binding(store,config.project.id,id);if(!link)return null;
  const target=runtimeTarget(store,config.project.id,link.target_work_id),drift=!target||target.fingerprint!==link.target_fingerprint;
  return {work_id:id,binding_revision:link.revision,target_work_id:link.target_work_id,runtime:link.runtime,
    state:drift?'connection_required':target!.state,connection:drift?'binding_changed':target!.connection,
    runtime_verified:!drift&&target!.connection==='observed',live:!drift&&target!.live,
    observed_at:target?.observed_at??null,target_revision:target?.revision??null,target_title:target?.title??null,
    scope:target?.scope??null,capabilities:drift?{observe:false,send:false,pause:false,resume:false,review:false,permission:false}:target!.capabilities,
    snapshot:drift?null:target!.snapshot,activity:drift?[]:workTail(store,config.project.id,link.target_work_id),
    execution_owner:'original' as const,schedule_owner:'original' as const,delivery_owner:'original' as const,
    source_modified:false,duplicate_execution:false,
    notice:target?.runtime==='hermes'?'This connection controls the registered Office-managed Hermes session. Independent Hermes bots and schedules stay with their original runtime.':'The original server owns execution, schedules and delivery. Scheduled jobs expose observation only.'};
}

export class WorkAdoptionRuntime{
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly hermes:HermesWorkRuntime,readonly remote:RemoteOffice){
    initWorkExecution(store);
    store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_work_adoption(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,target_work_id TEXT NOT NULL REFERENCES office_work(id),runtime TEXT NOT NULL,target_fingerprint TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,UNIQUE(project_id,target_work_id));`);
  }
  private source(id:string){
    const project=this.config.project.id,record=this.store.workImportForWork(project,id),work=this.store.intakeWork(project,id);
    requireCondition(record,'WORK_ADOPTION_IMPORT_REQUIRED');
    requireCondition(workImportExecutionOwner(this.store,project,id)==='original_runtime','WORK_ADOPTION_ORIGINAL_RUNTIME_REQUIRED');
    requireCondition((work.spec as WorkProposal|null)?.route.pack_family!=='coding.orchestrate','WORK_ADOPTION_CODING_USE_SESSION_CONTROL');
    requireCondition(this.store.officeRuns(project,id).length===0,'WORK_ADOPTION_ALREADY_EXECUTED');
    requireCondition(!hermesWorkDetail(this.store,project,id)&&!remoteDetail(this.store,project,id),'WORK_ADOPTION_SOURCE_ALREADY_CONNECTED');
    return work;
  }
  targets(raw:unknown){
    const input=workAdoptionTargetsSchema.parse(raw),work=this.source(input.work_id),project=this.config.project.id,ids:string[]=[];
    if(table(this.store,'hermes_work'))ids.push(...this.store.hermesState.prepare("SELECT work_id FROM hermes_work WHERE project_id=? AND state!='detached' ORDER BY updated_at DESC LIMIT 100").all(project).map(row=>String(row.work_id)));
    if(table(this.store,'office_remote_work'))ids.push(...this.store.hermesState.prepare('SELECT work_id FROM office_remote_work WHERE project_id=? ORDER BY work_id LIMIT 100').all(project).map(row=>String(row.work_id)));
    const targets=ids.filter(id=>id!==work.id&&readWorkLifecycle(this.store,project,id).state==='connected').flatMap(id=>{const owner=this.store.hermesState.prepare('SELECT work_id FROM office_work_adoption WHERE project_id=? AND target_work_id=?').get(project,id);if(owner&&owner.work_id!==work.id)return [];const target=runtimeTarget(this.store,project,id);return target?[{id:target.id,runtime:target.runtime,title:target.title,revision:target.revision,fingerprint:target.fingerprint,state:target.state,scope:target.scope,connection:target.connection}]:[];});
    return {work_id:work.id,revision:work.revision,targets,binding:importedWorkAdoption(this.store,this.config,work.id),execution:false,
      next_action:targets.length?'select_registered_original_runtime':'register_hermes_or_remote_runtime_connection'};
  }
  bind(raw:unknown){
    const input=workAdoptionBindSchema.parse(raw),work=this.source(input.work_id),project=this.config.project.id;
    assertWorkConnected(this.store,project,work.id);
    const target=runtimeTarget(this.store,project,input.target_work_id);requireCondition(target,'WORK_ADOPTION_TARGET_NOT_REGISTERED');
    assertWorkConnected(this.store,project,target.id);
    const previous=binding(this.store,project,work.id);
    if(previous){requireCondition(previous.target_work_id===input.target_work_id&&previous.target_fingerprint===input.target_fingerprint,'WORK_ADOPTION_BINDING_CONFLICT');return {...this.status(work.id),deduplicated:true};}
    requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');requireCondition(work.id!==input.target_work_id,'WORK_ADOPTION_SELF_REFERENCE');
    requireCondition(target.revision===input.target_revision&&target.fingerprint===input.target_fingerprint,'WORK_ADOPTION_TARGET_CHANGED');
    requireCondition(target.connection!=='detached','WORK_ADOPTION_TARGET_DETACHED');
    this.store.transaction(()=>{
      assertWorkConnected(this.store,project,work.id);assertWorkConnected(this.store,project,target.id);
      requireCondition(this.source(work.id).revision===input.revision,'WORK_REVISION_CONFLICT');
      requireCondition(!this.store.hermesState.prepare('SELECT 1 FROM office_work_adoption WHERE project_id=? AND target_work_id=?').get(project,target.id),'WORK_ADOPTION_TARGET_ALREADY_BOUND');
      this.store.hermesState.prepare('INSERT INTO office_work_adoption VALUES(?,?,?,?,?,0,?)').run(work.id,project,target.id,target.runtime,target.fingerprint,new Date().toISOString());
      workActivity(this.store,project,work.id,'runtime_connected',`Original runtime connected: ${target.runtime} · ${target.title}. Existing execution, schedules and delivery remain with the original runtime.`);
    });
    return {...this.status(work.id),deduplicated:false};
  }
  status(id:string){const source=this.source(id),adoption=importedWorkAdoption(this.store,this.config,id);requireCondition(adoption,'WORK_ADOPTION_CONNECTION_REQUIRED');return {work_id:id,revision:source.revision,adoption};}
  async action(raw:unknown){
    const input=workAdoptionActionSchema.parse(raw),source=this.source(input.work_id),link=binding(this.store,this.config.project.id,source.id);requireCondition(link,'WORK_ADOPTION_CONNECTION_REQUIRED');
    assertWorkConnected(this.store,this.config.project.id,source.id);assertWorkConnected(this.store,this.config.project.id,link.target_work_id);
    requireCondition(source.revision===input.revision&&link.revision===input.binding_revision,'WORK_REVISION_CONFLICT');
    const target=runtimeTarget(this.store,this.config.project.id,link.target_work_id);requireCondition(target&&target.fingerprint===link.target_fingerprint,'WORK_ADOPTION_BINDING_CHANGED');
    // Repeated send is resolved by its existing receipt before testing a changed runtime revision.
    if(input.action==='send'&&input.request_id){
      const prior=link.runtime==='hermes'?this.store.hermesState.prepare('SELECT work_id,instruction FROM hermes_turn WHERE project_id=? AND request_id=?').get(this.config.project.id,input.request_id):this.store.hermesState.prepare('SELECT work_id,instruction FROM office_remote_turn WHERE project_id=? AND id=?').get(this.config.project.id,input.request_id);
      if(prior){requireCondition(prior.work_id===target.id&&prior.instruction===input.instruction,'WORK_ADOPTION_REQUEST_ID_CONFLICT');return this.status(source.id);}
    }
    requireCondition(target.revision===input.target_revision,'WORK_REVISION_CONFLICT');
    requireCondition(target.capabilities[input.action==='refresh'?'observe':input.action],'WORK_ADOPTION_ACTION_UNSUPPORTED');
    const payload={...input,work_id:target.id,revision:target.revision};delete (payload as Partial<typeof input>).binding_revision;delete (payload as Partial<typeof input>).target_revision;
    if(link.runtime==='remote'){
      requireCondition(!['resume','permission'].includes(input.action),'WORK_ADOPTION_ACTION_UNSUPPORTED');
      await this.remote.action({...payload,action:input.action==='pause'?'stop':input.action});
    }else if(input.action!=='refresh')this.hermes.action(payload);
    workActivity(this.store,this.config.project.id,source.id,'runtime_action',`Original runtime ${input.action}: ${target.runtime} · ${target.title}`);
    return this.status(source.id);
  }
}
