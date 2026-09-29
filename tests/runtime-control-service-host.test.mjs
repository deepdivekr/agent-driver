import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {controlHostReachable,startHostReachableControlCenter} from '../dist/onboarding/control-service.js';

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
