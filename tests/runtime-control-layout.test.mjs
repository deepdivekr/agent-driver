import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,mkdir,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {BrowserSetupController} from '../dist/onboarding/browser-setup.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';

const evidence='tests/evidence/phase94';
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-layout-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);
  const ids=['codex','claude','opencode','cursor','hermes'],registered=new Set(),calls=[];
  const auth={async connections(){return ids.map(id=>({id,status:['codex','claude'].includes(id)?'ready':'signed_out',supported_login_flows:['browser'],connection:{client_id:id,state:'idle'}}));},view(id){return {client_id:id,state:'idle'};},async start(){throw Error('No live sign-in in a layout fixture');},close(){}};
  const bootstrap={view(){return {clients:ids.map(id=>({id,label:({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor CLI',hermes:'Hermes'})[id],installed:true,managed_install:true}))};}};
  const mcp={async view(){return {agent_driver:{installed:true},clients:ids.map(id=>({id,automatic:true,registration:registered.has(id)?'registered':'not_registered'})),registered_count:registered.size,windows_bridge:{command:'wsl.exe',args:['--exec','node','mcp']}};},async register(id){calls.push('register:'+id);registered.add(id);return this.view();}};
  const browsers=new BrowserSetupController(config,{detectAside:async()=>'/tmp/layout-fixture/aside',probe:async target=>{calls.push('browser:'+target.engine);}});
  const settings=new ControlSettings(config,auth,{},fetch,mcp,undefined,bootstrap,browsers);let host;
  const server=createServer(async(req,res)=>{
    if(req.url==='/settings/models'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify(Object.fromEntries(['codex','claude','opencode'].map(id=>[id,{status:'available',models:[{id:'fixture-model',label:'Fixture model'}]}]))));return;}
    if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{settings.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {url:'http://'+host+'/settings',config,paths,calls};
}

async function compactButtons(locator){
  const values=await locator.evaluateAll(items=>items.filter(b=>b.checkVisibility()).map(button=>{
    const range=document.createRange();range.selectNodeContents(button);const rect=button.getBoundingClientRect(),style=getComputedStyle(button);
    return {text:button.textContent.trim(),width:rect.width,height:rect.height,extra:rect.width-range.getBoundingClientRect().width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth),align:style.textAlign};
  }));
  assert.ok(values.length>0,'No visible buttons: '+locator.toString());
  assert.ok(values.every(b=>b.height>=36&&b.align==='center'),JSON.stringify(values));
  assert.ok(values.every(b=>Math.abs(b.extra)<2),JSON.stringify(values));
  return values;
}
async function alignedRows(page,selector,{equalHeight=false}={}){
  const values=await page.locator(selector).evaluateAll(rows=>rows.map(row=>{
    const name=row.querySelector('.cname')||row.querySelector('strong'),badge=row.querySelector('.badge'),actions=row.querySelector('.cact');
    const rect=node=>{const r=node.getBoundingClientRect();return {center:r.x+r.width/2,y:r.y+r.height/2,right:r.right,height:r.height};};
    return {name:rect(name),badge:rect(badge),actions:rect(actions),row:rect(row),nameAlign:getComputedStyle(name).textAlign};
  }));
  assert.ok(values.length>0,'No connection rows: '+selector);
  for(const value of values){
    assert.ok(Math.abs(value.name.center-values[0].name.center)<1,JSON.stringify(values));
    assert.ok(Math.abs(value.badge.center-values[0].badge.center)<1,JSON.stringify(values));
    assert.ok(Math.abs(value.actions.right-values[0].actions.right)<1,JSON.stringify(values));
    assert.equal(value.nameAlign,'center');
    assert.ok(Math.abs(value.name.y-value.badge.y)<1,JSON.stringify(values));
    if(equalHeight)assert.ok(Math.abs(value.row.height-values[0].row.height)<1,JSON.stringify(values));
  }
  return values;
}
async function rightEdge(page,actions,container){
  const value=await page.evaluate(({actions,container})=>{
    const buttons=[...document.querySelectorAll(actions)].filter(e=>e.checkVisibility());
    const last=buttons.at(-1),parent=document.querySelector(container),rect=parent.getBoundingClientRect(),style=getComputedStyle(parent);
    return {count:buttons.length,last:last?.getBoundingClientRect().right,edge:rect.right-parseFloat(style.paddingRight)-parseFloat(style.borderRightWidth)};
  },{actions,container});
  assert.ok(value.count>0);assert.ok(Math.abs(value.last-value.edge)<1,JSON.stringify(value));
}
async function noOverflow(page){assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'The document must not scroll horizontally');}
async function settled(page,id){await page.waitForFunction(id=>{const button=document.getElementById(id);return button&&!button.disabled;},id,{timeout:8000});}

test('runtime fixture Control Center alignment and compact right actions hold in sixteen localized theme and viewport combinations',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir(evidence,{recursive:true});
  const f=await fixture(t),before=await readFile(f.paths.runtimeConfig,'utf8'),records=[];
  for(const width of [1280,768,375,320])for(const lang of ['ko','en'])for(const theme of ['dark','light']){
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
    await context.addInitScript(({lang,theme})=>{localStorage.setItem('office-lang',lang);localStorage.setItem('office-theme',theme);},{lang,theme});
    page.on('pageerror',error=>errors.push(error.message));await page.goto(f.url);await page.locator('#mcp-clients [data-client=codex] button').waitFor();
    await settled(page,'refresh-mcp');
    await page.waitForFunction(lang=>document.documentElement.lang===lang,lang);
    const agents=await alignedRows(page,'#mcp-clients .client'),buttons=await compactButtons(page.locator('#mcp-clients .cact button'));
    assert.ok(buttons.filter(b=>b.text===(lang==='ko'?'연결':'Connect')).length===5);
    assert.equal(await page.getByText(lang==='ko'?'MCP 연결':'Connect MCP',{exact:true}).count(),0);
    await rightEdge(page,'#refresh-mcp,#mcp-next','#step-0');await noOverflow(page);
    if(width===1280)await page.screenshot({path:join(evidence,`agents-${width}-${lang}-${theme}.png`),fullPage:true});
    await page.locator('[data-step="1"]').click();await page.locator('[data-browser=playwright]').waitFor();
    await page.locator('#browser-setup details>summary').focus();await page.keyboard.press('Enter');
    await page.getByRole('button',{name:lang==='ko'?'Aside 연결 확인':'Check Aside connection',exact:true}).click();
    await page.locator('[data-browser=aside] .badge.ok').waitFor();
    // A cached ready badge is not evidence that this new check finished rerendering the rows.
    await settled(page,'browser-setup-refresh');
    const optional=await alignedRows(page,'.browser-list .client');
    await compactButtons(page.locator('.browser-list .cact button,.browser-list .cact .action-link'));
    await rightEdge(page,'[data-browser=playwright] .cact button','[data-browser=playwright]');
    await rightEdge(page,'#browser-setup-refresh','#browser-setup');await rightEdge(page,'#step-1>.actions button','#step-1');await noOverflow(page);
    if([1280,375].includes(width))await page.screenshot({path:join(evidence,`browsers-${width}-${lang}-${theme}.png`),fullPage:true});
    await page.locator('[data-step="2"]').click();await page.locator('#client-hermes').waitFor();await settled(page,'refresh-clients');
    const ai=await alignedRows(page,'#clients .client',{equalHeight:true});await compactButtons(page.locator('#clients .cact button'));
    await rightEdge(page,'#refresh-clients','#subscription-fields');await rightEdge(page,'#step-2>.actions button','#step-2');await noOverflow(page);
    const models=await page.locator('#codex-model,#claude-model,#opencode-model').evaluateAll(items=>items.map(e=>e.getBoundingClientRect().width));
    assert.ok(models.every(w=>Math.abs(w-models[0])<1),JSON.stringify(models));
    assert.equal(await page.locator('.terminal pre').evaluate(e=>getComputedStyle(e).textAlign),'start');
    assert.deepEqual(errors,[]);
    if([1280,375].includes(width))await page.screenshot({path:join(evidence,`ai-${width}-${lang}-${theme}.png`),fullPage:true});
    records.push({width,lang,theme,agents,optional,ai,buttons});await context.close();
  }
  assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),before);
  assert.ok(f.calls.every(call=>call==='browser:aside'),'Layout checks must not invoke models, change registration or start sign-in');
  await writeFile(join(evidence,'layout-matrix.json'),JSON.stringify({evidence_level:'fixture_integration',status:'PASS',records},null,2)+'\n');
});

test('runtime native Work import and detail retain compact right actions, readable prose and pause/resume interaction',async t=>{
  const f=await fixture(t),store=new PackStore(f.config.dbPath);store.registerProject(f.config.project);
  const work=store.beginWork(f.config.project.id,'layout-work','화면 정렬 검증 업무','quick').work.id;
  // Intake is initially defining and correctly cannot pause yet. Exercise an actual pausable state without calling a model.
  const owner=store.claimWorkDefinition(f.config.project.id,work);assert.ok(owner);
  store.failWorkDefinition(f.config.project.id,work,owner);store.close();
  const server=await startControlCenter(f.config),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();});
  for(const width of [1280,375])for(const lang of ['ko','en']){
    const context=await browser.newContext({viewport:{width,height:1000},colorScheme:'dark'}),page=await context.newPage(),errors=[];page.setDefaultTimeout(8000);
    await context.addInitScript(lang=>localStorage.setItem('office-lang',lang),lang);page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url);await page.locator('#open-import').click();await page.locator('#importer').waitFor({state:'visible'});
    await compactButtons(page.locator('#import-external .action-grid button'));await rightEdge(page,'#copy-migration-prompt','#import-external');await rightEdge(page,'#paste-import','#import-external');await noOverflow(page);
    await page.locator('[data-import-route=workflow]').click();await compactButtons(page.locator('#scan-import'));await rightEdge(page,'#scan-import','#import-project');
    await page.locator('[data-import-route=hermes]').click();await rightEdge(page,'#migration-discover','#import-hermes');
    await page.locator('[data-import-route=remote]').click();await rightEdge(page,'#remote-discover','#import-remote');await noOverflow(page);
    await page.goto(server.url+'?work='+work);await page.locator('.control-panel').waitFor();await page.locator('#pause').click();
    await page.waitForFunction(()=>document.querySelector('#pause')?.textContent.includes('재개')||document.querySelector('#pause')?.textContent.includes('Resume'));
    await page.locator('#pause').click();await page.waitForFunction(()=>document.querySelector('#pause')?.textContent.includes('일시정지')||document.querySelector('#pause')?.textContent.includes('Pause'));
    await compactButtons(page.locator('.controls button'));await rightEdge(page,'.controls button','.controls');
    assert.ok(['start','left'].includes(await page.locator('.control-note').first().evaluate(e=>getComputedStyle(e).textAlign)));await noOverflow(page);
    await page.screenshot({path:join(evidence,`work-${width}-${lang}.png`),fullPage:true});assert.deepEqual(errors,[]);await context.close();
  }
});
