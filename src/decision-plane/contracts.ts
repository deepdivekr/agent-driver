import {createHash} from 'node:crypto';
import {z} from 'zod';

const id=z.string().regex(/^[a-z][a-z0-9_.-]{0,95}$/u);
export const decisionRisk=z.enum(['informational','reversible','external_effect','irreversible']);
export const decisionPrimitive=z.enum(['choice','score','noul']);
export const judgmentDefinitionSchema=z.object({
  id,primitive:decisionPrimitive,risk:decisionRisk,
  question_version:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u),
  no_match_values:z.array(z.string().min(1).max(128)).max(8).default([]),
  fallback:z.enum(['continue_code','llm','human','hold']),
}).strict();
export const decisionCatalogSchema=z.object({
  format:z.literal(1),id,version:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u),
  judgments:z.array(judgmentDefinitionSchema).min(1).max(128),
}).strict().superRefine((value,context)=>{
  if(new Set(value.judgments.map(item=>item.id)).size!==value.judgments.length)context.addIssue({code:'custom',message:'duplicate judgment id'});
});
export type DecisionCatalog=z.infer<typeof decisionCatalogSchema>;
export type JudgmentDefinition=z.infer<typeof judgmentDefinitionSchema>;

export const calibrationRuleSchema=z.object({
  decision_id:id,risk:decisionRisk,
  execution:z.enum(['live','shadow_only']),
  min_confidence:z.number().min(0).max(1),
  min_selected_probability:z.number().min(0).max(1),
  noul_review_low:z.number().min(0).max(1).default(.4),
  noul_review_high:z.number().min(0).max(1).default(.6),
  source:z.enum(['product_default','labeled_holdout']),
  train_samples:z.number().int().nonnegative(),holdout_samples:z.number().int().nonnegative(),
  holdout_precision:z.number().min(0).max(1).nullable(),holdout_precision_lower_bound:z.number().min(0).max(1).nullable().default(null),
}).strict().superRefine((value,context)=>{
  if(value.noul_review_low>value.noul_review_high)context.addIssue({code:'custom',message:'invalid noul review band'});
});
export const decisionCalibrationProfileSchema=z.object({
  format:z.literal(1),id,version:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u),
  catalog_sha256:z.string().regex(/^[a-f0-9]{64}$/u),model:z.string().min(1).max(128),
  status:z.enum(['provisional','validated','partial','shadow_only']),
  evidence_level:z.enum(['product_default','fixture','user_environment','mixed']).default('product_default'),
  dataset_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable().default(null),
  calibration_target_precision:z.number().min(0).max(1).nullable().default(null),
  calibration_confidence_level:z.union([z.literal(.9),z.literal(.95),z.literal(.99)]).nullable().default(null),
  rules:z.record(id,calibrationRuleSchema),
}).strict();
export type DecisionCalibrationProfile=z.infer<typeof decisionCalibrationProfileSchema>;
export type CalibrationRule=z.infer<typeof calibrationRuleSchema>;

export const decisionBindingSchema=z.object({question_id:z.string().min(1).max(160),decision_id:id}).strict();
export type DecisionBinding=z.infer<typeof decisionBindingSchema>;
export type DecisionStatus='accepted'|'review'|'no_match'|'shadow_only'|'invalid'|'unavailable';
export interface DecisionJudgment {
  question_id:string;decision_id:string;primitive:z.infer<typeof decisionPrimitive>;status:DecisionStatus;
  value:string|number|boolean|null;confidence:number|null;selected_probability:number|null;
  threshold:{confidence:number;selected_probability:number;noul_review_low:number;noul_review_high:number};
  fallback:JudgmentDefinition['fallback'];risk:z.infer<typeof decisionRisk>;reason:string|null;
}
export interface DecisionProviderTrace {provider:string;model:string;elapsed_ms:number;input_sha256:string;status:'accepted'|'unavailable'|'invalid';}
export interface DecisionShadowSummary {sampled:boolean;provider:string|null;trace:DecisionProviderTrace|null;disagreements:string[];judgments:DecisionJudgment[];}
export interface DecisionEvent {
  format:1;event_id:string;occurred_at:string;catalog_id:string;catalog_version:string;catalog_sha256:string;
  profile_id:string;profile_version:string;profile_sha256:string;profile_model:string;context_id:string;state_sha256:string;request_sha256:string;
  primary:DecisionProviderTrace;judgments:DecisionJudgment[];shadow:DecisionShadowSummary;
  execution_authority:false;approval_granted:false;
}

const probability=z.number().min(0).max(1);
export const decisionJudgmentSchema:z.ZodType<DecisionJudgment>=z.object({
  question_id:z.string().min(1).max(160),decision_id:id,primitive:decisionPrimitive,
  status:z.enum(['accepted','review','no_match','shadow_only','invalid','unavailable']),
  value:z.union([z.string().max(512),z.number().finite(),z.boolean(),z.null()]),
  confidence:probability.nullable(),selected_probability:probability.nullable(),
  threshold:z.object({confidence:probability,selected_probability:probability,noul_review_low:probability,noul_review_high:probability}).strict(),
  fallback:z.enum(['continue_code','llm','human','hold']),risk:decisionRisk,reason:z.string().max(160).nullable(),
}).strict();
export const decisionProviderTraceSchema:z.ZodType<DecisionProviderTrace>=z.object({
  provider:z.string().min(1).max(128),model:z.string().min(1).max(128),elapsed_ms:z.number().int().nonnegative().max(3_600_000),
  input_sha256:z.string().regex(/^[a-f0-9]{64}$/u),status:z.enum(['accepted','unavailable','invalid']),
}).strict();
export const decisionShadowSummarySchema:z.ZodType<DecisionShadowSummary>=z.object({
  sampled:z.boolean(),provider:z.string().min(1).max(128).nullable(),trace:decisionProviderTraceSchema.nullable(),
  disagreements:z.array(z.string().min(1).max(160)).max(128),judgments:z.array(decisionJudgmentSchema).max(128),
}).strict();
export const decisionEventSchema:z.ZodType<DecisionEvent>=z.object({
  format:z.literal(1),event_id:z.string().uuid(),occurred_at:z.string().datetime({offset:true}),catalog_id:id,
  catalog_version:z.string().min(1).max(64),catalog_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  profile_id:id,profile_version:z.string().min(1).max(64),profile_sha256:z.string().regex(/^[a-f0-9]{64}$/u),profile_model:z.string().min(1).max(128),
  context_id:z.string().min(1).max(160),state_sha256:z.string().regex(/^[a-f0-9]{64}$/u),request_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  primary:decisionProviderTraceSchema,judgments:z.array(decisionJudgmentSchema).min(1).max(128),shadow:decisionShadowSummarySchema,
  execution_authority:z.literal(false),approval_granted:z.literal(false),
}).strict();

export function stableJson(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
}
export function decisionHash(value:unknown){return createHash('sha256').update(stableJson(value)).digest('hex');}
export function catalogHash(raw:DecisionCatalog){return decisionHash(decisionCatalogSchema.parse(raw));}
export function assertProfileForCatalog(raw:DecisionCalibrationProfile,catalog:DecisionCatalog){
  const profile=decisionCalibrationProfileSchema.parse(raw),parsed=decisionCatalogSchema.parse(catalog),definitions=new Map(parsed.judgments.map(item=>[item.id,item]));
  if(profile.catalog_sha256!==catalogHash(parsed))throw Error('DECISION_PROFILE_CATALOG_MISMATCH');
  if(Object.keys(profile.rules).length!==definitions.size||[...definitions].some(([key,value])=>profile.rules[key]?.decision_id!==key||profile.rules[key]?.risk!==value.risk))throw Error('DECISION_PROFILE_COVERAGE_MISMATCH');
  return profile;
}

export function provisionalProfile(catalog:DecisionCatalog,model:string,thresholds:Record<string,Partial<Pick<CalibrationRule,'min_confidence'|'min_selected_probability'|'noul_review_low'|'noul_review_high'|'execution'>>>={}):DecisionCalibrationProfile{
  const parsed=decisionCatalogSchema.parse(catalog),rules=Object.fromEntries(parsed.judgments.map(definition=>{
    const configured=thresholds[definition.id]??{};
    return [definition.id,{decision_id:definition.id,risk:definition.risk,execution:configured.execution??(['external_effect','irreversible'].includes(definition.risk)?'shadow_only':'live'),min_confidence:configured.min_confidence??.7,min_selected_probability:configured.min_selected_probability??.55,noul_review_low:configured.noul_review_low??.4,noul_review_high:configured.noul_review_high??.6,source:'product_default' as const,train_samples:0,holdout_samples:0,holdout_precision:null,holdout_precision_lower_bound:null}];
  }));
  return decisionCalibrationProfileSchema.parse({format:1,id:`${parsed.id}.provisional`,version:parsed.version,catalog_sha256:catalogHash(parsed),model,status:'provisional',evidence_level:'product_default',dataset_sha256:null,calibration_target_precision:null,calibration_confidence_level:null,rules});
}
