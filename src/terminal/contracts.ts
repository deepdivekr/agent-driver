import {z} from 'zod';
export const TerminalState=z.enum(['starting','input_ready','streaming','turn_completed','waiting_approval','waiting_auth','rate_limited','process_exited','context_exhausted','session_closed','stalled','state_unknown','reconciliation_required','manual_control']);
export type TerminalState=z.infer<typeof TerminalState>;
const identifier=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/);
export const terminalStart=z.object({request_id:identifier}).strict();
export const terminalSubmit=z.object({request_id:identifier,session_ref:identifier,expected_generation:z.number().int().positive(),expected_previous_turn_id:identifier.nullable(),prompt:z.string().min(1).max(8000)}).strict();
export type TerminalSubmit=z.infer<typeof terminalSubmit>;
export const terminalBound=z.object({session_ref:identifier,expected_generation:z.number().int().positive()}).strict();
const revision=z.number().int().safe().nonnegative();
export const terminalList=z.object({limit:z.number().int().min(1).max(20).default(10),cursor:z.object({revision,after_session_id:identifier}).strict().optional()}).strict();
export type TerminalList=z.infer<typeof terminalList>;
export const terminalHistory=terminalBound.extend({limit:z.number().int().min(1).max(20).default(10),cursor:z.object({revision,after_turn_id:identifier}).strict().optional()}).strict();
export type TerminalHistory=z.infer<typeof terminalHistory>;
export const terminalOutput=terminalBound.extend({limit:z.number().int().min(1).max(50).default(20),cursor:z.object({revision,after_event_id:revision}).strict().optional()}).strict();
export type TerminalOutput=z.infer<typeof terminalOutput>;
export const terminalHandoff=terminalBound.extend({include_diff:z.boolean().default(false)}).strict();
export interface TerminalSession{
  id:string;project_id:string;task_id:string;request_id:string;cli_session_id:string;
  worktree:string;executable:string;version:string;config_hash:string;host_instance_id:string|null;
  process_identity_json:string|null;generation:number;state:TerminalState;last_turn_id:string|null;
  active_turn_id:string|null;turn_count:number;interrupt_requested:number;resume_requested:number;
  manual_control:number;error_code:string|null;spool_bytes:number;created_at:string;
}
export interface TerminalTurn{
  id:string;session_id:string;request_id:string;request_hash:string;generation:number;prompt:string;
  status:'accepted'|'dispatched'|'acknowledged'|'turn_completed'|'uncertain'|'cancelled';
  deadline_uptime_ms:number|null;result_json:string|null;created_at:string;
}
export interface TerminalHostRecord{project_id:string;instance_id:string;identity_json:string;config_hash:string;endpoint:string;token:string;active:number;stop_requested:number}
export interface CliEvent{type:string;session_id?:unknown;uuid?:unknown;subtype?:unknown;[key:string]:unknown}
export interface TurnResult{outcome:'completed'|'waiting_approval'|'waiting_auth'|'rate_limited'|'context_exhausted'|'state_unknown';text:string|null;is_error:boolean;source:'official_result';project_completed:false}
export const decisionSchema=z.object({
  input:z.object({goal:z.string(),completion_criteria:z.array(z.string()),current_step:z.string(),cli_response:z.string(),diff:z.string(),test_results:z.array(z.string()),remaining_errors:z.array(z.string()),budget:z.object({remaining_turns:z.number().int().nonnegative()}).strict()}).strict(),
  output:z.object({decision:z.enum(['continue','repair','new_session','wait','complete']),reason:z.string().min(1),next_prompt:z.string().nullable(),expected_result:z.string(),verification:z.array(z.string())}).strict(),
}).strict();
export const handoffSchema=z.object({
  schema_version:z.literal(1),session_ref:identifier,cli_session_id:z.string().uuid(),generation:z.number().int().positive(),
  goal:z.string(),completed:z.array(z.string()),remaining:z.array(z.string()),commit:z.string().nullable(),worktree:z.string(),dirty_diff:z.string().nullable(),
  verification:z.array(z.object({check:z.string(),status:z.enum(['PASS','FAIL','NOT_RUN','BLOCKED_ENV']),evidence:z.string().nullable()}).strict()),
  failure_cause:z.string().nullable(),next_action:z.string(),delegation:z.object({project_id:identifier,allowed_tools:z.array(z.string()),remaining_turns:z.number().int().nonnegative()}).strict(),
  prepared_kind:z.literal('handoff'),automatic_execution:z.literal(false),
}).strict();
export function redact(text:string){return text.replace(/\b(?:sk-(?:proj-)?[\w-]{16,}|apikey_[\w-]{16,}|gh[pousr]_[\w]{20,})\b/g,'[REDACTED]').replace(/(authorization\s*:\s*bearer\s+)\S+/gi,'$1[REDACTED]');}
