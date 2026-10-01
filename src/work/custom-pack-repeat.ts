import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {type PackStore,type IntakeWork} from '../packs/store.js';
import {CustomPackRegistry,type CustomPackHostBinding,type CustomPackRepeat} from '../packs/custom-registry.js';
import {key,recipeSchema,type Recipe} from '../packs/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {requireCondition} from '../core/contracts.js';
import {validateWorkProposal,type WorkProposal} from './contracts.js';
import {bindWorkIntakeOptions,readWorkIntakeOptions} from './intake-options.js';
import {assertWorkConnected} from './lifecycle.js';
import {initWorkExecution,workActivity} from './activity.js';

export const customPackVersionsSchema=z.object({key}).strict();
export interface CustomPackWorkBinding {
  key:string;version:number;cycle_id:string;request_id:string;work_id:string;
  recipe:Recipe;parameters:CustomPackRepeat['parameters'];
  work_contract_sha256:string;config_fingerprint:string;engine_binding:string;
}

function currentContract(store:PackStore,project:string,work:IntakeWork){
  return {prompt:work.prompt,spec:work.spec,answers:work.answers,...readWorkIntakeOptions(store,project,work.id),
    user_directions:store.workDirections(project,work.id).map(({step_id,instruction})=>({step_id,instruction}))};
}
/** Read-only lookup used by the normal tool preflight, including older hosts
 * whose databases have no custom Pack tables. It never grants authority. */
export function customPackWorkBinding(store:PackStore,project:string,workId:string):CustomPackWorkBinding|null {
  const db=store.hermesState;
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_custom_pack_repeat_work'").get())return null;
  const row=db.prepare('SELECT body FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').get(project,workId);
  return row?JSON.parse(String(row.body)) as CustomPackWorkBinding:null;
}
export function assertCustomPackInvocation(store:PackStore,project:string,workId:string,name:string,args:Record<string,unknown>,host?:CustomPackHostBinding):CustomPackWorkBinding|null {
  const binding=customPackWorkBinding(store,project,workId);
  // A changed task may still inspect its original run and failure evidence.
  // Reading a receipt never grants a dispatch or changes the frozen version.
  if(name==='runtime_pack_status'||name==='runtime_pack_events'||name==='runtime_pack_watch_pause'&&args.paused===true)return binding;
  if(!binding){
    const db=store.hermesState;
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_custom_pack_cycle'").get()){
      const expected=db.prepare('SELECT 1 FROM office_intake w JOIN office_custom_pack_cycle c ON c.project_id=w.project_id AND c.request_id=w.request_id WHERE w.project_id=? AND w.work_id=?').get(project,workId);
      requireCondition(!expected,'CUSTOM_PACK_WORK_BINDING_MISSING');
    }
    return null;
  }
  assertWorkConnected(store,project,workId);
  requireCondition(!host||host.config_fingerprint===binding.config_fingerprint,'CUSTOM_PACK_CONFIG_CHANGED');
  requireCondition(!host||host.engine_binding===binding.engine_binding,'CUSTOM_PACK_ENGINE_CHANGED');
  const work=store.intakeWork(project,workId);
  requireCondition(!work.paused,'WORK_PAUSED');
  requireCondition(snapshotHash(currentContract(store,project,work))===binding.work_contract_sha256,'CUSTOM_PACK_WORK_CONTRACT_CHANGED');
  if(name==='runtime_pack_run'){
    requireCondition(snapshotHash(recipeSchema.parse(args.recipe))===snapshotHash(binding.recipe),'CUSTOM_PACK_RECIPE_CHANGED');
    if(args.request_id!==undefined)requireCondition(args.request_id===binding.request_id,'CUSTOM_PACK_REQUEST_ID_CHANGED');
  }
  return binding;
}

/** Preparing a repeat registers a new ordinary Work. It never starts tools,
 * activates a schedule, copies results, or gives approval/model-cost consent. */
export class CustomPackRepeats {
  constructor(private readonly store:PackStore,private readonly registry:CustomPackRegistry,private readonly onPrepared?:(work:IntakeWork,prepared:CustomPackRepeat)=>void){
    store.hermesState.exec('CREATE TABLE IF NOT EXISTS office_custom_pack_repeat_work(project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),request_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(project_id,work_id),UNIQUE(project_id,request_id));');
  }
  prepare(project:string,raw:unknown,host:CustomPackHostBinding,validate?:(prepared:CustomPackRepeat)=>void){
    const prepared=this.registry.prepareRepeat(project,raw,host);
    validate?.(prepared);
    initWorkExecution(this.store);
    return this.store.transaction(()=>{
      const db=this.store.hermesState,prior=db.prepare('SELECT work_id FROM office_intake WHERE project_id=? AND request_id=?').get(project,prepared.request_id);
      if(prior){
        const work=this.store.intakeWork(project,String(prior.work_id)),binding=assertCustomPackInvocation(this.store,project,work.id,'prepare',{},host);
        requireCondition(binding&&binding.request_id===prepared.request_id&&snapshotHash(binding.recipe)===snapshotHash(prepared.recipe),'CUSTOM_PACK_WORK_BINDING_MISSING');
        return {prepared,work,created:false};
      }
      const contract=prepared.completion_contract,spec:WorkProposal=structuredClone(contract.spec);
      spec.plan.steps=spec.plan.steps.map(step=>({...step,evidence_ids:[]}));
      // Questions were resolved in the original verified Work. Their answers
      // stay input context; no old source observation becomes new evidence.
      spec.questions=[];
      const validated=validateWorkProposal(spec,'quick',true);
      const id=randomUUID(),at=new Date().toISOString();
      // Host admission follows the same saved Work representation as normal
      // intake/import. There is no model proposal or inherited lease here.
      db.prepare('INSERT INTO office_work VALUES(?,?,?,?,?,?)').run(id,project,validated.title,validated.desired_outcome,at,at);
      db.prepare('INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,prepared.request_id,snapshotHash(contract.prompt),'quick','ready',1,contract.prompt,JSON.stringify(validated),'[]',JSON.stringify(contract.answers),at,at);
      db.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(id,0,'received','null','{}',at);
      db.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(id,1,'defined',JSON.stringify(validated),JSON.stringify(contract.answers),at);
      bindWorkIntakeOptions(this.store,project,id,{completion_condition:contract.completion_condition,delivery_target_ids:contract.delivery_target_ids});
      let saved=this.store.intakeWork(project,id);
      // Preserve only explicit direction text and its stage, with fresh Work
      // revision history. A source run reference is context, never a receipt.
      for(const direction of contract.user_directions){
        const revision=saved.revision+1,at=new Date().toISOString();
        // The cycle request ID is host-generated and bounded independently of
        // the user-selected Pack key. Direction provenance must satisfy the
        // same identifier contract as the final original-request verifier.
        this.store.hermesState.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(saved.id,revision,'direction_changed',JSON.stringify({...direction,run_id:prepared.request_id,created_at:at}),JSON.stringify(saved.answers),at);
        this.store.hermesState.prepare('UPDATE office_intake SET revision=?,updated_at=? WHERE project_id=? AND work_id=?').run(revision,at,project,saved.id);
        saved=this.store.intakeWork(project,saved.id);
      }
      const binding:CustomPackWorkBinding={key:prepared.key,version:prepared.version,cycle_id:prepared.cycle_id,request_id:prepared.request_id,work_id:saved.id,recipe:prepared.recipe,parameters:prepared.parameters,work_contract_sha256:snapshotHash(currentContract(this.store,project,saved)),...host};
      this.store.hermesState.prepare('INSERT INTO office_custom_pack_repeat_work VALUES(?,?,?,?)').run(project,saved.id,prepared.request_id,JSON.stringify(binding));
      this.onPrepared?.(saved,prepared);
      workActivity(this.store,project,saved.id,'custom_pack.prepared',`Prepared ${prepared.key} version ${prepared.version} cycle ${prepared.cycle_id}. Fresh Work execution and output verification are required.`,{status:'ready'});
      return {prepared,work:saved,created:true};
    });
  }
}
