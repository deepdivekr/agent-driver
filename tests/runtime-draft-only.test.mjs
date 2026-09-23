import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {targetSchema} from '../dist/packs/contracts.js';

test('runtime fixture public draft fills exact values but cannot expose approval or submit',{timeout:30000},async t=>{
  let posts=0;const server=createServer((req,res)=>{if(req.method==='POST'){posts++;res.end('unexpected');return;}res.setHeader('content-type','text/html');res.end('<h1>Contact</h1><form method="post" action="/submit"><input id="email"><textarea id="message"></textarea><button type="submit">Send</button></form><script>document.querySelector("textarea").addEventListener("input",()=>{fetch("/autosave",{method:"POST",body:"draft"}).catch(()=>{});});</script>');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const root=await mkdtemp(join(tmpdir(),'driver-draft-only-')),url=`http://127.0.0.1:${server.address().port}`;t.after(()=>rm(root,{recursive:true,force:true}));
  const target={id:'contact',family:'form.draft-submit',action:'submit_form',effect_boundary:'single_form_submission',url,draft_is_local:true,draft_only:true,auth_required:false,ready:'#email',auth_gate:'.authentication',account_selector:'.absent-account',account_text:'unused-public-draft',fields:{email:{selector:'#email',kind:'text'},message:{selector:'#message',kind:'text'}},identity_field:'email',submit:'button',readback_url:null,identity_parameter:'id'};
  assert.equal(targetSchema.safeParse({...target,draft_only:false}).success,false);
  assert.equal(targetSchema.safeParse({...target,draft_only:false,readback_url:url+'/read'}).success,false);
  const path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'draft',caller_ref:'tester',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:url+'/lab/account-a/',packs:{targets:[target]}}));
  const api=new RuntimeApi(loadHostConfig(path));t.after(()=>api.close());
  const result=await api.call('runtime_pack_run',{request_id:'fill',recipe:{version:1,family:'form.draft-submit',request:'Draft only',target:'contact',values:{email:'demo@example.com',message:'Unsent draft'},expected_before_sha256:null}});
  assert.equal(result.status,'draft_ready');assert.equal(result.result.external_submit,false);assert.equal(result.result.approval_available,false);assert.ok((await readFile(result.result.capture_ref)).length>0);
  await assert.rejects(api.call('runtime_pack_execute_approved',{run_id:result.run_id}),/PACK_DRAFT_ONLY/);assert.equal(posts,0);
  const duplicate=await api.call('runtime_pack_run',{request_id:'fill',recipe:{version:1,family:'form.draft-submit',request:'Draft only',target:'contact',values:{email:'demo@example.com',message:'Unsent draft'},expected_before_sha256:null}});assert.equal(duplicate.run_id,result.run_id);assert.equal(duplicate.deduplicated,true);
});
