import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {CustomPackRegistry,type CustomPackHostBinding,type CustomPackCompletionContract} from '../packs/custom-registry.js';
import {key} from '../packs/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {requireCondition} from '../core/contracts.js';
import {CustomPackRepeats,customPackWorkBinding} from './custom-pack-repeat.js';
import {WorkSchedules,supportedWorkScheduleSchema,normalizeExplicitWorkSchedule,explicitScheduleDigest,type SupportedSchedule,type WorkScheduleDue} from './schedule.js';
import {validateWorkProposal} from './contracts.js';
import {readWorkIntakeOptions} from './intake-options.js';
import {assertWorkConnected} from './lifecycle.js';

export const customPackScheduleConfigureSchema=z.object({
  key,version:z.number().int().positive().optional(),parent_revision:z.number().int().nonnegative(),
  definition:supportedWorkScheduleSchema,parameters:z.record(key,z.record(key,z.string().max(400))).default({}),
  cost_acknowledged:z.literal(true),recurrence_acknowledged:z.literal(true),
}).strict();
export const customPackScheduleControlSchema=z.object({parent_work_id:z.string().uuid(),parent_revision:z.number().int().nonnegative()}).strict();
export interface CustomPackScheduleBinding extends CustomPackHostBinding {
  parent_work_id:string;key:string;version:number;parameters:Record<string,Record<string,string>>;
  definition:SupportedSchedule;definition_sha256:string;parent_contract_sha256:string;
}
const scheduledCycle=/^schedule-[a-f0-9]{64}$/u;
function parentContract(store:PackStore,project:string,workId:string):CustomPackCompletionContract {
  const work=store.intakeWork(project,workId);
  return {prompt:work.prompt,...readWorkIntakeOptions(store,project,work.id),user_directions:store.workDirections(project,work.id),answers:work.answers,spec:validateWorkProposal(work.spec,work.mode,true)};
}
function findBinding(store:PackStore,project:string,workId:string):CustomPackScheduleBinding|null {
  const db=store.hermesState;if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_custom_pack_schedule'").get())return null;
  const row=db.prepare('SELECT body FROM office_custom_pack_schedule WHERE project_id=? AND parent_work_id=?').get(project,workId);
  return row?JSON.parse(String(row.body)) as CustomPackScheduleBinding:null;
}
function assertParent(store:PackStore,project:string,binding:CustomPackScheduleBinding,host:CustomPackHostBinding){
  assertWorkConnected(store,project,binding.parent_work_id);
  requireCondition(!store.intakeWork(project,binding.parent_work_id).paused,'WORK_PAUSED');
  requireCondition(binding.config_fingerprint===host.config_fingerprint,'CUSTOM_PACK_CONFIG_CHANGED');
  requireCondition(binding.engine_binding===host.engine_binding,'CUSTOM_PACK_ENGINE_CHANGED');
  requireCondition(snapshotHash(parentContract(store,project,binding.parent_work_id))===binding.parent_contract_sha256,'CUSTOM_PACK_WORK_CONTRACT_CHANGED');
  const schedule=store.hermesState.prepare('SELECT rule_sha256,execution_kind FROM office_work_schedule WHERE project_id=? AND work_id=?').get(project,binding.parent_work_id);
  requireCondition(schedule?.execution_kind==='custom_pack'&&schedule.rule_sha256===binding.definition_sha256,'CUSTOM_PACK_SCHEDULE_DEFINITION_CHANGED');
}
export function customPackScheduledParent(store:PackStore,project:string,childWorkId:string){
  const db=store.hermesState;if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_work_schedule_slot'").get())return null;
  if(!db.prepare('PRAGMA table_info(office_work_schedule_slot)').all().some(column=>column.name==='execution_work_id'))return null;
  const row=db.prepare('SELECT work_id,slot_key,run_id,state,execution_binding_sha256 FROM office_work_schedule_slot WHERE project_id=? AND execution_work_id=? ORDER BY created_at DESC LIMIT 1').get(project,childWorkId);
  return row?{parent_work_id:String(row.work_id),slot_key:String(row.slot_key),run_id:row.run_id===null?null:String(row.run_id),state:String(row.state),execution_binding_sha256:String(row.execution_binding_sha256)}:null;
}
/** Every scheduled child uses an existing scheduler slot and a fresh Work.
 * A prepared orphan has no slot/run assignment and cannot dispatch effects. */
export function assertCustomPackScheduledRun(store:PackStore,project:string,childWorkId:string,host:CustomPackHostBinding,runId?:string){
  const slot=customPackScheduledParent(store,project,childWorkId);
  const child=customPackWorkBinding(store,project,childWorkId);
  if(!slot&&(!child||!scheduledCycle.test(child.cycle_id)))return;
  requireCondition(child&&scheduledCycle.test(child.cycle_id),'SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH');
  requireCondition(slot&&slot.state==='started'&&slot.run_id,'CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED');
  requireCondition(child.cycle_id===`schedule-${slot.slot_key}`&&snapshotHash(child)===slot.execution_binding_sha256,'SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH');
  if(runId!==undefined)requireCondition(runId===slot.run_id,'SCHEDULE_RUN_BINDING_MISMATCH');
  const assigned=store.hermesState.prepare('SELECT 1 FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(project,childWorkId,slot.run_id);
  requireCondition(assigned,'SCHEDULE_RUN_BINDING_MISSING');
  const binding=findBinding(store,project,slot.parent_work_id);
  requireCondition(binding&&binding.key===child.key&&binding.version===child.version,'CUSTOM_PACK_SCHEDULE_VERSION_CHANGED');
  assertParent(store,project,binding,host);
}

/** Pins one explicitly selected Pack version to the existing Work scheduler.
 * No business goal, model-normalized rule, result or execution engine is copied.
 */
export class CustomPackSchedules {
  constructor(private readonly store:PackStore,private readonly project:string,private readonly registry:CustomPackRegistry,private readonly repeats:CustomPackRepeats,private readonly schedules:WorkSchedules){
    store.hermesState.exec('CREATE TABLE IF NOT EXISTS office_custom_pack_schedule(project_id TEXT NOT NULL,parent_work_id TEXT NOT NULL REFERENCES office_work(id),pack_key TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,parent_work_id));');
  }
  binding(parentWorkId:string){return findBinding(this.store,this.project,parentWorkId);}
  status(parentWorkId:string){
    this.store.officeWorkById(this.project,parentWorkId);
    const binding=this.binding(parentWorkId);
    if(!binding)return null;
    const slots=this.store.hermesState.prepare('SELECT s.slot_key,s.scheduled_ms,s.state AS slot_state,s.reason,s.execution_work_id AS child_work_id,s.run_id,r.state AS run_state FROM office_work_schedule_slot s LEFT JOIN office_supervisor r ON r.project_id=s.project_id AND r.work_id=s.execution_work_id AND r.run_id=s.run_id WHERE s.project_id=? AND s.work_id=? ORDER BY s.scheduled_ms DESC LIMIT 10').all(this.project,parentWorkId);
    return {...binding,schedule:this.schedules.status(parentWorkId),slots};
  }
  configure(raw:unknown,host:CustomPackHostBinding){
    const input=customPackScheduleConfigureSchema.parse(raw),pack=this.registry.get(this.project,input.key,input.version),parent=pack.source.work_id,db=this.store.hermesState;
    requireCondition(pack.config_fingerprint===host.config_fingerprint,'CUSTOM_PACK_CONFIG_CHANGED');requireCondition(pack.engine_binding===host.engine_binding,'CUSTOM_PACK_ENGINE_CHANGED');
    assertWorkConnected(this.store,this.project,parent);const work=this.store.intakeWork(this.project,parent);requireCondition(work.revision===input.parent_revision,'WORK_REVISION_CONFLICT');
    const contract=parentContract(this.store,this.project,parent);requireCondition(snapshotHash(contract)===snapshotHash(pack.completion_contract),'CUSTOM_PACK_WORK_CONTRACT_CHANGED');
    // Validate all parameter overrides using a preparation-only cycle. No Work,
    // scheduler slot, result or effect is created by this validation.
    this.validateParameters(pack.recipe,input.parameters);
    const definition=normalizeExplicitWorkSchedule(input.definition),base={parent_work_id:parent,key:pack.key,version:pack.version,parameters:input.parameters,definition,parent_contract_sha256:snapshotHash(contract),...host};
    const binding:CustomPackScheduleBinding={...base,definition_sha256:explicitScheduleDigest(definition,snapshotHash(base))};
    db.exec('SAVEPOINT custom_pack_schedule_configure');try{
      const prior=this.binding(parent),others=db.prepare('SELECT parent_work_id FROM office_custom_pack_schedule WHERE project_id=? AND pack_key=? AND parent_work_id<>?').all(this.project,pack.key,parent);
      for(const other of others){
        const status=this.schedules.status(String(other.parent_work_id));requireCondition(!status||!['enabled','paused'].includes(status.state),'SCHEDULE_EXISTING_ENABLED_CONFLICT');
        const active=db.prepare("SELECT 1 FROM office_work_schedule_slot WHERE project_id=? AND work_id=? AND (state IN ('started','reconciliation_required') OR state='claimed' AND lease_until_ms>?)").get(this.project,String(other.parent_work_id),Date.now());
        requireCondition(!active,'SCHEDULE_ACTIVE_SLOT_CONFLICT');
      }
      requireCondition(!prior||prior.key===pack.key,'SCHEDULE_CUSTOM_PACK_CONFLICT');
      this.schedules.configureExplicit(parent,work.revision,definition,{acknowledged:true,binding_sha256:snapshotHash(base),replace_existing:Boolean(prior),execution_kind:'custom_pack'});
      const at=new Date().toISOString();db.prepare('INSERT INTO office_custom_pack_schedule VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,parent_work_id) DO UPDATE SET pack_key=excluded.pack_key,body=excluded.body,updated_at=excluded.updated_at').run(this.project,parent,pack.key,JSON.stringify(binding),at,at);
      this.schedules.enable(parent,work.revision,{acknowledged:true});db.exec('RELEASE custom_pack_schedule_configure');
    }catch(error){db.exec('ROLLBACK TO custom_pack_schedule_configure; RELEASE custom_pack_schedule_configure');throw error;}
    return this.status(parent)!;
  }
  disable(raw:unknown){
    const input=customPackScheduleControlSchema.parse(raw);requireCondition(this.binding(input.parent_work_id),'CUSTOM_PACK_SCHEDULE_NOT_FOUND');
    this.schedules.disable(input.parent_work_id,input.parent_revision);return this.status(input.parent_work_id)!;
  }
  prepareDue(due:WorkScheduleDue,host:CustomPackHostBinding){
    const binding=this.binding(due.work_id);requireCondition(binding,'CUSTOM_PACK_SCHEDULE_NOT_FOUND');assertParent(this.store,this.project,binding,host);
    requireCondition(this.store.intakeWork(this.project,due.work_id).revision===due.work_revision,'WORK_REVISION_CONFLICT');
    requireCondition(this.schedules.due().some(slot=>slot.work_id===due.work_id&&slot.slot_key===due.slot_key),'SCHEDULE_SLOT_NOT_DUE');
    return this.repeats.prepare(this.project,{key:binding.key,version:binding.version,cycle_id:`schedule-${due.slot_key}`,parameters:binding.parameters},host);
  }
  private validateParameters(recipe:ReturnType<CustomPackRegistry['get']>['recipe'],parameters:Record<string,Record<string,string>>){
    requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u.test(JSON.stringify(parameters)),'CREDENTIAL_LIKE_INPUT');
    for(const [id,values] of Object.entries(parameters)){
      const matches='sources' in recipe?recipe.sources.filter(source=>source.id===id):[];
      requireCondition(matches.length>0,'CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN');requireCondition(matches.length===1,'CUSTOM_PACK_SOURCE_PARAMETER_AMBIGUOUS');
      requireCondition(Object.keys(values).every(name=>Object.hasOwn(matches[0]!.parameters,name)),'CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN');
    }
  }
}
