import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';

for(const outcome of ['supported','unknown','foreign_quote'])test(`runtime contract oversized final verdict groups retain all inspected evidence: ${outcome}`,async()=>{
  const rows=Array.from({length:40},(_,index)=>({id:`row-${index}`,detail:`Observed original detail ${index} `.padEnd(260,'x')}));
  const observations=[0,1].map(index=>({invocation:{request_id:`read-${index}`,turn:index,stage_id:'read',tool_name:'read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{rows},evidence_ids:[`evidence-${index}`],effect_state:'none',retry_safe:true},observed_at:'2026-10-01T00:00:00.000Z'}));
  const checks=Array.from({length:6},(_,index)=>({id:`check_${index}`,result:'Both complete observed sources must retain their original details.',evidence:'Every detail and original path.'}));
  const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Not evidence.',wait_reason:null,completed_checks:checks.map(check=>({id:check.id,evidence_ids:['evidence-0','evidence-1']}))};
  let inspections=0;const verdicts=[],audits=[];
  const model={calls:[],async call(purpose,_instructions,input){
    this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
    if(input.eligible_pairs){
      inspections++;
      return {findings:input.eligible_pairs.map(pair=>{
        const manifest=input.literal_leaf_manifest.find(record=>record.record_id===pair.record_id);
        const selected=manifest.leaf_paths.filter(([,base,segment])=>`${manifest.base_paths[base]}/${segment}`.endsWith('/detail'));
        assert.equal(selected.length,40);
        return {...pair,relation:'supports',quote_refs:selected.map(([quote_ref])=>({quote_ref,part:0})),reason:'All original details were inspected.'};
      })};
    }
    assert.equal(input.projection,'host_validated_leaf_findings');
    assert.ok(Buffer.byteLength(JSON.stringify(input))<=64000);
    assert.equal(input.manifest.length,2);assert.equal(input.observations.length,2);
    verdicts.push(input.checks.map(check=>check.id));
    return {checks:input.checks.map(check=>{
      const excerpts=input.observations.map(record=>{
        const finding=record.findings.find(finding=>finding.check_id===check.id);
        assert.ok(finding);assert.equal(finding.quotes.length,40);
        assert.deepEqual(finding.quotes,rows.map(row=>row.detail));
        assert.equal(new Set(finding.quote_paths).size,40);
        return {evidence_id:record.evidence_ids[0],quote_ref:finding.quote_refs[0]};
      });
      return {id:check.id,verdict:outcome==='unknown'&&check.id==='check_5'?'unknown':'supported',evidence_ids:['evidence-0','evidence-1'],evidence_quote_refs:outcome==='foreign_quote'?[{evidence_id:'evidence-0',quote_ref:'foreign-ref'}]:excerpts,reason:'Only the complete original evidence can establish the requested result.'};
    })};
  }};
  const actual=await createWorkCompletionVerifier(model,{literalRefMode:true,audit:event=>audits.push(event)})(checks,observations,claim);
  assert.equal(actual,outcome==='supported',JSON.stringify(audits.map(event=>event.code)));
  assert.equal(inspections,2,'Final verdict partitioning never repeats original inspection.');
  assert.ok(verdicts.length>1);
  assert.deepEqual(verdicts.slice(0,outcome==='foreign_quote'?verdicts.length/2:verdicts.length).flat(),checks.map(check=>check.id));
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_VERDICT_GROUP_OBSERVED'));
  assert.equal(audits.some(event=>event.code==='WORK_COMPLETION_VERIFIED'),outcome==='supported');
});
