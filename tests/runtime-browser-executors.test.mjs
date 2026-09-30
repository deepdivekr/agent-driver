import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {browserTargetSchema,browserExecutorsSchema} from '../dist/browser/executor-contracts.js';
import {RoutedBrowser,eligibleBrowserTargets,assertBrowserUrl,browserTargets,publicBrowserRecovery} from '../dist/browser/executor-routing.js';
import {BrowserExecutorJournal} from '../dist/browser/executor-journal.js';
import {collectSource} from '../dist/packs/sources.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {PackStore} from '../dist/packs/store.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {localVmSpawner,ubuntuBrowserCloudInit} from '../dist/isolation/ubuntu-browser-vm.js';

const target=(id,extra={})=>browserTargetSchema.parse({id,engine:'playwright',environment:'owned_headless',profile_ref:id,platform:process.platform,...extra});
const config=targets=>({fingerprint:'fixture',dbPath:'/tmp/unused.db',environment:'production',project:{id:'test',profileRef:'/tmp/unused'},browserExecutors:{targets}});
const observation=()=>({url:'https://example.test/',title:'Evidence',text:'Verified page',links:[],observed_at:new Date().toISOString()});
function fake(target,log,{probeError,readError}={}){let reads=0;return {target,async probe(){log.push(`${target.id}:probe`);if(probeError)throw Error(probeError);},async open(){log.push(`${target.id}:open`);},async navigate(){log.push(`${target.id}:navigate`);},async observe(){log.push(`${target.id}:observe`);if(++reads>1&&readError)throw Error(readError);return observation();},async extract(){return [{name:'Alpha'}];},async scroll(){log.push(`${target.id}:scroll`);},async close(){log.push(`${target.id}:close`);}};}
const options=factory=>({profile_key:'test',context_id:'test',factory});

test('runtime contract browser engine and placement stay independent; foreground never substitutes background',()=>{
  const c=config([target('headless'),target('foreground',{environment:'host_foreground'}),target('guest',{environment:'windows_vm'})]);
  assert.deepEqual(eligibleBrowserTargets(c).map(t=>t.id),['headless']);
  assert.deepEqual(eligibleBrowserTargets(c,{environment:'windows_vm'}).map(t=>t.id),['guest']);
  assert.equal(browserExecutorsSchema.safeParse({targets:[target('one'),target('one')]}).success,false);
  assert.equal(browserTargetSchema.safeParse({id:'bad',engine:'aside',environment:'owned_headless',platform:'win32',profile_ref:'x',executable:'C:/aside.exe'}).success,false);
});
test('runtime contract browser URL gate rejects credential forwarding, secret queries and undelegated origins',()=>{
  for(const url of ['https://user:pass@example.test/','https://example.test/?token=secret','https://other.test/','javascript:alert(1)'])assert.throws(()=>assertBrowserUrl(url,['https://example.test']));
  assert.equal(assertBrowserUrl('https://example.test/?q=search',['https://example.test']).hostname,'example.test');
});
test('runtime contract public recovery goes headless then managed VM then Aside, never Neo or a reverse loop',async()=>{
  const targets=[target('headless'),target('vm',{environment:'ubuntu_vm'}),target('neo',{engine:'neo',environment:'host_foreground',endpoint:'http://127.0.0.1:9999/mcp',priority:100}),target('aside',{engine:'aside',environment:'host_foreground',executable:'/fixture/aside',priority:1})];
  const log=[],browser=new RoutedBrowser(config(targets),{...options(t=>fake(t,log,t.id==='aside'?{}:{probeError:'ECONNREFUSED'})),fallback_preferences:publicBrowserRecovery()},['https://example.test']);
  await browser.open('https://example.test/');assert.equal(browser.target.id,'aside');
  assert.deepEqual(log.filter(s=>s.endsWith(':probe')),['headless:probe','vm:probe','aside:probe']);await browser.close();
  assert.deepEqual(publicBrowserRecovery({environment:'ubuntu_vm'}),[{environment:'host_foreground',preferred_engine:'aside'}]);
  assert.deepEqual(publicBrowserRecovery({environment:'host_foreground'}),[]);
  assert.deepEqual(publicBrowserRecovery({environment:'owned_headless',preferred_engine:'playwright'}),[]);
  assert.deepEqual(eligibleBrowserTargets(config(targets),{environment:'host_foreground',preferred_engine:'aside'}).map(t=>t.id),['aside']);
});
test('runtime contract configured managed VM appears once without starting a guest or claiming Windows VM support',()=>{
  const c={...config([target('headless')]),swarm:{visual:{owned_vm:{id:'test-vm'}}}};
  assert.deepEqual(browserTargets(c).map(t=>[t.id,t.environment]),[['headless','owned_headless'],['login-owned-ubuntu-vm','ubuntu_vm']]);
  assert.deepEqual(browserTargets({...c,browserExecutors:{targets:[target('vm',{environment:'ubuntu_vm'})]}}).map(t=>t.id),['vm']);
  assert.equal(browserTargets(config([target('headless')])).length,1);
});
test('runtime contract browser transport failure hands off with fresh observation and preserves completed steps',async()=>{
  const log=[],events=[],c=config([target('first'),target('second')]);
  const browser=new RoutedBrowser(c,{...options(t=>fake(t,log,t.id==='first'?{readError:'ECONNRESET'}:{})),event:e=>events.push(e)},['https://example.test']);
  await browser.open('https://example.test/');await browser.scroll('down');await browser.observe();
  assert.equal(browser.target.id,'second');assert.deepEqual(browser.completedSteps,['scroll','observe']);assert.equal(log.filter(s=>s==='first:scroll').length,1);assert.equal(log.includes('second:scroll'),false);
  assert.ok(events.some(e=>e.kind==='handoff'&&e.from==='first'));assert.equal(browser.checkpoint().effect_state,'none');await browser.close();
});

test('runtime contract read-only technical fallback crosses only explicitly offered registered environments',async()=>{
  const targets=[target('guest',{environment:'windows_vm'}),target('ubuntu',{environment:'ubuntu_vm'}),target('windows',{environment:'host_foreground'})];
  const log=[],events=[],browser=new RoutedBrowser(config(targets),{
    ...options(t=>fake(t,log,t.id==='windows'?{}:{probeError:'ECONNREFUSED'})),
    preference:{environment:'windows_vm'},fallback_environments:['ubuntu_vm','host_foreground'],event:e=>events.push(e),
  },['https://example.test']);
  await browser.open('https://example.test/');
  assert.equal(browser.target.id,'windows');
  assert.deepEqual(log.filter(item=>item.endsWith(':probe')),['guest:probe','ubuntu:probe','windows:probe']);
  assert.ok(events.some(event=>event.kind==='failed'&&event.environment==='windows_vm'));
  assert.ok(events.some(event=>event.kind==='selected'&&event.environment==='host_foreground'));
  await browser.close();
  const without=new RoutedBrowser(config(targets),{...options(t=>fake(t,[],t.id==='guest'?{probeError:'ECONNREFUSED'}:{})),preference:{environment:'windows_vm'}},['https://example.test']);
  await assert.rejects(without.open('https://example.test/'),/ECONNREFUSED/);await without.close();
});

test('runtime contract login/access failure and user-pinned engine never cross environments',async()=>{
  const targets=[target('guest',{environment:'windows_vm'}),target('ubuntu',{environment:'ubuntu_vm'})];
  const log=[],browser=new RoutedBrowser(config(targets),{
    ...options(t=>fake(t,log,t.id==='guest'?{readError:'PACK_WAITING_AUTH'}:{})),
    preference:{environment:'windows_vm'},fallback_environments:['ubuntu_vm'],
  },['https://example.test']);
  await browser.open('https://example.test/');await assert.rejects(browser.observe(),/PACK_WAITING_AUTH/);
  assert.equal(log.includes('ubuntu:open'),false);await browser.close();
  const pinnedLog=[],pinned=new RoutedBrowser(config(targets),{
    ...options(t=>fake(t,pinnedLog,t.id==='guest'?{probeError:'ECONNREFUSED'}:{})),
    preference:{environment:'windows_vm',preferred_engine:'playwright'},fallback_environments:['ubuntu_vm'],
  },['https://example.test']);
  await assert.rejects(pinned.open('https://example.test/'),/ECONNREFUSED/);
  assert.equal(pinnedLog.includes('ubuntu:probe'),false);await pinned.close();
});

test('runtime contract browser pre-navigation launch and absent binary errors select an eligible replacement',async()=>{
  for(const error of [Error('browserType.launchPersistentContext: spawn UNKNOWN'),Object.assign(Error('missing executable'),{code:'ENOENT'}),Error('page.goto: net::ERR_CONNECTION_RESET at https://example.test/')]){
    const log=[],events=[],browser=new RoutedBrowser(config([target('first'),target('second')]),{...options(t=>t.id==='first'?{...fake(t,log),async open(){throw error;}}:fake(t,log)),event:e=>events.push(e)},['https://example.test']);
    await browser.open('https://example.test/');assert.equal(browser.target.id,'second');assert.ok(events.some(e=>e.kind==='failed'&&e.reason==='executor_unavailable'));await browser.close();
  }
});
test('runtime contract browser authentication and unknown dialogs never trigger alternate-account fallback',async()=>{
  for(const error of ['PACK_WAITING_AUTH','PACK_UNKNOWN_DIALOG','PACK_ACCOUNT_MISMATCH']){const log=[],browser=new RoutedBrowser(config([target('first'),target('second')]),options(t=>fake(t,log,{readError:error})),['https://example.test']);await browser.open('https://example.test/');await assert.rejects(browser.observe(),new RegExp(error));assert.equal(log.includes('second:open'),false);await browser.close();}
});
test('runtime contract browser uncertain effects prohibit executor replay',async()=>{
  const log=[],browser=new RoutedBrowser(config([target('first'),target('second')]),options(t=>fake(t,log,{readError:'ECONNRESET'})),['https://example.test']);await browser.open('https://example.test/');browser.markUncertainEffect();await assert.rejects(browser.observe(),/ECONNRESET/);assert.equal(log.includes('second:open'),false);assert.equal(browser.checkpoint().effect_state,'uncertain');await browser.close();
});
test('runtime contract browser verified choice skips both models but still probes and observes',async()=>{
  const log=[],model={async call(){throw Error('model must not be called');}},browser=new RoutedBrowser(config([target('first'),target('second')]),{...options(t=>fake(t,log)),remembered:'second',providers:{llm:model,jev:{async systemOne(){throw Error('jev must not be called');}}}},['https://example.test']);await browser.open('https://example.test/');assert.equal(browser.target.id,'second');assert.deepEqual(log,['second:probe','second:open','second:observe']);await browser.close();
});
test('runtime contract browser journal survives connection recreation and scopes reusable routes',()=>{
  const db=new DatabaseSync(':memory:'),journal=new BrowserExecutorJournal(db),binding='a'.repeat(64);journal.success('a',binding,'second');assert.equal(new BrowserExecutorJournal(db).remembered('a',binding),'second');assert.equal(journal.remembered('b',binding),undefined);journal.invalidate('a',binding);assert.equal(journal.remembered('a',binding),undefined);db.close();
});
test('runtime contract browser Jev selection uses shared Decision Plane and persists real probabilities',async t=>{
  const root=await mkdtemp(join(tmpdir(),'browser-decision-'));t.after(()=>rm(root,{recursive:true,force:true}));const c={...config([target('first'),target('second')]),dbPath:join(root,'runtime.db')},log=[];
  let called=0;const jev={async systemOne(request){called++;assert.deepEqual(request.state.required_operations,['navigate','observe','extract']);const criteria=request.questions.executor.criteria;return {model:'jev-fixture',answers:{executor:{type:'choice',choice:'second',confidence:.99,probabilities:Object.fromEntries(Object.keys(criteria).map(k=>[k,k==='second'?1:0]))}},usage:{input_tokens:20,output_tokens:8}};}};
  const browser=new RoutedBrowser(c,{...options(t=>fake(t,log)),request:'Read this source',providers:{jev}},['https://example.test']);await browser.open('https://example.test/');assert.equal(browser.target.id,'second');assert.equal(called,1);await browser.close();const lines=(await readFile(join(root,'decisions/browser.jsonl'),'utf8')).trim().split('\n');const event=JSON.parse(lines[0]);assert.equal(event.judgments[0].value,'second');assert.equal(event.judgments[0].confidence,.99);
});

test('runtime contract browser LLM correction is identified without borrowing Jev confidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'browser-review-'));t.after(()=>rm(root,{recursive:true,force:true}));const events=[],c={...config([target('first'),target('second')]),dbPath:join(root,'runtime.db')};let reviews=0;
  const jev={async systemOne(request){return {model:'fixture',answers:{executor:{type:'choice',choice:'unknown',confidence:.99,probabilities:Object.fromEntries(Object.keys(request.questions.executor.criteria).map(k=>[k,k==='unknown'?1:0]))}},usage:{input_tokens:10,output_tokens:5}};}};
  const llm={async call(){reviews++;return {executor:'second'};}};
  const browser=new RoutedBrowser(c,{...options(t=>fake(t,[])),providers:{jev,llm},event:e=>events.push(e)},['https://example.test']);await browser.open('https://example.test/');assert.equal(browser.target.id,'second');assert.equal(reviews,1);const selected=events.find(e=>e.kind==='selected');assert.equal(selected.selection_source,'llm');assert.equal(selected.confidence,null);assert.ok(selected.decision_event_id);await browser.close();
});
test('runtime native browser common adapter collects real DOM and FamilyRuntime preserves its executor evidence',async t=>{
  const root=await mkdtemp(join(tmpdir(),'browser-family-'));let posts=0;const server=createServer((req,res)=>{if(req.method==='POST')posts++;res.setHeader('content-type','text/html');res.end('<h1 id="ready">Ready</h1><table><tr class="row"><td class="name">Alpha</td><td class="value">42</td></tr></table>');});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`,path=join(root,'host.json');
  const source={id:'table',kind:'browser',url,parameters:[],ready:'#ready',auth_gate:'#login',auth_required:false,account_selector:'#account',account_text:'fixture',rows:'.row',columns:{name:'.name',value:'.value'}};
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'test',caller_ref:'agent',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:url+'/fixture/account-a/',browser_executors:{targets:[target('pw')]},packs:{sources:[source]}}));const c=loadHostConfig(path),store=new PackStore(c.dbPath);store.registerProject(c.project);const runtime=new FamilyRuntime(store,c);
  t.after(async()=>{runtime.close();await runtime.drain();store.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const collected=await collectSource(source,{},c);assert.deepEqual(collected.rows,[{name:'Alpha',value:'42'}]);assert.equal(collected.evidence.executor,'playwright');
  const recipe={version:1,family:'portal.collect',request:'Collect public fixture',sources:[{id:'table',parameters:{}}],filters:[],deduplicate_by:[],format:'json'};
  const result=await runtime.call('runtime_pack_run',{request_id:'browser-run',recipe});assert.equal(result.status,'succeeded');assert.equal(posts,0);assert.ok(store.browserExecutors().events(c.project.id,`${result.run_id}:table`).some(e=>e.kind==='selected'));
});

test('runtime contract browser restart restores only bound checkpoint data and never replays completed actions',async()=>{
  const db=new DatabaseSync(':memory:'),journal=new BrowserExecutorJournal(db),log=[],c=config([target('one')]),checkpoint={load:()=>journal.checkpoint('test','run'),save:value=>journal.saveCheckpoint('test','run',value)};
  const opts={...options(t=>fake(t,log)),checkpoint},first=new RoutedBrowser(c,opts,['https://example.test']);
  await first.open('https://example.test/');await first.scroll('down');await first.close();
  const resumed=new RoutedBrowser(c,opts,['https://example.test']);await resumed.open('https://example.test/');assert.deepEqual(resumed.completedSteps,['scroll']);assert.equal(log.filter(s=>s==='one:scroll').length,1);assert.equal(log.filter(s=>s==='one:observe').length,2);await resumed.close();
  const changed=new RoutedBrowser({...c,fingerprint:'different'},opts,['https://example.test']);await assert.rejects(changed.open('https://example.test/'),/BINDING_CHANGED/);await changed.close();
  const uncertain=new RoutedBrowser(c,opts,['https://example.test']);await uncertain.open('https://example.test/');uncertain.markUncertainEffect();await uncertain.close();
  const blocked=new RoutedBrowser(c,opts,['https://example.test']);await assert.rejects(blocked.open('https://example.test/'),/RECONCILIATION_REQUIRED/);await blocked.close();db.close();
});

test('runtime contract browser live probe removes unavailable candidates before optional model use',async()=>{
  const log=[],browser=new RoutedBrowser(config([target('one'),target('two')]),{...options(t=>fake(t,log,t.id==='one'?{probeError:'ECONNREFUSED'}:{})),providers:{jev:{async systemOne(){throw Error('must not call a model for one live candidate');}}}},['https://example.test']);
  await browser.open('https://example.test/');assert.equal(browser.target.id,'two');assert.equal(log.filter(s=>s==='two:probe').length,1);await browser.close();
});

test('runtime contract browser semantic operation errors and revoked work do not trigger replay',async()=>{
  for(const failure of ['BROWSER_REMOTE_OPERATION_FAILED','PACK_SOURCE_CHANGED']){
    const log=[],browser=new RoutedBrowser(config([target('one'),target('two')]),options(t=>fake(t,log,{readError:failure})),['https://example.test']);await browser.open('https://example.test/');await assert.rejects(browser.observe(),new RegExp(failure));assert.equal(log.includes('two:open'),false);await browser.close();
  }
  let allowed=true;const log=[],browser=new RoutedBrowser(config([target('one'),target('two')]),{...options(t=>fake(t,log)),guard:()=>{if(!allowed)throw Error('WORK_PAUSED');}},['https://example.test']);await browser.open('https://example.test/');allowed=false;await assert.rejects(browser.observe(),/WORK_PAUSED/);assert.equal(log.includes('two:open'),false);await browser.close();
});

test('runtime native routed swarm automatically assigns isolated contexts and keeps an independent worker alive',async t=>{
  const root=await mkdtemp(join(tmpdir(),'routed-swarm-')),server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<title>${req.url}</title><p id="state"></p><a href="/next">Next</a><script>${req.url==='/one'?"localStorage.setItem('worker','one');document.cookie='worker=one';":""}document.getElementById('state').textContent='stored:'+(localStorage.getItem('worker')||'empty')+' cookies:'+document.cookie;</script>`);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'routed-project',caller_ref:'agent',account_ref:'account-a',worktree:root,data_dir:'data',environment:'fixture',fixture_url:origin+'/fixture/account-a/',browser_executors:{targets:[target('pw')]},swarm:{enabled:true,model_data_approved:true,max_logical_workers:8,max_concurrency:2,lease_ms:60_000,visual:{enabled:true,max_contexts:2}}}));
  const model={calls:[],async call(){this.calls.push({purpose:'design',model:'fixture',elapsed_ms:1,input_sha256:'a'.repeat(64),status:'accepted'});return {summary:'Owned browser isolation acceptance',workers:['one','two'].map(id=>({id,role:id,objective:'Read this test page',stage:'source_read',source_urls:[origin+'/'+id],executor:'browser',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Page text'],max_steps:20,timeout_ms:60_000}))};}},api=new RuntimeApi(loadHostConfig(path),{swarmModel:model});
  t.after(async()=>{api.close();await api.drain();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(root,{recursive:true,force:true});});
  const catalog=await api.call('runtime_browser_executors',{});assert.equal(catalog.executors[0].health,'unknown');assert.equal(catalog.executors[0].verified_for_environment,false);
  const plan=await api.call('runtime_swarm_plan',{goal:'Test browser worker isolation',context:{}}),run=await api.call('runtime_swarm_run',{request_id:'routed-test',plan_id:plan.plan.plan_id}),leased=await api.call('runtime_swarm_tick',{run_id:run.run_id});assert.equal(leased.dispatches.length,2);
  const views=await Promise.all(leased.dispatches.map(w=>api.call('runtime_swarm_browser',{run_id:run.run_id,worker_id:w.worker_id,lease_token:w.lease_token,command:{action:'observe'}})));
  assert.match(views[0].text,/stored:one cookies:worker=one/);assert.match(views[1].text,/stored:empty cookies:/);assert.equal(new Set(views.map(v=>v.surface_id)).size,2);
  const surfaces=api.store.controlSurfaces('routed-project');assert.equal(surfaces.length,2);assert.ok(surfaces.every(s=>s.preview_endpoint===''));
  const [a,b]=leased.dispatches;await api.call('runtime_swarm_report',{run_id:run.run_id,worker_id:a.worker_id,lease_token:a.lease_token,report:{status:'needs_human',summary:'Waiting for authentication',error_code:'BROWSER_AUTH_REQUIRED'}});
  const second=await api.call('runtime_swarm_browser',{run_id:run.run_id,worker_id:b.worker_id,lease_token:b.lease_token,command:{action:'observe'}});assert.match(second.text,/stored:empty/);
  await assert.rejects(api.call('runtime_swarm_browser',{run_id:run.run_id,worker_id:b.worker_id,lease_token:'00000000-0000-4000-8000-000000000001',command:{action:'observe'}}),/STALE_SWARM_LEASE/);
});

test('runtime native VM child cleanup retains event loop until its own detached process exits',async()=>{
  const child=await localVmSpawner.spawn(process.execPath,['-e','setInterval(()=>{},1000)']);await child.stop();assert.throws(()=>process.kill(child.pid,0));await child.stop();
  const source=ubuntuBrowserCloudInit({id:'test-vm',storage_root:'/tmp/test-vm',base_image:'/tmp/base.qcow2',base_image_sha256:'a'.repeat(64),memory_mib:1024,cpus:1,disk_gib:16,ssh_port:2222,devtools_port:9222,vnc_port:5901,guest_user:'agentdriver'});
  assert.match(source,/install -d -o agentdriver -g agentdriver \/home\/agentdriver\/snap \/home\/agentdriver\/snap\/chromium \/home\/agentdriver\/snap\/chromium\/common /);
  assert.ok(source.includes('/home/agentdriver/.config /home/agentdriver/.config/systemd /home/agentdriver/.config/systemd/user'));
});
