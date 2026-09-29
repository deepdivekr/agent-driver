import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {probeSubscriptionClient,SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {UNIVERSAL_WORK_MIGRATION_PROMPT,UNIVERSAL_WORK_MIGRATION_PROMPT_EN,parseWorkImportDraft} from '../dist/work/import-draft.js';
import {WorkImportRuntime} from '../dist/work/import-runtime.js';
import {workHtml} from '../dist/observability/work-ui.js';
import {i18nScript} from '../dist/observability/i18n.js';

const environment={AGENT_DRIVER_LLM_CLIENT:'claude',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude'};
const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};

test('runtime contract Claude explicit first-party OAuth setup-token and claude.ai auth use only the subscription bridge',async()=>{
  for(const authMethod of ['oauth_token','claude.ai'])for(const apiKeySource of [undefined,null,'']){
    let invocations=0;
    const runner={async run(request){
      if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod,apiProvider:'firstParty',apiKeySource}),stderr:''};
      invocations++;assert.equal(request.executable,'/fixture/claude');assert.ok(request.args.includes('--no-session-persistence'));
      return {code:0,stdout:JSON.stringify({structured_output:{ok:true}}),stderr:''};
    }};
    const status=await probeSubscriptionClient('claude',environment,runner);
    assert.equal(status.status,'ready');assert.equal(status.auth,'subscription');
    const model=new SubscriptionAwareStructuredModel({environment,runner,subscriptionOnly:true});
    assert.deepEqual(await model.call('correct','Choose a bounded answer.',{},schema),{ok:true});
    assert.equal(invocations,1);assert.equal(model.calls[0].provider,'claude');assert.equal(model.calls[0].auth,'subscription');
  }
});

test('runtime contract Claude OAuth label cannot override absent provider, API billing, cloud routing or an unrecognized auth method',async()=>{
  const cases=[
    ...[undefined,null,'bedrock','vertex','unknown'].map(apiProvider=>({authMethod:'oauth_token',apiProvider})),
    ...['ANTHROPIC_API_KEY','apiKeyHelper','unknown-source',false,17].map(apiKeySource=>({authMethod:'oauth_token',apiProvider:'firstParty',apiKeySource})),
    {authMethod:'api_key',apiProvider:'firstParty'},
    {authMethod:'unknown',apiProvider:'firstParty'},
    {authMethod:'oauth_token',subscriptionType:'max'},
  ];
  for(const value of cases){
    let invocations=0,paid=0;
    const runner={async run(request){
      if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,...value}),stderr:''};
      invocations++;throw Error('UNEXPECTED_UNCLASSIFIED_CLAUDE_EXECUTION');
    }};
    const status=await probeSubscriptionClient('claude',environment,runner);
    assert.equal(status.status,'unknown',JSON.stringify(value));assert.equal(status.auth,'unknown');
    const model=new SubscriptionAwareStructuredModel({environment,runner,subscriptionOnly:true,fallbackKind:'api_key',fallbackModel:{calls:[],async call(){paid++;throw Error('UNEXPECTED_PAID_API');}}});
    await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/u);
    assert.equal(invocations,0);assert.equal(paid,0);assert.equal(model.calls.length,0);
  }
});

test('runtime unit migration prompt response adds English without replacing Korean or granting automation authority',()=>{
  const response=WorkImportRuntime.prototype.prompt.call({});
  assert.equal(response.prompt,UNIVERSAL_WORK_MIGRATION_PROMPT);assert.equal(response.prompt_en,UNIVERSAL_WORK_MIGRATION_PROMPT_EN);
  assert.equal(response.format,'JSON');assert.equal(response.secrets,'do_not_include');assert.equal(response.next_action,'paste_result_for_preview');
  assert.match(response.prompt,/실행·수정·중지는 하지 마세요/u);
  assert.doesNotMatch(response.prompt_en,/[가-힣]/u);
  assert.match(response.prompt_en,/Do not run, change or stop the existing automation/u);
  assert.match(response.prompt_en,/Never output the actual value of an API key, password, cookie, token or verification code/u);
  assert.match(response.prompt_en,/Do not decide whether the Work may run or be activated/u);
  const skeleton=prompt=>JSON.parse(prompt.match(/\n(\{\n[\s\S]*?\n\})\n/u)[1]);
  assert.deepEqual(skeleton(response.prompt_en),skeleton(response.prompt));
  for(const prompt of [response.prompt,response.prompt_en]){
    const draft=parseWorkImportDraft(JSON.stringify(skeleton(prompt)));
    assert.deepEqual(draft.authority,{execution:false,activation:false});assert.equal(draft.goal.value,null);
  }
});

test('runtime unit migration UI chooses English when supplied, retains legacy responses and never overwrites an existing prompt',async()=>{
  const source=workHtml('fixture-nonce').match(/async function loadMigrationPrompt\(\)\{[^\n]+\}/u)?.[0];
  assert.ok(source,'Exercise the actual generated UI function');
  const body={prompt:UNIVERSAL_WORK_MIGRATION_PROMPT,prompt_en:UNIVERSAL_WORK_MIGRATION_PROMPT_EN};
  for(const [lang,payload,expected] of [
    ['en',body,body.prompt_en],['ko',body,body.prompt],
    ['en',{prompt:body.prompt},body.prompt],['en',body.prompt,body.prompt],
    ['en',{...body,prompt_en:''},body.prompt],
  ]){
    const target={value:''},messages=[];let fetches=0;
    const context={window:{officeLang:lang},document:{getElementById(id){assert.equal(id,'migration-prompt');return target;}},
      async fetch(url,options){fetches++;assert.equal(url,'work/import/prompt');assert.equal(options.cache,'no-store');return {ok:true,async text(){return JSON.stringify(payload);}};},setMessage:message=>messages.push(message)};
    runInNewContext(source,context);await context.loadMigrationPrompt();
    assert.equal(target.value,expected);assert.equal(fetches,1);assert.deepEqual(messages,[]);
    target.value='User-provided prompt must remain verbatim.';await context.loadMigrationPrompt();
    assert.equal(target.value,'User-provided prompt must remain verbatim.');assert.equal(fetches,1);
  }
});

function translator(lang='en'){
  const context={window:{},localStorage:{getItem(){return lang;}},document:{documentElement:{},readyState:'loading',addEventListener(){}}};
  runInNewContext(i18nScript,context,{timeout:1_000});return context.window.officeText;
}

test('runtime unit nested UI regex captures translate recursively while unknown and Korean user content remain intact',()=>{
  const text=translator();
  assert.equal(text('Claude Code: 다음 단계: 단계 2'),'Claude Code: Next stage: Step 2');
  assert.equal(text('지침 변경 · 가져온 계획 · 단계 4'),'Instruction changed · Imported plan · Step 4');
  assert.equal(text('다음 단계: 계획 단계 · 대기'),'Next stage: Planned stage · Queued');
  assert.equal(text('현재 확인: Codex 5개 · Claude Code: 로그인 필요'),'Checked: Codex 5 · Claude Code: Login needed');
  assert.equal(text('다음 단계: 사용자 비용 $1'),'Next stage: 사용자 비용 $1');
  assert.equal(text('사용자가 입력한 뉴스 요청'),'사용자가 입력한 뉴스 요청');
  assert.equal(translator('ko')('Claude Code: 다음 단계: 단계 2'),'Claude Code: 다음 단계: 단계 2');
});

test('runtime unit nested UI translation has an eight-level recursion cap instead of recursing indefinitely',()=>{
  const text=translator(),input='다음 단계: '.repeat(200)+'대기',translated=text(input);
  assert.match(translated,/^Next stage: /u);assert.match(translated,/다음 단계: /u);
  assert.ok(translated.length<input.length*2,'Bounded recursion preserves the untouched remainder');
  assert.equal(text('Plain English'), 'Plain English');
});
