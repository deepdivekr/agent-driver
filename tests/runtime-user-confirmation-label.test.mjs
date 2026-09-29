import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {chromium} from 'playwright';
import {workHtml} from '../dist/observability/work-ui.js';
import {settingsHtml} from '../dist/observability/settings-ui.js';
import {officeHtml} from '../dist/observability/office-ui.js';
import {hermesWorkScript} from '../dist/observability/hermes-work-ui.js';
import {remoteOfficeScript} from '../dist/observability/remote-office-ui.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';

function labels(script,name='labels'){
  const match=script.match(new RegExp('const '+name+'=(\\{[^;]*\\});','u'));
  assert.ok(match,'UI label table must exist');
  return runInNewContext('('+match[1]+')');
}

test('confirmation label tables retain machine statuses and agree across Work and connection surfaces',()=>{
  for(const [script,name,status] of [
    [workHtml('test'),'labels','needs_human'],
    [officeHtml('test'),'labels','needs_human'],
    [hermesWorkScript(),'hermesLabels','needs_human'],
    [remoteOfficeScript(),'remoteLabels','needs_human'],
    [settingsHtml('test'),'labels','challenge'],
  ]){
    assert.equal(labels(script,name)[status],'사용자 확인 필요');
    assert.doesNotMatch(script,/사람 확인 필요|Needs a person/u);
  }
  assert.equal(labels(workHtml('test')).waiting_auth,'로그인 필요');
  assert.equal(labels(workHtml('test')).waiting_approval,'승인 대기');
  assert.equal(labels(workHtml('test')).reconciliation_required,'중단 지점 확인 필요');
});

test('runtime fixture confirmation tags render on board, list, detail and site login in both languages and viewport sizes',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-confirmation-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'confirmation-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off',model_data_approved:false}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const id=store.beginWork(config.project.id,'confirmation-label','Confirmation label fixture','quick').work.id;
  store.close();
  const server=await startControlCenter(config),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});});
  const detail=await (await fetch(server.url+'work/detail?id='+id)).json();
  const connectionPage=await (await fetch(server.url+'connections')).text();
  assert.equal(labels(connectionPage).challenge,'사용자 확인 필요');
  assert.doesNotMatch(connectionPage,/사람 확인 필요|로그인이나 사람 확인/u);
  for(const width of [1280,375])for(const lang of ['ko','en']){
    const context=await browser.newContext({viewport:{width,height:980},colorScheme:'dark'}),page=await context.newPage(),errors=[],writes=[];
    page.on('pageerror',error=>errors.push(error.message));
    await context.addInitScript(language=>localStorage.setItem('office-lang',language),lang);
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url());
      if(url.origin!==new URL(server.url).origin)return route.abort();
      if(req.method()!=='GET'){writes.push(req.method());return route.abort();}
      if(url.pathname.endsWith('/work/board'))return route.fulfill({json:{works:[{id,title:'Confirmation label fixture',status:'needs_human',pack:null,run:null,updated_at:new Date().toISOString()}],auth_attention_count:0}});
      if(url.pathname.endsWith('/work/detail'))return route.fulfill({json:{...detail,run_status:'needs_human'}});
      if(url.pathname.endsWith('/connections/status'))return route.fulfill({json:{sites:[{site:'example.test',label:'Test portal',state:'challenge'}],profile_preserved:true,vnc:null}});
      return route.continue();
    });
    const expected=lang==='ko'?'사용자 확인 필요':'User confirmation needed';
    await page.goto(server.url);
    const tile=page.locator('[data-work="'+id+'"]');
    await tile.locator('.badge').filter({hasText:expected}).waitFor();
    assert.equal(await tile.locator('.badge').textContent(),expected);
    await page.locator('[data-layout="list"]').click();
    await page.locator('.rows .badge').filter({hasText:expected}).waitFor();
    await tile.click();
    await page.locator('.work-head .state').filter({hasText:expected}).waitFor();
    assert.equal(await page.locator('.work-head .state').textContent(),expected);
    await page.goto(server.url+'connections');
    await page.locator('#sites .badge').filter({hasText:expected}).waitFor();
    assert.equal(await page.locator('#sites .badge').textContent(),expected);
    await page.getByText(lang==='ko'?'로그인이나 사용자 확인이 끝날 때까지 해당 worker는 대기합니다.':'The worker waits until login or user confirmation is complete.',{exact:true}).waitFor();
    assert.doesNotMatch(await page.locator('body').innerText(),/사람 확인 필요|Needs a person/u);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    await context.close();
  }
});
