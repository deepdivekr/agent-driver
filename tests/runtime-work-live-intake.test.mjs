import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkSchedules} from '../dist/work/schedule.js';
import {workStartSchema,workAnswerSchema,workPauseSchema,workStartActionSchema,workAnswerActionSchema,workPauseActionSchema,workExecuteSchema} from '../dist/work/contracts.js';
import {initWorkExecution,workActivity,workTail} from '../dist/work/activity.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {startControlCenter,controlCenterReloadBlockedReason} from '../dist/observability/control-center.js';

const question={id:'format',prompt:'Choose the output',options:[{id:'summary',label:'Summary',meaning:'Text summary'},{id:'cards',label:'Cards',meaning:'Card draft'}],recommended_id:'summary',required:false};
const proposal=(extra={})=>({title:'ASTS article research',desired_outcome:'Read public sources about ASTS and provide a sourced summary',completion_checks:[{id:'evidence',result:'A sourced summary is available',evidence:'Observed source and saved result receipts'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],...extra});
const wait={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The fixture intentionally waits for configuration; no result is claimed.',completed_checks:[],wait_reason:'configuration'};
function model({definition=proposal(),gate=null,offline=false,guided=false}={}){
  return {calls:[],inputs:[],async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});this.inputs.push({instructions,input:structuredClone(input)});
    if(instructions.startsWith('Define one durable')){if(gate)await gate;if(offline)throw Error('OFFLINE');return structuredClone({...definition,...(guided&&!Object.keys(input.answers??{}).length?{questions:[question]}:{})});}
    if(instructions.startsWith('Normalize the user'))return {kind:'daily',timezone:'UTC',hour:20,minute:0};
    assert.ok(instructions.startsWith('Execute the registered Work'),instructions.slice(0,120));return structuredClone(wait);
  }};
}
async function fixture(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'work-live-intake-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'live-intake',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:options.approved!==false}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkExecution(store);
  const ai=options.model??model(),runtime=new WorkRuntime(store,config,ai),closers=[];
  const cc=await startControlCenter(config,{workModel:ai,...(options.onReload?{onReload:options.onReload}:{}),...(options.reloadStatus?{reloadStatus:options.reloadStatus}:{})});
  t.after(async()=>{for(const close of closers.reverse())await close();await cc.close();store.close();await rm(root,{recursive:true,force:true});});
  const headers={'content-type':'application/json','X-Agent-Driver':'human-office',origin:new URL(cc.url).origin};
  const post=async(suffix,body,extra={})=>{const response=await fetch(cc.url+suffix,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});return {response,data:await response.json()};};
  const detail=async id=>{const response=await fetch(cc.url+'work/detail?id='+id);assert.equal(response.status,200);return response.json();};
  return {root,path,config,store,ai,runtime,cc,post,headers,detail,closers};
}
async function settle(x,id){for(let i=0;i<100;i++){const value=supervisorStatus(x.store,x.config.project.id,id);if(value&&!['queued','running'].includes(value.state))return value;await delay(25);}assert.fail('fixture supervisor did not settle');}

test('runtime contract live intake fields are HTTP-only and MCP registration schemas remain strict',()=>{
  const start={request_id:'strict-intake',prompt:'Research ASTS'};
  assert.equal(workStartActionSchema.parse({...start,execute:true,cost_acknowledged:true}).execute,true);
  assert.equal(workStartActionSchema.parse(start).execute,false);
  assert.throws(()=>workStartSchema.parse({...start,execute:true}));
  assert.throws(()=>workStartActionSchema.parse({...start,current_run_only:true}));
  const answer={work_id:randomUUID(),revision:1,answers:{format:'summary'}};
  assert.equal(workAnswerActionSchema.parse({...answer,execute:true,cost_acknowledged:true}).execute,true);
  assert.throws(()=>workAnswerSchema.parse({...answer,execute:true}));
  const pause={work_id:answer.work_id,revision:1,paused:false};assert.equal(workPauseActionSchema.parse(pause).execute,false);assert.equal(workPauseActionSchema.parse(pause).cost_acknowledged,false);
  assert.equal(workPauseActionSchema.parse({...pause,execute:true,cost_acknowledged:true}).execute,true);assert.throws(()=>workPauseSchema.parse({...pause,execute:true}));
  assert.equal(workExecuteSchema.parse({work_id:answer.work_id,revision:1}).current_run_only,true);
});

test('runtime fixture plain HTTP registration retains ready Work without admitting a run',async t=>{
  const x=await fixture(t),{response,data}=await x.post('work/start',{request_id:'register',prompt:'Research ASTS'});
  assert.equal(response.status,200);assert.equal(data.definition_status,'ready');assert.equal(data.admission.requested,false);
  assert.equal(supervisorStatus(x.store,x.config.project.id,data.work_id),null);assert.equal(x.store.officeRuns(x.config.project.id,data.work_id).length,0);
  assert.ok(workTail(x.store,x.config.project.id,data.work_id).some(row=>row.kind==='definition.finished'));
});

test('runtime fixture explicit start requires allowance confirmation before registration or model use',async t=>{
  const x=await fixture(t),{response,data}=await x.post('work/start',{request_id:'no-cost',prompt:'Research ASTS',execute:true});
  assert.equal(response.status,409);assert.equal(data.error,'WORK_MODEL_USAGE_CONSENT_REQUIRED');assert.equal(x.ai.calls.length,0);
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_intake').get().n,0);
});

test('runtime fixture NDJSON exposes real durable analysis before its held model finishes, then admits only the current run',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),ai=model({gate,definition:proposal({recurrence:{kind:'recurring',rule:'Daily at 20:00 UTC'}})}),x=await fixture(t,{model:ai});x.closers.push(()=>release());
  const response=await fetch(x.cc.url+'work/start',{method:'POST',headers:{...x.headers,accept:'application/x-ndjson'},body:JSON.stringify({request_id:'live-start',prompt:'Research ASTS daily',execute:true,cost_acknowledged:true})});
  assert.equal(response.status,200);const reader=response.body.getReader(),first=new TextDecoder().decode((await reader.read()).value),registered=JSON.parse(first.trim());
  assert.equal(registered.type,'registered');const id=registered.work.work_id;assert.equal(x.store.intakeWork(x.config.project.id,id).status,'defining');
  const during=await x.detail(id);assert.equal(during.execution.basis,'definition_lease');assert.ok(during.activity.some(row=>row.kind==='definition.started'));
  const capabilities=ai.inputs[0].input.executor_capabilities;assert.ok(capabilities.browser_executors.some(item=>item.engine==='playwright'&&item.health==='unknown'&&item.verified_for_environment===false));
  release();let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value);}
  const done=rest.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='result').result;
  assert.equal(done.admission.accepted,true);const run=await settle(x,id);assert.equal(run.current_run_only,true);assert.equal(run.state,'paused');
  const actualResult=workTail(x.store,x.config.project.id,id).find(row=>row.kind==='supervisor.result');assert.equal(actualResult.metadata.status,run.state);assert.equal(actualResult.metadata.reason,run.reason);
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_work_schedule WHERE work_id=?').get(id).n,0);
  assert.equal(ai.inputs.filter(call=>call.instructions.startsWith('Normalize the user')).length,0);
  const repeated=await x.post('work/start',{request_id:'live-start',prompt:'Research ASTS daily',execute:true,cost_acknowledged:true});assert.equal(repeated.data.admission.deduplicated,true);assert.equal(repeated.data.admission.run_id,run.run_id);
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(id).n,1);
});

test('runtime fixture guided work waits for answers, rejects stale answers, and explicitly admits after ready',async t=>{
  const x=await fixture(t,{model:model({guided:true})}),first=await x.post('work/start',{request_id:'guided-live',prompt:'Research ASTS',intake_mode:'guided',execute:true,cost_acknowledged:true});
  assert.equal(first.data.definition_status,'awaiting_details');assert.equal(first.data.admission.accepted,false);assert.equal(supervisorStatus(x.store,x.config.project.id,first.data.work_id),null);
  const answer={work_id:first.data.work_id,revision:first.data.revision,answers:{format:'summary'},execute:true,cost_acknowledged:true};
  const denied=await x.post('work/answer',{...answer,cost_acknowledged:false});assert.equal(denied.response.status,409);assert.equal(x.store.intakeWork(x.config.project.id,answer.work_id).revision,answer.revision);
  const next=await x.post('work/answer',answer);assert.equal(next.response.status,200);assert.equal(next.data.admission.accepted,true);
  const stale=await x.post('work/answer',answer);assert.equal(stale.response.status,409);assert.match(stale.data.error,/WORK_REVISION_CONFLICT|WORK_NOT_AWAITING_DETAILS/u);
  await settle(x,answer.work_id);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(answer.work_id).n,1);
});

test('runtime fixture unavailable analysis persists Work and typed waiting activity without inventing an execution',async t=>{
  const x=await fixture(t,{model:model({offline:true})}),result=await x.post('work/start',{request_id:'offline',prompt:'Research ASTS',execute:true,cost_acknowledged:true});
  assert.equal(result.response.status,200);assert.equal(result.data.definition_status,'needs_model');assert.equal(result.data.admission.accepted,false);
  const tail=workTail(x.store,x.config.project.id,result.data.work_id);assert.ok(tail.some(row=>row.kind==='definition.failed'&&row.metadata.reason==='MODEL_OR_DEFINITION_UNAVAILABLE'));assert.ok(tail.some(row=>row.kind==='dispatch.waiting'));
  assert.equal(supervisorStatus(x.store,x.config.project.id,result.data.work_id),null);
});

test('runtime fixture pause during real analysis preserves its lease and unique revisions but blocks the next execution',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),x=await fixture(t,{model:model({gate})});x.closers.push(()=>release());
  const response=await fetch(x.cc.url+'work/start',{method:'POST',headers:{...x.headers,accept:'application/x-ndjson'},body:JSON.stringify({request_id:'pause-analysis',prompt:'Research ASTS',execute:true,cost_acknowledged:true})}),reader=response.body.getReader();
  const registered=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim()),id=registered.work.work_id,before=x.store.intakeWork(x.config.project.id,id),hash=x.config.fingerprint;
  const paused=await x.post('work/pause',{work_id:id,revision:before.revision,paused:true});assert.equal(paused.response.status,200);assert.equal(paused.data.revision,1);
  const lease=x.store.hermesState.prepare('SELECT define_owner,define_lease_until_ms FROM office_intake WHERE work_id=?').get(id);assert.ok(lease.define_owner);assert.ok(lease.define_lease_until_ms>Date.now());
  const stale=await x.post('work/pause',{work_id:id,revision:0,paused:false});assert.equal(stale.response.status,409);assert.equal(stale.data.error,'WORK_REVISION_CONFLICT');
  release();let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value);}
  const result=rest.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='result').result;assert.equal(result.paused,true);assert.equal(result.revision,2);assert.equal(result.admission.accepted,false);assert.equal(result.admission.reason,'WORK_PAUSED');
  assert.equal(supervisorStatus(x.store,x.config.project.id,id),null);assert.equal(loadHostConfig(x.path).fingerprint,hash);
  assert.deepEqual(x.store.workRevisions(x.config.project.id,id).map(row=>[row.revision,row.kind]),[[0,'received'],[1,'paused'],[2,'defined']]);
  const resumed=await x.post('work/pause',{work_id:id,revision:result.revision,paused:false,execute:true,cost_acknowledged:true,timezone:'UTC'});assert.equal(resumed.response.status,200);assert.equal(resumed.data.scope,'current_run_request');assert.equal(resumed.data.admission.accepted,true);
  const run=await settle(x,id);assert.equal(run.current_run_only,true);assert.equal(run.revision,3);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,1);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(id).n,1);
});

test('runtime fixture early explicit resume preserves the live definition and the original start admits exactly one current run',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),x=await fixture(t,{model:model({gate})});x.closers.push(()=>release());
  const response=await fetch(x.cc.url+'work/start',{method:'POST',headers:{...x.headers,accept:'application/x-ndjson'},body:JSON.stringify({request_id:'early-resume-analysis',prompt:'Research ASTS',execute:true,cost_acknowledged:true})}),reader=response.body.getReader(),registered=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim()),id=registered.work.work_id;
  const paused=await x.post('work/pause',{work_id:id,revision:0,paused:true}),lease=x.store.hermesState.prepare('SELECT define_owner,define_lease_until_ms FROM office_intake WHERE work_id=?').get(id);
  const resumed=await x.post('work/pause',{work_id:id,revision:paused.data.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.state,'defining');assert.equal(resumed.data.admission.reason,'WORK_DEFINITION_IN_PROGRESS');assert.equal(resumed.data.revision,2);assert.equal(supervisorStatus(x.store,x.config.project.id,id),null);
  assert.deepEqual(x.store.hermesState.prepare('SELECT define_owner,define_lease_until_ms FROM office_intake WHERE work_id=?').get(id),lease);
  release();let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value);}const result=rest.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='result').result;assert.equal(result.admission.accepted,true);assert.equal(result.paused,false);assert.equal(result.revision,3);
  const run=await settle(x,id);assert.equal(run.current_run_only,true);assert.equal(run.run_id,result.admission.run_id);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,1);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(id).n,1);
});

test('runtime fixture resume allowance and stale revisions are checked before mutation while omitted execute retains passive pause compatibility',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'resume-compat',prompt:'Research ASTS'});
  const contradictory=await x.post('work/pause',{work_id:work.work_id,revision:work.revision,paused:true,execute:true,cost_acknowledged:true});assert.equal(contradictory.response.status,409);assert.equal(contradictory.data.error,'WORK_RESUME_ACTION_REQUIRED');assert.equal(x.store.intakeWork(x.config.project.id,work.work_id).revision,work.revision);
  const paused=await x.post('work/pause',{work_id:work.work_id,revision:work.revision,paused:true});assert.equal(paused.data.scope,'future_dispatch');
  const unapproved=await x.post('work/pause',{work_id:work.work_id,revision:paused.data.revision,paused:false,execute:true});assert.equal(unapproved.response.status,409);assert.equal(unapproved.data.error,'WORK_MODEL_USAGE_CONSENT_REQUIRED');assert.equal(x.store.intakeWork(x.config.project.id,work.work_id).paused,true);assert.equal(x.store.intakeWork(x.config.project.id,work.work_id).revision,paused.data.revision);
  const stale=await x.post('work/pause',{work_id:work.work_id,revision:work.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(stale.response.status,409);assert.equal(stale.data.error,'WORK_REVISION_CONFLICT');assert.equal(x.store.intakeWork(x.config.project.id,work.work_id).paused,true);
  const passive=await x.post('work/pause',{work_id:work.work_id,revision:paused.data.revision,paused:false});assert.equal(passive.response.status,200);assert.equal(passive.data.scope,'future_dispatch');assert.equal('admission' in passive.data,false);assert.equal(supervisorStatus(x.store,x.config.project.id,work.work_id),null);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
});

test('runtime fixture explicit resume preserves configuration fences and reports the exact rejected current run',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'resume-config',prompt:'Research ASTS'}),paused=x.store.setIntakePaused(x.config.project.id,work.work_id,work.revision,true),raw=JSON.parse(await readFile(x.path,'utf8'));raw.packs.confidence=.85;await writeFile(x.path,JSON.stringify(raw));
  const current=loadHostConfig(x.path);assert.equal(current.packs.models,'off');assert.equal(current.packs.confidence,.85);assert.notEqual(current.fingerprint,x.config.fingerprint);
  const resumed=await x.post('work/pause',{work_id:work.work_id,revision:paused.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.reason,'CONFIG_CHANGED');assert.equal(supervisorStatus(x.store,x.config.project.id,work.work_id),null);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
  assert.ok(workTail(x.store,x.config.project.id,work.work_id).some(row=>row.kind==='dispatch.rejected'&&row.metadata.reason==='CONFIG_CHANGED'));
});

test('runtime fixture explicit resume rejects an invalid unapproved model configuration as unavailable rather than a valid fingerprint change',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'resume-invalid-config',prompt:'Research ASTS'}),paused=x.store.setIntakePaused(x.config.project.id,work.work_id,work.revision,true),raw=JSON.parse(await readFile(x.path,'utf8'));raw.packs.models='jev';await writeFile(x.path,JSON.stringify(raw));
  assert.throws(()=>loadHostConfig(x.path),/MODEL_DATA_APPROVAL_REQUIRED/u);
  const resumed=await x.post('work/pause',{work_id:work.work_id,revision:paused.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.reason,'CONFIG_UNAVAILABLE');assert.equal(supervisorStatus(x.store,x.config.project.id,work.work_id),null);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
  assert.ok(workTail(x.store,x.config.project.id,work.work_id).some(row=>row.kind==='dispatch.rejected'&&row.metadata.reason==='CONFIG_UNAVAILABLE'));
});

test('runtime fixture explicit resume never starts an attached original bot or its scheduler',async t=>{
  const x=await fixture(t),record=x.store.createWorkImport(x.config.project.id,'project',{source:'existing-bot'},'a'.repeat(64)),work=x.store.acceptWorkImport(x.config.project.id,record.id,'Observe the existing bot.',proposal()),paused=x.store.setIntakePaused(x.config.project.id,work.id,work.revision,true);
  const resumed=await x.post('work/pause',{work_id:work.id,revision:paused.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.reason,'USE_EXISTING_RUNTIME_CONTROL');assert.equal(supervisorStatus(x.store,x.config.project.id,work.id),null);assert.equal(x.ai.inputs.length,0);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_work_schedule WHERE work_id=?').get(work.id).n,0);
});

test('runtime fixture explicit resume does not replace or replay an existing uncertain external effect',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'resume-uncertain',prompt:'Research ASTS'}),paused=x.store.setIntakePaused(x.config.project.id,work.work_id,work.revision,true),run_id=randomUUID(),at=new Date().toISOString(),checkpoint=JSON.stringify({format:1,work_id:work.work_id,run_id,binding:'a'.repeat(64),turn:0,pending:{request_id:'prior-write',turn:0,stage_id:'write',tool_name:'runtime_windows_step',arguments:{},effect:'external_write',dispatched:true},observations:[],summary:'Uncertain prior external effect'});
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(run_id,x.config.project.id,work.work_id,paused.revision,'reconciliation_required',checkpoint,x.config.fingerprint,0,at,at);
  const resumed=await x.post('work/pause',{work_id:work.work_id,revision:paused.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.deduplicated,true);assert.equal(resumed.data.admission.state,'reconciliation_required');assert.equal(resumed.data.admission.run_id,run_id);assert.equal(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(run_id).checkpoint,checkpoint);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(work.work_id).n,1);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
});

test('runtime fixture explicit resume during registration-only analysis reports waiting without promising an absent auto-start callback',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),x=await fixture(t,{model:model({gate})});x.closers.push(()=>release());const registration=x.runtime.start({request_id:'registered-analysis-resume',prompt:'Research ASTS'}),work=x.store.intakeWorks(x.config.project.id)[0],paused=await x.post('work/pause',{work_id:work.id,revision:work.revision,paused:true});
  const resumed=await x.post('work/pause',{work_id:work.id,revision:paused.data.revision,paused:false,execute:true,cost_acknowledged:true});assert.equal(resumed.response.status,200);assert.equal(resumed.data.admission.state,'defining');assert.equal(resumed.data.admission.accepted,false);assert.equal(resumed.data.admission.reason,'WORK_DEFINITION_IN_PROGRESS');release();const ready=await registration;assert.equal(ready.definition_status,'ready');assert.equal(ready.paused,false);assert.equal(supervisorStatus(x.store,x.config.project.id,work.id),null);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
});

test('runtime fixture separately opted-in recurring admission still prepares its approved schedule',async t=>{
  const x=await fixture(t,{model:model({definition:proposal({recurrence:{kind:'recurring',rule:'Daily at 20:00 UTC'}})})}),work=await x.runtime.start({request_id:'recurring-explicit',prompt:'Research ASTS daily'});
  const admitted=await x.post('work/execute',{work_id:work.work_id,revision:work.revision,cost_acknowledged:true,current_run_only:false,timezone:'UTC'});assert.equal(admitted.response.status,202);assert.equal(admitted.data.accepted,true);
  const run=await settle(x,work.work_id);assert.equal(run.current_run_only,false);assert.equal(x.store.hermesState.prepare('SELECT state FROM office_work_schedule WHERE work_id=?').get(work.work_id).state,'enabled');
  assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Normalize the user')).length,1);
});

test('runtime fixture HTTP execute and direct supervisor omit schedule opt-in and run only the current cycle',async t=>{
  for(const entry of ['http','supervisor']){
    const x=await fixture(t,{model:model({definition:proposal({recurrence:{kind:'recurring',rule:'Daily at 20:00 UTC'}})})}),work=await x.runtime.start({request_id:'recurring-default-'+entry,prompt:'Research ASTS daily'});
    if(entry==='http'){const admitted=await x.post('work/execute',{work_id:work.work_id,revision:work.revision,cost_acknowledged:true,timezone:'UTC'});assert.equal(admitted.response.status,202);assert.equal(admitted.data.current_run_only,true);}
    else{const supervisor=new WorkSupervisor(x.store,x.config,x.ai);x.closers.push(()=>supervisor.close());assert.equal(supervisor.start(work.work_id,work.revision,true,'UTC').current_run_only,true);}
    const run=await settle(x,work.work_id);assert.equal(run.current_run_only,true);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_work_schedule WHERE work_id=?').get(work.work_id).n,0);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Normalize the user')).length,0);
  }
});

test('runtime fixture saved browser config drift disables start and persists the exact rejection without removing the fence',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'config-drift',prompt:'Research ASTS'}),raw=JSON.parse(await readFile(x.path,'utf8'));
  raw.browser_executors={targets:[{id:'playwright',engine:'playwright',environment:'owned_headless',profile_ref:'default',platform:process.platform}]};await writeFile(x.path,JSON.stringify(raw));
  const before=await x.detail(work.work_id);assert.equal(before.execution_action.can_execute,false);assert.equal(before.execution_action.reason,'CONFIG_CHANGED');
  const result=await x.post('work/execute',{work_id:work.work_id,revision:work.revision,cost_acknowledged:true,current_run_only:true});assert.equal(result.response.status,409);assert.equal(result.data.error,'CONFIG_CHANGED');
  assert.ok(workTail(x.store,x.config.project.id,work.work_id).some(row=>row.kind==='dispatch.rejected'&&row.metadata.reason==='CONFIG_CHANGED'));
  assert.equal(supervisorStatus(x.store,x.config.project.id,work.work_id),null);
});

test('runtime contract reload gates preserve queued work and uncertain or malformed durable effects',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'reload-checkpoints',prompt:'Research ASTS'}),s=new WorkSupervisor(x.store,x.config,x.ai,{auto_start:false});x.closers.push(()=>s.close());
  const started=s.start(work.work_id,work.revision,true,undefined,true);assert.equal(controlCenterReloadBlockedReason(x.store,x.config.project.id),'WORK_EXECUTION_ACTIVE');
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='paused',checkpoint=? WHERE run_id=?").run(JSON.stringify({pending:{dispatched:true,effect:'external_write'}}),started.run_id);assert.equal(controlCenterReloadBlockedReason(x.store,x.config.project.id),'WORK_RECONCILIATION_REQUIRED');
  x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run('{malformed',started.run_id);assert.equal(controlCenterReloadBlockedReason(x.store,x.config.project.id),'WORK_RECONCILIATION_REQUIRED');
  x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run('null',started.run_id);assert.equal(controlCenterReloadBlockedReason(x.store,x.config.project.id),null);
});

test('runtime fixture reload callback runs only after accepted response and fresh-listener mutations stay fenced during apply',async t=>{
  let called=0,state='idle';const x=await fixture(t,{onReload:async()=>{called++;state='reloading';},reloadStatus:()=>({state,reason:null})}),work=await x.runtime.start({request_id:'reload-idle',prompt:'Research ASTS'});
  const before=await x.detail(work.work_id);assert.equal(before.runtime_reload_available,true);
  const denied=await fetch(x.cc.url+'work/reconnect',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(denied.status,403);assert.equal(called,0);
  const accepted=await x.post('work/reconnect',{work_id:work.work_id});assert.equal(accepted.response.status,202);assert.equal(accepted.data.execution_started,false);
  for(let i=0;i<20&&called===0;i++)await delay(5);assert.equal(called,1);const after=await x.detail(work.work_id);assert.equal(after.runtime_configuration.state,'reloading');
  const mutation=await x.post('work/start',{request_id:'during-reload',prompt:'Do not admit',execute:true,cost_acknowledged:true});assert.equal(mutation.response.status,503);assert.equal(mutation.data.error,'CONTROL_CENTER_RELOADING');
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor').get().n,0);
  let readiness='reloading';const fresh=await startControlCenter(x.config,{workModel:x.ai,reloadStatus:()=>({state:readiness,reason:null})});x.closers.push(()=>fresh.close());
  const r=await fetch(fresh.url+'work/start',{method:'POST',headers:{...x.headers,origin:new URL(fresh.url).origin},body:JSON.stringify({request_id:'fresh-listener',prompt:'Must wait'})});assert.equal(r.status,503);assert.equal((await r.json()).error,'CONTROL_CENTER_RELOADING');assert.equal((await fetch(fresh.url+'work/board')).status,200);
  readiness='failed';const failed=await fetch(fresh.url+'work/start',{method:'POST',headers:{...x.headers,origin:new URL(fresh.url).origin},body:JSON.stringify({request_id:'failed-listener',prompt:'Must remain fenced'})});assert.equal(failed.status,503);assert.equal((await failed.json()).error,'CONTROL_CENTER_RELOAD_FAILED');assert.equal((await fetch(fresh.url+'work/board')).status,200);
});

test('runtime fixture disconnected pending analysis still blocks reload after its durable lease expires',async t=>{
  let release;const gate=new Promise(resolve=>release=resolve),x=await fixture(t,{model:model({gate}),onReload:async()=>assert.fail('reload must not interrupt analysis')}),abort=new AbortController();x.closers.push(()=>release());
  const response=await fetch(x.cc.url+'work/start',{method:'POST',signal:abort.signal,headers:{...x.headers,accept:'application/x-ndjson'},body:JSON.stringify({request_id:'disconnected-analysis',prompt:'Research ASTS',execute:true,cost_acknowledged:true})});
  const reader=response.body.getReader(),registered=JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());abort.abort();await reader.cancel().catch(()=>{});
  x.store.hermesState.prepare('UPDATE office_intake SET define_lease_until_ms=0 WHERE work_id=?').run(registered.work.work_id);
  const blocked=await x.post('work/reconnect',{});assert.equal(blocked.response.status,409);assert.equal(blocked.data.error,'MANAGEMENT_ACTION_IN_PROGRESS');
  release();for(let i=0;i<100;i++){if(x.store.intakeWork(x.config.project.id,registered.work.work_id).status!=='defining')break;await delay(10);}
});

test('runtime contract public source activity is bounded, credential-free and distinct from planned routing',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'activity-meta',prompt:'Research ASTS'}),at=new Date().toISOString();
  workActivity(x.store,x.config.project.id,work.work_id,'source.observed','Actual observation',{worker_id:'real-worker',tool_name:'office_browser_read',source:{url:'https://example.org/article?token=do-not-expose',title:'Observed',observed_at:at}});
  workActivity(x.store,x.config.project.id,work.work_id,'definition.route','Planned route only',{route_kind:'pack',pack_family:'research.search',status:'planned'});
  workActivity(x.store,x.config.project.id,work.work_id,'unsafe.metadata','No arguments allowed',{arguments:{password:'secret'}});
  const tail=workTail(x.store,x.config.project.id,work.work_id),source=tail.find(row=>row.kind==='source.observed');assert.equal(source.metadata.worker_id,'real-worker');assert.equal(source.metadata.source.observed_at,at);assert.doesNotMatch(JSON.stringify(source),/do-not-expose|token=/u);
  assert.equal(tail.find(row=>row.kind==='unsafe.metadata').metadata,undefined);assert.equal(tail.filter(row=>row.kind==='definition.route').at(-1).metadata.source,undefined);
});

test('runtime fixture topic-only public search uses the real routed DOM contract, records observed links and rejects secrets and private targets',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'topic-only',prompt:'Research ASTS articles'}),events=[],observed_at=new Date().toISOString();let current='';
  const toolkit=new WorkExecutionTools(x.store,x.config,{call:async()=>assert.fail('browser search must use its router')},work.work_id,randomUUID(),work.spec,work.prompt,()=>{},x.ai,{browserFactory:target=>({target,probe:async()=>events.push('probe'),open:async url=>{current=url;events.push('open');},navigate:async url=>{current=url;events.push('navigate');},observe:async()=>({url:current,title:current.startsWith('https://www.google.com/search')?'Observed search':'Observed article',text:'Actual fixture DOM only',links:[{text:'Article',url:'https://example.org/observed-article'},{text:'Private',url:'https://127.0.0.1/private'},{text:'Secret',url:'https://example.org/?token=private'},{text:'Private hostname',url:'https://vault.internal/private'},{text:'Session credential',url:'https://example.org/?session_id=private'}],observed_at}),extract:async()=>[],scroll:async()=>{},close:async()=>{}})});x.closers.push(()=>toolkit.close());
  assert.equal(toolkit.catalog().find(tool=>tool.name==='office_web_search').effect,'read_only');assert.deepEqual((await toolkit.execute('office_browser_links',{},'empty')).urls,[]);
  for(const query of ['apikey_abcdefghijklmnopqrstuvwxyz','http://127.0.0.1/private','Bearer abcdefghijklmnopqrstuvwxyz','https://app.localhost/private','https://2130706433/private','https://public.example/?access_token=private','https://public.example/#secret=private','https://user:password@public.example/','https://public.example/?session_id=private','https://public.example/?auth=private','cookie=private'])await assert.rejects(toolkit.execute('office_web_search',{query},'forbidden'));
  assert.deepEqual(events,[]);await assert.rejects(toolkit.execute('office_web_search',{query:'ASTS',url:'https://arbitrary.invalid'},'bad-shape'));
  const result=await toolkit.execute('office_web_search',{query:'ASTS latest articles'},'search');assert.equal(new URL(result.requested_url).origin,'https://www.google.com');assert.equal(new URL(result.requested_url).pathname,'/search');assert.equal(new URL(result.requested_url).searchParams.get('q'),'ASTS latest articles');assert.equal(result.provenance,'live_browser_dom');assert.equal(result.text,'Actual fixture DOM only');
  const links=await toolkit.execute('office_browser_links',{},'links');assert.ok(links.urls.includes('https://example.org/observed-article'));assert.ok(!links.urls.includes('https://127.0.0.1/private'));assert.ok(!links.urls.includes('https://example.org/?token=private'));assert.ok(!links.urls.includes('https://vault.internal/private'));assert.ok(!links.urls.includes('https://example.org/?session_id=private'));
  await assert.rejects(toolkit.execute('office_browser_read',{url:'https://example.org/never-observed'},'invented'),/BROWSER_URL_NOT_OBSERVED/u);await toolkit.execute('office_browser_read',{url:'https://example.org/observed-article'},'observed');
  const sources=workTail(x.store,x.config.project.id,work.work_id).filter(row=>row.kind==='source.observed');assert.equal(sources.length,2);assert.equal(sources[0].metadata.source.observed_at,observed_at);assert.equal(sources[0].metadata.tool_name,'office_web_search');assert.equal(sources[1].metadata.tool_name,'office_browser_read');assert.equal((await toolkit.receipt('office_web_search',result,'search')).effect_state,'none');
});

test('runtime fixture readiness rebind fences already-authorized due schedules until fresh configuration is ready',async t=>{
  const x=await fixture(t,{model:model({definition:proposal({recurrence:{kind:'recurring',rule:'Daily at 20:00 UTC'}})})}),work=await x.runtime.start({request_id:'due-after-apply',prompt:'Research ASTS daily'});await x.cc.close();
  const previous=new WorkSupervisor(x.store,x.config,x.ai,{auto_start:false}),at=new Date().toISOString();x.closers.push(()=>previous.close());
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),x.config.project.id,work.work_id,work.revision,'failed',x.config.fingerprint,0,at,at);
  // Advance a genuinely authorized past daily schedule. Setting only next_run_ms
  // in the past would fabricate a due row with no valid slot after its anchor.
  let scheduleNow=Date.now()-2*86400_000;const schedules=new WorkSchedules(x.store,x.config.project.id,{clock:()=>scheduleNow});await schedules.prepare(work.work_id,work.revision,x.ai,{default_timezone:'UTC'});schedules.enable(work.work_id,work.revision,{acknowledged:true});
  scheduleNow=Date.now();const due=schedules.due();assert.equal(due.length,1);assert.ok(due[0].scheduled_ms>=x.store.hermesState.prepare('SELECT anchor_ms FROM office_work_schedule WHERE work_id=?').get(work.work_id).anchor_ms);let state='reloading';
  const fresh=await startControlCenter(x.config,{workModel:x.ai,reloadStatus:()=>({state,reason:null})});x.closers.push(()=>fresh.close());
  await delay(1250);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(work.work_id).n,1);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
  state='failed';await delay(1250);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(work.work_id).n,1);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);
  state='idle';for(let i=0;i<140;i++){if(x.ai.inputs.some(call=>call.instructions.startsWith('Execute the registered Work')))break;await delay(25);}
  t.diagnostic(JSON.stringify({runtime_configuration:state,clock_ms:Date.now(),schedule:x.store.hermesState.prepare('SELECT state,definition,anchor_ms,next_run_ms,owner,lease_until_ms FROM office_work_schedule WHERE work_id=?').get(work.work_id),due:schedules.due(),leases:x.store.hermesState.prepare('SELECT state,owner,lease_until_ms,attempts FROM office_supervisor WHERE work_id=?').all(work.work_id),model_inputs:x.ai.inputs.map(call=>call.instructions.slice(0,100))}));
  assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(work.work_id).n,2);assert.equal(x.ai.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,1);
});

test('runtime fixture browser continuity restores only exact observed links from this Work/run successful read-only receipts',async t=>{
  const x=await fixture(t),work=await x.runtime.start({request_id:'restored-browser-urls',prompt:'Research ASTS'}),run=randomUUID(),observed_at=new Date().toISOString(),value={url:'https://www.google.com/search?q=ASTS',title:'Actual search',text:'Actual source list',links:[{text:'Article',url:'https://example.org/observed'},{text:'Private',url:'https://127.0.0.1/private'},{text:'Token',url:'https://example.org/?access_token=private'}],observed_at,requested_url:'https://www.google.com/search?q=ASTS',provenance:'live_browser_dom',effect:'read_only'};
  const receipt={status:'succeeded',value,evidence_ids:['observed-search'],effect_state:'none',retry_safe:true},invocation={request_id:'observed-search',turn:0,stage_id:'search',tool_name:'office_web_search',arguments:{query:'ASTS'},effect:'read_only',dispatched:true},checkpoint={format:1,work_id:work.work_id,run_id:run,binding:'a'.repeat(64),turn:1,pending:null,observations:[{invocation,receipt,observed_at}],summary:'Observed only'};
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(run,x.config.project.id,work.work_id,work.revision,'paused',JSON.stringify(checkpoint),x.config.fingerprint,0,observed_at,observed_at);
  const create=runId=>new WorkExecutionTools(x.store,x.config,{call:async()=>assert.fail('URL inventory never executes an API')},work.work_id,runId,work.spec,work.prompt,()=>{},x.ai),same=create(run);x.closers.push(()=>same.close());
  const inventory=await same.execute('office_browser_links',{},'restored');assert.ok(inventory.urls.includes(value.url));assert.ok(inventory.urls.includes('https://example.org/observed'));assert.ok(!inventory.urls.includes('https://127.0.0.1/private'));assert.ok(!inventory.urls.includes('https://example.org/?access_token=private'));
  const unrelated=create(randomUUID());x.closers.push(()=>unrelated.close());assert.deepEqual((await unrelated.execute('office_browser_links',{},'different-run')).urls,[]);
  checkpoint.observations[0].receipt={...receipt,status:'reconciliation_required',effect_state:'uncertain',retry_safe:false};x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),run);
  const uncertain=create(run);x.closers.push(()=>uncertain.close());assert.deepEqual((await uncertain.execute('office_browser_links',{},'uncertain')).urls,[]);
  checkpoint.observations[0].receipt=receipt;checkpoint.work_id=randomUUID();x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),run);
  const foreign=create(run);x.closers.push(()=>foreign.close());assert.deepEqual((await foreign.execute('office_browser_links',{},'foreign-checkpoint')).urls,[]);
});
