import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {saveModelSettings} from '../dist/onboarding/model-settings.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const selection={mode:'subscription',client:'codex',client_models:{codex:'saved-codex',claude:'saved-claude'},api_to_subscription:true,api_provider:'openai',api_model:'saved-api',api_base_url:'',reasoning:'low',jev:'off'};
const key='fixture-key-never-sent-to-provider';
const environment={OPENAI_API_KEY:key,AGENT_DRIVER_LLM_CLIENT:'codex,claude,api',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude'};
const runner={async run(r){
  if(r.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
  if(r.args.join(' ')==='auth status')return {code:0,stdout:'{"loggedIn":true,"authMethod":"claude.ai"}',stderr:''};
  return {code:1,stdout:'',stderr:'Weekly usage limit reached'};
}};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'billing-direction-'));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,'models.json');}

for(const saved of [false,true])test('runtime contract '+(saved?'saved':'unsaved')+' subscription exhaustion never constructs an ambient paid API',async t=>{
  const path=await fixture(t);if(saved)saveModelSettings(path,{revision:0,onboarding_step:2,selection},environment);
  let paid=0;const events=[];
  const model=new ConfiguredStructuredModel(path,environment,{
    api:()=>{paid++;throw Error('UNEXPECTED_PAID_API');},
    subscription:options=>{assert.equal(options.fallbackModel,undefined);return new SubscriptionAwareStructuredModel({...options,runner});},
  },event=>events.push(event));
  await assert.rejects(model.call('correct','Choose.',{work_id:'work-1'},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
  assert.equal(paid,0);assert.equal(events.at(-1).status,'no_candidate');assert.equal(events.at(-1).target,null);
  assert.ok(model.calls.every(c=>c.provider!=='openai'));
});

for(const chain of [undefined,'codex,api','api,codex','codex,claude,api'])test('runtime contract legacy subscription chain '+String(chain)+' cannot fall into injected API',async()=>{
  let paid=0;const model=new SubscriptionAwareStructuredModel({environment:{...environment,AGENT_DRIVER_LLM_CLIENT:chain},runner,fallbackKind:'api_key',fallbackModel:{calls:[],async call(){paid++;return {ok:true};}}});
  await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
  assert.equal(paid,0);assert.equal((await model.status()).fallback,'not_configured');
});

test('runtime contract explicit host API mode remains usable without implicit subscription fallback',async t=>{
  const path=await fixture(t);let paid=0,subscriptions=0;
  const model=new ConfiguredStructuredModel(path,{...environment,AGENT_DRIVER_LLM_CLIENT:'api'},{
    api:()=>({calls:[],async call(){paid++;return {ok:true};}}),
    subscription:()=>{subscriptions++;throw Error('UNEXPECTED_AUTH');},
  });
  assert.deepEqual(await model.call('correct','Choose.',{},schema),{ok:true});assert.equal(paid,1);assert.equal(subscriptions,0);
});

test('runtime contract unclassified CLI credentials are not used as an automatic subscription successor',async()=>{
  for(const subscriptionOnly of [false,true]){
    let invoked=0;const model=new SubscriptionAwareStructuredModel({
      environment:{...environment,AGENT_DRIVER_LLM_CLIENT:subscriptionOnly?'opencode':'codex,opencode',AGENT_DRIVER_OPENCODE_EXECUTABLE:'/fixture/opencode'},
      subscriptionOnly,
      runner:{async run(r){
        if(r.args.join(' ')==='auth list --format json')return {code:0,stdout:'[{"provider":"openrouter"}]',stderr:''};
        if(r.executable==='/fixture/opencode'){invoked++;throw Error('UNEXPECTED_UNCLASSIFIED_BILLING');}
        return runner.run(r);
      }},
    });
    await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
    assert.equal(invoked,0);
  }
});

test('runtime contract Claude API-key login is not mistaken for subscription auth',async()=>{
  for(const client of ['claude','codex,claude'])for(const authMethod of ['api_key','unknown']){
    let invoked=0;const model=new SubscriptionAwareStructuredModel({
      environment:{...environment,AGENT_DRIVER_LLM_CLIENT:client},
      runner:{async run(r){
        if(r.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod,subscriptionType:null}),stderr:''};
        if(r.executable==='/fixture/claude'){invoked++;throw Error('UNEXPECTED_CLAUDE_API_BILLING');}
        return runner.run(r);
      }},
    });
    await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
    assert.equal(invoked,0);
    const status=(await model.status()).clients.find(c=>c.id==='claude');
    assert.equal(status.status,'unknown');assert.equal(status.reason,'client_auth_not_subscription');
  }
});

test('runtime contract exhausted API transfers to saved auth model once, never returns to API',async t=>{
  for(const authWorks of [true,false]){
    const path=await fixture(t);saveModelSettings(path,{revision:0,onboarding_step:2,selection:{...selection,mode:'api'},api_action:'replace',api_key:key},{});
    let paid=0;const events=[];
    const model=new ConfiguredStructuredModel(path,environment,{
      api:()=>({calls:[],async call(){paid++;this.calls.push({provider:'openai',model:'saved-api',status:'failed',http_status:402});throw Error('MODEL_PROVIDER_UNAVAILABLE');}}),
      subscription:options=>new SubscriptionAwareStructuredModel({...options,runner:{async run(r){
        if(authWorks&&r.executable==='/fixture/codex'&&r.args.includes('exec')){
          assert.equal(r.args[r.args.indexOf('--model')+1],'saved-codex');
          return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}),stderr:''};
        }
        return runner.run(r);
      }}}),
    },event=>events.push(event));
    if(authWorks){assert.deepEqual(await model.call('correct','Choose.',{work_id:'work-1'},schema),{ok:true});assert.equal(events.at(-1).target,'codex');assert.equal(events.at(-1).target_model,'saved-codex');}
    else {await assert.rejects(model.call('correct','Choose.',{work_id:'work-1'},schema),/STRUCTURED_MODEL_UNAVAILABLE/);assert.equal(events.at(-1).status,'no_candidate');}
    assert.equal(paid,1);assert.ok(events.every(e=>e.target!=='api'));
  }
});
