import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Script} from 'node:vm';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {HermesWorkRuntime,importHermesWork,hermesWorkDetail} from '../dist/work/hermes.js';
import {readWorkBoard} from '../dist/observability/work-view.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {workHtml} from '../dist/observability/work-ui.js';
import {HermesAcp} from '../dist/integrations/hermes-acp.js';

const definition={title:'개인 조회 업무',goal:'정확한 자료를 확인한다',checks:['원본 자료와 결과 대조'],steps:['관측','결과 확인'],family:'portal.collect',history:[{source:'historical receipt',summary:'과거 완료 기록이며 새 실행 승인이 아님'}],instruction:'승인되지 않은 전송 및 제출 금지'};
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'driver-hermes-work-')),path=join(root,'host.json');
 await writeFile(path,JSON.stringify({schema_version:1,project_id:'personal-test',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'}));
 const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true})});
 const id=importHermesWork(store,config.project.id,'owned-work',definition);return {root,config,store,id};
}
function fakeFactory({permission=false,hold=false,missing=false}={}){
 const state={starts:0,prompts:[],loads:[],answers:[],closes:0};
 state.transport=callbacks=>{
  let rejectPrompt;return {async request(method,args){
   if(method==='initialize')return {protocolVersion:1};
   if(method==='session/new'){state.starts++;return {sessionId:'fixture-session-'+state.starts}};
   if(method==='session/load'){state.loads.push(args.sessionId);callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'OLD REPLAY MUST NOT BECOME NEW ANSWER'}}});return missing?null:{}};
   if(method==='session/prompt'){
    state.prompts.push(args);if(hold)return new Promise((_resolve,reject)=>{rejectPrompt=reject});
    callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'HIDDEN THOUGHT'}}});
    callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'tool_call',title:'등록 자료 읽기',status:'in_progress'}});
    if(permission){const answer=await new Promise(resolve=>callbacks.permission({sessionId:args.sessionId,toolCall:{title:'검토할 단일 작업'},options:[{optionId:'yes',name:'한 번 허용',kind:'allow_once'},{optionId:'always',name:'항상 허용',kind:'allow_always'},{optionId:'no',name:'거절',kind:'reject_once'}]},resolve));state.answers.push(answer)}
    callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'읽기 결과입니다. password=private-value'}}});return {stopReason:'end_turn'};
   }
   throw Error('UNEXPECTED_METHOD');
  },notify(){},async close(){state.closes++;rejectPrompt?.(Error('HERMES_TRANSPORT_CLOSED'))}};
 };
 return state;
}
const input=(runtime,id,action,rest={})=>({work_id:id,revision:runtime.status(id).revision,action,...rest});
const send=(runtime,id,rest={})=>runtime.action(input(runtime,id,'send',{request_id:randomUUID(),instruction:'자료를 읽고 결과만 알려줘',cost_acknowledged:true,...rest}));
async function until(predicate){for(let i=0;i<100;i++){if(predicate())return;await delay(10)}assert.fail('Condition did not settle');}

test('runtime fixture Hermes import creates one managed Work without a model, session or business action',async t=>{
 const x=await setup(t);assert.equal(importHermesWork(x.store,x.config.project.id,'owned-work',definition),x.id);
 const board=readWorkBoard(x.store,x.config);assert.equal(board.works.length,1);assert.equal(board.works[0].run.kind,'hermes');assert.equal(board.works[0].status,'ready');
 const detail=hermesWorkDetail(x.store,x.config.project.id,x.id);assert.equal(detail.hermes.turns.length,0);assert.equal(detail.hermes.session_id,null);assert.equal(detail.completion_verified,false);
});
test('runtime fixture Hermes queue deduplicates requests and records an answer without claiming task completion',async t=>{
 const x=await setup(t),fake=fakeFactory(),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());
 const request=input(runtime,x.id,'send',{request_id:randomUUID(),instruction:'자료만 읽고 답해줘',cost_acknowledged:true});runtime.action(request);runtime.action(request);await runtime.drain();
 assert.equal(fake.prompts.length,1);assert.equal(fake.starts,1);const result=runtime.status(x.id);assert.equal(result.run_status,'needs_human');assert.equal(result.hermes.turns[0].status,'finished');assert.equal(result.completion_verified,false);assert.match(result.hermes.turns[0].reply,/읽기 결과/u);assert.doesNotMatch(JSON.stringify(result),/private-value|HIDDEN THOUGHT/u);
 assert.throws(()=>runtime.action({...request,instruction:'변경된 요청'}),/HERMES_REQUEST_ID_CONFLICT/u);
 assert.throws(()=>send(runtime,x.id),/HERMES_WORK_REVIEW_OR_RESUME_REQUIRED/u);
 runtime.action(input(runtime,x.id,'review'));send(runtime,x.id);await runtime.drain();assert.equal(fake.starts,1);assert.equal(fake.loads.length,1);assert.doesNotMatch(runtime.status(x.id).hermes.turns[0].reply,/OLD REPLAY/u);
});
test('runtime fixture Hermes rejects missing cost consent, secrets, wrong project and stale revisions',async t=>{
 const x=await setup(t),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fakeFactory().transport});t.after(()=>runtime.close());
 assert.throws(()=>send(runtime,x.id,{cost_acknowledged:false}),/CONSENT/u);
 assert.throws(()=>send(runtime,x.id,{instruction:'password=secret-value'}),/CREDENTIAL/u);
 assert.throws(()=>runtime.action({work_id:x.id,revision:999,action:'pause'}),/REVISION/u);
 const foreign=new HermesWorkRuntime(x.store,{...x.config,project:{...x.config.project,id:'foreign'}},{transport:fakeFactory().transport});t.after(()=>foreign.close());assert.throws(()=>send(foreign,x.id),/NOT_FOUND|Cannot read/u);
});
test('runtime fixture Hermes resume carries prior directions and reported receipts without prescribing its skill sequence',async t=>{
 const x=await setup(t),fake=fakeFactory(),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());
 send(runtime,x.id,{instruction:'카드뉴스를 작성하되 전송은 하지 마세요'});await runtime.drain();runtime.action(input(runtime,x.id,'review'));
 send(runtime,x.id,{instruction:'이제 카드뉴스 대신 요약문으로 제공해줘'});await runtime.drain();
 assert.equal(fake.starts,1);assert.equal(fake.loads.length,1);
 const saved=x.store.hermesState.prepare('SELECT * FROM hermes_turn_context ORDER BY rowid DESC LIMIT 1').get(),context=JSON.parse(saved.context_json);
 assert.equal(context.sha256,saved.sha256);assert.equal(context.core.binding.work_id,x.id);assert.equal(context.core.binding.project_id,x.config.project.id);
 assert.deepEqual(context.core.instructions.filter(i=>i.source==='user').map(i=>i.text),['카드뉴스를 작성하되 전송은 하지 마세요','이제 카드뉴스 대신 요약문으로 제공해줘']);
 assert.equal(context.core.receipts[0].verification,'reported');assert.equal(context.core.receipts[0].effect_state,'unobserved');assert.equal(context.project_completion_verified,false);
 assert.match(context.core.constraints.join(' '),/Hermes owns execution.*installed, enabled skills/u);
 assert.match(context.core.constraints.join(' '),/not a mandatory tool sequence/u);
 assert.ok(fake.prompts[1].prompt[0].text.includes(saved.context_json));assert.doesNotMatch(saved.context_json,/private-value|HIDDEN THOUGHT/u);
});
test('runtime fixture Hermes keeps reviewed uncertain effects visible without replaying the prior instruction',async t=>{
 const x=await setup(t),first=randomUUID(),at=new Date().toISOString();
 x.store.hermesState.prepare("INSERT INTO hermes_turn(id,project_id,work_id,request_id,instruction,status,reason,created_at,updated_at) VALUES(?,?,?,?,?,'reconciliation_required','CONNECTION_LOST',?,?)").run(first,x.config.project.id,x.id,randomUUID(),'전송 결과 확인 필요',at,at);
 x.store.hermesState.prepare("UPDATE hermes_work SET state='reconciliation_required' WHERE work_id=?").run(x.id);
 const fake=fakeFactory(),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());runtime.action(input(runtime,x.id,'review'));send(runtime,x.id,{instruction:'재전송하지 말고 기존 전송 기록만 확인해줘'});await runtime.drain();
 assert.equal(fake.prompts.length,1);const context=JSON.parse(x.store.hermesState.prepare('SELECT context_json FROM hermes_turn_context').get().context_json);
 assert.equal(context.core.receipts[0].id,first);assert.equal(context.core.receipts[0].effect_state,'uncertain');assert.equal(context.core.receipts[0].verification,'unverified');
 assert.match(context.core.next_action,/uncertain previous effects/u);
});
test('runtime fixture Hermes never sends a prompt with silently truncated critical history',async t=>{
 const x=await setup(t),at=new Date().toISOString();
 for(let i=0;i<9;i++)x.store.hermesState.prepare("INSERT INTO hermes_turn(id,project_id,work_id,request_id,instruction,status,created_at,updated_at) VALUES(?,?,?,?,?,'finished',?,?)").run(randomUUID(),x.config.project.id,x.id,randomUUID(),'지'.repeat(4000),at,at);
 const fake=fakeFactory(),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());send(runtime,x.id);await runtime.drain();
 assert.equal(fake.prompts.length,0);assert.equal(runtime.status(x.id).run_status,'failed');
 assert.ok(runtime.status(x.id).hermes.turns.some(turn=>turn.reason==='CONTINUITY_CORE_TOO_LARGE'));
 assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM hermes_turn_context').get().n,0);
});
test('runtime fixture Hermes continuation survives reopening the store with the same session and protected directions',async t=>{
 const x=await setup(t),fake=fakeFactory(),first=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});
 send(first,x.id,{instruction:'초안만 작성하고 전송하지 마세요'});await first.drain();first.action(input(first,x.id,'review'));await first.close();
 const reopened=new PackStore(x.config.dbPath),second=new HermesWorkRuntime(reopened,x.config,{transport:fake.transport});
 try{
   send(second,x.id,{instruction:'앞서 작성한 초안을 요약문으로 바꿔줘'});await second.drain();
   assert.equal(fake.starts,1);assert.equal(fake.loads.length,1);
   const contexts=reopened.hermesState.prepare('SELECT context_json FROM hermes_turn_context ORDER BY rowid').all();assert.equal(contexts.length,2);
   const next=JSON.parse(contexts[1].context_json);assert.equal(next.core.instructions[1].text,'초안만 작성하고 전송하지 마세요');assert.match(next.rules,/not a queue of actions to execute again/u);
   assert.equal(next.core.receipts[0].verification,'reported');assert.match(fake.prompts[1].prompt[0].text,/앞서 작성한 초안을 요약문으로 바꿔줘/u);
 }finally{await second.close();reopened.close()}
});
test('runtime fixture Hermes approval is one-time, exact-request-bound and never automated',async t=>{
 const x=await setup(t),fake=fakeFactory({permission:true}),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());send(runtime,x.id);
 await until(()=>runtime.status(x.id).hermes.permission);const permission=runtime.status(x.id).hermes.permission;assert.deepEqual(permission.options.map(x=>x.id),['yes','no']);assert.equal(fake.answers.length,0);
 assert.throws(()=>runtime.action(input(runtime,x.id,'permission',{permission_id:permission.id,option_id:'always'})),/INVALID/u);
 runtime.action(input(runtime,x.id,'permission',{permission_id:permission.id,option_id:'yes'}));await runtime.drain();assert.equal(fake.answers[0].outcome.optionId,'yes');
 assert.throws(()=>runtime.action(input(runtime,x.id,'permission',{permission_id:permission.id,option_id:'yes'})),/INVALID/u);
});
test('runtime fixture Hermes pause cancels owned execution and resume does not replay an uncertain action',async t=>{
 const x=await setup(t),fake=fakeFactory({hold:true}),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());send(runtime,x.id);await until(()=>fake.prompts.length===1);
 runtime.action(input(runtime,x.id,'pause'));await runtime.drain();assert.equal(runtime.status(x.id).hermes.paused,true);runtime.action(input(runtime,x.id,'resume'));await runtime.drain();assert.equal(fake.prompts.length,1);assert.equal(runtime.status(x.id).run_status,'reconciliation_required');assert.equal(runtime.status(x.id).hermes.can_send,false);
});
test('runtime fixture Hermes single-flight queue keeps other Work pending and retains live ownership on reconnect',async t=>{
 const x=await setup(t),fake=fakeFactory({hold:true}),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());const second=importHermesWork(x.store,x.config.project.id,'second',{...definition,title:'두 번째'});
 send(runtime,x.id);await until(()=>fake.prompts.length);send(runtime,second);const other=new HermesWorkRuntime(x.store,x.config,{transport:fakeFactory().transport});t.after(()=>other.close());other.tick();await other.drain();assert.equal(fake.prompts.length,1);assert.equal(runtime.status(second).run_status,'queued');assert.equal(runtime.status(x.id).run_status,'running');
 runtime.action(input(runtime,second,'pause'));runtime.action(input(runtime,x.id,'pause'));await runtime.drain();runtime.tick();await runtime.drain();assert.equal(fake.prompts.length,1);
});
test('runtime fixture Hermes dead owner becomes review-required without replay',async t=>{
 const x=await setup(t);x.store.hermesState.prepare("INSERT INTO hermes_turn(id,project_id,work_id,request_id,instruction,status,owner,created_at,updated_at) VALUES(?,?,?,?,?,'running','99999999:old:1',?,?)").run(randomUUID(),x.config.project.id,x.id,randomUUID(),'중단 지시',new Date().toISOString(),new Date().toISOString());
 const fake=fakeFactory(),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());runtime.tick();await runtime.drain();assert.equal(runtime.status(x.id).run_status,'reconciliation_required');assert.equal(fake.prompts.length,0);
});
test('runtime fixture Hermes missing exact session is not replaced or replayed silently',async t=>{
 const x=await setup(t);x.store.hermesState.prepare('UPDATE hermes_work SET session_id=? WHERE work_id=?').run('missing-session',x.id);
 const fake=fakeFactory({missing:true}),runtime=new HermesWorkRuntime(x.store,x.config,{transport:fake.transport});t.after(()=>runtime.close());send(runtime,x.id);await runtime.drain();assert.equal(fake.starts,0);assert.equal(fake.prompts.length,0);assert.equal(runtime.status(x.id).hermes.turns[0].reason,'HERMES_SESSION_NOT_FOUND');
});
test('runtime fixture Hermes control HTTP validates origin and exposes managed Work without executing it',async t=>{
 const x=await setup(t),fake=fakeFactory(),server=await startControlCenter(x.config,{hermes:{transport:fake.transport}});t.after(()=>server.close());
 const board=await(await fetch(server.url+'work/board')).json();assert.equal(board.works[0].run.kind,'hermes');const detail=await(await fetch(server.url+'work/detail?id='+x.id)).json();assert.ok(detail.hermes);
 const body=JSON.stringify({work_id:x.id,revision:detail.revision,action:'pause'});
 assert.equal((await fetch(server.url+'work/hermes/action',{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body})).status,403);
 const paused=await fetch(server.url+'work/hermes/action',{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office',origin:new URL(server.url).origin},body});assert.equal(paused.status,200);assert.equal((await paused.json()).hermes.paused,true);assert.equal(fake.prompts.length,0);
});
test('runtime contract Hermes Work UI compiles, escapes text and shows actual logs plus explicit usage consent',()=>{
 const html=workHtml('nonce');assert.doesNotThrow(()=>new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));assert.match(html,/Hermes 실행 · Driver 관리/u);assert.match(html,/실제 작업 로그/u);assert.match(html,/cost_acknowledged:true/u);assert.match(html,/esc\(t.reply\)/u);assert.doesNotMatch(html,/<iframe|<video/u);
});
test('runtime fixture Hermes transport exchanges ACP JSONL, denies unsupported capabilities and bounds request time',async()=>{
 const updates=[],permissions=[];
 const source=`const rl=require('node:readline').createInterface({input:process.stdin});const send=v=>process.stdout.write(JSON.stringify(v)+'\\n');rl.on('line',line=>{const m=JSON.parse(line);if(m.method==='initialize')send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}});else if(m.method==='test/updates'){send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'owned',update:{sessionUpdate:'tool_call',title:'Read'}}});send({jsonrpc:'2.0',id:99,method:'session/request_permission',params:{sessionId:'owned'}})}else if(m.id===99){send({jsonrpc:'2.0',id:100,method:'fs/write_text_file',params:{}})}else if(m.id===100){send({jsonrpc:'2.0',id:2,result:{permission:m.error.code}})}});`;
 const bridge=new HermesAcp(process.execPath,['-e',source],process.cwd(),{update:p=>updates.push(p),permission:(p,respond)=>{permissions.push(p);respond({outcome:{outcome:'cancelled'}})}});
 try{assert.equal((await bridge.request('initialize',{})).protocolVersion,1);assert.equal((await bridge.request('test/updates',{})).permission,-32601);assert.equal(updates.length,1);assert.equal(permissions.length,1);await assert.rejects(bridge.request('test/no-response',{},100),/TIMEOUT/u);}finally{await bridge.close()}
 await assert.rejects(bridge.request('initialize',{}),/CLOSED/u);
});
test('runtime fixture Hermes rejects malformed ACP output without exposing it',async()=>{
 const bridge=new HermesAcp(process.execPath,['-e',"process.stdout.write('private-broken-json\\n');setInterval(()=>{},1000)"],process.cwd(),{update(){},permission(){}});
 try{await assert.rejects(bridge.request('initialize',{}),/HERMES_PROTOCOL_INVALID/u);}finally{await bridge.close()}
});
test('runtime fixture Hermes buffers split secret lines and redacts the final answer',async t=>{
 const x=await setup(t);let mid;
 const runtime=new HermesWorkRuntime(x.store,x.config,{transport:callbacks=>({async request(method,args){
  if(method==='initialize')return {};
  if(method==='session/new')return {sessionId:'split-secret'};
  if(method==='session/prompt'){
   for(const text of ['안전한 줄\npass','word=hidden-','secret\n끝']){callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}});mid=runtime.status(x.id).hermes.turns[0].reply;assert.doesNotMatch(mid,/hidden|secret|word=/u)}
   return {stopReason:'end_turn'};
  }
 },notify(){},async close(){}})});t.after(()=>runtime.close());send(runtime,x.id);await runtime.drain();assert.match(runtime.status(x.id).hermes.turns[0].reply,/끝/u);assert.doesNotMatch(runtime.status(x.id).hermes.turns[0].reply,/hidden-secret/u);
});
