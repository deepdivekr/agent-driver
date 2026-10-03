import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {modelSettingsPath,readModelSettings,saveModelSettings,roleModelConfiguration} from '../dist/onboarding/model-settings.js';

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'role-model-ui-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),path=modelSettingsPath(config);
  saveModelSettings(path,{revision:0,onboarding_step:3,selection:{mode:'subscription',client:'codex',client_models:{codex:'selected-model',claude:null,opencode:null},api_model:'gpt-6-luna',reasoning:'low',jev:'off'}},{});
  const auth={async connections(){return [];},view(){return {};},close(){},async start(){throw Error('NO_AUTH_CALL');}},mcp={async view(){return {registered_count:1,agent_driver:{installed:true},clients:[]};}},bootstrap={view(){return {clients:[]};},async install(){throw Error('NO_INSTALL');}};
  const settings=new ControlSettings(config,auth,{},()=>{throw Error('NO_API_CALL');},mcp,undefined,bootstrap);let host;
  const server=createServer(async(req,res)=>{if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{await settings.close();server.closeAllConnections();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});return {url:'http://'+host+'/settings',path};
}

test('runtime fixture subscription role settings save exact choices, refresh catalog and hide in API mode on KO/EN desktop/mobile',{timeout:60000},async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir('tests/evidence/phase107',{recursive:true});
  for(const width of [1280,390])for(const lang of ['ko','en']){
    const f=await setup(t),context=await browser.newContext({viewport:{width,height:980},colorScheme:'dark'}),page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(value=>localStorage.setItem('office-lang',value),lang);
    const models=['selected-model','planning-model','reader-model','review-model','synthesis-model'].map(id=>({id,label:id}));let catalogs=0;
    await page.route('**/settings/models',route=>{catalogs++;return route.fulfill({json:{codex:{status:'available',models:[...models,...(catalogs>1?[{id:'fresh-catalog-model',label:'fresh-catalog-model'}]:[])]},claude:{status:'available',models:[{id:'claude-review',label:'claude-review'}]},opencode:{status:'available',models:[]}}});});
    await page.goto(f.url);await page.waitForFunction(()=>initialized&&!busy);await page.locator('[data-step="2"]').click();await page.waitForFunction(()=>!busy&&clientsLoaded);
    const panel=page.locator('#role-model-settings');assert.equal(await panel.isVisible(),false);await page.locator('#role-model-mode').selectOption('manual');assert.ok(await panel.isVisible());assert.equal(await panel.evaluate(element=>element.open),false);
    await panel.locator('summary').click();for(const [role,model] of [['planner','planning-model'],['worker','reader-model'],['verifier','review-model'],['synthesis','synthesis-model']])await page.locator('#role-'+role+'-codex').selectOption(model);
    await page.locator('#role-verifier-claude').selectOption('claude-review');await page.locator('#refresh-clients').click();await page.waitForFunction(()=>!busy);
    assert.equal(await page.locator('#role-worker-codex').inputValue(),'reader-model');assert.equal(await page.locator('#role-worker-codex option[value=fresh-catalog-model]').count(),1);
    await page.locator('#save-model').click();await page.waitForFunction(()=>!busy);assert.equal(readModelSettings(f.path).selection.role_models.worker.codex,'reader-model');assert.equal(readModelSettings(f.path).selection.role_models.verifier.claude,'claude-review');
    assert.equal(readModelSettings(f.path).selection.client_models.codex,'selected-model');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    if(lang==='en')assert.doesNotMatch(await panel.innerText(),/[가-힣]/u);
    await page.screenshot({path:`tests/evidence/phase107/role-models-${lang}-${width}.png`,fullPage:true});
    await page.locator('#mode').selectOption('api');assert.equal(await panel.isVisible(),false);await page.locator('#mode').selectOption('subscription');assert.equal(await panel.isVisible(),true);assert.equal(await page.locator('#role-worker-codex').inputValue(),'reader-model');
    await page.locator('#model-scope').selectOption('coding');await page.waitForFunction(()=>!busy&&modelScope==='coding');assert.equal(await panel.isVisible(),false);
    await page.locator('#coding-inherit').uncheck();await page.locator('#codex-model').selectOption('fresh-catalog-model');await page.locator('#save-model').click();await page.waitForFunction(()=>!busy);
    assert.equal(roleModelConfiguration(f.path,'coding',{},'worker').environment.AGENT_DRIVER_CODEX_MODEL,'fresh-catalog-model');
    await page.locator('#model-scope').selectOption('global');await page.waitForFunction(()=>!busy&&modelScope==='global');assert.equal(await page.locator('#role-worker-codex').inputValue(),'reader-model');
    assert.deepEqual(errors,[]);await context.close();
  }
});
