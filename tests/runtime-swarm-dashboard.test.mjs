import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {request as httpRequest} from 'node:http';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {interfaceHelp} from '../dist/interface/cli.js';
import {projectSwarmRun,readSwarmDashboard,sanitizeSwarmEndpoint,startSwarmDashboard} from '../dist/swarm/dashboard.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'driver-dashboard-')),configPath=join(root,'host.json');
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'dashboard-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(configPath),store=new PackStore(config.dbPath);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});return {root,config,store};
}

function snapshot(){
  const now='2026-09-22T02:00:00.000Z',worker=(id,source_urls)=>({id,role:`${id} role`,objective:`Inspect ${source_urls[0]??'local state'} and preserve api_key=secret-value.`,stage:'source_read',source_urls,executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Direct source evidence.'],max_steps:10,timeout_ms:60_000});
  const plan={format:1,plan_id:'11111111-1111-4111-8111-111111111111',goal:'Research https://example.test/search?q=private#section using sk-proj-abcdefghijklmnop.',summary:'Bounded research.',workers:[worker('source-a',['https://user:pass@example.test/search/token/abcdefghijklmnopqrstuvwxyz012345?q=private#part']),worker('source-b',[])],planner:{kind:'llm',model:'fixture',input_sha256:'a'.repeat(64)},max_concurrency:2,research_mode:null,execution_profile:null,created_at:now,execution_authority:false,approval_granted:false};
  return {format:1,run_id:'22222222-2222-4222-8222-222222222222',request_id:'dashboard-request',plan,revision:0,status:'running',workers:{'source-a':{id:'source-a',status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null},'source-b':{id:'source-b',status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}},mode:null,started_at_ms:Date.parse(now),target_deadline_at_ms:null,hard_deadline_at_ms:null,synthesis_reserve_ms:0,reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};
}
function requestWithHost(url,host){return new Promise((resolve,reject)=>{const target=new URL(url),request=httpRequest({hostname:target.hostname,port:target.port,path:target.pathname,headers:{host}},response=>{response.resume();response.once('end',()=>resolve(response.statusCode));});request.once('error',reject);request.end();});}

test('URL projection strips userinfo, query, fragment and high-entropy path material',()=>{
  assert.equal(sanitizeSwarmEndpoint('https://user:pass@example.test/a/token/abcdefghijklmnopqrstuvwxyz012345?q=private#x'),'https://example.test/a/token/:redacted');
  assert.equal(sanitizeSwarmEndpoint('file:///tmp/private'),null);
  const projected=projectSwarmRun(snapshot());assert.equal(projected.workers[0].endpoints[0],'https://example.test/search/token/:redacted');
  assert.doesNotMatch(JSON.stringify(projected),/private|user:pass|secret-value|sk-proj-/u);
});

test('worker and run transitions are journaled atomically and survive store reopen',async t=>{
  const x=await fixture(t),initial=snapshot();x.store.saveSwarmPlan(x.config.project.id,initial.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,initial.request_id,initial.plan.plan_id,initial,x.config.fingerprint);
  const leased=structuredClone(initial);leased.revision=1;leased.updated_at='2026-09-22T02:00:01.000Z';leased.workers['source-a'].status='leased';leased.workers['source-a'].attempts=1;leased.workers['source-a'].lease_token='lease-secret';leased.workers['source-a'].lease_expires_at_ms=Date.parse('2026-09-22T02:01:01.000Z');x.store.updateSwarmRun(x.config.project.id,initial.run_id,0,leased);
  const complete=structuredClone(leased);complete.revision=2;complete.updated_at='2026-09-22T02:00:02.000Z';complete.status='completed';complete.workers['source-a'].status='succeeded';complete.workers['source-a'].lease_token=null;complete.workers['source-a'].lease_expires_at_ms=null;complete.decision_events.push('decision-1');x.store.updateSwarmRun(x.config.project.id,initial.run_id,1,complete);
  const events=x.store.swarmActivities(x.config.project.id,0,50);assert.deepEqual(events.map(event=>event.kind),['run.started','worker.leased','worker.succeeded','decision.recorded','run.completed']);assert.ok(events.every(event=>event.revision<=complete.revision));
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());assert.equal(reopened.swarmRuns(x.config.project.id,5)[0].revision,2);assert.equal(reopened.swarmActivities(x.config.project.id,0,50).length,5);
  const dashboard=readSwarmDashboard(reopened,x.config.project.id);assert.equal(dashboard.read_only,true);assert.equal(dashboard.runs[0].active_count,0);assert.equal(dashboard.latest_event_id,events.at(-1).id);assert.doesNotMatch(JSON.stringify(dashboard),/lease-secret|q=private|user:pass|sk-proj-/u);
});

test('loopback capability dashboard serves read-only UI, snapshot and live SSE while rejecting wrong host, path and methods',async t=>{
  const x=await fixture(t),initial=snapshot();x.store.saveSwarmPlan(x.config.project.id,initial.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,initial.request_id,initial.plan.plan_id,initial,x.config.fingerprint);
  const server=await startSwarmDashboard(x.config,{poll_ms:30});t.after(()=>server.close());assert.match(server.url,/^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/$/u);
  const page=await fetch(server.url),body=await page.text();assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/script-src 'nonce-/u);assert.match(body,/Swarm/u);assert.match(body,/실행 중/u);assert.match(body,/prefers-reduced-motion/u);assert.match(body,/EventSource\('events'\)/u);assert.doesNotMatch(body,/secret-value|q=private/u);
  const api=await fetch(new URL('snapshot',server.url)),view=await api.json();assert.equal(api.status,200);assert.equal(view.runs[0].workers[0].lane,'queued');assert.equal(view.read_only,true);assert.doesNotMatch(JSON.stringify(view),/secret-value|q=private|user:pass/u);
  assert.equal((await fetch(new URL('../wrong',server.url))).status,404);assert.equal((await fetch(server.url,{method:'POST'})).status,405);assert.equal(await requestWithHost(server.url,'evil.test'),403);
  const abort=new AbortController(),stream=await fetch(new URL('events',server.url),{signal:abort.signal}),reader=stream.body.getReader(),decoder=new TextDecoder();const first=decoder.decode((await reader.read()).value);assert.match(first,/event: snapshot/u);assert.match(first,/"read_only":true/u);
  const leased=structuredClone(initial);leased.revision=1;leased.updated_at=new Date().toISOString();leased.workers['source-a'].status='leased';leased.workers['source-a'].attempts=1;leased.workers['source-a'].lease_token='private-lease';leased.workers['source-a'].lease_expires_at_ms=Date.now()+30_000;x.store.updateSwarmRun(x.config.project.id,initial.run_id,0,leased);
  let changed='';for(let attempt=0;attempt<5&&!changed.includes('worker.leased');attempt++)changed+=decoder.decode((await reader.read()).value);assert.match(changed,/worker\.leased/u);assert.match(changed,/"lane":"running"/u);assert.doesNotMatch(changed,/private-lease/u);
  abort.abort();await reader.cancel().catch(()=>undefined);
});

test('dashboard CLI is a distinct read-only monitoring entry point',()=>{
  assert.match(interfaceHelp,/dashboard --config PATH \[--port N\]/u);assert.match(interfaceHelp,/read-only loopback Control Center/u);
});
