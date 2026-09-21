import {z} from 'zod';
import {basePackFamilyId} from '../taskpacks/base-pack-catalog.js';

export const key=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const field=z.string().min(1).max(120).refine(s=>!['__proto__','constructor','prototype'].includes(s));
export const scalar=z.union([z.string().max(16000),z.number().finite(),z.boolean(),z.null()]);
export const rowSchema=z.record(field,scalar);
export type Row=z.infer<typeof rowSchema>;
const selector=z.string().min(1).max(400);
const fields=z.record(field,z.object({selector,kind:z.enum(['text','select','checkbox'])}).strict());
const remote=z.object({url:z.string().url(),parameters:z.array(key).max(20).default([])});
export const sourceSchema=z.discriminatedUnion('kind',[
  z.object({id:key,kind:z.literal('file'),path:z.string().min(1),format:z.enum(['json','csv'])}).strict(),
  remote.extend({id:key,kind:z.literal('http'),format:z.enum(['json','csv'])}).strict(),
  remote.extend({id:key,kind:z.literal('browser'),rows:selector,columns:z.record(field,selector),ready:selector,auth_gate:selector,account_selector:selector,account_text:z.string().min(1)}).strict(),
]);
export const targetSchema=z.object({
  id:key,family:z.enum(['form.draft-submit','record.update','choose.stage']),
  action:z.enum(['submit_form','update_record','stage_cart']),url:z.string().url(),
  draft_is_local:z.literal(true),
  effect_boundary:z.enum(['single_form_submission','allowlisted_field_update','cart_or_draft_only']),
  ready:selector,auth_gate:selector,account_selector:selector,account_text:z.string().min(1),
  fields,identity_field:field,submit:selector,readback_url:z.string().url(),identity_parameter:key,
  // Host-reviewed benign dismissals only; unknown or security dialogs hold.
  known_popups:z.array(z.object({id:key,dialog:selector,dismiss:selector}).strict()).max(20).default([]),
}).strict().superRefine((v,c)=>{
  if(({ 'form.draft-submit':'submit_form','record.update':'update_record','choose.stage':'stage_cart' } as const)[v.family]!==v.action)c.addIssue({code:'custom',message:'family/effect mismatch'});
  if(({ 'form.draft-submit':'single_form_submission','record.update':'allowlisted_field_update','choose.stage':'cart_or_draft_only' } as const)[v.family]!==v.effect_boundary)c.addIssue({code:'custom',message:'effect boundary mismatch'});
  if(!Object.hasOwn(v.fields,v.identity_field))c.addIssue({code:'custom',message:'identity field missing'});
});
export const packPolicySchema=z.object({
  sources:z.array(sourceSchema).max(64).default([]),targets:z.array(targetSchema).max(32).default([]),
  models:z.enum(['off','jev','jev_llm']).default('off'),
  confidence:z.number().min(.5).max(1).default(.9),
  model_data_approved:z.boolean().default(false),
}).strict();
export type PackPolicy=z.infer<typeof packPolicySchema>;
export type Source=z.infer<typeof sourceSchema>;
export type Target=z.infer<typeof targetSchema>;
export const sourceRequest=z.object({id:key,parameters:z.record(key,z.string().max(400)).default({})}).strict();
export const filterSchema=z.object({field,op:z.enum(['eq','contains','gte','lte']),value:scalar}).strict();
const common={version:z.literal(1),request:z.string().trim().min(1).max(8000)};
const collection={sources:z.array(sourceRequest).min(1).max(24),filters:z.array(filterSchema).max(30).default([]),deduplicate_by:z.array(field).max(10).default([])};
const sort=z.object({field,direction:z.enum(['asc','desc'])}).strict();
const judgment=z.object({question:z.string().min(1).max(1200),labels:z.record(key,z.string().min(1).max(500))}).strict();
const relevance=judgment.extend({accept_labels:z.array(key).min(1).max(20)}).strict().superRefine((value,context)=>{
  if(value.accept_labels.some(label=>!Object.hasOwn(value.labels,label)))context.addIssue({code:'custom',message:'accept label missing'});
});
const mutation={target:key,values:rowSchema,expected_before_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable()};
export const recipeSchema=z.discriminatedUnion('family',[
  z.object({...common,family:z.literal('research.search'),...collection,query:z.string().max(500),search_fields:z.array(field).min(1).max(20),relevance:relevance.nullable().default(null),sort:sort.nullable(),limit:z.number().int().min(1).max(1000)}).strict(),
  z.object({...common,family:z.literal('portal.collect'),...collection,format:z.enum(['json','csv'])}).strict(),
  z.object({...common,family:z.literal('form.draft-submit'),...mutation}).strict(),
  z.object({...common,family:z.literal('record.update'),...mutation}).strict(),
  z.object({...common,family:z.literal('choose.stage'),...mutation}).strict(),
  z.object({...common,family:z.literal('inbox.triage'),...collection,judgment,draft_by_label:z.record(key,z.string().max(4000))}).strict(),
  z.object({...common,family:z.literal('monitor.watch'),...collection,interval_seconds:z.number().int().min(60).max(2592000),mode:z.enum(['any_change','minimum_decreases']),value_field:field.nullable(),comparison_fields:z.array(field).min(1).max(20)}).strict(),
  z.object({...common,family:z.literal('file.pipeline'),...collection,columns:z.array(field).min(1).max(100),numeric_columns:z.array(field).max(100),sort:sort.nullable(),format:z.enum(['json','csv'])}).strict(),
]);
export type Recipe=z.infer<typeof recipeSchema>;
export type MutationRecipe=Extract<Recipe,{family:'form.draft-submit'|'record.update'|'choose.stage'}>;
export const packTools={
  runtime_pack_catalog:{schema:z.object({}).strict(),implemented:true,readOnly:true},
  runtime_pack_plan:{schema:z.object({prompt:common.request}).strict(),implemented:true,readOnly:true},
  runtime_pack_run:{schema:z.object({request_id:key,recipe:recipeSchema}).strict(),implemented:true,readOnly:false},
  runtime_pack_status:{schema:z.object({run_id:key}).strict(),implemented:true,readOnly:true},
  runtime_pack_execute_approved:{schema:z.object({run_id:key}).strict(),implemented:true,readOnly:false},
  runtime_pack_watch_tick:{schema:z.object({}).strict(),implemented:true,readOnly:false},
  runtime_pack_watch_pause:{schema:z.object({run_id:key,paused:z.boolean()}).strict(),implemented:true,readOnly:false},
  runtime_pack_events:{schema:z.object({after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).strict(),implemented:true,readOnly:true},
} as const;
export const familyId=basePackFamilyId;
