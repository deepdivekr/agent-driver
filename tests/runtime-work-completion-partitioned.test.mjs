import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

const observation=(index,value)=>({
  invocation:{request_id:`request_${index}`,turn:index,stage_id:'collect',tool_name:'browser_read',arguments:{},effect:'read_only',dispatched:true},
  receipt:{status:'succeeded',value,evidence_ids:[`evidence_${index}`],effect_state:'none',retry_safe:true},
  observed_at:'2026-09-30T00:00:00.000Z',
});
const claim=checks=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Only an unverified claim.',wait_reason:null,completed_checks:checks.map((check,index)=>({id:check.id,evidence_ids:[`evidence_${index}`]}))});
const userRequest={prompt:'Preserve every source item and the complete saved result.',completion_condition:'All original source items must be present; a selected subset is insufficient.',delivery_target_ids:['app'],user_directions:[]};

test('runtime fixture: literal completion verifies each generated check separately, then still rejects an unproved original request',async()=>{
  const checks=Array.from({length:3},(_,index)=>({id:`check_${index}`,result:`Report source item ${index}.`,evidence:'The exact source fact.'}));
  const items=checks.map((_,index)=>observation(index,{fact:`Observed source item ${index}.`})),before=structuredClone(items),inputs=[],audits=[];
  const model={calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    assert.equal(input.checks.length,1,'One model judgment has exactly one check.');
    const check=input.checks[0];
    if(check.id==='original_user_request')return {checks:[{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'The required saved result was not observed.'}]};
    const id=check.allowed_evidence_ids[0],record=input.observations.find(item=>item.evidence_ids.includes(id));
    assert.ok(record);const manifest=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id));assert.ok(manifest);
    const ref=manifest.leaf_refs.find(([,path])=>path==='$/fact')[0];
    return {checks:[{id:check.id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'The cited source fact was observed.'}]};
  }};
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:userRequest,audit:event=>audits.push(event)});
  assert.equal(await verify(checks,items,claim(checks)),false);
  assert.deepEqual(inputs.map(input=>input.checks[0].id),['check_0','check_1','check_2','original_user_request'],`Audit codes: ${audits.map(event=>event.code).join(', ')}`);
  assert.deepEqual(inputs.at(-1).checks[0].allowed_evidence_ids,['evidence_0','evidence_1','evidence_2']);
  assert.deepEqual(items,before,'One-check partitioning must not mutate or discard source receipts.');
});

for(const contradiction of [false,true])test(`runtime fixture: every large literal check/receipt pair is inspected once in order${contradiction?' and a contradiction blocks synthesis':''}`,async()=>{
  const checks=[{id:'all_sources',result:'Report both first and last source facts while inspecting all six original receipts.',evidence:'Each whole original source receipt.'}];
  const items=Array.from({length:6},(_,index)=>observation(index,{fact:index===0?'Alpha':index===5?'Beta':`Other ${index}`,rows:index===0?[{status:'Critical'},{status:'Critical'}]:[],content:`Source ${index}: `+'x'.repeat(9500)}));
  const before=structuredClone(items),inputs=[];
  const model={calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs){
      assert.ok(input.eligible_pairs.length>=1&&input.eligible_pairs.length<=2,'A literal batch is bounded to two whole check/receipt pairs.');
      assert.equal(input.checks.length,1);
      return {findings:input.eligible_pairs.map(pair=>{
        const record=input.observations.find(item=>item.record_id===pair.record_id),manifest=input.literal_leaf_manifest.find(item=>item.record_id===pair.record_id);
        assert.ok(record&&manifest);assert.equal(record.value.content.length,`Source ${Number(pair.record_id.slice(7))}: `.length+9500,'No original leaf is truncated.');
        const fact=record.value.fact,ref=manifest.leaf_paths.find(([, ,segment])=>segment==='fact')[0];
        const relation=contradiction&&pair.record_id==='record_3'?'contradicts':fact==='Alpha'||fact==='Beta'?'supports':'irrelevant';
        const refs=relation==='supports'||relation==='contradicts'?[{quote_ref:ref,part:0}]:[];
        if(pair.record_id==='record_0'){
          const statusRefs=manifest.leaf_paths.filter(([, ,segment])=>segment==='status').map(([quote_ref])=>quote_ref);
          assert.equal(statusRefs.length,2);assert.notEqual(statusRefs[0],statusRefs[1],'Equal text at different original row paths has distinct references.');
          refs.push(...statusRefs.map(quote_ref=>({quote_ref,part:0})));
        }
        return {...pair,relation,quote_refs:refs,reason:'Whole receipt inspected.'};
      })};
    }
    const supportive=input.observations.filter(record=>record.findings[0].relation==='supports');
    assert.deepEqual(supportive.map(record=>record.record_id),['record_0','record_5']);
    return {checks:[{id:'all_sources',verdict:'supported',evidence_ids:supportive.map(record=>record.evidence_ids[0]),evidence_quote_refs:supportive.map(record=>({evidence_id:record.evidence_ids[0],quote_ref:record.findings[0].quote_refs[0]})),reason:'Both exact source facts were inspected.'}]};
  }};
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true});
  assert.equal(await verify(checks,items,{...claim(checks),completed_checks:[{id:'all_sources',evidence_ids:items.map(item=>item.receipt.evidence_ids[0])}]}),!contradiction);
  const batches=inputs.filter(input=>input.eligible_pairs),pairs=batches.flatMap(batch=>batch.eligible_pairs);
  const expected=items.map((_,index)=>({check_id:'all_sources',record_id:`record_${index}`}));
  assert.deepEqual(pairs,contradiction?expected.slice(0,pairs.length):expected);
  if(contradiction)assert.ok(pairs.some(pair=>pair.record_id==='record_3'),'The negative case reaches the actual contradictory receipt.');
  assert.equal(new Set(pairs.map(pair=>`${pair.check_id}/${pair.record_id}`)).size,pairs.length);
  assert.equal(inputs.some(input=>input.projection),!contradiction,'A contradiction never reaches a final forced pass.');
  assert.deepEqual(items,before);
});
