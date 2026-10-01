import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {sourceSchema} from '../dist/packs/contracts.js';
import {collectSource} from '../dist/packs/sources.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {sealCollectionContract,verifySealedCollectionRun} from '../dist/work/collection-contract.js';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const count=10013;
const rows=Array.from({length:count},(_,index)=>({id:`row-${String(index).padStart(5,'0')}`,note:`${index}:`+'x'.repeat(850)}));

test('local JSON collection and Pack export preserve every row and byte beyond old source/output caps',{timeout:120000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'pack-large-file-')),path=join(root,'input.json'),host=join(root,'host.json');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const original=Buffer.from(JSON.stringify(rows));assert.ok(original.length>8*1024*1024);
  await writeFile(path,original);
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'large-pack-file',caller_ref:'owner',account_ref:'account',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'input',kind:'file',path:'input.json',format:'json'}],targets:[],models:'off'}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);t.after(async()=>{api.close();await api.drain();});
  const collected=await collectSource(config.packs.sources[0],{},config);
  assert.equal(collected.rows.length,count);assert.deepEqual(collected.rows.at(-1),rows.at(-1));
  assert.equal(collected.evidence.content_sha256,hash(original));
  const recipe={version:1,family:'portal.collect',request:'Export every input row unchanged',sources:[{id:'input',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
  const run=await api.call('runtime_pack_run',{request_id:'large-file-export',recipe});
  assert.equal(run.status,'succeeded');assert.equal(run.result.artifact.rows,count);
  const output=await readFile(run.result.artifact.path);
  assert.ok(output.length>8*1024*1024);assert.equal(run.result.artifact.bytes,output.length);
  assert.equal(run.result.artifact.sha256,hash(output));
  const exported=JSON.parse(output.toString('utf8'));
  assert.equal(exported.length,count);assert.deepEqual(exported.at(-1),rows.at(-1));
  assert.deepEqual(await readFile(path),original);
  assert.equal((await stat(path)).size,original.length);
  const repeated=await api.call('runtime_pack_run',{request_id:'large-file-export',recipe});
  assert.equal(repeated.run_id,run.run_id);assert.equal(repeated.result.artifact.sha256,hash(output));
});

test('HTTP CSV collection consumes a complete response beyond old byte and row caps',{timeout:120000},async t=>{
  const header='id,note\r\n',csv=Buffer.from(header+rows.map(row=>`${row.id},${row.note}\r\n`).join(''));
  assert.ok(csv.length>8*1024*1024);
  const server=createServer((_request,response)=>{response.writeHead(200,{'content-type':'text/csv','content-length':csv.length});
    for(let offset=0;offset<csv.length;offset+=4096)response.write(csv.subarray(offset,offset+4096));response.end();});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const source=sourceSchema.parse({id:'http-rows',kind:'http',url:`http://127.0.0.1:${server.address().port}/rows`,format:'csv'});
  const collected=await collectSource(source,{},{});
  assert.equal(collected.rows.length,count);assert.deepEqual(collected.rows.at(-1),rows.at(-1));
  assert.equal(collected.evidence.content_sha256,hash(csv));assert.equal(collected.evidence.response_bytes,csv.length);
});

test('HTTP CSV rejects HTML login/error responses but accepts plain and octet-stream CSV',async t=>{
  const server=createServer((request,response)=>{
    const path=request.url;
    if(path==='/html-mime'){response.writeHead(200,{'content-type':'text/html; charset=utf-8'});response.end('id,status\n');return;}
    if(path==='/html-signature'){response.writeHead(200,{'content-type':'text/csv'});response.end('<html>sign in</html>');return;}
    if(path==='/plain'){response.writeHead(200,{'content-type':'text/plain'});response.end('id,status\r\n');return;}
    response.writeHead(200,{'content-type':'application/octet-stream'});response.end('id,status\r\na,Open\r\n');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const source=path=>sourceSchema.parse({id:'csv-response',kind:'http',url:`http://127.0.0.1:${server.address().port}${path}`,format:'csv'});
  await assert.rejects(collectSource(source('/html-mime'),{},{}),/PACK_SOURCE_HTTP_HTML_RESPONSE/u);
  await assert.rejects(collectSource(source('/html-signature'),{},{}),/SOURCE_HTML_NOT_CSV/u);
  assert.deepEqual((await collectSource(source('/plain'),{},{})).rows,[]);
  assert.deepEqual((await collectSource(source('/octet'),{},{})).rows,[{id:'a',status:'Open'}]);
});

test('sealed zero-row CSV completion requires the actual source header fields, while JSON empty stays distinct',async t=>{
  const bodies={bad:'Access denied\n',missing:'id\n',nonempty_missing:'id\na\n',good:'id,status\n',json:'[]'};
  const server=createServer((request,response)=>{
    const name=request.url?.split('/').at(-1)??'';
    response.writeHead(200,{'content-type':name==='json'?'application/json':'text/plain'});
    response.end(bodies[name]??'');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const root=await mkdtemp(join(tmpdir(),'pack-empty-header-')),host=join(root,'host.json');
  t.after(()=>rm(root,{recursive:true,force:true}));
  const base=`http://127.0.0.1:${server.address().port}/accounts/account-a/`;
  const sources=Object.keys(bodies).map(id=>({id,kind:'http',url:base+id,format:id==='json'?'json':'csv'}));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'pack-empty-header',caller_ref:'fixture',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:base,packs:{sources,targets:[],models:'off'}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);t.after(async()=>{api.close();await api.drain();});
  async function verified(id){
    const recipe={version:1,family:'portal.collect',request:'Keep every Open row',sources:[{id,parameters:{}}],filters:[{field:'status',op:'eq',value:'Open'}],deduplicate_by:['id'],columns:['id','status'],format:'json'};
    const spec={title:'Collect Open rows',desired_outcome:'Keep all matching rows',completion_checks:[{id:'all_rows',result:'Keep all matching observed rows',evidence:'Native source and output proof'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Keep all matching rows','local_file_write'),collection_contract:{version:1,recipe,scope:'all_matching_observed_rows',covered_check_ids:['all_rows']}};
    const started=api.store.beginWork(config.project.id,randomUUID(),'Keep every Open row from this source.','quick'),owner=api.store.claimWorkDefinition(config.project.id,started.work.id);
    const work=api.store.finishWorkDefinition(config.project.id,started.work.id,owner,spec,[],'ready',()=>sealCollectionContract(api.store,config,started.work.id,spec));
    const run=await api.call('runtime_pack_run',{request_id:`empty-${id}`,work_id:work.id,recipe});
    assert.equal(run.status,'succeeded');
    const proof=await verifySealedCollectionRun(api.store,config,work.id,run.run_id);
    return {run,proof};
  }
  for(const id of ['bad','missing','nonempty_missing']){
    const {run,proof}=await verified(id);
    assert.equal(run.result.artifact.rows,0,`${id} is the dangerous empty-output case`);
    assert.equal(proof,null,`${id} must not acquire a sealed completion certificate`);
  }
  const csv=await verified('good');assert.equal(csv.run.result.artifact.rows,0);assert.deepEqual(csv.run.result.evidence[0].csv_header,['id','status']);assert.ok(csv.proof);
  const json=await verified('json');assert.equal(json.run.result.artifact.rows,0);assert.equal(json.run.result.evidence[0].csv_header,undefined);assert.ok(json.proof);
});
