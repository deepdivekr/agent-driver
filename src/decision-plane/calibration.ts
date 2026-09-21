import {decisionCalibrationProfileSchema,type CalibrationRule,type DecisionCalibrationProfile,type DecisionCatalog,catalogHash,decisionCatalogSchema} from './contracts.js';

export interface CalibrationExample {id:string;decision_id:string;strength:number;correct:boolean;}
export interface CalibrationObjective {target_precision:number;min_train:number;min_holdout:number;confidence_level?:.9|.95|.99;evidence_level?:'fixture'|'user_environment'|'mixed';dataset_sha256?:string;}
export interface CalibrationFit {profile:DecisionCalibrationProfile;report:Record<string,{threshold:number;train_samples:number;train_precision:number|null;holdout_samples:number;holdout_precision:number|null;holdout_precision_lower_bound:number|null;execution:'live'|'shadow_only'}>;}
const precision=(rows:CalibrationExample[])=>rows.length?rows.filter(row=>row.correct).length/rows.length:null;
function wilson(rows:CalibrationExample[],level:.9|.95|.99){if(!rows.length)return null;const z=level===.9?1.6448536269514722:level===.95?1.959963984540054:2.5758293035489004,n=rows.length,p=rows.filter(row=>row.correct).length/n,denominator=1+z*z/n,center=p+z*z/(2*n),margin=z*Math.sqrt((p*(1-p)+z*z/(4*n))/n);return Math.max(0,(center-margin)/denominator);}
function bounded(rows:CalibrationExample[]){for(const row of rows)if(!(row.id&&Number.isFinite(row.strength)&&row.strength>=0&&row.strength<=1))throw Error('INVALID_CALIBRATION_EXAMPLE');}

/** Fits each judgment independently. Training and holdout IDs must be disjoint; an underpowered head remains shadow-only. */
export function fitDecisionCalibration(catalogRaw:DecisionCatalog,model:string,train:CalibrationExample[],holdout:CalibrationExample[],objective:CalibrationObjective):CalibrationFit{
  const catalog=decisionCatalogSchema.parse(catalogRaw);bounded(train);bounded(holdout);
  const confidenceLevel=objective.confidence_level??.95;if(!(objective.target_precision>0&&objective.target_precision<=1&&Number.isInteger(objective.min_train)&&objective.min_train>0&&Number.isInteger(objective.min_holdout)&&objective.min_holdout>0&&[.9,.95,.99].includes(confidenceLevel)))throw Error('INVALID_CALIBRATION_OBJECTIVE');
  const trainIds=new Set(train.map(row=>row.id));if(holdout.some(row=>trainIds.has(row.id)))throw Error('CALIBRATION_SPLIT_LEAKAGE');
  const known=new Set(catalog.judgments.map(item=>item.id));if([...train,...holdout].some(row=>!known.has(row.decision_id)))throw Error('CALIBRATION_DECISION_UNKNOWN');
  const rules:Record<string,CalibrationRule>={},report:CalibrationFit['report']={};
  for(const definition of catalog.judgments){
    const t=train.filter(row=>row.decision_id===definition.id),h=holdout.filter(row=>row.decision_id===definition.id);
    // Never extrapolate automatic acceptance below the weakest observed training
    // strength. An all-correct dataset does not prove that confidence zero is safe.
    const candidates=[...new Set([...t.map(row=>row.strength),1])].sort((a,b)=>a-b);let threshold=1,training:CalibrationExample[]=[];
    for(const candidate of candidates){const accepted=t.filter(row=>row.strength>=candidate),value=precision(accepted);if(accepted.length>=objective.min_train&&value!==null&&value>=objective.target_precision){threshold=candidate;training=accepted;break;}}
    const held=h.filter(row=>row.strength>=threshold),trainPrecision=precision(training),holdoutPrecision=precision(held),holdoutLower=wilson(held,confidenceLevel);
    const live=training.length>=objective.min_train&&held.length>=objective.min_holdout&&trainPrecision!==null&&trainPrecision>=objective.target_precision&&holdoutPrecision!==null&&holdoutPrecision>=objective.target_precision&&holdoutLower!==null&&holdoutLower>=objective.target_precision&&definition.risk!=='irreversible';
    rules[definition.id]={decision_id:definition.id,risk:definition.risk,execution:live?'live':'shadow_only',min_confidence:threshold,min_selected_probability:threshold,noul_review_low:(1-threshold)/2,noul_review_high:1-(1-threshold)/2,source:'labeled_holdout',train_samples:training.length,holdout_samples:held.length,holdout_precision:holdoutPrecision,holdout_precision_lower_bound:holdoutLower};
    report[definition.id]={threshold,train_samples:training.length,train_precision:trainPrecision,holdout_samples:held.length,holdout_precision:holdoutPrecision,holdout_precision_lower_bound:holdoutLower,execution:live?'live':'shadow_only'};
  }
  const states=Object.values(rules).map(rule=>rule.execution),status=states.every(value=>value==='live')?'validated':states.every(value=>value==='shadow_only')?'shadow_only':'partial';
  return {profile:decisionCalibrationProfileSchema.parse({format:1,id:`${catalog.id}.calibrated`,version:catalog.version,catalog_sha256:catalogHash(catalog),model,status,evidence_level:objective.evidence_level??'fixture',dataset_sha256:objective.dataset_sha256??null,calibration_target_precision:objective.target_precision,calibration_confidence_level:confidenceLevel,rules}),report};
}
