import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';
import {modelWorkPlan} from '../dist/work/plan.js';
const plan=modelWorkPlan({steps:[{id:'save',goal:'Save every requested row',observable_outcome:'The bound output exists',depends_on:[],effect:'local_write',tool_hints:[]}]},'Save requested rows','local_file_write');
const req={work_id:'owned-work',run_id:'owned-supervisor',prompt:'Save requested rows',plan,completion_checks:[{id:'all_rows',result:'Every requested row is saved',evidence:'Full artifact readback'}]};
const tool=(name,args,claims=[])=>({action:'tool',stage_id:'save',tool_name:name,arguments_json:JSON.stringify(args),summary:'Read the saved output',wait_reason:null,completed_stages:claims,completed_checks:[]});
const complete=(claims=[])=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Propose completion',wait_reason:null,completed_stages:claims,completed_checks:[{id:'all_rows',evidence_ids:['saved-output']}]});
const wait={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Required evidence is unavailable',wait_reason:'configuration',completed_stages:[],completed_checks:[]};
const tools=[{name:'runtime_pack_run',effect:'local_write'},{name:'runtime_pack_status',effect:'read_only'},{name:'office_result_read',effect:'read_only'}].map(item=>({...item,description:'Bound capability',input_schema:{type:'object'}}));
async function saved(catalog=tools){
 const outputs=[tool('runtime_pack_run',{}),complete([{stage_id:'save',evidence_ids:['saved-output']}])];
 const model={calls:[],async call(){this.calls.push({});return outputs.shift();}};
 const result=await new BoundedWorkClientExecutor(model).execute(req,{tools:catalog,async checkpoint(){},async executeTool(){return {status:'succeeded',value:{run_id:'owned-pack',artifact:{bytes:10}},evidence_ids:['saved-output'],effect_state:'verified',retry_safe:false};},async verifyCompletion(){return false;}});
 assert.equal(result.status,'awaiting_review');return result.checkpoint;
}
async function resume(checkpoint,outputs,overrides={}){
 const inputs=[],dispatched=[];
 const model={calls:[],async call(_purpose,_instructions,input){inputs.push(structuredClone(input));this.calls.push({});return outputs.shift();}};
 const result=await new BoundedWorkClientExecutor(model).execute({...req,checkpoint,resume_wait:true},{tools,async checkpoint(){},async executeTool(name,args){dispatched.push({name,args});return {status:'succeeded',value:{run_id:'owned-pack',text:'all rows',rows:1},evidence_ids:['new-read-'+dispatched.length],effect_state:'none',retry_safe:true};},async verifyCompletion(){return true;},...overrides});
 return {result,inputs,dispatched};
}
test('runtime fixture saved-result completion can reread its own Pack status and artifact after every stage is reported',async()=>{
 const before=await saved(),request_id=before.observations[0].invocation.request_id;
 const x=await resume(before,[tool('runtime_pack_status',{run_id:'owned-pack'}),tool('office_result_read',{request_id,work_id:req.work_id}),complete()]);
 assert.equal(x.result.status,'succeeded');assert.equal(x.result.completion_verified,true);
 assert.deepEqual(x.dispatched.map(item=>item.name),['runtime_pack_status','office_result_read']);
 assert.deepEqual(x.inputs[0].stage_context.allowed_action_stage_ids,[]);
 assert.equal(x.inputs[0].stage_context.saved_result_readback.remaining_reads,3);
 assert.equal(x.inputs[1].stage_context.saved_result_readback.remaining_reads,2);
 assert.deepEqual(x.result.checkpoint.observations.slice(0,before.observations.length),before.observations);
 assert.equal(x.result.checkpoint.stage_reports.length,1);
});
for(const [name,args] of [['runtime_pack_status',{run_id:'foreign-pack'}],['office_result_read',{request_id:'foreign-request'}],['office_result_read',{request_id:'known',work_id:'foreign-work'}],['runtime_pack_run',{}]])
 test('runtime contract completed-result readback rejects '+name+' '+JSON.stringify(args),async()=>{
  const before=await saved(),x=await resume(before,[tool(name,args),wait]);
  assert.equal(x.dispatched.length,0);assert.equal(x.result.status,'paused');
  assert.match(JSON.stringify(x.inputs[1].validation_error),/WORK_CLIENT_STAGE_ALREADY_COMPLETED/);
 });
test('runtime contract completed-result rereads have a three-read budget per admitted executor turn',async()=>{
 const x=await resume(await saved(),[...Array.from({length:4},()=>tool('runtime_pack_status',{run_id:'owned-pack'})),{action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Wait for configuration.',completed_checks:[],wait_reason:'configuration',completed_stages:[]}]);
 assert.equal(x.dispatched.length,3);assert.equal(x.result.status,'paused');
 assert.equal(x.result.checkpoint.observations.at(-1).receipt.value.error,'WORK_CLIENT_RESULT_READBACK_BUDGET','The fourth reread is refused without dispatch, and the model is told to propose completion.');
});
test('runtime contract a readback name cannot disguise an external-write capability',async()=>{
 const catalog=tools.map(item=>item.name==='runtime_pack_status'?{...item,effect:'external_write'}:item);
 const x=await resume(await saved(catalog),[tool('runtime_pack_status',{run_id:'owned-pack'})],{tools:catalog});
 assert.equal(x.dispatched.length,0);assert.equal(x.result.status,'retryable_failure');assert.equal(x.result.reason,'WORK_CLIENT_RESULT_READBACK_EFFECT_INVALID');
});
