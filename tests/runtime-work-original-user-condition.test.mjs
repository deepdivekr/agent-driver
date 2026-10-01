import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const original={prompt:'Critical인 원본 9행을 모두 보존해 Office 결과에 저장해 줘.',completion_condition:'Critical인 원본행 모두 유지; Office 결과 readback 확인; completion_verified=true.',delivery_target_ids:['app']};
const generated=[{id:'selected_restaurant',result:'선택한 식당 4행을 저장한다.',evidence:'저장된 결과의 해당 식당 행.'}];
const critical=Array.from({length:9},(_,index)=>`Critical ${index+1}`);
const source={invocation:{request_id:'source-request',turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{collected_rows:9,rows:critical.map(title=>({title,severity:'Critical'}))},evidence_ids:['source-nine'],effect_state:'verified',retry_safe:false},observed_at:'2026-09-30T00:00:00.000Z'};
const output=rows=>({invocation:{request_id:'output-request',turn:1,stage_id:'save',tool_name:'office_result_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{text:rows.join('\n')+'\n',artifact:{rows:rows.length}},evidence_ids:['output-rows'],effect_state:'none',retry_safe:true},observed_at:'2026-09-30T00:00:01.000Z'});
const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'The model asserts completion.',wait_reason:null,completed_checks:[{id:'selected_restaurant',evidence_ids:['output-rows']}]};
const supported=(check,id='output-rows',quote='Critical 1')=>({id:check.id,verdict:'supported',evidence_ids:[id],evidence_quotes:[{evidence_id:id,quote}],reason:'An actual observed row is present.'});

test('runtime fixture: a narrowed generated check cannot certify four saved rows when the original user required all nine',async()=>{
  const inputs=[],audits=[],model={calls:[],async call(purpose,instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:input.checks.map(check=>check.id==='selected_restaurant'?supported(check):{id:check.id,verdict:'unsupported',evidence_ids:[],evidence_quotes:[],reason:'The original source has nine Critical rows but the saved result has only four.'})};}};
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:original,audit:event=>audits.push(event)});
  assert.equal(await verify(generated,[source,output(critical.slice(0,4))],claim),false);
  assert.equal(inputs.length,1);assert.deepEqual(inputs[0].original_user_request,original);
  assert.deepEqual(inputs[0].checks.map(check=>check.id),['selected_restaurant','original_user_request']);
  assert.deepEqual(inputs[0].checks[1].allowed_evidence_ids,['source-nine','output-rows']);
  assert.equal(audits.at(-1).code,'WORK_COMPLETION_CHECK_NOT_SUPPORTED');assert.equal(audits.at(-1).issue.check_id,'original_user_request');
});

test('runtime fixture: all nine rows may pass without a preexisting self-referential completion_verified receipt',async()=>{
  const inputs=[],model={calls:[],async call(purpose,instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:input.checks.map(check=>check.id==='selected_restaurant'?supported(check):{id:check.id,verdict:'supported',evidence_ids:['source-nine','output-rows'],evidence_quotes:[{evidence_id:'source-nine',quote:'Critical 9'},{evidence_id:'output-rows',quote:'Critical 9'}],reason:'All nine original Critical rows appear in the saved readback; the host may now set its completion flag.'})};}};
  assert.equal(await createWorkCompletionVerifier(model,{originalUserRequest:original})(generated,[source,output(critical)],claim),true);
  assert.equal(inputs.length,1);assert.equal(inputs[0].original_user_request.completion_condition,original.completion_condition);
  assert.equal(JSON.stringify(inputs[0].observations).includes('completion_verified'),false);
});

test('runtime fixture: a later explicit user direction can supersede a conflicting original output format',async()=>{
  const amended={...original,prompt:'Critical 원본 9행으로 카드뉴스를 만들어 줘.',completion_condition:'Critical 9행을 카드뉴스에 모두 표시해 줘.',user_directions:[{run_id:'user-edit-run',step_id:'output',instruction:'카드뉴스 말고 9행을 모두 담은 요약문으로 바꿔 줘.',created_at:'2026-09-30T00:00:02.000Z'}]};
  const inputs=[],model={calls:[],async call(purpose,instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:input.checks.map(check=>check.id==='selected_restaurant'?supported(check):{id:check.id,verdict:'supported',evidence_ids:['source-nine','output-rows'],evidence_quotes:[{evidence_id:'source-nine',quote:'Critical 9'},{evidence_id:'output-rows',quote:'Critical 9'}],reason:'The trusted later user direction changes the output from card news to a summary, while all nine original rows remain in the saved readback.'})};}};
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:amended});
  assert.equal(await verify(generated,[source,output(critical)],claim),true);
  assert.deepEqual(inputs[0].original_user_request,amended);
  assert.equal(inputs[0].checks.at(-1).id,'original_user_request');
});

test('runtime fixture: eight generated checks retain their limit and require a separate original-request verdict',async()=>{
  const checks=Array.from({length:8},(_,index)=>({...generated[0],id:`generated_${index}`}));
  const fullClaim={...claim,completed_checks:checks.map(check=>({id:check.id,evidence_ids:['output-rows']}))},sizes=[];
  const model={calls:[],async call(purpose,instructions,input){sizes.push(input.checks.length);this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:input.checks.map(check=>check.id==='original_user_request'?{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quotes:[],reason:'The saved subset cannot establish the full original scope.'}:supported(check))};}};
  assert.equal(await createWorkCompletionVerifier(model,{originalUserRequest:original})(checks,[source,output(critical.slice(0,4))],fullClaim),false);
  assert.deepEqual(sizes,[8,1]);
});

test('runtime fixture: production literal mode bounds generated verdict groups while the original gate still sees every receipt',async()=>{
  const four=Array.from({length:4},(_,index)=>({...generated[0],id:`generated_${index}`}));
  const fourClaim={...claim,completed_checks:four.map(check=>({id:check.id,evidence_ids:['output-rows']}))},calls=[];
  const model={calls:[],async call(purpose,instructions,input){calls.push({ids:input.checks.map(check=>check.id),evidence_ids:input.literal_leaf_manifest.flatMap(record=>record.evidence_ids)});this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:input.checks.map(check=>check.id==='original_user_request'?{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'The original source has nine rows but only four were saved.'}:{id:check.id,verdict:'supported',evidence_ids:['output-rows'],evidence_quote_refs:[{evidence_id:'output-rows',quote_ref:input.literal_leaf_manifest.find(record=>record.evidence_ids.includes('output-rows')).leaf_refs[0][0]}],reason:'The selected restaurant rows were saved.'})};}};
  assert.equal(await createWorkCompletionVerifier(model,{originalUserRequest:original,literalRefMode:true})(four,[source,output(critical.slice(0,4))],fourClaim),false);
  assert.deepEqual(calls.flatMap(call=>call.ids),[...four.map(check=>check.id),'original_user_request'],'Every requested verdict and original-user gate is evaluated exactly once.');
  assert.ok(calls.every(call=>call.ids.length>=1&&call.ids.length<=8),'Every shared group remains schema bounded.');
  assert.equal(calls.length,1,'These bounded checks share one evidence pass without dropping the original gate.');
  assert.deepEqual(new Set(calls.at(-1).evidence_ids),new Set(['source-nine','output-rows']),'The original gate still sees both complete source and output receipts.');
});
