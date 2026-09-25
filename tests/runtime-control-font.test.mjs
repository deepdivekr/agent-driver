import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {setWorkModelDataApproval} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {pretendardAsset} from '../dist/observability/ui-assets.js';

test('runtime native Control Center serves the licensed font only through its exact capability-scoped path',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-font-')),paths=await prepareLocalConnection(root);
  const server=await startControlCenter(loadHostConfig(paths.runtimeConfig));
  t.after(async()=>{await server.close();await rm(root,{recursive:true,force:true});});
  const response=await fetch(server.url+pretendardAsset),bytes=Buffer.from(await response.arrayBuffer());
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'font/woff2');
  assert.equal(bytes.subarray(0,4).toString(),'wOF2');assert.equal(bytes.length,2057688);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),'9599f12fd42fc0bce1cd50b47a0c022e108d7aa64dd0d1bb0ed44f3282d900b4');
  assert.match(await readFile('assets/fonts/OFL.txt','utf8'),/SIL OPEN FONT LICENSE Version 1.1/);
  assert.equal((await fetch(server.url+pretendardAsset,{method:'HEAD'})).status,200);
  assert.equal((await fetch(server.url+pretendardAsset,{method:'POST'})).status,405);
  assert.equal((await fetch(new URL('/'+pretendardAsset,server.url))).status,404);
  assert.equal((await fetch(server.url+'fonts/OFL.txt')).status,404);
  const wrongHost=await new Promise((resolve,reject)=>{const request=httpRequest(server.url+pretendardAsset,{headers:{host:'untrusted.test'}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});request.on('error',reject);request.end();});
  assert.equal(wrongHost,403);
});

test('runtime fixture Pretendard renders Korean on Work, settings and connections at desktop and mobile widths without remote fonts',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-font-ui-')),paths=await prepareLocalConnection(root);
  await setWorkModelDataApproval(paths.runtimeConfig,true);
  const model={calls:[],async call(){return {title:'주간 기술 소식',desired_outcome:'최근 기술 소식을 출처와 함께 요약한다',completion_checks:[{id:'sources',result:'공식 출처 확인',evidence:'원문 링크'},{id:'summary',result:'핵심 내용 요약',evidence:'출처가 포함된 요약문'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}};
  const server=await startControlCenter(loadHostConfig(paths.runtimeConfig),{workModel:model});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});});
  await mkdir('tests/evidence/control-font',{recursive:true});
  const page=await browser.newPage({colorScheme:'dark'}),errors=[],remote=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.origin!==new URL(server.url).origin){remote.push(url.origin);return route.abort();}
    if(url.pathname.endsWith('/settings/mcp'))return route.fulfill({json:{agent_driver:{installed:true},clients:[],registered_count:0,windows_bridge:null}});
    if(url.pathname.endsWith('/settings/bootstrap'))return route.fulfill({json:{clients:[],connections:[]}});
    if(url.pathname.endsWith('/settings/models'))return route.fulfill({json:{codex:{models:[]},claude:{models:[]},opencode:{models:[]}}});
    return route.continue();
  });
  await page.goto(server.url);
  await page.locator('#prompt').fill('최근 기술 소식을 출처와 함께 요약해줘');
  await page.locator('#submit-work').click();
  await page.getByRole('heading',{name:'주간 기술 소식',exact:true}).waitFor();
  const detailSuffix=new URL(page.url()).search;
  for(const width of [1440,390])for(const suffix of ['', detailSuffix,'settings','connections']){
    await page.setViewportSize({width,height:1000});await page.goto(server.url+suffix);
    if(suffix===detailSuffix)await page.getByRole('heading',{name:'주간 기술 소식',exact:true}).waitFor();
    else if(!suffix)await page.locator('.tile').waitFor();
    await page.evaluate(async()=>{await document.fonts.load('600 20px "Pretendard Variable"','업무 연결 설정');await document.fonts.ready;});
    assert.equal(await page.evaluate(()=>[...document.fonts].some(f=>f.family==='Pretendard Variable'&&f.status==='loaded')),true);
    const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
    const {root:dom}=await cdp.send('DOM.getDocument'),{nodeId}=await cdp.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'h1'});
    const {fonts}=await cdp.send('CSS.getPlatformFontsForNode',{nodeId});
    assert.ok(fonts.some(f=>f.isCustomFont&&f.familyName.includes('Pretendard')),'heading must use downloaded font glyphs, not merely list a CSS fallback');
    await cdp.detach();
    const borders=await page.locator('.nav[aria-current=page],.nav.on,.control-note,.coding-reconcile').evaluateAll(nodes=>nodes.map(node=>{const s=getComputedStyle(node);return {widths:[s.borderLeftWidth,s.borderRightWidth,s.borderTopWidth,s.borderBottomWidth],colors:[s.borderLeftColor,s.borderRightColor,s.borderTopColor,s.borderBottomColor],shadow:s.boxShadow};}));
    for(const border of borders){assert.equal(new Set(border.widths).size,1);assert.equal(new Set(border.colors).size,1);assert.equal(border.shadow,'none');}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:'tests/evidence/control-font/'+(suffix===detailSuffix?'detail':suffix||'work')+'-'+width+'.png',fullPage:true});
  }
  assert.deepEqual(remote,[]);assert.deepEqual(errors,[]);
});

test('runtime unit Control Center emphasis has no left-edge border or inset stripe',async()=>{
  for(const path of ['ui-shell.ts','work-ui.ts','settings-ui.ts','browser-connections.ts','office-ui.ts']){
    const source=await readFile('src/observability/'+path,'utf8');
    assert.doesNotMatch(source,/border-(?:left|inline-start)\s*:|box-shadow\s*:\s*inset/u,path);
  }
});
