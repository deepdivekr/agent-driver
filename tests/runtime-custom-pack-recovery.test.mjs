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
import {supervisorStatus} from '../dist/work/supervisor.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';

const rows=[{id:'A',score:'3'},{id:'B',score:'5'}];
const action=(tool,args)=>({action:'tool',stage_id:'work',tool_name:tool,arguments_json:JSON.stringify(args),summary:'Follow the canonical procedure.',wait_reason:null,completed_checks:[]});
async function until(read){for(let i=0;i<400;i++){const value=read();if(value)return value;await delay(10);}assert.fail('Fixture did not reach expected state.');}
const terminal=(x,id)=>until(()=>{const status=supervisorStatus(x.api.store,x.config.project.id,id);return status&&!['queued','running','retry_wait'].includes(status.state)?status:null;});
const checkpoint=(x,runId)=>JSON.parse(x.api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(runId).checkpoint);
async function fixture(t,{watch=false}={}){
  const root=await mkdtemp(join(tmpdir(),'custom-pack-recovery-')),source=join(root,'rows.json'),host=join(root,'host.json'),prompt=watch?'Start a local watch with a baseline containing both current records.':'Save both current rows as numeric JSON.';
  await writeFile(source,JSON.stringify(rows));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'custom-recovery',caller_ref:'fixture',account_ref:'fixture',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:source,format:'json'}],targets:[]}}));
  const shared={version:1,request:prompt,sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id']},recipe=watch?{...shared,family:'monitor.watch',mode:'any_change',comparison_fields:['id','score'],value_field:null,interval_seconds:60}:{...shared,family:'file.pipeline',columns:['id','score'],numeric_columns:['score'],sort:null,format:'json'};
  const checks=watch?[{id:'baseline',result:'A local watch is started with both observed rows in its baseline.',evidence:'The same Work watch result has collected_rows=2 and a saved baseline.'}]:[nativeCompletionCheck('output',{version:1,kind:'native_pack_output',family:'file.pipeline',format:'json',columns:['id','score'],output_rows:2,numeric_columns:['score'],sort:null})];
  const model={calls:[],goals:[],resume:false,async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',elapsed_ms:0});
    if(instructions.startsWith('Independently verify')){
      this.goals.push(structuredClone(input));const observed=input.observations.find(item=>watch?item.value.result?.collected_rows===2:item.value.result?.artifact?.rows===2),id=observed?.evidence_ids[0],path=watch?'$/result/collected_rows':'$/result/artifact/rows',ref=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id))?.leaf_refs.find(([,value])=>value===path)?.[0];assert.ok(id&&ref);
      return {checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'The fixture independently accepts real current result evidence.'}))};
    }
    assert.ok(instructions.startsWith('Execute the registered Work'));const observations=input.checkpoint.observations,plan=observations.find(item=>item.invocation.tool_name==='runtime_pack_plan'),output=observations.find(item=>['runtime_pack_run','runtime_pack_status'].includes(item.invocation.tool_name)&&item.receipt.status==='succeeded');
    if(output&&output.invocation.tool_name==='runtime_pack_status'&&!watch&&!observations.some(item=>item.invocation.tool_name==='office_result_read'))return action('office_result_read',{request_id:output.invocation.request_id});
    if(output)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Current output observed.',wait_reason:null,completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:output.receipt.evidence_ids}))};
    if(observations.some(item=>item.invocation.tool_name==='runtime_pack_run')&&!this.resume)return {action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The broken source needs restoration.',wait_reason:'configuration',completed_checks:[]};
    if(!plan)return action('runtime_pack_plan',{prompt});return action('runtime_pack_run',{recipe:plan.receipt.value.recipe??recipe});
  }};
  const config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:model}),x={root,source,config,api,model,recipe,checks};t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const spec=validateWorkProposal({title:'Recovery fixture',desired_outcome:prompt,completion_checks:checks,assumptions:[],route:{kind:'pack',pack_family:recipe.family},requested_effect:watch?'read_only':'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,watch?'read_only':'local_file_write')},'quick');
  const begun=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),original=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');x.original=original;
  await api.call('runtime_work_execute',{work_id:original.id,revision:original.revision,cost_acknowledged:true});const end=await terminal(x,original.id);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const [run]=api.store.officeRuns(config.project.id,original.id);await api.call('runtime_custom_pack_publish',{key:'report',title:'Current report',work_id:original.id,supervisor_run_id:end.run_id,pack_run_id:run.source_id});
  return x;
}
async function outage(x,{scheduled=false,t}={}){
  await writeFile(x.source,'temporarily invalid JSON');let repeat;
  if(scheduled){
    const realNow=Date.now.bind(Date);t.mock.method(Date,'now',()=>realNow()+65_000);
    // Configure at real time so only the fixture clock advances a due period.
    t.mock.restoreAll();await x.api.call('runtime_custom_pack_schedule_configure',{key:'report',parent_revision:x.original.revision,definition:{kind:'interval',timezone:'UTC',seconds:60},cost_acknowledged:true,recurrence_acknowledged:true});t.mock.method(Date,'now',()=>realNow()+65_000);x.api.workSupervisor.tick();
    const child=await until(()=>x.api.store.hermesState.prepare('SELECT execution_work_id FROM office_work_schedule_slot WHERE project_id=? AND work_id=?').get(x.config.project.id,x.original.id)?.execution_work_id);repeat={work_id:child};
  }else{repeat=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'report',cycle_id:'source_outage'});await x.api.call('runtime_work_execute',{work_id:repeat.work_id,revision:repeat.revision,cost_acknowledged:true});}
  const stopped=await terminal(x,repeat.work_id);assert.equal(stopped.state,'paused',JSON.stringify(stopped));const prior=checkpoint(x,stopped.run_id).observations.find(item=>item.invocation.tool_name==='runtime_pack_run');assert.equal(prior.receipt.status,'retryable_failure');assert.equal(prior.receipt.effect_state,'none');assert.equal(prior.receipt.retry_safe,true);
  await writeFile(x.source,JSON.stringify([{id:'A',score:'13'},{id:'B',score:'21'}]));return {...repeat,stopped,prior,packId:prior.receipt.value.run_id};
}
async function recoverFamily(x,cycle){const tick=await x.api.packs.tick(Date.now()+5000),result=tick.recovered.find(item=>item.run_id===cycle.packId);assert.ok(result,JSON.stringify(tick));assert.equal(result.status,x.recipe.family==='monitor.watch'?'watching':'succeeded');return x.api.store.packRun(x.config.project.id,cycle.packId);}
async function retry(x,cycle){x.model.resume=true;const work=x.api.store.intakeWork(x.config.project.id,cycle.work_id);await x.api.call('runtime_work_control',{work_id:work.id,revision:work.revision,action:'retry'});return terminal(x,work.id);}

test('a canonical failed Pack recovers through a fresh read receipt without replaying its completed output or rewriting history',async t=>{
  const x=await fixture(t),cycle=await outage(x),recovered=await recoverFamily(x,cycle),artifactBefore=await readFile(recovered.result.artifact.path),attempts=x.api.store.packExecution(x.config.project.id,cycle.packId).attempts;
  const end=await retry(x,cycle);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);assert.equal(end.run_id,cycle.stopped.run_id);
  const cp=checkpoint(x,end.run_id),failed=cp.observations.find(item=>item.invocation.tool_name==='runtime_pack_run'),observed=cp.observations.find(item=>item.invocation.tool_name==='runtime_pack_status');assert.deepEqual(failed,cycle.prior);
  assert.ok(observed);assert.equal(observed.invocation.effect,'read_only');assert.equal(observed.invocation.dispatched,true);assert.notEqual(observed.invocation.request_id,failed.invocation.request_id);assert.equal(observed.invocation.arguments.run_id,cycle.packId);assert.equal(observed.receipt.status,'succeeded');assert.equal(observed.receipt.effect_state,'none');assert.ok(observed.receipt.evidence_ids.length>0);
  const read=cp.observations.find(item=>item.invocation.tool_name==='office_result_read');assert.equal(read.receipt.status,'succeeded');assert.equal(read.receipt.value.source_tool,'runtime_pack_status');assert.equal(read.receipt.value.source_run_id,cycle.packId);assert.equal(read.receipt.value.request_id,observed.invocation.request_id);assert.deepEqual(JSON.parse(read.receipt.value.text),[{id:'A',score:13},{id:'B',score:21}]);
  assert.equal(x.api.store.packExecution(x.config.project.id,cycle.packId).attempts,attempts);assert.deepEqual(await readFile(recovered.result.artifact.path),artifactBefore);assert.equal(x.api.store.officeRuns(x.config.project.id,cycle.work_id).length,1);
  const starts=x.api.store.hermesState.prepare("SELECT metadata FROM office_activity WHERE project_id=? AND work_id=? AND kind='tool.started'").all(x.config.project.id,cycle.work_id).map(item=>JSON.parse(item.metadata).tool_name);assert.equal(starts.filter(name=>name==='runtime_pack_run').length,1);assert.equal(starts.filter(name=>name==='runtime_pack_status').length,1);
  const goal=x.model.goals.at(-1);assert.deepEqual(goal.checks.map(check=>check.id),['original_user_request']);assert.ok(goal.observations.some(item=>item.evidence_ids.includes(observed.receipt.evidence_ids[0])));assert.deepEqual(failed.receipt.evidence_ids,[],'A failed canonical ID never becomes successful citation evidence.');
});

test('a still pending no-effect Pack stays reviewable and can later retry after actual Family recovery',async t=>{
  const x=await fixture(t),cycle=await outage(x),before=x.api.store.packExecution(x.config.project.id,cycle.packId).attempts,end=await retry(x,cycle);
  assert.equal(end.state,'awaiting_review');assert.equal(end.reason,'WORK_CLIENT_PACK_RECOVERY_PENDING');assert.equal(end.can_resume,true);assert.equal(end.result.completion_verified,false);assert.match(end.result.summary,/Inspect its current status/u);assert.equal(x.api.store.packExecution(x.config.project.id,cycle.packId).attempts,before);
  assert.ok(!checkpoint(x,end.run_id).observations.some(item=>item.invocation.tool_name==='runtime_pack_status'));await recoverFamily(x,cycle);assert.equal((await retry(x,cycle)).state,'succeeded');
});

test('a recovered watch baseline is observed as watching and independently checked without starting another watch',async t=>{
  const x=await fixture(t,{watch:true}),cycle=await outage(x);await recoverFamily(x,cycle);const before=x.api.store.packExecution(x.config.project.id,cycle.packId).attempts,end=await retry(x,cycle);
  assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);assert.equal(x.api.store.packExecution(x.config.project.id,cycle.packId).attempts,before);assert.equal(x.api.store.officeRuns(x.config.project.id,cycle.work_id).length,1);
  const status=checkpoint(x,end.run_id).observations.find(item=>item.invocation.tool_name==='runtime_pack_status');assert.equal(status.receipt.value.status,'watching');assert.equal(status.receipt.value.result.collected_rows,2);assert.ok(x.model.goals.at(-1).checks.some(check=>check.id==='original_user_request'));
});

test('a changed artifact cannot gain final completion from successful stored status metadata',async t=>{
  const x=await fixture(t),cycle=await outage(x),recovered=await recoverFamily(x,cycle),goals=x.model.goals.length;await writeFile(recovered.result.artifact.path,'corrupted output');x.model.resume=true;
  const work=x.api.store.intakeWork(x.config.project.id,cycle.work_id);await x.api.call('runtime_work_control',{work_id:work.id,revision:work.revision,action:'retry'});
  const end=await until(()=>{const status=supervisorStatus(x.api.store,x.config.project.id,work.id);return status?.reason==='WORK_RESULT_READBACK_MISMATCH'?status:null;});
  assert.notEqual(end.state,'succeeded');assert.equal(end.result.completion_verified,false);assert.equal(x.model.goals.length,goals,'The changed bytes are rejected before the original-goal model is invoked.');assert.equal(x.api.store.officeRuns(x.config.project.id,cycle.work_id).length,1);assert.deepEqual(checkpoint(x,end.run_id).observations.find(item=>item.invocation.tool_name==='runtime_pack_run'),cycle.prior);assert.equal(await readFile(recovered.result.artifact.path,'utf8'),'corrupted output');
});

test('the host lookup rejects foreign runs, changed recipes, request identity and prior observed effects',async t=>{
  const x=await fixture(t),cycle=await outage(x);await recoverFamily(x,cycle);const work=x.api.store.intakeWork(x.config.project.id,cycle.work_id),toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,cycle.stopped.run_id,work.spec,work.prompt,()=>{},x.model);t.after(()=>toolkit.close());
  const proposed={...cycle.prior.invocation,dispatched:false,turn:cycle.prior.invocation.turn+1};assert.equal(toolkit.packRequestRecovery(proposed,[cycle.prior]).state,'observe_success');
  const foreign=x.api.store.officeRuns(x.config.project.id,x.original.id)[0].source_id;assert.throws(()=>toolkit.packRequestRecovery(proposed,[{...cycle.prior,receipt:{...cycle.prior.receipt,value:{...cycle.prior.receipt.value,run_id:foreign}}}]),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
  assert.throws(()=>toolkit.packRequestRecovery({...proposed,request_id:'different-request'},[cycle.prior]),/CUSTOM_PACK_REQUEST_ID_CHANGED/u);
  assert.equal(toolkit.packRequestRecovery(proposed,[{...cycle.prior,receipt:{...cycle.prior.receipt,effect_state:'verified'}}]),null);
  const stored=x.api.store.hermesState.prepare('SELECT recipe FROM family_run WHERE project_id=? AND id=?').get(x.config.project.id,cycle.packId).recipe;x.api.store.hermesState.prepare('UPDATE family_run SET recipe=? WHERE project_id=? AND id=?').run(JSON.stringify({...x.recipe,filters:[{field:'id',op:'eq',value:'A'}]}),x.config.project.id,cycle.packId);
  assert.equal(toolkit.packRequestRecovery(proposed,[cycle.prior]),null);x.api.store.hermesState.prepare('UPDATE family_run SET recipe=? WHERE project_id=? AND id=?').run(stored,x.config.project.id,cycle.packId);
});

test('unknown prior effects never invoke the host Pack recovery lookup or another capability',async()=>{
  const tools=[{name:'runtime_pack_run',description:'Fixture canonical Pack.',input_schema:{type:'object'},effect:'local_write'},{name:'runtime_pack_status',description:'Fixture read.',input_schema:{type:'object'},effect:'read_only'}],request={work_id:'uncertain-work',run_id:'uncertain-run',prompt:'Observe current data.',completion_checks:[{id:'output',result:'Output is observed.',evidence:'A host receipt.'}]};
  let dispatches=0,recoveries=0;const model={calls:[],async call(){return action('runtime_pack_run',{recipe:{}});}},hooks={tools,toolRequestId:()=> 'stable-request',async checkpoint(){},async executeTool(){dispatches++;return {status:'reconciliation_required',value:{run_id:randomUUID()},evidence_ids:[],effect_state:'uncertain',retry_safe:false};},packRequestRecovery(){recoveries++;assert.fail('Unknown effects cannot use status recovery.');}};
  const first=await new BoundedWorkClientExecutor(model).execute(request,hooks);assert.equal(first.status,'reconciliation_required');const next=await new BoundedWorkClientExecutor(model).execute({...request,checkpoint:first.checkpoint,resume_wait:true},hooks);assert.equal(next.status,'reconciliation_required');assert.equal(dispatches,1);assert.equal(recoveries,0);
});

test('parent pause during the new recovery status read fences subsequent completion while preserving the actual read',async t=>{
  const x=await fixture(t),cycle=await outage(x,{scheduled:true,t});await recoverFamily(x,cycle);let reached,release;const observed=new Promise(resolve=>{reached=resolve;}),gate=new Promise(resolve=>{release=resolve;}),originalCall=x.api.call.bind(x.api);t.after(()=>release?.());
  x.api.call=async(name,args)=>{if(name==='runtime_pack_status'&&args.run_id===cycle.packId){reached();await gate;}return originalCall(name,args);};x.model.resume=true;const child=x.api.store.intakeWork(x.config.project.id,cycle.work_id);await x.api.call('runtime_work_control',{work_id:child.id,revision:child.revision,action:'retry'});await observed;
  const parent=x.api.store.intakeWork(x.config.project.id,x.original.id);await originalCall('runtime_work_pause',{work_id:parent.id,revision:parent.revision,paused:true});release();const end=await terminal(x,child.id);assert.equal(end.state,'paused');assert.equal(end.result.completion_verified,false);assert.equal(x.api.store.officeRuns(x.config.project.id,child.id).length,1);
  const cp=checkpoint(x,end.run_id);assert.deepEqual(cp.observations.find(item=>item.invocation.tool_name==='runtime_pack_run'),cycle.prior);assert.ok(cp.observations.some(item=>item.invocation.tool_name==='runtime_pack_status'&&item.receipt.status==='succeeded'));
});
