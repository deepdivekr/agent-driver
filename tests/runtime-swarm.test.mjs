import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {validateSwarmPlanDraft,SWARM_DECISION_CATALOG} from '../dist/swarm/index.js';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const worker=(id,depends_on=[],effect='read_only')=>({id,role:`${id} role`,objective:`Complete ${id} from bounded evidence.`,executor:'sub_agent',depends_on,required_capabilities:[],effect,completion_evidence:[`Independent evidence for ${id}.`],max_steps:12,timeout_ms:60_000});

function modelFor(getDraft,{quality=4}={}){
  const calls=[];
  return {calls,async call(purpose,instructions,input){
    calls.push({purpose,model:'fixture-llm',elapsed_ms:1,input_sha256:sha({instructions,input}),status:'accepted'});
    if(purpose==='design')return getDraft();
    if(instructions.startsWith('Choose one currently'))return {choice:input.candidates[0]??'NONE'};
    if(instructions.startsWith('Score each'))return {relevance:quality,evidence:quality,usability:quality};
    return {choice:input.all_workers_verified?'COMPLETE':'CONTINUE'};
  }};
}

function jev(){return {async systemOne(request){
  const answers={};
  for(const [name,question] of Object.entries(request.questions)){
    const keys=Array.isArray(question.criteria)?question.criteria.map((_,index)=>String(index)):Object.keys(question.criteria??{});
    if(question.type==='choice'){
      const choice=name==='next_step'?(request.state.all_workers_verified?'COMPLETE':'CONTINUE'):keys.find(key=>!['NONE','REVIEW'].includes(key))??'NONE';
      answers[name]={type:'choice',choice,confidence:.99,probabilities:Object.fromEntries(keys.map(key=>[key,key===choice?.99:(.01/(keys.length-1||1))]))};
    }else answers[name]={type:'score',score:4,confidence:.99,legend:Object.fromEntries(keys.map(key=>[key,question.criteria[Number(key)]])),probabilities:Object.fromEntries(keys.map(key=>[key,key==='4'?.99:.0025]))};
  }
  return {model:'fixture-jev',answers};
}};}

async function setup(t,{draft,quality=4,maxWorkers=8,maxConcurrency=2,withJev=true}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-swarm-')),path=join(root,'host.json'),raw={schema_version:1,project_id:'swarm-project',caller_ref:'swarm-agent',account_ref:'local-account',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true,max_logical_workers:maxWorkers,max_concurrency:maxConcurrency,lease_ms:30_000}};
  await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),model=modelFor(()=>draft,{quality}),api=new RuntimeApi(config,{swarmModel:model,...(withJev?{swarmJev:jev()}:{})});
  t.after(async()=>{api.close();await rm(root,{recursive:true,force:true});});return {api,config,model};
}

const report=id=>({status:'succeeded',summary:`${id} completed with direct evidence.`,artifacts:[{kind:'result',ref:`artifact://${id}`,sha256:'a'.repeat(64),summary:'bounded result'}],readback:{verified:true,method:'independent_readback',evidence_sha256:'b'.repeat(64),observed_at:new Date().toISOString()},error_code:null});

test('swarm mode requires an LLM-created multi-worker DAG, dispatches separate sub-agent leases and completes only after readback',async t=>{
  const x=await setup(t,{draft:{summary:'Research then independently verify.',workers:[worker('research'),worker('verify',['research'])]}}),planned=await x.api.call('runtime_swarm_plan',{goal:'Find and verify the bounded answer.',context:{domain:'fixture'}});
  assert.equal(planned.plan.planner.kind,'llm');assert.equal(planned.plan.workers.length,2);assert.equal(planned.execution_started,false);assert.equal(planned.plan.execution_authority,false);
  const run=await x.api.call('runtime_swarm_run',{request_id:'swarm-one',plan_id:planned.plan.plan_id}),first=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  assert.equal(first.dispatch.worker_id,'research');assert.equal(first.dispatch.spawn_sub_agent_required,true);assert.equal(first.dispatch.decider,'jev');assert.equal(first.workers.find(item=>item.id==='research').lease_token,'redacted');
  const afterFirst=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'research',lease_token:first.dispatch.lease_token,report:report('research')});assert.equal(afterFirst.status,'running');
  const second=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(second.dispatch.worker_id,'verify');
  const complete=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'verify',lease_token:second.dispatch.lease_token,report:report('verify')});assert.equal(complete.status,'completed');assert.ok(complete.workers.every(item=>item.quality.accepted));assert.equal(complete.approval_granted,false);
  const persisted=await x.api.call('runtime_swarm_status',{run_id:run.run_id});assert.equal(persisted.status,'completed');assert.ok(persisted.decision_events.length>=6);
});

test('swarm mode refuses silent single-agent downgrade and invalid or over-broad task graphs',async t=>{
  assert.throws(()=>validateSwarmPlanDraft({summary:'single',workers:[worker('one')]},{max_workers:8,capabilities:[]}));
  assert.throws(()=>validateSwarmPlanDraft({summary:'cycle',workers:[worker('one',['two']),worker('two',['one'])]},{max_workers:8,capabilities:[]}),/SWARM_PLAN_CYCLE/);
  assert.throws(()=>validateSwarmPlanDraft({summary:'capability',workers:[{...worker('one'),required_capabilities:['undelegated']},worker('two')]},{max_workers:8,capabilities:[]}),/SWARM_PLAN_CAPABILITY_NOT_DELEGATED/);
  const x=await setup(t,{draft:{summary:'valid',workers:[worker('one'),worker('two')]}});x.api.swarm.providers.planner=undefined;x.api.swarm.providers.llm_fallback=undefined;
  await assert.rejects(x.api.call('runtime_swarm_plan',{goal:'Must decompose.',context:{}}),/SWARM_LLM_PLANNER_REQUIRED/);
});

test('300 logical workers remain a bounded queue and never imply 300 concurrent processes',async t=>{
  const workers=Array.from({length:300},(_,index)=>worker(`w${String(index).padStart(3,'0')}`)),x=await setup(t,{draft:{summary:'Large logical task graph.',workers},maxWorkers:300,maxConcurrency:4,withJev:false}),planned=await x.api.call('runtime_swarm_plan',{goal:'Partition a large read-only corpus.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'large-swarm',plan_id:planned.plan.plan_id});
  assert.equal(planned.plan.workers.length,300);const dispatched=[];for(let i=0;i<4;i++)dispatched.push((await x.api.call('runtime_swarm_tick',{run_id:run.run_id})).dispatch);
  assert.equal(new Set(dispatched.map(item=>item.worker_id)).size,4);assert.ok(dispatched.every(item=>item.decider==='llm'));
  const limited=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(limited.dispatch,null);assert.equal(limited.reason,'CONCURRENCY_LIMIT');assert.equal(limited.workers.filter(item=>item.status==='leased').length,4);
});

test('weak artifacts and unverified success fail closed',async t=>{
  const external=await setup(t,{draft:{summary:'Read then publish.',workers:[worker('read'),worker('publish',['read'],'external_effect')]},quality:1,withJev:false}),planned=await external.api.call('runtime_swarm_plan',{goal:'Prepare a draft and request publication approval.',context:{}}),run=await external.api.call('runtime_swarm_run',{request_id:'guarded',plan_id:planned.plan.plan_id}),first=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});
  await assert.rejects(external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:{...report('read'),readback:null}}));
  const weak=await external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:report('read')});assert.equal(weak.status,'needs_human');assert.ok(weak.reviews.some(item=>item.kind==='quality'));
  const replanned=await external.api.call('runtime_swarm_replan',{run_id:run.run_id,reason:'Artifact evidence needs a different verification task.'});assert.equal(replanned.status,'planned');assert.notEqual(replanned.plan.plan_id,planned.plan.plan_id);assert.equal(replanned.execution_started,false);
  assert.equal(SWARM_DECISION_CATALOG.judgments.map(item=>item.id).includes('dispatch.next_actor'),true);assert.equal(SWARM_DECISION_CATALOG.judgments.map(item=>item.id).includes('workflow.next_step'),true);
});

test('external effects enter the human exception queue and expired leases are never blindly retried',async t=>{
  const external=await setup(t,{draft:{summary:'Read then publish.',workers:[worker('read'),worker('publish',['read'],'external_effect')]},withJev:false}),planned=await external.api.call('runtime_swarm_plan',{goal:'Prepare a draft and request publication approval.',context:{}}),run=await external.api.call('runtime_swarm_run',{request_id:'external-guard',plan_id:planned.plan.plan_id}),first=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});
  await external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:report('read')});
  const held=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(held.dispatch,null);assert.equal(held.status,'needs_human');assert.ok(held.reviews.some(item=>item.kind==='external_effect'&&item.worker_id==='publish'));

  const stale=await setup(t,{draft:{summary:'Two independent reads.',workers:[worker('one'),worker('two')]},withJev:false}),stalePlan=await stale.api.call('runtime_swarm_plan',{goal:'Run bounded reads.',context:{}}),staleRun=await stale.api.call('runtime_swarm_run',{request_id:'stale-lease',plan_id:stalePlan.plan.plan_id}),leased=await stale.api.call('runtime_swarm_tick',{run_id:staleRun.run_id});
  const expired=await stale.api.swarm.tick(staleRun.run_id,leased.dispatch.lease_expires_at_ms);assert.equal(expired.status,'needs_human');assert.ok(expired.reviews.some(item=>item.kind==='lease_expired'));await assert.rejects(stale.api.call('runtime_swarm_report',{run_id:staleRun.run_id,worker_id:leased.dispatch.worker_id,lease_token:leased.dispatch.lease_token,report:report('late')}),/SWARM_RUN_NOT_ACTIVE/);
});
