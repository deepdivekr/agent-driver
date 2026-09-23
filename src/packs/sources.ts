import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {requireCondition} from '../core/contracts.js';
import {OwnedPersistentPage} from '../taskpack/owned-playwright.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type HostConfig} from '../interface/config.js';
import {type Source,type Row,type Recipe,rowSchema} from './contracts.js';
import {parseData,readScopedFile,responseBytes,sha,MAX_ROWS} from './data.js';

export interface SourceEvidence {source_id:string;request_sha256:string;content_sha256:string;observed_at:string;rows:number;elapsed_ms:number;executor:string;}
export async function collectSource(source:Source,parameters:Record<string,string>,config:HostConfig):Promise<{rows:Row[];evidence:SourceEvidence}>{
  const start=performance.now();let rows:Row[],contentHash:string;
  if(source.kind==='file'){
    requireCondition(Object.keys(parameters).length===0,'FILE_PARAMETERS_UNSUPPORTED');
    const bytes=await readScopedFile(source.path);contentHash=sha(bytes);rows=parseData(bytes.toString('utf8'),source.format);
  }else{
    requireCondition(Object.keys(parameters).every(p=>source.parameters.includes(p)),'SOURCE_PARAMETER_NOT_DELEGATED');
    const url=new URL(source.url);for(const [key,value]of Object.entries(parameters))url.searchParams.set(key,value);
    if(source.kind==='http'){
      const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:source.format==='json'?'application/json':'text/csv'}});
      const bytes=await responseBytes(response);contentHash=sha(bytes);rows=parseData(bytes.toString('utf8'),source.format);
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
      }catch(error){
        // Another run can briefly own the same persistent source profile.
        // Never remove Chromium locks or copy its cookies to another profile.
        if(error instanceof Error&&/ProcessSingleton|SingletonLock|profile directory.*in use/iu.test(error.message))throw Error('PACK_BROWSER_PROFILE_BUSY');
        throw error;
      }finally{await owned.close();}
    }
  }
  // Credentials cannot be persisted as collected rows, or forwarded to models.
  requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(JSON.stringify(rows)),'CREDENTIAL_LIKE_INPUT');
  requireCondition(rows.every(row=>Object.keys(row).every(key=>!/^(?:password|passwd|cookie|authorization|access_token|refresh_token|api_key)$/iu.test(key))),'SECRET_COLUMN_FORBIDDEN');
  return {rows,evidence:{source_id:source.id,request_sha256:snapshotHash({id:source.id,parameters}),content_sha256:contentHash,observed_at:new Date().toISOString(),rows:rows.length,elapsed_ms:Math.round(performance.now()-start),executor:source.kind==='browser'?'playwright':source.kind==='http'?'http_get':'local_file'}};
}
export async function collect(recipe:Extract<Recipe,{sources:unknown}>,config:HostConfig){
  const rows:Row[]=[],evidence:SourceEvidence[]=[];const policy=config.packs;requireCondition(policy,'PACKS_NOT_CONNECTED');
  for(const requested of recipe.sources){
    const source=policy.sources.find(s=>s.id===requested.id);requireCondition(source,'SOURCE_NOT_DELEGATED');
    if(recipe.family==='file.pipeline')requireCondition(source.kind==='file','FILE_PIPELINE_REQUIRES_LOCAL_SOURCE');
    const result=await collectSource(source,requested.parameters,config);rows.push(...result.rows);evidence.push(result.evidence);requireCondition(rows.length<=MAX_ROWS,'SOURCE_TOO_MANY_ROWS');
  }
  return {rows,evidence};
}
