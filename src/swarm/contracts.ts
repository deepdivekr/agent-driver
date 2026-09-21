import {z} from 'zod';

export const SWARM_ENGINE_VERSION='swarm_mode_v1';
export const MAX_SWARM_WORKERS=300;
export const MAX_SWARM_CONCURRENCY=32;
const id=z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u);
const sentence=z.string().trim().min(1).max(2000);

export const swarmEffectSchema=z.enum(['read_only','local_write','external_effect','irreversible']);
export const swarmWorkerSchema=z.object({
  id,
  role:sentence.max(160),
  objective:sentence,
  executor:z.enum(['sub_agent','pack','browser','terminal']),
  depends_on:z.array(id).max(64).default([]),
  required_capabilities:z.array(id).max(32).default([]),
  effect:swarmEffectSchema,
  completion_evidence:z.array(sentence.max(500)).min(1).max(12),
  max_steps:z.number().int().min(1).max(200),
  timeout_ms:z.number().int().min(1_000).max(3_600_000),
}).strict();

export const swarmPlanDraftSchema=z.object({
  summary:sentence,
  workers:z.array(swarmWorkerSchema).min(2).max(MAX_SWARM_WORKERS),
}).strict();
export type SwarmPlanDraft=z.infer<typeof swarmPlanDraftSchema>;

export const swarmPlanSchema=swarmPlanDraftSchema.extend({
  format:z.literal(1),
  plan_id:z.string().uuid(),
  goal:sentence.max(8000),
  planner:z.object({kind:z.literal('llm'),model:z.string().min(1).max(128),input_sha256:z.string().regex(/^[a-f0-9]{64}$/u)}).strict(),
  max_concurrency:z.number().int().min(1).max(MAX_SWARM_CONCURRENCY),
  created_at:z.string().datetime({offset:true}),
  execution_authority:z.literal(false),
  approval_granted:z.literal(false),
}).strict();
export type SwarmPlan=z.infer<typeof swarmPlanSchema>;

export const swarmPolicySchema=z.object({
  enabled:z.boolean().default(false),
  model_data_approved:z.boolean().default(false),
  max_logical_workers:z.number().int().min(2).max(MAX_SWARM_WORKERS).default(64),
  max_concurrency:z.number().int().min(1).max(MAX_SWARM_CONCURRENCY).default(8),
  lease_ms:z.number().int().min(5_000).max(900_000).default(120_000),
}).strict().superRefine((value,context)=>{
  if(value.enabled&&!value.model_data_approved)context.addIssue({code:'custom',message:'swarm LLM planning requires model data approval'});
  if(value.max_concurrency>value.max_logical_workers)context.addIssue({code:'custom',message:'swarm concurrency exceeds logical workers'});
});
export type SwarmPolicy=z.infer<typeof swarmPolicySchema>;

export const swarmWorkerStatusSchema=z.enum(['pending','leased','succeeded','failed','needs_human']);
export const swarmArtifactSchema=z.object({
  kind:id,
  ref:z.string().min(1).max(1000),
  sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  summary:z.string().max(2000),
}).strict();
export const swarmReadbackSchema=z.object({
  verified:z.boolean(),
  method:z.enum(['independent_readback','test','source_reopen','human']),
  evidence_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  observed_at:z.string().datetime({offset:true}),
}).strict();
export const swarmWorkerReportSchema=z.object({
  status:z.enum(['succeeded','failed','needs_human']),
  summary:z.string().min(1).max(4000),
  artifacts:z.array(swarmArtifactSchema).max(100).default([]),
  readback:swarmReadbackSchema.nullable().default(null),
  error_code:z.string().regex(/^[A-Z][A-Z0-9_]{0,79}$/u).nullable().default(null),
}).strict().superRefine((value,context)=>{
  if(value.status==='succeeded'&&value.readback?.verified!==true)context.addIssue({code:'custom',message:'successful worker requires independent verified readback'});
  if(value.status==='failed'&&!value.error_code)context.addIssue({code:'custom',message:'failed worker requires error code'});
});
export type SwarmWorkerReport=z.infer<typeof swarmWorkerReportSchema>;

export interface SwarmWorkerState {
  id:string;status:z.infer<typeof swarmWorkerStatusSchema>;attempts:number;
  lease_token:string|null;lease_expires_at_ms:number|null;result:SwarmWorkerReport|null;
  quality:{score:number|null;accepted:boolean;decision_event_id:string|null;dimensions:Record<string,number|null>}|null;
}
export interface SwarmReviewItem {id:string;kind:'external_effect'|'worker_failure'|'lease_expired'|'quality'|'decision'|'replan';worker_id:string|null;reason:string;created_at:string;}
export interface SwarmRunSnapshot {
  format:1;run_id:string;request_id:string;plan:SwarmPlan;revision:number;
  status:'running'|'needs_human'|'completed'|'failed';workers:Record<string,SwarmWorkerState>;
  reviews:SwarmReviewItem[];decision_events:string[];created_at:string;updated_at:string;
  execution_authority:false;approval_granted:false;
}

export function validateSwarmPlanDraft(raw:unknown,limits:{max_workers:number;capabilities:string[]}){
  const draft=swarmPlanDraftSchema.parse(raw);
  if(draft.workers.length>limits.max_workers)throw Error('SWARM_PLAN_WORKER_LIMIT');
  const ids=new Set(draft.workers.map(worker=>worker.id));
  if(ids.size!==draft.workers.length)throw Error('SWARM_PLAN_DUPLICATE_WORKER');
  const allowed=new Set(limits.capabilities);
  for(const worker of draft.workers){
    if(worker.depends_on.includes(worker.id)||worker.depends_on.some(dependency=>!ids.has(dependency)))throw Error('SWARM_PLAN_INVALID_DEPENDENCY');
    if(worker.required_capabilities.some(capability=>!allowed.has(capability)))throw Error('SWARM_PLAN_CAPABILITY_NOT_DELEGATED');
  }
  const visiting=new Set<string>(),visited=new Set<string>(),byId=new Map(draft.workers.map(worker=>[worker.id,worker]));
  const visit=(workerId:string)=>{if(visiting.has(workerId))throw Error('SWARM_PLAN_CYCLE');if(visited.has(workerId))return;visiting.add(workerId);for(const dependency of byId.get(workerId)!.depends_on)visit(dependency);visiting.delete(workerId);visited.add(workerId);};
  for(const worker of draft.workers)visit(worker.id);
  return draft;
}

export const swarmTools={
  runtime_swarm_plan:{schema:z.object({goal:sentence.max(8000),context:z.record(z.string().max(120),z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()])).default({})}).strict(),implemented:true,readOnly:true},
  runtime_swarm_replan:{schema:z.object({run_id:z.string().uuid(),reason:sentence.max(2000)}).strict(),implemented:true,readOnly:false},
  runtime_swarm_run:{schema:z.object({request_id:id,plan_id:z.string().uuid()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_tick:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_report:{schema:z.object({run_id:z.string().uuid(),worker_id:id,lease_token:z.string().uuid(),report:swarmWorkerReportSchema}).strict(),implemented:true,readOnly:false},
  runtime_swarm_status:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:true},
} as const;
