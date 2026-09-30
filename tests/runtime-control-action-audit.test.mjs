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
  let calls=0,executionStarted,releaseExecution;const started=new Promise(resolve=>executionStarted=resolve),executionGate=new Promise(resolve=>releaseExecution=resolve);
  t.after(()=>releaseExecution());
  const x=await setup(t,{calls:[],async call(_purpose,instructions){calls++;if(instructions.startsWith('Execute the registered Work')){executionStarted();if(calls===2)await executionGate;return {action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'This fixture stops before external research at a model boundary.',completed_checks:[],wait_reason:'model'};}return spec;}});
  let release;const gate=new Promise(resolve=>release=resolve);t.after(()=>release());
  await x.page.route('**/settings/status',async route=>{await gate;await route.continue();});
  await x.page.goto(x.server.url);
  await x.page.locator('#prompt').fill('공개 자료 확인');
  await x.page.locator('#submit-work').click();
  await x.page.locator('#retry-define').waitFor();
  assert.equal(await x.page.locator('#allow-ai-data').count(),0);
  assert.equal(await x.page.locator('#jev-cost').count(),0,'new Work delegates to Pack settings without a second cost choice');
  assert.equal(await x.page.locator('.jev-policy').innerText(),'Task Pack 설정 사용');
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),true);
  // Even a stale/scripted change event must not turn an unavailable action on.
  await x.page.locator('#jev-toggle').evaluate(el=>el.dispatchEvent(new Event('click',{bubbles:true})));
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),true);
  release();
  await x.page.locator('#allow-ai-data').waitFor();
  await x.page.locator('#allow-ai-data').click();
  await x.page.getByRole('heading',{name:'검증 업무',exact:true}).waitFor();
  const workId=new URL(x.page.url()).searchParams.get('work');
  const read=async()=>await (await fetch(x.server.url+'work/detail?id='+encodeURIComponent(workId))).json();
  assert.equal((await read()).work_status,'ready');
  await started;
  await x.page.waitForFunction(async ({base,id})=>(await (await fetch(base+'work/detail?id='+encodeURIComponent(id))).json()).supervisor?.can_pause,{base:x.server.url,id:workId});
  assert.equal(calls,2,'Approved intake automatically makes one execution decision before Jev or Pause actions.');
  assert.equal((await read()).jev.enabled,null);
  assert.equal(await x.page.locator('#jev-toggle').isDisabled(),false);
  await x.page.locator('#jev-toggle').click();
  await x.page.getByRole('button',{name:'Jev 켜기',exact:true}).waitFor();
  assert.equal((await read()).jev.enabled,false,'explicit opt-out must persist');
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
  await x.page.locator('[data-stage]').first().click();await x.page.locator('#stage-dialog[open]').waitFor();
  await x.page.locator('[data-stage-action="pause"]').click();
  releaseExecution();
  await x.page.waitForFunction(()=>!document.querySelector('[data-stage-action="resume"]')?.disabled);
  assert.equal((await read()).paused,true);
  assert.equal(calls,2,'Jev configuration and Pause must not add a model call');
  assert.match(await x.page.locator('#stage-dialog').innerText(),/기존 결과와 증거는 보존합니다/u);
  await x.page.locator('[data-stage-action="resume"]').click();
  await x.page.waitForFunction(async ({base,id})=>(await (await fetch(base+'work/detail?id='+encodeURIComponent(id))).json()).supervisor?.state==='waiting_model',{base:x.server.url,id:workId});
  assert.equal((await read()).paused,false);
  assert.equal((await read()).supervisor.state,'waiting_model');
  assert.equal((await read()).supervisor.current_run_only,true);
  await x.page.locator('#stage-close').click();
  await x.page.locator('#back').click();
  await x.page.locator('[data-layout="list"]').click();
  await x.page.locator('.tile').waitFor();
  assert.equal(await x.page.locator('.tile').count(),1);
  await x.page.locator('#search').fill('없는 업무');
  assert.equal(await x.page.locator('.tile').count(),0);
  await x.page.locator('#search').fill('');
  await x.page.locator('[data-layout="board"]').click();
  await x.page.locator('[data-view="waiting"]').click();
  assert.equal(await x.page.locator('.tile').count(),0);
  await x.page.locator('[data-view="attention"]').click();
  assert.equal(await x.page.locator('.tile').count(),1);
  await x.page.locator('[data-view="done"]').click();
  assert.equal(await x.page.locator('.tile').count(),0);
  assert.equal(calls,3,'Only explicit current-cycle Resume may add the next execution model call');
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
  // Settings now collect explanations in an accessible disclosure rather than
  // the old question-mark dialog. Verify the actual open and close actions.
  const help=x.page.locator('#step-1 #browser-help');
  assert.equal(await help.evaluate(node=>node.open),false);
  await help.locator('summary').click();
  assert.equal(await help.evaluate(node=>node.open),true);
  assert.ok((await help.innerText()).includes('기본 전용 브라우저는 내 화면을 빼앗지 않습니다.'));
  await help.locator('summary').click();
  assert.equal(await help.locator('p').first().isHidden(),true);
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
  await x.page.route('**/connections/status',r=>r.fulfill({json:{sites:[{site:'example.test',label:'Example',state:'needs_login',handoff:false,profiles:{'fixture-ubuntu':{site:'example.test',state:'needs_login',handoff:false}}}],targets:[{id:'fixture-ubuntu',environment:'ubuntu',engine:'playwright',label:'Ubuntu · Playwright',availability:available?'ready':'unavailable'}],vnc:'127.0.0.1:45901',profile_preserved:available,vm_state:available?'running':'unavailable'}}));
  await x.page.route('**/connections/*/example.test/fixture-ubuntu',r=>{
    posts.push({action:r.request().url().split('/').at(-3),target:r.request().url().split('/').at(-1),method:r.request().method(),header:r.request().headers()['x-agent-driver']});
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
  await x.page.getByRole('status').filter({hasText:'로그인 화면에 연결하지 못했습니다. 브라우저 상태와 연결 설정을 확인하세요.'}).waitFor();
  assert.equal(await x.page.locator('#lang-toggle').isEnabled(),true);
  await x.page.getByRole('button',{name:'로그인 확인',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'로그인 상태를 확인했습니다.'}).waitFor();
  await x.page.getByRole('button',{name:'재시도 허용',exact:true}).click();
  await x.page.getByRole('status').filter({hasText:'재시도 허용됨 · 업무에서 재개하세요.'}).waitFor();
  assert.deepEqual(posts.map(p=>p.action),['open','check','check','retry']);
  assert.ok(posts.every(p=>p.target==='fixture-ubuntu'));
  assert.ok(posts.every(p=>p.method==='POST'&&p.header==='human-connection'));
  available=false;await x.page.evaluate(()=>refresh());
  assert.equal(await x.page.getByRole('button',{name:'로그인 창 열기',exact:true}).isDisabled(),true);
  assert.equal(await x.page.getByRole('button',{name:'재시도 허용',exact:true}).isDisabled(),true);
});

test('runtime fixture site-login defaults to a connected Windows Aside while preserving an explicit VM choice',async t=>{
  const x=await setup(t,{calls:[],async call(){return spec;}});
  await x.page.route('**/connections/status',r=>r.fulfill({json:{
    sites:[{site:'x.com',label:'X',state:'ready',handoff:false,profiles:{
      'fixture-vm':{site:'x.com',state:'ready',handoff:false},
      'fixture-aside':{site:'x.com',state:'needs_login',handoff:false},
    }}],
    targets:[
      {id:'fixture-vm',environment:'ubuntu',engine:'playwright',label:'Ubuntu · Playwright',availability:'ready'},
      {id:'fixture-aside',environment:'windows',engine:'aside',label:'Windows · Aside',availability:'ready'},
      {id:'',environment:'windows_vm',engine:null,label:'Windows VM',availability:'unsupported'},
    ],vm_state:'running',busy:false,
  }}));
  await x.page.goto(x.server.url+'connections');
  const choice=x.page.locator('[data-site="x.com"]').getByRole('combobox',{name:'로그인 브라우저'});await choice.waitFor();
  assert.equal(await choice.inputValue(),'fixture-aside','A connected Aside wins even when the VM has an older ready observation');
  await choice.selectOption('fixture-vm');
  await x.page.evaluate(()=>refresh());
  assert.equal(await choice.inputValue(),'fixture-vm','An explicit user choice remains selected');
});
