import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';
import {PACK_ENGINE_VERSION} from '../dist/packs/runtime.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {WorkSchedules} from '../dist/work/schedule.js';

const prompt='Observe this specific registered source and retain local changes only.';
const recipe={version:1,family:'monitor.watch',request:prompt,sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id','status']};
const spec={title:'Current status watch',desired_outcome:prompt,completion_checks:[{id:'watch',result:'Observe the current source',evidence:'Host watch observation'}],assumptions:[],route:{kind:'pack',pack_family:'monitor.watch'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'read_only')};

async function fixture(t,selectedRecipe=recipe){
  const root=await mkdtemp(join(tmpdir(),'custom-pack-timer-')),hostPath=join(root,'host.json');
  let requests=0,status='Open',api,held=null,failNext=false;const closers=[];
  const respond=res=>{if(failNext){failNext=false;res.writeHead(503);res.end('temporarily unavailable');return;}res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:'one',status}]));};
  const server=createServer((_req,res)=>{requests++;if(held&&!held.response){held.response=res;held.arrived();return;}respond(res);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{held?.response?.destroy();for(const close of closers.reverse())await close();if(api){api.close();await api.drain();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  await writeFile(hostPath,JSON.stringify({schema_version:1,project_id:'custom-timer-project',caller_ref:'owner',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:origin+'/lab/account-a/',packs:{models:'off',sources:[...new Set(selectedRecipe.sources.map(source=>source.id))].map(id=>({id,kind:'http',url:origin+'/rows',format:'json',json_fields:['id','status']})),targets:[]}}));
  const config=loadHostConfig(hostPath);api=new RuntimeApi(config);initWorkSupervisor(api.store);const project=config.project.id;
  function ready(){
    const received=api.store.beginWork(project,randomUUID(),prompt,'quick').work,owner=api.store.claimWorkDefinition(project,received.id);
    return api.store.finishWorkDefinition(project,received.id,owner,{...structuredClone(spec),route:{kind:'pack',pack_family:selectedRecipe.family}},[],'ready');
  }
  async function run(work,requestId=work.request_id){return api.call('runtime_pack_run',{work_id:work.id,request_id:requestId,recipe:selectedRecipe});}
  const original=ready(),demonstrated=await run(original),supervisorId=randomUUID(),at=new Date().toISOString();
  // Only independent goal acceptance is a fixture. HTTP collection, saved
  // recipe, ownership, repeat preparation and timer execution use real code.
  const checkpoint={observations:[{invocation:{tool_name:'runtime_pack_run',request_id:original.request_id,effect:'local_write',dispatched:true,arguments:{recipe:selectedRecipe,work_id:original.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[original.request_id],value:demonstrated}}]};
  api.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(supervisorId,project,original.id,original.revision,'succeeded',JSON.stringify(checkpoint),JSON.stringify({completion_verified:true}),config.fingerprint,0,at,at);
  await api.call('runtime_custom_pack_publish',{key:'specific-watch',title:'My specific status watch',work_id:original.id,supervisor_run_id:supervisorId,pack_run_id:demonstrated.run_id});
  function due(runId){api.store.hermesState.prepare('UPDATE family_watch SET next_ms=? WHERE run_id=?').run(Date.now()-1,runId);}
  function change(workId){const work=api.store.intakeWork(project,workId);api.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify({...work.spec,desired_outcome:'A changed goal needs a different Pack version.'}),project,workId);}
  async function repeat(cycle){
    const prepared=await api.call('runtime_custom_pack_prepare_repeat',{key:'specific-watch',cycle_id:cycle});
    return {prepared,work:api.store.intakeWork(project,prepared.work_id)};
  }
  function admit(work){
    const runId=randomUUID(),at=new Date().toISOString();
    // Admission is the fixture; public supervisor controls, HTTP failure and
    // Pack timer recovery below use the production implementation.
    api.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,current_run_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,project,work.id,work.revision,'queued',config.fingerprint,0,1,at,at);
    return runId;
  }
  function scheduledRepeat(){
    const host={config_fingerprint:config.fingerprint,engine_binding:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})};
    api.customPackSchedules.configure({key:'specific-watch',parent_revision:original.revision,definition:{kind:'interval',timezone:'UTC',seconds:60},cost_acknowledged:true,recurrence_acknowledged:true},host);
    const atMs=Date.now();api.store.hermesState.prepare('UPDATE office_work_schedule SET anchor_ms=?,next_run_ms=? WHERE project_id=? AND work_id=?').run(atMs-65_000,atMs-5_000,project,original.id);
    const schedules=new WorkSchedules(api.store,project),due=schedules.due()[0],prepared=api.customPackSchedules.prepareDue(due,host),claim=schedules.claim(due);
    assert.ok(claim);
    const runId=admit(prepared.work);
    schedules.markStarted(claim,runId,prepared.work.id);
    return prepared;
  }
  function holdNext(){
    assert.equal(held,null);let arrived;const entered=new Promise(resolve=>{arrived=resolve;});held={arrived,response:null};
    return {entered,release(){assert.ok(held?.response);respond(held.response);held=null;}};
  }
  async function mcp(){
    const client=new Client({name:'custom-timer-contract-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp','--config',hostPath],stderr:'pipe'});
    closers.push(()=>client.close());await client.connect(transport);return client;
  }
  return {api,config,project,original,ready,run,due,change,repeat,admit,scheduledRepeat,holdNext,mcp,requests:()=>requests,setStatus(value){status=value;},failNext(){failNext=true;},recoveryDue(runId){api.store.hermesState.prepare('UPDATE family_execution SET retry_at_ms=0 WHERE run_id=?').run(runId);}};
}
const value=result=>JSON.parse(result.content.find(item=>item.type==='text').text);

for(const scheduled of [false,true])test(`${scheduled?'scheduled parent':'manual child'} pause holds watch ticks without retiring the observation and resumes the same run`,async t=>{
  const x=await fixture(t),custom=scheduled?x.scheduledRepeat():await x.repeat('paused-watch'),customRun=await x.run(custom.work,custom.prepared.request_id),legacy=await x.run(x.ready());
  const controlled=scheduled?x.original:custom.work,paused=await x.api.call('runtime_work_pause',{work_id:controlled.id,revision:controlled.revision,paused:true});
  x.due(customRun.run_id);x.due(legacy.run_id);
  const before=x.requests(),state=x.api.store.watchState(x.project,customRun.run_id),checkpoint=snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint),timer=await x.api.packs.tick();
  assert.equal(timer.processed.find(item=>item.run_id===customRun.run_id),undefined,'Paused work is excluded before the bounded timer batch.');
  assert.equal(x.requests(),before+1,'Only the healthy legacy watch observes.');
  assert.deepEqual(x.api.store.watchState(x.project,customRun.run_id),state,'A Work pause must not permanently set the separate watch pause or advance the cycle.');
  assert.equal(snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint),checkpoint);
  const client=await x.mcp(),scoped=await client.callTool({name:'runtime_pack_watch_tick',arguments:{run_id:customRun.run_id}});
  assert.equal(scoped.isError,true);assert.equal(value(scoped).error,'WORK_PAUSED');assert.equal(x.requests(),before+1);
  await x.api.call('runtime_work_pause',{work_id:controlled.id,revision:paused.revision,paused:false});
  const resumed=await x.api.packs.tick();assert.equal(resumed.processed.find(item=>item.run_id===customRun.run_id).status,'unchanged');
  assert.equal(x.requests(),before+2);assert.equal(x.api.store.watchState(x.project,customRun.run_id).cycle,state.cycle+1);
});

test('paused scheduled parent retains its child failed run and permits recovery after Work unpause',async t=>{
  const x=await fixture(t),custom=x.scheduledRepeat();
  x.failNext();const failed=await x.run(custom.work,custom.prepared.request_id);assert.equal(failed.status,'retryable_failure');x.recoveryDue(failed.run_id);
  const interrupted=x.api.store.packRun(x.project,failed.run_id);
  const paused=await x.api.call('runtime_work_pause',{work_id:x.original.id,revision:x.original.revision,paused:true}),before=x.requests(),held=await x.api.packs.tick();
  assert.equal(held.recovered.find(item=>item.run_id===interrupted.id),undefined);
  assert.deepEqual(x.api.store.packRun(x.project,interrupted.id),interrupted);assert.equal(x.requests(),before);
  await x.api.call('runtime_work_pause',{work_id:x.original.id,revision:paused.revision,paused:false});
  const resumed=await x.api.packs.tick();assert.equal(resumed.recovered.find(item=>item.run_id===interrupted.id).status,'watching');
  assert.equal(x.requests(),before+1);assert.equal(x.api.store.packRun(x.project,interrupted.id).request_id,custom.prepared.request_id);
});

for(const recovery of [false,true])test(`five paused custom ${recovery?'recovery candidates':'watches'} do not starve a healthy timer sibling`,async t=>{
  const x=await fixture(t),paused=[],engine=snapshotHash({config:x.config.fingerprint,engine:PACK_ENGINE_VERSION});
  for(let index=0;index<5;index++){
    const custom=await x.repeat(`paused-batch-${index}`);if(recovery){x.admit(custom.work);x.failNext();}
    const run=await x.run(custom.work,custom.prepared.request_id),id=run.run_id;
    if(recovery){assert.equal(run.status,'retryable_failure');x.recoveryDue(id);}else x.due(id);
    await x.api.call(recovery?'runtime_work_control':'runtime_work_pause',{work_id:custom.work.id,revision:custom.work.revision,...(recovery?{action:'pause'}:{paused:true})});
    paused.push({id,run:x.api.store.packRun(x.project,id),checkpoint:x.api.store.packExecution(x.project,id)});
  }
  const healthy=x.ready(),run=recovery?x.api.store.beginPack(x.project,healthy.request_id,recipe,engine,healthy.id).run:await x.run(healthy),id=recovery?run.id:run.run_id;
  if(!recovery)x.due(id);
  const before=x.requests(),timer=await x.api.packs.tick();
  assert.equal(x.requests(),before+1,'The actual I/O budget still admits the healthy sibling behind five paused candidates.');
  assert.equal((recovery?timer.recovered:timer.processed).find(item=>item.run_id===id).status,recovery?'watching':'unchanged');
  for(const item of paused){assert.deepEqual(x.api.store.packRun(x.project,item.id),item.run);assert.deepEqual(x.api.store.packExecution(x.project,item.id),item.checkpoint);}
});

test('a scheduled timer cannot treat lost repeat and cycle metadata as legacy while its slot retains execution ownership',async t=>{
  const x=await fixture(t),custom=x.scheduledRepeat(),customRun=await x.run(custom.work,custom.prepared.request_id),legacy=await x.run(x.ready());
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').run(x.project,custom.work.id);
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_cycle WHERE project_id=? AND request_id=?').run(x.project,custom.prepared.request_id);
  x.due(customRun.run_id);x.due(legacy.run_id);const before=x.requests(),checkpoint=snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint),timer=await x.api.packs.tick();
  assert.deepEqual(timer.processed.find(item=>item.run_id===customRun.run_id),{run_id:customRun.run_id,status:'custom_contract_held',reason:'SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH',observed:false,evidence:[]});
  assert.equal(x.requests(),before+1);assert.equal(x.api.store.watchState(x.project,customRun.run_id).cycle,0);
  assert.equal(snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint),checkpoint);
});

test('parent pause during source collection preserves the completed read and stops subsequent reads and export until same-run resume',async t=>{
  const collectRecipe={version:1,family:'portal.collect',request:prompt,sources:[{id:'rows',parameters:{}},{id:'rows-two',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
  const x=await fixture(t,collectRecipe),custom=x.scheduledRepeat(),hold=x.holdNext(),before=x.requests(),running=x.run(custom.work,custom.prepared.request_id);
  await hold.entered;
  const paused=await x.api.call('runtime_work_pause',{work_id:x.original.id,revision:x.original.revision,paused:true});
  hold.release();const stopped=await running;
  assert.equal(stopped.status,'paused_work');assert.equal(stopped.result.error,'WORK_PAUSED');assert.equal(x.requests(),before+1,'The second source is not admitted after parent pause.');
  const checkpoint=x.api.store.packExecution(x.project,stopped.run_id).checkpoint;
  assert.deepEqual(checkpoint.sources['0'].result.rows,[{id:'one',status:'Open'}],'The completed source observation stays available for recovery.');
  assert.equal(checkpoint.sources['1'],undefined);
  await assert.rejects(readFile(join(dirname(x.config.dbPath),'pack-artifacts',`${stopped.run_id}.json`)),error=>error.code==='ENOENT','No local result export is admitted after pause.');
  await x.api.call('runtime_work_pause',{work_id:x.original.id,revision:paused.revision,paused:false});
  const resumed=await x.run(custom.work,custom.prepared.request_id);
  assert.equal(resumed.status,'succeeded');assert.equal(resumed.run_id,stopped.run_id);assert.equal(x.requests(),before+2,'The first successful source is reused within the same run; only the remaining source is read.');
  assert.deepEqual(JSON.parse(await readFile(resumed.result.artifact.path,'utf8')),[{id:'one',status:'Open'}]);
});

test('global timer and real MCP watch ticks hold changed custom contracts while a healthy legacy watch still observes',async t=>{
  const x=await fixture(t),custom=await x.repeat('changed'),customRun=await x.run(custom.work,custom.prepared.request_id),legacy=await x.run(x.ready());
  assert.equal(customRun.status,'watching');assert.equal(legacy.status,'watching');
  const before=x.requests(),checkpoint=snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint);
  x.change(custom.work.id);x.due(customRun.run_id);x.due(legacy.run_id);x.setStatus('Closed');
  const timer=await x.api.packs.tick();
  assert.equal(x.requests(),before+1,'Only the healthy legacy source is reobserved.');
  assert.deepEqual(timer.processed.find(item=>item.run_id===customRun.run_id),{run_id:customRun.run_id,status:'custom_contract_held',reason:'CUSTOM_PACK_WORK_CONTRACT_CHANGED',observed:false,evidence:[]});
  assert.equal(timer.processed.find(item=>item.run_id===legacy.run_id).status,'changed');
  assert.equal(x.api.store.watchState(x.project,customRun.run_id).paused,true);assert.equal(x.api.store.watchState(x.project,customRun.run_id).cycle,0);
  assert.equal(snapshotHash(x.api.store.packExecution(x.project,customRun.run_id).checkpoint),checkpoint);
  const client=await x.mcp(),scoped=await client.callTool({name:'runtime_pack_watch_tick',arguments:{run_id:customRun.run_id}});
  assert.equal(scoped.isError,true);assert.equal(value(scoped).error,'CUSTOM_PACK_WORK_CONTRACT_CHANGED');assert.equal(x.requests(),before+1);
  const pause=await client.callTool({name:'runtime_pack_watch_pause',arguments:{run_id:customRun.run_id,paused:true}});assert.notEqual(pause.isError,true);
  x.due(legacy.run_id);const global=await client.callTool({name:'runtime_pack_watch_tick',arguments:{}});
  assert.notEqual(global.isError,true);assert.equal(value(global).processed.find(item=>item.run_id===legacy.run_id).status,'unchanged');
  assert.equal(x.requests(),before+2);assert.equal(x.api.store.watchState(x.project,customRun.run_id).cycle,0);
});

test('global MCP tick holds a registered custom cycle with missing repeat binding rather than treating it as legacy',async t=>{
  const x=await fixture(t),custom=await x.repeat('missing-binding'),customRun=await x.run(custom.work,custom.prepared.request_id),legacy=await x.run(x.ready());
  x.api.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE project_id=? AND work_id=?').run(x.project,custom.work.id);
  x.due(customRun.run_id);x.due(legacy.run_id);const before=x.requests(),client=await x.mcp();
  const result=await client.callTool({name:'runtime_pack_watch_tick',arguments:{}});assert.notEqual(result.isError,true);
  const blocked=value(result).processed.find(item=>item.run_id===customRun.run_id);
  assert.equal(blocked.status,'custom_contract_held');assert.equal(blocked.reason,'CUSTOM_PACK_WORK_BINDING_MISSING');assert.equal(blocked.observed,false);
  assert.equal(x.requests(),before+1);assert.equal(x.api.store.watchState(x.project,customRun.run_id).cycle,0);
  assert.equal(x.api.store.watchState(x.project,legacy.run_id).cycle,1);
});

test('timer recovery preserves an interrupted custom run after contract change and continues healthy legacy recovery',async t=>{
  const x=await fixture(t),custom=await x.repeat('interrupted'),legacy=x.ready(),engine=snapshotHash({config:x.config.fingerprint,engine:PACK_ENGINE_VERSION});
  const interrupted=x.api.store.beginPack(x.project,custom.prepared.request_id,recipe,engine,custom.work.id).run;
  const ordinary=x.api.store.beginPack(x.project,legacy.request_id,recipe,engine,legacy.id).run;
  x.change(custom.work.id);const before=x.requests(),result=await x.api.packs.tick();
  const held=result.recovered.find(item=>item.run_id===interrupted.id);
  assert.equal(held.status,'custom_contract_held');assert.equal(held.reason,'CUSTOM_PACK_WORK_CONTRACT_CHANGED');assert.equal(held.write_replayed,false);
  const saved=x.api.store.packRun(x.project,interrupted.id);
  assert.equal(saved.status,'needs_replan');assert.deepEqual(saved.result.previous_result,interrupted.result);assert.equal(saved.result.dispatch_allowed,false);
  assert.equal(x.api.store.packRun(x.project,ordinary.id).status,'watching');assert.equal(x.requests(),before+1);
  assert.throws(()=>x.api.store.watchState(x.project,interrupted.id),/PACK_WATCH_NOT_FOUND/u);
});
