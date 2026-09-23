import {z} from 'zod';

const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const runtimeActivityReport=z.object({
  owner_kind:z.enum(['pack','task','terminal']),owner_id:id,actor_id:id.nullable().default(null),
  activity:z.object({kind:z.enum(['started','navigating','observing','tool_call','checkpoint','waiting','completed']),summary:z.string().trim().min(1).max(500),endpoint:z.string().url().max(2000).nullable().default(null),surface_id:id.nullable().optional(),decision_layer:z.enum(['llm','jev','code']).nullable().optional()}).strict(),
}).strict();

export const observabilityTools={runtime_activity_report:{schema:runtimeActivityReport,implemented:true,readOnly:false}} as const;
