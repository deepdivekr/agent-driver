import {backup} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdir,chmod,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {type PackStore} from '../packs/store.js';
import {type HostConfig} from '../interface/config.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {importHermesWork,initHermesWorks,type HermesWorkDefinition} from './hermes.js';
import {defaultHermesHome,discoverHermes,hermesSourceSelection,migrationText,readHermesSource,type HermesSourceSnapshot} from './hermes-source.js';

export const migrationDefinition=z.object({title:z.string().trim().min(1).max(160),goal:z.string().trim().min(3).max(2000),checks:z.array(z.string().trim().min(3).max(500)).min(1).max(8),steps:z.array(z.string().trim().min(1).max(500)).min(1).max(20),instruction:z.string().trim().min(3).max(4000)}).strict();
export const migrationPreview=hermesSourceSelection.extend({proposal:migrationDefinition.optional()}).strict();
export const migrationId=z.object({migration_id:z.string().uuid()}).strict();
export const migrationApply=migrationId.extend({source_fingerprint:z.string().regex(/^[a-f0-9]{64}$/u),definition:migrationDefinition,acknowledged:z.literal(true)}).strict();
type Definition=z.infer<typeof migrationDefinition>;
type Migration={id:string;project_id:string;source_key:string;source_hash:string;source:string;proposal:string;proposal_hash:string;status:'prepared'|'applied'|'detached';work_id:string|null;approval_hash:string|null;backup_path:string|null;created_at:string;updated_at:string};
export interface HermesMigrationOptions {backup?:(store:PackStore,path:string)=>Promise<void>;beforeCommit?:()=>void;}
function fail(condition:unknown,message:string):asserts condition{if(!condition)throw Error(message)}
function checkedDefinition(raw:unknown){
  const value=migrationDefinition.parse(raw),text=JSON.stringify(value);
  fail(migrationText(text,100000)===text,'MIGRATION_CREDENTIAL_LIKE_INPUT');return value;
}
function defaultProposal(source:HermesSourceSnapshot):Definition{
  const instruction=source.evidence.filter(item=>['user','source_instruction'].includes(item.role)).at(-1)?.text||'';
  return {title:source.title,goal:instruction.slice(0,2000),checks:['요청한 결과와 원본 근거를 대조하고 미완료 항목을 보고한다.'],steps:['대상·권한·필요한 연결 확인','요청된 업무 수행','결과와 미확인 항목 검토'],instruction:instruction.slice(0,4000)};
}
/** The importer reads Hermes only. Human acceptance creates an inactive Driver binding. */
export class HermesMigrationRuntime {
  constructor(readonly store:PackStore,readonly config:HostConfig,readonly options:HermesMigrationOptions={}){
    initHermesWorks(store);
    store.hermesState.exec(`CREATE TABLE IF NOT EXISTS office_hermes_migration(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,source_key TEXT NOT NULL,source_hash TEXT NOT NULL,source TEXT NOT NULL,proposal TEXT NOT NULL,proposal_hash TEXT NOT NULL,status TEXT NOT NULL,work_id TEXT,approval_hash TEXT,backup_path TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS hermes_migration_one_binding ON office_hermes_migration(project_id,source_key) WHERE status='applied';
      CREATE INDEX IF NOT EXISTS hermes_migration_preview ON office_hermes_migration(project_id,source_key,source_hash,proposal_hash);`);
  }
  discover(raw:unknown){return discoverHermes(raw)}
  private get(id:string){const row=this.store.hermesState.prepare('SELECT * FROM office_hermes_migration WHERE project_id=? AND id=?').get(this.config.project.id,id) as Migration|undefined;fail(row,'MIGRATION_NOT_FOUND');return row}
  private linked(key:string){return this.store.hermesState.prepare("SELECT * FROM office_hermes_migration WHERE project_id=? AND source_key=? AND status='applied'").get(this.config.project.id,key) as Migration|undefined}
  private legacyLink(source:HermesSourceSnapshot){
    const rows=this.store.hermesState.prepare("SELECT work_id,definition FROM hermes_work WHERE project_id=? AND import_key NOT LIKE 'migration:%' AND state!='detached'").all(this.config.project.id);
    return rows.find(row=>{const definition=JSON.parse(String(row.definition)) as HermesWorkDefinition;return (definition.runtime_home??defaultHermesHome())===source.home&&definition.history.some(item=>item.source.split(/[^A-Za-z0-9_.-]+/u).includes(source.source_id))})?.work_id??null;
  }
  private view(row:Migration){const source=JSON.parse(row.source) as HermesSourceSnapshot,legacy=this.legacyLink(source);return {format:1,migration_id:row.id,status:row.status,source_fingerprint:row.source_hash,source,definition:JSON.parse(row.proposal),work_id:row.work_id,existing_work_id:this.linked(row.source_key)?.work_id??legacy,legacy_work_id:legacy,backup_created:row.backup_path!==null,execution:false,schedule_activated:false,source_modified:false,jev_used:false,notices:['내용을 확인한 뒤 등록하세요. 이 단계에서는 모델을 호출하거나 업무를 실행하지 않습니다.','기존 Hermes 대화·예약·Telegram 봇·인증은 유지됩니다. 독립적으로 실행되는 원본 업무를 Driver가 자동 추적하지는 않습니다.']}}
  status(raw:unknown){return this.view(this.get(migrationId.parse(raw).migration_id))}
  async preview(raw:unknown){
    const input=migrationPreview.parse(raw),source=await readHermesSource({home:input.home,kind:input.kind,source_id:input.source_id}),proposal=input.proposal?checkedDefinition(input.proposal):defaultProposal(source),hash=snapshotHash(proposal),project=this.config.project.id;
    const id=this.store.transaction(()=>{
      const old=this.store.hermesState.prepare("SELECT id FROM office_hermes_migration WHERE project_id=? AND source_key=? AND source_hash=? AND proposal_hash=? AND status!='detached' ORDER BY created_at LIMIT 1").get(project,source.identity,source.fingerprint,hash);if(old)return String(old.id);
      const id=randomUUID(),at=new Date().toISOString();
      this.store.hermesState.prepare("INSERT INTO office_hermes_migration VALUES(?,?,?,?,?,?,?,'prepared',NULL,NULL,NULL,?,?)").run(id,project,source.identity,source.fingerprint,JSON.stringify(source),JSON.stringify(proposal),hash,at,at);return id;
    });return this.view(this.get(id));
  }
  async apply(raw:unknown){
    const input=migrationApply.parse(raw),definition=checkedDefinition(input.definition),approvalHash=snapshotHash(definition),row=this.get(input.migration_id);
    fail(input.source_fingerprint===row.source_hash,'MIGRATION_FINGERPRINT_MISMATCH');
    if(row.status==='applied'){fail(row.approval_hash===approvalHash,'MIGRATION_APPROVAL_CONFLICT');return {...this.view(row),deduplicated:true}}
    fail(row.status==='prepared','MIGRATION_ALREADY_DETACHED');
    const prior=JSON.parse(row.source) as HermesSourceSnapshot;
    const validateFresh=async()=>{const fresh=await readHermesSource({home:prior.home,kind:prior.kind,source_id:prior.source_id});fail(fresh.identity===row.source_key&&fresh.fingerprint===row.source_hash,'MIGRATION_SOURCE_CHANGED_RESCAN');fail(!fresh.blockers.length,'MIGRATION_SOURCE_RUNTIME_UNSUPPORTED');return fresh};
    await validateFresh();
    fail(!this.legacyLink(prior),'MIGRATION_LEGACY_WORK_REVIEW_REQUIRED');
    const existing=this.linked(row.source_key);
    if(existing){fail(existing.source_hash===row.source_hash&&existing.approval_hash===approvalHash,'MIGRATION_SOURCE_ALREADY_LINKED');return {...this.view(existing),deduplicated:true}}
    const folder=join(dirname(this.config.dbPath),'migration-backups');await mkdir(folder,{recursive:true,mode:0o700});
    fail(await realpath(folder)===folder,'MIGRATION_BACKUP_PATH_INVALID');
    const backupPath=join(folder,`hermes-${row.id}-${randomUUID()}.sqlite`);
    if(this.options.backup)await this.options.backup(this.store,backupPath);else await backup(this.store.hermesState,backupPath);
    await chmod(backupPath,0o600);
    const fresh=await validateFresh();
    return this.store.transaction(()=>{
      const current=this.get(row.id);
      if(current.status==='applied'){fail(current.approval_hash===approvalHash,'MIGRATION_APPROVAL_CONFLICT');return {...this.view(current),deduplicated:true}}
      fail(current.status==='prepared','MIGRATION_ALREADY_DETACHED');
      fail(!this.legacyLink(fresh),'MIGRATION_LEGACY_WORK_REVIEW_REQUIRED');
      const linked=this.linked(row.source_key);
      if(linked){fail(linked.source_hash===row.source_hash&&linked.approval_hash===approvalHash,'MIGRATION_SOURCE_ALREADY_LINKED');return {...this.view(linked),deduplicated:true}}
      const work:HermesWorkDefinition={...definition,family:'workflow.imported',runtime_home:fresh.home,history:[{source:`Hermes ${fresh.kind} · ${fresh.source_id}`,summary:'가져오기 시점의 원본 위치입니다. 과거 대화·완료 주장을 새 실행 승인으로 취급하지 않습니다.'}],instruction:definition.instruction+'\n과거 대화와 예약은 참고자료이며 새 실행 승인이 아닙니다. 일정을 추가·변경하거나 전송하지 말고, 이번 지시의 날짜·권한을 먼저 확인하세요.'};
      const workId=importHermesWork(this.store,this.config.project.id,'migration:'+row.id,work);
      this.options.beforeCommit?.();
      this.store.hermesState.prepare("UPDATE office_hermes_migration SET status='applied',proposal=?,approval_hash=?,work_id=?,backup_path=?,updated_at=? WHERE id=? AND project_id=?").run(JSON.stringify(definition),approvalHash,workId,backupPath,new Date().toISOString(),row.id,this.config.project.id);
      return {...this.view(this.get(row.id)),deduplicated:false};
    });
  }
  undo(raw:unknown){
    const input=migrationId.parse(raw);
    return this.store.transaction(()=>{
      const row=this.get(input.migration_id);if(row.status==='detached')return this.view(row);
      if(row.work_id){fail(!this.store.hermesState.prepare('SELECT 1 FROM hermes_turn WHERE project_id=? AND work_id=? LIMIT 1').get(this.config.project.id,row.work_id),'MIGRATION_ALREADY_EXECUTED_USE_PAUSE');
        this.store.hermesState.prepare("UPDATE hermes_work SET paused=1,state='detached',revision=revision+1,updated_at=? WHERE project_id=? AND work_id=?").run(new Date().toISOString(),this.config.project.id,row.work_id);
      }
      this.store.hermesState.prepare("UPDATE office_hermes_migration SET status='detached',updated_at=? WHERE id=? AND project_id=?").run(new Date().toISOString(),row.id,this.config.project.id);
      return this.view(this.get(row.id));
    });
  }
}
