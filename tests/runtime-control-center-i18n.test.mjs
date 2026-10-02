import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {createServer} from 'node:http';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {BrowserSetupController} from '../dist/onboarding/browser-setup.js';
import {appendSetupActivity,readSetupActivity} from '../dist/onboarding/setup-activity.js';

test('runtime fixture setup checks stream localized historical/live outcomes and explain optional Windows configuration without changing data',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());await mkdir('tests/evidence/phase97',{recursive:true});
 for(const width of [1280,375]){
  const root=await mkdtemp(join(tmpdir(),'office-setup-locale-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),before=await readFile(paths.runtimeConfig,'utf8');
  let releaseCheck,hold=false,fail=false,probeReady=true;
  const clients=[{id:'codex',status:'ready'},{id:'claude',status:'signed_out'},{id:'opencode',status:'unknown'},{id:'cursor',status:'expired'},{id:'hermes',status:'unavailable'}].map(row=>({...row,reason:row.id==='hermes'?'wsl_native_client_not_found':'fixture',supported_login_flows:[],connection:{state:'idle'}}));
  const auth={async connections(){if(hold)await new Promise(resolve=>releaseCheck=resolve);if(fail)throw Error('private-raw-provider-output');return clients;},view(){return {state:'idle'};},close(){}};
  const mcp={async view(){return {registered_count:0,agent_driver:{installed:true},clients:clients.map(c=>({id:c.id,installed:c.id!=='hermes',automatic:false,registration:'not_registered'})),windows_bridge:{command:'wsl.exe',args:['--exec','/home/업무/office','mcp']}};}};
  const bootstrap={view(){return {clients:clients.map(c=>({id:c.id,label:({codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'})[c.id],installed:c.id!=='hermes',managed_install:false}))};}};
  const browsers=new BrowserSetupController(config,{detectAside:async()=>'/tmp/aside',probe:async()=>{if(!probeReady)throw Error('private-browser-output');}});
  const seeds=['Aside 연결 점검 시작','Aside 연결 점검 통과 · 2.4초','Neo 연결 확인 필요 · 1.2초','Playwright 전용 Chromium 다운로드 시작','Aside 실행기 등록 완료 · 새 MCP 연결부터 적용','Neo 준비를 완료하지 못했습니다. 설치·실행 상태를 확인하세요.','WSL/Linux 실행 환경과 Agent Office 설치를 확인했습니다.','코딩 전용 AI 설정을 저장했습니다. 전역 설정보다 우선합니다.'];
  for(const message of seeds)await appendSetupActivity(root,'runtime','success',message);
  const settings=new ControlSettings(config,auth,{},fetch,mcp,undefined,bootstrap,browsers);let host;const server=createServer(async(req,res)=>{if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;
  const page=await browser.newPage({viewport:{width,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.goto('http://'+host+'/settings');await page.waitForFunction(()=>!document.querySelector('#refresh-mcp').disabled);
   await page.locator('.terminal>summary').click();
   await page.waitForFunction(()=>document.querySelector('#setup-log').textContent.includes('Aside connection verified · 2.4s'));
   assert.doesNotMatch(await page.locator('#setup-log').textContent(),/[가-힣]/u);
   await page.locator('#windows-bridge>summary').click();
   assert.match(await page.locator('#windows-bridge-help').innerText(),/Skip it if you connected a WSL app/u);
   assert.match(await page.locator('#windows-bridge').innerText(),/not commands for a terminal or chat/u);
   assert.match(await page.locator('#windows-bridge-config').textContent(),/업무/u,'User paths are not translated');
   hold=true;await page.locator('#refresh-mcp').click();
   await page.waitForFunction(()=>document.querySelector('#tail-last').textContent.includes('Checking app installation'));
   assert.equal(await page.locator('#refresh-mcp').isDisabled(),true);
   hold=false;releaseCheck();await page.waitForFunction(()=>!document.querySelector('#refresh-mcp').disabled);
   const tail=await page.locator('#setup-log').textContent();
   for(const result of ['Codex: Login verified · Connection needed','Claude Code: Login needed','OpenCode: Not confirmed','Cursor: Log in again','Hermes: Not installed'])assert.ok(tail.includes(result),result);
   assert.doesNotMatch(tail,/[가-힣]/u);assert.doesNotMatch(await page.locator('#tail-last').textContent(),/[가-힣]/u);
   fail=true;await page.locator('#refresh-mcp').click();await page.waitForFunction(()=>document.querySelector('#tail-last').textContent.includes('Could not check connections'));
   assert.doesNotMatch(await page.locator('#setup-log').textContent(),/private-raw/u);fail=false;
   for(const step of ['0','1','2','3']){
    await page.locator('[data-step="'+step+'"]').click();await page.waitForFunction(()=>!document.querySelector('[data-step="0"]').disabled);
    for(const summary of await page.locator('#step-'+step+' details:not([open])>summary').all())if(await summary.isVisible())await summary.click();
    const copy=await page.locator('#step-'+step).evaluate(el=>{const node=el.cloneNode(true);node.querySelectorAll('pre,input,textarea,script').forEach(n=>n.remove());return node.textContent;});
    assert.doesNotMatch(copy,/[가-힣]/u,'English step '+step);
   }
   await page.locator('[data-step="1"]').click();await page.waitForFunction(()=>!document.querySelector('#browser-setup-refresh').disabled);
   if(!await page.locator('#browser-alternatives').evaluate(e=>e.open))await page.locator('#browser-alternatives>summary').click();
   const aside=page.locator('[data-browser=aside]');await aside.locator('.cact button').click();await page.waitForFunction(()=>document.querySelector('#tail-last').textContent.includes('Aside: Connection verified'));
   assert.match(await page.locator('#tail-last').textContent(),/Permission needed/u);
   await page.screenshot({path:'tests/evidence/phase97/tail-'+width+'-en.png',fullPage:true});
   await page.reload();await page.waitForFunction(()=>!document.querySelector('[data-step="0"]').disabled);
   assert.doesNotMatch(await page.locator('#setup-log').textContent(),/[가-힣]/u,'Historical reload must stay English');
   await page.locator('#lang-toggle').click();await page.waitForFunction(()=>document.documentElement.lang==='ko'&&!document.querySelector('[data-step="0"]').disabled);
   assert.match(await page.locator('#setup-log').textContent(),/Aside 연결 확인 완료 · 2.4초/u,'Display copy is reviewed without rewriting stored source history');
   await page.locator('[data-step="1"]').click();await page.waitForFunction(()=>!document.querySelector('#browser-setup-refresh').disabled);await page.locator('#browser-alternatives>summary').click();
   probeReady=false;await page.locator('[data-browser=neo] .cact button').click();await page.waitForFunction(()=>document.querySelector('#tail-last').textContent.includes('연결 실패'));
   assert.match(await page.locator('#setup-log').textContent(),/확인 필요/u);
   assert.equal(await readFile(paths.runtimeConfig,'utf8'),before);
   assert.ok(readSetupActivity(root).some(e=>e.message===seeds[1]),'Do not rewrite stored history');
   assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }finally{hold=false;releaseCheck?.();await page.close();await settings.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});}
 }
});

test('Control Center renders English by default and the flag button switches to Korean per browser',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-i18n-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'i18n-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'}));
  const server=await startControlCenter(loadHostConfig(path),{poll_ms:50});
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.close();await rm(root,{recursive:true,force:true});});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url);
  await page.getByRole('button',{name:'Start work',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
  assert.equal(await page.getByPlaceholder('What would you like done?').count(),1);
  const hangul=/[가-힣]/u;
  assert.doesNotMatch(await page.locator('aside').innerText(),hangul);
  assert.doesNotMatch(await page.locator('#intake').innerText(),hangul);
  // A phrase used as a user title/filename must stay verbatim even when it is also a UI label.
  await page.evaluate(()=>{
    const probe=document.createElement('section');probe.id='user-copy-probe';probe.setAttribute('data-i18n-skip','');
    probe.innerHTML='<span title="실행기">실행기</span><input placeholder="완료 조건"><textarea>Work · 완료 조건</textarea>';
    document.querySelector('main').append(probe);
  });
  assert.equal(await page.locator('#user-copy-probe span').innerText(),'실행기');
  assert.equal(await page.locator('#user-copy-probe span').getAttribute('title'),'실행기');
  assert.equal(await page.locator('#user-copy-probe input').getAttribute('placeholder'),'완료 조건');
  assert.equal(await page.locator('#user-copy-probe textarea').inputValue(),'Work · 완료 조건');
  await page.getByPlaceholder('What would you like done?').fill('업무 제목 원문');
  assert.equal(await page.locator('#prompt').inputValue(),'업무 제목 원문','Translation observer must settle and leave editing responsive');
  assert.equal(await page.locator('#lang-toggle [data-lang-code]').textContent(),'EN');
  await page.evaluate(()=>{
    const probe=document.createElement('section');probe.id='plan-translation-probe';
    for(const value of ['계획 단계 · 대기','업무 계획 · v1']){
      const row=document.createElement('p');row.textContent=value;probe.append(row);
    }
    document.querySelector('main').append(probe);
  });
  await page.getByText('Planned stage · Queued',{exact:true}).waitFor();
  await page.getByText('Work plan · v1',{exact:true}).waitFor();
  assert.doesNotMatch(await page.locator('#plan-translation-probe').innerText(),hangul);
  await page.locator('#lang-toggle').click();
  await page.getByRole('button',{name:'업무 시작',exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.lang),'ko');
  assert.equal(await page.locator('#lang-toggle [data-lang-code]').textContent(),'KO');
  await page.goto(server.url+'settings');
  await page.getByRole('heading',{name:'연결 및 설정',exact:true}).waitFor();
  await page.locator('#lang-toggle').click();
  await page.getByRole('heading',{name:'Connections & settings',exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});
