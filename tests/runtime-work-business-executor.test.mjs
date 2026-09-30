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

test('a completed stage cannot be dispatched again after its execution claim',async()=>{
  const claim={stage_id:'collect',evidence_ids:['collect-receipt']};
  const x=fixture([decision('tool','collect'),decision('tool','collect',[claim]),decision('wait','compare',[claim])]);
  const result=await x.executor.execute(request(),x.hooks);
  assert.equal(result.status,'paused');assert.equal(x.model.calls.length,3);
  assert.deepEqual(x.executions.map(item=>item.stage_id),['collect']);
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect']);
  assert.match(JSON.stringify(x.model.calls[2].input.validation_error.issues),/WORK_CLIENT_STAGE_ALREADY_COMPLETED/u);
});
