import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
import {i18nScript} from '../dist/observability/i18n.js';

// The Control Center markup keeps its original Korean source text and is rewritten when shown. A text the copy
// catalog does not know is shown as written: in the old formal tone in Korean, and in Korean in English mode.
// These tests read the UI sources so that such a text fails here instead of appearing on a screen.
const dir=new URL('../src/observability/',import.meta.url);
// office-ui.ts is the earlier page that nothing serves any more.
const sources=readdirSync(dir).filter(file=>file.endsWith('.ts')&&!/^(?:ui-copy|ui-copy-extra|i18n|office-ui)\.ts$/u.test(file)).map(file=>({file,text:readFileSync(new URL(file,dir),'utf8')}));
const display=locale=>{const context={window:{},document:{documentElement:{},readyState:'loading',addEventListener(){}},localStorage:{getItem:()=>locale}};runInNewContext(i18nScript,context);return context.window;};
const ko=display('ko'),en=display('en');
const oldWording=/니다(?:[.!?\s)]|$)|클라이언트|실행기|완료 ?조건|관측|작업 ?지침/u,hangul=/[가-힣]/u;
const unique=(rows,key)=>[...new Map(rows.map(row=>[key(row),row])).values()];
// Texts written directly in markup: element text and the three attributes the display script rewrites.
const staticTexts=unique(sources.flatMap(({file,text})=>[
  ...[...text.matchAll(/>([^<>{}`$'"+()=;]*[가-힣][^<>{}`$'"+()=;]*)</gu)].map(match=>({file,text:match[1].trim()})),
  ...[...text.matchAll(/(?:placeholder|aria-label|title)="([^"$'+]*[가-힣][^"$'+]*)"/gu)].map(match=>({file,text:match[1].trim()})),
]).filter(row=>row.text),row=>row.text);
// Calls that pass both languages: fn('한국어','English').
const pairs=unique(sources.flatMap(({file,text})=>[...text.matchAll(/\b[A-Za-z]+\('((?:[^'\\$]|\\.)*[가-힣](?:[^'\\$]|\\.)*)','((?:[^'\\$]|\\.)*)'\)/gu)].map(match=>({file,ko:match[1].replace(/\\'/gu,"'"),en:match[2].replace(/\\'/gu,"'")}))),row=>row.ko);
// Shown by an element that paints its own two-language label (data-i18n-skip), or an example path whose backslashes
// are escaped differently in the source than in the page.
const ownLabel=new Set(['다크 모드','다크 모드로 전환','예: /home/me/projects/my-bot 또는 C:\\\\projects\\\\my-bot']);

test('display copy coverage: the sources hold the texts this test reads',()=>{
  assert.ok(staticTexts.length>300,`static texts found: ${staticTexts.length}`);assert.ok(pairs.length>120,`two-language calls found: ${pairs.length}`);
});
test('display copy coverage: no text written in the markup keeps the old terms or the formal tone in Korean',()=>{
  const left=staticTexts.filter(row=>!ownLabel.has(row.text)&&oldWording.test(ko.officeText(row.text)));
  assert.deepEqual(left.map(row=>`${row.file}: ${row.text}`),[],'Register these texts in ui-copy.ts or ui-copy-extra.ts');
});
test('display copy coverage: every text written in the markup has English wording',()=>{
  const left=staticTexts.filter(row=>!ownLabel.has(row.text)&&hangul.test(en.officeText(row.text)));
  assert.deepEqual(left.map(row=>`${row.file}: ${row.text} → ${en.officeText(row.text)}`),[],'Register these texts in ui-copy.ts or ui-copy-extra.ts');
});
test('display copy coverage: a two-language call shows the current wording in both languages',()=>{
  const korean=pairs.filter(row=>oldWording.test(ko.officeCopy(row.ko,row.en))),english=pairs.filter(row=>hangul.test(en.officeCopy(row.ko,row.en)));
  assert.deepEqual(korean.map(row=>`${row.file}: ${row.ko} → ${ko.officeCopy(row.ko,row.en)}`),[]);
  assert.deepEqual(english.map(row=>`${row.file}: ${row.ko} → ${en.officeCopy(row.ko,row.en)}`),[]);
});
test('display copy coverage: labels joined with a value at run time use the current terms',()=>{
  for(const [shown,korean,english] of [
    ['실행기: Codex','실행 도구: Codex','Execution tool: Codex'],
    ['완료 조건 3개','완료 기준 3개','Completion criteria · 3'],
    ['확인된 완료 조건 2개','확인된 완료 기준 2개','Confirmed completion criteria · 2'],
    ['클라이언트 인계 2건','AI 업무 인계 2건','AI handoffs · 2'],
    ['Codex · 미관측','Codex · 확인되지 않음','Codex · Not confirmed'],
    ['완료 조건 ·','완료 기준 ·','Completion criterion ·'],
    ['키 입력 후 새로고침하면 최신 목록을 불러옵니다 · 기본 gpt-6','키를 입력하고 새로고침하면 최신 목록을 불러와요 · 기본 gpt-6','Enter a key and refresh for the latest list · default gpt-6'],
  ]){assert.equal(ko.officeText(shown),korean);assert.equal(en.officeText(shown),english);}
  assert.equal(ko.officeCopy('관측된 실행기: ','Observed executor: ')+'Codex','확인된 실행 도구: Codex');assert.equal(en.officeCopy('관측된 실행기: ','Observed executor: ')+'Codex','Execution tool seen: Codex');
});
test('display copy coverage: a label followed by a name is not read as a "manage" or "connect" phrase',()=>{
  // '^(.+) 관리$' once turned "Hermes 실행 · Driver 관리" into "Manage Hermes 실행 · Driver".
  assert.equal(en.officeText('Hermes 실행 · Driver 관리'),'Runs in Hermes · managed in Driver');
  assert.equal(en.officeText('결과 확인 · 다음 지시 준비'),'Check result · prepare next instruction');
});
