import test from 'node:test';
import assert from 'node:assert/strict';
import {TypeSafeJevDecisionLayer,compileOneLineJevRequest,openAiTargetedLlmExtractorFromHostEnvironment,openAiTargetedLlmRequest,resolveTargetedLlmExtraction,targetedLlmExtractorFromStructuredModel,typeSafeTransportFromHostEnvironment} from '../dist/taskpack/typesafe-jev.js';

const input={
  request:'이름 김민수와 메모 오후에 다시 연락으로 초안 저장해줘',policy_version:'sampleportal_v1',
  routes:[{id:'draft_save',description:'Save a contact draft.'},{id:'report_export',description:'Export a report.'}],
  fields:[
    {id:'name',route_id:'draft_save',description:'Contact name.',required:true,candidates:[{id:'name_candidate',description:'Exact user text candidate for 김민수.'}]},
    {id:'memo',route_id:'draft_save',description:'Draft memo.',required:true,candidates:[]},
  ],observed_state:{origin:'https://example.test',authenticated:true},
};
function response(overrides={}){
  return {model:'jev-1.13.0',usage:{input_tokens:42,output_tokens:9},answers:{
    route:{type:'choice',choice:'draft_save',confidence:0.99,probabilities:{draft_save:0.99,report_export:0.01,UNSUPPORTED:0,CLARIFY:0}},
    'field.name.candidate':{type:'choice',choice:'name_candidate',confidence:0.99,probabilities:{name_candidate:0.99,NOT_STATED:0.01,NOT_IN_CANDIDATES:0}},
    'field.name.supplied':{type:'noul',noul:0.99},
    'field.memo.candidate':{type:'choice',choice:'NOT_STATED',confidence:0.99,probabilities:{NOT_STATED:0.99,NOT_IN_CANDIDATES:0.01}},
    'field.memo.supplied':{type:'noul',noul:0.96},
  },...overrides};
}
test('runtime TypeSafe Jev compiles one line into bounded Choice and Noul questions',()=>{
  const packet=compileOneLineJevRequest(input);
  assert.equal(packet.request.model,'jev-latest');assert.deepEqual(Object.keys(packet.request.questions),['route','field.name.candidate','field.name.supplied','field.memo.candidate','field.memo.supplied']);
  assert.equal(packet.request.questions['field.memo.candidate'].criteria.NOT_IN_CANDIDATES.includes('Extraction'),true);
  assert.equal(packet.request.state.policy.execution_authority,false);
});
test('runtime TypeSafe Jev sends only one no-retry batch and turns supplied-but-unrepresented input into targeted extraction',async()=>{
  const calls=[],layer=new TypeSafeJevDecisionLayer({async systemOne(request,options){calls.push({request,options});return response();}});
  const result=await layer.decide(input);
  assert.deepEqual({status:result.status,route_id:result.route_id,field_ids:result.status==='NEEDS_EXTRACTION'?result.field_ids:undefined},{status:'NEEDS_EXTRACTION',route_id:'draft_save',field_ids:['memo']});
  assert.equal(calls.length,1);assert.deepEqual(calls[0].options,{timeout:1500,retry:{maxRetries:0}});assert.equal(JSON.stringify(result.trace).includes(input.request),false);assert.equal(result.trace.input_tokens,42);
});
test('runtime TypeSafe Jev accepts only calibrated high-confidence code candidates',async()=>{
  const layer=new TypeSafeJevDecisionLayer({async systemOne(){const value=response();value.answers['field.memo.candidate']={type:'choice',choice:'NOT_IN_CANDIDATES',confidence:0.99,probabilities:{NOT_STATED:0,NOT_IN_CANDIDATES:1}};value.answers['field.memo.supplied']={type:'noul',noul:0.99};return value;}});
  const result=await layer.decide(input,{min_route_confidence:0.8,min_field_confidence:0.8,min_supplied_probability:0.8});assert.deepEqual(result,{status:'NEEDS_EXTRACTION',route_id:'draft_save',field_ids:['memo'],trace:result.trace});
  const proposedLayer=new TypeSafeJevDecisionLayer({async systemOne(){const value=response();value.answers['field.memo.candidate']={type:'choice',choice:'NOT_STATED',confidence:0.99,probabilities:{NOT_STATED:1,NOT_IN_CANDIDATES:0}};value.answers['field.memo.supplied']={type:'noul',noul:0.01};return value;}});
  const missing=await proposedLayer.decide(input);assert.equal(missing.status,'NEEDS_CLARIFICATION');assert.equal(missing.reason,'REQUIRED_INPUT_MISSING');
});
test('runtime TypeSafe Jev suppresses provider detail and rejects missing host credential',async()=>{
  const layer=new TypeSafeJevDecisionLayer({async systemOne(){throw Error('credential never place this in trace');}}),result=await layer.decide(input);
  assert.deepEqual({status:result.status,trace:result.trace.status},{status:'JEV_UNAVAILABLE',trace:'unavailable'});assert.equal(JSON.stringify(result).includes('credential never'),false);
  assert.throws(()=>typeSafeTransportFromHostEnvironment({}),/TYPESAFE_CREDENTIAL_UNAVAILABLE/);
});
test('runtime targeted LLM correction accepts only exact one-line provenance for Jev extraction fields',async()=>{
  const jev={status:'NEEDS_EXTRACTION',route_id:'draft_save',field_ids:['memo'],trace:{provider:'typesafe',model:'jev-1.13.0',input_sha256:'a'.repeat(64),elapsed_ms:1,input_tokens:1,output_tokens:1,status:'accepted'}};
  const start=input.request.indexOf('오후에 다시 연락'),correct=await resolveTargetedLlmExtraction(input,jev,{async extract(request){assert.deepEqual(request.fields,[{id:'memo',description:'Draft memo.'}]);return {model:'gpt-5.6-luna',values:{memo:{value:'오후에 다시 연락',start,end:start+'오후에 다시 연락'.length}}};}});
  assert.equal(correct.status,'EXTRACTED');assert.equal(correct.status==='EXTRACTED'&&correct.values.memo.value,'오후에 다시 연락');assert.equal(JSON.stringify(correct.trace).includes(input.request),false);
  const rejected=await resolveTargetedLlmExtraction(input,jev,{async extract(){return {model:'gpt-5.6-luna',values:{memo:{value:'invented',start:0,end:8}}};}});assert.deepEqual({status:rejected.status,trace:rejected.trace.status},{status:'LLM_REJECTED',trace:'rejected'});
});
test('runtime OpenAI correction adapter is one-shot, schema-bound, and host-secret-only',async()=>{
  const request={request:input.request,route_id:'draft_save',fields:[{id:'memo',description:'Draft memo.'}]},packet=openAiTargetedLlmRequest(request);
  assert.deepEqual({model:packet.model,effort:packet.reasoning.effort,store:packet.store,tools:packet.tools,strict:packet.text.format.strict},{model:'gpt-5.6-luna',effort:'low',store:false,tools:[],strict:true});
  assert.deepEqual(packet.text.format.schema.properties.values.required,['memo']);assert.equal(packet.text.format.schema.properties.values.additionalProperties,false);
  const calls=[],start=input.request.indexOf('오후에 다시 연락'),extractor=openAiTargetedLlmExtractorFromHostEnvironment({OPENAI_API_KEY:'test-only-safe-host-secret'}, {timeout_ms:1_500,fetcher:async(url,options)=>{
    calls.push({url,options});return {ok:true,json:async()=>({status:'completed',model:'gpt-5.6-luna',output:[{type:'reasoning'},{type:'message',content:[{type:'output_text',text:JSON.stringify({values:{memo:{value:'오후에 다시 연락',start,end:start+'오후에 다시 연락'.length}}})}]}]})};
  }});
  const raw=await extractor.extract(request);assert.deepEqual(raw,{model:'gpt-5.6-luna',values:{memo:{value:'오후에 다시 연락',start,end:start+'오후에 다시 연락'.length}}});
  assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.openai.com/v1/responses');assert.equal(calls[0].options.headers.Authorization,'Bearer test-only-safe-host-secret');
  assert.equal(calls[0].options.body.includes('test-only-safe-host-secret'),false);assert.throws(()=>openAiTargetedLlmExtractorFromHostEnvironment({}),/OPENAI_CREDENTIAL_UNAVAILABLE/);
});

test('runtime Jev correction can use the same provider-neutral structured model as Pack and Swarm',async()=>{
  const request={request:'도쿄 12월 28일',route_id:'search',fields:[{id:'date',description:'Requested date.'}]},calls=[];let received;
  const model={calls,async call(purpose,instructions,input,schema){received={purpose,instructions,input,schema};calls.push({model:'openrouter/fixture'});return {values:{date:{value:'12월 28일',start:3,end:10}}};}};
  const value=await targetedLlmExtractorFromStructuredModel(model).extract(request);assert.equal(value.model,'openrouter/fixture');assert.equal(received.purpose,'correct');assert.deepEqual(received.schema.required,['values']);assert.equal(received.input.request.text,request.request);
});
