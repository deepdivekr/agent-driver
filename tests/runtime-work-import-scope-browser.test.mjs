import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';

test('runtime fixture scoped project import uses real HTTP/storage, bilingual responsive UI, and rejects stale previews',async t=>{
 const root=await mkdtemp(join(tmpdir(),'office-scope-browser-')),project=join(root,'project');await mkdir(project);
 await writeFile(join(project,'bot.js'),"bot.command('news', () => bot.sendMessage('news'));\n");
 const paths=await prepareLocalConnection(root),raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));
 raw.work={model_data_approved:true};await writeFile(paths.runtimeConfig,JSON.stringify(raw));
 const config=loadHostConfig(paths.runtimeConfig),calls=[];
 let gate=null,release=null;
 const model={async call(_purpose,_instructions,input){
  calls.push(input);if(gate)await gate;
  return {title:'News alerts',goal:'Import news alerts only',prompt:'Import news alerts',steps:[{id:'news',goal:'Collect news',depends_on:[],evidence_ids:[input.evidence[0].id]}],completion:[{id:'saved',result:'News recorded',proof:'Saved result',evidence_ids:[input.evidence[0].id]}],unknowns:[]};
 }};
 const server=await startControlCenter(config,{workModel:model}),store=new PackStore(config.dbPath);
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 t.after(async()=>{release?.();await browser.close();await server.close();store.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
 await mkdir('tests/evidence/phase98',{recursive:true});
 const original=await readFile(join(project,'bot.js'),'utf8');
 for(const lang of ['ko','en'])for(const width of [1280,390]){
  await page.setViewportSize({width,height:1000});await page.goto(server.url);
  await page.evaluate(({lang})=>{localStorage.setItem('office-lang',lang);localStorage.setItem('office-theme','dark');},{lang});await page.reload();
  await page.locator('#open-import').click();
  await page.waitForFunction(()=>document.querySelector('#migration-prompt').value.length>0);
  const migrationPrompt=await page.locator('#migration-prompt').inputValue();
  if(lang==='en'){assert.match(migrationPrompt,/Do not run, change or stop the existing automation/u);assert.doesNotMatch(migrationPrompt,/[가-힣]/u);}
  else assert.match(migrationPrompt,/실행·수정·중지는 하지 마세요/u);
  await page.locator('[data-import-route="workflow"]').click();
  assert.equal(await page.locator('#import-scope').isVisible(),true);
  assert.equal(await page.locator('label[for="import-scope"]').innerText(),lang==='ko'?'어떤 업무를 가져올까요? · 선택':'What should we import? · optional');
  if(lang==='en'){
   assert.equal(await page.locator('[data-import-route="hermes"]').innerText(),'Hermes work');
   assert.equal(await page.locator('[data-import-route="remote"]').innerText(),'Remote OpenClaw');
   assert.doesNotMatch(await page.locator('#import-path').getAttribute('placeholder'),/[가-힣]/u);
  }
  await page.locator('[data-import-route="bot"]').click();
  assert.equal(await page.locator('#import-scope').isVisible(),true);
  const scope='뉴스 알림만 가져와줘.\n결제와 쇼핑몰은 제외. <img src=x onerror=alert(1)> '+lang+width;
  await page.locator('#import-path').fill(project);await page.locator('#import-scope').fill(scope);
  const other=lang==='ko'?'en':'ko';await page.locator('#lang-toggle').click();
  await page.waitForFunction(lang=>document.documentElement.lang===lang,other);
  assert.equal(await page.locator('#import-scope').inputValue(),scope);
  assert.equal(await page.locator('#import-path').inputValue(),project);
  assert.equal(await page.locator('#import-scope').isVisible(),true);
  await page.locator('#lang-toggle').click();await page.waitForFunction(lang=>document.documentElement.lang===lang,lang);
  assert.equal(await page.locator('#import-scope').inputValue(),scope);
  assert.equal(await page.locator('#import-scope').getAttribute('maxlength'),'2000');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#import-project').screenshot({path:`tests/evidence/phase98/import-${lang}-${width}.png`});
  await page.locator('#scan-import').click();await page.locator('#accept-import').waitFor();
  assert.equal(calls.at(-1).user_scope,scope);
  assert.equal(await page.locator('#import-preview .import-scope-copy').innerText(),scope);
  assert.equal(await page.locator('#import-preview img').count(),0);
  assert.equal(await page.locator('#import-goal').inputValue(),'Import news alerts only','scoped analysis must override generic bot suggestions');
  assert.equal(await page.locator('#import-mode').inputValue(),'observe');
  assert.equal(await page.locator('#import-completion').inputValue(),'News recorded');
  assert.equal(await page.locator('#import-progress').getAttribute('aria-busy'),'false');
  await page.locator('#import-preview').screenshot({path:`tests/evidence/phase98/phase99-review-${lang}-${width}.png`});
  // Editing an already analyzed scope invalidates acceptance.
  await page.locator('#import-scope').fill(scope+' Keep scheduler.');
  assert.equal(await page.locator('#import-preview').isVisible(),false);
  await page.locator('#scan-import').click();await page.locator('#accept-import').waitFor();
  await page.locator('#accept-import').click();await page.locator('#jev-toggle').waitFor();
  const work=store.intakeWorks(config.project.id).find(w=>w.prompt.includes(lang+width));
  assert.ok(work);assert.equal(work.paused,true);assert.equal(work.spec.plan.import_mode,'observe');assert.equal(await page.locator('#import-correct-source').isVisible(),true);assert.equal(await page.locator('#copy-work-dispatch').count(),0);assert.equal(await page.locator('#pause').count(),0);assert.equal(work.spec.plan.import_scope,scope+' Keep scheduler.');
  assert.equal(work.jev_enabled,false);assert.deepEqual(store.officeRuns(config.project.id,work.id),[]);
  await page.screenshot({path:`tests/evidence/phase98/phase99-connection-${lang}-${width}.png`,fullPage:true});
  const plan=page.locator('details.runlist').filter({has:page.locator('.import-scope-copy')});
  await plan.locator('summary').click();assert.equal(await plan.locator('.import-scope-copy').innerText(),scope+' Keep scheduler.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }
 // A changed request while a scan is in flight must never revive its old result.
 await page.goto(server.url);await page.locator('#open-import').click();await page.locator('[data-import-route="workflow"]').click();
 await page.locator('#import-path').fill(project);await page.locator('#import-scope').fill('Old request');
 gate=new Promise(resolve=>{release=resolve;});const before=calls.length;
 await page.locator('#scan-import').click();await page.waitForFunction(()=>document.getElementById('scan-import').disabled);
 await page.waitForFunction(()=>document.querySelector('#import-progress li.busy')?.textContent==='Analyze work with AI');
 assert.equal(await page.locator('#import-progress').getAttribute('aria-busy'),'true');
 await page.locator('#import-scope').fill('New request');
 while(calls.length===before)await new Promise(resolve=>setTimeout(resolve,10));
 assert.equal(await page.locator('#import-progress').isVisible(),false,'changed input hides obsolete progress');
 release();gate=null;await page.locator('#scan-import:not(:disabled)').waitFor();
 assert.equal(await page.locator('#import-preview').isVisible(),false);
 assert.match(await page.locator('#message').innerText(),/The import request changed/u);
 await page.locator('#scan-import').click();await page.locator('#accept-import').waitFor();
 assert.equal(calls.at(-1).user_scope,'New request');
 await page.locator('#import-path').fill(project+'/different');assert.equal(await page.locator('#import-preview').isVisible(),false);
 await page.locator('#scan-import').click();await page.locator('#scan-import:not(:disabled)').waitFor();assert.equal(await page.locator('#import-progress').getAttribute('aria-busy'),'false');assert.equal(await page.locator('#import-path').inputValue(),project+'/different');assert.equal(await page.locator('#accept-import').isVisible(),false);
 // Invalid API input remains guarded without a model call.
 const count=calls.length,origin=new URL(server.url).origin;
 const invalid=await fetch(new URL('work/import/scan',server.url),{method:'POST',headers:{origin,'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify({path:project,scope:'x'.repeat(2001)})});
 assert.equal(invalid.status,409);assert.equal(calls.length,count);
 assert.equal(await readFile(join(project,'bot.js'),'utf8'),original);
});
