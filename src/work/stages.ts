import {z} from 'zod';
import {type WorkPlan} from './plan.js';
import {hashJson} from '../taskpack/adaptive-spec.js';
import {requireCondition} from '../core/contracts.js';

const stageId=z.string().regex(/^[a-z][a-z0-9_]{0,39}$/u);
export const stageClaimSchema=z.object({stage_id:stageId,evidence_ids:z.array(z.string().min(1).max(128)).min(1).max(32)}).strict();
export const stageReportSchema=stageClaimSchema.extend({binding:z.string().regex(/^[a-f0-9]{64}$/u),reported_at:z.string().datetime()}).strict();
export type StageReport=z.infer<typeof stageReportSchema>;
export type StageClaim=z.infer<typeof stageClaimSchema>;
type Observation={invocation:{stage_id:string;stage_binding?:string|undefined};receipt:{status:string;evidence_ids:string[]}};

/** Legacy/imported plans remain displayable without pretending to have new execution bindings. */
export function businessSteps(plan:WorkPlan|undefined|null){
  return plan?.steps.length&&plan.steps.every(step=>typeof step.observable_outcome==='string'&&step.observable_outcome.trim())?plan.steps:[];
}
export function stageBinding(step:WorkPlan['steps'][number]){
  return hashJson({id:step.id,goal:step.goal,outcome:step.observable_outcome??null,depends_on:step.depends_on,effect:step.effect});
}
export function currentStageReports(plan:WorkPlan,reports:readonly StageReport[]=[]){
  const steps=businessSteps(plan);
  const matching=new Map(reports.filter(report=>steps.some(step=>step.id===report.stage_id&&stageBinding(step)===report.binding)).map(report=>[report.stage_id,report]));
  const valid=new Set<string>(),visiting=new Set<string>();
  const retain=(id:string):boolean=>{
    if(valid.has(id))return true;
    if(visiting.has(id)||!matching.has(id))return false;
    const step=steps.find(value=>value.id===id);if(!step)return false;
    visiting.add(id);const complete=step.depends_on.every(retain);visiting.delete(id);
    if(complete)valid.add(id);return complete;
  };
  return reports.filter(report=>matching.get(report.stage_id)===report&&retain(report.stage_id));
}
/** A host-accepted execution claim is NOT independent semantic/Work verification. */
export function acceptStageClaims(plan:WorkPlan,observations:readonly Observation[],prior:readonly StageReport[],claims:readonly StageClaim[],at=new Date().toISOString()):StageReport[]{
  const steps=businessSteps(plan),accepted=currentStageReports(plan,prior);
  requireCondition(new Set(claims.map(claim=>claim.stage_id)).size===claims.length,'WORK_CLIENT_STAGE_CLAIM_DUPLICATE');
  const byId=new Map(steps.map(step=>[step.id,step]));
  const depth=(id:string):number=>{const step=byId.get(id);return step?1+Math.max(0,...step.depends_on.map(depth)):0;};
  for(const claim of [...claims].sort((a,b)=>depth(a.stage_id)-depth(b.stage_id))){
    const step=steps.find(value=>value.id===claim.stage_id);
    requireCondition(step,'WORK_CLIENT_STAGE_UNKNOWN');
    requireCondition(step.depends_on.every(id=>accepted.some(report=>report.stage_id===id)),'WORK_CLIENT_STAGE_DEPENDENCY_PENDING');
    const binding=stageBinding(step),evidence=new Set(observations.filter(item=>item.invocation.stage_id===step.id&&item.invocation.stage_binding===binding&&item.receipt.status==='succeeded').flatMap(item=>item.receipt.evidence_ids));
    const previous=accepted.find(report=>report.stage_id===step.id);
    requireCondition(claim.evidence_ids.length>0&&claim.evidence_ids.every(id=>evidence.has(id)||previous?.evidence_ids.includes(id)),'WORK_CLIENT_STAGE_EVIDENCE_MISSING');
    const report={stage_id:step.id,binding,evidence_ids:[...new Set(claim.evidence_ids)],reported_at:previous?.reported_at??at};
    const index=accepted.findIndex(value=>value.stage_id===step.id);if(index<0)accepted.push(report);else accepted[index]=report;
  }
  return accepted;
}
export function assertStageDispatch(plan:WorkPlan,stage:string|null,reports:readonly StageReport[]){
  const step=businessSteps(plan).find(value=>value.id===stage);
  requireCondition(step,'WORK_CLIENT_STAGE_UNKNOWN');
  const accepted=currentStageReports(plan,reports);
  requireCondition(!accepted.some(report=>report.stage_id===step.id),'WORK_CLIENT_STAGE_ALREADY_COMPLETED');
  requireCondition(step.depends_on.every(id=>accepted.some(report=>report.stage_id===id)),'WORK_CLIENT_STAGE_DEPENDENCY_PENDING');
  return step;
}
