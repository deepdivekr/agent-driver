import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Script} from 'node:vm';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {BrowserSetupController} from '../dist/onboarding/browser-setup.js';
import {BrowserConnections,connectionHtml} from '../dist/observability/browser-connections.js';
import {setSiteAuth,authSites} from '../dist/swarm/browser-auth.js';
import {browserSetupHtml} from '../dist/observability/browser-setup-ui.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-prelogin-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'prelogin',caller_ref:'fixture',account_ref:'fixture',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true},browser_executors:{targets:[{id:'playwright',engine:'playwright',environment:'owned_headless',platform:process.platform,profile_ref:'default',priority:50},{id:'untouched-vm',engine:'playwright',environment:'windows_vm',platform:'win32',profile_ref:'separate',priority:20}]}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {root,path,config,store};
}

test('runtime contract profile retention changes one target with consent, revision and recoverable config',async t=>{
  const x=await fixture(t),controller=new BrowserSetupController(x.config),before=await readFile(x.path,'utf8'),first=controller.view();
  assert.throws(()=>controller.setSessionMode('playwright',first.revision,'persistent',false),/CONSENT_REQUIRED/);
  assert.equal(await readFile(x.path,'utf8'),before);
  assert.throws(()=>controller.setSessionMode('untouched-vm',first.revision,'persistent',true),/SESSION_TARGET_INVALID/);
  const after=controller.setSessionMode('playwright',first.revision,'persistent',true),raw=JSON.parse(await readFile(x.path,'utf8'));
  assert.equal(raw.browser_executors.targets[0].session_mode,'persistent');
  assert.deepEqual(raw.browser_executors.targets[1],JSON.parse(before).browser_executors.targets[1]);
  assert.equal(after.restart_required,true);assert.notEqual(loadHostConfig(x.path).fingerprint,x.config.fingerprint);
  assert.throws(()=>controller.setSessionMode('playwright',first.revision,'isolated',true),/CONFLICT/);
  const backups=(await readdir(x.root)).filter(name=>name.endsWith('.backup.json'));
  assert.equal(backups.length,1);assert.equal(await readFile(join(x.root,backups[0]),'utf8'),before);
  const disabled=controller.setSessionMode('playwright',after.revision,'isolated',true);
  assert.equal(JSON.parse(await readFile(x.path,'utf8')).browser_executors.targets[0].session_mode,'isolated');
  assert.equal(disabled.restart_required,true);
});

test('runtime contract prelogin HTTP registration validates local intent and keeps explicit finish distinct',async t=>{
  const x=await fixture(t),connections=new BrowserConnections(x.store,x.config),registered=[],finished=[],opened=[];
  connections.broker.register=async(site,target)=>{registered.push({site,target});setSiteAuth(x.store,x.config,site,'unchecked');return {site,target_id:target,state:'unchecked',verified:false};};
  connections.broker.finish=async(site,target,options)=>{finished.push({site,target,options});setSiteAuth(x.store,x.config,site,'unknown',false);return {site,state:'unknown',verified:false};};
  connections.broker.open=async(site,target,options)=>{opened.push({site,target,options});return {site,target_id:target,environment:'owned_headless',state:'login_limited',verified:false};};
  const server=createServer((request,response)=>{connections.handle(request,response,request.url.slice(1),request.headers.host).catch(()=>{response.writeHead(500);response.end();});});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await connections.close();await new Promise(resolve=>server.close(resolve));});
  const headers={Origin:origin,'X-Agent-Driver':'human-connection','Content-Type':'application/json'};
  const post=(endpoint,body,custom=headers)=>fetch(origin+'/'+endpoint,{method:'POST',headers:custom,body:JSON.stringify(body)});
  assert.equal((await post('connections/register',{url:'https://example.com/login?continue=home',target_id:'playwright'},{})).status,403);
  assert.equal((await post('connections/register',{url:'https://user:secret@example.com/',target_id:'playwright'})).status,409);
  assert.equal((await post('connections/register',{url:'http://example.com/',target_id:'playwright'})).status,409);
  assert.equal(registered.length,0);
  const result=await post('connections/register',{url:'https://www.example.com/login?continue=home',target_id:'playwright'});
  assert.equal(result.status,200);assert.deepEqual(registered,[{site:'example.com',target:'playwright'}]);
  assert.equal(authSites(x.store,x.config)[0].state,'unchecked');
  setSiteAuth(x.store,x.config,'example.com','unknown',true);assert.equal(connections.reloadBlockedReason,'BROWSER_LOGIN_IN_PROGRESS');
  const state=connections.setup.view();assert.equal((await post('connections/profile',{target_id:'playwright',revision:state.revision,session_mode:'persistent',consent:true})).status,409);
  assert.equal((await post('connections/finish/example.com',{})).status,200);
  assert.deepEqual(finished,[{site:'example.com',target:undefined,options:{explicit_release:true}}]);
  assert.equal(connections.reloadBlockedReason,null);assert.equal(authSites(x.store,x.config)[0].state,'unknown');
  const status=await (await fetch(origin+'/connections/status')).json();
  assert.equal(status.sites[0].automatic_verification,false);
  assert.equal(status.targets.find(target=>target.id==='untouched-vm').availability,'unsupported');
  assert.equal(status.targets.find(target=>target.id==='playwright').profile_preservation_basis,'configuration_only');
  assert.equal(status.runtime_reload_available,false);
  const recheck=await post('connections/recheck/example.com/playwright',{});
  assert.equal(recheck.status,200);assert.deepEqual(opened,[{site:'example.com',target:'playwright',options:{recheck_restricted:true}}]);
  const target=x.config.browserExecutors.targets.find(target=>target.id==='playwright'),retained={...target,session_mode:'persistent'};
  const beforeDormantHold=await readFile(x.path,'utf8');setSiteAuth(x.store,x.config,'x.com','ready',true,retained);
  const held=await post('connections/profile',{target_id:'playwright',revision:connections.setup.view().revision,session_mode:'persistent',consent:true});
  assert.equal(held.status,409);assert.equal((await held.json()).error,'BROWSER_LOGIN_IN_PROGRESS');assert.equal(await readFile(x.path,'utf8'),beforeDormantHold,'A dormant-mode human hold cannot change the saved configuration');
  setSiteAuth(x.store,x.config,'x.com','ready',false,retained);setSiteAuth(x.store,x.config,'reddit.com','login_limited',false,retained);
  const saved=await post('connections/profile',{target_id:'playwright',revision:connections.setup.view().revision,session_mode:'persistent',consent:true});
  assert.equal(saved.status,200);assert.equal((await saved.json()).execution_started,false);
  assert.equal(authSites(x.store,x.config,retained).find(row=>row.site==='x.com').state,'unknown','Mode changes invalidate historical readiness');
  assert.equal(authSites(x.store,x.config,retained).find(row=>row.site==='reddit.com').state,'login_limited','Mode changes preserve site restrictions');
});

function uiData(){return {
  sites:[{site:'google.com',label:'google.com',state:'unknown',automatic_verification:false,profiles:{aside:{state:'unknown',handoff:false,updated_at:'2026-09-30T00:00:00.000Z'}}}],
  targets:[
    {id:'aside',environment:'windows',engine:'aside',label:'Windows · Aside',availability:'ready',profile_preserved:true,session_mode:'external',can_enable_profile:false},
    {id:'playwright',environment:'owned_headless',engine:'playwright',label:'WSL · Playwright',availability:'profile_setup_required',profile_preserved:false,session_mode:'isolated',can_enable_profile:true,reason:'AUTH_PERSISTENT_PROFILE_REQUIRED'},
    {id:'ubuntu',environment:'ubuntu',engine:'playwright',label:'Ubuntu VM · Playwright',availability:'stopped',profile_preserved:true,session_mode:'external',can_enable_profile:false},
    {id:'windows-vm',environment:'windows_vm',engine:'playwright',label:'Windows VM · Playwright',availability:'unsupported',profile_preserved:false,session_mode:null,can_enable_profile:false},
  ],configuration_revision:'a'.repeat(64),restart_required:false,runtime_reload_available:true,vm_state:'stopped',busy:false,
};}

async function uiFixture(t,{width=1280,language='ko',restricted=false,finishRace=false,heldGuest=false}={}){
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width,height:1000}}),data=uiData(),posts=[],errors=[];let pendingMode=null;
  if(heldGuest)data.sites[0].profiles.ubuntu={state:'unknown',handoff:true,updated_at:'2026-09-30T00:00:00.000Z'};
  if(restricted){data.sites[0].site='x.com';data.sites[0].label='X';data.sites[0].state='login_limited';data.sites[0].automatic_verification=true;data.sites[0].profiles.aside.state='login_limited';}
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(language=>localStorage.setItem('office-lang',language),language);
  await page.route('https://office.test/**',async route=>{
    const request=route.request(),url=new URL(request.url()),json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
    if(url.pathname==='/connections')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:connectionHtml('fixture-nonce')});
    if(url.pathname==='/connections/status')return json(data);
    if(request.method()==='POST'){
      const body=request.postData()?JSON.parse(request.postData()):null;posts.push({path:url.pathname,body,header:request.headers()['x-agent-driver']});
      if(url.pathname==='/connections/register'){
        const site=new URL(body.url).hostname.replace(/^www\./u,'');data.sites.push({site,label:site,state:'unchecked',automatic_verification:false,profiles:{[body.target_id]:{state:'unchecked',handoff:false,updated_at:'2026-09-30T00:00:00.000Z'}}});return json({site,state:'unchecked',verified:false});
      }
      if(url.pathname==='/connections/profile'){pendingMode=body.session_mode;data.configuration_revision='b'.repeat(64);data.restart_required=true;return json({restart_required:true,execution_started:false});}
      if(url.pathname==='/work/reconnect'){const target=data.targets.find(target=>target.id==='playwright');target.session_mode=pendingMode;target.profile_preserved=pendingMode==='persistent';target.availability=pendingMode==='persistent'?'available':'profile_setup_required';target.reason=null;data.restart_required=false;return json({state:'reconnecting',execution_started:false},202);}
      const match=/^\/connections\/(open|recheck|check|finish|retry)\/([^/]+)\/([^/]+)$/u.exec(url.pathname);
      if(match){const row=data.sites.find(site=>site.site===match[2]).profiles[match[3]]??={state:'unknown',handoff:false,updated_at:'2026-09-30T00:00:00.000Z'};if(['open','recheck'].includes(match[1]))row.handoff=true;if(match[1]==='finish'&&!finishRace)row.handoff=false;return json({state:row.state,handoff:row.handoff,verified:false,viewer_opened:true});}
    }
    return route.fulfill({status:404,body:'missing fixture route'});
  });
  await page.goto('https://office.test/connections');await page.locator('[data-site="'+data.sites[0].site+'"]').waitFor();
  return {page,data,posts,errors};
}

test('runtime fixture prelogin exposes an existing guest login hold without clearing it',async t=>{
  const {page,posts,errors}=await uiFixture(t,{heldGuest:true}),card=page.locator('[data-site="google.com"]');
  assert.equal(await card.getByRole('combobox').inputValue(),'ubuntu');
  assert.equal(await card.getByRole('button',{name:'로그인 마침',exact:true}).isEnabled(),true);
  assert.deepEqual(posts,[]);
  await card.getByRole('button',{name:'로그인 마침',exact:true}).click();
  await page.getByRole('status').filter({hasText:'로그인 대기를 해제했습니다.'}).waitFor();
  assert.equal(posts[0].path,'/connections/finish/google.com/ubuntu');
  assert.deepEqual(errors,[]);
});

test('runtime fixture prelogin UI preserves URL draft across explicit profile apply and never executes Work',async t=>{
  const {page,posts,errors}=await uiFixture(t);
  await page.locator('#site-url').fill('https://example.com/login');
  await page.locator('#site-target').selectOption('playwright');
  assert.equal(await page.locator('#save-login-profile').isDisabled(),true);
  await page.locator('#profile-consent').check();await page.locator('#save-login-profile').click();
  await page.locator('#apply-login-settings').waitFor();assert.equal(await page.locator('#register-site').isDisabled(),true);
  await page.locator('#apply-login-settings').click();await page.waitForFunction(()=>!document.getElementById('register-site').disabled);
  assert.equal(await page.locator('#site-url').inputValue(),'https://example.com/login');
  await page.locator('#register-site').click();await page.locator('[data-site="example.com"]').waitFor();
  assert.deepEqual(posts.map(post=>post.path),['/connections/profile','/work/reconnect','/connections/register']);
  assert.deepEqual(posts[0].body,{target_id:'playwright',revision:'a'.repeat(64),session_mode:'persistent',consent:true});
  assert.equal(posts[1].header,'human-office');assert.deepEqual(posts[1].body,{});
  assert.equal(posts[2].body.target_id,'playwright');
  await page.locator('#profile-management summary').click();await page.locator('#disable-login-profile').click();
  assert.equal(posts[3].body.session_mode,'isolated');assert.equal(posts[3].body.consent,true);
  assert.deepEqual(errors,[]);
});

test('runtime fixture generic site finish releases login hold without claiming verification',async t=>{
  const {page,posts,errors}=await uiFixture(t),card=page.locator('[data-site="google.com"]');
  await card.getByRole('button',{name:'로그인 창 열기',exact:true}).click();
  await card.getByRole('button',{name:'로그인 마침',exact:true}).waitFor();
  assert.equal(await card.getByRole('button',{name:'자동 확인 미지원',exact:true}).isDisabled(),true);
  assert.equal(await card.getByRole('button',{name:'재시도 허용',exact:true}).isDisabled(),true);
  assert.match(await card.locator('.badge').innerText(),/로그인 미확인/u);
  await card.getByRole('button',{name:'로그인 마침',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('[data-site="google.com"]').textContent.includes('직접 로그인 중'));
  assert.match(await card.locator('.badge').innerText(),/로그인 미확인/u);
  assert.deepEqual(posts.map(post=>post.path),['/connections/open/google.com/aside','/connections/finish/google.com/aside']);
  assert.deepEqual(errors,[]);
});

test('runtime fixture restricted site offers explicit same-environment recheck without lifting its restriction',async t=>{
  const {page,posts,errors}=await uiFixture(t,{restricted:true}),card=page.locator('[data-site="x.com"]');
  assert.equal(await card.getByRole('button',{name:'로그인 창 열기',exact:true}).isDisabled(),true);
  assert.equal(await card.getByRole('button',{name:'재시도 허용',exact:true}).isDisabled(),true);
  await card.locator('.browser-choice').selectOption('ubuntu');
  await page.waitForFunction(()=>!document.querySelector('[data-site="x.com"]').textContent.includes('직접 다시 확인'));
  await card.locator('.browser-choice').selectOption('aside');
  await card.getByRole('button',{name:'직접 다시 확인',exact:true}).click();
  await card.getByRole('button',{name:'로그인 마침',exact:true}).waitFor();
  await page.locator('#site-target').selectOption('playwright');await page.locator('#profile-consent').check();
  assert.equal(await page.locator('#save-login-profile').isDisabled(),true,'A human login hold disables mode changes');
  await card.getByRole('button',{name:'로그인 마침',exact:true}).click();
  await card.getByRole('button',{name:'직접 다시 확인',exact:true}).waitFor();
  assert.match(await card.locator('.badge').innerText(),/사이트가 로그인 일시 제한/u);
  assert.deepEqual(posts.map(post=>post.path),['/connections/recheck/x.com/aside','/connections/finish/x.com/aside']);
  assert.deepEqual(errors,[]);
});

test('runtime fixture a raced finish never claims the human hold was released',async t=>{
  const {page,errors}=await uiFixture(t,{finishRace:true}),card=page.locator('[data-site="google.com"]');
  await card.getByRole('button',{name:'로그인 창 열기',exact:true}).click();
  await card.getByRole('button',{name:'로그인 마침',exact:true}).click();
  await page.waitForFunction(()=>document.getElementById('notice').textContent==='열린 로그인 창에서 작업을 마친 뒤 로그인 마침을 누르세요.');
  assert.match(await card.locator('.badge').innerText(),/직접 로그인 중/u);
  assert.equal(await card.getByRole('button',{name:'재시도 허용',exact:true}).isDisabled(),true);
  assert.deepEqual(errors,[]);
});

for(const width of [1280,375])for(const language of ['ko','en'])test(`runtime fixture prelogin ${language} ${width}px shows supported environments and closed explanations`,async t=>{
  const {page,posts,errors}=await uiFixture(t,{width,language});
  assert.equal(await page.locator('#site-target option').count(),4);
  assert.equal(await page.locator('#site-target option[value="windows-vm"]').evaluate(option=>option.disabled),true);
  assert.equal(await page.locator('#site-target').inputValue(),'aside');
  assert.equal(await page.locator('#prelogin-help').getAttribute('open'),null);
  assert.equal(await page.locator('.site details').getAttribute('open'),null);
  await page.locator('#prelogin-help summary').click();await page.locator('.site summary').click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(language==='en'){const text=await page.locator('main').innerText();assert.equal(/[\uac00-\ud7a3]/u.test(text),false,text);}
  assert.equal(posts.length,0);assert.deepEqual(errors,[]);
  await mkdir('tests/evidence/phase106-prelogin',{recursive:true});
  await page.screenshot({path:`tests/evidence/phase106-prelogin/${language}-${width}.png`,fullPage:true});
});

test('runtime contract local browser setup links to prelogin without automatic settings mutation',()=>{
  assert.match(browserSetupHtml,/<a id="browser-site-logins"[^>]+href="connections"/u);
  assert.doesNotThrow(()=>new Script(connectionHtml('test-nonce').match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));
});
