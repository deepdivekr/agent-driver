import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {nativeCompletionCheck} from '../dist/work/completion-checks.js';
import {validateWorkProposal} from '../dist/work/contracts.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {bindWorkIntakeOptions,readWorkIntakeOptions} from '../dist/work/intake-options.js';
import {supervisorStatus} from '../dist/work/supervisor.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {customPackWorkBinding,assertCustomPackInvocation} from '../dist/work/custom-pack-repeat.js';
import {changeWorkLifecycle} from '../dist/work/lifecycle.js';

const prompt='Save both current records as JSON with numeric scores; retain every original row.';
const recipe={version:1,family:'file.pipeline',request:prompt,sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],columns:['id','score'],numeric_columns:['score'],sort:null,format:'json'};
const predicate={version:1,kind:'native_pack_output',family:'file.pipeline',format:'json',columns:['id','score'],output_rows:2,numeric_columns:['score'],sort:null};
const action=(tool,args)=>({action:'tool',stage_id:'work',tool_name:tool,arguments_json:JSON.stringify(args),summary:'Follow the demonstrated recipe using fresh host execution.',wait_reason:null,completed_checks:[]});

async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'custom-pack-integrated-')),source=join(root,'rows.json'),host=join(root,'host.json');
  await writeFile(source,JSON.stringify([{id:'A',score:'3'},{id:'B',score:'5'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'custom-pack-integrated',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:source,format:'json'}],targets:[]}}));
  const inputs=[],model={calls:[],rejectGoal:false,repeatPackCall:false,repeatedWorkIds:new Set(),async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',elapsed_ms:0});inputs.push({instructions,input:structuredClone(input)});
    if(instructions.startsWith('Independently verify')){
      assert.deepEqual(input.checks.map(check=>check.id),['original_user_request'],'Technical predicates never replace the original goal.');
      assert.equal(input.original_user_request.prompt,prompt);
      if(this.rejectGoal)return {checks:[{id:'original_user_request',verdict:'unsupported',evidence_ids:[],evidence_quote_refs:[],reason:'Fixture independent goal verifier rejects the current result despite technical success.'}]};
      const observed=input.observations.find(item=>item.value.result?.artifact?.rows===2),id=observed?.evidence_ids[0];
      const ref=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path==='$/result/artifact/rows')?.[0];
      assert.ok(id&&ref,'A real fresh Pack output must be present in the verifier input.');
      return {checks:[{id:'original_user_request',verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'Fixture original-goal verifier independently accepts actual output evidence.'}]};
    }
    assert.ok(instructions.startsWith('Execute the registered Work'),'Repeat does not re-run definition or invent a new route.');
    const observations=input.checkpoint.observations,plan=observations.find(item=>item.invocation.tool_name==='runtime_pack_plan'),run=observations.find(item=>item.invocation.tool_name==='runtime_pack_run'&&item.receipt.status==='succeeded');
    if(run){
      if(this.repeatPackCall&&!this.repeatedWorkIds.has(input.work_id)){this.repeatedWorkIds.add(input.work_id);return action('runtime_pack_run',{recipe:plan.receipt.value.recipe??recipe});}
      return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Actual output saved.',wait_reason:null,completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:run.receipt.evidence_ids}))};
    }
    if(!plan)return action('runtime_pack_plan',{prompt});
    return action('runtime_pack_run',{recipe:plan.receipt.value.recipe??recipe});
  }};
  const config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:model});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const spec=validateWorkProposal({title:'Current two-row numeric report',desired_outcome:prompt,completion_checks:[nativeCompletionCheck('output',predicate)],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write')},'quick');
  const begun=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),original=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
  bindWorkIntakeOptions(api.store,config.project.id,original.id,{completion_condition:'Both rows must be retained. A past report is not current input.',delivery_target_ids:options.deliveryTargetIds??null});
  return {root,source,host,api,config,model,inputs,original,spec};
}
async function terminal(x,workId){
  for(let i=0;i<300;i++){
    const status=supervisorStatus(x.api.store,x.config.project.id,workId);
    if(status&&!['queued','running','retry_wait'].includes(status.state))return status;
    await delay(20);
  }
  assert.fail(JSON.stringify(supervisorStatus(x.api.store,x.config.project.id,workId)));
}
async function publish(x,key='daily_rows'){
  await x.api.call('runtime_work_execute',{work_id:x.original.id,revision:x.original.revision,cost_acknowledged:true});
  const completed=await terminal(x,x.original.id);assert.equal(completed.state,'succeeded',JSON.stringify(completed));
  const [bound]=x.api.store.officeRuns(x.config.project.id,x.original.id);
  const saved=await x.api.call('runtime_custom_pack_publish',{key,title:'Daily current records',work_id:x.original.id,supervisor_run_id:completed.run_id,pack_run_id:bound.source_id});
  assert.equal(saved.pack.state,'ready');return {saved,completed,run:x.api.store.packRun(x.config.project.id,bound.source_id)};
}

test('custom Pack MCP path repeats the immutable procedure in a fresh verified Work and deduplicates a cycle without replay',async t=>{
  const x=await setup(t),first=await publish(x),originalArtifact=first.run.result.artifact;
  assert.deepEqual(JSON.parse(await readFile(originalArtifact.path,'utf8')),[{id:'A',score:3},{id:'B',score:5}]);
  const list=await x.api.call('runtime_custom_pack_list',{}),versions=await x.api.call('runtime_custom_pack_versions',{key:'daily_rows'});
  assert.equal(list.packs.length,1);assert.equal(versions.versions.length,1);
  assert.equal(versions.versions[0].completion_contract.prompt,prompt);
  await writeFile(x.source,JSON.stringify([{id:'A',score:'13'},{id:'B',score:'21'}]));
  const repeated=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'day_two'});
  assert.notEqual(repeated.work_id,x.original.id);assert.equal(repeated.execution_started,false);assert.equal(repeated.schedule_enabled,false);assert.equal(repeated.completion_verified,false);
  assert.equal(supervisorStatus(x.api.store,x.config.project.id,repeated.work_id),null);assert.deepEqual(x.api.store.officeRuns(x.config.project.id,repeated.work_id),[]);
  assert.deepEqual(readWorkIntakeOptions(x.api.store,x.config.project.id,repeated.work_id),readWorkIntakeOptions(x.api.store,x.config.project.id,x.original.id));
  assert.ok(repeated.work.spec.plan.steps.every(step=>step.evidence_ids.length===0));
  const plan=await x.api.call('runtime_pack_plan',{prompt,work_id:repeated.work_id});
  assert.deepEqual(plan.recipe,recipe);assert.equal(plan.procedure_state,'ready');assert.equal(plan.custom_pack.result_reuse,false);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:repeated.work_id,revision:repeated.revision}),/WORK_MODEL_USAGE_CONSENT_REQUIRED/u);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:repeated.work_id,revision:repeated.revision,cost_acknowledged:true,current_run_only:false}),/CUSTOM_PACK_NEW_CYCLE_REQUIRED/u);
  assert.equal(supervisorStatus(x.api.store,x.config.project.id,repeated.work_id),null,'Preparation never grants cost consent.');
  await x.api.call('runtime_work_execute',{work_id:repeated.work_id,revision:repeated.revision,cost_acknowledged:true});
  const completed=await terminal(x,repeated.work_id);assert.equal(completed.state,'succeeded',JSON.stringify(completed));
  const [bound]=x.api.store.officeRuns(x.config.project.id,repeated.work_id),run=x.api.store.packRun(x.config.project.id,bound.source_id);
  assert.notEqual(run.id,first.run.id);assert.notEqual(run.result.artifact.path,originalArtifact.path);assert.equal(run.request_id,repeated.request_id);
  assert.deepEqual(JSON.parse(await readFile(run.result.artifact.path,'utf8')),[{id:'A',score:13},{id:'B',score:21}]);
  assert.deepEqual(JSON.parse(await readFile(originalArtifact.path,'utf8')),[{id:'A',score:3},{id:'B',score:5}]);
  const checkpoint=JSON.parse(x.api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(completed.run_id).checkpoint);
  assert.equal(checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run').invocation.request_id,repeated.request_id,'Checkpoint, receipt and Pack identity remain exact.');
  const before=x.api.store.packRuns(x.config.project.id).length,again=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'day_two'});
  assert.equal(again.work_id,repeated.work_id);assert.equal(again.created,false);assert.equal(again.work.completion_verified,true);assert.equal(x.api.store.packRuns(x.config.project.id).length,before);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:again.work_id,revision:again.revision,cost_acknowledged:true}),/WORK_USE_EXISTING_EXECUTION_CONTROL/u);
  const next=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'day_three'});assert.notEqual(next.request_id,repeated.request_id);assert.notEqual(next.work_id,repeated.work_id);
  const goalInputs=x.inputs.filter(item=>item.instructions.startsWith('Independently verify'));assert.equal(goalInputs.length,2);
  assert.ok(goalInputs[1].input.observations.some(item=>item.value.run_id===run.id));assert.ok(!goalInputs[1].input.observations.some(item=>item.value.run_id===first.run.id),'Past result receipts are not new evidence.');
});

test('a repeated technical success still faces original-goal rejection and cannot publish a ready version',async t=>{
  const x=await setup(t);await publish(x);x.model.rejectGoal=true;
  const repeat=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'rejected'});
  await x.api.call('runtime_work_execute',{work_id:repeat.work_id,revision:repeat.revision,cost_acknowledged:true});
  const end=await terminal(x,repeat.work_id);assert.notEqual(end.state,'succeeded');assert.equal(end.result.completion_verified,false);
  const runs=x.api.store.officeRuns(x.config.project.id,repeat.work_id);assert.equal(runs.length,1,'Original-goal verification failure must not replay a completed local write.');
  assert.equal(x.api.store.packRun(x.config.project.id,runs[0].source_id).status,'succeeded','Family technical success is independent of the original-goal verdict.');
  await assert.rejects(x.api.call('runtime_custom_pack_publish',{key:'rejected',title:'Not verified',work_id:repeat.work_id,supervisor_run_id:end.run_id,pack_run_id:runs[0].source_id}),/CUSTOM_PACK_WORK_NOT_VERIFIED/u);
});

test('maximum-length custom Pack keys preserve explicit directions through fresh original-goal verification',async t=>{
  const x=await setup(t),key='a'.repeat(80),directions=[
    {step_id:'work',instruction:'Preserve both current records and their numeric scores.'},
    {step_id:'next',instruction:'현재 원본의 모든 행을 보존하고 외부로 전송하지 마세요.'},
  ];
  // Host-owned explicit user directions precede the demonstrated execution.
  // They are input authority, not model-proposed completion evidence.
  x.api.store.transaction(()=>{
    for(const [index,direction] of directions.entries()){
      const revision=x.original.revision+index+1,at=new Date().toISOString();
      x.api.store.hermesState.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(x.original.id,revision,'direction_changed',JSON.stringify({...direction,run_id:randomUUID(),created_at:at}),JSON.stringify(x.original.answers),at);
      x.api.store.hermesState.prepare('UPDATE office_intake SET revision=?,updated_at=? WHERE project_id=? AND work_id=?').run(revision,at,x.config.project.id,x.original.id);
    }
  });
  x.original=x.api.store.intakeWork(x.config.project.id,x.original.id);
  const first=await publish(x,key);
  assert.deepEqual(first.saved.pack.completion_contract.user_directions.map(({step_id,instruction})=>({step_id,instruction})),directions);
  await writeFile(x.source,JSON.stringify([{id:'A',score:'13'},{id:'B',score:'21'}]));
  const prepared=await x.api.call('runtime_custom_pack_prepare_repeat',{key,cycle_id:'b'.repeat(80)}),copied=x.api.store.workDirections(x.config.project.id,prepared.work_id);
  assert.equal(prepared.revision,1+directions.length);
  assert.deepEqual(copied.map(({step_id,instruction})=>({step_id,instruction})),directions);
  assert.ok(copied.every(direction=>direction.run_id===prepared.request_id&&direction.run_id.length<=80),'Copied directions retain bounded, host-owned cycle provenance.');
  await x.api.call('runtime_work_execute',{work_id:prepared.work_id,revision:prepared.revision,cost_acknowledged:true,current_run_only:true});
  const completed=await terminal(x,prepared.work_id);
  assert.equal(completed.state,'succeeded',JSON.stringify(completed));assert.equal(completed.result.completion_verified,true);
  const verified=x.inputs.filter(item=>item.instructions.startsWith('Independently verify'));
  assert.equal(verified.length,2,'The repeated Work must reach independent original-goal verification.');
  assert.deepEqual(verified[1].input.original_user_request.user_directions.map(({step_id,instruction})=>({step_id,instruction})),directions);
  const run=x.api.store.packRun(x.config.project.id,x.api.store.officeRuns(x.config.project.id,prepared.work_id)[0].source_id);
  assert.deepEqual(JSON.parse(await readFile(run.result.artifact.path,'utf8')),[{id:'A',score:13},{id:'B',score:21}]);
});

test('custom repeat preflight preserves task authority and rejects a changed recipe, identity or contract before Pack dispatch',async t=>{
  const x=await setup(t);await publish(x);
  const repeated=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'guarded'}),binding=customPackWorkBinding(x.api.store,x.config.project.id,repeated.work_id),work=x.api.store.intakeWork(x.config.project.id,repeated.work_id);
  assert.equal(binding.request_id,repeated.request_id);
  const toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,randomUUID(),work.spec,work.prompt,()=>{},x.model);t.after(()=>toolkit.close());
  const changed={...recipe,filters:[{field:'id',op:'eq',value:'A'}]};
  assert.throws(()=>toolkit.validate('runtime_pack_run',{recipe:changed},repeated.request_id),error=>error.code==='CUSTOM_PACK_RECIPE_CHANGED'&&error.not_dispatched===true);
  await assert.rejects(x.api.call('runtime_pack_run',{request_id:repeated.request_id,recipe:changed}),/CUSTOM_PACK_RECIPE_CHANGED/u,'Request-derived Work authority must not be bypassed by omitting work_id.');
  await assert.rejects(x.api.call('runtime_pack_run',{work_id:x.original.id,request_id:repeated.request_id,recipe}),/WORK_RUN_BINDING_CONFLICT/u,'Explicit and request-derived Work owners must agree.');
  await assert.rejects(x.api.call('runtime_pack_run',{work_id:work.id,request_id:'wrong-cycle-id',recipe}),/CUSTOM_PACK_REQUEST_ID_CHANGED/u);
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,work.id),[]);
  await assert.rejects(x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'unknown_input',parameters:{rows:{unknown:'value'}}}),/CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN/u);
  const legacyPlan=await x.api.call('runtime_pack_plan',{prompt});assert.equal(legacyPlan.procedure_state,'draft');assert.equal(legacyPlan.original_work_verified,false);
  const accepted=await x.api.call('runtime_pack_run',{work_id:work.id,request_id:repeated.request_id,recipe});assert.equal(accepted.status,'succeeded');
  x.api.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify({...work.spec,desired_outcome:'Only one row is sufficient now.'}),x.config.project.id,work.id);
  assert.throws(()=>toolkit.validate('runtime_pack_run',{recipe},repeated.request_id),error=>error.code==='CUSTOM_PACK_WORK_CONTRACT_CHANGED'&&error.not_dispatched===true);
  await assert.rejects(x.api.call('runtime_pack_run',{request_id:repeated.request_id,recipe}),/CUSTOM_PACK_WORK_CONTRACT_CHANGED/u,'Existing run identity still resolves the frozen Work when work_id is absent.');
  await assert.rejects(x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'guarded'}),/CUSTOM_PACK_WORK_CONTRACT_CHANGED/u);
  const historical=await x.api.call('runtime_pack_status',{run_id:accepted.run_id});assert.equal(historical.run_id,accepted.run_id);assert.deepEqual(historical.result,accepted.result);
  assert.equal(assertCustomPackInvocation(x.api.store,x.config.project.id,work.id,'runtime_pack_watch_pause',{paused:true}).work_id,work.id,'A changed contract must still allow the scoped host pause fence.');
  assert.throws(()=>assertCustomPackInvocation(x.api.store,x.config.project.id,work.id,'runtime_pack_watch_pause',{paused:false}),/CUSTOM_PACK_WORK_CONTRACT_CHANGED/u,'Resuming effects keeps the immutable contract gate.');
  assert.equal(x.api.store.officeRuns(x.config.project.id,work.id).length,1);
});

test('custom repeat admission atomically stores requested delivery destinations and preserves later human selection on a retry',async t=>{
  const x=await setup(t,{deliveryTargetIds:[]});await publish(x);
  const originalSelection=x.api.workResults.setSelection.bind(x.api.workResults);
  x.api.workResults.setSelection=(...args)=>{originalSelection(...args);throw Error('SIMULATED_ADMISSION_INTERRUPTION');};
  await assert.rejects(x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'atomic'}),/SIMULATED_ADMISSION_INTERRUPTION/u);
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,1,'A failed admission must not leave a half-initialized Work or delivery policy.');
  x.api.workResults.setSelection=originalSelection;
  const prepared=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'atomic'});
  assert.equal(prepared.created,true);assert.deepEqual(x.api.workResults.selection(x.config.project.id,prepared.work_id).target_ids,[],'Explicit requested destinations take precedence over current app defaults.');
  x.api.workResults.setSelection(x.config.project.id,prepared.work_id,{revision:1,target_ids:['app']});
  const again=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'atomic'});
  assert.equal(again.work_id,prepared.work_id);assert.deepEqual(x.api.workResults.selection(x.config.project.id,prepared.work_id).target_ids,['app'],'A prepare retry must not overwrite the human selection.');
});

test('normal repeated Pack calls reuse the canonical completed invocation without a second dispatch or conflicting completion evidence',async t=>{
  const x=await setup(t);await publish(x);x.model.repeatPackCall=true;
  const repeat=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'double_call'});
  await x.api.call('runtime_work_execute',{work_id:repeat.work_id,revision:repeat.revision,cost_acknowledged:true});
  const end=await terminal(x,repeat.work_id);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
  assert.ok(x.model.repeatedWorkIds.has(repeat.work_id),'The fixture really requested the same Pack call twice.');
  const row=x.api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id),checkpoint=JSON.parse(row.checkpoint),observations=checkpoint.observations.filter(item=>item.invocation.tool_name==='runtime_pack_run');
  assert.equal(observations.length,1,'The canonical completed receipt is retained once, rather than contradicted by a deduplicated second response.');
  assert.equal(observations[0].invocation.request_id,repeat.request_id);assert.equal(observations[0].receipt.status,'succeeded');assert.equal(observations[0].receipt.effect_state,'verified');
  assert.equal(x.api.store.officeRuns(x.config.project.id,repeat.work_id).length,1);
  const starts=x.api.store.hermesState.prepare("SELECT metadata FROM office_activity WHERE project_id=? AND work_id=? AND kind='tool.started'").all(x.config.project.id,repeat.work_id).filter(item=>JSON.parse(item.metadata).tool_name==='runtime_pack_run');
  assert.equal(starts.length,1,'A reuse proposal must not be recorded as another actual capability dispatch.');
});

test('a registered custom cycle whose Work binding was lost cannot degrade to legacy Pack dispatch with a fresh request ID',async t=>{
  const x=await setup(t);await publish(x);
  const repeated=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'daily_rows',cycle_id:'lost_binding'}),work=x.api.store.intakeWork(x.config.project.id,repeated.work_id);
  const toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,randomUUID(),work.spec,work.prompt,()=>{},x.model);t.after(()=>toolkit.close());
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').run(x.config.project.id,work.id);
  const fallback='work-tool-fresh-after-lost-metadata';assert.equal(toolkit.requestId('runtime_pack_run',{recipe},fallback),fallback);
  assert.throws(()=>toolkit.validate('runtime_pack_run',{recipe},fallback),error=>error.code==='CUSTOM_PACK_WORK_BINDING_MISSING'&&error.not_dispatched===true);
  await assert.rejects(x.api.call('runtime_pack_run',{work_id:work.id,request_id:fallback,recipe}),/CUSTOM_PACK_WORK_BINDING_MISSING/u);
  await assert.rejects(x.api.call('runtime_pack_run',{request_id:repeated.request_id,recipe}),/CUSTOM_PACK_WORK_BINDING_MISSING/u);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true}),/CUSTOM_PACK_WORK_BINDING_MISSING/u);
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,work.id),[]);assert.equal(supervisorStatus(x.api.store,x.config.project.id,work.id),null);assert.equal(x.api.store.packRuns(x.config.project.id).length,1);
});

test('custom schedule API requires explicit consent and produces independently verified fresh child cycles through the existing supervisor',async t=>{
  const x=await setup(t),first=await publish(x),initialSpec=structuredClone(x.api.store.intakeWork(x.config.project.id,x.original.id).spec),realNow=Date.now.bind(Date);
  let clockOffset=0;t.mock.method(Date,'now',()=>realNow()+clockOffset);
  const configure={key:'daily_rows',parent_revision:x.original.revision,definition:{kind:'interval',timezone:'UTC',seconds:60},cost_acknowledged:true,recurrence_acknowledged:true};
  await assert.rejects(x.api.call('runtime_custom_pack_schedule_configure',{...configure,cost_acknowledged:false}));
  await assert.rejects(x.api.call('runtime_custom_pack_schedule_configure',{...configure,recurrence_acknowledged:false}));
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,1,'Rejected consent must not create scheduled child Works.');
  const configured=await x.api.call('runtime_custom_pack_schedule_configure',configure);
  assert.equal(configured.parent_work_id,x.original.id);assert.equal(configured.schedule.enabled,true);
  assert.deepEqual(x.api.store.intakeWork(x.config.project.id,x.original.id).spec,initialSpec,'Scheduling must not reinterpret the original goal or recurrence contract.');
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,1,'Configuring the schedule does not dispatch before its first due slot.');
  const children=()=>x.api.store.intakeWorks(x.config.project.id).filter(work=>work.id!==x.original.id);
  async function nextChild(previousCount){
    x.api.workSupervisor.tick();
    for(let i=0;i<300;i++){
      const works=children();if(works.length>previousCount){const child=works.find(work=>!seen.has(work.id));assert.ok(child);seen.add(child.id);return {child,end:await terminal(x,child.id)};}
      await delay(20);
    }
    assert.fail(JSON.stringify({schedule:await x.api.call('runtime_custom_pack_schedule_status',{parent_work_id:x.original.id}),children:children()}));
  }
  const seen=new Set();
  await writeFile(x.source,JSON.stringify([{id:'A',score:'34'},{id:'B',score:'55'}]));clockOffset=65_000;
  const one=await nextChild(0);assert.equal(one.end.state,'succeeded',JSON.stringify(one.end));assert.equal(one.end.result.completion_verified,true);
  const firstChildRun=x.api.store.packRun(x.config.project.id,x.api.store.officeRuns(x.config.project.id,one.child.id)[0].source_id);
  assert.deepEqual(JSON.parse(await readFile(firstChildRun.result.artifact.path,'utf8')),[{id:'A',score:34},{id:'B',score:55}]);
  await writeFile(x.source,JSON.stringify([{id:'A',score:'89'},{id:'B',score:'144'}]));clockOffset=125_000;
  const two=await nextChild(1);assert.equal(two.end.state,'succeeded',JSON.stringify(two.end));assert.equal(two.end.result.completion_verified,true);
  const secondChildRun=x.api.store.packRun(x.config.project.id,x.api.store.officeRuns(x.config.project.id,two.child.id)[0].source_id);
  assert.notEqual(two.child.id,one.child.id);assert.notEqual(two.child.request_id,one.child.request_id);assert.notEqual(two.end.run_id,one.end.run_id);assert.notEqual(secondChildRun.id,firstChildRun.id);
  assert.deepEqual(JSON.parse(await readFile(secondChildRun.result.artifact.path,'utf8')),[{id:'A',score:89},{id:'B',score:144}]);
  assert.deepEqual(JSON.parse(await readFile(first.run.result.artifact.path,'utf8')),[{id:'A',score:3},{id:'B',score:5}]);
  assert.deepEqual(JSON.parse(await readFile(firstChildRun.result.artifact.path,'utf8')),[{id:'A',score:34},{id:'B',score:55}]);
  const parent=x.api.store.intakeWork(x.config.project.id,x.original.id);
  await x.api.call('runtime_work_pause',{work_id:parent.id,revision:parent.revision,paused:true});clockOffset=185_000;x.api.workSupervisor.tick();await delay(30);
  assert.equal(children().length,2,'Parent pause must block creation of the next child cycle.');
  const pausedStatus=await x.api.call('runtime_custom_pack_schedule_status',{parent_work_id:parent.id});assert.equal(pausedStatus.schedule.enabled,false);
  const pausedParent=x.api.store.intakeWork(x.config.project.id,parent.id);
  await x.api.call('runtime_custom_pack_schedule_disable',{parent_work_id:parent.id,parent_revision:pausedParent.revision});
  await x.api.call('runtime_work_pause',{work_id:parent.id,revision:pausedParent.revision,paused:false});clockOffset=245_000;x.api.workSupervisor.tick();await delay(30);
  assert.equal(children().length,2,'A disabled schedule cannot start another cycle when the parent is resumed.');
  const connected=x.api.store.intakeWork(x.config.project.id,parent.id);
  changeWorkLifecycle(x.api.store,x.config.project.id,{work_id:parent.id,revision:0,work_revision:connected.revision,action:'disconnect',confirmed:true});clockOffset=305_000;x.api.workSupervisor.tick();await delay(30);
  assert.equal(children().length,2);assert.equal(x.api.store.packRuns(x.config.project.id).length,3,'Past source and child receipts are retained after parent detachment.');
});
