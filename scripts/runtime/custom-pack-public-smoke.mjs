// Live public data check; no model or external write. This is not a rerun of
// the private Phase112 Work matrix or independent business-goal acceptance.
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../../dist/interface/config.js';
import {PackStore} from '../../dist/packs/store.js';
import {FamilyRuntime} from '../../dist/packs/runtime.js';
import {nativeOutputCertificate} from '../../dist/packs/native-output-certificate.js';

const root=await mkdtemp(join(tmpdir(),'office-public-pack-'));
const url='https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.csv';
const report={at:new Date().toISOString(),scope:'live_public_http_numeric_normalization_and_native_artifacts',
  private_matrix_rerun:false,work_goal_acceptance:false,model_calls:0,external_writes:0,source_url:url,cases:[]};
let store,runtime;
try{
  const configPath=join(root,'host.json');
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'public-pack-smoke',caller_ref:'acceptance',account_ref:'public',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'usgs_hour',kind:'http',url,parameters:[],format:'csv',numeric_columns:['mag']}],targets:[]}}));
  const config=loadHostConfig(configPath);store=new PackStore(config.dbPath);store.registerProject(config.project);runtime=new FamilyRuntime(store,config);
  const recipe={version:1,family:'portal.collect',request:'Save this current USGS observation with nonnegative numeric magnitudes.',sources:[{id:'usgs_hour',parameters:{}}],filters:[{field:'mag',op:'gte',value:0}],deduplicate_by:['id'],columns:['id','mag'],format:'json'};
  const runs=[];
  for(const cycle of ['first','second']){
    const output=await runtime.call('runtime_pack_run',{request_id:'live-'+cycle,recipe});
    assert.equal(output.status,'succeeded',JSON.stringify(output));
    const run=store.packRun(config.project.id,output.run_id),saved=store.packExecution(config.project.id,run.id).checkpoint.sources['0'].result;
    assert.equal(saved.evidence.http_status,200);assert.equal(saved.evidence.executor,'http_get');
    assert.ok(saved.rows.length>0,'Current source must have actual rows.');
    assert.ok(saved.rows.every(row=>typeof row.mag==='number'&&Number.isFinite(row.mag)));
    assert.equal(saved.evidence.normalization.kind,'declared_numeric_columns');
    const expected=saved.rows.filter(row=>row.mag>=0).map(row=>({id:row.id,mag:row.mag}));
    const bytes=await readFile(run.result.artifact.path),actual=JSON.parse(bytes.toString('utf8'));
    assert.deepEqual(actual,expected);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),run.result.artifact.sha256);
    const certificate=await nativeOutputCertificate(store,config,run);
    assert.ok(certificate);assert.equal(certificate.output_rows,expected.length);
    assert.equal(certificate.remote_source_freshness,'not_checked');assert.equal(certificate.user_goal_verified,'not_asserted');
    runs.push(run);report.cases.push({cycle,status:'PASS',observed_at:saved.evidence.observed_at,source_rows:saved.rows.length,output_rows:expected.length,source_sha256:saved.evidence.content_sha256,artifact_sha256:run.result.artifact.sha256});
  }
  assert.notEqual(runs[0].id,runs[1].id);assert.notEqual(runs[0].result.artifact.path,runs[1].result.artifact.path);
  assert.notEqual(store.packExecution(config.project.id,runs[0].id).checkpoint.sources['0'].result.evidence.observed_at,store.packExecution(config.project.id,runs[1].id).checkpoint.sources['0'].result.evidence.observed_at);
  const repeated=await runtime.call('runtime_pack_run',{request_id:'live-second',recipe});assert.equal(repeated.run_id,runs[1].id);
  report.same_cycle_deduplicated=true;report.new_cycle_fresh_observation=true;report.status='PASS';
}catch(error){report.status='FAIL';report.error=error.message;process.exitCode=1;}
finally{if(runtime){runtime.close();await runtime.drain();}store?.close();await rm(root,{recursive:true,force:true});}
console.log(JSON.stringify(report,null,2));
