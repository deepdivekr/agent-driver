import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {z} from 'zod';
import {BoundedWorkClientExecutor,WorkClientToolInputError,workClientDecisionSchema,WORK_CLIENT_EXECUTION_INSTRUCTIONS,executorView,runBudget} from '../dist/work/client-executor.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {saveModelSettings,scopedModelSettingsPath} from '../dist/onboarding/model-settings.js';
import {workActivity} from '../dist/work/activity.js';

const request={work_id:'work-1',run_id:'run-1',prompt:'Find the current physical AI source and report its title.',completion_checks:[{id:'source',result:'Report one source title.',evidence:'A retrieved source.'}]};
const readTool={name:'browser_read',description:'Read a delegated public source.',input_schema:{type:'object',properties:{url:{type:'string'}},required:['url'],additionalProperties:false},effect:'read_only'};
const writeTool={name:'send_message',description:'Send one separately approved message.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},effect:'external_write'};
const choose=(name='browser_read',args={url:'https://example.test/news'})=>({action:'tool',stage_id:'collect',tool_name:name,arguments_json:JSON.stringify(args),summary:'Read the delegated source.',completed_checks:[],wait_reason:null});
const done=(ids=['source-1'])=>({action:'complete',stage_id:'report',tool_name:null,arguments_json:null,summary:'Observed source title: Physical AI.',completed_checks:[{id:'source',evidence_ids:ids}],wait_reason:null});
const receipt={status:'succeeded',value:{title:'Physical AI'},evidence_ids:['source-1'],effect_state:'none',retry_safe:true};
const waitConfiguration={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Wait for configuration.',completed_checks:[],wait_reason:'configuration'};
function model(queue){return {calls:[],inputs:[],async call(purpose,instructions,input){this.inputs.push(structuredClone(input));const next=queue.shift();if(next instanceof Error)throw next;this.calls.push({purpose,provider:'fixture',model:'fixture-decision',elapsed_ms:1,input_sha256:'a'.repeat(64),status:'accepted',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return next;}};}
function hooks(overrides={}){const saved=[],events=[],executions=[];return {saved,events,executions,tools:[readTool],async checkpoint(value){saved.push(structuredClone(value));},async progress(event){events.push(event);},async executeTool(name,args,context){executions.push({name,args,context});return receipt;},async verifyCompletion(_checks,observations){return observations.at(-1).receipt.value.title==='Physical AI';},...overrides};}
const selection={mode:'subscription',client:'codex',client_models:{codex:'saved-codex',claude:'saved-claude',opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'saved-api',api_base_url:'',reasoning:'low',jev:'off'};
async function fixture(t){const root=await mkdtemp(join(tmpdir(),'office-client-'));t.after(()=>rm(root,{recursive:true,force:true}));return join(root,'models.json');}

test('bounded client decisions execute real host callbacks and need observed evidence plus host verification',async()=>{
  const provider=model([choose(),done()]),originalCall=provider.call.bind(provider);provider.call=async(...args)=>{assert.match(args[1],/Propose complete once the requested result receipts and readbacks exist/u);assert.match(args[1],/The host then verifies independently and sets completion itself/u);return originalCall(...args);};
  const host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(host.executions.length,1);
  assert.deepEqual(provider.inputs[0].completion_gate,{phase:'pre_verification',complete_action:'proposal_for_independent_host_verification',final_flag:'set_by_host_after_verification',closed_trace:'generated_by_host_at_complete_cutpoint',evidence_role:'control_metadata_not_result_evidence',business_receipts:'required_before_complete_proposal'});
  assert.deepEqual(provider.inputs[1].completion_gate,provider.inputs[0].completion_gate);
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

test('output correction never turns unknown completion evidence into proof: an invented ID only points the verifier at observed receipts',async()=>{
  const provider=model([choose(),{...done(['invented']),tool_name:'browser_read'},done(['invented'])]),claims=[];const host=hooks({async verifyCompletion(_checks,_observations,claim){claims.push(claim);return false;}}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'awaiting_review');assert.equal(result.completion_verified,false);assert.equal(host.executions.length,1);assert.equal(provider.inputs.length,3);
  assert.equal(claims.length,1);assert.deepEqual(claims[0].completed_checks,[{id:'source',evidence_ids:['source-1']}],'The invented ID is never passed on as evidence.');
  const valid=model([done(['invented']),waitConfiguration]),empty=hooks(),unsupported=await new BoundedWorkClientExecutor(valid).execute(request,empty);
  assert.equal(unsupported.status,'paused');assert.equal(unsupported.completion_verified,false);assert.equal(empty.executions.length,0);
  assert.equal(unsupported.checkpoint.observations[0].receipt.value.error,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING','Completion without any receipt is refused before verification.');
});

test('invalid decision outputs never dispatch, a failed correction continues with a fresh decision, and the correction budget is bounded',async()=>{
  const bad={...choose(),wait_reason:'approval'},provider=model([bad,bad,choose(),done()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(provider.inputs.length,4);assert.equal(host.executions.length,1,'Only the valid decision dispatched.');assert.equal(result.checkpoint.observations.length,1);
  const endless=model(Array.from({length:12},()=>bad)),none=hooks(),exhausted=await new BoundedWorkClientExecutor(endless).execute(request,none);
  assert.equal(exhausted.status,'retryable_failure');assert.equal(exhausted.reason,'WORK_CLIENT_DECISION_OUTPUT_UNUSABLE');assert.equal(none.executions.length,0);assert.equal(exhausted.checkpoint.pending,null);assert.equal(exhausted.checkpoint.observations.length,0);
  assert.equal(endless.inputs.filter(input=>input.validation_error).length,3,'Three corrections per run attempt.');
});

test('decision correction records bounded safe schema paths and output digests without leaking model text or dispatching tools',async()=>{
  const secret='sk-proj-abcdefghijklmnopqrstu',bad={...choose(),wait_reason:'approval',[secret]:'private model text'};
  const provider=model([bad,bad,waitConfiguration]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'paused');assert.equal(host.executions.length,0);
  const events=host.events.filter(event=>event.validation),diagnostics=events.map(event=>event.validation);
  assert.deepEqual(diagnostics.map(item=>item.code),['WORK_CLIENT_DECISION_OUTPUT_INVALID','WORK_CLIENT_DECISION_CORRECTION_FAILED']);
  assert.deepEqual(events.map(event=>event.reason),diagnostics.map(item=>item.code));
  for(const item of diagnostics){assert.match(item.output_sha256,/^[a-f0-9]{64}$/u);assert.ok(item.issues.length>0&&item.issues.length<=8);assert.ok(item.issues.every(issue=>typeof issue.path==='string'&&typeof issue.code==='string'&&typeof issue.message==='string'));}
  assert.doesNotMatch(JSON.stringify(host.events),new RegExp(secret,'u'));
  assert.ok(host.events.some(event=>event.summary.includes('no tool dispatched from this decision')));
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('CREATE TABLE office_activity(project_id TEXT,work_id TEXT,kind TEXT,summary TEXT,created_at TEXT,metadata TEXT)');
    for(const event of events)workActivity({hermesState:db},'project-1','work-1',event.kind,event.summary,{run_id:'run-1',reason:event.reason,validation:event.validation});
    const rows=db.prepare('SELECT metadata FROM office_activity ORDER BY rowid').all().map(row=>JSON.parse(row.metadata));
    assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.validation.code),diagnostics.map(item=>item.code));
    assert.ok(rows.every(row=>row.run_id==='run-1'&&row.validation.issues.length>0));
    assert.doesNotMatch(JSON.stringify(rows),new RegExp(secret,'u'));
  }finally{db.close();}
});

test('auth quota and provider failures never invoke output correction, including failure during the only correction',async()=>{
  for(const reason of ['STRUCTURED_MODEL_UNAVAILABLE','STRUCTURED_MODEL_UNSUPPORTED','CLIENT_SUBSCRIPTION_EXHAUSTED']){
    const provider=model([Error(reason),choose()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);assert.equal(result.status,'waiting_model');if(reason==='STRUCTURED_MODEL_UNSUPPORTED')assert.equal(result.reason,reason);assert.equal(provider.inputs.length,1);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.observations.length,0);
  }
  const provider=model([{...choose(),wait_reason:'approval'},Error('STRUCTURED_MODEL_UNAVAILABLE'),choose()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute(request,host);assert.equal(result.status,'waiting_model');assert.equal(result.reason,'STRUCTURED_MODEL_UNAVAILABLE');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);
});

test('format correction does not reset the operation budget or admit another model call after pause',async()=>{
  const bad={...choose(),wait_reason:'approval'},provider=model([bad,choose(),done()]),host=hooks(),result=await new BoundedWorkClientExecutor(provider).execute({...request,max_turns:1},host);assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED');assert.equal(provider.inputs.length,2);assert.equal(host.executions.length,1);assert.equal(result.checkpoint.turn,1);
  let paused=false;const stopped=model([bad,choose()]),base=stopped.call.bind(stopped);stopped.call=async(...args)=>{const value=await base(...args);paused=true;return value;};const fenced=hooks({async guard(){if(paused)throw Error('WORK_PAUSED');}}),blocked=await new BoundedWorkClientExecutor(stopped).execute(request,fenced);assert.equal(blocked.status,'paused');assert.equal(stopped.inputs.length,1);assert.equal(fenced.executions.length,0);assert.equal(blocked.checkpoint.pending,null);assert.equal(blocked.checkpoint.observations.length,0);
});

test('a model cannot mark Work complete with invented receipt IDs or without using a host capability',async()=>{
  const host=hooks(),refused=await new BoundedWorkClientExecutor(model([done(),waitConfiguration])).execute(request,host);
  assert.equal(refused.status,'paused');assert.equal(refused.completion_verified,false);assert.equal(host.executions.length,0);assert.equal(refused.checkpoint.observations[0].receipt.value.error,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');
  const claims=[],other=hooks({async verifyCompletion(_checks,observations,claim){claims.push(claim);return observations.at(-1).receipt.value.title==='Physical AI';}}),result=await new BoundedWorkClientExecutor(model([choose(),done(['invented'])])).execute(request,other);
  assert.equal(result.status,'succeeded','Only the independent verifier, judging the observed receipt, completes the Work.');assert.deepEqual(claims[0].completed_checks[0].evidence_ids,['source-1']);
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
for(const code of ['PACK_LOCAL_RECORD_IDENTITY_NOT_UNIQUE','PACK_LOCAL_RECORD_READ_FIELD_MISSING'])test(`known local-record inspect error ${code} is saved as a failed read receipt, not a phantom interrupted operation`,async()=>{
  const inspectTool={...readTool,name:'runtime_pack_local_record_inspect'},provider=model([choose('runtime_pack_local_record_inspect',{target:'review',identity:70565781})]);
  const host=hooks({tools:[inspectTool],async executeTool(){throw Error(code);}});
  const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'retryable_failure');assert.equal(result.reason,code);
  assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,1);
  const observed=result.checkpoint.observations[0];assert.equal(observed.invocation.dispatched,true);assert.equal(observed.receipt.value.status,'read_failed');assert.equal(observed.receipt.value.error,code);assert.equal(observed.receipt.value.result_observation,'error_returned');assert.equal(observed.receipt.effect_state,'none');assert.deepEqual(observed.receipt.evidence_ids,[]);
  assert.equal(host.saved.at(-1).pending,null);
});
test('a saved read retry is preflighted without falsifying its prior dispatched history, then corrected with fresh evidence',async()=>{
  const initial=await interruptedRead(),provider=model([choose('browser_read',{url:'https://example.test/verified'}),done()]),host=hooks({validateTool(_name,args){if(args.url==='https://example.test/news')throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED','Correct the known failed source check before trying to read that output.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,1);assert.equal(host.executions[0].args.url,'https://example.test/verified');assert.equal(provider.inputs.length,2);
  const rejected=result.checkpoint.observations[0];assert.deepEqual(rejected.invocation,initial.checkpoint.pending);assert.equal(rejected.invocation.dispatched,true);assert.equal(rejected.receipt.value.status,'read_retry_rejected');assert.equal(rejected.receipt.value.prior_dispatched,true);assert.equal(rejected.receipt.value.correction_required,true);assert.equal(rejected.receipt.effect_state,'none');assert.deepEqual(rejected.receipt.evidence_ids,[]);assert.equal(result.checkpoint.pending,null);
  assert.ok(host.events.some(event=>event.kind==='tool.result'&&event.summary.includes('saved read not retried')));assert.equal(provider.inputs[0].checkpoint.observations[0].invocation.dispatched,true);
});
test('a rejected saved read cannot be retried blindly by the next model turn',async()=>{
  const initial=await interruptedRead(),provider=model([choose(),choose('browser_read',{url:'https://example.test/unused'}),waitConfiguration]),host=hooks({validateTool(){throw new WorkClientToolInputError('WORK_RESULT_QUALITY_NOT_VERIFIED','Use a newly verified result instead.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'paused');assert.equal(provider.inputs.length,3);assert.equal(host.executions.length,0);
  assert.equal(provider.inputs[1].tools.some(tool=>tool.name==='browser_read'),false,'The repeatedly rejected read is set aside instead of retried blindly.');
  assert.equal(result.checkpoint.observations[2].receipt.value.issues[0].code,'WORK_CLIENT_TOOL_NOT_AVAILABLE');assert.equal(result.checkpoint.observations[0].invocation.dispatched,true);assert.equal(result.checkpoint.observations[0].receipt.value.status,'read_retry_rejected');assert.equal(result.checkpoint.observations[1].invocation.dispatched,false);assert.equal(result.checkpoint.pending,null);
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

const oversizedMetadata={artifact:{path:'/local/'.repeat(3000),sha256:'e'.repeat(64)},title:'Physical AI'};
const oversizedReceipt=()=>({...receipt,value:structuredClone(oversizedMetadata)});
const metadataHash=()=>createHash('sha256').update(JSON.stringify(oversizedMetadata)).digest('hex');
const waitAfterMetadata={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The read result was too large to hand off; keep existing evidence and await a smaller read.',completed_checks:[],wait_reason:'configuration'};
function assertMetadataFailure(observed){
  assert.equal(observed.invocation.dispatched,true);assert.equal(observed.invocation.effect,'read_only');assert.equal(observed.receipt.status,'retryable_failure');assert.equal(observed.receipt.effect_state,'none');assert.equal(observed.receipt.retry_safe,false);assert.deepEqual(observed.receipt.evidence_ids,[]);
  assert.equal(observed.receipt.value.status,'normalization_failed');assert.equal(observed.receipt.value.error,'WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED');assert.equal(observed.receipt.value.receipt_received,true);assert.equal(observed.receipt.value.original_receipt_status,'succeeded');assert.equal(observed.receipt.value.raw_value_bytes,Buffer.byteLength(JSON.stringify(oversizedMetadata)));assert.equal(observed.receipt.value.raw_value_sha256,metadataHash());assert.equal(observed.receipt.value.correction_required,true);
  assert.ok(Buffer.byteLength(JSON.stringify(observed.receipt.value))<16000);assert.equal(observed.receipt.value.artifact,undefined);assert.equal(observed.receipt.value.title,undefined);assert.ok(!JSON.stringify(observed.receipt.value).includes('/local/'));
}

test('an oversized immutable read metadata value preserves a dispatched failed observation instead of losing history or issuing success evidence',async()=>{
  let dispatched=0;const host=hooks({async executeTool(){dispatched++;return oversizedReceipt();}}),provider=model([choose()]);
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,max_turns:1},host);
  assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED');assert.equal(result.completion_verified,false);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.checkpoint.turn,1);assert.equal(result.checkpoint.pending,null);assert.equal(dispatched,1);assertMetadataFailure(result.checkpoint.observations[0]);assert.deepEqual(host.saved.at(-1),result.checkpoint);assert.ok(host.events.some(event=>event.kind==='tool.result'&&event.status==='retryable_failure'&&event.reason==='WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED'));
});

test('metadata normalization failure remains failed evidence while the next bounded turn may choose a smaller fresh read',async()=>{
  const provider=model([choose(),choose('browser_read',{url:'https://example.test/smaller'}),done()]);let dispatched=0;
  const host=hooks({async executeTool(name,args,context){this.executions.push({name,args,context});return ++dispatched===1?oversizedReceipt():receipt;}}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(host.executions.length,2);assert.equal(result.checkpoint.observations.length,2);assertMetadataFailure(result.checkpoint.observations[0]);assert.deepEqual(result.checkpoint.observations[1].receipt,receipt);assert.deepEqual(provider.inputs[1].checkpoint.observations[0],result.checkpoint.observations[0]);assert.equal(provider.inputs[1].checkpoint.pending,null);
});

test('an already retryable no-effect read keeps its original status in the failed metadata observation without receiving evidence IDs',async()=>{
  const host=hooks({async executeTool(){return {...oversizedReceipt(),status:'retryable_failure',evidence_ids:[]};}}),result=await new BoundedWorkClientExecutor(model([choose()])).execute({...request,max_turns:1},host),observed=result.checkpoint.observations[0];
  assert.equal(result.completion_verified,false);assert.equal(result.checkpoint.pending,null);assert.equal(observed.invocation.dispatched,true);assert.equal(observed.receipt.status,'retryable_failure');assert.equal(observed.receipt.value.original_receipt_status,'retryable_failure');assert.equal(observed.receipt.value.raw_value_sha256,metadataHash());assert.equal(observed.receipt.effect_state,'none');assert.equal(observed.receipt.retry_safe,false);assert.deepEqual(observed.receipt.evidence_ids,[]);
});

test('a normalized metadata failure cannot support completion or trigger an automatic replay after checkpoint resume',async()=>{
  const first=hooks({async executeTool(){return oversizedReceipt();}}),initial=await new BoundedWorkClientExecutor(model([choose()])).execute({...request,max_turns:1},first);
  let verifications=0;const impossible=hooks({async verifyCompletion(){verifications++;return true;}}),rejected=await new BoundedWorkClientExecutor(model([done(),waitAfterMetadata])).execute({...request,checkpoint:initial.checkpoint,resume_wait:true},impossible);
  assert.equal(rejected.status,'paused');assert.equal(rejected.completion_verified,false);assert.equal(verifications,0);assert.equal(impossible.executions.length,0);
  assert.deepEqual(rejected.checkpoint.observations.slice(0,initial.checkpoint.observations.length),initial.checkpoint.observations);assert.equal(rejected.checkpoint.observations.at(-1).receipt.value.error,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');
  const provider=model([waitAfterMetadata]),passive=hooks(),waited=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint,resume_wait:true},passive);assert.equal(waited.status,'paused');assert.equal(passive.executions.length,0);assert.equal(provider.inputs[0].checkpoint.turn,1);assertMetadataFailure(provider.inputs[0].checkpoint.observations[0]);
});

for(const path of ['retry','reconcile'])test(`saved read ${path} metadata normalization failure is persisted before the next model turn without discarding the original dispatch`,async()=>{
  const initial=await interruptedRead(),provider=model([waitAfterMetadata]);let reconciliations=0;
  const host=hooks({...(path==='reconcile'?{async reconcileTool(invocation){reconciliations++;assert.deepEqual(invocation,initial.checkpoint.pending);return oversizedReceipt();}}:{}),async executeTool(name,args,context){this.executions.push({name,args,context});return oversizedReceipt();}}),result=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:initial.checkpoint},host);
  assert.equal(result.status,'paused');assert.equal(result.completion_verified,false);assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.turn,1);assert.equal(host.executions.length,path==='retry'?1:0);assert.equal(reconciliations,path==='reconcile'?1:0);assert.deepEqual(result.checkpoint.observations[0].invocation,initial.checkpoint.pending);assertMetadataFailure(result.checkpoint.observations[0]);assert.deepEqual(provider.inputs[0].checkpoint.observations,result.checkpoint.observations);assert.ok(host.saved.some(checkpoint=>checkpoint.pending===null&&checkpoint.observations.length===1));
});

test('metadata failure from a read returning during pause is saved before the pause guard and is not redispatched on explicit resume',async()=>{
  let paused=false;const host=hooks({async guard(){if(paused)throw Error('WORK_PAUSED');},async executeTool(){paused=true;return oversizedReceipt();}}),stopped=await new BoundedWorkClientExecutor(model([choose()])).execute(request,host);
  assert.equal(stopped.status,'paused');assert.equal(stopped.checkpoint.pending,null);assertMetadataFailure(stopped.checkpoint.observations[0]);assert.deepEqual(host.saved.at(-1),stopped.checkpoint);
  const after=hooks(),resumed=await new BoundedWorkClientExecutor(model([waitAfterMetadata])).execute({...request,checkpoint:stopped.checkpoint,resume_wait:true},after);assert.equal(resumed.status,'paused');assert.equal(after.executions.length,0);assert.deepEqual(resumed.checkpoint.observations,stopped.checkpoint.observations);
});

test('metadata fallback never clears a write dispatch or turns invalid schemas and unknown effects into a no-effect tombstone',async()=>{
  for(const kind of ['external_write','local_write']){const tool={...writeTool,effect:kind},host=hooks({tools:[tool],async executeTool(){return {...oversizedReceipt(),effect_state:'verified',retry_safe:false};}}),result=await new BoundedWorkClientExecutor(model([choose(tool.name,{text:'test'})])).execute(request,host);assert.equal(result.status,'reconciliation_required');assert.equal(result.reason,'WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED');assert.equal(result.checkpoint.pending.dispatched,true);assert.equal(result.checkpoint.observations.length,0);assert.equal(result.completion_verified,false);}
  for(const raw of [{...oversizedReceipt(),retry_safe:'invalid'},{...oversizedReceipt(),status:'reconciliation_required',effect_state:'uncertain'},{...oversizedReceipt(),effect_state:'verified'}]){const host=hooks({async executeTool(){return raw;}}),result=await new BoundedWorkClientExecutor(model([choose()])).execute(request,host);assert.equal(result.checkpoint.pending.dispatched,true);assert.equal(result.checkpoint.observations.length,0);assert.equal(result.completion_verified,false);}
});

test('oversized terminal authentication, approval and failed receipts retain their existing boundary instead of becoming correctable metadata observations',async()=>{
  for(const status of ['waiting_auth','waiting_approval','failed','reconciliation_required']){const host=hooks({async executeTool(){return {...oversizedReceipt(),status};}}),provider=model([choose()]),result=await new BoundedWorkClientExecutor(provider).execute(request,host);assert.equal(result.reason,'WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED');assert.equal(result.checkpoint.pending.dispatched,true);assert.equal(result.checkpoint.observations.length,0);assert.equal(result.completion_verified,false);assert.equal(provider.inputs.length,1);}
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
  const provider=model([choose('send_message',{text:12}),choose('send_message',{text:12}),choose('send_message',{text:'unused'}),waitConfiguration]),host=hooks({tools:[writeTool],validateTool(){throw new WorkClientToolInputError('UNKNOWN_TARGET','Choose a target that was observed.');}});
  const result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'paused');assert.equal(provider.inputs.length,4);assert.equal(host.executions.length,0);assert.equal(result.checkpoint.pending,null);
  assert.deepEqual(provider.inputs[2].tools,[],'The capability that rejected the same input twice is no longer offered.');
  assert.equal(result.checkpoint.observations[2].receipt.value.issues[0].code,'WORK_CLIENT_TOOL_NOT_AVAILABLE');
  assert.ok(result.checkpoint.observations.every(item=>item.invocation.dispatched===false&&item.receipt.value.status==='not_dispatched'));
});

test('an explicit resumed read may use identical arguments after the host capability is fixed, while an unchanged rejection stays bounded',async()=>{
  const blocked=hooks({validateTool(){throw new WorkClientToolInputError('BROWSER_NO_AVAILABLE_EXECUTOR','The registered read-only connection needs repair.');}});
  const first=await new BoundedWorkClientExecutor(model([choose()])).execute({...request,max_turns:1},blocked);
  assert.equal(first.checkpoint.pending,null);assert.equal(first.checkpoint.observations.length,1);assert.equal(first.checkpoint.observations[0].invocation.dispatched,false);assert.equal(blocked.executions.length,0);
  const unchanged=hooks({validateTool:blocked.validateTool}),stillModel=model([choose(),waitConfiguration]),stillBlocked=await new BoundedWorkClientExecutor(stillModel).execute({...request,checkpoint:first.checkpoint,resume_wait:true},unchanged);
  assert.equal(stillBlocked.status,'paused');assert.equal(unchanged.executions.length,0);assert.equal(stillModel.inputs[1].tools.length,0,'The unchanged rejection sets the read aside for this attempt.');
  let validations=0;const fixed=hooks({validateTool(){validations++;}}),provider=model([choose(),done()]);
  const resumed=await new BoundedWorkClientExecutor(provider).execute({...request,checkpoint:first.checkpoint,resume_wait:true,context:{user_directions:[{instruction:'The registered browser connection was corrected. Retry the same read-only source.'}]}},fixed);
  assert.equal(resumed.status,'succeeded');assert.equal(validations,1);assert.equal(fixed.executions.length,1);assert.deepEqual(fixed.executions[0].args,first.checkpoint.observations[0].invocation.arguments);assert.deepEqual(resumed.checkpoint.observations[0],first.checkpoint.observations[0]);assert.equal(resumed.checkpoint.observations[1].receipt.status,'succeeded');assert.equal(resumed.checkpoint.observations[1].invocation.dispatched,true);
  assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/one newly validated read-only attempt/u);assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/host validation still decides/u);assert.doesNotMatch(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/never repeat the exact rejected input/u);
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
  const host=hooks(),result=await new BoundedWorkClientExecutor(model([choose('hidden_shell',{command:'rm -rf /'}),waitConfiguration])).execute(request,host);assert.equal(result.status,'paused');assert.equal(host.executions.length,0);assert.equal(result.checkpoint.observations[0].receipt.value.issues[0].code,'WORK_CLIENT_TOOL_NOT_AVAILABLE');
  const closed=hooks({async guard(){throw Error('WORK_PAUSED');}});assert.equal((await new BoundedWorkClientExecutor(model([])).execute(request,closed)).status,'paused');
});

test('configured subscription exhaustion stops the run for the model and never asks Claude',async t=>{
  const path=await fixture(t),cliCalls=[];saveModelSettings(path,{revision:0,onboarding_step:2,selection},{});
  let responses=0;
  const runner={async run(call){cliCalls.push(call);if(call.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};if(call.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),stderr:''};if(call.executable==='/fixture/codex')return {code:1,stdout:'',stderr:'Weekly usage limit reached'};if(call.executable==='/fixture/claude')return {code:0,stdout:JSON.stringify({is_error:false,structured_output:responses++?done():choose()}),stderr:''};throw Error('UNEXPECTED_CLIENT');}};
  const configured=new ConfiguredStructuredModel(path,{AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude'}, {subscription:options=>new SubscriptionAwareStructuredModel({...options,runner})});
  const result=await new BoundedWorkClientExecutor(configured).execute(request,hooks());assert.equal(result.status,'waiting_model',JSON.stringify(result));
  assert.equal(cliCalls.some(call=>call.executable==='/fixture/claude'&&call.args.includes('-p')),false);
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

// Plan B4, replay. Live: guidance alone did not shorten a repeated request (6 model turns both times). The read
// steps of a verified procedure are proposed by the host in place of model turns; everything after is the normal loop.
test('B4: verified read steps are replayed without a model turn; writes, unknown tools and already observed reads are not',async()=>{
  const replay=[{tool:'browser_read',arguments:{url:'https://example.test/news'}},{tool:'send_message',arguments:{text:'hi'}},{tool:'gone_tool',arguments:{}},{tool:'browser_read',arguments:{url:'https://example.test/news'}}];
  const provider=model([done()]),host=hooks({tools:[readTool,writeTool],replay}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);
  assert.deepEqual(host.executions.map(item=>[item.name,item.args]),[['browser_read',{url:'https://example.test/news'}]],'One read is dispatched through the normal tool path; the write and the duplicate are never proposed.');
  assert.equal(provider.calls.length,1,'The model is asked only for the decision after the replayed read.');
  assert.deepEqual(host.events.filter(event=>['procedure.replayed','model.started'].includes(event.kind)).map(event=>event.kind),['procedure.replayed','model.started']);
  const plain=model([choose(),done()]);await new BoundedWorkClientExecutor(plain).execute(request,hooks());assert.equal(plain.calls.length,2,'Without a procedure the same Work takes two model turns.');
  // A replayed read that fails is an ordinary failed observation; the model continues from it.
  const failing=model([choose('browser_read',{url:'https://example.test/other'}),done()]);let n=0;
  const recovered=await new BoundedWorkClientExecutor(failing).execute(request,hooks({replay:[replay[0]],async executeTool(){return n++===0?{status:'retryable_failure',value:{error:'TIMEOUT'},evidence_ids:[],effect_state:'none',retry_safe:true}:receipt;}}));
  assert.equal(recovered.status,'succeeded');assert.equal(failing.calls.length,2);
});

// Recorded runs: a saved result was read back next almost every time. The host does it without a model turn.
test('B4: a saved result is read back by the host without a model turn; a failed readback goes to the model',async()=>{
  const draftTool={name:'office_result_draft',description:'Save a result.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},effect:'local_write'};
  const readTool2={name:'office_result_read',description:'Read a saved result.',input_schema:{type:'object',properties:{request_id:{type:'string'}},required:['request_id'],additionalProperties:false},effect:'read_only'};
  const save={action:'tool',stage_id:'report',tool_name:'office_result_draft',arguments_json:JSON.stringify({text:'Physical AI'}),summary:'Save the result.',completed_checks:[],wait_reason:null};
  const run=async readStatus=>{
    const provider=model([choose(),save,done(),done()]),executed=[];
    const host=hooks({tools:[readTool,draftTool,readTool2],async executeTool(name,args,context){executed.push([name,args]);
      if(name==='office_result_read')return {status:readStatus,value:{title:'Physical AI'},evidence_ids:readStatus==='succeeded'?['readback-1']:[],effect_state:'none',retry_safe:true};
      return name==='office_result_draft'?{status:'succeeded',value:{title:'Physical AI'},evidence_ids:['draft-1'],effect_state:'verified',retry_safe:false}:receipt;}});
    const result=await new BoundedWorkClientExecutor(provider).execute(request,host);return {result,provider,executed,host};
  };
  const ok=await run('succeeded');
  assert.equal(ok.result.status,'succeeded');assert.deepEqual(ok.executed.map(item=>item[0]),['browser_read','office_result_draft','office_result_read']);
  assert.equal(ok.executed[2][1].request_id,ok.result.checkpoint.observations.find(item=>item.invocation.tool_name==='office_result_draft').invocation.request_id,'The readback names the draft it follows.');
  assert.equal(ok.provider.calls.length,3,'Read, save, complete: the readback took no model turn.');
  const failed=await run('retryable_failure');
  assert.equal(failed.executed.filter(item=>item[0]==='office_result_read').length,1,'A failed readback is not repeated by the host.');
});

// Live: after thirty page reads every executor turn carried all thirty pages again and took two minutes.
test('the executor sees recent receipts in full and only the opening of long text in older ones; the checkpoint keeps everything',()=>{
  const observation=i=>({invocation:{request_id:`r-${i}`,turn:i,stage_id:'s',tool_name:'browser_read',arguments:{url:`https://example.test/${i}`},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{title:`Page ${i}`,text:'x'.repeat(12000),links:[{url:'https://example.test/a',text:'a'}]},evidence_ids:[`e-${i}`],effect_state:'none',retry_safe:true},observed_at:'2026-10-01T00:00:00.000Z'});
  const checkpoint={format:1,work_id:'w',run_id:'r',binding:'b',turn:10,pending:null,observations:Array.from({length:20},(_,i)=>observation(i)),summary:''},view=executorView(checkpoint);
  assert.equal(checkpoint.observations[0].receipt.value.text.length,12000,'The saved checkpoint is untouched.');
  assert.ok(view.observations[0].receipt.value.text.length<2600);assert.match(view.observations[0].receipt.value.text,/9600 more characters were read/u);assert.equal(view.observations[0].receipt.value.title,'Page 0');
  assert.deepEqual(view.observations[0].receipt.evidence_ids,['e-0']);assert.equal(view.observations.at(-1).receipt.value.text.length,12000,'The latest receipts are complete.');
  assert.ok(JSON.stringify(view).length<JSON.stringify(checkpoint).length/2);
  assert.equal(executorView({...checkpoint,observations:checkpoint.observations.slice(0,3)}).observations[0].receipt.value.text.length,12000);
});

// Live: one page per model turn made a ten-article task take ten turns, each carrying everything read so far.
test('one decision can ask for several reads; the host runs them all before the next model turn, and only reads',async()=>{
  const many={...choose('browser_read',{url:'https://example.test/1'}),also_read:[{tool_name:'browser_read',arguments_json:JSON.stringify({url:'https://example.test/2'})},{tool_name:'send_message',arguments_json:JSON.stringify({text:'hi'})},{tool_name:'browser_read',arguments_json:'not json'},{tool_name:'browser_read',arguments_json:JSON.stringify({url:'https://example.test/3'})}]};
  const provider=model([many,done()]),host=hooks({tools:[readTool,writeTool]}),result=await new BoundedWorkClientExecutor(provider).execute(request,host);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(host.executions.map(item=>[item.name,item.args.url]),[['browser_read','https://example.test/1'],['browser_read','https://example.test/2'],['browser_read','https://example.test/3']],'Three reads, in order; the write and the unparsable entry are not run.');
  assert.equal(provider.calls.length,2,'Three reads cost one model turn.');
  assert.equal(result.checkpoint.observations.filter(item=>item.invocation.dispatched).length,3);
});

// Live: a wide news task made ninety reads in twenty minutes and never saved a result.
test('a run that has read much or long is told to save what is established; a run that already saved is not',()=>{
  const observation=(i,tool='browser_read',effect='read_only')=>({invocation:{request_id:`r-${i}`,turn:i,stage_id:'s',tool_name:tool,arguments:{},effect,dispatched:true},receipt:{status:'succeeded',value:{},evidence_ids:[`e-${i}`],effect_state:'none',retry_safe:true},observed_at:'2026-10-01T00:00:00.000Z'});
  const checkpoint=n=>({format:1,work_id:'w',run_id:'r',binding:'b',turn:n,pending:null,observations:Array.from({length:n},(_,i)=>observation(i)),summary:''}),at=Date.parse('2026-10-01T00:01:00.000Z');
  const early=runBudget(checkpoint(5),at).run_budget;assert.equal(early.wrap_up,false);assert.equal(early.reads_left,19);assert.match(early.instruction,/in the order the request ranks them/u);
  assert.equal(runBudget(checkpoint(0),at).run_budget.reads_left,24,'The budget is known from the first turn.');
  assert.equal(runBudget(checkpoint(20),at).run_budget.wrap_up,true);assert.equal(runBudget(checkpoint(20),at).run_budget.reads_done,20);
  assert.equal(runBudget(checkpoint(5),Date.parse('2026-10-01T00:08:00.000Z')).run_budget.elapsed_seconds,480);
  const saved=checkpoint(30);saved.observations.push(observation(30,'office_result_draft','local_write'));assert.deepEqual(runBudget(saved,at),{},'Once a result is saved the run is finishing, not exploring.');
});

// The checkpoint keeps 32 receipts and verification can only judge what is kept: a run stops reading at 30 until it saves.
test('a run without a saved result is refused a read past the limit and continues after it saves',async()=>{
  const draftTool={name:'office_result_draft',description:'Save a result.',input_schema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},effect:'local_write'};
  const queue=[...Array.from({length:25},(_,i)=>choose('browser_read',{url:`https://example.test/${i}`})),{action:'tool',stage_id:'report',tool_name:'office_result_draft',arguments_json:JSON.stringify({text:'Physical AI'}),summary:'Save.',completed_checks:[],wait_reason:null},done(['draft-1'])];
  const provider=model(queue),executed=[],host=hooks({tools:[readTool,draftTool],async executeTool(name,args){executed.push(name+(args.url?args.url.slice(-3):''));return name==='office_result_draft'?{status:'succeeded',value:{title:'Physical AI'},evidence_ids:['draft-1'],effect_state:'verified',retry_safe:false}:{...receipt,evidence_ids:[`source-${executed.length}`]};},async verifyCompletion(){return true;}});
  const result=await new BoundedWorkClientExecutor(provider).execute({...request,max_turns:40},host);
  assert.equal(result.status,'succeeded');assert.equal(executed.filter(name=>name.startsWith('browser_read')).length,24,'The 25th read is not dispatched.');
  const refused=result.checkpoint.observations.find(item=>!item.invocation.dispatched&&JSON.stringify(item.receipt.value).includes('WORK_CLIENT_READ_BUDGET_REACHED'));assert.ok(refused,'The refusal is an observation the model can act on.');
  assert.equal(executed.at(-1),'office_result_draft');
});
