import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {readWorkIntakeOptions} from '../dist/work/intake-options.js';
import {WorkDeliverySettings} from '../dist/work/delivery-settings.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';

const proposal={title:'공식 문서 확인',desired_outcome:'공식 문서의 결과를 정리한다',completion_checks:[{id:'result',result:'공식 문서의 제목과 URL을 확인한다',evidence:'원문 관측 영수증'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'office-intake-options-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'intake-options',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},packs:{sources:[],targets:[],models:'off'}}));
  let received;const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:{calls:[],async call(_purpose,instructions,input){received={instructions,input};return structuredClone(proposal);}}});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});return {api,config,received:()=>received};
}
test('runtime user completion and delivery choices survive definition, restart and idempotent intake without granting a send',async t=>{
  const x=await setup(t),input={request_id:'explicit-conditions',prompt:'공식 문서를 요약해줘',completion_condition:'제목과 원문 URL을 제공하고 확인되지 않은 사실은 구분',delivery_target_ids:['app']};
  const work=await x.api.call('runtime_work_start',input);
  assert.equal(work.definition_status,'ready');
  assert.deepEqual(x.received().input.user_intake,{completion_condition:input.completion_condition,delivery_target_ids:['app']});
  assert.match(x.received().instructions,/explicit completion requirement/u);
  assert.deepEqual(x.api.workResults.selection(x.config.project.id,work.work_id).target_ids,['app']);
  assert.equal(x.api.workResults.list(x.config.project.id,work.work_id).length,0);
  const reopened=new PackStore(x.config.dbPath);try{assert.deepEqual(readWorkIntakeOptions(reopened,x.config.project.id,work.work_id),x.received().input.user_intake);}finally{reopened.close();}
  const repeated=await x.api.call('runtime_work_start',input);assert.equal(repeated.work_id,work.work_id);assert.equal(repeated.deduplicated,true);
  await assert.rejects(x.api.call('runtime_work_start',{...input,completion_condition:'다른 완료 기준'}),/WORK_REQUEST_ID_CONFLICT/u);
  await assert.rejects(x.api.call('runtime_work_start',{...input,delivery_target_ids:[]}),/WORK_REQUEST_ID_CONFLICT/u);
});
test('runtime old one-line intake derives completion checks and remains app-only without messenger selection',async t=>{
  const x=await setup(t),work=await x.api.call('runtime_work_start',{request_id:'one-line',prompt:'공식 문서를 요약해줘'});
  assert.equal(work.definition_status,'ready');assert.deepEqual(x.received().input.user_intake,{completion_condition:null,delivery_target_ids:null});
  assert.deepEqual(x.api.workResults.selection(x.config.project.id,work.work_id).target_ids,['app']);
  const legacy=x.api.store.beginWork(x.config.project.id,'legacy-options','이전 업무','quick').work;
  assert.deepEqual(readWorkIntakeOptions(x.api.store,x.config.project.id,legacy.id),{completion_condition:null,delivery_target_ids:null});
});
test('Runtime API rejects an unavailable destination before allocating a durable Work',async t=>{
  const x=await setup(t),settings=WorkDeliverySettings.fromConfig(x.config);
  settings.save({revision:0,targets:[{id:'updates',platform:'telegram',label:'Updates',telegram_bot_token:'123456789:'+'A'.repeat(32),telegram_chat_id:'-1001234567890'}],default_target_ids:['app']});
  const base={request_id:'validate-before-begin',prompt:'공식 문서를 요약해줘'};
  await assert.rejects(x.api.call('runtime_work_start',{...base,delivery_target_ids:['missing']}),/RESULT_DELIVERY_TARGET_UNAVAILABLE/u);
  assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_work WHERE project_id=?').get(x.config.project.id).n,0);
  const work=await x.api.call('runtime_work_start',{...base,delivery_target_ids:['updates']});
  assert.equal(work.definition_status,'ready');assert.deepEqual(x.api.workResults.selection(x.config.project.id,work.work_id).target_ids,['updates']);
});
test('Runtime API restart dispatches only saved verified pending deliveries without rerunning Work',async t=>{
  const x=await setup(t),settings=WorkDeliverySettings.fromConfig(x.config);
  settings.save({revision:0,targets:[{id:'updates',platform:'telegram',label:'Updates',telegram_bot_token:'123456789:'+'A'.repeat(32),telegram_chat_id:'-1001234567890'}],default_target_ids:['app']});
  initWorkSupervisor(x.api.store);
  const work=x.api.store.beginWork(x.config.project.id,'saved-pending','Saved report','quick').work,runId=randomUUID(),stamp=new Date().toISOString();
  x.api.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,x.config.project.id,work.id,work.revision,'succeeded',JSON.stringify({summary:'Verified local report',completion_verified:true}),x.config.fingerprint,0,stamp,stamp);
  x.api.workResults.setSelection(x.config.project.id,work.id,{revision:0,target_ids:['updates']});
  const output=x.api.workResults.record(x.config.project.id,{work_id:work.id,run_id:runId,source_kind:'client',work_revision:work.revision,summary:'Verified local report',text:'Verified local report'});
  assert.equal(output.deliveries.find(item=>item.channel==='telegram').status,'pending');
  x.api.close();await x.api.drain();
  const originalFetch=globalThis.fetch,calls=[];
  globalThis.fetch=async input=>{const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);assert.equal(url.hostname,'api.telegram.org');calls.push(url.pathname);return new Response(JSON.stringify({ok:true,result:{message_id:43,chat:{id:-1001234567890}}}),{status:200});};
  const reopened=new RuntimeApi(x.config,{swarmModel:{async call(){throw Error('WORK_MUST_NOT_RERUN');}}});
  try{
    let current;
    for(let index=0;index<100;index++){current=reopened.workResults.get(x.config.project.id,work.id,output.id);if(current.deliveries.some(item=>item.channel==='telegram'&&item.status==='delivered'))break;await delay(20);}
    assert.equal(current.deliveries.find(item=>item.channel==='telegram').status,'delivered');
    assert.equal(calls.length,1);assert.equal(reopened.store.officeRuns(x.config.project.id,work.id).length,0);
    assert.equal(reopened.workResults.pendingWorkIds(x.config.project.id).length,0);
  }finally{reopened.close();await reopened.drain();globalThis.fetch=originalFetch;}
});
