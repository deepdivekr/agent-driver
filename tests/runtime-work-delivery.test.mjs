import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PackStore} from '../dist/packs/store.js';
import {WorkDeliverySettings} from '../dist/work/delivery-settings.js';
import {createDeliveryConnector} from '../dist/work/delivery-connectors.js';
import {WorkResults} from '../dist/work/results.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-delivery-')),dbPath=join(root,'data','office.db'),store=new PackStore(dbPath),project='delivery-test',workId=randomUUID(),runId=randomUUID(),now=new Date().toISOString();
  store.hermesState.prepare('INSERT INTO office_work VALUES(?,?,?,?,?,?)').run(workId,project,'Saved delivery test','Verified receipt',now,now);
  store.hermesState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,work_revision INTEGER,state TEXT,result TEXT)');
  store.hermesState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?)').run(runId,project,workId,0,'succeeded',JSON.stringify({completion_verified:true,summary:'Verified local result'}));
  const settings=WorkDeliverySettings.fromConfig({dbPath});
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {root,dbPath,store,project,workId,runId,settings};
}
const telegram={id:'updates',platform:'telegram',label:'My chat',telegram_bot_token:'123456789:'+'A'.repeat(32),telegram_chat_id:'-1001234567890'};
test('delivery settings persist private credentials and expose only stored, unverified configuration',async t=>{
  const x=await fixture(t),publicState=x.settings.save({revision:0,targets:[telegram],default_target_ids:['app','updates']});
  assert.equal(publicState.targets[0].connection,'stored_unverified');assert.equal(JSON.stringify(publicState).includes(telegram.telegram_bot_token),false);
  assert.deepEqual(publicState.default_target_ids,['app','updates']);
  const saved=await readFile(x.settings.path,'utf8');assert.equal(saved.includes(telegram.telegram_bot_token),true);
  if(process.platform!=='win32')assert.equal((await stat(x.settings.path)).mode&0o077,0);
  assert.throws(()=>x.settings.save({revision:0,targets:[],default_target_ids:['app']}),/DELIVERY_SETTINGS_CONFLICT/u);
  assert.throws(()=>x.settings.save({revision:1,targets:[{...telegram,webhook_url:'https://127.0.0.1/secret'}],default_target_ids:['app']}));
  assert.throws(()=>x.settings.save({revision:1,targets:[{id:'bad',platform:'slack',label:'Bad',webhook_url:'https://hooks.slack.com.evil.test/services/A/B/C'}],default_target_ids:['bad']}),/DELIVERY_WEBHOOK_INVALID/u);
  const retained=x.settings.save({revision:1,targets:[{id:'updates',platform:'telegram',label:'Renamed'}],default_target_ids:['updates']});
  assert.equal(retained.targets[0].label,'Renamed');assert.equal(x.settings.target('updates').telegram_bot_token,telegram.telegram_bot_token);
});
test('verified result selects multiple targets durably, sends once and does not replay on changed preference',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram,{id:'team',platform:'slack',label:'Team',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'}],default_target_ids:['app']});
  const calls=[];const connectors=['updates','team'].map((id,index)=>({id,channel:index?'slack':'telegram',async send(input){calls.push({id,key:input.idempotency_key});return {status:'delivered',receipt_id:`fixture:${id}`};}}));
  const results=new WorkResults(x.store,connectors,x.settings);
  assert.deepEqual(results.selection(x.project,x.workId).target_ids,['app']);
  assert.throws(()=>results.setSelection(x.project,x.workId,{revision:1,target_ids:['updates']}),/RESULT_DELIVERY_SELECTION_CONFLICT/u);
  results.setSelection(x.project,x.workId,{revision:0,target_ids:['app','updates','team']});
  const output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Verified local result',text:'Confirmed facts'});
  assert.equal(output.work_completion_verified,true);assert.equal(output.deliveries.filter(d=>d.status==='pending').length,2);assert.equal(calls.length,0);
  assert.deepEqual(results.pendingWorkIds(x.project),[x.workId]);
  await results.dispatchPending(x.project,x.workId);assert.equal(calls.length,2);
  assert.deepEqual(results.pendingWorkIds(x.project),[]);
  await results.dispatchPending(x.project,x.workId);assert.equal(calls.length,2);
  const reopened=new WorkResults(x.store,connectors,x.settings);reopened.setSelection(x.project,x.workId,{revision:1,target_ids:['app']});
  assert.equal(reopened.get(x.project,x.workId,output.id).deliveries.filter(d=>d.status==='delivered').length,2);
  assert.equal(reopened.get(x.project,x.workId,output.id).deliveries.filter(d=>d.status==='pending').length,0);
});
test('credential drift blocks pending sends and a provider timeout needs reconciliation',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram],default_target_ids:['updates']});let calls=0;
  const connector={id:'updates',channel:'telegram',async send(){calls++;throw Error('transport response lost');}};
  const results=new WorkResults(x.store,[connector],x.settings);results.setSelection(x.project,x.workId,{revision:0,target_ids:['updates']});
  const output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Verified local result'});
  x.settings.save({revision:1,targets:[{...telegram,telegram_chat_id:'-1001234567891'}],default_target_ids:['updates']});
  await results.dispatchPending(x.project,x.workId);assert.equal(calls,0);
  assert.equal(results.get(x.project,x.workId,output.id).deliveries.find(d=>d.channel==='telegram').reason,'DELIVERY_TARGET_CHANGED');
  const next=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,result_key:'new',summary:'New verified result'});
  await results.dispatchPending(x.project,x.workId);assert.equal(calls,1);
  const row=results.get(x.project,x.workId,next.id).deliveries.find(d=>d.channel==='telegram');assert.equal(row.status,'reconciliation_required');assert.equal(row.can_retry,false);
  await results.dispatchPending(x.project,x.workId);assert.equal(calls,1);
});
test('a changed final destination applies to the current unsent verified receipt',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram,{id:'team',platform:'slack',label:'Team',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'}],default_target_ids:['app']});
  const sends=[];const connectors=['updates','team'].map((id,index)=>({id,channel:index?'slack':'telegram',async send(){sends.push(id);return {status:'delivered',receipt_id:`fixture:${id}`};}}));
  const results=new WorkResults(x.store,connectors,x.settings);results.setSelection(x.project,x.workId,{revision:0,target_ids:['updates']});
  const output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Verified local result'});
  results.setSelection(x.project,x.workId,{revision:1,target_ids:['team']});
  const before=results.get(x.project,x.workId,output.id).deliveries;
  assert.equal(before.find(d=>d.target_alias==='updates').reason,'DELIVERY_SELECTION_CHANGED');assert.equal(before.find(d=>d.target_alias==='team').status,'pending');
  await results.dispatchPending(x.project,x.workId);assert.deepEqual(sends,['team']);
});
test('an uncertain delivery cannot be rerouted automatically to another destination',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram,{id:'team',platform:'slack',label:'Team',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'}],default_target_ids:['app']});
  const sends=[];const connectors=[{id:'updates',channel:'telegram',async send(){sends.push('updates');throw Error('response lost');}},{id:'team',channel:'slack',async send(){sends.push('team');return {status:'delivered',receipt_id:'fixture:team'};}}];
  const results=new WorkResults(x.store,connectors,x.settings);results.setSelection(x.project,x.workId,{revision:0,target_ids:['updates']});
  const output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Verified local result'});
  await results.dispatchPending(x.project,x.workId);results.setSelection(x.project,x.workId,{revision:1,target_ids:['team']});
  assert.equal(results.get(x.project,x.workId,output.id).deliveries.some(d=>d.target_alias==='team'),false);
  await results.dispatchPending(x.project,x.workId);assert.deepEqual(sends,['updates']);
});
test('shutdown fence stops new target sends after an in-flight receipt settles',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram,{id:'team',platform:'slack',label:'Team',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'}],default_target_ids:['app']});
  let open=true;const sends=[];const connectors=['updates','team'].map((id,index)=>({id,channel:index?'slack':'telegram',async send(){sends.push(id);open=false;return {status:'delivered',receipt_id:`fixture:${id}`};}}));
  const results=new WorkResults(x.store,connectors,x.settings);results.setSelection(x.project,x.workId,{revision:0,target_ids:['updates','team']});
  const output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Verified local result'});
  await results.dispatchPending(x.project,x.workId,()=>open);assert.deepEqual(sends,['updates']);
  assert.equal(results.get(x.project,x.workId,output.id).deliveries.filter(d=>d.status==='pending').length,1);
});
test('an adopted original bot without an import row never gains Office delivery authority',async t=>{
  const x=await fixture(t);x.settings.save({revision:0,targets:[telegram],default_target_ids:['updates']});
  x.store.hermesState.exec('CREATE TABLE office_work_adoption(work_id TEXT PRIMARY KEY,project_id TEXT)');
  x.store.hermesState.prepare('INSERT INTO office_work_adoption VALUES(?,?)').run(x.workId,x.project);
  const results=new WorkResults(x.store,[],x.settings),output=results.record(x.project,{work_id:x.workId,run_id:x.runId,source_kind:'client',work_revision:0,summary:'Original bot result'});
  assert.equal(output.deliveries.some(d=>d.channel==='telegram'&&d.authority==='office'),false);
  assert.throws(()=>results.setSelection(x.project,x.workId,{revision:0,target_ids:['updates']}),/RESULT_ORIGINAL_DELIVERY_AUTHORITY/u);
  assert.throws(()=>results.requestDelivery(x.project,x.workId,output.id,{channel:'telegram',connector_id:'updates',target_alias:'updates',acknowledged:true}),/RESULT_ORIGINAL_DELIVERY_AUTHORITY/u);
});
test('provider adapters use bounded POSTs and require provider acknowledgements',async()=>{
  assert.throws(()=>createDeliveryConnector({id:'unsafe',platform:'slack',label:'Unsafe',webhook_url:'https://127.0.0.1/services/AAAA/BBBB/CCCC'}),/DELIVERY_WEBHOOK_INVALID/u);
  const result={id:randomUUID(),summary:'Verified',text:'A'.repeat(10000),artifacts:[]};
  const calls=[];const transport=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({ok:true,result:{message_id:42,chat:{id:-1001234567890}}}),{status:200});};
  const telegramConnector=createDeliveryConnector(telegram,transport);
  const ack=await telegramConnector.send({result,target_alias:'updates',idempotency_key:'unique'});
  assert.equal(ack.status,'delivered');assert.match(ack.receipt_id,/telegram:/u);
  assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].url,/sendDocument$/u);
  assert.equal(calls[0].options.body.get('document').name,'result.txt');assert.match(await calls[0].options.body.get('document').text(),/A{1000}/u);
  const discord=createDeliveryConnector({id:'server',platform:'discord',label:'Server',webhook_url:'https://discord.com/api/webhooks/12345678901234567890/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'},async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:'12345678901234567890'}),{status:200});});
  assert.equal((await discord.send({result,target_alias:'server',idempotency_key:'unique'})).status,'delivered');assert.match(calls[1].url,/\?wait=true$/u);
  assert.deepEqual(JSON.parse(calls[1].options.body.get('payload_json')).allowed_mentions,{parse:[]});assert.equal(calls[1].options.body.get('files[0]').name,'result.txt');
  const slack=createDeliveryConnector({id:'slack',platform:'slack',label:'Slack',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'},async(url,options)=>{calls.push({url,options});return new Response('ok',{status:200});});
  assert.equal((await slack.send({result,target_alias:'slack',idempotency_key:'unique'})).status,'delivered');
  assert.equal(JSON.parse(calls[2].options.body).text.includes(result.text),true);
  for(const [http,effect] of [[408,'uncertain'],[429,'not_dispatched']]){
    const rejected=createDeliveryConnector({id:'slack',platform:'slack',label:'Slack',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'},async()=>new Response('rejected',{status:http}));
    assert.equal((await rejected.send({result,target_alias:'slack',idempotency_key:'unique'})).effect_state,effect);
  }
});
