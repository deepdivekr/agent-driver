import {z} from 'zod';
import {type PackRun,type PackStore} from './store.js';
import {key,recipeSchema,type Recipe} from './contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {requireCondition} from '../core/contracts.js';
import {assertWorkConnected} from '../work/lifecycle.js';
import {readWorkIntakeOptions} from '../work/intake-options.js';
import {validateWorkProposal,type WorkProposal} from '../work/contracts.js';

export const customPackPublishSchema=z.object({
  key,title:z.string().trim().min(1).max(160),work_id:z.string().uuid(),
  supervisor_run_id:z.string().uuid(),pack_run_id:z.string().uuid(),
}).strict();
export const customPackRepeatSchema=z.object({
  key,version:z.number().int().positive().optional(),cycle_id:key,
  parameters:z.record(key,z.record(key,z.string().max(400))).default({}),
}).strict();
/** These bindings come from the host, never from a caller's tool arguments. */
export interface CustomPackHostBinding {config_fingerprint:string;engine_binding:string;}
export interface CustomPackCompletionContract {
  prompt:string;completion_condition:string|null;delivery_target_ids:string[]|null;
  user_directions:ReturnType<PackStore['workDirections']>;
  answers:Record<string,string>;spec:WorkProposal;
}
export interface CustomPackVersion {
  project_id:string;key:string;title:string;version:number;state:'ready';
  definition_sha256:string;recipe:Recipe;completion_contract:CustomPackCompletionContract;
  config_fingerprint:string;engine_binding:string;
  source:{work_id:string;work_revision:number;supervisor_run_id:string;pack_run_id:string;verification_sha256:string};
  created_at:string;
}
export interface CustomPackRepeat {
  key:string;version:number;cycle_id:string;request_id:string;recipe:Recipe;
  completion_contract:CustomPackCompletionContract;
  parameters:Record<string,Record<string,string>>;
  dispatch_allowed:false;completion_verified:false;created:boolean;
}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const decode=(value:unknown)=>JSON.parse(String(value)) as unknown;
const credentialLike=/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/u;
function observations(checkpoint:unknown):Record<string,unknown>[] {
  const record=object(checkpoint),direct=Array.isArray(record.observations)?record.observations.map(object):[];
  return [...direct,...Object.values(object(record.workers)).flatMap(worker=>observations(worker))];
}
function matchingPackReceipt(checkpoint:unknown,run:PackRun,recipe:Recipe):boolean {
  return observations(checkpoint).some(observation=>{
    const invocation=object(observation.invocation),args=object(invocation.arguments),receipt=object(observation.receipt),value=object(receipt.value);
    if(invocation.dispatched!==true||receipt.status!=='succeeded'||receipt.effect_state!=='verified'||!Array.isArray(receipt.evidence_ids)||!receipt.evidence_ids.includes(invocation.request_id))return false;
    if(value.run_id!==run.id||value.family!==recipe.family||value.status!==run.status||value.task_id!==run.task_id||!Object.hasOwn(value,'result')||snapshotHash(value.result)!==snapshotHash(run.result))return false;
    if(invocation.tool_name==='runtime_pack_execute_approved')return invocation.effect==='external_write'&&args.run_id===run.id;
    if(invocation.tool_name!=='runtime_pack_run')return false;
    // The executor replaces a model's request_id alias with this host-owned
    // invocation ID; checkpoint arguments preserve the original proposal.
    if(invocation.effect!=='local_write'||invocation.request_id!==run.request_id)return false;
    const parsed=recipeSchema.safeParse(args.recipe);
    return parsed.success&&snapshotHash(parsed.data)===snapshotHash(recipe);
  });
}

/** A verified family recipe is a reusable procedure, not a reusable result.
 * Legacy family_spec entries remain planning hints and never grant readiness.
 * Each repeat must enter ordinary Work admission and independent verification.
 */
export class CustomPackRegistry {
  constructor(private readonly store:PackStore){
    store.hermesState.exec(`
      CREATE TABLE IF NOT EXISTS office_custom_pack(project_id TEXT NOT NULL,pack_key TEXT NOT NULL,title TEXT NOT NULL,current_version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,pack_key));
      CREATE TABLE IF NOT EXISTS office_custom_pack_version(project_id TEXT NOT NULL,pack_key TEXT NOT NULL,version INTEGER NOT NULL,title TEXT NOT NULL,definition_sha256 TEXT NOT NULL,recipe TEXT NOT NULL,completion_contract TEXT NOT NULL,config_fingerprint TEXT NOT NULL,engine_binding TEXT NOT NULL,source_work_id TEXT NOT NULL,source_work_revision INTEGER NOT NULL,source_supervisor_run_id TEXT NOT NULL,source_pack_run_id TEXT NOT NULL,verification_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,pack_key,version),UNIQUE(project_id,pack_key,definition_sha256));
      CREATE TABLE IF NOT EXISTS office_custom_pack_cycle(project_id TEXT NOT NULL,pack_key TEXT NOT NULL,version INTEGER NOT NULL,cycle_id TEXT NOT NULL,request_id TEXT NOT NULL,parameters TEXT NOT NULL,parameters_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,pack_key,cycle_id),UNIQUE(project_id,request_id));
    `);
  }
  list(project:string){
    return this.store.hermesState.prepare('SELECT pack_key,title,current_version,created_at,updated_at FROM office_custom_pack WHERE project_id=? ORDER BY updated_at DESC,pack_key').all(project).map(row=>({key:String(row.pack_key),title:String(row.title),version:Number(row.current_version),state:'ready' as const,created_at:String(row.created_at),updated_at:String(row.updated_at)}));
  }
  versions(project:string,packKey:string){
    key.parse(packKey);
    return this.store.hermesState.prepare('SELECT version FROM office_custom_pack_version WHERE project_id=? AND pack_key=? ORDER BY version').all(project,packKey).map(row=>this.get(project,packKey,Number(row.version)));
  }
  get(project:string,packKey:string,version?:number):CustomPackVersion {
    key.parse(packKey);if(version!==undefined)z.number().int().positive().parse(version);
    const row=this.store.hermesState.prepare(`SELECT v.* FROM office_custom_pack_version v JOIN office_custom_pack p ON p.project_id=v.project_id AND p.pack_key=v.pack_key WHERE v.project_id=? AND v.pack_key=? AND v.version=${version===undefined?'p.current_version':'?'}`).get(project,packKey,...(version===undefined?[]:[version]));
    requireCondition(row,'CUSTOM_PACK_NOT_FOUND');
    return {project_id:project,key:packKey,title:String(row.title),version:Number(row.version),state:'ready',definition_sha256:String(row.definition_sha256),recipe:recipeSchema.parse(decode(row.recipe)),completion_contract:decode(row.completion_contract) as CustomPackCompletionContract,config_fingerprint:String(row.config_fingerprint),engine_binding:String(row.engine_binding),source:{work_id:String(row.source_work_id),work_revision:Number(row.source_work_revision),supervisor_run_id:String(row.source_supervisor_run_id),pack_run_id:String(row.source_pack_run_id),verification_sha256:String(row.verification_sha256)},created_at:String(row.created_at)};
  }
  publishVerified(project:string,raw:unknown,host:CustomPackHostBinding):{pack:CustomPackVersion;created:boolean} {
    const input=customPackPublishSchema.parse(raw),db=this.store.hermesState;
    requireCondition(!credentialLike.test(input.title),'CREDENTIAL_LIKE_INPUT');
    return this.store.transaction(()=>{
      assertWorkConnected(this.store,project,input.work_id);
      const work=this.store.intakeWork(project,input.work_id);
      requireCondition(db.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get(),'CUSTOM_PACK_WORK_NOT_VERIFIED');
      const verified=db.prepare('SELECT * FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(project,work.id,input.supervisor_run_id);
      const result=verified?.result?object(decode(verified.result)):{};
      requireCondition(verified?.state==='succeeded'&&result.completion_verified===true,'CUSTOM_PACK_WORK_NOT_VERIFIED');
      requireCondition(Number(verified.work_revision)===work.revision,'CUSTOM_PACK_WORK_REVISION_CHANGED');
      requireCondition(verified.config_hash===host.config_fingerprint,'CUSTOM_PACK_CONFIG_CHANGED');
      const recipeRun=this.store.packRun(project,input.pack_run_id),recipe=recipeSchema.parse(recipeRun.recipe);
      requireCondition(['succeeded','watching','draft_ready'].includes(recipeRun.status),'CUSTOM_PACK_RECIPE_NOT_SUCCEEDED');
      requireCondition(recipeRun.binding===snapshotHash({recipe,fingerprint:host.engine_binding}),'CUSTOM_PACK_ENGINE_CHANGED');
      const ownedRuns=this.store.officeRuns(project,work.id),checkpoint=decode(verified.checkpoint);
      requireCondition(ownedRuns.some(run=>run.source_kind==='pack'&&run.source_id===recipeRun.id),'CUSTOM_PACK_WORK_RUN_MISMATCH');
      requireCondition(matchingPackReceipt(checkpoint,recipeRun,recipe),'CUSTOM_PACK_RECEIPT_NOT_VERIFIED');
      // A ready version can execute one recipe. Do not turn a verified composite
      // Work into a partial procedure by selecting just one of its successful
      // recipes. Failed, undispatched and unrelated runs are not execution proof.
      const demonstratedRecipes=new Set([snapshotHash(recipe)]);
      for(const owned of ownedRuns){
        if(owned.source_kind!=='pack'||owned.source_id===recipeRun.id)continue;
        const candidate=this.store.packRun(project,owned.source_id);
        if(!['succeeded','watching','draft_ready'].includes(candidate.status))continue;
        const candidateRecipe=recipeSchema.parse(candidate.recipe);
        if(matchingPackReceipt(checkpoint,candidate,candidateRecipe))demonstratedRecipes.add(snapshotHash(candidateRecipe));
      }
      requireCondition(demonstratedRecipes.size===1,'CUSTOM_PACK_MULTIPLE_RECIPES_UNSUPPORTED');
      const spec=validateWorkProposal(work.spec,work.mode,true);
      requireCondition(spec.route.kind==='pack'&&spec.route.pack_family===recipe.family,'CUSTOM_PACK_WORK_FAMILY_MISMATCH');
      if(recipeRun.status==='draft_ready')requireCondition(['read_only','draft_only','local_file_write'].includes(spec.requested_effect),'CUSTOM_PACK_DRAFT_NOT_FINAL_OUTCOME');
      const intake=readWorkIntakeOptions(this.store,project,work.id);
      const contract:CustomPackCompletionContract={prompt:work.prompt,...intake,user_directions:this.store.workDirections(project,work.id),answers:work.answers,spec};
      const binding={recipe,completion_contract:contract,config_fingerprint:host.config_fingerprint,engine_binding:host.engine_binding},digest=snapshotHash(binding);
      const prior=db.prepare('SELECT version FROM office_custom_pack_version WHERE project_id=? AND pack_key=? AND definition_sha256=?').get(project,input.key,digest);
      if(prior)return {pack:this.get(project,input.key,Number(prior.version)),created:false};
      const identity=db.prepare('SELECT current_version FROM office_custom_pack WHERE project_id=? AND pack_key=?').get(project,input.key),version=identity?Number(identity.current_version)+1:1,at=new Date().toISOString();
      db.prepare('INSERT INTO office_custom_pack_version VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(project,input.key,version,input.title,digest,JSON.stringify(recipe),JSON.stringify(contract),host.config_fingerprint,host.engine_binding,work.id,work.revision,input.supervisor_run_id,recipeRun.id,snapshotHash({result,checkpoint:decode(verified.checkpoint)}),at);
      db.prepare('INSERT INTO office_custom_pack VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,pack_key) DO UPDATE SET title=excluded.title,current_version=excluded.current_version,updated_at=excluded.updated_at').run(project,input.key,input.title,version,at,at);
      return {pack:this.get(project,input.key,version),created:true};
    });
  }
  prepareRepeat(project:string,raw:unknown,host:CustomPackHostBinding):CustomPackRepeat {
    return this.store.transaction(()=>this.prepareRepeatBody(project,raw,host));
  }
  /** Atomically reserve a cycle and let the Work layer persist its fresh
   * execution binding. A callback failure rolls back the cycle too. */
  prepareRepeatWithWork<T>(project:string,raw:unknown,host:CustomPackHostBinding,register:(prepared:CustomPackRepeat)=>T):T {
    return this.store.transaction(()=>register(this.prepareRepeatBody(project,raw,host)));
  }
  private prepareRepeatBody(project:string,raw:unknown,host:CustomPackHostBinding):CustomPackRepeat {
    const input=customPackRepeatSchema.parse(raw),db=this.store.hermesState;
    requireCondition(!credentialLike.test(JSON.stringify(input.parameters)),'CREDENTIAL_LIKE_INPUT');
      // Existing cycle IDs remain bound to their original version even if a
      // newer procedure is published between a retry and a process restart.
      const prior=db.prepare('SELECT * FROM office_custom_pack_cycle WHERE project_id=? AND pack_key=? AND cycle_id=?').get(project,input.key,input.cycle_id);
      const pack=this.get(project,input.key,input.version??(prior?Number(prior.version):undefined));
      requireCondition(pack.config_fingerprint===host.config_fingerprint,'CUSTOM_PACK_CONFIG_CHANGED');
      requireCondition(pack.engine_binding===host.engine_binding,'CUSTOM_PACK_ENGINE_CHANGED');
      const recipe=structuredClone(pack.recipe);
      for(const [sourceId,parameters] of Object.entries(input.parameters)){
        const matches='sources' in recipe?recipe.sources.filter(source=>source.id===sourceId):[];
        requireCondition(matches.length>0,'CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN');
        requireCondition(matches.length===1,'CUSTOM_PACK_SOURCE_PARAMETER_AMBIGUOUS');
        const source=matches[0]!;
        for(const [name,value] of Object.entries(parameters)){
          requireCondition(Object.hasOwn(source.parameters,name),'CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN');
          source.parameters[name]=value;
        }
      }
      const parsed=recipeSchema.parse(recipe),parametersHash=snapshotHash(input.parameters);
      if(prior)requireCondition(Number(prior.version)===pack.version&&prior.parameters_sha256===parametersHash,'CUSTOM_PACK_CYCLE_CONFLICT');
      const requestId=prior?String(prior.request_id):`custom-${snapshotHash({project,key:input.key,version:pack.version,cycle_id:input.cycle_id}).slice(0,48)}`;
      if(!prior)db.prepare('INSERT INTO office_custom_pack_cycle VALUES(?,?,?,?,?,?,?,?)').run(project,input.key,pack.version,input.cycle_id,requestId,JSON.stringify(input.parameters),parametersHash,new Date().toISOString());
      return {key:input.key,version:pack.version,cycle_id:input.cycle_id,request_id:requestId,recipe:parsed,completion_contract:structuredClone(pack.completion_contract),parameters:structuredClone(input.parameters),dispatch_allowed:false,completion_verified:false,created:!prior};
  }
}
