import test from 'node:test';
import assert from 'node:assert/strict';
import {LlmSwarmPlanner,STANDARD_RESEARCH_INSTRUCTIONS} from '../dist/swarm/planner.js';
import {swarmPlanSchema,validateSwarmPlanDraft} from '../dist/swarm/contracts.js';
import {decisionHash} from '../dist/decision-plane/index.js';

const goal='Read six bounded sources in parallel and return a grounded report.';
const limits={max_workers:24,max_concurrency:3,capabilities:[],mode:'standard',target_wall_ms:180000,hard_deadline_ms:240000,worker_timeout_ms:75000,synthesis_reserve_ms:35000,max_sources_per_worker:2};
function draft(){
  const sources=Array.from({length:6},(_,index)=>({id:`source-${index+1}`,role:'Read source',objective:`Read assigned source ${index+1}.`,stage:'source_read',source_urls:[`https://example.test/${index+1}`],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Observed source and fact cards.'],max_steps:8,timeout_ms:30000}));
  return {summary:'Collect, reduce and synthesize grounded facts.',workers:[...sources,{...sources[0],id:'reduce',role:'Reduce facts',objective:'Reduce predecessor fact cards.',stage:'reduction',source_urls:[],depends_on:sources.map(worker=>worker.id),timeout_ms:15000},{...sources[0],id:'synthesize',role:'Synthesize',objective:'Return final grounded content.',stage:'synthesis',source_urls:[],depends_on:['reduce'],timeout_ms:20000}]};
}
function modelFor(responses){
  const calls=[],received=[];
  return {calls,received,async call(purpose,instructions,input){
    const index=received.length;received.push({purpose,instructions,input:structuredClone(input)});
    const response=responses[index];calls.push({purpose,model:'fixture-budget',status:response instanceof Error?'failed':'accepted',elapsed_ms:1,input_sha256:decisionHash({instructions,input}),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});
    if(response instanceof Error)throw response;if(response===undefined)throw Error('UNEXPECTED_MODEL_CALL');return structuredClone(response);
  }};
}

test('runtime contract new Standard plans fix all shorter LLM worker budgets to the host profile after validation',async()=>{
  const proposed=draft(),original=structuredClone(proposed),model=modelFor([proposed]),plan=await new LlmSwarmPlanner(model).plan(goal,{},limits);
  assert.equal(model.calls.length,1);assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/host owns execution time budgets/u);
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/including reduction and synthesis/u);
  assert.ok(plan.workers.every(worker=>worker.timeout_ms===75000));assert.equal(plan.execution_profile.worker_timeout_ms,75000);
  assert.deepEqual(proposed,original);assert.deepEqual(plan.workers,original.workers.map(worker=>({...worker,timeout_ms:75000})));
  assert.deepEqual(plan.planner.worker_timeout_budget,{owner:'host',timeout_ms:75000,proposed_timeouts_sha256:decisionHash(original.workers.map(worker=>({worker_id:worker.id,timeout_ms:worker.timeout_ms})))});
  assert.equal(plan.planner.input_sha256,model.calls[0].input_sha256);assert.equal(plan.goal,goal);
  assert.equal(plan.execution_authority,false);assert.equal(plan.approval_granted,false);
});

test('runtime contract Standard timeout normalization honors the user host override without changing other limits',async()=>{
  const configured={...limits,worker_timeout_ms:50000,max_concurrency:2},model=modelFor([draft()]),plan=await new LlmSwarmPlanner(model).plan(goal,{},configured);
  assert.ok(plan.workers.every(worker=>worker.timeout_ms===50000));assert.equal(plan.planner.worker_timeout_budget.timeout_ms,50000);
  assert.equal(plan.execution_profile.worker_timeout_ms,50000);assert.equal(plan.execution_profile.hard_deadline_ms,configured.hard_deadline_ms);
  assert.equal(plan.max_concurrency,2);assert.equal(model.received[0].input.limits.worker_timeout_ms,50000);
});

test('runtime contract an above-host Standard proposal is rejected before normalization and cannot be silently clamped',async()=>{
  const invalid=draft();invalid.workers.find(worker=>worker.id==='reduce').timeout_ms=75001;
  assert.throws(()=>validateSwarmPlanDraft(invalid,limits),/SWARM_STANDARD_WORKER_TIMEOUT/u);
  const rejected=modelFor([invalid,invalid]);
  await assert.rejects(new LlmSwarmPlanner(rejected).plan(goal,{},limits),/SWARM_PLANNER_CORRECTION_FAILED_SWARM_STANDARD_WORKER_TIMEOUT/u);
  assert.deepEqual(rejected.calls.map(call=>call.purpose),['design','repair']);
  assert.equal(rejected.received[1].input.validation_error.code,'SWARM_STANDARD_WORKER_TIMEOUT');
  const repaired=modelFor([invalid,draft()]),plan=await new LlmSwarmPlanner(repaired).plan(goal,{},limits);
  assert.equal(repaired.calls.length,2);assert.ok(plan.workers.every(worker=>worker.timeout_ms===75000));
});

test('runtime contract generic non-Standard plans retain their individually proposed worker timeouts',async()=>{
  const proposed=draft(),model=modelFor([proposed]),plan=await new LlmSwarmPlanner(model).plan(goal,{}, {max_workers:24,max_concurrency:3,capabilities:[]});
  assert.deepEqual(plan.workers,proposed.workers);assert.equal(plan.research_mode,null);assert.equal(plan.execution_profile,null);
  assert.equal(plan.planner.worker_timeout_budget,undefined);assert.equal(model.calls.length,1);
});

test('runtime contract legacy saved Standard plans remain valid and parsing never rewrites their old timeouts',async()=>{
  const model=modelFor([draft()]),fresh=await new LlmSwarmPlanner(model).plan(goal,{},limits),legacy=structuredClone(fresh);
  delete legacy.planner.worker_timeout_budget;legacy.workers.find(worker=>worker.id==='reduce').timeout_ms=15000;legacy.workers.find(worker=>worker.id==='synthesize').timeout_ms=20000;
  const before=structuredClone(legacy),parsed=swarmPlanSchema.parse(legacy);
  assert.deepEqual(parsed,before);assert.deepEqual(legacy,before);assert.equal(parsed.planner.worker_timeout_budget,undefined);
});
