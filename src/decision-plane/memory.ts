import {randomUUID} from 'node:crypto';
import {type DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {decisionHash,stableJson} from './contracts.js';

const hash=z.string().regex(/^[a-f0-9]{64}$/u);
const key=z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u);
const featuresSchema=z.record(key,z.union([z.boolean(),z.number().finite(),z.null()])).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=48);
const valueSchema=z.union([z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/u),z.number().finite(),z.boolean(),z.null()]);
const answerSchema=z.record(key,valueSchema).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=16);
const bindingSchema=z.object({project_id:z.string().min(1).max(160),pack_sha256:hash,catalog_sha256:hash,question_sha256:hash,profile_sha256:hash,provider:z.string().min(1).max(128),requested_model:z.string().min(1).max(128),contract_version:z.literal('verified-memory-v1')}).strict();
export type DecisionMemoryBinding=z.infer<typeof bindingSchema>;
export type DecisionFeatures=z.infer<typeof featuresSchema>;
export type DecisionAnswers=z.infer<typeof answerSchema>;
export interface DecisionMemoryExample {id:string;features:DecisionFeatures;verified_answer:DecisionAnswers;model:string;verified_at_ms:number;}
type Stored={id:string;project_id:string;scope_hash:string;run_hash:string;event_id:string;model:string;features:string;feature_hash:string;proposed:string;status:'candidate'|'verified'|'rejected'|'revoked';receipt_hash:string|null;created_ms:number;verified_ms:number|null;expires_ms:number;};
export const DECISION_MEMORY_TTL_MS=7*24*60*60*1000;

/** Private, bounded references, not model training, a result cache, or execution authority.
 * Producers may only supply code-extracted boolean/numeric features and typed answers.
 * The LLM's proposal alone never becomes a verified example. */
export class DecisionMemory {
  constructor(readonly db:DatabaseSync){db.exec(`
    CREATE TABLE IF NOT EXISTS decision_memory(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,scope_hash TEXT NOT NULL,run_hash TEXT NOT NULL,event_id TEXT NOT NULL,model TEXT NOT NULL,features TEXT NOT NULL,feature_hash TEXT NOT NULL,proposed TEXT NOT NULL,status TEXT NOT NULL,receipt_hash TEXT,created_ms INTEGER NOT NULL,verified_ms INTEGER,expires_ms INTEGER NOT NULL,UNIQUE(project_id,scope_hash,event_id));
    CREATE INDEX IF NOT EXISTS decision_memory_scope ON decision_memory(project_id,scope_hash,status,created_ms);
    CREATE TABLE IF NOT EXISTS decision_memory_audit(id INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL,memory_id TEXT NOT NULL,kind TEXT NOT NULL,created_ms INTEGER NOT NULL);
  `);}
  scope(binding:DecisionMemoryBinding){return decisionHash(bindingSchema.parse(binding));}
  propose(binding:DecisionMemoryBinding,input:{run_id:string;event_id:string;model:string;features:DecisionFeatures;answer:DecisionAnswers},now=Date.now()){
    return this.atomic(()=>this.proposeLocked(binding,input,now));
  }
  private proposeLocked(binding:DecisionMemoryBinding,input:{run_id:string;event_id:string;model:string;features:DecisionFeatures;answer:DecisionAnswers},now:number){
    const scope=this.scope(binding),features=featuresSchema.parse(input.features),answer=answerSchema.parse(input.answer);
    z.string().uuid().parse(input.event_id);z.string().min(1).max(128).parse(input.model);
    const existing=this.db.prepare('SELECT * FROM decision_memory WHERE project_id=? AND scope_hash=? AND event_id=?').get(binding.project_id,scope,input.event_id) as Stored|undefined;
    if(existing){
      if(existing.run_hash!==decisionHash(input.run_id)||existing.model!==input.model||existing.features!==stableJson(features)||existing.proposed!==stableJson(answer))throw Error('DECISION_MEMORY_EVENT_CONFLICT');
      return existing.id;
    }
    const projectCount=this.db.prepare('SELECT COUNT(*) AS n FROM decision_memory WHERE project_id=?').get(binding.project_id);
    if(Number(projectCount?.n??0)>=10000)throw Error('DECISION_MEMORY_PROJECT_FULL');
    const count=this.db.prepare('SELECT COUNT(*) AS n FROM decision_memory WHERE project_id=? AND scope_hash=? AND expires_ms>?').get(binding.project_id,scope,now);
    if(Number(count?.n??0)>=512)throw Error('DECISION_MEMORY_SCOPE_FULL');
    const id=randomUUID();this.db.prepare('INSERT INTO decision_memory VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,binding.project_id,scope,decisionHash(input.run_id),input.event_id,input.model,stableJson(features),decisionHash(features),stableJson(answer),'candidate',null,now,null,now+DECISION_MEMORY_TTL_MS);
    this.audit(binding.project_id,id,'candidate_saved',now);return id;
  }
  /** Called by a code-owned outcome verifier, never by an MCP/model tool. */
  verify(binding:DecisionMemoryBinding,id:string,proof:{features:DecisionFeatures;expected:DecisionAnswers;receipt_sha256:string},now=Date.now()){
    return this.atomic(()=>this.verifyLocked(binding,id,proof,now));
  }
  private verifyLocked(binding:DecisionMemoryBinding,id:string,proof:{features:DecisionFeatures;expected:DecisionAnswers;receipt_sha256:string},now:number){
    const scope=this.scope(binding),row=this.db.prepare('SELECT * FROM decision_memory WHERE id=? AND project_id=? AND scope_hash=?').get(id,binding.project_id,scope) as Stored|undefined;
    if(!row||row.status!=='candidate'||row.expires_ms<=now)throw Error('DECISION_MEMORY_CANDIDATE_UNAVAILABLE');
    const features=featuresSchema.parse(proof.features),expected=answerSchema.parse(proof.expected);hash.parse(proof.receipt_sha256);
    if(row.feature_hash!==decisionHash(features))throw Error('DECISION_MEMORY_PROOF_MISMATCH');
    const correct=row.proposed===stableJson(expected),conflict=this.db.prepare("SELECT id FROM decision_memory WHERE project_id=? AND scope_hash=? AND model=? AND feature_hash=? AND status='verified' AND proposed<>? AND expires_ms>?").all(binding.project_id,scope,row.model,row.feature_hash,stableJson(expected),now);
    if(conflict.length){this.db.prepare("UPDATE decision_memory SET status='revoked' WHERE project_id=? AND scope_hash=? AND model=? AND feature_hash=? AND status='verified'").run(binding.project_id,scope,row.model,row.feature_hash);for(const old of conflict)this.audit(binding.project_id,String(old.id),'conflicting_outcome',now);}
    const status=correct&&!conflict.length?'verified':'rejected';
    this.db.prepare('UPDATE decision_memory SET status=?,receipt_hash=?,verified_ms=? WHERE id=?').run(status,proof.receipt_sha256,now,id);this.audit(binding.project_id,id,status,now);return {status,correct};
  }
  examples(binding:DecisionMemoryBinding,runId:string,features:DecisionFeatures,now=Date.now()):DecisionMemoryExample[]{
    const scope=this.scope(binding),featureHash=decisionHash(featuresSchema.parse(features));
    const rows=this.db.prepare("SELECT * FROM decision_memory WHERE project_id=? AND scope_hash=? AND run_hash<>? AND status='verified' AND expires_ms>? ORDER BY (feature_hash=?) DESC,verified_ms DESC,id LIMIT 128").all(binding.project_id,scope,decisionHash(runId),now,featureHash) as unknown as Stored[];
    const seen=new Set<string>(),result:DecisionMemoryExample[]=[];
    for(const row of rows){const identity=`${row.model}:${row.feature_hash}:${row.proposed}`;if(seen.has(identity))continue;seen.add(identity);result.push({id:row.id,features:featuresSchema.parse(JSON.parse(row.features)),verified_answer:answerSchema.parse(JSON.parse(row.proposed)),model:row.model,verified_at_ms:row.verified_ms!});if(result.length===3)break;}
    return result;
  }
  revoke(binding:DecisionMemoryBinding,ids:string[],reason:'model_changed'|'audit_mismatch',now=Date.now()){
    for(const id of ids){z.string().uuid().parse(id);const result=this.db.prepare("UPDATE decision_memory SET status='revoked' WHERE project_id=? AND scope_hash=? AND id=? AND status='verified'").run(binding.project_id,this.scope(binding),id);if(Number(result.changes))this.audit(binding.project_id,id,reason,now);}
  }
  summary(project:string,now=Date.now()){
    const statuses=this.db.prepare('SELECT status,COUNT(*) AS n FROM decision_memory WHERE project_id=? AND expires_ms>? GROUP BY status').all(project,now);
    return {candidate:Number(statuses.find(x=>x.status==='candidate')?.n??0),verified:Number(statuses.find(x=>x.status==='verified')?.n??0),rejected:Number(statuses.find(x=>x.status==='rejected')?.n??0),revoked:Number(statuses.find(x=>x.status==='revoked')?.n??0),expires_after_ms:DECISION_MEMORY_TTL_MS,raw_examples_exposed:false,model_training:false,thresholds_automatically_changed:false};
  }
  private audit(project:string,id:string,kind:string,now:number){this.db.prepare('INSERT INTO decision_memory_audit(project_id,memory_id,kind,created_ms) VALUES (?,?,?,?)').run(project,id,kind,now);}
  private atomic<T>(operation:()=>T):T{
    const savepoint=`memory_${randomUUID().replaceAll('-','')}`;this.db.exec(`SAVEPOINT ${savepoint}`);
    try{const value=operation();this.db.exec(`RELEASE ${savepoint}`);return value;}catch(error){this.db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);throw error;}
  }
}
