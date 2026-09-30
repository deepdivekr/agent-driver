import test from 'node:test';
import assert from 'node:assert/strict';
import {workProposalSchema,validateModelWorkProposal,validateWorkProposal} from '../dist/work/contracts.js';
import {hasBusinessStages,initialWorkPlan,validateWorkPlan} from '../dist/work/plan.js';

const base={title:'Public source review',desired_outcome:'Compare two requested public claims and provide a grounded summary.',completion_checks:[{id:'summary',result:'A grounded comparison is available',evidence:'Source citations and saved result'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const stages=[
  {id:'gather',goal:'Collect the two requested public claims',observable_outcome:'Both claim texts and source URLs are retained',depends_on:[],effect:'read_only',tool_hints:[]},
  {id:'compare',goal:'Compare the claims and produce a grounded summary',observable_outcome:'A comparison cites both retained sources and identifies any unresolved difference',depends_on:['gather'],effect:'draft_only',tool_hints:[]},
];
const model=(steps=stages)=>({...base,plan:{steps}});

test('new model definition schema requires bounded observable stages while stored legacy proposal remains readable',()=>{
  assert.equal(workProposalSchema.safeParse(base).success,false);
  assert.equal(workProposalSchema.safeParse(model([{...stages[0],observable_outcome:undefined}])).success,false);
  assert.equal(workProposalSchema.safeParse(model()).success,true);
  assert.equal(workProposalSchema.safeParse(model([stages[0]])).success,true,'A simple Work may use one meaningful stage');
  assert.equal(workProposalSchema.safeParse(model(Array.from({length:21},(_,index)=>({...stages[0],id:`stage_${index}`})))).success,false);
  const legacy=validateWorkProposal(base,'quick');
  assert.equal(legacy.plan.steps.length,1);
  assert.equal(hasBusinessStages(legacy.plan),false);
  assert.deepEqual(validateWorkPlan(initialWorkPlan(base.desired_outcome,'read_only')),legacy.plan);
});

test('model stages become a host-owned plan and model metadata or evidence cannot forge authority',()=>{
  const forged={...model(),plan:{format:1,revision:900,source:'pasted_import',source_id:'forged-import',source_digest:'a'.repeat(64),provenance:'unverified_external',steps:stages.map(step=>({...step,evidence_ids:['invented-receipt']}))}};
  const result=validateModelWorkProposal(forged,'quick');
  assert.equal(result.plan.source,'request');assert.equal(result.plan.source_id,null);assert.equal(result.plan.source_digest,null);
  assert.equal(result.plan.revision,1);assert.equal(result.plan.provenance,'user_request');
  assert.deepEqual(result.plan.steps.map(step=>step.evidence_ids),[[],[]]);
  assert.deepEqual(result.plan.steps.map(step=>step.depends_on),[[],['gather']]);
  assert.equal(hasBusinessStages(result.plan),true);
  assert.throws(()=>validateModelWorkProposal(model([{...stages[0],depends_on:['missing']}]),'quick'),/WORK_PLAN_DEPENDENCY_INVALID/u);
});

test('replanning preserves imported provenance, unchanged stage IDs and existing evidence only for the same stage contract',()=>{
  const prior=validateModelWorkProposal(model(),'quick');
  prior.plan={...prior.plan,source:'project_scan',source_id:'scan-1',source_digest:'b'.repeat(64),import_scope:'Only the requested project',import_mode:'observe',provenance:'observed_code_unverified_execution',steps:prior.plan.steps.map(step=>({...step,evidence_ids:['prior-receipt']}))};
  const updated=validateModelWorkProposal(model([stages[0],{...stages[1],observable_outcome:'A new requested comparison is retained'}]),'quick',false,prior);
  assert.equal(updated.plan.revision,2);assert.equal(updated.plan.source,'project_scan');assert.equal(updated.plan.source_id,'scan-1');assert.equal(updated.plan.source_digest,'b'.repeat(64));
  assert.equal(updated.plan.import_scope,'Only the requested project');assert.equal(updated.plan.import_mode,'observe');assert.equal(updated.plan.provenance,'observed_code_unverified_execution');
  assert.deepEqual(updated.plan.steps.map(step=>step.evidence_ids),[['prior-receipt'],[]]);
  const upstreamChanged=validateModelWorkProposal(model([{...stages[0],observable_outcome:'A revised source set is retained'},stages[1]]),'quick',false,prior);
  assert.deepEqual(upstreamChanged.plan.steps.map(step=>step.evidence_ids),[[],[]],'Changed upstream contract invalidates dependent evidence');
  assert.throws(()=>validateModelWorkProposal(model([{...stages[0],id:'renamed'},stages[1]]),'quick',false,prior),/WORK_PLAN_STEP_ID_CHANGED|WORK_PLAN_DEPENDENCY_INVALID/u);
  assert.throws(()=>validateModelWorkProposal(base,'quick',false,prior),/WORK_PLAN_REQUIRED_FOR_REPLAN/u,'A semantic replan cannot silently retain stages after an omitted model plan');
  const legacy=validateWorkProposal(base,'quick'),oldProvider=validateModelWorkProposal(base,'quick',false,legacy);
  assert.deepEqual(oldProvider.plan.steps,legacy.plan.steps,'A legacy omitted-plan redefinition does not erase existing steps');
  assert.equal(oldProvider.plan.revision,2);
});
