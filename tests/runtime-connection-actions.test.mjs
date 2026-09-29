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
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';
import {importHermesWork} from '../dist/work/hermes.js';

async function assertDisclosures(page,minimum){
  const values=await page.locator('details>summary').evaluateAll(items=>items.map(s=>({color:getComputedStyle(s).color,underline:getComputedStyle(s).textDecorationLine})));
  assert.ok(values.length>=minimum);
  const light=await page.evaluate(()=>document.documentElement.dataset.theme==='light'||!document.documentElement.dataset.theme&&matchMedia('(prefers-color-scheme:light)').matches);
  assert.ok(values.every(s=>s.color===(light?'rgb(47, 111, 174)':'rgb(111, 168, 220)')&&s.underline==='underline'),JSON.stringify(values));
}

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-actions-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),ids=['codex','claude','opencode','cursor','hermes'];
  const installed=new Set(['codex','claude','hermes']),flows=new Map(),calls=[];
  const auth={async connections(){return ids.map(id=>({id,status:installed.has(id)?['codex','claude'].includes(id)?'ready':'signed_out':'unavailable',supported_login_flows:[id==='codex'||id==='opencode'?'device':'browser'],connection:this.view(id)}));},view(id){return flows.get(id)??{client_id:id,state:'idle'};},async start(id,flow){assert.ok(installed.has(id));calls.push('login:'+id);const result={client_id:id,flow,state:'waiting',reason:'waiting_for_confirmation',credentials_exposed:false,...(id==='cursor'?{auth_url:'https://cursor.com/loginDeepControl?mode=login&redirectTarget=cli&uuid=fixture&challenge=fixture'}:{device_url:'https://auth.openai.com/codex/device',user_code:'ABCD-1234'})};flows.set(id,result);return result;},close(){}};
  const bootstrap={view(){return {clients:ids.map(id=>({id,label:({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor CLI',hermes:'Hermes'})[id],installed:installed.has(id),managed_install:true,docs_url:'https://example.test/docs'}))};},async install(id,onStage){calls.push('install:'+id);await onStage('downloading');installed.add(id);return this.view();}};
  const mcp={async view(){return {agent_driver:{installed:true},clients:ids.map(id=>({id,automatic:true,registration:'not_registered'})),registered_count:0,windows_bridge:{command:'wsl.exe',args:['--exec','node','mcp']}};}};
  const settings=new ControlSettings(config,auth,{},fetch,mcp,undefined,bootstrap);let host;const server=createServer(async(req,res)=>{if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{settings.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});});
  return {url:'http://'+host+'/settings',calls,flows,config};
}

test('runtime fixture connection actions align and automatically continue install to login on desktop and mobile',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir('tests/evidence/phase92',{recursive:true});
  for(const width of [1280,375])for(const lang of ['ko','en']){
    const f=await fixture(t),context=await browser.newContext({viewport:{width,height:980},colorScheme:'dark'}),page=await context.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));await context.addInitScript(value=>localStorage.setItem('office-lang',value),lang);
    await context.route('https://cursor.com/**',route=>route.fulfill({body:'<h1>Official login fixture</h1>',contentType:'text/html'}));
    await context.route('https://auth.openai.com/**',route=>route.fulfill({body:'<h1>Device login fixture</h1>',contentType:'text/html'}));
    await page.goto(f.url);await page.locator('[data-client=cursor] button').waitFor();
    assert.equal(await page.getByText(lang==='ko'?'공식 설치 안내':'Official install guide',{exact:true}).count(),0);
    const geometry=await page.locator('#mcp-clients .cact button').evaluateAll(buttons=>buttons.map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height,text:b.textContent};}));
    assert.ok(geometry.every(b=>b.width===geometry[0].width&&b.height===36));assert.ok(geometry.every(b=>b.text.length<=11));
    const summary=page.locator('#windows-bridge summary');await assertDisclosures(page,5);
    await summary.focus();await page.keyboard.press('Enter');assert.equal(await page.locator('#windows-bridge').evaluate(e=>e.open),true);
    for(const id of ['cursor','opencode']){
      const popupPromise=context.waitForEvent('page');await page.locator('[data-client='+id+'] button').click();const popup=await popupPromise;
      await popup.waitForURL(id==='cursor'?'https://cursor.com/**':'https://auth.openai.com/codex/device');
      assert.deepEqual(f.calls.slice(-2),['install:'+id,'login:'+id]);assert.ok(await page.locator('#agent-flow-'+id).isVisible());await popup.close();
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);
    await page.screenshot({path:'tests/evidence/phase92/connections-'+width+'-'+lang+'.png',fullPage:true});await page.locator('#theme-toggle').click();await assertDisclosures(page,5);await context.close();
  }
});

test('runtime native import entry is visibly linked and import text/actions have consistent spacing',async t=>{
  const f=await fixture(t),store=new PackStore(f.config.dbPath);store.registerProject(f.config.project);
  const work=store.beginWork(f.config.project.id,'disclosure-ui','펼치기 스타일 검증','quick').work.id;
  const hermes=importHermesWork(store,f.config.project.id,'disclosure-hermes-ui',{title:'가져온 업무 스타일 검증',goal:'업무 상세와 계획 확인',checks:['내용 확인'],steps:['자료 확인','결과 검토'],family:'portal.collect',history:[],instruction:'외부 변경 금지'});store.close();
  const server=await startControlCenter(f.config),browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close();});
  for(const width of [1280,375]){
    const page=await browser.newPage({viewport:{width,height:1000},colorScheme:'dark'});await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));await page.goto(server.url);
    const link=page.locator('#open-import');const style=await link.evaluate(e=>({color:getComputedStyle(e).color,underline:getComputedStyle(e).textDecorationLine}));assert.equal(style.underline,'underline');assert.equal(style.color,'rgb(111, 168, 220)');
    await link.click();await page.locator('#importer').waitFor({state:'visible'});
    const rowStyle=await page.locator('#import-external .row').first().evaluate(e=>({top:getComputedStyle(e).marginTop,bottom:getComputedStyle(e).marginBottom}));assert.deepEqual(rowStyle,{top:'12px',bottom:'12px'});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'tests/evidence/phase92/import-'+width+'.png',fullPage:true});
    await page.goto(server.url+'?work='+work);await page.locator('.runlist summary').first().waitFor();await assertDisclosures(page,1);
    const disclosure=page.locator('.runlist').first(),closed=await disclosure.evaluate(e=>e.open);await disclosure.locator('summary').click();assert.notEqual(await disclosure.evaluate(e=>e.open),closed);
    await page.locator('#theme-toggle').click();await assertDisclosures(page,1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    await page.goto(server.url+'?work='+hermes);await page.locator('#hermes-instruction').waitFor();await assertDisclosures(page,3);await page.locator('#theme-toggle').click();await assertDisclosures(page,3);await page.close();
  }
});
