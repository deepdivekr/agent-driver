import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {BoundedWorkClientExecutor,appendWorkObservation} from '../dist/work/client-executor.js';
import {createWorkRunTraceEvidence} from '../dist/work/completion.js';

// A3 regression: executor exits that ended a Work before completion. Fixture
// models stand in for real decisions; no real model or external effect runs.
const request={work_id:'path-work',run_id:'path-run',prompt:'Read the value and save it.',completion_checks:[{id:'read',result:'The value is read.',evidence:'A read receipt.'},{id:'saved',result:'The value is saved.',evidence:'A save receipt.'}],max_turns:10};
const tools=[{name:'read_value',description:'Read one value.',input_schema:{type:'object'},effect:'read_only'},{name:'save_value',description:'Save one value.',input_schema:{type:'object'},effect:'local_write'}];
const tool=(name,args={})=>({action:'tool',stage_id:null,tool_name:name,arguments_json:JSON.stringify(args),summary:`Use ${name}.`,completed_checks:[],wait_reason:null});
const complete=checks=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Done.',completed_checks:checks,wait_reason:null});
const wait={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Wait for configuration.',completed_checks:[],wait_reason:'configuration'};
function provider(queue){return {calls:[],inputs:[],async call(purpose,_instructions,input){this.inputs.push(structuredClone(input));this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return queue.shift();}};}
function host(overrides={}){
  const dispatches=[],claims=[];
  return {dispatches,claims,tools,async checkpoint(){},
    async executeTool(name,args,context){dispatches.push({name,args,request_id:context.request_id});return name==='read_value'?{status:'succeeded',value:{value:42},evidence_ids:['ev-read'],effect_state:'none',retry_safe:true}:{status:'succeeded',value:{saved:42},evidence_ids:['ev-save'],effect_state:'verified',retry_safe:false};},
    async verifyCompletion(_checks,_observations,claim){claims.push(structuredClone(claim));return true;},...overrides};
}

test('A3: a completion proposal with a missing check or a request ID instead of an evidence ID is normalized, not failed',async()=>{
  for(const variant of ['missing_check','request_id','unknown_id']){
    const hooks=host(),model=provider([tool('read_value'),tool('save_value'),null]);
    model.call=async function(purpose,_instructions,input){
      this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});
      if(this.calls.length<3)return [tool('read_value'),tool('save_value')][this.calls.length-1];
      const readId=input.checkpoint.observations[0].invocation.request_id;
      return complete(variant==='missing_check'?[{id:'read',evidence_ids:['ev-read']}]:variant==='request_id'?[{id:'read',evidence_ids:[readId]},{id:'saved',evidence_ids:['ev-save']}]:[{id:'read',evidence_ids:['invented']},{id:'saved',evidence_ids:['ev-save']}]);
    };
    const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
    assert.equal(result.status,'succeeded',variant);assert.equal(hooks.claims.length,1);
    const ids=Object.fromEntries(hooks.claims[0].completed_checks.map(check=>[check.id,check.evidence_ids]));
    assert.deepEqual(Object.keys(ids).sort(),['read','saved'],variant);
    assert.ok(Object.values(ids).flat().every(id=>['ev-read','ev-save'].includes(id)),variant);
    if(variant!=='missing_check')assert.deepEqual(ids.read,variant==='request_id'?['ev-read']:['ev-read','ev-save']);
  }
});

test('A3: completion proposed before any successful receipt is refused as a correctable note',async()=>{
  const hooks=host(),model=provider([complete([{id:'read',evidence_ids:['x']}]),wait]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'paused');assert.equal(hooks.claims.length,0);
  assert.equal(result.checkpoint.observations[0].receipt.value.error,'WORK_CLIENT_COMPLETION_EVIDENCE_MISSING');
});

test('A3: invalid decision output is corrected within a budget and then retried later, never failed',async()=>{
  const hooks=host(),model=provider(Array.from({length:12},()=>({action:'nonsense'})));
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_DECISION_OUTPUT_UNUSABLE');assert.equal(hooks.dispatches.length,0);
  const recovered=await new BoundedWorkClientExecutor(provider([{action:'nonsense'},tool('read_value'),tool('save_value'),complete([{id:'read',evidence_ids:['ev-read']},{id:'saved',evidence_ids:['ev-save']}])])).execute(request,host());
  assert.equal(recovered.status,'succeeded','One bad output is corrected and the Work continues.');
});

test('A3: the same invalid input twice sets that capability aside instead of failing the Work',async()=>{
  const hooks=host({async validateTool(name,args){if(name==='save_value'&&!args.value){const {WorkClientToolInputError}=await import('../dist/work/client-executor.js');throw new WorkClientToolInputError('VALUE_REQUIRED','Supply value.');}}});
  const model=provider([tool('read_value'),tool('save_value'),tool('save_value'),tool('save_value'),wait]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'paused');assert.deepEqual(hooks.dispatches.map(item=>item.name),['read_value']);
  assert.equal(model.inputs.at(-1).tools.some(item=>item.name==='save_value'),false,'The repeated capability is no longer offered.');
  assert.match(result.checkpoint.observations.at(-1).receipt.value.issues[0].message,/unavailable for the rest of this run attempt/u);
});

test('A3: a failed operation with no effect informs the next decision instead of ending the Work',async()=>{
  let reads=0;const hooks=host();const execute=hooks.executeTool;
  hooks.executeTool=async(name,args,context)=>name==='read_value'&&++reads===1?(hooks.dispatches.push({name}),{status:'failed',value:{error:'SOURCE_TIMEOUT'},evidence_ids:[],effect_state:'none',retry_safe:true}):execute(name,args,context);
  const model=provider([tool('read_value'),tool('read_value',{retry:true}),tool('save_value'),complete([{id:'read',evidence_ids:['ev-read']},{id:'saved',evidence_ids:['ev-save']}])]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.checkpoint.observations[0].receipt.status,'failed','The failure stays in the history.');
  const writeFailure=host();writeFailure.executeTool=async()=>({status:'failed',value:{error:'PARTIAL'},evidence_ids:[],effect_state:'verified',retry_safe:false});
  const stopped=await new BoundedWorkClientExecutor(provider([tool('save_value')])).execute(request,writeFailure);
  assert.equal(stopped.status,'failed','A failure that had an effect remains terminal.');
});

test('A3: reusing a host-bound successful receipt is recorded as a note and keeps the execution trace closable',async t=>{
  const hooks=host({toolRequestId:(name,_args,fallback)=>name==='read_value'?'stable-read':fallback});
  const stable={...tool('read_value'),stage_id:'collect'},model=provider([stable,stable,wait]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(hooks.dispatches.length,1);
  const [first,note]=result.checkpoint.observations;
  assert.equal(note.invocation.dispatched,false);assert.notEqual(note.invocation.request_id,first.invocation.request_id);assert.equal(note.receipt.value.error,'WORK_CLIENT_TOOL_RECEIPT_REUSED');
  assert.equal(result.checkpoint.turn,result.checkpoint.observations.length,'One observation per turn.');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run('p',request.work_id,request.run_id,'owner',Date.now()+60000,'running',0,JSON.stringify(result.checkpoint));
  const trace=createWorkRunTraceEvidence({hermesState:db,intakeWork:()=>({revision:0})},'p',{work_id:request.work_id,run_id:request.run_id,owner:'owner',checkpoint:result.checkpoint,observations:result.checkpoint.observations,admission_closed:true});
  assert.equal(trace.receipt.value.closure,'closed',trace.receipt.value.reason);
});

test('A3: observations beyond the 32-entry window keep a ledger so the lifetime trace stays closed and counted',async t=>{
  let checkpoint={format:1,work_id:request.work_id,run_id:request.run_id,binding:'a'.repeat(64),turn:0,pending:null,observations:[],summary:''};
  for(let turn=0;turn<40;turn++){
    const write=turn%10===9;
    checkpoint={...appendWorkObservation(checkpoint,{invocation:{request_id:`r-${turn}`,turn,stage_id:'s',tool_name:write?'save_value':'read_value',arguments:{turn},effect:write?'local_write':'read_only',dispatched:true},receipt:{status:'succeeded',value:{turn},evidence_ids:[`ev-${turn}`],effect_state:write?'verified':'none',retry_safe:!write},observed_at:'2026-10-01T00:00:00.000Z'}),turn:turn+1};
  }
  assert.equal(checkpoint.observations.length,32);assert.equal(checkpoint.evicted_observations.count,8);
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run('p',request.work_id,request.run_id,'owner',Date.now()+60000,'running',0,JSON.stringify(checkpoint));
  const trace=createWorkRunTraceEvidence({hermesState:db,intakeWork:()=>({revision:0})},'p',{work_id:request.work_id,run_id:request.run_id,owner:'owner',checkpoint,observations:checkpoint.observations,admission_closed:true});
  assert.equal(trace.receipt.value.closure,'closed',trace.receipt.value.reason);
  assert.deepEqual({total:trace.receipt.value.lifetime_dispatch_counts.total,read:trace.receipt.value.lifetime_dispatch_counts.read_only,write:trace.receipt.value.lifetime_dispatch_counts.local_write},{total:40,read:36,write:4});
  const tampered=structuredClone(checkpoint);tampered.evicted_observations.unsafe=1;
  db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(tampered));
  const unsafe=createWorkRunTraceEvidence({hermesState:db,intakeWork:()=>({revision:0})},'p',{work_id:request.work_id,run_id:request.run_id,owner:'owner',checkpoint:tampered,observations:tampered.observations,admission_closed:true});
  assert.equal(unsafe.receipt.value.closure,'unknown','An evicted uncertain effect still prevents a closed trace.');
});
