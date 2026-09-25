import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {settingsHtml} from '../dist/observability/settings-ui.js';
import {workHtml} from '../dist/observability/work-ui.js';
import {BrowserConnections} from '../dist/observability/browser-connections.js';

test('first-run settings does not preselect Work data sharing',()=>{
  const html=settingsHtml('safe-nonce');
  assert.match(html,/\$\('work-data'\)\.checked=Boolean\(state\.work_model_data\?\.approved\)/u);
  assert.doesNotMatch(html,/\$\('work-data'\)\.checked=state\.work_model_data\?\.approved\|\|!state\.configured/u);
});

test('closed Work is not described as verified and its displayed run ID is the actual run ID',()=>{
  const html=workHtml('safe-nonce');
  assert.match(html,/data-view="done">종료된 업무/u);
  assert.match(html,/d\.run_id\.slice\(0,8\)/u);
  const script=html.match(/<script nonce="safe-nonce">([\s\S]*?)<\/script>/u)?.[1];
  assert.ok(script);
  const group=script.match(/function groupOf\(s\)\{[^\n]+\}/u)?.[0];
  const tone=script.match(/function tone\(s\)\{[^\n]+\}/u)?.[0];
  assert.ok(group&&tone);
  const result=vm.runInNewContext(`const attention=()=>false,active=()=>false;${group}${tone};[groupOf('stopped'),tone('stopped'),tone('completed')]`);
  assert.deepEqual(Array.from(result),['done','idle','ok']);
});

test('site-login actions preserve the language switch and clear the first loading state by status',async()=>{
  const connection=new BrowserConnections({},{}),response={html:'',writeHead(){},end(body){this.html=body;}};
  assert.equal(await connection.handle({method:'GET'},response,'connections','127.0.0.1:9999'),true);
  assert.match(response.html,/document\.querySelectorAll\('#sites button'\)/u);
  assert.doesNotMatch(response.html,/document\.querySelectorAll\('button'\)/u);
  assert.match(response.html,/refresh\(\)\.then\(ok=>\{if\(ok\)/u);
});
