import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,readdir,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {BrowserSetupController} from '../dist/onboarding/browser-setup.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {eligibleBrowserTargets,RoutedBrowser} from '../dist/browser/executor-routing.js';

async function setup(t,dependencies={}){const root=await mkdtemp(join(tmpdir(),'browser-setup-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);return {root,paths,config,browsers:new BrowserSetupController(config,dependencies)};}
const auth={async connections(){return [];},view(){return {state:'idle'};},close(){}};
const mcp={async view(){return {registered_count:1,agent_driver:{installed:true},clients:[]};}};
const bootstrap={view(){return {clients:[]};}};
async function serverFor(t,x){const settings=new ControlSettings(x.config,auth,{},fetch,mcp,undefined,bootstrap,x.browsers);let host;const server=createServer(async(req,res)=>{try{if(!await settings.handle(req,res,req.url.slice('/test/'.length),host)){res.writeHead(404);res.end();}}catch{res.writeHead(500);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));host='127.0.0.1:'+server.address().port;t.after(async()=>{settings.close();await new Promise(r=>server.close(r));});return {url:'http://'+host+'/test/settings',headers:{origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'}};}

test('runtime contract browser setup missing and disconnected Aside never blocks default Playwright or launches from GET',async t=>{
  let detects=0,probes=0;const x=await setup(t,{detectAside:async()=>{detects++;return null;},probe:async()=>{probes++;}});
  const initial=await readFile(x.paths.runtimeConfig,'utf8');assert.equal(x.browsers.view().rows[1].health,'unchecked');assert.equal(detects,0);assert.equal(probes,0);
  const missing=await x.browsers.check('aside');assert.equal(missing.rows[1].health,'unavailable');assert.equal(probes,0);assert.equal(await readFile(x.paths.runtimeConfig,'utf8'),initial);
  assert.equal(eligibleBrowserTargets(x.config)[0].engine,'playwright');
  const disconnected=new BrowserSetupController(x.config,{detectAside:async()=>'/tmp/aside',probe:async()=>{throw Error('account-secret-token');}}),result=await disconnected.check('aside');assert.equal(result.rows[1].health,'unavailable');assert.doesNotMatch(JSON.stringify(result),/secret-token/);assert.throws(()=>disconnected.register('aside',result.revision,true),/CHECK_REQUIRED/);
});

test('runtime contract browser registration requires fresh check consent and revision, preserves policy and backup',async t=>{
  const x=await setup(t,{detectAside:async()=>'/tmp/aside',probe:async()=>{}});const raw=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));raw.work={model_data_approved:false};raw.recovery_policy='prepare_only';await writeFile(x.paths.runtimeConfig,JSON.stringify(raw));
  const current=await x.browsers.check('aside');assert.equal(current.rows[1].health,'ready');assert.equal(current.rows[1].verified_for_environment,false);
  assert.throws(()=>x.browsers.register('aside',current.revision,false),/CONSENT_REQUIRED/);assert.throws(()=>x.browsers.register('aside','stale',true),/CONFLICT/);
  const saved=x.browsers.register('aside',current.revision,true);assert.equal(saved.restart_required,true);const next=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));assert.deepEqual({...next,browser_executors:undefined},{...raw,browser_executors:undefined});assert.deepEqual(next.browser_executors.targets.map(t=>t.engine),['playwright','aside']);
  const backups=(await readdir(x.root)).filter(name=>name.endsWith('.backup.json'));assert.equal(backups.length,1);assert.deepEqual(JSON.parse(await readFile(join(x.root,backups[0]),'utf8')),raw);
  x.browsers.register('aside',saved.revision,true);assert.equal((await readdir(x.root)).filter(name=>name.endsWith('.backup.json')).length,1);
  const loaded=loadHostConfig(x.paths.runtimeConfig);assert.equal(eligibleBrowserTargets(loaded)[0].engine,'playwright');assert.equal(eligibleBrowserTargets(loaded,{environment:'host_foreground'})[0].engine,'aside');assert.equal(eligibleBrowserTargets(loaded,{environment:'windows_vm'}).length,0);
  assert.notEqual(loaded.fingerprint,x.config.fingerprint);assert.equal(eligibleBrowserTargets(x.config,{environment:'host_foreground'}).length,0);
});

test('runtime contract optional browser registration retains explicit VM targets and adds default headless once',async t=>{
  const x=await setup(t);const raw=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));raw.browser_executors={targets:[{id:'vm-pw',engine:'playwright',environment:'ubuntu_vm',platform:'linux',profile_ref:'guest',priority:50}]};await writeFile(x.paths.runtimeConfig,JSON.stringify(raw));
  const controller=new BrowserSetupController(loadHostConfig(x.paths.runtimeConfig),{probe:async()=>{}}),state=await controller.check('neo');controller.register('neo',state.revision,true);
  const targets=loadHostConfig(x.paths.runtimeConfig).browserExecutors.targets;assert.deepEqual(targets[0],raw.browser_executors.targets[0]);assert.equal(targets.filter(t=>t.environment==='owned_headless').length,1);assert.equal(targets.filter(t=>t.engine==='neo').length,1);
});

test('runtime native browser setup rejects symlink config and registration cannot overwrite external edits',async t=>{
  const x=await setup(t,{probe:async()=>{}}),state=await x.browsers.check('neo');await writeFile(x.paths.runtimeConfig,(await readFile(x.paths.runtimeConfig,'utf8'))+'\n');assert.throws(()=>x.browsers.register('neo',state.revision,true),/CONFLICT/);
  const link=join(x.root,'link.json');await symlink(x.paths.runtimeConfig,link);const unsafe=new BrowserSetupController({...x.config,path:link});assert.throws(()=>unsafe.view(),/UNSAFE_CONFIG/);
});

test('runtime contract browser preparation executes only bundled Chromium installer and propagates failure',async t=>{
  const calls=[];const x=await setup(t,{runner:{async run(request){calls.push(request);return {code:0,stdout:'',stderr:''};}},probe:async()=>{}});const result=await x.browsers.installPlaywright();assert.equal(result.rows[0].health,'ready');assert.equal(calls.length,1);assert.equal(calls[0].executable,process.execPath);assert.match(calls[0].args[0],/playwright.*cli/u);assert.deepEqual(calls[0].args.slice(1),['install','chromium']);
  const failed=new BrowserSetupController(x.config,{runner:{async run(){return {code:1,stdout:'',stderr:'secret'};}}});await assert.rejects(failed.installPlaywright(),/INSTALL_FAILED/);
});

test('runtime native browser setup HTTP refuses foreign origin and unknown actions without writing',async t=>{
  const x=await setup(t,{probe:async()=>{}}),s=await serverFor(t,x);const get=await(await fetch(s.url+'/browsers')).json();assert.equal(get.rows[2].health,'unchecked');
  assert.equal((await fetch(s.url+'/browsers/check',{method:'POST',headers:{...s.headers,origin:'https://evil.invalid'},body:'{"engine":"neo"}'})).status,403);
  assert.equal((await fetch(s.url+'/browsers/install',{method:'POST',headers:s.headers,body:'{"engine":"aside"}'})).status,400);
  assert.equal((await fetch(s.url+'/browsers/register',{method:'POST',headers:s.headers,body:JSON.stringify({engine:'neo',consent:true,revision:get.revision})})).status,400);
  const checked=await(await fetch(s.url+'/browsers/check',{method:'POST',headers:s.headers,body:'{"engine":"neo"}'})).json();assert.equal(checked.rows[2].health,'ready');
  assert.equal((await fetch(s.url+'/browsers/register',{method:'POST',headers:s.headers,body:JSON.stringify({engine:'neo',consent:true,revision:checked.revision})})).status,200);
});

test('runtime fixture browser setup desktop/mobile buttons check download consent register and truthful tail',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir('tests/evidence/phase88',{recursive:true});
  for(const width of [1440,390]){
    let installed=false,probes=0,installs=0;const x=await setup(t,{detectAside:async()=>'/tmp/aside',probe:async target=>{probes++;if(target.engine==='playwright'&&!installed)throw Error('missing');},runner:{async run(){installs++;installed=true;return {code:0,stdout:'',stderr:''};}}}),s=await serverFor(t,x);
    const page=await browser.newPage({viewport:{width,height:980}});const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));await page.goto(s.url);
    await page.getByRole('heading',{name:'로컬 실행',exact:true}).waitFor();await page.locator('[data-browser=playwright]').waitFor();assert.equal(probes,0);
    await page.getByRole('button',{name:'Playwright 연결 확인',exact:true}).click();await page.getByRole('button',{name:'전용 브라우저 다운로드',exact:true}).waitFor();await page.getByRole('button',{name:'전용 브라우저 다운로드',exact:true}).click();await page.locator('[data-browser=playwright] .badge').filter({hasText:'준비됨'}).waitFor();assert.equal(installs,1);
    await page.getByText('다른 브라우저 연결 · 선택',{exact:true}).click();await page.getByRole('button',{name:'Aside 연결 확인',exact:true}).click();await page.getByRole('button',{name:'Aside 연결 등록',exact:true}).waitFor();
    assert.match(await page.locator('[data-browser=aside] .browser-feedback').textContent(),/화면·프로필 사용을 허용/u);
    assert.equal(JSON.parse(await readFile(x.paths.runtimeConfig,'utf8')).browser_executors,undefined,'Checking is not authorization');
    await page.getByRole('button',{name:'Aside 연결 등록',exact:true}).click();await page.locator('#browser-setup-notice').filter({hasText:'MCP를 다시 연결'}).waitFor();assert.equal(await page.getByRole('button',{name:'Aside 연결 등록',exact:true}).count(),0);
    assert.ok(await page.getByRole('button',{name:'Aside 연결됨',exact:true}).isDisabled());
    await page.locator('.terminal summary').click();assert.match(await page.locator('#setup-log').textContent(),/Aside 실행기 등록 완료/u);assert.match(await page.locator('#setup-log').textContent(),/Playwright 연결 확인 필요/u);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.screenshot({path:'tests/evidence/phase88/browser-setup-'+width+'.png',fullPage:true});await page.close();
  }
});

test('runtime native default browser reads owned fixture without optional browsers installed or registered',async t=>{
  const x=await setup(t);const server=createServer((_req,res)=>res.end('<html><title>Owned setup check</title><main>ready</main></html>'));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));const origin='http://127.0.0.1:'+server.address().port;
  const route=new RoutedBrowser({...x.config,environment:'fixture'},{profile_key:'phase88',context_id:'phase88',ephemeral:true},[origin]);t.after(()=>route.close());await route.open(origin);assert.equal(route.target.engine,'playwright');assert.equal(route.target.environment,'owned_headless');
});

test('runtime native browser setup launches and closes dedicated Chromium for readiness without registering optional engines',async t=>{
  const x=await setup(t),before=await readFile(x.paths.runtimeConfig,'utf8');const result=await x.browsers.check('playwright');assert.equal(result.rows[0].health,'ready');assert.equal(result.rows[0].verified_for_environment,false);assert.equal(await readFile(x.paths.runtimeConfig,'utf8'),before);
});
