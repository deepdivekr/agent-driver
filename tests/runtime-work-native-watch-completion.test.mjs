import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';
import {createNativeCompletionResolver} from '../dist/work/native-completion.js';
import {nativeCompletionCheck} from '../dist/work/completion-checks.js';

const originalRows=[{id:'one',title:'Initial',route:'ICN-NRT',price:100}];
const baseRecipe={version:1,family:'monitor.watch',request:'Observe this specific source twice and keep changes local.',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id','title']};
const watchPredicate={version:1,kind:'native_watch_observations',family:'monitor.watch',mode:'any_change',value_field:null,comparison_fields:['id','title'],expected_change:'unchanged',minimum_elapsed_seconds:0};
const userRequest={prompt:'Observe the actual configured source twice and compare its values.',completion_condition:null,delivery_target_ids:null,user_directions:[]};

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'native-watch-completion-')),source=join(root,'records.json'),host=join(root,'host.json');
  await writeFile(source,JSON.stringify(originalRows));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'native-watch-completion',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'records',kind:'file',path:source,format:'json'}],targets:[]}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config),toolkits=[];initWorkExecution(api.store);
  t.after(async()=>{for(const toolkit of toolkits)await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  async function work(recipe=baseRecipe,predicate=watchPredicate){
    const checks=[nativeCompletionCheck('two_observations',predicate)],spec={title:'Specific local watch',desired_outcome:userRequest.prompt,completion_checks:checks,assumptions:[],route:{kind:'pack',pack_family:'monitor.watch'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(userRequest.prompt,'read_only')};
    const begun=api.store.beginWork(config.project.id,randomUUID(),userRequest.prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),saved=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
    const toolkit=new WorkExecutionTools(api.store,config,api,saved.id,randomUUID(),spec,userRequest.prompt,()=>{},{async call(){assert.fail('Native watch execution does not invoke a model.');}});toolkits.push(toolkit);
    const request=`baseline-${randomUUID()}`,value=await toolkit.execute('runtime_pack_run',{recipe},request);assert.equal(value.status,'watching');
    const baseline={invocation:{request_id:request,turn:0,stage_id:'baseline',tool_name:'runtime_pack_run',arguments:{recipe},effect:'local_write',dispatched:true},receipt:await toolkit.receipt('runtime_pack_run',value,request),observed_at:new Date().toISOString()};
    return {saved,toolkit,checks,runId:value.run_id,baseline,resolver:createNativeCompletionResolver(api.store,config,saved.id)};
  }
  async function tick(owner,rows=originalRows){
    await writeFile(source,JSON.stringify(rows));await delay(5);
    // Make only this fixture watch unambiguously due. A one-millisecond
    // Date.now() offset can become future-dated if the wall clock adjusts
    // between this write and the runtime's independent due-time read.
    // Source observations still use the actual clock, so a predicate
    // requiring 60 elapsed seconds must still fail in this fixture.
    const scheduled=api.store.hermesState.prepare('UPDATE family_watch SET next_ms=0 WHERE run_id=?').run(owner.runId);
    assert.equal(scheduled.changes,1);
    assert.equal(api.store.watchState(config.project.id,owner.runId).next_ms,0);
    assert.equal(api.store.dueWatches(config.project.id,Date.now(),owner.runId).length,1);
    const request=`tick-${randomUUID()}`,value=await owner.toolkit.execute('runtime_pack_watch_tick',{run_id:owner.runId},request);
    assert.equal(value.pending,false);
    const receipt=await owner.toolkit.receipt('runtime_pack_watch_tick',value,request);
    const observation={invocation:{request_id:request,turn:1,stage_id:'reobserve',tool_name:'runtime_pack_watch_tick',arguments:{run_id:owner.runId},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()};
    return {value,observation,ids:receipt.evidence_ids};
  }
  return {source,config,api,work,tick};
}
const completionClaim=(checks,ids)=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Only an executor claim.',wait_reason:null,completed_checks:checks.map(check=>({id:check.id,evidence_ids:ids}))});

test('a stable native watch proves two actual saved observations without an audit-model call, then checks the original goal',async t=>{
  const x=await setup(t),owner=await x.work(),tick=await x.tick(owner),audits=[],inputs=[];
  const execution=x.api.store.packExecution(x.config.project.id,owner.runId).checkpoint;
  assert.deepEqual(execution.sources['0'].result.rows,originalRows);assert.deepEqual(execution.watch_tick.rows,originalRows);
  assert.ok(Date.parse(execution.watch_tick.observed_at)>Date.parse(execution.sources['0'].result.evidence.observed_at));
  const model={calls:[],async call(purpose,_instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});inputs.push(structuredClone(input));
    assert.equal(input.checks[0].id,'original_user_request');assert.equal(input.original_user_request.prompt,userRequest.prompt);
    assert.ok(input.observations.some(item=>item.tool_name==='runtime_pack_run'));assert.ok(input.observations.some(item=>item.tool_name==='runtime_pack_watch_tick'));
    const id=tick.ids[0],record=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id)),ref=record.leaf_refs.find(([,path])=>path==='$/processed/0/status')[0];
    return {checks:[{id:input.checks[0].id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'Fixture original-goal verifier independently accepted the real pair of observations.'}]};
  }};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:userRequest,nativeResolver:owner.resolver,audit:event=>audits.push(event)})(owner.checks,[owner.baseline,tick.observation],completionClaim(owner.checks,tick.ids)),true);
  assert.equal(inputs.length,1);assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_NATIVE_VERIFIED'));
  assert.deepEqual(x.api.store.packEvents(x.config.project.id,0,10,owner.runId),[]);
});

test('native change proof binds the actual changed rows and matching local event; tampered event does not pass',async t=>{
  const x=await setup(t),predicate={...watchPredicate,expected_change:'changed'},owner=await x.work(baseRecipe,predicate),tick=await x.tick(owner,[{...originalRows[0],title:'Changed'}]);
  assert.equal(tick.value.processed[0].status,'changed');
  assert.equal((await owner.resolver(predicate,[owner.baseline,tick.observation],tick.ids)).verdict,'supported');
  const event=x.api.store.packEvents(x.config.project.id,0,10,owner.runId)[0];assert.equal(event.kind,'changed');
  const corrupted={...event.body,after:{...event.body.after,digest:'0'.repeat(64)}};
  x.api.store.hermesState.prepare('UPDATE family_event SET body=? WHERE id=?').run(JSON.stringify(corrupted),event.id);
  assert.equal((await owner.resolver(predicate,[owner.baseline,tick.observation],tick.ids)).verdict,'unknown');
});

test('minimum-decrease proof computes both no-drop and drop from real numeric source rows',async t=>{
  const x=await setup(t),recipe={...baseRecipe,mode:'minimum_decreases',comparison_fields:['route'],value_field:'price'},predicate={...watchPredicate,mode:'minimum_decreases',comparison_fields:['route'],value_field:'price'};
  const stable=await x.work(recipe,predicate),noDrop=await x.tick(stable,[{...originalRows[0],price:110}]);
  assert.equal(noDrop.value.processed[0].status,'unchanged');assert.equal((await stable.resolver(predicate,[stable.baseline,noDrop.observation],noDrop.ids)).verdict,'supported');
  await writeFile(x.source,JSON.stringify(originalRows));
  const changedPredicate={...predicate,expected_change:'changed'},changed=await x.work(recipe,changedPredicate),drop=await x.tick(changed,[{...originalRows[0],price:90}]);
  assert.equal(drop.value.processed[0].status,'changed');assert.equal((await changed.resolver(changedPredicate,[changed.baseline,drop.observation],drop.ids)).verdict,'supported');
  assert.equal((await changed.resolver({...changedPredicate,expected_change:'unchanged'},[changed.baseline,drop.observation],drop.ids)).verdict,'unsupported');
});

test('a baseline, early tick, current-cycle metadata or unelapsed spacing cannot fabricate two qualified observations',async t=>{
  const x=await setup(t),owner=await x.work(),early=await owner.toolkit.execute('runtime_pack_watch_tick',{run_id:owner.runId},'early-native-tick');
  assert.equal(early.pending,true);
  assert.equal((await owner.resolver(watchPredicate,[owner.baseline],owner.baseline.receipt.evidence_ids)).verdict,'unknown');
  const earlyReceipt=await owner.toolkit.receipt('runtime_pack_watch_tick',early,'early-native-tick');assert.equal(earlyReceipt.status,'retryable_failure');
  const tick=await x.tick(owner);
  assert.equal((await owner.resolver({...watchPredicate,minimum_elapsed_seconds:60},[owner.baseline,tick.observation],tick.ids)).verdict,'unsupported','Accelerated due scheduling cannot prove a real elapsed minute.');
  const checkpoint=x.api.store.packExecution(x.config.project.id,owner.runId).checkpoint;delete checkpoint.watch_tick;
  x.api.store.hermesState.prepare('UPDATE family_execution SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),owner.runId);
  assert.equal((await owner.resolver(watchPredicate,[owner.baseline,tick.observation],tick.ids)).verdict,'unknown');
});

test('foreign, wrong-cycle, stale-source and non-retained previous snapshot evidence remain unknown',async t=>{
  const x=await setup(t),owner=await x.work(),foreign=await x.work(),tick=await x.tick(owner);
  assert.equal((await foreign.resolver(watchPredicate,[owner.baseline,tick.observation],tick.ids)).verdict,'unknown');
  const wrong=structuredClone(tick.observation);wrong.receipt.value.processed[0].cycle=99;
  assert.equal((await owner.resolver(watchPredicate,[owner.baseline,wrong],tick.ids)).verdict,'unknown');
  await writeFile(x.source,JSON.stringify([{...originalRows[0],title:'Changed after the recorded tick'}]));
  assert.equal((await owner.resolver(watchPredicate,[owner.baseline,tick.observation],tick.ids)).verdict,'unknown');
  const second=await x.tick(owner,[{...originalRows[0],title:'A changed current observation'}]);
  assert.equal((await owner.resolver({...watchPredicate,expected_change:'changed'},[owner.baseline,second.observation],second.ids)).verdict,'supported');
  const third=await x.tick(owner,[{...originalRows[0],title:'A changed current observation'}]);
  assert.equal((await owner.resolver(watchPredicate,[owner.baseline,third.observation],third.ids)).verdict,'unknown','The previous changed tick rows were overwritten and may not be invented.');
});
