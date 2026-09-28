import {decisionHash} from './contracts.js';
import {SEMANTIC_DECISION_CATALOG,SEMANTIC_BATCH_LIMIT,semanticBatch,type SemanticItem,type SemanticProviders} from './semantic.js';

export interface SemanticRegressionCase {id:string;item:SemanticItem;expected:'SUPPORTED'|'UNSUPPORTED'|'CONTRADICTED'|'KEEP'|'SKIP'|'UNKNOWN';}
/** Explicit replay only: never runs a model in background hooks or mutates calibration. */
export async function replaySemanticCases(cases:SemanticRegressionCase[],providers:SemanticProviders,evidenceLevel:'contract_fake'|'user_environment'){
  if(!cases.length||cases.length>200||new Set(cases.map(item=>item.id)).size!==cases.length)throw Error('SEMANTIC_REGRESSION_CASES_INVALID');
  const results=[];
  for(let offset=0;offset<cases.length;offset+=SEMANTIC_BATCH_LIMIT){
    const batch=cases.slice(offset,offset+SEMANTIC_BATCH_LIMIT),actual=await semanticBatch(batch.map((value,index)=>({...value.item,id:`case_${offset+index}`})),providers,`regression:${decisionHash(cases)}:${offset}`);
    for(const [index,value]of batch.entries()){
      const answer=actual[index]!,unavailable=answer.decider==='none'&&['NOT_CONFIGURED','PROVIDER_UNAVAILABLE','LLM_CORRECTION_UNAVAILABLE'].includes(answer.reason??'');
      const invalid=answer.decider==='none'&&['INVALID_TYPED_ANSWER','LLM_CORRECTION_INVALID'].includes(answer.reason??'');
      results.push({id:value.id,input_sha256:decisionHash(value.item),expected:value.expected,actual:answer.value,status:unavailable?'BLOCKED_ENV' as const:!invalid&&answer.value===value.expected?'PASS' as const:'FAIL' as const,decision_event_id:answer.decision_event_id,confidence:answer.confidence,selected_probability:answer.selected_probability,decider:answer.decider,reason:answer.reason});
    }
  }
  const failed=results.filter(item=>item.status==='FAIL').length,blocked=results.filter(item=>item.status==='BLOCKED_ENV').length;
  return {format:1 as const,evidence_level:evidenceLevel,catalog_sha256:decisionHash(SEMANTIC_DECISION_CATALOG),dataset_sha256:decisionHash(cases),status:failed?'FAIL' as const:blocked?'BLOCKED_ENV' as const:'PASS' as const,results,calibration_changed:false,execution_authority:false,live_accuracy:evidenceLevel==='user_environment'?'limited_to_this_labeled_replay' as const:'unmeasured' as const};
}
