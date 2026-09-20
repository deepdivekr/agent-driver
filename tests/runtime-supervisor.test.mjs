import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {createServer,request as httpRequest} from 'node:http';
import {startFixture} from '../dist/evaluation-v2/fixture.js';
import {makeCase} from '../dist/evaluation-v2/oracle.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {runWorker} from '../dist/interface/worker.js';
import {Supervisor,launchWorker} from '../dist/supervisor/supervisor.js';
import {RecoveryStore,remainingBudget} from '../dist/supervisor/store.js';
import {processIdentity,liveness,profileOccupancy} from '../dist/supervisor/identity.js';
import {MIGRATION_1,MIGRATION_2} from '../dist/store/migration.js';

const body=id=>({request_id:id,capability:'fixture.draft.save',account_ref:'account-a',input:{name:'중단 시험',note:'저장 중복 금지 🐈'},deadline_ms:60000});
async function until(fn,timeout=15000){const end=performance.now()+timeout;while(performance.now()<end){const value=await fn();if(value)return value;await delay(25);}throw Error('condition timed out');}
function child(x,mode,...args){
  const handle=fork('tests/fixtures/supervisor-harness.mjs',[mode,x.path,...args],{stdio:['ignore','ignore','ignore','ipc']});
  const exited=once(handle,'exit'),message=Promise.race([once(handle,'message').then(([value])=>value),exited.then(()=>{throw Error('harness exited before checkpoint');})]);
  // Not every child is expected to reach a checkpoint (negative controls).
  message.catch(()=>{});const record={handle,exited,message};x.children.push(record);return record;
}
async function kill(record){if(record.handle.exitCode===null&&record.handle.signalCode===null)record.handle.kill('SIGKILL');await record.exited;}
async function setup(t,policy='auto_resume'){
  const root=await mkdtemp(join(tmpdir(),'driver-supervisor-')),fixture=await startFixture(),spec=makeCase('supervision','S02',101,'normal');
  const path=join(root,'host.json'),raw={schema_version:1,project_id:'supervised',caller_ref:'agent',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:fixture.create(spec),recovery_policy:policy};
  await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),api=new RuntimeApi(config);
  const x={root,path,raw,config,api,fixture,spec,children:[],supervisors:[]};
  t.after(async()=>{
    let clear=false;
    try{
      for(const c of x.children)await kill(c);
      for(const s of x.supervisors)if(s.nonce)s.close();
      for(const row of x.api.store.submissions(x.config.project.id)){if(row.worker_identity_json)await until(async()=>await liveness(JSON.parse(row.worker_identity_json))==='dead');}
      await until(async()=>await profileOccupancy(x.config.project.profileRef)==='clear');clear=true;
    }finally{
      try{x.api.close();}finally{await fixture.close();if(clear)await rm(root,{recursive:true,force:true});}
    }
  });return x;
}
async function supervise(x,launch=launchWorker){const s=new Supervisor(x.config,launch);x.supervisors.push(s);await s.start();return s;}
function enqueue(x,id='first',overrides={}){return x.api.store.enqueue(x.config.project.id,id,'fixture.draft.save',{...body(id),...overrides},x.config.fingerprint).task.id;}
function effects(x){return x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length;}
async function finish(x,s,id){return until(async()=>{await s.step();const row=s.store.submission(id);return ['done','blocked','prepared'].includes(row.recovery_state)?s.store.outcome(id):false;},25000);}
function cutLauncher(x,point){let first;const launch=async(config,row)=>{
  if(first)return launchWorker(config,row);
  first=child(x,'worker',row.task_id,row.launch_nonce,String(row.dispatch_generation),point);
  const identity=await processIdentity(first.handle.pid);assert.equal(typeof identity,'object');return identity;
};return {launch,first:()=>first};}

test('runtime native v2 migration preserves accepted requests, legacy claims, intents and events',async t=>{
  const x=await setup(t),path=join(x.root,'v2.sqlite'),db=new DatabaseSync(path);db.exec(MIGRATION_1);db.exec('INSERT INTO schema_version VALUES (1)');db.exec(MIGRATION_2);
  db.prepare('INSERT INTO project VALUES (?,?)').run(x.config.project.id,JSON.stringify(x.config.project));
  db.prepare("INSERT INTO task(id,project_id,capability,status,next_action,created_at,updated_at) VALUES ('old',?,'fixture.draft.save','queued','start','then','then')").run(x.config.project.id);
  db.prepare('INSERT INTO submission VALUES (?,?,?,?,?,?,?,?,?,?)').run(x.config.project.id,'request','old','hash',JSON.stringify(body('request')),x.config.fingerprint,'then','legacy',123,'then');
  db.prepare("INSERT INTO lease VALUES ('resource',?,'old',1,'token',1,'intent')").run(x.config.project.id);
  db.exec("INSERT INTO step VALUES ('step','old','fixture.draft.save'); INSERT INTO command_intent(id,step_id,task_id,resource,generation,effect,input_hash,status,created_at) VALUES ('intent','step','old','resource',1,'write_external','digest','dispatched','then')");
  db.prepare("INSERT INTO event(project_id,task_id,kind,data_json,created_at) VALUES (?,'old','preserved','{}','then')").run(x.config.project.id);db.exec('INSERT INTO outbox VALUES (1)');db.close();
  const store=new RecoveryStore(path);assert.equal(store.submission('old').recovery_state,'legacy_unknown');assert.equal(store.submission('old').payload_json,JSON.stringify(body('request')));assert.equal(store.events(x.config.project.id,'reader')[0].kind,'preserved');assert.equal(store.hasIntent('old'),true);assert.equal(store.resourceBusy(x.config.project.id),true);store.close();
});
test('runtime native process identity distinguishes a reused PID and keeps an occupied profile',async t=>{
  const x=await setup(t),identity=await processIdentity(process.pid);assert.equal(await liveness(identity),'alive');assert.equal(await liveness({...identity,startTicks:'1'}),'dead');assert.equal(await liveness(null),'unknown');
  const p=child(x,'profile','--user-data-dir='+x.config.project.profileRef);await p.message;
  assert.equal(await profileOccupancy(x.config.project.profileRef),'busy');const s=await supervise(x),id=enqueue(x);await s.step();assert.equal(s.store.submission(id).attempt_count,0);
  await kill(p);assert.equal((await finish(x,s,id)).status,'succeeded');assert.equal(effects(x),1);
});
test('runtime native accepted queue survives gateway SIGKILL before any worker is launched',{timeout:60000},async t=>{
  const x=await setup(t),s=await supervise(x),gateway=child(x,'gateway',JSON.stringify(body('queued-crash'))),accepted=await gateway.message;
  assert.equal(s.store.submission(accepted.task_id).attempt_count,0);await kill(gateway);
  assert.equal((await finish(x,s,accepted.task_id)).status,'succeeded');assert.equal(effects(x),1);
});
test('runtime native supervisor SIGKILL revokes an unclaimed reservation and fences the old ticket',{timeout:60000},async t=>{
  const x=await setup(t),id=enqueue(x),owner=child(x,'supervisor',id),{reserved}=await owner.message;
  const duplicate=new Supervisor(x.config);await assert.rejects(duplicate.start(),/SUPERVISOR_ALREADY_ACTIVE/);duplicate.close();
  await kill(owner);const next=await supervise(x);await next.step();
  await assert.rejects(runWorker(x.path,id,reserved.launch_nonce,reserved.dispatch_generation),/WORKER_FAILED/);
  assert.equal((await finish(x,next,id)).status,'succeeded');assert.equal(effects(x),1);assert.equal(next.store.submission(id).attempt_count,2);
});
for(const point of ['claimed','browser_ready','before_intent','intent_recorded','after_save','response_recorded','verified']){
  test(`runtime native worker SIGKILL at ${point} preserves effect count and recovery meaning`,{timeout:60000},async t=>{
    const x=await setup(t),cut=cutLauncher(x,point),s=await supervise(x,cut.launch),id=enqueue(x);await s.step();const worker=cut.first();await worker.message;
    // An alive worker cannot be taken over even while paused at an arbitrary boundary.
    await s.step();assert.equal(s.store.submission(id).attempt_count,1);
    assert.throws(()=>s.store.recoverTask(id),/MANAGED_RECOVERY_REQUIRES_SUPERVISOR/);
    await kill(worker);
    const final=await finish(x,s,id);
    if(['claimed','browser_ready','before_intent'].includes(point)){assert.equal(final.status,'succeeded');assert.equal(s.store.submission(id).attempt_count,2);assert.equal(effects(x),1);}
    else if(point==='intent_recorded'){assert.equal(final.status,'reconciliation_required');assert.equal(final.verification.result,'NOT_MATCH');assert.equal(effects(x),0);assert.equal(s.store.submission(id).attempt_count,1);}
    else{assert.equal(final.status,'succeeded');assert.equal(final.verification.result,'MATCH');assert.equal(effects(x),1);assert.equal(s.store.submission(id).attempt_count,1);}
    for(let i=0;i<3;i++)await s.step();assert.equal(effects(x),point==='intent_recorded'?0:1);
  });
}
test('runtime native prepare_only requires the exact recovery generation before resuming',{timeout:60000},async t=>{
  const x=await setup(t,'prepare_only'),cut=cutLauncher(x,'claimed'),s=await supervise(x,cut.launch),id=enqueue(x);await s.step();await cut.first().message;await kill(cut.first());
  const prepared=await finish(x,s,id);assert.equal(prepared.status,'ready_to_resume');assert.equal(effects(x),0);
  const ready=await x.api.call('runtime_recovery_prepare',{task_id:id,expected_recovery_generation:prepared.recovery_generation});assert.equal(ready.prepared_kind,'handoff');assert.equal(ready.automatic_execution,false);
  await assert.rejects(x.api.call('runtime_task_resume',{task_id:id,expected_recovery_generation:prepared.recovery_generation-1}),/STALE_RECOVERY/);
  await x.api.call('runtime_task_resume',{task_id:id,expected_recovery_generation:prepared.recovery_generation});
  await assert.rejects(x.api.call('runtime_task_resume',{task_id:id,expected_recovery_generation:prepared.recovery_generation}),/STALE_RECOVERY/);
  const final=await finish(x,s,id);
  const evidence={outcome:final,attempts:s.store.submission(id).attempt_count,states:s.store.events(x.config.project.id,'prepare-only-diagnostic',1000).filter(e=>e.kind==='task.state').map(e=>e.data)};
  assert.equal(final.status,'succeeded',JSON.stringify(evidence));assert.equal(effects(x),1);
});
test('runtime native repeated pre-claim process deaths stop after three launches with bounded backoff',{timeout:60000},async t=>{
  const x=await setup(t);let launches=0;const s=await supervise(x,async()=>{launches++;const process=child(x,'profile');await process.message;await kill(process);return 'dead';}),id=enqueue(x);
  const result=await finish(x,s,id);assert.equal(launches,3);assert.equal(result.recovery_reason,'RESTART_BUDGET_EXHAUSTED');assert.equal(effects(x),0);
});
for(const change of ['cancel','deadline','config']){
  test(`runtime native ${change} at pre-save barrier cannot commit or trigger blind retry`,{timeout:60000},async t=>{
    const x=await setup(t),cut=cutLauncher(x,'before_save'),s=await supervise(x,cut.launch),id=enqueue(x,'change',{deadline_ms:change==='deadline'?20000:60000});
    await s.step();await cut.first().message;
    if(change==='cancel')x.api.store.cancel(id);
    if(change==='deadline')await delay(remainingBudget(s.store.submission(id))+200);
    if(change==='config')await writeFile(x.path,JSON.stringify({...x.raw,recovery_policy:'prepare_only'}));
    cut.first().handle.send({continue:true});await cut.first().exited;
    if(change==='config'){
      await assert.rejects(s.step(),/CONFIG_CHANGED/);s.close();x.config=loadHostConfig(x.path);const next=await supervise(x);assert.equal((await finish(x,next,id)).status,'reconciliation_required');
    }else await finish(x,s,id);
    assert.equal(effects(x),0);assert.equal(x.api.store.submission(id).attempt_count,1);
  });
}

async function proxyConfig(t,x,{badIdentity=false,holdSave=false}={}){
  let release,seen;const gate=new Promise(r=>{release=r;}),arrived=new Promise(r=>{seen=r;});
  const proxy=createServer((req,res)=>{
    if(badIdentity&&req.url.endsWith('/api/identity')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({account:'account-b',run_id:x.spec.runId}));return;}
    const upstream=httpRequest(x.fixture.baseUrl+req.url,{method:req.method,headers:req.headers},response=>{void(async()=>{
      if(holdSave&&req.url.endsWith('/api/save')){seen();await gate;}
      if(!res.destroyed){res.writeHead(response.statusCode,response.headers);response.pipe(res);}else response.resume();
    })();});upstream.on('error',()=>{if(!res.destroyed){res.writeHead(502);res.end();}});req.pipe(upstream);
  });await new Promise(r=>proxy.listen(0,'127.0.0.1',r));
  t.after(async()=>{release();proxy.closeAllConnections();await new Promise(r=>proxy.close(r));});
  x.raw.fixture_url=`http://127.0.0.1:${proxy.address().port}/${x.spec.runId}/account-a/`;x.raw.data_dir=join(x.root,'proxy-data');await writeFile(x.path,JSON.stringify(x.raw));
  const config=loadHostConfig(x.path),api=new RuntimeApi(config);x.api.close();x.config=config;x.api=api;return {arrived,release};
}
test('runtime native worker dies while save response is blocked after the server committed',{timeout:60000},async t=>{
  const x=await setup(t),gate=await proxyConfig(t,x,{holdSave:true}),cut=cutLauncher(x,'claimed'),s=await supervise(x,cut.launch),id=enqueue(x);
  await s.step();const worker=cut.first();await worker.message;worker.handle.send({continue:true});await gate.arrived;assert.equal(effects(x),1);await kill(worker);
  gate.release();assert.equal((await finish(x,s,id)).status,'succeeded');assert.equal(s.store.submission(id).attempt_count,1);assert.equal(effects(x),1);
});
test('runtime native wrong identity during recovery retains uncertainty and blocks the next writer',{timeout:60000},async t=>{
  const x=await setup(t);await proxyConfig(t,x,{badIdentity:true});const cut=cutLauncher(x,'after_save'),s=await supervise(x,cut.launch),id=enqueue(x);
  await s.step();await cut.first().message;await kill(cut.first());const result=await finish(x,s,id);
  assert.equal(result.status,'reconciliation_required');assert.equal(result.verification.result,'UNKNOWN');const next=enqueue(x,'second');await s.step();assert.equal(s.store.submission(next).attempt_count,0);assert.equal(effects(x),1);
  await assert.rejects(x.api.call('runtime_task_resume',{task_id:id,expected_recovery_generation:result.recovery_generation}),/UNSAFE_RESUME/);
});
test('runtime native a new supervisor preserves a living claimed worker and never starts a duplicate',{timeout:60000},async t=>{
  const x=await setup(t),cut=cutLauncher(x,'claimed'),old=await supervise(x,cut.launch),id=enqueue(x);await old.step();await cut.first().message;
  old.close();const next=await supervise(x);await next.step();assert.equal(next.store.submission(id).attempt_count,1);cut.first().handle.send({continue:true});
  assert.equal((await finish(x,next,id)).status,'succeeded');assert.equal(effects(x),1);
});
test('runtime native cancellation and expired pending deadlines launch no worker',{timeout:60000},async t=>{
  const x=await setup(t),s=await supervise(x),cancel=enqueue(x,'cancel'),expired=enqueue(x,'expired',{deadline_ms:1000});x.api.store.cancel(cancel);await delay(1100);await s.step();
  assert.equal(s.store.submission(cancel).attempt_count,0);assert.equal(s.store.submission(expired).attempt_count,0);assert.equal(s.store.outcome(expired).recovery_reason,'DEADLINE_OR_BOOT_CHANGED');assert.equal(effects(x),0);
});
test('runtime native unclaimed startup timeout revokes an alive process ticket before any effect',{timeout:60000},async t=>{
  const x=await setup(t);let row,first;
  const s=await supervise(x,async(config,reserved)=>{
    if(first)return launchWorker(config,reserved);row=reserved;first=child(x,'profile');await first.message;return processIdentity(first.handle.pid);
  }),id=enqueue(x);await s.step();await delay(5100);await s.step();
  await assert.rejects(runWorker(x.path,id,row.launch_nonce,row.dispatch_generation),/WORKER_FAILED/);assert.equal((await finish(x,s,id)).status,'succeeded');assert.equal(effects(x),1);
});
