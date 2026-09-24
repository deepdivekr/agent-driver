import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Script} from 'node:vm';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {readControlCenter,startControlCenter} from '../dist/observability/control-center.js';

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'driver-control-center-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'control-project',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',terminal:{executable:process.execPath,version:'2.1.126',tools:[]},packs:{sources:[],targets:[],models:'off',model_data_approved:false},swarm:{enabled:true,model_data_approved:true},observability:{surfaces:[{id:'browser-a',label:'Owned browser A',kind:'browser',endpoint:'http://127.0.0.1:49222'}],frame_interval_ms:500}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);t.after(async()=>{store.close();await rm(root,{recursive:true,force:true})});return {root,path,config,store};
}
function swarmSnapshot(){const now='2026-09-22T03:00:00.000Z',plan={format:1,plan_id:'11111111-1111-4111-8111-111111111111',goal:'Compare public sources',summary:'Bounded.',workers:[{id:'source-a',role:'Researcher',objective:'Inspect source',stage:'source_read',source_urls:['https://example.test/path?q=private'],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['source'],max_steps:5,timeout_ms:60000}],planner:{kind:'llm',model:'fixture',input_sha256:'a'.repeat(64)},max_concurrency:1,research_mode:null,execution_profile:null,created_at:now,execution_authority:false,approval_granted:false};return {format:1,run_id:'22222222-2222-4222-8222-222222222222',request_id:'swarm-request',plan,revision:0,status:'running',workers:{'source-a':{id:'source-a',status:'pending',attempts:0,lease_token:null,lease_expires_at_ms:null,result:null,quality:null}},mode:'standard',started_at_ms:Date.parse(now),target_deadline_at_ms:null,hard_deadline_at_ms:null,synthesis_reserve_ms:0,reviews:[],decision_events:[],created_at:now,updated_at:now,execution_authority:false,approval_granted:false};}

test('mixed Swarm Pack Task and CLI records project into one truthful control snapshot',async t=>{
  const x=await setup(t),swarm=swarmSnapshot();x.store.saveSwarmPlan(x.config.project.id,swarm.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,swarm.request_id,swarm.plan.plan_id,swarm,x.config.fingerprint);
  const recipe={version:1,family:'research.search',request:'Find safe results at https://user:pass@example.test/search?q=secret',sources:[],filters:[],deduplicate_by:[],query:'safe',search_fields:['title'],relevance:null,sort:null,limit:10};const pack=x.store.beginPack(x.config.project.id,'pack-request',recipe,x.config.fingerprint).run;
  const task=x.store.createTask(x.config.project.id,'coding.session');const session=x.store.startSession(x.config,'cli-request').session;
  x.store.recordRuntimeActivity(x.config.project.id,'pack',pack.id,null,'navigating','Open results api_key=hidden','https://user:pass@example.test/search/token/abcdefghijklmnopqrstuvwxyz012345?q=secret#x');
  x.store.recordRuntimeActivity(x.config.project.id,'terminal',session.id,'cli','tool_call','Inspect local files',null);
  const mcp=x.store.startPresence(x.config.project.id,'mcp',{transport:'stdio'}),view=readControlCenter(x.store,x.config);
  assert.deepEqual(new Set(view.runs.map(run=>run.kind)),new Set(['swarm','pack','task','terminal']));assert.equal(view.health.find(item=>item.id==='mcp').state,'active');assert.equal(view.coverage.outside_runtime,'unobserved');assert.equal(view.read_only,true);
  assert.match(JSON.stringify(view),/https:\/\/example\.test\/search\/token\/:redacted/u);assert.doesNotMatch(JSON.stringify(view),/user:pass|q=secret|api_key=hidden/u);
  assert.equal(view.runs.find(run=>run.id===session.id).actors[0].activity,'tool_call');assert.equal(view.runs.find(run=>run.id===task.id).kind,'task');x.store.stopPresence(x.config.project.id,mcp);
});

test('generic activity report is scoped, sanitized, durable and never grants authority',async t=>{
  const x=await setup(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const pack=api.store.beginPack(x.config.project.id,'api-pack',{version:1,family:'research.search',request:'search',sources:[],filters:[],deduplicate_by:[],query:'q',search_fields:['title'],relevance:null,sort:null,limit:2},x.config.fingerprint).run;
  const result=await api.call('runtime_activity_report',{owner_kind:'pack',owner_id:pack.id,actor_id:null,activity:{kind:'navigating',summary:'Visit page password=do-not-store',endpoint:'https://user:pass@example.test/a?secret=1#x',surface_id:'browser-a',decision_layer:'code'}});
  assert.deepEqual({recorded:result.recorded,authority_granted:result.authority_granted,completion_verified:result.completion_verified},{recorded:true,authority_granted:false,completion_verified:false});
  const stored=api.store.runtimeActivities(x.config.project.id).at(-1);assert.equal(stored.endpoint,'https://example.test/a');assert.doesNotMatch(stored.summary,/do-not-store/u);
  assert.equal(stored.surface_id,'browser-a');assert.equal(stored.decision_layer,'code');const actor=readControlCenter(api.store,x.config).runs.find(run=>run.id===pack.id).actors[0];assert.equal(actor.surface.kind,'browser');assert.equal(actor.decision_layer,'code');
  await assert.rejects(api.call('runtime_activity_report',{owner_kind:'pack',owner_id:'missing',actor_id:null,activity:{kind:'started',summary:'x',endpoint:null}}),/PACK_RUN_NOT_FOUND/u);
  await assert.rejects(api.call('runtime_activity_report',{owner_kind:'pack',owner_id:pack.id,actor_id:null,activity:{kind:'started',summary:'x',endpoint:null,surface_id:'not-delegated'}}),/CONTROL_SURFACE_UNDELEGATED/u);
});

test('presence distinguishes active stale stopped and Office HTTP remains capability-addressed',async t=>{
  const x=await setup(t),stale=x.store.startPresence(x.config.project.id,'mcp');
  // A stale active row represents an uncleanly terminated gateway. Public APIs never forge active health from configuration.
  const db=(await import('node:sqlite')).DatabaseSync;const raw=new db(x.config.dbPath);raw.prepare('UPDATE runtime_presence SET heartbeat_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',stale);raw.close();
  assert.equal(readControlCenter(x.store,x.config).health.find(item=>item.id==='mcp').state,'stale');
  const server=await startControlCenter(x.config,{poll_ms:25});const page=await fetch(server.url),body=await page.text();assert.equal(page.status,200);assert.match(body,/Agent Office/u);assert.match(body,/업무 현황/u);assert.doesNotMatch(body,/LIVE ACTOR WALL|<img|surface-frame/u);assert.match(body,/href="connections"/u);assert.match(body,/href="settings"/u);assert.doesNotThrow(()=>new Script(body.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));assert.equal((await fetch(server.url,{method:'POST'})).status,405);assert.equal((await fetch(new URL('../invalid',server.url))).status,404);assert.equal((await fetch(new URL('surface/missing/frame',server.url))).status,404);assert.equal((await fetch(new URL('surface/browser-a/frame',server.url))).status,404);
  const snapshot=await (await fetch(new URL('snapshot',server.url))).json();assert.equal(snapshot.health.find(item=>item.id==='mcp').state,'stale');assert.equal(snapshot.read_only,true);await server.close();
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());assert.equal(reopened.presences(x.config.project.id).find(p=>p.kind==='dashboard').state,'stopped');
});

test('managed worker surfaces bind before activity and expired leases stop projecting as live',async t=>{
  const x=await setup(t),swarm=swarmSnapshot(),expires=Date.now()+60000;
  Object.assign(swarm.workers['source-a'],{status:'leased',lease_token:'lease-a',lease_expires_at_ms:expires});
  x.store.saveSwarmPlan(x.config.project.id,swarm.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,swarm.request_id,swarm.plan.plan_id,swarm,x.config.fingerprint);
  x.store.bindControlSurface(x.config.project.id,swarm.run_id,'source-a','lease-a','managed-a','http://127.0.0.1:49321/'+ 'a'.repeat(48)+'/frame/managed-a');
  const active=readControlCenter(x.store,x.config),actor=active.runs[0].actors[0];
  assert.equal(actor.surface.id,'managed-a');assert.equal(actor.surface.state,'active');assert.equal(actor.surface.frame_path,null);assert.equal(actor.decision_layer,null);assert.equal(actor.updated_at,null);assert.equal(actor.lane,'running');
  assert.doesNotMatch(JSON.stringify(active),/49321|a{48}|preview_endpoint/u);
  const stale=readControlCenter(x.store,x.config,expires+1);assert.equal(stale.runs[0].actors[0].lease_stale,true);assert.equal(stale.runs[0].actors[0].lane,'attention');assert.notEqual(stale.latest_revision,active.latest_revision);
  x.store.endControlSurface(x.config.project.id,swarm.run_id,'source-a','closed');const closed=readControlCenter(x.store,x.config);assert.equal(closed.runs[0].actors[0].surface.state,'closed');assert.notEqual(closed.latest_revision,active.latest_revision);
});

test('brief Jev activity survives a following code event between snapshot polls without inventing other layers',async t=>{
  const x=await setup(t),swarm=swarmSnapshot(),now=Date.now(),jevAt=new Date(now-300).toISOString(),codeAt=new Date(now-50).toISOString();
  swarm.plan.workers.push({...swarm.plan.workers[0],id:'source-b'});swarm.workers['source-b']={...swarm.workers['source-a'],id:'source-b'};
  Object.assign(swarm.workers['source-a'],{status:'leased',lease_token:'lease-a',lease_expires_at_ms:now+60000});
  x.store.saveSwarmPlan(x.config.project.id,swarm.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,swarm.request_id,swarm.plan.plan_id,swarm,x.config.fingerprint);
  x.store.recordSwarmActivity(x.config.project.id,swarm.run_id,0,'source-a','worker.activity',{activity_kind:'observing',summary:'Jev chose the next source',decision_layer:'jev'},jevAt);
  x.store.recordSwarmActivity(x.config.project.id,swarm.run_id,0,'source-a','worker.activity',{activity_kind:'navigating',summary:'Open the source',decision_layer:'code'},codeAt);
  const actors=readControlCenter(x.store,x.config,now).runs[0].actors,actor=actors.find(item=>item.id==='source-a');
  assert.equal(actor.decision_layer,'code','latest current layer remains code');assert.deepEqual(actor.layer_activity_at,{jev:jevAt,code:codeAt});assert.equal(actor.layer_activity_at.llm,undefined);assert.deepEqual(actors.find(item=>item.id==='source-b').layer_activity_at,{});
  const server=await startControlCenter(x.config);t.after(()=>server.close());const office=await (await fetch(new URL('office/snapshot',server.url))).json();
  assert.match(JSON.stringify(office.works[0].events),/Jev chose the next source/u);assert.match(JSON.stringify(office.works[0].events),/Open the source/u);
  const body=await (await fetch(server.url)).text();assert.doesNotMatch(body,/decision-tag active/u);
});

test('retired frame route never contacts an old managed preview endpoint',async t=>{
  const x=await setup(t),swarm=swarmSnapshot();Object.assign(swarm.workers['source-a'],{status:'leased',lease_token:'lease-a',lease_expires_at_ms:Date.now()+60000});
  x.store.saveSwarmPlan(x.config.project.id,swarm.plan,x.config.fingerprint);x.store.beginSwarmRun(x.config.project.id,swarm.request_id,swarm.plan.plan_id,swarm,x.config.fingerprint);
  let requests=0;
  const preview=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'image/jpeg'});response.end(Buffer.from([0xff,0xd8,0xff,0xd9]));});
  preview.listen(0,'127.0.0.1');await once(preview,'listening');t.after(()=>new Promise(resolve=>preview.close(resolve)));
  const endpoint='http://127.0.0.1:'+preview.address().port+'/'+ 'b'.repeat(48)+'/frame/managed-a';x.store.bindControlSurface(x.config.project.id,swarm.run_id,'source-a','lease-a','managed-a',endpoint);
  await assert.rejects(startControlCenter(x.config,{capability_token:'../bad'}),/CONTROL_CENTER_CAPABILITY_INVALID/u);
  const server=await startControlCenter(x.config,{capability_token:'c'.repeat(48)});t.after(()=>server.close());assert.equal(new URL(server.url).pathname,'/'+ 'c'.repeat(48)+'/');
  const path=new URL('surface/managed-a/frame',server.url),responses=await Promise.all([fetch(path),fetch(path)]);assert.ok(responses.every(response=>response.status===404));assert.equal(requests,0);
  x.store.endControlSurface(x.config.project.id,swarm.run_id,'source-a','failed');assert.equal((await fetch(path)).status,404);assert.equal(requests,0);
});
