import {z} from 'zod';
import {decisionHash} from '../decision-plane/contracts.js';
import {semanticBatch,SEMANTIC_BATCH_LIMIT,type SemanticItem,type SemanticProviders,type SemanticResult} from '../decision-plane/semantic.js';
import {type Row} from './contracts.js';

const field=z.string().min(1).max(120).refine(value=>!['__proto__','constructor','prototype'].includes(value));
const common={id:z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u),source_field:field};
export const evidenceCheckSchema=z.discriminatedUnion('kind',[
  z.object({...common,kind:z.literal('citation'),claim_field:field,quote_field:field}).strict(),
  z.object({...common,kind:z.literal('extraction'),value_field:field,quote_field:field,meaning:z.string().trim().min(1).max(800)}).strict(),
  z.object({...common,kind:z.literal('literal_copy'),value_field:field}).strict(),
]);
export const evidenceChecksSchema=z.array(evidenceCheckSchema).min(1).max(4).refine(value=>new Set(value.map(item=>item.id)).size===value.length,'Duplicate evidence check');
export type EvidenceCheck=z.infer<typeof evidenceCheckSchema>;
export interface EvidenceReceipt {row_sha256:string;check_id:string;kind:EvidenceCheck['kind'];source_sha256:string|null;quote_present:boolean|null;status:'supported'|'unsupported'|'contradicted'|'quote_missing'|'literal_match'|'literal_missing'|'unobserved'|'review';semantic_verified:boolean;decision:SemanticResult|null;reason:string|null;}
export interface EvidenceReport {scope:'supplied_source_snapshot';all_checks_passed:boolean;semantic_accuracy:'unmeasured';originals_modified:false;receipts:EvidenceReceipt[];}

/** Values are checked, not rewritten. Literal presence is deliberately not semantic proof. */
export async function verifyEvidence(rows:Row[],rawChecks:EvidenceCheck[],getProviders:()=>Promise<SemanticProviders>,contextId:string,guard:()=>void=()=>{}):Promise<EvidenceReport>{
  const checks=evidenceChecksSchema.parse(rawChecks),receipts:EvidenceReceipt[]=[],pending:Array<{item:SemanticItem;receipt:EvidenceReceipt}>=[];
  if(rows.length*checks.length>200)throw Error('EVIDENCE_CHECK_LIMIT');
  for(const row of rows)for(const check of checks){
    const source=row[check.source_field],value=row[check.kind==='citation'?check.claim_field:check.value_field];
    const receipt:EvidenceReceipt={row_sha256:decisionHash(row),check_id:check.id,kind:check.kind,source_sha256:typeof source==='string'?decisionHash(source):null,quote_present:null,status:'unobserved',semantic_verified:false,decision:null,reason:'SOURCE_OR_VALUE_MISSING'};receipts.push(receipt);
    if(typeof source!=='string'||!source.trim()||value===null||value===undefined||String(value).trim()==='')continue;
    if(check.kind==='literal_copy'){
      receipt.quote_present=source.includes(String(value));receipt.status=receipt.quote_present?'literal_match':'literal_missing';receipt.reason='LITERAL_PRESENCE_ONLY';continue;
    }
    const quote=row[check.quote_field];if(typeof quote!=='string'||!quote.trim()){receipt.reason='QUOTE_UNOBSERVED';continue;}
    receipt.quote_present=source.includes(quote);
    if(!receipt.quote_present){receipt.status='quote_missing';receipt.reason='EXACT_QUOTE_NOT_IN_SUPPLIED_SOURCE';continue;}
    if(source.length>16000||String(value).length>4000){receipt.status='review';receipt.reason='SEMANTIC_INPUT_LIMIT';continue;}
    receipt.status='review';receipt.reason='SEMANTIC_UNOBSERVED';
    pending.push({receipt,item:{id:`evidence_${receipts.length-1}`,decision_id:check.kind==='citation'?'citation.support':'extraction.support',source,subject:String(value),quote,question:check.kind==='citation'?'Does the supplied source context support the subject claim? An exact quote match alone is not enough.':`Does the subject value express this field meaning in the source, with the correct entity, time and units: ${check.meaning}`}});
  }
  for(let offset=0;offset<pending.length;offset+=SEMANTIC_BATCH_LIMIT){
    guard();const batch=pending.slice(offset,offset+SEMANTIC_BATCH_LIMIT),providers=await getProviders();guard();
    const decisions=await semanticBatch(batch.map(item=>item.item),providers,`${contextId}:evidence:${offset}`);guard();
    for(const [index,entry]of batch.entries()){
      const result=decisions[index]!;entry.receipt.decision=result;entry.receipt.reason=result.reason;
      entry.receipt.status=result.value==='SUPPORTED'?'supported':result.value==='UNSUPPORTED'?'unsupported':result.value==='CONTRADICTED'?'contradicted':'review';
      entry.receipt.semantic_verified=result.value==='SUPPORTED';
    }
  }
  return {scope:'supplied_source_snapshot',all_checks_passed:rows.length>0&&receipts.every(item=>['supported','literal_match'].includes(item.status)),semantic_accuracy:'unmeasured',originals_modified:false,receipts};
}
