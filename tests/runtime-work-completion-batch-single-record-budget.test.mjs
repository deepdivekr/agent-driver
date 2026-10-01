import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const evidenceId='source-nine-rows';
const checks=Array.from({length:6},(_,index)=>({id:`check_${index}`,result:`Preserve all nine original rows and their observed values for independent check ${index}. Verify row identity, every requested column, source status and read-back value against all nine source entries. `.repeat(16),evidence:'The complete original receipt, not an example row or an asserted summary.'}));
const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'A claim only.',wait_reason:null,completed_checks:checks.map(check=>({id:check.id,evidence_ids:[evidenceId]}))};
const originalUserRequest={prompt:'Save all nine original Critical rows.',completion_condition:'The whole original nine-row set, not a selected subset, must be represented in the verified output. '.repeat(12),delivery_target_ids:null,user_directions:[]};
const rows=(columns,fill)=>Array.from({length:9},(_,row)=>Object.fromEntries(Array.from({length:columns},(_,column)=>[`field_${column}`,`row-${row}-column-${column}-${'x'.repeat(fill)}`])));
const observation=value=>({invocation:{request_id:'source-request',turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value,evidence_ids:[evidenceId],effect_state:'none',retry_safe:true},observed_at:'2026-09-30T00:00:00.000Z'});

test('runtime fixture: one indivisible nine-row receipt keeps every original leaf under a bounded 40KB literal batch',async()=>{
  const item=observation({result:{rows:rows(35,18)}}),before=structuredClone(item),inputs=[],audits=[],provider={calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs){const manifest=input.literal_leaf_manifest[0],first=manifest.leaf_paths.find(([,base,segment])=>manifest.base_paths[base].includes('/rows/')&&segment==='field_0');assert.ok(first);
      return {findings:input.eligible_pairs.map(pair=>({...pair,relation:'supports',quote_refs:[{quote_ref:first[0],part:0}],reason:'An exact original row leaf was observed.'}))};}
    return {checks:input.checks.map(check=>({id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'One cited example cannot prove every requested original row.'}))};
  }};
  const verify=createWorkCompletionVerifier(provider,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  assert.ok(Buffer.byteLength(JSON.stringify(item.receipt.value))<=16000);
  assert.equal(await verify(checks,[item],claim),false,'The batch may be inspected, but one example quote is not completion.');
  const batch=inputs.find(input=>input.eligible_pairs);assert.ok(batch);
  const bytes=Buffer.byteLength(JSON.stringify(batch));assert.ok(bytes>32000-2048,`Fixture must exercise the old hard ceiling: ${bytes}`);assert.ok(bytes<=40000-2048);
  assert.equal(batch.literal_leaf_manifest[0].leaf_paths.length,9*35);
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_BATCH_INSPECTED'));
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_CHECK_NOT_SUPPORTED'));
  assert.deepEqual(item,before,'The entire receipt is retained without truncation or mutation.');
});

test('runtime fixture: a receipt beyond the separate 40KB hard ceiling fails before any model call or evidence trimming',async()=>{
  const item=observation({result:{rows:rows(45,9)}}),before=structuredClone(item),audits=[],provider={calls:[],async call(_purpose,_instructions,input){this.calls.push(Buffer.byteLength(JSON.stringify(input)));throw Error('MODEL_MUST_NOT_BE_CALLED');}};
  const largerRequest={...originalUserRequest,completion_condition:originalUserRequest.completion_condition+'Read back and compare every requested field, never a sample. '.repeat(10)};
  const overflowChecks=checks.map(check=>({...check,evidence:check.evidence+' Match every original field to its exact source-row identity before treating a read-back result as complete. '.repeat(35)}));
  const verify=createWorkCompletionVerifier(provider,{literalRefMode:true,originalUserRequest:largerRequest,audit:event=>audits.push(event)});
  assert.ok(Buffer.byteLength(JSON.stringify(item.receipt.value))<=16000);
  assert.equal(await verify(overflowChecks,[item],claim),false);
  assert.equal(provider.calls.length,0,`No model call is permitted for an oversized original receipt; batch bytes: ${provider.calls.join(',')}`);assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_EVIDENCE_BUDGET_EXCEEDED'));
  assert.deepEqual(item,before);
});
