import {dirname,join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {type HostConfig} from '../interface/config.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {rowSchema,type Row} from './contracts.js';
import {applyFilters,deduplicate,encodedRowsChunks,hashEncodedRows,hashScopedFile,iterateParsedRows,normalizeNumericColumns,scopedFileChunks,sortRows} from './data.js';
import {type PackRun,PackStore} from './store.js';
import {normalizeDeclaredSourceRows,sourceNormalizationMatches,type SourceEvidence} from './sources.js';

const object=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const hash=(value:unknown)=>snapshotHash(value);
const sensitiveRow=(row:Row)=>Object.keys(row).some(key=>/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key))||/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(JSON.stringify(row));

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
      if(!sourceNormalizationMatches(source,rows,proof as unknown as SourceEvidence))return null;
      sources.push({source_id:requested.id,rows,evidence:structuredClone(proof),saved_observation_sha256:hash(collected)});
    }
    if(result.collected_rows!==count||hash(result.evidence)!==hash(sources.map(source=>source.evidence)))return null;
    const readback={scope:'Complete saved source observations before filtering; no fresh request and no claim of current remote values.',observed_source_rows:count,sources,user_goal_verified:'not_asserted'};
    const encoded=JSON.stringify(readback);
    if(Buffer.byteLength(encoded,'utf8')>16384||/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(encoded)||sources.some(source=>source.rows.some(row=>Object.keys(row).some(key=>/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key)))))return null;
    return readback;
  }catch{return null;}
}

/** Bound a native Pack's original observed rows to its freshly rechecked
 * source checkpoint and exact output artifact. Remote sources are not fetched
 * again; their rows are the saved observations, not a freshness claim. */
export async function savedNativeSourceReadback(store:PackStore,config:HostConfig,run:PackRun){
  try{
    if(run.recipe.family!=='portal.collect'&&run.recipe.family!=='file.pipeline'||!config.packs)return null;
    const certificate=await nativeOutputCertificate(store,config,run);
    if(!certificate)return null;
    const execution=store.packExecution(config.project.id,run.id),savedSources=object(execution?.checkpoint.sources);
    if(!savedSources||Object.keys(savedSources).length!==run.recipe.sources.length)return null;
    const sources:Array<{source_id:string;source_kind:string;observed_at:string;original_content_sha256:string;observed_rows_sha256:string;rows_total:number;rows_returned:number;complete:boolean;rows:Row[]}>=[],validatedRows:Row[][]=[];
    let observedRows=0;
    for(const [index,requested] of run.recipe.sources.entries()){
      const source=config.packs.sources.find(value=>value.id===requested.id),saved=object(savedSources[String(index)]),collected=object(saved?.result),proof=object(collected?.evidence);
      if(!source||!saved||!collected||!proof||!Array.isArray(collected.rows)||saved.binding!==hash({source,requested,config:config.fingerprint})||saved.digest!==hash(collected)||proof.source_id!==requested.id||proof.request_sha256!==hash({id:requested.id,parameters:requested.parameters})||proof.rows!==collected.rows.length||typeof proof.observed_at!=='string'||typeof proof.content_sha256!=='string')return null;
      const rows=collected.rows.map(value=>rowSchema.parse(value));
      if(source.kind==='file'&&(await hashScopedFile(source.path)).sha256!==proof.content_sha256)return null;
      if(!sourceNormalizationMatches(source,rows,proof as unknown as SourceEvidence))return null;
      if(rows.some(sensitiveRow))return null;
      observedRows+=rows.length;
      validatedRows.push(rows);
      sources.push({source_id:requested.id,source_kind:source.kind,observed_at:proof.observed_at,original_content_sha256:proof.content_sha256,observed_rows_sha256:hash(rows),rows_total:rows.length,rows_returned:0,complete:rows.length===0,rows:[]});
    }
    if(observedRows!==certificate.observed_source_rows)return null;
    const readback={scope:'saved_source_observations_before_filtering',observed_source_rows:observedRows,source_rows_complete:false,truncated:true,read_all_pages_with:'office_pack_source_read',certificate_sha256:hash(certificate),artifact_sha256:certificate.artifact_sha256,remote_source_freshness:'not_checked',user_goal_verified:'not_asserted',sources};
    const maxBytes=4096,maxRows=100;
    if(Buffer.byteLength(JSON.stringify(readback),'utf8')>maxBytes)return null;
    let included=0;
    for(const [index,rows] of validatedRows.entries()){
      const entry=sources[index]!;
      for(const row of rows){
        if(included>=maxRows)break;
        entry.rows.push(row);entry.rows_returned++;included++;
        if(Buffer.byteLength(JSON.stringify(readback),'utf8')>maxBytes){entry.rows.pop();entry.rows_returned--;included--;break;}
      }
      entry.complete=entry.rows_returned===entry.rows_total;
    }
    readback.source_rows_complete=sources.every(source=>source.complete);
    readback.truncated=!readback.source_rows_complete;
    return readback;
  }catch{return null;}
}

/** Page the full saved original, not a sample. The view hash binds every page
 * to the same complete observation. Reaching the last page does not establish
 * coverage of the preceding pages or verification of the user's goal. */
export async function savedNativeSourceReadbackPage(store:PackStore,config:HostConfig,run:PackRun,request:{source_id:string;offset?:number;max_bytes?:number}){
  try{
    const offset=request.offset??0,maxBytes=request.max_bytes??8192;
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(maxBytes)||maxBytes<4||maxBytes>8192||!config.packs)return null;
    const certificate=await nativeOutputCertificate(store,config,run);if(!certificate)return null;
    const recipe=run.recipe;if(recipe.family!=='portal.collect'&&recipe.family!=='file.pipeline')return null;
    const index=recipe.sources.findIndex(source=>source.id===request.source_id);if(index<0)return null;
    const requested=recipe.sources[index]!,source=config.packs.sources.find(value=>value.id===requested.id);
    const saved=object(object(store.packExecution(config.project.id,run.id)?.checkpoint.sources)?.[String(index)]),collected=object(saved?.result),proof=object(collected?.evidence);
    if(!source||!saved||!collected||!proof||!Array.isArray(collected.rows)||saved.binding!==hash({source,requested,config:config.fingerprint})||saved.digest!==hash(collected)||proof.source_id!==requested.id||proof.request_sha256!==hash({id:requested.id,parameters:requested.parameters})||proof.rows!==collected.rows.length||typeof proof.observed_at!=='string'||typeof proof.content_sha256!=='string')return null;
    const rows=collected.rows.map(value=>rowSchema.parse(value));
    if(rows.some(sensitiveRow)||!sourceNormalizationMatches(source,rows,proof as unknown as SourceEvidence))return null;
    if(source.kind==='file'&&(await hashScopedFile(source.path)).sha256!==proof.content_sha256)return null;
    const digest=createHash('sha256'),parts:Uint8Array[]=[];let bytes=0;
    for(const text of encodedRowsChunks(rows,'json')){
      const chunk=Buffer.from(text,'utf8');digest.update(chunk);
      const from=Math.max(0,offset-bytes),to=Math.min(chunk.length,offset+maxBytes-bytes);
      if(from<to)parts.push(chunk.subarray(from,to));bytes+=chunk.length;if(!Number.isSafeInteger(bytes))return null;
    }
    if(offset>bytes)return null;
    const captured=Buffer.concat(parts);let page:string|undefined,returned=0,end=captured.length;
    do{
      page=undefined;
      for(let drop=0;drop<=3&&drop<=end;drop++){
        try{const valid=captured.subarray(0,end-drop);page=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(valid);returned=valid.length;break;}catch{/* only trim an incomplete final character */}
      }
      if(page===undefined)return null;
      if(Buffer.byteLength(JSON.stringify(page),'utf8')<=8192)break;
      end=Math.floor(returned/2);
    }while(end>0);
    if(page===undefined||offset<bytes&&returned===0)return null;
    const next=offset+returned,hasMore=next<bytes;
    return {scope:'saved_source_observation_page',run_id:run.id,source_id:source.id,source_kind:source.kind,observed_at:proof.observed_at,rows_total:rows.length,format:'json',original_content_sha256:proof.content_sha256,view_sha256:digest.digest('hex'),certificate_sha256:hash(certificate),artifact_sha256:certificate.artifact_sha256,total_bytes:bytes,offset,returned_bytes:returned,next_offset:hasMore?next:null,has_more:hasMore,full_source_read:offset===0&&!hasMore,remote_source_freshness:'not_checked',user_goal_verified:'not_asserted',text:page};
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
      let rawRows:Row[]|undefined,fileCsvHeader:string[]|undefined;
      if(registered.kind==='file'){
        const sourceDigest=await hashScopedFile(registered.path);
        if(proof.executor!=='local_file'||sourceDigest.sha256!==proof.content_sha256)return null;
        const parsedDigest=createHash('sha256'),sourcePath=registered.path;rawRows=[];
        async function* currentBytes(){for await(const chunk of scopedFileChunks(sourcePath)){parsedDigest.update(chunk);yield chunk;}}
        for await(const row of iterateParsedRows(currentBytes(),registered.format,undefined,header=>{fileCsvHeader=[...header];}))rawRows.push(row);
        if(parsedDigest.digest('hex')!==sourceDigest.sha256)return null;
        fileCount++;
      }else if(registered.kind==='http'&&proof.executor!=='http_get')return null;
      const validated:Row[]=[];for(const value of rows){const parsed=rowSchema.safeParse(value);if(!parsed.success)return null;validated.push(parsed.data);}
      if(rawRows){
        const current=registered.numeric_columns?.length?normalizeDeclaredSourceRows(rawRows,registered.numeric_columns):rawRows;
        if(hash(current)!==hash(validated))return null;
        if(proof.csv_header!==undefined&&hash(proof.csv_header)!==hash(fileCsvHeader))return null;
      }
      if(recipe.sources.length===1&&registered.kind!=='browser'&&registered.format==='csv'){
        const header=registered.kind==='file'?fileCsvHeader:proof.csv_header;
        const required=[...new Set([...recipe.filters.map(filter=>filter.field),...recipe.deduplicate_by,...(recipe.columns??[]),...(registered.numeric_columns??[]),...(recipe.family==='file.pipeline'?[...recipe.numeric_columns,...(recipe.sort?[recipe.sort.field]:[])]:[])])];
        // A one-line error can otherwise masquerade as a valid one-column,
        // zero-row CSV. Legacy nonempty receipts can still prove fields from
        // their saved rows, but a header-only receipt needs the real header.
        if(validated.length===0&&(required.length===0||!Array.isArray(header)))return null;
        if(Array.isArray(header)){
          if(header.length===0||!header.every(field=>typeof field==='string')||new Set(header).size!==header.length||required.some(field=>!header.includes(field)))return null;
        }else if(required.some(field=>!validated.every(row=>Object.hasOwn(row,field))))return null;
      }
      if(!sourceNormalizationMatches(registered,validated,proof as unknown as SourceEvidence,rawRows))return null;
      for(const row of validated)observed.push(row);
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
    const expected=hashEncodedRows(output,recipe.format,columns);
    const root=join(dirname(config.dbPath),'pack-artifacts');
    if(typeof artifact.path!=='string'||resolve(dirname(artifact.path))!==resolve(root)||artifact.format!==recipe.format||artifact.rows!==output.length||artifact.originals_modified!==false||artifact.bytes!==expected.bytes||artifact.sha256!==expected.sha256)return null;
    const actual=await hashScopedFile(artifact.path);
    if(actual.bytes!==expected.bytes||actual.sha256!==expected.sha256)return null;
    const sourceNormalizations=evidence.flatMap(value=>{const proof=object(value);return proof?.normalization?[{source_id:proof.source_id,...object(proof.normalization)}]:[];});
    return {version:1,scope:'saved_source_observations_to_local_artifact',family:recipe.family,run_id:run.id,recipe_sha256:hash(recipe),source_checkpoint_sha256:hash(checkpoints),observed_source_rows:observed.length,filtered_rows:filtered.length,deduplicated_rows:deduped.length,output_rows:output.length,columns,format:recipe.format,sort:recipe.family==='file.pipeline'?recipe.sort:null,numeric_columns:recipe.family==='file.pipeline'?recipe.numeric_columns:[],...(sourceNormalizations.length?{source_normalizations:sourceNormalizations}:{}),output_rows_sha256:hash(output),artifact_sha256:actual.sha256,artifact_bytes:actual.bytes,exact_native_bytes_match:true,file_sources_unchanged_at_check:fileCount?'verified':'not_applicable',remote_source_freshness:'not_checked',user_goal_verified:'not_asserted'};
  }catch{return null;}
}
