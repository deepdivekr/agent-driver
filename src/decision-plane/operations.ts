import {type DecisionCatalog,type DecisionJudgment,catalogHash,decisionHash} from './contracts.js';
import {type CalibrationExample} from './calibration.js';
import {type DecisionJournalAudit,type DecisionLabel} from './journal.js';

export interface DecisionDatasetExample extends CalibrationExample {
  event_id:string;question_id:string;primitive:DecisionJudgment['primitive'];split:'train'|'holdout';
  evidence_level:'fixture'|'user_environment';provider:string;model:string;
}
export interface DecisionOperationsReport {
  format:1;catalog_id:string;catalog_sha256:string;model:string;events:number;judgments:number;
  provider:{accepted:number;unavailable:number;invalid:number;latency_ms:{p50:number|null;p95:number|null}};
  labels:{all:number;valid:number;train:number;holdout:number;audit:number;unassigned:number};
  journal_errors:{code:string;key:string}[];excluded:{catalog_drift:number;model_drift:number;unlabeled:number;invalid_strength:number};
  by_decision:Record<string,{observed:number;accepted:number;review:number;no_match:number;shadow_only:number;invalid_or_unavailable:number;coverage:number;shadow_samples:number;shadow_disagreements:number;labeled:number;correct:number;precision:number|null;high_certainty_errors:number}>;
  dataset_sha256:string;dataset_evidence:'fixture'|'user_environment'|'mixed'|'none';
}

function percentile(values:number[],fraction:number){if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.min(sorted.length-1,Math.floor((sorted.length-1)*fraction))]!;}
/** Strength is a certainty statistic, never permission: Choice/Score use the weaker returned gate and Noul uses distance from 0.5. */
export function judgmentStrength(judgment:DecisionJudgment){
  if(judgment.primitive==='noul')return typeof judgment.value==='number'?Math.min(1,Math.max(0,2*Math.abs(judgment.value-.5))):null;
  return judgment.confidence===null||judgment.selected_probability===null?null:Math.min(judgment.confidence,judgment.selected_probability);
}

export function buildDecisionDataset(catalog:DecisionCatalog,model:string,audit:DecisionJournalAudit){
  const expectedCatalog=catalogHash(catalog),events=new Map(audit.events.map(event=>[event.event_id,event])),examples:DecisionDatasetExample[]=[];
  let catalogDrift=0,modelDrift=0,invalidStrength=0;
  for(const label of audit.valid_labels){
    if(label.split!=='train'&&label.split!=='holdout')continue;const event=events.get(label.event_id)!;
    if(event.catalog_sha256!==expectedCatalog){catalogDrift++;continue;}if(event.profile_model!==model){modelDrift++;continue;}
    const judgment=event.judgments.find(item=>item.question_id===label.question_id&&item.decision_id===label.decision_id)!,strength=judgmentStrength(judgment);
    if(strength===null){invalidStrength++;continue;}
    examples.push({id:`${label.event_id}:${label.question_id}`,event_id:label.event_id,question_id:label.question_id,decision_id:label.decision_id,primitive:judgment.primitive,strength,correct:label.correct,split:label.split,evidence_level:label.evidence_level,provider:event.primary.provider,model:event.primary.model});
  }
  const evidence=new Set(examples.map(item=>item.evidence_level)),dataset_evidence:'fixture'|'user_environment'|'mixed'|'none'=evidence.size===0?'none':evidence.size===1?[...evidence][0]!:'mixed';
  return {examples,dataset_sha256:decisionHash(examples),dataset_evidence,excluded:{catalog_drift:catalogDrift,model_drift:modelDrift,invalid_strength:invalidStrength}};
}

export function decisionOperationsReport(catalog:DecisionCatalog,model:string,audit:DecisionJournalAudit):DecisionOperationsReport{
  const dataset=buildDecisionDataset(catalog,model,audit),expectedCatalog=catalogHash(catalog),relevant=audit.events.filter(event=>event.catalog_sha256===expectedCatalog&&event.profile_model===model),labeledKeys=new Set(audit.valid_labels.map(label=>`${label.event_id}:${label.question_id}`));
  const base=()=>({observed:0,accepted:0,review:0,no_match:0,shadow_only:0,invalid_or_unavailable:0,coverage:0,shadow_samples:0,shadow_disagreements:0,labeled:0,correct:0,precision:null as number|null,high_certainty_errors:0}),by_decision=Object.fromEntries(catalog.judgments.map(item=>[item.id,base()]));
  for(const event of relevant)for(const judgment of event.judgments){const row=by_decision[judgment.decision_id];if(!row)continue;row.observed++;if(judgment.status==='accepted')row.accepted++;else if(judgment.status==='review')row.review++;else if(judgment.status==='no_match')row.no_match++;else if(judgment.status==='shadow_only')row.shadow_only++;else row.invalid_or_unavailable++;if(event.shadow.sampled)row.shadow_samples++;if(event.shadow.disagreements.includes(judgment.question_id))row.shadow_disagreements++;}
  for(const example of dataset.examples){const row=by_decision[example.decision_id]!;row.labeled++;if(example.correct)row.correct++;if(!example.correct&&example.strength>=.9)row.high_certainty_errors++;}
  for(const row of Object.values(by_decision)){row.coverage=row.observed?row.accepted/row.observed:0;row.precision=row.labeled?row.correct/row.labeled:null;}
  const labels=(split:DecisionLabel['split'])=>audit.valid_labels.filter(label=>label.split===split).length,latencies=relevant.map(event=>event.primary.elapsed_ms);
  return {format:1,catalog_id:catalog.id,catalog_sha256:expectedCatalog,model,events:relevant.length,judgments:relevant.reduce((sum,event)=>sum+event.judgments.length,0),provider:{accepted:relevant.filter(event=>event.primary.status==='accepted').length,unavailable:relevant.filter(event=>event.primary.status==='unavailable').length,invalid:relevant.filter(event=>event.primary.status==='invalid').length,latency_ms:{p50:percentile(latencies,.5),p95:percentile(latencies,.95)}},labels:{all:audit.labels.length,valid:audit.valid_labels.length,train:labels('train'),holdout:labels('holdout'),audit:labels('audit'),unassigned:labels('unassigned')},journal_errors:audit.errors,excluded:{...dataset.excluded,unlabeled:relevant.reduce((sum,event)=>sum+event.judgments.filter(item=>!labeledKeys.has(`${event.event_id}:${item.question_id}`)).length,0)},by_decision,dataset_sha256:dataset.dataset_sha256,dataset_evidence:dataset.dataset_evidence};
}
