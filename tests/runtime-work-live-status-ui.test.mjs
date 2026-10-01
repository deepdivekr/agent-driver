import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {workHtml} from '../dist/observability/work-ui.js';
import {i18nScript} from '../dist/observability/i18n.js';
import {taskModelUiScript} from '../dist/observability/task-model-ui.js';

// Actual UI/i18n functions in a unit DOM contract. No browser, model, runtime,
// bot, persistent state, external URL or delivery connector is invoked.
const script=workHtml('live-status-nonce').match(/<script nonce="live-status-nonce">([\s\S]*?)<\/script>/u)[1];
const start=script.indexOf('function activitySummary'),end=script.indexOf('function renderDetailBody');
assert.ok(start>=0&&end>start);
const helpers=script.slice(start,end),at='2026-09-29T15:00:00.000Z';
function context(language='en'){
  const value={window:{},localStorage:{getItem:()=>language},document:{documentElement:{lang:''},readyState:'loading',addEventListener(){}},labels:{},esc:value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))};
  vm.runInNewContext(i18nScript+taskModelUiScript+helpers,value);return value;
}

test('runtime unit unsupported app response schema is actionable in Korean and English without suggesting login or quota refresh',()=>{
  const admission=script.slice(script.indexOf('function executionAdmissionMessage'),script.indexOf('async function readWorkStartResponse'));
  assert.ok(admission.startsWith('function executionAdmissionMessage'));
  for(const language of ['ko','en']){
    const x=context(language);vm.runInNewContext(admission,x);
    for(const code of ['CLIENT_SCHEMA_INVALID','CLIENT_OUTPUT_SCHEMA_UNSUPPORTED']){
      x.reason=code;x.data={definition_status:'needs_model',reason:code};
      const cause=vm.runInNewContext('executionReason(reason)',x),intake=vm.runInNewContext('admissionMessage(data)',x);
      assert.equal(intake,cause);assert.match(cause,language==='ko'?/응답 형식.*앱 수정/u:/response schema.*app is fixed/u);
      assert.doesNotMatch(cause,/CLIENT_|로그인 필요|login again|quota exhausted/u);
      if(language==='en')assert.doesNotMatch(cause,/[가-힣]/u);
    }
  }
});

test('runtime unit allocation success is not an error reason and actual model names remain visible without native session metadata',()=>{
  for(const language of ['ko','en']){
    const x=context(language);
    x.row={kind:'models.assigned',metadata:{reason:'allocated'}};
    const assigned=vm.runInNewContext('activitySummary(row)',x);assert.doesNotMatch(assigned,/상세 원인|detailed cause|allocated/u);
    x.row={kind:'model.result',metadata:{model_name:'observed-model'}};
    const model=vm.runInNewContext('activitySummary(row)',x);assert.match(model,/observed-model/u);if(language==='en')assert.doesNotMatch(model,/[가-힣]/u);
    x.row={kind:'model.result',metadata:{model_name:'resumed-model',model_continuity:'resumed_session'}};
    const reused=vm.runInNewContext('activitySummary(row)',x);assert.match(reused,/resumed-model/u);assert.match(reused,/담당자 세션|assignee session/u);
  }
});

test('runtime unit empty steps distinguish queued, live model work, unobserved and paused states from a real Start action',()=>{
  for(const language of ['ko','en']){
    const x=context(language),cases=[
      [{supervisor:{state:'queued',live:false}},/접수|queued/u],
      [{supervisor:{state:'running',live:true},activity:[{kind:'model.started'}]},/AI.*정하는 중|AI is choosing/u],
      [{supervisor:{state:'running',live:true},activity:[{kind:'model.result'}]},/실행 중|Execution is active/u],
      [{supervisor:{state:'running',live:false},execution:{live:false}},/관측되지|not yet been observed/u],
      [{supervisor:{state:'paused',live:false},activity:[{kind:'model.started'}]},/멈춘 이유|why it stopped/u],
      [{supervisor:{state:'retry_wait',live:false}},/멈춘 이유|why it stopped/u],
      [{display_status:'defining',execution:{live:true}},/업무 분석 중|Work analysis is active/u]
    ];
    for(const [data,expected] of cases){x.data=data;const text=vm.runInNewContext('window.officeText(emptyStageMessage(data))',x);assert.match(text,expected);assert.doesNotMatch(text,/업무 시작을 누르면|Press Start Work/u);if(language==='en')assert.doesNotMatch(text,/[가-힣]/u);}
    x.data={display_status:'ready',execution_action:{can_execute:true}};assert.match(vm.runInNewContext('window.officeText(emptyStageMessage(data))',x),/업무 시작을 누르면|Press Start Work/u);
    x.data.runtime_configuration={state:'failed'};assert.doesNotMatch(vm.runInNewContext('window.officeText(emptyStageMessage(data))',x),/업무 시작을 누르면|Press Start Work/u);
  }
  assert.match(script,/emptyStageMessage\(d\)/u,'the actual empty-stage markup uses the state-aware helper');
});

test('runtime unit analysis preserves confirmed browser engine after a model event without claiming a planned route was observed',()=>{
  const x=context();x.data={spec:{desired_outcome:'Source-grounded research.',route:{kind:'pack',pack_family:'research.search'},plan:{steps:[]}},current_operation:{kind:'model.started',executor:'planned_neo',summary:'Next action.',observed_at:at},activity:[{kind:'source.observed',metadata:{status:'succeeded',engine:'playwright'}}],observed_sources:[]};
  assert.equal(vm.runInNewContext('observedExecutor(data).name',x),'playwright');const html=vm.runInNewContext('workAnalysisHtml(data)',x);const renderedLabel=html.match(/<dt>([^<]+)<\/dt><dd>playwright<\/dd>/u)?.[1];assert.equal(renderedLabel,'최근 관측된 실행기','the rendered caption describes a confirmed previous observation');x.renderedLabel=renderedLabel;assert.equal(vm.runInNewContext('window.officeText(renderedLabel)',x),'Recently observed executor','the actual i18n translator used by the DOM walker translates the rendered caption');assert.match(html,/playwright/u);assert.doesNotMatch(html,/planned_neo/u);
  x.data.activity=[];x.data.observed_sources=[{engine:'playwright',observed_at:at}];assert.equal(vm.runInNewContext('observedExecutor(data).name',x),'playwright');
  x.data.observed_sources=[];x.data.activity=[{kind:'tool.result',metadata:{status:'succeeded',engine:'windows_uia'}}];assert.equal(vm.runInNewContext('observedExecutor(data).name',x),'windows_uia');
  x.data.activity=[{kind:'tool.result',metadata:{status:'waiting_approval',engine:'aside'}}];assert.equal(vm.runInNewContext('observedExecutor(data)',x),null);
  x.data.activity=[{kind:'source.observed',metadata:{status:'failed',engine:'aside'}}];assert.equal(vm.runInNewContext('observedExecutor(data)',x),null);
  x.data.current_operation={kind:'dispatch.selected',engine:'planned_neo',metadata:{status:'preparing'}};x.data.activity=[];assert.equal(vm.runInNewContext('observedExecutor(data)',x),null);
  assert.match(script,/s\.executor==='client'\?t\('실행 경로: 연결된 AI','Execution route: connected AI'\)/u,'client dispatch is labelled as a route, not a browser engine');
  assert.match(script,/<span>'\+esc\(t\('도구 기록 확인','Tool records observed'\)\)\+'<\/span>/u,'confirmed tool records remain distinct from Work completion');
});

test('runtime unit ordinary live worker counts use host observations and distinguish Swarm sub-agents without planned or unknown counts',()=>{
  const x=context();x.data={supervisor:{kind:'client',active_workers:0},execution:{live:true,active_workers:1,basis:'work_supervisor_lease'},agent_count:12};assert.equal(vm.runInNewContext('workerSummary(data)',x),'Currently active workers: 1');
  x.data.execution={live:false,active_workers:0,basis:'no_active_lease'};assert.equal(vm.runInNewContext('workerSummary(data)',x),'Currently active workers: 0');
  for(const count of [undefined,null,'1',-1,1.5]){x.data.execution.active_workers=count;assert.equal(vm.runInNewContext('workerSummary(data)',x),'');}
  x.data={supervisor:{kind:'swarm',active_workers:3},execution:{live:true,active_workers:1},agent_count:12};assert.equal(vm.runInNewContext('workerSummary(data)',x),'Currently active sub-agents: 3');
  x.data={supervisor:{kind:'client',active_workers:0},execution:{live:true,active_workers:1},swarm:true};assert.equal(vm.runInNewContext('workerSummary(data)',x),'Currently active workers: 1','current supervisor identity takes precedence over a legacy Swarm flag');
});

test('runtime unit host dispatch selection is localized in both the friendly timeline and technical tail without translating model text',()=>{
  const raw='The configured client and host tool capabilities were selected for this Work run.',paint=script.slice(script.indexOf('function paintWorkTail'),script.indexOf('function activityViewKey'));
  for(const language of ['ko','en']){
    const x=context(language),nodes={'work-tail-output':{textContent:'',scrollHeight:0,scrollTop:0,clientHeight:0},'work-timeline':{dataset:{},innerHTML:''},'work-worker-summary':{},'work-tail-state':{},'work-tail-last':{}};
    x.row={kind:'dispatch.selected',summary:raw,created_at:at,metadata:{status:'preparing',executor:'client'}};x.detail={activity:[x.row]};x.document.getElementById=id=>nodes[id];x.tailConnectionState='live';
    const caption=vm.runInNewContext('activitySummary(row)',x);assert.match(caption,language==='ko'?/설정된 AI와 실행 도구/u:/configured AI and host tools/u);if(language==='en')assert.doesNotMatch(caption,/[가-힣]/u);
    vm.runInNewContext(paint+'\npaintWorkTail()',x);assert.ok(nodes['work-tail-output'].textContent.includes(caption));assert.ok(nodes['work-timeline'].innerHTML.includes(caption));assert.doesNotMatch(nodes['work-tail-output'].textContent,/configured client and host tool capabilities/u);
    x.row={kind:'unrecognized.model.detail',summary:'Keep this actual model text verbatim.'};assert.equal(vm.runInNewContext('activitySummary(row)',x),x.row.summary);
  }
});

test('runtime unit observed search challenge is localized and retryable tool activity is not successful or Work completion',()=>{
  const paint=script.slice(script.indexOf('function paintWorkTail'),script.indexOf('function activityViewKey')),body=script.slice(script.indexOf('function renderDetailBody'),script.indexOf('let activityStream='));
  for(const language of ['ko','en']){
    const x=context(language),nodes={'work-tail-output':{textContent:'',scrollHeight:0,scrollTop:0,clientHeight:0},'work-timeline':{dataset:{},innerHTML:''},'work-worker-summary':{},'work-tail-state':{},'work-tail-last':{},back:{}};
    x.labels={retryable_failure:'재시도 대기',paused:'일시정지됨'};x.row={kind:'search.blocked',summary:'The public search provider returned an observed access challenge. No login, challenge bypass or browser replay was attempted.',created_at:at,metadata:{status:'retryable_failure',reason:'WORK_SEARCH_PROVIDER_CHALLENGE'}};
    x.detail={id:'11111111-1111-4111-8111-111111111111',title:'Search challenge',goal:'Find source-grounded research.',work_status:'ready',display_status:'paused',spec:null,supervisor:{kind:'client',state:'paused',live:false},execution:{live:false,active_workers:0},activity:[x.row,{kind:'tool.result',summary:'A challenge page is not an article.',created_at:at,metadata:{tool_name:'office_web_search',status:'retryable_failure'}}],stages:[{id:'query',label:'자료 조회',objective:'office_web_search',status:'retryable_failure',verified:false,executor:'client',attempts:1,owner:null}],verified_steps:0,total_steps:1,progress_percent:null,runs:[],completion_verified:false,completion_note:'도구 기록은 업무 완료와 다릅니다.'};
    x.document.getElementById=id=>nodes[id]??null;x.tailConnectionState='live';const caption=vm.runInNewContext('activitySummary(row)',x);assert.match(caption,language==='ko'?/자료를 가져오지 못했습니다/u:/no research material was retrieved/u);assert.match(caption,language==='ko'?/추가 확인을 요구/u:/requested additional verification/u);assert.doesNotMatch(caption,/WORK_SEARCH_PROVIDER_CHALLENGE/u);if(language==='en')assert.doesNotMatch(caption,/[가-힣]/u);
    vm.runInNewContext(paint+'\npaintWorkTail()',x);assert.equal((nodes['work-timeline'].innerHTML.match(/timeline-failure/gu)||[]).length,2);assert.doesNotMatch(nodes['work-timeline'].innerHTML,/timeline-success|업무 실행 성공|Work execution succeeded/u);assert.ok(nodes['work-tail-output'].textContent.includes(caption));assert.match(nodes['work-timeline'].innerHTML,/재시도 대기|Retry pending/u);
    x.app={innerHTML:'',querySelectorAll:()=>[]};x.updateConnection=()=>{};x.showBoard=()=>{};x.liveStageHtml=()=>'';x.fileWorkPanel=()=>'';x.editing=null;x.attention=status=>status==='retryable_failure';vm.runInNewContext(body+'\nrenderDetailBody()',x);assert.match(x.app.innerHTML,/data-verified="false"/u);assert.match(x.app.innerHTML,/class="step t-hu /u);assert.doesNotMatch(x.app.innerHTML,/class="step t-done|aria-valuenow="100"/u);assert.equal(x.detail.completion_verified,false);
  }
});

test('runtime unit bounded recent run history includes the observed client supervisor exactly once and preserves legacy tool history',()=>{
  for(const language of ['ko','en']){
    const x=context(language);x.labels={paused:'일시정지됨'};x.data={runs:[],supervisor:{run_id:'observed-supervisor-id',kind:'client',state:'paused',updated_at:at}};
    let html=vm.runInNewContext('recentRunHistoryHtml(data)',x);assert.match(html,language==='ko'?/최근 실행 기록 1건/u:/Recent execution records · 1/u);assert.match(html,/observed-supervisor-id/u);assert.ok(html.includes(at));assert.match(html,/일시정지됨|Paused/u);
    x.data.runs=[{source_kind:'client',source_id:'observed-supervisor-id',created_at:at}];html=vm.runInNewContext('recentRunHistoryHtml(data)',x);assert.equal((html.match(/data-run-id="observed-supervisor-id"/gu)||[]).length,1);assert.doesNotMatch(html,/최근 실행 기록 2건|Recent execution records · 2/u);
    x.data={runs:[],supervisor:{run_id:'missing-time-id',kind:'client',state:'paused'}};html=vm.runInNewContext('recentRunHistoryHtml(data)',x);assert.match(html,language==='ko'?/미관측/u:/Not observed/u);assert.doesNotMatch(html,/2026-/u,'a missing observed timestamp is never replaced with now');
    x.data={runs:[{source_kind:'pack',source_id:'existing-tool-run',created_at:at}]};html=vm.runInNewContext('recentRunHistoryHtml(data)',x);assert.match(html,language==='ko'?/실행 이력 1건/u:/Run history · 1/u);assert.match(html,/existing-tool-run/u);
  }
});

test('runtime unit friendly timeline explains actual browser lifecycle and checkpoint failure while the technical log retains raw evidence',()=>{
  const paint=script.slice(script.indexOf('function paintWorkTail'),script.indexOf('function activityViewKey'));
  for(const language of ['ko','en']){
    const x=context(language),nodes={'work-tail-output':{textContent:'',scrollHeight:0,scrollTop:0,clientHeight:0},'work-timeline':{dataset:{},innerHTML:''},'work-worker-summary':{},'work-tail-state':{},'work-tail-last':{}};
    x.detail={activity:[{kind:'browser.selected',summary:'playwright / owned_headless',created_at:at,metadata:{engine:'playwright',status:'selected'}},{kind:'browser.observed',summary:'playwright / owned_headless',created_at:at,metadata:{engine:'playwright',status:'observed'}},{kind:'supervisor.result',summary:'failed · BROWSER_CHECKPOINT_BINDING_CHANGED',created_at:at,metadata:{status:'failed',reason:'BROWSER_CHECKPOINT_BINDING_CHANGED'}}],execution:{active_workers:0}};
    x.document.getElementById=id=>nodes[id];x.tailConnectionState='live';vm.runInNewContext(paint+'\npaintWorkTail()',x);
    assert.match(nodes['work-timeline'].innerHTML,language==='ko'?/브라우저 준비 완료/u:/Browser ready/u);
    assert.match(nodes['work-timeline'].innerHTML,language==='ko'?/현재 요청이 달라/u:/differs from this request/u);
    assert.doesNotMatch(nodes['work-timeline'].innerHTML,/owned_headless|BROWSER_CHECKPOINT_BINDING_CHANGED|Browser observation confirmed|브라우저 화면 관측 확인/u);
    assert.match(nodes['work-tail-output'].textContent,/owned_headless|BROWSER_CHECKPOINT_BINDING_CHANGED/u);
    assert.match(nodes['work-timeline'].innerHTML,/timeline-failure/u);
    if(language==='en'){
      const captions=Array.from(nodes['work-timeline'].innerHTML.matchAll(/<strong[^>]*>([^<]+)<\/strong>/gu),match=>match[1]);assert.doesNotMatch(captions.join(' '),/[가-힣]/u);
      // Raw Korean markup is translated by the real DOM walker; this unit's
      // string-only node stub does not execute that MutationObserver.
      x.label=nodes['work-timeline'].innerHTML.match(/<small><span>([^<]+)<\/span>/u)?.[1];assert.equal(vm.runInNewContext('window.officeText(label)',x),'Executor');
    }
  }
});
