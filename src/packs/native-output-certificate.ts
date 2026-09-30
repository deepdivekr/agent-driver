import {dirname,join,resolve} from 'node:path';
import {type HostConfig} from '../interface/config.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {rowSchema,type Row} from './contracts.js';
import {applyFilters,deduplicate,encodeCsv,MAX_ROWS,normalizeNumericColumns,readScopedFile,sha,sortRows} from './data.js';
import {type PackRun,PackStore} from './store.js';

const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const hash=(value:unknown)=>snapshotHash(value);

/** Lossless, bounded readback of this run's already collected research rows.
 * No network/file reread, freshness claim or inferred fields. An incomplete,
 * changed or oversized checkpoint is unavailable rather than truncated. */
export function savedResearchSourceReadback(store:PackStore,config:HostConfig,run:PackRun){
  try{
    if(run.status!=='succeeded'||run.recipe.family!=='research.search'||!config.packs)return null;
    const execution=store.packExecution(config.project.id,run.id),savedSources=object(execution?.checkpoint.sources),result=object(run.result);
    if(!savedSources||!result||!Array.isArray(result.evidence)||Object.keys(savedSources).length!==run.recipe.sources.length)return null;
    const sources=[];let count=0;
    for(const [index,requested] of run.recipe.sources.entries()){
      const source=config.packs.sources.find(value=>value.id===requested.id),saved=object(savedSources[String(index)]),collected=object(saved?.result),proof=object(collected?.evidence);
      if(!source||!saved||!collected||!proof||!Array.isArray(collected.rows)||saved.binding!==hash({source,requested,config:config.fingerprint})||saved.digest!==hash(collected)||proof.source_id!==requested.id||proof.request_sha256!==hash({id:requested.id,parameters:requested.parameters})||proof.rows!==collected.rows.length)return null;
      if(source.kind==='http'&&source.json_fields&&hash(proof.projection_fields)!==hash(source.json_fields))return null;
      const rows=collected.rows.map(value=>rowSchema.parse(value));count+=rows.length;if(count>50)return null;
      sources.push({source_id:requested.id,rows,evidence:structuredClone(proof),saved_observation_sha256:hash(collected)});
    }
    if(result.collected_rows!==count||hash(result.evidence)!==hash(sources.map(source=>source.evidence)))return null;
    const readback={scope:'Complete saved source observations before filtering; no fresh request and no claim of current remote values.',observed_source_rows:count,sources,user_goal_verified:'not_asserted'};
    const encoded=JSON.stringify(readback);
    if(Buffer.byteLength(encoded,'utf8')>16384||/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(encoded)||sources.some(source=>source.rows.some(row=>Object.keys(row).some(key=>/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key)))))return null;
    return readback;
  }catch{return null;}
}

/** A bounded, host-computed statement about observed rows and exact local
 * bytes. It never asserts that a recipe matched the user's business goal or
 * that an HTTP/browser source is still current. Invalid provenance is null. */
export async function nativeOutputCertificate(store:PackStore,config:HostConfig,run:PackRun){
  try{
    if(run.status!=='succeeded'||run.task_id!==null||!['portal.collect','file.pipeline'].includes(run.recipe.family))return null;
    const recipe=run.recipe;
    if(recipe.family!=='portal.collect'&&recipe.family!=='file.pipeline')return null;
    const execution=store.packExecution(config.project.id,run.id),sources=object(execution?.checkpoint.sources),result=object(run.result),artifact=object(result?.artifact);
    if(!sources||!result||!artifact||!config.packs||!Array.isArray(result.evidence))return null;
    const observed:Row[]=[],evidence:unknown[]=[],checkpoints:unknown[]=[];
    let fileCount=0;
    for(const [index,requested] of recipe.sources.entries()){
      const registered=config.packs.sources.find(source=>source.id===requested.id),saved=object(sources[String(index)]),collected=object(saved?.result),rows=collected?.rows,proof=object(collected?.evidence);
      if(!registered||recipe.family==='file.pipeline'&&registered.kind!=='file'||!saved||!collected||!Array.isArray(rows)||!proof)return null;
      if(saved.binding!==hash({source:registered,requested,config:config.fingerprint})||saved.digest!==hash(collected)||proof.source_id!==requested.id||proof.request_sha256!==hash({id:requested.id,parameters:requested.parameters})||proof.rows!==rows.length||typeof proof.content_sha256!=='string'||!/^[a-f0-9]{64}$/u.test(proof.content_sha256))return null;
      if(registered.kind==='http'&&registered.json_fields&&hash(proof.projection_fields)!==hash(registered.json_fields))return null;
      if(registered.kind==='file'){
        if(proof.executor!=='local_file'||sha(await readScopedFile(registered.path))!==proof.content_sha256)return null;
        fileCount++;
      }else if(registered.kind==='http'&&proof.executor!=='http_get')return null;
      for(const value of rows){const parsed=rowSchema.safeParse(value);if(!parsed.success)return null;observed.push(parsed.data);}
      if(observed.length>MAX_ROWS)return null;
      evidence.push(proof);checkpoints.push(saved);
    }
    if(Object.keys(sources).length!==recipe.sources.length||result.collected_rows!==observed.length||hash(result.evidence)!==hash(evidence))return null;
    const normalized=recipe.family==='file.pipeline'?normalizeNumericColumns(observed,recipe.numeric_columns):observed;
    const filtered=applyFilters(normalized,recipe.filters),deduped=deduplicate(filtered,recipe.deduplicate_by);
    if(result.matched_rows!==deduped.length)return null;
    let output:Row[],columns:string[];
    if(recipe.family==='portal.collect'){
      if(recipe.columns&&!deduped.every(row=>recipe.columns!.every(column=>Object.hasOwn(row,column))))return null;
      output=recipe.columns?deduped.map(row=>Object.fromEntries(recipe.columns!.map(column=>[column,row[column]!]))):deduped;
      columns=recipe.columns??[...new Set(output.flatMap(row=>Object.keys(row)))];
    }else{
      if(!recipe.numeric_columns.every(column=>recipe.columns.includes(column))||!deduped.every(row=>recipe.columns.every(column=>Object.hasOwn(row,column))))return null;
      output=sortRows(deduped,recipe.sort).map(row=>Object.fromEntries(recipe.columns.map(column=>[column,row[column]!])));
      columns=recipe.columns;
    }
    if(recipe.format==='csv'&&columns.length===0)return null;
    const expected=Buffer.from(recipe.format==='json'?JSON.stringify(output,null,2)+'\n':encodeCsv(output,columns));
    const root=join(dirname(config.dbPath),'pack-artifacts');
    if(typeof artifact.path!=='string'||resolve(dirname(artifact.path))!==resolve(root)||artifact.format!==recipe.format||artifact.rows!==output.length||artifact.originals_modified!==false||artifact.bytes!==expected.length||artifact.sha256!==sha(expected))return null;
    const actual=await readScopedFile(artifact.path);
    if(!actual.equals(expected)||sha(actual)!==artifact.sha256)return null;
    return {version:1,scope:'saved_source_observations_to_local_artifact',family:recipe.family,run_id:run.id,recipe_sha256:hash(recipe),source_checkpoint_sha256:hash(checkpoints),observed_source_rows:observed.length,filtered_rows:filtered.length,deduplicated_rows:deduped.length,output_rows:output.length,columns,format:recipe.format,sort:recipe.family==='file.pipeline'?recipe.sort:null,numeric_columns:recipe.family==='file.pipeline'?recipe.numeric_columns:[],output_rows_sha256:hash(output),artifact_sha256:sha(actual),artifact_bytes:actual.length,exact_native_bytes_match:true,file_sources_unchanged_at_check:fileCount?'verified':'not_applicable',remote_source_freshness:'not_checked',user_goal_verified:'not_asserted'};
  }catch{return null;}
}
