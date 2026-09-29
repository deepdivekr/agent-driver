import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {connectMcp} from '../dist/interface/mcp.js';
import {PackStore} from '../dist/packs/store.js';
import {workExecuteSchema,workControlSchema,workTools} from '../dist/work/contracts.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {workExecuteSchema as dispatcherExecuteSchema} from '../dist/work/dispatch.js';
import {supervisorActionSchema} from '../dist/work/supervisor.js';
import {workTail} from '../dist/work/activity.js';

const proposal={title:'Read Pack catalog',desired_outcome:'Report the registered search Pack family.',completion_checks:[{id:'catalog',result:'Find the research.search Pack in the host catalog.',evidence:'The observed host Pack family ID.'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
function model(options={}){
  let actionCount=0;return {calls:[],inputs:[],async call(purpose,instructions,input,schema){
    this.inputs.push({purpose,instructions,input:structuredClone(input)});
    let result;
    if(schema.properties?.title)result=structuredClone(proposal);
    else if(schema.properties?.action){
      if(actionCount++===0)await options.firstAction?.();
      if(!input.checkpoint.observations.length)result={action:'tool',stage_id:'catalog',tool_name:'runtime_pack_catalog',arguments_json:'{}',summary:'Read the configured host catalog.',completed_checks:[],wait_reason:null};
      else result={action:'complete',stage_id:'result',tool_name:null,arguments_json:null,summary:'The host catalog includes research.search.',completed_checks:[{id:'catalog',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}],wait_reason:null};
    }else if(schema.properties?.checks){
      const id=input.checks[0].allowed_evidence_ids[0];result={checks:[{id:'catalog',verdict:'supported',evidence_ids:[id],evidence_quotes:[{evidence_id:id,quote:'research.search'}],reason:'The observed catalog has this family ID.'}]};
    }else throw Error('UNEXPECTED_FIXTURE_SCHEMA');
    this.calls.push({purpose,provider:'contract_fixture',model:'fixture-model',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return result;
  }};
}
function gate(){let release,enter;const ready=new Promise(resolve=>{enter=resolve;}),wait=new Promise(resolve=>{release=resolve;});return {release,ready,async block(){enter();await wait;}};}
async function setup(t,provider=model()){
  const root=await mkdtemp(join(tmpdir(),'office-mcp-work-')),path=join(root,'host.json');
  const raw={schema_version:1,project_id:'mcp-work',caller_ref:'fixture-client',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}};
  await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:provider}),resources=[],releases=[];
  t.after(async()=>{for(const release of releases)release();for(const close of resources.reverse())await close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {root,path,raw,config,api,provider,onClose:close=>resources.push(close),onRelease:release=>releases.push(release),start:()=>api.call('runtime_work_start',{request_id:'catalog-work',prompt:'Report the registered research.search Pack family.'})};
}
const status=x=>supervisorStatus(x.api.store,x.config.project.id,x.work.work_id);
async function settle(x,expected='succeeded'){
  for(let i=0;i<200;i++){const current=status(x);if(current?.state===expected)return current;if(current?.state==='failed'&&expected!=='failed')assert.fail(JSON.stringify(current));await delay(15);}assert.fail(JSON.stringify(status(x)));
}
const hasSupervisor=x=>Boolean(x.api.store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get());

test('MCP contract execution and control share canonical dashboard schemas without granting authority',()=>{
  assert.equal(dispatcherExecuteSchema,workExecuteSchema);assert.equal(supervisorActionSchema,workControlSchema);
  assert.equal(workTools.runtime_work_execute.readOnly,false);assert.equal(workTools.runtime_work_control.readOnly,false);
  assert.deepEqual(workExecuteSchema.parse({work_id:'11111111-1111-4111-8111-111111111111',revision:1}),{work_id:'11111111-1111-4111-8111-111111111111',revision:1,executor:'client',cost_acknowledged:false});
  assert.throws(()=>workControlSchema.parse({work_id:'11111111-1111-4111-8111-111111111111',revision:1,action:'resume',approved:true}));
});

test('MCP contract ordinary intake/status does not instantiate the operating loop; invalid admission cannot wake it',async t=>{
  const x=await setup(t);x.work=await x.start();assert.equal(hasSupervisor(x),false);
  await x.api.call('runtime_work_status',{work_id:x.work.work_id});await x.api.call('runtime_pack_catalog',{});assert.equal(hasSupervisor(x),false);
  const request={work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true};
  await assert.rejects(x.api.call('runtime_work_execute',{...request,cost_acknowledged:false}),/WORK_MODEL_USAGE_CONSENT_REQUIRED/u);
  await assert.rejects(x.api.call('runtime_work_execute',{...request,revision:999}),/WORK_REVISION_CONFLICT/u);
  await assert.rejects(x.api.call('runtime_work_execute',{...request,executor:'hermes'}),/WORK_EXECUTOR_CHANGED/u);
  await assert.rejects(x.api.call('runtime_work_execute',{...request,work_id:'22222222-2222-4222-8222-222222222222'}),/WORK_NOT_FOUND/u);
  assert.equal(hasSupervisor(x),false);assert.equal(x.provider.inputs.length,1);
});

test('MCP contract explicitly admitted Work executes host tools through the supplied API and verifies durable receipts',async t=>{
  const x=await setup(t);x.work=await x.start();let toolCalls=0;const original=x.api.call.bind(x.api);x.api.call=async(name,args)=>{if(name==='runtime_pack_catalog')toolCalls++;return original(name,args);};
  const accepted=await x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true,timezone:'Asia/Seoul'});assert.equal(accepted.accepted,true);assert.ok(accepted.run_id);
  const complete=await settle(x);assert.equal(complete.result.completion_verified,true);assert.equal(complete.steps.length,1);assert.equal(toolCalls,1);
  assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);
  assert.equal(x.api.store.hermesState.prepare('SELECT timezone FROM office_supervisor').get().timezone,'Asia/Seoul');
  assert.ok(workTail(x.api.store,x.config.project.id,x.work.work_id).some(event=>event.kind==='supervisor.verification'));
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true}),/WORK_USE_EXISTING_EXECUTION_CONTROL/u);
});

test('MCP contract independent runtimes share the exact UI supervisor lease instead of executing a second bot',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);x.work=await x.start();
  const ui=new WorkSupervisor(x.api.store,x.config,x.provider,{api:x.api});x.onClose(()=>ui.close());
  const begun=ui.start(x.work.work_id,x.work.revision,true);await hold.ready;
  const other=new RuntimeApi(x.config,{swarmModel:model()});x.onClose(async()=>{other.close();await other.drain();});
  const repeated=await other.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true});
  assert.equal(repeated.accepted,false);assert.equal(repeated.deduplicated,true);assert.equal(repeated.run_id,begun.run_id);
  assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);hold.release();assert.equal((await settle(x)).state,'succeeded');
});

test('MCP contract pause/resume changes the same Work revision and preserves the operation identity',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);x.work=await x.start();
  const begun=await x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true});await hold.ready;
  const paused=await x.api.call('runtime_work_control',{work_id:x.work.work_id,revision:x.work.revision,action:'pause'});assert.equal(paused.state,'paused');assert.equal(paused.revision,x.work.revision+1);
  await assert.rejects(x.api.call('runtime_work_control',{work_id:x.work.work_id,revision:x.work.revision,action:'resume'}),/WORK_REVISION_CONFLICT/u);
  hold.release();for(let i=0;i<80&&status(x).live;i++)await delay(10);
  const resumed=await x.api.call('runtime_work_control',{work_id:x.work.work_id,revision:paused.revision,action:'resume'});assert.equal(resumed.run_id,begun.run_id);
  const finished=await settle(x);assert.equal(finished.run_id,begun.run_id);assert.equal(finished.steps.length,1);assert.equal(finished.revision,paused.revision+1);
});

test('MCP contract passive pause does not wake a worker; explicit cross-session resume continues the already approved run',async t=>{
  const x=await setup(t);x.work=await x.start();const passive=new WorkSupervisor(x.api.store,x.config,x.provider,{api:x.api,auto_start:false});x.onClose(()=>passive.close());
  // Seed a saved queue through the same durable admission, then pause it before the turn can dispatch.
  const hold=gate(),ownerModel=model({firstAction:hold.block}),owner=new WorkSupervisor(x.api.store,x.config,ownerModel,{api:x.api});x.onClose(()=>owner.close());x.onRelease(hold.release);
  owner.start(x.work.work_id,x.work.revision,true);await hold.ready;
  const otherModel=model(),other=new RuntimeApi(x.config,{swarmModel:otherModel});x.onClose(async()=>{other.close();await other.drain();});
  const paused=await other.call('runtime_work_control',{work_id:x.work.work_id,revision:x.work.revision,action:'pause'});assert.equal(otherModel.inputs.length,0);hold.release();
  for(let i=0;i<80&&status(x).live;i++)await delay(10);
  await owner.close();
  const originalRun=status(x).run_id;
  const queued=await other.call('runtime_work_control',{work_id:x.work.work_id,revision:paused.revision,action:'resume'});assert.equal(queued.state,'queued');
  assert.equal((await settle(x)).state,'succeeded');assert.ok(otherModel.inputs.length>0);
  assert.equal(status(x).run_id,originalRun);assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);
});

test('MCP contract imported bots and another project stay outside new Work admission authority',async t=>{
  const x=await setup(t);x.work=await x.start();const record=x.api.store.createWorkImport(x.config.project.id,'project',{source:'existing-bot'},'a'.repeat(64));
  const imported=x.api.store.acceptWorkImport(x.config.project.id,record.id,'Observe the existing bot.',proposal);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:imported.id,revision:imported.revision,cost_acknowledged:true}),/ORIGINAL_RUNTIME_CONNECTION_REQUIRED/u);
  const otherPath=join(x.root,'other.json');await writeFile(otherPath,JSON.stringify({...x.raw,project_id:'another-project'}));const other=new RuntimeApi(loadHostConfig(otherPath),{swarmModel:model()});x.onClose(async()=>{other.close();await other.drain();});
  await assert.rejects(other.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true}),/WORK_NOT_FOUND/u);assert.equal(hasSupervisor(x),false);
});

test('MCP contract close drains its supplied supervisor before closing the shared store and leaves resumable queue state',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);x.work=await x.start();
  const admitted=await x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true});await hold.ready;
  x.api.close();let finished=false;const drained=x.api.drain().then(()=>{finished=true;});await delay(20);assert.equal(finished,false);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true}),/RUNTIME_API_CLOSED/u);
  hold.release();await drained;const reopened=new PackStore(x.config.dbPath);try{const row=supervisorStatus(reopened,x.config.project.id,x.work.work_id);assert.equal(row.run_id,admitted.run_id);assert.equal(row.state,'queued');assert.equal(row.live,false);assert.equal(row.steps.length,0);}finally{reopened.close();}
});

test('MCP contract close during lazy admission cannot construct a late operating loop against a closed store',async t=>{
  const x=await setup(t);x.work=await x.start();
  const admission=x.api.call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true});x.api.close();
  await assert.rejects(admission,/RUNTIME_API_CLOSED|WORK_SUPERVISOR_CLOSED/u);await x.api.drain();
  const reopened=new PackStore(x.config.dbPath);try{assert.equal(supervisorStatus(reopened,x.config.project.id,x.work.work_id),null);}finally{reopened.close();}
});

test('MCP contract actual SDK transport publishes and invokes execution/control, not just dashboard buttons',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),connection=await connectMcp(x.api,serverTransport,{transport:'streamable-http'}),client=new Client({name:'work-control-fixture',version:'1'});
  x.onClose(async()=>{await client.close();await connection.close();});await client.connect(clientTransport);
  const catalog=await client.listTools();assert.ok(catalog.tools.some(tool=>tool.name==='runtime_work_execute'));assert.ok(catalog.tools.some(tool=>tool.name==='runtime_work_control'));
  assert.match(catalog.tools.find(tool=>tool.name==='runtime_work_execute').description,/validated pasted definition.*without an original-runtime binding can run in Office/u);
  assert.match(catalog.tools.find(tool=>tool.name==='runtime_work_execute').description,/observe\/augment modes.*keep their original runtime/u);
  assert.match(catalog.tools.find(tool=>tool.name==='runtime_work_results').description,/Office-owned copied Work output.*local Control Center/u);
  assert.match(client.getInstructions(),/Validated pasted definitions accepted for migration without an original-runtime binding can run in Office after consent/u);
  assert.doesNotMatch(client.getInstructions(),/Imported workflows.*never re-executed by the new-Work loop/u);
  const call=async(name,args)=>{const reply=await client.callTool({name,arguments:args});assert.notEqual(reply.isError,true,JSON.stringify(reply));return JSON.parse(reply.content[0].text);};
  x.work=await call('runtime_work_start',{request_id:'catalog-work',prompt:'Report the registered search Pack family.'});
  const begun=await call('runtime_work_execute',{work_id:x.work.work_id,revision:x.work.revision,cost_acknowledged:true});await hold.ready;assert.equal(begun.accepted,true);
  const paused=await call('runtime_work_control',{work_id:x.work.work_id,revision:x.work.revision,action:'pause'});assert.equal(paused.state,'paused');hold.release();
  const state=await call('runtime_work_status',{work_id:x.work.work_id});assert.equal(state.paused,true);assert.equal(state.revision,paused.revision);
});
