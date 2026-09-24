import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {startControlCenter} from '../dist/observability/control-center.js';

async function setup(t,model){
  const root=await mkdtemp(join(tmpdir(),'driver-work-'));
  const path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'work-test',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off',model_data_approved:false},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:model});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {config,api};
}
function proposal(questions=[]){return {title:'AI 소식 정리',desired_outcome:'매일 AI 관련 최신 소식 요약을 전달한다',completion_checks:[{id:'sources',result:'새 소식을 확인한다',evidence:'방문한 출처와 관측 시각'},{id:'delivery',result:'요약을 전달한다',evidence:'전송 영수증'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'recurring',rule:'매일'},questions};}
function model(reply=proposal()){return {calls:[],async call(){if(reply instanceof Error)throw reply;return structuredClone(reply);}};}

test('one-line Work is durable before model success and request IDs are idempotent',async t=>{
  const x=await setup(t,model(new Error('offline')));
  const first=await x.api.call('runtime_work_start',{request_id:'daily-ai',prompt:'매일 AI 소식 알려줘'});
  assert.equal(first.status,'needs_model');
  assert.equal(first.revision,0);
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  assert.equal(reopened.intakeWork(x.config.project.id,first.work_id).prompt,'매일 AI 소식 알려줘');
  const repeat=await x.api.call('runtime_work_start',{request_id:'daily-ai',prompt:'매일 AI 소식 알려줘'});
  assert.equal(repeat.work_id,first.work_id);
  assert.equal(repeat.deduplicated,true);
  await assert.rejects(x.api.call('runtime_work_start',{request_id:'daily-ai',prompt:'다른 요청'}),/WORK_REQUEST_ID_CONFLICT/u);
  await assert.rejects(x.api.call('runtime_work_start',{request_id:'bad-key',prompt:'apikey_abcdefghijklmnopqrstuvwxyz'}),/CREDENTIAL_LIKE_INPUT/u);
});

test('quick mode removes optional questions; guided mode persists options and answers',async t=>{
  const question={id:'format',prompt:'결과 형식은?',options:[{id:'summary',label:'요약문',meaning:'글머리표 요약'},{id:'cards',label:'카드뉴스',meaning:'시각 카드 초안'}],recommended_id:'summary',required:false};
  let lastInput=null;const fake={calls:[],async call(_purpose,_instructions,input){lastInput=input;return proposal([question]);}};
  const x=await setup(t,fake);
  const quick=await x.api.call('runtime_work_start',{request_id:'quick-ai',prompt:'매일 AI 소식 알려줘'});
  assert.equal(quick.status,'ready');assert.deepEqual(quick.questions,[]);
  const guided=await x.api.call('runtime_work_start',{request_id:'guided-ai',prompt:'매일 AI 소식 알려줘',intake_mode:'guided'});
  assert.equal(guided.status,'awaiting_details');assert.equal(guided.questions[0].id,'format');
  const answered=await x.api.call('runtime_work_answer',{work_id:guided.work_id,revision:guided.revision,answers:{format:'cards'}});
  assert.equal(answered.status,'ready');assert.equal(answered.answers.format,'cards');assert.equal(lastInput.answers.format,'cards');
  await assert.rejects(x.api.call('runtime_work_answer',{work_id:guided.work_id,revision:guided.revision,answers:{format:'summary'}}),/WORK_REVISION_CONFLICT|WORK_NOT_AWAITING_DETAILS/u);
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  assert.equal(reopened.intakeWork(x.config.project.id,guided.work_id).status,'ready');
  assert.deepEqual(reopened.workRevisions(x.config.project.id,guided.work_id).map(x=>x.kind),['received','defined','answered','defined']);
});

test('a Pack run with the same request ID binds to the defined Work, not a second Work',async t=>{
  const x=await setup(t,model({...proposal(),route:{kind:'pack',pack_family:'portal.collect'}}));
  const work=await x.api.call('runtime_work_start',{request_id:'bound-ai',prompt:'AI 소식 찾아줘'});
  assert.equal(work.status,'ready');
  const recipe={version:1,request:'AI 소식 찾아줘',family:'portal.collect',sources:[{id:'not-connected',parameters:{}}],filters:[],deduplicate_by:[],format:'json'};
  const begun=x.api.store.beginPack(x.config.project.id,'bound-ai',recipe,'fixture');
  assert.equal(x.api.store.officeWork(x.config.project.id,'pack',begun.run.id).id,work.work_id);
  assert.equal(x.api.store.intakeWork(x.config.project.id,work.work_id).status,'running');
  assert.equal(x.api.store.officeRuns(x.config.project.id,work.work_id).length,1);
  const repeated=x.api.store.beginPack(x.config.project.id,'bound-ai-week-2',recipe,'fixture',work.work_id);
  assert.equal(x.api.store.officeWork(x.config.project.id,'pack',repeated.run.id).id,work.work_id);
  assert.equal(x.api.store.officeRuns(x.config.project.id,work.work_id).length,2);
  await assert.rejects(Promise.resolve().then(()=>x.api.store.beginPack(x.config.project.id,'wrong-family',{...recipe,family:'research.search'},'fixture',work.work_id)),/WORK_PACK_FAMILY_MISMATCH/u);
});

test('a revised Swarm step invalidates stale Work checks and survives redefinition',async t=>{
  let lastInput;const fake={async call(_purpose,_instructions,input){lastInput=input;return {...proposal(),route:{kind:'swarm',pack_family:null}};}};
  const x=await setup(t,fake),project=x.config.project.id;
  const work=await x.api.call('runtime_work_start',{request_id:'swarm-work',prompt:'AI 카드뉴스 만들어줘'});
  const now=new Date().toISOString(),worker={id:'write',role:'Writer',objective:'카드뉴스 작성',stage:'synthesis',source_urls:[],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['카드뉴스'],max_steps:5,timeout_ms:60000};
  const plan={format:1,plan_id:'11111111-1111-4111-8111-111111111111',goal:'AI 카드뉴스',summary:'Write',workers:[worker],planner:{kind:'llm',model:'fixture',input_sha256:'a'.repeat(64)},max_concurrency:1,research_mode:null,execution_profile:null,created_at:now,execution_authority:false,approval_granted:false};
  const snapshot={format:1,run_id:'22222222-2222-4222-8222-222222222222',request_id:'swarm-work',plan,revision:0,status:'running',workers:{write:{id:'write',status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}},mode:null,started_at_ms:Date.now(),target_deadline_at_ms:null,hard_deadline_at_ms:null,synthesis_reserve_ms:0,reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};
  const run=x.api.store.beginSwarmRun(project,'swarm-work',plan.plan_id,snapshot,x.config.fingerprint,work.work_id);
  assert.equal(x.api.store.officeWork(project,'swarm',snapshot.run_id).id,work.work_id);
  x.api.store.officeAction(project,snapshot.run_id,'edit',0,'write','카드뉴스 대신 요약문 제공');
  assert.equal(x.api.store.intakeWork(project,work.work_id).status,'needs_model');
  assert.equal(x.api.store.workDirections(project,work.work_id)[0].instruction,'카드뉴스 대신 요약문 제공');
  assert.equal(x.api.store.beginSwarmRun(project,'swarm-work',plan.plan_id,snapshot,x.config.fingerprint,work.work_id).snapshot.run_id,run.snapshot.run_id);
  const redefined=await x.api.call('runtime_work_define',{work_id:work.work_id});
  assert.equal(redefined.status,'ready');
  assert.equal(lastInput.user_directions[0].instruction,'카드뉴스 대신 요약문 제공');
});

test('Work pause fences later runs without pretending to stop an active Pack',async t=>{
  const x=await setup(t,model({...proposal(),route:{kind:'pack',pack_family:'portal.collect'}})),project=x.config.project.id;
  const work=await x.api.call('runtime_work_start',{request_id:'pause-work',prompt:'자료 수집'});
  const paused=await x.api.call('runtime_work_pause',{work_id:work.work_id,revision:work.revision,paused:true});
  assert.equal(paused.paused,true);
  const recipe={version:1,request:'자료 수집',family:'portal.collect',sources:[{id:'not-connected',parameters:{}}],filters:[],deduplicate_by:[],format:'json'};
  assert.throws(()=>x.api.store.beginPack(project,'pause-run-1',recipe,'fixture',work.work_id),/WORK_PAUSED/u);
  const resumed=await x.api.call('runtime_work_pause',{work_id:work.work_id,revision:paused.revision,paused:false});
  const run=x.api.store.beginPack(project,'pause-run-1',recipe,'fixture',work.work_id).run;
  await assert.rejects(x.api.call('runtime_work_pause',{work_id:work.work_id,revision:resumed.revision,paused:true}),/WORK_ACTIVE_PACK_NOT_PAUSABLE/u);
  x.api.store.finishPack(project,run.id,'succeeded',{verified:false});
  const later=await x.api.call('runtime_work_pause',{work_id:work.work_id,revision:resumed.revision,paused:true});
  assert.equal(later.paused,true);
});

test('light Work HTTP serves bounded board/detail and protects human controls',async t=>{
  const x=await setup(t,model()),work=await x.api.call('runtime_work_start',{request_id:'http-work',prompt:'매일 AI 소식 알려줘'});
  const server=await startControlCenter(x.config,{poll_ms:25});t.after(()=>server.close());
  const boardResponse=await fetch(new URL('work/board',server.url)),body=await boardResponse.text(),board=JSON.parse(body);
  assert.equal(board.works.length,1);assert.ok(Buffer.byteLength(body)<3000);assert.equal(board.works[0].id,work.work_id);
  const detail=await (await fetch(new URL('work/detail?id='+work.work_id,server.url))).json();
  assert.equal(detail.spec.completion_checks.length,2);assert.equal(detail.progress_percent,null);assert.equal(detail.completion_verified,false);
  const url=new URL('work/pause',server.url),payload={work_id:work.work_id,revision:work.revision,paused:true};
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify(payload)})).status,403);
  const response=await fetch(url,{method:'POST',headers:{origin:new URL(server.url).origin,'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify(payload)});
  assert.equal(response.status,200);assert.equal((await response.json()).scope,'future_dispatch');
  assert.equal((await (await fetch(new URL('work/board',server.url))).json()).works[0].status,'paused');
});

test('dashboard accepts one-line Work through the same durable intake and compiles guided answers',async t=>{
  const question={id:'format',prompt:'결과 형식은?',options:[{id:'summary',label:'요약문',meaning:'짧은 글'},{id:'cards',label:'카드뉴스',meaning:'시각 카드'}],recommended_id:'summary',required:false};
  const fake=model(proposal([question]));
  const x=await setup(t,fake),server=await startControlCenter(x.config,{workModel:fake});t.after(()=>server.close());
  const url=new URL('work/start',server.url),headers={origin:new URL(server.url).origin,'content-type':'application/json','x-agent-driver':'human-office'};
  const input={request_id:'desk-guided-1',prompt:'매일 AI 소식 알려줘',intake_mode:'guided'};
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify(input)})).status,403);
  const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(input)});
  assert.equal(response.status,200);const work=await response.json();
  assert.equal(work.status,'awaiting_details');
  assert.equal(work.questions[0].id,'format');
  assert.equal((await (await fetch(new URL('work/board',server.url))).json()).works[0].id,work.work_id);
  const duplicate=await (await fetch(url,{method:'POST',headers,body:JSON.stringify(input)})).json();
  assert.equal(duplicate.work_id,work.work_id);assert.equal(duplicate.deduplicated,true);
  const answer=await fetch(new URL('work/answer',server.url),{method:'POST',headers,body:JSON.stringify({work_id:work.work_id,revision:work.revision,answers:{format:'cards'}})});
  assert.equal(answer.status,200);assert.equal((await answer.json()).status,'ready');
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  assert.equal(reopened.intakeWork(x.config.project.id,work.work_id).answers.format,'cards');
});
