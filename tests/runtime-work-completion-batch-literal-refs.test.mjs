import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const rows=Array.from({length:90},(_,index)=>({id:`row-${index}`,title:`Observed source ${index}`,value:index}));
const observation=(index)=>({invocation:{request_id:`request-${index}`,turn:index,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{rows,artifact:{format:'json',row_count:rows.length}},evidence_ids:[`evidence-${index}`],effect_state:'verified',retry_safe:false},observed_at:`2026-09-30T00:00:0${index}.000Z`});
const observations=[observation(0),observation(1)];
const checks=[{id:'all_rows',result:'Keep the observed source rows.',evidence:'Both successful original receipts.'}];
const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'An assertion, not proof.',wait_reason:null,completed_checks:[{id:'all_rows',evidence_ids:['evidence-0','evidence-1']}]};
const cited=(input,recordId)=>{
  const manifest=input.literal_leaf_manifest.find(row=>row.record_id===recordId);
  const leaf=manifest.leaf_paths.find(row=>row[2]==='title');
  assert.ok(manifest.base_paths[leaf[1]].includes('/rows/'));
  return {quote_ref:leaf[0],part:0};
};

test('runtime fixture: oversized literal batch inspects full receipts but emits only host-resolved exact leaf references',async()=>{
  const inputs=[],model={calls:[],async call(purpose,instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs)return {findings:input.eligible_pairs.map(pair=>({...pair,relation:'supports',quote_refs:[cited(input,pair.record_id)],reason:'Actual source title is present.'}))};
    return {checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:['evidence-0','evidence-1'],evidence_quote_refs:input.observations.flatMap(record=>record.findings.filter(finding=>finding.relation==='supports').map(finding=>({evidence_id:record.evidence_ids[0],quote_ref:finding.quote_refs[0]}))),reason:'Both original source receipts have literal observed titles.'}))};
  }};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true})(checks,observations,claim),true);
  const batches=inputs.filter(input=>input.eligible_pairs);assert.ok(batches.length>=1);
  assert.equal(batches.flatMap(input=>input.observations).length,2);
  assert.ok(batches.every(input=>Buffer.byteLength(JSON.stringify(input))<=32000));
  assert.ok(batches.every(input=>input.observations.every(row=>JSON.stringify(row.value).includes('Observed source 89'))));
  assert.equal(inputs.at(-1).projection,'host_validated_leaf_findings');
});

test('runtime fixture: invented batch leaf reference gets only one output correction, never a forced pass',async()=>{
  const audits=[],model={calls:[],async call(purpose,instructions,input){this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});assert.ok(input.eligible_pairs);return {findings:input.eligible_pairs.map(pair=>({...pair,relation:'supports',quote_refs:[{quote_ref:'q_invented',part:0}],reason:'A fabricated citation.'}))};}};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,audit:event=>audits.push(event)})(checks,observations,claim),false);
  assert.equal(model.calls.length,2);assert.deepEqual(audits.map(event=>event.code),['WORK_COMPLETION_BATCH_QUOTE_REF_INVALID','WORK_COMPLETION_BATCH_QUOTE_REF_INVALID']);
});

test('runtime fixture: omitted eligible pair or material contradiction cannot be repaired into support',async()=>{
  for(const kind of ['coverage','contradiction']){
    const audits=[],model={calls:[],async call(purpose,instructions,input){this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});assert.ok(input.eligible_pairs);if(kind==='coverage')return {findings:[]};return {findings:input.eligible_pairs.map(pair=>({...pair,relation:'contradicts',quote_refs:[cited(input,pair.record_id)],reason:'Material conflict in original receipt.'}))};}};
    assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,audit:event=>audits.push(event)})(checks,observations,claim),false,kind);
    assert.equal(model.calls.length,1,kind);assert.ok(kind==='coverage'?['WORK_COMPLETION_BATCH_COVERAGE_INVALID','WORK_COMPLETION_VERIFIER_OUTPUT_INVALID'].includes(audits.at(-1).code):audits.at(-1).code==='WORK_COMPLETION_BATCH_CONTRADICTS');
  }
});
