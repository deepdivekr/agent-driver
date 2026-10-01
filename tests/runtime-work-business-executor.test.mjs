import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedWorkClientExecutor,workClientBusinessDecisionSchema} from '../dist/work/client-executor.js';
import {modelWorkPlan} from '../dist/work/plan.js';
import {currentStageReports,stageBinding} from '../dist/work/stages.js';

const steps=[
  {id:'collect',goal:'Collect the public source',observable_outcome:'The source content and URL are retained',depends_on:[],effect:'read_only',tool_hints:[]},
  {id:'compare',goal:'Compare the source with the requested claim',observable_outcome:'A grounded comparison is retained',depends_on:['collect'],effect:'draft_only',tool_hints:[]},
];
const plan=modelWorkPlan({steps},'Produce a grounded comparison','read_only');
const decision=(action,stage_id,completed_stages=[],completed_checks=[])=>({action,stage_id,tool_name:action==='tool'?'read_source':null,arguments_json:action==='tool'?'{}':null,summary:`${action} ${stage_id??''}`,completed_checks,wait_reason:action==='wait'?'configuration':null,completed_stages});
const request=(extra={})=>({work_id:'semantic-work',run_id:'semantic-run',prompt:'Compare the requested public claim.',completion_checks:[{id:'comparison',result:'Grounded comparison',evidence:'Source and comparison receipts'}],plan,...extra});
function fixture(outputs){
  const model={calls:[],async call(purpose,instructions,input,schema){this.calls.push({purpose,instructions,input,schema});return structuredClone(outputs.shift());}};
  const saved=[],events=[],executions=[];
  const hooks={tools:[{name:'read_source',description:'Read the selected source',input_schema:{type:'object'},effect:'read_only'}],
    async executeTool(_name,_args,context){executions.push(context);return {status:'succeeded',value:{stage_id:context.stage_id},evidence_ids:[`${context.stage_id}-receipt`],effect_state:'none',retry_safe:true};},
    async checkpoint(value){saved.push(value);},async progress(value){events.push(value);},async verifyCompletion(){return false;}};
  return {model,saved,events,executions,hooks,executor:new BoundedWorkClientExecutor(model)};
}

test('semantic executor binds each operation and accepts stage execution claims only from same-stage receipts',async()=>{
  const x=fixture([
    decision('tool','collect'),
    decision('tool','compare',[{stage_id:'collect',evidence_ids:['collect-receipt']}]),
    decision('complete',null,[{stage_id:'compare',evidence_ids:['compare-receipt']}],[{id:'comparison',evidence_ids:['compare-receipt']}]),
  ]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'awaiting_review');assert.equal(result.completion_verified,false);
  assert.deepEqual(x.executions.map(item=>item.stage_id),['collect','compare']);
  assert.deepEqual(result.checkpoint.observations.map(item=>item.invocation.stage_binding),steps.map((_,index)=>stageBinding(plan.steps[index])));
  assert.deepEqual(currentStageReports(plan,result.checkpoint.stage_reports).map(report=>report.stage_id),['collect','compare']);
  assert.deepEqual(x.events.filter(item=>item.kind==='stage.reported').map(item=>item.stage_id),['collect','compare']);
  assert.equal(x.model.calls[0].schema.required.includes('completed_stages'),true);
  assert.equal(workClientBusinessDecisionSchema.safeParse(decision('wait',null)).success,true);
});

test('unknown stage dispatch enters one output correction and executes no tool',async()=>{
  const x=fixture([decision('tool','invented'),decision('wait',null)]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'paused');assert.equal(x.model.calls.length,2);assert.equal(x.executions.length,0);
  assert.equal(x.model.calls[1].input.validation_error.code,'WORK_CLIENT_DECISION_OUTPUT_INVALID');
  assert.equal(result.checkpoint.stage_reports.length,0);
});

test('cross-stage evidence cannot finish a stage and changed stage contracts invalidate dependent reports',async()=>{
  const x=fixture([decision('tool','collect'),decision('complete',null,[{stage_id:'compare',evidence_ids:['collect-receipt']}],[{id:'comparison',evidence_ids:['collect-receipt']}]),decision('wait',null)]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'paused');assert.equal(x.model.calls.length,3);assert.deepEqual(result.checkpoint.stage_reports,[]);
  const original=[{stage_id:'collect',binding:stageBinding(plan.steps[0]),evidence_ids:['collect-receipt'],reported_at:new Date().toISOString()},{stage_id:'compare',binding:stageBinding(plan.steps[1]),evidence_ids:['compare-receipt'],reported_at:new Date().toISOString()}];
  const changed=modelWorkPlan({steps:[{...steps[0],observable_outcome:'A changed source is retained'},steps[1]]},'Produce a grounded comparison','read_only',plan);
  assert.deepEqual(currentStageReports(changed,original),[],'A changed dependency invalidates a dependent completion report');
});

test('replanned same-ID stage exposes only exact current-binding evidence while retaining historical receipts',async()=>{
  const first=fixture([decision('tool','collect')]);
  const old=await first.executor.execute(request({max_turns:1}),first.hooks);
  assert.equal(old.status,'retryable_failure');assert.equal(old.checkpoint.observations.length,1);
  const previous={stage_id:'collect',binding:stageBinding(plan.steps[0]),evidence_ids:['collect-receipt'],reported_at:new Date().toISOString()};
  const changed=modelWorkPlan({steps:[{...steps[0],observable_outcome:'The newly requested source value is retained'},steps[1]]},'Produce a grounded comparison','read_only',plan);
  const next=fixture([decision('wait',null)]),resumed=await next.executor.execute(request({plan:changed,checkpoint:{...old.checkpoint,stage_reports:[previous]}}),next.hooks);
  assert.equal(resumed.status,'paused');assert.equal(next.executions.length,0);
  const input=next.model.calls[0].input,context=input.stage_context;
  assert.equal(input.checkpoint.observations.length,1,'Historical receipt remains available to final Work verification');
  assert.equal(input.checkpoint.observations[0].invocation.stage_binding,previous.binding);
  assert.equal(context.stages[0].state,'ready');assert.notEqual(context.stages[0].current_binding,previous.binding);
  assert.deepEqual(context.stages[0].eligible_evidence_ids,[]);assert.equal(context.stages[0].stale_same_id_receipt_count,1);
  assert.equal(context.stages[1].state,'blocked');assert.deepEqual(context.allowed_action_stage_ids,['collect']);
  assert.match(context.warning,/same-ID receipt with a different current stage binding cannot support/u);
  assert.match(next.model.calls[0].instructions,/successful receipts under the current stage binding/u);
});

test('a completed stage cannot be dispatched again after its execution claim',async()=>{
  const claim={stage_id:'collect',evidence_ids:['collect-receipt']};
  const x=fixture([decision('tool','collect'),decision('tool','collect',[claim]),decision('wait','compare',[claim])]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'paused');assert.equal(x.model.calls.length,3);
  assert.deepEqual(x.executions.map(item=>item.stage_id),['collect']);
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect']);
  assert.match(JSON.stringify(x.model.calls[2].input.validation_error.issues),/WORK_CLIENT_STAGE_ALREADY_COMPLETED/u);
});

test('same-decision stage claim correction keeps a valid prerequisite and routes only to its newly ready dependent',async()=>{
  const claim={stage_id:'collect',evidence_ids:['collect-receipt']};
  const x=fixture([decision('tool','collect'),decision('tool','collect',[claim]),decision('tool','compare',[claim]),decision('complete',null,[{stage_id:'compare',evidence_ids:['compare-receipt']}],[{id:'comparison',evidence_ids:['compare-receipt']}])]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'awaiting_review');assert.deepEqual(x.executions.map(item=>item.stage_id),['collect','compare']);
  const initial=x.model.calls[1].input,repair=x.model.calls[2].input;
  assert.deepEqual(initial.stage_context.allowed_action_stage_ids,['collect']);
  assert.deepEqual(initial.stage_context.stages[0].if_reported_next_action_stage_ids,['compare']);
  assert.equal(repair.validation_error.issues.find(issue=>issue.path==='stage_id').message,'WORK_CLIENT_STAGE_ALREADY_COMPLETED');
  assert.equal(repair.stage_transition.proposed_claims,'evidence_valid_not_outcome_verified');
  assert.deepEqual(repair.stage_transition.proposed_stage_ids,['collect']);
  assert.deepEqual(repair.stage_transition.allowed_tool_stage_ids_after_claims,['compare']);
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect','compare']);

  const dropped=fixture([decision('tool','collect'),decision('tool','collect',[claim]),decision('tool','compare'),{action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Wait for configuration.',completed_checks:[],wait_reason:'configuration',completed_stages:[]}]);
  const rejected=await dropped.executor.execute(request(),dropped.hooks);
  assert.equal(rejected.status,'paused','A failed correction is not dispatched; the next valid decision continues.');
  assert.deepEqual(dropped.executions.map(item=>item.stage_id),['collect']);
  assert.ok(dropped.events.some(event=>event.validation?.issues.some(issue=>issue.message==='WORK_CLIENT_STAGE_DEPENDENCY_PENDING')));
});

test('awaiting review resumes the same semantic receipts for verification without replaying source reads or file writes',async()=>{
  const tools=[{name:'read_source',description:'Read the selected source',input_schema:{type:'object'},effect:'read_only'},{name:'write_report',description:'Write the verified local report',input_schema:{type:'object'},effect:'local_write'}];
  const first=fixture([decision('tool','collect'),{...decision('tool','compare',[{stage_id:'collect',evidence_ids:['collect-receipt']}]),tool_name:'write_report'},decision('complete',null,[{stage_id:'compare',evidence_ids:['compare-receipt']}],[{id:'comparison',evidence_ids:['compare-receipt']}])]);
  const dispatched=[];first.hooks.tools=tools;first.hooks.executeTool=async(name,_args,context)=>{dispatched.push({name,stage:context.stage_id});return {status:'succeeded',value:{stage_id:context.stage_id},evidence_ids:[`${context.stage_id}-receipt`],effect_state:name==='write_report'?'verified':'none',retry_safe:true};};
  const awaiting=await first.executor.execute(request(),first.hooks);
  assert.equal(awaiting.status,'awaiting_review');assert.deepEqual(dispatched,[{name:'read_source',stage:'collect'},{name:'write_report',stage:'compare'}]);assert.equal(awaiting.checkpoint.pending,null);
  assert.deepEqual(currentStageReports(plan,awaiting.checkpoint.stage_reports).map(report=>report.stage_id),['collect','compare']);
  for(const [stage_id,tool_name] of [['collect','read_source'],['compare','write_report']]){
    const resumed=fixture([{...decision('tool',stage_id),tool_name},decision('complete',null,[],[{id:'comparison',evidence_ids:['compare-receipt']}])]);
    resumed.hooks.tools=tools;let verifiedObservations=null;resumed.hooks.verifyCompletion=async(_checks,observations)=>{verifiedObservations=observations;return true;};
    const result=await resumed.executor.execute(request({checkpoint:awaiting.checkpoint,resume_wait:true}),resumed.hooks);
    assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(resumed.executions.length,0,'no source read or local write is dispatched');
    assert.equal(resumed.model.calls[0].input.stage_id,'completion.verify');assert.match(JSON.stringify(resumed.model.calls[1].input.validation_error.issues),/WORK_CLIENT_STAGE_ALREADY_COMPLETED/u);
    assert.deepEqual(verifiedObservations,awaiting.checkpoint.observations);assert.deepEqual(result.checkpoint.observations,awaiting.checkpoint.observations);
  }
});
