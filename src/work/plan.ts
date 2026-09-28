import {z} from 'zod';
import {type WorkImportRecord} from '../packs/store.js';
import {type WorkImportDraft} from './import-draft.js';

const stepId=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
export const workPlanSchema=z.object({
  format:z.literal(1),
  revision:z.number().int().positive(),
  source:z.enum(['request','pasted_import','project_scan']),
  source_id:z.string().min(1).max(128).nullable(),
  source_digest:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  provenance:z.enum(['user_request','unverified_external','observed_code_unverified_execution']),
  steps:z.array(z.object({
    id:stepId,goal:z.string().trim().min(1).max(2000),depends_on:z.array(stepId).max(10),
    effect:z.enum(['read_only','draft_only','local_write','external_write','unknown']),
    tool_hints:z.array(z.string().trim().min(1).max(300)).max(10),
    evidence_ids:z.array(z.string().min(1).max(80)).max(8),
  }).strict()).min(1).max(20),
}).strict();
export type WorkPlan=z.infer<typeof workPlanSchema>;

export function validateWorkPlan(raw:unknown):WorkPlan{
  const plan=workPlanSchema.parse(raw),steps=new Map(plan.steps.map(step=>[step.id,step]));
  if(steps.size!==plan.steps.length)throw Error('WORK_PLAN_STEP_DUPLICATE');
  const visiting=new Set<string>(),visited=new Set<string>();
  const visit=(id:string):void=>{
    if(visiting.has(id))throw Error('WORK_PLAN_STEP_CYCLE');
    if(visited.has(id))return;
    const step=steps.get(id);if(!step)throw Error('WORK_PLAN_DEPENDENCY_INVALID');
    visiting.add(id);for(const dep of step.depends_on)visit(dep);visiting.delete(id);visited.add(id);
  };
  for(const step of plan.steps)visit(step.id);
  return plan;
}

export function initialWorkPlan(goal:string,requestedEffect:'read_only'|'draft_only'|'local_file_write'|'external_effect_requested'|'unknown'='unknown'):WorkPlan{return validateWorkPlan({
  format:1,revision:1,source:'request',source_id:null,source_digest:null,provenance:'user_request',
  steps:[{id:'work',goal,depends_on:[],effect:requestedEffect==='local_file_write'?'local_write':requestedEffect==='external_effect_requested'?'external_write':requestedEffect,tool_hints:[],evidence_ids:[]}],
});}

export function planFromImport(record:WorkImportRecord,goal:string,requestedEffect:'read_only'|'draft_only'|'local_file_write'|'external_effect_requested'|'unknown'):WorkPlan{
  const steps:WorkPlan['steps']=record.kind==='pasted'?(record.body as WorkImportDraft).steps.map(step=>({id:step.id,goal:step.goal,depends_on:step.depends_on,effect:step.effect,tool_hints:step.tool_hints,evidence_ids:step.evidence_ids})):(record.body as {analysis?:{steps:Array<{id:string;goal:string;depends_on:string[];evidence_ids:string[]}>}|null}).analysis?.steps.map(step=>({id:step.id,goal:step.goal,depends_on:step.depends_on,effect:'unknown' as const,tool_hints:[],evidence_ids:step.evidence_ids}))??[];
  const fallback=initialWorkPlan(goal,requestedEffect).steps[0]!;
  return validateWorkPlan({format:1,revision:1,source:record.kind==='pasted'?'pasted_import':'project_scan',source_id:record.id,source_digest:record.source_digest,provenance:record.kind==='pasted'?'unverified_external':'observed_code_unverified_execution',steps:steps.length?steps:[fallback]});
}
