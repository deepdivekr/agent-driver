import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
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

const prompt='Observe this specific registered source and retain local changes only.';
const recipe={version:1,family:'monitor.watch',request:prompt,sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id','status']};
const spec={title:'Current status watch',desired_outcome:prompt,completion_checks:[{id:'watch',result:'Observe the current source',evidence:'Host watch observation'}],assumptions:[],route:{kind:'pack',pack_family:'monitor.watch'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'read_only')};

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'custom-pack-timer-')),hostPath=join(root,'host.json');
  let requests=0,status='Open',api;const closers=[];
  const server=createServer((_req,res)=>{requests++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:'one',status}]));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{for(const close of closers.reverse())await close();if(api){api.close();await api.drain();}server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  await writeFile(hostPath,JSON.stringify({schema_version:1,project_id:'custom-timer-project',caller_ref:'owner',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:origin+'/lab/account-a/',packs:{models:'off',sources:[{id:'rows',kind:'http',url:origin+'/rows',format:'json',json_fields:['id','status']}],targets:[]}}));
  const config=loadHostConfig(hostPath);api=new RuntimeApi(config);initWorkSupervisor(api.store);const project=config.project.id;
  function ready(){
    const received=api.store.beginWork(project,randomUUID(),prompt,'quick').work,owner=api.store.claimWorkDefinition(project,received.id);
    return api.store.finishWorkDefinition(project,received.id,owner,structuredClone(spec),[],'ready');
  }
  async function run(work,requestId=work.request_id){return api.call('runtime_pack_run',{work_id:work.id,request_id:requestId,recipe});}
  const original=ready(),demonstrated=await run(original),supervisorId=randomUUID(),at=new Date().toISOString();
  // Only independent goal acceptance is a fixture. HTTP collection, saved
  // recipe, ownership, repeat preparation and timer execution use real code.
  const checkpoint={observations:[{invocation:{tool_name:'runtime_pack_run',request_id:original.request_id,effect:'local_write',dispatched:true,arguments:{recipe,work_id:original.id}},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[original.request_id],value:demonstrated}}]};
  api.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(supervisorId,project,original.id,original.revision,'succeeded',JSON.stringify(checkpoint),JSON.stringify({completion_verified:true}),config.fingerprint,0,at,at);
  await api.call('runtime_custom_pack_publish',{key:'specific-watch',title:'My specific status watch',work_id:original.id,supervisor_run_id:supervisorId,pack_run_id:demonstrated.run_id});
  function due(runId){api.store.hermesState.prepare('UPDATE family_watch SET next_ms=? WHERE run_id=?').run(Date.now()-1,runId);}
  function change(workId){const work=api.store.intakeWork(project,workId);api.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify({...work.spec,desired_outcome:'A changed goal needs a different Pack version.'}),project,workId);}
  async function repeat(cycle){
    const prepared=await api.call('runtime_custom_pack_prepare_repeat',{key:'specific-watch',cycle_id:cycle});
    return {prepared,work:api.store.intakeWork(project,prepared.work_id)};
  }
  async function mcp(){
    const client=new Client({name:'custom-timer-contract-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp','--config',hostPath],stderr:'pipe'});
    closers.push(()=>client.close());await client.connect(transport);return client;
  }
  return {api,config,project,ready,run,due,change,repeat,mcp,requests:()=>requests,setStatus(value){status=value;}};
}
const value=result=>JSON.parse(result.content.find(item=>item.type==='text').text);

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
