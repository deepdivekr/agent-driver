import {lstat,open,readdir,realpath} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';
import {homedir} from 'node:os';
import {basename,extname,isAbsolute,join,relative,resolve,sep,win32} from 'node:path';
import {redact} from '../terminal/contracts.js';

const MAX_FILES=120,MAX_ENTRIES=2500,MAX_BYTES=1_000_000,MAX_FILE_BYTES=64_000,MAX_DEPTH=5;
const excluded=/^(?:\.git|node_modules|vendor|dist|build|coverage|\.next|\.venv|venv|__pycache__|\.secrets?|secrets?|credentials?|cookies?|\.runtime|artifacts|data)$/iu;
const confidential=/(?:^\.|env|secret|credential|password|token|cookie|key(?:ring|chain)?|\.pem$|\.p12$|\.sqlite(?:3)?$|\.db$|\.log$)/iu;
const sourceExtensions=new Set(['.ts','.tsx','.js','.mjs','.cjs','.py','.go','.rs','.sh','.yaml','.yml','.json','.toml','.md']);
const implementationExtensions=new Set(['.ts','.tsx','.js','.mjs','.cjs','.py','.go','.rs','.sh']);
const preferred=new Set(['README.md','package.json','pyproject.toml','requirements.txt','Cargo.toml','go.mod','docker-compose.yml','compose.yml']);
const signals:{id:string;description:string;pattern:RegExp}[]=[
  {id:'bot_channel',description:'메시지 봇 또는 채널 연결',pattern:/\b(?:telegram|discord|slack|telegraf|python-telegram-bot|bot\.command|on_message|sendMessage)\b/iu},
  {id:'model',description:'LLM 또는 모델 호출',pattern:/\b(?:openai|anthropic|claude|codex|llm|chat\.completions|responses\.create|generate_text)\b/iu},
  {id:'tool',description:'에이전트 도구 또는 외부 실행 연결',pattern:/\b(?:tool_calls?|function_call|mcp|playwright|browser_use|execute_tool|subprocess|child_process)\b/iu},
  {id:'agent_loop',description:'에이전트 계획·도구 루프',pattern:/\b(?:create_agent|run_agent|agent\.run|orchestrat(?:e|ion|or)|langgraph|autogen|crew_ai|tool_loop|plan_and_execute)\b/iu},
  {id:'trigger',description:'반복 일정·이벤트 진입점',pattern:/\b(?:cron|schedule|setInterval|webhook|on_message|bot\.command|workflow_dispatch|on:\s*schedule)\b/iu},
  {id:'delivery',description:'결과 전송·알림 코드',pattern:/\b(?:send_message|sendMessage|reply_text|notify|send_mail|sendEmail|post_message)\b/iu},
  {id:'state',description:'상태·체크포인트 저장',pattern:/\b(?:sqlite|postgres|redis|checkpoint|state_store|resume)\b/iu},
  {id:'semantic_judgment',description:'내용 분류·관련성·상태 선택처럼 의미를 읽는 판단 지점 후보',pattern:/\b(?:classify(?:Message|Item|Content|Result|State)?|categorize(?:Message|Item|Content|Result)?|triage(?:Message|Item|Content)?|is_relevant|relevance|rerank|selectTarget|detectState)\b/iu},
];
export type ProjectKind='agentic_workflow'|'bot_only'|'mixed'|'unknown';
export interface ProjectSignalEvidence {id:string;file:string;line:number;signal:string;description:string;source:'observed_code'|'observed_config'|'observed_documentation';}
export interface ProjectScan {
  format:1;root:string;kind:ProjectKind;purpose:string|null;files_read:number;bytes_read:number;content_sha256:string;
  readme_excerpt:string|null;commands:string[];scripts:string[];evidence:ProjectSignalEvidence[];unknowns:string[];recommendations:string[];
  limits:{max_files:number;max_bytes:number;truncated:boolean};
  authority:{execution:false;project_write:false;jev_call:false};
}
function safeText(value:string,max=160){
  const cleaned=redact(value).replace(/[\r\n\t\u0000-\u001f]/gu,' ').replace(/https?:\/\/\S+/giu,'[URL]').trim();
  if(/(?:sk-[A-Za-z0-9_-]{12,}|apikey_[A-Za-z0-9_-]{12,}|(?:password|secret|token|api.?key)\s*[:=])/iu.test(cleaned))return '[REDACTED]';
  return cleaned.slice(0,max)||null;
}
export function normalizeProjectPath(raw:string,platform=process.platform,distro=process.env.WSL_DISTRO_NAME){
  const value=raw.trim();if(!value||value.length>2048||/[\u0000-\u001f]/u.test(value))throw Error('PROJECT_PATH_INVALID');
  if(platform==='win32')return win32.isAbsolute(value)?win32.resolve(value):(()=>{throw Error('PROJECT_PATH_ABSOLUTE_REQUIRED');})();
  const unc=/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)\\(.+)$/iu.exec(value);
  if(unc){if(distro&&unc[1]!.toLowerCase()!==distro.toLowerCase())throw Error('PROJECT_WSL_DISTRO_MISMATCH');return '/'+unc[2]!.replace(/\\/gu,'/');}
  const drive=/^([A-Za-z]):[\\/](.+)$/u.exec(value);
  if(drive)return `/mnt/${drive[1]!.toLowerCase()}/${drive[2]!.replace(/\\/gu,'/')}`;
  if(!isAbsolute(value))throw Error('PROJECT_PATH_ABSOLUTE_REQUIRED');return resolve(value);
}
function allowedFile(name:string){return !confidential.test(name)&&(preferred.has(name)||sourceExtensions.has(extname(name).toLowerCase()));}
function recommendation(kind:ProjectKind,found:Set<string>){
  if(kind==='bot_only')return [
    '기존 봇의 메시지 수신·전송은 유지하고, 예상 밖 요청만 LLM 검토로 넘기기',
    ...(found.has('state')?[]:['중단 지점·처리 영수증을 저장해 재시작 후 이어가기']),
    '작업별 완료 조건과 사람 승인 경계를 정의한 뒤 Agent Driver Work로 연결하기',
  ];
  if(kind==='agentic_workflow'||kind==='mixed')return ['기존 실행 코드를 보존하고 Work 단계·완료 증거·실패 재개 지점을 대응시키기','시험 실행으로 기존 결과와 새 Work 결과를 비교한 뒤에만 이전하기'];
  return ['진입점과 실제 실행 로그를 추가 확인한 뒤 자동화 여부를 판정하기'];
}
export async function scanProject(rawPath:string):Promise<ProjectScan>{
  const input=normalizeProjectPath(rawPath),entry=await lstat(input);
  if(entry.isSymbolicLink()||!entry.isDirectory())throw Error('PROJECT_DIRECTORY_REQUIRED');
  const root=await realpath(input),home=await realpath(homedir()).catch(()=>homedir());
  if(root===sep||root===home||/^\/mnt\/[a-z]$/u.test(root)||root.split(sep).filter(Boolean).length<2)throw Error('PROJECT_ROOT_TOO_BROAD');
  const queue=[{dir:root,depth:0}],candidates:string[]=[],seen=new Set<string>(),unknowns:string[]=[];
  let entries=0,truncated=false;
  while(queue.length){
    const item=queue.shift()!;if(seen.has(item.dir))continue;seen.add(item.dir);
    let children;try{children=await readdir(item.dir,{withFileTypes:true});}catch{unknowns.push(`읽을 수 없는 디렉터리: ${relative(root,item.dir)||'.'}`);continue;}
    for(const child of children.sort((a,b)=>a.name.localeCompare(b.name))){
      if(++entries>MAX_ENTRIES){truncated=true;break;}
      if(child.isSymbolicLink()||excluded.test(child.name))continue;
      const path=join(item.dir,child.name),rel=relative(root,path);
      if(rel.startsWith('..')||isAbsolute(rel))continue;
      if(child.isDirectory()){if(item.depth<MAX_DEPTH)queue.push({dir:path,depth:item.depth+1});continue;}
      if(child.isFile()&&allowedFile(child.name))candidates.push(path);
    }
    if(truncated)break;
  }
  candidates.sort((a,b)=>Number(preferred.has(basename(b)))-Number(preferred.has(basename(a)))||relative(root,a).localeCompare(relative(root,b)));
  const evidence:ProjectSignalEvidence[]=[],found=new Set<string>(),digest=createHash('sha256'),commands=new Set<string>(),scripts=new Set<string>();let filesRead=0,bytesRead=0,purpose:string|null=null,readmeExcerpt:string|null=null;
  for(const path of candidates){
    if(filesRead>=MAX_FILES||bytesRead>=MAX_BYTES){truncated=true;break;}
    const resolved=await realpath(path).catch(()=>null);if(!resolved||!resolved.startsWith(root+sep))continue;
    const entry=await lstat(path).catch(()=>null);if(!entry||entry.isSymbolicLink()||!entry.isFile()||entry.size>MAX_FILE_BYTES||bytesRead+entry.size>MAX_BYTES)continue;
    const fileHandle=await open(path,constants.O_RDONLY|(process.platform==='linux'?constants.O_NOFOLLOW:0));
    let bytes:Buffer;
    try{const info=await fileHandle.stat();if(!info.isFile()||info.size>MAX_FILE_BYTES||bytesRead+info.size>MAX_BYTES)continue;bytes=await fileHandle.readFile();}
    finally{await fileHandle.close();}
    if(bytes.includes(0))continue;
    const content=bytes.toString('utf8');if(content.includes('\uFFFD'))continue;
    filesRead++;bytesRead+=bytes.length;const file=relative(root,path).split(sep).join('/');digest.update(file).update('\0').update(bytes).update('\0');
    const extension=extname(path).toLowerCase(),source=implementationExtensions.has(extension)?'observed_code':extension==='.md'?'observed_documentation':'observed_config';
    if(basename(path).toLowerCase()==='readme.md'){
      if(purpose===null)purpose=safeText(content.split(/\r?\n/gu).find(line=>/^#\s+\S/u.test(line))?.replace(/^#\s*/u,'')??'');
      if(readmeExcerpt===null)readmeExcerpt=safeText(content.replace(/^#.*$/gmu,'').slice(0,900),500);
    }
    if(basename(path)==='package.json')try{const parsed=JSON.parse(content) as {description?:unknown;scripts?:Record<string,unknown>};if(purpose===null&&typeof parsed.description==='string')purpose=safeText(parsed.description);for(const name of Object.keys(parsed.scripts??{}).slice(0,20))if(/^[a-z0-9:_-]{1,50}$/iu.test(name))scripts.add(name);}catch{}
    for(const [index,line]of content.split(/\r?\n/gu).entries()){
      for(const match of line.matchAll(/\b(?:bot\.command|command|route|handler)\s*\(\s*['"]([a-z0-9_/-]{1,60})['"]/giu))if(commands.size<30)commands.add(match[1]!);
      if(evidence.length>=100)break;
      for(const signal of signals){
        if(signal.id==='semantic_judgment'&&source==='observed_code'&&/^\s*(?:\/\/|\/\*|\*|#)/u.test(line))continue;
        if(signal.pattern.test(line)&&!evidence.some(item=>item.file===file&&item.signal===signal.id)){
          evidence.push({id:`e${evidence.length+1}`,file,line:index+1,signal:signal.id,description:signal.description,source});
          if(source==='observed_code')found.add(signal.id);
        }
      }
    }
  }
  const agentic=found.has('agent_loop')&&found.has('model')||found.has('model')&&found.has('tool')&&found.has('state');
  const bot=found.has('bot_channel')&&found.has('delivery');
  const kind:ProjectKind=agentic&&bot?'mixed':agentic?'agentic_workflow':bot?'bot_only':'unknown';
  if(!purpose)unknowns.push('프로젝트 목적은 코드·README에서 확인되지 않음');
  if(!found.has('trigger'))unknowns.push('실제 일정 또는 이벤트 진입점 미확인');
  if(!found.has('delivery'))unknowns.push('결과 전달 경로 미확인');
  if(kind==='unknown')unknowns.push('에이전틱 흐름 또는 봇의 실제 동작은 추가 확인 필요');
  return {format:1,root,kind,purpose,files_read:filesRead,bytes_read:bytesRead,content_sha256:digest.digest('hex'),readme_excerpt:readmeExcerpt,commands:[...commands],scripts:[...scripts],evidence,unknowns,recommendations:recommendation(kind,found),limits:{max_files:MAX_FILES,max_bytes:MAX_BYTES,truncated},authority:{execution:false,project_write:false,jev_call:false}};
}
