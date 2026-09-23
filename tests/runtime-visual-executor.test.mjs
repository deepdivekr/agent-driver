import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {SwarmVisualExecutor} from '../dist/swarm/visual-executor.js';
import {captureManagedSurface} from '../dist/observability/surfaces.js';

async function setup(t){
  const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<html><head><title>${req.url}</title></head><body style="background:${req.url==='/one'?'lightblue':'pink'};height:1600px"><h1>${req.url}</h1><p id="state"></p><a href="/next">Read more</a>${req.url==='/one'?'<a href="/fragment?mode=read#section">Fragment example</a>':''}<script>${req.url==='/one'?"localStorage.setItem('worker','one');document.cookie='worker=one'":""};document.getElementById('state').textContent='stored:'+(localStorage.getItem('worker')||'empty')+' cookies:'+document.cookie;</script></body></html>`);});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`,root=await mkdtemp(join(tmpdir(),'driver-native-visual-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'visual-project',caller_ref:'agent',account_ref:'account-a',worktree:root,data_dir:'data',environment:'fixture',fixture_url:`${origin}/fixture/account-a/`,swarm:{enabled:true,model_data_approved:true,max_logical_workers:8,max_concurrency:2,lease_ms:60_000}}));
  const calls=[],model={calls,async call(purpose,instructions,input){calls.push({purpose,model:'fixture-planner',elapsed_ms:1,input_sha256:'a'.repeat(64),status:'accepted'});return {summary:'Native browser isolation test, not research evidence.',workers:['one','two'].map(id=>({id,role:id,objective:'Read the assigned fixture independently',stage:'source_read',source_urls:[`${origin}/${id}`],executor:'browser',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Read visible page'],max_steps:20,timeout_ms:60_000}))};}};
  const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:model}),pool=new SwarmVisualExecutor(api.store,config,{max_contexts:2,frame_interval_ms:500,fixture_origins:[origin]});
  t.after(async()=>{await pool.close();api.close();await api.drain();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(root,{recursive:true,force:true});});
  const plan=await api.call('runtime_swarm_plan',{goal:'Native browser isolation verification',context:{}}),run=await api.call('runtime_swarm_run',{request_id:'isolation',plan_id:plan.plan.plan_id}),leased=await api.call('runtime_swarm_tick',{run_id:run.run_id});
  return {api,pool,config,origin,run:run.run_id,workers:leased.dispatches};
}

test('runtime native visual pool isolates parallel browser storage, pages and timestamped real frames',async t=>{
  const x=await setup(t);assert.equal(x.workers.length,2);
  const assigned=await Promise.all(x.workers.map(w=>x.pool.assign(x.run,w.worker_id,w.lease_token)));assert.equal(new Set(assigned.map(a=>a.surface_id)).size,2);
  const observations=await Promise.all(x.workers.map(w=>x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:w.source_urls[0]})));
  assert.match(observations[0].text,/stored:one cookies:worker=one/);assert.match(observations[1].text,/stored:empty cookies:/);assert.doesNotMatch(observations[1].text,/worker=one/);
  const surfaces=x.api.store.controlSurfaces(x.config.project.id);assert.equal(surfaces.length,2);assert.ok(surfaces.every(s=>s.state==='active'));
  const frames=await Promise.all(surfaces.map(s=>captureManagedSurface(s.preview_endpoint)));assert.ok(frames.every(f=>f.body.length>1000&&Date.parse(f.captured_at)>0));assert.notEqual(createHash('sha256').update(frames[0].body).digest('hex'),createHash('sha256').update(frames[1].body).digest('hex'));
  const w=x.workers[0];const next=await x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:`${x.origin}/next`});assert.match(next.text,/stored:one/);assert.ok(x.api.store.observedUrls(x.config.project.id,x.run,w.worker_id).includes(`${x.origin}/next`));
  await assert.rejects(x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:`${x.origin}/not-observed`}),/URL_NOT_OBSERVED/);
  await assert.rejects(x.pool.perform(x.run,w.worker_id,'wrong-lease',{action:'observe'}),/STALE_SWARM_LEASE/);
  await assert.rejects(x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:'http://169.254.169.254/metadata'}),/PRIVATE_ADDRESS/);
  const denied=await fetch(surfaces[0].preview_endpoint,{headers:{Origin:'https://evil.example'}});assert.equal(denied.status,403);
  const firstFrame=await captureManagedSurface(surfaces[0].preview_endpoint);await x.pool.release(surfaces[0].run_id,surfaces[0].worker_id);assert.equal(x.api.store.controlSurfaces(x.config.project.id).find(s=>s.id===surfaces[0].id).state,'closed');
  const retained=await captureManagedSurface(surfaces[0].preview_endpoint);assert.equal(retained.captured_at,firstFrame.captured_at);
  await x.pool.close();assert.ok(x.api.store.controlSurfaces(x.config.project.id).every(s=>s.state==='closed'));await assert.rejects(captureManagedSurface(surfaces[0].preview_endpoint));
});

test('runtime native visual pool enforces capacity without creating extra contexts',async t=>{
  const x=await setup(t),pool=new SwarmVisualExecutor(x.api.store,x.config,{max_contexts:1,fixture_origins:[x.origin]});t.after(()=>pool.close());const [a,b]=x.workers;
  await pool.assign(x.run,a.worker_id,a.lease_token);await assert.rejects(pool.assign(x.run,b.worker_id,b.lease_token),/CAPACITY_EXCEEDED/);
  assert.equal(x.api.store.controlSurfaces(x.config.project.id).length,1);await pool.release(x.run,a.worker_id);await pool.assign(x.run,b.worker_id,b.lease_token);await pool.close();
});

test('observed fragment links can be revisited but changed queries and unobserved resources stay denied',async t=>{
  const x=await setup(t),w=x.workers[0];
  await x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:w.source_urls[0]});
  const withoutHash=`${x.origin}/fragment?mode=read`,visited=await x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:withoutHash});assert.equal(visited.url,withoutHash);
  const reopened=await x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:withoutHash+'#different-section'});assert.match(reopened.url,/#different-section$/);assert.ok(x.api.store.observedUrls(x.config.project.id,x.run,w.worker_id).includes(withoutHash));
  await assert.rejects(x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:`${x.origin}/fragment?mode=write`}),/URL_NOT_OBSERVED/);
  await assert.rejects(x.pool.perform(x.run,w.worker_id,w.lease_token,{action:'navigate',url:`${x.origin}/fragment`}),/URL_NOT_OBSERVED/);
});

test('one worker waiting for a person does not revoke an independent already-leased read worker',async t=>{
  const x=await setup(t),[first,second]=x.workers;await Promise.all(x.workers.map(w=>x.pool.assign(x.run,w.worker_id,w.lease_token)));
  const held=await x.api.call('runtime_swarm_report',{run_id:x.run,worker_id:first.worker_id,lease_token:first.lease_token,report:{status:'needs_human',summary:'This source requires user authentication.',error_code:'BROWSER_AUTH_REQUIRED'}});assert.equal(held.status,'needs_human');
  assert.throws(()=>x.api.store.claimBrowserHandoff(x.config.project.id,'test-profile','example.test'),/AUTH_WAIT_FOR_ACTIVE_WORKERS/);
  const view=await x.pool.perform(x.run,second.worker_id,second.lease_token,{action:'navigate',url:second.source_urls[0]});assert.match(view.text,/stored:empty/);
  const activity=await x.api.call('runtime_swarm_activity',{run_id:x.run,worker_id:second.worker_id,lease_token:second.lease_token,activity:{kind:'checkpoint',summary:'Independent source preserved.',endpoint:view.url}});assert.equal(activity.recorded,true);
  await assert.rejects(x.pool.perform(x.run,first.worker_id,first.lease_token,{action:'observe'}),/STALE_SWARM_LEASE/);
  assert.throws(()=>x.api.store.recordObservedUrl(x.config.project.id,x.run,second.worker_id,'stale-token',second.source_urls[0]),/STALE_SWARM_LEASE/);
});

test('managed previews reject arbitrary network endpoints before fetching',async()=>{
  for(const url of ['https://example.com/frame','http://127.0.0.1:1/private','http://localhost:8080/'+'a'.repeat(48)+'/frame/test'])await assert.rejects(captureManagedSurface(url),/ENDPOINT_INVALID/);
});
