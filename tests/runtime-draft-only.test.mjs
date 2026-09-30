import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {targetSchema} from '../dist/packs/contracts.js';
import {verifiedDraftBrowserReadbacks} from '../dist/packs/browser-write.js';

test('runtime unit old or divergent draft readbacks cannot become observed before-and-after evidence',()=>{
  const values={email:'demo@example.com',message:'Unsent draft'},digest='a'.repeat(64);
  const complete={verified_values:values,verified_values_before_capture:values,verified_values_after_capture:values,capture_sha256:digest};
  assert.deepEqual(verifiedDraftBrowserReadbacks(complete,values),{before:values,after:values});
  for(const partial of [
    {verified_values:values,capture_sha256:digest},
    {...complete,verified_values_before_capture:undefined},
    {...complete,verified_values_after_capture:undefined},
    {...complete,verified_values_after_capture:{...values,message:'Changed after capture'}},
    {...complete,capture_sha256:undefined},
  ])assert.throws(()=>verifiedDraftBrowserReadbacks(partial,values),/PACK_DRAFT_READBACK_UNVERIFIED/u);
});

test('runtime fixture public draft fills exact values but cannot expose approval or submit',{timeout:30000},async t=>{
  let posts=0;const server=createServer((req,res)=>{if(req.method==='POST'){posts++;res.end('unexpected');return;}res.setHeader('content-type','text/html');res.end('<h1>Contact</h1><form method="post" action="/submit"><input id="email"><textarea id="message"></textarea><button type="submit">Send</button></form><script>document.querySelector("textarea").addEventListener("input",()=>{fetch("/autosave",{method:"POST",body:"draft"}).catch(()=>{});});</script>');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const root=await mkdtemp(join(tmpdir(),'driver-draft-only-')),url=`http://127.0.0.1:${server.address().port}`;t.after(()=>rm(root,{recursive:true,force:true}));
  const target={id:'contact',family:'form.draft-submit',action:'submit_form',effect_boundary:'single_form_submission',url,draft_is_local:true,draft_only:true,auth_required:false,ready:'#email',auth_gate:'.authentication',account_selector:'.absent-account',account_text:'unused-public-draft',fields:{email:{selector:'#email',kind:'text'},message:{selector:'#message',kind:'text'}},identity_field:'email',submit:'button',readback_url:null,identity_parameter:'id'};
  assert.equal(targetSchema.safeParse({...target,draft_only:false}).success,false);
  assert.equal(targetSchema.safeParse({...target,draft_only:false,readback_url:url+'/read'}).success,false);
  const path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'draft',caller_ref:'tester',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:url+'/lab/account-a/',packs:{targets:[target]}}));
  const api=new RuntimeApi(loadHostConfig(path));t.after(()=>api.close());
  const result=await api.call('runtime_pack_run',{request_id:'fill',recipe:{version:1,family:'form.draft-submit',request:'Draft only',target:'contact',values:{email:'demo@example.com',message:'Unsent draft'},expected_before_sha256:null}});
  assert.equal(result.status,'draft_ready');assert.equal(result.result.external_submit,false);assert.equal(result.result.approval_available,false);
  assert.deepEqual(result.result.verified_values,{email:'demo@example.com',message:'Unsent draft'});assert.equal(result.result.readback_source,'browser_dom_controls_after_capture');
  assert.deepEqual(result.result.verified_values_before_capture,{email:'demo@example.com',message:'Unsent draft'});
  assert.deepEqual(result.result.verified_values_after_capture,{email:'demo@example.com',message:'Unsent draft'});
  const capture=await readFile(result.result.capture_ref);assert.ok(capture.length>0);assert.equal(result.result.capture_sha256,createHash('sha256').update(capture).digest('hex'));
  await assert.rejects(api.call('runtime_pack_execute_approved',{run_id:result.run_id}),/PACK_DRAFT_ONLY/);assert.equal(posts,0);
  const duplicate=await api.call('runtime_pack_run',{request_id:'fill',recipe:{version:1,family:'form.draft-submit',request:'Draft only',target:'contact',values:{email:'demo@example.com',message:'Unsent draft'},expected_before_sha256:null}});assert.equal(duplicate.run_id,result.run_id);assert.equal(duplicate.deduplicated,true);
});
