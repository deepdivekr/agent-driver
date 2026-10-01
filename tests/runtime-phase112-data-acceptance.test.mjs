import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {validate} from '../scripts/live-pack-data-acceptance.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify((function visit(input){return Array.isArray(input)?input.map(visit):input&&typeof input==='object'?Object.fromEntries(Object.entries(input).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,visit(v)])):input;})(value));
const hash=value=>sha(canonical(value));

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'phase112-data-acceptance-')),data=join(root,'data'),artifacts=join(data,'pack-artifacts');
  t.after(async()=>rm(root,{recursive:true,force:true}));await mkdir(artifacts,{recursive:true});
  const all=[{id:'a',critical_flag:'Critical'},{id:'b',critical_flag:'Not Critical'},{id:'c',critical_flag:'Critical'}];
  const text='\uFEFF"id","critical_flag"\r\n"a","Critical"\r\n"c","Critical"\r\n',bytes=Buffer.from(text),path=join(artifacts,'run.csv');await writeFile(path,bytes);
  const artifact={path,sha256:sha(bytes),bytes:bytes.length,rows:2,format:'csv',originals_modified:false,independent_readback:{bytes:bytes.length,sha256:sha(bytes),matches:true,text}};
  const recipe={version:1,family:'portal.collect',request:'Collect all critical rows',sources:[{id:'nycfood_http',parameters:{}}],filters:[{field:'critical_flag',op:'eq',value:'Critical'}],deduplicate_by:[],format:'csv'};
  const evidence={source_id:'nycfood_http',request_sha256:hash({id:'nycfood_http',parameters:{}}),content_sha256:sha('observed-public-response'),observed_at:'2026-09-30T00:00:00.000Z',rows:3,elapsed_ms:1,executor:'http_get'};
  const sourceResult={rows:all,evidence},runId='pack-run',requestId='tool-pack';
  const result={evidence:[evidence],collected_rows:3,matched_rows:2,artifact};
  const run={id:runId,project_id:'unit-project',request_id:requestId,recipe,status:'succeeded',result,task_id:null,execution_checkpoint:{sources:{0:{binding:'fixture',digest:hash(sourceResult),result:sourceResult}}}};
  const page=(offset,chunk)=>({invocation:{tool_name:'office_result_read',request_id:`read-${offset}`,arguments:{request_id:requestId},dispatched:true},receipt:{status:'succeeded',value:{source_tool:'runtime_pack_run',source_run_id:runId,request_id:requestId,verified_by:'independent_sha256_and_bytes_readback',artifact,text:chunk.toString('utf8'),page:{offset,returned_bytes:chunk.length,total_bytes:bytes.length,next_offset:offset+chunk.length<bytes.length?offset+chunk.length:null,has_more:offset+chunk.length<bytes.length}}}});
  const audit={supervisor:{state:'succeeded',result:{completion_verified:true}},pack_runs:[run],observations:[{invocation:{tool_name:'runtime_pack_run',request_id:requestId,arguments:{request_id:'logical'},dispatched:true},receipt:{status:'succeeded',effect_state:'verified',value:{run_id:runId}}},page(0,bytes.subarray(0,25)),page(25,bytes.subarray(25))]};
  const item={id:'phase112-portal-food',family:'portal.collect',expected_recipe:recipe};
  const config={project:{id:'unit-project'},dbPath:join(data,'host.sqlite'),packs:{sources:[{id:'nycfood_http',kind:'http',url:'https://data.cityofnewyork.us/resource/43nn-pn8j.json',format:'json'}],local_records:[]}};
  return {root,item,audit,config,all};
}

test('portal acceptance uses the entire verified Pack readback without requiring a second TXT draft or status call',async t=>{
  const x=await fixture(t),verdict=validate(x.item,x.audit,x.config,[]);
  assert.equal(verdict.status,'PASS',JSON.stringify(verdict.checks));
  assert.equal(verdict.checks.find(row=>row.name==='work_completed_and_office_readback').pass,true);
});

test('portal acceptance fails a partial Pack read or an omitted Critical row',async t=>{
  const x=await fixture(t),partial=structuredClone(x.audit);partial.observations.pop();
  const unread=validate(x.item,partial,x.config,[]);
  assert.equal(unread.status,'FAIL');assert.equal(unread.checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const omitted=structuredClone(x.audit);omitted.pack_runs[0].result.matched_rows=1;
  const incomplete=validate(x.item,omitted,x.config,[]);
  assert.equal(incomplete.status,'FAIL');assert.equal(incomplete.checks.find(row=>row.name==='independent_export_rows').pass,false);
});

test('portal acceptance reconciles rereads by actual byte ranges, not mutable title or page size',async t=>{
  const x=await fixture(t),repeated=structuredClone(x.audit);
  repeated.observations.push(structuredClone(repeated.observations[1]));
  assert.equal(validate(x.item,repeated,x.config,[]).status,'PASS');
  const retitled=structuredClone(repeated);retitled.observations[1].receipt.value.title='Earlier display title';retitled.observations.at(-1).receipt.value.title='Current display title';
  assert.equal(validate(x.item,retitled,x.config,[]).status,'PASS','display-title changes do not change the saved Pack artifact');
  const resized=structuredClone(repeated),smaller=resized.observations.at(-1).receipt.value,short=Buffer.from(smaller.text,'utf8').subarray(0,10).toString('utf8');
  smaller.text=short;smaller.page.returned_bytes=Buffer.byteLength(short,'utf8');smaller.page.next_offset=smaller.page.returned_bytes;
  assert.equal(validate(x.item,resized,x.config,[]).status,'PASS','two valid page lengths may cover the same artifact offset');
  const conflictingText=structuredClone(repeated);conflictingText.observations.at(-1).receipt.value.text=conflictingText.observations.at(-1).receipt.value.text.replace('"id"','"xd"');
  assert.equal(validate(x.item,conflictingText,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const conflictingPage=structuredClone(repeated);conflictingPage.observations.at(-1).receipt.value.page.next_offset=24;
  assert.equal(validate(x.item,conflictingPage,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const wrongRun=structuredClone(repeated);wrongRun.observations.at(-1).receipt.value.source_run_id='another-pack-run';
  assert.equal(validate(x.item,wrongRun,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const wrongRequest=structuredClone(repeated);wrongRequest.observations.at(-1).receipt.value.request_id='another-request';
  assert.equal(validate(x.item,wrongRequest,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const wrongArtifact=structuredClone(repeated);wrongArtifact.observations.at(-1).receipt.value.artifact.path=join(x.root,'another.csv');
  assert.equal(validate(x.item,wrongArtifact,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  const missingPage=structuredClone(repeated);missingPage.observations.splice(2,1);
  assert.equal(validate(x.item,missingPage,x.config,[]).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
});

test('copied file source keeps a distinct registered HTTP origin and rejects fabricated selected rows',async t=>{
  const x=await fixture(t),inputs=join(x.root,'inputs');await mkdir(inputs);
  const sourcePath=join(inputs,'copied.json'),copyBytes=Buffer.from(JSON.stringify(x.all)+'\n');await writeFile(sourcePath,copyBytes);
  const origin={id:'nycfood_public_scalar',kind:'http',url:'https://data.cityofnewyork.us/resource/43nn-pn8j.json',format:'json'};
  const file={id:'nycfood_triage_file',kind:'file',path:sourcePath,format:'json'};
  x.config.packs.sources=[file,origin];
  const run=x.audit.pack_runs[0];run.recipe.sources=[{id:file.id,parameters:{}}];x.item.expected_recipe.sources=[{id:file.id,parameters:{}}];
  const evidence={source_id:file.id,request_sha256:hash({id:file.id,parameters:{}}),content_sha256:sha(copyBytes),observed_at:'2026-09-30T00:00:00.000Z',rows:x.all.length,elapsed_ms:1,executor:'local_file'};
  run.result.evidence=[evidence];run.execution_checkpoint.sources[0].result={rows:x.all,evidence};run.execution_checkpoint.sources[0].digest=hash(run.execution_checkpoint.sources[0].result);
  const originEvidence={source_id:origin.id,request_sha256:hash({id:origin.id,parameters:{}}),content_sha256:sha('actual-upstream-response'),observed_at:'2026-09-30T00:00:00.000Z',rows:x.all.length,elapsed_ms:1,executor:'http_get'};
  const provenance=[{source_id:origin.id,destination:sourcePath,sha256:sha(copyBytes),rows:x.all.length,format:'json',evidence:originEvidence,source_rows:x.all,selected_rows:x.all,local_fields:null}];
  assert.equal(validate(x.item,x.audit,x.config,provenance).status,'PASS');
  const wrongOrigin=structuredClone(provenance);wrongOrigin[0].source_id='unregistered';
  assert.equal(validate(x.item,x.audit,x.config,wrongOrigin).checks.find(row=>row.name==='observed_source_provenance').pass,false);
  const invented=structuredClone(provenance);invented[0].source_rows[0].id='invented';
  assert.equal(validate(x.item,x.audit,x.config,invented).checks.find(row=>row.name==='observed_source_provenance').pass,false);
});

async function recordFixture(t){
  const root=await mkdtemp(join(tmpdir(),'phase112-record-acceptance-')),data=join(root,'data'),artifacts=join(data,'pack-artifacts'),inputs=join(root,'inputs');
  t.after(async()=>rm(root,{recursive:true,force:true}));await mkdir(artifacts,{recursive:true});await mkdir(inputs);
  const workId='record-work',runId='record-pack-run',requestId='record-host-request',originalPath=join(inputs,'records.json');
  const sourceRow={unique_key:70565782,status:'Closed'},before={...sourceRow,local_review_note:null},after={...before,local_review_note:'Local review only'},originalRows=[before,{unique_key:70565783,status:'Open',local_review_note:null}],draftRows=[after,originalRows[1]];
  const originalBytes=Buffer.from(JSON.stringify(originalRows)+'\n'),draftBytes=Buffer.from(JSON.stringify(draftRows)+'\n'),artifactPath=join(artifacts,'record.json');
  await writeFile(originalPath,originalBytes);await writeFile(artifactPath,draftBytes);
  const artifact={path:artifactPath,sha256:sha(draftBytes),bytes:draftBytes.length,rows:2,format:'json',originals_modified:false,independent_readback:{bytes:draftBytes.length,sha256:sha(draftBytes),matches:true,text:draftBytes.toString('utf8')}};
  const recipe={version:1,family:'record.update',request:'Draft one local review field',target:'nyc311_review',values:{unique_key:70565782,local_review_note:'Local review only'},expected_before_sha256:hash(before)};
  const result={target:'nyc311_review',identity_field:'unique_key',identity:70565782,before_sha256:hash(before),after_sha256:hash(after),source_sha256:sha(originalBytes),source_rows:2,originals_modified:false,external_submit:false,non_target_rows_unchanged:true,non_target_fields_unchanged:true,artifact,local_record_draft:true,approval_available:false};
  const run={id:runId,project_id:'unit-project',request_id:requestId,recipe,status:'draft_ready',result,task_id:null};
  const audit={work_id:workId,supervisor:{state:'succeeded',result:{completion_verified:true}},pack_runs:[run],office_artifacts:[],observations:[
    {invocation:{tool_name:'runtime_pack_local_record_inspect',request_id:'inspect',dispatched:true},receipt:{status:'succeeded',value:{target:'nyc311_review',identity:70565782,before_sha256:hash(before),source_sha256:sha(originalBytes)}}},
    {invocation:{tool_name:'runtime_pack_run',request_id:requestId,arguments:{work_id:workId,recipe},dispatched:true},receipt:{status:'succeeded',effect_state:'verified',value:{run_id:runId}}},
    {invocation:{tool_name:'runtime_pack_status',request_id:'status',dispatched:true},receipt:{status:'succeeded',value:{run_id:runId,status:'draft_ready'}}},
    {invocation:{tool_name:'office_result_read',request_id:'read',dispatched:true},receipt:{status:'succeeded',value:{work_id:workId,source_tool:'runtime_pack_run',source_run_id:runId,request_id:requestId,verified_by:'independent_sha256_and_bytes_readback',artifact,text:draftBytes.toString('utf8'),page:{offset:0,returned_bytes:draftBytes.length,total_bytes:draftBytes.length,next_offset:null,has_more:false}}}},
  ]};
  const item={id:'phase112-record-parking',family:'record.update',work_id:workId,recipe_template:{version:1,family:'record.update',target:'nyc311_review',values:{unique_key:'70565782',local_review_note:'Local review only'}}};
  const origin={id:'nyc311_public',kind:'http',url:'https://data.cityofnewyork.us/resource/erm2-nwe9.json',format:'json'};
  const config={project:{id:'unit-project'},dbPath:join(data,'host.sqlite'),packs:{sources:[origin],local_records:[{id:'nyc311_review',path:originalPath,identity_field:'unique_key',fields:['local_review_note']}]}};
  const evidence={source_id:origin.id,request_sha256:hash({id:origin.id,parameters:{}}),content_sha256:sha('public-source-response'),observed_at:'2026-09-30T00:00:00.000Z',rows:2,elapsed_ms:1,executor:'http_get'};
  const provenance=[{source_id:origin.id,destination:originalPath,sha256:sha(originalBytes),rows:2,format:'json',evidence,source_rows:[sourceRow,{unique_key:70565783,status:'Open'}],selected_rows:originalRows,local_fields:{local_review_note:null}}];
  return {item,audit,config,provenance};
}

test('record acceptance uses the complete bound Pack JSON readback without inventing a TXT draft',async t=>{
  const x=await recordFixture(t);x.audit.observations.push(structuredClone(x.audit.observations.at(-1)));
  const verdict=validate(x.item,x.audit,x.config,x.provenance);
  assert.equal(verdict.status,'PASS',JSON.stringify(verdict.checks));
  assert.equal(x.audit.office_artifacts.length,0);
});

test('record acceptance rejects another Work, a partial or altered readback, and the wrong target identity',async t=>{
  const x=await recordFixture(t),bad=mutate=>{const audit=structuredClone(x.audit),item=structuredClone(x.item);mutate(audit,item);return validate(item,audit,x.config,x.provenance);};
  assert.equal(bad((audit)=>{audit.observations[1].invocation.arguments.work_id='another-work';}).checks.find(row=>row.name==='bound_pack_run').pass,false);
  assert.equal(bad((audit)=>{audit.observations[3].receipt.value.work_id='another-work';}).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  assert.equal(bad((audit)=>{audit.observations[3].receipt.value.page.has_more=true;}).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  assert.equal(bad((audit)=>{audit.observations[3].receipt.value.artifact.sha256='0'.repeat(64);}).checks.find(row=>row.name==='work_completed_and_office_readback').pass,false);
  assert.equal(bad((audit)=>{audit.pack_runs[0].recipe.target='another-target';}).checks.find(row=>row.name==='bound_pack_run').pass,false);
  assert.equal(bad((audit)=>{audit.pack_runs[0].recipe.values.unique_key=70565784;}).checks.find(row=>row.name==='bound_pack_run').pass,false);
});
