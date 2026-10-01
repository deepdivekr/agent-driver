import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';

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
  assert.equal(portalStatus.receipt.value.executed_contract.filters[0].value,'Open');
  assert.equal(first.output_rows<first.observed_source_rows,true,'a valid native transformation can still violate the user request for all rows');
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
  await writeFile(x.sourcePath,JSON.stringify(observed));
  const artifactPath=run.result.artifact.path,originalBytes=await readFile(artifactPath),changedBytes=Buffer.from(originalBytes);changedBytes[changedBytes.length-3]^=1;
  await writeFile(artifactPath,changedBytes);assert.equal(changedBytes.length,originalBytes.length);
  assert.equal((await status(own.toolkit,run.run_id,'changed-artifact-status')).receipt.value.native_output_certificate,null);
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
