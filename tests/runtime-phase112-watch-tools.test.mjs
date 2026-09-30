import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {setTimeout as delay} from 'node:timers/promises';

const model={async call(){throw Error('No model permitted in this test');}};
const spec={title:'Isolated watch',desired_outcome:'Observe a source twice',completion_checks:[{id:'watch',result:'Reobserve the source',evidence:'Two source receipts'}],assumptions:[],route:{kind:'pack',pack_family:'monitor.watch'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Observe a source twice','read_only')};
const recipe={version:1,family:'monitor.watch',request:'Watch records',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id','title']};

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'office-watch-scope-'));
  const source=join(root,'records.json'),configPath=join(root,'host.json');
  await writeFile(source,JSON.stringify([{id:'one',title:'Initial'}]));
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'watch-scope-project',caller_ref:'watch-test',account_ref:'test-account',worktree:root,data_dir:join(root,'runtime'),environment:'production',packs:{models:'off',sources:[{id:'records',kind:'file',path:'records.json',format:'json'}],targets:[]}}));
  const config=loadHostConfig(configPath),api=new RuntimeApi(config),store=api.store,closers=[];initWorkExecution(store);
  t.after(async()=>{for(const close of closers.reverse())await close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  async function watch(label){
    const begun=store.beginWork(config.project.id,randomUUID(),`Watch ${label}`,'quick'),owner=store.claimWorkDefinition(config.project.id,begun.work.id);
    const work=store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
    const toolkit=new WorkExecutionTools(store,config,api,work.id,randomUUID(),spec,`Watch ${label}`,()=>{},model);t.after(()=>toolkit.close());
    const started=await api.call('runtime_pack_run',{request_id:`watch-${label}`,work_id:work.id,recipe:{...recipe,request:`Watch ${label}`}});
    assert.equal(started.status,'watching');
    return {work,toolkit,runId:started.run_id};
  }
  return {source,config,api,store,watch,closers};
}

test('runtime Work-scoped watch tick never runs other due watches or Pack recovery and an early tick remains pending',async t=>{
  const x=await setup(t),one=await x.watch('one'),two=await x.watch('two');
  const catalog=one.toolkit.catalog();for(const name of ['runtime_pack_watch_tick','runtime_pack_watch_pause','runtime_pack_events'])assert.ok(catalog.some(tool=>tool.name===name));
  assert.throws(()=>one.toolkit.validate('runtime_pack_watch_tick',{},'missing'),/WORK_WATCH_RUN_REQUIRED/);
  assert.throws(()=>one.toolkit.validate('runtime_pack_events',{after:0},'missing-events'),/WORK_WATCH_RUN_REQUIRED/);
  assert.throws(()=>one.toolkit.validate('runtime_pack_watch_tick',{run_id:two.runId},'foreign'),/WORK_TOOL_RUN_SCOPE_MISMATCH/);
  await assert.rejects(one.toolkit.execute('runtime_pack_watch_tick',{run_id:two.runId},'foreign-exec'),/WORK_TOOL_RUN_SCOPE_MISMATCH/);
  const early=await one.toolkit.execute('runtime_pack_watch_tick',{run_id:one.runId},'early');
  assert.equal(early.pending,true);assert.deepEqual(early.processed,[]);assert.equal(early.watch.cycle,0);assert.ok(Date.parse(early.ready_at)>Date.now());
  const earlyReceipt=await one.toolkit.receipt('runtime_pack_watch_tick',early,'early');assert.equal(earlyReceipt.effect_state,'none');assert.equal(earlyReceipt.status,'retryable_failure');assert.deepEqual(earlyReceipt.evidence_ids,[]);
  x.store.desktopState.prepare('UPDATE family_watch SET next_ms=? WHERE run_id IN (?,?)').run(Date.now()-1,one.runId,two.runId);
  await writeFile(x.source,JSON.stringify([{id:'one',title:'Changed'}]));
  const observed=await one.toolkit.execute('runtime_pack_watch_tick',{run_id:one.runId},'due');
  assert.equal(observed.pending,false);assert.deepEqual(observed.processed.map(item=>item.run_id),[one.runId]);
  assert.equal(observed.processed[0].status,'changed');assert.equal(observed.watch.cycle,1);
  const checkpoint=x.store.packExecution(x.config.project.id,one.runId).checkpoint;
  assert.equal(checkpoint.sources['0'].result.rows[0].title,'Initial');
  assert.equal(checkpoint.watch_tick.cycle,1);assert.equal(checkpoint.watch_tick.rows[0].title,'Changed');
  assert.equal(checkpoint.watch_tick.evidence[0].content_sha256,observed.processed[0].evidence[0].content_sha256);
  assert.equal((await one.toolkit.receipt('runtime_pack_watch_tick',observed,'due')).effect_state,'verified');
  assert.equal(x.store.watchState(x.config.project.id,two.runId).cycle,0);
  const ownEvents=await one.toolkit.execute('runtime_pack_events',{run_id:one.runId,after:0,limit:10},'events');
  assert.equal(ownEvents.events.length,1);assert.equal(ownEvents.events[0].run_id,one.runId);assert.equal(ownEvents.events[0].body.external_notifications_sent,0);
  const otherEvents=await two.toolkit.execute('runtime_pack_events',{run_id:two.runId,after:0,limit:10},'other-events');assert.deepEqual(otherEvents.events,[]);
  const paused=await one.toolkit.execute('runtime_pack_watch_pause',{run_id:one.runId,paused:true},'pause');
  assert.equal(paused.paused,true);assert.equal((await one.toolkit.receipt('runtime_pack_watch_pause',paused,'pause')).effect_state,'verified');
  assert.equal(x.store.watchState(x.config.project.id,two.runId).paused,false);
  const operator=await x.api.call('runtime_pack_watch_tick',{});assert.ok(operator.processed.some(item=>item.run_id===two.runId));
});

test('runtime native-clock fixture parks a not-due watch without failure retry cost, then resumes the same Work after due',async t=>{
  const x=await setup(t),work=await x.watch('automatic'),started=x.store.watchState(x.config.project.id,work.runId);
  assert.equal(started.cycle,0);
  // Accelerate only this fixture's scheduler to a real near-future instant.
  // No fake Date or simulated future tick is used; the live 60-second gate is separate.
  const ready=Date.now()+900;
  x.store.desktopState.prepare('UPDATE family_watch SET next_ms=? WHERE run_id=?').run(ready,work.runId);
  const calls=[],decision=(tool_name,arguments_json)=>({action:'tool',stage_id:null,tool_name,arguments_json:JSON.stringify(arguments_json),summary:`Use ${tool_name} on this Work only`,completed_checks:[],wait_reason:null});
  const selector={calls,async call(_purpose,instructions,input){
    assert.match(instructions,/Execute the registered Work/u);calls.push({at:Date.now(),observations:input.checkpoint.observations.length});
    const seen=input.checkpoint.observations.filter(item=>item.invocation.tool_name==='runtime_pack_watch_tick');
    if(seen.length===0||seen.at(-1).receipt.value.pending===true)return decision('runtime_pack_watch_tick',{run_id:work.runId});
    return {action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'One due observation is complete; inspect the bounded watch before final review.',completed_checks:[],wait_reason:'configuration'};
  }};
  const supervisor=new WorkSupervisor(x.store,x.config,selector,{tick_ms:25,api:x.api});x.closers.push(()=>supervisor.close());
  supervisor.start(work.work.id,work.work.revision,true);
  const waitFor=async(states)=>{for(let i=0;i<140;i++){const current=supervisorStatus(x.store,x.config.project.id,work.work.id);if(states.includes(current?.state))return current;await delay(25);}assert.fail(JSON.stringify(supervisorStatus(x.store,x.config.project.id,work.work.id)));};
  const parked=await waitFor(['retry_wait','failed','reconciliation_required']);
  assert.equal(parked.state,'retry_wait',JSON.stringify(parked));assert.equal(parked.reason,'WORK_CLIENT_WATCH_NOT_DUE');assert.equal(parked.attempts,0);
  assert.ok(parked.steps.some(step=>step.tool==='runtime_pack_watch_tick'&&step.status==='retryable_failure'));
  assert.equal(x.store.watchState(x.config.project.id,work.runId).cycle,0);
  const db=x.store.hermesState.prepare('SELECT retry_at_ms FROM office_supervisor WHERE run_id=?').get(parked.run_id);
  assert.equal(db.retry_at_ms,ready);assert.ok(Date.now()<ready);
  const resumed=await waitFor(['paused','failed','reconciliation_required']);
  assert.equal(resumed.state,'paused',JSON.stringify(resumed));assert.equal(resumed.run_id,parked.run_id);
  assert.equal(x.store.watchState(x.config.project.id,work.runId).cycle,1);
  const checkpoint=x.store.packExecution(x.config.project.id,work.runId).checkpoint;
  assert.equal(checkpoint.sources['0'].result.rows[0].title,'Initial');assert.equal(checkpoint.watch_tick.rows[0].title,'Initial');assert.equal(checkpoint.watch_tick.cycle,1);
  assert.equal(resumed.steps.filter(step=>step.tool==='runtime_pack_watch_tick').length,2);
  assert.equal(resumed.steps.at(-1).status,'succeeded');assert.equal(resumed.result.completion_verified,false);
  assert.equal((await x.api.call('runtime_pack_events',{run_id:work.runId,after:0,limit:10})).events.length,0);
  await x.api.call('runtime_pack_watch_pause',{run_id:work.runId,paused:true});
});

test('failed watch comparison field offers only observed names for a distinct Pack request with no baseline or effect',async t=>{
  const x=await setup(t),work=await x.watch('field-correction');
  const wrong={...recipe,request:'Watch an observed field',comparison_fields:['id','first_release']};
  const failed=await work.toolkit.execute('runtime_pack_run',{recipe:wrong},'watch-wrong-field');
  assert.equal(failed.status,'failed');assert.equal(failed.result.error,'WATCH_COMPARISON_FIELD_MISSING');
  assert.throws(()=>x.store.watchState(x.config.project.id,failed.run_id),/PACK_WATCH_NOT_FOUND/);
  const checkpoint=x.store.packExecution(x.config.project.id,failed.run_id).checkpoint;
  assert.deepEqual(checkpoint.sources['0'].result.rows,[{id:'one',title:'Initial'}]);
  const receipt=await work.toolkit.receipt('runtime_pack_run',failed,'watch-wrong-field');
  assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.effect_state,'none');assert.equal(receipt.retry_safe,false);
  assert.deepEqual(receipt.evidence_ids,[]);
  assert.equal(receipt.value.correction.kind,'source_contract');
  assert.deepEqual(receipt.value.correction.missing_fields,['first_release']);
  assert.deepEqual(receipt.value.correction.available_fields,['id','title']);
  assert.equal(receipt.value.correction.new_pack_request_required,true);
  const tampered=structuredClone(failed);tampered.result.error='SOURCE_NOT_DELEGATED';
  const untrusted=await work.toolkit.receipt('runtime_pack_run',tampered,'watch-wrong-field');
  assert.equal(untrusted.status,'failed');assert.equal(untrusted.value.correction,undefined);
  const approval=await work.toolkit.receipt('runtime_pack_run',{...failed,task_id:'unexpected-approval-task'},'watch-wrong-field');
  assert.equal(approval.status,'failed');assert.equal(approval.value.correction,undefined);
  x.store.scheduleWatch(failed.run_id,60_000,{digest:'untrusted-baseline',minima:{},error:null});
  const alreadyScheduled=await work.toolkit.receipt('runtime_pack_run',failed,'watch-wrong-field');
  assert.equal(alreadyScheduled.status,'failed');assert.equal(alreadyScheduled.value.correction,undefined);
  const corrected=await work.toolkit.execute('runtime_pack_run',{recipe:{...wrong,comparison_fields:['id','title']}},'watch-correct-field');
  assert.equal(corrected.status,'watching');assert.notEqual(corrected.run_id,failed.run_id);
  assert.equal(x.store.watchState(x.config.project.id,corrected.run_id).cycle,0);
  assert.equal(x.store.packRun(x.config.project.id,failed.run_id).status,'failed');
});
