import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {WorkClientToolInputError} from '../dist/work/client-executor.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {sha} from '../dist/packs/data.js';

const spec={title:'Local review draft',desired_outcome:'Draft one scoped local annotation without changing the source',completion_checks:[{id:'draft',result:'A separately saved record draft',evidence:'Pack artifact and original hash'}],assumptions:[],route:{kind:'pack',pack_family:'record.update'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Draft a local annotation','local_file_write')};
const model={calls:[],async call(){throw Error('No model call in contract regression');}};

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'phase112-local-record-')),source=join(root,'records.json'),configPath=join(root,'host.json');
  const records=[{id:'public-a',official_status:'Closed',local_note:null,untouched:'first'},{id:'public-b',official_status:'In Progress',local_note:null,untouched:'second'}];
  await writeFile(source,JSON.stringify(records));
  const raw={schema_version:1,project_id:'local-record-project',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'runtime'),environment:'production',packs:{models:'off',sources:[],targets:[],local_records:[{id:'review',path:'records.json',identity_field:'id',fields:['local_note']}]}};
  await writeFile(configPath,JSON.stringify(raw));
  const config=loadHostConfig(configPath),api=new RuntimeApi(config);initWorkExecution(api.store);
  const begun=api.store.beginWork(config.project.id,randomUUID(),'Draft one local record','quick');
  const owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),work=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {root,source,configPath,config,api,work,raw,records};
}

test('local record target inspects only delegated fields and produces a verified separate draft without modifying source',async t=>{
  const x=await setup(t),before=await readFile(x.source),toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,x.work.id,randomUUID(),spec,x.work.prompt,()=>{},model);
  t.after(()=>toolkit.close());
  assert.equal(toolkit.catalog().find(tool=>tool.name==='runtime_pack_local_record_inspect')?.effect,'read_only');
  assert.throws(()=>toolkit.validate('runtime_pack_local_record_inspect',{target:'absent',identity:'public-a'},'inspect-missing'),/WORK_PACK_TARGET_NOT_CONNECTED/u);
  const inspectArgs=toolkit.validate('runtime_pack_local_record_inspect',{target:'review',identity:'public-a'},'inspect-one');
  assert.equal(inspectArgs.work_id,x.work.id);
  const observed=await toolkit.execute('runtime_pack_local_record_inspect',{target:'review',identity:'public-a'},'inspect-one');
  assert.deepEqual(observed.values,{local_note:null});assert.deepEqual(observed.allowed_fields,['local_note']);
  assert.equal(observed.source_rows,2);assert.equal(observed.matched_rows,1);
  assert.equal(observed.source_sha256,sha(before));assert.equal(JSON.stringify(observed).includes(x.source),false);
  assert.equal((await toolkit.receipt('runtime_pack_local_record_inspect',observed,'inspect-one')).effect_state,'none');
  const recipe={version:1,family:'record.update',request:'Draft a scoped annotation',target:'review',values:{id:'public-a',local_note:'Official status Closed; details unavailable'},expected_before_sha256:observed.before_sha256};
  assert.equal(toolkit.validate('runtime_pack_run',{recipe},'local-draft-one').work_id,x.work.id);
  const result=await toolkit.execute('runtime_pack_run',{recipe},'local-draft-one');
  assert.equal(result.status,'draft_ready');assert.equal(result.task_id,null);assert.equal(result.result.external_submit,false);assert.equal(result.result.originals_modified,false);
  assert.equal(result.result.source_rows,2);assert.equal(result.result.matched_rows,1);
  assert.equal(result.result.before_sha256,observed.before_sha256);assert.notEqual(result.result.after_sha256,observed.before_sha256);
  const receipt=await toolkit.receipt('runtime_pack_run',result,'local-draft-one');assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');
  const artifact=await readFile(result.result.artifact.path);assert.equal(sha(artifact),result.result.artifact.sha256);
  assert.deepEqual(JSON.parse(artifact.toString('utf8')),[{...x.records[0],local_note:'Official status Closed; details unavailable'},x.records[1]]);
  assert.deepEqual(await readFile(x.source),before);
  const repeat=await toolkit.execute('runtime_pack_run',{recipe},'local-draft-one');assert.equal(repeat.deduplicated,true);assert.deepEqual(await readFile(x.source),before);
});

test('local record Pack preflight requires explicit inspected identity, current hash and only editable fields',async t=>{
  const x=await setup(t),before=await readFile(x.source),toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,x.work.id,randomUUID(),spec,x.work.prompt,()=>{},model);
  t.after(()=>toolkit.close());
  assert.match(toolkit.catalog().find(tool=>tool.name==='runtime_pack_local_record_inspect').description,/values must explicitly include the same identity under identity_field/u);
  const observed=await toolkit.execute('runtime_pack_local_record_inspect',{target:'review',identity:'public-a'},'record-preflight-inspect');
  const base={version:1,family:'record.update',request:'Draft scoped note',target:'review',values:{id:'public-a',local_note:'internal note'},expected_before_sha256:observed.before_sha256};
  const invalid=[
    [{...base,values:{local_note:'internal note'}},'WORK_PACK_LOCAL_RECORD_IDENTITY_REQUIRED'],
    [{...base,values:{id:Number.MAX_SAFE_INTEGER+1,local_note:'internal note'}},'WORK_PACK_LOCAL_RECORD_IDENTITY_REQUIRED'],
    [{...base,expected_before_sha256:null},'WORK_PACK_LOCAL_RECORD_BEFORE_HASH_REQUIRED'],
    [{...base,values:{id:'public-a',official_status:'Changed'}},'WORK_PACK_LOCAL_RECORD_FIELD_NOT_ALLOWED'],
  ];
  for(const [recipe,code] of invalid){
    assert.throws(()=>toolkit.validate('runtime_pack_run',{recipe},`bad-${code}`),error=>error instanceof WorkClientToolInputError&&error.code===code&&error.not_dispatched===true);
    await assert.rejects(toolkit.execute('runtime_pack_run',{recipe},`direct-${code}`),error=>error instanceof WorkClientToolInputError&&error.code===code);
  }
  assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);
  assert.deepEqual(await readFile(x.source),before);
  assert.equal(toolkit.validate('runtime_pack_run',{recipe:base},'valid-record').recipe.values.id,'public-a');
});

test('local record target rejects stale hashes, unrelated fields, ambiguous identities and unsafe policy paths',async t=>{
  const x=await setup(t),original=await readFile(x.source);
  const recipe=(request_id,values,expected_before_sha256)=>x.api.call('runtime_pack_run',{request_id,work_id:x.work.id,recipe:{version:1,family:'record.update',request:'Draft review only',target:'review',values,expected_before_sha256}});
  const stale=await recipe('stale-hash',{id:'public-a',local_note:'note'},'a'.repeat(64));assert.equal(stale.status,'failed');assert.equal(stale.result.error,'PACK_LOCAL_RECORD_BEFORE_CHANGED');
  const denied=await recipe('unallowed-field',{id:'public-a',official_status:'Changed'},'a'.repeat(64));assert.equal(denied.status,'failed');assert.equal(denied.result.error,'PACK_LOCAL_RECORD_FIELD_NOT_ALLOWED');
  await assert.rejects(x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:'missing'}),/PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE/u);
  assert.deepEqual(await readFile(x.source),original);
  const duplicate=[x.records[0],x.records[0],x.records[1]];await writeFile(x.source,JSON.stringify(duplicate));
  await assert.rejects(x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:'public-a'}),/PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE/u);
  const unsafe={...x.raw,packs:{...x.raw.packs,local_records:[{id:'review',path:'../private.json',identity_field:'id',fields:['local_note']}]}};
  await writeFile(join(x.root,'unsafe.json'),JSON.stringify(unsafe));assert.throws(()=>loadHostConfig(join(x.root,'unsafe.json')),/PACK_LOCAL_RECORD_OUTSIDE_WORKTREE/u);
  const secret={...x.raw,packs:{...x.raw.packs,local_records:[{id:'review',path:'.env/records.json',identity_field:'id',fields:['local_note']}]}};
  await writeFile(join(x.root,'secret.json'),JSON.stringify(secret));assert.throws(()=>loadHostConfig(join(x.root,'secret.json')),/PACK_LOCAL_RECORD_SECRET_PATH/u);
});

test('canonical decimal ID is losslessly matched across JSON string and model number, but ambiguous or lossy forms fail',async t=>{
  const x=await setup(t),rows=[{id:'70565782',official_status:'Closed',local_note:null},{id:'00123',official_status:'Open',local_note:null}];
  await writeFile(x.source,JSON.stringify(rows));const before=await readFile(x.source);
  const inspected=await x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:70565782});
  assert.equal(inspected.before_sha256.length,64);assert.equal(inspected.identity,70565782);assert.equal(inspected.source_rows,2);assert.equal(inspected.matched_rows,1);
  const result=await x.api.call('runtime_pack_run',{request_id:'canonical-number-id',work_id:x.work.id,recipe:{version:1,family:'record.update',request:'Draft note for one observed ID',target:'review',values:{id:70565782,local_note:'internal draft'},expected_before_sha256:inspected.before_sha256}});
  assert.equal(result.status,'draft_ready');
  assert.equal(result.result.source_rows,2);assert.equal(result.result.matched_rows,1);
  assert.deepEqual(JSON.parse(await readFile(result.result.artifact.path,'utf8')),[{...rows[0],local_note:'internal draft'},rows[1]]);
  assert.deepEqual(await readFile(x.source),before);
  await assert.rejects(x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:123}),/PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE/u);
  await assert.rejects(x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:Number.MAX_SAFE_INTEGER+1}),/PACK_LOCAL_RECORD_IDENTITY_UNSAFE_NUMBER/u);
  await writeFile(x.source,JSON.stringify([...rows,{id:70565782,official_status:'duplicate',local_note:null}]));
  await assert.rejects(x.api.call('runtime_pack_local_record_inspect',{work_id:x.work.id,target:'review',identity:70565782}),/PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE/u);
});
