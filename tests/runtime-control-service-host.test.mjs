import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {controlHostReachable,startHostReachableControlCenter,ensureControlService,publishControlServiceRecord} from '../dist/onboarding/control-service.js';

async function setup(t){const root=await mkdtemp(join(tmpdir(),'office-host-probe-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await prepareLocalConnection(root);return loadHostConfig(paths.runtimeConfig);}
const fixtureUrl=`http://127.0.0.1:12345/${'a'.repeat(48)}/`;

test('runtime contract WSL host probe checks the Windows capability endpoint and fails on timeout or a wrong listener',async()=>{
  let calls=0;
  const run=async script=>{calls++;assert.ok(script.includes(`-Uri '${fixtureUrl}settings/status'`));assert.match(script,/-TimeoutSec 3/u);assert.match(script,/-MaximumRedirection 0/u);assert.match(script,/credentials_exposed -eq \$false/u);return {code:0,stdout:''};};
  assert.equal(await controlHostReachable(fixtureUrl,{environment:{WSL_DISTRO_NAME:'Ubuntu-24.04'},platform:'linux',run}),true);
  for(const code of [1,null])assert.equal(await controlHostReachable(fixtureUrl,{environment:{WSL_INTEROP:'/fixture/interop'},platform:'linux',run:async()=>({code,stdout:''})}),false);
  assert.equal(await controlHostReachable(fixtureUrl,{environment:{},platform:'linux',run}),true);
  assert.equal(await controlHostReachable(fixtureUrl,{environment:{WSL_DISTRO_NAME:'fixture'},platform:'win32',run}),true);
  assert.equal(calls,1);
  for(const url of ['https://evil.test/','http://127.0.0.1:12345/not-a-capability/','http://127.0.0.1:12345/'+"a'.repeat(48)/"]){await assert.rejects(controlHostReachable(url,{environment:{WSL_DISTRO_NAME:'fixture'},platform:'linux',run}),/CONTROL_CENTER_URL_INVALID/u);}
  assert.equal(calls,1,'Invalid URLs never enter a Windows shell');
});

test('runtime contract host collision closes the unpublished listener and retries another port with the same capability',async t=>{
  const config=await setup(t),urls=[],previous=new URL(`http://127.0.0.1:0/${'b'.repeat(48)}/`);
  const service=await startHostReachableControlCenter(config,previous,async url=>{
    urls.push(url);assert.equal((await fetch(url+'settings/status')).status,200);return urls.length===2;
  });t.after(()=>service.close());
  assert.equal(urls.length,2);assert.notEqual(new URL(urls[0]).port,new URL(service.url).port);
  assert.equal(new URL(service.url).pathname,previous.pathname);
  await assert.rejects(fetch(urls[0]+'settings/status',{signal:AbortSignal.timeout(500)}));
  assert.equal((await fetch(service.url+'settings/status')).status,200);
});

test('runtime contract host failure is bounded to three unpublished attempts and leaves no listeners',async t=>{
  const config=await setup(t),urls=[];
  await assert.rejects(startHostReachableControlCenter(config,undefined,async url=>{urls.push(url);return false;}),/CONTROL_CENTER_WINDOWS_UNREACHABLE/u);
  assert.equal(urls.length,3);
  for(const url of urls)await assert.rejects(fetch(url+'settings/status',{signal:AbortSignal.timeout(500)}));
});

test('runtime contract throwing host probe closes the unpublished UI rather than leaking a duplicate',async t=>{
  const config=await setup(t);let url;
  await assert.rejects(startHostReachableControlCenter(config,undefined,async value=>{url=value;throw Error('HOST_PROBE_FAILED');}),/HOST_PROBE_FAILED/u);
  await assert.rejects(fetch(url+'settings/status',{signal:AbortSignal.timeout(500)}));
});

const pidAlive=pid=>{try{process.kill(pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}};
async function waitForPidExit(pid){for(let attempt=0;attempt<80;attempt++){if(!pidAlive(pid))return;await delay(50);}throw Error('OWNED_FIXTURE_CONTROL_PROCESS_DID_NOT_EXIT');}
async function stopOwnRecord(record){if(!record||!pidAlive(record.pid))return;process.kill(record.pid,'SIGTERM');await waitForPidExit(record.pid);}

test('runtime native default control record publication is durable and ready reuse never spawns or terminates another daemon',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-control-publish-'));let record;
  t.after(async()=>{await stopOwnRecord(record);await rm(root,{recursive:true,force:true});});
  record=await ensureControlService(root);assert.equal(record.reused,false);assert.notEqual(record.pid,process.pid);assert.equal(pidAlive(record.pid),true);
  const published=JSON.parse(await readFile(join(root,'control-center.json'),'utf8'));
  assert.deepEqual(published,{format:1,pid:record.pid,url:record.url,config:record.config,started_at:record.started_at});
  assert.equal((await fetch(record.url+'settings/status')).status,200);
  const reused=await ensureControlService(root,{spawnChild(){throw Error('READY_REUSE_MUST_NOT_SPAWN');},publishRecord(){throw Error('READY_REUSE_MUST_NOT_REPUBLISH');}});
  assert.equal(reused.reused,true);assert.equal(reused.pid,record.pid);assert.equal(reused.url,record.url);assert.equal(pidAlive(record.pid),true);
  assert.ok(!(await readdir(root)).includes('.control-center.lock'));
});

test('runtime native a record publication failure stops only its newly owned ready child and confirms its listener closed',async t=>{
  for(const phase of ['write','rename']){
    const root=await mkdtemp(join(tmpdir(),`office-control-failed-${phase}-`));let attempted;
    t.after(async()=>{await stopOwnRecord(attempted);await rm(root,{recursive:true,force:true});});
    await assert.rejects(ensureControlService(root,{async publishRecord(path,record){
      attempted=record;assert.equal(pidAlive(record.pid),true);assert.equal((await fetch(record.url+'settings/status')).status,200);
      if(phase==='write')throw Error('FIXTURE_RECORD_WRITE_FAILED');
      // The real default publisher creates its private temporary file, then
      // rename fails against this fixture-owned directory.
      await mkdir(path);await publishControlServiceRecord(path,record);
    }}),error=>phase==='write'?error.message==='FIXTURE_RECORD_WRITE_FAILED':['EISDIR','ENOTEMPTY','EPERM','EACCES'].includes(error.code));
    assert.ok(attempted);await waitForPidExit(attempted.pid);
    await assert.rejects(fetch(attempted.url+'settings/status',{signal:AbortSignal.timeout(500)}));
    const names=await readdir(root);assert.ok(!names.includes('.control-center.lock'));assert.ok(names.every(name=>!name.endsWith('.tmp')));
    assert.equal(pidAlive(process.pid),true,'The owning test process was never stopped');
  }
});

test('runtime contract an unconfirmed owned child cleanup preserves a clear failure instead of claiming publication succeeded',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-control-unconfirmed-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const signals=[];let started=0,published=0;
  const result=ensureControlService(root,{spawnChild(_entry,config){
    started++;const child=new EventEmitter();Object.assign(child,{pid:process.pid,exitCode:null,signalCode:null,connected:false,kill(signal){signals.push(signal);return false;},unref(){throw Error('FAILED_START_MUST_NOT_UNREF');}});
    // This fake ChildProcess never signals an OS process. The current PID is
    // an alive sentinel, not a process the fixture is authorized to terminate.
    queueMicrotask(()=>child.emit('message',{format:1,pid:child.pid,url:fixtureUrl,config,started_at:new Date().toISOString()}));return child;
  },async publishRecord(){published++;throw Error('FIXTURE_RECORD_WRITE_FAILED');}});
  await assert.rejects(result,/CONTROL_CENTER_FAILED_START_CLEANUP_UNCONFIRMED/u);
  assert.equal(started,1);assert.equal(published,1);assert.deepEqual(signals,['SIGTERM','SIGKILL']);assert.equal(pidAlive(process.pid),true);
  await assert.rejects(readFile(join(root,'control-center.json')),error=>error.code==='ENOENT');assert.ok(!(await readdir(root)).includes('.control-center.lock'));
});
