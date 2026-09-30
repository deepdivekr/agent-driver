import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {workActivity,workObservation,workTail,shortWorkTitle} from '../dist/work/activity.js';
import {prepareLoginVm} from '../dist/swarm/login-vm.js';
import {BrowserLoginBroker,requireSiteAuth,authSites} from '../dist/swarm/browser-auth.js';
import {HermesWorkRuntime} from '../dist/work/hermes.js';
import {WorkDispatcher} from '../dist/work/dispatch.js';
const proposal={title:'데이터 조회',desired_outcome:'파일의 결과 확인',completion_checks:[{id:'result',result:'원본과 일치',evidence:'조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'office-live-')),host=join(root,'host.json');
 await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'observed result'}]));
 await writeFile(host,JSON.stringify({schema_version:1,project_id:'live-test',caller_ref:'test',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true,visual:{enabled:true,owned_vm:{id:'owned-test',storage_root:join(root,'vm'),devtools_port:49222,vnc_port:45901}}}}));
 const config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:{async call(){return proposal;}}});
 const work=await api.call('runtime_work_start',{request_id:'new-work',prompt:recipe.request});
 let release;const gate=new Promise(resolve=>release=resolve);
 const server=await startControlCenter(config,{workModel:{calls:[],async call(_purpose,instructions,input){
  if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{
   // A controlled-run trace is provenance, not the file contents being checked.
   // Cite only evidence attached to the actual Pack source observation.
   const evidence_ids=input.observations.filter(item=>item.tool_name==='runtime_pack_run'&&JSON.stringify(item.value).includes('observed result')).flatMap(item=>item.evidence_ids).filter(id=>check.allowed_evidence_ids.includes(id));
   assert.ok(evidence_ids.length>0,'Verification requires an actual delegated source observation.');
   return {id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids,evidence_quotes:evidence_ids.map(evidence_id=>({evidence_id,quote:'observed result'})),reason:'Actual delegated file observation.'};
  })};
  assert.ok(instructions.startsWith('Execute the registered Work'));
  if(input.checkpoint.observations.length){const receipt=input.checkpoint.observations[0].receipt;return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Actual source: observed result',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:receipt.evidence_ids})),wait_reason:null};}
  await gate;return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe}),summary:'Read the delegated file through the Pack runtime.',completed_checks:[],wait_reason:null};
 }}});
 t.after(async()=>{release();await server.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
 const post=body=>fetch(server.url+'work/execute',{method:'POST',headers:{Origin:new URL(server.url).origin,'X-Agent-Driver':'human-office','Content-Type':'application/json'},body:JSON.stringify(body)});
 const detail=async()=>{const r=await fetch(server.url+'work/detail?id='+work.work_id);assert.equal(r.status,200);return r.json();};
 return {root,config,api,work,server,release,post,detail};
}
test('runtime fixture UI dispatch performs native file read, deduplicates clicks, exposes real Work logs',async t=>{
 const x=await setup(t),body={work_id:x.work.work_id,revision:x.work.revision,executor:'client',cost_acknowledged:true};
 assert.equal((await x.detail()).execution_action.executor,'client');
 assert.equal((await fetch(x.server.url+'work/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})).status,403);
 assert.equal((await x.post({...body,cost_acknowledged:false})).status,409);
 assert.equal((await x.post({...body,revision:99})).status,409);
 assert.equal((await x.post(body)).status,202);
 assert.equal((await (await x.post(body)).json()).deduplicated,true);
 const running=await x.detail();assert.equal(running.display_status,'running');assert.equal(running.execution.live,true);
 assert.ok(running.activity.some(e=>e.kind==='supervisor.started'));
 x.release();let completed;
 for(let i=0;i<100;i++){completed=await x.detail();if(completed.activity.some(e=>e.kind==='supervisor.result'))break;await delay(50);}
 assert.ok(completed.activity.some(e=>e.kind==='supervisor.result'),JSON.stringify(completed));assert.equal(completed.supervisor.state,'succeeded');
 assert.equal(completed.execution.live,false);assert.equal(completed.runs.length,1);assert.equal(completed.execution_action,null);
 assert.equal((await x.post(body)).status,409);
 assert.equal(JSON.parse(await readFile(join(x.root,'source.json'),'utf8'))[0].title,'observed result');
});
test('runtime contract stale state is not live execution and tail stays scoped, bounded and redacted',async t=>{
 const x=await setup(t),store=x.api.store,project=x.config.project.id,id=x.work.work_id;
 assert.equal(workObservation(store,project,id,'running').status,'execution_unobserved');
 store.hermesState.prepare('INSERT INTO office_execution(work_id,project_id,owner,lease_until_ms,state,updated_at) VALUES(?,?,?,?,?,?)').run(id,project,'expired',Date.now()-1,'running',new Date().toISOString());
 assert.equal(workObservation(store,project,id,'ready').status,'execution_unobserved');
 for(let i=0;i<150;i++)workActivity(store,project,id,'observed','entry '+i);
 workActivity(store,project,'another-work','secret','other work contents');
 workActivity(store,project,id,'observed','password=do-not-show');
 const logs=workTail(store,project,id);assert.ok(!JSON.stringify(logs).includes('do-not-show'));assert.ok(logs.length<=100);assert.ok(!JSON.stringify(logs).includes('other work contents'));
 assert.throws(()=>workTail(store,'other-project',id));
 assert.ok([...shortWorkTitle('이전 업무 · '+ '아주 긴 업무 지침 '.repeat(30))].length<=28);
});
test('runtime browser Work execute and event tail work on mobile without losing interaction',async t=>{
 const x=await setup(t),browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];
 page.on('pageerror',error=>errors.push(error.message));await page.addInitScript(()=>{if(!localStorage.getItem('office-lang'))localStorage.setItem('office-lang','ko');});
 await page.goto(x.server.url+'?work='+x.work.work_id);
 if(!await page.locator('#execute-work').count())await page.getByText('데이터 조회',{exact:true}).first().click();
 assert.equal(await page.locator('#execution-consent').count(),0);assert.equal(await page.locator('#execute-work').isEnabled(),true);await page.locator('#execute-work').click();
 await page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('supervisor.started'));
 x.release();await page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('supervisor.result'));
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 await page.getByRole('button',{name:'언어: 한국어. 영어로 전환'}).click();
 await page.getByRole('heading',{name:'Execution timeline'}).waitFor();
 assert.doesNotMatch(await page.locator('.work-tail').innerText(),/[가-힣]/u);
 assert.deepEqual(errors,[]);
});
test('runtime contract explicit login starts one existing VM, preserves disk, and releases failed handoff',async t=>{
 const x=await setup(t),root=join(x.root,'vm','owned-test');await mkdir(root,{recursive:true});
 const manifest={format:1,id:'owned-test',base_image:join(x.root,'base.img'),base_image_sha256:'a'.repeat(64),memory_mib:2048,cpus:2,disk_gib:30,ssh_port:42222,devtools_port:49222,vnc_port:45901,guest_user:'agentdriver',isolation:'qemu_kvm_no_shared_folders_loopback_forwards'};
 await writeFile(join(root,'vm-manifest.json'),JSON.stringify(manifest));await writeFile(join(root,'browser.qcow2'),'original profile');
 let launches=0,running=false,ready=false;
 const ops={async running(){return running;},async launch(spec){assert.equal(spec.memory_mib,2048);launches++;running=true;},async ready(){return ready;},async wait(){ready=true;await delay(10);},attempts:3};
 await Promise.all([prepareLoginVm(x.config,ops),prepareLoginVm(x.config,ops)]);assert.equal(launches,1);
 await prepareLoginVm(x.config,ops);assert.equal(launches,1);
 assert.equal(await readFile(join(root,'browser.qcow2'),'utf8'),'original profile');
 requireSiteAuth(x.api.store,x.config,['https://x.com']);const broker=new BrowserLoginBroker(x.api.store,x.config,async()=>{throw Error('AUTH_VM_BROWSER_NOT_READY');});
 await assert.rejects(broker.open('x.com'),/AUTH_VM_BROWSER_NOT_READY/);assert.equal(authSites(x.api.store,x.config)[0].handoff,false);
 await assert.rejects(prepareLoginVm(x.config,{...ops,async ready(){return false;},attempts:1}),/AUTH_VM_BROWSER_NOT_READY/);
 await prepareLoginVm(x.config,ops);assert.equal(launches,1);
});
test('runtime fixture new Work binds Hermes once and streams tool/reply events under its original ID',async t=>{
 const x=await setup(t);let calls=0;
 const runtime=new HermesWorkRuntime(x.api.store,x.config,{transport:callbacks=>({async request(method,args){
   if(method==='initialize')return {protocolVersion:1};
   if(method==='session/new')return {sessionId:'test-session'};
   if(method==='session/prompt'){calls++;callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'tool_call',title:'Read local fixture',status:'in_progress'}});callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fixture reply'}}});return {stopReason:'end_turn'};}
   throw Error('UNEXPECTED_METHOD');
 },notify(){},async close(){}})});
 const dispatcher=new WorkDispatcher(x.api.store,{...x.config,packs:undefined},{async call(){throw Error('NO_MODEL');}},runtime);
 t.after(async()=>{await dispatcher.close();await runtime.close();});
 const count=x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_work').get().n;
 dispatcher.start({work_id:x.work.work_id,revision:x.work.revision,executor:'hermes',cost_acknowledged:true});
 await runtime.drain();assert.equal(calls,1);
 assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_work').get().n,count);
 assert.equal(runtime.status(x.work.work_id).hermes.turns[0].reply,'Fixture reply');
 assert.ok(workTail(x.api.store,x.config.project.id,x.work.work_id).some(e=>e.summary.includes('Read local fixture')));
});
