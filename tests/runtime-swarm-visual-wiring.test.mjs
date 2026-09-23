import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {LlmSwarmPlanner,LlmSwarmDecisionFallback} from '../dist/swarm/planner.js';

// Adapter fakes test the orchestration contract, not successful browser execution.
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const worker=(id,stage='source_read',depends_on=[])=>({id,role:id,objective:`Read and verify ${id}.`,stage,source_urls:stage==='source_read'?[`https://example.test/${id}`]:[],executor:'sub_agent',depends_on,required_capabilities:[],effect:'read_only',completion_evidence:['Independent source readback.'],max_steps:10,timeout_ms:60_000});
const draft=()=>{const sources=Array.from({length:6},(_,i)=>worker(`source-${i+1}`));return {summary:'Six evidence readers and bounded synthesis.',workers:[...sources,worker('reduce','reduction',sources.map(item=>item.id)),worker('synthesize','synthesis',['reduce'])]};};
const result=(id,url=`https://example.test/${id}`)=>({status:'succeeded',summary:`Evidence for ${id}.`,artifacts:[],evidence:[{source_url:url,claim:'Observed source content.',observed_at:new Date().toISOString(),verification:'source_reopen'}],fact_cards:[{claim:'Observed source content.',source_url:url,source_type:'article',observed_at:new Date().toISOString(),evidence_excerpt:'An actual bounded excerpt in a contract fixture.',verification:'source_reopen',freshness:'dated',contradiction_refs:[]}],readback:{verified:true,method:'source_reopen',evidence_sha256:'a'.repeat(64),observed_at:new Date().toISOString()}});

function fakeVisual({fail=null,closeBarrier=null}={}){
  return {assigned:[],released:[],commands:[],closed:false,
    async assign(runId,workerId,leaseToken){if(workerId===fail)throw Error('SWARM_VISUAL_CONTEXT_LIMIT');this.assigned.push({runId,workerId,leaseToken});return {surface_id:`surface-${workerId}`,kind:'browser'};},
    async perform(runId,workerId,leaseToken,command){this.commands.push({runId,workerId,leaseToken,command});return {url:'https://example.test/',title:'Contract fixture',text:'fixture',links:[],captured_at:new Date().toISOString(),surface_id:`surface-${workerId}`};},
    async release(runId,workerId){this.released.push({runId,workerId});},
    async close(){if(closeBarrier)await closeBarrier;this.closed=true;},
  };
}

async function setup(t,{visualEnabled=true,maxContexts=16,visual=fakeVisual(),getDraft=draft,qualityBarrier=null}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-swarm-visual-wiring-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'visual-test',caller_ref:'test-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true,max_logical_workers:24,max_concurrency:16,lease_ms:60_000,visual:{enabled:visualEnabled,max_contexts:maxContexts},standard:{max_concurrency:16}}}));
  const model={calls:[],async call(purpose,instructions,input){this.calls.push({purpose,model:'contract-model',elapsed_ms:1,input_sha256:sha({instructions,input}),status:'accepted'});if(purpose==='design')return getDraft();if(instructions.startsWith('Score each')){if(qualityBarrier)await qualityBarrier();return {relevance:4,evidence:4,usability:4};}return {choice:input.all_workers_verified?'COMPLETE':'CONTINUE'};}};
  const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:model,swarmProviders:{planner:new LlmSwarmPlanner(model),llm_fallback:new LlmSwarmDecisionFallback(model)},swarmVisual:visual});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {api,config,visual,model};
}
const start=api=>api.call('runtime_swarm_start',{request_id:'visual-research',goal:'Read independent assigned pages and synthesize.',context:{}});

test('visual dispatch automatically allocates one distinct surface per source worker',async t=>{
  const {api,visual}=await setup(t),run=await start(api);
  assert.equal(run.dispatches.length,6);assert.equal(visual.assigned.length,6);
  assert.equal(new Set(run.dispatches.map(item=>item.surface_id)).size,6);
  assert.ok(run.dispatches.every(item=>item.visual_status==='assigned'&&item.kind==='browser'));
  assert.ok(visual.assigned.every(item=>item.runId===run.run.run_id));
  for(const item of run.dispatches)await api.call('runtime_swarm_report',{run_id:item.run_id,worker_id:item.worker_id,lease_token:item.lease_token,report:result(item.worker_id)});
  const next=await api.call('runtime_swarm_tick',{run_id:run.run.run_id});
  assert.equal(next.dispatch.worker_id,'reduce');assert.equal(next.dispatch.surface_id,undefined);assert.equal(visual.assigned.length,6);
});

test('visual context ceiling is applied before leasing and the next batch is automatically assigned',async t=>{
  const {api,visual}=await setup(t,{maxContexts:2}),run=await start(api);
  assert.equal(run.plan.max_concurrency,2);assert.equal(run.dispatches.length,2);
  for(const item of run.dispatches)await api.call('runtime_swarm_report',{run_id:item.run_id,worker_id:item.worker_id,lease_token:item.lease_token,report:result(item.worker_id)});
  const next=await api.call('runtime_swarm_tick',{run_id:run.run.run_id});
  assert.equal(next.dispatches.length,2);assert.ok(next.dispatches.every(item=>item.visual_status==='assigned'));assert.equal(visual.assigned.length,4);
  assert.ok(visual.released.some(item=>item.workerId===run.dispatches[0].worker_id));
});

test('browser tool uses the delegated visual adapter and rejects unsupported script commands',async t=>{
  const {api,visual}=await setup(t),run=await start(api),lease=run.dispatches[0],binding={run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token};
  const observed=await api.call('runtime_swarm_browser',{...binding,command:{action:'navigate',url:'https://example.test/article'}});
  assert.equal(observed.surface_id,lease.surface_id);assert.equal(visual.commands.length,1);
  await assert.rejects(api.call('runtime_swarm_browser',{...binding,command:{action:'evaluate',script:'document.cookie'}}));
  assert.equal(visual.commands.length,1);
});

test('disabled visual execution is explicit and never invokes an injected adapter',async t=>{
  const {api,visual,config}=await setup(t,{visualEnabled:false}),run=await start(api),lease=run.dispatches[0];
  assert.equal(config.swarm.visual.enabled,false);assert.equal(visual.assigned.length,0);assert.equal(run.dispatch.surface_id,undefined);
  await assert.rejects(api.call('runtime_swarm_browser',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,command:{action:'observe'}}),/SWARM_VISUAL_NOT_ENABLED/);
});

test('an allocation failure returns only the five successfully assigned existing leases and preserves their surfaces',async t=>{
  const visual=fakeVisual({fail:'source-2'}),{api}=await setup(t,{visual}),run=await start(api);
  assert.equal(run.status,'needs_human');assert.equal(run.dispatch.worker_id,'source-1');assert.equal(run.dispatches.length,5);
  assert.ok(run.dispatches.every(item=>item.worker_id!=='source-2'&&item.visual_status==='assigned'&&item.surface_id));
  assert.deepEqual(run.visual_failures,[{worker_id:'source-2',error_code:'SWARM_VISUAL_CONTEXT_LIMIT'}]);
  const status=await api.call('runtime_swarm_status',{run_id:run.run.run_id});
  assert.equal(status.workers.find(item=>item.id==='source-2').status,'needs_human');assert.ok(visual.released.some(item=>item.workerId==='source-2'));
  assert.ok(run.dispatches.every(item=>!visual.released.some(released=>released.workerId===item.worker_id)));
  const lease=run.dispatches[0],accepted=await api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id)});
  assert.equal(accepted.workers.find(item=>item.id===lease.worker_id).status,'succeeded');assert.ok(visual.released.some(item=>item.workerId===lease.worker_id));
  assert.ok(run.dispatches.slice(1).every(item=>!visual.released.some(released=>released.workerId===item.worker_id)));
});

test('API review hold preserves a leased sibling screen and read operation, fences human handoff, then releases its settled screen',async t=>{
  const visual=fakeVisual(),active=new Set(),assign=visual.assign.bind(visual),perform=visual.perform.bind(visual),release=visual.release.bind(visual);
  visual.assign=async(...args)=>{const surface=await assign(...args);active.add(args[1]);return surface;};
  visual.perform=async(...args)=>{assert.ok(active.has(args[1]),'API must not release a still-leased sibling before its read');return perform(...args);};
  visual.release=async(...args)=>{active.delete(args[1]);return release(...args);};
  const {api,config}=await setup(t,{maxContexts:2,visual}),run=await start(api),[a,b]=run.dispatches;
  api.swarm.providers.llm_fallback.workflow=async()=> 'HUMAN_REVIEW';
  const held=await api.call('runtime_swarm_report',{run_id:a.run_id,worker_id:a.worker_id,lease_token:a.lease_token,report:result(a.worker_id)});
  assert.equal(held.status,'needs_human');assert.equal(held.workers.find(item=>item.id===b.worker_id).status,'leased');
  assert.equal(active.has(a.worker_id),false);assert.equal(active.has(b.worker_id),true);assert.equal(visual.released.some(item=>item.workerId===b.worker_id),false);
  assert.throws(()=>api.store.claimBrowserHandoff(config.project.id,config.project.profileRef,'example.test'),/AUTH_WAIT_FOR_ACTIVE_WORKERS/);
  const observed=await api.call('runtime_swarm_browser',{run_id:b.run_id,worker_id:b.worker_id,lease_token:b.lease_token,command:{action:'observe'}});
  assert.equal(observed.surface_id,b.surface_id);assert.equal(visual.commands.at(-1).workerId,b.worker_id);
  const settled=await api.call('runtime_swarm_report',{run_id:b.run_id,worker_id:b.worker_id,lease_token:b.lease_token,report:result(b.worker_id)});
  assert.equal(settled.workers.find(item=>item.id===b.worker_id).status,'succeeded');assert.equal(active.has(b.worker_id),false);assert.ok(visual.released.some(item=>item.workerId===b.worker_id));
  assert.equal(active.size,0);api.store.claimBrowserHandoff(config.project.id,config.project.profileRef,'example.test');
  assert.equal(api.store.browserAuthEntries(config.project.id,config.project.profileRef)[0].handoff,1);
});

test('concurrent reports and ticks serialize per run while quality judgment awaits',async t=>{
  let release,entered;const ready=new Promise(resolve=>{entered=resolve;}),barrier=new Promise(resolve=>{release=resolve;});let first=true;
  const {api}=await setup(t,{maxContexts:2,qualityBarrier:async()=>{if(first){first=false;entered();await barrier;}}}),run=await start(api),[a,b]=run.dispatches;
  const firstReport=api.call('runtime_swarm_report',{run_id:a.run_id,worker_id:a.worker_id,lease_token:a.lease_token,report:result(a.worker_id)});
  await ready;
  const secondReport=api.call('runtime_swarm_report',{run_id:b.run_id,worker_id:b.worker_id,lease_token:b.lease_token,report:result(b.worker_id)}),tick=api.call('runtime_swarm_tick',{run_id:a.run_id});
  release();const results=await Promise.all([firstReport,secondReport,tick]);
  assert.equal(results[1].workers.filter(item=>item.status==='succeeded').length,2);
  assert.equal(results[2].dispatches.length,2);
  const status=await api.call('runtime_swarm_status',{run_id:a.run_id});assert.equal(status.workers.filter(item=>item.status==='succeeded').length,2);
});

test('standard fact cards accept trusted observed worker URLs but reject unrelated URLs',async t=>{
  const {api}=await setup(t),run=await start(api),lease=run.dispatches[0],article='https://example.test/discovered-article';
  api.store.observedUrls=(_project,runId,workerId)=>runId===lease.run_id&&workerId===lease.worker_id?[article]:[];
  await assert.rejects(api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id,'https://example.test/unobserved')}),/SWARM_STANDARD_FACT_CARD_SOURCE_MISMATCH/);
  const accepted=await api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id,article)});
  assert.equal(accepted.workers.find(item=>item.id===lease.worker_id).status,'succeeded');
});

test('managed surface activity must belong to the exact active run and worker',async t=>{
  const {api}=await setup(t),run=await start(api),[a,b]=run.dispatches;
  api.store.controlSurfaces=()=>[{id:a.surface_id,run_id:a.run_id,worker_id:a.worker_id,state:'active'}];
  const activity={kind:'observing',summary:'Observed assigned browser.',endpoint:'https://example.test',surface_id:a.surface_id,decision_layer:'code'};
  const recorded=await api.call('runtime_swarm_activity',{run_id:a.run_id,worker_id:a.worker_id,lease_token:a.lease_token,activity});assert.equal(recorded.recorded,true);
  await assert.rejects(api.call('runtime_swarm_activity',{run_id:b.run_id,worker_id:b.worker_id,lease_token:b.lease_token,activity}),/CONTROL_SURFACE_UNDELEGATED/);
});

test('decision activity lights Jev only at an actual provider call and identifies its worker before LLM fallback',async t=>{
  const {api}=await setup(t),run=await start(api),lease=run.dispatches[0];let calls=0;
  api.store.controlSurfaces=()=>[{id:lease.surface_id,run_id:lease.run_id,worker_id:lease.worker_id,state:'active'}];
  const events=()=>api.store.swarmActivities(api.config.project.id,0,1000).filter(item=>item.kind==='worker.activity'&&item.worker_id===lease.worker_id);
  assert.equal(events().some(item=>item.body.decision_layer==='jev'),false);
  api.swarm.providers.decision={id:'contract-jev',async systemOne(){calls++;const event=events().at(-1);assert.equal(event.body.decision_layer,'jev');assert.equal(event.body.surface_id,lease.surface_id);throw Error('CONTRACT_PROVIDER_UNAVAILABLE');}};
  await api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id)});
  const layers=events().map(item=>item.body.decision_layer);
  assert.equal(calls,2);assert.deepEqual(layers,['jev','code','llm','code','jev','code','llm','code']);
  assert.ok(events().every(item=>item.run_id===lease.run_id&&item.body.surface_id===lease.surface_id));
});

test('Jev-free reports produce LLM and code activity but never a fabricated Jev stage',async t=>{
  const {api}=await setup(t),run=await start(api),lease=run.dispatches[0];
  await api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id)});
  const layers=api.store.swarmActivities(api.config.project.id,0,1000).filter(item=>item.kind==='worker.activity'&&item.worker_id===lease.worker_id).map(item=>item.body.decision_layer);
  assert.deepEqual(layers,['llm','code','llm','code']);
});

test('a rejected Jev workflow judgment reaches LLM review instead of silently defaulting to continue',async t=>{
  const {api}=await setup(t),run=await start(api),lease=run.dispatches[0];let workflowCalls=0;
  api.swarm.providers.decision={id:'contract-invalid-jev',async systemOne(){return {model:'contract-invalid',answers:{}};}};
  api.swarm.providers.llm_fallback.workflow=async()=>{workflowCalls++;return 'HUMAN_REVIEW';};
  const reported=await api.call('runtime_swarm_report',{run_id:lease.run_id,worker_id:lease.worker_id,lease_token:lease.lease_token,report:result(lease.worker_id)});
  assert.equal(workflowCalls,1);assert.equal(reported.status,'needs_human');assert.ok(reported.reviews.some(item=>item.reason==='Workflow selected HUMAN_REVIEW.'));
});

test('close remains idempotent, waits for visual cleanup before closing store, and blocks new calls',async t=>{
  let release;const barrier=new Promise(resolve=>{release=resolve;}),visual=fakeVisual({closeBarrier:barrier}),{api}=await setup(t,{visual});await start(api);
  api.close();api.close();assert.equal(visual.closed,false);assert.ok(api.store.controlSurfaces(api.config.project.id));
  await assert.rejects(api.call('runtime_swarm_status',{run_id:'00000000-0000-4000-8000-000000000000'}),/RUNTIME_API_CLOSED/);
  release();await api.drain();assert.equal(visual.closed,true);
});
