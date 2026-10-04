import {createHash,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {open,realpath} from 'node:fs/promises';
import {basename,dirname,extname,isAbsolute,relative,resolve,sep} from 'node:path';
import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {assertWorkConnected,readWorkLifecycle} from './lifecycle.js';
import {safeControlText} from '../observability/safe-text.js';
import {requireCondition} from '../core/contracts.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {workImportExecutionOwner} from './import-authority.js';
import {WorkDeliverySettings} from './delivery-settings.js';
import {createDeliveryConnector} from './delivery-connectors.js';
import {workActivity} from './activity.js';

const identity=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/u);
const digest=z.string().regex(/^[a-f0-9]{64}$/u);
const text=z.string().max(24000);
const artifactSchema=z.object({label:z.string().min(1).max(200),path:z.string().min(1).max(2000),sha256:digest,bytes:z.number().int().nonnegative().optional(),media_type:z.string().max(120).optional()}).strict();
const sourceSchema=z.object({label:z.string().min(1).max(300),url:z.string().url().max(2000).optional(),reference:z.string().max(500).optional(),observed_at:z.string().datetime({offset:true}).optional()}).strict();
export const workResultRecordSchema=z.object({work_id:identity,run_id:identity,source_kind:z.enum(['pack','swarm','coding','coding_dialog','hermes','remote','client']),work_revision:z.number().int().nonnegative().nullable(),result_key:identity.default('output'),summary:z.string().min(1).max(4000),text:text.default(''),delivery_text:z.string().max(16000).optional(),artifacts:z.array(artifactSchema).max(20).default([]),sources:z.array(sourceSchema).max(32).default([])}).strict();
export const workResultsListSchema=z.object({work_id:identity,limit:z.number().int().min(1).max(30).default(10)}).strict();
export const workResultGetSchema=z.object({work_id:identity,result_id:z.string().uuid()}).strict();
type RecordInput=z.input<typeof workResultRecordSchema>;
type SourceKind=z.infer<typeof workResultRecordSchema>['source_kind'];
export type ResultDeliveryChannel='telegram'|'slack'|'discord'|'email'|'chat'|'file'|'other';
/** An image the saved result produced, read back and verified by the host, for a channel that can show pictures. */
export interface DeliveryImage {name:string;media_type:string;bytes:Buffer;}
export interface ResultDeliveryConnector {id:string;channel:ResultDeliveryChannel;send(input:{result:WorkResult;target_alias:string;idempotency_key:string;images?:DeliveryImage[]}):Promise<{status:'delivered';receipt_id:string}|{status:'failed';effect_state:'not_dispatched'|'uncertain';reason:string}>;}
export interface WorkResultArtifact {id:string;label:string;sha256:string;bytes:number|null;media_type:string|null;download_available:boolean;}
export interface WorkResultDelivery {id:string;channel:'app'|ResultDeliveryChannel;authority:'office'|'original_runtime';status:'available'|'unobserved'|'pending'|'sending'|'delivered'|'failed'|'reconciliation_required';target_alias:string|null;connector_id:string|null;revision:number;attempts:number;reason:string|null;receipt_id:string|null;updated_at:string;can_retry:boolean;}
export interface WorkResult {id:string;project_id:string;work_id:string;run_id:string;source_kind:SourceKind;work_revision:number|null;source_status:string;verification:'verified'|'reported'|'unverified';summary:string;text:string;/** The message the owner receives, when the run wrote one apart from its record. */delivery_text?:string;artifacts:WorkResultArtifact[];sources:Array<z.infer<typeof sourceSchema>>;content_sha256:string;created_at:string;work_completion_verified:boolean;work_title:string;deliveries:WorkResultDelivery[];}
type ResultRow={id:string;project_id:string;work_id:string;run_id:string;source_kind:SourceKind;work_revision:number|null;source_status:string;verification:WorkResult['verification'];body:string;content_sha256:string;created_at:string};
type DeliveryRow={id:string;result_id:string;project_id:string;work_id:string;channel:WorkResultDelivery['channel'];authority:WorkResultDelivery['authority'];status:WorkResultDelivery['status'];target_alias:string|null;connector_id:string|null;target_fingerprint:string|null;revision:number;attempts:number;reason:string|null;receipt_id:string|null;updated_at:string};
type PolicyRow={revision:number;target_ids:string};
const sha=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
const at=()=>new Date().toISOString();
const terminal=new Set(['succeeded','completed','finished','failed','cancelled','partial_evidence','needs_review','watching','aborted']);
/** Plan B1 notification level, for messages to the owner's own messenger. `results`: verified completions only.
 * `results_and_owner` (default): also a stop only the owner can resolve. `all`: every recorded outcome. */
export type NotifyLevel='results'|'results_and_owner'|'all';
export const ownerNeededStates=new Set(['waiting_auth','waiting_approval','awaiting_review','reconciliation_required','failed','waiting_connection','needs_review']);
export const notifies=(level:NotifyLevel,status:string,verified:boolean)=>verified||level==='all'||level==='results_and_owner'&&ownerNeededStates.has(status);
const partialClientStates=new Set(['awaiting_review','waiting_auth','waiting_approval','waiting_model','waiting_connection','paused','retry_wait','reconciliation_required']);
const safe=(value:string,max=24000)=>safeControlText(value,max).replace(/\b(?:password|passwd|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|cookie|authorization)["']?\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]*)/giu,'[REDACTED]').replace(/\bBearer\s+[^\s,;]+/giu,'Bearer [REDACTED]').replace(/\b\d{7,}:[A-Za-z0-9_-]{25,}\b/gu,'[REDACTED]');
function safeUrl(raw:string){try{const url=new URL(raw);if(!['http:','https:'].includes(url.protocol))return undefined;url.username='';url.password='';url.search='';url.hash='';return safe(url.toString(),2000);}catch{return undefined;}}
const object=(value:unknown):Record<string,unknown>=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
const boundedJson=(value:unknown)=>safe(JSON.stringify(value,null,2)??'',24000);
const table=(store:PackStore,name:string)=>Boolean(store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Work outputs are durable receipts. Publishing one never marks the Work complete. */
export class WorkResults {
  private readonly connectors:Map<string,ResultDeliveryConnector>;
  constructor(readonly store:PackStore,connectors:ResultDeliveryConnector[]=[],readonly settings?:WorkDeliverySettings,private readonly notifyLevel:()=>NotifyLevel=()=>'results'){
    this.connectors=new Map(connectors.map(connector=>[connector.id,connector]));
    requireCondition(this.connectors.size===connectors.length,'RESULT_CONNECTOR_DUPLICATE');
    store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_result(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,work_id TEXT NOT NULL REFERENCES office_work(id),run_id TEXT NOT NULL,source_kind TEXT NOT NULL,work_revision INTEGER,source_status TEXT NOT NULL,verification TEXT NOT NULL,result_key TEXT NOT NULL,body TEXT NOT NULL,content_sha256 TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,work_id,source_kind,run_id,result_key,content_sha256));
      CREATE INDEX IF NOT EXISTS office_result_work ON office_result(project_id,work_id,created_at);
      CREATE TABLE IF NOT EXISTS office_result_delivery(id TEXT PRIMARY KEY,result_id TEXT NOT NULL REFERENCES office_result(id),project_id TEXT NOT NULL,work_id TEXT NOT NULL,channel TEXT NOT NULL,authority TEXT NOT NULL,status TEXT NOT NULL,target_alias TEXT,connector_id TEXT,revision INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,reason TEXT,receipt_id TEXT,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS office_result_delivery_target ON office_result_delivery(result_id,channel,COALESCE(target_alias,''));
      CREATE TABLE IF NOT EXISTS office_work_delivery_policy(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,revision INTEGER NOT NULL,target_ids TEXT NOT NULL,updated_at TEXT NOT NULL);`);
    if(!store.hermesState.prepare('PRAGMA table_info(office_result_delivery)').all().some(column=>column.name==='target_fingerprint'))store.hermesState.exec('ALTER TABLE office_result_delivery ADD COLUMN target_fingerprint TEXT');
    // A provider may have accepted a message before an interrupted send. Do not replay it.
    this.reconcileInterrupted();
  }
  selection(project:string,workId:string){
    this.store.officeWorkById(project,workId);
    const authority=workImportExecutionOwner(this.store,project,workId)==='original_runtime'?'original_runtime' as const:'office' as const;
    const row=this.store.hermesState.prepare('SELECT revision,target_ids FROM office_work_delivery_policy WHERE project_id=? AND work_id=?').get(project,workId) as PolicyRow|undefined;
    const target_ids=row?JSON.parse(row.target_ids) as string[]:['app'];
    return {revision:row?.revision??0,target_ids:authority==='office'?target_ids:['app'],authority,deliveries:this.list(project,workId,1)[0]?.deliveries??[]};
  }
  private addPending(project:string,workId:string,resultId:string,targetIds:string[]){
    if(!this.settings)return;
    const db=this.store.hermesState,time=at();
    for(const targetId of targetIds){if(targetId==='app')continue;
      const snapshot=this.settings.targetSnapshot(targetId);if(!snapshot)continue;
      db.prepare('INSERT OR IGNORE INTO office_result_delivery(id,result_id,project_id,work_id,channel,authority,status,target_alias,connector_id,target_fingerprint,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),resultId,project,workId,snapshot.target.platform,'office','pending',targetId,targetId,snapshot.fingerprint,time);
    }
  }
  setSelection(project:string,workId:string,raw:{revision:number;target_ids:string[]}){
    assertWorkConnected(this.store,project,workId);requireCondition(workImportExecutionOwner(this.store,project,workId)!=='original_runtime','RESULT_ORIGINAL_DELIVERY_AUTHORITY');
    requireCondition(Number.isInteger(raw.revision)&&raw.revision>=0&&Array.isArray(raw.target_ids)&&raw.target_ids.length<=21,'RESULT_DELIVERY_SELECTION_INVALID');
    requireCondition(new Set(raw.target_ids).size===raw.target_ids.length&&raw.target_ids.every(id=>typeof id==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u.test(id)&&(id==='app'||this.settings?.target(id))),'RESULT_DELIVERY_TARGET_UNAVAILABLE');
    const db=this.store.hermesState;db.exec('SAVEPOINT office_delivery_selection');
    try{
      const row=db.prepare('SELECT revision,target_ids FROM office_work_delivery_policy WHERE project_id=? AND work_id=?').get(project,workId);
      requireCondition(raw.revision===Number(row?.revision??0),'RESULT_DELIVERY_SELECTION_CONFLICT');
      const previous=row?JSON.parse(String(row.target_ids)) as string[]:['app'];
      const latest=db.prepare('SELECT id,body FROM office_result WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(project,workId);
      let rerouteResultId:string|null=null,newTargets:string[]=[];
      if(latest&&object(JSON.parse(String(latest.body))).completion_verified===true){
        const prior=db.prepare("SELECT status,reason,target_alias,target_fingerprint FROM office_result_delivery WHERE project_id=? AND work_id=? AND result_id=? AND authority='office' AND channel<>'app'").all(project,workId,String(latest.id));
        const uncertain=prior.some(delivery=>['sending','reconciliation_required'].includes(String(delivery.status)));
        const unsent=prior.some(delivery=>delivery.target_fingerprint&&delivery.status==='pending'||delivery.target_fingerprint&&delivery.status==='failed'&&delivery.reason!=='DELIVERY_SELECTION_CHANGED');
        if(unsent&&!uncertain)rerouteResultId=String(latest.id);
        // A destination the owner adds now gets the latest verified result too (live: the owner added their Telegram
        // chat after a Work had finished and nothing was sent, because only unsent rows were rerouted).
        newTargets=uncertain?[]:raw.target_ids.filter(id=>id!=='app'&&!previous.includes(id)&&!prior.some(delivery=>String(delivery.target_alias)===id&&delivery.status!=='failed'));
      }
      db.prepare('INSERT INTO office_work_delivery_policy(work_id,project_id,revision,target_ids,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(work_id) DO UPDATE SET revision=excluded.revision,target_ids=excluded.target_ids,updated_at=excluded.updated_at').run(workId,project,raw.revision+1,JSON.stringify(raw.target_ids),at());
      const existing=db.prepare("SELECT id,target_alias FROM office_result_delivery WHERE project_id=? AND work_id=? AND authority='office' AND status='pending'").all(project,workId);
      for(const pending of existing)if(!raw.target_ids.includes(String(pending.target_alias)))db.prepare("UPDATE office_result_delivery SET status='failed',reason='DELIVERY_SELECTION_CHANGED',revision=revision+1,updated_at=? WHERE id=? AND status='pending'").run(at(),String(pending.id));
      if(rerouteResultId)this.addPending(project,workId,rerouteResultId,raw.target_ids);
      else if(newTargets.length&&latest)this.addPending(project,workId,String(latest.id),newTargets);
      db.exec('RELEASE office_delivery_selection');
    }catch(error){db.exec('ROLLBACK TO office_delivery_selection; RELEASE office_delivery_selection');throw error;}
    this.activity(project,workId,'delivery.selected','Delivery destinations updated.');
    return this.selection(project,workId);
  }
  private revision(project:string,workId:string){
    this.store.officeWorkById(project,workId);
    const intake=this.store.intakeWorkOptional(project,workId);if(intake)return intake.revision;
    for(const name of ['hermes_work','office_remote_work'])if(table(this.store,name)){const row=this.store.hermesState.prepare(`SELECT revision FROM ${name} WHERE project_id=? AND work_id=?`).get(project,workId);if(row)return Number(row.revision);}
    return null;
  }
  private activity(project:string,workId:string,kind:string,summary:string){if(table(this.store,'office_activity'))workActivity(this.store,project,workId,kind,summary);}
  private origin(project:string,workId:string,kind:SourceKind,runId:string):{status:string;verification:WorkResult['verification'];body:unknown;work_revision?:number}{
    this.store.officeWorkById(project,workId);
    if(kind==='client'){
      requireCondition(table(this.store,'office_supervisor'),'RESULT_ORIGIN_UNAVAILABLE');const row=this.store.hermesState.prepare('SELECT state,result,work_revision FROM office_supervisor WHERE project_id=? AND work_id=? AND run_id=?').get(project,workId,runId);requireCondition(row&&row.result,'RESULT_RUN_WORK_MISMATCH');const body=object(JSON.parse(String(row.result)));return {status:String(row.state),verification:row.state==='succeeded'&&body.completion_verified===true?'verified':'reported',body,work_revision:Number(row.work_revision)};
    }
    if(['pack','swarm','coding','coding_dialog'].includes(kind))requireCondition(this.store.officeRuns(project,workId).some(run=>run.source_kind===kind&&run.source_id===runId),'RESULT_RUN_WORK_MISMATCH');
    if(kind==='pack'){const run=this.store.packRun(project,runId);return {status:run.status,verification:'reported',body:run.result};}
    if(kind==='swarm'){const run=this.store.swarmRun(project,runId).snapshot as SwarmRunSnapshot,workers=Object.values(run.workers);return {status:run.status,verification:workers.length>0&&workers.every(worker=>worker.status==='succeeded'&&worker.result?.readback?.verified===true&&worker.quality?.accepted===true)?'verified':'unverified',body:run};}
    if(kind==='coding'){const run=this.store.codingRun(project,runId);return {status:run.status,verification:'reported',body:this.store.codingStages(project,runId)};}
    if(kind==='coding_dialog'){const turn=this.store.codingDialogTurns(project,runId,100).filter(value=>value.status==='completed').at(-1);requireCondition(turn,'RESULT_TURN_NOT_COMPLETED');return {status:'completed',verification:'reported',body:turn};}
    if(kind==='hermes'){
      requireCondition(table(this.store,'hermes_turn'),'RESULT_ORIGIN_UNAVAILABLE');const turn=this.store.hermesState.prepare('SELECT status,reply,updated_at FROM hermes_turn WHERE project_id=? AND work_id=? AND id=?').get(project,workId,runId);requireCondition(turn,'RESULT_RUN_WORK_MISMATCH');return {status:String(turn.status),verification:'reported',body:turn};
    }
    requireCondition(table(this.store,'office_remote_work'),'RESULT_ORIGIN_UNAVAILABLE');
    const row=this.store.hermesState.prepare('SELECT state,observed_at,snapshot FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,workId);requireCondition(row&&runId===workId&&row.observed_at,'RESULT_RUN_WORK_MISMATCH');
    return {status:'finished',verification:'unverified',body:JSON.parse(String(row.snapshot))};
  }
  private importedDelivery(project:string,workId:string):{channel:ResultDeliveryChannel;target:string|null}|null{
    if(workImportExecutionOwner(this.store,project,workId)==='office')return null;
    const imported=this.store.workImportForWork(project,workId),delivery=object(object(imported?.body).delivery);
    const channel=String(delivery.channel??'');if(['telegram','email','chat','file','other'].includes(channel))return {channel:channel as ResultDeliveryChannel,target:typeof delivery.target==='string'?safe(delivery.target,240):null};
    if(table(this.store,'office_remote_work')&&this.store.hermesState.prepare('SELECT 1 FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,workId))return {channel:'other',target:null};
    if(table(this.store,'hermes_work')){const row=this.store.hermesState.prepare('SELECT import_key FROM hermes_work WHERE project_id=? AND work_id=?').get(project,workId);if(row&&!String(row.import_key).startsWith('intake:'))return {channel:'other',target:null};}
    return imported?{channel:'other',target:null}:null;
  }
  /** Trusted runtime hook only; not an MCP result-writing tool. Origin and revision are checked. */
  record(project:string,raw:RecordInput):WorkResult{
    const input=workResultRecordSchema.parse(raw),revision=this.revision(project,input.work_id),origin=this.origin(project,input.work_id,input.source_kind,input.run_id);
    requireCondition(input.work_revision===(origin.work_revision??revision),'RESULT_WORK_REVISION_CONFLICT');
    requireCondition(terminal.has(origin.status)||input.source_kind==='client'&&partialClientStates.has(origin.status),'RESULT_ORIGIN_NOT_FINISHED');
    const body={binding_revision:input.work_revision,summary:safe(input.summary,4000),text:safe(input.text),...(input.delivery_text?.trim()?{delivery_text:safe(input.delivery_text,12000)}:{}),completion_verified:input.source_kind==='client'&&origin.status==='succeeded'&&object(origin.body).completion_verified===true,artifacts:input.artifacts.map((artifact,index)=>({id:`artifact-${index}`,label:safe(artifact.label,200),path:artifact.path,sha256:artifact.sha256,bytes:artifact.bytes??null,media_type:artifact.media_type??null})),sources:input.sources.map(source=>({label:safe(source.label,300),...(source.url&&safeUrl(source.url)?{url:safeUrl(source.url)!}:{}),...(source.reference?{reference:safe(source.reference,500)}:{}),...(source.observed_at?{observed_at:source.observed_at}:{})})),origin_sha256:sha(JSON.stringify({status:origin.status,verification:origin.verification,receipt:origin.body}))};
    requireCondition(Buffer.byteLength(JSON.stringify(body),'utf8')<=96*1024,'RESULT_TOO_LARGE');
    const contentHash=sha(JSON.stringify(body)),db=this.store.hermesState;
    db.exec('SAVEPOINT office_result_record');let id:string;
    try{
      const prior=db.prepare('SELECT id FROM office_result WHERE project_id=? AND work_id=? AND source_kind=? AND run_id=? AND result_key=? AND content_sha256=?').get(project,input.work_id,input.source_kind,input.run_id,input.result_key,contentHash);
      if(prior){db.exec('RELEASE office_result_record');return this.get(project,input.work_id,String(prior.id));}
      id=randomUUID();const time=at();db.prepare('INSERT INTO office_result VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,project,input.work_id,input.run_id,input.source_kind,input.work_revision,origin.status,origin.verification,input.result_key,JSON.stringify(body),contentHash,time);
      db.prepare('INSERT INTO office_result_delivery(id,result_id,project_id,work_id,channel,authority,status,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(),id,project,input.work_id,'app','office','available',time);
      const imported=this.importedDelivery(project,input.work_id);if(imported)db.prepare('INSERT INTO office_result_delivery(id,result_id,project_id,work_id,channel,authority,status,target_alias,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),id,project,input.work_id,imported.channel,'original_runtime','unobserved',imported.target,time);
      // A run the executor paused to wait for a connection or setting is a stop only the owner can resolve; a pause the owner made is not.
      const waitReason=input.source_kind==='client'&&origin.status==='paused'&&table(this.store,'office_supervisor')?String(db.prepare('SELECT reason FROM office_supervisor WHERE run_id=?').get(input.run_id)?.reason??''):'';
      if(notifies(this.notifyLevel(),waitReason.startsWith('WORK_CLIENT_WAIT_')?'waiting_connection':origin.status,body.completion_verified===true)&&!imported&&workImportExecutionOwner(this.store,project,input.work_id)!=='original_runtime'&&this.settings){const policy=db.prepare('SELECT target_ids FROM office_work_delivery_policy WHERE project_id=? AND work_id=?').get(project,input.work_id);if(policy)this.addPending(project,input.work_id,id,JSON.parse(String(policy.target_ids)) as string[]);}
      db.prepare('UPDATE office_work SET updated_at=? WHERE project_id=? AND id=?').run(time,project,input.work_id);db.exec('RELEASE office_result_record');
    }catch(error){db.exec('ROLLBACK TO office_result_record; RELEASE office_result_record');throw error;}
    return this.get(project,input.work_id,id);
  }
  list(project:string,workId:string,limit=10):WorkResult[]{
    const input=workResultsListSchema.parse({work_id:workId,limit});this.store.officeWorkById(project,input.work_id);
    return (this.store.hermesState.prepare('SELECT id FROM office_result WHERE project_id=? AND work_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?').all(project,workId,limit)).map(row=>this.get(project,workId,String(row.id)));
  }
  get(project:string,workId:string,resultId:string):WorkResult{
    const input=workResultGetSchema.parse({work_id:workId,result_id:resultId});this.store.officeWorkById(project,input.work_id);
    const row=this.store.hermesState.prepare('SELECT * FROM office_result WHERE project_id=? AND work_id=? AND id=?').get(project,workId,resultId) as ResultRow|undefined;requireCondition(row,'WORK_RESULT_NOT_FOUND');
    const body=JSON.parse(row.body) as {summary:string;text:string;delivery_text?:string;completion_verified?:boolean;artifacts:Array<WorkResultArtifact&{path:string}>;sources:WorkResult['sources']};
    const connected=readWorkLifecycle(this.store,project,workId).state==='connected';
    const deliveries=(this.store.hermesState.prepare('SELECT * FROM office_result_delivery WHERE project_id=? AND work_id=? AND result_id=? ORDER BY rowid').all(project,workId,resultId) as DeliveryRow[]).map(delivery=>({id:delivery.id,channel:delivery.channel,authority:delivery.authority,status:delivery.status,target_alias:delivery.target_alias,connector_id:delivery.connector_id,revision:delivery.revision,attempts:delivery.attempts,reason:delivery.reason,receipt_id:delivery.receipt_id,updated_at:delivery.updated_at,can_retry:connected&&delivery.status==='failed'&&delivery.authority==='office'&&delivery.connector_id!==null&&delivery.reason!=='DELIVERY_SELECTION_CHANGED'&&(delivery.target_fingerprint===null?this.connectors.has(delivery.connector_id):this.settings?.fingerprint(delivery.connector_id)===delivery.target_fingerprint)}));
    return {id:row.id,project_id:project,work_id:workId,run_id:row.run_id,source_kind:row.source_kind,work_revision:row.work_revision,source_status:row.source_status,verification:row.verification,work_title:String((this.store.officeWorkById(project,workId) as {title?:unknown}|null)?.title??''),summary:body.summary,text:body.text,...(body.delivery_text?{delivery_text:body.delivery_text}:{}),artifacts:body.artifacts.map(artifact=>({id:artifact.id,label:artifact.label,sha256:artifact.sha256,bytes:artifact.bytes,media_type:artifact.media_type,download_available:isAbsolute(artifact.path)})),sources:body.sources,content_sha256:row.content_sha256,created_at:row.created_at,work_completion_verified:body.completion_verified===true,deliveries};
  }
  /** Read persisted output only. This does not call a model, rerun a Pack, or send a message. */
  capture(project:string,workId:string):WorkResult[]{
    if(readWorkLifecycle(this.store,project,workId).state!=='connected')return this.list(project,workId);
    const revision=this.revision(project,workId);
    for(const run of this.store.officeRuns(project,workId).slice(0,20)){
      if(!['pack','swarm','coding','coding_dialog'].includes(run.source_kind))continue;
      let origin:ReturnType<WorkResults['origin']>;try{origin=this.origin(project,workId,run.source_kind as SourceKind,run.source_id);}catch(error){if(error instanceof Error&&error.message==='RESULT_TURN_NOT_COMPLETED')continue;throw error;}
      if(!terminal.has(origin.status))continue;
      const input:RecordInput={work_id:workId,run_id:run.source_id,source_kind:run.source_kind as SourceKind,work_revision:revision,summary:`${run.source_kind} · ${origin.status}`,text:'',artifacts:[],sources:[]},body=object(origin.body);
      if(run.source_kind==='pack'){
        const artifact=object(body.artifact);if(typeof artifact.path==='string'&&typeof artifact.sha256==='string'&&digest.safeParse(artifact.sha256).success)input.artifacts=[{label:basename(artifact.path),path:artifact.path,sha256:artifact.sha256,...(typeof artifact.bytes==='number'?{bytes:artifact.bytes}:{})}];
        input.text=boundedJson(body.rows??body.items??body.baseline??{collected_rows:body.collected_rows,matched_rows:body.matched_rows});
        input.sources=(Array.isArray(body.evidence)?body.evidence:[]).slice(0,32).map(value=>{const evidence=object(value);return {label:safe(String(evidence.source_id??'Observed source'),300),reference:safe(String(evidence.content_sha256??''),500),...(typeof evidence.observed_at==='string'?{observed_at:evidence.observed_at}:{})};});
      }else if(run.source_kind==='swarm'){
        const snapshot=origin.body as SwarmRunSnapshot,reports=Object.values(snapshot.workers).filter(worker=>worker.result).map(worker=>worker.result!);
        input.summary=safe(reports.map(report=>report.summary).join('\n'),4000)||`swarm · ${origin.status}`;
        input.text=boundedJson(reports.flatMap(report=>report.fact_cards));
        input.sources=reports.flatMap(report=>report.evidence.map(evidence=>({label:safe(evidence.claim,300),url:evidence.source_url,observed_at:evidence.observed_at}))).slice(0,32);
        input.artifacts=reports.flatMap(report=>report.artifacts.filter(artifact=>isAbsolute(artifact.ref)).map(artifact=>({label:artifact.kind,path:artifact.ref,sha256:artifact.sha256}))).slice(0,20);
      }else if(run.source_kind==='coding')input.text=safe(this.store.codingStages(project,run.source_id).map(stage=>stage.summary??'').filter(Boolean).join('\n\n'));
      else {input.text=safe(String(body.reply??''));input.summary=safe(input.text.split('\n')[0]??'Completed coding turn',4000)||'Completed coding turn';input.result_key=String(body.id);}
      this.record(project,input);
    }
    if(table(this.store,'office_supervisor'))for(const row of this.store.hermesState.prepare("SELECT run_id,work_revision,state,result,checkpoint FROM office_supervisor WHERE project_id=? AND work_id=? AND result IS NOT NULL AND state IN ('succeeded','needs_review','awaiting_review','failed','completed','waiting_auth','waiting_approval','waiting_model','waiting_connection','paused','retry_wait','reconciliation_required') ORDER BY created_at DESC LIMIT 10").all(project,workId)){
      const output=object(JSON.parse(String(row.result))),checkpoint=object(JSON.parse(String(row.checkpoint))),observations=[...(Array.isArray(checkpoint.observations)?checkpoint.observations:[]),...(Array.isArray(checkpoint.final_observations)?checkpoint.final_observations:[]),...Object.values(object(checkpoint.workers)).flatMap(worker=>{const child=object(worker);return Array.isArray(child.observations)?child.observations:[];})],sources:z.infer<typeof sourceSchema>[]=[],artifacts:z.infer<typeof artifactSchema>[]=[];
      const seen=new Set<string>();let visited=0,allowFiles=true;
      const collect=(raw:unknown,observedAt:string|undefined,depth=0):void=>{
        if(depth>4||visited++>400)return;
        if(Array.isArray(raw)){for(const value of raw.slice(0,32))collect(value,observedAt,depth+1);return;}
        const value=object(raw);
        if(typeof value.url==='string'&&safeUrl(value.url)&&sources.length<32&&!seen.has('url:'+safeUrl(value.url))){seen.add('url:'+safeUrl(value.url));sources.push({label:safe(String(value.title||value.url),300)||'source',url:safeUrl(value.url)!,...(observedAt?{observed_at:observedAt}:{})});}
        if(allowFiles&&typeof value.path==='string'&&typeof value.sha256==='string'&&digest.safeParse(value.sha256).success&&isAbsolute(value.path)&&artifacts.length<20&&!seen.has('artifact:'+value.path)){seen.add('artifact:'+value.path);artifacts.push({label:basename(value.path),path:value.path,sha256:value.sha256,...(typeof value.bytes==='number'&&Number.isInteger(value.bytes)&&value.bytes>=0?{bytes:value.bytes}:{})});}
        for(const child of Object.values(value))if(child&&typeof child==='object')collect(child,observedAt,depth+1);
      };
      // A client run's result is what its latest turn left: files come from its last run record on, sources from the whole run
      // (live: copies of yesterday's cases in the folder took the result's file slots and today's pictures were cut to three).
      const lastRun=observations.map(raw=>String(object(object(raw).invocation).tool_name)).lastIndexOf('office_client_run');
      for(const raw of observations.slice(-64)){const observation=object(raw),receipt=object(observation.receipt);allowFiles=lastRun<0||observations.indexOf(raw)>=lastRun;if(['succeeded','completed','ok'].includes(String(receipt.status)))collect(receipt.value,typeof observation.observed_at==='string'?observation.observed_at:undefined);}
      // The result is what was saved, not only the executor's sentence about it: the last saved Office result is the text.
      let savedText='';for(const raw of observations){const observation=object(raw),invocation=object(observation.invocation),receipt=object(observation.receipt),value=object(receipt.value);if(invocation.tool_name==='office_result_draft'&&receipt.status==='succeeded'&&typeof value.text==='string')savedText=value.text;}
      this.record(project,{work_id:workId,run_id:String(row.run_id),source_kind:'client',work_revision:Number(row.work_revision),summary:safe(String(output.summary??`client · ${row.state}`),4000)||`client · ${row.state}`,text:safe(savedText||String(output.text??output.summary??'')),...(typeof output.delivery_text==='string'&&output.delivery_text.trim()?{delivery_text:output.delivery_text}:{}),sources,artifacts});
    }
    if(table(this.store,'hermes_turn'))for(const turn of this.store.hermesState.prepare("SELECT id,reply FROM hermes_turn WHERE project_id=? AND work_id=? AND status='finished' AND reply<>'' ORDER BY created_at DESC LIMIT 10").all(project,workId))this.record(project,{work_id:workId,run_id:String(turn.id),source_kind:'hermes',work_revision:revision,summary:safe(String(turn.reply).split('\n')[0]??'Hermes reply',4000)||'Hermes reply',text:String(turn.reply)});
    if(table(this.store,'office_remote_work')){
      const row=this.store.hermesState.prepare('SELECT observed_at,snapshot FROM office_remote_work WHERE project_id=? AND work_id=?').get(project,workId);
      if(row?.observed_at){const snapshot=object(JSON.parse(String(row.snapshot))),messages=Array.isArray(snapshot.messages)?snapshot.messages:[],replies=messages.map(object).filter(message=>message.role==='assistant'&&typeof message.text==='string');if(replies.length||Array.isArray(snapshot.runs)&&snapshot.runs.length)this.record(project,{work_id:workId,run_id:workId,source_kind:'remote',work_revision:revision,summary:'Original runtime output',text:replies.length?safe(String(replies.at(-1)!.text)):boundedJson(snapshot.runs)});}
    }
    return this.list(project,workId);
  }
  /** An explicit user instruction and an available connector are required before external delivery. */
  requestDelivery(project:string,workId:string,resultId:string,input:{channel:ResultDeliveryChannel;connector_id:string;target_alias:string;acknowledged:boolean}){
    assertWorkConnected(this.store,project,workId);
    this.get(project,workId,resultId);requireCondition(input.acknowledged,'RESULT_DELIVERY_CONFIRMATION_REQUIRED');
    requireCondition(workImportExecutionOwner(this.store,project,workId)!=='original_runtime'&&!this.importedDelivery(project,workId),'RESULT_ORIGINAL_DELIVERY_AUTHORITY');
    const connector=this.connectors.get(input.connector_id);requireCondition(connector&&connector.channel===input.channel,'RESULT_DELIVERY_CONNECTOR_UNAVAILABLE');
    requireCondition(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/u.test(input.target_alias),'RESULT_TARGET_ALIAS_INVALID');
    const db=this.store.hermesState,old=db.prepare('SELECT id FROM office_result_delivery WHERE result_id=? AND channel=? AND target_alias=?').get(resultId,input.channel,input.target_alias);if(old)return String(old.id);
    const id=randomUUID();db.prepare('INSERT INTO office_result_delivery(id,result_id,project_id,work_id,channel,authority,status,target_alias,connector_id,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,resultId,project,workId,input.channel,'office','pending',input.target_alias,input.connector_id,at());return id;
  }
  async deliver(project:string,workId:string,resultId:string,deliveryId:string,revision:number){
    assertWorkConnected(this.store,project,workId);
    requireCondition(!this.store.intakeWorkOptional(project,workId)?.paused,'RESULT_WORK_PAUSED');
    const result=this.get(project,workId,resultId),db=this.store.hermesState,row=db.prepare('SELECT * FROM office_result_delivery WHERE project_id=? AND work_id=? AND result_id=? AND id=?').get(project,workId,resultId,deliveryId) as DeliveryRow|undefined;
    requireCondition(row&&row.authority==='office'&&row.channel!=='app','RESULT_DELIVERY_NOT_ALLOWED');requireCondition(row.revision===revision,'RESULT_DELIVERY_REVISION_CONFLICT');requireCondition(['pending','failed'].includes(row.status),'RESULT_DELIVERY_NOT_RETRYABLE');
    const targetSnapshot=row.connector_id&&row.target_fingerprint?this.settings?.targetSnapshot(row.connector_id):null;
    requireCondition(row.target_fingerprint===null||targetSnapshot?.fingerprint===row.target_fingerprint,'RESULT_DELIVERY_TARGET_CHANGED');
    let connector=row.connector_id?this.connectors.get(row.connector_id):undefined;
    if(!connector&&targetSnapshot)connector=createDeliveryConnector(targetSnapshot.target);
    requireCondition(connector&&row.target_alias,'RESULT_DELIVERY_CONNECTOR_UNAVAILABLE');
    const claim=db.prepare("UPDATE office_result_delivery SET status='sending',attempts=attempts+1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND status IN ('pending','failed')").run(at(),deliveryId,revision);requireCondition(claim.changes===1,'RESULT_DELIVERY_ALREADY_CLAIMED');
    this.activity(project,workId,'delivery.sending','저장한 결과를 보내는 중이에요.');
    // The pictures the result made go with it to a channel that shows them; one the host cannot reread intact is left out.
    const images:DeliveryImage[]=[],imageTypes:Record<string,string>={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.gif':'image/gif'};
    // A saved artifact may carry no media type (a client run's files did not); the file name decides then.
    const imageType=(artifact:WorkResultArtifact)=>/^image\/(?:png|jpeg|webp|gif)$/u.test(artifact.media_type??'')?artifact.media_type!:artifact.media_type?null:imageTypes[extname(artifact.label).toLowerCase()]??null;
    for(const artifact of result.artifacts.filter(item=>item.download_available&&imageType(item)&&(item.bytes??0)<=10*1024*1024).slice(0,10)){
      try{const file=await this.readArtifact(project,workId,resultId,artifact.id,[dirname(this.store.databasePath)]);images.push({name:artifact.label,media_type:imageType(artifact)!,bytes:file.bytes});}catch{/* left out */}
    }
    let outcome:Awaited<ReturnType<ResultDeliveryConnector['send']>>;
    let timer:NodeJS.Timeout|undefined;
    try{outcome=await Promise.race([connector.send({result,target_alias:row.target_alias,idempotency_key:`office-result:${deliveryId}`,...(images.length?{images}:{})}),new Promise<Awaited<ReturnType<ResultDeliveryConnector['send']>>>(resolve=>{timer=setTimeout(()=>resolve({status:'failed',effect_state:'uncertain',reason:'DELIVERY_RESPONSE_UNOBSERVED'}),30_000);timer.unref();})]);}catch{outcome={status:'failed',effect_state:'uncertain',reason:'DELIVERY_RESPONSE_UNOBSERVED'};}finally{if(timer)clearTimeout(timer);}
    const delivered=outcome.status==='delivered'&&typeof outcome.receipt_id==='string'&&outcome.receipt_id.length>0&&outcome.receipt_id.length<=500;
    const status=delivered?'delivered':outcome.status==='failed'&&outcome.effect_state==='not_dispatched'?'failed':'reconciliation_required';
    db.prepare('UPDATE office_result_delivery SET status=?,revision=revision+1,reason=?,receipt_id=?,updated_at=? WHERE id=? AND status=?').run(status,delivered?null:safe(outcome.status==='failed'?outcome.reason:'DELIVERY_RECEIPT_INVALID',300),delivered?safe((outcome as {receipt_id:string}).receipt_id,500):null,at(),deliveryId,'sending');
    this.activity(project,workId,`delivery.${status}`,status==='delivered'?'저장한 결과를 전달했어요.':status==='failed'?'보내기 전에 실패해서 전달하지 못했어요.':'전달 응답을 확인해야 해요.');
    return this.get(project,workId,resultId);
  }
  /** Retry the stored delivery, not the original Work. Uncertain sends require reconciliation. */
  async retryDelivery(project:string,workId:string,resultId:string,deliveryId:string,revision:number){
    assertWorkConnected(this.store,project,workId);
    const delivery=this.get(project,workId,resultId).deliveries.find(item=>item.id===deliveryId);requireCondition(delivery?.can_retry,'RESULT_DELIVERY_NOT_RETRYABLE');return this.deliver(project,workId,resultId,deliveryId,revision);
  }
  /** Send only stored, verified completion receipts. Called by the execution hook or an explicit recovery tick, never a read route. */
  private reconcileInterrupted(){
    this.store.hermesState.prepare("UPDATE office_result_delivery SET status='reconciliation_required',revision=revision+1,reason='DELIVERY_INTERRUPTED_RECONCILE_RECEIPT',updated_at=? WHERE status='sending' AND updated_at<?").run(at(),new Date(Date.now()-60_000).toISOString());
  }
  async dispatchPending(project:string,workId:string,canDispatch:()=>boolean=()=>true):Promise<WorkResult[]>{
    this.reconcileInterrupted();
    if(!canDispatch()||readWorkLifecycle(this.store,project,workId).state!=='connected'||this.store.intakeWorkOptional(project,workId)?.paused||workImportExecutionOwner(this.store,project,workId)==='original_runtime')return [];
    const rows=this.store.hermesState.prepare("SELECT d.id,d.result_id,d.revision,d.connector_id,d.target_fingerprint,r.body FROM office_result_delivery d JOIN office_result r ON r.id=d.result_id WHERE d.project_id=? AND d.work_id=? AND d.authority='office' AND d.status='pending' AND d.target_fingerprint IS NOT NULL ORDER BY r.created_at,d.rowid LIMIT 20").all(project,workId);
    const delivered:WorkResult[]=[];
    for(const row of rows){
      if(!canDispatch()||readWorkLifecycle(this.store,project,workId).state!=='connected'||this.store.intakeWorkOptional(project,workId)?.paused)break;
      // A pending row exists only for an outcome the notification level admitted when it was recorded.
      if(!row.connector_id||!row.target_fingerprint||this.settings?.fingerprint(String(row.connector_id))!==row.target_fingerprint){
        this.store.hermesState.prepare("UPDATE office_result_delivery SET status='failed',reason='DELIVERY_TARGET_CHANGED',revision=revision+1,updated_at=? WHERE id=? AND status='pending'").run(at(),String(row.id));
        this.activity(project,workId,'delivery.failed','Delivery destination changed before sending.');continue;
      }
      try{delivered.push(await this.deliver(project,workId,String(row.result_id),String(row.id),Number(row.revision)));}catch(error){
        if(error instanceof Error&&['RESULT_DELIVERY_REVISION_CONFLICT','RESULT_DELIVERY_NOT_RETRYABLE','RESULT_DELIVERY_ALREADY_CLAIMED'].includes(error.message))continue;
        throw error;
      }
    }
    return delivered;
  }
  /** Startup recovery cursor: only unsent verified Office receipts, never uncertain attempts. */
  pendingWorkIds(project:string,limit=20):string[]{
    requireCondition(Number.isInteger(limit)&&limit>=1&&limit<=100,'RESULT_DELIVERY_LIMIT_INVALID');
    this.reconcileInterrupted();
    return this.store.hermesState.prepare("SELECT DISTINCT d.work_id FROM office_result_delivery d JOIN office_result r ON r.id=d.result_id LEFT JOIN office_work_lifecycle l ON l.work_id=d.work_id LEFT JOIN office_intake i ON i.work_id=d.work_id WHERE d.project_id=? AND d.authority='office' AND d.status='pending' AND d.target_fingerprint IS NOT NULL AND l.work_id IS NULL AND COALESCE(i.paused,0)=0 ORDER BY r.created_at LIMIT ?").all(project,limit).map(row=>String(row.work_id));
  }
  /** Download only a recorded file inside explicitly delegated roots, with independent readback. */
  async readArtifact(project:string,workId:string,resultId:string,artifactId:string,roots:string[]){
    this.get(project,workId,resultId);const row=this.store.hermesState.prepare('SELECT body FROM office_result WHERE project_id=? AND work_id=? AND id=?').get(project,workId,resultId)!;
    const artifact=(JSON.parse(String(row.body)).artifacts as Array<{id:string;path:string;label:string;sha256:string;bytes:number|null;media_type:string|null}>).find(value=>value.id===artifactId);requireCondition(artifact&&isAbsolute(artifact.path),'RESULT_ARTIFACT_NOT_FOUND');
    const delegated=await Promise.all(roots.filter(isAbsolute).map(root=>realpath(root))),resolved=await realpath(artifact.path);
    requireCondition(delegated.some(root=>{const path=relative(root,resolved);return path!==''&&!isAbsolute(path)&&path!=='..'&&!path.startsWith('..'+sep);}), 'RESULT_ARTIFACT_OUT_OF_SCOPE');
    const handle=await open(resolved,constants.O_RDONLY|constants.O_NOFOLLOW);try{const stat=await handle.stat();requireCondition(stat.isFile()&&stat.size<=16*1024*1024,'RESULT_ARTIFACT_SIZE_INVALID');requireCondition(artifact.bytes===null||artifact.bytes===stat.size,'RESULT_ARTIFACT_CHANGED');const bytes=await handle.readFile();requireCondition(sha(bytes)===artifact.sha256,'RESULT_ARTIFACT_CHANGED');return {bytes,filename:basename(resolve(resolved)).replace(/[\r\n"\\]/gu,'_'),media_type:artifact.media_type??'application/octet-stream',sha256:artifact.sha256};}finally{await handle.close();}
  }
}
