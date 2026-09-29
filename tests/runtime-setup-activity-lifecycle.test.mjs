import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {SetupActivityStream,readSetupActivity} from '../dist/onboarding/setup-activity.js';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {WorkSupervisor} from '../dist/work/supervisor.js';

test('runtime native Setup activity close permanently rejects HTTP stream reattachment while retaining its journal',{timeout:8000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-stream-lifecycle-')),stream=new SetupActivityStream(root),abort=new AbortController();
  const server=createServer((_request,response)=>stream.attach(response));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{abort.abort();stream.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  await stream.record('runtime','running','Fixture preparation started');
  const url='http://127.0.0.1:'+server.address().port,response=await fetch(url,{signal:abort.signal}),reader=response.body.getReader();
  assert.equal(response.status,200);assert.match(new TextDecoder().decode((await reader.read()).value),/Fixture preparation started/u);
  stream.close();stream.close();assert.equal((await reader.read()).done,true);
  // EventSource can reconnect after the first response ended. A terminally
  // closed owner must never retain this new request and block server.close().
  for(let i=0;i<3;i++){
    const retry=await fetch(url,{signal:AbortSignal.timeout(1000)});
    assert.equal(retry.status,503);assert.equal(retry.headers.get('connection'),'close');
    assert.deepEqual(await retry.json(),{error:'SETUP_ACTIVITY_CLOSED'});
  }
  await stream.record('runtime','success','Fixture preparation finished');
  assert.deepEqual(readSetupActivity(root).map(event=>event.message),['Fixture preparation started','Fixture preparation finished']);
});

test('runtime contract Control Center shutdown fences late requests and a previously unfinished body without losing open stream completion',{timeout:10000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-control-shutdown-')),paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);
  const store=new PackStore(config.dbPath);store.registerProject(config.project);const work=store.beginWork(config.project.id,'shutdown-existing','Observe shutdown','quick').work;
  let release,entered,modelCalls=0;const gate=new Promise(resolve=>release=resolve),draining=new Promise(resolve=>entered=resolve),originalClose=WorkSupervisor.prototype.close;
  // A bounded fake drain exposes the real server's shutdown admission window.
  // No model or bot execution takes place in this fixture.
  WorkSupervisor.prototype.close=async function(){entered();await gate;return originalClose.call(this);};
  const model={calls:[],async call(){modelCalls++;throw Error('No model calls permitted in shutdown fixture');}};
  let server,closing,unfinished;const abort=new AbortController();
  t.after(async()=>{release();WorkSupervisor.prototype.close=originalClose;abort.abort();unfinished?.destroy();await closing;await server?.close();store.close();await rm(root,{recursive:true,force:true});});
  server=await startControlCenter(config,{workModel:model,poll_ms:25});
  const origin=new URL(server.url).origin,headers={origin,'content-type':'application/json','x-agent-driver':'human-office'};
  const setupResponse=await fetch(new URL('settings/activity',server.url),{signal:abort.signal}),setupReader=setupResponse.body.getReader();await setupReader.read();
  const workResponse=await fetch(new URL('work/events?work_id='+work.id,server.url),{signal:abort.signal}),workReader=workResponse.body.getReader();await workReader.read();
  const body=JSON.stringify({request_id:'must-not-register-after-close',prompt:'A new task that must not start',intake_mode:'quick'}),split=Math.floor(body.length/2);
  const pendingResponse=new Promise((resolve,reject)=>{
    unfinished=httpRequest(new URL('work/start',server.url),{method:'POST',headers},response=>{let text='';response.setEncoding('utf8');response.on('data',chunk=>text+=chunk);response.on('end',()=>resolve({status:response.statusCode,body:JSON.parse(text)}));});
    unfinished.on('error',reject);unfinished.flushHeaders();unfinished.write(body.slice(0,split));
  });
  // Let the owned HTTP request enter its body reader before shutdown starts.
  await delay(30);closing=server.close();await draining;
  let concurrentCloseFinished=false;const concurrentClose=server.close().then(()=>concurrentCloseFinished=true);
  await new Promise(resolve=>setImmediate(resolve));assert.equal(concurrentCloseFinished,false,'A second close must await the same in-flight shutdown');
  assert.equal((await setupReader.read()).done,true);
  for(const suffix of ['settings/activity','work/events?work_id='+work.id,'snapshot','']){
    const retry=await fetch(new URL(suffix,server.url),{signal:AbortSignal.timeout(1000)});
    assert.equal(retry.status,503);assert.equal(retry.headers.get('connection'),'close');assert.deepEqual(await retry.json(),{error:'CONTROL_CENTER_CLOSING'});
  }
  const execute=await fetch(new URL('work/execute',server.url),{method:'POST',headers,body:'{}',signal:AbortSignal.timeout(1000)});
  assert.equal(execute.status,503);assert.deepEqual(await execute.json(),{error:'CONTROL_CENTER_CLOSING'});
  unfinished.end(body.slice(split));assert.deepEqual(await pendingResponse,{status:503,body:{error:'CONTROL_CENTER_CLOSING'}});
  assert.equal(modelCalls,0);assert.deepEqual(store.intakeWorks(config.project.id).map(item=>item.id),[work.id]);
  release();await closing;await concurrentClose;
  let item;do{item=await workReader.read();}while(!item.done);assert.equal(item.done,true);
});
