import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {chromium} from 'playwright';
import {workHtml} from '../dist/observability/work-ui.js';

// Fixture UI/HTTP only. No real model, browser account, remote bot, schedule,
// filesystem mutation or personal Work database is touched.
function detail(){
  return {id:randomUUID(),title:'Personal source research',goal:'Read a public article.',prompt:'Read a public article.',work_status:'ready',display_status:'ready',mode:'quick',revision:3,paused:false,spec:null,questions:[],answers:{},route:null,pack:null,run_id:null,run_status:null,runs:[],client_handoffs:[],swarm:false,coding:false,agent_count:0,verified_steps:0,total_steps:0,progress_percent:null,progress_basis:'No observed steps',stages:[],control:null,work_control:{can_pause:true,paused:false,revision:3,scope:'future_dispatch'},events:[],completion_verified:false,completion_note:'No completion evidence.',execution:{live:false,active_workers:0,basis:'no_active_lease'},execution_action:{executor:'client',can_execute:true,reason:null},supervisor:null,schedule:null,adoption:null,adoption_eligible:false,jev:null,file_activity:null,imported_connection:null,imported_coding:null,coding_attach:null,coding_dialog:null,activity:[{id:'saved-event',kind:'defined',summary:'Saved record',created_at:'2026-09-29T10:00:00.000Z',metadata:{}}],observed_sources:[],current_operation:null,runtime_reload_available:false,runtime_configuration:{state:'idle',reason:null},results:[],lifecycle:{state:'connected',revision:0,work_revision:3,updated_at:null}};
}
async function fixture(t,{language='ko',width=1280,reject=null}={}){
  const value=detail(),calls=[],streams=new Set();let rejected=reject;
  const board=()=>({format:1,project_id:'lifecycle-ui-fixture',generated_at:'2026-09-29T10:00:00.000Z',works:value.lifecycle.state==='removed'?[]:[{id:value.id,title:value.title,full_title:value.title,status:value.lifecycle.state==='connected'?'ready':value.lifecycle.state,updated_at:'2026-09-29T10:00:00.000Z',lifecycle:value.lifecycle,has_contract:true}],auth_attention_count:0});
  const json=(response,value,status=200)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(value))};
  const emit=()=>{for(const response of streams){response.write('event: board\ndata: '+JSON.stringify(board())+'\n\n');response.write('event: activity\ndata: '+JSON.stringify({work_id:value.id,lifecycle:value.lifecycle,display_status:value.display_status,activity:value.activity})+'\n\n')}};
  const server=createServer(async(request,response)=>{
    const path=new URL(request.url,'http://127.0.0.1').pathname.replace('/office/','');
    if(request.method==='GET'){
      if(path===''){response.writeHead(200,{'content-type':'text/html'});response.end(workHtml('lifecycle-fixture'));return}
      if(path==='work/board'){json(response,board());return}
      if(path==='work/detail'){json(response,value);return}
      if(path==='settings/status'){json(response,{work_model_data:{editable:true,approved:true}});return}
      if(path==='work/events'){response.writeHead(200,{'content-type':'text/event-stream'});streams.add(response);emit();response.on('close',()=>streams.delete(response));return}
      response.writeHead(404);response.end();return;
    }
    let raw='';for await(const chunk of request)raw+=chunk;
    const body=JSON.parse(raw||'{}');calls.push({path,body,headers:request.headers});
    if(path!=='work/lifecycle'){json(response,{error:'UNEXPECTED_MUTATION'},409);return}
    if(rejected){json(response,{error:rejected},409);return}
    if(body.work_id!==value.id||body.revision!==value.lifecycle.revision||body.work_revision!==value.lifecycle.work_revision||body.confirmed!==true){json(response,{error:'WORK_REVISION_CONFLICT'},409);return}
    value.lifecycle={...value.lifecycle,state:body.action==='disconnect'?'disconnected':'removed',revision:value.lifecycle.revision+1,updated_at:'2026-09-29T10:05:00.000Z'};value.display_status=value.lifecycle.state;value.execution_action=null;value.work_control.can_pause=false;emit();json(response,{work_id:value.id,lifecycle:value.lifecycle,deduplicated:false,original_runtime_unchanged:true,records_preserved:true});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}/office/`,browser=await chromium.launch({headless:true}),context=await browser.newContext({viewport:{width,height:900}}),errors=[];
  await context.addInitScript(lang=>localStorage.setItem('office-lang',lang),language);const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  t.after(async()=>{for(const stream of streams)stream.end();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))});
  return {value,calls,page,url,errors,emit,reject(code){rejected=code}};
}

for(const [language,width] of [['ko',1280],['en',390]])test(`fixture ${language}/${width} disconnect confirms Office-only effects and keeps direct read-only history`,{timeout:20000},async t=>{
  const x=await fixture(t,{language,width});await x.page.goto(x.url+'?work='+x.value.id);await x.page.locator('[data-work-lifecycle="disconnect"]').waitFor();assert.equal(x.calls.length,0);
  await x.page.locator('[data-work-lifecycle="disconnect"]').click();await x.page.locator('#work-lifecycle-dialog[open]').waitFor();const explanation=await x.page.locator('#work-lifecycle-dialog').innerText();assert.match(explanation,language==='en'?/original bot or schedule/u:/원본 봇·예약/u);assert.equal(x.calls.length,0);
  await x.page.locator('#lifecycle-back').click();assert.equal(x.calls.length,0);await x.page.locator('[data-work-lifecycle="disconnect"]').click();await x.page.locator('#lifecycle-confirm').click();await x.page.waitForFunction(()=>document.querySelector('.work-lifecycle-banner')?.textContent.includes(document.documentElement.lang==='en'?'Office disconnected':'Office 연결 끊김'));
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].path,'work/lifecycle');assert.equal(x.calls[0].body.action,'disconnect');assert.equal(x.calls[0].body.confirmed,true);assert.equal(x.calls[0].body.revision,0);assert.equal(x.calls[0].body.work_revision,3);assert.equal(x.calls[0].headers['x-agent-driver'],'human-office');assert.equal(await x.page.locator('#execute-work').count(),0);assert.equal(await x.page.locator('.control-panel button:not(:disabled)').count(),0);assert.match(await x.page.locator('#work-tail-output').textContent(),/Saved record/u);
  await x.page.reload();await x.page.locator('.work-lifecycle-banner').waitFor();assert.equal(await x.page.locator('[data-work-lifecycle="disconnect"]').count(),0);assert.equal(await x.page.locator('[data-work-lifecycle="remove"]').count(),1);assert.equal(x.calls.length,1);assert.equal(await x.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);assert.deepEqual(x.errors,[]);
});

test('fixture removal hides the normal board and counts but retains the historical direct link without any reactivation',{timeout:20000},async t=>{
  const x=await fixture(t);await x.page.goto(x.url+'?work='+x.value.id);await x.page.locator('[data-work-lifecycle="remove"]').click();await x.page.locator('#lifecycle-confirm').click();await x.page.locator('.work-lifecycle-banner').waitFor();assert.equal(x.calls.length,1);assert.equal(x.calls[0].body.action,'remove');assert.equal(await x.page.locator('#execute-work').count(),0);assert.match(await x.page.locator('#work-tail-output').textContent(),/Saved record/u);
  await x.page.locator('#back').click();await x.page.locator('.empty').waitFor();assert.equal(await x.page.locator('[data-count="all"]').textContent(),'');await x.page.goto(x.url+'?work='+x.value.id);await x.page.locator('.work-lifecycle-banner').waitFor();assert.equal(await x.page.locator('[data-work-lifecycle]').count(),0);assert.equal(x.calls.length,1);assert.deepEqual(x.errors,[]);
});

test('fixture failed disconnect is visible in its confirmation dialog and never hides or stops the Work',{timeout:20000},async t=>{
  const x=await fixture(t,{language:'en',reject:'WORK_LIFECYCLE_RECONCILIATION_REQUIRED'});await x.page.goto(x.url+'?work='+x.value.id);await x.page.locator('[data-work-lifecycle="disconnect"]').click();await x.page.locator('#lifecycle-confirm').click();await x.page.locator('#lifecycle-error').getByText(/previous run result is uncertain/i).waitFor();assert.equal(await x.page.locator('#work-lifecycle-dialog[open]').count(),1);assert.equal(x.value.lifecycle.state,'connected');assert.equal(await x.page.locator('#execute-work').count(),1);assert.equal(x.calls.length,1);assert.deepEqual(x.errors,[]);
});

test('fixture SSE lifecycle transition disables visible controls without losing the selected Work or log',{timeout:20000},async t=>{
  const x=await fixture(t);await x.page.goto(x.url+'?work='+x.value.id);await x.page.locator('[data-work-lifecycle="disconnect"]').waitFor();x.value.lifecycle={...x.value.lifecycle,state:'disconnected',revision:1};x.value.display_status='disconnected';x.value.execution_action=null;x.emit();await x.page.locator('.work-lifecycle-banner').waitFor();assert.equal(new URL(x.page.url()).searchParams.get('work'),x.value.id);assert.equal(await x.page.locator('#execute-work').count(),0);assert.equal(await x.page.locator('.control-panel button:not(:disabled)').count(),0);assert.match(await x.page.locator('#work-tail-output').textContent(),/Saved record/u);assert.equal(x.calls.length,0);assert.deepEqual(x.errors,[]);
});
