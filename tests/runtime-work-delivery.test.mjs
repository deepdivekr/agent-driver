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
  // A long result is sent as a message cut to the platform limit, with a note; the complete file stays in the app.
  assert.equal(calls[0].options.redirect,'error');assert.match(calls[0].url,/sendMessage$/u);
  const sent=JSON.parse(calls[0].options.body).text;assert.ok([...sent].length<=4096);assert.match(sent,/A{1000}/u);assert.match(sent,/앞부분만 표시\. 전체 파일은 앱에서/u);
  const discord=createDeliveryConnector({id:'server',platform:'discord',label:'Server',webhook_url:'https://discord.com/api/webhooks/12345678901234567890/ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'},async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({id:'12345678901234567890'}),{status:200});});
  assert.equal((await discord.send({result,target_alias:'server',idempotency_key:'unique'})).status,'delivered');assert.match(calls[1].url,/\?wait=true$/u);
  const discordBody=JSON.parse(calls[1].options.body);assert.deepEqual(discordBody.allowed_mentions,{parse:[]});assert.ok([...discordBody.content].length<=1900);
  const slack=createDeliveryConnector({id:'slack',platform:'slack',label:'Slack',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'},async(url,options)=>{calls.push({url,options});return new Response('ok',{status:200});});
  assert.equal((await slack.send({result,target_alias:'slack',idempotency_key:'unique'})).status,'delivered');
  assert.match(JSON.parse(calls[2].options.body).text,/A{1000}/u);
  for(const [http,effect] of [[408,'uncertain'],[429,'not_dispatched']]){
    const rejected=createDeliveryConnector({id:'slack',platform:'slack',label:'Slack',webhook_url:'https://hooks.slack.com/services/AAAA/BBBB/CCCC'},async()=>new Response('rejected',{status:http}));
    assert.equal((await rejected.send({result,target_alias:'slack',idempotency_key:'unique'})).effect_state,effect);
  }
});

// Plan B1 notification level: what reaches the owner's own messenger.
test('B1: the notification level decides which outcomes are sent, and the message says whether the Work is done or needs the owner',async()=>{
  const {notifies}=await import('../dist/work/results.js'),{deliveryContent}=await import('../dist/work/delivery-connectors.js');
  assert.equal(notifies('results','succeeded',true),true);assert.equal(notifies('results','waiting_auth',false),false);
  assert.equal(notifies('results_and_owner','waiting_auth',false),true);assert.equal(notifies('results_and_owner','awaiting_review',false),true);
  assert.equal(notifies('results_and_owner','retry_wait',false),false,'A transient wait is not a reason to message the owner.');assert.equal(notifies('all','retry_wait',false),true);
  const result={id:'r-1',work_title:'지진 수집',source_status:'succeeded',work_completion_verified:true,summary:'14건을 저장했다.',text:'14건을 저장했다.',artifacts:[{id:'a'}]};
  assert.equal(deliveryContent(result),'지진 수집\n[완료] 검증을 통과했습니다.\n\n14건을 저장했다.\n\n원본 파일은 앱에서 내려받을 수 있습니다.\n\nWork result r-1');
  // The message carries the result itself; a long one is cut at a line end and says so. The file stays in the app.
  const rows=Array.from({length:400},(_,i)=>`2026-10-01T0${i%10}:00:00Z,4.${i%10},Place number ${i}`),long={...result,text:['시각,규모,위치',...rows].join('\n')};
  const short=deliveryContent({...result,text:'시각,규모,위치\n2026-10-01T01:00:00Z,4.6,Offshore'});
  assert.match(short,/— 결과 —\n시각,규모,위치\n2026-10-01T01:00:00Z,4\.6,Offshore\n\nWork result r-1$/u);assert.doesNotMatch(short,/표시\./u);
  const cut=deliveryContent(long);assert.ok([...cut].length<=4000,'Within the Telegram message limit.');
  assert.match(cut,/… \(전체 401줄 중 \d+줄 표시\. 전체 파일은 앱에서 내려받을 수 있습니다\.\)\n\nWork result r-1$/u);assert.ok(cut.includes('시각,규모,위치\n2026-10-01T00:00:00Z,4.0,Place number 0'));
  assert.ok([...deliveryContent(long,1850)].length<=1850,'The same rule fits a smaller platform limit.');
  assert.match(deliveryContent({...result,source_status:'waiting_auth',work_completion_verified:false,artifacts:[]}),/^지진 수집\n\[확인 필요\] 로그인이 필요합니다\./u);
});

// Live: Telegram was reachable over IPv4 but Node gave up after 250 ms per address family and reported ETIMEDOUT.
test('a provider that was never reached is retryable, not an uncertain delivery; an unobserved response stays uncertain',async()=>{
  const {createDeliveryConnector}=await import('../dist/work/delivery-connectors.js'),{neverConnected}=await import('../dist/core/network.js'),net=await import('node:net');
  assert.ok(net.getDefaultAutoSelectFamilyAttemptTimeout()>=2500,'Each address family gets a realistic connection time.');
  const target={id:'tg',platform:'telegram',label:'t',telegram_bot_token:'123456:'+'a'.repeat(30),telegram_chat_id:'42'},result={id:'r-1',work_title:'t',source_status:'succeeded',work_completion_verified:true,summary:'s',text:'s',artifacts:[]};
  const unreachable=Object.assign(new TypeError('fetch failed'),{cause:Object.assign(new AggregateError([Object.assign(new Error('a'),{code:'ETIMEDOUT'}),Object.assign(new Error('b'),{code:'ENETUNREACH'})]),{code:'ETIMEDOUT'})});
  assert.equal(neverConnected(unreachable),true);assert.equal(neverConnected(new DOMException('timed out','TimeoutError')),false);
  assert.deepEqual(await createDeliveryConnector(target,async()=>{throw unreachable;}).send({result,target_alias:'tg',idempotency_key:'k'}),{status:'failed',effect_state:'not_dispatched',reason:'DELIVERY_PROVIDER_UNREACHABLE'});
  assert.deepEqual(await createDeliveryConnector(target,async()=>{throw new DOMException('timed out','TimeoutError');}).send({result,target_alias:'tg',idempotency_key:'k'}),{status:'failed',effect_state:'uncertain',reason:'DELIVERY_RESPONSE_UNOBSERVED'});
});

// Live: a 3,600-character Korean message was delivered, but its 25 KB acknowledgement exceeded the read limit and the
// delivery was recorded as uncertain.
test('a long non-ASCII message is acknowledged: the provider echo fits the response limit',async()=>{
  const {createDeliveryConnector}=await import('../dist/work/delivery-connectors.js');
  const target={id:'tg',platform:'telegram',label:'t',telegram_bot_token:'123456:'+'a'.repeat(30),telegram_chat_id:'42'},text='가'.repeat(3900);
  const echo=JSON.stringify({ok:true,result:{message_id:7,chat:{id:42},text}}).replace(/[\u0080-\uffff]/gu,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
  assert.ok(Buffer.byteLength(echo)>20000);
  const ack=await createDeliveryConnector(target,async()=>new Response(echo,{status:200})).send({result:{id:'r-1',work_title:'t',source_status:'succeeded',work_completion_verified:true,summary:'s',text,artifacts:[]},target_alias:'tg',idempotency_key:'k'});
  assert.equal(ack.status,'delivered');
});

// Live 2026-10-03: image teaching material had to reach the owner's Telegram chat; the connector carried text only.
test('telegram sends the result pictures after the text, one sendPhoto each, and the receipt counts them',async()=>{
  const calls=[];const transport=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify(/sendPhoto$/u.test(url)?{ok:true,result:{message_id:43,chat:{id:-1001234567890}}}:{ok:true,result:{message_id:42,chat:{id:-1001234567890}}}),{status:200});};
  const connector=createDeliveryConnector(telegram,transport);
  const png=Buffer.from([0x89,0x50,0x4e,0x47,1,2,3]);
  const outcome=await connector.send({result:{id:'r1',work_title:'파생상품 사례',summary:'5세트',text:'해설 본문',artifacts:[],sources:[]},target_alias:'updates',idempotency_key:'k1',images:[{name:'01_레버리지.png',media_type:'image/png',bytes:png},{name:'02_증거금.png',media_type:'image/png',bytes:png}]});
  assert.equal(outcome.status,'delivered');assert.match(outcome.receipt_id,/:photos:2\/2$/u);
  assert.match(calls[0].url,/sendMessage$/u);assert.match(calls[1].url,/sendPhoto$/u);assert.match(calls[2].url,/sendPhoto$/u);
  assert.ok(calls[1].options.body instanceof FormData);assert.equal(calls[1].options.body.get('caption'),'01_레버리지.png');assert.equal(calls[1].options.redirect,'error');
  const photoBlob=calls[1].options.body.get('photo');assert.equal(photoBlob.type,'image/png');assert.equal(photoBlob.size,png.length);
});

// Live 2026-10-03: the owner's Telegram got file lists and check notes instead of the five explanations they asked for.
test('a result that carries the owner message is delivered as that message only',async()=>{
  const {deliveryContent}=await import('../dist/work/delivery-connectors.js');
  const result={id:'r-2',work_title:'파생상품 교육자료',source_status:'succeeded',work_completion_verified:true,summary:'case-1.png 과 해설을 만들었습니다. 파일: a, b, c. 완료조건 충족.',text:'Files made in this run (Work folder):\n- a.png\n- b.txt',delivery_text:'## 1. 레버리지\n증거금 10%로 …\n\n## 2. 추가 증거금\n하루 1% 변동이 …',artifacts:[{id:'a'}]};
  assert.equal(deliveryContent(result),'파생상품 교육자료\n[완료] 검증을 통과했습니다.\n\n## 1. 레버리지\n증거금 10%로 …\n\n## 2. 추가 증거금\n하루 1% 변동이 …\n\nWork result r-2');
  const long={...result,delivery_text:'가'.repeat(5000)},cut=deliveryContent(long);assert.ok([...cut].length<=4000);assert.match(cut,/전체 내용은 앱에서/u);assert.doesNotMatch(cut,/Files made/u);
});
