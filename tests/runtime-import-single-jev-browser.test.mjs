import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {RuntimeApi} from '../dist/interface/api.js';

test('runtime fixture new Work shows Pack-owned Jev settings and can opt out on desktop and mobile',async t=>{
 const root=await mkdtemp(join(tmpdir(),'pack-jev-browser-'));
 const paths=await prepareLocalConnection(root),raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));
 raw.work={model_data_approved:true};await writeFile(paths.runtimeConfig,JSON.stringify(raw));
 const config=loadHostConfig(paths.runtimeConfig),model={async call(){return {title:'자료 수집',desired_outcome:'자료를 모은다',completion_checks:[{id:'collected',result:'수집 결과',evidence:'저장 파일'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}};
 const api=new RuntimeApi(config,{swarmModel:model}),server=await startControlCenter(config);
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await browser.close();await server.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[])});
 await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
 for(const width of [1280,390]){
  const work=await api.call('runtime_work_start',{request_id:'pack-default-'+width,prompt:'자료를 수집해 줘'});
  await page.setViewportSize({width,height:1000});await page.goto(server.url);
  await page.locator('[data-work="'+work.work_id+'"]').click();
  await page.locator('.jev-policy').waitFor();
  assert.equal(await page.locator('.jev-policy').innerText(),'Task Pack 설정 사용');
  assert.equal(await page.locator('#jev-cost').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#jev-toggle').click();
  await page.waitForFunction(()=>document.getElementById('jev-toggle')?.textContent==='Jev 켜기');
  assert.equal(api.store.intakeWork(config.project.id,work.work_id).jev_enabled,false);
 }
});

test('runtime fixture single Jev recommendation import UI works without candidate choice on desktop and mobile',async t=>{
 const root=await mkdtemp(join(tmpdir(),'single-jev-browser-')),project=join(root,'project'),plain=join(root,'plain');
 await mkdir(project);await mkdir(plain);
 await writeFile(join(project,'worker.js'),'export async function inspectIncoming(client,messages) {\n for (const message of messages) {\n  const result=await client.responses.create({model:"configured",input:"Return yes or no: urgent? "+message});\n  answers.push(result);\n }\n}\n');
 await writeFile(join(plain,'worker.js'),'export function classifyMessage(count) { return count > 10 ? "high" : "low"; }');
 const paths=await prepareLocalConnection(root),raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));
 raw.work={model_data_approved:true};await writeFile(paths.runtimeConfig,JSON.stringify(raw));
 let modelCalls=0;
 const workModel={async call(_purpose,_instructions,input){
  modelCalls++;
  const calls=input.evidence.filter(e=>e.signal==='model_call'),e=calls[0]??input.evidence[0];
  return {title:'메시지 검토',goal:'메시지를 검토해 결과를 기록한다',prompt:'메시지를 검토해 줘',steps:[{id:'review',goal:'메시지 긴급도 검토',depends_on:[],evidence_ids:[e.id]}],completion:[{id:'saved',result:'판단 결과 기록',proof:'저장 결과 재조회',evidence_ids:[e.id]}],unknowns:[],jev_recommendations:calls.length?[{
   step_id:'review',judgment:'메시지가 긴급한지 판단',answer_shape:'yes_no',why_fit:'메시지마다 표현이 달라지지만 필요한 답은 예 또는 아니오입니다.',evidence_ids:[e.id],benefit_kind:'replace_llm_judgment',baseline:'메시지마다 기존 LLM을 호출해 긴급도를 확인합니다.',expected_gain:'짧은 판단을 분리하여 반복되는 LLM 응답 생성을 줄일 수 있습니다.',why_selected:'관측된 코드에서 같은 짧은 판단을 메시지마다 반복하는 이 지점을 선정했습니다.',repetition_basis:'messages 반복문 안에서 항목별 모델 호출을 합니다.',state_inputs:[{name:'message 원문',evidence_id:e.id}],fallback:'입력이 부족하거나 판단이 불확실하면 기존 LLM 경로를 사용합니다.',compared_evidence_ids:calls.map(e=>e.id)
  }]:[]};
 }};
 const server=await startControlCenter(loadHostConfig(paths.runtimeConfig),{workModel});
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];
 page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[])});
 await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
 await mkdir('tests/evidence/phase68',{recursive:true});
 for(const width of [1280,390]){
  await page.setViewportSize({width,height:1000});await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.locator('#open-import').click();await page.locator('[data-import-route="workflow"]').click();
  await page.locator('#import-path').fill(project);await page.locator('#scan-import').click();
  await page.locator('.jev-recommendation').waitFor();assert.equal(await page.locator('.jev-recommendation').count(),1);
  assert.equal(await page.locator('#import-jev').count(),0);assert.equal(await page.locator('#import-cost').isChecked(),false);
  assert.match(await page.locator('.jev-recommendations').innerText(),/Jev 추천 · 한 곳/u);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('.jev-recommendation').screenshot({path:`tests/evidence/phase68/single-${width}.png`});
  // No cost consent: saving still works and preserves the LLM/code route.
  await page.locator('#accept-import').click();await page.locator('#jev-toggle').waitFor();
  assert.equal(await page.locator('#jev-toggle').textContent(),'Jev 켜기');assert.equal(await page.locator('#jev-toggle').isDisabled(),true);
  await page.locator('#jev-cost').check();await page.locator('#jev-toggle').click();
  await page.waitForFunction(()=>document.getElementById('jev-toggle')?.textContent==='Jev 끄기');
  await page.locator('#jev-toggle').click();await page.waitForFunction(()=>document.getElementById('jev-toggle')?.textContent==='Jev 켜기');
  await page.locator('#back').click();await page.locator('#open-import').click();await page.locator('[data-import-route="workflow"]').click();
  await page.locator('#import-path').fill(plain);await page.locator('#scan-import').click();await page.locator('#accept-import').waitFor();
  assert.equal(await page.locator('.jev-recommendation').count(),0);assert.equal(await page.locator('#import-cost').count(),0);
  assert.match(await page.locator('#import-preview').innerText(),/Jev 없이 기존 AI와 코드로 진행합니다/u);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.locator('#accept-import').click();await page.locator('#jev-toggle').waitFor();
  assert.equal(await page.locator('#jev-toggle').textContent(),'Jev 켜기');
 }
 assert.equal(modelCalls,4);
});
