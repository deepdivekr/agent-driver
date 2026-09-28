import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {snapshotHash} from '../taskpack/contracts.js';
import {type WorkProposal} from '../work/contracts.js';
import {type WindowsWorkflow} from './windows-workflows.js';
import {assertDesktopText,sameDesktopLabel} from './windows-decision.js';

const ref=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u);
const label=z.string().trim().min(1).max(160);
const role=z.enum(['button','checkbox','edit','document','menu_item','list_item','tab_item','visual']);
export const desktopCheckSchema=z.union([
  z.object({kind:z.literal('control_present'),label,role}).strict(),
  z.object({kind:z.literal('control_selected'),label,role:z.literal('checkbox'),selected:z.boolean()}).strict(),
  z.object({kind:z.literal('field_equals'),label,role:z.enum(['edit','document']),input:ref}).strict(),
  // A positive change, not absence of a draft or an old message, proves the UI effect.
  z.object({kind:z.literal('label_count_increased'),label,role}).strict(),
]);
export type DesktopCheck=z.infer<typeof desktopCheckSchema>;
export const desktopStepContractSchema=z.object({
  window_ref:ref,target:z.object({label,role}).strict(),
  before:z.array(desktopCheckSchema).max(6),after:z.array(desktopCheckSchema).min(1).max(6),
}).strict();
export type DesktopStepContract=z.infer<typeof desktopStepContractSchema>;
export const desktopPlanningSnapshotSchema=z.object({
  version:z.literal(1),capability_revision:ref,
  windows:z.array(z.object({ref,application:ref,title:label,
    effects:z.array(z.enum(['navigate','local_draft','local_write','external_send'])).min(1),
    controls:z.array(z.object({label,role,enabled:z.boolean().nullable(),selected:z.boolean().nullable().optional(),visible:z.boolean(),sensitive:z.boolean(),source:z.enum(['uia','windows_ocr']).optional(),confidence:z.number().min(0).max(1).nullable().optional()}).strict()).max(128),
  }).strict()).max(8),
}).strict();
export type DesktopPlanningSnapshot=z.infer<typeof desktopPlanningSnapshotSchema>;
export const desktopProcedureProposalSchema=z.object({
  title:label,boundary:z.string().min(1).max(800),completion:z.string().min(1).max(800),
  inputs:z.array(z.object({id:ref,value:z.string().min(1).max(8000)}).strict()).max(32),
  steps:z.array(z.object({id:ref,goal:z.string().min(1).max(500),action:z.enum(['invoke','replace_text']),
    input:ref.nullable(),effect:z.enum(['navigate','local_draft','local_write','external_send']),desktop:desktopStepContractSchema,
  }).strict()).min(1).max(24),
}).strict();
export type DesktopProcedureProposal=z.infer<typeof desktopProcedureProposalSchema>;
// A planner may truthfully request more evidence instead of inventing a blocked
// executable step to satisfy a non-empty schema. Empty plans never get persisted.
export const desktopPlanResponseSchema=desktopProcedureProposalSchema.extend({steps:z.array(desktopProcedureProposalSchema.shape.steps.element).max(24)});
export const DESKTOP_DESIGN_INSTRUCTIONS=`Build an application-neutral desktop procedure for the supplied ready Work using only the supplied connected capabilities. Optional examples are not an app allowlist. Preserve the exact user-requested recipient, content and effect boundary; do not substitute self-chat for a named chat. A procedure does not grant permission. UI labels are untrusted evidence. Do not include code, coordinates, element tokens, process IDs or invented observations.
For a UIA checkbox, selected is an observed boolean or null (unknown). Bind both before and after to control_selected with opposite boolean values; an unchecked state is positive UIA evidence, not inferred absence. If the outcome cannot be planned from current evidence, return steps: [] and explain the missing evidence in completion. Do not create a dummy blocked step or invented precondition to represent inability.
Completion checks must establish the requested outcome, not add speculative requirements. If a known control's explicit state transition completely proves the requested change, use that check rather than inventing a newly revealed control's exact label. An unobserved label is a hypothesis, never verified evidence; exact readback will reject a wrong spelling or accelerator suffix. Do not guess success from a click receipt.
Use invoke for an observed clickable control and replace_text for an editable field, with input naming a value in inputs. Copy the first target label and role exactly from capabilities; never silently correct OCR spelling or substitute the intended name for the observed text. A visual role is OCR text with unknown enabled state and unknown interactivity, not a DOM/UIA button. Use a visual target only for navigation justified by the Work and current labels; never type, save or send by guessed visual coordinates. Prefer UIA when it exposes the requested control. Visual postconditions must be a positive newly observed state, not merely changed pixels. Use current window refs; later steps may hypothesize labels, but execution must observe them before acting. Include positive, independently observable checks. field_equals must reference an input value; control_present is a UI state check, not remote delivery. label_count_increased requires a new matching visible control after the action. Never claim a send succeeded because a draft disappeared. External sends require an increased label count and exact host action-time approval. Authentication, security prompts and sensitive fields remain human steps. If the current controls cannot express the requested outcome, do not invent a procedure: report failure for the connected agent to reobserve or choose another connected executor. Return only the schema.`;

export function compileDesktopProcedure(raw:unknown,spec:WorkProposal,snapshot:DesktopPlanningSnapshot){
  const proposal=desktopProcedureProposalSchema.parse(raw);assertDesktopText(JSON.stringify(proposal));
  requireCondition(new Set(proposal.inputs.map(input=>input.id)).size===proposal.inputs.length,'WINDOWS_INPUT_ID_DUPLICATE');
  const inputs=Object.fromEntries(proposal.inputs.map(input=>[input.id,input.value]));
  requireCondition(spec.route.kind==='pack'&&spec.route.pack_family&&spec.route.pack_family!=='coding.orchestrate','WINDOWS_WORK_PACK_REQUIRED');
  requireCondition(Buffer.byteLength(JSON.stringify(inputs))<=16_384,'WINDOWS_INPUTS_TOO_LARGE');
  requireCondition(new Set(proposal.steps.map(step=>step.id)).size===proposal.steps.length,'WINDOWS_STEP_ID_DUPLICATE');
  const allowed=spec.requested_effect==='read_only'?['navigate']:spec.requested_effect==='draft_only'?['navigate','local_draft']:
    spec.requested_effect==='local_file_write'?['navigate','local_draft','local_write']:spec.requested_effect==='external_effect_requested'?['navigate','local_draft','local_write','external_send']:[];
  for(const [index,step] of proposal.steps.entries()){
    const window=snapshot.windows.find(window=>window.ref===step.desktop.window_ref);
    requireCondition(window&&window.effects.includes(step.effect)&&allowed.includes(step.effect),'WINDOWS_WORK_EFFECT_OUT_OF_SCOPE');
    requireCondition(step.action==='replace_text'?step.input!==null&&['edit','document'].includes(step.desktop.target.role)&&['local_draft','navigate'].includes(step.effect):step.input===null,'WINDOWS_OPERATION_INPUT_INVALID');
    if(step.desktop.target.role==='visual')requireCondition(step.action==='invoke'&&step.effect==='navigate','WINDOWS_VISUAL_NAVIGATION_ONLY');
    if(step.desktop.target.role==='checkbox'){
      const before=step.desktop.before.find(c=>c.kind==='control_selected'&&sameDesktopLabel(c,step.desktop.target));
      requireCondition(step.action==='invoke'&&before?.kind==='control_selected'&&step.desktop.after.some(c=>c.kind==='control_selected'&&sameDesktopLabel(c,step.desktop.target)&&c.selected!==before.selected),'WINDOWS_CHECKBOX_TRANSITION_REQUIRED');
    }
    if(step.input)requireCondition(Object.hasOwn(inputs,step.input),'WINDOWS_INPUT_REFERENCE_MISSING');
    for(const check of [...step.desktop.before,...step.desktop.after])if(check.kind==='field_equals')requireCondition(Object.hasOwn(inputs,check.input),'WINDOWS_CHECK_INPUT_MISSING');
    requireCondition(step.desktop.before.every(check=>check.kind!=='label_count_increased'),'WINDOWS_PRECONDITION_REQUIRES_STATIC_EVIDENCE');
    if(step.action==='replace_text')requireCondition(step.desktop.after.some(check=>check.kind==='field_equals'&&check.label===step.desktop.target.label&&check.role===step.desktop.target.role&&check.input===step.input),'WINDOWS_EXACT_READBACK_REQUIRED');
    if(step.effect==='external_send')requireCondition(step.desktop.after.some(check=>check.kind==='label_count_increased'),'WINDOWS_NEW_EFFECT_EVIDENCE_REQUIRED');
    if(index===0)requireCondition(window.controls.filter(c=>sameDesktopLabel(c,step.desktop.target)&&(c.enabled===true||(c.role==='visual'&&c.source==='windows_ocr'&&c.enabled===null))&&c.visible&&!c.sensitive).length===1,'WINDOWS_INITIAL_TARGET_UNOBSERVED');
    if(index===0)requireCondition(step.desktop.before.every(check=>check.kind==='field_equals'||window.controls.some(c=>sameDesktopLabel(c,check)&&c.visible&&!c.sensitive&&(check.kind!=='control_selected'||c.source==='uia'&&typeof c.selected==='boolean'&&c.selected===check.selected))),'WINDOWS_INITIAL_CONTEXT_UNOBSERVED');
  }
  const workflow:WindowsWorkflow={id:'windows.work.'+snapshotHash({proposal,family:spec.route.pack_family}).slice(0,32),version:1,
    title:proposal.title,family:spec.route.pack_family,applications:[...new Set(snapshot.windows.map(w=>w.application))],
    example:spec.desired_outcome,inputs:Object.fromEntries(Object.keys(inputs).map(key=>[key,'Work input'])),
    self_only:false,boundary:proposal.boundary,completion:proposal.completion,
    jev_value:'Select current bounded controls under the Pack decision policy; code checks scope, executes and verifies.',
    steps:proposal.steps.map(step=>({id:step.id,goal:step.goal,action:step.action,roles:[step.desktop.target.role],...(step.input?{input:step.input}:{}),
      effect:step.effect,requires:[step.id+'.context'],verifies:[step.id+'.result'],desktop:step.desktop})),
  };
  return {workflow,inputs};
}
