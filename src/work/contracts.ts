import {z} from 'zod';
import {referenceSelectionSchema} from './reference-selection.js';
import {basePackFamilyId} from '../taskpacks/base-pack-catalog.js';
import {browserPreferenceSchema} from '../browser/executor-contracts.js';
import {hasBusinessStages,initialWorkPlan,modelWorkPlan,modelWorkPlanSchema,validateWorkPlan,workPlanSchema} from './plan.js';
import {workResultGetSchema,workResultsListSchema} from './results.js';
import {nativeCompletionPredicateSchema,nativeCompletionTextIsCanonical} from './completion-checks.js';
import {collectionContractSchema,modelCollectionContractSchema,compileModelCollectionContract} from './collection-contract.js';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u);
const sentence=z.string().trim().min(1).max(2000);
export const workModeSchema=z.enum(['quick','guided']);
export type WorkMode=z.infer<typeof workModeSchema>;
export const workQuestionSchema=z.object({
  id:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),
  prompt:sentence.max(400),
  options:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),label:sentence.max(120),meaning:sentence.max(300)}).strict()).min(2).max(4),
  recommended_id:z.string().nullable(),
  required:z.boolean(),
}).strict();
const workProposalFields=z.object({
  title:sentence.max(160),
  desired_outcome:sentence,
  completion_checks:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),result:sentence.max(500),evidence:sentence.max(500),native_check:nativeCompletionPredicateSchema.optional()}).strict().refine(nativeCompletionTextIsCanonical,'NATIVE_COMPLETION_TEXT_NOT_CANONICAL')).min(1).max(8),
  assumptions:z.array(z.object({field:sentence.max(120),value:sentence.max(500),basis:sentence.max(500)}).strict()).max(8),
  route:z.object({kind:z.enum(['pack','swarm','workflow','unknown']),pack_family:basePackFamilyId.nullable()}).strict(),
  requested_effect:z.enum(['read_only','draft_only','local_file_write','external_effect_requested','unknown']),
  collection_contract:collectionContractSchema.optional(),
  browser:browserPreferenceSchema.optional(),
  recurrence:z.object({kind:z.enum(['once','recurring']),rule:sentence.max(300).nullable()}).strict(),
  questions:z.array(workQuestionSchema).max(4),
}).strict();
// A new model definition must describe observable business stages. Old saved
// Works and imported plans remain readable through the separate storage form.
export const workProposalSchema=workProposalFields.extend({plan:modelWorkPlanSchema,collection_contract:modelCollectionContractSchema.optional()}).strict();
export type WorkProposal=z.infer<typeof workProposalFields>&{plan:z.infer<typeof workPlanSchema>};
const storedWorkProposalSchema=workProposalFields.extend({plan:workPlanSchema.optional()}).strict();

export const workStartSchema=z.object({request_id:id,prompt:z.string().trim().min(1).max(8000).refine(value=>!/[\r\n]/u.test(value),'ONE_LINE_REQUIRED'),intake_mode:workModeSchema.default('quick'),completion_condition:z.string().trim().max(2000).optional(),delivery_target_ids:z.array(id).max(10).refine(value=>new Set(value).size===value.length,'DUPLICATE_DELIVERY_TARGET').optional()}).strict();
export const workDefineSchema=z.object({work_id:id}).strict();
export const workAnswerSchema=z.object({work_id:id,revision:z.number().int().nonnegative(),answers:z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),z.string().trim().min(1).max(800)).refine(value=>Object.keys(value).length<=4)}).strict();
// Human Control Center actions may combine registration with ONE explicit run.
// The MCP intake contracts above remain registration-only.
const intakeAction={execute:z.boolean().default(false),cost_acknowledged:z.boolean().default(false),timezone:z.string().min(1).max(100).optional()};
export const workStartActionSchema=workStartSchema.extend(intakeAction).strict();
export const workAnswerActionSchema=workAnswerSchema.extend(intakeAction).strict();
export const workReconnectSchema=z.object({work_id:id.optional()}).strict();
export const workStatusSchema=z.object({work_id:id}).strict();
export const workContextSchema=z.object({work_id:id,run_id:id.optional(),actor:z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/u),reference_ids:z.array(z.string().min(1).max(200)).max(5).default([]),selection:referenceSelectionSchema.optional()}).strict().refine(value=>!value.selection||value.reference_ids.length===0,'Choose explicit reference IDs or semantic selection, not both');
export const workListSchema=z.object({limit:z.number().int().min(1).max(100).default(30)}).strict();
export const workPauseSchema=z.object({work_id:id,revision:z.number().int().nonnegative(),paused:z.boolean()}).strict();
export const workPauseActionSchema=workPauseSchema.extend(intakeAction).strict();
// Shared by the Control Center dispatcher and MCP. No second admission contract.
export const workExecuteSchema=z.object({work_id:z.string().uuid(),revision:z.number().int().nonnegative(),executor:z.enum(['pack','hermes','client']).default('client'),cost_acknowledged:z.boolean().default(false),current_run_only:z.boolean().default(true).describe('Defaults to this cycle only. Set false only after the user separately agreed to future recurring executions and their configured model usage; review any original-platform schedule first. A timezone is not schedule consent.'),timezone:z.string().min(1).max(100).optional()}).strict();
export const workControlSchema=z.object({work_id:z.string().uuid(),revision:z.number().int().nonnegative(),action:z.enum(['pause','resume','edit','retry']),instruction:z.string().trim().min(1).max(4000).optional(),stage_id:z.string().max(80).optional()}).strict();
export const workJevSchema=z.object({work_id:id,revision:z.number().int().nonnegative(),enabled:z.boolean(),cost_acknowledged:z.boolean().default(false)}).strict();
// Pack request IDs are bounded to 80 characters. Preserve legacy longer Work
// IDs without creating an unbound second Work or a fresh ID on every retry.
export function workExecutionBinding(work:{id:string;request_id:string}){
  return {work_id:work.id,request_id:work.request_id.length<=80?work.request_id:`work-${work.id}`};
}
export const workTools={
  runtime_work_start:{schema:workStartSchema,implemented:true,readOnly:false},
  runtime_work_define:{schema:workDefineSchema,implemented:true,readOnly:false},
  runtime_work_answer:{schema:workAnswerSchema,implemented:true,readOnly:false},
  runtime_work_status:{schema:workStatusSchema,implemented:true,readOnly:true},
  runtime_work_results:{schema:workResultsListSchema,implemented:true,readOnly:true},
  runtime_work_result:{schema:workResultGetSchema,implemented:true,readOnly:true},
  runtime_work_context:{schema:workContextSchema,implemented:true,readOnly:true},
  runtime_work_list:{schema:workListSchema,implemented:true,readOnly:true},
  runtime_work_pause:{schema:workPauseSchema,implemented:true,readOnly:false},
  runtime_work_execute:{schema:workExecuteSchema,implemented:true,readOnly:false},
  runtime_work_control:{schema:workControlSchema,implemented:true,readOnly:false},
} as const;

export function validateWorkProposal(raw:unknown,mode:WorkMode,answered=false){
  const parsed=storedWorkProposalSchema.parse(raw);
  const proposal={...parsed,plan:validateWorkPlan(parsed.plan??initialWorkPlan(parsed.desired_outcome,parsed.requested_effect))};
  const ids=proposal.completion_checks.map(check=>check.id);
  if(new Set(ids).size!==ids.length)throw Error('WORK_CHECK_ID_DUPLICATE');
  if(proposal.collection_contract){
    const covered=proposal.collection_contract.covered_check_ids;
    if(new Set(covered).size!==covered.length||covered.some(id=>!ids.includes(id)))throw Error('WORK_COLLECTION_CHECK_INVALID');
    if(proposal.route.kind!=='pack'||proposal.route.pack_family!==proposal.collection_contract.recipe.family)throw Error('WORK_COLLECTION_ROUTE_MISMATCH');
  }
  if(proposal.route.kind!=='pack'&&proposal.route.pack_family!==null)throw Error('WORK_ROUTE_FAMILY_INVALID');
  if(proposal.route.kind==='pack'&&proposal.route.pack_family===null)throw Error('WORK_ROUTE_FAMILY_REQUIRED');
  if(proposal.recurrence.kind==='once'&&proposal.recurrence.rule!==null)throw Error('WORK_RECURRENCE_INVALID');
  if(proposal.recurrence.kind==='recurring'&&proposal.recurrence.rule===null)throw Error('WORK_RECURRENCE_MISSING');
  const questions=answered?[]:mode==='quick'?proposal.questions.filter(question=>question.required):proposal.questions;
  for(const question of questions){
    const options=question.options.map(option=>option.id);
    if(new Set(options).size!==options.length||question.recommended_id!==null&&!options.includes(question.recommended_id))throw Error('WORK_QUESTION_INVALID');
  }
  if(new Set(questions.map(question=>question.id)).size!==questions.length)throw Error('WORK_QUESTION_ID_DUPLICATE');
  return {...proposal,questions};
}

/** Interpret an LLM proposal without granting its metadata or evidence claims
 * authority. Missing plan remains a compatibility path for older model
 * fixtures/providers; the model-facing JSON schema requires one.
 */
export function validateModelWorkProposal(raw:unknown,mode:WorkMode,answered=false,previous:WorkProposal|null=null):WorkProposal{
  const candidate=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
  const fields={...candidate};delete fields.plan;
  if(fields.collection_contract!==undefined)fields.collection_contract=compileModelCollectionContract(fields.collection_contract);
  const proposed=validateWorkProposal(fields,mode,answered);
  if(previous&&hasBusinessStages(previous.plan)&&(!candidate||!Object.hasOwn(candidate,'plan')))throw Error('WORK_PLAN_REQUIRED_FOR_REPLAN');
  const plan=candidate&&Object.hasOwn(candidate,'plan')?
    modelWorkPlan(candidate.plan,proposed.desired_outcome,proposed.requested_effect,previous?.plan??null):
    previous?.plan?validateWorkPlan({...previous.plan,revision:previous.plan.revision+1}):proposed.plan;
  return {...proposed,plan};
}
