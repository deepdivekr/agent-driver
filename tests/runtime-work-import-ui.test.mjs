import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {workHtml} from '../dist/observability/work-ui.js';

test('Work board exposes three import routes and does not activate on preview',()=>{
  const html=workHtml('safe-nonce');
  assert.match(html,/data-import-route="external"/u);
  assert.match(html,/data-import-route="workflow"/u);
  assert.match(html,/data-import-route="bot"/u);
  assert.match(html,/id="import-path"/u);
  assert.match(html,/id="import-json"/u);
  assert.match(html,/work\/import\/prompt/u);
  assert.match(html,/work\/import\/paste/u);
  assert.match(html,/work\/import\/scan/u);
  assert.match(html,/work\/import\/accept/u);
  assert.match(html,/work\/import\/coding\/start/u);
  assert.match(html,/work\/import\/coding\/step/u);
  assert.match(html,/다음 단계 실행/u);
  assert.match(html,/README 요약과 근거 위치를 해당 모델에 보낼 수 있습니다/u);
  assert.match(html,/개선용 업무 초안을 만듭니다/u);
  assert.match(html,/실행되거나 일정이 켜지지 않습니다/u);
  assert.match(html,/가져온 계획/u);
  assert.match(html,/원본 별도 확인 필요/u);
});

test('Jev remains optional with explicit cost acknowledgment in import and Work detail',()=>{
  const html=workHtml('safe-nonce');
  assert.match(html,/Jev는 선택사항입니다/u);
  assert.match(html,/API 비용이 발생할 수 있습니다/u);
  assert.match(html,/id="import-cost"/u);
  assert.match(html,/id="jev-cost"/u);
  assert.match(html,/work\/jev/u);
  assert.match(html,/cost_acknowledged/u);
});

test('inline Work UI JavaScript compiles and escapes preview fields',()=>{
  const html=workHtml('safe-nonce');
  const script=html.match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  assert.doesNotThrow(()=>new vm.Script(script));
  assert.match(script,/esc\(goal\)/u);
  assert.match(script,/esc\(completionDefault\)/u);
  assert.match(script,/esc\(value\)/u);
});

test('project scan preview reads analyzed goal and steps, and renders string unknowns safely',()=>{
  const html=workHtml('safe-nonce');
  const script=html.match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const fragment=script.slice(script.indexOf('function importField'),script.indexOf('async function importRequest'));
  const preview={hidden:true,innerHTML:''};
  const context={
    importResult:{import_id:'import-1',preview:{kind:'bot_only',purpose:'Old bot',unknowns:['trigger.timezone'],analysis:{goal:'Improve the bot safely',steps:[{goal:'Check new messages'}],completion:['Reply is delivered']},recommendations:['Add retry after failure']}},
    importFromScan:true,importPreview:preview,
    document:{getElementById:id=>id==='accept-import'?{onclick:null}:null},
    esc:value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),
    acceptImport:()=>{},
  };
  vm.runInNewContext(fragment+'\nrenderImportPreview();',context);
  assert.equal(preview.hidden,false);
  assert.match(preview.innerHTML,/value="Add retry after failure"/u);
  assert.doesNotMatch(preview.innerHTML,/value="Improve the bot safely"/u);
  assert.match(preview.innerHTML,/Check new messages/u);
  assert.match(preview.innerHTML,/Reply is delivered/u);
  assert.match(preview.innerHTML,/trigger\.timezone/u);
  assert.doesNotMatch(preview.innerHTML,/undefined · undefined/u);
  assert.match(preview.innerHTML,/개선용 업무 초안/u);
  assert.match(preview.innerHTML,/maxlength="500"/u);
});

test('Jev point and its reason use readable, escaped text in both import preview and Work detail',()=>{
  const script=workHtml('safe-nonce').match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const esc=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const recommendation={
    step_id:'triage',judgment:'새 메시지가 긴급한지 판단',answer_shape:'yes_no',
    why_fit:'메시지마다 표현이 달라져 내용을 읽고 짧게 판단합니다. <script>alert(1)</script>',
    evidence:[{file:'agent.py',line:5,signal:'semantic_judgment'}],status:'proposal_unverified',enabled:false,
  };
  const previewFragment=script.slice(script.indexOf('function importField'),script.indexOf('async function importRequest'));
  const preview={hidden:true,innerHTML:''};
  const previewContext={
    importResult:{import_id:'import-1',preview:{kind:'agentic_workflow',purpose:'Message workflow',analysis_status:'complete',analysis:{goal:'메시지 확인',steps:[{goal:'메시지 분류'}],completion:[{result:'분류 결과 확인'}]},jev_recommendations:[recommendation]}},
    importFromScan:true,importPreview:preview,document:{getElementById:id=>id==='accept-import'?{onclick:null}:null},esc,acceptImport:()=>{},
  };
  vm.runInNewContext(previewFragment+'\nrenderImportPreview();',previewContext);
  assert.match(preview.innerHTML,/새 메시지가 긴급한지 판단<\/b> · 예\/아니오 확인/u);
  assert.match(preview.innerHTML,/왜 Jev일까요\? 메시지마다 표현이 달라져/u);
  assert.match(preview.innerHTML,/근거: agent\.py:5/u);
  assert.match(preview.innerHTML,/실제 반복 빈도·정답률·속도 이득은 아직 검증되지 않았습니다/u);
  assert.match(preview.innerHTML,/자동으로 삽입되지는 않습니다/u);
  assert.match(preview.innerHTML,/API 비용이 발생할 수 있습니다/u);
  assert.match(preview.innerHTML,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.doesNotMatch(preview.innerHTML,/<script>alert\(1\)<\/script>/u);
  const helper=script.slice(script.indexOf('function renderJevRecommendations'),script.indexOf('function setImportRoute'));
  const detailFragment=script.slice(script.indexOf('function renderDetail'),script.indexOf('function render(){'));
  const app={innerHTML:'',querySelectorAll:()=>[]};
  const detail={id:'11111111-1111-4111-8111-111111111111',title:'메시지 검토',goal:'메시지 확인',prompt:'메시지 확인',work_status:'ready',run_status:null,spec:{completion_checks:[]},stages:[],progress_percent:null,control:null,work_control:null,jev:{enabled:false,can_change:true},jev_recommendations:[recommendation],jev_recommendation_status:'complete',runs:[],completion_note:''};
  const detailContext={app,detail,editing:null,esc,labels:{},attention:()=>false,updateConnection:()=>{},document:{getElementById:id=>id==='back'?{onclick:null}:null},showBoard:()=>{},setMessage:()=>{}};
  vm.runInNewContext(helper+detailFragment+'\nrenderDetail();',detailContext);
  assert.match(app.innerHTML,/새 메시지가 긴급한지 판단<\/b> · 예\/아니오 확인/u);
  assert.match(app.innerHTML,/왜 Jev일까요\? 메시지마다 표현이 달라져/u);
  assert.match(app.innerHTML,/읽기 전용 분석에서 나온 제안입니다/u);
  assert.match(app.innerHTML,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(app.innerHTML,/id="jev-toggle" disabled/u);
  assert.doesNotMatch(app.innerHTML,/<script>alert\(1\)<\/script>/u);
});

test('import preview says why no Jev point was suggested when analysis was not approved or lacked evidence',()=>{
  const script=workHtml('safe-nonce').match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const helper=script.slice(script.indexOf('function renderJevRecommendations'),script.indexOf('function setImportRoute'));
  const esc=value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  for(const [status,reason] of [['not_approved','AI의 프로젝트 자료 사용이 승인되지 않아'],['complete','읽은 코드에서 Jev에 적합하다고 설명할 수 있는 지점을 확인하지 못했습니다']]){
    const output=vm.runInNewContext(helper+'\nrenderJevRecommendations([],status)',{esc,status});
    assert.match(output,/Jev 추천 없음/u);
    assert.ok(output.includes(reason));
    assert.doesNotMatch(output,/Jev가 도움이 될 수 있는 지점/u);
  }
});

test('import acceptance requires goal, completion and separate Jev cost acknowledgment',async()=>{
  const script=workHtml('safe-nonce').match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const fragment=script.slice(script.indexOf('async function acceptImport'),script.indexOf('async function submitWork'));
  const inputs={'import-goal':{value:'Improve the bot'},'import-completion':{value:'Verified new behavior'},'import-jev':{checked:true},'import-cost':{checked:false}};
  const messages=[],calls=[];
  const context={importResult:{import_id:'import-1',kind:'project',preview:{kind:'bot_only'}},importBusy:false,document:{getElementById:id=>inputs[id]},setMessage:value=>messages.push(value),fetch:async(_url,options)=>{calls.push(JSON.parse(options.body));return {ok:true,json:async()=>({work_id:'work-1'})}},openWork:()=>{}};
  await vm.runInNewContext(fragment+'\nacceptImport()',context);
  assert.equal(calls.length,0);
  assert.match(messages.at(-1),/비용/u);
  inputs['import-cost'].checked=true;
  await vm.runInNewContext('acceptImport()',context);
  assert.equal(calls.length,1);
  assert.equal(calls[0].mode,'augment');
  assert.equal(calls[0].jev_enabled,true);
  assert.equal(calls[0].cost_acknowledged,true);
});
