// Real UI from serve-readme-ui.mjs; isolated sample records, no paid calls.
// Usage: node scripts/docs/capture-readme-ui.mjs /tmp/office-readme-XXXX/server.json
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from 'playwright';
import {execFileSync} from 'node:child_process';

const receipt=JSON.parse(await readFile(process.argv[2],'utf8'));
assert.equal(new URL(receipt.url).hostname,'127.0.0.1');
assert.equal(receipt.sample_data,true,'Refuse to capture a private/live dashboard');
const language=receipt.language??'ko';
assert.ok(['en','ko'].includes(language));
const labels=language==='en'?{title:'Weekly AI brief',resume:'Resume',pause:'Pause',ai:'Connect AI',key:'API key'}:{title:'AI 소식 주간 요약',resume:'작업 재개',pause:'일시정지',ai:'AI 연결',key:'API 키'};
const directory=resolve('docs/images',language==='en'?'en':'.');
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[];
try{
  const page=await browser.newPage({viewport:{width:1440,height:720},deviceScaleFactor:1,colorScheme:'dark',reducedMotion:'reduce',locale:language==='en'?'en-US':'ko-KR'});
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(language=>{
    localStorage.setItem('office-lang',language);
    localStorage.setItem('office-layout','board');
  },language);
  async function verifyScreen(){
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.evaluate(()=>matchMedia('(prefers-color-scheme: dark)').matches),true);
    assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()),'#101317');
    if(language==='en')assert.doesNotMatch(await page.locator('body').innerText(),/[가-힣]/u,'English capture contains untranslated visible text');
  }
  await page.goto(receipt.url);
  await page.locator('.tile').first().waitFor();
  assert.equal(await page.locator('.tile').count(),4);
  await page.locator('[data-layout="board"][aria-pressed="true"]').waitFor();
  await page.locator('.kanban').waitFor();
  await verifyScreen();
  await page.screenshot({path:directory+'/work-overview.png',fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.goto(receipt.detail_url);
  await page.getByRole('heading',{name:labels.title,exact:true}).waitFor();
  await page.locator('#pause').waitFor();
  await page.locator('.checks-wrap summary').click();
  await verifyScreen();
  await page.screenshot({path:directory+'/work-detail.png',fullPage:true});
  await page.locator('#pause').click();
  await page.getByRole('button',{name:labels.resume,exact:true}).waitFor();
  await page.locator('#pause').click();
  await page.getByRole('button',{name:labels.pause,exact:true}).waitFor();
  await page.goto(receipt.url+'settings');
  await page.locator('[data-step="2"]:enabled').waitFor();
  await page.locator('[data-step="2"]').click();
  await page.getByRole('heading',{name:labels.ai,exact:true}).waitFor();
  // Unsaved API form only. Never enter a credential or call a provider.
  await page.locator('#mode').selectOption('api');
  await page.getByLabel(labels.key,{exact:true}).waitFor();
  await verifyScreen();
  await page.screenshot({path:directory+'/ai-connection.png',fullPage:true});
  assert.equal(await page.getByLabel(labels.key,{exact:true}).inputValue(),'');
  assert.deepEqual(errors,[]);
  await writeFile(directory+'/capture.json',JSON.stringify({
    source_version:receipt.version,ui_base_commit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),
    captured_at:new Date().toISOString(),sample_data:true,live_task_run:false,paid_model_calls:0,
    viewport:{width:1440,overview_height:720,detail_height:1000,settings_height:1000},language,theme:'dark',layout:'board',
    screens:['work-overview.png','work-detail.png','ai-connection.png'],
    checks:['four queued/paused sample Works','board view selected','dark media and rendered background verified','localized UI and sample records','pause/resume changes state','API key blank; no settings saved','no page errors'],
  },null,2)+'\n');
  console.log('Captured three current UI screens; pause/resume verified; no model calls.');
}finally{await browser.close();}
