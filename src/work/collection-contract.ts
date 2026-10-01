import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {filePipelineRecipeSchema,key,portalCollectRecipeSchema,recipeSchema,type Recipe,type Source} from '../packs/contracts.js';
import {nativeOutputCertificate} from '../packs/native-output-certificate.js';
import {PACK_ENGINE_VERSION} from '../packs/engine-version.js';
import {type PackStore,type IntakeWork} from '../packs/store.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WorkProposal} from './contracts.js';
import {type WorkClientCheckpoint,type workClientDecisionSchema} from './client-executor.js';
import {readWorkIntakeOptions} from './intake-options.js';

const checkId=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
export const collectionRecipeSchema=z.discriminatedUnion('family',[portalCollectRecipeSchema,filePipelineRecipeSchema]);
/** Model-facing proposal shape. Only sealCollectionContract can grant its
 * narrowly bound local-output authority. Other Pack families are rejected. */
export const collectionContractSchema=z.object({
  version:z.literal(1),recipe:collectionRecipeSchema,scope:z.literal('all_matching_observed_rows'),
  covered_check_ids:z.array(checkId).min(1).max(8),
}).strict();
export type CollectionContract=z.infer<typeof collectionContractSchema>;
const modelParameter=z.object({name:key,value:z.string().max(400)}).strict();
const modelSource=z.object({id:key,parameters:z.array(modelParameter).max(20)}).strict();
const modelSources=z.array(modelSource).min(1).max(24);
export const modelCollectionRecipeSchema=z.discriminatedUnion('family',[
  portalCollectRecipeSchema.omit({browser:true,verification:true,sources:true}).extend({sources:modelSources}).strict(),
  filePipelineRecipeSchema.omit({browser:true,verification:true,sources:true}).extend({sources:modelSources}).strict(),
]);
/** Codex structured output does not accept JSON Schema propertyNames, so only
 * the model-facing source parameters are pairs. Durable recipes remain maps. */
export const modelCollectionContractSchema=z.object({
  version:z.literal(1),recipe:modelCollectionRecipeSchema,scope:z.literal('all_matching_observed_rows'),
  covered_check_ids:z.array(checkId).min(1).max(8),
}).strict();
export function compileModelCollectionContract(raw:unknown):CollectionContract{
  const candidate=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
  const recipe=candidate?.recipe&&typeof candidate.recipe==='object'&&!Array.isArray(candidate.recipe)?candidate.recipe as Record<string,unknown>:null;
  const sources=Array.isArray(recipe?.sources)?recipe.sources:[];
  if(!sources.some(source=>source&&typeof source==='object'&&!Array.isArray(source)&&Array.isArray((source as Record<string,unknown>).parameters)))return collectionContractSchema.parse(raw);
  const model=modelCollectionContractSchema.parse(raw),compiled=model.recipe.sources.map(source=>{
    const names=source.parameters.map(parameter=>parameter.name);
    requireCondition(new Set(names).size===names.length,'WORK_COLLECTION_PARAMETER_DUPLICATE');
    requireCondition(names.every(name=>!['__proto__','prototype','constructor'].includes(name)),'WORK_COLLECTION_PARAMETER_NAME_UNSAFE');
    return {id:source.id,parameters:Object.fromEntries(source.parameters.map(parameter=>[parameter.name,parameter.value]))};
  });
  return collectionContractSchema.parse({...model,recipe:{...model.recipe,sources:compiled}});
}
type CollectionRecipe=Extract<Recipe,{family:'portal.collect'|'file.pipeline'}>;
interface SealBody {
  version:1;contract:CollectionContract;contract_sha256:string;recipe_sha256:string;
  source_id:string;source_sha256:string;user_request_sha256:string;spec_sha256:string;
  sealed_work_revision:number;sealed_at:string;
}
const sha256=z.string().regex(/^[a-f0-9]{64}$/u);
const sealBodySchema=z.object({
  version:z.literal(1),contract:collectionContractSchema,contract_sha256:sha256,recipe_sha256:sha256,
  source_id:z.string().min(1),source_sha256:sha256,user_request_sha256:sha256,spec_sha256:sha256,
  sealed_work_revision:z.number().int().nonnegative(),sealed_at:z.string().datetime({offset:true}),
}).strict();

function table(store:PackStore){store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_collection_contract (
  project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),work_revision INTEGER NOT NULL,
  body TEXT,created_at TEXT NOT NULL,PRIMARY KEY(project_id,work_id,work_revision)
);`);}
function latest(store:PackStore,project:string,workId:string):{work_revision:number;body:string|null}|null{
  if(!store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_collection_contract'").get())return null;
  const row=store.hermesState.prepare('SELECT work_revision,body FROM office_collection_contract WHERE project_id=? AND work_id=? ORDER BY work_revision DESC LIMIT 1').get(project,workId);
  return row?{work_revision:Number(row.work_revision),body:row.body===null?null:String(row.body)}:null;
}
function userRequestHash(store:PackStore,project:string,work:IntakeWork){
  return snapshotHash({prompt:work.prompt,intake:readWorkIntakeOptions(store,project,work.id),answers:work.answers,user_directions:store.workDirections(project,work.id)});
}
function selectedSource(config:HostConfig,recipe:Recipe):Source{
  requireCondition(recipe.family==='portal.collect'||recipe.family==='file.pipeline','WORK_COLLECTION_FAMILY_UNSUPPORTED');
  requireCondition(recipe.sources.length===1,'WORK_COLLECTION_SINGLE_SOURCE_REQUIRED');
  const requested=recipe.sources[0]!,source=config.packs?.sources.find(item=>item.id===requested.id);
  requireCondition(source&&(source.kind==='file'||source.kind==='http'),'WORK_COLLECTION_SOURCE_UNSUPPORTED');
  requireCondition(source.kind==='file'?Object.keys(requested.parameters).length===0:Object.keys(requested.parameters).every(name=>source.parameters.includes(name)),'WORK_COLLECTION_PARAMETER_NOT_DELEGATED');
  requireCondition(recipe.family!=='file.pipeline'||source.kind==='file','WORK_COLLECTION_FILE_SOURCE_REQUIRED');
  return source;
}
function validatedContract(config:HostConfig,spec:WorkProposal):{contract:CollectionContract;recipe:CollectionRecipe;source:Source}|null{
  const proposed=(spec as WorkProposal&{collection_contract?:unknown}).collection_contract;
  if(proposed===undefined||proposed===null)return null;
  const contract=collectionContractSchema.parse(proposed),recipe=contract.recipe;
  requireCondition(recipe.family==='portal.collect'||recipe.family==='file.pipeline','WORK_COLLECTION_FAMILY_UNSUPPORTED');
  requireCondition(!recipe.browser&&!recipe.verification,'WORK_COLLECTION_SEMANTIC_VERIFICATION_UNSUPPORTED');
  requireCondition(spec.route.kind==='pack'&&spec.route.pack_family===recipe.family,'WORK_COLLECTION_ROUTE_MISMATCH');
  requireCondition(['read_only','draft_only','local_file_write'].includes(spec.requested_effect),'WORK_COLLECTION_EFFECT_UNSUPPORTED');
  requireCondition(new Set(contract.covered_check_ids).size===contract.covered_check_ids.length,'WORK_COLLECTION_CHECK_DUPLICATE');
  for(const id of contract.covered_check_ids)requireCondition(spec.completion_checks.some(item=>item.id===id),'WORK_COLLECTION_CHECK_NOT_FOUND');
  for(const id of contract.covered_check_ids){
    const native=spec.completion_checks.find(item=>item.id===id)?.native_check;
    requireCondition(!native||native.kind==='native_pack_output'&&native.family===recipe.family,'WORK_COLLECTION_CHECK_UNSUPPORTED');
  }
  return {contract,recipe,source:selectedSource(config,recipe)};
}

/** Call only after a successful initial definition or an explicit replan has
 * stored its new spec. Revisions are append-only, including a revoked seal. */
export function sealCollectionContract(store:PackStore,config:HostConfig,workId:string,spec:WorkProposal):SealBody|null{
  const project=config.project.id,work=store.intakeWork(project,workId);
  requireCondition(snapshotHash(work.spec)===snapshotHash(spec),'WORK_COLLECTION_SPEC_NOT_STORED');
  const selected=validatedContract(config,spec),prior=latest(store,project,workId);
  if(!selected&&!prior)return null;
  const at=new Date().toISOString(),body:SealBody|null=selected?{
    version:1,contract:selected.contract,contract_sha256:snapshotHash(selected.contract),recipe_sha256:snapshotHash(selected.recipe),
    source_id:selected.source.id,source_sha256:snapshotHash(selected.source),user_request_sha256:userRequestHash(store,project,work),
    spec_sha256:snapshotHash(spec),sealed_work_revision:work.revision,sealed_at:at,
  }:null;
  store.hermesState.exec('SAVEPOINT office_collection_seal');
  try{
    table(store);
    const existing=latest(store,project,workId);
    requireCondition(!existing||existing.work_revision<=work.revision,'WORK_COLLECTION_REVISION_STALE');
    if(existing?.work_revision===work.revision){
      let old:SealBody|null=null;
      try{old=existing.body?sealBodySchema.parse(JSON.parse(existing.body)):null;}
      catch{throw Error('WORK_COLLECTION_SEAL_INVALID');}
      const comparable=(value:SealBody|null)=>value?{...value,sealed_at:null}:null;
      requireCondition(snapshotHash(comparable(old))===snapshotHash(comparable(body)),'WORK_COLLECTION_SEAL_CONFLICT');
      store.hermesState.exec('RELEASE office_collection_seal');
      return old;
    }
    store.hermesState.prepare('INSERT INTO office_collection_contract(project_id,work_id,work_revision,body,created_at) VALUES(?,?,?,?,?)').run(project,workId,work.revision,body?JSON.stringify(body):null,at);
    store.hermesState.exec('RELEASE office_collection_seal');
    return body;
  }catch(error){store.hermesState.exec('ROLLBACK TO office_collection_seal');store.hermesState.exec('RELEASE office_collection_seal');throw error;}
}

/** Read-only current authority check. A missing seal for a proposed contract
 * or any source/request/spec drift fails closed. Older uncontracted Works keep
 * their original model verification path. */
export function readSealedCollectionContract(store:PackStore,config:HostConfig,workId:string,spec?:WorkProposal):SealBody|null{
  const project=config.project.id,work=store.intakeWork(project,workId),current=spec??work.spec as WorkProposal;
  requireCondition(snapshotHash(work.spec)===snapshotHash(current),'WORK_COLLECTION_SPEC_CHANGED');
  const saved=latest(store,project,workId),proposed=(current as WorkProposal&{collection_contract?:unknown}).collection_contract;
  if(!saved||saved.body===null){requireCondition(proposed===undefined||proposed===null,'WORK_COLLECTION_SEAL_MISSING');return null;}
  requireCondition(saved.work_revision<=work.revision&&proposed!==undefined&&proposed!==null,'WORK_COLLECTION_SEAL_CHANGED');
  let body:SealBody;
  try{body=sealBodySchema.parse(JSON.parse(saved.body));}
  catch{throw Error('WORK_COLLECTION_SEAL_INVALID');}
  const validated=validatedContract(config,current);
  requireCondition(body.version===1&&validated&&body.sealed_work_revision===saved.work_revision&&body.source_id===validated.source.id&&body.source_sha256===snapshotHash(validated.source)&&body.contract_sha256===snapshotHash(validated.contract)&&body.recipe_sha256===snapshotHash(validated.recipe)&&body.user_request_sha256===userRequestHash(store,project,work)&&body.spec_sha256===snapshotHash(current),'WORK_COLLECTION_CONTRACT_CHANGED');
  return body;
}

/** Use at the Work tool pre-dispatch boundary. An LLM cannot replace a sealed
 * recipe, even when its replacement would also produce a valid Pack receipt. */
export function assertSealedCollectionRecipe(store:PackStore,config:HostConfig,workId:string,recipe:Recipe):SealBody|null{
  const body=readSealedCollectionContract(store,config,workId);
  if(body)requireCondition(snapshotHash(recipeSchema.parse(recipe))===body.recipe_sha256,'WORK_COLLECTION_RECIPE_CHANGED');
  return body;
}

/** The request is descriptive prose, not an input to these pure native
 * transformations. The original user request and completion checks remain
 * separately sealed; only retrospective output verification may ignore this
 * one field. Pre-dispatch authority still requires the full recipe hash. */
function mechanicalRecipeHash(raw:unknown):string{
  const {request:description,...mechanics}=collectionRecipeSchema.parse(raw);
  void description;
  return snapshotHash(mechanics);
}

function latestMechanicalCollectionRunId(store:PackStore,project:string,workId:string,recipeMechanicalSha256:string):string|null{
  const rows=store.hermesState.prepare("SELECT r.id,r.recipe FROM family_run r JOIN office_run o ON o.project_id=r.project_id AND o.source_kind='pack' AND o.source_id=r.id WHERE r.project_id=? AND o.work_id=? ORDER BY r.rowid DESC").iterate(project,workId);
  for(const row of rows){
    try{if(mechanicalRecipeHash(JSON.parse(String(row.recipe)))===recipeMechanicalSha256)return String(row.id);}catch{/* Malformed saved recipes cannot gain contract authority. */}
  }
  return null;
}

/** Reopen the durable same-Work run and fresh native certificate. This proves
 * only the sealed single-source observation-to-artifact transformation. */
export async function verifySealedCollectionRun(store:PackStore,config:HostConfig,workId:string,runId:string):Promise<{seal:SealBody;certificate:NonNullable<Awaited<ReturnType<typeof nativeOutputCertificate>>>}|null>{
  const seal=readSealedCollectionContract(store,config,workId);
  if(!seal)return null;
  const sealedMechanicalSha256=mechanicalRecipeHash(seal.contract.recipe);
  if(latestMechanicalCollectionRunId(store,config.project.id,workId,sealedMechanicalSha256)!==runId)return null;
  let run;
  try{run=store.packRun(config.project.id,runId);}catch(error){if(error instanceof Error&&error.message==='PACK_RUN_NOT_FOUND')return null;throw error;}
  const owned=store.officeWork(config.project.id,'pack',runId) as {id:string}|null;
  const binding=snapshotHash({recipe:run.recipe,fingerprint:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})});
  if(owned?.id!==workId||run.status!=='succeeded'||run.task_id!==null||run.binding!==binding||mechanicalRecipeHash(run.recipe)!==sealedMechanicalSha256)return null;
  const certificate=await nativeOutputCertificate(store,config,run);
  if(!certificate||certificate.recipe_sha256!==snapshotHash(run.recipe)||certificate.run_id!==runId||certificate.exact_native_bytes_match!==true)return null;
  return {seal,certificate};
}

export type CollectionCompletionResolution={covered_check_ids:string[];verified:boolean;evidence_ids:string[];certificate_sha256?:string;reason:string};
type Observation=WorkClientCheckpoint['observations'][number];
type Claim=z.infer<typeof workClientDecisionSchema>;
const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function nativeCoveredChecksMatch(checks:WorkProposal['completion_checks'],covered:string[],certificate:NonNullable<Awaited<ReturnType<typeof nativeOutputCertificate>>>){
  return covered.every(id=>{
    const native=checks.find(check=>check.id===id)?.native_check;
    if(!native)return true;
    if(native.kind!=='native_pack_output')return false;
    const expected={family:native.family,format:native.format,columns:native.columns,output_rows:native.output_rows==='observed_source_rows'?certificate.observed_source_rows:native.output_rows,numeric_columns:native.numeric_columns,sort:native.sort};
    const actual={family:certificate.family,format:certificate.format,columns:certificate.columns,output_rows:certificate.output_rows,numeric_columns:certificate.numeric_columns,sort:certificate.sort};
    return snapshotHash(expected)===snapshotHash(actual);
  });
}

/** Null means this Work never opted into native collection completion. A
 * contracted Work that lacks valid same-run receipts fails closed, never falls
 * back to an LLM claim about its supposedly covered conditions. */
export function createCollectionCompletionResolver(store:PackStore,config:HostConfig,workId:string){
  return async(checks:WorkProposal['completion_checks'],observations:Observation[],claim:Claim):Promise<CollectionCompletionResolution|null>=>{
    const seal=readSealedCollectionContract(store,config,workId);
    if(!seal)return null;
    const covered=seal.contract.covered_check_ids;
    const current=store.intakeWork(config.project.id,workId).spec as WorkProposal|null;
    requireCondition(current&&snapshotHash(checks)===snapshotHash(current.completion_checks),'WORK_COLLECTION_CHECKS_CHANGED');
    const cited=covered.map(id=>claim.completed_checks.find(item=>item.id===id)?.evidence_ids??[]);
    if(cited.some(ids=>ids.length===0))return {covered_check_ids:covered,verified:false,evidence_ids:[],reason:'WORK_COLLECTION_COVERED_EVIDENCE_MISSING'};
    let failureReason='WORK_COLLECTION_RESULT_NOT_VERIFIED';
    for(const observation of observations){
      const name=observation.invocation.tool_name;
      if(!['runtime_pack_run','runtime_pack_status'].includes(name)||!observation.invocation.dispatched||observation.receipt.status!=='succeeded'||observation.receipt.effect_state==='uncertain')continue;
      const ids=observation.receipt.evidence_ids;
      if(ids.length===0||cited.some(expected=>!expected.some(id=>ids.includes(id))))continue;
      const value=object(observation.receipt.value);
      if(typeof value?.run_id!=='string'||value.status!=='succeeded')continue;
      let run;
      try{run=store.packRun(config.project.id,value.run_id);}catch{continue;}
      if(name==='runtime_pack_run'&&run.request_id!==observation.invocation.request_id)continue;
      if(name==='runtime_pack_status'&&observation.invocation.arguments.run_id!==run.id)continue;
      if(snapshotHash(value.result)!==snapshotHash(run.result))continue;
      try{
        if(mechanicalRecipeHash(run.recipe)!==mechanicalRecipeHash(seal.contract.recipe)){
          failureReason='WORK_COLLECTION_MECHANICAL_RECIPE_MISMATCH';
          continue;
        }
      }catch{failureReason='WORK_COLLECTION_SAVED_RECIPE_INVALID';continue;}
      if(latestMechanicalCollectionRunId(store,config.project.id,workId,mechanicalRecipeHash(seal.contract.recipe))!==run.id){
        failureReason='WORK_COLLECTION_LATEST_RUN_NOT_CITED';
        continue;
      }
      const result=await verifySealedCollectionRun(store,config,workId,run.id);
      if(!result){failureReason='WORK_COLLECTION_NATIVE_OUTPUT_NOT_VERIFIED';continue;}
      if(!nativeCoveredChecksMatch(checks,covered,result.certificate)){failureReason='WORK_COLLECTION_NATIVE_CHECK_MISMATCH';continue;}
      return {covered_check_ids:covered,verified:true,evidence_ids:ids.filter(id=>cited.some(expected=>expected.includes(id))),certificate_sha256:snapshotHash(result.certificate),reason:'Fresh same-Work native output and sealed collection recipe match.'};
    }
    return {covered_check_ids:covered,verified:false,evidence_ids:[],reason:failureReason};
  };
}
export type CollectionCompletionResolver=ReturnType<typeof createCollectionCompletionResolver>;
