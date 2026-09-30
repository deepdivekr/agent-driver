import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {effectiveModelEnvironment,publicModelSettings,readModelSettings,saveModelSettings} from '../dist/onboarding/model-settings.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {settingsHtml} from '../dist/observability/settings-ui.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const secret='fixture-ambient-api-key-never-used-12345';
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'initial-subscription-model-'));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,'.connection','models.json');}
const update=(selection,revision=0)=>({revision,onboarding_step:2,selection});
function fakeCodexRunner(){
  const requests=[];
  return {requests,async run(request){
    requests.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    assert.equal(request.executable,'/fixture/codex');assert.ok(request.args.includes('exec'));
    return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}})+'\n',stderr:''};
  }};
}
async function invokeSaved(path,runner){
  let paid=0;
  const model=new ConfiguredStructuredModel(path,{AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',OPENAI_API_KEY:secret},{
    subscription:options=>{assert.equal(options.fallbackModel,undefined);return new SubscriptionAwareStructuredModel({...options,runner});},
    api:()=>{paid++;throw Error('UNAUTHORIZED_PAID_API');},
  });
  assert.deepEqual(await model.call('correct','Return the requested JSON.',{},schema),{ok:true});
  assert.equal(paid,0);assert.equal(model.calls.at(-1).provider,'codex');
  return runner.requests.find(request=>request.args.includes('exec'))?.args;
}

test('runtime unit first subscription setup leaves Codex CLI default until the account catalog is observed',async t=>{
  const path=await fixture(t),initial=publicModelSettings(null,{});
  assert.equal(initial.configured,false);assert.equal(initial.selection.mode,'subscription');assert.equal(initial.selection.client,'codex');
  assert.equal(initial.selection.client_models.codex,null);assert.equal(initial.selection.codex_reasoning_effort,null);
  assert.equal(initial.selection.api_model,'gpt-6-luna');assert.equal(initial.selection.reasoning,'low');
  assert.equal(readModelSettings(path),null);
  const html=settingsHtml('fixture-nonce');assert.match(html,/id="codex-reasoning"/u);assert.match(html,/Codex 추론 강도/u);
});

test('runtime contract saved account-listed Sol/high choice reaches Codex CLI without paid fallback',async t=>{
  const path=await fixture(t),defaults=publicModelSettings(null,{}).selection,selection={...defaults,client_models:{...defaults.client_models,codex:'gpt-5.6-sol'},codex_reasoning_effort:'high'};
  saveModelSettings(path,update(selection),{});
  const runner=fakeCodexRunner(),args=await invokeSaved(path,runner);
  assert.deepEqual(args.slice(0,6),['--model','gpt-5.6-sol','exec','-c','model_reasoning_effort=high','--json']);
  assert.ok(args.includes('--ignore-user-config'));assert.equal(args.at(-1),'-');
  assert.equal(readModelSettings(path).selection.codex_reasoning_effort,'high');
  assert.doesNotMatch(await readFile(path,'utf8'),new RegExp(secret));
});

test('runtime contract a fresh CLI-default selection never invents a versioned model or reasoning override',async t=>{
  const path=await fixture(t),selection=publicModelSettings(null,{}).selection;
  saveModelSettings(path,update(selection),{});
  const args=await invokeSaved(path,fakeCodexRunner());
  assert.equal(args.includes('--model'),false);assert.equal(args.includes('-c'),false);
});

test('runtime contract an existing or custom Codex choice stays selected and absent effort leaves CLI config alone',async t=>{
  const path=await fixture(t),defaults=publicModelSettings(null,{}).selection;
  const {codex_reasoning_effort:unused,...legacy}=defaults;
  saveModelSettings(path,update({...legacy,client_models:{...legacy.client_models,codex:'gpt-5.6-luna'}}),{});
  assert.equal(readModelSettings(path).selection.codex_reasoning_effort,undefined);
  assert.equal(effectiveModelEnvironment(readModelSettings(path),{}).AGENT_DRIVER_CODEX_REASONING_EFFORT,undefined);
  let runner=fakeCodexRunner(),args=await invokeSaved(path,runner);
  assert.equal(args[args.indexOf('--model')+1],'gpt-5.6-luna');assert.equal(args.includes('-c'),false);
  saveModelSettings(path,update({...legacy,client_models:{...legacy.client_models,codex:'gpt-6-luna'},codex_reasoning_effort:'medium'},1),{});
  runner=fakeCodexRunner();args=await invokeSaved(path,runner);
  assert.deepEqual(args.slice(0,6),['--model','gpt-6-luna','exec','-c','model_reasoning_effort=medium','--json']);
});

test('runtime unit API and other subscription client choices retain their own provider and model',async t=>{
  const path=await fixture(t),defaults=publicModelSettings(null,{}).selection;
  const apiDefault=publicModelSettings(null,{AGENT_DRIVER_LLM_CLIENT:'api'}).selection;
  assert.equal(apiDefault.mode,'api');assert.equal(apiDefault.client_models.codex,null);assert.equal(apiDefault.codex_reasoning_effort,null);
  assert.equal(publicModelSettings(null,{AGENT_DRIVER_LLM_CLIENT:'claude'}).selection.client,'claude');
  assert.equal(publicModelSettings(null,{AGENT_DRIVER_LLM_CLIENT:'claude'}).selection.client_models.codex,null);
  const choice={...defaults,mode:'api',client:'claude',client_models:{codex:null,claude:'opus',opencode:null},codex_reasoning_effort:null,api_provider:'anthropic',api_model:'claude-sonnet-4-5',reasoning:'low'};
  saveModelSettings(path,{...update(choice),api_action:'replace',api_key:secret},{});
  const env=effectiveModelEnvironment(readModelSettings(path),{});
  assert.equal(env.AGENT_DRIVER_LLM_CLIENT,'api');assert.equal(env.AGENT_DRIVER_API_PROVIDER,'anthropic');
  assert.equal(env.AGENT_DRIVER_API_MODEL,'claude-sonnet-4-5');assert.equal(env.AGENT_DRIVER_API_REASONING,'low');
  assert.equal(env.AGENT_DRIVER_CODEX_MODEL,undefined);assert.equal(env.AGENT_DRIVER_CODEX_REASONING_EFFORT,undefined);
  assert.equal(env.AGENT_DRIVER_CLAUDE_MODEL,'opus');
});
