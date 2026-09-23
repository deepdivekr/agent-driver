import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';

test('runtime contract Chromium profile-busy error is bounded retryable and same request completes after contention clears',{timeout:30000},async t=>{
  const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end('<h1 id="ready">Public list</h1><div class="row"><span class="title">Observed item</span></div>');});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});
  const root=await mkdtemp(join(tmpdir(),'driver-busy-source-')),url=`http://127.0.0.1:${server.address().port}`;t.after(()=>rm(root,{recursive:true,force:true}));
  const path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'busy',caller_ref:'tester',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:url+'/lab/account-a/',packs:{sources:[{id:'public',kind:'browser',url,rows:'.row',columns:{title:'.title'},ready:'#ready',auth_gate:'#auth',auth_required:false,account_selector:'#not-present',account_text:'unused'}]}}));
  const config=loadHostConfig(path),originalLaunch=chromium.launchPersistentContext;
  // This Chromium build permits two headless contexts on one directory, so
  // inject the documented launch failure; do not claim native lock reproduction.
  chromium.launchPersistentContext=async()=>{throw Error('Failed to create a ProcessSingleton for your profile directory');};t.after(()=>{chromium.launchPersistentContext=originalLaunch;});
  const api=new RuntimeApi(config);t.after(()=>api.close());const args={request_id:'shared-profile',recipe:{version:1,family:'research.search',request:'Read observed public list',sources:[{id:'public',parameters:{}}],filters:[],deduplicate_by:['title'],query:'',search_fields:['title'],sort:null,limit:10}};
  const busy=await api.call('runtime_pack_run',args);assert.equal(busy.status,'retryable_failure');assert.equal(busy.result.error,'PACK_BROWSER_PROFILE_BUSY');
  chromium.launchPersistentContext=originalLaunch;
  const resumed=await api.call('runtime_pack_run',args);assert.equal(resumed.run_id,busy.run_id);assert.equal(resumed.status,'succeeded');assert.equal(resumed.result.rows[0].title,'Observed item');
});
