import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath,stat,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {parsePackDate,rowSchema,type Row,type Recipe} from './contracts.js';

/** Legacy in-memory read limit; streaming source/output paths do not use it. */
export const MAX_BYTES=8*1024*1024;
export const MAX_ROWS=10000;
const STREAM_CHUNK_BYTES=64*1024;
export function sha(bytes:Uint8Array|string){return createHash('sha256').update(bytes).digest('hex');}

/** Read a complete owned file in fixed-size chunks. Consumers must finish the
 * iterator before treating any yielded bytes as verified: the final stat also
 * detects in-place mutation or path replacement during the read. */
export async function* scopedFileChunks(path:string):AsyncGenerator<Uint8Array>{
  const resolved=resolve(path);requireCondition(await realpath(resolved)===resolved,'PACK_FILE_REDIRECTED');
  const file=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{
    const before=await file.stat({bigint:true});requireCondition(before.isFile()&&before.nlink===1n,'PACK_FILE_UNSAFE');
    const buffer=Buffer.allocUnsafe(STREAM_CHUNK_BYTES);let position=0;
    for(;;){const {bytesRead}=await file.read(buffer,0,buffer.length,position);if(bytesRead===0)break;position+=bytesRead;yield Buffer.from(buffer.subarray(0,bytesRead));}
    const after=await file.stat({bigint:true}),named=await stat(resolved,{bigint:true});
    requireCondition(await realpath(resolved)===resolved&&before.dev===after.dev&&before.ino===after.ino&&before.size===after.size&&before.mtimeNs===after.mtimeNs&&before.ctimeNs===after.ctimeNs&&after.dev===named.dev&&after.ino===named.ino&&after.size===named.size&&after.mtimeNs===named.mtimeNs&&after.ctimeNs===named.ctimeNs&&BigInt(position)===after.size,'PACK_SOURCE_CHANGED');
  }finally{await file.close();}
}

export async function hashScopedFile(path:string):Promise<{sha256:string;bytes:number}>{
  const digest=createHash('sha256');let bytes=0;
  for await(const chunk of scopedFileChunks(path)){digest.update(chunk);bytes+=chunk.length;requireCondition(Number.isSafeInteger(bytes),'PACK_FILE_SIZE_UNREPRESENTABLE');}
  return {sha256:digest.digest('hex'),bytes};
}

/** Do not turn an HTTP response into a single unbounded Buffer. */
export async function* responseChunks(response:Response,idleTimeoutMs=30000):AsyncGenerator<Uint8Array>{
  requireCondition(response.ok,'PACK_SOURCE_HTTP_ERROR');
  requireCondition(Number.isSafeInteger(idleTimeoutMs)&&idleTimeoutMs>0,'PACK_SOURCE_HTTP_IDLE_TIMEOUT_INVALID');
  const reader=response.body?.getReader();requireCondition(reader,'PACK_EMPTY_RESPONSE');let bytes=0,completed=false;
  try{
    for(;;){
      let timeout:ReturnType<typeof setTimeout>|undefined;
      const pending=reader.read(),idle=new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(Error('PACK_SOURCE_HTTP_IDLE_TIMEOUT')),idleTimeoutMs);});
      let next:ReadableStreamReadResult<Uint8Array>;
      try{next=await Promise.race([pending,idle]);}finally{if(timeout)clearTimeout(timeout);}
      const {done,value}=next;if(done)break;requireCondition(value instanceof Uint8Array,'PACK_SOURCE_HTTP_CHUNK_INVALID');
      for(let offset=0;offset<value.length;offset+=STREAM_CHUNK_BYTES){const part=value.subarray(offset,offset+STREAM_CHUNK_BYTES);bytes+=part.length;requireCondition(Number.isSafeInteger(bytes),'PACK_SOURCE_SIZE_UNREPRESENTABLE');yield part;}
    }
    // Fetch decodes gzip/br/deflate bodies but retains the wire Content-Length.
    // Only identity transfer has a byte length comparable to yielded chunks.
    const encoding=response.headers.get('content-encoding')?.trim().toLowerCase(),declared=response.headers.get('content-length');
    if((!encoding||encoding==='identity')&&declared!==null)requireCondition(/^\d+$/u.test(declared)&&Number(declared)===bytes,'PACK_SOURCE_HTTP_LENGTH_MISMATCH');
    completed=true;
  }finally{
    if(!completed){
      // A timed-out read remains pending until cancellation. Promise.race has
      // already attached a rejection handler; cancellation must not hang work.
      const cancellation=reader.cancel().catch(()=>{});let timeout:ReturnType<typeof setTimeout>|undefined;
      await Promise.race([cancellation,new Promise<void>(resolve=>{timeout=setTimeout(resolve,1000);})]);
      if(timeout)clearTimeout(timeout);
    }
    try{reader.releaseLock();}catch{/* A broken stream must not mask the idle failure. */}
  }
}

export async function readScopedTextPage(path:string,offset:number,maxBytes:number):Promise<{bytes:number;sha256:string;page:string;next_offset:number|null}>{
  requireCondition(Number.isSafeInteger(offset)&&offset>=0&&Number.isSafeInteger(maxBytes)&&maxBytes>=4&&maxBytes<=12000,'PACK_TEXT_PAGE_RANGE_INVALID');
  const digest=createHash('sha256'),parts:Uint8Array[]=[],wholeDecoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let bytes=0;
  for await(const chunk of scopedFileChunks(path)){
    requireCondition(!chunk.includes(0),'PACK_TEXT_FILE_UNSUPPORTED_FORMAT');
    try{wholeDecoder.decode(chunk,{stream:true});}catch{throw Error('PACK_TEXT_FILE_UNSUPPORTED_FORMAT');}
    digest.update(chunk);const from=Math.max(0,offset-bytes),to=Math.min(chunk.length,offset+maxBytes-bytes);
    if(from<to)parts.push(chunk.subarray(from,to));bytes+=chunk.length;requireCondition(Number.isSafeInteger(bytes),'PACK_FILE_SIZE_UNREPRESENTABLE');
  }
  try{wholeDecoder.decode();}catch{throw Error('PACK_TEXT_FILE_UNSUPPORTED_FORMAT');}
  requireCondition(offset<=bytes,'PACK_TEXT_PAGE_OFFSET_INVALID');
  const captured=Buffer.concat(parts);let valid=captured,page='';
  for(let dropped=0;dropped<=3;dropped++){
    try{valid=captured.subarray(0,captured.length-dropped);page=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(valid);break;}
    catch{if(dropped===3)throw Error('PACK_TEXT_PAGE_OFFSET_INVALID');}
  }
  requireCondition(offset===bytes||valid.length>0,'PACK_TEXT_PAGE_TOO_SMALL');
  const next=offset+valid.length;
  return {bytes,sha256:digest.digest('hex'),page,next_offset:next<bytes?next:null};
}
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

/** Parse a complete JSON array or CSV document one row at a time. The total
 * file/row count has no arbitrary cap; the existing field schema still applies.
 * A consumer must drain the iterator before accepting its observations. */
export async function* iterateParsedRows(chunks:AsyncIterable<Uint8Array>,format:'json'|'csv',jsonFields?:readonly string[],onCsvHeader?:(header:readonly string[])=>void):AsyncGenerator<Row>{
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  async function* textChunks(){for await(const chunk of chunks)yield decoder.decode(chunk,{stream:true});const tail=decoder.decode();if(tail)yield tail;}
  if(format==='json'){
    let state:'start'|'value'|'separator'|'done'='start',allowEnd=true,depth=0,quoted=false,escaped=false,chars:string[]=[];
    const space=(char:string)=>char===' '||char==='\t'||char==='\r'||char==='\n';
    for await(const text of textChunks())for(const ch of text){
      if(state==='start'){if(space(ch))continue;requireCondition(ch==='[','SOURCE_ROWS_REQUIRED');state='value';continue;}
      if(state==='done'){requireCondition(space(ch),'SOURCE_JSON_TRAILING_DATA');continue;}
      if(state==='separator'){
        if(space(ch))continue;
        if(ch===','){state='value';allowEnd=false;continue;}
        requireCondition(ch===']','SOURCE_JSON_SEPARATOR_INVALID');state='done';continue;
      }
      if(depth===0){
        if(space(ch))continue;
        if(ch===']'){requireCondition(allowEnd,'SOURCE_JSON_TRAILING_COMMA');state='done';continue;}
        requireCondition(ch==='{','SOURCE_ROW_REQUIRED');depth=1;chars=['{'];allowEnd=false;continue;
      }
      chars.push(ch);
      if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
      if(ch==='"'){quoted=true;continue;}
      if(ch==='{'||ch==='[')depth++;
      else if(ch==='}'||ch===']')depth--;
      requireCondition(depth>=0,'SOURCE_JSON_INVALID');
      if(depth===0){
        const raw:unknown=JSON.parse(chars.join(''));chars=[];
        requireCondition(raw!==null&&typeof raw==='object'&&!Array.isArray(raw),'SOURCE_ROW_REQUIRED');
        let selected=raw;
        if(jsonFields){const record=raw as Record<string,unknown>,projection:Record<string,unknown>={};
          for(const field of jsonFields){requireCondition(Object.hasOwn(record,field),'SOURCE_PROJECTION_FIELD_MISSING');projection[field]=record[field];}
          selected=projection;
        }
        yield rowSchema.parse(selected);state='separator';
      }
    }
    requireCondition(state==='done'&&depth===0,'SOURCE_JSON_INCOMPLETE');return;
  }
  requireCondition(!jsonFields,'SOURCE_PROJECTION_REQUIRES_JSON');
  let header:string[]|null=null,record:string[]=[],cell='',quoted=false,quotePending=false,closed=false,skipLF=false,first=true;
  const finishRecord=():Row|null=>{
    record.push(cell);cell='';closed=false;const values=record;record=[];
    if(header===null){
      // A successful HTTP login/error page can be a single line. Without this
      // check it becomes a syntactically valid one-column, zero-row CSV.
      const firstCell=values[0]?.trim()??'';
      requireCondition(!/^<(?:!doctype\s+html\b|html\b|head\b|body\b|\?xml\b|!--)/iu.test(firstCell),'SOURCE_HTML_NOT_CSV');
      requireCondition(values.length>0&&values.every(Boolean)&&new Set(values).size===values.length,'CSV_INVALID_HEADER');header=values;onCsvHeader?.([...values]);return null;
    }
    requireCondition(values.length===header.length,'CSV_COLUMN_MISMATCH');return rowSchema.parse(Object.fromEntries(header.map((name,index)=>[name,values[index]!])));
  };
  for await(const text of textChunks())for(const ch of text){
    if(first){first=false;if(ch==='\uFEFF')continue;}
    if(skipLF){skipLF=false;if(ch==='\n')continue;}
    if(quoted){
      if(quotePending){quotePending=false;if(ch==='"'){cell+='"';continue;}quoted=false;closed=true;}
      else if(ch==='"'){quotePending=true;continue;}
      else{cell+=ch;continue;}
    }
    if(ch==='"'){requireCondition(cell===''&&!closed,'CSV_INVALID_QUOTE');quoted=true;continue;}
    if(ch===','){record.push(cell);cell='';closed=false;continue;}
    if(ch==='\n'||ch==='\r'){const row=finishRecord();if(row)yield row;if(ch==='\r')skipLF=true;continue;}
    requireCondition(!closed,'CSV_TRAILING_QUOTE_DATA');cell+=ch;
  }
  requireCondition(!quoted||quotePending,'CSV_UNCLOSED_QUOTE');
  if(cell!==''||record.length||quotePending||closed){const row=finishRecord();if(row)yield row;}
  requireCondition(header!==null,'CSV_INVALID_HEADER');
}
/** No spreadsheet formula is emitted as an executable cell. Null/boolean/numeric types use JSON for lossless output. */
const csvCell=(value:unknown)=>{let text=value===null?'':String(value);if(/^[\s]*[=+@-]/u.test(text)&&typeof value!=='number')text="'"+text;return '"'+text.replace(/"/gu,'""')+'"';};
const csvLine=(row:Row,columns:string[])=>columns.map(key=>csvCell(row[key]??null)).join(',');
export function encodeCsv(rows:Row[],columns:string[]):string{return '\uFEFF'+[columns.map(csvCell).join(','),...rows.map(row=>csvLine(row,columns))].join('\r\n')+'\r\n';}
const observedColumns=(rows:readonly Row[])=>{const seen=new Set<string>();for(const row of rows)for(const key of Object.keys(row))seen.add(key);return [...seen];};

/** Same bytes as JSON.stringify(rows,null,2)+'\n' or encodeCsv, generated
 * one row at a time so total output size does not become a memory limit. */
export function* encodedRowsChunks(rows:readonly Row[],format:'json'|'csv',columns?:string[]):Generator<string>{
  const selected=columns??observedColumns(rows);requireCondition(format==='json'||selected.length>0,'CSV_COLUMNS_UNOBSERVED');
  if(format==='csv'){
    yield '\uFEFF'+selected.map(csvCell).join(',')+'\r\n';
    for(const row of rows)yield csvLine(row,selected)+'\r\n';
    return;
  }
  if(rows.length===0){yield '[]\n';return;}
  yield '[\n';
  for(const [index,row] of rows.entries())yield (index?',\n':'')+'  '+JSON.stringify(row,null,2).replace(/\n/gu,'\n  ');
  yield '\n]\n';
}
export function hashEncodedRows(rows:readonly Row[],format:'json'|'csv',columns?:string[]):{sha256:string;bytes:number}{
  const digest=createHash('sha256');let bytes=0;
  for(const chunk of encodedRowsChunks(rows,format,columns)){digest.update(chunk);bytes+=Buffer.byteLength(chunk,'utf8');requireCondition(Number.isSafeInteger(bytes),'PACK_OUTPUT_SIZE_UNREPRESENTABLE');}
  return {sha256:digest.digest('hex'),bytes};
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
    if(f.op==='date_gte'||f.op==='date_lt'||f.op==='date_lte'){
      const bound=parsePackDate(f.value);requireCondition(bound,'FILTER_DATE_BOUND_INVALID');
      requireCondition(Object.hasOwn(row,f.field),'SOURCE_DATE_FIELD_MISSING');
      const observed=parsePackDate(row[f.field]);requireCondition(observed,'SOURCE_DATE_VALUE_INVALID');
      if(f.op==='date_gte')return observed.epoch_ms>=bound.epoch_ms;
      if(f.op==='date_lt')return observed.epoch_ms<bound.epoch_ms;
      return bound.date_only?observed.epoch_ms<bound.epoch_ms+86400000:observed.epoch_ms<=bound.epoch_ms;
    }
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
export function normalizeNumericColumns(rows:Row[],columns:string[]){return rows.map(row=>{
  const copy={...row};for(const field of columns){const value=copy[field];requireCondition(typeof value==='number'||typeof value==='string'&&/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value),'INVALID_NUMERIC_VALUE');const number=Number(value);requireCondition(Number.isFinite(number),'INVALID_NUMERIC_VALUE');copy[field]=number;}return copy;
});}
export function sortRows(rows:Row[],sort:{field:string;direction:'asc'|'desc'}|null){
  if(!sort)return rows;
  requireCondition(rows.every(r=>r[sort.field]!==undefined&&r[sort.field]!==null),'SORT_FIELD_MISSING');
  requireCondition(new Set(rows.map(r=>typeof r[sort.field])).size<=1,'SORT_TYPE_MISMATCH');
  return [...rows].sort((a,b)=>{const x=a[sort.field]!,y=b[sort.field]!;const delta=typeof x==='number'&&typeof y==='number'?x-y:String(x).localeCompare(String(y));return sort.direction==='asc'?delta:-delta;});
}
export async function exportRows(root:string,id:string,rows:Row[],format:'json'|'csv',columns?:string[]){
  const selected=columns??observedColumns(rows);requireCondition(format==='json'||selected.length>0,'CSV_COLUMNS_UNOBSERVED');
  await mkdir(root,{recursive:true,mode:0o700});requireCondition(await realpath(root)===resolve(root),'PACK_OUTPUT_REDIRECTED');
  const path=join(root,`${id}.${format}`),handle=await open(path,'wx',0o600);
  const digest=createHash('sha256');let bytes=0;
  try {for(const chunk of encodedRowsChunks(rows,format,selected)){await handle.writeFile(chunk);digest.update(chunk);bytes+=Buffer.byteLength(chunk,'utf8');requireCondition(Number.isSafeInteger(bytes),'PACK_OUTPUT_SIZE_UNREPRESENTABLE');}await handle.sync();}finally{await handle.close();}
  const expected=digest.digest('hex'),readDigest=createHash('sha256');let readBytes=0,count=0;
  async function* checked(){for await(const chunk of scopedFileChunks(path)){readDigest.update(chunk);readBytes+=chunk.length;yield chunk;}}
  for await(const _row of iterateParsedRows(checked(),format))count++;
  requireCondition(readBytes===bytes&&readDigest.digest('hex')===expected,'PACK_EXPORT_READBACK_MISMATCH');
  requireCondition(count===rows.length,'PACK_EXPORT_ROW_MISMATCH');
  return {path,sha256:expected,bytes,rows:rows.length,format,csv_formula_escaped:format==='csv',originals_modified:false};
}
