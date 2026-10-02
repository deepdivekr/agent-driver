import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {BoundedWorkClientExecutor,WorkClientToolInputError,WORK_CLIENT_EXECUTION_INSTRUCTIONS} from '../dist/work/client-executor.js';
import {WorkSupervisor,initWorkSupervisor,supervisorStatus,reconcileUnstartedPackExecution} from '../dist/work/supervisor.js';
import {workActivity} from '../dist/work/activity.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const proposal={title:'Pack refusal recovery',desired_outcome:'Read a delegated source without replaying an uncertain operation.',completion_checks:[{id:'source',result:'Observed source',evidence:'Actual read receipt'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'Read the delegated source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
const readTool={name:'fixture_read',description:'Read a fixture source.',effect:'read_only',input_schema:{type:'object',properties:{},additionalProperties:false}};
const packTool={name:'runtime_pack_run',description:'Execute a Pack.',effect:'local_write',input_schema:{type:'object',properties:{recipe:{type:'object'}},required:['recipe'],additionalProperties:false}};
const choose=(name,args={})=>({action:'tool',stage_id:name==='runtime_pack_run'?'pack-stage':'source-stage',tool_name:name,arguments_json:JSON.stringify(args),summary:'Read the delegated source.',completed_checks:[],wait_reason:null});
const wait=()=>({action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'Keep the prior refusal and wait for the missing connection.',completed_checks:[],wait_reason:'configuration'});
const sourceReceipt={status:'succeeded',effect_state:'none',value:{title:'Observed fixture source'},evidence_ids:['observed-source'],retry_safe:true};
const request=x=>({work_id:x.work.work_id,run_id:x.run,prompt:'Read the delegated source.',completion_checks:proposal.completion_checks});
const saved=x=>JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(x.run).checkpoint);
const totalChanges=x=>x.store.hermesState.prepare('SELECT total_changes() AS n').get().n;
const status=x=>supervisorStatus(x.store,x.config.project.id,x.work.work_id,x.config);
const input=x=>({work_id:x.work.work_id,revision:x.work.revision});
function model(queue){return {calls:[],inputs:[],async call(purpose,_instructions,value){this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});this.inputs.push(structuredClone(value));assert.ok(queue.length,'No extra model turn is authorized');return queue.shift();}};}

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'work-pack-refusal-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'pack-refusal-fixture',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkSupervisor(store);
  const definition=model([proposal]),work=await new WorkRuntime(store,config,definition).start({request_id:'pack-refusal-work',prompt:'Read the delegated source.'}),run=randomUUID(),cleanup=[];
  t.after(async()=>{for(const operation of cleanup.reverse())await operation();store.close();await rm(root,{recursive:true,force:true});});
  return {root,path,config,store,work,run,cleanup};
}

// Actual FamilyRuntime with an absent Pack connection reproduces the old host
// path; the missing preflight is intentional historical fixture evidence.
async function historicalRefusal(t){
  const x=await setup(t),family=new FamilyRuntime(x.store,x.config),provider=model([choose('fixture_read'),choose('runtime_pack_run',{recipe})]),at=new Date().toISOString();
  x.cleanup.push(()=>family.drain());let packDispatches=0,packBeginnings=0;
  const originalBegin=x.store.beginPack.bind(x.store);x.store.beginPack=(...args)=>{packBeginnings++;return originalBegin(...args);};
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(x.run,x.config.project.id,x.work.work_id,x.work.revision,'running',x.config.fingerprint,0,at,at);
  const result=await new BoundedWorkClientExecutor(provider).execute(request(x),{
    tools:[readTool,packTool],
    checkpoint:cp=>x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(cp),x.run),
    progress:event=>workActivity(x.store,x.config.project.id,x.work.work_id,event.kind,event.summary,{stage_id:event.stage_id,...(event.tool_name?{tool_name:event.tool_name}:{}),...(event.kind==='tool.started'?{status:'running'}:event.kind==='tool.result'?{status:event.status??'unknown'}:{})}),
    async executeTool(name,args,context){if(name==='fixture_read')return sourceReceipt;packDispatches++;await family.call(name,{...args,request_id:context.request_id,work_id:x.work.work_id});assert.fail('The absent Pack connection must reject before a receipt');},
  });
  assert.equal(result.status,'reconciliation_required');assert.equal(result.reason,'PACKS_NOT_CONNECTED');assert.equal(packDispatches,1);assert.equal(packBeginnings,0);
  const summary={summary:result.summary,text:result.summary,completion_verified:false,checks:proposal.completion_checks,model_calls:result.model_calls.length,observations:result.checkpoint.observations.length};
  x.store.hermesState.prepare('UPDATE office_supervisor SET state=?,reason=?,result=?,owner=NULL,lease_until_ms=0 WHERE run_id=?').run(result.status,result.reason,JSON.stringify(summary),x.run);
  workActivity(x.store,x.config.project.id,x.work.work_id,'supervisor.result',result.summary,{stage_id:'execution',status:result.status,reason:result.reason});
  return {...x,result,provider,summary,checkpoint:structuredClone(result.checkpoint)};
}

test('runtime fixture absent Packs reject before beginPack and pure status proves only the historical pre-execution refusal',async t=>{
  const x=await historicalRefusal(t),before=totalChanges(x),checkpoint=saved(x);
  assert.equal(supervisorStatus(x.store,x.config.project.id,x.work.work_id).can_resume,false,'No configuration means no reconciliation proof');
  for(let i=0;i<3;i++){const current=status(x);assert.equal(current.can_resume,true);assert.equal(current.state,'reconciliation_required');assert.equal(current.steps.at(-1).effect_state,'unobserved');}
  assert.equal(totalChanges(x),before,'A status lookup must never reconcile or write to SQLite');assert.deepEqual(saved(x),checkpoint);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);
});

test('runtime fixture explicit no-dispatch reconciliation preserves every observation and pauses durably before official resume',async t=>{
  const x=await historicalRefusal(t),beforeCalls=x.provider.calls.length,reconciled=reconcileUnstartedPackExecution(x.store,x.config,input(x)),cp=saved(x);
  assert.equal(reconciled.reconciled,true);assert.equal(reconciled.execution_started,false);assert.equal(reconciled.original_invocation_replayed,false);assert.equal(reconciled.state,'paused');assert.equal(reconciled.run_id,x.run);assert.equal(reconciled.revision,x.work.revision+1);assert.equal(reconciled.can_resume,true);assert.equal(x.provider.calls.length,beforeCalls);
  assert.deepEqual(reconciled.result,x.summary,'An old failure is not relabeled successful');assert.equal(cp.pending,null);assert.equal(cp.turn,x.checkpoint.turn+1);assert.deepEqual(cp.observations[0],x.checkpoint.observations[0]);
  const refusal=cp.observations.at(-1);assert.deepEqual(refusal.invocation,x.checkpoint.pending);assert.equal(refusal.invocation.dispatched,true);assert.equal(refusal.receipt.status,'retryable_failure');assert.equal(refusal.receipt.effect_state,'none');assert.equal(refusal.receipt.retry_safe,false);assert.deepEqual(refusal.receipt.evidence_ids,[]);assert.equal(refusal.receipt.value.retry_not_attempted,true);assert.equal(refusal.receipt.value.proof.checkpoint_sha256,hashJson(x.checkpoint));assert.equal(refusal.receipt.value.proof.config_sha256,x.config.fingerprint);
  const reopened=new PackStore(x.config.dbPath);try{assert.equal(supervisorStatus(reopened,x.config.project.id,x.work.work_id,x.config).state,'paused');assert.deepEqual(JSON.parse(reopened.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(x.run).checkpoint),cp);}finally{reopened.close();}
  assert.throws(()=>reconcileUnstartedPackExecution(x.store,x.config,{...input(x),revision:reconciled.revision}),/WORK_RECONCILIATION_REQUIRED/u);
  const next=model([wait()]),supervisor=new WorkSupervisor(x.store,x.config,next,{auto_start:false,tick_ms:10});x.cleanup.push(()=>supervisor.close());
  const resumed=supervisor.action({...input(x),revision:reconciled.revision,action:'resume'});assert.equal(resumed.run_id,x.run);supervisor.activate();
  for(let i=0;i<100&&status(x).state!=='paused';i++)await delay(20);
  assert.equal(status(x).state,'paused');assert.equal(next.inputs.length,1);assert.deepEqual(next.inputs[0].checkpoint.observations,cp.observations);assert.equal(next.inputs[0].checkpoint.pending,null);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(x.work.work_id).n,1);
});

test('runtime fixture explicit existing retry action uses the same narrow proof and never replays the refused Pack call',async t=>{
  const x=await historicalRefusal(t),next=model([wait()]),supervisor=new WorkSupervisor(x.store,x.config,next,{auto_start:false});x.cleanup.push(()=>supervisor.close());
  const resumed=supervisor.action({...input(x),action:'retry'});assert.equal(resumed.state,'queued');assert.equal(next.inputs.length,0);assert.equal(saved(x).pending,null);assert.deepEqual(saved(x).observations.at(-1).invocation,x.checkpoint.pending);
});

test('runtime fixture absent Pack preflight is correctable before dispatch and does not hide a post-dispatch typed error',async t=>{
  const x=await setup(t),provider=model([choose('runtime_pack_run',{recipe}),wait()]),calls=[];
  const tools=new WorkExecutionTools(x.store,x.config,{async call(name){calls.push(name);assert.fail('Preflight must reject before the API call');}},x.work.work_id,x.run,x.work.spec,'Read the delegated source.',()=>{},provider);x.cleanup.push(()=>tools.close());
  const result=await new BoundedWorkClientExecutor(provider).execute(request(x),{tools:tools.catalog(),checkpoint:()=>{},validateTool:(name,args,context)=>tools.validate(name,args,context.request_id),executeTool:async(name,args,context)=>tools.receipt(name,await tools.execute(name,args,context.request_id),context.request_id)});
  assert.equal(result.status,'paused');assert.equal(calls.length,0);assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.checkpoint.observations[0].invocation.dispatched,false);assert.equal(result.checkpoint.observations[0].receipt.effect_state,'none');assert.match(JSON.stringify(result.checkpoint.observations[0].receipt.value),/WORK_PACK_CONNECTION_REQUIRED/u);
  const afterDispatch=await new BoundedWorkClientExecutor(model([choose('runtime_pack_run',{recipe})])).execute(request(x),{tools:[packTool],checkpoint:()=>{},async executeTool(){throw new WorkClientToolInputError('PACKS_NOT_CONNECTED','An error type alone does not prove dispatch never occurred.');}});
  assert.equal(afterDispatch.status,'reconciliation_required');assert.equal(afterDispatch.checkpoint.pending.dispatched,true);assert.equal(afterDispatch.checkpoint.observations.length,0);
});

const mutations={
  other_reason:x=>x.store.hermesState.prepare("UPDATE office_supervisor SET reason='PACK_SOURCE_TIMEOUT' WHERE run_id=?").run(x.run),
  saved_config_changed:x=>x.store.hermesState.prepare('UPDATE office_supervisor SET config_hash=? WHERE run_id=?').run('f'.repeat(64),x.run),
  current_config_changed:async x=>{const raw=JSON.parse(await readFile(x.path,'utf8'));raw.caller_ref='different-caller';await writeFile(x.path,JSON.stringify(raw));},
  configured_pack_connection:async x=>{const raw=JSON.parse(await readFile(x.path,'utf8'));raw.packs={sources:[],targets:[],models:'off'};await writeFile(x.path,JSON.stringify(raw));x.config=loadHostConfig(x.path);x.store.hermesState.prepare('UPDATE office_supervisor SET config_hash=? WHERE run_id=?').run(x.config.fingerprint,x.run);},
  wrong_database:x=>{x.config={...x.config,dbPath:join(x.root,'other.sqlite')};},
  live_owner:x=>x.store.hermesState.prepare('UPDATE office_supervisor SET owner=?,lease_until_ms=? WHERE run_id=?').run('active-owner',Date.now()+60000,x.run),
  stale_lease:x=>x.store.hermesState.prepare('UPDATE office_supervisor SET lease_until_ms=1 WHERE run_id=?').run(x.run),
  foreign_checkpoint:x=>{x.checkpoint.run_id=randomUUID();},
  foreign_work_argument:x=>{x.checkpoint.pending.arguments.work_id=randomUUID();},
  another_tool:x=>{x.checkpoint.pending.tool_name='runtime_pack_execute_approved';},
  external_write:x=>{x.checkpoint.pending.effect='external_write';},
  altered_request:x=>{x.checkpoint.pending.request_id='unrelated-request';},
  uncertain_prior_receipt:x=>{x.checkpoint.observations[0].receipt.effect_state='uncertain';},
  repeated_receipt:x=>{x.checkpoint.observations[0].invocation.request_id=x.checkpoint.pending.request_id;},
  exhausted_turns:x=>{x.checkpoint.turn=128;x.checkpoint.pending.turn=128;},
  full_history:x=>{x.checkpoint.observations=Array.from({length:32},(_,index)=>({...structuredClone(x.checkpoint.observations[0]),invocation:{...x.checkpoint.observations[0].invocation,request_id:`prior-${index}`}}));},
  prior_pack_record:x=>x.store.beginPack(x.config.project.id,x.checkpoint.pending.request_id,recipe,'binding',x.work.work_id),
  orphan_pack_binding:x=>x.store.hermesState.prepare('INSERT INTO office_run VALUES(?,?,?,?,?)').run(x.config.project.id,x.work.work_id,'pack','missing-pack',new Date().toISOString()),
  missing_failure_result:x=>x.store.hermesState.prepare('UPDATE office_supervisor SET result=NULL WHERE run_id=?').run(x.run),
  missing_failure_activity:x=>x.store.hermesState.prepare("DELETE FROM office_activity WHERE work_id=? AND kind='supervisor.result'").run(x.work.work_id),
  contradictory_tool_result:x=>workActivity(x.store,x.config.project.id,x.work.work_id,'tool.result','A later result cannot be ignored',{stage_id:'pack-stage',tool_name:'runtime_pack_run',status:'succeeded'}),
};
for(const [boundary,mutate] of Object.entries(mutations))test(`runtime contract unstarted-Pack recovery refuses ${boundary} without changing checkpoint or dispatching`,async t=>{
  const x=await historicalRefusal(t);await mutate(x);x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(x.checkpoint),x.run);
  const supervisor=new WorkSupervisor(x.store,x.config,model([]),{auto_start:false});x.cleanup.push(()=>supervisor.close());
  const before=JSON.stringify(x.store.hermesState.prepare('SELECT * FROM office_supervisor WHERE run_id=?').get(x.run)),changes=totalChanges(x);
  assert.equal(status(x).can_resume,false);assert.throws(()=>reconcileUnstartedPackExecution(x.store,x.config,input(x)),/WORK_RECONCILIATION_REQUIRED/u);assert.throws(()=>supervisor.action({...input(x),action:'resume'}),/WORK_RECONCILIATION_REQUIRED/u);
  assert.equal(JSON.stringify(x.store.hermesState.prepare('SELECT * FROM office_supervisor WHERE run_id=?').get(x.run)),before);assert.equal(totalChanges(x),changes);assert.equal(x.store.intakeWork(x.config.project.id,x.work.work_id).revision,x.work.revision);assert.equal(supervisor.model.inputs.length,0);
});

test('runtime contract the executor policy distinguishes Google environment recovery from other challenges',()=>{
  // A6: the Google environment-block route is host-only and its provider/query
  // rules live in the office_web_search description; WORK_SEARCH_ENVIRONMENT_BLOCKED
  // and WORK_SEARCH_PROVIDER_BLOCKED refuse substitutions and repeats
  // (runtime-work-unusual-traffic, runtime-work-search-provider). The prompt keeps the general rule.
  assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/Never solve or bypass a login, CAPTCHA or access challenge/u);assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/if the requested service is essential, keep it and wait/u);
});
