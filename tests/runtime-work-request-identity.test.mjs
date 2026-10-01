import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const request={work_id:'identity-work',run_id:'identity-run',prompt:'Read the registered source.',completion_checks:[{id:'source',result:'Observe the source.',evidence:'A source receipt.'}]};
const args={source_id:'registered-source'};
const choose={action:'tool',stage_id:'collect',tool_name:'read_source',arguments_json:JSON.stringify(args),summary:'Read the source.',completed_checks:[],wait_reason:null};
const complete={action:'complete',stage_id:'done',tool_name:null,arguments_json:null,summary:'The source was observed.',completed_checks:[{id:'source',evidence_ids:['source']}],wait_reason:null};
const receipt={status:'succeeded',value:{title:'Observed source'},evidence_ids:['source'],effect_state:'none',retry_safe:true};
function model(queue){return {calls:[],async call(){this.calls.push({purpose:'correct',model:'fixture',status:'accepted'});return queue.shift();}};}
function host(overrides={}){
  const events=[],saved=[];
  return {events,saved,tools:[{name:'read_source',description:'Read one registered source.',input_schema:{type:'object'},effect:'read_only'}],
    async validateTool(_name,_args,context){events.push({kind:'validate',request_id:context.request_id});},
    async checkpoint(value){saved.push(structuredClone(value));if(value.pending)events.push({kind:value.pending.dispatched?'saved_dispatched':'saved_prepared',request_id:value.pending.request_id});},
    async executeTool(_name,_args,context){events.push({kind:'execute',request_id:context.request_id});return receipt;},
    async verifyCompletion(){return true;},...overrides};
}

test('host request identity is resolved once before validation, pending checkpoint and actual execution',async()=>{
  const hooks=host(),resolved=[];
  hooks.toolRequestId=(name,argumentsValue,fallback)=>{resolved.push({name,args:argumentsValue,fallback});argumentsValue.source_id='cannot-mutate-invocation';return 'custom-cycle-stable-id';};
  const result=await new BoundedWorkClientExecutor(model([choose,complete])).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(resolved.length,1);assert.equal(resolved[0].name,'read_source');
  assert.match(resolved[0].fallback,/^work-tool-[a-f0-9]{48}$/u);
  assert.deepEqual(hooks.events.map(event=>event.kind),['validate','saved_prepared','saved_dispatched','execute']);
  assert.ok(hooks.events.every(event=>event.request_id==='custom-cycle-stable-id'));
  assert.deepEqual(result.checkpoint.observations[0].invocation.arguments,args);
});

test('unconfigured request identity preserves the existing run/turn/tool/arguments hash',async()=>{
  const hooks=host(),result=await new BoundedWorkClientExecutor(model([choose,complete])).execute(request,hooks);
  const expected=`work-tool-${hashJson({run_id:request.run_id,turn:0,tool:choose.tool_name,args}).slice(0,48)}`;
  assert.equal(result.status,'succeeded');assert.equal(result.checkpoint.observations[0].invocation.request_id,expected);
  assert.ok(hooks.events.every(event=>event.request_id===expected));
});

test('repeated host-bound write keeps its original verified receipt and invokes the effect once',async()=>{
  const writeReceipt={...receipt,effect_state:'verified',retry_safe:false},hooks=host({tools:[{name:'read_source',description:'Fixture local output.',input_schema:{type:'object'},effect:'local_write'}],toolRequestId:()=> 'custom-cycle-stable-id'});
  hooks.executeTool=async(_name,_args,context)=>{hooks.events.push({kind:'execute',request_id:context.request_id});return writeReceipt;};
  const result=await new BoundedWorkClientExecutor(model([choose,choose,complete])).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);
  assert.equal(hooks.events.filter(event=>event.kind==='execute').length,1);assert.equal(hooks.events.filter(event=>event.kind==='validate').length,2);
  assert.equal(result.checkpoint.turn,2);assert.equal(result.checkpoint.observations.length,1);
  assert.deepEqual(result.checkpoint.observations[0].receipt,writeReceipt);
  assert.equal(result.checkpoint.observations[0].invocation.turn,0);
});

test('a stable identity cannot authorize different arguments or replay a failed observed operation',async()=>{
  const different=host({toolRequestId:()=> 'custom-cycle-stable-id'}),changed={...choose,arguments_json:JSON.stringify({source_id:'another-source'})};
  const conflict=await new BoundedWorkClientExecutor(model([choose,changed])).execute(request,different);
  assert.equal(conflict.status,'failed');assert.equal(conflict.reason,'WORK_CLIENT_TOOL_REQUEST_ID_CONFLICT');assert.equal(different.events.filter(event=>event.kind==='execute').length,1);
  for(const effectState of ['none','verified']){
    const hooks=host({toolRequestId:()=> 'custom-cycle-stable-id'});
    hooks.executeTool=async(_name,_args,context)=>{hooks.events.push({kind:'execute',request_id:context.request_id});return {status:'retryable_failure',value:{error:'READ_INCOMPLETE'},evidence_ids:[],effect_state:effectState,retry_safe:false};};
    const result=await new BoundedWorkClientExecutor(model([choose,choose])).execute(request,hooks);
    assert.equal(result.status,effectState==='none'?'awaiting_review':'reconciliation_required');assert.equal(result.reason,'WORK_CLIENT_TOOL_REQUEST_ID_NOT_REUSABLE');
    assert.equal(hooks.events.filter(event=>event.kind==='execute').length,1);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.completion_verified,false);
  }
});

test('invalid host request identities fail before preflight, saved pending or dispatch',async()=>{
  for(const invalid of ['', 'x'.repeat(81), 'unscoped/id', null]){
    const hooks=host({toolRequestId:()=>invalid}),result=await new BoundedWorkClientExecutor(model([choose])).execute(request,hooks);
    assert.equal(result.status,'failed');assert.equal(result.reason,'WORK_CLIENT_TOOL_REQUEST_ID_INVALID');
    assert.deepEqual(hooks.events,[]);assert.deepEqual(hooks.saved,[]);assert.equal(result.checkpoint.pending,null);
  }
});

test('completion repair cannot invoke a read under a previously dispatched stable identity',async()=>{
  const hooks=host({toolRequestId:()=> 'reused-read-id',async verifyCompletion(){return {verified:false,repair:{code:'WORK_COMPLETION_CHECK_NOT_SUPPORTED',check_id:'source',verdict:'unknown'}};}});
  const result=await new BoundedWorkClientExecutor(model([choose,complete,choose])).execute({...request,max_turns:6},hooks);
  assert.equal(result.status,'awaiting_review');assert.equal(result.reason,'WORK_CLIENT_COMPLETION_REPAIR_REPLAY_FORBIDDEN');
  assert.equal(result.completion_verified,false);assert.equal(hooks.events.filter(event=>event.kind==='execute').length,1);
  assert.equal(result.checkpoint.observations.length,1);
});

test('saved pending recovery reconciles the original stable identity without resolving or dispatching a new one',async()=>{
  const initialHost=host({toolRequestId:()=> 'custom-cycle-stable-id',async executeTool(){throw Error('CLIENT_TIMEOUT');}});
  const first=await new BoundedWorkClientExecutor(model([choose])).execute(request,initialHost);
  assert.equal(first.status,'waiting_model');assert.equal(first.checkpoint.pending.request_id,'custom-cycle-stable-id');assert.equal(first.checkpoint.pending.dispatched,true);
  const reconciled=[],hooks=host({toolRequestId:()=>assert.fail('Recovery must retain the saved identity.'),async reconcileTool(invocation){reconciled.push(invocation.request_id);return receipt;}});
  const result=await new BoundedWorkClientExecutor(model([complete])).execute({...request,checkpoint:first.checkpoint},hooks);
  assert.equal(result.status,'succeeded');assert.deepEqual(reconciled,['custom-cycle-stable-id']);
  assert.deepEqual(hooks.events,[]);assert.equal(result.checkpoint.observations[0].invocation.request_id,'custom-cycle-stable-id');
});
