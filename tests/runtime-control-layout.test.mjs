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
import {modelSettingsPath,publicModelSettings,readModelSettings,saveModelSettings} from '../dist/onboarding/model-settings.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';

const evidence='tests/evidence/phase94';
async function fixture(t,{savedCodexModel,savedCodexEffort,catalogModels=[{id:'fixture-model',label:'Fixture model'}]}={}){
  const root=await mkdtemp(join(tmpdir(),'office-layout-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);
  if(savedCodexModel){
    const selection=publicModelSettings(null,{}).selection;
    saveModelSettings(modelSettingsPath(config),{revision:0,onboarding_step:0,selection:{...selection,client_models:{...selection.client_models,codex:savedCodexModel},codex_reasoning_effort:savedCodexEffort}},{});
  }
  const ids=['codex','claude','opencode','cursor','hermes'],registered=new Set(),calls=[],statusOverrides=new Map();
  const auth={async connections(){return ids.map(id=>({id,status:statusOverrides.get(id)??(['codex','claude'].includes(id)?'ready':'signed_out'),supported_login_flows:['browser'],connection:{client_id:id,state:'idle'}}));},view(id){return {client_id:id,state:'idle'};},async start(){throw Error('No live sign-in in a layout fixture');},close(){}};
  const bootstrap={view(){return {clients:ids.map(id=>({id,label:({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor CLI',hermes:'Hermes'})[id],installed:true,managed_install:true}))};}};
  const mcp={async view(){return {agent_driver:{installed:true},clients:ids.map(id=>({id,automatic:true,registration:registered.has(id)?'registered':'not_registered'})),registered_count:registered.size,windows_bridge:{command:'wsl.exe',args:['--exec','node','mcp']}};},async register(id){calls.push('register:'+id);registered.add(id);return this.view();}};
  const browsers=new BrowserSetupController(config,{detectAside:async()=>'/tmp/layout-fixture/aside',probe:async target=>{calls.push('browser:'+target.engine);}});
  const providerFetch=async()=>new Response(JSON.stringify({data:[{id:'fixture-model'}]}),{status:200,headers:{'content-type':'application/json'}});
  const settings=new ControlSettings(config,auth,{HOME:root},providerFetch,mcp,undefined,bootstrap,browsers);let host;
  const server=createServer(async(req,res)=>{
    if(req.url==='/settings/models'&&req.method==='GET'){res.setHeader('content-type','application/json');res.end(JSON.stringify(Object.fromEntries(['codex','claude','opencode'].map(id=>[id,{status:'available',models:id==='codex'?catalogModels:[{id:'fixture-model',label:'Fixture model'}]}]))));return;}
    if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{await settings.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  return {url:'http://'+host+'/settings',config,paths,calls,statusOverrides,registered};
}

async function compactButtons(locator){
  // The live stream can replace a resolved node; wait for the current controls
  // rather than treating a render boundary as missing product actions.
  await locator.first().waitFor({state:'visible'});
  let values=[];
  for(let attempt=0;attempt<3&&!values.length;attempt++){
  await locator.first().waitFor({state:'visible'});
  values=await locator.evaluateAll(items=>items.filter(b=>b.checkVisibility()).map(button=>{
    const range=document.createRange();range.selectNodeContents(button);const rect=button.getBoundingClientRect(),style=getComputedStyle(button);
    return {text:button.textContent.trim(),width:rect.width,height:rect.height,extra:rect.width-range.getBoundingClientRect().width-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)-parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth),align:style.textAlign};
  }));
  }
  assert.ok(values.length>0,'No visible buttons: '+locator.toString());
  assert.ok(values.every(b=>b.height>=36&&b.align==='center'),JSON.stringify(values));
  assert.ok(values.every(b=>Math.abs(b.extra)<2),JSON.stringify(values));
  return values;
}
async function alignedRows(page,selector,{equalHeight=false,leftNames=false}={}){
  const values=await page.locator(selector).evaluateAll(rows=>rows.map(row=>{
    const name=row.querySelector('.cname')||row.querySelector('strong'),badge=row.querySelector('.badge'),actions=row.querySelector('.cact');
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,center:r.x+r.width/2,y:r.y+r.height/2,right:r.right,height:r.height};};
    return {name:rect(name),badge:rect(badge),actions:rect(actions),row:rect(row),nameAlign:getComputedStyle(name).textAlign};
  }));
  assert.ok(values.length>0,'No connection rows: '+selector);
  for(const value of values){
    assert.ok(Math.abs(value.name[leftNames?'left':'center']-values[0].name[leftNames?'left':'center'])<1,JSON.stringify(values));
    assert.ok(Math.abs(value.badge.center-values[0].badge.center)<1,JSON.stringify(values));
    assert.ok(Math.abs(value.actions.right-values[0].actions.right)<1,JSON.stringify(values));
    assert.equal(value.nameAlign,leftNames?'left':'center');
    assert.ok(Math.abs(value.name.y-value.badge.y)<1,JSON.stringify(values));
    if(equalHeight)assert.ok(Math.abs(value.row.height-values[0].row.height)<1,JSON.stringify(values));
  }
  return values;
}
async function statusActionSpacing(page,selector){
  const values=await page.locator(selector).evaluateAll(rows=>rows.flatMap(row=>{
    const badge=row.querySelector('.badge')?.getBoundingClientRect();
    return [...row.querySelectorAll('.cact button,.cact .action-link')].filter(button=>button.checkVisibility()).map(button=>{
      const r=button.getBoundingClientRect(),stacked=r.top>=badge.bottom-.5;
      return {name:row.querySelector('.cname')?.textContent,label:button.textContent.trim(),stacked,gap:stacked?r.top-badge.bottom:r.left-badge.right};
    });
  }));
  assert.ok(values.length>0);assert.ok(values.every(value=>value.gap>=(value.stacked?12:16)-.5),JSON.stringify(values));
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
  const records=[];
  for(const width of [1280,768,375,320])for(const lang of ['ko','en'])for(const theme of ['dark','light']){
    const f=await fixture(t),before=await readFile(f.paths.runtimeConfig,'utf8');
    const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];
    await context.addInitScript(({lang,theme})=>{localStorage.setItem('office-lang',lang);localStorage.setItem('office-theme',theme);},{lang,theme});
    page.on('pageerror',error=>errors.push(error.message));await page.goto(f.url);await page.locator('#mcp-clients [data-client=codex] button').waitFor();
    await settled(page,'refresh-mcp');
    await page.waitForFunction(lang=>document.documentElement.lang===lang,lang);
    const agents=await alignedRows(page,'#mcp-clients .client',{leftNames:true}),buttons=await compactButtons(page.locator('#mcp-clients .cact button'));
    const agentSpacing=await statusActionSpacing(page,'#mcp-clients .client');
    assert.equal(await page.locator('#mcp-clients .client-icon svg').count(),5);
    assert.equal(await page.locator('#mcp-clients .client>p').count(),0,'Client descriptions must not clutter the connection list');
    await page.locator('#windows-bridge>summary').click();
    assert.ok(await page.locator('#windows-bridge-help').isVisible());
    assert.match(await page.locator('#windows-bridge-help').textContent(),lang==='ko'?/건너뛰어도 돼요/u:/Skip it if you connected a WSL app/u);assert.match(await page.locator('#windows-bridge').innerText(),lang==='ko'?/터미널이나 채팅에 입력하는 명령이 아니에요/u:/not commands for a terminal or chat/u);
    assert.equal(buttons.filter(b=>b.text===(lang==='ko'?'연결':'Connect')).length,2,'Only the two signed-in clients should offer registration');
    assert.equal(await page.locator('#mcp-clients [data-client=opencode] .cact button').count(),1,'Log in first; do not offer registration alongside it');
    assert.equal(await page.getByText(lang==='ko'?'MCP 연결':'Connect MCP',{exact:true}).count(),0);
    await rightEdge(page,'#refresh-mcp,#mcp-next','#step-0');await noOverflow(page);
    if(width===1280)await page.screenshot({path:join(evidence,`agents-${width}-${lang}-${theme}.png`),fullPage:true});
    await page.locator('[data-step="1"]').click();await page.locator('[data-browser=playwright]').waitFor();
    await page.locator('#browser-alternatives>summary').focus();await page.keyboard.press('Enter');
    await page.getByRole('button',{name:lang==='ko'?'Aside 연결 확인':'Check Aside connection',exact:true}).click();
    await page.locator('[data-browser=aside][data-setup-state=permission]').waitFor();
    // A cached ready badge is not evidence that this new check finished rerendering the rows.
    await settled(page,'browser-setup-refresh');
    const optional=await alignedRows(page,'.browser-list .client');
    await compactButtons(page.locator('.browser-list .cact button,.browser-list .cact .action-link'));
    await rightEdge(page,'[data-browser=playwright] .cact button','[data-browser=playwright]');
    await rightEdge(page,'#browser-setup-refresh','#browser-setup');await rightEdge(page,'#step-1>.actions button','#step-1');await noOverflow(page);
    if([1280,375].includes(width))await page.screenshot({path:join(evidence,`browsers-${width}-${lang}-${theme}.png`),fullPage:true});
    await page.locator('[data-step="2"]').click();await page.locator('#client-hermes').waitFor();await settled(page,'refresh-clients');
    const ai=await alignedRows(page,'#clients .client',{equalHeight:true,leftNames:true});await compactButtons(page.locator('#clients .cact button'));
    const aiSpacing=await statusActionSpacing(page,'#clients .client');
    assert.equal(await page.locator('#clients .client-icon svg').count(),5);
    assert.equal(await page.locator('#clients .client>p').count(),0);
    const selectedCodexModel=await page.locator('#codex-model').inputValue(),selectedCodexEffort=await page.locator('#codex-reasoning').inputValue();
    assert.equal(selectedCodexModel,'gpt-6.1-sol','The requested first-run default remains visible even before account access is verified');
    assert.equal(selectedCodexEffort,'low');
    const catalogState=await page.locator('#catalog-state').textContent();
    if(lang==='en'){assert.doesNotMatch(catalogState,/[\uac00-\ud7a3]/u,'English AI settings must not retain Korean catalog status fragments');assert.match(catalogState,/new default Codex model is not in this account’s model list/u);}
    else{assert.match(catalogState,/확인한 모델/u);assert.match(catalogState,/새 기본 Codex 모델이 현재 목록에 없어요/u);}
    await page.locator('#client-codex [data-manage-client=codex]').click();
    await page.waitForFunction(()=>document.activeElement?.id==='codex-model');
    assert.equal(await page.locator('#codex-model').inputValue(),selectedCodexModel,'Manage must focus the existing model setting without changing it');
    assert.equal(await page.locator('#codex-reasoning').inputValue(),selectedCodexEffort);
    await rightEdge(page,'#refresh-clients','#subscription-fields');await rightEdge(page,'#step-2>.actions button','#step-2');await noOverflow(page);
    const models=await page.locator('#codex-model,#claude-model').evaluateAll(items=>items.map(e=>e.getBoundingClientRect().width));
    assert.ok(models.every(w=>Math.abs(w-models[0])<1),JSON.stringify(models));
    assert.equal(await page.locator('.terminal pre').evaluate(e=>getComputedStyle(e).textAlign),'start');
    assert.deepEqual(errors,[]);
    if([1280,375].includes(width))await page.screenshot({path:join(evidence,`ai-${width}-${lang}-${theme}.png`),fullPage:true});
    assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),before);
    assert.ok(f.calls.every(call=>call==='browser:aside'),'Layout checks must not invoke models, change registration or start sign-in');
    records.push({width,lang,theme,agents,optional,ai,buttons,agentSpacing,aiSpacing});await context.close();
  }
  await writeFile(join(evidence,'layout-matrix.json'),JSON.stringify({evidence_level:'fixture_integration',status:'PASS',records},null,2)+'\n');
});

test('runtime native Work import and detail retain compact right actions, readable prose and pause/resume interaction',async t=>{
  const f=await fixture(t),store=new PackStore(f.config.dbPath);store.registerProject(f.config.project);
  const work=store.beginWork(f.config.project.id,'layout-work','화면 정렬 검증 업무','quick').work.id;
  // Exercise a saved needs-model state through its actual modal controls,
  // without pretending a missing definition can invoke a model or execute.
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
    await page.goto(server.url+'?work='+work);await page.locator('.control-panel').waitFor();await page.locator('[data-stage="next"]').click();await page.locator('#stage-dialog[open]').waitFor();await page.locator('[data-stage-action="pause"]').click();
    await page.waitForFunction(()=>!document.querySelector('[data-stage-action="resume"]')?.disabled);
    const paused=await(await fetch(server.url+'work/detail?id='+work)).json();assert.equal(paused.paused,true);assert.equal(paused.supervisor,null);
    await page.locator('[data-stage-action="resume"]').click();await page.waitForFunction(()=>!document.querySelector('[data-stage-action="pause"]')?.disabled);
    const resumed=await(await fetch(server.url+'work/detail?id='+work)).json();assert.equal(resumed.paused,false);assert.equal(resumed.supervisor,null,'A missing definition must not execute');assert.equal(resumed.work_status,'needs_model');
    await compactButtons(page.locator('#stage-dialog .actions button'));await rightEdge(page,'#stage-dialog .actions button','#stage-dialog .actions');await page.locator('#stage-close').click();
    // The live Work stream can replace the node after a locator resolves. Inspect the current connected node atomically.
    await page.waitForFunction(()=>{const note=document.querySelector('.control-note');return note?.isConnected&&['start','left'].includes(getComputedStyle(note).textAlign);});await noOverflow(page);
    await page.screenshot({path:join(evidence,`work-${width}-${lang}.png`),fullPage:true});assert.deepEqual(errors,[]);await context.close();
  }
});

test('runtime fixture client management opens actual settings without changing the selected API mode or saved configuration',async t=>{
  const f=await fixture(t,{savedCodexModel:'gpt-5.6-luna',savedCodexEffort:'medium'}),before=await readFile(f.paths.runtimeConfig,'utf8'),savedBefore=await readFile(modelSettingsPath(f.config),'utf8');
  for(const id of ['codex','claude','opencode','cursor','hermes']){f.statusOverrides.set(id,'ready');f.registered.add(id);}
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:375,height:900}});
  await page.addInitScript(()=>localStorage.setItem('office-lang','en'));await page.goto(f.url);
  await page.locator('[data-step="2"]').click();await settled(page,'refresh-clients');
  await page.getByRole('button',{name:'Manage Cursor',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.matches('#mcp-clients [data-client=cursor]'));
  await page.getByRole('button',{name:'Manage Codex',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='codex-model');
  assert.equal(await page.locator('#codex-model').inputValue(),'gpt-5.6-luna','Manage must retain the persisted model instead of restoring the first-run default');
  assert.equal(await page.locator('#codex-reasoning').inputValue(),'medium');
  await page.locator('#codex-model').selectOption('fixture-model');
  await page.getByRole('button',{name:'Manage Codex',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='codex-model');
  assert.equal(await page.locator('#codex-model').inputValue(),'fixture-model');
  assert.equal(await page.locator('#codex-reasoning').inputValue(),'medium');
  // The API mode is a legacy path hidden from the page unless saved; this case drives it on purpose.
  await page.evaluate(()=>{document.getElementById('mode-field').hidden=false;});await page.locator('#mode').selectOption('api');await settled(page,'save-model');
  await page.locator('[data-step="0"]').click();await settled(page,'refresh-mcp');
  await page.getByRole('button',{name:'Manage Codex',exact:true}).click();
  await page.waitForFunction(()=>document.activeElement?.id==='mode');
  assert.equal(await page.locator('#mode').inputValue(),'api','Manage must never implicitly switch billing or authentication mode');
  assert.equal(await readFile(f.paths.runtimeConfig,'utf8'),before);assert.equal(await readFile(modelSettingsPath(f.config),'utf8'),savedBefore);assert.deepEqual(f.calls,[]);await noOverflow(page);
});

test('runtime fixture fresh catalog refresh confirms listed 6.1 Sol/low, saves it, and invokes that exact CLI model',async t=>{
  const f=await fixture(t,{catalogModels:[{id:'gpt-6.1-sol',label:'GPT-6.1-Sol'},{id:'gpt-5.6-luna',label:'GPT-5.6-Luna'}]}),browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));await page.goto(f.url);await page.locator('[data-step="2"]').click();await settled(page,'refresh-clients');
  assert.equal(await page.locator('#codex-model').inputValue(),'gpt-6.1-sol');assert.equal(await page.locator('#codex-reasoning').inputValue(),'low');
  await page.locator('#refresh-clients').click();await settled(page,'refresh-clients');assert.equal(await page.locator('#codex-model').inputValue(),'gpt-6.1-sol');
  await page.locator('#save-model').click();await page.locator('#notice').filter({hasText:"저장했어요."}).waitFor();
  const saved=readModelSettings(modelSettingsPath(f.config));assert.equal(saved.selection.client_models.codex,'gpt-6.1-sol');assert.equal(saved.selection.codex_reasoning_effort,'low');
  const requests=[],runner={async run(request){requests.push(request);return request.args.join(' ')==='login status'?{code:0,stdout:'Logged in using ChatGPT',stderr:''}:{code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\n',stderr:''};}};
  const model=new ConfiguredStructuredModel(modelSettingsPath(f.config),{AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex'}, {subscription:options=>new SubscriptionAwareStructuredModel({...options,runner}),api:()=>{throw Error('PAID_API_NOT_ALLOWED');}});
  await model.call('correct','Return JSON.',{},{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false});
  const args=requests.find(request=>request.args.includes('exec')).args;assert.deepEqual(args.slice(0,6),['--model','gpt-6.1-sol','exec','-c','model_reasoning_effort=low','--json']);
});

test('runtime fixture a saved model absent from the account list stays visible and blocks only active Codex saves',async t=>{
  const f=await fixture(t,{savedCodexModel:'gpt-6-sol',savedCodexEffort:'high',catalogModels:[{id:'gpt-5.6-sol',label:'GPT-5.6-Sol'}]}),browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));await page.goto(f.url);await page.locator('[data-step="2"]').click();await settled(page,'refresh-clients');
  assert.equal(await page.locator('#codex-model').inputValue(),'gpt-6-sol');assert.match(await page.locator('#catalog-state').textContent(),/저장한 Codex 모델이 현재 목록에 없어요/u);
  await page.locator('#save-model').click();await page.locator('#notice').filter({hasText:'다시 선택해 주세요.'}).waitFor();assert.equal(readModelSettings(modelSettingsPath(f.config)).selection.client_models.codex,'gpt-6-sol');
  await page.locator('#client').selectOption('claude');await page.locator('#save-model').click();await page.locator('#notice').filter({hasText:"저장했어요."}).waitFor();
  assert.equal(readModelSettings(modelSettingsPath(f.config)).selection.client,'claude');assert.equal(readModelSettings(modelSettingsPath(f.config)).selection.client_models.codex,'gpt-6-sol');
  await page.locator('#client').selectOption('codex');await page.locator('#codex-model').selectOption('gpt-5.6-sol');await page.locator('#save-model').click();await page.locator('#notice').filter({hasText:"저장했어요."}).waitFor();
  assert.equal(readModelSettings(modelSettingsPath(f.config)).selection.client_models.codex,'gpt-5.6-sol');
});

test('runtime fixture English catalog warning and unsupported-model save error stay in English',async t=>{
  const f=await fixture(t,{savedCodexModel:'gpt-6-sol',catalogModels:[{id:'gpt-5.6-sol',label:'GPT-5.6-Sol'}]}),browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('office-lang','en'));await page.goto(f.url);await page.locator('[data-step="2"]').click();await settled(page,'refresh-clients');
  assert.equal(await page.locator('#codex-model').inputValue(),'gpt-6-sol');
  assert.match(await page.locator('#codex-model option:checked').textContent(),/Not in this account’s model list/u);
  assert.match(await page.locator('#catalog-state').textContent(),/The saved Codex model is not in this account’s model list/u);
  assert.doesNotMatch(await page.locator('#catalog-state').textContent(),/[\uac00-\ud7a3]/u);
  await page.locator('#save-model').click();await page.locator('#notice').filter({hasText:'Choose another model from the list.'}).waitFor();
  assert.equal(readModelSettings(modelSettingsPath(f.config)).selection.client_models.codex,'gpt-6-sol');
});
