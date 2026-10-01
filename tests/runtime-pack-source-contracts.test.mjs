import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {sourceSchema,localRecordSchema} from '../dist/packs/contracts.js';
import {inspectLocalRecord,localRecordDraft} from '../dist/packs/local-records.js';
import {collectSource,sourceNormalizationMatches} from '../dist/packs/sources.js';
import {nativeOutputCertificate,savedResearchSourceReadback} from '../dist/packs/native-output-certificate.js';
import {declaredSourceContractIssues,DeclaredSourceContractError} from '../dist/packs/source-catalog.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {sha} from '../dist/packs/data.js';

async function directory(t){
  const root=await mkdtemp(join(tmpdir(),'pack-source-contracts-'));
  t.after(()=>rm(root,{recursive:true,force:true}));return root;
}

test('Pack read delegation exposes the original status without granting writes and proves complete draft preservation',async t=>{
  const root=await directory(t),path=join(root,'records.json');
  const rows=[{id:'one',status:'Closed',note:null,preserved:'original'},{id:'two',status:'Open',note:'keep',preserved:'other'}];
  await writeFile(path,JSON.stringify(rows));const original=await readFile(path);
  const legacy=localRecordSchema.parse({id:'records',path,identity_field:'id',fields:['note']});
  const oldView=await inspectLocalRecord(legacy,'one');assert.deepEqual(oldView.values,{note:null});
  const target=localRecordSchema.parse({...legacy,read_fields:['status','preserved']});
  const observed=await inspectLocalRecord(target,'one');
  assert.deepEqual(observed.values,{note:null,status:'Closed',preserved:'original'});
  assert.deepEqual(observed.allowed_fields,['note']);assert.deepEqual(observed.editable_fields,['note']);
  assert.deepEqual(observed.readable_fields,['note','status','preserved']);
  await assert.rejects(localRecordDraft(target,{id:'one',status:'Open'},observed.before_sha256),/PACK_LOCAL_RECORD_FIELD_NOT_ALLOWED/u);
  const draft=await localRecordDraft(target,{id:'one',note:'Reviewed Closed'},observed.before_sha256);
  assert.deepEqual(draft.rows,[{...rows[0],note:'Reviewed Closed'},rows[1]]);
  assert.deepEqual(draft.receipt.observed_before_values,{note:null,status:'Closed',preserved:'original'});
  assert.deepEqual(draft.receipt.observed_after_values,{note:'Reviewed Closed',status:'Closed',preserved:'original'});
  assert.equal(draft.receipt.non_target_fields_unchanged,true);assert.equal(draft.receipt.non_target_rows_unchanged,true);
  assert.deepEqual(draft.receipt.preservation,{verified_by:'host_exact_row_and_field_comparison',non_target_rows:1,non_target_fields:3,before_rows_sha256:snapshotHash(rows),after_rows_sha256:snapshotHash(draft.rows)});
  assert.deepEqual(await readFile(path),original);
  assert.equal(JSON.stringify(draft.receipt).includes(path),false);
  await assert.rejects(inspectLocalRecord({...target,read_fields:['missing_status']},'one'),/PACK_LOCAL_RECORD_READ_FIELD_MISSING/u);
  assert.throws(()=>localRecordSchema.parse({...legacy,read_fields:['status','status']}));
  assert.throws(()=>localRecordSchema.parse({...legacy,read_fields:['access_token']}));
});

test('explicit CSV numeric columns normalize observations before filters and retain the original byte hash',async t=>{
  const root=await directory(t),path=join(root,'rows.csv'),text='id,points,title\r\none,42,Show HN\r\ntwo,7,Other\r\n';
  await writeFile(path,text);
  const legacy=sourceSchema.parse({id:'rows',kind:'file',path,format:'csv'});
  const old=await collectSource(legacy,{},{});assert.equal(old.rows[0].points,'42');assert.equal(old.evidence.normalization,undefined);
  const source=sourceSchema.parse({...legacy,numeric_columns:['points']}),collected=await collectSource(source,{},{});
  assert.equal(collected.rows[0].points,42);assert.equal(collected.rows[1].points,7);
  assert.equal(collected.evidence.content_sha256,sha(text));
  assert.deepEqual(collected.evidence.normalization,{version:1,kind:'declared_numeric_columns',columns:['points'],raw_rows_sha256:snapshotHash(old.rows),normalized_rows_sha256:snapshotHash(collected.rows)});
  assert.equal(sourceNormalizationMatches(source,collected.rows,collected.evidence,old.rows),true);
  assert.equal(sourceNormalizationMatches(source,collected.rows,{...collected.evidence,normalization:{...collected.evidence.normalization,normalized_rows_sha256:'0'.repeat(64)}}),false);
  assert.deepEqual(await readFile(path),Buffer.from(text));
  for(const value of ['', ' 42', '1,000', '01', 'Infinity', '9007199254740993']){
    await writeFile(path,`id,points,title\none,"${value}",Show HN\n`);
    await assert.rejects(collectSource(source,{},{}),/SOURCE_NUMERIC_VALUE_INVALID/u);
  }
});

async function httpFixture(t){
  const root=await mkdtemp(join(tmpdir(),'pack-source-http-')),rows=[{id:'one',points:'42',title:'Show HN',first_released:'2024-04-24'},{id:'two',points:'7',title:'Other',first_released:'2024-05-01'}];
  const text=JSON.stringify(rows);let requests=0;
  const server=createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(text);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  let api;
  t.after(async()=>{if(api){api.close();await api.drain();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const host=join(root,'host.json');
  const projected={id:'rows',kind:'http',url:origin+'/rows',format:'json',json_fields:['id','points','title','first_released'],numeric_columns:['points']};
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'source-contract-project',caller_ref:'owner',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:origin+'/lab/account-a/',packs:{sources:[projected,{...projected,id:'legacy',numeric_columns:undefined},{id:'unprojected',kind:'http',url:origin+'/rows',format:'json'}],targets:[],models:'off'}}));
  const config=loadHostConfig(host);api=new RuntimeApi(config);
  return {api,config,rows,text,requests:()=>requests};
}

const collection={version:1,request:'Read the configured source',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id']};

test('research and portal use declared numeric source values and host certificates retain normalization provenance',async t=>{
  const x=await httpFixture(t);
  const search={...collection,family:'research.search',query:'Show HN',search_fields:['title'],sort:{field:'points',direction:'desc'},limit:10,relevance:null,filters:[{field:'points',op:'gte',value:10}]};
  const found=await x.api.call('runtime_pack_run',{request_id:'numeric-research',recipe:search});
  assert.equal(found.status,'succeeded');assert.deepEqual(found.result.rows,[{...x.rows[0],points:42}]);
  assert.equal(found.result.evidence[0].content_sha256,sha(x.text));
  const readback=savedResearchSourceReadback(x.api.store,x.config,x.api.store.packRun(x.config.project.id,found.run_id));
  assert.equal(readback.sources[0].rows[0].points,42);assert.equal(readback.sources[0].evidence.normalization.kind,'declared_numeric_columns');
  const legacy=await x.api.call('runtime_pack_run',{request_id:'untyped-research',recipe:{...search,sources:[{id:'legacy',parameters:{}}]}});
  assert.equal(legacy.status,'failed');assert.equal(legacy.result.error,'NUMERIC_FILTER_REQUIRES_NUMBER');
  const portal=await x.api.call('runtime_pack_run',{request_id:'numeric-portal',recipe:{...collection,family:'portal.collect',columns:['id','points'],format:'json',filters:search.filters}});
  assert.equal(portal.status,'succeeded');assert.deepEqual(JSON.parse(await readFile(portal.result.artifact.path,'utf8')),[{id:'one',points:42}]);
  const certificate=await nativeOutputCertificate(x.api.store,x.config,x.api.store.packRun(x.config.project.id,portal.run_id));
  assert.equal(certificate.exact_native_bytes_match,true);assert.equal(certificate.source_normalizations[0].source_id,'rows');
  assert.deepEqual(certificate.source_normalizations[0].columns,['points']);assert.equal(certificate.remote_source_freshness,'not_checked');
});

test('registered watch field typo is rejected before collection while unknown schemas remain observation-driven',async t=>{
  const x=await httpFixture(t);
  const watch={...collection,family:'monitor.watch',interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id','first_release']};
  const issues=declaredSourceContractIssues(watch,x.config.packs.sources);
  assert.deepEqual(issues,[{source_id:'rows',missing_fields:['first_release'],declared_fields:['id','points','title','first_released'],registration_not_observation:true}]);
  await assert.rejects(x.api.call('runtime_pack_run',{request_id:'typo-watch',recipe:watch}),error=>error instanceof DeclaredSourceContractError&&error.code==='PACK_DECLARED_SOURCE_FIELD_MISSING'&&error.not_dispatched===true&&error.issues[0].missing_fields[0]==='first_release');
  assert.equal(x.requests(),0);assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);
  const search={...collection,family:'research.search',query:'Node',search_fields:['missing_title'],sort:null,limit:10,relevance:null};
  assert.deepEqual(declaredSourceContractIssues(search,x.config.packs.sources)[0].missing_fields,['missing_title']);
  assert.deepEqual(declaredSourceContractIssues({...search,search_fields:['title','optional_description']},x.config.packs.sources),[]);
  assert.deepEqual(declaredSourceContractIssues({...search,query:''},x.config.packs.sources),[]);
  const verified={...search,search_fields:['title'],verification:[{id:'claim',kind:'citation',source_field:'title',claim_field:'missing_claim',quote_field:'missing_quote'}]};
  assert.deepEqual(declaredSourceContractIssues(verified,x.config.packs.sources)[0].missing_fields,['missing_claim','missing_quote']);
  const unknown={...watch,sources:[{id:'unprojected',parameters:{}}]};assert.deepEqual(declaredSourceContractIssues(unknown,x.config.packs.sources),[]);
  const failed=await x.api.call('runtime_pack_run',{request_id:'observed-typo-watch',recipe:unknown});
  assert.equal(failed.status,'failed');assert.equal(failed.result.error,'WATCH_COMPARISON_FIELD_MISSING');assert.equal(x.requests(),1);
  assert.throws(()=>x.api.store.watchState(x.config.project.id,failed.run_id),/PACK_WATCH_NOT_FOUND/u);
  assert.throws(()=>sourceSchema.parse({...x.config.packs.sources[0],numeric_columns:['missing']}));
});
