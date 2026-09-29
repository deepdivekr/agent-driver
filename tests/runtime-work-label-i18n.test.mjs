import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {i18nScript} from '../dist/observability/i18n.js';

const labels=[['실행','Run'],['가져올 업무 찾기','Find work to import'],['서버 업무 찾기','Find server work'],['연결 정보 저장','Save connection']];
function fixture(locale){
  const context={window:{},document:{documentElement:{},readyState:'loading',addEventListener(){}},localStorage:{getItem:()=>locale}};
  runInNewContext(i18nScript,context);return context;
}

test('UI i18n unit: dynamic execution and hidden import/remote action labels have explicit English mappings',()=>{
  const context=fixture('en');assert.equal(context.document.documentElement.lang,'en');
  for(const [source,expected] of labels)assert.equal(context.window.officeText(source),expected,source);
  const goal='로컬 원본의 값 23과 17을 확인하고 한국어 보고서를 작성해줘';
  assert.equal(context.window.officeText(goal),goal,'User Work content is not translated as a fixed button label');
});

test('UI i18n unit: Korean keeps the source action labels and English labels remain unchanged',()=>{
  const context=fixture('ko');assert.equal(context.document.documentElement.lang,'ko');
  for(const [source,english] of labels){assert.equal(context.window.officeText(source),source);assert.equal(context.window.officeText(english),english);}
});
