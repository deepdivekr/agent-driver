import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {validateSwarmPlanDraft,SWARM_DECISION_CATALOG} from '../dist/swarm/index.js';
import {readSwarmDashboard} from '../dist/swarm/dashboard.js';

const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const worker=(id,depends_on=[],effect='read_only',extra={})=>({id,role:`${id} role`,objective:`Complete ${id} from bounded evidence.`,executor:'sub_agent',depends_on,required_capabilities:[],effect,completion_evidence:[`Independent evidence for ${id}.`],max_steps:12,timeout_ms:60_000,...extra});
const standardDraft=(sourceCount=6)=>{
  const sources=Array.from({length:sourceCount},(_,index)=>worker(`source-${index+1}`,[],'read_only',{stage:'source_read',source_urls:[`https://example.test/source-${index+1}`]}));
  return {summary:'Read six independent sources, reduce fact cards, then synthesize.',workers:[...sources,worker('reduce',sources.map(item=>item.id),'read_only',{stage:'reduction'}),worker('synthesize',['reduce'],'read_only',{stage:'synthesis'})]};
};

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

const report=id=>({status:'succeeded',summary:`${id} completed with direct evidence.`,artifacts:[{kind:'result',ref:`artifact://${id}`,sha256:'a'.repeat(64),summary:'bounded result'}],evidence:[{source_url:`https://example.test/${id}`,claim:`Direct evidence for ${id}.`,observed_at:new Date().toISOString(),verification:'source_reopen'}],readback:{verified:true,method:'independent_readback',evidence_sha256:'b'.repeat(64),observed_at:new Date().toISOString()},error_code:null});
const sourceReport=id=>({...report(id),fact_cards:[{claim:`Verified claim from ${id}.`,source_url:`https://example.test/${id}`,source_type:'official_documentation',observed_at:new Date().toISOString(),evidence_excerpt:`Bounded excerpt for ${id}.`,verification:'source_reopen',freshness:'current',contradiction_refs:[]}]});

test('on-time reports survive internal quality queue delay while genuinely late reports remain fenced',async t=>{
  const x=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16,withJev:false});
  const start=await x.api.call('runtime_swarm_start',{request_id:'queue-delay',goal:'Research bounded sources.',context:{}});
  let unblock,entered;const gate=new Promise(r=>unblock=r),inside=new Promise(r=>entered=r);
  const original=x.model.call.bind(x.model);let first=true;
  x.model.call=async(...args)=>{if(first&&args[1].startsWith('Score each')){first=false;entered();await gate;}return original(...args);};
  const send=d=>x.api.call('runtime_swarm_report',{run_id:start.run.run_id,worker_id:d.worker_id,lease_token:d.lease_token,report:sourceReport(d.worker_id)});
  const a=send(start.dispatches[0]);await inside;
  const b=send(start.dispatches[1]);
  const realNow=Date.now,late=realNow()+31_000;
  try{Date.now=()=>late;unblock();await Promise.all([a,b]);
    const state=await x.api.call('runtime_swarm_status',{run_id:start.run.run_id});
    assert.equal(state.workers.find(w=>w.id===start.dispatches[1].worker_id).status,'succeeded');
    await assert.rejects(send(start.dispatches[2]),/STALE_SWARM_LEASE/);
  }finally{Date.now=realNow;unblock();}
});

test('standard start defaults to an eight-worker URL plan and leases all safe source workers in one batch',async t=>{
  const x=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16}),started=await x.api.call('runtime_swarm_start',{request_id:'standard-start',goal:'Research six bounded sources and synthesize the verified result.',context:{}});
  assert.equal(started.mode,'standard');assert.equal(started.plan.research_mode,'standard');assert.equal(started.plan.workers.length,8);
  assert.equal(started.run.target_deadline_at_ms-started.run.started_at_ms,180_000);assert.equal(started.run.hard_deadline_at_ms-started.run.started_at_ms,240_000);assert.equal(started.run.synthesis_reserve_ms,35_000);
  assert.equal(started.dispatches.length,6);assert.equal(started.dispatch.worker_id,started.dispatches[0].worker_id);assert.ok(started.dispatches.every(item=>item.stage==='source_read'&&item.source_urls.length===1&&item.timeout_ms<=75_000&&item.effect==='read_only'));
  assert.equal(started.run.workers.filter(item=>item.status==='leased').length,0); // start returns the pre-batch run snapshot separately
  const status=await x.api.call('runtime_swarm_status',{run_id:started.run.run_id});assert.equal(status.workers.filter(item=>item.status==='leased').length,6);
});

test('read-only technical failures retry once with new leases and never turn an exhausted model timeout into human approval',async t=>{
  const x=await setup(t,{draft:{summary:'Two independent reads.',workers:[worker('one'),worker('two')]},withJev:false});
  const plan=await x.api.call('runtime_swarm_plan',{goal:'Recover a transient provider failure.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'technical-retry',plan_id:plan.plan.plan_id}),batch=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  const one=batch.dispatches.find(d=>d.worker_id==='one'),two=batch.dispatches.find(d=>d.worker_id==='two');
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'two',lease_token:two.lease_token,report:report('two')});
  const failure={status:'failed',summary:'Provider timed out.',error_code:'STRUCTURED_MODEL_UNAVAILABLE'};
  const pending=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:one.lease_token,report:failure});
  assert.equal(pending.status,'running');assert.equal(pending.reviews.length,0);assert.equal(pending.workers.find(w=>w.id==='one').status,'pending');
  const retry=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(retry.dispatches.length,1);assert.notEqual(retry.dispatch.lease_token,one.lease_token);
  await assert.rejects(x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:one.lease_token,report:report('one')}),/STALE_SWARM_LEASE/);
  const failed=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:retry.dispatch.lease_token,report:failure});
  assert.equal(failed.status,'failed');assert.equal(failed.reviews.length,0);assert.equal(failed.workers.find(w=>w.id==='one').attempts,2);assert.equal(failed.workers.find(w=>w.id==='two').status,'succeeded');
});

test('authentication requests are not classified as retryable technical failures',async t=>{
  const x=await setup(t,{draft:{summary:'Two independent reads.',workers:[worker('one'),worker('two')]},withJev:false});
  const plan=await x.api.call('runtime_swarm_plan',{goal:'Respect a genuine authentication boundary.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'auth-no-retry',plan_id:plan.plan.plan_id}),batch=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  const held=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:batch.dispatch.lease_token,report:{status:'needs_human',summary:'Authentication is required.',error_code:'BROWSER_AUTH_REQUIRED'}});
  assert.equal(held.status,'needs_human');assert.equal(held.workers.find(w=>w.id==='one').status,'needs_human');
});

test('a transient read worker failure resumes the same run and completes dependent work without replaying its sibling',async t=>{
  const x=await setup(t,{draft:{summary:'Read two sources and combine.',workers:[worker('one'),worker('two'),worker('combine',['one','two'])]},withJev:false});
  const plan=await x.api.call('runtime_swarm_plan',{goal:'Recover then combine preserved source evidence.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'retry-completes',plan_id:plan.plan.plan_id}),batch=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  const one=batch.dispatches.find(d=>d.worker_id==='one'),two=batch.dispatches.find(d=>d.worker_id==='two');
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'two',lease_token:two.lease_token,report:report('two')});
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:one.lease_token,report:{status:'failed',summary:'Transient model timeout.',error_code:'CLIENT_TIMEOUT'}});
  const retry=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.deepEqual(retry.dispatches.map(d=>d.worker_id),['one']);
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:retry.dispatch.lease_token,report:report('one')});
  const combine=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(combine.dispatch.worker_id,'combine');
  const completed=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'combine',lease_token:combine.dispatch.lease_token,report:report('combine')});
  assert.equal(completed.run_id,run.run_id);assert.equal(completed.status,'completed');assert.equal(completed.workers.find(w=>w.id==='two').attempts,1);assert.equal(completed.workers.find(w=>w.id==='one').attempts,2);assert.equal(completed.reviews.length,0);
});

test('a read-only quality rejection gets one LLM correction with unchanged acceptance thresholds and preserved feedback',async t=>{
  const x=await setup(t,{draft:{summary:'Read and synthesize.',workers:[worker('one'),worker('final',['one'])]},withJev:false});
  const original=x.model.call.bind(x.model);let rejected=false;
  x.model.call=async(purpose,instructions,input,...rest)=>{if(instructions.startsWith('Score each')&&input.worker.id==='final'&&!rejected){rejected=true;return {relevance:3,evidence:3,usability:2};}return original(purpose,instructions,input,...rest);};
  const plan=await x.api.call('runtime_swarm_plan',{goal:'Produce a useful verified digest.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'quality-correction',plan_id:plan.plan.plan_id}),first=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:first.dispatch.lease_token,report:report('one')});
  const final=await x.api.call('runtime_swarm_tick',{run_id:run.run_id}),held=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'final',lease_token:final.dispatch.lease_token,report:report('final')});
  const feedback=held.workers.find(w=>w.id==='final');assert.equal(held.status,'running');assert.equal(feedback.status,'pending');assert.equal(feedback.quality.accepted,false);assert.equal(feedback.quality.required_score,.75);assert.equal(feedback.quality.dimensions.usability,.5);
  const correction=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(correction.dispatch.worker_id,'final');assert.notEqual(correction.dispatch.lease_token,final.dispatch.lease_token);
  const complete=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'final',lease_token:correction.dispatch.lease_token,report:report('final')});assert.equal(complete.status,'completed');assert.equal(complete.workers.find(w=>w.id==='final').quality.required_score,.75);
});

test('final quality receives real upstream coverage without using upstream success to override a weak final artifact',async t=>{
  const x=await setup(t,{draft:{summary:'Read and synthesize.',workers:[worker('one',[],'read_only',{stage:'source_read',source_urls:['https://example.test/one']}),worker('final',['one'],'read_only',{stage:'synthesis'})]},withJev:false});
  const original=x.model.call.bind(x.model),inspected=[];
  x.model.call=async(purpose,instructions,input,...rest)=>{if(instructions.startsWith('Score each')&&input.worker.id==='final'){inspected.push(input);return {relevance:1,evidence:1,usability:1};}return original(purpose,instructions,input,...rest);};
  const plan=await x.api.call('runtime_swarm_plan',{goal:'Observe the source, then produce a relevant result.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'upstream-quality-state',plan_id:plan.plan.plan_id}),first=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  x.api.store.recordObservedUrl(x.config.project.id,run.run_id,'one',first.dispatch.lease_token,'https://example.test/one');
  await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'one',lease_token:first.dispatch.lease_token,report:sourceReport('one')});
  for(let attempt=0;attempt<2;attempt++){const final=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'final',lease_token:final.dispatch.lease_token,report:report('final')});}
  assert.equal(inspected.length,2);assert.deepEqual(inspected[0].upstream_coverage,[{worker_id:'one',stage:'source_read',status:'succeeded',source_urls:['https://example.test/one'],observed_urls:['https://example.test/one'],readback_verified:true,fact_cards_count:1}]);
  const state=await x.api.call('runtime_swarm_status',{run_id:run.run_id});assert.equal(state.status,'needs_human');assert.equal(state.workers.find(w=>w.id==='final').quality.accepted,false);assert.equal(state.workers.find(w=>w.id==='final').quality.required_score,.75);
});

test('leased worker activity updates the dashboard endpoint without exposing query, userinfo or lease authority',async t=>{
  const x=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16}),started=await x.api.call('runtime_swarm_start',{request_id:'activity-heartbeat',goal:'Research bounded sources.',context:{}}),lease=started.dispatches[0];
  const activity=await x.api.call('runtime_swarm_activity',{run_id:started.run.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,activity:{kind:'navigating',summary:'Opening the assigned primary source.',endpoint:'https://user:pass@example.test/source/token/abcdefghijklmnopqrstuvwxyz012345?q=private#part'}});
  assert.equal(activity.recorded,true);assert.equal(activity.endpoint,'https://example.test/source/token/:redacted');assert.equal(activity.execution_authority,false);assert.equal(activity.approval_granted,false);
  const view=readSwarmDashboard(x.api.store,x.config.project.id),worker=view.runs[0].workers.find(item=>item.id===lease.worker_id);assert.equal(worker.current_activity,'navigating');assert.equal(worker.current_endpoint,'https://example.test/source/token/:redacted');assert.doesNotMatch(JSON.stringify(view),/user:pass|q=private|lease_token/u);
  await assert.rejects(x.api.call('runtime_swarm_activity',{run_id:started.run.run_id,worker_id:lease.worker_id,lease_token:'00000000-0000-4000-8000-000000000000',activity:{kind:'observing',summary:'Observe.',endpoint:null}}),/STALE_SWARM_LEASE/);
  await assert.rejects(x.api.call('runtime_swarm_activity',{run_id:started.run.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,activity:{kind:'observing',summary:'Use sk-proj-abcdefghijklmnop.',endpoint:null}}),/CREDENTIAL_LIKE_INPUT/);
});

test('standard batch leases exactly sixteen of eighteen dependency-ready workers at the configured concurrency ceiling',async t=>{
  const x=await setup(t,{draft:standardDraft(16),maxWorkers:24,maxConcurrency:16}),started=await x.api.call('runtime_swarm_start',{request_id:'standard-sixteen',goal:'Research sixteen independent bounded sources.',context:{}});
  assert.equal(started.plan.workers.length,18);assert.equal(started.dispatches.length,16);assert.equal(new Set(started.dispatches.map(item=>item.worker_id)).size,16);assert.ok(started.dispatches.every(item=>item.stage==='source_read'));
  const status=await x.api.call('runtime_swarm_status',{run_id:started.run.run_id});assert.equal(status.workers.filter(item=>item.status==='leased').length,16);assert.equal(status.workers.filter(item=>item.status==='pending').length,2);
});

test('standard start rejects a three-worker plan while the compatible generic plan API still accepts it',async t=>{
  const draft={summary:'Legacy generic graph.',workers:[worker('one'),worker('two'),worker('three')]},x=await setup(t,{draft,maxWorkers:24,maxConcurrency:16});
  await assert.rejects(x.api.call('runtime_swarm_start',{request_id:'too-small-standard',goal:'Research broadly.',context:{}}),/SWARM_STANDARD_MIN_WORKERS/);
  const generic=await x.api.call('runtime_swarm_plan',{goal:'Run a generic bounded graph.',context:{}});assert.equal(generic.plan.workers.length,3);assert.equal(generic.plan.research_mode,null);
});

test('standard validation caps each source worker at two URLs',()=>{
  const draft=standardDraft();draft.workers[0].source_urls.push('https://example.test/extra-1','https://example.test/extra-2');
  assert.throws(()=>validateSwarmPlanDraft(draft,{max_workers:24,capabilities:[],mode:'standard',worker_timeout_ms:75_000,max_sources_per_worker:2}),/SWARM_STANDARD_SOURCE_URL_LIMIT/);
});

test('standard source reports require typed fact cards bound to one of the assigned URLs',async t=>{
  const x=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16}),started=await x.api.call('runtime_swarm_start',{request_id:'fact-card-contract',goal:'Research bounded sources.',context:{}}),first=started.dispatches[0];
  await assert.rejects(x.api.call('runtime_swarm_report',{run_id:started.run.run_id,worker_id:first.worker_id,lease_token:first.lease_token,report:report(first.worker_id)}),/SWARM_STANDARD_FACT_CARD_REQUIRED/);
  const accepted=await x.api.call('runtime_swarm_report',{run_id:started.run.run_id,worker_id:first.worker_id,lease_token:first.lease_token,report:sourceReport(first.worker_id)});assert.equal(accepted.workers.find(item=>item.id===first.worker_id).status,'succeeded');
});

test('synthesis reserve stops new source reads and a hard deadline ends as partial evidence, never completed',async t=>{
  const x=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16}),planned=await x.api.swarm.plan('Research within the standard deadline.',{},'standard'),run=x.api.swarm.run('deadline-standard',planned.plan.plan_id);
  const reserve=await x.api.swarm.batchTick(run.run_id,run.hard_deadline_at_ms-30_000);assert.equal(reserve.dispatches.length,1);assert.equal(reserve.dispatch.stage,'reduction');assert.equal(reserve.workers.filter(item=>item.status==='skipped_deadline').length,6);
  await x.api.swarm.report(run.run_id,'reduce',reserve.dispatch.lease_token,report('reduce'));
  const synthesis=await x.api.swarm.batchTick(run.run_id);assert.equal(synthesis.dispatch.stage,'synthesis');
  const partial=await x.api.swarm.report(run.run_id,'synthesize',synthesis.dispatch.lease_token,report('synthesize'));assert.equal(partial.status,'partial_evidence');assert.notEqual(partial.status,'completed');

  const y=await setup(t,{draft:standardDraft(),maxWorkers:24,maxConcurrency:16}),started=await y.api.call('runtime_swarm_start',{request_id:'hard-deadline',goal:'Research until the hard deadline.',context:{}}),expired=await y.api.swarm.batchTick(started.run.run_id,started.run.hard_deadline_at_ms);
  assert.equal(expired.status,'partial_evidence');assert.equal(expired.dispatches.length,0);assert.equal(expired.reason,'HARD_DEADLINE_EXCEEDED');assert.ok(expired.reviews.some(item=>item.kind==='deadline'));
});

test('swarm mode requires an LLM-created multi-worker DAG, dispatches separate sub-agent leases and completes only after readback',async t=>{
  const x=await setup(t,{draft:{summary:'Research then independently verify.',workers:[worker('research'),worker('verify',['research'])]}}),planned=await x.api.call('runtime_swarm_plan',{goal:'Find and verify the bounded answer.',context:{domain:'fixture'}});
  assert.equal(planned.plan.planner.kind,'llm');assert.equal(planned.plan.workers.length,2);assert.equal(planned.execution_started,false);assert.equal(planned.plan.execution_authority,false);
  const run=await x.api.call('runtime_swarm_run',{request_id:'swarm-one',plan_id:planned.plan.plan_id}),first=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});
  assert.equal(first.dispatch.worker_id,'research');assert.equal(first.dispatch.spawn_sub_agent_required,true);assert.equal(first.dispatch.decider,'code');assert.equal(first.workers.find(item=>item.id==='research').lease_token,'redacted');
  const afterFirst=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'research',lease_token:first.dispatch.lease_token,report:report('research')});assert.equal(afterFirst.status,'running');
  const second=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(second.dispatch.worker_id,'verify');
  const complete=await x.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'verify',lease_token:second.dispatch.lease_token,report:report('verify')});assert.equal(complete.status,'completed');assert.ok(complete.workers.every(item=>item.quality.accepted));assert.equal(complete.approval_granted,false);
  const persisted=await x.api.call('runtime_swarm_status',{run_id:run.run_id});assert.equal(persisted.status,'completed');assert.ok(persisted.decision_events.length>=4);
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
  assert.equal(planned.plan.workers.length,300);const first=await x.api.call('runtime_swarm_tick',{run_id:run.run_id}),dispatched=first.dispatches;
  assert.equal(dispatched.length,4);assert.equal(first.dispatch.worker_id,dispatched[0].worker_id);assert.equal(new Set(dispatched.map(item=>item.worker_id)).size,4);assert.ok(dispatched.every(item=>item.decider==='code'));
  const limited=await x.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(limited.dispatch,null);assert.equal(limited.reason,'CONCURRENCY_LIMIT');assert.equal(limited.workers.filter(item=>item.status==='leased').length,4);
});

test('weak artifacts and unverified success fail closed',async t=>{
  const external=await setup(t,{draft:{summary:'Read then publish.',workers:[worker('read'),worker('publish',['read'],'external_effect')]},quality:1,withJev:false}),planned=await external.api.call('runtime_swarm_plan',{goal:'Prepare a draft and request publication approval.',context:{}}),run=await external.api.call('runtime_swarm_run',{request_id:'guarded',plan_id:planned.plan.plan_id}),first=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});
  await assert.rejects(external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:{...report('read'),readback:null}}));
  const weak=await external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:{...report('read'),evidence:[]}});assert.equal(weak.status,'needs_human');assert.ok(weak.reviews.some(item=>item.kind==='quality'));
  const replanned=await external.api.call('runtime_swarm_replan',{run_id:run.run_id,reason:'Artifact evidence needs a different verification task.'});assert.equal(replanned.status,'planned');assert.notEqual(replanned.plan.plan_id,planned.plan.plan_id);assert.equal(replanned.execution_started,false);
  assert.equal(SWARM_DECISION_CATALOG.judgments.map(item=>item.id).includes('dispatch.next_actor'),true);assert.equal(SWARM_DECISION_CATALOG.judgments.map(item=>item.id).includes('workflow.next_step'),true);
});

test('external effects enter the human exception queue and expired leases are never blindly retried',async t=>{
  const external=await setup(t,{draft:{summary:'Read then publish.',workers:[worker('read'),worker('publish',['read'],'external_effect')]},withJev:false}),planned=await external.api.call('runtime_swarm_plan',{goal:'Prepare a draft and request publication approval.',context:{}}),run=await external.api.call('runtime_swarm_run',{request_id:'external-guard',plan_id:planned.plan.plan_id}),first=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});
  await external.api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:'read',lease_token:first.dispatch.lease_token,report:report('read')});
  const held=await external.api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(held.dispatch,null);assert.equal(held.status,'needs_human');assert.ok(held.reviews.some(item=>item.kind==='external_effect'&&item.worker_id==='publish'));
  await assert.rejects(external.api.call('runtime_swarm_recover',{run_id:run.run_id}),/SWARM_RECOVERY_REQUIRES_REVIEW/);

  const stale=await setup(t,{draft:{summary:'Two independent reads.',workers:[worker('one'),worker('two')]},withJev:false}),stalePlan=await stale.api.call('runtime_swarm_plan',{goal:'Run bounded reads.',context:{}}),staleRun=await stale.api.call('runtime_swarm_run',{request_id:'stale-lease',plan_id:stalePlan.plan.plan_id}),leased=await stale.api.call('runtime_swarm_tick',{run_id:staleRun.run_id});
  const expired=await stale.api.swarm.tick(staleRun.run_id,leased.dispatch.lease_expires_at_ms);assert.equal(expired.status,'needs_human');assert.ok(expired.reviews.some(item=>item.kind==='lease_expired'));await assert.rejects(stale.api.call('runtime_swarm_report',{run_id:staleRun.run_id,worker_id:leased.dispatch.worker_id,lease_token:leased.dispatch.lease_token,report:report('late')}),/STALE_SWARM_LEASE/);
  const recovered=await stale.api.call('runtime_swarm_recover',{run_id:staleRun.run_id});assert.equal(recovered.status,'running');
  const fresh=await stale.api.call('runtime_swarm_tick',{run_id:staleRun.run_id});assert.notEqual(fresh.dispatch.lease_token,leased.dispatch.lease_token);
  await assert.rejects(stale.api.call('runtime_swarm_report',{run_id:staleRun.run_id,worker_id:leased.dispatch.worker_id,lease_token:leased.dispatch.lease_token,report:report('late')}),/STALE_SWARM_LEASE/);
  await stale.api.swarm.tick(staleRun.run_id,fresh.dispatch.lease_expires_at_ms);
  await assert.rejects(stale.api.call('runtime_swarm_recover',{run_id:staleRun.run_id}),/SWARM_RECOVERY_UNSAFE_OR_EXHAUSTED/);
});

test('batchTick leases read-only work but never batches external or irreversible effects',async t=>{
  const x=await setup(t,{draft:{summary:'Safe reads plus guarded effects.',workers:[worker('read-one'),worker('read-two'),worker('publish',[],'external_effect'),worker('commit',[],'irreversible')]},maxConcurrency:4,withJev:false}),planned=await x.api.call('runtime_swarm_plan',{goal:'Separate safe reads from guarded effects.',context:{}}),run=await x.api.call('runtime_swarm_run',{request_id:'batch-effect-guard',plan_id:planned.plan.plan_id}),batch=await x.api.swarm.batchTick(run.run_id);
  assert.deepEqual(batch.dispatches.map(item=>item.worker_id),['read-one','read-two']);assert.ok(batch.dispatches.every(item=>item.effect==='read_only'));
  const status=await x.api.call('runtime_swarm_status',{run_id:run.run_id});assert.equal(status.workers.find(item=>item.id==='publish').status,'pending');assert.equal(status.workers.find(item=>item.id==='commit').status,'pending');
});
