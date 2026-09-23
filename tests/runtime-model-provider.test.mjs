import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCompatibleBaseUrl,probeStructuredModel,structuredModelFromEnvironment} from '../dist/integrations/model-provider.js';

const secret='fixture-provider-key-never-log-123456';
const schema={type:'object',additionalProperties:false,required:['status','nonce'],properties:{status:{type:'string'},nonce:{type:'string'}}};
const result={status:'ok',nonce:'agent-driver-provider-probe'};

function response(provider){
  if(provider==='openai')return {status:'completed',model:'fixture',output:[{type:'message',phase:'final_answer',content:[{type:'output_text',text:JSON.stringify(result)}]}],usage:{input_tokens:3,output_tokens:2,total_tokens:5}};
  if(provider==='anthropic')return {stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify(result)}],usage:{input_tokens:3,output_tokens:2}};
  return {choices:[{finish_reason:'stop',message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};
}

for(const [provider,expectedUrl] of [
  ['openai','https://api.openai.com/v1/responses'],
  ['anthropic','https://api.anthropic.com/v1/messages'],
  ['openrouter','https://openrouter.ai/api/v1/chat/completions'],
  ['openai_compatible','https://models.example.test/v1/chat/completions'],
])test(`runtime ${provider} adapter sends a bounded schema request and decodes structured output`,async()=>{
  let call;const fetcher=async(url,options)=>{call={url:String(url),options,body:JSON.parse(String(options.body))};return new Response(JSON.stringify(response(provider)),{status:200,headers:{'content-type':'application/json'}});};
  const environment={AGENT_DRIVER_API_PROVIDER:provider,AGENT_DRIVER_API_KEY:secret,AGENT_DRIVER_API_MODEL:provider==='openrouter'?'anthropic/claude-sonnet-4.5':'fixture-model',AGENT_DRIVER_API_REASONING:'low',...(provider==='openai_compatible'?{AGENT_DRIVER_API_BASE_URL:'https://models.example.test/v1'}:{})};
  const model=structuredModelFromEnvironment(environment,fetcher);assert.deepEqual(await model.call('correct','Return the state.',result,schema),result);
  assert.equal(call.url,expectedUrl);assert.equal(call.options.redirect,'error');assert.equal(JSON.stringify(call.body).includes(secret),false);assert.equal(call.body.tools?.length??0,0);
  if(provider==='openai')assert.deepEqual(call.body.text.format.schema,schema);
  else if(provider==='anthropic'){assert.deepEqual(call.body.output_config.format.schema,schema);assert.equal(call.body.output_config.effort,'low');}
  else assert.deepEqual(call.body.response_format.json_schema.schema,schema);
  if(provider==='openrouter'){assert.equal(call.body.provider.require_parameters,true);assert.deepEqual(call.body.reasoning,{effort:'low',exclude:true});}
  assert.equal(model.calls[0].provider,provider);assert.equal(model.calls[0].status,'accepted');assert.equal(JSON.stringify(model.calls).includes(secret),false);
});

test('runtime provider probe proves an exact schema response and does not treat HTTP success as readiness',async()=>{
  const environment={AGENT_DRIVER_API_PROVIDER:'openrouter',AGENT_DRIVER_API_KEY:secret,AGENT_DRIVER_API_MODEL:'openai/gpt-5-mini'};
  const ok=await probeStructuredModel(environment,async()=>new Response(JSON.stringify(response('openrouter')),{status:200}));assert.equal(ok.status,'ready');assert.equal(ok.credentials_exposed,false);
  await assert.rejects(probeStructuredModel(environment,async()=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"status":"ok","nonce":"wrong"}'}}]}),{status:200})),/MODEL_PROVIDER_PROBE_INVALID/);
  await assert.rejects(probeStructuredModel(environment,async()=>new Response('denied',{status:401})),/MODEL_PROVIDER_UNAVAILABLE/);
});

test('runtime custom compatible endpoint rejects credentials, redirects, public HTTP and full method paths',()=>{
  assert.equal(normalizeCompatibleBaseUrl('https://models.example.test/v1/'),'https://models.example.test/v1/');
  assert.equal(normalizeCompatibleBaseUrl('http://127.0.0.1:11434/v1'),'http://127.0.0.1:11434/v1/');
  for(const value of ['http://models.example.test/v1','https://user:secret@models.example.test/v1','https://models.example.test/v1?key=secret','https://models.example.test/v1/chat/completions','https://models.example.test/'])assert.throws(()=>normalizeCompatibleBaseUrl(value),/MODEL_PROVIDER_/);
});
