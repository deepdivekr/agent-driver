import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {Script} from 'node:vm';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {authProfile,authSite,authSites,requireSiteAuth,setSiteAuth,blockedAuthSites,detectAuthGate,BrowserLoginBroker,connectOwnedBrowser} from '../dist/swarm/browser-auth.js';
import {SwarmVisualExecutor} from '../dist/swarm/visual-executor.js';
import {startControlCenter,readControlCenter} from '../dist/observability/control-center.js';
const koPage=async(browser,options)=>{const page=await browser.newPage(options);await page.addInitScript(()=>{try{localStorage.setItem('office-lang','ko')}catch{}});return page;};

async function setup(t,{allProtected=false,fixtureOrigin=null,owned=true,deferCleanup=false}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-browser-auth-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'auth-test',caller_ref:'test',account_ref:'account-a',worktree:root,data_dir:'data',environment:fixtureOrigin?'fixture':'production',...(fixtureOrigin?{fixture_url:`${fixtureOrigin}/fixture/account-a/`}:{}),swarm:{enabled:true,model_data_approved:true,max_logical_workers:8,max_concurrency:6,visual:{enabled:true,max_contexts:6,...(owned?{owned_vm:{id:'test-owned',storage_root:join(root,'vm'),devtools_port:49222,vnc_port:45901}}:{})}}}));
  const urls=fixtureOrigin?Array.from({length:6},(_,i)=>`${fixtureOrigin}/worker-${i}`):['https://x.com/search','https://www.reddit.com/r/ASTSpaceMobile/',...Array.from({length:4},(_,i)=>allProtected?'https://x.com/home':`https://example.test/${i}`)];
  const worker=(id,stage,source_urls,depends_on=[])=>({id,role:id,objective:'Read source',stage,source_urls,executor:'browser',depends_on,required_capabilities:[],effect:'read_only',completion_evidence:['Readback'],max_steps:10,timeout_ms:60000});
  const sources=urls.map((url,i)=>worker(`source-${i}`,'source_read',[url]));
  const visual={assigned:[],released:[],async assign(run,id){this.assigned.push(id);return {surface_id:`surface-${id}`,kind:'browser'};},async perform(){throw Error('BROWSER_AUTH_REQUIRED');},async release(run,id){this.released.push(id);},async close(){}};
  const model={calls:[],async call(purpose){this.calls.push({model:'contract-model',input_sha256:'a'.repeat(64),status:'accepted'});if(purpose==='design')return {summary:'Auth preflight contract fixture.',workers:[...sources,worker('reduce','reduction',[],sources.map(w=>w.id)),worker('synthesize','synthesis',[],['reduce'])]};throw Error('MODEL_NOT_USED');}};
  const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:model,swarmVisual:visual});
  const cleanup=async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});};
  if(!deferCleanup)t.after(cleanup);
  return {root,path,config,api,visual,cleanup};
}
const start=x=>x.api.call('runtime_swarm_start',{request_id:'auth-run',goal:'Research requested sources with website login preflight.'});

test('auth site mapping and gate detection do not mistake mention of login for an auth wall',()=>{
  assert.equal(authSite('https://www.reddit.com/r/example'),'reddit.com');assert.equal(authSite('https://x.com.evil.test'),'x.com.evil.test');assert.throws(()=>authSite('https://user:pass@x.com/'));
  assert.equal(detectAuthGate('https://example.test/article','News','The company added a login button.'),null);
  assert.equal(detectAuthGate('https://x.com/i/flow/login','X',''),'needs_login');assert.equal(detectAuthGate('https://reddit.com/','Reddit - Prove your humanity',''),'challenge');assert.equal(detectAuthGate('https://example.test','Portal','',true),'needs_login');
});

test('auth requirements persist without credentials and user retry remains unverified',async t=>{
  const x=await setup(t);requireSiteAuth(x.api.store,x.config,['https://x.com/a','https://www.reddit.com/r/a','https://x.com/b','https://x.com.evil.test/']);
  assert.equal(authSites(x.api.store,x.config).length,2);assert.equal(blockedAuthSites(x.api.store,x.config,['https://x.com/a']).length,1);
  const broker=new BrowserLoginBroker(x.api.store,x.config);assert.equal(broker.retry('x.com').state,'retry_requested');assert.equal(blockedAuthSites(x.api.store,x.config,['https://x.com/a']).length,0);
  assert.throws(()=>broker.retry('unknown.test'),/AUTH_SITE_NOT_REQUESTED/);
  const reopened=new PackStore(x.config.dbPath);try{assert.equal(authSites(reopened,x.config).find(s=>s.site==='x.com').state,'retry_requested');}finally{reopened.close();}
  setSiteAuth(x.api.store,x.config,'reddit.com','needs_login',true);assert.equal(blockedAuthSites(x.api.store,x.config,['https://example.test']).length,1);
  assert.deepEqual(Object.keys(authSites(x.api.store,x.config)[0]).sort(),['handoff','site','state','updated_at']);
});

test('runtime contract source preflight leases only unblocked URLs and projects login attention',async t=>{
  const x=await setup(t),result=await start(x);assert.equal(result.dispatches.length,4);assert.equal(x.visual.assigned.length,4);
  assert.equal(result.run.source_auth.length,2);assert.equal(result.run.workers.find(w=>w.id==='source-0').attempts,0);
  const view=readControlCenter(x.api.store,x.config);assert.equal(view.runs[0].actors.find(a=>a.id==='source-0').status,'waiting_for_auth');assert.equal(view.runs[0].actors.find(a=>a.id==='source-0').lane,'attention');
  setSiteAuth(x.api.store,x.config,'x.com','ready');const next=await x.api.call('runtime_swarm_tick',{run_id:result.run.run_id});assert.equal(next.dispatches.length,1);assert.equal(next.dispatches[0].worker_id,'source-0');
});

test('runtime contract authentication-only wait does not consume worker leases or standard deadline',async t=>{
  const x=await setup(t,{allProtected:true}),result=await start(x),run=result.run.run_id;
  assert.equal(result.dispatches.length,0);assert.ok(result.run.workers.every(w=>w.attempts===0));
  const before=x.api.swarm.status(run);const waiting=await x.api.swarm.tick(run,Date.now()+600000);assert.equal(waiting.reason,'WAITING_FOR_SITE_AUTH');assert.equal(waiting.status,'running');assert.ok(waiting.hard_deadline_at_ms>before.hard_deadline_at_ms+590000);
  setSiteAuth(x.api.store,x.config,'x.com','ready');setSiteAuth(x.api.store,x.config,'reddit.com','ready');const released=await x.api.swarm.tick(run,Date.now()+600010);assert.equal(released.dispatches.length,6);assert.equal(new Set(released.dispatches.map(item=>item.worker_id)).size,6);
});

test('runtime contract a ready observed sign-in releases the source to the normal browser lease path',async t=>{
  const x=await setup(t);requireSiteAuth(x.api.store,x.config,['https://x.com']);setSiteAuth(x.api.store,x.config,'x.com','ready');
  const result=await start(x);assert.equal(result.dispatches.some(d=>d.worker_id==='source-0'),true);const worker=x.api.swarm.status(result.run.run_id).workers.find(w=>w.id==='source-0');assert.equal(worker.status,'leased');assert.equal(worker.attempts,1);
});

test('runtime contract auth preflight remains active when no VM or persistent browser is configured',async t=>{
  const x=await setup(t,{allProtected:true,owned:false}),result=await start(x);assert.equal(result.dispatches.length,0);assert.ok(result.run.source_auth.every(item=>item.state==='unchecked'));assert.ok(result.run.workers.every(worker=>worker.attempts===0));
  const server=await startControlCenter(x.config);t.after(()=>server.close());const status=await (await fetch(server.url+'connections/status')).json();assert.equal(status.profile_preserved,false);assert.equal(status.vnc,null);assert.ok(status.sites.every(site=>site.state==='unchecked'));
});

test('runtime contract migrates legacy site-policy blocks back to ordinary sign-in discovery',async t=>{
  const x=await setup(t);setSiteAuth(x.api.store,x.config,'x.com','policy_blocked');
  requireSiteAuth(x.api.store,x.config,['https://x.com/search']);
  assert.equal(authSites(x.api.store,x.config).find(site=>site.site==='x.com').state,'unchecked');
});

test('runtime contract connections UI protects mutations with capability and same-origin human action',async t=>{
  const x=await setup(t);requireSiteAuth(x.api.store,x.config,['https://x.com']);const server=await startControlCenter(x.config);let browser;t.after(async()=>{await browser?.close();await server.close()});
  browser=await chromium.launch({headless:true});const browserPage=await koPage(browser);await browserPage.goto(server.url);const attention=browserPage.getByRole('link',{name:'사이트 로그인 1개 필요',exact:true});await attention.waitFor();assert.match(await attention.getAttribute('href'),/connections$/u);
  const page=await fetch(server.url+'connections'),body=await page.text();assert.equal(page.status,200);assert.match(body,/사이트 로그인/);assert.doesNotThrow(()=>new Script(body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));
  const url=server.url+'connections/retry/x.com';assert.equal((await fetch(url)).status,405);assert.equal((await fetch(url,{method:'POST'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{Origin:'https://evil.example','X-Agent-Driver':'human-connection'}})).status,403);
  assert.equal((await fetch(new URL('/wrong/connections/retry/x.com',server.url),{method:'POST'})).status,404);
  const response=await fetch(url,{method:'POST',headers:{Origin:new URL(server.url).origin,'X-Agent-Driver':'human-connection'}});assert.equal(response.status,200);assert.equal((await response.json()).state,'retry_requested');
  const status=await (await fetch(server.url+'connections/status')).json();assert.equal(status.sites[0].state,'retry_requested');assert.equal('automated_access' in status.sites[0],false);assert.equal((await fetch(server.url,{method:'POST'})).status,405);
});

test('owned-browser connector refuses unprovisioned VM and production fixture injection',async t=>{
  const x=await setup(t);await assert.rejects(connectOwnedBrowser(x.config));assert.throws(()=>new SwarmVisualExecutor(x.api.store,x.config,{fixture_owned_connect:async()=>null}),/FIXTURE_CONNECT_FORBIDDEN/);
});

test('runtime contract human handoff and browser lease admission are mutually fenced in SQLite',async t=>{
  const x=await setup(t),result=await start(x),profile=authProfile(x.config);
  assert.throws(()=>x.api.store.claimBrowserHandoff(x.config.project.id,profile,'x.com'),/AUTH_WAIT_FOR_ACTIVE_WORKERS/);
  const y=await setup(t,{allProtected:true}),waiting=await start(y),row=y.api.store.swarmRun(y.config.project.id,waiting.run.run_id),snapshot=row.snapshot;
  y.api.store.claimBrowserHandoff(y.config.project.id,authProfile(y.config),'x.com');
  snapshot.workers['source-0'].status='leased';snapshot.revision++;
  assert.throws(()=>y.api.store.updateSwarmRun(y.config.project.id,snapshot.run_id,snapshot.revision-1,snapshot,authProfile(y.config)),/AUTH_HANDOFF_IN_PROGRESS/);
  assert.equal(y.api.swarm.status(snapshot.run_id).workers.find(w=>w.id==='source-0').status,'pending');
});

test('saved ready observation permits a future attempt but changing the owned profile does not inherit sign-in',async t=>{
  const x=await setup(t);requireSiteAuth(x.api.store,x.config,['https://x.com']);setSiteAuth(x.api.store,x.config,'x.com','ready');
  assert.equal(blockedAuthSites(x.api.store,x.config,['https://x.com']).length,0);
  const other={...x.config,swarm:{...x.config.swarm,visual:{...x.config.swarm.visual,owned_vm:{...x.config.swarm.visual.owned_vm,id:'different-profile'}}}};
  assert.equal(blockedAuthSites(x.api.store,other,['https://x.com']).length,1);
});

async function launchPersistent(root,port){
  const child=spawn(chromium.executablePath(),['--headless=new','--no-sandbox','--disable-gpu','--no-first-run',`--remote-debugging-port=${port}`,`--user-data-dir=${root}`,'about:blank'],{stdio:'ignore'});
  for(let attempt=0;attempt<100;attempt++){if(child.exitCode!==null)throw Error('FIXTURE_BROWSER_EXIT');try{const response=await fetch(`http://127.0.0.1:${port}/json/version`);if(response.ok)return child;}catch{}await delay(100);}child.kill();throw Error('FIXTURE_BROWSER_TIMEOUT');
}
async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const closed=once(child,'exit');if(!child.kill('SIGTERM'))return;await closed;}
async function gracefulStop(child,port){const closed=once(child,'exit'),browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`),session=await browser.newBrowserCDPSession();await session.send('Browser.close').catch(()=>{});await closed;}
test('runtime native persistent profile survives worker-page cleanup and browser restart without cookie export',async t=>{
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');if(req.url==='/login-fixture')res.setHeader('Set-Cookie','fixture_session=ready; Max-Age=3600; Path=/');res.end(`<html><title>Owned profile fixture</title><body><h1>${req.url}</h1><p>${req.headers.cookie?.includes('fixture_session=ready')?'fixture signed in':'fixture anonymous'}</p></body></html>`);});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const origin=`http://127.0.0.1:${server.address().port}`,x=await setup(t,{fixtureOrigin:origin,deferCleanup:true});
  let child=null,browser=null,pool=null;
  t.after(async()=>{await pool?.close().catch(()=>{});await browser?.close().catch(()=>{});if(child)await stop(child);await x.cleanup();});
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(resolve=>reserve.close(resolve));
  child=await launchPersistent(join(x.root,'profile'),port);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);let context=browser.contexts()[0];const login=await context.newPage();await login.goto(origin+'/login-fixture');await login.reload();assert.match(await login.locator('body').innerText(),/fixture signed in/);await browser.close();
  pool=new SwarmVisualExecutor(x.api.store,x.config,{fixture_origins:[origin],fixture_owned_connect:()=>chromium.connectOverCDP(`http://127.0.0.1:${port}`)});const run=await start(x),workers=run.dispatches.slice(0,2);
  const results=await Promise.all(workers.map(w=>pool.perform(run.run.run_id,w.worker_id,w.lease_token,{action:'navigate',url:w.source_urls[0]})));assert.equal(new Set(results.map(r=>r.surface_id)).size,2);assert.ok(results.every(r=>r.text.includes('fixture signed in')));
  await pool.close();browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);assert.ok(browser.contexts()[0].pages().some(p=>p.url()===origin+'/login-fixture'));assert.ok(!browser.contexts()[0].pages().some(p=>p.url().includes('/worker-')));await browser.close();
  await gracefulStop(child,port);child=await launchPersistent(join(x.root,'profile'),port);browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);const probe=await browser.contexts()[0].newPage();await probe.goto(origin+'/read-after-restart');assert.match(await probe.locator('body').innerText(),/fixture signed in/);await browser.close();await gracefulStop(child,port);
});
