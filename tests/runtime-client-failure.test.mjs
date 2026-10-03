import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PackStore} from '../dist/packs/store.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {saveModelSettings,readModelSettings,effectiveModelEnvironment} from '../dist/onboarding/model-settings.js';
import {apiModelCatalog,claudeModelCatalog} from '../dist/onboarding/model-catalog.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {classifyClientFailure,isNonRetryableClientFailure} from '../dist/integrations/client-failure.js';

const key='fixture-provider-key-not-real-12345';
const selection={mode:'subscription',client:'codex',client_models:{codex:'gpt-5.6-luna',claude:'sonnet',opencode:'openrouter/test-model'},api_to_subscription:false,api_provider:'openai',api_model:'gpt-5.6-luna',api_base_url:'',reasoning:'low',jev:'off'};
const schema={type:'object',properties:{choice:{type:'string'}},required:['choice'],additionalProperties:false};
async function fixture(t,dispose=()=>{}){const root=await mkdtemp(join(tmpdir(),'driver-client-'));t.after(async()=>{await dispose();await rm(root,{recursive:true,force:true});});return {root,path:join(root,'.connection','models.json'),database:join(root,'store.sqlite')};}

// Owner decision 2026-10-03: one client per Work. A judgment is answered by one client and never moves to another.
test('the saved client answers alone, and every client keeps its own saved model',async t=>{
  const x=await fixture(t);saveModelSettings(x.path,{revision:0,onboarding_step:2,selection},{});
  const saved=readModelSettings(x.path),env=effectiveModelEnvironment(saved,{});
  assert.equal(env.AGENT_DRIVER_LLM_CLIENT,'codex');
  assert.equal(env.AGENT_DRIVER_CODEX_MODEL,'gpt-5.6-luna');assert.equal(env.AGENT_DRIVER_CLAUDE_MODEL,'sonnet');assert.equal(env.AGENT_DRIVER_OPENCODE_MODEL,'openrouter/test-model');
  assert.equal(effectiveModelEnvironment({...saved,selection:{...saved.selection,client:'auto'}},{}).AGENT_DRIVER_LLM_CLIENT,'codex');
  assert.throws(()=>saveModelSettings(x.path,{revision:1,onboarding_step:2,selection:{...selection,client_models:{...selection.client_models,codex:'sk-proj-ABCDEFGHIJKLMNOPQRSTUV'}}},{}));
});
test('a Codex quota failure stays with Codex: an older saved list never sends the judgment to Claude',async()=>{
  const calls=[],runner={async run(request){calls.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),stderr:''};
    if(request.executable==='/fixture/codex')return {code:1,stdout:'',stderr:'Weekly usage limit reached'};
    throw Error('UNEXPECTED_CLIENT');
  }};
  const model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'codex,claude',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_CODEX_MODEL:'gpt-5.6-luna'},runner});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-1',run_id:'run-1'},schema),/^Error: STRUCTURED_MODEL_UNAVAILABLE$/u);
  assert.equal(calls.some(call=>call.executable==='/fixture/claude'),false);
  assert.deepEqual(model.calls.map(call=>[call.provider,call.failure_kind]),[['codex','quota_exhausted']]);
});
test('an unsupported Codex model is typed from stdout despite generic stderr and never moves to another client',async()=>{
  const calls=[],runner={async run(request){calls.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.executable==='/fixture/codex')return {code:1,stdout:JSON.stringify({type:'error',message:"The 'fixture-model' model is not supported when using Codex with a ChatGPT account. private-output-must-not-leak"}),stderr:'Command failed'};
    throw Error('UNEXPECTED_CLIENT');
  }};
  const model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'codex,claude',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_CODEX_MODEL:'fixture-model'},runner});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-model'},schema),/^Error: STRUCTURED_MODEL_UNSUPPORTED$/u);
  assert.equal(calls.some(call=>call.executable==='/fixture/claude'),false);
  assert.equal(model.calls[0].failure_kind,'model_unsupported');
  assert.doesNotMatch(JSON.stringify(model.calls),/private-output-must-not-leak/u);
});
test('request-schema errors are distinct from provider, auth, quota and model output failures',()=>{
  assert.equal(classifyClientFailure(Error('CLIENT_OUTPUT_SCHEMA_UNSUPPORTED')),'schema_invalid');
  assert.equal(classifyClientFailure(Error('CLIENT_SCHEMA_INVALID')),'schema_invalid');
  assert.equal(classifyClientFailure('HTTP 400: Invalid schema for response_format: completion_checks/items/native_check/anyOf/0: oneOf is not permitted'),'schema_invalid');
  assert.equal(isNonRetryableClientFailure(Error('CLIENT_OUTPUT_SCHEMA_UNSUPPORTED')),true);
  assert.equal(isNonRetryableClientFailure(Error('CLIENT_SCHEMA_INVALID')),true);
  assert.equal(isNonRetryableClientFailure(Error('CLIENT_QUOTA_EXHAUSTED')),false);
  assert.equal(classifyClientFailure('Weekly usage limit reached'),'quota_exhausted');
  assert.equal(classifyClientFailure('Session expired'),'auth_expired');
});

test('Codex HTTP400 response schema stops before another subscription or ambient paid API invocation',async()=>{
  const calls=[];let paid=0;
  const runner={async run(request){calls.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.executable==='/fixture/codex')return {code:1,stdout:JSON.stringify({type:'error',message:'Invalid schema for response_format: completion_checks/items/native_check/anyOf/0: oneOf is not permitted. private-value-must-not-leak'}),stderr:'Command failed'};
    throw Error('UNEXPECTED_SUCCESSOR_OR_MODEL_CALL');
  }};
  const fallbackModel={calls:[],async call(){paid++;return {choice:'paid'};}};
  const model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'codex,claude,api',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude'},runner,fallbackModel,fallbackKind:'api_key'});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-schema'},schema),/^Error: CLIENT_SCHEMA_INVALID$/u);
  assert.equal(calls.filter(call=>call.executable==='/fixture/codex'&&call.args.includes('exec')).length,1);
  assert.equal(calls.some(call=>call.executable==='/fixture/claude'),false);
  assert.equal(paid,0);
  assert.equal(model.calls[0].failure_kind,'schema_invalid');
  assert.doesNotMatch(JSON.stringify(model.calls),/private-value-must-not-leak/u);
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-schema'},schema),/^Error: CLIENT_SCHEMA_INVALID$/u);
  assert.equal(calls.filter(call=>call.args.join(' ')==='login status').length,1,'an app schema error must not invalidate a verified subscription login');
});

test('a saved API-to-subscription choice no longer moves a failed API call to a subscription app',async t=>{
  const x=await fixture(t),seen=[];
  const api=()=>({calls:[],async call(){this.calls.push({provider:'openai',model:'api-model',http_status:429,status:'failed'});throw Error('MODEL_PROVIDER_UNAVAILABLE');}});
  const subscription=options=>({calls:[],async call(){seen.push(options.environment);return {choice:'A'};}});
  saveModelSettings(x.path,{revision:0,onboarding_step:2,selection:{...selection,mode:'api',client:'claude',api_model:'api-model',api_to_subscription:true},api_action:'replace',api_key:key},{});
  const model=new ConfiguredStructuredModel(x.path,{},{api,subscription});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-2'},schema),/MODEL_PROVIDER_UNAVAILABLE/u);assert.equal(seen.length,0);
});
test('an expired client is reported as unavailable without asking another client',async()=>{
  const calls=[],runner={async run(request){calls.push(request);if(request.args.join(' ')==='login status')return {code:1,stdout:'',stderr:'Session expired'};return {code:1,stdout:'',stderr:'Not logged in'};}};
  const model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'codex,claude',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_CODEX_MODEL:'gpt-5.6-luna'},runner});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-3'},schema),/STRUCTURED_MODEL_UNAVAILABLE/u);
  assert.equal(calls.some(call=>call.executable==='/fixture/claude'),false);
});
test('current model catalogs are bounded, key-safe, and distinguish exact Claude Sonnet 5.5 from provider aliases',async()=>{
  const seen=[];const catalog=await apiModelCatalog('openrouter',key,'',async(url,options)=>{seen.push({url,auth:options.headers.Authorization});return new Response(JSON.stringify({data:[{id:'provider/new-model',name:'New model'},{id:'invalid model'}]}),{status:200});});
  assert.equal(catalog.status,'available');assert.deepEqual(catalog.models,[{id:'provider/new-model',label:'New model'}]);assert.equal(seen[0].url,'https://openrouter.ai/api/v1/models');assert.equal(seen[0].auth,'Bearer '+key);assert.doesNotMatch(JSON.stringify(catalog),new RegExp(key));
  const claude=claudeModelCatalog();assert.deepEqual(claude.models.map(item=>item.id),['claude-sonnet-5-5','sonnet','opus','haiku']);
  assert.match(claude.models[0].label,/5\.5/u);assert.doesNotMatch(claude.models.find(item=>item.id==='sonnet').label,/5\.5/u);
});
