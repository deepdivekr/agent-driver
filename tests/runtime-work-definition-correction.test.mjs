import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {initWorkExecution,workTail} from '../dist/work/activity.js';
import {WORK_DEFINITION_INSTRUCTIONS,validateOrCorrectWorkProposal} from '../dist/work/runtime.js';

const proposal=(route={kind:'swarm',pack_family:null})=>({title:'AI 병렬 조사',desired_outcome:'사용자가 요청한 출처를 병렬 조사해 근거 있는 요약을 제공한다',completion_checks:[{id:'sources',result:'요청한 출처 조사 결과를 확인한다',evidence:'각 출처 URL과 관측 영수증'}],assumptions:[],route,requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]});
function scripted(...outputs){return {calls:[],async call(purpose,instructions,input,schema){this.calls.push({purpose,instructions,input,schema});const output=outputs[this.calls.length-1];if(output instanceof Error)throw output;return structuredClone(output);}};}
async function fixture(t,model){
 const root=await mkdtemp(join(tmpdir(),'office-definition-correction-')),path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'definition-test',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},swarm:{enabled:true,model_data_approved:true}}));
 const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:model});initWorkExecution(api.store);t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});return {api,config,model};
}
test('runtime contract invalid native Swarm/family combination is corrected once without changing the requested outcome or kind',async t=>{
 const bad=proposal({kind:'swarm',pack_family:'research.search'}),model=scripted(bad,proposal()),x=await fixture(t,model),prompt='8개 에이전트로 요청한 AI 출처를 병렬 조사해 요약해줘';
 const work=await x.api.call('runtime_work_start',{request_id:'native-swarm-route',prompt});assert.equal(work.status,'ready');assert.equal(work.prompt,prompt);assert.deepEqual(work.spec.route,{kind:'swarm',pack_family:null});assert.equal(work.spec.desired_outcome,bad.desired_outcome);assert.equal(work.spec.requested_effect,'read_only');assert.equal(work.completion_verified,false);assert.deepEqual(work.runs,[]);
 assert.deepEqual(model.calls.map(call=>call.purpose),['design','correct']);assert.equal(model.calls[1].input.validation_error.code,'WORK_ROUTE_FAMILY_INVALID');assert.equal(model.calls[1].input.original_input.prompt,prompt);assert.match(model.calls[0].instructions,/non-pack route MUST set pack_family to null/u);assert.match(model.calls[1].instructions,/OUTPUT-ONLY CORRECTION/u);assert.match(model.calls[1].instructions,/Do not switch Swarm to Pack/u);assert.deepEqual(x.api.store.officeRuns(x.config.project.id,work.work_id),[]);
 const logs=workTail(x.api.store,x.config.project.id,work.work_id);assert.ok(logs.some(log=>log.kind==='definition.correction_finished'));assert.equal(logs.some(log=>log.kind==='tool.dispatch'),false);
});
test('runtime contract malformed proposal output stops after one correction and exposes only safe diagnostics',async t=>{
 const secret=['api','key_abcdefghijklmnopqrstuvwxyz123456789'].join(''),bad={...proposal(),title:42,password:'private-value-do-not-log',unknown_key:secret},model=scripted(bad,{still:'invalid',password:'private-value-do-not-log'}),x=await fixture(t,model);
 const work=await x.api.call('runtime_work_start',{request_id:'malformed-output',prompt:'요청한 출처를 조사해줘'});assert.equal(work.status,'needs_model');assert.equal(work.reason,'WORK_DEFINITION_INVALID_AFTER_CORRECTION');assert.equal(model.calls.length,2);assert.deepEqual(model.calls.map(call=>call.purpose),['design','correct']);assert.equal(work.spec,null);assert.deepEqual(work.runs,[]);
 assert.doesNotMatch(model.calls[1].input.invalid_output,/private-value-do-not-log|apikey_abcdefghijklmnopqrstuvwxyz/u);assert.match(model.calls[1].input.invalid_output,/REDACTED/u);
 const logs=JSON.stringify(workTail(x.api.store,x.config.project.id,work.work_id));assert.doesNotMatch(logs,/private-value-do-not-log|apikey_abcdefghijklmnopqrstuvwxyz/u);assert.match(logs,/WORK_DEFINITION_SCHEMA_INVALID/u);
 const repeated=await x.api.call('runtime_work_start',{request_id:'malformed-output',prompt:'요청한 출처를 조사해줘'});assert.equal(repeated.work_id,work.work_id);assert.equal(model.calls.length,2);
});
test('runtime contract provider, authentication and quota failures never initiate a definition correction loop',async t=>{
 for(const [id,message]of [['provider','SERVICE_PROVIDER_UNAVAILABLE'],['auth','Authentication expired'],['quota','Weekly usage limit reached'],['misleading','WORK_ROUTE_FAMILY_INVALID']]){
  const model=scripted(new Error(message),proposal()),x=await fixture(t,model),work=await x.api.call('runtime_work_start',{request_id:`failure-${id}`,prompt:'요청한 출처를 조사해줘'});assert.equal(work.status,'needs_model');assert.equal(work.reason,'MODEL_OR_DEFINITION_UNAVAILABLE');assert.equal(model.calls.length,1);assert.deepEqual(model.calls.map(call=>call.purpose),['design']);assert.equal(work.spec,null);
  const logs=workTail(x.api.store,x.config.project.id,work.work_id);assert.equal(logs.some(log=>log.kind==='definition.correction_started'),false);
 }
});
test('runtime contract failed correction provider call stops immediately and keeps the durable Work for reconnection',async t=>{
 const model=scripted(proposal({kind:'swarm',pack_family:'research.search'}),new Error('Authentication expired')),x=await fixture(t,model),work=await x.api.call('runtime_work_start',{request_id:'correction-auth',prompt:'요청한 출처를 병렬 조사해줘'});assert.equal(work.status,'needs_model');assert.equal(work.reason,'MODEL_OR_DEFINITION_UNAVAILABLE');assert.equal(model.calls.length,2);assert.equal(x.api.store.intakeWork(x.config.project.id,work.work_id).prompt,work.prompt);assert.deepEqual(work.runs,[]);
 assert.ok(workTail(x.api.store,x.config.project.id,work.work_id).some(log=>log.kind==='definition.correction_failed'));
});
test('runtime contract output correction cannot silently change the route kind, intended outcome or effect authorization',async t=>{
 const bad=proposal({kind:'swarm',pack_family:'research.search'});
 for(const [id,corrected]of [['route',proposal({kind:'pack',pack_family:'research.search'})],['outcome',{...proposal(),desired_outcome:'전혀 다른 자료를 조사한다'}],['effect',{...proposal(),requested_effect:'external_effect_requested'}]]){
  const model=scripted(bad,corrected),x=await fixture(t,model),work=await x.api.call('runtime_work_start',{request_id:`scope-${id}`,prompt:'요청한 출처를 병렬 조사해줘'});assert.equal(work.status,'needs_model');assert.equal(work.reason,'WORK_DEFINITION_INVALID_AFTER_CORRECTION');assert.equal(model.calls.length,2);assert.equal(work.spec,null);assert.deepEqual(work.runs,[]);
 }
});
test('runtime contract exported proposal validator is reusable by replanning and valid outputs make no extra call',async()=>{
 const input={prompt:'새 지침에 따라 병렬 조사'},events=[],model=scripted(proposal()),valid=proposal();assert.equal((await validateOrCorrectWorkProposal(valid,'quick',false,{model,instructions:WORK_DEFINITION_INSTRUCTIONS,input})).route.kind,'swarm');assert.equal(model.calls.length,0);
 const corrected=await validateOrCorrectWorkProposal(proposal({kind:'swarm',pack_family:'research.search'}),'quick',false,{model,instructions:WORK_DEFINITION_INSTRUCTIONS,input,onDiagnostic:event=>events.push(event)});assert.deepEqual(corrected.route,{kind:'swarm',pack_family:null});assert.equal(model.calls.length,1);assert.equal(model.calls[0].input.original_input.prompt,input.prompt);assert.deepEqual(events.map(event=>event.kind),['invalid_output','correction_started','correction_finished']);
});
