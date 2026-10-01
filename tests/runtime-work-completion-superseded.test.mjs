import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier,supersededOutputEvidence} from '../dist/work/completion.js';
import {supervisorCompletionClaim} from '../dist/work/supervisor.js';

// A1 regression: an earlier Office result file that a later draft replaced must
// not block the current correct result, while a conflict in the current result
// still does. Fixture models stand in for verifier judgments; no real model runs.
const at=turn=>`2026-10-01T00:00:${String(turn).padStart(2,'0')}.000Z`;
const source=(turn,text)=>({invocation:{request_id:`source-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url:'https://nodejs.org/en/blog',title:'Node.js blog',text},evidence_ids:[`ev-source-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
const artifact=(request,text,format='txt')=>({path:`/work-artifacts/${request}.${format}`,sha256:'a'.repeat(64),bytes:text.length,format});
const draft=(turn,request,text,title='Node release summary',format='txt')=>({invocation:{request_id:request,turn,stage_id:'write',tool_name:'office_result_draft',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{status:'succeeded',work_id:'work',run_id:'run',request_id:request,title,text,artifact:artifact(request,text,format),deduplicated:false,external_delivery:false},evidence_ids:[`ev-${request}`],effect_state:'verified',retry_safe:false},observed_at:at(turn)});
const readback=(turn,request,text)=>({invocation:{request_id:`read-${request}`,turn,stage_id:'write',tool_name:'office_result_read',arguments:{request_id:request},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{status:'succeeded',work_id:'work',run_id:'run',request_id:request,source_tool:'office_result_draft',title:'Node release summary',text,artifact:artifact(request,text),verified_by:'independent_sha256_and_bytes_readback'},evidence_ids:[`ev-read-${request}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
const wrong='Summary: Node.js 23 is the latest release.',right='Summary: Node.js 24 is the latest release.';
const checks=[{id:'summary_saved',result:'A summary naming the latest Node.js release is saved and read back.',evidence:'The saved and read-back summary.'}];
const originalUserRequest={prompt:'Find the latest Node.js release and save a one-line summary.',completion_condition:null,delivery_target_ids:null,user_directions:[]};
const claimFor=ids=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'A claim, not evidence.',wait_reason:null,completed_checks:[{id:'summary_saved',evidence_ids:ids}]});
const leafRef=(manifest,segment)=>{const leaf=manifest.leaf_paths.find(row=>row[2]===segment)??manifest.leaf_paths[0];return {quote_ref:leaf[0],part:0};};

function batchFixture(){
  const inputs=[];
  return {inputs,calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs)return {findings:input.eligible_pairs.map(pair=>{
      const record=input.observations.find(item=>item.record_id===pair.record_id),manifest=input.literal_leaf_manifest.find(item=>item.record_id===pair.record_id);
      const conflict=JSON.stringify(record.value).includes('Node.js 23');
      return {...pair,relation:conflict?'contradicts':'supports',quote_refs:[leafRef(manifest,'text')],reason:conflict?'Names an older release.':'Names the latest release.'};
    })};
    assert.equal(input.projection,'host_validated_leaf_findings');
    return {checks:input.checks.map(check=>{
      const cites=input.observations.filter(record=>!record.host_superseded_by).flatMap(record=>record.findings.filter(finding=>finding.check_id===check.id&&finding.relation==='supports').slice(0,1).map(finding=>({evidence_id:record.evidence_ids[0],quote_ref:finding.quote_refs[0]})));
      return {id:check.id,verdict:'supported',evidence_ids:cites.map(item=>item.evidence_id),evidence_quote_refs:cites,reason:'The current saved summary names the latest release.'};
    })};
  }};
}

test('A1: a replaced earlier draft is labelled and does not block the current correct result',async()=>{
  const items=[source(0,'Node.js 24 released. '.repeat(700)),source(1,'Node.js 24 is the current release. '.repeat(400)),draft(2,'draft-1',wrong),readback(3,'draft-1',wrong),draft(4,'draft-2',right),readback(5,'draft-2',right)];
  const model=batchFixture(),audits=[],verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  const current=['ev-source-0','ev-source-1','ev-draft-2','ev-read-draft-2'];
  assert.equal(await verify(checks,items,claimFor(current)),true,JSON.stringify(audits.map(event=>event.code)));
  assert.ok(model.inputs.some(input=>input.eligible_pairs),'The fixture exercises batched inspection.');
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_BATCH_INSPECTED'&&event.batch_findings.some(finding=>finding.relation==='contradicts')),'The replaced draft conflict is recorded, not hidden.');
  const final=model.inputs.at(-1);
  const replaced=final.observations.filter(record=>record.host_superseded_by==='ev-draft-2').flatMap(record=>record.evidence_ids).sort();
  assert.deepEqual(replaced,['ev-draft-1','ev-read-draft-1'],'Both the replaced draft and its readback stay visible with the host label.');
});

test('A1: a conflict in the current result still blocks completion',async()=>{
  const items=[source(0,'Node.js 24 released. '.repeat(700)),source(1,'Node.js 24 is the current release. '.repeat(400)),draft(2,'draft-1',wrong),readback(3,'draft-1',wrong)];
  const model=batchFixture(),audits=[],verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  assert.equal(await verify(checks,items,claimFor(['ev-source-0','ev-source-1','ev-draft-1','ev-read-draft-1'])),false);
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_BATCH_CONTRADICTS'));
  assert.equal(model.inputs.some(input=>input.projection),false);
});

test('A1: the final verifier may not cite a replaced output, and gets one correction',async()=>{
  const items=[source(0,'Node.js 24 released.'),draft(1,'draft-1',wrong),draft(2,'draft-2',right)];
  const inputs=[],audits=[],model={calls:[],async call(purpose,_instructions,input){
    inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    assert.equal(input.projection,'host_literal_leaf_refs','Small receipts are judged directly.');
    const target=input.correction?'ev-draft-2':'ev-draft-1',record=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(target));
    return {checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:[target],evidence_quote_refs:[{evidence_id:target,quote_ref:record.leaf_refs.find(row=>row[1]==='$/text')[0]}],reason:'A saved summary names a release.'}))};
  }};
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  assert.equal(await verify(checks,items,claimFor(['ev-draft-1','ev-draft-2'])),true);
  assert.equal(inputs.length,2);
  assert.ok(inputs[0].observations.some(record=>record.evidence_ids.includes('ev-draft-1')&&record.host_superseded_by==='ev-draft-2'));
  assert.equal(audits.find(event=>event.status==='rejected').code,'WORK_COMPLETION_SUPERSEDED_EVIDENCE_CITED');
});

test('A1: only a later draft with the same title and format replaces an earlier one',()=>{
  const replaced=supersededOutputEvidence([draft(0,'a',wrong),draft(1,'b',right,'Other deliverable'),draft(2,'c',right,'Node release summary','csv'),draft(3,'d',right),readback(4,'a',wrong),readback(5,'d',right)]);
  assert.deepEqual([...replaced.entries()].sort(),[['ev-a','ev-d'],['ev-read-a','ev-d']]);
  assert.equal(supersededOutputEvidence([draft(0,'same',right),draft(1,'same',right)]).size,0,'A deduplicated retry of the same request replaces nothing.');
});

test('A1: generated checks are not widened with a replaced draft unless the worker cites it',()=>{
  const items=[source(0,'Node.js 24 released.'),draft(1,'draft-1',wrong),draft(2,'draft-2',right)];
  const widened=supervisorCompletionClaim(items,claimFor(['ev-draft-2']),'trace-id',true).completed_checks[0].evidence_ids;
  assert.deepEqual(widened,['ev-draft-2','ev-source-0','trace-id']);
  const cited=supervisorCompletionClaim(items,claimFor(['ev-draft-1']),'trace-id',true).completed_checks[0].evidence_ids;
  assert.ok(cited.includes('ev-draft-1'),'An explicit citation is kept, so the verifier can reject it.');
});

test('A1: a 180-row, 15KB table receipt is judged instead of failing on the citation index budget',async()=>{
  const rows=Array.from({length:180},(_,index)=>({id:`us${7000+index}`,mag:(2+index%50/10).toFixed(1),place:`${index} km N of Town`,time:`2026-09-30T0${index%10}:00:00Z`}));
  const item={invocation:{request_id:'quakes',turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{source:'usgs',rows},evidence_ids:['ev-quakes'],effect_state:'none',retry_safe:true},observed_at:at(0)};
  assert.ok(Buffer.byteLength(JSON.stringify(item.receipt.value))<=16000);
  const tableChecks=[{id:'rows_saved',result:'All observed rows are present.',evidence:'The rows receipt.'}];
  const audits=[],model={calls:[],async call(purpose,_instructions,input){
    this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs){const table=input.literal_leaf_manifest[0].tables[0];return {findings:input.eligible_pairs.map(pair=>({...pair,relation:'supports',quote_refs:[{quote_ref:`${table.ref_prefix}.179.0`,part:0}],reason:'Row identities observed.'}))};}
    return {checks:input.checks.map(check=>{const finding=input.observations[0].findings.find(item=>item.check_id===check.id);assert.deepEqual(finding.quotes,['us7179']);assert.deepEqual(finding.quote_paths,['$/rows/179/id']);return {id:check.id,verdict:'supported',evidence_ids:['ev-quakes'],evidence_quote_refs:[{evidence_id:'ev-quakes',quote_ref:finding.quote_refs[0]}],reason:'Rows observed.'};})};
  }};
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:{...originalUserRequest,prompt:'Collect today\'s USGS earthquakes.'},audit:event=>audits.push(event)});
  assert.equal(await verify(tableChecks,[item],{...claimFor(['ev-quakes']),completed_checks:[{id:'rows_saved',evidence_ids:['ev-quakes']}]}),true,JSON.stringify(audits.map(event=>event.code)));
  assert.equal(audits.some(event=>event.code==='WORK_COMPLETION_EVIDENCE_BUDGET_EXCEEDED'),false);
});
