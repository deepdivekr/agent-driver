import {z} from 'zod';
import {referenceSelectionSchema} from './reference-selection.js';
import {basePackFamilyId} from '../taskpacks/base-pack-catalog.js';
import {browserPreferenceSchema} from '../browser/executor-contracts.js';
import {initialWorkPlan,validateWorkPlan,workPlanSchema} from './plan.js';

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
export const workProposalSchema=z.object({
  title:sentence.max(160),
  desired_outcome:sentence,
  completion_checks:z.array(z.object({id:z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),result:sentence.max(500),evidence:sentence.max(500)}).strict()).min(1).max(8),
  assumptions:z.array(z.object({field:sentence.max(120),value:sentence.max(500),basis:sentence.max(500)}).strict()).max(8),
  route:z.object({kind:z.enum(['pack','swarm','workflow','unknown']),pack_family:basePackFamilyId.nullable()}).strict(),
  requested_effect:z.enum(['read_only','draft_only','local_file_write','external_effect_requested','unknown']),
  browser:browserPreferenceSchema.optional(),
  recurrence:z.object({kind:z.enum(['once','recurring']),rule:sentence.max(300).nullable()}).strict(),
  questions:z.array(workQuestionSchema).max(4),
}).strict();
export type WorkProposal=z.infer<typeof workProposalSchema>&{plan:z.infer<typeof workPlanSchema>};
const storedWorkProposalSchema=workProposalSchema.extend({plan:workPlanSchema.optional()}).strict();

export const workStartSchema=z.object({request_id:id,prompt:z.string().trim().min(1).max(8000).refine(value=>!/[\r\n]/u.test(value),'ONE_LINE_REQUIRED'),intake_mode:workModeSchema.default('quick')}).strict();
export const workDefineSchema=z.object({work_id:id}).strict();
export const workAnswerSchema=z.object({work_id:id,revision:z.number().int().nonnegative(),answers:z.record(z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u),z.string().trim().min(1).max(800)).refine(value=>Object.keys(value).length<=4)}).strict();
export const workStatusSchema=z.object({work_id:id}).strict();
export const workContextSchema=z.object({work_id:id,run_id:id.optional(),actor:z.string().regex(/^[a-zA-Z0-9_.:-]{1,80}$/u),reference_ids:z.array(z.string().min(1).max(200)).max(5).default([]),selection:referenceSelectionSchema.optional()}).strict().refine(value=>!value.selection||value.reference_ids.length===0,'Choose explicit reference IDs or semantic selection, not both');
export const workListSchema=z.object({limit:z.number().int().min(1).max(100).default(30)}).strict();
export const workPauseSchema=z.object({work_id:id,revision:z.number().int().nonnegative(),paused:z.boolean()}).strict();
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
  runtime_work_context:{schema:workContextSchema,implemented:true,readOnly:true},
  runtime_work_list:{schema:workListSchema,implemented:true,readOnly:true},
  runtime_work_pause:{schema:workPauseSchema,implemented:true,readOnly:false},
} as const;

export function validateWorkProposal(raw:unknown,mode:WorkMode,answered=false){
  const parsed=storedWorkProposalSchema.parse(raw);
  const proposal={...parsed,plan:validateWorkPlan(parsed.plan??initialWorkPlan(parsed.desired_outcome,parsed.requested_effect))};
  const ids=proposal.completion_checks.map(check=>check.id);
  if(new Set(ids).size!==ids.length)throw Error('WORK_CHECK_ID_DUPLICATE');
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
