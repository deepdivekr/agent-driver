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

test('runtime fixture: no new receipt or external send cannot become a correction',async()=>{
  for(const [next,reason] of [[complete(['source']),'WORK_CLIENT_COMPLETION_REPAIR_NO_NEW_EVIDENCE'],[tool('send_external'),'WORK_CLIENT_COMPLETION_REPAIR_EXTERNAL_EFFECT_FORBIDDEN']]){
    const model=provider([tool('read_source'),complete(['source']),next]),hooks=host(),result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'awaiting_review');assert.equal(result.reason,reason);assert.equal(result.completion_verified,false);
    assert.deepEqual(hooks.verifications,[1]);assert.deepEqual(hooks.dispatches.map(item=>item.name),['read_source']);
  }
});

test('runtime fixture: completion repair may refresh a known no-effect read with fresh preflight and a new request identity',async()=>{
  const model=provider([tool('read_source'),complete(['source']),tool('read_source'),complete(['source'])]),hooks=host(),preflights=[];
  hooks.validateTool=async(name,args,context)=>preflights.push({name,args,...context});
  hooks.executeTool=async(name,args,context)=>{
    hooks.dispatches.push({name,args,...context});
    return {status:'succeeded',value:hooks.dispatches.length===1?{rows:['A','B','C']}:{rows:['A','B','C'],original_status:'open'},evidence_ids:['source'],effect_state:'none',retry_safe:true};
  };
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);
  assert.deepEqual(hooks.verifications,[1,2]);assert.equal(hooks.dispatches.length,2);assert.equal(preflights.length,2);
  assert.notEqual(hooks.dispatches[0].request_id,hooks.dispatches[1].request_id);
  assert.deepEqual(hooks.dispatches.map(item=>item.args),[{},{}]);
  assert.equal(result.checkpoint.observations[1].receipt.value.original_status,'open');
});

test('runtime fixture: repair preserves local-write replay and positively observed-effect boundaries',async()=>{
  for(const [first,next,verifiedRead] of [[tool('save_result',{text:'A'}),tool('save_result',{text:'A'}),false],[tool('read_source'),tool('read_source'),true]]){
    const model=provider([first,complete([verifiedRead?'source':'output']),next]),hooks=host();
    if(verifiedRead){const execute=hooks.executeTool;hooks.executeTool=async(...args)=>({...await execute(...args),effect_state:'verified'});}
    const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'awaiting_review');assert.equal(result.reason,'WORK_CLIENT_COMPLETION_REPAIR_REPLAY_FORBIDDEN');
    assert.equal(result.completion_verified,false);assert.equal(hooks.dispatches.length,1);
  }
});

test('runtime fixture: repair considers failed dispatched reads and permits only positively no-effect refreshes',async()=>{
  for(const previousEffect of ['none','verified']){
    const model=provider([tool('read_source'),tool('read_output'),complete(['output']),tool('read_source'),complete(['source','output'])]),hooks=host();
    hooks.tools=[...tools,{name:'read_output',description:'Read an existing result.',input_schema:{type:'object',properties:{},additionalProperties:false},effect:'read_only'}];
    hooks.executeTool=async(name,args)=>{
      hooks.dispatches.push({name,args});
      if(hooks.dispatches.length===1)return {status:'retryable_failure',value:{error:'READ_INCOMPLETE'},evidence_ids:[],effect_state:previousEffect,retry_safe:false};
      return {status:'succeeded',value:{rows:['A','B','C'],original_status:'open'},evidence_ids:[name==='read_source'?'source':'output'],effect_state:'none',retry_safe:true};
    };
    hooks.verifyCompletion=async(_checks,observations)=>{hooks.verifications.push(observations.length);return observations.length===2?feedback:true;};
    const result=await new BoundedWorkClientExecutor(model).execute({...request,max_turns:8},hooks);
    assert.equal(result.status,previousEffect==='none'?'succeeded':'awaiting_review');
    assert.equal(result.completion_verified,previousEffect==='none');assert.equal(hooks.dispatches.length,previousEffect==='none'?3:2);
    if(previousEffect==='verified')assert.equal(result.reason,'WORK_CLIENT_COMPLETION_REPAIR_REPLAY_FORBIDDEN');
    assert.equal(result.checkpoint.observations[0].receipt.status,'retryable_failure');
  }
});

test('runtime fixture: an uncertain refresh fences further repair actions and completion',async()=>{
  const model=provider([tool('read_source'),complete(['source']),tool('read_source'),tool('read_source')]),hooks=host();
  const execute=hooks.executeTool;
  hooks.executeTool=async(...args)=>{
    const receipt=await execute(...args);
    return hooks.dispatches.length===2?{...receipt,status:'reconciliation_required',effect_state:'uncertain',evidence_ids:[],retry_safe:false}:receipt;
  };
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'reconciliation_required');assert.equal(result.completion_verified,false);
  assert.equal(hooks.dispatches.length,2);assert.equal(model.inputs.length,3);assert.deepEqual(hooks.verifications,[1]);
  assert.equal(result.checkpoint.observations.at(-1).receipt.effect_state,'uncertain');
});

test('runtime fixture: refreshing reads remains limited by the three-dispatch completion repair budget',async()=>{
  const model=provider([tool('read_source'),complete(['source']),...Array.from({length:4},()=>tool('read_source'))]),hooks=host();
  const result=await new BoundedWorkClientExecutor(model).execute({...request,max_turns:8},hooks);
  assert.equal(result.status,'awaiting_review');assert.equal(result.reason,'WORK_CLIENT_COMPLETION_REPAIR_TOOL_BUDGET');
  assert.equal(result.completion_verified,false);assert.equal(hooks.dispatches.length,4);assert.deepEqual(hooks.verifications,[1]);
});

test('runtime fixture: refreshed receipt cannot override independent denial or a current permission boundary',async()=>{
  const denied=host();denied.verifyCompletion=async(_checks,observations)=>{denied.verifications.push(observations.length);return feedback;};
  const refused=await new BoundedWorkClientExecutor(provider([tool('read_source'),complete(['source']),tool('read_source'),complete(['source'])])).execute(request,denied);
  assert.equal(refused.status,'awaiting_review');assert.equal(refused.completion_verified,false);assert.equal(denied.dispatches.length,2);
  assert.deepEqual(denied.verifications,[1,2]);
  const guarded=host();let validations=0;guarded.validateTool=async()=>{if(++validations===2)throw Error('TOOL_PERMISSION_REQUIRED');};
  const blocked=await new BoundedWorkClientExecutor(provider([tool('read_source'),complete(['source']),tool('read_source')])).execute(request,guarded);
  assert.equal(blocked.status,'waiting_approval');assert.equal(blocked.reason,'TOOL_PERMISSION_REQUIRED');assert.equal(guarded.dispatches.length,1);
});

test('runtime fixture: boolean false, model/output invalidity and missing typed denial do not authorize repair',async()=>{
  for(const denied of [false,{verified:false,repair:{code:'WORK_COMPLETION_VERIFIER_QUOTE_UNOBSERVED',check_id:'rows',verdict:'unknown'}}]){
    const model=provider([tool('read_source'),complete(['source']),tool('save_result',{text:'A'})]),hooks=host();hooks.verifyCompletion=async()=>denied;
    const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'awaiting_review');assert.equal(result.checkpoint.completion_repair,undefined);assert.equal(model.inputs.length,2);assert.equal(hooks.dispatches.length,1);
  }
});
