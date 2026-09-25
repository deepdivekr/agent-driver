import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {requireCondition} from '../core/contracts.js';
import {migrationText as clean} from './hermes-source.js';
import {remoteTargetSchema,SshOpenClaw,type RemoteTransport,type RemoteTarget} from '../integrations/remote-openclaw.js';

const uuid=z.string().uuid(),key=z.string().min(1).max(240),now=()=>new Date().toISOString();
export const remoteDiscover=z.object({target_id:uuid}).strict();
export const remoteLink=z.object({target_id:uuid,kind:z.enum(['session','job']),source_id:key,acknowledged:z.literal(true)}).strict();
export const remotePropose=z.object({work_id:uuid,request_id:uuid,instruction:z.string().trim().min(3).max(4000)}).strict();
export const remoteAction=z.object({work_id:uuid,revision:z.number().int().nonnegative(),action:z.enum(['refresh','send','stop','review']),request_id:uuid.optional(),instruction:z.string().trim().min(3).max(4000).optional(),cost_acknowledged:z.boolean().optional()}).strict();
type Row={work_id:string;project_id:string;target_id:string;kind:'session'|'job';source_id:string;title:string;revision:number;state:string;observed_at:string|null;error:string|null;snapshot:string};
type Turn={id:string;project_id:string;work_id:string;instruction:string;status:string;run_id:string|null;created_at:string;updated_at:string};
function init(store:PackStore){store.hermesState.exec(`
 CREATE TABLE IF NOT EXISTS office_remote_target(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,definition TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,definition));
 CREATE TABLE IF NOT EXISTS office_remote_work(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,target_id TEXT NOT NULL,kind TEXT NOT NULL,source_id TEXT NOT NULL,title TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL DEFAULT 'unobserved',observed_at TEXT,error TEXT,snapshot TEXT NOT NULL DEFAULT '{}',UNIQUE(project_id,target_id,kind,source_id));
 CREATE TABLE IF NOT EXISTS office_remote_turn(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL,instruction TEXT NOT NULL,status TEXT NOT NULL,run_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS office_remote_event(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL,kind TEXT NOT NULL,summary TEXT NOT NULL,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS office_remote_proposal(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL,instruction TEXT NOT NULL,created_at TEXT NOT NULL);
`)}
function exists(store:PackStore){return Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_remote_work'").get())}
function find(store:PackStore,project:string,id:string){const row=store.hermesState.prepare('SELECT * FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,id) as Row|undefined;requireCondition(row,'REMOTE_WORK_NOT_FOUND');return row}
export function remoteDetail(store:PackStore,project:string,id:string){
 if(!exists(store))return null;const row=store.hermesState.prepare('SELECT * FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,id) as Row|undefined;if(!row)return null;
 const t=store.hermesState.prepare('SELECT definition FROM office_remote_target WHERE project_id=? AND id=?').get(project,row.target_id);if(!t)return null;
 const target=JSON.parse(String(t.definition)) as RemoteTarget;
 const turns=store.hermesState.prepare('SELECT id,instruction,status,run_id,created_at,updated_at FROM office_remote_turn WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 10').all(project,id);
 const events=store.hermesState.prepare('SELECT kind,summary,created_at FROM office_remote_event WHERE project_id=? AND work_id=? ORDER BY id DESC LIMIT 25').all(project,id).reverse();
 const latest=turns[0];
 const proposal=store.hermesState.prepare('SELECT id,instruction FROM office_remote_proposal WHERE project_id=? AND work_id=? AND id NOT IN (SELECT id FROM office_remote_turn) ORDER BY created_at DESC LIMIT 1').get(project,id)??null;
 const fresh=row.observed_at!==null&&Date.now()-Date.parse(row.observed_at)<30000,snapshot=JSON.parse(row.snapshot);
 return {id,title:row.title,goal:'원격 OpenClaw 업무 · 실행과 예약은 원본 서버에서 유지',revision:row.revision,run_status:row.state,completion_verified:false,remote:{target_name:target.name,kind:row.kind,source_id:row.source_id,observed_at:row.observed_at,stale:!fresh,error:row.error,snapshot,turns,events,proposal,can_send:row.kind==='session'&&!row.error&&row.state==='ready'&&fresh&&Boolean(snapshot.session_id),can_stop:row.kind==='session'&&Boolean(latest?.run_id)&&['running','uncertain'].includes(String(latest?.status)),needs_review:['finished','aborted','failed'].includes(String(latest?.status))&&row.state!=='ready',schedule_owner:'remote'}};
}
export function remoteBoard(store:PackStore,project:string,id:string){if(!exists(store))return null;const row=store.hermesState.prepare('SELECT state,revision,observed_at,error FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,id);if(!row)return null;return {status:row.error?'reconciliation_required':row.state,run:{kind:'remote',id,status:row.state},run_revision:row.revision,pack:'remote.openclaw',has_contract:true}}
function visibleHistory(result:any){requireCondition(Array.isArray(result?.messages),'REMOTE_SOURCE_SCHEMA_UNSUPPORTED');return {session_id:typeof result?.sessionId==='string'?clean(result.sessionId,240):null,messages:result.messages.slice(-12).filter((m:any)=>m&&['user','assistant'].includes(m.role)&&!m.isReasoning).map((m:any)=>({role:m.role,text:clean(typeof m.content==='string'?m.content:(Array.isArray(m.content)?m.content.filter((c:any)=>c&&c.type==='text'&&!c.isReasoning).map((c:any)=>c.text??'').join('\n'):''),8000)}))}}
export class RemoteOffice {
 private pending=new Map<string,Promise<unknown>>();
 private active=new Set<Promise<unknown>>();
 private track<T>(fn:()=>Promise<T>){const task=fn();this.active.add(task);void task.finally(()=>this.active.delete(task)).catch(()=>{});return task}
 constructor(readonly store:PackStore,readonly config:HostConfig,readonly transport:RemoteTransport=new SshOpenClaw()){init(store)}
 targets(){return this.store.hermesState.prepare('SELECT id,definition FROM office_remote_target WHERE project_id=? ORDER BY created_at').all(this.config.project.id).map(row=>({id:String(row.id),...JSON.parse(String(row.definition)) as RemoteTarget}))}
 register(raw:unknown){const definition=remoteTargetSchema.parse(raw);requireCondition(clean(definition.name,80)===definition.name,'REMOTE_CREDENTIAL_LIKE_INPUT');const body=JSON.stringify(definition),project=this.config.project.id,old=this.store.hermesState.prepare('SELECT id FROM office_remote_target WHERE project_id=? AND definition=?').get(project,body);if(old)return {id:String(old.id),reused:true};const id=randomUUID();this.store.hermesState.prepare('INSERT INTO office_remote_target VALUES(?,?,?,?)').run(id,project,body,now());return {id,reused:false}}
 private target(id:string){const t=this.store.hermesState.prepare('SELECT definition FROM office_remote_target WHERE project_id=? AND id=?').get(this.config.project.id,id);requireCondition(t,'REMOTE_TARGET_NOT_FOUND');return remoteTargetSchema.parse(JSON.parse(String(t.definition)))}
 private event(id:string,kind:string,summary:string){this.store.hermesState.prepare('INSERT INTO office_remote_event(project_id,work_id,kind,summary,created_at) VALUES(?,?,?,?,?)').run(this.config.project.id,id,kind,clean(summary,1500),now())}
 private touch(id:string){this.store.hermesState.prepare('UPDATE office_remote_work SET revision=revision+1 WHERE project_id=? AND work_id=?').run(this.config.project.id,id);this.store.hermesState.prepare('UPDATE office_work SET updated_at=? WHERE project_id=? AND id=?').run(now(),this.config.project.id,id)}
 status(id:string){return remoteDetail(this.store,this.config.project.id,id)}
 propose(raw:unknown){const input=remotePropose.parse(raw),row=find(this.store,this.config.project.id,input.work_id);requireCondition(row.kind==='session','REMOTE_JOB_READ_ONLY');requireCondition(clean(input.instruction,4000)===input.instruction,'REMOTE_CREDENTIAL_LIKE_INPUT');const old=this.store.hermesState.prepare('SELECT * FROM office_remote_proposal WHERE id=?').get(input.request_id);if(old){requireCondition(old.project_id===this.config.project.id&&old.work_id===row.work_id&&old.instruction===input.instruction,'REMOTE_REQUEST_ID_CONFLICT')}else{this.store.hermesState.prepare('INSERT INTO office_remote_proposal VALUES(?,?,?,?,?)').run(input.request_id,this.config.project.id,row.work_id,input.instruction,now());this.event(row.work_id,'proposed','에이전트의 지시 초안이 도착했습니다. 사람이 내용을 확인하고 전송하기 전에는 실행하지 않습니다.');this.touch(row.work_id)}return {work_id:row.work_id,requires_human:true,execution:false}}
 discover(raw:unknown){return this.track(()=>this.discoverOnce(raw))}
 private async discoverOnce(raw:unknown){const {target_id}=remoteDiscover.parse(raw),target=this.target(target_id);
  const [sessions,jobs]=await Promise.all([this.transport.call(target,'sessions.list',{limit:50}),this.transport.call(target,'cron.list',{includeDisabled:true})]);
  requireCondition(Array.isArray(sessions?.sessions)&&Array.isArray(jobs?.jobs),'REMOTE_SOURCE_SCHEMA_UNSUPPORTED');
  return {target_id,observed_at:now(),schedule_owner:'remote',candidates:[...sessions.sessions.slice(0,50).filter((s:any)=>typeof s.key==='string').map((s:any)=>({kind:'session',source_id:s.key,title:clean(s.label??s.displayName??s.key,160),schedule:null})),...jobs.jobs.slice(0,100).filter((j:any)=>typeof j.id==='string').map((j:any)=>({kind:'job',source_id:j.id,title:clean(j.name??j.id,160),schedule:clean(JSON.stringify(j.schedule??null),400),enabled:typeof j.enabled==='boolean'?j.enabled:null}))],truncated:sessions.sessions.length>=50||jobs.jobs.length>100};
 }
 link(raw:unknown){return this.track(()=>this.linkOnce(raw))}
 private async linkOnce(raw:unknown){const input=remoteLink.parse(raw),project=this.config.project.id;this.target(input.target_id);const old=this.store.hermesState.prepare('SELECT work_id FROM office_remote_work WHERE project_id=? AND target_id=? AND kind=? AND source_id=?').get(project,input.target_id,input.kind,input.source_id);if(old)return {work_id:String(old.work_id),reused:true};
  const source=(await this.discover({target_id:input.target_id})).candidates.find(s=>s.kind===input.kind&&s.source_id===input.source_id);requireCondition(source,'REMOTE_SOURCE_NOT_FOUND');
  const id=randomUUID(),at=now();this.store.hermesState.exec('BEGIN IMMEDIATE');try{
   const existing=this.store.hermesState.prepare('SELECT work_id FROM office_remote_work WHERE project_id=? AND target_id=? AND kind=? AND source_id=?').get(project,input.target_id,input.kind,input.source_id);if(existing){this.store.hermesState.exec('COMMIT');return {work_id:String(existing.work_id),reused:true}}
   this.store.hermesState.prepare('INSERT INTO office_work VALUES(?,?,?,?,?,?)').run(id,project,source.title,'원격 실행 유지 · Office 관리',at,at);
   this.store.hermesState.prepare('INSERT INTO office_remote_work(work_id,project_id,target_id,kind,source_id,title) VALUES(?,?,?,?,?,?)').run(id,project,input.target_id,input.kind,input.source_id,source.title);
   this.event(id,'linked','원격 업무에 연결했습니다. 실행·인증·예약은 서버에서 유지합니다.');this.store.hermesState.exec('COMMIT');
  }catch(e){this.store.hermesState.exec('ROLLBACK');throw e}return {work_id:id,reused:false};
 }
 async refresh(id:string){if(this.pending.has(id))return this.pending.get(id);const task=this.refreshOnce(id).finally(()=>this.pending.delete(id));this.pending.set(id,task);return task}
 private async refreshOnce(id:string){const project=this.config.project.id,row=find(this.store,project,id),target=this.target(row.target_id);
  try{let snapshot:unknown;
   if(row.kind==='job'){const result=await this.transport.call(target,'cron.runs',{id:row.source_id,limit:10});requireCondition(Array.isArray(result?.entries),'REMOTE_SOURCE_SCHEMA_UNSUPPORTED');snapshot={runs:result.entries.slice(0,10).map((r:any)=>({status:clean(r.status,80),at:typeof r.ts==='number'?r.ts:null,summary:clean(r.summary??r.error,3000)})),notice:'기존 예약은 서버가 관리합니다. 이 화면에서 예약을 실행·중지하지 않습니다.'};}
   else snapshot=visibleHistory(await this.transport.call(target,'chat.history',{sessionKey:row.source_id,limit:12}));
   const last=this.store.hermesState.prepare('SELECT * FROM office_remote_turn WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(project,id) as Turn|undefined;
   let state=last?row.state:'ready',terminal:string|null=null;
   if(last&&['sending','running','uncertain'].includes(last.status)){
    if(last.run_id){const result=await this.transport.call(target,'agent.wait',{runId:last.run_id,timeoutMs:1});const status=result?.status;
     if(['ok','error'].includes(status)){requireCondition(!result.runId||result.runId===last.run_id,'REMOTE_RUN_ID_MISMATCH');terminal=status==='ok'?'finished':'failed';state='needs_human';}
     else state='reconciliation_required'; // timeout is not evidence that a run is still alive.
    }else{state='reconciliation_required';terminal='uncertain'}
   }
   this.store.hermesState.exec('BEGIN IMMEDIATE');try{
    if(find(this.store,project,id).revision!==row.revision){this.store.hermesState.exec('COMMIT');return this.status(id)}
    if(last&&terminal){this.store.hermesState.prepare('UPDATE office_remote_turn SET status=?,updated_at=? WHERE id=?').run(terminal,now(),last.id);this.event(id,terminal,terminal==='finished'?'서버가 실행 종료를 보고했습니다. 답변과 완료 조건을 확인하세요.':'실행 결과 확인이 필요합니다. 자동 재실행하지 않습니다.')}
    this.store.hermesState.prepare('UPDATE office_remote_work SET snapshot=?,observed_at=?,error=NULL,state=? WHERE project_id=? AND work_id=?').run(JSON.stringify(snapshot),now(),state,project,id);this.touch(id);this.store.hermesState.exec('COMMIT');
   }catch(e){this.store.hermesState.exec('ROLLBACK');throw e}
  }catch{if(find(this.store,project,id).revision===row.revision){this.store.hermesState.prepare("UPDATE office_remote_work SET error='REMOTE_REFRESH_FAILED' WHERE project_id=? AND work_id=?").run(project,id);this.touch(id)}}return this.status(id);
 }
 action(raw:unknown){return this.track(()=>this.actionOnce(raw))}
 private async actionOnce(raw:unknown){const input=remoteAction.parse(raw),project=this.config.project.id,row=find(this.store,project,input.work_id),target=this.target(row.target_id);
  if(input.action==='refresh')return this.refresh(row.work_id);
  if(input.action==='send'&&input.request_id){const prior=this.store.hermesState.prepare('SELECT * FROM office_remote_turn WHERE id=?').get(input.request_id) as Turn|undefined;if(prior){requireCondition(prior.project_id===project&&prior.work_id===row.work_id&&prior.instruction===input.instruction,'REMOTE_REQUEST_ID_CONFLICT');return this.status(row.work_id)}}
  requireCondition(row.revision===input.revision,'WORK_REVISION_CONFLICT');requireCondition(row.kind==='session','REMOTE_JOB_READ_ONLY');
  if(input.action==='send'){
   requireCondition(input.request_id&&input.instruction&&input.cost_acknowledged,'REMOTE_MODEL_USAGE_CONSENT_REQUIRED');requireCondition(clean(input.instruction,4000)===input.instruction,'REMOTE_CREDENTIAL_LIKE_INPUT');requireCondition(this.status(row.work_id)?.remote.can_send,'REMOTE_REFRESH_OR_REVIEW_REQUIRED');
   this.store.hermesState.exec('BEGIN IMMEDIATE');try{
    requireCondition(find(this.store,project,row.work_id).revision===input.revision,'WORK_REVISION_CONFLICT');
    const snapshot=JSON.parse(row.snapshot);requireCondition(typeof snapshot.session_id==='string'&&snapshot.session_id.length>0,'REMOTE_SESSION_UNOBSERVED');
    const at=now();this.store.hermesState.prepare('INSERT INTO office_remote_turn VALUES(?,?,?,?,?,?,?,?)').run(input.request_id,project,row.work_id,input.instruction,'sending',input.request_id,at,at);
    this.store.hermesState.prepare("UPDATE office_remote_work SET state='running' WHERE project_id=? AND work_id=?").run(project,row.work_id);this.touch(row.work_id);this.event(row.work_id,'sending','서버에 지시를 전달합니다. 연결이 끊겨도 같은 지시를 자동 반복하지 않습니다.');this.store.hermesState.exec('COMMIT');
   }catch(e){this.store.hermesState.exec('ROLLBACK');throw e}
   try{const answer=await this.transport.call(target,'chat.send',{sessionKey:row.source_id,sessionId:JSON.parse(row.snapshot).session_id,message:input.instruction,idempotencyKey:input.request_id,deliver:false});requireCondition(typeof answer?.runId==='string'&&uuid.safeParse(answer.runId).success,'REMOTE_ACK_INVALID');this.store.hermesState.prepare("UPDATE office_remote_turn SET run_id=?,status='running',updated_at=? WHERE id=? AND status IN ('sending','uncertain')").run(answer.runId,now(),input.request_id);this.event(row.work_id,'accepted','서버가 지시를 접수했습니다. 접수는 업무 완료가 아닙니다.');}
   catch{this.store.hermesState.prepare("UPDATE office_remote_turn SET status='uncertain',updated_at=? WHERE id=?").run(now(),input.request_id);this.store.hermesState.prepare("UPDATE office_remote_work SET state='reconciliation_required' WHERE project_id=? AND work_id=?").run(project,row.work_id);this.event(row.work_id,'uncertain','수신 여부가 불확실합니다. 서버 기록을 확인하세요. 자동 재전송하지 않습니다.');}
   this.touch(row.work_id);
  }else if(input.action==='stop'){
   const last=this.store.hermesState.prepare('SELECT * FROM office_remote_turn WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(project,row.work_id) as Turn|undefined;requireCondition(last?.run_id&&['running','uncertain'].includes(last.status),'REMOTE_NO_OWNED_RUN');
   const result=await this.transport.call(target,'chat.abort',{sessionKey:row.source_id,runId:last.run_id,preserveSideRuns:true});requireCondition(result?.aborted===true&&Array.isArray(result?.runIds)&&result.runIds.includes(last.run_id),'REMOTE_STOP_UNCONFIRMED');this.store.hermesState.prepare("UPDATE office_remote_turn SET status='aborted',updated_at=? WHERE id=?").run(now(),last.id);this.store.hermesState.prepare("UPDATE office_remote_work SET state='needs_human' WHERE project_id=? AND work_id=?").run(project,row.work_id);this.event(row.work_id,'aborted','이 Office가 보낸 실행의 중단을 서버가 확인했습니다. 발생한 변경은 되돌려지지 않습니다.');this.touch(row.work_id);
  }else{
   requireCondition(!row.error&&Boolean(row.observed_at)&&Date.now()-Date.parse(row.observed_at!)<30000,'REMOTE_REFRESH_OR_REVIEW_REQUIRED');
   const last=this.store.hermesState.prepare('SELECT * FROM office_remote_turn WHERE project_id=? AND work_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(project,row.work_id) as Turn|undefined;requireCondition(last&&['finished','aborted','failed'].includes(last.status),'REMOTE_UNCERTAIN_RUN_REQUIRES_REMOTE_CONFIRMATION');
   this.store.hermesState.prepare("UPDATE office_remote_work SET state='ready' WHERE project_id=? AND work_id=?").run(project,row.work_id);this.event(row.work_id,'reviewed','결과를 확인했습니다. 새로운 지시를 기다립니다. 이전 지시는 반복하지 않습니다.');this.touch(row.work_id);
  }return this.status(row.work_id);
 }
 async drain(){while(this.active.size||this.pending.size)await Promise.allSettled([...this.active,...this.pending.values()])}
}
