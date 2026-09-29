import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';

async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'office-theme-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'theme-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'}));
  const server=await startControlCenter(loadHostConfig(path)),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});});
  const context=await browser.newContext({colorScheme:'light',...options}),page=await context.newPage(),errors=[];
  context.on('page',tab=>tab.on('pageerror',error=>errors.push(error.message)));
  page.on('pageerror',error=>errors.push(error.message));
  return {context,page,server,errors};
}
async function color(page,expected){
  await page.waitForFunction(value=>getComputedStyle(document.body).backgroundColor===value,expected);
}
const dark='rgb(16, 19, 23)',light='rgb(244, 245, 247)';

test('runtime native theme changes immediately without losing a draft and persists across all Control Center routes',async t=>{
  const {page,server,errors}=await setup(t),posts=[];
  page.on('request',request=>{if(request.method()==='POST')posts.push(request.url());});
  await page.goto(server.url);
  await color(page,light);
  await page.locator('#prompt').fill('Keep this unsent work draft');
  await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
  await color(page,dark);
  assert.equal(await page.locator('#prompt').inputValue(),'Keep this unsent work draft');
  assert.equal(await page.evaluate(()=>localStorage.getItem('office-theme')),'dark');
  await page.emulateMedia({colorScheme:'dark'});
  await page.emulateMedia({colorScheme:'light'});
  await color(page,dark);
  await page.reload();
  await color(page,dark);
  for(const route of ['settings','connections','']){
    await page.goto(server.url+route);
    await color(page,dark);
    assert.equal(await page.getByRole('button',{name:'Switch to light mode',exact:true}).count(),1);
  }
  await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
  await page.emulateMedia({colorScheme:'dark'});
  await color(page,light);
  await page.reload();
  await color(page,light);
  assert.deepEqual(posts,[]);
  assert.deepEqual(errors,[]);
});

test('runtime native theme follows the system until chosen and ignores invalid saved values',async t=>{
  const {context,page,server,errors}=await setup(t);
  await context.addInitScript(()=>{localStorage.setItem('office-theme','invalid-theme');});
  await page.goto(server.url+'settings');
  await color(page,light);
  await page.emulateMedia({colorScheme:'dark'});
  await color(page,dark);
  await page.getByRole('button',{name:'Switch to light mode',exact:true}).focus();
  await page.keyboard.press('Enter');
  await color(page,light);
  await page.keyboard.press('Space');
  await color(page,dark);
  assert.deepEqual(errors,[]);
});

test('runtime native theme remains usable when browser storage is denied',async t=>{
  const {context,page,server,errors}=await setup(t);
  await context.addInitScript(()=>{
    for(const name of ['getItem','setItem'])Object.defineProperty(Storage.prototype,name,{value(){throw new DOMException('Storage denied','SecurityError');}});
  });
  await page.goto(server.url+'settings');
  await color(page,light);
  await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
  await color(page,dark);
  await page.getByRole('button',{name:'Switch to light mode',exact:true}).click();
  await color(page,light);
  assert.deepEqual(errors,[]);
});

test('runtime native theme syncs tabs and keeps localized controls visible on a narrow screen',async t=>{
  const {context,page,server,errors}=await setup(t,{viewport:{width:375,height:812}});
  await page.goto(server.url+'settings');
  const other=await context.newPage();
  await other.goto(server.url+'connections');
  await page.getByRole('button',{name:'Switch to dark mode',exact:true}).click();
  await color(other,dark);
  await page.locator('#lang-toggle').click();
  await page.getByRole('heading',{name:'연결 및 설정',exact:true}).waitFor();
  await color(page,dark);
  assert.equal(await page.getByRole('button',{name:'라이트 모드로 전환',exact:true}).count(),1);
  for(const route of ['settings','connections','']){
    await page.goto(server.url+route);
    const theme=await page.locator('#theme-toggle').boundingBox(),lang=await page.locator('#lang-toggle').boundingBox();
    assert.ok(theme&&lang);
    assert.ok(theme.x>=0&&theme.x+theme.width<=375);
    assert.ok(lang.x+lang.width<=theme.x);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  }
  await page.getByRole('button',{name:'라이트 모드로 전환',exact:true}).click();
  await color(other,light);
  await page.evaluate(()=>localStorage.removeItem('office-theme'));
  await other.emulateMedia({colorScheme:'dark'});
  await color(other,dark);
  assert.deepEqual(errors,[]);
});
