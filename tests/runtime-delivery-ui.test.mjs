import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir} from 'node:fs/promises';
import {chromium} from 'playwright';
import {settingsHtml} from '../dist/observability/settings-ui.js';
import {workHtml} from '../dist/observability/work-ui.js';

test('delivery onboarding, new Work fields and future-only destination modal use configured targets without exposing secrets',async t=>{
  await mkdir('tests/evidence/phase111',{recursive:true});
  const browser=await chromium.launch({headless:true});
  let delivery={revision:0,targets:[],default_target_ids:['app']};
  const posted={settings:[],settingsHeaders:[],starts:[],work:[]};
  const json=(res,value,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  const settings={revision:0,configured:true,onboarding_step:4,selection:{mode:'subscription',client:'auto',client_models:{},api_provider:'openai',api_model:'',api_base_url:'',reasoning:'low',jev:'off'},computer:{connected:true},work_model_data:{editable:false,approved:false}};
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,'http://127.0.0.1');
    if(url.pathname==='/settings'){res.writeHead(200,{'content-type':'text/html'});res.end(settingsHtml('fixture'));return;}
    if(url.pathname==='/'){res.writeHead(200,{'content-type':'text/html'});res.end(workHtml('fixture'));return;}
    if(url.pathname==='/settings/activity'){res.writeHead(204);res.end();return;}
    if(url.pathname==='/settings/status'){json(res,settings);return;}
    if(url.pathname==='/settings/mcp'){json(res,{registered_count:1,windows_bridge:null});return;}
    if(url.pathname==='/settings/bootstrap'){json(res,{});return;}
    if(url.pathname==='/delivery/status'){json(res,delivery);return;}
    if(url.pathname==='/delivery/settings'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));posted.settings.push(body);posted.settingsHeaders.push(req.headers['x-agent-driver']);
      delivery={revision:delivery.revision+1,targets:body.targets.map(({id,platform,label})=>({id,platform,label,configured:true,connection:'stored_unverified'})),default_target_ids:body.default_target_ids};json(res,delivery);return;
    }
    if(url.pathname==='/work/board'){json(res,{works:[]});return;}
    if(url.pathname==='/work/start'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);posted.starts.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));json(res,{work_id:'work1',admission:{}});return;
    }
    if(url.pathname==='/work/delivery'&&req.method==='GET'){json(res,{revision:0,target_ids:['app'],authority:'office',deliveries:[]});return;}
    if(url.pathname==='/work/delivery'&&req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));posted.work.push(body);json(res,{revision:body.revision+1,target_ids:body.target_ids,authority:'office',deliveries:[]});return;
    }
    json(res,{error:'fixture route unavailable'},404);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base='http://127.0.0.1:'+server.address().port;
  const page=await browser.newPage({viewport:{width:390,height:844}});
  await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/settings');
  await page.locator('#delivery-targets').waitFor();
  await page.getByRole('button',{name:'Telegram 추가'}).click();
  const card=page.locator('[data-delivery-target]').last();
  const id=await card.getAttribute('data-delivery-target');
  await card.locator('[data-target-label]').fill('운영 알림');
  await card.locator('[data-target-token]').fill('123456:fixture-secret-token');
  await card.locator('[data-target-chat]').fill('123456789');
  await page.locator('#delivery-defaults input[value="'+id+'"]').check();
  await page.locator('#save-delivery').click();
  await page.getByText('전달 설정을 저장했습니다.',{exact:false}).waitFor();
  assert.equal(posted.settings.length,1);
  assert.equal(posted.settingsHeaders[0],'human-office');
  assert.deepEqual(posted.settings[0].default_target_ids,['app',id]);
  assert.equal(posted.settings[0].targets[0].telegram_bot_token,'123456:fixture-secret-token');
  assert.equal(await page.locator('[data-target-token]').inputValue(),'');
  assert.equal((await page.content()).includes('fixture-secret-token'),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'tests/evidence/phase111/delivery-settings-mobile.png',fullPage:true});
  await page.setViewportSize({width:1440,height:900});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'tests/evidence/phase111/delivery-settings-desktop.png',fullPage:true});
  await page.goto(base+'/');
  await page.locator('#intake-delivery-choices input[value="'+id+'"]').waitFor();
  await page.locator('#prompt').fill('지난달 매출을 요약해 줘');
  await page.locator('#completion-condition').fill('월별 합계와 근거가 표시되면 완료');
  await page.locator('#intake-delivery-choices input[value="'+id+'"]').check();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'tests/evidence/phase111/new-work-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'tests/evidence/phase111/new-work-mobile.png',fullPage:true});
  await page.locator('#submit-work').click();
  await page.waitForFunction(()=>document.querySelector('#submit-work')?.disabled===false);
  assert.equal(posted.starts.length,1);
  assert.equal(posted.starts[0].completion_condition,'월별 합계와 근거가 표시되면 완료');
  assert.deepEqual(posted.starts[0].delivery_target_ids,['app',id]);
  const stageTone=await page.evaluate(()=>({
    partial:deliveryStageHtml({delivery:{target_ids:['app'],deliveries:[{channel:'app',status:'available',authority:'office'}]},results:[{work_completion_verified:false}],stages:[]}),
    complete:deliveryStageHtml({delivery:{target_ids:['app'],deliveries:[{channel:'app',status:'available',authority:'office'}]},results:[{work_completion_verified:true}],stages:[]})
  }));
  assert.match(stageTone.partial,/t-pend/u);
  assert.match(stageTone.partial,/검증 대기/u);
  assert.match(stageTone.complete,/t-done/u);
  const reasons=await page.evaluate(()=>{app.innerHTML='<ul class="delivery-state-list"><li>전달 실패</li></ul><article class="work-result"><div class="result-deliveries"><p>전달 실패</p></div></article>';const row={channel:'telegram',status:'failed',reason:'DELIVERY_PROVIDER_HTTP_401'};decorateDeliveryReasons({delivery:{deliveries:[row]},results:[{deliveries:[row]}]});return {stage:app.querySelector('.delivery-state-list').textContent,result:app.querySelector('.delivery-reason').textContent,unknown:deliveryReasonLabel('token-secret-untrusted')};});
  assert.match(reasons.stage,/인증 또는 권한/u);
  assert.match(reasons.result,/인증 또는 권한/u);
  assert.doesNotMatch(reasons.unknown,/token-secret/u);
  await page.evaluate(()=>{detail={id:'work1'};app.innerHTML='<button type="button" id="delivery-stage">결과 전달</button>';});
  await page.locator('#delivery-stage').click();
  await page.locator('#delivery-save').waitFor();
  await page.screenshot({path:'tests/evidence/phase111/delivery-modal-mobile.png',fullPage:true});
  await page.locator('#delivery-dialog input[value="'+id+'"]').check();
  await page.locator('#delivery-save').click();
  await page.waitForFunction(()=>!document.querySelector('#delivery-dialog')?.open);
  assert.deepEqual(posted.work[0],{work_id:'work1',revision:0,target_ids:['app',id]});
  const english=await browser.newPage({viewport:{width:390,height:844}});
  english.on('pageerror',error=>errors.push(error.message));
  await english.goto(base+'/settings');
  await english.getByRole('heading',{name:'Result delivery',exact:true}).waitFor();
  assert.equal(await english.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await english.goto(base+'/');
  await english.getByText('Work instructions',{exact:true}).waitFor();
  await english.getByText('How to receive the result',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
});
