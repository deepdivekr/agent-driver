import {randomUUID} from 'node:crypto';
import {z} from 'zod';

const client=z.enum(['mcp','codex','claude','opencode','cursor','api']);
const model=z.string().min(1).max(200).refine(value=>!/[\s\x00-\x1f]/u.test(value)&&!/^(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})$/u.test(value));
export const clientHandoffSchema=z.object({
  id:z.string().uuid(),project_id:z.string().min(1),work_id:z.string().nullable(),run_id:z.string().nullable(),stage_id:z.string().nullable(),
  source:client,target:client.nullable(),source_model:model,target_model:model.nullable(),
  reason:z.enum(['auth_expired','quota_exhausted','rate_limited','context_exhausted','provider_unavailable','unknown']),
  effect_state:z.enum(['none','verified','uncertain']),status:z.enum(['transferred','requires_reconciliation','no_candidate']),
  input_sha256:z.string().regex(/^[a-f0-9]{64}$/u).nullable(),created_at:z.string().datetime(),
}).strict();
export type ClientHandoff=z.infer<typeof clientHandoffSchema>;
export type HandoffReason=ClientHandoff['reason'];
export type HandoffClient=ClientHandoff['source'];
export type ClientRouteEvent=Pick<ClientHandoff,'work_id'|'run_id'|'stage_id'|'source'|'target'|'source_model'|'target_model'|'reason'|'effect_state'|'status'|'input_sha256'>;
export function handoffContext(input:unknown){
  const value=input&&typeof input==='object'&&!Array.isArray(input)?input as Record<string,unknown>:{};
  const id=(name:string)=>typeof value[name]==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u.test(value[name])?value[name] as string:null;
  return {work_id:id('work_id'),run_id:id('run_id'),stage_id:id('stage_id')};
}
export function classifyClientFailure(value:unknown):HandoffReason{
  const message=typeof value==='string'?value:value instanceof Error?value.message:'';
  if(/(?:auth(?:entication)?|login|session|credential|token).{0,40}(?:expired|invalid|required|failed)|(?:expired|invalid).{0,40}(?:auth|login|session|credential|token)|\b(?:401|403|unauthorized|signed.out)\b/iu.test(message))return 'auth_expired';
  if(/(?:quota|credit|balance|billing|insufficient|usage limit|weekly limit|monthly limit)/iu.test(message)||/\b402\b/u.test(message))return 'quota_exhausted';
  if(/(?:rate.limit|too many requests|retry.after|\b429\b)/iu.test(message))return 'rate_limited';
  if(/(?:context.window|context.length|context.exhausted|maximum context)/iu.test(message))return 'context_exhausted';
  return 'provider_unavailable';
}
export function makeClientHandoff(value:Omit<ClientHandoff,'id'|'created_at'>):ClientHandoff{
  return clientHandoffSchema.parse({...value,id:randomUUID(),created_at:new Date().toISOString()});
}
