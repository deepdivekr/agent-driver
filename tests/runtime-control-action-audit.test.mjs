import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {startControlCenter} from '../dist/observability/control-center.js';

const spec={title:'검증 업무',desired_outcome:'공개 자료 확인',completion_checks:[{id:'source',result:'원문 확인',evidence:'출처 링크'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
async function setup(t,model){
  const root=await mkdtemp(join(tmpdir(),'office-action-audit-'));
  const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);
  const server=await startControlCenter(config,{workModel:model,poll_ms:50});
  const browser=await chromium.launch({headless:true}),page=await browser.newPage();
  await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  t.after(async()=>{await browser.close();await server.close();await rm(root,{recursive:true,force:true});assert.deepEqual(errors,[]);});
  return {root,config,server,browser,page};
}

test('runtime fixture Work UI: delayed consent appears, blocked Jev stays disabled, allowed toggle and pause persist',async t=>{
  let calls=0;const x=await setup(t,{calls:[],async call(){calls++;return spec;}});
  let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  await x.page.route('**/settings/status',async route=>{await gate;await route.continue();});
  await x.page.goto(x.server.url);
  await x.page.locator('#prompt').fill('공개 자료 확인');
  await x.page.locator('#submit-work').click();
  await x.page.locator('#retry-define').waitFor();
  assert.equal(await x.page.locator('#allow-ai-data').count(),0);
  assert.equal(await x.page.locator('#jev-cost').isDisabled(),true);
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),true);
  // Even a stale/scripted change event must not turn an unavailable action on.
  await x.page.locator('#jev-cost').evaluate(el=>{el.checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),true);
  release();
  await x.page.locator('#allow-ai-data').waitFor();
  await x.page.locator('#allow-ai-data').click();
  await x.page.getByRole('heading',{name:'검증 업무',exact:true}).waitFor();
  const workId=new URL(x.page.url()).searchParams.get('work');
  const read=async()=>await (await fetch(x.server.url+'work/detail?id='+encodeURIComponent(workId))).json();
  assert.equal((await read()).work_status,'ready');
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),true);
  await x.page.locator('#jev-cost').check();
  await x.page.evaluate(()=>loadDetail());
  assert.equal(await x.page.locator('#jev-cost').isChecked(),true,'live refresh must preserve this Work cost acknowledgement');
  await x.page.locator('#jev-toggle').click();
  await x.page.getByRole('button',{name:'Jev 끄기',exact:true}).waitFor();
  assert.equal((await read()).jev.enabled,true);
  assert.ok((await read()).jev.cost_consent_at);
  await x.page.locator('#jev-toggle').click();
  await x.page.getByRole('button',{name:'Jev 켜기',exact:true}).waitFor();
  assert.equal((await read()).jev.enabled,false);
  await x.page.locator('#pause').click();
  await x.page.getByRole('button',{name:'작업 재개',exact:true}).waitFor();
  assert.equal((await read()).paused,true);
  await x.page.locator('#pause').click();
  await x.page.getByRole('button',{name:'일시정지',exact:true}).waitFor();
  assert.equal((await read()).paused,false);
  await x.page.locator('#back').click();
  await x.page.locator('[data-layout="list"]').click();
  await x.page.locator('.tile').waitFor();
  assert.equal(await x.page.locator('.tile').count(),1);
  await x.page.locator('#search').fill('없는 업무');
  assert.equal(await x.page.locator('.tile').count(),0);
  await x.page.locator('#search').fill('');
  await x.page.locator('[data-layout="board"]').click();
  await x.page.locator('[data-view="waiting"]').click();
  assert.equal(await x.page.locator('.tile').count(),1);
  await x.page.locator('[data-view="done"]').click();
  assert.equal(await x.page.locator('.tile').count(),0);
  assert.equal(calls,1,'UI controls must not add model calls');
});

test('runtime fixture settings UI locks startup controls, offers retry after failure and unlocks after fresh load',async t=>{
  const x=await setup(t,{calls:[],async call(){return spec;}});
  // Fixture discovery avoids inspecting any real installed accounts.
  await x.page.route('**/settings/mcp',r=>r.fulfill({json:{agent_driver:{installed:true},clients:[],registered_count:1,windows_bridge:null}}));
  await x.page.route('**/settings/bootstrap',r=>r.fulfill({json:{clients:[],connections:[]}}));
  let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());let attempt=0;
  await x.page.route('**/settings/status',async r=>{if(++attempt===1){await gate;return r.fulfill({status:503,json:{error:'fixture unavailable'}});}return r.continue();});
  await x.page.goto(x.server.url+'settings');
  assert.equal(await x.page.locator('[data-step="2"]').isDisabled(),true);
  assert.equal(await x.page.locator('#save-model').isDisabled(),true);
  assert.equal(await x.page.locator('#mode').isDisabled(),true);
  release();
  await x.page.locator('#retry-settings').waitFor();
  assert.equal(await x.page.locator('#connect-computer').isDisabled(),true);
  await x.page.locator('#retry-settings').click();
  await x.page.getByRole('heading',{name:'로컬 실행',exact:true}).waitFor();
  assert.equal(await x.page.locator('[data-step="2"]').isEnabled(),true);
  assert.equal(await x.page.locator('#connect-computer').isEnabled(),true);
  assert.equal(await x.page.locator('#retry-settings').isHidden(),true);
  await x.page.locator('#step-1 .hint').click();
  assert.equal(await x.page.locator('#help').isVisible(),true);
  await x.page.locator('#help button').click();
  assert.equal(await x.page.locator('#help').isVisible(),false);
});

test('runtime fixture all three import routes preview and save inactive Work through the real HTTP UI',async t=>{
  const x=await setup(t,{calls:[],async call(){throw Error('AI must not run without consent');}});
  for(const kind of ['external','workflow','bot']){
    await x.page.goto(x.server.url+'?import=1');
    await x.page.locator('[data-import-route="'+kind+'"]').click();
    if(kind==='external'){
      await x.page.locator('#migration-prompt').filter({visible:true}).waitFor();
      await x.page.waitForFunction(()=>document.getElementById('migration-prompt').value.includes('evidence_ids'));
      const prompt=await x.page.locator('#migration-prompt').inputValue();
      await x.page.context().grantPermissions(['clipboard-read','clipboard-write']);
      await x.page.locator('#copy-migration-prompt').click();
      assert.equal(await x.page.evaluate(()=>navigator.clipboard.readText()),prompt);
      const body=JSON.parse(prompt.match(/\n(\{\n[\s\S]*?\n\})\n/u)[1]);
      body.title={value:'가져온 테스트 업무',evidence_ids:['e1']};body.goal={value:'공개 자료를 요약한다',evidence_ids:['e1']};
      body.evidence=[{id:'e1',source_ref:'fixture instructions',quote:'공개 자료를 요약한다'}];
      await x.page.locator('#import-json').fill(JSON.stringify(body));
      await x.page.locator('#paste-import').click();
    }else{
      const project=join(x.root,kind);await mkdir(project);
      await writeFile(join(project,'README.md'),'# Fixture project\nRead public information.\n');
      await writeFile(join(project,'main.py'),kind==='workflow'?'from openai import OpenAI\ncreate_agent()\ntool_call()\ncheckpoint = True\n':'import telegram\nbot.command("weather", sendMessage)\n');
      const before=await readFile(join(project,'main.py'),'utf8');
      await x.page.locator('#import-path').fill(project);
      await x.page.locator('#scan-import').click();
      await x.page.locator('#import-goal').waitFor();
      assert.equal(await readFile(join(project,'main.py'),'utf8'),before,'scan never runs or edits project code');
    }
    await x.page.locator('#import-goal').waitFor();
    await x.page.locator('#import-goal').fill('가져온 '+kind+' 업무');
    await x.page.locator('#import-completion').fill('출처와 결과 확인');
    await x.page.locator('#accept-import').click();
    await x.page.locator('#back').waitFor();
    const id=new URL(x.page.url()).searchParams.get('work');
    const detail=await (await fetch(x.server.url+'work/detail?id='+encodeURIComponent(id))).json();
    assert.equal(detail.run_id,null,'saving an import is not permission to execute');
    assert.equal(detail.jev.enabled,false);
  }
});

test('runtime fixture site-login UI enables only configured actions, dispatches all three actions and recovers from failure (fixture browser)',async t=>{
  const x=await setup(t,{calls:[],async call(){return spec;}}),posts=[];
  let available=false,failCheck=true;
  await x.page.route('**/connections/status',r=>r.fulfill({json:{sites:[{site:'example.test',label:'Example',state:'needs_login',handoff:false}],vnc:'127.0.0.1:45901',profile_preserved:available}}));
  await x.page.route('**/connections/*/example.test',r=>{
    posts.push({action:r.request().url().split('/').at(-2),method:r.request().method(),header:r.request().headers()['x-agent-driver']});
    if(posts.at(-1).action==='check'&&failCheck){failCheck=false;return r.fulfill({status:409,json:{error:'CONNECTION_UNAVAILABLE'}});}
    return r.fulfill({json:{viewer_opened:false,vnc:'127.0.0.1:45901',verified:true}});
  });
  await x.page.goto(x.server.url+'connections');
  await x.page.getByRole('heading',{name:'Example'}).waitFor();
  assert.equal(await x.page.getByRole('button',{name:'로그인 창 열기',exact:true}).isDisabled(),true);
  available=true;await x.page.evaluate(()=>refresh());
  await x.page.getByRole('button',{name:'로그인 창 열기',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'VNC 127.0.0.1:45901'}).waitFor();
  await x.page.getByRole('button',{name:'로그인 확인',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'CONNECTION_UNAVAILABLE'}).waitFor();
  assert.equal(await x.page.locator('#lang-toggle').isEnabled(),true);
  await x.page.getByRole('button',{name:'로그인 확인',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'로그인 상태를 확인했습니다.'}).waitFor();
  await x.page.getByRole('button',{name:'다시 시도',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'작업에서 다시 접근합니다.'}).waitFor();
  assert.deepEqual(posts.map(p=>p.action),['open','check','check','retry']);
  assert.ok(posts.every(p=>p.method==='POST'&&p.header==='human-connection'));
  available=false;await x.page.evaluate(()=>refresh());
  assert.equal(await x.page.getByRole('button',{name:'로그인 창 열기',exact:true}).isDisabled(),true);
  assert.equal(await x.page.getByRole('button',{name:'다시 시도',exact:true}).isDisabled(),true);
});
