import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Script} from 'node:vm';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {SwarmRuntime} from '../dist/swarm/runtime.js';
import {readControlCenter,startControlCenter} from '../dist/observability/control-center.js';
import {readOffice} from '../dist/observability/office.js';
const koPage=async(browser,options)=>{const page=await browser.newPage(options);await page.addInitScript(()=>{try{localStorage.setItem('office-lang','ko')}catch{}});return page;};

async function setup(t){const root=await mkdtemp(join(tmpdir(),'driver-office-')),path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'office-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',terminal:{executable:process.execPath,version:'2.1.126',tools:[]},packs:{sources:[],targets:[],models:'off',model_data_approved:false},swarm:{enabled:true,model_data_approved:true}}));const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true})});return {config,store,swarm:new SwarmRuntime(store,config)};}
function fixture(){const now=new Date().toISOString(),source={id:'source',role:'Researcher',objective:'Read public sources',stage:'source_read',source_urls:[],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['source checked'],max_steps:5,timeout_ms:60000},write={...source,id:'write',role:'Writer',objective:'Create a card news item',stage:'synthesis',depends_on:['source'],completion_evidence:['card news'],source_urls:[]},plan={format:1,plan_id:'11111111-1111-4111-8111-111111111111',goal:'Create a card news item',summary:'Research and write',workers:[source,write],planner:{kind:'llm',model:'fixture',input_sha256:'a'.repeat(64)},max_concurrency:2,research_mode:null,execution_profile:null,created_at:now,execution_authority:false,approval_granted:false};return {format:1,run_id:'22222222-2222-4222-8222-222222222222',request_id:'office-case',plan,revision:0,status:'running',workers:Object.fromEntries(plan.workers.map(worker=>[worker.id,{id:worker.id,status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}])),mode:null,started_at_ms:Date.now(),target_deadline_at_ms:null,hard_deadline_at_ms:null,synthesis_reserve_ms:0,reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};}
function begin(x){const run=fixture();x.store.saveSwarmPlan(x.config.project.id,run.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,run.request_id,run.plan.plan_id,run,x.config.fingerprint);return run;}

test('office pause revokes read-only lease, fences old report, and edit reaches next dispatch',async t=>{const x=await setup(t),run=begin(x),project=x.config.project.id;const first=await x.swarm.tick(run.run_id);assert.equal(first.dispatch.worker_id,'source');assert.equal(first.dispatch.objective,'Read public sources');assert.equal(first.dispatch.instruction_version,0);const stopped=x.store.officeAction(project,run.run_id,'pause',0);assert.equal(stopped.control.paused,true);assert.equal((await x.swarm.tick(run.run_id)).reason,'USER_PAUSED');await assert.rejects(x.swarm.report(run.run_id,'source',first.dispatch.lease_token,{status:'needs_human',summary:'late result'}),/STALE_SWARM_LEASE/u);assert.throws(()=>x.store.officeAction(project,run.run_id,'edit',0,'write','Return a short summary'),/OFFICE_REVISION_CONFLICT/u);const edited=x.store.officeAction(project,run.run_id,'edit',1,'source','Read and make a concise summary');assert.equal(edited.control.revision,2);assert.equal(x.store.swarmRun(project,run.run_id).snapshot.plan.workers[0].objective,'Read and make a concise summary');assert.equal(x.store.officeInstructions(project,run.run_id).at(-1).version,1);x.store.officeAction(project,run.run_id,'resume',2);const resumed=await x.swarm.tick(run.run_id);assert.equal(resumed.dispatch.objective,'Read and make a concise summary');assert.equal(resumed.dispatch.instruction_version,1);assert.notEqual(resumed.dispatch.lease_token,first.dispatch.lease_token);assert.equal(resumed.dispatch.worker_id,'source');x.swarm.activity(run.run_id,'source',resumed.dispatch.lease_token,{kind:'started',summary:'Taking over source',endpoint:null,actor_id:'research-agent-2'});const office=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.match(office.works[0].stages.find(s=>s.id==='source').owner,/research-agent-2/u);});

test('office holds in-flight mutating effects rather than claiming a force stop',async t=>{const x=await setup(t),run=fixture(),project=x.config.project.id;run.plan.workers[0].effect='local_write';x.store.saveSwarmPlan(project,run.plan,x.config.fingerprint);x.store.beginSwarmRun(project,run.request_id,run.plan.plan_id,run,x.config.fingerprint);const leased=structuredClone(x.store.swarmRun(project,run.run_id).snapshot);leased.workers.source.status='leased';leased.workers.source.lease_token='33333333-3333-4333-8333-333333333333';leased.workers.source.lease_expires_at_ms=Date.now()+60000;leased.workers.source.attempts=1;leased.revision=1;leased.updated_at=new Date().toISOString();x.store.updateSwarmRun(project,run.run_id,0,leased);x.store.officeAction(project,run.run_id,'pause',0);const saved=x.store.swarmRun(project,run.run_id).snapshot;assert.equal(saved.workers.source.status,'leased');assert.equal(saved.workers.source.lease_token,leased.workers.source.lease_token);assert.throws(()=>x.store.officeAction(project,run.run_id,'resume',1),/OFFICE_INFLIGHT_EFFECT_UNRESOLVED/u);const view=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.match(view.works[0].attention_reason,/외부 변경/u);});

test('work mapping, pause, and updated instructions survive a new store instance',async t=>{const x=await setup(t),run=begin(x),project=x.config.project.id;assert.equal(x.store.officeWork(project,'swarm',run.run_id).id,'swarm:'+run.run_id);x.store.officeAction(project,run.run_id,'pause',0);x.store.officeAction(project,run.run_id,'edit',1,'write','Return a verified summary');const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());assert.equal(reopened.officeControl(project,run.run_id).paused,true);assert.equal(reopened.officeWork(project,'swarm',run.run_id).goal,'Return a verified summary');assert.equal(reopened.officeInstructions(project,run.run_id)[0].instruction,'Return a verified summary');assert.equal(reopened.officeEvents(project,run.run_id).filter(event=>event.kind==='user.edit').length,1);});

test('office snapshot uses verified stage evidence, shows pause and records handoff without invented worker identity',async t=>{const x=await setup(t),run=begin(x),project=x.config.project.id;let view=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.equal(view.works[0].progress_percent,0);assert.equal(view.works[0].total_steps,2);assert.equal(view.works[0].verified_steps,0);assert.equal(view.works[0].stages[0].owner,null);x.store.officeAction(project,run.run_id,'pause',0);x.store.officeAction(project,run.run_id,'edit',1,'write','Provide a plain-language summary instead of a card news item');view=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.equal(view.works[0].paused,true);assert.equal(view.works[0].title,'Provide a plain-language summary instead of a card news item');assert.equal(view.works[0].stages.find(s=>s.id==='write').instruction_version,1);assert.match(JSON.stringify(view.works[0].events),/user.edit/u);assert.equal(view.works[0].progress_percent,0);});

test('office HTTP is capability scoped and requires same-origin user action',async t=>{const x=await setup(t),run=begin(x),server=await startControlCenter(x.config,{poll_ms:25});t.after(()=>server.close());const page=await (await fetch(server.url)).text();assert.match(page,/Agent Office/u);assert.match(page,/단계 진척도/u);assert.doesNotMatch(page,/LIVE ACTOR WALL/u);assert.doesNotThrow(()=>new Script(page.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));const snap=await (await fetch(new URL('office/snapshot',server.url))).json();assert.equal(snap.works[0].run_id,run.run_id);const url=new URL('office/action',server.url),body=JSON.stringify({run_id:run.run_id,action:'pause',revision:0});assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body})).status,403);const post=(payload,headers={})=>fetch(url,{method:'POST',headers:{origin:new URL(server.url).origin,'content-type':'application/json','x-agent-driver':'human-office',...headers},body:JSON.stringify(payload)});assert.equal((await post({run_id:run.run_id,action:'pause',revision:0},{'sec-fetch-site':'cross-site'})).status,403);assert.equal((await post({run_id:run.run_id,action:'pause',revision:0})).status,200);assert.equal((await post({run_id:run.run_id,action:'pause',revision:0})).status,409);assert.equal((await (await fetch(new URL('office/snapshot',server.url))).json()).works[0].paused,true);});

test('minimal Work detail edits a future stage without losing draft, desktop and mobile',async t=>{
  const x=await setup(t),run=begin(x),server=await startControlCenter(x.config,{poll_ms:25}),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close()});
  for(const width of [1280,390]){
    const page=await koPage(browser,{viewport:{width,height:900}}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(server.url+'?work=swarm:'+run.run_id);
    await page.getByRole('heading',{name:'진행 단계'}).waitFor();
    if(width===1280){
      await page.locator('[data-stage="write"]').click();
      await page.locator('#instruction').fill('카드뉴스 대신 요약문으로 제공해줘');
      x.store.recordSwarmActivity(x.config.project.id,run.run_id,0,null,'test.heartbeat',{summary:'new activity'});
      await page.waitForTimeout(2200);
      assert.equal(await page.locator('#instruction').inputValue(),'카드뉴스 대신 요약문으로 제공해줘');
      assert.equal(await page.evaluate(()=>document.activeElement?.id),'instruction');
      await page.getByRole('button',{name:'다음 배정에 적용'}).click();
      await page.locator('[data-stage="write"] small').filter({hasText:'카드뉴스 대신 요약문으로 제공해줘'}).waitFor();
    }
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,JSON.stringify(await page.evaluate(()=>[...document.querySelectorAll('*')].filter(el=>el.getBoundingClientRect().right>innerWidth).slice(0,8).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})))));
    assert.equal(await page.getByRole('progressbar').count(),1);
    assert.deepEqual(errors,[]);
    await page.close();
  }
});

test('board uses a short Work title and detail retains the full instruction',async t=>{
  const x=await setup(t),run=fixture();
  run.plan.goal='AI 카드뉴스 제작을 위해 여러 공개 원문 사이트를 병렬로 조사하고 정확한 날짜와 출처를 확인한다. 검증된 사실만 취합하고 불확실한 부분은 명확하게 표시한 뒤 한국어 결과물을 작성한다.';
  x.store.saveSwarmPlan(x.config.project.id,run.plan,x.config.fingerprint);
  x.store.beginSwarmRun(x.config.project.id,run.request_id,run.plan.plan_id,run,x.config.fingerprint);
  const server=await startControlCenter(x.config),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close()});
  const page=await koPage(browser,{viewport:{width:1280,height:800}});
  await page.goto(server.url);
  await page.locator('.tile strong').waitFor();
  const short=await page.locator('.tile strong').textContent();
  assert.ok(short.length<80);
  assert.ok(short.length<run.plan.goal.length);
  await page.locator('.tile').click();
  await page.getByRole('heading',{level:2}).waitFor();
  assert.equal(await page.locator('.request').textContent(),run.plan.goal);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

test('same immutable plan groups repeated runs as one durable work and keeps original brief',async t=>{const x=await setup(t),first=begin(x),project=x.config.project.id;const second=structuredClone(first);second.run_id='44444444-4444-4444-8444-444444444444';second.request_id='office-repeat';second.created_at=new Date(Date.now()+1000).toISOString();second.updated_at=second.created_at;x.store.beginSwarmRun(project,second.request_id,second.plan.plan_id,second,x.config.fingerprint);assert.equal(x.store.officeWork(project,'swarm',second.run_id).id,x.store.officeWork(project,'swarm',first.run_id).id);assert.equal(x.store.officeRuns(project,'swarm:'+first.run_id).length,2);x.store.officeAction(project,first.run_id,'edit',0,'write','Return a summary instead');const view=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.equal(view.works.length,1);assert.equal(view.works[0].runs.length,2);assert.equal(view.run_details.length,2);assert.equal(view.run_details.find(item=>item.run_id===first.run_id).brief.request,'Create a card news item');assert.equal(view.run_details.find(item=>item.run_id===first.run_id).brief.current_goal,'Return a summary instead');assert.equal(view.run_details[0].plan.summary,'Research and write');assert.equal(view.run_details[0].stages.find(item=>item.id==='write').depends_on[0],'source');const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());assert.equal(reopened.officeRuns(project,'swarm:'+first.run_id).length,2);});

test('editing a pending step rejects already started descendants',async t=>{const x=await setup(t),run=begin(x),project=x.config.project.id;const saved=structuredClone(x.store.swarmRun(project,run.run_id).snapshot);saved.workers.write.status='leased';saved.workers.write.lease_token='55555555-5555-4555-8555-555555555555';saved.workers.write.lease_expires_at_ms=Date.now()+30000;saved.revision=1;saved.updated_at=new Date().toISOString();x.store.updateSwarmRun(project,run.run_id,0,saved);assert.throws(()=>x.store.officeAction(project,run.run_id,'edit',0,'source','Change source'),/OFFICE_EDIT_DOWNSTREAM_STARTED/u);const view=readOffice(x.store,x.config,readControlCenter(x.store,x.config));assert.deepEqual(view.works[0].stages.find(item=>item.id==='source').downstream,['write']);assert.equal(view.works[0].stages.find(item=>item.id==='source').can_edit,false);});

test('minimal Work desk shows live stage truth without visual previews or invented completion',async t=>{
  const x=await setup(t),run=begin(x),server=await startControlCenter(x.config),browser=await chromium.launch({headless:true});
  t.after(async()=>{await browser.close();await server.close()});
  const page=await koPage(browser,{viewport:{width:1280,height:850}});
  await page.goto(server.url);
  await page.locator('.tile').waitFor();
  assert.equal(await page.locator('.tile').count(),1);
  await page.locator('.tile').click();
  await page.getByRole('heading',{name:'진행 단계'}).waitFor();
  assert.equal(await page.getByRole('heading',{name:'작업 제어'}).count(),1);
  assert.equal(await page.getByText('선택된 Pack').count(),1);
  assert.equal(await page.getByText('Run 성공은 Work의 모든 완료조건 충족을 자동으로 뜻하지 않습니다.').count(),1);
  assert.equal(await page.locator('img,canvas,video').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
});

test('one-line dashboard intake opens the new Work without a preview or horizontal overflow',async t=>{
  const x=await setup(t),fake={calls:[],async call(){return {title:'도쿄 호텔 검색',desired_outcome:'조건에 맞는 숙소 후보를 찾는다',completion_checks:[{id:'candidates',result:'숙소 후보를 확인한다',evidence:'출처와 조회 시각'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}};
  const server=await startControlCenter(x.config,{workModel:fake}),browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
  const page=await koPage(browser,{viewport:{width:390,height:850}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(server.url);
  await page.getByPlaceholder('한 줄로 어떤 업무를 맡길까요?').fill('도쿄 호텔 찾아줘');
  await page.getByRole('button',{name:'업무 접수'}).click();
  await page.getByRole('heading',{name:'도쿄 호텔 검색'}).waitFor();
  assert.equal(await page.getByText('완료 조건 · 숙소 후보를 확인한다').count(),1);
  assert.equal(await page.locator('img,canvas,video').count(),0);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.deepEqual(errors,[]);
});

test('dashboard can retry the same durable Work after a model interruption',async t=>{
  const x=await setup(t);let calls=0;const fake={calls:[],async call(){if(++calls===1)throw Error('model offline');return {title:'복구된 업무',desired_outcome:'자료를 확인한다',completion_checks:[{id:'readback',result:'자료 확인',evidence:'출처와 시각'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}};
  const server=await startControlCenter(x.config,{workModel:fake}),browser=await chromium.launch({headless:true});t.after(async()=>{await browser.close();await server.close()});
  const page=await koPage(browser);await page.goto(server.url);
  await page.getByPlaceholder('한 줄로 어떤 업무를 맡길까요?').fill('자료 확인해줘');
  await page.getByRole('button',{name:'업무 접수'}).click();
  await page.getByRole('button',{name:'업무 정의 재시도'}).waitFor();
  const first=await (await fetch(new URL('work/board',server.url))).json();
  assert.equal(first.works.length,1);
  await page.getByRole('button',{name:'업무 정의 재시도'}).click();
  await page.getByRole('heading',{name:'복구된 업무'}).waitFor();
  const final=await (await fetch(new URL('work/board',server.url))).json();
  assert.equal(final.works.length,1);assert.equal(final.works[0].id,first.works[0].id);
});
