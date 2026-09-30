import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,stat,rm,symlink} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {browserTargetSchema} from '../dist/browser/executor-contracts.js';
import {PlaywrightBrowserExecutor} from '../dist/browser/playwright-executor.js';
import {acquirePersistentProfile,hasHeadedDisplay,persistentProfilePath} from '../dist/browser/persistent-profile.js';
import {BrowserLoginBroker,authProfile,authSites,requireSiteAuth,setSiteAuth,readyAuthTargets,siteLoginTargets,migrateOwnedProfileAuthMode} from '../dist/swarm/browser-auth.js';

const target=(id='saved',extra={})=>browserTargetSchema.parse({id,engine:'playwright',environment:'owned_headless',platform:process.platform,profile_ref:'account-profile',session_mode:'persistent',...extra});
async function setup(t,{origin='http://127.0.0.1:49119',targets=[target()]}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-saved-profile-')),path=join(root,'host.json');
  const cleanup=[];let store;
  t.after(async()=>{try{for(const close of cleanup.reverse())await close();}finally{store?.close();await rm(root,{recursive:true,force:true});}});
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'saved-session',caller_ref:'fixture',account_ref:'account-a',worktree:root,data_dir:'data',environment:'fixture',fixture_url:origin+'/lab/account-a/',browser_executors:{targets}}));
  const config=loadHostConfig(path);store=new PackStore(config.dbPath);store.registerProject(config.project);
  return {root,path,config,store,target:config.browserExecutors.targets[0],cleanup};
}
function fakeLaunch(t){
  const sessions=[],calls=[];
  t.mock.method(chromium,'launchPersistentContext',async(path,options)=>{
    const state={url:'about:blank',text:'Sign in',signed:false,password:false,closed:false,pageClosed:false};
    const page={async goto(url){state.url=url;},async bringToFront(){assert.equal(state.pageClosed,false);},url(){return state.url;},async title(){return 'Fixture';},locator(selector){return {first(){return this;},async isVisible(){return selector==='input[type="password"]'?state.password:state.signed;},async innerText(){return state.text;}};},isClosed(){return state.pageClosed;},async close(){state.pageClosed=true;}};
    const context={async newPage(){state.pageClosed=false;return page;},async close(){state.closed=true;state.pageClosed=true;}};
    calls.push({path,options});sessions.push({state,page,context});return context;
  });
  return {sessions,calls};
}
function fakeDisplay(t){const previous=process.env.DISPLAY;process.env.DISPLAY=':fixture';t.after(()=>{if(previous===undefined)delete process.env.DISPLAY;else process.env.DISPLAY=previous;});}

test('runtime contract saved profile is explicit target opt-in and mode changes do not inherit authentication',async t=>{
  const x=await setup(t),isolated={...x.target,session_mode:'isolated'};
  assert.notEqual(authProfile(x.config,x.target),authProfile(x.config,isolated));
  assert.equal(browserTargetSchema.safeParse({...x.target,engine:'aside',environment:'host_foreground',executable:'/fixture/aside'}).success,false);
  assert.equal(hasHeadedDisplay({},'linux'),false);assert.equal(hasHeadedDisplay({WAYLAND_DISPLAY:'wayland-fixture'},'linux'),true);
  assert.deepEqual(siteLoginTargets({...x.config,browserExecutors:undefined}).map(row=>row.id),['playwright']);
  requireSiteAuth(x.store,x.config,['https://x.com']);setSiteAuth(x.store,x.config,'x.com','ready',false,x.target);
  assert.deepEqual(readyAuthTargets(x.store,x.config,'x.com').map(row=>row.id),['saved']);
  assert.deepEqual(readyAuthTargets(x.store,{...x.config,browserExecutors:{targets:[isolated]}},'x.com'),[]);
});

test('runtime contract mode transitions preserve restrictions and fresh verification never revives obsolete restrictions',async t=>{
  const x=await setup(t),isolated={...x.target,session_mode:'isolated'};requireSiteAuth(x.store,x.config,['https://x.com']);
  for(const state of ['login_limited','challenge','policy_blocked']){
    setSiteAuth(x.store,x.config,'x.com',state,false,x.target);setSiteAuth(x.store,x.config,'x.com','ready',false,isolated);
    migrateOwnedProfileAuthMode(x.store,x.config,x.target,isolated);assert.equal(authSites(x.store,x.config,isolated)[0].state,state);
    migrateOwnedProfileAuthMode(x.store,x.config,isolated,x.target);assert.equal(authSites(x.store,x.config,x.target)[0].state,state);
    setSiteAuth(x.store,x.config,'x.com','ready',false,x.target); // A new actual same-profile verification.
    migrateOwnedProfileAuthMode(x.store,x.config,x.target,isolated);assert.equal(authSites(x.store,x.config,isolated)[0].state,'unknown');assert.equal(authSites(x.store,x.config,x.target)[0].state,'unknown');
    migrateOwnedProfileAuthMode(x.store,x.config,isolated,x.target);assert.equal(authSites(x.store,x.config,x.target)[0].state,'unknown');
  }
  setSiteAuth(x.store,x.config,'x.com','unknown',true,x.target);
  assert.throws(()=>migrateOwnedProfileAuthMode(x.store,x.config,x.target,isolated),/AUTH_LOGIN_IN_PROGRESS/);
});

test('runtime contract mode migration retains the stronger hold and newer restrictions beat stale ready observations',async t=>{
  const x=await setup(t),isolated={...x.target,session_mode:'isolated'};
  for(const [source,destination] of [['challenge','login_limited'],['login_limited','challenge'],['policy_blocked','challenge']]){
    setSiteAuth(x.store,x.config,'x.com',source,false,x.target);setSiteAuth(x.store,x.config,'x.com',destination,false,isolated);
    migrateOwnedProfileAuthMode(x.store,x.config,x.target,isolated);
    assert.equal(authSites(x.store,x.config,isolated)[0].state,source==='policy_blocked'?'policy_blocked':'login_limited');
  }
  setSiteAuth(x.store,x.config,'x.com','ready',false,x.target);setSiteAuth(x.store,x.config,'x.com','login_limited',false,isolated);
  const entries=x.store.browserAuthEntries,sourceKey=authProfile(x.config,x.target);
  t.mock.method(x.store,'browserAuthEntries',function(project,profile){return entries.call(this,project,profile).map(row=>({...row,updated_at:profile===sourceKey?'2026-01-01T00:00:00.000Z':'2026-01-02T00:00:00.000Z'}));});
  migrateOwnedProfileAuthMode(x.store,x.config,x.target,isolated);
  assert.equal(authSites(x.store,x.config,isolated)[0].state,'login_limited');assert.equal(authSites(x.store,x.config,x.target)[0].state,'unknown');
});

test('runtime contract saved profiles bound pools, flush last release, recover launch rejection and exclude human races',async t=>{
  const x=await setup(t);fakeDisplay(t);const fake=fakeLaunch(t);
  const first=await acquirePersistentProfile(x.config,x.target,'automation'),second=await acquirePersistentProfile(x.config,x.target,'automation');
  assert.equal(first.context,second.context);assert.equal(fake.calls.length,1);
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'human'),/AUTH_WAIT_FOR_ACTIVE_WORKERS/);
  await first.release();assert.equal(fake.sessions[0].state.closed,false);await second.release();assert.equal(fake.sessions[0].state.closed,true);
  const human=await acquirePersistentProfile(x.config,x.target,'human');assert.equal(fake.calls[1].options.headless,false);
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/PACK_WAITING_AUTH/);await human.release();
  const readers=await Promise.all(Array.from({length:8},()=>acquirePersistentProfile(x.config,x.target,'automation')));
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/BROWSER_PROFILE_CAPACITY_EXCEEDED/);await Promise.all(readers.map(lease=>lease.release()));
  const launch=chromium.launchPersistentContext;chromium.launchPersistentContext=async()=>{throw Error('browserType.launchPersistentContext: Target page, context or browser has been closed\nProcessSingleton');};
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/^Error: PACK_BROWSER_PROFILE_BUSY$/);
  chromium.launchPersistentContext=launch;const recovered=await acquirePersistentProfile(x.config,x.target,'automation');await recovered.release();
  assert.equal((await stat(persistentProfilePath(x.config,x.target))).mode&0o777,0o700);
  assert.equal((await stat(join(persistentProfilePath(x.config,x.target),'.agent-office-profile.json'))).mode&0o777,0o600);
});

test('runtime contract saved profile refuses symlink escape, foreign files and mismatched ownership marker',async t=>{
  const x=await setup(t),path=persistentProfilePath(x.config,x.target),outside=join(x.root,'foreign');fakeLaunch(t);
  await mkdir(join(x.config.project.profileRef,'saved-browser-profiles'),{recursive:true});await mkdir(outside);
  await symlink(outside,join(x.config.project.profileRef,'saved-browser-profiles',x.target.id));
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/BROWSER_PROFILE_PATH_UNSAFE/);
  const other=target('foreign');await mkdir(persistentProfilePath(x.config,other),{recursive:true});await writeFile(join(persistentProfilePath(x.config,other),'Cookies'),'fixture foreign profile');
  await assert.rejects(acquirePersistentProfile(x.config,other,'automation'),/BROWSER_PROFILE_BINDING_INVALID/);
  const mismatch=target('mismatch');await mkdir(persistentProfilePath(x.config,mismatch),{recursive:true});await writeFile(join(persistentProfilePath(x.config,mismatch),'.agent-office-profile.json'),'{}');
  await assert.rejects(acquirePersistentProfile(x.config,mismatch,'automation'),/BROWSER_PROFILE_BINDING_INVALID/);
  assert.equal(await readFile(join(persistentProfilePath(x.config,other),'Cookies'),'utf8'),'fixture foreign profile');
  assert.equal(path.includes(x.target.profile_ref),true);
});

test('runtime contract prior human handoff fences reopened automation while unrelated profiles remain usable',async t=>{
  const x=await setup(t);fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);setSiteAuth(x.store,x.config,'x.com','unknown',true,x.target);
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/PACK_WAITING_AUTH/);
  const unrelated=await acquirePersistentProfile(x.config,target('unrelated'),'automation');await unrelated.release();
  const fresh=new BrowserLoginBroker(x.store,x.config);await fresh.close();assert.equal(authSites(x.store,x.config,x.target)[0].handoff,true,'Closing an unrelated broker cannot clear a persisted claim');
});

test('runtime contract saved-profile broker finish preserves unknown, flushes, and closes only its own claim',async t=>{
  const x=await setup(t);fakeDisplay(t);const fake=fakeLaunch(t),broker=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>broker.close());
  const registered=await broker.register('https://127.0.0.1/path?not_saved=fixture#fragment',x.target.id);assert.equal(registered.site,'127.0.0.1');assert.equal(registered.state,'unchecked');
  await broker.open(registered.site,x.target.id);assert.equal(fake.calls[0].options.headless,false);fake.sessions[0].state.url='https://127.0.0.1/';
  const checked=await broker.check(registered.site,x.target.id);assert.equal(checked.state,'unknown');assert.equal(checked.verified,false);
  assert.throws(()=>broker.retry(registered.site,x.target.id),/AUTH_LOGIN_IN_PROGRESS/);
  await assert.rejects(acquirePersistentProfile(x.config,x.target,'automation'),/PACK_WAITING_AUTH/);
  const finished=await broker.finish(registered.site,x.target.id);assert.equal(finished.state,'unknown');assert.equal(finished.verified,false);assert.equal(finished.handoff,false);assert.equal(fake.sessions[0].state.closed,true);
  assert.deepEqual(authSites(x.store,x.config,x.target).map(row=>row.site),['127.0.0.1']);
  assert.equal(JSON.stringify(authSites(x.store,x.config,x.target)).includes('not_saved'),false);
});

test('runtime contract saved-profile login readiness closes and flushes; manual window close permits reopen',async t=>{
  const x=await setup(t);fakeDisplay(t);const fake=fakeLaunch(t),broker=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>broker.close());requireSiteAuth(x.store,x.config,['https://x.com']);
  await broker.open('x.com',x.target.id);fake.sessions[0].state.pageClosed=true;await broker.open('x.com',x.target.id);assert.equal(fake.calls.length,2);
  fake.sessions[1].state.url='https://x.com/home';fake.sessions[1].state.signed=true;fake.sessions[1].state.text='Timeline';
  const checked=await broker.check('x.com',x.target.id);assert.equal(checked.state,'ready');assert.equal(fake.sessions[1].state.closed,true);assert.equal(authSites(x.store,x.config,x.target)[0].handoff,false);
});

test('runtime contract an explicit restricted-profile recheck restores only the same human window after restart',async t=>{
  const other=target('other'),x=await setup(t,{targets:[target(),other]});fakeDisplay(t);const fake=fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);
  setSiteAuth(x.store,x.config,'x.com','login_limited',false,x.target);const broker=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>broker.close());
  await assert.rejects(broker.open('x.com',x.target.id),/AUTH_LOGIN_LIMITED/);
  await assert.rejects(broker.recheck('x.com',other.id),/AUTH_LOGIN_LIMITED/);assert.equal(fake.calls.length,0);
  await broker.recheck('x.com',x.target.id);assert.equal(fake.calls.length,1);assert.equal(authSites(x.store,x.config,x.target)[0].state,'login_limited');assert.equal(authSites(x.store,x.config,x.target)[0].handoff,true);
  assert.throws(()=>broker.retry('x.com',x.target.id),/AUTH_LOGIN_IN_PROGRESS/);
  await broker.finish('x.com',x.target.id);assert.equal(authSites(x.store,x.config,x.target)[0].state,'login_limited');
  const restarted=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>restarted.close());await restarted.recheck('x.com',x.target.id);
  assert.equal(authSites(x.store,x.config,x.target)[0].state,'login_limited');fake.sessions[1].state.url='https://x.com/home';fake.sessions[1].state.signed=true;fake.sessions[1].state.text='Timeline';
  assert.equal((await restarted.check('x.com',x.target.id)).state,'ready');assert.equal(authSites(x.store,x.config,x.target)[0].handoff,false);
});

test('runtime contract opening and finishing without observation cannot clear an existing challenge or policy hold',async t=>{
  const x=await setup(t);fakeDisplay(t);fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);const broker=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>broker.close());
  for(const state of ['challenge','policy_blocked']){
    setSiteAuth(x.store,x.config,'x.com',state,false,x.target);await broker.open('x.com',x.target.id);assert.equal(authSites(x.store,x.config,x.target)[0].state,state);
    const result=await broker.finish('x.com',x.target.id);assert.equal(result.state,state);assert.equal(result.verified,false);assert.equal(result.handoff,false);
  }
});

test('runtime contract unrelated and ambiguous recheck observations cannot release an existing restriction',async t=>{
  const x=await setup(t);fakeDisplay(t);const fake=fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);const broker=new BrowserLoginBroker(x.store,x.config);x.cleanup.push(()=>broker.close());
  for(const state of ['login_limited','challenge','policy_blocked']){
    setSiteAuth(x.store,x.config,'x.com',state,false,x.target);
    if(state==='login_limited')await broker.recheck('x.com',x.target.id);else await broker.open('x.com',x.target.id);
    const current=fake.sessions.at(-1).state;current.url='https://unrelated.example/home';current.signed=true;current.text='Home';
    assert.equal((await broker.check('x.com',x.target.id)).state,state);
    current.url='https://x.com/i/flow/login';current.signed=false;current.password=true;
    assert.equal((await broker.check('x.com',x.target.id)).state,state);
    current.url='https://x.com/home';current.password=false;current.text='Loading';
    assert.equal((await broker.check('x.com',x.target.id)).state,state);
    current.signed=true;current.text='Timeline';assert.equal((await broker.check('x.com',x.target.id)).state,'ready');
    assert.equal(authSites(x.store,x.config,x.target)[0].handoff,false);
  }
});

test('runtime contract explicit finish recovers a stale saved-profile handoff only after exclusive ownership',async t=>{
  const x=await setup(t);fakeDisplay(t);const fake=fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);setSiteAuth(x.store,x.config,'x.com','unknown',true,x.target);
  const broker=new BrowserLoginBroker(x.store,x.config),launch=chromium.launchPersistentContext;
  chromium.launchPersistentContext=async()=>{throw Error('browserType.launchPersistentContext: Target page, context or browser has been closed\nSingletonLock');};
  await assert.rejects(broker.finish('x.com',x.target.id,{explicit_release:true}),/PACK_BROWSER_PROFILE_BUSY/);assert.equal(authSites(x.store,x.config,x.target)[0].handoff,true);
  chromium.launchPersistentContext=launch;const finished=await broker.finish('x.com',x.target.id,{explicit_release:true});assert.equal(finished.state,'unknown');assert.equal(finished.handoff,false);assert.equal(fake.sessions[0].state.closed,true);
});

test('runtime contract registration rejects credentialed and private public-site targets without browser launch',async t=>{
  const x=await setup(t);const config={...x.config,environment:'production'},broker=new BrowserLoginBroker(x.store,config),fake=fakeLaunch(t);
  for(const url of ['http://example.com','https://user:pass@example.com','https://localhost','https://10.0.0.1','https://192.168.1.1','https://example.internal','https://[::1]'])await assert.rejects(broker.register(url,x.target.id),/AUTH_(?:URL_INVALID|SITE_PUBLIC_REQUIRED)/);
  assert.equal(fake.calls.length,0);assert.equal(authSites(x.store,config,x.target).length,0);
});

test('runtime contract explicit finish releases orphaned connected and VM holds without opening or verifying a browser',async t=>{
  const aside=browserTargetSchema.parse({id:'connected',engine:'aside',environment:'host_foreground',platform:process.platform,profile_ref:'aside',executable:'/fixture/aside'});
  const vm=browserTargetSchema.parse({id:'guest',engine:'playwright',environment:'ubuntu_vm',platform:'linux',profile_ref:'guest'});
  const x=await setup(t,{targets:[aside,vm]}),fake=fakeLaunch(t),broker=new BrowserLoginBroker(x.store,x.config);requireSiteAuth(x.store,x.config,['https://x.com']);
  for(const chosen of [aside,vm]){
    setSiteAuth(x.store,x.config,'x.com','unknown',true,chosen);
    assert.equal((await broker.finish('x.com',chosen.id)).handoff,true);
    const explicit=await broker.finish('x.com',chosen.id,{explicit_release:true});assert.equal(explicit.state,'unknown');assert.equal(explicit.verified,false);assert.equal(explicit.handoff,false);
  }
  assert.equal(fake.calls.length,0);
});

test('runtime contract stale finish never clears a newly changed handoff observation',async t=>{
  const x=await setup(t);fakeDisplay(t);fakeLaunch(t);requireSiteAuth(x.store,x.config,['https://x.com']);setSiteAuth(x.store,x.config,'x.com','unknown',true,x.target);
  const launch=chromium.launchPersistentContext;chromium.launchPersistentContext=async(...args)=>{
    const context=await launch(...args),close=context.close;context.close=async()=>{await new Promise(resolve=>setTimeout(resolve,10));setSiteAuth(x.store,x.config,'x.com','challenge',true,x.target);await close();};return context;
  };
  const result=await new BrowserLoginBroker(x.store,x.config).finish('x.com',x.target.id,{explicit_release:true});assert.equal(result.state,'challenge');assert.equal(result.handoff,true);
});

test('runtime contract missing Linux display does not start a browser or claim human login',async t=>{
  if(process.platform!=='linux'){t.skip('Linux display prerequisite');return;}
  const x=await setup(t),fake=fakeLaunch(t),previous={DISPLAY:process.env.DISPLAY,WAYLAND_DISPLAY:process.env.WAYLAND_DISPLAY};
  delete process.env.DISPLAY;delete process.env.WAYLAND_DISPLAY;t.after(()=>{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  requireSiteAuth(x.store,x.config,['https://x.com']);const broker=new BrowserLoginBroker(x.store,x.config);
  await assert.rejects(broker.open('x.com',x.target.id),/AUTH_HEADED_DISPLAY_UNAVAILABLE/);assert.equal(fake.calls.length,0);assert.equal(authSites(x.store,x.config,x.target)[0].handoff,false);
});

async function fixtureServer(t){
  const server=createServer((req,res)=>{
    res.setHeader('content-type','text/html');if(req.url==='/login-fixture')res.setHeader('set-cookie','fixture_session=retained; Max-Age=3600; Path=/');
    res.end(`<html><title>Local persistence fixture</title><body><div id="state">${req.headers.cookie?.includes('fixture_session=retained')?'cookie retained':'anonymous'}</div><script>${req.url==='/login-fixture'?'localStorage.setItem("fixture_login","retained");':''}document.getElementById('state').append(' / '+(localStorage.getItem('fixture_login')||'empty'));</script></body></html>`);
  });server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>{server.closeAllConnections();server.close();});return `http://127.0.0.1:${server.address().port}`;
}

test('runtime native owned saved profile retains fixture cookie and local storage after headed close and new headless process',{timeout:45000},async t=>{
  if(!hasHeadedDisplay()){t.skip('Headed display unavailable; PC reboot and live website login are not tested');return;}
  const origin=await fixtureServer(t),x=await setup(t,{origin}),lease=await acquirePersistentProfile(x.config,x.target,'human');x.cleanup.push(()=>lease.release());
  const page=await lease.context.newPage();await page.goto(origin+'/login-fixture');assert.match(await page.locator('body').innerText(),/retained/);await lease.release();
  const module=new URL('../dist/browser/playwright-executor.js',import.meta.url).href;
  const child=spawn(process.execPath,['--input-type=module','-e',`import {PlaywrightBrowserExecutor} from ${JSON.stringify(module)};const port=new PlaywrightBrowserExecutor(${JSON.stringify(x.target)},${JSON.stringify(x.config)},'another-work-key',true);try{await port.open(${JSON.stringify(origin+'/read-after-restart')});const read=await port.observe();console.log(JSON.stringify({text:read.text}));}finally{await port.close();}`],{stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
  let output='',error='';child.stdout.on('data',part=>{output+=part;});child.stderr.on('data',part=>{error+=part;});const [code]=await once(child,'exit');assert.equal(code,0,error);assert.match(JSON.parse(output.trim()).text,/cookie retained \/ retained/);
  const isolated=new PlaywrightBrowserExecutor({...x.target,session_mode:'isolated'},x.config,'another-work-key',true);x.cleanup.push(()=>isolated.close());await isolated.open(origin+'/read-isolated');assert.match((await isolated.observe()).text,/anonymous \/ empty/);await isolated.close();
  assert.ok((await stat(persistentProfilePath(x.config,x.target))).isDirectory(),'Disabling persistence never deletes the saved profile');
});

test('runtime native saved-profile parallel readers share login without closing another reader and last close retains it',{timeout:30000},async t=>{
  const origin=await fixtureServer(t),x=await setup(t,{origin});
  const a=new PlaywrightBrowserExecutor(x.target,x.config,'work-a',true),b=new PlaywrightBrowserExecutor(x.target,x.config,'work-b',true);x.cleanup.push(()=>a.close(),()=>b.close());
  await a.open(origin+'/login-fixture');await b.open(origin+'/read-b');assert.match((await b.observe()).text,/cookie retained \/ retained/);await a.close();assert.match((await b.observe()).text,/cookie retained \/ retained/);await b.close();
  const reopened=new PlaywrightBrowserExecutor(x.target,x.config,'source-c',false);x.cleanup.push(()=>reopened.close());await reopened.open(origin+'/read-c');assert.match((await reopened.observe()).text,/cookie retained \/ retained/);
});
