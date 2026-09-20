import {z} from 'zod';
import {draftInput} from './catalog.js';
import {requireCondition} from '../core/contracts.js';
const span=z.object({start:z.number().int().nonnegative(),end:z.number().int().positive(),value:z.string().min(1).max(4000)}).strict();
export const intakeSchema=z.object({prompt:z.string().min(1).max(8000).refine(s=>s.trim().length>0),proposal:z.object({pack:z.literal('fixture.draft.save'),name:span,note:span}).strict().optional()}).strict();
export function intake(value:unknown){
  const request=intakeSchema.parse(value),prompt=request.prompt;
  requireCondition(!/[\r\n]/u.test(prompt),'ONE_LINE_REQUIRED');
  requireCondition(!/\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})/u.test(prompt),'CREDENTIAL_LIKE_INPUT');
  if(!request.proposal)return {status:'NEEDS_EXTRACTION',dispatch_allowed:false,pack:'fixture.draft.save',required_arguments:['name','note'],
    question:'Extract the exact name and note from this request with UTF-16 source ranges. Do not invent omitted arguments. If absent, ask the user.',
    state:{request:{text:prompt}},next_action:'caller_extract_or_clarify'};
  const p=request.proposal;
  for(const s of [p.name,p.note])requireCondition(s.end>s.start&&s.end<=prompt.length&&prompt.slice(s.start,s.end)===s.value,'SPAN_PROVENANCE_MISMATCH');
  requireCondition(p.name.end<=p.note.start||p.note.end<=p.name.start,'OVERLAPPING_ARGUMENT_SPANS');
  const input=draftInput.parse({name:p.name.value,note:p.note.value});
  return {status:'PROPOSED',dispatch_allowed:false,pack:p.pack,input,provenance:{name:p.name,note:p.note},
    next_action:'caller_check_intent_then_submit_with_existing_delegation'};
}
