import {createHash} from 'node:crypto';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';

export const packId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
export const sourceSpan=z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),value:z.string().min(1).max(8_000)}).strict();
export const naturalLanguageCandidate=z.object({
  normalized:z.record(z.string().min(1).max(128),z.unknown()),
  provenance:z.record(z.string().min(1).max(128),sourceSpan),
  missing:z.array(z.string().min(1).max(128)).max(32).default([]),
  ambiguities:z.array(z.string().min(1).max(128)).max(32).default([]),
  unsupported:z.array(z.string().min(1).max(128)).max(32).default([]),
}).strict();
export type NaturalLanguageCandidate=z.infer<typeof naturalLanguageCandidate>;

export const taskPackManifest=z.object({
  id:packId,version:z.number().int().positive(),adapter_id:packId,
  effect:z.literal('write_external'),
  input_fields:z.array(z.object({name:z.string().min(1).max(128),required:z.boolean(),description:z.string().min(1).max(400)}).strict()).min(1).max(64),
  observation:z.object({logged_in_signal:z.string().min(1),independent_readback:z.string().min(1)}).strict(),
  time_constraints:z.array(z.string().min(1).max(400)).max(32),
  popup_policy:z.object({known_dismissible:z.array(z.string().min(1).max(128)).max(32),unknown_action:z.literal('hold'),security_action:z.literal('hold')}).strict(),
  approval:z.object({required:z.literal('per_external_write'),binds:z.array(z.enum(['task','caller','pack','adapter','normalized_input','form_snapshot','generation'])).min(7),token:z.literal('single_use_expiring')}).strict(),
}).strict();
export type TaskPackManifest=z.infer<typeof taskPackManifest>;

export interface ValidatedProposal<T=unknown> {
  normalized:T;
  provenance:Record<string,z.infer<typeof sourceSpan>>;
}

export function canonicalJson(value:unknown):string {
  const visit=(input:unknown):unknown=>{
    if(input===null||typeof input==='string'||typeof input==='boolean')return input;
    if(typeof input==='number'){requireCondition(Number.isFinite(input),'NONFINITE_TASKPACK_VALUE');return input;}
    if(Array.isArray(input))return input.map(visit);
    requireCondition(typeof input==='object'&&input!==null,'INVALID_TASKPACK_VALUE');
    return Object.fromEntries(Object.entries(input as Record<string,unknown>).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,visit(item)]));
  };
  return JSON.stringify(visit(value));
}
export function snapshotHash(value:unknown){return createHash('sha256').update(canonicalJson(value)).digest('hex');}

/**
 * A model response is only candidate data.  This validates that every extracted
 * value is literally anchored in the user's single-line request before a pack
 * specific normalizer sees it.  Missing, ambiguous or unsupported requests do
 * not become drafts.
 */
export function validateCandidate(prompt:string,candidate:unknown):ValidatedProposal {
  requireCondition(typeof prompt==='string'&&prompt.trim().length>0&&prompt.length<=8_000,'INVALID_TASKPACK_PROMPT');
  requireCondition(!/[\r\n]/u.test(prompt),'ONE_LINE_REQUIRED');
  const parsed=naturalLanguageCandidate.parse(candidate);
  requireCondition(parsed.missing.length===0,'TASKPACK_INPUT_MISSING');
  requireCondition(parsed.ambiguities.length===0,'TASKPACK_INPUT_AMBIGUOUS');
  requireCondition(parsed.unsupported.length===0,'TASKPACK_INPUT_UNSUPPORTED');
  const spans=Object.entries(parsed.provenance);
  requireCondition(spans.length>0,'TASKPACK_PROVENANCE_REQUIRED');
  requireCondition(Object.keys(parsed.normalized).length===spans.length&&Object.keys(parsed.normalized).every(field=>Object.hasOwn(parsed.provenance,field)),'TASKPACK_PROVENANCE_INCOMPLETE');
  for(const [field,span] of spans){
    requireCondition(Object.hasOwn(parsed.normalized,field),'PROVENANCE_FIELD_UNKNOWN');
    requireCondition(span.end>span.start&&span.end<=prompt.length&&prompt.slice(span.start,span.end)===span.value,'SPAN_PROVENANCE_MISMATCH');
  }
  const ordered=spans.map(([,span])=>span).sort((a,b)=>a.start-b.start||a.end-b.end);
  for(let index=1;index<ordered.length;index+=1){const previous=ordered[index-1]!,current=ordered[index]!;requireCondition(previous.end<=current.start||(previous.start===current.start&&previous.end===current.end&&previous.value===current.value),'OVERLAPPING_ARGUMENT_SPANS');}
  return {normalized:parsed.normalized,provenance:parsed.provenance};
}
