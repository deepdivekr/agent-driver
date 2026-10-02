import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {BrowserSetupController} from '../dist/onboarding/browser-setup.js';
import {ControlSettings} from '../dist/observability/control-settings.js';

async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'office-setup-state-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),state={installed:false,reachable:false,probes:0};
 const browsers=new BrowserSetupController(config,{detectAside:async()=>state.installed?'/tmp/aside':null,probe:async target=>{state.probes++;if(target.engine!=='playwright'&&!state.reachable)throw Error('private-profile-token');}});
 const auth={async connections(){return [];},view(){return {state:'idle'};},close(){}},mcp={async view(){return {registered_count:1,agent_driver:{installed:true},clients:[]};}},bootstrap={view(){return {clients:[]};}};
 const settings=new ControlSettings(config,auth,{},fetch,mcp,undefined,bootstrap,browsers);let host;
 const server=createServer(async(req,res)=>{if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{await settings.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});return {root,paths,state,url:'http://'+host+'/settings',browsers};
}
const ready=page=>page.waitForFunction(()=>!document.getElementById('browser-setup-refresh')?.disabled);
test('runtime fixture browser actions guide unknown, missing CLI, disconnected, permission and connected states in both languages and screen sizes',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir('tests/evidence/phase95',{recursive:true});
 for(const width of [1280,375])for(const lang of ['ko','en'])for(const theme of ['dark','light']){
  const f=await fixture(t),before=await readFile(f.paths.runtimeConfig,'utf8'),context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
  await context.addInitScript(({lang,theme})=>{localStorage.setItem('office-lang',lang);localStorage.setItem('office-theme',theme);},{lang,theme});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(f.url);await ready(page);await page.locator('#browser-alternatives>summary').click();const card=page.locator('[data-browser=aside]');
  assert.equal(await card.getAttribute('data-setup-state'),'unchecked');assert.equal(f.state.probes,0);
  assert.equal(await card.locator('.cact .action-link').count(),0,'Do not show Download before installation is checked');
  await card.locator('.cact button').click();await ready(page);assert.equal(await card.getAttribute('data-setup-state'),'missing_cli');
  assert.equal(await card.locator('.cact .action-link').count(),1);assert.match(await card.locator('.browser-feedback').textContent(),/CLI/u);
  assert.doesNotMatch(await card.textContent(),/uninstalled|설치되지 않았/u,'A missing CLI does not prove that the GUI app is absent');
  f.state.installed=true;await card.locator('.cact button').click();await ready(page);assert.equal(await card.getAttribute('data-setup-state'),'disconnected');
  assert.equal(await card.locator('.cact .action-link').count(),0,'Installed CLI needs connection, not another download');
  assert.equal(await card.locator('.cact button').textContent(),lang==='ko'?'연결':'Connect');assert.doesNotMatch(await card.textContent(),/private-profile-token/u);
  f.state.reachable=true;await card.locator('.cact button').click();await ready(page);assert.equal(await card.getAttribute('data-setup-state'),'permission');
  assert.equal(await card.locator('.cact button').count(),1);assert.equal(await card.locator('.cact .action-link').count(),0);
  assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),before,'A successful probe must not register or grant access');
  await page.screenshot({path:'tests/evidence/phase95/permission-'+width+'-'+lang+'-'+theme+'.png',fullPage:true});
  // Two immediate gestures cannot duplicate registration: the first locks actions synchronously.
  await card.locator('.cact button').evaluate(button=>{button.click();button.click();});await ready(page);
  assert.equal(await card.getAttribute('data-setup-state'),'connected');assert.ok(await card.locator('.cact button').isDisabled());
  assert.equal(await card.locator('.cact button').textContent(),lang==='ko'?'연결됨':'Connected');
  assert.equal((await readdir(f.root)).filter(name=>name.endsWith('.backup.json')).length,1);
  const saved=await readFile(f.paths.runtimeConfig,'utf8'),probes=f.state.probes;
  await page.locator('#browser-setup-refresh').click();await ready(page);assert.ok(await card.locator('.cact button').isDisabled(),'Global control unlock must not re-enable a completed action');
  assert.equal(f.state.probes,probes);assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),saved);assert.deepEqual(errors,[]);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:'tests/evidence/phase95/connected-'+width+'-'+lang+'-'+theme+'.png',fullPage:true});await context.close();
 }
});

test('runtime fixture stale browser revision is explained beside the action and requires a new check without overwriting settings',async t=>{
 const f=await fixture(t);f.state.installed=true;f.state.reachable=true;
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
 await page.goto(f.url);await ready(page);await page.locator('#browser-alternatives>summary').click();const card=page.locator('[data-browser=aside]');await card.locator('.cact button').click();await ready(page);
 const changed=(await readFile(f.paths.runtimeConfig,'utf8'))+'\n';await writeFile(f.paths.runtimeConfig,changed);await card.locator('.cact button').click();await ready(page);
 assert.equal(await card.getAttribute('data-setup-state'),'unchecked');assert.match(await card.locator('.browser-feedback').textContent(),/설정이 변경됐어요/u);assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),changed);
 await card.locator('.cact button').click();await ready(page);assert.equal(await card.getAttribute('data-setup-state'),'permission');
});

test('runtime contract an expired successful browser check cannot authorize registration',async t=>{
 const f=await fixture(t);f.state.installed=true;f.state.reachable=true;const state=await f.browsers.check('aside'),before=await readFile(f.paths.runtimeConfig,'utf8'),at=Date.now();
 const clock=t.mock.method(Date,'now',()=>at+300001);
 assert.throws(()=>f.browsers.register('aside',state.revision,true),/CHECK_REQUIRED/u);assert.equal(f.browsers.view().rows.find(row=>row.engine==='aside').health,'unchecked');
 assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),before);clock.mock.restore();
});
