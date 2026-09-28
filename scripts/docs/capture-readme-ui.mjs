// Real UI from serve-readme-ui.mjs; isolated sample records, no paid calls.
// Usage: node scripts/docs/capture-readme-ui.mjs /tmp/office-readme-XXXX/server.json
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';

const receipt=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(new URL(receipt.url).hostname,'127.0.0.1');
assert.equal(receipt.sample_data,true,'Refuse to capture a private/live dashboard');
const directory=resolve('docs/images');
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:1280,height:600},deviceScaleFactor:1});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    localStorage.setItem('office-lang','ko');
    localStorage.setItem('office-layout','list');
  });
  await page.goto(receipt.url);
  await page.locator('.tile').first().waitFor();
  assert.equal(await page.locator('.tile').count(),4);
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:directory+'/work-overview.png',fullPage:true});
  await page.setViewportSize({width:1280,height:960});
  await page.goto(receipt.detail_url);
  await page.getByRole('heading',{name:'AI 소식 주간 요약',exact:true}).waitFor();
  await page.locator('#pause').waitFor();
  await page.locator('.checks-wrap summary').click();
  await page.screenshot({path:directory+'/work-detail.png',fullPage:true});
  await page.locator('#pause').click();
  await page.getByRole('button',{name:'작업 재개',exact:true}).waitFor();
  await page.locator('#pause').click();
  await page.getByRole('button',{name:'일시정지',exact:true}).waitFor();
  await page.goto(receipt.url+'settings');
  await page.locator('[data-step="2"]:enabled').waitFor();
  await page.locator('[data-step="2"]').click();
  await page.getByRole('heading',{name:'AI 연결',exact:true}).waitFor();
  // Unsaved API form only. Never enter a credential or call a provider.
  await page.locator('#mode').selectOption('api');
  await page.getByLabel('API 키',{exact:true}).waitFor();
  await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:directory+'/ai-connection.png',fullPage:true});
  assert.equal(await page.getByLabel('API 키',{exact:true}).inputValue(),'');
  assert.deepEqual(errors,[]);
  await writeFile(directory+'/capture.json',JSON.stringify({
    source_version:receipt.version,ui_base_commit:'9da560090d5aaf66a08649741944cd9fb915b20e',
    captured_at:new Date().toISOString(),sample_data:true,live_task_run:false,paid_model_calls:0,
    viewport:{width:1280,overview_height:600,detail_height:960,settings_height:960},language:'ko',
    screens:['work-overview.png','work-detail.png','ai-connection.png'],
    checks:['four queued/paused sample Works','pause/resume changes state','API key blank; no settings saved','no page errors'],
  },null,2)+'\n');
  console.log('Captured three current UI screens; pause/resume verified; no model calls.');
}finally{await browser.close();}
