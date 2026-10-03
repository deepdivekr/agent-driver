import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {i18nScript,controlCenterCopy} from '../dist/observability/i18n.js';
import {reviewedCopy} from '../dist/observability/ui-copy.js';
import {workHtml} from '../dist/observability/work-ui.js';

function translate(locale){
  const context={window:{},document:{documentElement:{},readyState:'loading',addEventListener(){}},localStorage:{getItem:()=>locale}};
  runInNewContext(i18nScript,context);return context.window.officeText;
}
test('display copy: all registered phrases have stable Korean and English wording',()=>{
  assert.ok(Object.keys(controlCenterCopy.ko).length>1000);
  for(const locale of ['ko','en']){
    const text=translate(locale);
    for(const [source,expected] of Object.entries(controlCenterCopy[locale])){
      assert.equal(text(source),expected,locale+': '+source);
      assert.equal(text(expected),expected,locale+' must be idempotent: '+source);
      if(locale==='ko')assert.doesNotMatch(expected,/앱(?:가|를|는)/u,'The renamed noun keeps the correct Korean particle: '+source);
    }
  }
});
test('display copy: short labels agree across intake, settings, import and progress',()=>{
  const ko=translate('ko'),en=translate('en');
  for(const [source,korean,english] of [
    ['완료 조건','완료 기준','Completion criteria'],
    ['진행 단계','업무 진행','Progress'],
    ['작업물 확인 방법','결과 받을 곳','Receive results'],
    ['MCP 연결','연결','Connect'],
    ['에이전트 연결','AI 앱 연결','Connect AI apps'],
    ['프로젝트 살펴보기','프로젝트 분석','Analyze project'],
    ['실행기','실행 도구','Execution tool'],
  ]){assert.equal(ko(source),korean);assert.equal(en(source),english);}
});
test('display copy: verification, permissions, delivery uncertainty and API cost are not hidden',()=>{
  const ko=translate('ko'),en=translate('en');
  assert.match(ko('Run 성공은 Work의 모든 완료조건 충족을 자동으로 뜻하지 않습니다.'),/모든 완료 기준.*아닐 수/u);
  assert.match(en('Run 성공은 Work의 모든 완료조건 충족을 자동으로 뜻하지 않습니다.'),/may not meet every/u);
  assert.match(ko('저장됨 · 발송 연결 미확인'),/전송 확인 전/u);
  assert.match(en('저장됨 · 발송 연결 미확인'),/not confirmed/u);
  assert.match(ko('전송 여부가 불확실합니다. 메신저에서 수신 여부를 확인하세요.'),/불확실.*수신 여부/u);
  assert.match(ko('Jev API 비용 가능성을 확인하고 연결에 동의합니다'),/API 비용.*동의/u);
  assert.match(ko('구독 한도를 소진해도 유료 API로 자동 전환하지 않습니다.'),/자동 전환하지 않아요/u);
  assert.match(en('구독 한도를 소진해도 유료 API로 자동 전환하지 않습니다.'),/never triggers an automatic switch/u);
  assert.match(ko('현재 실행 미관측'),/미확인/u);
});
test('display copy: unknown requests, credentials, identifiers and file content remain verbatim',()=>{
  for(const locale of ['ko','en'])for(const value of [
    '매일 20시에 Re:spac 방에 결과를 보내줘',
    '/home/me/업무/Work.json', 'runtime_work_start', 'CLIENT_SCHEMA_INVALID', '__proto__', 'constructor', 'toString',
    '{"실행기":"사용자 원문","rows":35}', 'fixture-secret-value-do-not-translate',
  ])assert.equal(translate(locale)(value),value);
});
test('display copy: recommendations do not claim measured benefits or actual Jev installation',()=>{
  const pair=reviewedCopy['읽기 전용 분석에서 나온 제안입니다. 실제 반복 빈도·정답률·속도 이득은 아직 검증되지 않았습니다. Work에서 Jev를 켜도 이 후보 단계에 자동으로 삽입되지는 않습니다.'];
  assert.match(pair[0],/아직 확인하지 않았어요.*자동으로 추가되지는 않아요/u);
  assert.match(pair[1],/have not been verified.*does not automatically add/u);
});
test('display copy: suggestion labels are localized while the actual AI explanation stays verbatim',()=>{
  const script=workHtml('copy-test').match(/<script nonce="copy-test">([\s\S]*?)<\/script>/u)[1];
  const helper=script.slice(script.indexOf('function renderJevRecommendations'),script.indexOf('function invalidateImportPreview'));
  for(const locale of ['ko','en']){
    const context={window:{officeText:translate(locale)},esc:value=>String(value),item:{step_goal:'완료 조건',judgment:'실행기',why_fit:'작업물 확인 방법',baseline:'Work',expected_gain:'사용자 지침 원문',answer_shape:'yes_no'}};
    runInNewContext(helper,context);
    const html=runInNewContext('renderJevRecommendations([item],"complete")',context);
    for(const raw of ['완료 조건','실행기','작업물 확인 방법','Work','사용자 지침 원문'])assert.ok(html.includes('<span data-i18n-skip>'+raw+'</span>'));
    assert.ok(html.includes(locale==='en'?'Why Jev fits':'Jev가 맞는 이유'));
    assert.ok(html.includes(locale==='en'?'Efficiency gains':'실제 개선 폭')||html.includes('실제 개선 폭은 측정하지 않았습니다.'),'The display disclaimer remains present');
  }
});
