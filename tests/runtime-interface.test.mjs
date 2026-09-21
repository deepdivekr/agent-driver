import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {DatabaseSync} from 'node:sqlite';
import {createServer,request as httpRequest} from 'node:http';
import {startFixture} from '../dist/evaluation-v2/fixture.js';
import {makeCase} from '../dist/evaluation-v2/oracle.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {intake} from '../dist/interface/intake.js';
import {tools} from '../dist/interface/catalog.js';
import {MIGRATION_1} from '../dist/store/migration.js';
import {RuntimeStore} from '../dist/store/runtime-store.js';
import {stopSupervisor} from '../dist/supervisor/manager.js';
import {liveness} from '../dist/supervisor/identity.js';

async function setup(t,environment='fixture'){
  const root=await mkdtemp(join(tmpdir(),'driver-interface-')),fixture=await startFixture();
  const spec=makeCase('interface','S02',42,'normal'),url=fixture.create(spec),path=join(root,'host.json');
  const raw={schema_version:1,project_id:'test-project',caller_ref:'test-agent',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment,...(environment==='fixture'?{fixture_url:url}:{})};
  await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),api=new RuntimeApi(config),clients=[];
  const state={root,path,raw,config,api,fixture,spec,clients};
  t.after(async()=>{for(const c of clients)await c.close().catch(()=>{});assert.equal((await stopSupervisor(state.config)).stopped,true);
    for(const row of state.api.store.submissions(state.config.project.id)){if(row.worker_identity_json){const end=performance.now()+10000;while(await liveness(JSON.parse(row.worker_identity_json))==='alive'&&performance.now()<end)await delay(25);assert.equal(await liveness(JSON.parse(row.worker_identity_json)),'dead');}}
    state.api.close();await fixture.close();await rm(root,{recursive:true,force:true});});
  return state;
}
const request=id=>({request_id:id,capability:'fixture.draft.save',account_ref:'account-a',input:{name:'한글 🐈',note:'원문 그대로 저장'},deadline_ms:20000});
async function client(x){const client=new Client({name:'interface-test',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp','--config',x.path],stderr:'pipe'});let errors='';transport.stderr?.on('data',b=>errors+=b);await client.connect(transport);assert.deepEqual(client.getServerVersion(),{name:'agent-driver',version:'0.1.0-alpha.15'});x.clients.push(client);return {client,transport,errors:()=>errors};}
async function call(client,name,args={}){const reply=await client.callTool({name,arguments:args});assert.notEqual(reply.isError,true,JSON.stringify(reply));return JSON.parse(reply.content[0].text);}
async function complete(x,taskId){const end=performance.now()+20000;let last;while(performance.now()<end){last=await x.api.call('runtime_task_status',{task_id:taskId});if(['succeeded','cancelled','failed','paused_dependency','reconciliation_required'].includes(last.status))return last;await delay(50);}throw Error(`worker did not finish: ${JSON.stringify(last)}`);}
async function cli(args){const c=spawn(process.execPath,['dist/cli.js',...args],{stdio:['ignore','pipe','pipe']});let out='',err='';c.stdout.on('data',b=>out+=b);c.stderr.on('data',b=>err+=b);const [code]=await once(c,'close');return {code,out,err};}

test('runtime native production default disables fixture execution and rejects caller-supplied authority',async t=>{
  const x=await setup(t,'production');assert.deepEqual((await x.api.call('runtime_capabilities_list',{})).capabilities,[]);
  await assert.rejects(x.api.call('runtime_task_start',request('denied')),/CAPABILITY_NOT_DELEGATED/);
  await assert.rejects(x.api.call('runtime_task_start',{...request('denied'),caller_ref:'admin',approved:true}));
  assert.equal(x.api.store.tasks(x.config.project.id).length,0);
});
test('runtime contract intake preserves Unicode and source offsets but never grants dispatch',()=>{
  const prompt='  이름 봄🐈, 메모 점심 회의 초안을 저장해';
  assert.equal(intake({prompt}).status,'NEEDS_EXTRACTION');
  const source=value=>({value,start:prompt.indexOf(value),end:prompt.indexOf(value)+value.length});
  const proposal={pack:'fixture.draft.save',name:source('봄🐈'),note:source('점심 회의')};
  const result=intake({prompt,proposal});assert.equal(result.status,'PROPOSED');assert.equal(result.dispatch_allowed,false);assert.equal(result.input.name,'봄🐈');
  assert.throws(()=>intake({prompt,proposal:{...proposal,name:{...proposal.name,value:'다른 값'}}}),/SPAN_PROVENANCE_MISMATCH/);
  assert.throws(()=>intake({prompt,proposal:{...proposal,note:proposal.name}}),/OVERLAPPING/);
  assert.throws(()=>intake({prompt,approved:true}));assert.throws(()=>intake({prompt:'\n비밀'}),/ONE_LINE/);
});
test('runtime native schema v1 upgrades without discarding existing project/task/events',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-migrate-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'old.sqlite');
  const old=new DatabaseSync(path);old.exec(MIGRATION_1);old.exec('INSERT INTO schema_version VALUES (1)');old.prepare('INSERT INTO project VALUES (?,?)').run('old',JSON.stringify({id:'old',capabilities:[]}));old.close();
  const store=new RuntimeStore(path);assert.equal(store.project('old').id,'old');store.close();
  const db=new DatabaseSync(path);assert.equal(db.prepare('SELECT version FROM schema_version').get().version,8);db.close();
});
test('runtime native C01 CLI and SDK stdio share capability semantics with independent tasks',{timeout:60000},async t=>{
  const x=await setup(t),r=request('cli-first'),file=join(x.root,'request.json');await writeFile(file,JSON.stringify(r));
  const a=await cli(['task','start','--config',x.path,'--request-file',file,'--json']);assert.equal(a.code,0,a.err);const first=JSON.parse(a.out);
  assert.equal((await complete(x,first.task_id)).status,'succeeded');
  const m=await client(x),second=await call(m.client,'runtime_task_start',request('mcp-second'));
  assert.notEqual(first.task_id,second.task_id);const final=await complete(x,second.task_id);assert.equal(final.status,'succeeded');assert.equal(final.verification.result,'MATCH');
  assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,2);
  const catalog=await m.client.listTools();assert.equal(catalog.tools.length,Object.keys(tools).length+1);assert.deepEqual(catalog.tools.map(t=>t.name).sort(),[...Object.keys(tools),'runtime_task_intake'].sort());
  assert.deepEqual(await call(m.client,'runtime_storage_status',{}),{status:'unconfigured',verified:false,usage:'unobserved'});
  const decisions=await call(m.client,'runtime_decision_status',{});assert.equal(decisions.scope,'fixture');assert.equal(decisions.mutation_allowed,false);assert.equal(decisions.profile_promotion_exposed,false);assert.deepEqual(decisions.decisions.map(item=>item.catalog_id).sort(),['adaptive.browser','pack.row','task.intake']);
  assert.equal(catalog.tools.find(t=>t.name==='runtime_decision_status').annotations.readOnlyHint,true);
  const plan=await m.client.callTool({name:'runtime_storage_plan',arguments:{}});assert.equal(plan.isError,true);assert.match(plan.content[0].text,/STORAGE_UNCONFIGURED/);
  const prune=await m.client.callTool({name:'runtime_storage_prune',arguments:{plan_sha256:'a'.repeat(64),approved:true}});assert.equal(prune.isError,true);
  assert.equal(catalog.tools.find(t=>t.name==='runtime_storage_prune').annotations.destructiveHint,true);
  assert.equal(catalog.tools.some(t=>/grant|shell|eval/.test(t.name)||t.name==='runtime_pack_approve'),false);
  const unsupported=await m.client.callTool({name:'runtime_terminal_status',arguments:{session_ref:'missing'}});assert.equal(unsupported.isError,true);assert.match(unsupported.content[0].text,/TERMINAL_DISABLED/);
  const malformed=await m.client.callTool({name:'runtime_task_start',arguments:{...request('invalid'),approved:true}});assert.equal(malformed.isError,true);
});
test('runtime native gateway exits while accepted detached worker continues; retry and reconnect do not replay',{timeout:60000},async t=>{
  const x=await setup(t),m=await client(x),body=request('durable-id');
  const accepted=await call(m.client,'runtime_task_start',body);await m.client.close();
  const finished=await complete(x,accepted.task_id);assert.equal(finished.status,'succeeded');
  const other=await client(x),repeated=await call(other.client,'runtime_task_start',body);assert.equal(repeated.task_id,accepted.task_id);assert.equal(repeated.deduplicated,true);
  const events=await call(other.client,'runtime_events_read',{consumer_id:'reader'});
  await other.client.close();const next=await client(x);
  const reconnected=(await call(next.client,'runtime_events_read',{consumer_id:'reader'})).events;
  assert.deepEqual(reconnected.slice(0,events.events.length).map(e=>e.id),events.events.map(e=>e.id));
  assert.equal(new Set(reconnected.map(e=>e.id)).size,reconnected.length);
  await call(next.client,'runtime_events_ack',{consumer_id:'reader',event_id:events.events.at(-1).id});
  assert.equal((await call(next.client,'runtime_events_read',{consumer_id:'reader'})).events.some(e=>e.id<=events.events.at(-1).id),false);
  await assert.rejects(x.api.call('runtime_task_start',{...body,input:{...body.input,note:'changed'}}),/REQUEST_ID_CONFLICT/);
  assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,1);
});
test('runtime native simultaneous duplicate starts persist only one task and one save',{timeout:60000},async t=>{
  const x=await setup(t),a=await client(x),b=await client(x),r=request('same-id');
  const [one,two]=await Promise.all([call(a.client,'runtime_task_start',r),call(b.client,'runtime_task_start',r)]);
  assert.equal(one.task_id,two.task_id);assert.equal((await complete(x,one.task_id)).status,'succeeded');assert.equal(x.api.store.tasks(x.config.project.id).length,1);
  assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,1);
});
test('runtime native cross-project task reads and mutations are rejected',async t=>{
  const x=await setup(t);x.api.store.registerProject({...x.config.project,id:'other',profileRef:'other-owned'});
  const task=x.api.store.createTask('other','fixture.draft.save');
  for(const name of ['runtime_task_status','runtime_task_cancel','runtime_artifacts_list'])await assert.rejects(x.api.call(name,{task_id:task.id}),/TASK_SCOPE_MISMATCH/);
  assert.equal(x.api.store.task(task.id).status,'queued');
});
test('runtime native fixture config rejects remote origins and unknown authority fields',async t=>{
  const x=await setup(t);for(const changed of [{fixture_url:'https://example.com/case/account-a/'},{approved:true},{fixture_url:'http://127.0.0.1:42/case/account-b/'}]){
    await writeFile(x.path,JSON.stringify({...x.raw,...changed}));assert.throws(()=>loadHostConfig(x.path));
  }
  assert.ok((await readFile(x.path,'utf8')).length>0);
});
test('runtime native SIGKILL gateway during blocked navigation leaves the worker alive and bound',{timeout:60000},async t=>{
  const x=await setup(t);x.api.close();
  let release,seen;const gate=new Promise(resolve=>{release=resolve;}),arrived=new Promise(resolve=>{seen=resolve;});
  const proxy=createServer((req,res)=>{void(async()=>{
    if(req.url.endsWith('/account-a/')){seen();await gate;}
    const upstream=httpRequest(x.fixture.baseUrl+req.url,{method:req.method,headers:req.headers},r=>{res.writeHead(r.statusCode,r.headers);r.pipe(res);});
    upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
  })();});await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{release();proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));});
  const raw={...x.raw,data_dir:join(x.root,'barrier-data'),fixture_url:`http://127.0.0.1:${proxy.address().port}/interface/account-a/`};
  await writeFile(x.path,JSON.stringify(raw));x.config=loadHostConfig(x.path);x.api=new RuntimeApi(x.config);
  const m=await client(x),accepted=await call(m.client,'runtime_task_start',request('kill-gateway'));
  await arrived;assert.equal(x.api.store.task(accepted.task_id).status,'running');
  const closed=new Promise(resolve=>{m.client.onclose=resolve;});assert.ok(m.transport.pid);process.kill(m.transport.pid,'SIGKILL');await closed;
  assert.equal(x.api.store.task(accepted.task_id).status,'running');assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,0);
  release();assert.equal((await complete(x,accepted.task_id)).status,'succeeded');
  assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,1);
});
test('runtime native distinct concurrent requests serialize one persistent browser profile',{timeout:60000},async t=>{
  const x=await setup(t),a=await client(x),b=await client(x);
  const [one,two]=await Promise.all([call(a.client,'runtime_task_start',request('first')),call(b.client,'runtime_task_start',request('second'))]);
  const results=await Promise.all([complete(x,one.task_id),complete(x,two.task_id)]);assert.deepEqual(results.map(x=>x.status),['succeeded','succeeded']);
  assert.equal(x.fixture.snapshot(x.spec.runId).effects.filter(e=>e.kind==='save').length,2);
});
test('runtime native fixture lab CLI starts a connectable owned app and refuses configuration overwrite',{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-lab-')),dir=join(root,'lab');
  const child=spawn(process.execPath,['dist/cli.js','fixture','serve','--data-dir',dir],{stdio:['ignore','pipe','pipe']});
  const exit=once(child,'exit');let output='';
  const ready=new Promise((resolve,reject)=>{child.stdout.on('data',b=>{output+=b;if(output.includes('\n'))resolve(JSON.parse(output.trim()));});child.once('exit',()=>reject(Error('lab exited before readiness')));});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await exit;await rm(root,{recursive:true,force:true});});
  const info=await ready;assert.equal(info.environment,'synthetic_only');const before=await readFile(info.config_file,'utf8');
  const health=await cli(['doctor','--config',info.config_file]);assert.equal(health.code,0);assert.equal(JSON.parse(health.out).environment,'fixture');
  const duplicate=await cli(['fixture','serve','--data-dir',dir]);assert.equal(duplicate.code,1);assert.equal(await readFile(info.config_file,'utf8'),before);
  const invalid=await cli(['doctor','--config',info.config_file,'--prompt','ignored']);assert.equal(invalid.code,1);assert.match(invalid.err,/UNKNOWN_OPTION/);
});
test('runtime native queue limit is atomic and cancellation does not reclaim a live worker profile',async t=>{
  const x=await setup(t),one=x.api.store.enqueue(x.config.project.id,'direct-0','fixture.draft.save',request('direct-0'),x.config.fingerprint);
  x.api.store.claimSubmission(one.task.id,x.config.fingerprint,'owned-worker');
  const {browserResource}=await import('../dist/policy/dispatch-guard.js');
  const lease=x.api.store.acquire(one.task.id,browserResource(x.config.project),'owned-page');x.api.store.cancel(one.task.id);
  const second=x.api.store.createTask(x.config.project.id,'fixture.draft.save');assert.throws(()=>x.api.store.acquire(second.id,browserResource(x.config.project),'next-page'),/RESOURCE_BUSY/);
  x.api.store.release(lease);
  for(let i=1;i<=15;i++)x.api.store.enqueue(x.config.project.id,`direct-${i}`,'fixture.draft.save',request(`direct-${i}`),x.config.fingerprint);
  assert.throws(()=>x.api.store.enqueue(x.config.project.id,'too-many','fixture.draft.save',request('too-many'),x.config.fingerprint),/PROJECT_QUEUE_FULL/);
});
