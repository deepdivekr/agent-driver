import {existsSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash} from 'node:crypto';
import {z} from 'zod';
import {iterateParsedRows} from './data.js';
import {field,packPolicySchema,sourceSchema,type Row,type Source} from './contracts.js';
import {type HostConfig} from '../interface/config.js';

/** Plan B5/B2: a public table the host itself read completely (CSV, or a JSON array of flat rows) is remembered as a
 * read-only source, so a later Work can collect it through a Pack recipe and have every row checked in code instead
 * of asking a model whether a saved file looks complete. An entry grants nothing new: it is a public HTTPS GET of a
 * URL the host already read, without parameters or credentials. It is not part of the run fingerprint. */
const entrySchema=z.object({source:sourceSchema,columns:z.array(field).max(100),observed_at:z.string().datetime()}).strict();
export type AutoSourceEntry=z.infer<typeof entrySchema>;
export interface DetectedTable {format:'csv'|'json';columns:string[];numeric_columns:string[];json_fields?:string[];rows:number;}
const MAX_AUTO_SOURCES=40,file='auto-sources.json';
const privateHost=(value:string)=>/^(?:localhost$|.*\.localhost$|127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(?:1[6-9]|2\d|3[01])\.|\[)|\.(?:local|lan|internal)$/iu.test(value);
const sensitive=/(?:password|token|secret|api.?key|auth|session|cookie|signature)/iu;
function publicUrl(value:string,fixture:boolean):URL|null{
  try{
    const url=new URL(value);
    if(fixture&&url.protocol==='http:'&&url.hostname==='127.0.0.1')return url;
    if(url.protocol!=='https:'||url.username||url.password||url.hash||privateHost(url.hostname)||[...url.searchParams.keys()].some(key=>sensitive.test(key)))return null;
    return url;
  }catch{return null;}
}
const dataDir=(config:Pick<HostConfig,'dbPath'>)=>dirname(config.dbPath);

export function readAutoSources(directory:string,fixture=false):AutoSourceEntry[]{
  const path=join(directory,file);if(!existsSync(path))return [];
  try{
    const raw:unknown=JSON.parse(readFileSync(path,'utf8'));if(!Array.isArray(raw))return [];
    return raw.flatMap(item=>{const parsed=entrySchema.safeParse(item);
      return parsed.success&&parsed.data.source.kind==='http'&&parsed.data.source.parameters.length===0&&publicUrl(parsed.data.source.url,fixture)?[parsed.data]:[];}).slice(0,MAX_AUTO_SOURCES);
  }catch{return [];}
}
/** Adds remembered sources the loaded config does not have yet. In place: every holder of this config sees them. */
export function applyAutoSources(config:HostConfig):void{
  const entries=readAutoSources(dataDir(config),config.environment==='fixture');if(!entries.length)return;
  const mutable=config as {packs:HostConfig['packs'];autoSources?:HostConfig['autoSources']};
  mutable.packs??=packPolicySchema.parse({});mutable.autoSources??={};
  for(const entry of entries){
    const source=entry.source as Extract<Source,{kind:'http'}>;
    if(mutable.packs.sources.length>=64)break;
    if(!mutable.packs.sources.some(item=>item.id===source.id||item.kind!=='file'&&item.url===source.url))mutable.packs.sources.push(source);
    if(mutable.packs.sources.some(item=>item.id===source.id&&item.kind==='http'&&item.url===source.url))mutable.autoSources[source.id]={columns:entry.columns,observed_at:entry.observed_at};
  }
}
/** A complete response body that is a table the Pack reader accepts, or null. */
export async function detectTable(bytes:Uint8Array,contentType:string,url:string):Promise<DetectedTable|null>{
  const type=contentType.split(';',1)[0]!.trim().toLowerCase(),path=(()=>{try{return new URL(url).pathname.toLowerCase();}catch{return '';}})();
  const format=type==='text/csv'||type==='application/csv'||path.endsWith('.csv')?'csv':type==='application/json'||path.endsWith('.json')?'json':null;
  if(!format||bytes.length===0)return null;
  const read=async(jsonFields?:string[])=>{
    const rows:Row[]=[];let header:readonly string[]|null=null;
    async function* chunks(){yield bytes;}
    for await(const row of iterateParsedRows(chunks(),format,jsonFields,value=>{header=value;})){rows.push(row);if(rows.length>50_000)return null;}
    return {rows,header:header as readonly string[]|null};
  };
  try{
    let jsonFields:string[]|undefined,result=await read().catch(()=>null);
    if(!result&&format==='json'){
      // Rows with nested values: keep the scalar fields every sampled row has.
      const raw:unknown=JSON.parse(Buffer.from(bytes).toString('utf8'));if(!Array.isArray(raw)||!raw.length)return null;
      const sample=raw.slice(0,200);if(sample.some(row=>row===null||typeof row!=='object'||Array.isArray(row)))return null;
      jsonFields=Object.keys(sample[0] as object).filter(name=>field.safeParse(name).success&&sample.every(row=>{const value=(row as Record<string,unknown>)[name];return value===null||['string','number','boolean'].includes(typeof value);})).slice(0,100);
      if(jsonFields.length<2)return null;result=await read(jsonFields).catch(()=>null);
    }
    if(!result||!result.rows.length)return null;
    const columns=(result.header?[...result.header]:Object.keys(result.rows[0]!)).filter(name=>field.safeParse(name).success&&!sensitive.test(name)).slice(0,100);
    if(columns.length<2)return null;
    // The Pack reader rejects a declared numeric column with any non-numeric value, so every row must qualify.
    const numeric=columns.filter(name=>result!.rows.every(row=>{const value=row[name];return typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value);}));
    return {format,columns,numeric_columns:numeric,...(jsonFields?{json_fields:jsonFields}:{}),rows:result.rows.length};
  }catch{return null;}
}
/** Remembers one observed public table. Returns its source id, or null when it is not eligible or the list is full. */
export function registerAutoSource(config:HostConfig,url:string,table:DetectedTable):{id:string;created:boolean}|null{
  const fixture=config.environment==='fixture',target=publicUrl(url,fixture);if(!target)return null;
  const existing=config.packs?.sources.find(item=>item.kind!=='file'&&item.url===target.href);
  if(existing)return {id:existing.id,created:false};
  const directory=dataDir(config),entries=readAutoSources(directory,fixture);if(entries.length>=MAX_AUTO_SOURCES||(config.packs?.sources.length??0)>=64)return null;
  const name=`${target.hostname.replace(/^www\./u,'')}${target.pathname}`.toLowerCase().replace(/\.(?:csv|json)$/u,'').replace(/[^a-z0-9]+/gu,'_').replace(/^_+|_+$/gu,'').slice(0,48)||'source';
  const id=`auto_${name}_${createHash('sha256').update(target.href).digest('hex').slice(0,6)}`;
  const parsed=sourceSchema.safeParse({id,kind:'http',url:target.href,parameters:[],format:table.format,...(table.numeric_columns.length?{numeric_columns:table.numeric_columns}:{}),...(table.json_fields?{json_fields:table.json_fields}:{})});
  if(!parsed.success)return null;
  const path=join(directory,file),next=[...entries.filter(entry=>entry.source.id!==id),{source:parsed.data,columns:table.columns,observed_at:new Date().toISOString()}];
  writeFileSync(`${path}.tmp`,JSON.stringify(next,null,1),{mode:0o600});renameSync(`${path}.tmp`,path);
  applyAutoSources(config);
  return {id,created:true};
}
