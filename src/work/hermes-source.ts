import {DatabaseSync} from 'node:sqlite';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join,relative,sep} from 'node:path';
import {z} from 'zod';
import {snapshotHash} from '../taskpack/contracts.js';
import {redact} from '../terminal/contracts.js';
import {normalizeProjectPath} from './project-scan.js';

export const hermesSourceSelection=z.object({home:z.string().min(1).max(2048).optional(),kind:z.enum(['session','job']),source_id:z.string().min(1).max(160)}).strict();
export const hermesDiscoverSchema=z.object({home:z.string().min(1).max(2048).optional(),offset:z.number().int().min(0).max(10000).default(0)}).strict();
export const defaultHermesHome=()=>process.env.HERMES_HOME||join(homedir(),'.hermes');
/** Never return authentication values, raw tool calls, hidden reasoning or config files. */
export function migrationText(value:unknown,max=4000):string{
  return redact(String(value??''))
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gu,'[REDACTED]')
    .replace(/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|cookie|authorization|secret|token)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]*)/giu,'[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/giu,'[REDACTED]')
    .replace(/\b\d{7,12}:[A-Za-z0-9_-]{25,}\b/gu,'[REDACTED]')
    .replace(/https?:\/\/[^\s<>"']+/giu,raw=>{try{const url=new URL(raw);return url.origin+url.pathname}catch{return '[URL]'}})
    .slice(0,max);
}
async function homePath(raw=defaultHermesHome()){
  const path=normalizeProjectPath(raw),entry=await lstat(path).catch(()=>null);
  if(!entry?.isDirectory()||entry.isSymbolicLink())throw Error('HERMES_SOURCE_DIRECTORY_REQUIRED');
  const root=await realpath(path),home=await realpath(homedir()).catch(()=>homedir());
  if(root===sep||root===home||/^\/mnt\/[a-z]$/u.test(root))throw Error('HERMES_SOURCE_TOO_BROAD');
  return root;
}
async function sourceFile(root:string,path:string,max:number){
  const full=join(root,path),stat=await lstat(full).catch(()=>null);if(!stat)return null;
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>max)throw Error('HERMES_SOURCE_FILE_UNSUPPORTED');
  const actual=await realpath(full),rel=relative(root,actual);if(rel.startsWith('..')||rel.startsWith(sep))throw Error('HERMES_SOURCE_PATH_ESCAPE');
  return full;
}
async function jobs(root:string){
  const path=await sourceFile(root,'cron/jobs.json',2_000_000);if(!path)return [];
  let parsed;try{parsed=JSON.parse(await readFile(path,'utf8'))}catch{throw Error('HERMES_JOBS_INVALID')}
  const rows=Array.isArray(parsed)?parsed:parsed?.jobs;
  if(!Array.isArray(rows)||rows.length>500||rows.some(row=>!row||typeof row!=='object'||typeof row.id!=='string'||!row.id||row.id.length>160)||new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('HERMES_JOBS_SCHEMA_UNSUPPORTED');
  return rows as Array<Record<string,unknown>&{id:string}>;
}
async function database(root:string){
  const path=await sourceFile(root,'state.db',2_000_000_000);if(!path)return null;
  const db=new DatabaseSync(path,{readOnly:true});
  try{db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1500;');
    for(const [table,required] of [['sessions',['id','source','started_at']],['messages',['id','session_id','role','content']]] as const){
      const columns=new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row=>String(row.name)));
      if(required.some(column=>!columns.has(column)))throw Error('HERMES_STATE_SCHEMA_UNSUPPORTED');
    }
    return db;
  }catch(error){db.close();throw error}
}
export async function discoverHermes(raw:unknown){
  const input=hermesDiscoverSchema.parse(raw),root=await homePath(input.home),scheduled=await jobs(root),db=await database(root);
  const sessions:Record<string,unknown>[]=[];let more=false;
  try{if(db){const columns=new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row=>String(row.name)));
    const rows=db.prepare(`SELECT id,source,${columns.has('title')?'substr(title,1,200)':'NULL'} AS title FROM sessions ORDER BY started_at DESC,id DESC LIMIT 51 OFFSET ?`).all(input.offset);more=rows.length>50;
    for(const row of rows.slice(0,50))sessions.push({kind:'session',source_id:String(row.id),title:migrationText(row.title,160)||'제목 없는 대화',channel:migrationText(row.source,80),schedule:'none_imported'});
  }}finally{db?.close()}
  if(!db&&!scheduled.length)throw Error('HERMES_SOURCE_NOT_FOUND');
  return {home:root,candidates:[...scheduled.map(row=>({kind:'job',source_id:row.id,title:migrationText(row.name??row.title??row.id,160),schedule:migrationText(JSON.stringify(row.schedule??null),300)})),...sessions],next_offset:more?input.offset+50:null,execution:false,source_modified:false,notice:'예약은 원본 Hermes에서 계속 유지됩니다. 가져오기는 실행 권한이나 예약 이전이 아닙니다.'};
}
export interface HermesSourceSnapshot {
  home:string;kind:'session'|'job';source_id:string;identity:string;fingerprint:string;title:string;
  evidence:Array<{id:string;role:string;text:string}>;schedule:string|null;unknowns:string[];blockers:string[];
}
export async function readHermesSource(raw:unknown):Promise<HermesSourceSnapshot>{
  const input=hermesSourceSelection.parse(raw),root=await homePath(input.home),identity=snapshotHash({adapter:'hermes-v1',root,kind:input.kind,id:input.source_id});
  if(input.kind==='job'){
    const job=(await jobs(root)).find(row=>row.id===input.source_id);if(!job)throw Error('HERMES_SOURCE_ITEM_NOT_FOUND');
    if(typeof job.prompt!=='string'||job.prompt.length>64000)throw Error('HERMES_JOB_PROMPT_UNSUPPORTED');
    const selected={id:job.id,name:job.name??job.title??null,prompt:job.prompt,schedule:job.schedule??null,enabled:job.enabled??null,state:job.state??null,deliver:job.deliver??job.delivery??null,skills:job.skills??null,script:job.script??null,no_agent:job.no_agent??false,model:job.model??null,provider:job.provider??null,base_url:job.base_url??null};
    const blockers=[];
    if(job.script||job.no_agent)blockers.push('스크립트 전용 예약은 이 가져오기 경로에서 실행 방식까지 보존할 수 없습니다.');
    if(Array.isArray(job.skills)&&job.skills.length||job.cwd||job.workdir)blockers.push('업무별 스킬·작업 폴더 지정을 사용하는 예약은 수동 실행 지침과 경로 확인이 먼저 필요합니다.');
    if(job.model||job.provider||job.base_url)blockers.push('업무별 모델 연결 설정이 있어 그대로 재현할 수 없습니다. 현재 가져오기는 Hermes 프로필의 기본 모델을 사용합니다.');
    return {home:root,kind:'job',source_id:job.id,identity,fingerprint:snapshotHash(selected),title:migrationText(selected.name,160)||'Hermes 예약 업무',evidence:[{id:'prompt',role:'source_instruction',text:migrationText(job.prompt,8000)}],schedule:migrationText(JSON.stringify(selected.schedule),1500),unknowns:['원본 예약은 유지되며 Driver의 새 예약은 만들지 않습니다.','원본의 결과·권한·전달처는 이번 실행의 승인으로 취급하지 않습니다.',...(job.prompt.length>8000?['표시할 수 있는 지침 길이를 초과했습니다. 원본에서 직접 범위를 확인하세요.']:[])],blockers};
  }
  const db=await database(root);if(!db)throw Error('HERMES_SOURCE_NOT_FOUND');
  try{db.exec('BEGIN');
    const columns=new Set(db.prepare('PRAGMA table_info(sessions)').all().map(row=>String(row.name)));
    const session=db.prepare(`SELECT id,source,${columns.has('title')?'title':'NULL'} AS title FROM sessions WHERE id=?`).get(input.source_id);if(!session)throw Error('HERMES_SOURCE_ITEM_NOT_FOUND');
    const rows=db.prepare("SELECT id,role,substr(content,1,64001) content,length(CAST(content AS BLOB)) bytes FROM messages WHERE session_id=? AND role IN ('user','assistant') ORDER BY id DESC LIMIT 12").all(input.source_id).reverse();
    if(rows.some(row=>Number(row.bytes)>64000))throw Error('HERMES_SOURCE_MESSAGE_TOO_LARGE');
    const evidence=rows.map(row=>({id:'message_'+row.id,role:String(row.role),text:migrationText(row.content,2500)}));
    return {home:root,kind:'session',source_id:input.source_id,identity,fingerprint:snapshotHash({session,rows}),title:migrationText(session.title,160)||'가져온 Hermes 업무',evidence,schedule:null,unknowns:['최근 사용자·답변 12개만 읽었습니다. 도구 로그와 숨은 추론은 읽지 않았습니다.','대화가 여러 업무를 포함할 수 있습니다. 이번에 가져올 업무와 완료 조건을 확인하세요.','과거 답변은 검증된 업무 완료 기록이 아닙니다. 기존 대화는 재개하거나 변경하지 않습니다.'] ,blockers:[]};
  }finally{try{db.exec('ROLLBACK')}finally{db.close()}}
}
