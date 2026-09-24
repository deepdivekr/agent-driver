import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {chromium} from 'playwright';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {readWorkBoard,readWorkDetail} from '../dist/observability/work-view.js';
import {workHtml} from '../dist/observability/work-ui.js';

const git={head:'a'.repeat(40),state_sha256:'b'.repeat(64),changed_paths:[]};
const session='11111111-1111-4111-8111-111111111111';
const escape=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'coding-dialog-view-'));
  const path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'coding-dialog-view',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off',model_data_approved:false},swarm:{enabled:false,model_data_approved:false}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath),project=config.project.id,workId='work-1',at=new Date().toISOString();
  store.registerProject(config.project);
  store.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run(workId,project,'코딩 업무','기능을 구현한다',at,at);
  store.connection.prepare("INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,'ready',0,?,?,'[]','{}',?,?)").run(workId,project,'request-1','fixture','quick','기능을 구현해줘',JSON.stringify({route:{kind:'pack',pack_family:'coding.orchestrate'},completion_checks:[]}),at,at);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {store,config,project,workId};
}

test('Work detail keeps full Codex response, exact session and supervisor advice in separate fields',async t=>{
  const x=await setup(t),before=readWorkDetail(x.store,x.config,x.workId);
  assert.equal(before.coding_attach.eligible,true);
  assert.equal(before.coding_dialog,null);
  const dialog=x.store.beginCodingDialog(x.project,'request-1',x.workId,'demo','/fixture/repo','fingerprint','gpt-test',git,session,'기능을 구현한다').dialog;
  const queued=x.store.queueCodingDialogTurn(x.project,dialog.id,dialog.revision,'turn-1','기능을 구현하고 변경사항을 설명해줘');
  const claimed=x.store.claimCodingDialogTurn(x.project,dialog.id,queued.dialog.revision);
  const reply='실제 Codex 답변\n'+('<script>alert(1)</script>\n').repeat(120);
  const completed=x.store.completeCodingDialogTurn(x.project,dialog.id,claimed.turn.id,claimed.owner,session,'gpt-test',reply,git);
  x.store.setCodingDialogAdvice(x.project,dialog.id,completed.revision,claimed.turn.id,'다음에는 테스트를 검토하는 것이 좋습니다.');
  const detail=readWorkDetail(x.store,x.config,x.workId),board=readWorkBoard(x.store,x.config);
  assert.equal(board.works[0].run.kind,'coding_dialog');
  assert.equal(board.works[0].run.status,'waiting_user');
  assert.equal(detail.coding_attach.eligible,false);
  assert.equal(detail.coding_dialog.session_id,session);
  assert.equal(detail.coding_dialog.can_turn,true);
  assert.equal(detail.coding_dialog.turns[0].reply,reply);
  assert.equal(detail.coding_dialog.turns[0].advice,'다음에는 테스트를 검토하는 것이 좋습니다.');
  assert.equal(detail.progress_percent,null);
  assert.equal(detail.completion_verified,false);
});

test('conversation UI escapes long Codex reply and labels advice separately; catalog never preselects a session',()=>{
  const html=workHtml('safe-nonce'),script=html.match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script));
  const helpers=script.slice(script.indexOf('function renderCodingAttach'),script.indexOf('function renderDetail'));
  const context={esc:escape,labels:{waiting_user:'사용자 지시 대기',completed:'실행 완료'},attachProjectRef:'demo',attachSessionId:'',codingCatalogProject:'demo',codingCatalog:{sessions:[{id:session,title:'기존 작업',preview:'변경 사항',status:'idle',selectable:true},{id:'22222222-2222-4222-8222-222222222222',title:'진행 중',preview:'',status:'active',selectable:false}]},codingDraft:'',codingReconcileResult:null};
  const attach=vm.runInNewContext(helpers+"\nrenderCodingAttach({suggested_project_ref:'demo',registered_project_refs:['demo','other']})",context);
  assert.match(attach,/기존 작업/u);
  assert.match(attach,/진행 중/u);
  assert.match(attach,/option value="demo" selected/u);
  assert.match(attach,/disabled/u);
  assert.doesNotMatch(attach,/checked/u);
  const longReply='<img src=x onerror=alert(1)>\n'+'반복 답변'.repeat(900);
  const dialog={project_ref:'demo',session_id:session,model:'gpt-test',status:'waiting_user',can_turn:true,can_stop:true,needs_reconcile:false,turns:[{id:'turn-1',ordinal:0,instruction:'구현해줘',status:'completed',reply:longReply,reply_redacted:false,advice:'테스트를 요청해보세요.',session_id:session,model:'gpt-test',reason:null,created_at:'2026-09-24T00:00:00.000Z',completed_at:'2026-09-24T00:01:00.000Z'}]};
  const rendered=vm.runInNewContext('renderCodingConversation(dialog)',{...context,dialog});
  assert.match(rendered,/Codex 답변/u);
  assert.match(rendered,/상위 에이전트 조언/u);
  assert.ok(rendered.indexOf('Codex 답변')<rendered.indexOf('상위 에이전트 조언'));
  assert.match(rendered,/반복 답변/u);
  assert.ok(rendered.length>longReply.length);
  assert.match(rendered,/&lt;img src=x onerror=alert\(1\)&gt;/u);
  assert.doesNotMatch(rendered,/<img src=x onerror=alert\(1\)>/u);
  assert.match(rendered,/id="coding-followup"/u);
  assert.match(rendered,/id="coding-send"/u);
});

test('UI wires only explicit session attach and user turn, with revision and request id',()=>{
  const html=workHtml('safe-nonce');
  assert.match(html,/work\/coding\/sessions\?project_ref=/u);
  assert.match(html,/work\/coding\/attach/u);
  assert.match(html,/work\/coding\/turn/u);
  assert.match(html,/work\/coding\/stop/u);
  assert.match(html,/work\/coding\/reconcile/u);
  assert.match(html,/expected_revision:dialog\.revision/u);
  assert.match(html,/session_id:attachSessionId/u);
  assert.doesNotMatch(html,/value="new"/u);
  assert.match(html,/if\(event\.target\.closest\('#coding-send'\)\)sendCodingInstruction\(\)/u);
  assert.match(html,/if\(event\.target\.closest\('#coding-attach'\)\)attachCodingSession\(\)/u);
});

test('desktop and mobile Work conversation preserves full reply and sends only a user-submitted next turn',async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  for(const width of [1280,390]){
    const page=await browser.newPage({viewport:{width,height:900}}),calls=[],errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    const reply='Codex completed the requested change.\n'+'Detailed explanation. '.repeat(400);
    const detail={id:'work-1',title:'기능 구현',goal:'테스트 가능한 기능',prompt:'테스트 가능한 기능 구현',work_status:'running',run_status:'waiting_user',spec:{completion_checks:[]},stages:[],progress_percent:null,control:null,work_control:null,swarm:false,coding:false,agent_count:0,verified_steps:0,total_steps:0,progress_basis:'업무 완료 확인 전',pack:'coding.orchestrate',coding_attach:{eligible:false},coding_dialog:{id:'dialog-1',project_ref:'demo',session_id:session,model:'gpt-test',status:'waiting_user',revision:5,can_turn:true,can_stop:true,needs_reconcile:false,turns:[{id:'turn-1',ordinal:0,instruction:'첫 작업',status:'completed',reply,reply_redacted:false,advice:'다음은 테스트 결과를 확인해보세요.',advice_at:'2026-09-24T00:00:02.000Z',session_id:session,model:'gpt-test',reason:null,created_at:'2026-09-24T00:00:00.000Z',completed_at:'2026-09-24T00:00:01.000Z'}]},jev:null,imported_plan:null,imported_coding:null,client_handoffs:[],runs:[],events:[],completion_note:'업무 완료는 별도로 확인해야 합니다.'};
    await page.route('https://office.test/**',async route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:workHtml('safe-nonce')});
      if(url.pathname==='/work/board')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({works:[{id:'work-1',title:'기능 구현',status:'waiting_user',run:{kind:'coding_dialog'}}],auth_attention_count:0})});
      if(url.pathname==='/work/detail')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail)});
      if(url.pathname==='/work/events')return route.fulfill({status:200,contentType:'text/event-stream',body:''});
      if(url.pathname==='/work/coding/turn'){
        calls.push(JSON.parse(route.request().postData()));
        detail.run_status='running';detail.coding_dialog.status='running';detail.coding_dialog.can_turn=false;
        return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'running'})});
      }
      return route.fulfill({status:404,body:'not found'});
    });
    await page.goto('https://office.test/');
    await page.locator('.tile').click();
    await page.getByText('Codex 답변').waitFor();
    assert.equal(await page.locator('.coding-answer pre').first().textContent(),reply);
    assert.equal(await page.getByText('상위 에이전트 조언').count(),1);
    assert.equal(calls.length,0);
    await page.locator('#coding-followup').fill('기존 변경의 테스트를 검증해줘');
    await page.getByRole('button',{name:'Codex에 지시 보내기'}).click();
    await page.getByText('이전 지시의 결과를 기다리는 중입니다.').waitFor();
    assert.equal(calls.length,1);
    assert.equal(calls[0].dialog_id,'dialog-1');
    assert.equal(calls[0].expected_revision,5);
    assert.equal(calls[0].instruction,'기존 변경의 테스트를 검증해줘');
    assert.ok(typeof calls[0].request_id==='string'&&calls[0].request_id.length>10);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
    assert.deepEqual(errors,[]);
    await page.close();
  }
});

test('reviewed Git reconciliation is a separate local action and never replays the failed turn',async t=>{
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage(),posts=[];
  const dialog={id:'dialog-1',project_ref:'demo',session_id:session,model:'gpt-test',status:'reconciliation_required',revision:5,can_turn:false,can_stop:false,needs_reconcile:true,turns:[{id:'turn-1',ordinal:0,instruction:'구현해줘',status:'uncertain',reply:null,advice:null,reason:'결과 확인 필요',created_at:'2026-09-24T00:00:00.000Z'}]};
  const detail={id:'work-1',title:'기능 구현',goal:'테스트 가능한 기능',prompt:'테스트 가능한 기능 구현',work_status:'running',run_status:'reconciliation_required',spec:{completion_checks:[]},stages:[],progress_percent:null,control:null,work_control:null,swarm:false,coding:false,agent_count:0,verified_steps:0,total_steps:0,progress_basis:'업무 완료 확인 전',pack:'coding.orchestrate',coding_attach:{eligible:false},coding_dialog:dialog,jev:null,imported_plan:null,imported_coding:null,client_handoffs:[],runs:[],events:[],completion_note:'결과 확인 필요'};
  await page.route('https://office.test/**',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/')return route.fulfill({status:200,contentType:'text/html; charset=utf-8',body:workHtml('safe-nonce')});
    if(url.pathname==='/work/board')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({works:[{id:'work-1',title:'기능 구현',status:'reconciliation_required',run:{kind:'coding_dialog'}}],auth_attention_count:0})});
    if(url.pathname==='/work/detail')return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(detail)});
    if(url.pathname==='/work/events')return route.fulfill({status:200,contentType:'text/event-stream',body:''});
    if(url.pathname==='/work/coding/reconcile'){
      const body=JSON.parse(route.request().postData());posts.push(body);
      if(body.action==='accept_current_git'){dialog.status='waiting_user';dialog.needs_reconcile=false;dialog.can_turn=true;dialog.revision++;return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'waiting_user',auto_replay:false})});}
      return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({status:'reconciliation_required',revision:5,observed_git:{head:'a'.repeat(40),state_sha256:'b'.repeat(64)},session_status:'idle'})});
    }
    return route.fulfill({status:404,body:'not found'});
  });
  await page.goto('https://office.test/');await page.locator('.tile').click();
  assert.equal(await page.locator('#coding-accept-reconciliation').count(),0);
  await page.locator('#coding-reconcile').click();
  await page.locator('#coding-accept-reconciliation').waitFor();
  await page.locator('#coding-accept-reconciliation').click();
  assert.equal(posts.length,1);
  await page.locator('#coding-git-reviewed').check();await page.locator('#coding-session-reviewed').check();
  await page.locator('#coding-accept-reconciliation').click();
  await page.locator('#coding-followup').waitFor();
  assert.equal(posts.length,2);assert.equal(posts[1].action,'accept_current_git');
  assert.equal(posts[1].confirm_git_reviewed,true);assert.equal(posts[1].confirm_session_reviewed,true);
  assert.equal(await page.locator('#coding-send').count(),1);
});
