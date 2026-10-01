import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {boundWorkToolValue} from '../dist/work/client-executor.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {sealCollectionContract} from '../dist/work/collection-contract.js';
import {sha} from '../dist/packs/data.js';

const recipe={version:1,family:'research.search',request:'Read a registered source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],query:'',search_fields:['name'],relevance:null,sort:null,limit:10};
const spec={title:'Read saved Office output',desired_outcome:'Inspect the saved output bytes',completion_checks:[{id:'bytes',result:'Read the saved output',evidence:'Bound result receipt and full-file hash'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Inspect the saved output bytes','read_only')};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-large-result-')),paths=await prepareLocalConnection(join(root,'office'));
  const raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));raw.environment='fixture';raw.account_ref='account-a';raw.fixture_url='http://127.0.0.1:9999/test/account-a/';await writeFile(paths.runtimeConfig,JSON.stringify(raw));
  const config=loadHostConfig(paths.runtimeConfig),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkExecution(store);
  const begun=store.beginWork(config.project.id,randomUUID(),'Inspect saved output bytes','quick'),owner=store.claimWorkDefinition(config.project.id,begun.work.id),work=store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
  const toolkit=new WorkExecutionTools(store,config,{async call(){assert.fail('A saved artifact read never dispatches a Pack or model.');}},work.id,randomUUID(),spec,work.prompt,()=>{},{calls:[],async call(){assert.fail('No model call is required.');}});
  t.after(async()=>{await toolkit.close();store.close();await rm(root,{recursive:true,force:true});});
  const artifactRoot=join(dirname(config.dbPath),'pack-artifacts');await mkdir(artifactRoot,{recursive:true});
  async function save(requestId,bytes){
    const run=store.beginPack(config.project.id,requestId,recipe,'fixture-binding',work.id).run,path=join(artifactRoot,run.id+'.txt');await writeFile(path,bytes);
    const result={artifact:{path,sha256:sha(bytes),bytes:bytes.length,format:'txt',originals_modified:false}};
    store.finishPack(config.project.id,run.id,'succeeded',result,null);
    const receipt=await toolkit.receipt('runtime_pack_run',{run_id:run.id,status:'succeeded',task_id:null,result},requestId);
    assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');
    return {path,run,result};
  }
  return {toolkit,save};
}

test('runtime fixture Office result read verifies and pages an actual file beyond 8 MiB without claiming a partial page is complete',async t=>{
  const x=await fixture(t),tail='마지막 줄\n',bytes=Buffer.from('\uFEFF'+'한글,🌤️,line\r\n'.repeat(450000)+tail,'utf8');
  assert.ok(bytes.length>8*1024*1024);
  const {path,result}=await x.save('large-output',bytes);
  const first=await x.toolkit.execute('office_result_read',{request_id:'large-output',offset:0,max_bytes:7},'first-page');
  assert.equal(first.text,'\uFEFF한');assert.equal(first.page.returned_bytes,6);assert.equal(first.page.total_bytes,bytes.length);
  assert.equal(first.page.next_offset,6);assert.equal(first.page.has_more,true);
  assert.equal(first.artifact.sha256,sha(bytes));assert.equal(first.verified_by,'independent_sha256_and_bytes_readback');
  const second=await x.toolkit.execute('office_result_read',{request_id:'large-output',offset:first.page.next_offset,max_bytes:12},'second-page');
  assert.ok(second.page.returned_bytes<=12);assert.equal(Buffer.byteLength(second.text,'utf8'),second.page.returned_bytes);
  const tailOffset=bytes.length-Buffer.byteLength(tail,'utf8');assert.ok(tailOffset>8*1024*1024);
  const last=await x.toolkit.execute('office_result_read',{request_id:'large-output',offset:tailOffset,max_bytes:12000},'end-page');
  assert.equal(last.text,tail);assert.equal(last.page.next_offset,null);assert.equal(last.page.has_more,false);
  assert.equal(last.page.total_bytes,bytes.length);assert.equal(last.artifact.bytes,result.artifact.bytes);
  await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'large-output',offset:1},'mid-bom'),/WORK_RESULT_PAGE_OFFSET_INVALID/u);
  const changed=Buffer.from(bytes),ascii=changed.indexOf('line');assert.ok(ascii>0);changed[ascii]='L'.charCodeAt(0);
  await writeFile(path,changed);
  await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'large-output',offset:tailOffset},'mutated'),/WORK_RESULT_READBACK_MISMATCH/u);
});

test('runtime fixture Office result read checks unrequested bytes for NUL and invalid UTF-8 before claiming full-file verification',async t=>{
  const x=await fixture(t),base=Buffer.from('A'.repeat(8*1024*1024+1024)+'\n','utf8');
  for(const [name,badByte] of [['nul',0],['invalid-utf8',0xff]]){
    const bytes=Buffer.from(base);bytes[8*1024*1024]=badByte;
    await x.save(name,bytes);
    await assert.rejects(x.toolkit.execute('office_result_read',{request_id:name,offset:0,max_bytes:12000},name+'-first-page'),/WORK_RESULT_UNSUPPORTED_FORMAT/u);
  }
});

test('runtime fixture escaped Office result pages reassemble exactly without Work receipt compaction or skipped byte offsets',async t=>{
  const x=await fixture(t),content='\uFEFF'+JSON.stringify({rows:Array.from({length:40},(_,index)=>({id:index,note:'\\'.repeat(900)+' 한글 🌤️\n'}))})+'\n';
  const bytes=Buffer.from(content,'utf8');assert.ok(bytes.length>12000);
  await x.save('escaped-output',bytes);
  let offset=0,pages=0;const parts=[];
  for(;;){
    const page=await x.toolkit.execute('office_result_read',{request_id:'escaped-output',offset,max_bytes:12000},`escaped-page-${pages++}`);
    assert.equal(page.page.offset,offset);assert.equal(page.page.total_bytes,bytes.length);
    assert.equal(page.page.returned_bytes,Buffer.byteLength(page.text,'utf8'));
    assert.ok(Buffer.byteLength(JSON.stringify(page.text),'utf8')<=10000);
    assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<=16000);
    const normalized=boundWorkToolValue(page);assert.deepEqual(normalized,page);assert.equal(Object.hasOwn(normalized,'_office_compaction'),false);
    parts.push(page.text);
    if(!page.page.has_more){assert.equal(page.page.next_offset,null);break;}
    assert.equal(page.page.next_offset,offset+page.page.returned_bytes);assert.ok(page.page.next_offset>offset);
    offset=page.page.next_offset;assert.ok(pages<100,'Each page must advance without an unbounded loop');
  }
  assert.ok(pages>3);assert.equal(parts.join(''),content);assert.deepEqual(JSON.parse(parts.join('').replace(/^\uFEFF/u,'')),JSON.parse(content.replace(/^\uFEFF/u,'')));
});

test('runtime fixture saved native Pack source uses scoped pages whose raw Work tool value stays below the 16 KB boundary',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-native-source-page-')),source=join(root,'records.json'),host=join(root,'host.json');
  const rows=Array.from({length:24},(_,index)=>({id:`row-${index}`,note:`Observed ${index}: `+'\\'.repeat(900)+' 한글 🌤️'}));
  await writeFile(source,JSON.stringify(rows));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'office-native-source-page',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'records',kind:'file',path:source,format:'json'}],targets:[]}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);initWorkExecution(api.store);
  const nativeRecipe={version:1,family:'portal.collect',request:'Export every registered row',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
  const nativeSpec={...spec,route:{kind:'pack',pack_family:'portal.collect'},collection_contract:{version:1,recipe:nativeRecipe,scope:'all_matching_observed_rows',covered_check_ids:['bytes']}},begun=api.store.beginWork(config.project.id,randomUUID(),'Read all registered rows','quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),work=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,nativeSpec,[],'ready');
  assert.ok(sealCollectionContract(api.store,config,work.id,nativeSpec));
  const toolkit=new WorkExecutionTools(api.store,config,api,work.id,randomUUID(),nativeSpec,work.prompt,()=>{},{calls:[],async call(){assert.fail('No model call is required.');}});
  t.after(async()=>{await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const substituted={...nativeRecipe,filters:[{field:'id',op:'contains',value:'row'}]};
  assert.throws(()=>toolkit.validate('runtime_pack_run',{recipe:substituted},'changed-recipe-preflight'),/WORK_COLLECTION_RECIPE_CHANGED/u);
  await assert.rejects(toolkit.execute('runtime_pack_run',{recipe:substituted},'changed-recipe-direct'),/WORK_COLLECTION_RECIPE_CHANGED/u);
  assert.deepEqual(api.store.packRuns(config.project.id),[],'A changed sealed recipe must not dispatch a Pack run');
  const result=await toolkit.execute('runtime_pack_run',{recipe:nativeRecipe},'native-paged-source');assert.equal(result.status,'succeeded');
  const receipt=await toolkit.receipt('runtime_pack_run',result,'native-paged-source');assert.equal(receipt.effect_state,'verified');
  assert.match(toolkit.catalog().find(item=>item.name==='runtime_pack_status').description,/office_pack_source_read/u);
  let offset=0,index=0,viewHash=null,totalBytes=null;const parts=[];
  do{
    const page=await toolkit.execute('office_pack_source_read',{run_id:result.run_id,source_id:'records',offset,max_bytes:8192},`source-page-${index++}`);
    assert.equal(page.status,'succeeded');assert.equal(page.run_id,result.run_id);assert.equal(page.source_id,'records');assert.equal(page.offset,offset);
    assert.ok(Buffer.byteLength(JSON.stringify(page),'utf8')<16000);
    const normalized=boundWorkToolValue(page);assert.deepEqual(normalized,page);assert.equal(Object.hasOwn(normalized,'_office_compaction'),false);
    assert.equal(page.returned_bytes,Buffer.byteLength(page.text,'utf8'));
    assert.equal(page.full_source_read,false,'A page starting at a nonzero offset never asserts a full source read');
    viewHash??=page.view_sha256;totalBytes??=page.total_bytes;assert.equal(page.view_sha256,viewHash);assert.equal(page.total_bytes,totalBytes);
    parts.push(page.text);
    if(page.has_more){assert.ok(page.next_offset>offset);offset=page.next_offset;}else {assert.equal(page.next_offset,null);break;}
    assert.ok(index<100,'Pagination must make bounded progress');
  }while(true);
  assert.ok(index>1);const assembled=parts.join('');assert.deepEqual(JSON.parse(assembled),rows);
  assert.equal(Buffer.byteLength(assembled,'utf8'),totalBytes);assert.equal(sha(Buffer.from(assembled)),viewHash);
  await assert.rejects(toolkit.execute('office_pack_source_read',{run_id:result.run_id,source_id:'unregistered'},'wrong-source'),/WORK_PACK_SOURCE_NOT_CONNECTED/u);
  const foreignBegin=api.store.beginWork(config.project.id,randomUUID(),'Other Work','quick'),foreignOwner=api.store.claimWorkDefinition(config.project.id,foreignBegin.work.id),foreign=api.store.finishWorkDefinition(config.project.id,foreignBegin.work.id,foreignOwner,nativeSpec,[],'ready');
  const foreignToolkit=new WorkExecutionTools(api.store,config,api,foreign.id,randomUUID(),nativeSpec,foreign.prompt,()=>{},{calls:[],async call(){assert.fail('No model call is required.');}});
  t.after(()=>foreignToolkit.close());
  await assert.rejects(foreignToolkit.execute('office_pack_source_read',{run_id:result.run_id,source_id:'records'},'foreign-source'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
  await writeFile(source,JSON.stringify([{id:'mutated',note:'The original registered file changed.'}]));
  await assert.rejects(toolkit.execute('office_pack_source_read',{run_id:result.run_id,source_id:'records'},'changed-source'),/WORK_PACK_SOURCE_READBACK_UNAVAILABLE/u);
});
