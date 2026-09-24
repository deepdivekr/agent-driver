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
import {clientHandoffSchema} from '../dist/integrations/client-handoff.js';

const key='fixture-provider-key-not-real-12345';
const selection={mode:'subscription',client:'codex',client_models:{codex:'gpt-5.6-luna',claude:'sonnet',opencode:'openrouter/test-model'},api_to_subscription:false,api_provider:'openai',api_model:'gpt-5.6-luna',api_base_url:'',reasoning:'low',jev:'off'};
const schema={type:'object',properties:{choice:{type:'string'}},required:['choice'],additionalProperties:false};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'driver-handoff-'));t.after(()=>rm(root,{recursive:true,force:true}));return {root,path:join(root,'.connection','models.json'),database:join(root,'store.sqlite')};}

test('selected subscription client is first, while every connected fallback retains its own saved model',async t=>{
  const x=await fixture(t);saveModelSettings(x.path,{revision:0,onboarding_step:2,selection},{});
  const saved=readModelSettings(x.path),env=effectiveModelEnvironment(saved,{});
  assert.equal(env.AGENT_DRIVER_LLM_CLIENT,'codex,mcp,claude,opencode');
  assert.equal(env.AGENT_DRIVER_CODEX_MODEL,'gpt-5.6-luna');assert.equal(env.AGENT_DRIVER_CLAUDE_MODEL,'sonnet');assert.equal(env.AGENT_DRIVER_OPENCODE_MODEL,'openrouter/test-model');
  assert.throws(()=>saveModelSettings(x.path,{revision:1,onboarding_step:2,selection:{...selection,client_models:{...selection.client_models,codex:'sk-proj-ABCDEFGHIJKLMNOPQRSTUV'}}},{}));
});

test('Codex quota failure transfers one no-tools judgment to Claude saved model and survives database restart',async t=>{
  const x=await fixture(t),events=[],calls=[];let store=new PackStore(x.database);
  const runner={async run(request){calls.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai'}),stderr:''};
    if(request.executable==='/fixture/codex')return {code:1,stdout:'',stderr:'Weekly usage limit reached'};
    if(request.executable==='/fixture/claude')return {code:0,stdout:JSON.stringify({is_error:false,structured_output:{choice:'B'}}),stderr:''};
    throw Error('UNEXPECTED_CLIENT');
  }};
  const env={AGENT_DRIVER_LLM_CLIENT:'codex,claude',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_CODEX_MODEL:'gpt-5.6-luna',AGENT_DRIVER_CLAUDE_MODEL:'sonnet'};
  const model=new SubscriptionAwareStructuredModel({environment:env,runner,onHandoff:event=>{events.push(event);store.recordClientHandoff('fixture-project',event);}});
  assert.deepEqual(await model.call('correct','Choose.',{work_id:'work-1',run_id:'run-1',stage_id:'stage-1'},schema),{choice:'B'});
  assert.equal(calls.filter(call=>call.executable==='/fixture/claude'&&call.args.includes('-p')).length,1);
  assert.ok(calls.find(call=>call.executable==='/fixture/claude'&&call.args.includes('--model')&&call.args.includes('sonnet')));
  assert.deepEqual(events.map(event=>[event.source,event.target,event.source_model,event.target_model,event.reason,event.effect_state,event.status]),[['codex','claude','gpt-5.6-luna','sonnet','quota_exhausted','none','transferred']]);
  assert.equal(model.calls[0].failure_kind,'quota_exhausted');
  store.close();store=new PackStore(x.database);t.after(()=>store.close());
  const durable=store.clientHandoffs('fixture-project','work-1');assert.equal(durable.length,1);assert.equal(durable[0].run_id,'run-1');assert.equal(durable[0].stage_id,'stage-1');assert.doesNotMatch(JSON.stringify(durable),/Weekly usage|fixture-provider-key/u);
  assert.deepEqual(clientHandoffSchema.parse(durable[0]),durable[0]);
});

test('API to subscription handoff requires an explicit saved choice and records target model',async t=>{
  const x=await fixture(t),events=[],seen=[];
  const api=()=>({calls:[],async call(){this.calls.push({provider:'openai',model:'api-model',http_status:429,status:'failed'});throw Error('MODEL_PROVIDER_UNAVAILABLE');}});
  const subscription=options=>({calls:[],async call(){seen.push(options.environment);this.calls.push({provider:'claude',model:options.environment.AGENT_DRIVER_CLAUDE_MODEL,status:'accepted'});return {choice:'A'};}});
  saveModelSettings(x.path,{revision:0,onboarding_step:2,selection:{...selection,mode:'api',client:'claude',api_model:'api-model'},api_action:'replace',api_key:key},{});
  const model=new ConfiguredStructuredModel(x.path,{}, {api,subscription},event=>events.push(event));
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-2'},schema),/MODEL_PROVIDER_UNAVAILABLE/u);assert.equal(seen.length,0);
  saveModelSettings(x.path,{revision:1,onboarding_step:2,selection:{...selection,mode:'api',client:'claude',api_model:'api-model',api_to_subscription:true}},{});
  assert.deepEqual(await model.call('correct','Choose.',{work_id:'work-2'},schema),{choice:'A'});
  assert.equal(seen[0].AGENT_DRIVER_LLM_CLIENT,'claude,mcp,codex,opencode');assert.equal(seen[0].AGENT_DRIVER_CLAUDE_MODEL,'sonnet');
  assert.deepEqual(events.map(event=>[event.source,event.target,event.source_model,event.target_model,event.reason]),[['api','claude','api-model','sonnet','rate_limited']]);
});

test('API client errors unrelated to authentication or capacity never trigger a subscription retry',async t=>{
  const x=await fixture(t);saveModelSettings(x.path,{revision:0,onboarding_step:2,selection:{...selection,mode:'api',api_to_subscription:true},api_action:'replace',api_key:key},{});
  let retries=0;const model=new ConfiguredStructuredModel(x.path,{}, {api:()=>({calls:[{http_status:400}],async call(){throw Error('MODEL_PROVIDER_UNAVAILABLE');}}),subscription:()=>({calls:[],async call(){retries++;return {};}})});
  await assert.rejects(model.call('correct','Choose.',{},schema),/MODEL_PROVIDER_UNAVAILABLE/u);assert.equal(retries,0);
});

test('an expired selected client with no usable successor leaves a typed no-candidate receipt',async()=>{
  const events=[],runner={async run(request){if(request.args.join(' ')==='login status')return {code:1,stdout:'',stderr:'Session expired'};return {code:1,stdout:'',stderr:'Not logged in'};}};
  const model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'codex',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CODEX_MODEL:'gpt-5.6-luna'},runner,onHandoff:event=>events.push(event)});
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-3'},schema),/STRUCTURED_MODEL_UNAVAILABLE/u);
  assert.deepEqual(events.map(event=>[event.work_id,event.source,event.target,event.reason,event.status]),[['work-3','codex',null,'auth_expired','no_candidate']]);
});

test('current model catalogs are bounded, key-safe, and keep latest Claude aliases',async()=>{
  const seen=[];const catalog=await apiModelCatalog('openrouter',key,'',async(url,options)=>{seen.push({url,auth:options.headers.Authorization});return new Response(JSON.stringify({data:[{id:'provider/new-model',name:'New model'},{id:'invalid model'}]}),{status:200});});
  assert.equal(catalog.status,'available');assert.deepEqual(catalog.models,[{id:'provider/new-model',label:'New model'}]);assert.equal(seen[0].url,'https://openrouter.ai/api/v1/models');assert.equal(seen[0].auth,'Bearer '+key);assert.doesNotMatch(JSON.stringify(catalog),new RegExp(key));
  assert.deepEqual(claudeModelCatalog().models.map(item=>item.id),['sonnet','opus','haiku']);
});
