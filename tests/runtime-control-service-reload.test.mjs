import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {startManagedControlService,ensureControlService} from '../dist/onboarding/control-service.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {readSetupActivity} from '../dist/onboarding/setup-activity.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {PackStore} from '../dist/packs/store.js';

const address=`http://127.0.0.1:12345/${'a'.repeat(48)}/`;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const digest=value=>createHash('sha256').update(value).digest('hex');
const fixtureConfig=fingerprint=>({path:'/fixture/host.json',dbPath:'/fixture/data/runtime.sqlite',fingerprint,project:{id:'project',callerRef:'caller',accountRef:'account',worktree:'/fixture/worktree',profileRef:'/fixture/data/profile'}});
async function fakeManaged(t,{load,start,probe,onReloadState,close_timeout_ms}={}){
  const fixture={config:fixtureConfig('before'),calls:[],services:[]};
  const create=(config,options)=>{
    const ended=deferred(),service={config,options,url:address,closed:ended.promise,close_calls:0,async close(){this.close_calls++;ended.resolve();}};
    fixture.services.push(service);return service;
  };
  fixture.managed=await startManagedControlService('/fixture/host.json',undefined,{
    load:()=>load?load(fixture):fixture.config,
    start:async(config,options)=>{fixture.calls.push({config,options,pid:process.pid});return start?start(config,options,fixture,create):create(config,options);},
    probe:probe??(async()=>true),...(onReloadState?{onReloadState}:{}),...(close_timeout_ms?{close_timeout_ms}:{})
  });
  t.after(()=>fixture.managed.close());return fixture;
}

test('runtime contract managed reload preserves exact URL, host identity and logical lifetime while replacing only its own server',async t=>{
  const states=[],x=await fakeManaged(t,{onReloadState:state=>states.push(state)});let ended=false;x.managed.closed.then(()=>ended=true);
  x.config=fixtureConfig('after');await x.services[0].options.onReload();await Promise.resolve();
  assert.equal(x.managed.url,address);assert.equal(ended,false,'Closing the old listener is not daemon shutdown');
  assert.equal(x.services[0].close_calls,1);assert.equal(x.calls.length,2);assert.equal(x.calls[1].config.fingerprint,'after');
  assert.equal(x.calls[1].options.port,12345);assert.equal(x.calls[1].options.capability_token,'a'.repeat(48));
  assert.equal(x.calls[1].options.reloadStatus().state,'idle');assert.deepEqual(states,[{state:'reloading',reason:null},{state:'idle',reason:null}]);
  assert.deepEqual(new Set(x.calls.map(call=>call.pid)),new Set([process.pid]));
  await x.managed.close();await x.managed.closed;assert.equal(ended,true);assert.equal(x.services[1].close_calls,1);
});

test('runtime contract managed reload rejects each host identity change before closing a listener',async t=>{
  const x=await fakeManaged(t),mutations=[config=>config.path='/other/host.json',config=>config.dbPath='/other/runtime.sqlite',config=>config.project.id='other',config=>config.project.callerRef='other',config=>config.project.accountRef='other',config=>config.project.worktree='/other/worktree',config=>config.project.profileRef='/other/profile'];
  for(const mutate of mutations){x.config=fixtureConfig('after');mutate(x.config);await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_CONFIG_REJECTED/u);assert.equal(x.services[0].close_calls,0);assert.equal(x.calls.length,1);assert.deepEqual(x.managed.reloadStatus(),{state:'restored',reason:'CONTROL_CENTER_RELOAD_CONFIG_REJECTED'});}
});

test('runtime contract failed replacement restores cached config at the exact address without exposing raw provider failure',async t=>{
  const x=await fakeManaged(t,{start(config,options,fixture,create){if(fixture.calls.length===2)throw Error('password=fixture-not-for-ui https://private.invalid/token');return create(config,options);}});
  x.config=fixtureConfig('after');await assert.rejects(x.managed.reload(),error=>error.message==='CONTROL_CENTER_RELOAD_FAILED_RESTORED');
  assert.equal(x.calls.length,3);assert.equal(x.calls[2].config.fingerprint,'before');assert.equal(x.calls[2].options.port,12345);assert.equal(x.calls[2].options.capability_token,'a'.repeat(48));
  assert.deepEqual(x.managed.reloadStatus(),{state:'restored',reason:'CONTROL_CENTER_RELOAD_FAILED_RESTORED'});assert.doesNotMatch(JSON.stringify(x.managed.reloadStatus()),/password|private/u);
});

test('runtime contract failed host readiness closes the replacement before restoring and never selects an alternate port',async t=>{
  let probes=0;const x=await fakeManaged(t,{probe:async()=>++probes!==2});x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_FAILED_RESTORED/u);
  assert.equal(probes,3);assert.equal(x.services[1].close_calls,1);assert.equal(x.calls.length,3);
  for(const call of x.calls.slice(1)){assert.equal(call.options.port,12345);assert.equal(call.options.capability_token,'a'.repeat(48));}
  assert.equal(x.services[2].config.fingerprint,'before');
});

test('runtime contract unexpected replacement URL is closed rather than silently moving the published address',async t=>{
  const x=await fakeManaged(t,{start(config,options,fixture,create){const service=create(config,options);if(fixture.calls.length===2)service.url=`http://127.0.0.1:12346/${'b'.repeat(48)}/`;return service;}});x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_FAILED_RESTORED/u);assert.equal(x.services[1].close_calls,1);assert.equal(x.managed.url,address);assert.equal(x.calls.length,3);
});

test('runtime contract unrecoverable restore ends the managed lifetime with explicit failure instead of claiming availability',async t=>{
  const x=await fakeManaged(t,{start(config,options,fixture,create){if(fixture.calls.length>1)throw Error('FIXTURE_START_FAILURE');return create(config,options);}});x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_RESTORE_FAILED/u);await x.managed.closed;
  assert.deepEqual(x.managed.reloadStatus(),{state:'failed',reason:'CONTROL_CENTER_RELOAD_RESTORE_FAILED'});assert.equal(x.calls.length,3);await assert.rejects(x.managed.reload(),/CONTROL_CENTER_CLOSING/u);
});

test('runtime contract unconfirmed old closure refuses any new listener and keeps ownership for explicit cleanup',async t=>{
  const x=await fakeManaged(t,{close_timeout_ms:15}),old=x.services[0],close=old.close;old.close=async()=>{};x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_CLOSE_UNCONFIRMED/u);assert.equal(x.calls.length,1);assert.equal(x.managed.reloadStatus().state,'failed');
  old.close=close;await x.managed.close();await x.managed.closed;
});

test('runtime contract unconfirmed failed replacement cleanup never starts a restore duplicate',async t=>{
  let probes=0,ownedClose;const x=await fakeManaged(t,{close_timeout_ms:15,probe:async()=>++probes!==2,start(config,options,fixture,create){const service=create(config,options);if(fixture.calls.length===2){ownedClose=service.close;service.close=async()=>{};}return service;}});x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED/u);assert.equal(x.calls.length,2);assert.deepEqual(x.managed.reloadStatus(),{state:'failed',reason:'CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED'});
  x.services[1].close=ownedClose;await x.managed.close();await x.managed.closed;
});

test('runtime contract policy drift during readiness closes the candidate and restores without changing prior execution hashes',async t=>{
  let probes=0;const x=await fakeManaged(t,{probe:async()=>{if(++probes===2)x.config=fixtureConfig('changed-during-probe');return true;}});x.config=fixtureConfig('after');
  await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_FAILED_RESTORED/u);assert.equal(x.calls.length,3);assert.equal(x.services[1].close_calls,1);assert.equal(x.calls[2].config.fingerprint,'before');assert.equal(x.managed.url,address);
});

test('runtime contract shutdown during reload drains the newly owned listener without restore or premature logical completion',async t=>{
  const starting=deferred(),release=deferred(),x=await fakeManaged(t,{async start(config,options,fixture,create){if(fixture.calls.length===2){starting.resolve();await release.promise;}return create(config,options);}});x.config=fixtureConfig('after');
  const reload=x.managed.reload();await starting.promise;await assert.rejects(x.managed.reload(),/CONTROL_CENTER_RELOAD_IN_PROGRESS/u);const closing=x.managed.close();release.resolve();await reload;await closing;await x.managed.closed;
  assert.equal(x.calls.length,2);assert.equal(x.services[1].close_calls,1);assert.equal(x.services[0].close_calls,1);
});

const browserPolicy={targets:[{id:'playwright',engine:'playwright',environment:'owned_headless',platform:'linux',profile_ref:'default',priority:50}]};
test('runtime native managed HTTP reload applies fresh policy on the same listener and preserves original Work/checkpoint hashes',{timeout:15000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-managed-reload-'));let managed,store;t.after(async()=>{await managed?.close();store?.close();await rm(root,{recursive:true,force:true});});const paths=await prepareLocalConnection(root),original=loadHostConfig(paths.runtimeConfig),starts=[],modelCalls=[];
  managed=await startManagedControlService(paths.runtimeConfig,undefined,{start:(config,options)=>{starts.push(config.fingerprint);return startControlCenter(config,{...options,workModel:{async call(){modelCalls.push('unexpected');throw Error('FIXTURE_MODELS_NOT_AUTHORIZED');}}});},probe:async url=>(await fetch(url+'settings/status')).status===200});
  store=new PackStore(original.dbPath);store.registerProject(original.project);const work=store.beginWork(original.project.id,'managed-reload-binding','Preserve this pending Work','quick').work;
  store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('11111111-1111-4111-8111-111111111111',original.project.id,work.id,work.revision,'waiting_connection',original.fingerprint,0,new Date().toISOString(),new Date().toISOString());
  const before=store.hermesState.prepare('SELECT config_hash,checkpoint,work_revision,state FROM office_supervisor WHERE work_id=?').get(work.id),workBefore=store.hermesState.prepare('SELECT * FROM office_work WHERE id=?').get(work.id),url=managed.url;
  const raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));await writeFile(paths.runtimeConfig,JSON.stringify({...raw,browser_executors:browserPolicy})+'\n');const saved=await readFile(paths.runtimeConfig);
  const response=await fetch(url+'work/reconnect',{method:'POST',headers:{origin:new URL(url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:'{}'});
  assert.equal(response.status,202);assert.equal((await response.json()).execution_started,false);
  for(let attempts=0;attempts<100&&(starts.length!==2||managed.reloadStatus().state!=='idle');attempts++)await delay(20);
  assert.equal(starts.length,2);assert.notEqual(starts[0],starts[1]);assert.equal(managed.url,url);assert.deepEqual(managed.reloadStatus(),{state:'idle',reason:null});
  assert.equal((await fetch(url+'settings/status')).status,200);assert.equal((await (await fetch(url+'settings/browsers')).json()).restart_required,false);
  assert.deepEqual(store.hermesState.prepare('SELECT config_hash,checkpoint,work_revision,state FROM office_supervisor WHERE work_id=?').get(work.id),before);
  assert.deepEqual(store.hermesState.prepare('SELECT * FROM office_work WHERE id=?').get(work.id),workBefore);assert.equal(digest(await readFile(paths.runtimeConfig)),digest(saved));assert.deepEqual(modelCalls,[]);
});

test('runtime native owned managed daemon survives HTTP reload with unchanged PID and private service record',{timeout:25000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-managed-daemon-'));let record;
  t.after(async()=>{if(record){try{process.kill(record.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}let exited=false;for(let attempt=0;attempt<100;attempt++){try{process.kill(record.pid,0);}catch(error){if(error.code==='ESRCH'){exited=true;break;}throw error;}await delay(30);}assert.equal(exited,true,'Only this fixture-owned child must stop');}await rm(root,{recursive:true,force:true});});
  record=await ensureControlService(root);const recordBytes=await readFile(join(root,'control-center.json')),raw=JSON.parse(await readFile(record.config,'utf8'));await writeFile(record.config,JSON.stringify({...raw,browser_executors:browserPolicy})+'\n');const configBytes=await readFile(record.config);
  assert.equal((await (await fetch(record.url+'settings/browsers')).json()).restart_required,true);
  const response=await fetch(record.url+'work/reconnect',{method:'POST',headers:{origin:new URL(record.url).origin,'x-agent-driver':'human-office','content-type':'application/json'},body:'{}'});assert.equal(response.status,202);assert.equal((await response.json()).execution_started,false);
  let applied=false;for(let attempt=0;attempt<150;attempt++){try{const next=await fetch(record.url+'settings/browsers',{signal:AbortSignal.timeout(300)});if(next.ok&&(await next.json()).restart_required===false){applied=true;break;}}catch{}await delay(30);}
  assert.equal(applied,true);assert.doesNotThrow(()=>process.kill(record.pid,0));assert.deepEqual(await readFile(join(root,'control-center.json')),recordBytes);assert.deepEqual(await readFile(record.config),configBytes);
  // The replacement listener serves its fresh config before the Windows-host
  // probe and final fixed journal append finish. A successful config GET alone
  // is not a completed reload; wait for the separately observed success event.
  let events=[],completed=false;const journalDeadline=Date.now()+8000;
  while(Date.now()<journalDeadline){events=readSetupActivity(root);completed=events.some(event=>event.state==='success'&&event.message==='Saved runtime settings applied. No Work was replayed.');if(completed)break;await delay(30);}
  assert.equal(completed,true,'Final host readiness and success journal must complete within the bounded reload window');
  assert.ok(events.every(event=>!event.message.includes(record.url)&&!event.message.includes(new URL(record.url).pathname)));
});
