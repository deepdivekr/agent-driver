import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {LlmSwarmPlanner,STANDARD_RESEARCH_INSTRUCTIONS} from '../dist/swarm/planner.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {structuredModelFromEnvironment} from '../dist/integrations/model-provider.js';

const goal='Read six assigned sources in parallel, preserve their citations and provide a TXT report in this Work.';
const limits={max_workers:24,max_concurrency:8,capabilities:['research'],mode:'standard',target_wall_ms:180000,hard_deadline_ms:240000,worker_timeout_ms:75000,synthesis_reserve_ms:35000,max_sources_per_worker:2};
const draft=()=>{
  const sources=Array.from({length:6},(_,index)=>({id:`source-${index+1}`,role:'Read one bounded source',objective:`Read source ${index+1} and return grounded fact cards.`,stage:'source_read',source_urls:[`https://example.test/source-${index+1}`],executor:'sub_agent',depends_on:[],required_capabilities:['research'],effect:'read_only',completion_evidence:['Observed source excerpt and source URL.'],max_steps:12,timeout_ms:75000}));
  return {summary:'Read sources, reduce their grounded facts, and synthesize report content.',workers:[...sources,{...sources[0],id:'reduce',role:'Reduce evidence',objective:'Reduce supplied fact cards, preserving sources and contradictions.',stage:'reduction',source_urls:[],depends_on:sources.map(worker=>worker.id)},{...sources[0],id:'synthesize',role:'Synthesize report',objective:'Return report content for the host supervisor to save and deliver.',stage:'synthesis',source_urls:[],depends_on:['reduce']}]};
};
const invalidWriteDraft=()=>{const value=draft();value.workers.at(-1).effect='local_write';value.workers.at(-1).objective='Save the requested TXT file.';return value;};
function modelFor(responses){
  const calls=[],received=[];
  return {calls,received,async call(purpose,instructions,input,schema){
    const index=received.length;received.push({purpose,instructions,input:structuredClone(input),schema});
    const response=responses[index];
    const status=response instanceof Error?'failed':'accepted';
    calls.push({purpose,model:index===0?'fixture-design':'fixture-correction',elapsed_ms:1,status,input_sha256:createHash('sha256').update(JSON.stringify({instructions,input,schema})).digest('hex'),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});
    if(response instanceof Error)throw response;
    if(response===undefined)throw Error('UNEXPECTED_EXTRA_MODEL_CALL');
    return structuredClone(response);
  }};
}

test('runtime contract Standard instructions reserve all worker effects for read-only evidence and host result delivery',async()=>{
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/EVERY worker.*read_only/u);
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/including discovery, verification, reduction and synthesis/u);
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/host Work supervisor/u);
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/Do not add an output-file or delivery worker/u);
  const model=modelFor([draft()]),plan=await new LlmSwarmPlanner(model).plan(goal,{output_delivery:'app TXT'},limits);
  assert.equal(model.calls.length,1);assert.equal(plan.goal,goal);assert.equal(plan.workers.length,8);
  assert.ok(plan.workers.every(worker=>worker.effect==='read_only'));
  assert.equal(plan.execution_authority,false);assert.equal(plan.approval_granted,false);
});

test('runtime contract actual Standard local-write synthesis error receives one output-only correction with unchanged bounds',async()=>{
  const original=invalidWriteDraft(),corrected=draft(),model=modelFor([original,corrected]);
  const context={output_delivery:'Office persists and delivers verified TXT'};
  const plan=await new LlmSwarmPlanner(model).plan(goal,context,limits);
  assert.deepEqual(model.calls.map(call=>call.purpose),['design','repair']);
  const repair=model.received[1];assert.equal(repair.input.validation_error.code,'SWARM_STANDARD_READ_ONLY_REQUIRED');
  assert.deepEqual(repair.input.original_input,model.received[0].input);assert.equal(repair.input.original_input.goal,goal);
  assert.deepEqual(repair.input.original_input.delegated_capabilities,limits.capabilities);
  assert.equal(repair.input.original_input.limits.max_workers,limits.max_workers);assert.equal(repair.input.original_input.limits.worker_timeout_ms,limits.worker_timeout_ms);
  assert.match(repair.instructions,/Do not execute tools, contact sources, save files, deliver messages, grant approval/u);
  assert.deepEqual(plan.workers.flatMap(worker=>worker.source_urls),original.workers.flatMap(worker=>worker.source_urls));
  assert.ok(plan.workers.every(worker=>worker.effect==='read_only'));
  assert.equal(plan.planner.model,'fixture-correction');assert.equal(plan.planner.input_sha256,model.calls[1].input_sha256);
  assert.equal(plan.goal,goal);assert.equal(plan.max_concurrency,limits.max_concurrency);
  assert.equal(plan.execution_authority,false);assert.equal(plan.approval_granted,false);
});

test('runtime contract malformed received Swarm schema is repaired once without replaying any source',async()=>{
  const model=modelFor([{summary:'Missing worker array.'},draft()]);
  const plan=await new LlmSwarmPlanner(model).plan(goal,{},limits);
  assert.equal(plan.workers.length,8);assert.equal(model.calls.length,2);
  assert.equal(model.received[1].input.validation_error.code,'SWARM_PLAN_SCHEMA_INVALID');
  assert.equal(model.received[1].input.original_input.goal,goal);
});

test('runtime contract a second invalid Swarm draft stops after exactly one correction',async()=>{
  for(const second of [invalidWriteDraft(),{summary:'Still missing workers.'}]){
    const model=modelFor([invalidWriteDraft(),second,draft()]);
    await assert.rejects(new LlmSwarmPlanner(model).plan(goal,{},limits),/SWARM_PLANNER_CORRECTION_FAILED_SWARM_STANDARD_READ_ONLY_REQUIRED/u);
    assert.equal(model.calls.length,2);assert.equal(model.received.length,2);
  }
});

test('runtime contract whole-DAG repair keeps the design-sized API budget and identical schema for every provider',async()=>{
  for(const provider of ['openai','anthropic','openrouter','openai_compatible']){
    const bodies=[],responses=[invalidWriteDraft(),draft()];
    const fetcher=async(_url,request)=>{
      bodies.push(JSON.parse(request.body));const value=responses[bodies.length-1];assert.ok(value);
      const text=JSON.stringify(value),raw=provider==='openai'?{status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}:provider==='anthropic'?{stop_reason:'end_turn',content:[{type:'text',text}]}:{choices:[{finish_reason:'stop',message:{content:text}}]};
      return {ok:true,status:200,json:async()=>raw};
    };
    const model=structuredModelFromEnvironment({AGENT_DRIVER_API_PROVIDER:provider,AGENT_DRIVER_API_KEY:'fixture-provider-key-not-real-123456',AGENT_DRIVER_API_MODEL:'fixture-model',...(provider==='openai_compatible'?{AGENT_DRIVER_API_BASE_URL:'http://127.0.0.1:65532/v1'}:{})},fetcher);
    const plan=await new LlmSwarmPlanner(model).plan(goal,{output_delivery:'host TXT'},limits);
    assert.deepEqual(model.calls.map(call=>call.purpose),['design','repair']);assert.equal(bodies.length,2);
    for(const body of bodies)assert.equal(body.max_output_tokens??body.max_tokens,5000);
    const schema=body=>provider==='openai'?body.text.format.schema:provider==='anthropic'?body.output_config.format.schema:body.response_format.json_schema.schema;
    assert.deepEqual(schema(bodies[1]),schema(bodies[0]));assert.equal(plan.workers.length,8);
    assert.ok(plan.workers.every(worker=>worker.effect==='read_only'));assert.equal(plan.execution_authority,false);
  }
});

test('runtime contract initial provider authentication and quota failures never enter Swarm output correction',async()=>{
  for(const code of ['AUTH_REQUIRED','QUOTA_EXHAUSTED','STRUCTURED_MODEL_UNAVAILABLE','SWARM_STANDARD_READ_ONLY_REQUIRED']){
    const failure=Error(code),model=modelFor([failure,draft()]);
    await assert.rejects(new LlmSwarmPlanner(model).plan(goal,{},limits),error=>error===failure);
    assert.equal(model.calls.length,1);assert.equal(model.calls[0].purpose,'design');
  }
  const failure=Error('AUTH_REQUIRED'),model=modelFor([invalidWriteDraft(),failure,draft()]);
  await assert.rejects(new LlmSwarmPlanner(model).plan(goal,{},limits),error=>error===failure);
  assert.equal(model.calls.length,2);assert.equal(model.calls[1].status,'failed');
});

test('runtime contract Swarm output correction cannot expand delegated capabilities budgets or effects',async()=>{
  for(const broaden of [
    value=>value.workers[0].required_capabilities.push('undelegated'),
    value=>value.workers[0].timeout_ms=75001,
    value=>value.workers[0].source_urls.push('https://example.test/extra-a','https://example.test/extra-b'),
    value=>value.workers[0].effect='external_effect',
  ]){
    const corrected=draft();broaden(corrected);const model=modelFor([invalidWriteDraft(),corrected]);
    await assert.rejects(new LlmSwarmPlanner(model).plan(goal,{},limits),/SWARM_PLANNER_CORRECTION_FAILED_/u);
    assert.equal(model.calls.length,2);assert.deepEqual(model.received[1].input.original_input.delegated_capabilities,limits.capabilities);
  }
});

test('runtime contract a failed model receipt or secret-like invalid data cannot masquerade as an accepted Swarm plan',async()=>{
  const received=invalidWriteDraft();received.api_key='sk-proj-abcdefghijklmnopqrstuvwxyz1234567890';
  const model=modelFor([received,draft()]);
  await new LlmSwarmPlanner(model).plan(goal,{},limits);
  assert.doesNotMatch(model.received[1].input.invalid_output,/sk-proj-abcdefghijklmnopqrstuvwxyz1234567890/u);
  const bad=modelFor([received,draft()]),call=bad.call.bind(bad);
  bad.call=async(...args)=>{const value=await call(...args);bad.calls.at(-1).status='failed';return value;};
  await assert.rejects(new LlmSwarmPlanner(bad).plan(goal,{},limits),/SWARM_LLM_PLANNER_REQUIRED/u);
  assert.equal(bad.calls.length,1);
});

test('runtime fixture invalid Swarm drafts are neither stored nor started and only the corrected proposal persists',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-swarm-planner-correction-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'planner-correction',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true,max_logical_workers:24,max_concurrency:8}}));
  const responses=[invalidWriteDraft(),invalidWriteDraft(),invalidWriteDraft(),draft()];
  for(const response of responses)for(const worker of response.workers)worker.required_capabilities=[];
  const model=modelFor(responses),api=new RuntimeApi(loadHostConfig(path),{swarmModel:model});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const count=table=>Number(api.store.connection.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get().total);
  await assert.rejects(api.swarm.start('invalid-start',goal,{},'standard'),/SWARM_PLANNER_CORRECTION_FAILED_/u);
  assert.equal(count('swarm_plan'),0);assert.equal(count('swarm_run'),0);
  const accepted=await api.swarm.plan(goal,{output_delivery:'app TXT'},'standard');
  assert.equal(accepted.execution_started,false);assert.equal(count('swarm_plan'),1);assert.equal(count('swarm_run'),0);
  const persisted=JSON.parse(api.store.connection.prepare('SELECT body FROM swarm_plan').get().body);
  assert.ok(persisted.workers.every(worker=>worker.effect==='read_only'));assert.equal(persisted.goal,goal);
  assert.equal(persisted.execution_authority,false);assert.equal(persisted.approval_granted,false);assert.equal(model.calls.length,4);
});
