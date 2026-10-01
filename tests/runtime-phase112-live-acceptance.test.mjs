import test from 'node:test';
import assert from 'node:assert/strict';
import {validate as data} from '../scripts/live-pack-data-acceptance.mjs';
import {validate as browser} from '../scripts/live-pack-browser-acceptance.mjs';
import {validate as research} from '../scripts/live-pack-research-watch-acceptance.mjs';

// Negative validator contracts only. These tests are not evidence that a real
// Work or external website executed, and must never enter the live PASS tally.
for(const [family,validate] of [
  ['portal.collect',data],['file.pipeline',data],['inbox.triage',data],['record.update',data],
  ['form.draft-submit',browser],['choose.stage',browser],
  ['research.search',research],['monitor.watch',research],
])test(`live acceptance rejects an unsupported success summary for ${family}`,()=>{
  const item={id:'missing-evidence',family};
  const audit={supervisor:{state:'succeeded',result:{completion_verified:true}},pack_runs:[],observations:[],office_artifacts:[]};
  const result=validate(item,audit,{project:{id:'test'},packs:{sources:[],targets:[],local_records:[]}},[]);
  assert.equal(result.status,'FAIL');
  assert.ok(result.checks.some(check=>check.pass===false));
});

// Read-only validator contracts, not website/driver success evidence.
const browserCase={id:'browser-case',family:'form.draft-submit',target_id:'contact',external_submit_allowed:false};
const draftRun=id=>{
  const values={project:'Unsent validator fixture'};
  return {id,request_id:id,status:'draft_ready',recipe:{family:browserCase.family,target:'contact',values},result:{values,verified_values_before_capture:values,verified_values_after_capture:values,verified_values:values,readback_source:'browser_dom_controls_after_capture'}};
};
const checked=(audit,name)=>browser(browserCase,{id:browserCase.id,work_id:'owned',...audit},{targets:[]}).checks.find(row=>row.name===name);
test('browser acceptance inspects the newest draft, not a legacy missing observation',()=>{
  const old=draftRun('old'),fresh=draftRun('fresh');delete old.result.verified_values_before_capture;
  assert.equal(checked({pack_runs:[old,fresh]},'dom_before_capture_readback').pass,true);
  fresh.status='failed';
  assert.equal(checked({pack_runs:[old,fresh]},'actual_pack_run').pass,false);
});
test('browser acceptance requires the Office result promised by matrix completion conditions',()=>{
  assert.equal(checked({office_artifacts:[]},'office_result_present').pass,false);
});
test('browser acceptance allows identical repeated pages but rejects conflicts and missing pages',()=>{
  const artifact={request_id:'result',bytes:4,sha256:'a'.repeat(64),independent_readback:{matches:true,text:'abcd'}};
  const page=(offset,text,has_more,next_offset)=>({invocation:{tool_name:'office_result_read',arguments:{request_id:'result'}},receipt:{status:'succeeded',value:{request_id:'result',artifact:{sha256:artifact.sha256},text,page:{offset,returned_bytes:Buffer.byteLength(text),total_bytes:4,has_more,next_offset}}}});
  const first=page(0,'ab',true,2),last=page(2,'cd',false,null);
  const audit={office_artifacts:[artifact],observations:[first,last,structuredClone(first),structuredClone(last)]};
  assert.equal(checked(audit,'office_result_file_readback').pass,true);
  audit.observations.push(page(0,'xy',true,2));
  assert.equal(checked(audit,'office_result_file_readback').pass,false);
  audit.observations=[first];
  assert.equal(checked(audit,'office_result_file_readback').pass,false);
});
