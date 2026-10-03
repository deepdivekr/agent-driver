import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {PackStore} from '../dist/packs/store.js';
import {WorkSchedules,nextScheduleSlot,latestScheduleSlot,workScheduleSchema} from '../dist/work/schedule.js';

test('runtime contract schedule, custom Pack schedule and lifecycle entrypoints load independently without ESM initialization cycles',()=>{
 for(const entry of ['schedule','custom-pack-schedule','lifecycle']){
  const url=new URL(`../dist/work/${entry}.js`,import.meta.url).href;
  const child=spawnSync(process.execPath,['--input-type=module','--eval',`await import(${JSON.stringify(url)});`],{encoding:'utf8'});
  assert.equal(child.status,0,`${entry} import failed: ${child.stderr}`);
 }
});

const timestamp=value=>Date.parse(value);
const spec=rule=>({title:'Daily report',desired_outcome:'Collect the current report',completion_checks:[{id:'report',result:'Current report is collected',evidence:'Source readback'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'recurring',rule},questions:[],plan:{revision:0,source:'request',steps:[]}});
const recipe={version:1,family:'research.search',request:'Daily report',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
async function setup(t,definition={kind:'daily',timezone:'Asia/Seoul',hour:20,minute:0}){
 const root=await mkdtemp(join(tmpdir(),'work-schedule-')),store=new PackStore(join(root,'runtime.sqlite')),project='schedule-test';
 let now=timestamp('2026-09-29T08:00:00Z'),calls=0;const model={calls:[],async call(){calls++;return definition;}},clock=()=>now;
 const work=store.beginWork(project,'schedule-request','Collect the report every day at 20:00','quick').work,owner=store.claimWorkDefinition(project,work.id);store.finishWorkDefinition(project,work.id,owner,spec('Every day at 20:00 in Asia/Seoul'),[],'ready');
 const schedules=new WorkSchedules(store,project,{clock,default_timezone:'Asia/Seoul'});
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return {root,store,project,work:store.intakeWork(project,work.id),schedules,model,clock,setTime(value){now=typeof value==='number'?value:timestamp(value);},calls(){return calls;}};
}
test('runtime contract recurrence normalizes once, start authorizes future execution, and unsupported rules wait visibly',async t=>{
 const x=await setup(t),prepared=await x.schedules.prepare(x.work.id,x.work.revision,x.model);
 assert.equal(prepared.state,'disabled');assert.equal(prepared.timezone,'Asia/Seoul');assert.equal(x.calls(),1);
 await x.schedules.prepare(x.work.id,x.work.revision,x.model);assert.equal(x.calls(),1);
 assert.throws(()=>x.schedules.enable(x.work.id,x.work.revision,{acknowledged:false}),/SCHEDULE_WORK_START_REQUIRED/);
 const active=x.schedules.enable(x.work.id,x.work.revision,{acknowledged:true});assert.equal(active.next_run_at,'2026-09-29T11:00:00.000Z');assert.equal(active.enabled,true);
 assert.throws(()=>x.schedules.enable(x.work.id,99,{acknowledged:true}),/WORK_REVISION_CONFLICT/);
 const other=await setup(t,{kind:'unsupported',reason:'Event-based triggers require a connected event source.'});
 assert.equal((await other.schedules.prepare(other.work.id,other.work.revision,other.model)).state,'waiting_config');
 assert.throws(()=>other.schedules.enable(other.work.id,other.work.revision,{acknowledged:true}),/SCHEDULE_CONFIGURATION_REQUIRED/);
 assert.match(other.schedules.status(other.work.id).reason,/Event-based/);
 assert.equal(workScheduleSchema.safeParse({kind:'daily',timezone:'unknown/not-real',hour:20,minute:0}).success,false);
});
test('runtime contract each Work keeps its explicit browser timezone across restart and future prepare',async t=>{
 const x=await setup(t),scheduler=new WorkSchedules(x.store,x.project,{clock:x.clock,default_timezone:'UTC'});let calls=0,received;
 const model={calls:[],async call(_purpose,_instructions,input){calls++;received=input;return {kind:'daily',timezone:input.default_timezone,hour:20,minute:0};}};
 await scheduler.prepare(x.work.id,x.work.revision,model,{default_timezone:'Asia/Seoul'});assert.equal(received.default_timezone,'Asia/Seoul');
 assert.equal(scheduler.enable(x.work.id,x.work.revision,{acknowledged:true}).next_run_at,'2026-09-29T11:00:00.000Z');
 const restarted=new WorkSchedules(x.store,x.project,{clock:x.clock,default_timezone:'UTC'});await restarted.prepare(x.work.id,x.work.revision,model);assert.equal(calls,1);assert.equal(restarted.status(x.work.id).timezone,'Asia/Seoul');
});
test('runtime native SQLite missed slots coalesce once, duplicate claim is fenced, and a known run blocks overlap',async t=>{
 const x=await setup(t);await x.schedules.prepare(x.work.id,x.work.revision,x.model);x.schedules.enable(x.work.id,x.work.revision,{acknowledged:true});
 x.setTime('2026-10-03T11:05:00Z');const due=x.schedules.due();assert.equal(due.length,1);assert.equal(due[0].scheduled_at,'2026-10-03T11:00:00.000Z');assert.equal(due[0].coalesced,true);
 const claim=x.schedules.claim(due[0]);assert.ok(claim);assert.equal(x.schedules.claim(due[0]),null);
 const run=x.store.beginPack(x.project,'scheduled-slot-'+due[0].slot_key.slice(0,12),recipe,'fixture-config',x.work.id).run;
 x.schedules.markStarted(claim,run.id);x.setTime('2026-10-04T11:05:00Z');assert.deepEqual(x.schedules.due(),[]);
 x.store.finishPack(x.project,run.id,'succeeded',{rows:[{id:'actual-receipt'}]});
 assert.equal(x.schedules.due().length,1);assert.equal(x.schedules.due()[0].scheduled_at,'2026-10-04T11:00:00.000Z');
 assert.equal(x.store.hermesState.prepare('SELECT state FROM office_work_schedule_slot').get().state,'finished');
 assert.equal(x.schedules.status(x.work.id).enabled,true);assert.equal(x.store.officeRuns(x.project,x.work.id).length,1);
});
test('runtime native restart reclaims an undispatched slot and keeps one normalized definition',async t=>{
 const x=await setup(t);await x.schedules.prepare(x.work.id,x.work.revision,x.model);x.schedules.enable(x.work.id,x.work.revision,{acknowledged:true});
 x.setTime('2026-09-29T11:00:00Z');const due=x.schedules.due()[0],claim=x.schedules.claim(due);assert.ok(claim);
 const observer=new PackStore(join(x.root,'runtime.sqlite'));try{
  const restarted=new WorkSchedules(observer,x.project,{clock:x.clock,default_timezone:'Asia/Seoul'});assert.equal(restarted.status(x.work.id).next_run_at,'2026-09-30T11:00:00.000Z');
  x.setTime('2026-09-29T11:00:31Z');const recovered=restarted.due();assert.equal(recovered.length,1);assert.equal(recovered[0].slot_key,due.slot_key);assert.ok(restarted.claim(recovered[0]));
  await restarted.prepare(x.work.id,x.work.revision,x.model);assert.equal(x.calls(),1);
 }finally{observer.close();}
});
test('runtime contract pause blocks scheduled dispatch, resumption coalesces, and imported Work keeps the original scheduler',async t=>{
 const x=await setup(t);await x.schedules.prepare(x.work.id,x.work.revision,x.model);x.schedules.enable(x.work.id,x.work.revision,{acknowledged:true});
 let paused=x.store.setIntakePaused(x.project,x.work.id,x.work.revision,true);x.setTime('2026-10-01T12:00:00Z');assert.deepEqual(x.schedules.due(),[]);assert.equal(x.schedules.status(x.work.id).state,'paused');
 const resumed=x.store.setIntakePaused(x.project,x.work.id,paused.revision,false);assert.equal(x.schedules.due()[0].work_revision,resumed.revision);assert.equal(x.schedules.due()[0].coalesced,true);
 const time=new Date().toISOString();x.store.hermesState.prepare('INSERT INTO office_import VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),x.project,'pasted','accepted','{}','import-hash',x.work.id,time,time);
 const original=await x.schedules.prepare(x.work.id,resumed.revision,x.model);assert.equal(original.owner,'original_runtime');assert.equal(original.state,'original_runtime');assert.equal(original.next_run_at,null);assert.equal(x.calls(),1);assert.deepEqual(x.schedules.due(),[]);
 assert.throws(()=>x.schedules.enable(x.work.id,resumed.revision,{acknowledged:true}),/SCHEDULE_ORIGINAL_RUNTIME_AUTHORITY/);
});
test('runtime unit timezone DST gap skips the missing local time and fold runs only once',()=>{
 const gap={kind:'daily',timezone:'America/New_York',hour:2,minute:30};
 assert.equal(new Date(nextScheduleSlot(gap,timestamp('2026-03-08T00:00:00Z'),timestamp('2026-03-01T00:00:00Z'))).toISOString(),'2026-03-09T06:30:00.000Z');
 const fold={kind:'daily',timezone:'America/New_York',hour:1,minute:30},anchor=timestamp('2026-10-01T00:00:00Z');
 assert.equal(new Date(nextScheduleSlot(fold,timestamp('2026-11-01T00:00:00Z'),anchor)).toISOString(),'2026-11-01T05:30:00.000Z');
 assert.equal(new Date(nextScheduleSlot(fold,timestamp('2026-11-01T05:31:00Z'),anchor)).toISOString(),'2026-11-02T06:30:00.000Z');
 assert.equal(new Date(latestScheduleSlot(fold,timestamp('2026-11-01T06:31:00Z'),anchor)).toISOString(),'2026-11-01T05:30:00.000Z');
 const weekly={kind:'weekly',timezone:'Asia/Seoul',hour:20,minute:0,weekdays:[0]};
 assert.equal(new Date(nextScheduleSlot(weekly,timestamp('2026-09-29T00:00:00Z'),timestamp('2026-09-01T00:00:00Z'))).toISOString(),'2026-10-04T11:00:00.000Z');
 const interval={kind:'interval',timezone:'UTC',seconds:3600},start=timestamp('2026-09-29T08:00:00Z');
 assert.equal(nextScheduleSlot(interval,start,start),start+3600_000);assert.equal(latestScheduleSlot(interval,start+6*3600_000+1,start),start+6*3600_000);
});

// Owner direction 2026-10-03: "오전 8시 30분, 저녁 9시 30분" — a Work that runs twice a day.
test('runtime contract a daily schedule with two clock times runs at both, in order, and an earlier saved schedule reads as before',async()=>{
  const {scheduleFromProposal,normalizeExplicitWorkSchedule,nextScheduleSlot,latestScheduleSlot}=await import('../dist/work/schedule.js');
  const proposed=scheduleFromProposal({kind:'daily',timezone:'Asia/Seoul',hour:21,minute:30,also_at:[{hour:8,minute:30}],weekdays:null,seconds:null,reason:null},'UTC');
  const schedule=normalizeExplicitWorkSchedule(proposed);
  assert.deepEqual(schedule,{kind:'daily',timezone:'Asia/Seoul',hour:8,minute:30,also_at:[{hour:21,minute:30}]},'Times are kept in order, the earliest first.');
  const kst=(day,hm)=>Date.parse(`2026-10-${day}T${hm}:00+09:00`),anchor=kst('01','00:00');
  assert.equal(nextScheduleSlot(schedule,kst('03','10:00'),anchor),kst('03','21:30'));
  assert.equal(nextScheduleSlot(schedule,kst('03','21:30'),anchor),kst('04','08:30'));
  assert.equal(nextScheduleSlot(schedule,kst('03','07:00'),anchor),kst('03','08:30'));
  assert.equal(latestScheduleSlot(schedule,kst('03','22:00'),anchor),kst('03','21:30'));
  assert.equal(latestScheduleSlot(schedule,kst('03','12:00'),anchor),kst('03','08:30'));
  assert.throws(()=>normalizeExplicitWorkSchedule({kind:'daily',timezone:'Asia/Seoul',hour:8,minute:30,also_at:[{hour:8,minute:30}]}),/SCHEDULE_TIME_DUPLICATE/u);
  const single=normalizeExplicitWorkSchedule({kind:'daily',timezone:'Asia/Seoul',hour:9,minute:0});
  assert.deepEqual(single,{kind:'daily',timezone:'Asia/Seoul',hour:9,minute:0});assert.equal(nextScheduleSlot(single,kst('03','10:00'),anchor),kst('04','09:00'));
  assert.deepEqual(scheduleFromProposal({kind:'daily',timezone:'Asia/Seoul',hour:9,minute:0,also_at:null,weekdays:null,seconds:null,reason:null},'UTC'),single,'No extra time gives the same schedule as before.');
});
