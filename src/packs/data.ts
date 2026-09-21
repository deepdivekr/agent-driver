import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,stat,mkdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {rowSchema,type Row,type Recipe} from './contracts.js';

export const MAX_BYTES=8*1024*1024;
export const MAX_ROWS=10000;
export function sha(bytes:Uint8Array|string){return createHash('sha256').update(bytes).digest('hex');}
export function parseCsv(text:string):Row[]{
  const records:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false;
  text=text.replace(/^\uFEFF/u,'');
  for(let i=0;i<text.length;i++){
    const c=text[i]!;
    if(quoted){if(c==='"'){if(text[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=c;continue;}
    if(c==='"'){requireCondition(cell===''&&!closed,'CSV_INVALID_QUOTE');quoted=true;}
    else if(c===','||c==='\n'||c==='\r'){
      row.push(cell);cell='';closed=false;
      if(c!==','){records.push(row);row=[];if(c==='\r'&&text[i+1]==='\n')i++;}
    }else{requireCondition(!closed,'CSV_TRAILING_QUOTE_DATA');cell+=c;}
    requireCondition(records.length<=MAX_ROWS+1,'SOURCE_TOO_MANY_ROWS');
  }
  requireCondition(!quoted,'CSV_UNCLOSED_QUOTE');if(cell!==''||row.length||closed){row.push(cell);records.push(row);}
  const header=records.shift();requireCondition(header?.length&&header.every(Boolean)&&new Set(header).size===header.length,'CSV_INVALID_HEADER');
  return records.map(values=>{requireCondition(values.length===header.length,'CSV_COLUMN_MISMATCH');return rowSchema.parse(Object.fromEntries(header.map((name,i)=>[name,values[i]!])));});
}
export function parseData(text:string,format:'json'|'csv'):Row[]{
  const raw:unknown=format==='csv'?parseCsv(text):JSON.parse(text);
  requireCondition(Array.isArray(raw)&&raw.length<=MAX_ROWS,'SOURCE_ROWS_REQUIRED');return raw.map(row=>rowSchema.parse(row));
}
/** No spreadsheet formula is emitted as an executable cell. Null/boolean/numeric types use JSON for lossless output. */
export function encodeCsv(rows:Row[],columns:string[]):string{
  const quote=(value:unknown)=>{let text=value===null?'':String(value);if(/^[\s]*[=+@-]/u.test(text)&&typeof value!=='number')text="'"+text;return '"'+text.replace(/"/gu,'""')+'"';};
  return '\uFEFF'+[columns.map(quote).join(','),...rows.map(row=>columns.map(key=>quote(row[key]??null)).join(','))].join('\r\n')+'\r\n';
}
export async function readScopedFile(path:string){
  const resolved=resolve(path);requireCondition(await realpath(resolved)===resolved,'PACK_FILE_REDIRECTED');
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const before=await file.stat();requireCondition(before.isFile()&&before.nlink===1&&before.size<=MAX_BYTES,'PACK_FILE_UNSAFE_OR_TOO_LARGE');
    const bytes=await file.readFile();const after=await file.stat();requireCondition(bytes.length<=MAX_BYTES&&before.size===after.size&&before.mtimeMs===after.mtimeMs,'PACK_SOURCE_CHANGED');
    return bytes;
  } finally {await file.close();}
}
export async function responseBytes(response:Response){
  requireCondition(response.ok,'PACK_SOURCE_HTTP_ERROR');requireCondition(Number(response.headers.get('content-length')??0)<=MAX_BYTES,'PACK_SOURCE_TOO_LARGE');
  const reader=response.body?.getReader();requireCondition(reader,'PACK_EMPTY_RESPONSE');const chunks:Uint8Array[]=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;requireCondition(size<=MAX_BYTES,'PACK_SOURCE_TOO_LARGE');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return Buffer.concat(chunks);
}
export function applyFilters(rows:Row[],filters:Extract<Recipe,{sources:unknown}>['filters']){
  return rows.filter(row=>filters.every(f=>{
    const value=row[f.field];if(value===undefined||value===null||f.value===null)return f.op==='eq'&&value===f.value;
    if(f.op==='eq')return value===f.value;
    if(f.op==='contains')return typeof value==='string'&&typeof f.value==='string'&&value.toLocaleLowerCase().includes(f.value.toLocaleLowerCase());
    // No lexicographic date/price guessing or implicit "" -> 0 coercion.
    requireCondition(typeof value==='number'&&typeof f.value==='number','NUMERIC_FILTER_REQUIRES_NUMBER');return f.op==='gte'?value>=f.value:value<=f.value;
  }));
}
export function deduplicate(rows:Row[],keys:string[]){
  if(!keys.length)return rows;
  const seen=new Map<string,string>();return rows.filter(row=>{
    requireCondition(keys.every(k=>row[k]!==undefined&&row[k]!==null),'DEDUPLICATION_KEY_MISSING');const key=snapshotHash(keys.map(k=>row[k]!)),hash=snapshotHash(row),old=seen.get(key);
    requireCondition(old===undefined||old===hash,'DUPLICATE_KEY_CONFLICT');seen.set(key,hash);return old===undefined;
  });
}
export function sortRows(rows:Row[],sort:{field:string;direction:'asc'|'desc'}|null){
  if(!sort)return rows;
  requireCondition(rows.every(r=>r[sort.field]!==undefined&&r[sort.field]!==null),'SORT_FIELD_MISSING');
  requireCondition(new Set(rows.map(r=>typeof r[sort.field])).size<=1,'SORT_TYPE_MISMATCH');
  return [...rows].sort((a,b)=>{const x=a[sort.field]!,y=b[sort.field]!;const delta=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y));return sort.direction==='asc'?delta:-delta;});
}
export async function exportRows(root:string,id:string,rows:Row[],format:'json'|'csv',columns?:string[]){
  const selected=columns??[...new Set(rows.flatMap(r=>Object.keys(r)))];requireCondition(format==='json'||selected.length>0,'CSV_COLUMNS_UNOBSERVED');
  const bytes=Buffer.from(format==='json'?JSON.stringify(rows,null,2)+'\n':encodeCsv(rows,selected));requireCondition(bytes.length<=MAX_BYTES,'PACK_OUTPUT_TOO_LARGE');
  await mkdir(root,{recursive:true,mode:0o700});requireCondition(await realpath(root)===resolve(root),'PACK_OUTPUT_REDIRECTED');
  const path=join(root,`${id}.${format}`),handle=await open(path,'wx',0o600);
  try {await handle.writeFile(bytes);await handle.sync();}finally{await handle.close();}
  const saved=await readFile(path);requireCondition(sha(saved)===sha(bytes),'PACK_EXPORT_READBACK_MISMATCH');
  requireCondition(parseData(saved.toString('utf8'),format).length===rows.length,'PACK_EXPORT_ROW_MISMATCH');
  const info=await stat(path);return {path,sha256:sha(saved),bytes:info.size,rows:rows.length,format,csv_formula_escaped:format==='csv',originals_modified:false};
}
