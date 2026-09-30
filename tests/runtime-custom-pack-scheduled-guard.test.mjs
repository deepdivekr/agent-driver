import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {nativeCompletionCheck} from '../dist/work/completion-checks.js';
import {validateWorkProposal} from '../dist/work/contracts.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {supervisorStatus} from '../dist/work/supervisor.js';
import {assertCustomPackScheduledRun} from '../dist/work/custom-pack-schedule.js';
import {changeWorkLifecycle} from '../dist/work/lifecycle.js';
import {PACK_ENGINE_VERSION} from '../dist/packs/runtime.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const prompt='Save the two current records as numeric JSON, preserving both original rows.';
const recipe={version:1,family:'file.pipeline',request:prompt,sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],columns:['id','score'],numeric_columns:['score'],sort:null,format:'json'};
const predicate={version:1,kind:'native_pack_output',family:'file.pipeline',format:'json',columns:['id','score'],output_rows:2,numeric_columns:['score'],sort:null};
const action=(tool,args)=>({action:'tool',stage_id:'work',tool_name:tool,arguments_json:JSON.stringify(args),summary:'Execute the pinned procedure on this cycle input.',wait_reason:null,completed_checks:[]});

async function until(get){
  for(let i=0;i<300;i++){const value=get();if(value)return value;await delay(10);}
  assert.fail('Fixture did not reach its expected state.');
}
const terminal=x=>workId=>until(()=>{const status=supervisorStatus(x.api.store,x.config.project.id,workId);return status&&!['queued','running','retry_wait'].includes(status.state)?status:null;});

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'custom-pack-scheduled-guard-')),source=join(root,'rows.json'),host=join(root,'host.json');
  await writeFile(source,JSON.stringify([{id:'A',score:'3'},{id:'B',score:'5'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'scheduled-guard',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:source,format:'json'}],targets:[]}}));
  const model={calls:[],goalCalls:0,rejectGoal:false,invalidDecision:false,holdNextPack:false,nextTool:null,heldWork:null,release:null,async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',elapsed_ms:0});
    if(instructions.startsWith('Independently verify')){
      this.goalCalls++;
      assert.deepEqual(input.checks.map(check=>check.id),['original_user_request']);
      assert.equal(input.original_user_request.prompt,prompt);
      if(this.rejectGoal)return {checks:[{id:'original_user_request',verdict:'unsupported',evidence_ids:[],evidence_quote_refs:[],reason:'Independent original-goal rejection despite valid technical output.'}]};
      const output=input.observations.find(item=>item.value.result?.artifact?.rows===2),id=output?.evidence_ids[0];
      const ref=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path==='$/result/artifact/rows')?.[0];
      assert.ok(id&&ref);
      return {checks:[{id:'original_user_request',verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'The current actual output independently meets the original fixture request.'}]};
    }
    assert.ok(instructions.startsWith('Execute the registered Work'));
    if(this.invalidDecision)return {};
    const observed=input.checkpoint.observations,planned=observed.find(item=>item.invocation.tool_name==='runtime_pack_plan'),run=observed.find(item=>item.invocation.tool_name==='runtime_pack_run'&&item.receipt.status==='succeeded');
    if(run)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Fresh output saved.',wait_reason:null,completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:run.receipt.evidence_ids}))};
    if(!planned)return action('runtime_pack_plan',{prompt});
    if(this.holdNextPack){this.holdNextPack=false;this.heldWork=input.work_id;await new Promise(resolve=>{this.release=resolve;});}
    if(this.nextTool)return action(this.nextTool,{text:'This result must never be written after authority is lost.',format:'txt'});
    return action('runtime_pack_run',{recipe:planned.receipt.value.recipe??recipe});
  }};
  const config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:model}),x={root,source,config,api,model};
  t.after(async()=>{model.release?.();x.api.close();await x.api.drain();await rm(root,{recursive:true,force:true});});
  const spec=validateWorkProposal({title:'Two current numeric rows',desired_outcome:prompt,completion_checks:[nativeCompletionCheck('output',predicate)],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write')},'quick');
  const begun=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),original=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
  x.original=original;
  await api.call('runtime_work_execute',{work_id:original.id,revision:original.revision,cost_acknowledged:true});
  const first=await terminal(x)(original.id);assert.equal(first.state,'succeeded',JSON.stringify(first));
  const [bound]=api.store.officeRuns(config.project.id,original.id);
  await api.call('runtime_custom_pack_publish',{key:'rows',title:'Current rows',work_id:original.id,supervisor_run_id:first.run_id,pack_run_id:bound.source_id});
  return x;
}
async function configure(t,x){
  const realNow=Date.now.bind(Date);let offset=0;t.mock.method(Date,'now',()=>realNow()+offset);
  await x.api.call('runtime_custom_pack_schedule_configure',{key:'rows',parent_revision:x.original.revision,definition:{kind:'interval',timezone:'UTC',seconds:60},cost_acknowledged:true,recurrence_acknowledged:true});
  return ms=>{offset=ms;x.api.workSupervisor.tick();};
}
const slots=x=>x.api.store.hermesState.prepare('SELECT * FROM office_work_schedule_slot WHERE project_id=? AND work_id=? ORDER BY scheduled_ms').all(x.config.project.id,x.original.id);

test('original-goal rejection holds the scheduled slot and repeated future ticks cannot duplicate effects or advance a cycle',async t=>{
  const x=await fixture(t),advance=await configure(t,x);x.model.rejectGoal=true;
  await writeFile(x.source,JSON.stringify([{id:'A',score:'13'},{id:'B',score:'21'}]));
  advance(65_000);advance(65_000);advance(65_000);
  const slot=await until(()=>slots(x)[0]),child=slot.execution_work_id,end=await terminal(x)(child);
  assert.equal(end.state,'awaiting_review',JSON.stringify(end));assert.equal(end.result.completion_verified,false);
  const [output]=x.api.store.officeRuns(x.config.project.id,child);assert.ok(output);
  assert.equal(x.api.store.packRun(x.config.project.id,output.source_id).status,'succeeded','A technical success is preserved while the independent goal fails.');
  const native=x.api.store.hermesState.prepare("SELECT 1 FROM office_activity WHERE project_id=? AND work_id=? AND kind='supervisor.verification.audit' AND summary LIKE '%WORK_COMPLETION_NATIVE_VERIFIED%'").get(x.config.project.id,child);
  assert.ok(native,'The original-goal failure occurred after real native technical acceptance.');
  const before=x.api.store.packRuns(x.config.project.id).length;
  advance(125_000);advance(185_000);await delay(30);
  assert.equal(slots(x).length,1,'An unreconciled semantic failure keeps this slot busy.');
  assert.equal(slots(x)[0].state,'started');assert.equal(x.api.store.intakeWorks(x.config.project.id).length,2);
  assert.equal(x.api.store.packRuns(x.config.project.id).length,before);assert.equal(x.api.store.officeRuns(x.config.project.id,child).length,1);
  assert.ok(x.model.goalCalls>=2,'Original goal is checked in the source and scheduled child.');
});

test('an orphan reserved scheduled cycle cannot execute through direct Pack calls or the Work supervisor',async t=>{
  const x=await fixture(t),prepared=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'rows',cycle_id:`schedule-${'a'.repeat(64)}`});
  await assert.rejects(x.api.call('runtime_pack_run',{work_id:prepared.work_id,request_id:prepared.request_id,recipe}),/CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED/u);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:prepared.work_id,revision:prepared.revision,current_run_only:true,cost_acknowledged:true}),/CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED/u);
  assert.throws(()=>x.api.workSupervisor.start(prepared.work_id,prepared.revision,true,undefined,true),/CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED/u,'The direct Control Center path checks the reserved slot before allocation.');
  assert.equal(supervisorStatus(x.api.store,x.config.project.id,prepared.work_id),null,'An orphan does not receive a supervisor execution assignment.');
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,prepared.work_id),[]);assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
  const started=x.api.store.hermesState.prepare("SELECT 1 FROM office_activity WHERE project_id=? AND work_id=? AND kind='tool.started'").get(x.config.project.id,prepared.work_id);
  assert.equal(started,undefined,'No capability is dispatched from an unassigned scheduler child.');
});

test('direct supervisor admission rejects missing immutable repeat metadata before allocating a run',async t=>{
  const x=await fixture(t),prepared=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'rows',cycle_id:'missing_binding'});
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').run(x.config.project.id,prepared.work_id);
  assert.throws(()=>x.api.workSupervisor.start(prepared.work_id,prepared.revision,true),/CUSTOM_PACK_WORK_BINDING_MISSING/u);
  assert.equal(supervisorStatus(x.api.store,x.config.project.id,prepared.work_id),null);
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,prepared.work_id),[]);assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
});

test('losing a custom schedule mapping before its first due slot cannot fall back to the parent, including after restart',async t=>{
  const x=await fixture(t),advance=await configure(t,x),beforeCalls=x.model.calls.length;
  const countParentRuns=()=>Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE project_id=? AND work_id=?').get(x.config.project.id,x.original.id).n);
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_schedule WHERE project_id=? AND parent_work_id=?').run(x.config.project.id,x.original.id);
  assert.equal(x.api.workSupervisor.schedules.customPackRequired(x.original.id),true,'Custom execution ownership survives loss of the mapping table row.');
  advance(65_000);advance(65_000);await delay(20);
  assert.equal(slots(x).length,0);assert.equal(countParentRuns(),1);assert.equal(x.api.store.intakeWorks(x.config.project.id).length,1);assert.equal(x.model.calls.length,beforeCalls);
  assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
  x.api.close();await x.api.drain();x.api=new RuntimeApi(x.config,{swarmModel:x.model});
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:x.original.id,revision:x.original.revision,cost_acknowledged:true}),/WORK_USE_EXISTING_EXECUTION_CONTROL/u);
  assert.equal(x.api.workSupervisor.schedules.customPackRequired(x.original.id),true);
  x.api.workSupervisor.activate();x.api.workSupervisor.tick();await delay(20);
  assert.equal(slots(x).length,0);assert.equal(countParentRuns(),1);assert.equal(x.api.store.intakeWorks(x.config.project.id).length,1);assert.equal(x.model.calls.length,beforeCalls);
  assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
  const blocked=x.api.store.hermesState.prepare("SELECT summary FROM office_activity WHERE project_id=? AND work_id=? AND kind='schedule.blocked'").all(x.config.project.id,x.original.id);
  assert.deepEqual(blocked.map(item=>item.summary),['CUSTOM_PACK_SCHEDULE_BINDING_MISSING'],'Repeated blocked ticks retain one diagnosis and dispatch nothing.');
});

for(const scheduled of [false,true])test(`${scheduled?'scheduled':'manual'} custom metadata loss during a model turn blocks a non-Pack local result write`,async t=>{
  const x=await fixture(t);x.model.holdNextPack=true;x.model.nextTool='office_result_draft';
  let advance;
  if(scheduled){advance=await configure(t,x);advance(65_000);}
  else{
    const prepared=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'rows',cycle_id:'lost_during_turn'});
    await x.api.call('runtime_work_execute',{work_id:prepared.work_id,revision:prepared.revision,cost_acknowledged:true});
  }
  const child=await until(()=>x.model.heldWork),binding=x.api.store.hermesState.prepare('SELECT request_id FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').get(x.config.project.id,child);
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').run(x.config.project.id,child);
  if(scheduled){
    // A scheduler slot is a separate ownership record, even if the ordinary
    // cycle lookup is also gone. Non-Pack writes still require that binding.
    x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_cycle WHERE project_id=? AND request_id=?').run(x.config.project.id,binding.request_id);
    const parent=x.api.store.intakeWork(x.config.project.id,x.original.id);
    await x.api.call('runtime_work_pause',{work_id:parent.id,revision:parent.revision,paused:true});
  }
  x.model.release();const end=await terminal(x)(child);
  assert.equal(end.state,'failed');assert.equal(end.reason,scheduled?'SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH':'CUSTOM_PACK_WORK_BINDING_MISSING');
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,child),[]);assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
  await assert.rejects(stat(join(dirname(x.config.dbPath),'work-artifacts',child)),error=>error.code==='ENOENT');
  const starts=x.api.store.hermesState.prepare("SELECT metadata FROM office_activity WHERE project_id=? AND work_id=? AND kind='tool.started'").all(x.config.project.id,child);
  assert.ok(starts.every(item=>JSON.parse(item.metadata).tool_name!=='office_result_draft'),'The model-proposed non-Pack effect was never dispatched.');
  if(scheduled){advance(125_000);await delay(20);assert.equal(slots(x).length,1);assert.equal(x.api.store.intakeWorks(x.config.project.id).length,2);}
});

test('a failed scheduled decision holds its slot for explicit retry and resumes the same supervisor before another cycle',async t=>{
  const x=await fixture(t),advance=await configure(t,x);x.model.invalidDecision=true;advance(65_000);
  const slot=await until(()=>slots(x)[0]),child=slot.execution_work_id,failed=await terminal(x)(child);
  assert.equal(failed.state,'failed');assert.equal(failed.reason,'WORK_CLIENT_DECISION_CORRECTION_FAILED');
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,child),[]);
  advance(125_000);await delay(20);assert.equal(slots(x).length,1);assert.equal(slots(x)[0].state,'started');
  x.model.invalidDecision=false;
  const work=x.api.store.intakeWork(x.config.project.id,child);
  await x.api.call('runtime_work_control',{work_id:child,revision:work.revision,action:'retry'});
  const accepted=await terminal(x)(child);assert.equal(accepted.state,'succeeded',JSON.stringify(accepted));assert.equal(accepted.run_id,failed.run_id);assert.equal(accepted.result.completion_verified,true);
  assert.equal(x.api.store.officeRuns(x.config.project.id,child).length,1,'Retry performs one new output effect after a no-dispatch decision failure.');
  x.api.workSupervisor.tick();
  const next=await until(()=>slots(x)[1]);assert.equal(slots(x)[0].state,'finished');assert.notEqual(next.execution_work_id,child);assert.notEqual(next.run_id,failed.run_id);
  const nextEnd=await terminal(x)(next.execution_work_id);assert.equal(nextEnd.state,'succeeded',JSON.stringify(nextEnd));
});

for(const control of ['pause','disconnect'])test(`scheduled dispatch rechecks ${control} of the parent after a model turn and binds the exact assigned supervisor`,async t=>{
  const x=await fixture(t),advance=await configure(t,x);x.model.holdNextPack=true;
  advance(65_000);
  const child=await until(()=>x.model.heldWork),slot=slots(x)[0],host={config_fingerprint:x.config.fingerprint,engine_binding:hashJson({config:x.config.fingerprint,engine:PACK_ENGINE_VERSION})};
  assert.equal(slot.execution_work_id,child);assert.equal(slot.state,'started');
  assert.doesNotThrow(()=>assertCustomPackScheduledRun(x.api.store,x.config.project.id,child,host,slot.run_id));
  assert.throws(()=>assertCustomPackScheduledRun(x.api.store,x.config.project.id,child,host,randomUUID()),/SCHEDULE_RUN_BINDING_MISMATCH/u);
  const parent=x.api.store.intakeWork(x.config.project.id,x.original.id);
  if(control==='pause')await x.api.call('runtime_work_pause',{work_id:parent.id,revision:parent.revision,paused:true});
  else changeWorkLifecycle(x.api.store,x.config.project.id,{work_id:parent.id,revision:0,work_revision:parent.revision,action:'disconnect',confirmed:true});
  assert.throws(()=>x.api.workSupervisor.start(child,x.api.store.intakeWork(x.config.project.id,child).revision,true),control==='pause'?/WORK_PAUSED/u:/WORK_DISCONNECTED/u,'Direct start cannot override the parent control fence.');
  x.model.release();const end=await terminal(x)(child);
  assert.notEqual(end.state,'succeeded');assert.equal(end.result?.completion_verified??false,false);
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,child),[],'Parent control is enforced before the planned Pack effect.');
  assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
  advance(125_000);await delay(20);assert.equal(slots(x).length,1);assert.equal(x.api.store.intakeWorks(x.config.project.id).length,2);
});
