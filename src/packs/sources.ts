import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {OwnedPersistentPage} from '../taskpack/owned-playwright.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type Source,type Row,type Recipe,rowSchema} from './contracts.js';
import {scopedFileChunks,responseChunks,iterateParsedRows,featureRows,MAX_ROWS,MAX_BYTES} from './data.js';
import {RoutedBrowser,type BrowserRouteOptions} from '../browser/executor-routing.js';

export interface SourceNormalization {
  version:1;kind:'declared_numeric_columns';columns:string[];
  raw_rows_sha256:string;normalized_rows_sha256:string;
}
export interface SourceEvidence {source_id:string;request_sha256:string;content_sha256:string;observed_at:string;rows:number;elapsed_ms:number;executor:string;projection_fields?:string[];csv_header?:string[];http_status?:number;response_bytes?:number;response_shape?:'array'|'feature_collection';normalization?:SourceNormalization;}

/** Convert only host-declared columns, with no blank, locale, ID or infinity
 * guessing. Unsafe integers cannot retain an exact identity in a JS number. */
export function normalizeDeclaredSourceRows(rows:Row[],columns:readonly string[]):Row[]{
  return rows.map(row=>{
    const normalized={...row};
    for(const column of columns){
      const value=row[column];
      requireCondition(typeof value==='number'||typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value),'SOURCE_NUMERIC_VALUE_INVALID');
      const numeric=Number(value);
      requireCondition(Number.isFinite(numeric)&&(!Number.isInteger(numeric)||Number.isSafeInteger(numeric)),'SOURCE_NUMERIC_VALUE_INVALID');
      normalized[column]=numeric;
    }
    return normalized;
  });
}

/** A row checkpoint is the normalized view. The content hash continues to
 * identify the original HTTP/file bytes or original browser observation. */
export function sourceNormalizationMatches(source:Source,rows:Row[],evidence:SourceEvidence,rawRows?:Row[]){
  const columns=source.numeric_columns??[],proof=evidence.normalization;
  if(columns.length===0)return proof===undefined;
  if(!proof||proof.version!==1||proof.kind!=='declared_numeric_columns'||snapshotHash(proof.columns)!==snapshotHash(columns)||!/^[a-f0-9]{64}$/u.test(proof.raw_rows_sha256)||proof.normalized_rows_sha256!==snapshotHash(rows))return false;
  if(source.kind==='browser'&&proof.raw_rows_sha256!==evidence.content_sha256)return false;
  try{
    if(snapshotHash(normalizeDeclaredSourceRows(rows,columns))!==snapshotHash(rows))return false;
    return !rawRows||proof.raw_rows_sha256===snapshotHash(rawRows)&&snapshotHash(normalizeDeclaredSourceRows(rawRows,columns))===snapshotHash(rows);
  }catch{return false;}
}
function sourceBrowserError(error:unknown):never{
  // A locked persistent profile is retryable, never permission to remove locks
  // or copy its cookies into another profile.
  if(error instanceof Error&&/ProcessSingleton|SingletonLock|profile directory.*in use/iu.test(error.message))throw Error('PACK_BROWSER_PROFILE_BUSY',{cause:error});
  throw error;
}
export async function collectSource(source:Source,parameters:Record<string,string>,config:HostConfig,routeOptions?:Partial<BrowserRouteOptions>):Promise<{rows:Row[];evidence:SourceEvidence}>{
  const start=performance.now();let rows:Row[],contentHash:string,executor=source.kind==='browser'?'playwright':source.kind==='http'?'http_get':'local_file';
  let csvHeader:string[]|undefined;const observeCsvHeader=(header:readonly string[])=>{csvHeader=[...header];};
  let httpEvidence:Pick<SourceEvidence,'http_status'|'response_bytes'|'response_shape'>={};
  if(source.kind==='file'){
    requireCondition(Object.keys(parameters).length===0,'FILE_PARAMETERS_UNSUPPORTED');
    const path=source.path,digest=createHash('sha256');rows=[];
    async function* observed(){for await(const chunk of scopedFileChunks(path)){digest.update(chunk);yield chunk;}}
    for await(const row of iterateParsedRows(observed(),source.format,undefined,observeCsvHeader))rows.push(row);
    contentHash=digest.digest('hex');
  }else{
    requireCondition(Object.keys(parameters).every(p=>source.parameters.includes(p)),'SOURCE_PARAMETER_NOT_DELEGATED');
    const url=new URL(source.url);for(const [key,value]of Object.entries(parameters))url.searchParams.set(key,value);
    if(source.kind==='http'){
      const controller=new AbortController(),headerTimer=setTimeout(()=>controller.abort(new DOMException('Source response headers timed out','TimeoutError')),15000);
      let response:Response;
      try{response=await fetch(url,{redirect:'error',signal:controller.signal,headers:{Accept:source.format==='json'?'application/json':'text/csv'}});}
      finally{clearTimeout(headerTimer);}
      if(!response.ok){controller.abort();throw Error('PACK_SOURCE_HTTP_ERROR');}
      const contentType=response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
      if(contentType==='text/html'||contentType==='application/xhtml+xml'){
        controller.abort();
        throw Error('PACK_SOURCE_HTTP_HTML_RESPONSE');
      }
      requireCondition(!source.json_fields||source.format==='json','SOURCE_PROJECTION_REQUIRES_JSON');
      const digest=createHash('sha256');let responseBytes=0;rows=[];
      async function* observed(){for await(const chunk of responseChunks(response)){digest.update(chunk);responseBytes+=chunk.length;yield chunk;}}
      if(source.json_rows==='features'){
        const parts:Uint8Array[]=[];for await(const chunk of observed()){requireCondition(responseBytes<=MAX_BYTES,'SOURCE_TOO_LARGE');parts.push(chunk);}
        rows=featureRows(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts))),source.json_fields!);
      }else for await(const row of iterateParsedRows(observed(),source.format,source.json_fields,observeCsvHeader))rows.push(row);
      contentHash=digest.digest('hex');
      httpEvidence={http_status:response.status,response_bytes:responseBytes};
      // A successful JSON parse above validates the original top-level array,
      // not an agent assertion. Never retrofit this into historical receipts.
      if(source.format==='json')httpEvidence.response_shape=source.json_rows==='features'?'feature_collection':'array';
    }else if(config.browserExecutors||routeOptions?.preference||routeOptions?.fallback_preferences?.length){
      const browser=new RoutedBrowser(config,{profile_key:source.id,context_id:randomUUID(),...routeOptions},[url.origin]);
      try{
        await browser.open(url.toString());
        rows=(await browser.extract({...source,max_rows:MAX_ROWS})).map(row=>rowSchema.parse(row));
        contentHash=snapshotHash(rows);executor=browser.target!.engine;
      }catch(error){sourceBrowserError(error);}finally{await browser.close();}
    }else{
      const owned=new OwnedPersistentPage(join(config.project.profileRef,'pack-sources',source.id),join(config.project.profileRef,'pack-captures'));
      try{
        const opened=await owned.open(randomUUID(),{url:url.toString(),allowed_origins:[url.origin],logged_in:source.ready,authentication_request:source.auth_gate,requires_logged_in:source.auth_required,known_popups:[],unknown_dialog:'[role="dialog"],dialog[open]',navigation_timeout_ms:15000,allow_capture_failure:true});
        requireCondition(opened.gate==='ready',opened.gate==='waiting_auth'?'PACK_WAITING_AUTH':'PACK_UNKNOWN_DIALOG');
        await owned.page.locator(source.ready).waitFor({state:'visible',timeout:10000});
        if(source.auth_required)requireCondition((await owned.page.locator(source.account_selector).innerText()).trim()===source.account_text,'PACK_ACCOUNT_MISMATCH');
        const nodes=owned.page.locator(source.rows),count=await nodes.count();requireCondition(count<=MAX_ROWS,'SOURCE_TOO_MANY_ROWS');rows=[];
        for(let i=0;i<count;i++){
          const values:Row={};for(const [field,selector]of Object.entries(source.columns)){const cell=nodes.nth(i).locator(selector);requireCondition(await cell.count()===1,'SOURCE_FIELD_AMBIGUOUS');values[field]=(await cell.innerText()).trim();}rows.push(rowSchema.parse(values));
        }
        contentHash=snapshotHash(rows);
      }catch(error){sourceBrowserError(error);}finally{await owned.close();}
    }
  }
  // Credentials cannot be persisted as collected rows, or forwarded to models.
  for(const row of rows){
    requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(JSON.stringify(row)),'CREDENTIAL_LIKE_INPUT');
    requireCondition(Object.keys(row).every(key=>!/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key)),'SECRET_COLUMN_FORBIDDEN');
  }
  let normalization:SourceNormalization|undefined;
  if(source.numeric_columns?.length){
    const rawHash=snapshotHash(rows);rows=normalizeDeclaredSourceRows(rows,source.numeric_columns);
    normalization={version:1,kind:'declared_numeric_columns',columns:[...source.numeric_columns],raw_rows_sha256:rawHash,normalized_rows_sha256:snapshotHash(rows)};
  }
  return {rows,evidence:{source_id:source.id,request_sha256:snapshotHash({id:source.id,parameters}),content_sha256:contentHash,observed_at:new Date().toISOString(),rows:rows.length,elapsed_ms:Math.round(performance.now()-start),executor,...httpEvidence,...(source.kind==='http'&&source.json_fields?{projection_fields:source.json_fields}: {}),...(csvHeader?{csv_header:csvHeader}:{}),...(normalization?{normalization}:{})}};
}
export async function collect(recipe:Extract<Recipe,{sources:unknown}>,config:HostConfig){
  const rows:Row[]=[],evidence:SourceEvidence[]=[];const policy=config.packs;requireCondition(policy,'PACKS_NOT_CONNECTED');
  for(const requested of recipe.sources){
    const source=policy.sources.find(s=>s.id===requested.id);requireCondition(source,'SOURCE_NOT_DELEGATED');
    if(recipe.family==='file.pipeline')requireCondition(source.kind==='file','FILE_PIPELINE_REQUIRES_LOCAL_SOURCE');
    const result=await collectSource(source,requested.parameters,config,{preference:recipe.browser,request:recipe.request});for(const row of result.rows)rows.push(row);evidence.push(result.evidence);
  }
  return {rows,evidence};
}
