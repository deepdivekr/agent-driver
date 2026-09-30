import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const checks=[{id:'all_rows',result:'Keep all three observed rows in the saved result.',evidence:'Original source and saved readback.'}];
const source={invocation:{request_id:'source-request',turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{rows:[{id:'a'},{id:'b'},{id:'c'}],truncated:false},evidence_ids:['source-evidence'],effect_state:'verified',retry_safe:false},observed_at:'2026-09-30T00:00:00.000Z'};
const output={invocation:{request_id:'read-request',turn:1,stage_id:'read',tool_name:'office_result_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{text:'id\na\nb\nc\n',verified_by:'independent_sha256_and_bytes_readback'},evidence_ids:['output-evidence'],effect_state:'none',retry_safe:true},observed_at:'2026-09-30T00:00:01.000Z'};
const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Agent assertion only.',wait_reason:null,completed_checks:[{id:'all_rows',evidence_ids:['source-evidence','output-evidence']}]};
const ref=(input,id,path)=>input.literal_leaf_manifest.find(row=>row.evidence_ids.includes(id))?.leaf_refs.find(row=>row[1].endsWith(path))?.[0];

test('runtime fixture: direct literal refs resolve to exact original source and readback leaf values',async()=>{
  const inputs=[],model={calls:[],async call(purpose,instructions,input,schema){inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});assert.equal(input.projection,'host_literal_leaf_refs');assert.ok(schema.properties.checks.items.properties.evidence_quote_refs);return {checks:[{id:'all_rows',verdict:'supported',evidence_ids:['source-evidence','output-evidence'],evidence_quote_refs:[{evidence_id:'source-evidence',quote_ref:ref(input,'source-evidence','/rows/2/id')},{evidence_id:'output-evidence',quote_ref:ref(input,'output-evidence','/text')}],reason:'All three source IDs are present in the saved readback.'}]};}};
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true});
  assert.equal(await verify(checks,[source,output],claim),true);
  assert.equal(inputs.length,1);assert.deepEqual(inputs[0].observations.map(row=>row.value),[source.receipt.value,output.receipt.value]);
  assert.equal(inputs[0].literal_leaf_manifest.length,2);
  assert.equal(inputs[0].literal_leaf_manifest[0].leaf_refs.some(row=>row[1].endsWith('/truncated')),false);
});

test('runtime fixture: a foreign or invented literal ref cannot be promoted to grounded completion',async()=>{
  for(const kind of ['foreign','invented']){
    const audits=[],model={calls:[],async call(purpose,instructions,input){this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:[{id:'all_rows',verdict:'supported',evidence_ids:['source-evidence','output-evidence'],evidence_quote_refs:[{evidence_id:'source-evidence',quote_ref:kind==='foreign'?ref(input,'output-evidence','/text'):'q_invented'},{evidence_id:'output-evidence',quote_ref:ref(input,'output-evidence','/text')}],reason:'Claimed grounded evidence.'}]};}};
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,audit:event=>audits.push(event)});
    assert.equal(await verify(checks,[source,output],claim),false,kind);
    assert.equal(model.calls.length,2,kind);
    assert.equal(audits[0].code,'WORK_COMPLETION_LITERAL_QUOTE_REF_INVALID');
  }
});

test('runtime fixture: every long leaf is represented by contiguous bounded literal parts, not a truncated excerpt',async()=>{
  const long='ROW-'.repeat(700),large={...output,receipt:{...output.receipt,value:{text:long}}};
  let observed=null;const model={calls:[],async call(purpose,instructions,input){observed=input;this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return {checks:[{id:'all_rows',verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'The model cannot establish the requested meaning.'}]};}};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true})(checks,[source,large],claim),false);
  assert.equal(observed.projection,'host_literal_leaf_refs');
  const parts=observed.literal_leaf_manifest.find(row=>row.evidence_ids.includes('output-evidence')).leaf_refs;
  assert.equal(parts.length,7);assert.ok(parts.every(row=>row.length===3&&row[1]==='$/text'));
});
