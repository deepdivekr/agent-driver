import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const request={work_id:'repair-work',run_id:'repair-run',prompt:'Preserve all original rows in the Office output.',completion_checks:[{id:'rows',result:'All original rows appear in the saved result.',evidence:'Read the source and saved output.'}],max_turns:6};
const tools=[{name:'read_source',description:'Read original rows.',input_schema:{type:'object',properties:{},additionalProperties:false},effect:'read_only'},{name:'save_result',description:'Save a local Office result.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},effect:'local_write'},{name:'send_external',description:'Externally send content.',input_schema:{type:'object',properties:{},additionalProperties:false},effect:'external_write'}];
const tool=(name,args={})=>({action:'tool',stage_id:'collect',tool_name:name,arguments_json:JSON.stringify(args),summary:`Use ${name}.`,completed_checks:[],wait_reason:null});
const complete=ids=>({action:'complete',stage_id:'done',tool_name:null,arguments_json:null,summary:'Claim all rows are present.',completed_checks:[{id:'rows',evidence_ids:ids}],wait_reason:null});
const feedback={verified:false,repair:{code:'WORK_COMPLETION_CHECK_NOT_SUPPORTED',check_id:'original_user_request',verdict:'unsupported'}};
function provider(queue){return {calls:[],inputs:[],async call(purpose,instructions,input,schema){hashJson({instructions,input,schema});this.inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return queue.shift();}};}
function host(){const dispatches=[],saved=[],verifications=[];return {dispatches,saved,verifications,tools,async checkpoint(value){saved.push(structuredClone(value));},async executeTool(name,args){dispatches.push({name,args});return name==='read_source'?{status:'succeeded',value:{rows:['A','B','C']},evidence_ids:['source'],effect_state:'none',retry_safe:true}:{status:'succeeded',value:{text:args.text},evidence_ids:['output'],effect_state:'verified',retry_safe:false};},async verifyCompletion(_checks,observations){verifications.push(observations.length);return observations.length===1?feedback:true;}};}

test('runtime fixture: substantive independent denial permits one bounded local correction, then re-verifies new evidence',async()=>{
  const model=provider([tool('read_source'),complete(['source']),tool('save_result',{text:'A\nB\nC'}),complete(['source','output'])]),hooks=host();
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);
  assert.deepEqual(hooks.verifications,[1,2]);assert.deepEqual(hooks.dispatches.map(item=>item.name),['read_source','save_result']);
  assert.equal(result.checkpoint.completion_repair.attempts,1);assert.deepEqual(result.checkpoint.completion_repair.prior_successful_request_ids,[result.checkpoint.observations[0].invocation.request_id]);
  assert.deepEqual(model.inputs[2].checkpoint.completion_repair,{...feedback.repair,attempts:1,prior_successful_request_ids:[result.checkpoint.observations[0].invocation.request_id],prior_dispatched_request_ids:[result.checkpoint.observations[0].invocation.request_id]});
  assert.equal(Object.hasOwn(model.inputs[2].checkpoint,'verification_pending'),false);
});

test('runtime fixture: no new receipt, identical replay or external send cannot become a correction',async()=>{
  for(const [next,reason] of [[complete(['source']),'WORK_CLIENT_COMPLETION_REPAIR_NO_NEW_EVIDENCE'],[tool('read_source'),'WORK_CLIENT_COMPLETION_REPAIR_REPLAY_FORBIDDEN'],[tool('send_external'),'WORK_CLIENT_COMPLETION_REPAIR_EXTERNAL_EFFECT_FORBIDDEN']]){
    const model=provider([tool('read_source'),complete(['source']),next]),hooks=host(),result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'awaiting_review');assert.equal(result.reason,reason);assert.equal(result.completion_verified,false);
    assert.deepEqual(hooks.verifications,[1]);assert.deepEqual(hooks.dispatches.map(item=>item.name),['read_source']);
  }
});

test('runtime fixture: boolean false, model/output invalidity and missing typed denial do not authorize repair',async()=>{
  for(const denied of [false,{verified:false,repair:{code:'WORK_COMPLETION_VERIFIER_QUOTE_UNOBSERVED',check_id:'rows',verdict:'unknown'}}]){
    const model=provider([tool('read_source'),complete(['source']),tool('save_result',{text:'A'})]),hooks=host();hooks.verifyCompletion=async()=>denied;
    const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'awaiting_review');assert.equal(result.checkpoint.completion_repair,undefined);assert.equal(model.inputs.length,2);assert.equal(hooks.dispatches.length,1);
  }
});
