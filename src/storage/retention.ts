import {constants,openSync,closeSync,lstatSync,renameSync,unlinkSync,fsyncSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig,type HostConfig} from '../interface/config.js';
import {processIdentitySync,type ProcessIdentity} from '../supervisor/identity.js';
import {type TerminalStore} from '../terminal/store.js';
import {captureArtifact,withArtifactDirectory,type ArtifactManifest} from './artifacts.js';

interface Artifact {id:string;project_id:string;session_id:string;generation:number;kind:string;manifest_json:string;created_at:string;state:'retained'|'pruning'|'pruned'}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
const missing=(e:unknown)=>(e as NodeJS.ErrnoException).code==='ENOENT';
export type RetentionCut=(stage:'journaled'|'quarantined'|'unlinked',artifact:string)=>void;

/** Deletes only registered output copies. Journals, effects, task history and user worktrees are never pruned. */
export class StorageRetention {
  constructor(private readonly db:DatabaseSync,private readonly transaction:<T>(fn:()=>T)=>T,private readonly store:TerminalStore,private readonly config:HostConfig){}
  private fresh(){
    requireCondition(this.config.storage,'STORAGE_UNCONFIGURED');
    requireCondition(loadHostConfig(this.config.path).fingerprint===this.config.fingerprint,'CONFIG_CHANGED');
    const status=this.store.storage(this.config).status();requireCondition(status.status!=='unavailable','STORAGE_UNOBSERVED');
  }
  private manifest(row:Artifact){
    const m=JSON.parse(row.manifest_json) as ArtifactManifest;
    requireCondition(/^[a-f0-9]{64}$/.test(row.id)&&/^[a-zA-Z0-9-]{1,128}$/.test(row.session_id),'STORAGE_ARTIFACT_SCOPE');
    requireCondition(row.kind==='spool'&&m.directory==='terminal-spool'&&(m.filename===`${row.session_id}.jsonl`||new RegExp(`^${row.session_id}-[0-9]+\\.jsonl$`).test(m.filename))||row.kind==='handoff'&&m.directory==='terminal-handoffs'&&new RegExp(`^${row.session_id}-[a-f0-9]{64}\\.json$`).test(m.filename),'STORAGE_ARTIFACT_SCOPE');
    requireCondition(Number.isSafeInteger(m.bytes)&&m.bytes>=0&&m.bytes<=16777216&&/^[a-f0-9]{64}$/.test(m.sha256),'STORAGE_ARTIFACT_MANIFEST');
    return m;
  }
  private eligible(row:Artifact){
    const s=this.store.session(row.session_id);
    requireCondition(s.project_id===this.config.project.id&&row.project_id===s.project_id&&row.generation<=s.generation,'STORAGE_ARTIFACT_SCOPE');
    requireCondition(['session_closed','process_exited'].includes(s.state)&&!s.active_turn_id&&!s.resume_requested,'STORAGE_SESSION_ACTIVE');
    requireCondition(this.store.task(s.task_id).status!=='reconciliation_required','STORAGE_EFFECT_UNCERTAIN');
    requireCondition(!this.db.prepare("SELECT id FROM terminal_turn WHERE session_id=? AND status NOT IN ('turn_completed','cancelled')").get(s.id),'STORAGE_TURN_UNRESOLVED');
    requireCondition(!this.db.prepare("SELECT id FROM terminal_file_intent WHERE session_id=? AND status IN ('intent','uncertain')").get(s.id),'STORAGE_EFFECT_UNCERTAIN');
    requireCondition(!this.db.prepare('SELECT id FROM terminal_tool_call WHERE session_id=? AND observed=0').get(s.id),'STORAGE_TOOL_UNOBSERVED');
    requireCondition(!this.store.pendingVerification(s.worktree),'STORAGE_VERIFIER_PENDING');
    if(s.process_identity_json){
      const identity=JSON.parse(s.process_identity_json) as ProcessIdentity,actual=processIdentitySync(identity.pid);
      requireCondition(actual==='dead'||typeof actual!=='string'&&!equal(actual,identity),'STORAGE_PROCESS_ALIVE_OR_UNKNOWN');
    }else requireCondition(s.state==='session_closed'&&s.error_code==='STOPPED_BEFORE_START','STORAGE_PROCESS_UNOBSERVED');
    const activity=this.db.prepare("SELECT MAX(created_at) AS at FROM event WHERE task_id=? AND kind NOT LIKE 'storage.%'").get(s.task_id)?.at;
    const last=Math.max(Date.parse(String(activity??s.created_at)),Date.parse(row.created_at));
    requireCondition(Number.isFinite(last)&&last<=Date.now()-this.config.storage!.retention_days*86400000,'STORAGE_RETENTION_NOT_EXPIRED');
    return {session_generation:s.generation,revision:this.store.revision(s.id)};
  }
  private inspect(row:Artifact,fn?:(dir:number,source:string,quarantine:string,location:'source'|'quarantine'|'missing')=>void){
    const m=this.manifest(row);
    return withArtifactDirectory(this.config.dbPath,m.directory,(dir,rootIdentity,directoryIdentity)=>{
      requireCondition(rootIdentity===m.root_identity&&directoryIdentity===m.directory_identity,'STORAGE_ARTIFACT_PARENT_CHANGED');
      const source=`/proc/self/fd/${dir}/${m.filename}`,quarantine=`/proc/self/fd/${dir}/.prune-${row.id}`;
      const observe=(path:string)=>{let fd:number;try{fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}catch(e){if(missing(e))return null;throw e;}
        try{const actual=captureArtifact(fd,m.directory,m.filename,rootIdentity,directoryIdentity);requireCondition(equal(actual,m),'STORAGE_ARTIFACT_CHANGED');return actual;}finally{closeSync(fd);}};
      const original=observe(source),moved=observe(quarantine);
      requireCondition(!(original&&moved),'STORAGE_QUARANTINE_CONFLICT');
      requireCondition(row.state==='pruning'||original&&!moved,'STORAGE_ARTIFACT_MISSING');
      const location=original?'source':moved?'quarantine':'missing';fn?.(dir,source,quarantine,location);return location;
    });
  }
  plan(){
    this.fresh();
    const rows=this.db.prepare("SELECT * FROM storage_artifact WHERE project_id=? AND state!='pruned' ORDER BY id LIMIT 10001").all(this.config.project.id) as unknown as Artifact[];
    requireCondition(rows.length<=10000,'STORAGE_ARTIFACT_SCAN_LIMIT');
    const candidates:Array<{id:string;session_ref:string;session_generation:number;revision:number;manifest_sha256:string;state:string;location:string;bytes:number}>=[],protectedArtifacts:Array<{id:string;reason:string}>=[];
    let batchLimited=false,protectedCount=0;
    for(const row of rows){
      if(candidates.length===200){batchLimited=true;break;}
      try{const state=this.eligible(row),location=this.inspect(row);candidates.push({id:row.id,session_ref:row.session_id,...state,manifest_sha256:hash(row.manifest_json),state:row.state,location,bytes:this.manifest(row).bytes});}
      catch(e){protectedCount++;const reason=(e as Error).message;if(protectedArtifacts.length<200)protectedArtifacts.push({id:row.id,reason:/^STORAGE_[A-Z_]+$/.test(reason)?reason:'STORAGE_ARTIFACT_UNOBSERVED'});}
    }
    return {plan_sha256:hash({config:this.config.fingerprint,candidates}),cleanup_enabled:this.config.storage!.cleanup_enabled,candidates,protected:protectedArtifacts,protected_count:protectedCount,batch_limited:batchLimited,
      eligible_bytes:candidates.reduce((n,r)=>n+r.bytes,0),unregistered_files:'preserved',scope:'owned_terminal_spool_and_handoff_copies_only',history_and_intents:'preserved'};
  }
  execute(expected:string,cut?:RetentionCut){
    this.fresh();requireCondition(this.config.storage!.cleanup_enabled,'STORAGE_CLEANUP_DISABLED');
    const selected=this.transaction(()=>{
      const plan=this.plan();requireCondition(plan.plan_sha256===expected,'STORAGE_PLAN_CHANGED');
      for(const candidate of plan.candidates){
        const changed=this.db.prepare("UPDATE storage_artifact SET state='pruning' WHERE id=? AND state='retained'").run(candidate.id).changes;
        if(changed){
          const artifact=this.db.prepare('SELECT * FROM storage_artifact WHERE id=?').get(candidate.id) as unknown as Artifact,m=this.manifest(artifact);
          if(artifact.kind==='spool')this.db.prepare("UPDATE terminal_spool_segment SET state='pruning' WHERE session_id=? AND filename=?").run(artifact.session_id,m.filename);
          this.store.noteStorage(artifact.session_id,'storage.prune_intent',{artifact_id:artifact.id,bytes:m.bytes,sha256:m.sha256});
        }
      }
      return plan.candidates;
    });
    // The deletion intent is durable before any rename/unlink. A full DB prevents deletion.
    for(const item of selected)cut?.('journaled',item.id);
    let removed=0,recoveredMissing=0;
    for(const item of selected)this.transaction(()=>{
      this.fresh();
      const row=this.db.prepare('SELECT * FROM storage_artifact WHERE id=? AND project_id=?').get(item.id,this.config.project.id) as unknown as Artifact;
      if(row.state==='pruned')return;
      requireCondition(row.state==='pruning','STORAGE_PLAN_CHANGED');
      const state=this.eligible(row);requireCondition(state.session_generation===item.session_generation,'STORAGE_PLAN_CHANGED');
      this.inspect(row,(dir,source,quarantine,location)=>{
        if(location==='source'){
          // The destination is runtime-private and must not exist. Unknown files are not overwritten.
          try{lstatSync(quarantine);throw Error('STORAGE_QUARANTINE_CONFLICT');}catch(e){if(!missing(e))throw e;}
          renameSync(source,quarantine);fsyncSync(dir);cut?.('quarantined',row.id);
          // Recheck the moved inode and full content before irreversible deletion.
          this.inspect(row);
        }
        if(location!=='missing'){unlinkSync(quarantine);fsyncSync(dir);removed++;cut?.('unlinked',row.id);}else recoveredMissing++;
      });
      const m=this.manifest(row);
      this.db.prepare("UPDATE storage_artifact SET state='pruned',pruned_at=? WHERE id=?").run(new Date().toISOString(),row.id);
      if(row.kind==='spool')this.db.prepare("UPDATE terminal_spool_segment SET state='pruned' WHERE session_id=? AND filename=?").run(row.session_id,m.filename);
      this.store.noteStorage(row.session_id,'storage.artifact_pruned',{artifact_id:row.id,kind:row.kind,bytes:m.bytes,sha256:m.sha256,history_retained:true});
    });
    return {selected:selected.length,removed,recovered_missing:recoveredMissing,history_and_intents:'preserved',next_action:'review_fresh_plan'};
  }
}
