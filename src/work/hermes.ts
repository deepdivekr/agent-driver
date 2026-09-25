import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {redact} from '../terminal/contracts.js';
import {requireCondition} from '../core/contracts.js';
import {HermesAcp,type HermesTransport,type HermesTransportCallbacks} from '../integrations/hermes-acp.js';
import {buildContinuityContext,renderContinuityContext} from './continuity-context.js';

const clean=(value:unknown,max=2000)=>redact(String(value??''))
  .replace(/\b(?:password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]*)/giu,'[REDACTED]')
  .replace(/\bBearer\s+[^\s,;]+/giu,'Bearer [REDACTED]')
  .replace(/\b\d{8,12}:[A-Za-z0-9_-]{25,}\b/gu,'[REDACTED]').slice(0,max);
const now=()=>new Date().toISOString();
const active=['queued','starting','running','needs_human'];
const actionSchema=z.object({work_id:z.string().uuid(),revision:z.number().int().nonnegative(),action:z.enum(['send','pause','resume','permission','review']),request_id:z.string().uuid().optional(),instruction:z.string().trim().min(3).max(4000).optional(),permission_id:z.string().uuid().optional(),option_id:z.string().max(120).optional(),cost_acknowledged:z.boolean().optional()}).strict();
export interface HermesWorkDefinition {title:string;goal:string;checks:string[];steps:string[];family:string;history:Array<{source:string;summary:string}>;instruction:string;runtime_home?:string;}
type WorkRow={work_id:string;project_id:string;import_key:string;definition:string;session_id:string|null;paused:number;revision:number;state:string;updated_at:string};
type TurnRow={id:string;project_id:string;work_id:string;request_id:string;instruction:string;status:string;reply:string;session_id:string|null;owner:string|null;permission:string|null;reason:string|null;created_at:string;updated_at:string};
export function initHermesWorks(store:PackStore){store.hermesState.exec(`
  CREATE TABLE IF NOT EXISTS hermes_work(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,import_key TEXT NOT NULL,definition TEXT NOT NULL,session_id TEXT,paused INTEGER NOT NULL DEFAULT 0,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'ready',updated_at TEXT NOT NULL,UNIQUE(project_id,import_key));
  CREATE TABLE IF NOT EXISTS hermes_turn(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES hermes_work(work_id),request_id TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,reply TEXT NOT NULL DEFAULT '',session_id TEXT,owner TEXT,permission TEXT,reason TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_id));
  CREATE TABLE IF NOT EXISTS hermes_event(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL,turn_id TEXT,kind TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS hermes_turn_work ON hermes_turn(project_id,work_id,created_at);
  CREATE TABLE IF NOT EXISTS hermes_turn_context(turn_id TEXT PRIMARY KEY REFERENCES hermes_turn(id),project_id TEXT NOT NULL,work_id TEXT NOT NULL,context_json TEXT NOT NULL,sha256 TEXT NOT NULL,created_at TEXT NOT NULL);
`);}
function hasTable(store:PackStore){return Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='hermes_work'").get());}
function row(store:PackStore,project:string,id:string){const value=store.hermesState.prepare('SELECT * FROM hermes_work WHERE project_id=? AND work_id=?').get(project,id) as WorkRow|undefined;requireCondition(value,'HERMES_WORK_NOT_FOUND');return value;}
function touch(store:PackStore,project:string,id:string,state?:string){const at=now();store.hermesState.prepare('UPDATE hermes_work SET revision=revision+1,state=COALESCE(?,state),updated_at=? WHERE project_id=? AND work_id=?').run(state??null,at,project,id);store.hermesState.prepare('UPDATE office_work SET updated_at=? WHERE project_id=? AND id=?').run(at,project,id);}
function event(store:PackStore,project:string,id:string,turn:string|null,kind:string,summary:string){store.hermesState.prepare('INSERT INTO hermes_event(project_id,work_id,turn_id,kind,summary,created_at) VALUES(?,?,?,?,?,?)').run(project,id,turn,kind,clean(summary),now());touch(store,project,id);}
export function importHermesWork(store:PackStore,project:string,key:string,definition:HermesWorkDefinition){
  initHermesWorks(store);const old=store.hermesState.prepare('SELECT work_id FROM hermes_work WHERE project_id=? AND import_key=?').get(project,key);if(old)return String(old.work_id);
  const id=randomUUID(),at=now();store.hermesState.exec('SAVEPOINT hermes_import');try{
    store.hermesState.prepare('INSERT INTO office_work VALUES(?,?,?,?,?,?)').run(id,project,definition.title,definition.goal,at,at);
    store.hermesState.prepare('INSERT INTO hermes_work(work_id,project_id,import_key,definition,updated_at) VALUES(?,?,?,?,?)').run(id,project,key,JSON.stringify(definition),at);
    event(store,project,id,null,'imported','기존 업무 지침과 과거 근거를 연결했습니다. 실행·일정은 시작하지 않았습니다.');store.hermesState.exec('RELEASE hermes_import');return id;
  }catch(error){store.hermesState.exec('ROLLBACK TO hermes_import; RELEASE hermes_import');throw error;}
}
export function hermesBoardRow(store:PackStore,project:string,id:string){
  if(!hasTable(store))return null;const value=store.hermesState.prepare('SELECT * FROM hermes_work WHERE project_id=? AND work_id=?').get(project,id) as WorkRow|undefined;if(!value)return null;
  const definition=JSON.parse(value.definition) as HermesWorkDefinition;
  return {status:value.state==='detached'?'stopped':value.paused?'paused':value.state,run:{kind:'hermes',id:value.work_id,status:value.state},run_revision:value.revision,updated_at:value.updated_at,pack:definition.family,has_contract:true};
}
export function hermesWorkDetail(store:PackStore,project:string,id:string){
  if(!hermesBoardRow(store,project,id))return null;const work=row(store,project,id),definition=JSON.parse(work.definition) as HermesWorkDefinition;
  const turns=store.hermesState.prepare('SELECT * FROM hermes_turn WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(project,id) as TurnRow[];
  const latest=turns[0],permission=latest?.permission?JSON.parse(latest.permission):null;
  const events=store.hermesState.prepare('SELECT id,kind,summary,created_at FROM hermes_event WHERE project_id=? AND work_id=? ORDER BY id DESC LIMIT 60').all(project,id).reverse();
  const migration=store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_hermes_migration'").get()?store.hermesState.prepare('SELECT id,status FROM office_hermes_migration WHERE project_id=? AND work_id=? LIMIT 1').get(project,id):null;
  return {id,title:definition.title,goal:definition.goal,client:'Hermes',definition,revision:work.revision,run_status:work.state==='detached'?'detached':work.paused?'paused':work.state,migration,hermes:{session_id:work.session_id,detached:work.state==='detached',paused:Boolean(work.paused),can_send:!work.paused&&!turns.some(t=>active.includes(t.status))&&!['reconciliation_required','needs_human','detached'].includes(work.state),needs_review:['reconciliation_required','needs_human'].includes(work.state)&&!permission,permission:permission&&Date.parse(permission.expires_at)>Date.now()?permission:null,turns:turns.map(t=>({id:t.id,instruction:clean(t.instruction,4000),status:t.status,reply:clean(t.reply,24000),session_id:t.session_id,reason:t.reason,created_at:t.created_at,updated_at:t.updated_at})),events},completion_verified:false};
}
function ownerIdentity(pid=process.pid){try{const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),stat=readFileSync(`/proc/${pid}/stat`,'utf8'),ticks=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];return `${pid}:${boot}:${ticks}`;}catch{return null;}}
export interface HermesWorkOptions {executable?:string;args?:string[];transport?:(callbacks:HermesTransportCallbacks,cwd:string)=>HermesTransport;turn_timeout_ms?:number;}
export class HermesWorkRuntime {
  private transport:HermesTransport|null=null;private current:TurnRow|null=null;private running:Promise<void>|null=null;private stopped=false;private replyBuffer='';
  private permission:{id:string;turn:string;resolve:(result:unknown)=>void;timer:NodeJS.Timeout;options:string[]}|null=null;
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly options:HermesWorkOptions={}){
    initHermesWorks(store);
    for(const turn of store.hermesState.prepare("SELECT * FROM hermes_turn WHERE project_id=? AND status IN ('starting','running','needs_human')").all(config.project.id) as TurnRow[]){
      const pid=Number(turn.owner?.split(':')[0]);if(!turn.owner||ownerIdentity(pid)!==turn.owner)this.finish(turn,'reconciliation_required','HERMES_CONNECTION_LOST_REVIEW_BEFORE_NEXT_INSTRUCTION');
    }
  }
  status(id:string){return hermesWorkDetail(this.store,this.config.project.id,id);}
  action(raw:unknown){
    const input=actionSchema.parse(raw),project=this.config.project.id,work=row(this.store,project,input.work_id);
    requireCondition(work.state!=='detached','HERMES_WORK_DETACHED');
    if(input.action==='send'&&input.request_id){const old=this.store.hermesState.prepare('SELECT * FROM hermes_turn WHERE project_id=? AND request_id=?').get(project,input.request_id) as TurnRow|undefined;if(old){requireCondition(old.work_id===input.work_id&&old.instruction===input.instruction,'HERMES_REQUEST_ID_CONFLICT');return this.status(input.work_id);}}
    requireCondition(work.revision===input.revision,'WORK_REVISION_CONFLICT');
    if(input.action==='send'){
      requireCondition(input.request_id&&input.instruction,'HERMES_INSTRUCTION_REQUIRED');requireCondition(input.cost_acknowledged,'HERMES_MODEL_USAGE_CONSENT_REQUIRED');
      requireCondition(clean(input.instruction,4000)===input.instruction,'CREDENTIAL_LIKE_INPUT');
      requireCondition(!work.paused&&!['reconciliation_required','needs_human'].includes(work.state),'HERMES_WORK_REVIEW_OR_RESUME_REQUIRED');
      this.store.hermesState.exec('BEGIN IMMEDIATE');try{
        requireCondition(!this.store.hermesState.prepare("SELECT 1 FROM hermes_turn WHERE project_id=? AND work_id=? AND status IN ('queued','starting','running','needs_human')").get(project,input.work_id),'HERMES_TURN_ALREADY_ACTIVE');
        const id=randomUUID(),at=now();this.store.hermesState.prepare('INSERT INTO hermes_turn(id,project_id,work_id,request_id,instruction,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(id,project,input.work_id,input.request_id,input.instruction,'queued',at,at);touch(this.store,project,input.work_id,'queued');event(this.store,project,input.work_id,id,'queued','Hermes 실행 대기열에 지시를 저장했습니다.');this.store.hermesState.exec('COMMIT');
      }catch(error){this.store.hermesState.exec('ROLLBACK');throw error;}
      this.tick();
    }else if(input.action==='pause'||input.action==='resume'){
      const paused=input.action==='pause';this.store.hermesState.prepare('UPDATE hermes_work SET paused=? WHERE project_id=? AND work_id=?').run(Number(paused),project,input.work_id);touch(this.store,project,input.work_id);
      event(this.store,project,input.work_id,this.current?.work_id===input.work_id?this.current.id:null,paused?'paused':'resumed',paused?'추가 배정을 멈췄습니다. 진행 중 요청에는 중단을 전달합니다.':'대기 중인 미실행 지시를 허용합니다. 중단된 지시는 자동 재실행하지 않습니다.');
      if(paused&&this.current?.work_id===input.work_id){this.cancelPermission();if(this.current.session_id)this.transport?.notify('session/cancel',{sessionId:this.current.session_id});this.finish(this.current,'reconciliation_required','HERMES_INTERRUPTED_EFFECTS_REQUIRE_REVIEW');void this.transport?.close();}else if(!paused)this.tick();
    }else if(input.action==='review'){
      requireCondition(!this.store.hermesState.prepare("SELECT 1 FROM hermes_turn WHERE project_id=? AND work_id=? AND status IN ('queued','starting','running','needs_human')").get(project,input.work_id),'HERMES_TURN_ALREADY_ACTIVE');
      requireCondition(['needs_human','reconciliation_required'].includes(work.state),'HERMES_REVIEW_NOT_REQUIRED');touch(this.store,project,input.work_id,'ready');event(this.store,project,input.work_id,null,'reviewed','사용자가 결과를 검토했습니다. 새 지시 전에는 추가 실행하지 않습니다.');
    }else{
      requireCondition(this.permission&&this.current?.work_id===input.work_id&&input.permission_id===this.permission.id&&input.option_id&&this.permission.options.includes(input.option_id),'HERMES_PERMISSION_EXPIRED_OR_INVALID');
      const pending=this.permission;this.permission=null;clearTimeout(pending.timer);pending.resolve({outcome:{outcome:'selected',optionId:input.option_id}});
      this.store.hermesState.prepare('UPDATE hermes_turn SET permission=NULL,status=? WHERE id=?').run('running',pending.turn);touch(this.store,project,input.work_id,'running');event(this.store,project,input.work_id,pending.turn,'permission_answered','사용자가 현재 요청에 한 번만 응답했습니다.');
    }
    return this.status(input.work_id);
  }
  private cancelPermission(){if(!this.permission)return;const pending=this.permission;this.permission=null;clearTimeout(pending.timer);pending.resolve({outcome:{outcome:'cancelled'}});}
  tick(){if(this.stopped||this.running)return;this.running=this.dispatch().finally(()=>{this.running=null;});}
  private async dispatch(){
    const project=this.config.project.id;this.store.hermesState.exec('BEGIN IMMEDIATE');let turn:TurnRow|undefined;
    try{
      if(this.store.hermesState.prepare("SELECT 1 FROM hermes_turn WHERE project_id=? AND status IN ('starting','running','needs_human')").get(project)){this.store.hermesState.exec('COMMIT');return;}
      turn=this.store.hermesState.prepare("SELECT t.* FROM hermes_turn t JOIN hermes_work w ON w.work_id=t.work_id WHERE t.project_id=? AND t.status='queued' AND w.paused=0 ORDER BY t.created_at,t.id LIMIT 1").get(project) as TurnRow|undefined;
      if(turn)this.store.hermesState.prepare("UPDATE hermes_turn SET status='starting',owner=?,updated_at=? WHERE id=? AND status='queued'").run(ownerIdentity(),now(),turn.id);
      this.store.hermesState.exec('COMMIT');
    }catch(error){this.store.hermesState.exec('ROLLBACK');throw error;}if(!turn)return;
    this.current=turn;this.replyBuffer='';let promptSent=false;
    try{
      const work=row(this.store,project,turn.work_id),definition=JSON.parse(work.definition) as HermesWorkDefinition;
      const cwd=join(dirname(this.config.dbPath),'hermes-workspaces',work.work_id);await mkdir(cwd,{recursive:true,mode:0o700});
      const callbacks:HermesTransportCallbacks={update:params=>this.update(turn!,params),permission:(params,respond)=>this.requestPermission(turn!,params,respond)};
      const executable=this.options.executable??join(homedir(),'.hermes','hermes-agent','venv','bin','hermes-acp');
      if(!this.options.transport)requireCondition(existsSync(executable),'HERMES_ACP_NOT_INSTALLED');
      const transport=this.options.transport?.(callbacks,cwd)??new HermesAcp(executable,this.options.args??[],cwd,callbacks,definition.runtime_home?{...process.env,HERMES_HOME:definition.runtime_home}:undefined);this.transport=transport;
      touch(this.store,project,work.work_id,'running');event(this.store,project,work.work_id,turn.id,'connecting','Hermes 공식 ACP 연결을 준비합니다. 기존 모델·인증 설정을 사용합니다.');
      // Hermes performs parallel MCP discovery (bounded at 120s) before ACP starts.
      await transport.request('initialize',{protocolVersion:1,clientInfo:{name:'agent-driver-personal',version:'0.1.1'},clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false}},150_000);
      if(work.session_id){const loaded=await transport.request('session/load',{sessionId:work.session_id,cwd,mcpServers:[]});requireCondition(loaded!==null,'HERMES_SESSION_NOT_FOUND');turn.session_id=work.session_id;}
      else{const made=await transport.request('session/new',{cwd,mcpServers:[]});requireCondition(typeof made?.sessionId==='string'&&made.sessionId.length<=160,'HERMES_SESSION_INVALID');turn.session_id=made.sessionId;this.store.hermesState.prepare('UPDATE hermes_work SET session_id=? WHERE project_id=? AND work_id=?').run(turn.session_id,project,work.work_id);}
      requireCondition(!this.stopped&&!row(this.store,project,work.work_id).paused,'HERMES_PAUSED_BEFORE_PROMPT');
      const currentWork=row(this.store,project,work.work_id);
      const prior=this.store.hermesState.prepare('SELECT * FROM hermes_turn WHERE project_id=? AND work_id=? AND id<>? ORDER BY created_at,rowid LIMIT 129').all(project,work.work_id,turn.id) as TurnRow[];
      requireCondition(prior.length<=128,'CONTINUITY_HISTORY_REVIEW_REQUIRED');
      const context=buildContinuityContext({
        binding:{project_id:project,work_id:work.work_id,run_id:turn.id,revision:currentWork.revision,execution_owner:'hermes'},
        goal:definition.goal,completion_checks:definition.checks,
        instructions:[{id:'definition',source:'work_definition',text:definition.instruction},...prior.map(item=>({id:item.id,source:'user' as const,text:item.instruction})),{id:turn.id,source:'user',text:turn.instruction}],
        constraints:[
          'Hermes owns execution and may select its installed, enabled skills and tools within existing permissions. Pack family and suggested steps are organizational hints, not a mandatory tool sequence.',
          'Hermes keeps its own model, credentials, memory and session. This contract does not enable unavailable skills or grant permission to install them.',
          'Do not submit reports, enable schedules or send notifications without a separate user instruction. Result review does not authorize repeating previous actions.',
        ],
        receipts:prior.map(item=>({id:item.id,status:item.status,effect_state:item.status==='reconciliation_required'?'uncertain' as const:'unobserved' as const,verification:item.status==='finished'?'reported' as const:'unverified' as const,evidence_refs:[`hermes_turn:${item.id}`],reason:item.reason})),
        next_action:'Follow the latest user direction within the existing scope. Inspect any uncertain previous effects before repeating actions. Report results, evidence and unfinished items separately.',
      },[...prior.slice(-3).reverse().map(item=>({id:item.id,source:'agent_reply_unverified',text:item.reply})),...definition.history.slice(-3).reverse().map((item,index)=>({id:`imported-${index}`,source:item.source,text:item.summary}))]);
      this.store.hermesState.prepare('INSERT INTO hermes_turn_context(turn_id,project_id,work_id,context_json,sha256,created_at) VALUES(?,?,?,?,?,?)').run(turn.id,project,work.work_id,JSON.stringify(context),context.sha256,now());
      this.store.hermesState.prepare("UPDATE hermes_turn SET status='running',session_id=?,updated_at=? WHERE id=?").run(turn.session_id,now(),turn.id);
      event(this.store,project,work.work_id,turn.id,'prompt_sent','업무 지침을 Hermes에 전달했습니다. 답변과 도구 진행을 기다립니다.');
      promptSent=true;
      const prompt=`Agent Driver가 관리하는 개인 업무입니다. 실제 실행과 스킬 선택은 Hermes가 담당합니다.\n업무: ${clean(definition.title)}\n요청 ID: ${turn.request_id}\n업무 인계 계약:\n${renderContinuityContext(context)}`;
      const result=await transport.request('session/prompt',{sessionId:turn.session_id,prompt:[{type:'text',text:prompt}]},this.options.turn_timeout_ms??600_000);
      const current=this.store.hermesState.prepare('SELECT status FROM hermes_turn WHERE id=?').get(turn.id);
      if(current?.status==='reconciliation_required')return;
      if(result?.stopReason==='end_turn')this.finish(turn,'needs_human','HERMES_REPLY_REQUIRES_RESULT_REVIEW','finished');
      else this.finish(turn,'reconciliation_required','HERMES_TURN_NOT_COMPLETED');
    }catch(error){const interrupted=this.store.hermesState.prepare('SELECT status FROM hermes_turn WHERE id=?').get(turn.id)?.status==='reconciliation_required';if(!interrupted)this.finish(turn,promptSent?'reconciliation_required':'failed',error instanceof Error&&/^[A-Z_]+$/u.test(error.message)?error.message:'HERMES_EXECUTION_FAILED');}
    finally{this.cancelPermission();await this.transport?.close();this.transport=null;this.current=null;this.replyBuffer='';}
  }
  private update(turn:TurnRow,params:any){
    if(!turn.session_id||params?.sessionId!==turn.session_id)return;
    const update=params.update;if(!update||typeof update!=='object')return;
    // Never store hidden reasoning or history replay as a new answer.
    const status=this.store.hermesState.prepare('SELECT status,reply FROM hermes_turn WHERE id=?').get(turn.id);if(!status||!['running','needs_human'].includes(String(status.status)))return;
    if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'){
      this.replyBuffer=(this.replyBuffer+String(update.content.text??'')).slice(0,24000);
      // Buffer the incomplete final line so split credentials cannot leak between chunks.
      const boundary=this.replyBuffer.lastIndexOf('\n');
      const text=boundary<0?'':clean(this.replyBuffer.slice(0,boundary+1),24000);this.store.hermesState.prepare('UPDATE hermes_turn SET reply=?,updated_at=? WHERE id=?').run(text,now(),turn.id);touch(this.store,turn.project_id,turn.work_id);
    }else if(['tool_call','tool_call_update'].includes(update.sessionUpdate))event(this.store,turn.project_id,turn.work_id,turn.id,'tool',`${clean(update.title??update.toolCallId,180)} · ${clean(update.status??'진행 중',80)}`);
    else if(update.sessionUpdate==='plan')event(this.store,turn.project_id,turn.work_id,turn.id,'plan',JSON.stringify((update.entries??[]).slice(0,12).map((item:any)=>({step:clean(item.content,160),status:clean(item.status,40)}))));
  }
  private requestPermission(turn:TurnRow,params:any,respond:(result:unknown)=>void){
    if(params?.sessionId!==turn.session_id||this.permission||row(this.store,turn.project_id,turn.work_id).paused){respond({outcome:{outcome:'cancelled'}});return;}
    const options=(Array.isArray(params.options)?params.options:[]).filter((o:any)=>o&&['allow_once','reject_once'].includes(o.kind)&&typeof o.optionId==='string'&&o.optionId.length>0&&o.optionId.length<=120).slice(0,8).map((o:any)=>({id:o.optionId,label:clean(o.name,100),kind:o.kind}));
    if(!options.length){respond({outcome:{outcome:'cancelled'}});return;}
    const id=randomUUID(),permission={id,title:clean(params.toolCall?.title??'Hermes 요청 확인'),options,expires_at:new Date(Date.now()+50_000).toISOString()};
    const timer=setTimeout(()=>{if(this.permission?.id===id){this.cancelPermission();this.store.hermesState.prepare("UPDATE hermes_turn SET permission=NULL,status='running' WHERE id=?").run(turn.id);touch(this.store,turn.project_id,turn.work_id,'running');event(this.store,turn.project_id,turn.work_id,turn.id,'permission_expired','확인 시간이 지나 요청을 거절했습니다.');}},50_000);timer.unref();
    this.permission={id,turn:turn.id,resolve:respond,timer,options:options.map((o:any)=>o.id)};
    this.store.hermesState.prepare("UPDATE hermes_turn SET permission=?,status='needs_human' WHERE id=?").run(JSON.stringify(permission),turn.id);touch(this.store,turn.project_id,turn.work_id,'needs_human');event(this.store,turn.project_id,turn.work_id,turn.id,'permission_required',permission.title);
  }
  private finish(turn:TurnRow,state:string,reason:string,turnState=state){if(this.current?.id===turn.id&&this.replyBuffer)this.store.hermesState.prepare('UPDATE hermes_turn SET reply=? WHERE id=?').run(clean(this.replyBuffer,24000),turn.id);this.store.hermesState.prepare('UPDATE hermes_turn SET status=?,permission=NULL,reason=?,updated_at=? WHERE id=?').run(turnState,reason,now(),turn.id);touch(this.store,turn.project_id,turn.work_id,state);event(this.store,turn.project_id,turn.work_id,turn.id,state,reason);}
  async drain(){await this.running;}
  async close(){this.stopped=true;this.cancelPermission();if(this.current){this.finish(this.current,'reconciliation_required','CONTROL_CENTER_STOPPED_REVIEW_BEFORE_RESUME');if(this.current.session_id)this.transport?.notify('session/cancel',{sessionId:this.current.session_id});}await this.transport?.close();await this.running;}
}
