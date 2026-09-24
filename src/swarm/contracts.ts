import {z} from 'zod';

export const SWARM_ENGINE_VERSION='swarm_mode_v1';
export const MAX_SWARM_WORKERS=300;
export const MAX_SWARM_CONCURRENCY=32;
export const STANDARD_SWARM_DEFAULTS={
  target_wall_ms:180_000,
  hard_deadline_ms:240_000,
  max_workers:24,
  min_workers:8,
  min_source_workers:6,
  max_concurrency:16,
  worker_timeout_ms:75_000,
  synthesis_reserve_ms:35_000,
  max_sources_per_worker:2,
} as const;
const id=z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u);
const sentence=z.string().trim().min(1).max(2000);

export const swarmResearchModeSchema=z.literal('standard');
export type SwarmResearchMode=z.infer<typeof swarmResearchModeSchema>;
export const swarmWorkerStageSchema=z.enum(['discovery','source_read','verification','reduction','synthesis']);

export const swarmEffectSchema=z.enum(['read_only','local_write','external_effect','irreversible']);
export const swarmWorkerSchema=z.object({
  id,
  role:sentence.max(160),
  objective:sentence,
  stage:swarmWorkerStageSchema.default('discovery'),
  source_urls:z.array(z.string().url().max(2000)).max(32).default([]),
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
  research_mode:swarmResearchModeSchema.nullable().default(null),
  execution_profile:z.object({
    target_wall_ms:z.number().int().min(1_000).max(3_600_000),
    hard_deadline_ms:z.number().int().min(1_000).max(3_600_000),
    worker_timeout_ms:z.number().int().min(1_000).max(3_600_000),
    synthesis_reserve_ms:z.number().int().min(1_000).max(900_000),
    max_sources_per_worker:z.number().int().min(1).max(32),
  }).strict().nullable().default(null),
  created_at:z.string().datetime({offset:true}),
  execution_authority:z.literal(false),
  approval_granted:z.literal(false),
}).strict();
export type SwarmPlan=z.infer<typeof swarmPlanSchema>;

export const standardSwarmPolicySchema=z.object({
  target_wall_ms:z.number().int().min(60_000).max(900_000).default(STANDARD_SWARM_DEFAULTS.target_wall_ms),
  hard_deadline_ms:z.number().int().min(60_000).max(900_000).default(STANDARD_SWARM_DEFAULTS.hard_deadline_ms),
  max_workers:z.number().int().min(STANDARD_SWARM_DEFAULTS.min_workers).max(STANDARD_SWARM_DEFAULTS.max_workers).default(STANDARD_SWARM_DEFAULTS.max_workers),
  max_concurrency:z.number().int().min(1).max(STANDARD_SWARM_DEFAULTS.max_concurrency).default(STANDARD_SWARM_DEFAULTS.max_concurrency),
  worker_timeout_ms:z.number().int().min(5_000).max(180_000).default(STANDARD_SWARM_DEFAULTS.worker_timeout_ms),
  synthesis_reserve_ms:z.number().int().min(5_000).max(120_000).default(STANDARD_SWARM_DEFAULTS.synthesis_reserve_ms),
  max_sources_per_worker:z.number().int().min(1).max(STANDARD_SWARM_DEFAULTS.max_sources_per_worker).default(STANDARD_SWARM_DEFAULTS.max_sources_per_worker),
}).strict().superRefine((value,context)=>{
  if(value.target_wall_ms>value.hard_deadline_ms)context.addIssue({code:'custom',message:'standard target exceeds hard deadline'});
  if(value.synthesis_reserve_ms>=value.hard_deadline_ms)context.addIssue({code:'custom',message:'standard synthesis reserve exceeds hard deadline'});
  if(value.max_concurrency>value.max_workers)context.addIssue({code:'custom',message:'standard concurrency exceeds workers'});
});

export const swarmPolicySchema=z.object({
  enabled:z.boolean().default(false),
  model_data_approved:z.boolean().default(false),
  max_logical_workers:z.number().int().min(2).max(MAX_SWARM_WORKERS).default(64),
  max_concurrency:z.number().int().min(1).max(MAX_SWARM_CONCURRENCY).default(8),
  lease_ms:z.number().int().min(5_000).max(900_000).default(120_000),
  default_mode:swarmResearchModeSchema.default('standard'),
  visual:z.object({
    enabled:z.boolean().default(false),
    max_contexts:z.number().int().min(1).max(MAX_SWARM_CONCURRENCY).default(16),
    frame_interval_ms:z.number().int().min(500).max(5000).default(1000),
    owned_vm:z.object({id:z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u),storage_root:z.string().min(1),devtools_port:z.number().int().min(1024).max(65535),vnc_port:z.number().int().min(1024).max(65535)}).strict().optional(),
  }).strict().default({enabled:false,max_contexts:16,frame_interval_ms:1000}),
  standard:standardSwarmPolicySchema.default({
    target_wall_ms:STANDARD_SWARM_DEFAULTS.target_wall_ms,
    hard_deadline_ms:STANDARD_SWARM_DEFAULTS.hard_deadline_ms,
    max_workers:STANDARD_SWARM_DEFAULTS.max_workers,
    max_concurrency:STANDARD_SWARM_DEFAULTS.max_concurrency,
    worker_timeout_ms:STANDARD_SWARM_DEFAULTS.worker_timeout_ms,
    synthesis_reserve_ms:STANDARD_SWARM_DEFAULTS.synthesis_reserve_ms,
    max_sources_per_worker:STANDARD_SWARM_DEFAULTS.max_sources_per_worker,
  }),
}).strict().superRefine((value,context)=>{
  if(value.enabled&&!value.model_data_approved)context.addIssue({code:'custom',message:'swarm LLM planning requires model data approval'});
  if(value.max_concurrency>value.max_logical_workers)context.addIssue({code:'custom',message:'swarm concurrency exceeds logical workers'});
});
export type SwarmPolicy=z.infer<typeof swarmPolicySchema>;

export const swarmWorkerStatusSchema=z.enum(['pending','leased','succeeded','failed','needs_human','skipped_deadline']);
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
export const swarmEvidenceSchema=z.object({
  source_url:z.string().url().max(2000),claim:z.string().min(1).max(1000),observed_at:z.string().datetime({offset:true}),verification:z.enum(['source_reopen','cross_source','human','test']),
}).strict();
export const swarmFactCardSchema=z.object({
  claim:z.string().trim().min(1).max(2000),
  source_url:z.string().url().max(2000),
  source_type:z.enum(['official_documentation','repository','release','issue','article','social','dataset','other']),
  observed_at:z.string().datetime({offset:true}),
  evidence_excerpt:z.string().trim().min(1).max(2000),
  verification:z.enum(['source_reopen','cross_source','human','test','unverified']),
  freshness:z.enum(['current','dated','stale','unknown']),
  contradiction_refs:z.array(id).max(32).default([]),
}).strict();
export const swarmWorkerReportSchema=z.object({
  status:z.enum(['succeeded','failed','needs_human']),
  summary:z.string().min(1).max(4000),
  artifacts:z.array(swarmArtifactSchema).max(100).default([]),
  evidence:z.array(swarmEvidenceSchema).max(32).default([]),
  fact_cards:z.array(swarmFactCardSchema).max(64).default([]),
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
  quality:{score:number|null;accepted:boolean;decision_event_id:string|null;dimensions:Record<string,number|null>;required_score?:number;required_evidence?:number}|null;
}
export interface SwarmReviewItem {id:string;kind:'external_effect'|'worker_failure'|'lease_expired'|'quality'|'decision'|'replan'|'deadline';worker_id:string|null;reason:string;created_at:string;}
export interface SwarmRunSnapshot {
  auth_wait_started_at_ms?:number;
  format:1;run_id:string;request_id:string;plan:SwarmPlan;revision:number;
  status:'running'|'needs_human'|'completed'|'failed'|'partial_evidence';workers:Record<string,SwarmWorkerState>;
  mode:SwarmResearchMode|null;started_at_ms:number;target_deadline_at_ms:number|null;hard_deadline_at_ms:number|null;synthesis_reserve_ms:number;
  reviews:SwarmReviewItem[];decision_events:string[];created_at:string;updated_at:string;
  execution_authority:false;approval_granted:false;
}

export function validateSwarmPlanDraft(raw:unknown,limits:{max_workers:number;capabilities:string[];mode?:SwarmResearchMode;worker_timeout_ms?:number;max_sources_per_worker?:number}){
  const draft=swarmPlanDraftSchema.parse(raw);
  if(draft.workers.length>limits.max_workers)throw Error('SWARM_PLAN_WORKER_LIMIT');
  const ids=new Set(draft.workers.map(worker=>worker.id));
  if(ids.size!==draft.workers.length)throw Error('SWARM_PLAN_DUPLICATE_WORKER');
  const allowed=new Set(limits.capabilities);
  for(const worker of draft.workers){
    if(worker.depends_on.includes(worker.id)||worker.depends_on.some(dependency=>!ids.has(dependency)))throw Error('SWARM_PLAN_INVALID_DEPENDENCY');
    if(worker.required_capabilities.some(capability=>!allowed.has(capability)))throw Error('SWARM_PLAN_CAPABILITY_NOT_DELEGATED');
    if(limits.mode==='standard'&&worker.stage==='source_read'&&(worker.source_urls.length<1||worker.source_urls.length>(limits.max_sources_per_worker??STANDARD_SWARM_DEFAULTS.max_sources_per_worker)))throw Error('SWARM_STANDARD_SOURCE_URL_LIMIT');
  }
  const visiting=new Set<string>(),visited=new Set<string>(),byId=new Map(draft.workers.map(worker=>[worker.id,worker]));
  const visit=(workerId:string)=>{if(visiting.has(workerId))throw Error('SWARM_PLAN_CYCLE');if(visited.has(workerId))return;visiting.add(workerId);for(const dependency of byId.get(workerId)!.depends_on)visit(dependency);visiting.delete(workerId);visited.add(workerId);};
  for(const worker of draft.workers)visit(worker.id);
  if(limits.mode==='standard'){
    if(draft.workers.length<STANDARD_SWARM_DEFAULTS.min_workers)throw Error('SWARM_STANDARD_MIN_WORKERS');
    const sources=draft.workers.filter(worker=>worker.stage==='source_read');
    if(sources.length<STANDARD_SWARM_DEFAULTS.min_source_workers)throw Error('SWARM_STANDARD_MIN_SOURCE_WORKERS');
    if(draft.workers.some(worker=>worker.effect!=='read_only'))throw Error('SWARM_STANDARD_READ_ONLY_REQUIRED');
    if(!draft.workers.some(worker=>worker.stage==='reduction')||!draft.workers.some(worker=>worker.stage==='synthesis'))throw Error('SWARM_STANDARD_STAGES_REQUIRED');
    if(sources.some(worker=>worker.depends_on.length>0))throw Error('SWARM_STANDARD_SOURCE_STAGE_NOT_PARALLEL');
    if(draft.workers.some(worker=>['reduction','synthesis'].includes(worker.stage)&&worker.source_urls.length>0))throw Error('SWARM_STANDARD_REDUCER_SOURCE_FORBIDDEN');
    if(draft.workers.some(worker=>worker.timeout_ms>(limits.worker_timeout_ms??STANDARD_SWARM_DEFAULTS.worker_timeout_ms)))throw Error('SWARM_STANDARD_WORKER_TIMEOUT');
    const syntheses=draft.workers.filter(worker=>worker.stage==='synthesis');
    const ancestors=(workerId:string,seen=new Set<string>()):Set<string>=>{for(const dependency of byId.get(workerId)!.depends_on){if(!seen.has(dependency)){seen.add(dependency);ancestors(dependency,seen);}}return seen;};
    if(syntheses.some(worker=>!worker.depends_on.some(dependency=>byId.get(dependency)?.stage==='reduction')))throw Error('SWARM_STANDARD_SYNTHESIS_REDUCER_REQUIRED');
    const covered=new Set(syntheses.flatMap(worker=>[...ancestors(worker.id)]));
    if(sources.some(worker=>!covered.has(worker.id)))throw Error('SWARM_STANDARD_SOURCE_NOT_SYNTHESIZED');
  }
  return draft;
}

export const swarmTools={
  runtime_swarm_recover:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_start:{schema:z.object({request_id:id,work_id:z.string().uuid().optional(),goal:sentence.max(8000),context:z.record(z.string().max(120),z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()])).default({}),mode:swarmResearchModeSchema.default('standard')}).strict(),implemented:true,readOnly:false},
  runtime_swarm_plan:{schema:z.object({goal:sentence.max(8000),context:z.record(z.string().max(120),z.union([z.string().max(4000),z.number().finite(),z.boolean(),z.null()])).default({})}).strict(),implemented:true,readOnly:true},
  runtime_swarm_replan:{schema:z.object({run_id:z.string().uuid(),reason:sentence.max(2000)}).strict(),implemented:true,readOnly:false},
  runtime_swarm_run:{schema:z.object({request_id:id,work_id:z.string().uuid().optional(),plan_id:z.string().uuid()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_tick:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_browser:{schema:z.object({run_id:z.string().uuid(),worker_id:id,lease_token:z.string().uuid(),command:z.discriminatedUnion('action',[
    z.object({action:z.literal('navigate'),url:z.string().url().max(2000)}).strict(),
    z.object({action:z.literal('observe')}).strict(),
    z.object({action:z.literal('scroll'),direction:z.enum(['up','down'])}).strict(),
  ])}).strict(),implemented:true,readOnly:false},
  runtime_swarm_activity:{schema:z.object({run_id:z.string().uuid(),worker_id:id,lease_token:z.string().uuid(),activity:z.object({kind:z.enum(['started','navigating','observing','tool_call','checkpoint']),summary:sentence.max(500),endpoint:z.string().url().max(2000).nullable().default(null),surface_id:id.nullable().optional(),actor_id:id.nullable().optional(),decision_layer:z.enum(['llm','jev','code']).nullable().optional()}).strict()}).strict(),implemented:true,readOnly:false},
  runtime_swarm_report:{schema:z.object({run_id:z.string().uuid(),worker_id:id,lease_token:z.string().uuid(),report:swarmWorkerReportSchema}).strict(),implemented:true,readOnly:false},
  runtime_swarm_status:{schema:z.object({run_id:z.string().uuid()}).strict(),implemented:true,readOnly:true},
} as const;
