import {z} from 'zod';

export const codingId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
export const codingStageSchema=z.object({
  id:codingId,
  actor:z.enum(['codex','claude','code']),
  operation:z.enum(['implement','review','document','marketing','commit_readme']),
  instruction:z.string().trim().min(10).max(4000),
  evidence:z.string().trim().min(5).max(500),
  target_path:z.string().optional(),
  source_paths:z.array(z.string().min(1).max(200)).max(10).default([]),
}).strict();
export const codingPlanSchema=z.object({
  goal:z.string().trim().min(5).max(1000),
  stages:z.array(codingStageSchema).min(1).max(6),
  completion_checks:z.array(z.string().trim().min(5).max(300)).min(1).max(6),
}).strict();
export type CodingPlan=z.infer<typeof codingPlanSchema>;
export type CodingStage=z.infer<typeof codingStageSchema>;
export const codingTools={
  runtime_coding_projects:{schema:z.object({}).strict(),implemented:true,readOnly:true},
  runtime_coding_last:{schema:z.object({project_ref:codingId}).strict(),implemented:true,readOnly:true},
  runtime_coding_start:{schema:z.object({request_id:codingId,work_id:codingId,project_ref:codingId}).strict(),implemented:true,readOnly:false},
  runtime_coding_step:{schema:z.object({run_id:codingId,expected_revision:z.number().int().nonnegative()}).strict(),implemented:true,readOnly:false},
  runtime_coding_status:{schema:z.object({run_id:codingId}).strict(),implemented:true,readOnly:true},
  runtime_coding_pause:{schema:z.object({run_id:codingId,expected_revision:z.number().int().nonnegative(),paused:z.boolean()}).strict(),implemented:true,readOnly:false},
  runtime_coding_reconcile:{schema:z.object({run_id:codingId}).strict(),implemented:true,readOnly:true},
} as const;
