import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';
import {importHermesWork} from '../dist/work/hermes.js';

test('runtime fixture Hermes UI sends, approves, reviews, pauses and isolates drafts on desktop and mobile',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hermes-ui-'));
 const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),store=new PackStore(config.dbPath);store.registerProject(config.project);
 const definition={title:'첫 번째 업무',goal:'테스트 자료 확인',checks:['근거 확인'],steps:['관측','결과 검토'],family:'portal.collect',history:[],instruction:'외부 변경 금지'};
 const first=importHermesWork(store,config.project.id,'first',definition),second=importHermesWork(store,config.project.id,'second',{...definition,title:'다른 업무'});store.close();
 let prompts=0,approvals=0;
 const server=await startControlCenter(config,{hermes:{transport:callbacks=>({async request(method,args){
  if(method==='initialize')return {};
  if(method==='session/new')return {sessionId:'fixture-owned'};
  if(method==='session/prompt'){
   prompts++;
   await new Promise(resolve=>callbacks.permission({sessionId:args.sessionId,toolCall:{title:'테스트 자료 읽기'},options:[{optionId:'once',name:'한 번 허용',kind:'allow_once'},{optionId:'never',name:'거절',kind:'reject_once'}]},answer=>{assert.equal(answer.outcome.optionId,'once');approvals++;resolve()}));
   callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'실제 사이트를 실행하지 않은 검증 답변입니다.'}}});return {stopReason:'end_turn'};
  }
 },notify(){},async close(){}})}});
 const browser=await chromium.launch({headless:true}),page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[])});
 await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
 await page.goto(server.url+'?work='+first);
 await page.locator('#hermes-instruction').waitFor();
 await page.locator('[data-hermes-action="pause"]').click();await page.locator('[data-hermes-action="resume"]').waitFor();
 await page.locator('[data-hermes-action="resume"]').click();await page.locator('[data-hermes-action="pause"]').waitFor();
 await page.locator('#hermes-instruction').fill('자료를 읽고 답변해줘');await page.locator('#hermes-send').click();assert.equal(prompts,0);
 await page.locator('#hermes-cost').check();await page.evaluate(()=>loadDetail());assert.equal(await page.locator('#hermes-cost').isChecked(),true);
 await page.locator('#hermes-send').click();await page.locator('[data-hermes-option="once"]').waitFor();assert.equal(approvals,0);
 await page.locator('[data-hermes-option="once"]').click();await page.locator('[data-hermes-action="review"]').waitFor();assert.equal(approvals,1);assert.equal(prompts,1);
 assert.match(await page.locator('.coding-answer').innerText(),/검증 답변/u);
 await page.locator('[data-hermes-action="review"]').click();await page.waitForFunction(()=>!document.getElementById('hermes-send').disabled);
 await page.locator('#hermes-instruction').fill('이 업무의 개인 초안');await page.locator('#hermes-cost').check();await page.locator('#back').click();
 await page.locator('[data-work="'+second+'"]').click();await page.locator('#hermes-instruction').waitFor();assert.equal(await page.locator('#hermes-instruction').inputValue(),'');assert.equal(await page.locator('#hermes-cost').isChecked(),false);
 for(const width of [1280,390]){await page.setViewportSize({width,height:850});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('#hermes-send').isVisible(),true)}
 assert.equal(prompts,1);
});
