import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {workHtml} from '../dist/observability/work-ui.js';

test('runtime fixture semantic stage activity is labeled as dated history without changing timeline event meaning',async t=>{
  const server=createServer((req,res)=>{
    if(req.url==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(workHtml('fixture'));return;}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({works:[],targets:[],default_target_ids:['app']}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  const stage={id:'stage-1',label:'Check result',objective:'Evidence exists',semantic:true,status:'succeeded',verified:true,attempts:1,executor:'playwright',activities:[
    {kind:'tool.started',summary:'Running result read.',created_at:'2026-09-30T03:41:29.312Z',metadata:{tool_name:'office_result_read'}},
    {kind:'model.started',summary:'Selecting the next Work action.',created_at:'2026-09-30T03:41:29.325Z',metadata:{}},
    {kind:'stage.reported',summary:'Stage result reported.',created_at:'2026-09-30T03:41:48.927Z',metadata:{}}
  ]};
  for(const [lang,expected,historyLabel,pendingLabel] of [
    ['ko','단계 실행 보고 · 이후 검증 완료','최근 활동 기록','업무 단계 실행 보고 · 독립 검증 대기'],
    ['en','Stage execution reported · later verified','Recent activity history','Stage execution reported · independent verification pending']
  ]){
    const page=await browser.newPage({viewport:{width:390,height:844}});
    await page.addInitScript(value=>localStorage.setItem('office-lang',value),lang);
    await page.goto(base+'/');
    const rendered=await page.evaluate(value=>{
      const html=stageCardHtml(value,0);
      app.innerHTML=html;
      return {timelineLabel:activitySummary(value.activities.at(-1)),stageStatus:app.querySelector('.step strong')?.textContent,history:app.querySelector('.stage-activity-caption')?.textContent,times:[...app.querySelectorAll('.stage-activities time')].map(node=>node.getAttribute('datetime')),overflow:document.documentElement.scrollWidth>innerWidth};
    },stage);
    assert.match(await page.locator('.stage-activities').innerText(),new RegExp(expected,'u'));
    assert.equal(rendered.history,historyLabel);
    assert.equal(rendered.timelineLabel,pendingLabel,'Global timeline retains event-time wording');
    assert.deepEqual(rendered.times,stage.activities.map(row=>row.created_at).reverse());
    assert.equal(rendered.overflow,false);
    assert.match(rendered.stageStatus,lang==='ko'?/검증 완료/u:/Verified/u);
    if(lang==='en'){
      const unverified=await page.evaluate(value=>stageCardHtml({...value,status:'execution_completed',verified:false},0),stage);
      assert.match(unverified,/Stage execution reported · independent verification pending/u);
      assert.doesNotMatch(unverified,/later verified/u);
      await mkdir('tests/evidence/phase111',{recursive:true});
      await page.screenshot({path:'tests/evidence/phase111/stage-history-mobile.png',fullPage:true});
    }
    await page.close();
  }
});
