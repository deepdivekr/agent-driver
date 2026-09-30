import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {lifecycleActionSchema,readWorkLifecycle,assertWorkConnected,assertBoundRunConnected,changeWorkLifecycle} from '../dist/work/lifecycle.js';
import {initHermesWorks} from '../dist/work/hermes.js';
import {RemoteOffice} from '../dist/work/remote.js';
import {WorkSchedules} from '../dist/work/schedule.js';
import {WorkSupervisor} from '../dist/work/supervisor.js';
import {WorkRuntime} from '../dist/work/runtime.js';

const proposal={
  title:'원본 자료 점검',desired_outcome:'로컬 원본의 값만 확인한다',
  completion_checks:[{id:'source',result:'원본 값 23 확인',evidence:'실제 원본 조회'}],
  assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',
  recurrence:{kind:'once',rule:null},questions:[],
};

async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'work-lifecycle-'));
  const host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',value:23}]));
  await writeFile(host,JSON.stringify({
    schema_version:1,project_id:'lifecycle-fixture',caller_ref:'fixture-owner',account_ref:'fixture-owner',
    worktree:root,data_dir:join(root,'data'),environment:'production',
    packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},
    swarm:{enabled:true,model_data_approved:true},
  }));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);
  store.registerProject(config.project);
  const begun=store.beginWork(config.project.id,randomUUID(),'원본 자료를 확인해줘','quick').work;
  const owner=store.claimWorkDefinition(config.project.id,begun.id);
  assert.ok(owner);
  const work=store.finishWorkDefinition(config.project.id,begun.id,owner,{...proposal,...options.proposal},[],'ready');
  const cleanup=[];
  t.after(async()=>{for(const operation of cleanup.reverse())await operation();store.close();await rm(root,{recursive:true,force:true});});
  return {root,host,config,store,work,cleanup,project:config.project.id};
}

function input(x,action,overrides={}){
  const lifecycle=readWorkLifecycle(x.store,x.project,x.work.id);
  return {work_id:x.work.id,revision:lifecycle.revision,work_revision:lifecycle.work_revision,action,confirmed:true,...overrides};
}

test('fixture lifecycle action requires explicit confirmation, exact revision and no extra fields',()=>{
  const valid={work_id:randomUUID(),revision:0,work_revision:1,action:'disconnect',confirmed:true};
  assert.equal(lifecycleActionSchema.safeParse(valid).success,true);
  for(const invalid of [{...valid,confirmed:false},{...valid,revision:-1},{...valid,work_revision:-1},{...valid,extra:'silently accepted'},{...valid,action:'stop-original-bot'}]){
    assert.equal(lifecycleActionSchema.safeParse(invalid).success,false);
  }
});

test('fixture lifecycle read is side-effect free and scoped to project and Work',async t=>{
  const x=await setup(t),db=x.store.hermesState;
  const before=Number(db.prepare('SELECT total_changes() AS n').get().n);
  const lifecycle=readWorkLifecycle(x.store,x.project,x.work.id);
  assert.equal(lifecycle.state,'connected');
  assert.equal(lifecycle.revision,0);
  assert.equal(lifecycle.work_revision,x.work.revision);
  assert.equal(Number(db.prepare('SELECT total_changes() AS n').get().n),before);
  assert.doesNotThrow(()=>assertWorkConnected(x.store,x.project,x.work.id));
  assert.throws(()=>readWorkLifecycle(x.store,'unrelated-project',x.work.id),/WORK_NOT_FOUND|WORK_LIFECYCLE/);
});

test('fixture disconnect preserves definition, revisions, existing records and runtime configuration',async t=>{
  const x=await setup(t),db=x.store.hermesState;
  const hostBefore=await readFile(x.host),definition=x.store.intakeWork(x.project,x.work.id);
  const revisions=x.store.workRevisions(x.project,x.work.id);
  const auditAt=new Date().toISOString();
  db.prepare('INSERT INTO office_context_delivery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),x.project,x.work.id,'fixture-read-only',null,1,'a'.repeat(64),16,0,'[]',null,'unobserved','unobserved',null,null,null,auditAt);
  const retained=db.prepare('SELECT * FROM office_context_delivery WHERE project_id=? AND work_id=?').all(x.project,x.work.id);
  const changed=changeWorkLifecycle(x.store,x.project,input(x,'disconnect'));
  assert.equal(changed.work_id,x.work.id);
  assert.equal(changed.lifecycle.state,'disconnected');
  assert.equal(changed.original_runtime_unchanged,true);
  assert.equal(changed.records_preserved,true);
  assert.deepEqual(x.store.intakeWork(x.project,x.work.id),definition);
  assert.deepEqual(x.store.workRevisions(x.project,x.work.id),revisions);
  assert.deepEqual(db.prepare('SELECT * FROM office_context_delivery WHERE project_id=? AND work_id=?').all(x.project,x.work.id),retained);
  assert.deepEqual(await readFile(x.host),hostBefore);
  assert.throws(()=>assertWorkConnected(x.store,x.project,x.work.id),/WORK_DISCONNECTED/);
});

test('fixture lifecycle CAS rejects stale action and Work revision without changing existing state',async t=>{
  const x=await setup(t),first=input(x,'disconnect');
  changeWorkLifecycle(x.store,x.project,first);
  const before=readWorkLifecycle(x.store,x.project,x.work.id);
  assert.throws(()=>changeWorkLifecycle(x.store,x.project,first),/REVISION|LIFECYCLE/);
  assert.throws(()=>changeWorkLifecycle(x.store,x.project,{...input(x,'remove'),work_revision:x.work.revision+1}),/REVISION/);
  assert.deepEqual(readWorkLifecycle(x.store,x.project,x.work.id),before);
});

test('fixture removed Work disappears from active lists but remains readable with its receipts',async t=>{
  const x=await setup(t),db=x.store.hermesState;
  const marker='fixture receipt, not a live effect';
  db.prepare('INSERT INTO office_context_delivery VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),x.project,x.work.id,marker,null,1,'b'.repeat(64),12,0,'[]',null,'unobserved','unobserved',null,null,null,new Date().toISOString());
  const historical=db.prepare('SELECT * FROM office_context_delivery WHERE work_id=?').all(x.work.id);
  const original=x.store.officeWorkById(x.project,x.work.id);
  assert.ok(x.store.officeWorkSummaries(x.project).some(item=>item.id===x.work.id));
  assert.ok(x.store.intakeWorks(x.project).some(item=>item.id===x.work.id));
  const changed=changeWorkLifecycle(x.store,x.project,input(x,'remove'));
  assert.equal(changed.lifecycle.state,'removed');
  assert.ok(!x.store.officeWorkSummaries(x.project).some(item=>item.id===x.work.id));
  assert.ok(!x.store.intakeWorks(x.project).some(item=>item.id===x.work.id));
  assert.deepEqual(x.store.officeWorkById(x.project,x.work.id),original);
  assert.deepEqual(db.prepare('SELECT * FROM office_context_delivery WHERE work_id=?').all(x.work.id),historical);
  assert.throws(()=>assertWorkConnected(x.store,x.project,x.work.id),/WORK_REMOVED/);
  const repeated=changeWorkLifecycle(x.store,x.project,input(x,'remove'));
  assert.equal(repeated.deduplicated,true);
  assert.equal(repeated.lifecycle.revision,changed.lifecycle.revision);
});

test('fixture detaching a linked original Hermes bot does not stop or alter that bot',async t=>{
  const x=await setup(t),db=x.store.hermesState;
  initHermesWorks(x.store);
  const at=new Date().toISOString();
  db.prepare('INSERT INTO hermes_work(work_id,project_id,import_key,definition,state,updated_at) VALUES(?,?,?,?,?,?)').run(x.work.id,x.project,'existing-original-bot',JSON.stringify({title:'Original bot',goal:'Preserve its independent operation'}),'running',at);
  const old=db.prepare('SELECT * FROM hermes_work WHERE work_id=?').get(x.work.id);
  const changed=changeWorkLifecycle(x.store,x.project,input(x,'disconnect'));
  assert.equal(changed.lifecycle.state,'disconnected');
  assert.deepEqual(db.prepare('SELECT * FROM hermes_work WHERE work_id=?').get(x.work.id),old);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM hermes_turn WHERE work_id=?').get(x.work.id).n,0);
  assert.equal(changed.original_runtime_unchanged,true);
});

test('fixture detaching a remote job does not call original RPC or alter its observed row',async t=>{
  const x=await setup(t),db=x.store.hermesState,calls=[];
  const remote=new RemoteOffice(x.store,x.config,{async call(...args){calls.push(args);throw Error('ORIGINAL_RPC_MUST_NOT_RUN');}});
  x.cleanup.push(()=>remote.drain());
  const target=randomUUID();
  db.prepare('INSERT INTO office_remote_target VALUES(?,?,?,?)').run(target,x.project,'{}',new Date().toISOString());
  db.prepare('INSERT INTO office_remote_work(work_id,project_id,target_id,kind,source_id,title,state) VALUES(?,?,?,?,?,?,?)').run(x.work.id,x.project,target,'job','original-job','Original job','running');
  const old=db.prepare('SELECT * FROM office_remote_work WHERE work_id=?').get(x.work.id);
  changeWorkLifecycle(x.store,x.project,input(x,'remove'));
  assert.deepEqual(db.prepare('SELECT * FROM office_remote_work WHERE work_id=?').get(x.work.id),old);
  assert.equal(calls.length,0);
});

test('fixture bound Pack history stays readable while old request-ID replay is fenced',async t=>{
  const x=await setup(t),recipe={version:1,family:'research.search',request:'Inspect a local source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['id'],sort:null,limit:10};
  const requestId=randomUUID(),begun=x.store.beginPack(x.project,requestId,recipe,x.config.fingerprint,x.work.id);
  x.store.finishPack(x.project,begun.run.id,'needs_review',{fixture_only:true,effect:'none',verification:'unobserved'});
  const oldPack=x.store.packRun(x.project,begun.run.id),oldRuns=x.store.officeRuns(x.project,x.work.id);
  changeWorkLifecycle(x.store,x.project,input(x,'remove'));
  assert.deepEqual(x.store.packRun(x.project,begun.run.id),oldPack);
  assert.deepEqual(x.store.officeRuns(x.project,x.work.id),oldRuns);
  assert.throws(()=>assertBoundRunConnected(x.store,x.project,'pack',begun.run.id),/WORK_REMOVED/);
  assert.throws(()=>x.store.beginPack(x.project,requestId,recipe,x.config.fingerprint,x.work.id),/WORK_REMOVED/);
});

test('fixture live Office lease blocks detachment, while a queued run cannot dispatch after detachment',async t=>{
  const x=await setup(t),modelCalls=[];
  const model={async call(...args){modelCalls.push(args);throw Error('MODEL_MUST_NOT_RUN');}};
  const supervisor=new WorkSupervisor(x.store,x.config,model,{auto_start:false,tick_ms:20});
  x.cleanup.push(()=>supervisor.close());
  const db=x.store.hermesState,runId=randomUUID(),at=new Date().toISOString();
  db.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,owner,lease_until_ms,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,x.project,x.work.id,x.work.revision,'running','null','fixture-lease',Date.now()+60_000,x.config.fingerprint,0,at,at);
  assert.throws(()=>changeWorkLifecycle(x.store,x.project,input(x,'disconnect')),/WORK_LIFECYCLE_BUSY/);
  assert.equal(readWorkLifecycle(x.store,x.project,x.work.id).state,'connected');
  db.prepare("UPDATE office_supervisor SET state='queued',owner=NULL,lease_until_ms=0 WHERE run_id=?").run(runId);
  changeWorkLifecycle(x.store,x.project,input(x,'disconnect'));
  assert.throws(()=>supervisor.start(x.work.id,x.work.revision,true),/WORK_DISCONNECTED/);
  supervisor.activate();
  await delay(80);
  const row=db.prepare('SELECT state,owner,attempts FROM office_supervisor WHERE run_id=?').get(runId);
  assert.notEqual(row.state,'running');
  assert.equal(row.owner,null);
  assert.equal(modelCalls.length,0);
  assert.equal(x.store.officeRuns(x.project,x.work.id).length,0);
});

test('fixture dispatched uncertain write requires reconciliation before disconnection',async t=>{
  const x=await setup(t),model={async call(){throw Error('MODEL_MUST_NOT_RUN');}};
  const supervisor=new WorkSupervisor(x.store,x.config,model,{auto_start:false});
  x.cleanup.push(()=>supervisor.close());
  const db=x.store.hermesState,runId=randomUUID(),at=new Date().toISOString();
  const checkpoint={format:1,work_id:x.work.id,run_id:runId,turn:1,pending:{request_id:'uncertain-effect',turn:0,stage_id:'submit',tool_name:'runtime_pack_run',arguments:{},effect:'external_write',dispatched:true},observations:[],summary:'No host receipt was observed.'};
  db.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(runId,x.project,x.work.id,x.work.revision,'failed',JSON.stringify(checkpoint),x.config.fingerprint,0,at,at);
  assert.throws(()=>changeWorkLifecycle(x.store,x.project,input(x,'remove')),/WORK_LIFECYCLE_RECONCILIATION_REQUIRED/);
  assert.equal(readWorkLifecycle(x.store,x.project,x.work.id).state,'connected');
  assert.deepEqual(JSON.parse(db.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(runId).checkpoint),checkpoint);
});

test('fixture Office schedule cannot fire or be enabled after disconnect',async t=>{
  const x=await setup(t,{proposal:{recurrence:{kind:'recurring',rule:'Every day at 20:00 UTC'}}});
  const clock=()=>Date.parse('2026-09-29T12:00:00Z'),schedule=new WorkSchedules(x.store,x.project,{clock,default_timezone:'UTC'});
  const modelCalls=[],model={async call(...args){modelCalls.push(args);return {kind:'daily',timezone:'UTC',hour:20,minute:0};}};
  const prepared=await schedule.prepare(x.work.id,x.work.revision,model);
  assert.equal(prepared.state,'disabled');
  schedule.enable(x.work.id,x.work.revision,{acknowledged:true});
  const due=schedule.due(Date.parse('2026-09-29T20:01:00Z')).find(item=>item.work_id===x.work.id);
  assert.ok(due);
  changeWorkLifecycle(x.store,x.project,input(x,'disconnect'));
  assert.ok(!schedule.due(Date.parse('2026-09-29T20:01:00Z')).some(item=>item.work_id===x.work.id));
  assert.throws(()=>schedule.claim(due),/WORK_DISCONNECTED/);
  assert.throws(()=>schedule.enable(x.work.id,x.work.revision,{acknowledged:true}),/WORK_DISCONNECTED/);
  assert.equal(modelCalls.length,1);
});

test('fixture late definition result cannot revive a detached Work or launch an execution',async t=>{
  const x=await setup(t),db=x.store.hermesState;
  let release,started,id;
  const gate=new Promise(resolve=>{release=resolve;});
  x.cleanup.push(async()=>{release();});
  const entered=new Promise(resolve=>{started=resolve;});
  const model={async call(){started();await gate;return proposal;}};
  const runtime=new WorkRuntime(x.store,x.config,model);
  const task=runtime.start({request_id:randomUUID(),prompt:'별도의 자료를 조사해줘',intake_mode:'quick'},value=>{id=value.work_id;});
  await entered;
  assert.ok(id);
  db.prepare('UPDATE office_intake SET define_lease_until_ms=0 WHERE work_id=?').run(id);
  const lifecycle=readWorkLifecycle(x.store,x.project,id);
  changeWorkLifecycle(x.store,x.project,{work_id:id,revision:lifecycle.revision,work_revision:lifecycle.work_revision,action:'remove',confirmed:true});
  release();
  await assert.rejects(task,/WORK_REMOVED/);
  assert.equal(readWorkLifecycle(x.store,x.project,id).state,'removed');
  assert.equal(x.store.intakeWork(x.project,id).spec,null);
  assert.equal(x.store.officeRuns(x.project,id).length,0);
  assert.ok(!x.store.officeWorkSummaries(x.project).some(item=>item.id===id));
});
