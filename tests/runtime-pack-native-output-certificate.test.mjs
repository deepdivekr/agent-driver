import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {nativeOutputCertificate} from '../dist/packs/native-output-certificate.js';
import {encodeCsv} from '../dist/packs/data.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {boundWorkToolValue} from '../dist/work/client-executor.js';

const observed=[{id:'A',status:'Open',score:'4'},{id:'B',status:'Closed',score:'8'},{id:'C',status:'Open',score:'6'}];
const model={async call(){assert.fail('No model call is permitted.');}};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'pack-native-certificate-')),sourcePath=join(root,'rows.json'),host=join(root,'host.json');
  await writeFile(sourcePath,JSON.stringify(observed));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'native-certificate-test',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:sourcePath,format:'json'}],targets:[]}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);initWorkExecution(api.store);
  const toolkits=[];t.after(async()=>{for(const toolkit of toolkits)await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  function work(family,title){
    const prompt=`Save all three ${title} rows`;
    const spec={title,desired_outcome:prompt,completion_checks:[{id:'all_rows',result:'All three observed rows are represented',evidence:'Host Pack artifact and readback'}],assumptions:[],route:{kind:'pack',pack_family:family},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write')};
    const started=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,started.work.id),saved=api.store.finishWorkDefinition(config.project.id,started.work.id,owner,spec,[],'ready');
    const toolkit=new WorkExecutionTools(api.store,config,api,saved.id,randomUUID(),spec,prompt,()=>{},model);toolkits.push(toolkit);
    return {saved,toolkit};
  }
  return {api,config,sourcePath,work};
}
const portal={version:1,family:'portal.collect',request:'Collect observed IDs',sources:[{id:'rows',parameters:{}}],filters:[{field:'status',op:'eq',value:'Open'}],deduplicate_by:['id'],columns:['id'],format:'csv'};
const file={version:1,family:'file.pipeline',request:'Normalize and sort all observed rows',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],columns:['id','score'],numeric_columns:['score'],sort:{field:'score',direction:'desc'},format:'json'};

test('large immutable verification metadata is available losslessly through same-Work hash-bound pages',async t=>{
  const x=await fixture(t),own=x.work('portal.collect','portal'),foreign=x.work('portal.collect','foreign'),result=await own.toolkit.execute('runtime_pack_run',{recipe:portal},'paged-receipt-run');
  const stored=x.api.store.packRun(x.config.project.id,result.run_id),large={...stored.result,verification:{scope:'supplied_source_snapshot',all_checks_passed:true,originals_modified:false,receipts:Array.from({length:140},(_,i)=>({id:'proof-'+i,quote:'실제 원문 🎯 '+i,source_sha256:'a'.repeat(64),verdict:'supported'}))}};
  x.api.store.hermesState.prepare('UPDATE family_run SET result=? WHERE id=?').run(JSON.stringify(large),stored.id);
  const view=await status(own.toolkit,stored.id,'paged-receipt-status'),bounded=boundWorkToolValue(view.receipt.value),ref=bounded.durable_result_readback;
  assert.equal(bounded.result_view,'verification_metadata_paged');assert.equal(ref.full_verification_included,false);assert.ok(Buffer.byteLength(JSON.stringify(bounded))<=16000);
  const args={run_id:stored.id,result_sha256:ref.result_sha256,max_bytes:8192};let offset=0,text='',sha=null,pages=0;
  do{const page=await own.toolkit.execute('office_pack_receipt_read',{...args,offset},'read-receipt-'+pages++);assert.equal(page.result_sha256,ref.result_sha256);assert.equal(page.full_result_read,false);assert.equal(sha===null||sha===page.view_sha256,true);sha=page.view_sha256;text+=page.text;offset=page.next_offset;}while(offset!==null);
  assert.deepEqual(JSON.parse(text),large);assert.equal(text,JSON.stringify(large));assert.ok(pages>1);
  await assert.rejects(foreign.toolkit.execute('office_pack_receipt_read',args,'foreign-receipt'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
  await assert.rejects(own.toolkit.execute('office_pack_receipt_read',{...args,result_sha256:'0'.repeat(64)},'changed-hash'),/WORK_PACK_RESULT_CHANGED/u);
  assert.equal(JSON.stringify(x.api.store.packRun(x.config.project.id,stored.id).result),JSON.stringify(large));assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,1);
});
async function status(toolkit,runId,requestId){const value=await toolkit.execute('runtime_pack_status',{run_id:runId},requestId);return {value,receipt:await toolkit.receipt('runtime_pack_status',value,requestId)};}

test('fresh same-Work status certifies exact observed portal/file transformations, never user-goal semantics',async t=>{
  const x=await fixture(t),portalWork=x.work('portal.collect','portal'),fileWork=x.work('file.pipeline','file');
  const portalRun=await portalWork.toolkit.execute('runtime_pack_run',{recipe:portal},'portal-native-request');
  const fileRun=await fileWork.toolkit.execute('runtime_pack_run',{recipe:file},'file-native-request');
  assert.equal(portalRun.status,'succeeded');assert.equal(fileRun.status,'succeeded');
  const portalStatus=await status(portalWork.toolkit,portalRun.run_id,'portal-native-status');
  const fileStatus=await status(fileWork.toolkit,fileRun.run_id,'file-native-status');
  const first=portalStatus.receipt.value.native_output_certificate,second=fileStatus.receipt.value.native_output_certificate;
  assert.equal(first.exact_native_bytes_match,true);assert.equal(first.scope,'saved_source_observations_to_local_artifact');
  assert.deepEqual([first.observed_source_rows,first.filtered_rows,first.deduplicated_rows,first.output_rows],[3,2,2,2]);
  assert.deepEqual(first.columns,['id']);assert.equal(first.format,'csv');assert.equal(first.file_sources_unchanged_at_check,'verified');
  assert.equal(first.remote_source_freshness,'not_checked');assert.equal(first.user_goal_verified,'not_asserted');
  assert.equal('source_rows' in first,false);assert.equal('path' in first,false);
  assert.equal(second.exact_native_bytes_match,true);assert.deepEqual([second.observed_source_rows,second.filtered_rows,second.output_rows],[3,3,3]);
  assert.deepEqual(second.columns,['id','score']);assert.deepEqual(second.sort,{field:'score',direction:'desc'});
  assert.deepEqual(second.numeric_columns,['score']);assert.equal(second.format,'json');
  const sourceReadback=fileStatus.receipt.value.saved_source_readback;
  assert.equal(sourceReadback.scope,'saved_source_observations_before_filtering');
  assert.equal(sourceReadback.observed_source_rows,3);assert.equal(sourceReadback.source_rows_complete,true);assert.equal(sourceReadback.truncated,false);
  assert.deepEqual(sourceReadback.sources[0].rows,observed);assert.equal(sourceReadback.sources[0].rows_total,3);
  assert.equal(sourceReadback.sources[0].rows_returned,3);assert.equal(sourceReadback.sources[0].complete,true);
  assert.equal(sourceReadback.sources[0].original_content_sha256.length,64);assert.equal(sourceReadback.sources[0].observed_at.length>0,true);
  assert.equal(sourceReadback.artifact_sha256,second.artifact_sha256);assert.equal(sourceReadback.user_goal_verified,'not_asserted');
  assert.equal(JSON.stringify(sourceReadback).includes(x.sourcePath),false);
  assert.equal(portalStatus.receipt.value.saved_source_readback.source_rows_complete,true);
  assert.deepEqual(portalStatus.receipt.value.saved_source_readback.sources[0].rows,observed,'filtered output must not rewrite the original observation');
  assert.equal(portalStatus.receipt.value.executed_contract.filters[0].value,'Open');
  assert.equal(first.output_rows<first.observed_source_rows,true,'a valid native transformation can still violate the user request for all rows');
});

test('native source preview is bounded and complete originals remain available by pages without replaying a Pack run',async t=>{
  const x=await fixture(t),own=x.work('file.pipeline','large original'),moderate=Array.from({length:36},(_,i)=>({id:`row-${i}`,status:'Open',score:String(i),note:'x'.repeat(310)}));
  await writeFile(x.sourcePath,JSON.stringify(moderate));
  const run=await own.toolkit.execute('runtime_pack_run',{recipe:file},'moderate-native-request');assert.equal(run.status,'succeeded');
  const runCount=Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM family_run').get().count);
  const first=await status(own.toolkit,run.run_id,'moderate-native-status'),readback=first.receipt.value.saved_source_readback;
  assert.equal(Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM family_run').get().count),runCount,'readback does not replay a source or start a Pack run');
  assert.equal(readback.observed_source_rows,36);assert.equal(readback.source_rows_complete,false);
  assert.deepEqual(readback.sources[0].rows,moderate.slice(0,readback.sources[0].rows_returned));
  assert.equal(readback.read_all_pages_with,'office_pack_source_read');
  let offset=0,original='',viewHash;
  do{
    const page=await own.toolkit.execute('office_pack_source_read',{run_id:run.run_id,source_id:'rows',offset,max_bytes:4096},`moderate-source-page-${offset}`);
    viewHash??=page.view_sha256;assert.equal(page.view_sha256,viewHash);assert.equal(page.full_source_read,false);
    assert.equal(page.user_goal_verified,'not_asserted');original+=page.text;offset=page.next_offset;
  }while(offset!==null);
  assert.deepEqual(JSON.parse(original),moderate);
  assert.equal(Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM family_run').get().count),runCount);
  const unbound=await own.toolkit.receipt('runtime_pack_status',first.value,'unbound-native-readback');assert.equal(unbound.value.saved_source_readback,null);
  const oversized=Array.from({length:70},(_,i)=>({id:`row-${i}`,status:'Open',score:String(i),note:'x'.repeat(500)}));
  await writeFile(x.sourcePath,JSON.stringify(oversized));
  assert.equal((await status(own.toolkit,run.run_id,'changed-original-status')).receipt.value.saved_source_readback,null,'a changed current file cannot reuse old observations');
  const next=await own.toolkit.execute('runtime_pack_run',{recipe:file},'oversized-native-request');assert.equal(next.status,'succeeded');
  const sampled=(await status(own.toolkit,next.run_id,'oversized-native-status')).receipt.value.saved_source_readback;
  assert.equal(sampled.observed_source_rows,70);assert.equal(sampled.source_rows_complete,false);assert.equal(sampled.truncated,true);
  assert.equal(sampled.sources[0].rows_total,70);assert.equal(sampled.sources[0].rows_returned<70,true);
  assert.equal(sampled.sources[0].complete,false);assert.equal(sampled.sources[0].rows.length,sampled.sources[0].rows_returned);
  assert.equal(Buffer.byteLength(JSON.stringify(sampled),'utf8')<=4096,true);
  assert.equal(sampled.user_goal_verified,'not_asserted');
});

test('native status retains immutable verification metadata and pages source rows when their combined view exceeds the handoff budget',async t=>{
  const x=await fixture(t),own=x.work('file.pipeline','retained verification'),rows=Array.from({length:36},(_,i)=>({id:`row-${i}`,status:'Open',score:String(i),note:'x'.repeat(310)}));
  await writeFile(x.sourcePath,JSON.stringify(rows));
  const run=await own.toolkit.execute('runtime_pack_run',{recipe:file},'metadata-native-request');
  const verification=Array.from({length:100},(_,index)=>({evidence_ids:[`observed-proof-${index}`],source_id:'rows',observed_at:'2026-10-01T00:00:00.000Z',status:'supported'}));
  x.api.store.finishPack(x.config.project.id,run.run_id,'succeeded',{...run.result,verification});
  const checked=await status(own.toolkit,run.run_id,'metadata-native-status'),value=checked.receipt.value;
  assert.ok(value.native_output_certificate?.exact_native_bytes_match);
  assert.deepEqual(value.result.verification,verification,'Immutable verification metadata is not discarded.');
  assert.equal(value.saved_source_readback.source_rows_complete,false);assert.equal(value.saved_source_readback.truncated,true);
  assert.equal(value.saved_source_readback.sources[0].rows_returned,0);assert.deepEqual(value.saved_source_readback.sources[0].rows,[]);
  assert.equal(value.saved_source_readback.sources[0].rows_total,rows.length);
  assert.ok(Buffer.byteLength(JSON.stringify(boundWorkToolValue(value)))<=16000);
  const page=await own.toolkit.execute('office_pack_source_read',{run_id:run.run_id,source_id:'rows',offset:0,max_bytes:4096},'metadata-native-source-page');
  assert.equal(page.total_bytes,Buffer.byteLength(JSON.stringify(rows,null,2)+'\n'));
  assert.equal(page.artifact_sha256,value.native_output_certificate.artifact_sha256);
  assert.equal(page.full_source_read,false);
  assert.equal(Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n),1,'Status and source pages never execute a second Pack.');
});

test('foreign, changed status, failed/review run, changed source/checkpoint or same-length artifact bytes never get a certificate',async t=>{
  const x=await fixture(t),own=x.work('portal.collect','portal'),foreign=x.work('file.pipeline','file');
  const run=await own.toolkit.execute('runtime_pack_run',{recipe:portal},'negative-native-request');assert.equal(run.status,'succeeded');
  const good=await status(own.toolkit,run.run_id,'negative-native-status');assert.equal(good.receipt.value.native_output_certificate?.exact_native_bytes_match,true);
  await assert.rejects(foreign.toolkit.execute('runtime_pack_status',{run_id:run.run_id},'foreign-native-status'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
  const unbound=await foreign.toolkit.receipt('runtime_pack_status',good.value,'foreign-unbound-status');assert.equal(unbound.value.native_output_certificate,null);
  const forged=structuredClone(good.value);forged.result.matched_rows=99;
  assert.equal((await own.toolkit.receipt('runtime_pack_status',forged,'negative-native-status')).value.native_output_certificate,null);
  await writeFile(x.sourcePath,JSON.stringify([{id:'X',status:'Open',score:'4'}]));
  assert.equal((await status(own.toolkit,run.run_id,'changed-source-status')).receipt.value.native_output_certificate,null);
  assert.equal((await status(own.toolkit,run.run_id,'changed-source-readback')).receipt.value.saved_source_readback,null);
  await writeFile(x.sourcePath,JSON.stringify(observed));
  const artifactPath=run.result.artifact.path,originalBytes=await readFile(artifactPath),changedBytes=Buffer.from(originalBytes);changedBytes[changedBytes.length-3]^=1;
  await writeFile(artifactPath,changedBytes);assert.equal(changedBytes.length,originalBytes.length);
  const changedArtifact=await status(own.toolkit,run.run_id,'changed-artifact-status');
  assert.equal(changedArtifact.receipt.value.native_output_certificate,null);assert.equal(changedArtifact.receipt.value.saved_source_readback,null);
  await writeFile(artifactPath,originalBytes);
  const execution=x.api.store.packExecution(x.config.project.id,run.run_id),checkpoint=execution.checkpoint,originalBinding=checkpoint.sources['0'].binding,originalDigest=checkpoint.sources['0'].digest;checkpoint.sources['0'].digest='0'.repeat(64);
  x.api.store.hermesState.prepare('UPDATE family_execution SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),run.run_id);
  assert.equal((await status(own.toolkit,run.run_id,'changed-checkpoint-status')).receipt.value.native_output_certificate,null);
  checkpoint.sources['0'].digest=originalDigest;checkpoint.sources['0'].binding='0'.repeat(64);
  x.api.store.hermesState.prepare('UPDATE family_execution SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),run.run_id);
  assert.equal((await status(own.toolkit,run.run_id,'changed-binding-status')).receipt.value.native_output_certificate,null);
  checkpoint.sources['0'].binding=originalBinding;
  const failed=await own.toolkit.execute('runtime_pack_run',{recipe:{...portal,columns:['missing']}},'failed-native-request');assert.equal(failed.status,'failed');
  assert.equal((await status(own.toolkit,failed.run_id,'failed-native-status')).receipt.value.native_output_certificate,null);
  x.api.store.finishPack(x.config.project.id,run.run_id,'needs_review',run.result);
  assert.equal((await status(own.toolkit,run.run_id,'review-native-status')).receipt.value.native_output_certificate,null);
});

test('unchanged local source rejects a shortened checkpoint even if its digest and forged output agree',async t=>{
  const x=await fixture(t),own=x.work('portal.collect','portal'),run=await own.toolkit.execute('runtime_pack_run',{recipe:portal},'shortened-source-request');
  assert.equal(run.status,'succeeded');
  const originalSource=await readFile(x.sourcePath),stored=x.api.store.packRun(x.config.project.id,run.run_id);
  assert.ok(await nativeOutputCertificate(x.api.store,x.config,stored));
  const checkpoint=x.api.store.packExecution(x.config.project.id,run.run_id).checkpoint,saved=checkpoint.sources['0'];
  saved.result.rows=saved.result.rows.slice(0,2);
  saved.result.evidence.rows=2;
  saved.digest=snapshotHash(saved.result);
  const forged=structuredClone(stored.result),output=Buffer.from(encodeCsv([{id:'A'}],['id']));
  forged.evidence[0].rows=2;forged.collected_rows=2;forged.matched_rows=1;
  forged.artifact.rows=1;forged.artifact.bytes=output.length;forged.artifact.sha256=createHash('sha256').update(output).digest('hex');
  await writeFile(forged.artifact.path,output);
  x.api.store.hermesState.prepare('UPDATE family_execution SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),run.run_id);
  x.api.store.hermesState.prepare('UPDATE family_run SET result=? WHERE id=?').run(JSON.stringify(forged),run.run_id);
  assert.deepEqual(await readFile(x.sourcePath),originalSource,'the complete original file was not changed');
  assert.equal(await nativeOutputCertificate(x.api.store,x.config,x.api.store.packRun(x.config.project.id,run.run_id)),null);
});
