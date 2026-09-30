import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime,PACK_ENGINE_VERSION} from '../dist/packs/runtime.js';
import {CustomPackRegistry} from '../dist/packs/custom-registry.js';
import {parseCsv} from '../dist/packs/data.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {bindWorkIntakeOptions} from '../dist/work/intake-options.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';

const copied=value=>structuredClone(value);
const recipe=(format='json')=>({version:1,family:'portal.collect',request:'Save current source rows',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],format});
const proposal={title:'주간 거래처 목록',desired_outcome:'현재 원본 전체를 저장한다',completion_checks:[{id:'rows',result:'모든 원본 행을 결과에 저장한다',evidence:'현재 원본과 결과 재읽기'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'read_only',recurrence:{kind:'recurring',rule:'Every Monday'},questions:[]};
function ready(store,project,requestId=randomUUID(),spec=proposal,prompt='Save all current source rows for this weekly cycle.'){
  const received=store.beginWork(project,requestId,prompt,'quick').work;
  bindWorkIntakeOptions(store,project,received.id,{completion_condition:'Preserve every source row and all fields.',delivery_target_ids:null});
  const owner=store.claimWorkDefinition(project,received.id);
  return store.finishWorkDefinition(project,received.id,owner,copied(spec),[],'ready');
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'office-custom-pack-')),path=join(root,'host.json'),source=join(root,'source.json');
  await writeFile(source,JSON.stringify([{id:'first',status:'open'}]));
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'custom-pack-test',caller_ref:'custom-agent',account_ref:'account-a',worktree:root,data_dir:join(root,'runtime'),...(options.fixture_url?{environment:'fixture',fixture_url:options.fixture_url}:{}),packs:{models:'off',sources:options.sources??[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],local_records:options.local_records??[]}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkSupervisor(store);
  const runtime=new FamilyRuntime(store,config),registry=new CustomPackRegistry(store),project=config.project.id,host={config_fingerprint:config.fingerprint,engine_binding:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})};
  t.after(async()=>{await runtime.drain();store.close();await rm(root,{recursive:true,force:true});});
  return {root,source,config,store,runtime,registry,project,host};
}
/** Only the completion authority is a fixture. The family execution, artifact,
 * recipe binding, Work association and durable database are actual code. */
async function demonstrated(x,definition=recipe(),options={}){
  const work=ready(x.store,x.project,randomUUID(),options.spec??proposal,options.prompt),result=await x.runtime.call('runtime_pack_run',{request_id:work.request_id,work_id:work.id,recipe:definition});
  assert.equal(result.status,options.expected_status??'succeeded');
  const supervisorId=randomUUID(),stamp=new Date().toISOString(),checkpoint={observations:[{invocation:{tool_name:'runtime_pack_run',request_id:work.request_id,effect:'local_write',dispatched:true,arguments:{recipe:definition,work_id:work.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[work.request_id],value:result}}]};
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(supervisorId,x.project,work.id,work.revision,'succeeded',JSON.stringify(checkpoint),JSON.stringify({completion_verified:true}),x.config.fingerprint,0,stamp,stamp);
  return {work,result,supervisorId,checkpoint,input:{key:'weekly-records',title:'내 주간 거래처 목록',work_id:work.id,supervisor_run_id:supervisorId,pack_run_id:result.run_id}};
}

test('runtime custom Pack: recipe cache cannot activate a Pack; readiness requires independent host Work completion',async t=>{
  const x=await fixture(t),source=await demonstrated(x);
  assert.ok(x.store.cachedPack(x.project,recipe().request,x.host.engine_binding));
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='awaiting_review',result=? WHERE run_id=?").run(JSON.stringify({completion_verified:false}),source.supervisorId);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,x.host),/CUSTOM_PACK_WORK_NOT_VERIFIED/u);
  assert.deepEqual(x.registry.list(x.project),[]);
  assert.throws(()=>x.registry.publishVerified(x.project,{...source.input,completion_verified:true},x.host),/Unrecognized key/u);
  assert.throws(()=>x.registry.publishVerified(x.project,{...source.input,title:'sk-proj-'+ 'x'.repeat(32)},x.host),/CREDENTIAL_LIKE_INPUT/u);
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='succeeded',result=? WHERE run_id=?").run(JSON.stringify({completion_verified:true}),source.supervisorId);
  const saved=x.registry.publishVerified(x.project,source.input,x.host);
  assert.equal(saved.created,true);assert.equal(saved.pack.state,'ready');assert.equal(saved.pack.version,1);
  assert.equal(saved.pack.completion_contract.prompt,source.work.prompt);
  assert.equal(saved.pack.completion_contract.completion_condition,'Preserve every source row and all fields.');
  assert.equal(saved.pack.source.supervisor_run_id,source.supervisorId);
  assert.deepEqual(saved.pack.completion_contract.spec.completion_checks,proposal.completion_checks);
  // Real Work checkpoints retain model aliases while the host invocation owns
  // the executed request ID; an ignored alias cannot invalidate actual proof.
  source.checkpoint.observations[0].invocation.arguments.request_id='model-cannot-change-id';
  x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(source.checkpoint),source.supervisorId);
  assert.equal(x.registry.publishVerified(x.project,{...source.input,key:'canonical-request'},x.host).pack.state,'ready');
});

test('runtime custom Pack: old versions preserve procedure and original completion contract across revisions and restart',async t=>{
  const x=await fixture(t),first=await demonstrated(x),v1=x.registry.publishVerified(x.project,first.input,x.host).pack;
  const repeated=x.registry.publishVerified(x.project,first.input,x.host);assert.equal(repeated.created,false);assert.deepEqual(repeated.pack,v1);
  const second=await demonstrated(x,recipe('csv')),v2=x.registry.publishVerified(x.project,second.input,x.host).pack;
  assert.equal(v2.version,2);assert.equal(v2.recipe.format,'csv');assert.notEqual(v2.definition_sha256,v1.definition_sha256);
  assert.equal(x.registry.get(x.project,'weekly-records').version,2);
  assert.deepEqual(x.registry.get(x.project,'weekly-records',1),v1);
  assert.equal(x.registry.publishVerified(x.project,first.input,x.host).pack.version,1);
  assert.equal(x.registry.get(x.project,'weekly-records').version,2,'Re-publishing historical content does not silently roll back the active version');
  const observer=new PackStore(x.config.dbPath);
  try{
    const restarted=new CustomPackRegistry(observer);
    assert.deepEqual(restarted.versions(x.project,'weekly-records'),[v1,v2]);
    assert.deepEqual(restarted.list(x.project).map(pack=>({key:pack.key,version:pack.version})),[{key:'weekly-records',version:2}]);
    assert.throws(()=>restarted.get('other-project','weekly-records'),/CUSTOM_PACK_NOT_FOUND/u);
  }finally{observer.close();}
});

test('runtime custom Pack: a verified Work using distinct successful recipes cannot publish a partial ready procedure',async t=>{
  const x=await fixture(t),spec={...copied(proposal),desired_outcome:'현재 원본을 JSON과 CSV로 각각 저장한다',completion_checks:[{id:'json',result:'현재 원본 전체를 JSON으로 저장한다',evidence:'JSON 재읽기'},{id:'csv',result:'현재 원본 전체를 CSV로 저장한다',evidence:'CSV 재읽기'}]},source=await demonstrated(x,recipe(),{spec,prompt:'Save all current source rows in both JSON and CSV.'});
  const secondRecipe=recipe('csv'),secondRequest=randomUUID(),second=await x.runtime.call('runtime_pack_run',{request_id:secondRequest,work_id:source.work.id,recipe:secondRecipe});
  assert.equal(second.status,'succeeded');
  assert.deepEqual(JSON.parse(await readFile(source.result.result.artifact.path,'utf8')),[{id:'first',status:'open'}]);
  assert.deepEqual(parseCsv(await readFile(second.result.artifact.path,'utf8')),[{id:'first',status:'open'}]);
  source.checkpoint.workers={csv:{observations:[{invocation:{tool_name:'runtime_pack_run',request_id:secondRequest,effect:'local_write',dispatched:true,arguments:{recipe:secondRecipe,work_id:source.work.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[secondRequest],value:second}}]}};
  const savedCheckpoint=JSON.stringify(source.checkpoint),db=x.store.hermesState;
  db.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(savedCheckpoint,source.supervisorId);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,x.host),/CUSTOM_PACK_MULTIPLE_RECIPES_UNSUPPORTED/u);
  assert.throws(()=>x.registry.publishVerified(x.project,{...source.input,pack_run_id:second.run_id},x.host),/CUSTOM_PACK_MULTIPLE_RECIPES_UNSUPPORTED/u);
  assert.deepEqual(x.registry.list(x.project),[]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM office_custom_pack_version').get().n,0);
  assert.equal(db.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(source.supervisorId).checkpoint,savedCheckpoint,'Rejecting readiness preserves the original closed execution trace');
});

test('runtime custom Pack: repeated identical recipes, failed executions and undispatched proposals do not become a composite procedure',async t=>{
  const x=await fixture(t),source=await demonstrated(x),sameRequest=randomUUID(),same=await x.runtime.call('runtime_pack_run',{request_id:sameRequest,work_id:source.work.id,recipe:recipe()});
  assert.equal(same.status,'succeeded');assert.notEqual(same.run_id,source.result.run_id);
  source.checkpoint.observations.push({invocation:{tool_name:'runtime_pack_run',request_id:sameRequest,effect:'local_write',dispatched:true,arguments:{recipe:recipe(),work_id:source.work.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[sameRequest],value:same}});
  const failedRecipe={...recipe(),filters:[{field:'status',op:'gte',value:1}]},failedRequest=randomUUID(),failed=await x.runtime.call('runtime_pack_run',{request_id:failedRequest,work_id:source.work.id,recipe:failedRecipe});
  assert.equal(failed.status,'failed');assert.equal(failed.result.error,'NUMERIC_FILTER_REQUIRES_NUMBER');
  source.checkpoint.observations.push({invocation:{tool_name:'runtime_pack_run',request_id:failedRequest,effect:'local_write',dispatched:true,arguments:{recipe:failedRecipe,work_id:source.work.id}},receipt:{status:'failed',effect_state:'none',evidence_ids:[failedRequest],value:failed}});
  const csvRecipe=recipe('csv'),undispatchedRequest=randomUUID(),csv=await x.runtime.call('runtime_pack_run',{request_id:undispatchedRequest,work_id:source.work.id,recipe:csvRecipe});
  assert.equal(csv.status,'succeeded');
  // This real run belongs to the Work, but the closed trace did not dispatch or
  // rely on it. A succeeded value alone is not an authoritative invocation.
  source.checkpoint.observations.push({invocation:{tool_name:'runtime_pack_run',request_id:undispatchedRequest,effect:'local_write',dispatched:false,arguments:{recipe:csvRecipe,work_id:source.work.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[undispatchedRequest],value:csv}});
  x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(source.checkpoint),source.supervisorId);
  const saved=x.registry.publishVerified(x.project,source.input,x.host);
  assert.equal(saved.created,true);assert.equal(saved.pack.state,'ready');assert.deepEqual(saved.pack.recipe,recipe());
  assert.deepEqual(x.registry.list(x.project).map(pack=>pack.key),['weekly-records']);
});

test('runtime custom Pack: each new cycle obtains fresh run and artifact while retries keep the original cycle version',async t=>{
  const x=await fixture(t),source=await demonstrated(x);x.registry.publishVerified(x.project,source.input,x.host);
  const first=x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'week-1'},x.host);
  assert.equal(first.created,true);assert.equal(first.dispatch_allowed,false);assert.equal(first.completion_verified,false);
  assert.equal('result' in first,false);assert.equal('checkpoint' in first,false);assert.equal('observations' in first,false);
  const work1=ready(x.store,x.project,first.request_id),run1=await x.runtime.call('runtime_pack_run',{request_id:first.request_id,work_id:work1.id,recipe:first.recipe});
  assert.equal(run1.status,'succeeded');
  assert.deepEqual(JSON.parse(await readFile(run1.result.artifact.path,'utf8')),[{id:'first',status:'open'}]);
  await writeFile(x.source,JSON.stringify([{id:'second',status:'closed'}]));
  const second=x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'week-2'},x.host);
  assert.notEqual(first.request_id,second.request_id);
  const work2=ready(x.store,x.project,second.request_id),run2=await x.runtime.call('runtime_pack_run',{request_id:second.request_id,work_id:work2.id,recipe:second.recipe});
  assert.equal(run2.status,'succeeded');assert.notEqual(run1.run_id,run2.run_id);assert.notEqual(run1.result.artifact.path,run2.result.artifact.path);
  assert.deepEqual(JSON.parse(await readFile(run2.result.artifact.path,'utf8')),[{id:'second',status:'closed'}]);
  assert.deepEqual(JSON.parse(await readFile(run1.result.artifact.path,'utf8')),[{id:'first',status:'open'}]);
  const newSource=await demonstrated(x,recipe('csv'));x.registry.publishVerified(x.project,newSource.input,x.host);
  const observer=new PackStore(x.config.dbPath);
  try{
    const restarted=new CustomPackRegistry(observer),retry=restarted.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'week-1'},x.host);
    assert.equal(retry.created,false);assert.equal(retry.version,1);assert.equal(retry.request_id,first.request_id);
    assert.throws(()=>restarted.prepareRepeat(x.project,{key:'weekly-records',version:2,cycle_id:'week-1'},x.host),/CUSTOM_PACK_CYCLE_CONFLICT/u);
    assert.equal(x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'week-3'},x.host).version,2);
  }finally{observer.close();}
});

test('runtime custom Pack: unbound receipts, changed Work revision, configuration or engine cannot activate or repeat',async t=>{
  const x=await fixture(t),source=await demonstrated(x),db=x.store.hermesState;
  db.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify({observations:[]}),source.supervisorId);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,x.host),/CUSTOM_PACK_RECEIPT_NOT_VERIFIED/u);
  db.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(source.checkpoint),source.supervisorId);
  for(const corrupt of [
    receipt=>{receipt.invocation.dispatched=false;},
    receipt=>{receipt.receipt.effect_state='none';},
    receipt=>{receipt.invocation.request_id='foreign-request';receipt.receipt.evidence_ids=['foreign-request'];},
    receipt=>{receipt.invocation.arguments.recipe.format='csv';},
    receipt=>{receipt.receipt.value.result={artifact:{rows:999}};},
    receipt=>{receipt.receipt.value.family='file.pipeline';},
    receipt=>{receipt.receipt.value.task_id=randomUUID();},
  ]){
    const corrupted=copied(source.checkpoint);corrupt(corrupted.observations[0]);
    db.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(corrupted),source.supervisorId);
    assert.throws(()=>x.registry.publishVerified(x.project,source.input,x.host),/CUSTOM_PACK_RECEIPT_NOT_VERIFIED/u);
  }
  db.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(source.checkpoint),source.supervisorId);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,{...x.host,engine_binding:'different-engine'}),/CUSTOM_PACK_ENGINE_CHANGED/u);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,{...x.host,config_fingerprint:'different-config'}),/CUSTOM_PACK_CONFIG_CHANGED/u);
  db.prepare('UPDATE office_intake SET revision=revision+1 WHERE work_id=?').run(source.work.id);
  assert.throws(()=>x.registry.publishVerified(x.project,source.input,x.host),/CUSTOM_PACK_WORK_REVISION_CHANGED/u);
  db.prepare('UPDATE office_intake SET revision=revision-1 WHERE work_id=?').run(source.work.id);
  x.registry.publishVerified(x.project,source.input,x.host);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'next'},{...x.host,engine_binding:'different-engine'}),/CUSTOM_PACK_ENGINE_CHANGED/u);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'next'},{...x.host,config_fingerprint:'different-config'}),/CUSTOM_PACK_CONFIG_CHANGED/u);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'next',parameters:{records:{undeclared:'x'}}},x.host),/CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN/u);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM office_custom_pack_cycle').get().n,0);
});

test('runtime custom Pack: source-parameter overrides are bounded data and never overwrite the saved recipe or completion conditions',async t=>{
  const periods=[],server=createServer((request,response)=>{const url=new URL(request.url,'http://localhost');periods.push(url.searchParams.get('period'));response.setHeader('content-type','application/json');response.end(JSON.stringify([{id:'record',period:url.searchParams.get('period')}]));});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const fixtureUrl=`http://127.0.0.1:${server.address().port}/test/account-a/`,x=await fixture(t,{fixture_url:fixtureUrl,sources:[{id:'records',kind:'http',url:fixtureUrl+'records',format:'json',parameters:['period']}]}),parameterized={...recipe(),sources:[{id:'records',parameters:{period:'2026-09'}}]},source=await demonstrated(x,parameterized);
  const version=x.registry.publishVerified(x.project,source.input,x.host).pack;
  const next=x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'october',parameters:{records:{period:'2026-10'}}},x.host);
  assert.equal(next.recipe.sources[0].parameters.period,'2026-10');assert.equal(version.recipe.sources[0].parameters.period,'2026-09');
  assert.deepEqual(next.completion_contract,version.completion_contract);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'october',parameters:{records:{period:'2026-11'}}},x.host),/CUSTOM_PACK_CYCLE_CONFLICT/u);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'november',parameters:{records:{new_parameter:'x'}}},x.host),/CUSTOM_PACK_SOURCE_PARAMETER_UNKNOWN/u);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'weekly-records',cycle_id:'november',parameters:{records:{period:'ghp_'+ 'x'.repeat(32)}}},x.host),/CREDENTIAL_LIKE_INPUT/u);
  const nextWork=ready(x.store,x.project,next.request_id),nextRun=await x.runtime.call('runtime_pack_run',{request_id:next.request_id,work_id:nextWork.id,recipe:next.recipe});
  assert.equal(nextRun.status,'succeeded');assert.deepEqual(periods,['2026-09','2026-10']);
  assert.deepEqual(JSON.parse(await readFile(nextRun.result.artifact.path,'utf8')),[{id:'record',period:'2026-10'}]);
  const multiple={...recipe(),deduplicate_by:[],sources:[{id:'records',parameters:{period:'2026-09'}},{id:'records',parameters:{period:'2026-10'}}]},multiSource=await demonstrated(x,multiple);
  assert.equal(multiSource.result.result.artifact.rows,2);
  x.registry.publishVerified(x.project,{...multiSource.input,key:'multi-period'},x.host);
  assert.throws(()=>x.registry.prepareRepeat(x.project,{key:'multi-period',cycle_id:'new-period',parameters:{records:{period:'2026-11'}}},x.host),/CUSTOM_PACK_SOURCE_PARAMETER_AMBIGUOUS/u);
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_custom_pack_cycle WHERE pack_key=?').get('multi-period').n,0);
});

test('runtime custom Pack: a host-verified local draft can be reused for a draft goal, never for a requested external effect',async t=>{
  const x=await fixture(t,{local_records:[{id:'records',path:'source.json',identity_field:'id',fields:['status']}]}),draft={version:1,family:'record.update',request:'Create a local status-change draft only',target:'records',values:{id:'first',status:'closed'},expected_before_sha256:snapshotHash({id:'first',status:'open'})};
  const spec={...copied(proposal),route:{kind:'pack',pack_family:'record.update'},requested_effect:'draft_only'},source=await demonstrated(x,draft,{spec,prompt:'Create a local draft changing the selected status while preserving all other rows and fields.',expected_status:'draft_ready'});
  assert.equal(x.registry.publishVerified(x.project,source.input,x.host).pack.state,'ready');
  assert.deepEqual(JSON.parse(await readFile(x.source,'utf8')),[{id:'first',status:'open'}]);
  const changed={...spec,requested_effect:'external_effect_requested'};
  x.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify(changed),source.work.id);
  assert.throws(()=>x.registry.publishVerified(x.project,{...source.input,key:'requested-write'},x.host),/CUSTOM_PACK_DRAFT_NOT_FINAL_OUTCOME/u);
});
