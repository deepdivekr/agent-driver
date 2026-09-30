import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime,PACK_ENGINE_VERSION} from '../dist/packs/runtime.js';
import {CustomPackRegistry} from '../dist/packs/custom-registry.js';
import {nativeOutputCertificate} from '../dist/packs/native-output-certificate.js';
import {CustomPackRepeats} from '../dist/work/custom-pack-repeat.js';
import {CustomPackSchedules,assertCustomPackScheduledRun,customPackScheduledParent} from '../dist/work/custom-pack-schedule.js';
import {WorkSchedules} from '../dist/work/schedule.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {bindWorkIntakeOptions} from '../dist/work/intake-options.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';

const recipe={version:1,family:'portal.collect',request:'Save current weekly source rows',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
const proposal={title:'주간 목록 저장',desired_outcome:'현재 원본 전체를 저장한다',completion_checks:[{id:'rows',result:'전체 원본 행을 결과에 저장한다',evidence:'현재 원본과 출력 재읽기'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'read_only',recurrence:{kind:'recurring',rule:'Every week'},questions:[]};
const interval={kind:'interval',timezone:'UTC',seconds:60};
const configure=(x,extras={})=>({key:'weekly',parent_revision:x.store.intakeWork(x.project,x.parent.id).revision,definition:interval,cost_acknowledged:true,recurrence_acknowledged:true,...extras});
function supervisor(x,work,state='queued',checkpoint=null,result=null){
  const runId=randomUUID(),at=new Date(x.clock.now).toISOString();
  x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,result,config_hash,model_revision,current_run_only,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(runId,x.project,work.id,work.revision,state,JSON.stringify(checkpoint),result===null?null:JSON.stringify(result),x.config.fingerprint,0,1,at,at);return runId;
}
async function verifiedSource(x,definition=recipe){
  const value=await x.runtime.call('runtime_pack_run',{request_id:randomUUID(),work_id:x.parent.id,recipe:definition});assert.equal(value.status,'succeeded');
  const run=x.store.packRun(x.project,value.run_id),checkpoint={observations:[{invocation:{request_id:run.request_id,tool_name:'runtime_pack_run',arguments:{recipe:definition},effect:'local_write',dispatched:true},receipt:{status:'succeeded',effect_state:'verified',evidence_ids:[run.request_id],value}}]},id=supervisor(x,x.parent,'succeeded',checkpoint,{completion_verified:true});
  return x.registry.publishVerified(x.project,{key:'weekly',title:'내 주간 목록',work_id:x.parent.id,supervisor_run_id:id,pack_run_id:run.id},x.host).pack;
}
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'office-custom-schedule-')),source=join(root,'source.json'),path=join(root,'host.json');
  await writeFile(source,JSON.stringify([{id:'first',value:1}]));await writeFile(path,JSON.stringify({schema_version:1,project_id:'custom-schedule-test',caller_ref:'schedule-agent',account_ref:'account-a',worktree:root,data_dir:join(root,'runtime'),packs:{models:'off',sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[]}}));
  const config=loadHostConfig(path),project=config.project.id,store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkSupervisor(store);
  const incoming=store.beginWork(project,randomUUID(),'Save all current source rows on each approved recurring execution.','quick').work;
  bindWorkIntakeOptions(store,project,incoming.id,{completion_condition:'Preserve all source rows and fields.',delivery_target_ids:null});
  const owner=store.claimWorkDefinition(project,incoming.id),parent=store.finishWorkDefinition(project,incoming.id,owner,structuredClone(proposal),[],'ready');
  const registry=new CustomPackRegistry(store),repeats=new CustomPackRepeats(store,registry),clock={now:Date.now()},schedules=new WorkSchedules(store,project,{clock:()=>clock.now}),service=new CustomPackSchedules(store,project,registry,repeats,schedules),runtime=new FamilyRuntime(store,config),host={config_fingerprint:config.fingerprint,engine_binding:snapshotHash({config:config.fingerprint,engine:PACK_ENGINE_VERSION})};
  t.after(async()=>{await runtime.drain();store.close();await rm(root,{recursive:true,force:true});});
  const x={root,source,config,project,store,parent,registry,repeats,schedules,service,runtime,host,clock};x.version=await verifiedSource(x);return x;
}
function startSlot(x,due){
  const child=x.service.prepareDue(due,x.host);
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host),/CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED/u);
  const db=x.store.hermesState;db.exec('SAVEPOINT test_schedule_start');
  try{const claim=x.schedules.claim(due);assert.ok(claim);const runId=supervisor(x,child.work);x.schedules.markStarted(claim,runId,child.work.id);db.exec('RELEASE test_schedule_start');return {...child,claim,runId};}
  catch(error){db.exec('ROLLBACK TO test_schedule_start; RELEASE test_schedule_start');throw error;}
}

test('runtime custom schedule: supported explicit consent configures existing scheduler without model or Work goal changes',async t=>{
  const x=await fixture(t),before=x.store.intakeWork(x.project,x.parent.id);
  assert.throws(()=>x.service.configure(configure(x,{cost_acknowledged:false}),x.host));
  assert.throws(()=>x.service.configure(configure(x,{recurrence_acknowledged:false}),x.host));
  assert.throws(()=>x.service.configure(configure(x,{definition:{kind:'unsupported',reason:'Monthly'}}),x.host));
  assert.equal(x.service.status(x.parent.id),null);
  const ready=x.service.configure(configure(x),x.host);assert.equal(ready.schedule.enabled,true);assert.deepEqual(ready.schedule.definition,interval);assert.equal(ready.parent_work_id,x.parent.id);
  assert.deepEqual(x.store.intakeWork(x.project,x.parent.id).spec,before.spec);assert.equal(x.store.intakeWork(x.project,x.parent.id).prompt,before.prompt);
  assert.equal(x.schedules.due().length,0);x.clock.now+=65_000;assert.equal(x.schedules.due().length,1);
  const observer=new PackStore(x.config.dbPath);
  try{const schedules=new WorkSchedules(observer,x.project,{clock:()=>x.clock.now}),registry=new CustomPackRegistry(observer),service=new CustomPackSchedules(observer,x.project,registry,new CustomPackRepeats(observer,registry),schedules);assert.equal(service.status(x.parent.id).version,1);assert.equal(schedules.due()[0].slot_key,x.schedules.due()[0].slot_key);}finally{observer.close();}
});

test('runtime custom schedule fixture: two due occurrences have independent Works, requests, actual artifacts and native proof',async t=>{
  const x=await fixture(t);x.service.configure(configure(x),x.host);
  const original=x.store.packRun(x.project,x.version.source.pack_run_id),originalText=await readFile(original.result.artifact.path,'utf8');
  const completed=[];
  for(const [offset,rows] of [[65_000,[{id:'first',value:1}]],[60_000,[{id:'second',value:2}]]]){
    x.clock.now+=offset;await writeFile(x.source,JSON.stringify(rows));const due=x.schedules.due()[0];assert.ok(due);
    const child=startSlot(x,due);assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host,child.runId);
    assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host,'foreign-run'),/SCHEDULE_RUN_BINDING_MISMATCH/u);
    const result=await x.runtime.call('runtime_pack_run',{request_id:child.prepared.request_id,work_id:child.work.id,recipe:child.prepared.recipe});assert.equal(result.status,'succeeded');
    const actual=JSON.parse(await readFile(result.result.artifact.path,'utf8'));assert.deepEqual(actual,rows);
    const proof=await nativeOutputCertificate(x.store,x.config,x.store.packRun(x.project,result.run_id));assert.equal(proof.exact_native_bytes_match,true);assert.equal(proof.run_id,result.run_id);assert.equal(proof.user_goal_verified,'not_asserted');
    // The scheduling test's host goal verdict is a fixture; the fresh file and
    // native proof above are actual. Integration tests exercise real supervisor.
    x.store.hermesState.prepare("UPDATE office_supervisor SET state='succeeded',result=? WHERE run_id=?").run(JSON.stringify({completion_verified:true}),child.runId);
    x.schedules.finish(x.parent.id,due.slot_key,child.runId);completed.push({child,result,proof});
  }
  assert.notEqual(completed[0].child.work.id,completed[1].child.work.id);assert.notEqual(completed[0].child.prepared.request_id,completed[1].child.prepared.request_id);assert.notEqual(completed[0].result.run_id,completed[1].result.run_id);assert.notEqual(completed[0].proof.artifact_sha256,completed[1].proof.artifact_sha256);
  assert.equal(await readFile(original.result.artifact.path,'utf8'),originalText);
  assert.deepEqual(x.registry.get(x.project,'weekly',1).completion_contract,x.version.completion_contract);
});

test('runtime custom schedule: review holds slot, parent pause/detach/changed contract holds child and disable stops future occurrences',async t=>{
  const x=await fixture(t);x.service.configure(configure(x),x.host);x.clock.now+=65_000;const due=x.schedules.due()[0],child=startSlot(x,due);
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='awaiting_review' WHERE run_id=?").run(child.runId);x.clock.now+=60_000;
  assert.deepEqual(x.schedules.due(),[]);assert.throws(()=>x.schedules.finish(x.parent.id,due.slot_key,child.runId),/SCHEDULE_RUN_NOT_FINISHED/u);
  let parent=x.store.intakeWork(x.project,x.parent.id);parent=x.store.setIntakePaused(x.project,parent.id,parent.revision,true);
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host),/WORK_PAUSED/u);assert.deepEqual(x.schedules.due(),[]);
  parent=x.store.setIntakePaused(x.project,parent.id,parent.revision,false);assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host);
  x.service.disable({parent_work_id:parent.id,parent_revision:parent.revision});assert.equal(x.service.status(parent.id).schedule.enabled,false);
  assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host);assert.deepEqual(x.schedules.due(),[]);
  const db=x.store.hermesState;db.prepare('INSERT INTO office_work_lifecycle VALUES(?,?,?,?,?)').run(parent.id,x.project,'disconnected',1,new Date().toISOString());
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host),/WORK_DISCONNECTED/u);db.prepare('DELETE FROM office_work_lifecycle WHERE work_id=?').run(parent.id);
  const modified=structuredClone(parent.spec);modified.desired_outcome='Different business goal';db.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify(modified),parent.id);
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host),/CUSTOM_PACK_WORK_CONTRACT_CHANGED/u);
});

test('runtime custom schedule: conflicts are held and explicit version replacement invalidates an unclaimed prior slot',async t=>{
  const x=await fixture(t);x.schedules.configureExplicit(x.parent.id,x.parent.revision,interval,{acknowledged:true});x.schedules.enable(x.parent.id,x.parent.revision,{acknowledged:true});
  assert.throws(()=>x.service.configure(configure(x),x.host),/SCHEDULE_EXISTING_ENABLED_CONFLICT/u);assert.equal(x.service.status(x.parent.id),null);
  x.schedules.disable(x.parent.id,x.parent.revision);x.service.configure(configure(x),x.host);x.clock.now+=65_000;const oldDue=x.schedules.due()[0],orphan=x.service.prepareDue(oldDue,x.host);
  assert.equal(x.store.officeRuns(x.project,orphan.work.id).length,0);
  const version2=await verifiedSource(x,{...recipe,format:'csv'});assert.equal(version2.version,2);
  x.service.configure(configure(x,{version:2}),x.host);assert.equal(x.service.status(x.parent.id).version,2);assert.equal(x.schedules.claim(oldDue),null);
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,orphan.work.id,x.host),/CUSTOM_PACK_SCHEDULE_SLOT_NOT_STARTED/u);
  x.clock.now+=65_000;const latestDue=x.schedules.due()[0];assert.notEqual(latestDue.slot_key,oldDue.slot_key);assert.equal(x.service.prepareDue(latestDue,x.host).prepared.version,2);
});

test('runtime custom schedule: durable execution marker survives mapping loss and cannot be replaced by legacy normalization',async t=>{
  const x=await fixture(t);assert.equal(x.schedules.customPackRequired(x.parent.id),false);x.service.configure(configure(x),x.host);
  assert.equal(x.schedules.customPackRequired(x.parent.id),true);
  x.store.hermesState.prepare('DELETE FROM office_custom_pack_schedule WHERE parent_work_id=?').run(x.parent.id);
  assert.equal(x.schedules.customPackRequired(x.parent.id),true);
  await assert.rejects(x.schedules.prepare(x.parent.id,x.parent.revision,{async call(){assert.fail('must not normalize a custom schedule');}}),/SCHEDULE_CUSTOM_PACK_AUTHORITY/u);
  assert.throws(()=>x.schedules.configureExplicit(x.parent.id,x.parent.revision,interval,{acknowledged:true,replace_existing:true}),/SCHEDULE_CUSTOM_PACK_AUTHORITY/u);
  x.clock.now+=65_000;const due=x.schedules.due()[0];assert.ok(due);
  const claim=x.schedules.claim(due),parentRun=supervisor(x,x.parent);assert.ok(claim);
  assert.throws(()=>x.schedules.markStarted(claim,parentRun),/SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH/u);
  const observer=new PackStore(x.config.dbPath);
  try{const restarted=new WorkSchedules(observer,x.project,{clock:()=>x.clock.now});assert.equal(restarted.customPackRequired(x.parent.id),true);}finally{observer.close();}
});

test('runtime custom schedule: failed child keeps exact recovery identity and successful recovery releases the next occurrence',async t=>{
  const x=await fixture(t);x.service.configure(configure(x),x.host);x.clock.now+=65_000;const due=x.schedules.due()[0],child=startSlot(x,due);
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='failed' WHERE run_id=?").run(child.runId);x.clock.now+=60_000;
  assert.deepEqual(x.schedules.due(),[]);assert.equal(customPackScheduledParent(x.store,x.project,child.work.id).state,'started');
  assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host,child.runId);
  const held=x.service.status(x.parent.id).slots[0];assert.equal(held.child_work_id,child.work.id);assert.equal(held.run_id,child.runId);assert.equal(held.run_state,'failed');assert.equal(held.slot_state,'started');
  assert.throws(()=>x.schedules.finish(x.parent.id,due.slot_key,child.runId),/SCHEDULE_RUN_NOT_FINISHED/u);
  // Explicit same-run recovery is represented here by the host state changes;
  // supervisor integration tests exercise the actual retry command.
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='queued' WHERE run_id=?").run(child.runId);assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host,child.runId);
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='succeeded' WHERE run_id=?").run(child.runId);
  assert.equal(x.schedules.due().length,1);assert.equal(customPackScheduledParent(x.store,x.project,child.work.id).state,'finished');
});

test('runtime custom schedule: lost child metadata parks only its slot and healthy sibling scheduling continues',async t=>{
  const x=await fixture(t);x.service.configure(configure(x),x.host);x.clock.now+=65_000;const due=x.schedules.due()[0],child=startSlot(x,due);
  const incoming=x.store.beginWork(x.project,randomUUID(),'A healthy ordinary scheduled sibling','quick').work,owner=x.store.claimWorkDefinition(x.project,incoming.id),sibling=x.store.finishWorkDefinition(x.project,incoming.id,owner,structuredClone(proposal),[],'ready');
  x.schedules.configureExplicit(sibling.id,sibling.revision,interval,{acknowledged:true});x.schedules.enable(sibling.id,sibling.revision,{acknowledged:true});
  x.store.hermesState.prepare("UPDATE office_supervisor SET state='failed' WHERE run_id=?").run(child.runId);
  x.store.hermesState.prepare('DELETE FROM office_custom_pack_repeat_work WHERE work_id=?').run(child.work.id);
  const parent=x.store.setIntakePaused(x.project,x.parent.id,x.parent.revision,true);
  assert.throws(()=>assertCustomPackScheduledRun(x.store,x.project,child.work.id,x.host,child.runId),/SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH/u);
  x.clock.now+=65_000;const healthy=x.schedules.due();assert.equal(healthy.length,1);assert.equal(healthy[0].work_id,sibling.id);
  const parked=customPackScheduledParent(x.store,x.project,child.work.id);assert.equal(parked.state,'reconciliation_required');
  const status=x.service.status(parent.id).slots[0];assert.equal(status.reason,'SCHEDULE_CUSTOM_WORK_BINDING_MISMATCH');assert.equal(status.slot_state,'reconciliation_required');
  assert.equal(x.schedules.due().length,1);
});
