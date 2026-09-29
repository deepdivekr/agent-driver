import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {BoundedWorkClientExecutor,WorkClientToolInputError,workClientDecisionSchema} from '../dist/work/client-executor.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {saveModelSettings,scopedModelSettingsPath} from '../dist/onboarding/model-settings.js';

const request={work_id:'work-1',run_id:'run-1',prompt:'Find the current physical AI source and report its title.',completion_checks:[{id:'source',result:'Report one source title.',evidence:'A retrieved source.'}]};
const readTool={name:'browser_read',description:'Read a delegated public source.',input_schema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false},effect:'read_only'};
const writeTool={name:'send_message',description:'Send one separately approved message.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},effect:'external_write'};
const choose=(name='browser_read',args={url:'https://example.test/news'})=>({action:'tool',stage_id:'collect',tool_name:name,arguments_json:JSON.stringify(args),summary:'Read the delegated source.',completed_checks:[],wait_reason:null});
const done=(ids=['source-1'])=>({action:'complete',stage_id:'report',tool_name:null,arguments_json:null,summary:'Observed source title: Physical AI.',completed_checks:[{id:'source',evidence_ids:ids}],wait_reason:null});
const receipt={status:'succeeded',value:{title:'Physical AI'},evidence_ids:['source-1'],effect_state:'none',retry_safe:true};
function model(queue){return {calls:[],inputs:[],async call(purpose,instructions,input){this.inputs.push(structuredClone(input));const next=queue.shift();if(next instanceof Error)throw next;this.calls.push({purpose,provider:'fixture',model:'fixture-decision',elapsed_ms:1,input_sha256:'a'.repeat(64),status:'accepted',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return next;}};}
function hooks(overrides={}){const saved=[],events=[],executions=[];return {saved,events,executions,tools:[readTool],async checkpoint(value){saved.push(structuredClone(value));},async progress(event){events.push(event);},async executeTool(name,args,context){executions.push({name,args,context});return receipt;},async verifyCompletion(_checks,observations){return observations.at(-1).receipt.value.title==='Physical AI';},...overrides};}
const selection={mode:'subscription',client:'codex',client_models:{codex:'saved-codex',claude:'saved-claude',opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'saved-api',api_base_url:'',reasoning:'low',jev:'off'};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'office-client-'));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,'models.json');}

test('bounded client decisions execute real host callbacks and need observed evidence plus host verification',async()=>{
  const provider=model([choose(),done()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(host.executions.length,1);
  assert.deepEqual(host.executions[0].args,{url:'https://example.test/news'});assert.equal(host.executions[0].context.work_id,request.work_id);assert.equal(host.executions[0].context.run_id,request.run_id);
  assert.equal(host.saved[0].pending.dispatched,false);assert.equal(host.saved[1].pending.dispatched,true);assert.equal(host.saved[2].pending,null);
  assert.equal(provider.inputs[1].checkpoint.observations[0].receipt.value.title,'Physical AI');assert.deepEqual(result.model_calls.map(call=>call.provider),['fixture','fixture']);
});

for(const kind of ['schema','tool_fields'])test(`Work decision ${kind} output is corrected once using the same flat schema and unchanged host context before any effect`,async()=>{
  const invalid=kind==='schema'?{...choose(),summary:42}:{...choose(),wait_reason:'approval',completed_checks:[{id:'source',evidence_ids:['not-observed']}]},provider=model([invalid,choose(),done()]),schemas=[],base=provider.call.bind(provider);
  provider.call=async(...args)=>{schemas.push(structuredClone(args[3]));return base(...args);};const host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(provider.inputs.length,3);const repair=provider.inputs[1];
  assert.deepEqual(repair.original_input,provider.inputs[0]);assert.equal(repair.validation_error.code,'WORK_CLIENT_DECISION_OUTPUT_INVALID');assert.ok(repair.validation_error.issues.length>0);assert.ok(repair.invalid_output.includes(kind==='schema'?'42':'approval'));assert.equal(repair.original_input.checkpoint.pending,null);assert.equal(repair.original_input.checkpoint.observations.length,0);assert.deepEqual(repair.original_input.completion_checks,request.completion_checks);
  assert.deepEqual(schemas[0],z.toJSONSchema(workClientDecisionSchema));assert.deepEqual(schemas[1],schemas[0]);assert.equal(schemas[0].type,'object');assert.equal(schemas[0].anyOf,undefined);assert.equal(schemas[0].oneOf,undefined);assert.equal(schemas[0].additionalProperties,false);
  assert.equal(host.events.filter(event=>event.summary.startsWith('Correcting the Work decision output once')).length,1);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.model_calls.length,3);
});

test('wait field correction does not execute a capability, assert completion or grant approval',async()=>{
  const invalid={...choose(),action:'wait',wait_reason:null,completed_checks:[{id:'source',evidence_ids:['invented']}]},corrected={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The existing permission requires user approval.',completed_checks:[],wait_reason:'approval'},provider=model([invalid,corrected]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'waiting_approval');assert.equal(result.completion_verified,false);assert.equal(host.executions.length,0);assert.equal(provider.inputs.length,2);assert.ok(provider.inputs[1].validation_error.issues.some(issue=>issue.path==='wait_reason'));assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,0);
});

test('completion field correction preserves already observed receipts and still requires independent verification',async()=>{
  const provider=model([choose(),{...done(),tool_name:'browser_read',arguments_json:'{}',wait_reason:'configuration'},done()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(provider.inputs.length,3);assert.equal(provider.inputs[2].original_input.checkpoint.observations.length,1);assert.deepEqual(provider.inputs[2].original_input.checkpoint.observations[0].receipt,receipt);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.completion_verified,true);
});

test('output correction never turns unknown completion evidence into proof or retries a valid but unsupported completion',async()=>{
  const provider=model([choose(),{...done(['invented']),tool_name:'browser_read'},done(['invented'])]);let verifications=0;const host=hooks({async verifyCompletion(){verifications++;return true;}}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');assert.equal(result.completion_verified,false);assert.equal(host.executions.length,1);assert.equal(provider.inputs.length,3);assert.equal(verifications,0);
  const valid=model([done(['invented'])]),empty=hooks(),unsupported=await new BoundedWorkClientExecutor(valid).execute(request,empty);assert.equal(unsupported.status,'failed');assert.equal(unsupported.reason,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');assert.equal(valid.inputs.length,1);assert.equal(empty.executions.length,0);
});

test('a second invalid decision output fails without dispatch and a later invalid output cannot reset the single correction budget',async()=>{
  const bad={...choose(),wait_reason:'approval'},provider=model([bad,bad,choose()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_DECISION_CORRECTION_FAILED');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,0);
  const later=model([bad,choose(),{...done(),tool_name:'browser_read'},done()]),preserved=hooks(),failed=await new BoundedWorkClientExecutor(later).execute(request,preserved);assert.equal(failed.status,'failed');assert.equal(failed.reason,'WORK_CLIENT_DECISION_CORRECTION_BUDGET_EXCEEDED');assert.equal(later.inputs.length,3);assert.equal(later.inputs.filter(input=>input.validation_error).length,1);assert.equal(preserved.executions.length,1);assert.equal(failed.checkpoint.observations.length,1);assert.deepEqual(failed.checkpoint.observations[0].receipt,receipt);
});

test('auth quota and provider failures never invoke output correction, including failure during the only correction',async()=>{
  for(const reason of ['STRUCTURED_MODEL_UNAVAILABLE','CLIENT_SUBSCRIPTION_EXHAUSTED']){
    const provider=model([Error(reason),choose()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);assert.equal(result.status,'waiting_model');assert.equal(provider.inputs.length,1);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.observations.length,0);
  }
  const provider=model([{...choose(),wait_reason:'approval'},Error('STRUCTURED_MODEL_UNAVAILABLE'),choose()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);assert.equal(result.status,'waiting_model');assert.equal(result.reason,'STRUCTURED_MODEL_UNAVAILABLE');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);
});

test('format correction does not reset the operation budget or admit another model call after pause',async()=>{
  const bad={...choose(),wait_reason:'approval'},provider=model([bad,choose(),done()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute({...request,max_turns:1},host);assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,1);assert.equal(result.checkpoint.turn,1);
  let paused=false;const stopped=model([bad,choose()]),base=stopped.call.bind(stopped);stopped.call=async(...args)=>{const value=await base(...args);paused=true;return value;};const fenced=hooks({async guard(){if(paused)throw Error('WORK_PAUSED');}}),blocked=await new BoundedWorkClientExecutor(stopped).execute(request,fenced);assert.equal(blocked.status,'paused');assert.equal(stopped.inputs.length,1);assert.equal(fenced.executions.length,0);assert.equal(blocked.checkpoint.pending,null);assert.equal(blocked.checkpoint.observations.length,0);
});

test('a model cannot mark Work complete with invented receipt IDs or without using a host capability',async()=>{
  const host=hooks();assert.equal((await new BoundedWorkClientExecutor(model([done()])).execute(request,host)).status,'failed');assert.equal(host.executions.length,0);
  const other=hooks(),result=await new BoundedWorkClientExecutor(model([choose(),done(['invented'])])).execute(request,other);assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');
});

test('an observed result without a verifier is awaiting review, not verified success',async()=>{
  const host=hooks({verifyCompletion:undefined}),result=await new BoundedWorkClientExecutor(model([choose(),done()])).execute(request,host);
  assert.equal(result.status,'awaiting_review');assert.equal(result.completion_verified,false);
});

test('restart reuses persisted receipts and the latest guidance without repeating completed tool work',async()=>{
  const first=hooks(),initial=await new BoundedWorkClientExecutor(model([choose()])).execute({...request,max_turns:1},first);
  assert.equal(initial.status,'retryable_failure');
  const next=model([done()]),second=hooks(),result=await new BoundedWorkClientExecutor(next).execute({...request,checkpoint:initial.checkpoint,context:{instruction:'Give a summary instead of a card.'}},second);
  assert.equal(result.status,'succeeded');assert.equal(second.executions.length,0);assert.equal(next.inputs[0].context.instruction,'Give a summary instead of a card.');assert.equal(next.inputs[0].checkpoint.turn,1);
});

async function interruptedRead(){
  const first=hooks({async executeTool(){throw Error('WORK_RESULT_RECEIPT_NOT_FOUND');}}),initial=await new BoundedWorkClientExecutor(model([choose()])).execute(request,first);
  assert.equal(initial.checkpoint.pending.dispatched,true);assert.equal(initial.checkpoint.pending.effect,'read_only');return initial;
}
test('a saved read retry is preflighted without falsifying its prior dispatched history, then corrected with fresh evidence',async()=>{
  const initial=await interruptedRead(),provider=model([choose('browser_read',{url:'https://example.test/verified'}),done()]),host=hooks({validateTool(_name,args){if(args.url==='https://example.test/news')throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED','Correct the known failed source check before trying to read that output.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(host.executions[0].args.url,'https://example.test/verified');assert.equal(provider.inputs.length,2);
  const rejected=result.checkpoint.observations[0];assert.deepEqual(rejected.invocation,initial.checkpoint.pending);assert.equal(rejected.invocation.dispatched,true);assert.equal(rejected.receipt.value.status,'read_retry_rejected');assert.equal(rejected.receipt.value.prior_dispatched,true);assert.equal(rejected.receipt.value.correction_required,true);assert.equal(rejected.receipt.effect_state,'none');assert.deepEqual(rejected.receipt.evidence_ids,[]);assert.equal(result.checkpoint.pending,null);
  assert.ok(host.events.some(event=>event.kind==='tool.result'&&event.summary.includes('saved read not retried')));assert.equal(provider.inputs[0].checkpoint.observations[0].invocation.dispatched,true);
});
test('a rejected saved read cannot be retried blindly by the next model turn',async()=>{
  const initial=await interruptedRead(),provider=model([choose(),choose('browser_read',{url:'https://example.test/unused'})]),host=hooks({validateTool(){throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED','Use a newly verified result instead.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_REPEATED_INVALID_TOOL_INPUT');assert.equal(provider.inputs.length,1);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.observations[0].invocation.dispatched,true);assert.equal(result.checkpoint.observations[0].receipt.value.status,'read_retry_rejected');assert.equal(result.checkpoint.observations[1].invocation.dispatched,false);assert.equal(result.checkpoint.pending,null);
});
test('saved read preflight retains scope and approval denial without a model correction or replay',async()=>{
  for(const [reason,status] of [['WORK_TOOL_SCOPE_MISMATCH','failed'],['HUMAN_APPROVAL_REQUIRED','waiting_approval']]){
    const initial=await interruptedRead(),provider=model([]),host=hooks({validateTool(){throw Error(reason);}}),result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
    assert.equal(result.status,status);assert.equal(result.reason,reason);assert.equal(provider.inputs.length,0);assert.equal(host.executions.length,0);assert.deepEqual(result.checkpoint.pending,initial.checkpoint.pending);assert.equal(result.checkpoint.observations.length,0);
  }
});
test('saved writes remain reconciliation-only even when a host offers correctable read preflight',async()=>{
  const first=hooks({tools:[writeTool],async executeTool(){throw Error('WRITE_REPLY_LOST');}}),initial=await new BoundedWorkClientExecutor(model([choose('send_message',{text:'test'})])).execute(request,first);let validations=0;
  const provider=model([]),host=hooks({tools:[writeTool],validateTool(){validations++;throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED','Must never be used to replay a write.');}}),result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'reconciliation_required');assert.equal(validations,0);assert.equal(host.executions.length,0);assert.equal(provider.inputs.length,0);assert.equal(result.checkpoint.pending.dispatched,true);assert.equal(result.checkpoint.observations.length,0);
});

test('unknown external effect is fenced across process restart, then resumes from a reconciled receipt',async()=>{
  const interrupted=hooks({tools:[writeTool],async executeTool(){throw Error('NETWORK_RESET_AFTER_DISPATCH');}});
  const initial=await new BoundedWorkClientExecutor(model([choose('send_message',{text:'test'})])).execute(request,interrupted);
  assert.equal(initial.status,'reconciliation_required');assert.equal(initial.checkpoint.pending.dispatched,true);
  const host=hooks({tools:[writeTool]}),blocked=await new BoundedWorkClientExecutor(model([])).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(blocked.status,'reconciliation_required');assert.equal(host.executions.length,0);
  const reconciled=hooks({tools:[writeTool],async reconcileTool(invocation){assert.equal(invocation.request_id,initial.checkpoint.pending.request_id);return {...receipt,effect_state:'verified',retry_safe:false};}});
  assert.equal((await new BoundedWorkClientExecutor(model([done()])).execute({...request,checkpoint:initial.checkpoint},reconciled)).status,'succeeded');assert.equal(reconciled.executions.length,0);
});

test('pause before a prepared write is dispatched remains paused, not an uncertain send',async()=>{
  let paused=false;const host=hooks({tools:[writeTool],async guard(){if(paused)throw Error('WORK_PAUSED');},async checkpoint(value){host.saved.push(structuredClone(value));if(value.pending&&!value.pending.dispatched)paused=true;}});
  const result=await new BoundedWorkClientExecutor(model([choose('send_message',{text:'test'})])).execute(request,host);
  assert.equal(result.status,'paused');assert.equal(result.checkpoint.pending.dispatched,false);assert.equal(host.executions.length,0);
});

test('authentication wait keeps the completed tool receipt and does not burn a repeated tool action',async()=>{
  const host=hooks({async executeTool(){return {status:'waiting_auth',value:{site:'X'},evidence_ids:[],effect_state:'none',retry_safe:true};}});
  const result=await new BoundedWorkClientExecutor(model([choose()])).execute(request,host);assert.equal(result.status,'waiting_auth');assert.equal(result.checkpoint.observations.length,1);
});

test('explicit authentication resume reobserves the host while preserving the old wait receipt',async()=>{
  const first=hooks({async executeTool(){return {status:'waiting_auth',value:{site:'X'},evidence_ids:[],effect_state:'none',retry_safe:true};}});
  const waited=await new BoundedWorkClientExecutor(model([choose()])).execute(request,first);
  const passive=hooks(),still=await new BoundedWorkClientExecutor(model([])).execute({...request,checkpoint:waited.checkpoint},passive);assert.equal(still.status,'waiting_auth');assert.equal(passive.executions.length,0);
  const after=model([choose(),done()]),host=hooks(),resumed=await new BoundedWorkClientExecutor(after).execute({...request,checkpoint:waited.checkpoint,resume_wait:true},host);
  assert.equal(resumed.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(after.inputs[0].checkpoint.observations[0].receipt.status,'waiting_auth');assert.equal(resumed.checkpoint.observations.length,2);
});

test('a completed write receipt is saved before a pause arriving during its operation and is not repeated on resume',async()=>{
  let release,entry;const gate=new Promise(resolve=>{release=resolve;}),entered=new Promise(resolve=>{entry=resolve;});
  let paused=false;
  const host=hooks({tools:[writeTool],async guard(){if(paused)throw Error('WORK_PAUSED');},async executeTool(name,args,context){host.executions.push({name,args,context});entry();await gate;return {...receipt,effect_state:'verified',retry_safe:false};}});
  const operation=new BoundedWorkClientExecutor(model([choose('send_message',{text:'test'})])).execute(request,host);
  await entered;paused=true;release();const stopped=await operation;
  assert.equal(stopped.status,'paused');assert.equal(stopped.checkpoint.pending,null);assert.equal(stopped.checkpoint.observations[0].receipt.effect_state,'verified');assert.equal(host.saved.at(-1).observations[0].receipt.effect_state,'verified');
  const next=hooks({tools:[writeTool]}),result=await new BoundedWorkClientExecutor(model([done()])).execute({...request,checkpoint:stopped.checkpoint},next);assert.equal(result.status,'succeeded');assert.equal(next.executions.length,0);
});

test('large result drafts retain complete artifact and Work/Run provenance while only their body is shortened',async()=>{
  const text='한글 "summary"\n'.repeat(2200),artifact={path:'/local/office/work-1/run-1/summary.txt',sha256:'c'.repeat(64),bytes:Buffer.byteLength(text),format:'txt'};
  // Metadata deliberately follows the large body: a prefix preview would lose all of it.
  const large={status:'succeeded',text,work_id:'work-1',run_id:'run-1',artifact,external_delivery:false,deduplicated:false,title:'Physical AI'};
  const provider=model([choose(),done()]),host=hooks({async executeTool(){return {...receipt,value:large};}}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');const value=result.checkpoint.observations[0].receipt.value;
  assert.equal(value.work_id,'work-1');assert.equal(value.run_id,'run-1');assert.deepEqual(value.artifact,artifact);assert.equal(value.external_delivery,false);
  assert.equal(value.title,'Physical AI');assert.ok(value.text.length<text.length);assert.ok(text.startsWith(value.text));assert.ok(!value.text.includes('\ufffd'));
  assert.ok(Buffer.byteLength(JSON.stringify(value))<=16000);assert.equal(value._office_compaction.truncated,true);assert.equal(value._office_compaction.original_bytes,Buffer.byteLength(JSON.stringify(large)));
  assert.ok(value._office_compaction.changes.some(change=>change.path==='/text'&&change.kind==='text'));
  assert.deepEqual(provider.inputs[1].checkpoint.observations[0].receipt.value.artifact,artifact);assert.deepEqual(host.saved.at(-1).observations[0].receipt.value.artifact,artifact);
});

test('large browser bodies and UI trees compact independently without discarding source and nested receipt metadata',async()=>{
  const large={executor:'playwright',observed_at:'2026-09-29T01:00:00.000Z',sources:[{url:'https://example.test/a',title:'Physical AI',text:'Source A evidence. '.repeat(2000)},{url:'https://example.test/b',title:'Source B',text:'Source B evidence. '.repeat(2000)}],
    data:{work_id:'work-1',run_id:'run-1',receipt:{artifact_id:'artifact-1',path:'/actual/output/report.json',sha256:'d'.repeat(64)},tree:{nodes:Array.from({length:2000},(_,i)=>({label:`Observed UI element ${i}`,role:'button'}))}}};
  const host=hooks({verifyCompletion:async()=>true,async executeTool(){return {...receipt,value:large};}}),result=await new BoundedWorkClientExecutor(model([choose(),done()])).execute(request,host);
  assert.equal(result.status,'succeeded');const value=result.checkpoint.observations[0].receipt.value;
  assert.equal(value.executor,'playwright');assert.equal(value.observed_at,large.observed_at);assert.deepEqual(value.sources.map(source=>[source.url,source.title]),large.sources.map(source=>[source.url,source.title]));
  assert.deepEqual(value.data.receipt,large.data.receipt);assert.equal(value.data.work_id,'work-1');assert.equal(value.data.run_id,'run-1');assert.ok(Buffer.byteLength(JSON.stringify(value))<=16000);
  assert.ok(value._office_compaction.changes.some(change=>/tree/u.test(change.path)));assert.ok(value._office_compaction.changes.some(change=>/sources\/\d\/text/u.test(change.path)));
});

test('an oversized immutable artifact metadata value is an explicit boundary instead of a lossy replacement',async()=>{
  let dispatched=0;const host=hooks({async executeTool(){dispatched++;return {...receipt,value:{artifact:{path:'/local/'.repeat(3000),sha256:'e'.repeat(64)},title:'Physical AI'}};}});
  const result=await new BoundedWorkClientExecutor(model([choose()])).execute(request,host);
  assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED');assert.equal(result.checkpoint.observations.length,0);assert.equal(dispatched,1);
});

test('a host Zod refine rejection is checkpointed as not dispatched then corrected in the next bounded model turn',async()=>{
  const schema=z.object({reference_ids:z.array(z.string()).default([]),selection:z.string().optional()}).strict().refine(value=>!value.selection||value.reference_ids.length===0,'Choose reference_ids or selection, not both');
  const tool={...readTool,name:'runtime_work_context'},provider=model([choose(tool.name,{reference_ids:['one'],selection:'Find the relevant reference'}),choose(tool.name,{selection:'Find the relevant reference'}),done()]);
  const host=hooks({tools:[tool],validateTool(_name,args){schema.parse(args);}}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(result.checkpoint.observations.length,2);
  const rejected=result.checkpoint.observations[0];assert.equal(rejected.invocation.dispatched,false);assert.equal(rejected.receipt.status,'retryable_failure');assert.equal(rejected.receipt.value.status,'not_dispatched');assert.equal(rejected.receipt.effect_state,'none');assert.deepEqual(rejected.receipt.evidence_ids,[]);
  assert.ok(rejected.receipt.value.issues[0].message.includes('not both'));assert.equal(provider.inputs[1].checkpoint.pending,null);assert.equal(provider.inputs[1].checkpoint.observations[0].receipt.value.correction_required,true);
});

test('invalid write arguments are rejected before dispatch without fabricating an uncertain effect',async()=>{
  const schema=z.object({text:z.string().min(1)}).strict(),provider=model([choose('send_message',{text:12}),choose('send_message',{text:'test'}),done()]);
  const host=hooks({tools:[writeTool],validateTool(_name,args){schema.parse(args);},async executeTool(name,args,context){host.executions.push({name,args,context});return {...receipt,effect_state:'verified',retry_safe:false};}});
  const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(host.executions[0].args.text,'test');assert.equal(result.checkpoint.observations[0].invocation.dispatched,false);
  assert.equal(result.checkpoint.observations[0].receipt.effect_state,'none');assert.equal(result.checkpoint.observations[1].receipt.effect_state,'verified');
});

test('repeating the same rejected input cannot become a blind dispatch or an unbounded correction loop',async()=>{
  const provider=model([choose('send_message',{text:12}),choose('send_message',{text:12}),choose('send_message',{text:'unused'})]),host=hooks({tools:[writeTool],validateTool(){throw new WorkClientToolInputError('UNKNOWN_TARGET','Choose a target that was observed.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_REPEATED_INVALID_TOOL_INPUT');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);
  assert.ok(result.checkpoint.observations.every(item=>item.invocation.dispatched===false&&item.receipt.value.status==='not_dispatched'));
});

test('malformed tool JSON and unavailable capabilities can be corrected before any host invocation',async()=>{
  const malformed={...choose(),arguments_json:'{url:broken}'},provider=model([malformed,choose('unavailable_capability',{}),choose(),done()]),host=hooks();
  const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(result.checkpoint.observations.length,3);assert.equal(result.checkpoint.observations[0].receipt.value.issues[0].code,'invalid_json');
  assert.equal(result.checkpoint.observations[1].receipt.value.issues[0].code,'WORK_CLIENT_TOOL_NOT_AVAILABLE');
});

test('scope and permission denials remain authority boundaries instead of tool-input correction',async()=>{
  for(const [reason,status] of [['WORK_TOOL_SCOPE_MISMATCH','failed'],['HUMAN_APPROVAL_REQUIRED','waiting_approval']]){
    const provider=model([choose('send_message',{text:'test'}),choose('send_message',{text:'should not run'})]),host=hooks({tools:[writeTool],validateTool(){throw Error(reason);}});
    const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
    assert.equal(result.status,status);assert.equal(result.reason,reason);assert.equal(provider.inputs.length,1);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,0);
  }
});

test('a validation-looking exception after write dispatch remains uncertain and never claims not_dispatched',async()=>{
  const host=hooks({tools:[writeTool],async executeTool(){z.string().parse(42);return receipt;}}),result=await new BoundedWorkClientExecutor(model([choose('send_message',{text:'test'})])).execute(request,host);
  assert.equal(result.status,'reconciliation_required');assert.equal(result.checkpoint.pending.dispatched,true);assert.equal(result.checkpoint.observations.length,0);
});

test('checkpoint identity, capability catalog and runtime guard prevent stale or unavailable execution',async()=>{
  const initial=await new BoundedWorkClientExecutor(model([choose()])).execute({...request,max_turns:1},hooks());
  await assert.rejects(new BoundedWorkClientExecutor(model([])).execute({...request,run_id:'other-run',checkpoint:initial.checkpoint},hooks()),/CHECKPOINT_MISMATCH/);
  const host=hooks(),result=await new BoundedWorkClientExecutor(model([choose('hidden_shell',{command:'rm -rf /'})])).execute(request,host);assert.equal(result.status,'failed');assert.equal(host.executions.length,0);
  const closed=hooks({async guard(){throw Error('WORK_PAUSED');}});assert.equal((await new BoundedWorkClientExecutor(model([])).execute(request,closed)).status,'paused');
});

test('configured subscription exhaustion transfers a tool judgment to Claude with saved model and same Work/run/stage',async t=>{
  const path=await fixture(t),events=[],cliCalls=[];saveModelSettings(path,{revision:0,onboarding_step:2,selection},{});
  let responses=0;
  const runner={async run(call){cliCalls.push(call);if(call.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};if(call.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),stderr:''};if(call.executable==='/fixture/codex')return {code:1,stdout:'',stderr:'Weekly usage limit reached'};if(call.executable==='/fixture/claude')return {code:0,stdout:JSON.stringify({is_error:false,structured_output:responses++?done():choose()}),stderr:''};throw Error('UNEXPECTED_CLIENT');}};
  const configured=new ConfiguredStructuredModel(path,{AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude'}, {subscription:options=>new SubscriptionAwareStructuredModel({...options,runner})},event=>events.push(event));
  const result=await new BoundedWorkClientExecutor(configured).execute(request,hooks());assert.equal(result.status,'succeeded');assert.equal(events.length,2);
  assert.ok(events.every(event=>event.work_id==='work-1'&&event.run_id==='run-1'&&/^turn-[01]$/u.test(event.stage_id)&&event.source==='codex'&&event.target==='claude'&&event.reason==='quota_exhausted'&&event.target_model==='saved-claude'));
  assert.equal(cliCalls.filter(call=>call.executable==='/fixture/claude'&&call.args.includes('-p')).length,2);assert.ok(cliCalls.filter(call=>call.executable==='/fixture/claude'&&call.args.includes('-p')).every(call=>call.args.includes('saved-claude')&&call.args.includes('--tools')&&call.args.includes('')));
});

test('Work-bound coding decisions retain coding model override and record only new calls from reused providers',async t=>{
  const path=await fixture(t);saveModelSettings(path,{revision:0,onboarding_step:2,selection},{});saveModelSettings(scopedModelSettingsPath(path,'coding'),{revision:0,onboarding_step:2,inherit_global:false,selection:{...selection,client_models:{...selection.client_models,codex:'coding-selected'}}},{});
  const seen=[],shared={calls:[],async call(purpose,_instructions,input){seen.push(input);this.calls.push({purpose,model:'coding-selected',provider:'codex',status:'accepted'});return {};}};
  let env;const configured=new ConfiguredStructuredModel(path,{}, {subscription:options=>{env=options.environment;return shared;}}).forWork({work_id:'actual-work',run_id:'actual-run'},'coding');
  await configured.call('correct','Judge.',{work_id:'spoofed',stage_id:'collect'},{});await configured.call('correct','Judge.',{stage_id:'report'},{});
  assert.equal(env.AGENT_DRIVER_CODEX_MODEL,'coding-selected');assert.deepEqual(seen.map(input=>[input.work_id,input.run_id,input.stage_id]),[['actual-work','actual-run','collect'],['actual-work','actual-run','report']]);assert.equal(configured.calls.length,2);
});

test('subscription exhaustion never consumes an ambient paid API key',async t=>{
  const path=await fixture(t);saveModelSettings(path,{revision:0,onboarding_step:2,selection},{});let paid=0;
  const configured=new ConfiguredStructuredModel(path,{OPENAI_API_KEY:'fixture-not-real-paid-key-12345'}, {api:()=>({calls:[],async call(){paid++;return done();}}),subscription:()=>({calls:[],async call(){throw Error('STRUCTURED_MODEL_UNAVAILABLE');}})});
  const result=await new BoundedWorkClientExecutor(configured).execute(request,hooks());assert.equal(result.status,'waiting_model');assert.equal(paid,0);
});
