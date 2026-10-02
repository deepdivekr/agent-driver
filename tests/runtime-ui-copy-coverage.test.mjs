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
// Owner direction 2026-10-02: English follows ASD-STE100 (Simplified Technical English) most of the way.
test('display copy: English uses one word for one thing, plain verbs and simple tenses',async()=>{
  const {controlCenterCopy}=await import('../dist/observability/i18n.js'),{plainEnglish}=await import('../dist/observability/ui-copy.js');
  const shown=[...new Set(Object.values(controlCenterCopy.en))].filter(value=>!hangul.test(value));
  const left=shown.filter(value=>/\b(?:log in|login|logins|verify|verifies|verified|unverified|verification|select|selects|selected|require|requires|required|retain|retains|remain|remains)\b/iu.test(value)||/\b(?:has|have) (?:not |never |already )?been [a-z]+ed\b/u.test(value)||/\bmay (?!not\b)/u.test(value));
  assert.deepEqual(left,[]);
  for(const value of shown)assert.equal(plainEnglish(value),value,'The rules leave their own result unchanged: '+value);
  for(const [written,expected] of [
    ['Log in to Codex','Sign in to Codex'],['Site login needed','Site sign-in needed'],
    ['Access has not been verified for this account.','Access is not confirmed for this account.'],
    ['Select Start work to execute.','Choose Start work to execute.'],['You selected Hermes.','You chose Hermes.'],
    ['Leave blank to inherit the selected model.','Leave blank to inherit the chosen model.'],
    ['Work analysis requires permission.','Work analysis needs permission.'],['Check the required settings.','Check the necessary settings.'],
    ['The AI is choosing the next step.','The AI chooses the next step.'],['Progress has been saved.','Progress is saved.'],
    ['Auto may override it.','Auto can override it.'],['A finished run may not meet every criterion.','A finished run may not meet every criterion.'],
    ['Check the connection, then start the work.','Check the connection. Then start the work.'],
    ['Check that the app is running and connected.','Check that the app is running and connected.'],
  ])assert.equal(plainEnglish(written),expected);
  assert.equal(en.officeText('Codex 로그인'),'Sign in to Codex');
});
test('display copy: Korean verb endings and the wording the owner fixed',()=>{
  assert.equal(ko.officeText('아직 없습니다. 업무가 검증을 통과하면 여기에 쌓입니다.'),'아직 없어요. 업무가 검증을 통과하면 여기에 쌓여요.');
  assert.equal(ko.officeText('Jev는 정해진 판단 지점에서만 쓰입니다. 꺼도 AI와 코드로 진행합니다.'),'Jev는 정해진 판단 지점에서만 쓰여요. 꺼도 AI와 코드로 진행해요.');
  assert.equal(ko.officeText('학습한 절차와 기억한 출처'),'학습한 절차와 기억한 출처');assert.equal(en.officeText('학습한 절차와 기억한 출처'),'Learned procedures and remembered sources');
  assert.ok(sources.every(({text})=>!text.includes('배운 절차')),'The heading says 학습한, not 배운.');
});
// Owner direction 2026-10-02: a choice that needs a value ("one stock") comes with its input.
test('work questions: an option with a value hint shows an input and sends "<option>: <value>"',async()=>{
  const {workHtml}=await import('../dist/observability/work-ui.js');const page=workHtml('question-test');
  assert.match(page,/data-detail="'\+esc\(o\.detail\|\|''\)\+'"/u,'Each option carries its value hint.');
  assert.match(page,/input\.hidden=choice\.value!=='custom'&&!detail/u,'The input appears for a custom answer or an option that needs a value.');
  assert.match(page,/detail\?choice\+': '\+typed:choice/u,'The typed value is sent with its option.');
  assert.match(page,/if\(detail&&!typed\)/u,'An option that needs a value cannot be sent without it.');
  assert.match(page,/question-meaning/u,'The meaning of the chosen option is shown under it.');
});
