import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';

test('runtime fixture draft-only record update verifies identity and before hash, then independently checks the record stayed unchanged',{timeout:60000},async t=>{
  const original={id:'r1',title:'Old title',untouched:'preserve'};
  let reads=0,posts=0,returnedId='r1',changeAfterFirstRead=false;
  const server=createServer((req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(req.method==='POST'){posts++;res.writeHead(500);res.end('unexpected write');return;}
    if(url.pathname==='/record'){
      reads++;
      res.setHeader('content-type','application/json');
      res.end(JSON.stringify({...original,id:returnedId,title:changeAfterFirstRead&&reads>1?'Changed elsewhere':original.title}));
      return;
    }
    res.setHeader('content-type','text/html');
    res.end('<h1>Existing record</h1><input id="id" value="r1"><input id="title" value="Old title"><button id="save" type="button">Save</button><script>document.querySelector("#title").addEventListener("input",()=>{fetch("/autosave",{method:"POST",body:"draft"}).catch(()=>{});});</script>');
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const root=await mkdtemp(join(tmpdir(),'driver-record-draft-')),origin=`http://127.0.0.1:${server.address().port}`;t.after(()=>rm(root,{recursive:true,force:true}));
  const target={id:'existing-record',family:'record.update',action:'update_record',effect_boundary:'allowlisted_field_update',url:origin+'/edit',draft_is_local:true,draft_only:true,auth_required:false,ready:'#id',auth_gate:'.authentication',account_selector:'.unused-account',account_text:'anonymous-draft',fields:{id:{selector:'#id',kind:'text'},title:{selector:'#title',kind:'text'}},identity_field:'id',submit:'#save',readback_url:origin+'/record',identity_parameter:'id'};
  const configPath=join(root,'host.json');await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'record-draft',caller_ref:'tester',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:origin+'/lab/account-a/',packs:{targets:[target]}}));
  const api=new RuntimeApi(loadHostConfig(configPath));t.after(()=>api.close());
  const recipe=(expected_before_sha256)=>({version:1,family:'record.update',request:'Prepare an unsaved title edit for the existing record',target:target.id,values:{id:'r1',title:'New draft title'},expected_before_sha256});
  const good=await api.call('runtime_pack_run',{request_id:'draft-good',recipe:recipe(snapshotHash(original))});
  assert.equal(good.status,'draft_ready');assert.equal(good.result.external_submit,false);assert.equal(good.result.approval_available,false);
  assert.ok((await readFile(good.result.capture_ref)).length>0);assert.ok(reads>=2,'existing record must be read both before and after form entry');assert.equal(posts,0);
  await assert.rejects(api.call('runtime_pack_execute_approved',{run_id:good.run_id}),/PACK_DRAFT_ONLY/u);

  reads=0;
  const stale=await api.call('runtime_pack_run',{request_id:'draft-stale',recipe:recipe('0'.repeat(64))});
  assert.equal(stale.status,'failed');assert.equal(stale.result.error,'PACK_RECORD_STALE');assert.equal(reads,1);assert.equal(posts,0);

  reads=0;returnedId='other';
  const wrongIdentity=await api.call('runtime_pack_run',{request_id:'draft-identity',recipe:recipe(snapshotHash(original))});
  assert.equal(wrongIdentity.status,'failed');assert.equal(wrongIdentity.result.error,'PACK_RECORD_IDENTITY_MISMATCH');assert.equal(reads,1);assert.equal(posts,0);

  reads=0;returnedId='r1';changeAfterFirstRead=true;
  const changed=await api.call('runtime_pack_run',{request_id:'draft-changed',recipe:recipe(snapshotHash(original))});
  assert.equal(changed.status,'failed');assert.equal(changed.result.error,'PACK_DRAFT_RECORD_CHANGED');assert.equal(reads,2);assert.equal(posts,0);
});
