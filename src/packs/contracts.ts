import {z} from 'zod';
import {basePackFamilyId} from '../taskpacks/base-pack-catalog.js';
import {evidenceChecksSchema} from './evidence.js';
import {browserPreferenceSchema} from '../browser/executor-contracts.js';

export const key=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const field=z.string().min(1).max(120).refine(s=>!['__proto__','constructor','prototype'].includes(s));
export const scalar=z.union([z.string().max(16000),z.number().finite(),z.boolean(),z.null()]);
export const rowSchema=z.record(field,scalar);
export type Row=z.infer<typeof rowSchema>;
const selector=z.string().min(1).max(400);
const fields=z.record(field,z.object({selector,kind:z.enum(['text','select','checkbox','radio'])}).strict());
const remote=z.object({url:z.string().url(),parameters:z.array(key).max(20).default([])});
const numericColumns=z.array(field).max(100).refine(columns=>new Set(columns).size===columns.length,'duplicate numeric column').optional();
export const sourceSchema=z.discriminatedUnion('kind',[
  z.object({id:key,kind:z.literal('file'),path:z.string().min(1),format:z.enum(['json','csv']),numeric_columns:numericColumns}).strict(),
  // json_rows 'features': the rows are the `properties` of a GeoJSON FeatureCollection, projected by json_fields.
  remote.extend({id:key,kind:z.literal('http'),format:z.enum(['json','csv']),numeric_columns:numericColumns,json_fields:z.array(field).min(1).max(100).refine(fields=>new Set(fields).size===fields.length,'duplicate JSON projection field').optional(),json_rows:z.enum(['features']).optional()}).strict().superRefine((source,context)=>{
    if(source.json_fields&&source.format!=='json')context.addIssue({code:'custom',message:'json_fields requires JSON format'});
    if(source.json_rows&&(source.format!=='json'||!source.json_fields))context.addIssue({code:'custom',message:'json_rows requires JSON format and json_fields'});
    if(source.json_fields&&source.numeric_columns?.some(column=>!source.json_fields!.includes(column)))context.addIssue({code:'custom',message:'numeric column missing from JSON projection'});
  }),
  remote.extend({id:key,kind:z.literal('browser'),rows:selector,columns:z.record(field,selector),numeric_columns:numericColumns,ready:selector,auth_gate:selector,auth_required:z.boolean().default(true),account_selector:selector,account_text:z.string().min(1)}).strict().superRefine((source,context)=>{
    if(source.numeric_columns?.some(column=>!Object.hasOwn(source.columns,column)))context.addIssue({code:'custom',message:'numeric column missing from browser columns'});
  }),
]);
export const targetSchema=z.object({
  id:key,family:z.enum(['form.draft-submit','record.update','choose.stage']),
  action:z.enum(['submit_form','update_record','stage_cart']),url:z.string().url(),
  draft_is_local:z.literal(true),
  draft_only:z.boolean().default(false),auth_required:z.boolean().default(true),
  effect_boundary:z.enum(['single_form_submission','allowlisted_field_update','cart_or_draft_only']),
  ready:selector,auth_gate:selector,account_selector:selector,account_text:z.string().min(1),
  fields,identity_field:field,submit:selector,readback_url:z.string().url().nullable().default(null),identity_parameter:key,
  // Host-reviewed benign dismissals only; unknown or security dialogs hold.
  known_popups:z.array(z.object({id:key,dialog:selector,dismiss:selector}).strict()).max(20).default([]),
}).strict().superRefine((v,c)=>{
  if(!v.draft_only&&!v.readback_url)c.addIssue({code:'custom',message:'submittable targets require independent readback'});
  if(!v.auth_required&&!v.draft_only)c.addIssue({code:'custom',message:'public anonymous targets must be draft-only'});
  if(({ 'form.draft-submit':'submit_form','record.update':'update_record','choose.stage':'stage_cart' } as const)[v.family]!==v.action)c.addIssue({code:'custom',message:'family/effect mismatch'});
  if(({ 'form.draft-submit':'single_form_submission','record.update':'allowlisted_field_update','choose.stage':'cart_or_draft_only' } as const)[v.family]!==v.effect_boundary)c.addIssue({code:'custom',message:'effect boundary mismatch'});
  if(!Object.hasOwn(v.fields,v.identity_field))c.addIssue({code:'custom',message:'identity field missing'});
});
export const localRecordSchema=z.object({
  id:key,path:z.string().min(1),identity_field:field,
  fields:z.array(field).min(1).max(100),
  read_fields:z.array(field).max(100).optional(),
}).strict().superRefine((value,context)=>{
  if(new Set(value.fields).size!==value.fields.length||value.fields.includes(value.identity_field))context.addIssue({code:'custom',message:'local record editable fields must be unique and exclude identity'});
  if(value.read_fields&&new Set(value.read_fields).size!==value.read_fields.length)context.addIssue({code:'custom',message:'local record readable fields must be unique'});
  if([value.identity_field,...value.fields,...(value.read_fields??[])].some(name=>/(?:password|token|secret|api.?key|auth|session|cookie)/iu.test(name)))context.addIssue({code:'custom',message:'credential-like local record field forbidden'});
});
export const packPolicySchema=z.object({
  sources:z.array(sourceSchema).max(64).default([]),targets:z.array(targetSchema).max(32).default([]),local_records:z.array(localRecordSchema).max(32).default([]),
  models:z.enum(['off','jev','jev_llm']).default('off'),
  confidence:z.number().min(.5).max(1).default(.9),
  model_data_approved:z.boolean().default(false),
  decision_shadow:z.object({provider:z.enum(['off','llm']).default('off'),sample_rate:z.number().min(0).max(1).default(.1)}).strict().default({provider:'off',sample_rate:.1}),
}).strict().superRefine((value,context)=>{
  if(value.decision_shadow.provider==='llm'&&value.models!=='jev_llm')context.addIssue({code:'custom',message:'LLM shadow requires jev_llm'});
});
export type PackPolicy=z.infer<typeof packPolicySchema>;
export type Source=z.infer<typeof sourceSchema>;
export type Target=z.infer<typeof targetSchema>;
export type LocalRecord=z.infer<typeof localRecordSchema>;
export const sourceRequest=z.object({id:key,parameters:z.record(key,z.string().max(400)).default({})}).strict();
/** Date-only values denote a UTC calendar day. Timestamps must carry Z or an
 * explicit numeric offset; local-clock and numeric epoch guesses are invalid. */
export function parsePackDate(value:unknown):{epoch_ms:number;date_only:boolean}|null{
  if(typeof value!=='string')return null;
  const match=/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2}))?$/u.exec(value);
  if(!match)return null;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  if(year<1||month<1||month>12||day<1||day>31)return null;
  const date=new Date(0);date.setUTCFullYear(year,month-1,day);date.setUTCHours(0,0,0,0);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return null;
  if(match[4]===undefined)return {epoch_ms:date.getTime(),date_only:true};
  const hour=Number(match[4]),minute=Number(match[5]),second=Number(match[6]),millisecond=Number((match[7]??'').padEnd(3,'0'))||0;
  if(hour>23||minute>59||second>59)return null;
  const zone=match[8]!;let offsetMinutes=0;
  if(zone!=='Z'){
    const hours=Number(zone.slice(1,3)),minutes=Number(zone.slice(4,6));if(hours>23||minutes>59||zone==='-00:00')return null;
    offsetMinutes=(zone[0]==='+'?1:-1)*(hours*60+minutes);
  }
  const epoch=date.getTime()+hour*3600000+minute*60000+second*1000+millisecond-offsetMinutes*60000;
  return Number.isSafeInteger(epoch)?{epoch_ms:epoch,date_only:false}:null;
}
export const filterSchema=z.object({field,op:z.enum(['eq','contains','gte','lte','date_gte','date_lt','date_lte']).describe('date_gte/date_lt/date_lte compare strict dates. YYYY-MM-DD means a UTC calendar day; date_lte includes that entire UTC day. Timestamps require Z or an explicit offset, such as +09:00 for Korea.'),value:scalar.describe('For date_* use YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss[.SSS]Z/±HH:MM. Never use a numeric epoch or timezone-free clock time.')}).strict().superRefine((filter,context)=>{
  if(filter.op.startsWith('date_')&&!parsePackDate(filter.value))context.addIssue({code:'custom',message:'date filter requires valid YYYY-MM-DD UTC day or ISO timestamp with explicit Z/offset'});
});
const common={version:z.literal(1),request:z.string().trim().min(1).max(8000),browser:browserPreferenceSchema.optional()};
const collection={sources:z.array(sourceRequest).min(1).max(24),filters:z.array(filterSchema).max(30).default([]),deduplicate_by:z.array(field).max(10).default([])};
const sort=z.object({field,direction:z.enum(['asc','desc'])}).strict();
const judgment=z.object({question:z.string().min(1).max(1200),labels:z.record(key,z.string().min(1).max(500))}).strict();
const relevance=judgment.extend({accept_labels:z.array(key).min(1).max(20)}).strict().superRefine((value,context)=>{
  if(value.accept_labels.some(label=>!Object.hasOwn(value.labels,label)))context.addIssue({code:'custom',message:'accept label missing'});
});
const mutation={target:key,values:rowSchema,expected_before_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable()};
export const portalCollectRecipeSchema=z.object({...common,family:z.literal('portal.collect'),...collection,columns:z.array(field).min(1).max(100).refine(columns=>new Set(columns).size===columns.length,'duplicate portal column').optional(),format:z.enum(['json','csv']),verification:evidenceChecksSchema.optional()}).strict();
export const filePipelineRecipeSchema=z.object({...common,family:z.literal('file.pipeline'),...collection,columns:z.array(field).min(1).max(100),numeric_columns:z.array(field).max(100),sort:sort.nullable(),format:z.enum(['json','csv']),verification:evidenceChecksSchema.optional()}).strict();
export const recipeSchema=z.discriminatedUnion('family',[
  z.object({...common,family:z.literal('research.search'),...collection,query:z.string().max(500),search_fields:z.array(field).min(1).max(20),relevance:relevance.nullable().default(null),sort:sort.nullable(),limit:z.number().int().min(1).max(1000),verification:evidenceChecksSchema.optional()}).strict(),
  portalCollectRecipeSchema,
  z.object({...common,family:z.literal('form.draft-submit'),...mutation}).strict(),
  z.object({...common,family:z.literal('record.update'),...mutation}).strict(),
  z.object({...common,family:z.literal('choose.stage'),...mutation}).strict(),
  z.object({...common,family:z.literal('inbox.triage'),...collection,judgment,draft_by_label:z.record(key,z.string().max(4000))}).strict(),
  z.object({...common,family:z.literal('monitor.watch'),...collection,interval_seconds:z.number().int().min(60).max(2592000),mode:z.enum(['any_change','minimum_decreases']),value_field:field.nullable(),comparison_fields:z.array(field).min(1).max(20)}).strict(),
  filePipelineRecipeSchema,
]);
export type Recipe=z.infer<typeof recipeSchema>;
export type MutationRecipe=Extract<Recipe,{family:'form.draft-submit'|'record.update'|'choose.stage'}>;
export const packTools={
  runtime_pack_catalog:{schema:z.object({}).strict(),implemented:true,readOnly:true},
  runtime_pack_plan:{schema:z.object({prompt:common.request,work_id:z.string().uuid().optional()}).strict(),implemented:true,readOnly:true},
  runtime_pack_local_record_inspect:{schema:z.object({work_id:z.string().uuid(),target:key,identity:z.union([z.string().min(1).max(400),z.number().finite()])}).strict(),implemented:true,readOnly:true},
  runtime_pack_run:{schema:z.object({request_id:key,work_id:z.string().uuid().optional(),recipe:recipeSchema}).strict(),implemented:true,readOnly:false},
  runtime_pack_status:{schema:z.object({run_id:key}).strict(),implemented:true,readOnly:true},
  runtime_pack_execute_approved:{schema:z.object({run_id:key}).strict(),implemented:true,readOnly:false},
  runtime_pack_watch_tick:{schema:z.object({run_id:key.optional()}).strict(),implemented:true,readOnly:false},
  runtime_pack_watch_pause:{schema:z.object({run_id:key,paused:z.boolean()}).strict(),implemented:true,readOnly:false},
  runtime_pack_events:{schema:z.object({run_id:key.optional(),after:z.number().int().nonnegative().default(0),limit:z.number().int().min(1).max(100).default(50)}).strict(),implemented:true,readOnly:true},
} as const;
export const familyId=basePackFamilyId;
