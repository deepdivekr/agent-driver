import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkImportRuntime,importedConnectionReadiness} from '../dist/work/import-runtime.js';
import {HermesWorkRuntime,importHermesWork} from '../dist/work/hermes.js';
import {RemoteOffice} from '../dist/work/remote.js';
import {WorkAdoptionRuntime,importedWorkAdoption} from '../dist/work/adoption.js';

const remoteTarget={name:'Disposable original runtime',host:'example.invalid',user:'agent',entry:'/app/openclaw.mjs'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'office-adoption-')),project=join(root,'original-bot');await mkdir(project);
 const code='def main():\n    print("existing telegram bot output")\n';await writeFile(join(project,'run.py'),code);
 const paths=await prepareLocalConnection(join(root,'office')),raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));raw.work={model_data_approved:true};await writeFile(paths.runtimeConfig,JSON.stringify(raw));
 const config=loadHostConfig(paths.runtimeConfig),store=new PackStore(config.dbPath);store.registerProject(config.project);
 const imports=new WorkImportRuntime(store,config,{async call(_purpose,_instructions,input){const e=input.evidence.find(e=>e.signal==='entrypoint');return {title:'Existing bot',goal:'Observe original bot results',prompt:'Observe the original bot',steps:[{id:'read',goal:'Read original records',depends_on:[],evidence_ids:[e.id]}],completion:[{id:'receipt',result:'Original record is observed',proof:'Original runtime receipt',evidence_ids:[e.id]}],unknowns:[]};}});
 const preview=await imports.scan({path:project}),imported=await imports.accept({import_id:preview.import_id,mode:'observe'}),requests=[];
 const hermes=new HermesWorkRuntime(store,config,{transport(callbacks){return {async request(method,args){requests.push(method);if(method==='session/new')return {sessionId:'disposable-session'};if(method==='session/prompt'){callbacks.update({sessionId:args.sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Disposable verified reply\n'}}});return {stopReason:'end_turn'}}return {};},notify(){},async close(){}};}});
 const calls=[],remote=new RemoteOffice(store,config,{async call(_target,method,params){calls.push({method,params});if(method==='sessions.list')return {sessions:[{key:'session:existing',label:'Original session'}]};if(method==='cron.list')return {jobs:[{id:'original-job',name:'Original daily bot',schedule:{expr:'0 8 * * *'},enabled:true}]};if(method==='cron.runs')return {entries:[{status:'ok',ts:1700000000000,summary:'Original job ran; token=private-example'}]};if(method==='chat.history')return {sessionId:'observed-session',messages:[{role:'assistant',content:'Original session reply'}]};throw Error('Unexpected remote mutation '+method);}});
 const runtime=new WorkAdoptionRuntime(store,config,hermes,remote);
 t.after(async()=>{await hermes.close();await remote.drain();store.close();await rm(root,{recursive:true,force:true});});
 return {root,project,code,config,store,imports,imported,hermes,remote,runtime,requests,calls};
}
function addHermes(x,key='registered-original'){
 return importHermesWork(x.store,x.config.project.id,key,{title:'Registered Hermes work',goal:'Observe only',checks:['Output exists'],steps:['Observe output'],family:'workflow.imported',history:[],instruction:'Observe the disposable output only'});
}
function bind(x,targetId){const list=x.runtime.targets({work_id:x.imported.work_id}),target=list.targets.find(t=>t.id===targetId);assert.ok(target);return {work_id:list.work_id,revision:list.revision,target_work_id:target.id,target_revision:target.revision,target_fingerprint:target.fingerprint,acknowledged:true};}
function action(x,kind,extra={}){const status=x.runtime.status(x.imported.work_id);return {work_id:status.work_id,revision:status.revision,binding_revision:status.adoption.binding_revision,target_revision:status.adoption.target_revision,action:kind,...extra};}
const count=x=>Number(x.store.hermesState.prepare('SELECT count(*) n FROM office_work').get().n);
test('runtime fixture import binding preserves Work identity, original source and zero duplicate execution across restart',async t=>{
 const x=await fixture(t),target=addHermes(x),before=count(x),request=bind(x,target),connected=x.runtime.bind(request);
 assert.equal(connected.work_id,x.imported.work_id);assert.equal(connected.adoption.target_work_id,target);assert.equal(connected.adoption.duplicate_execution,false);
 assert.equal(connected.adoption.schedule_owner,'original');assert.equal(connected.adoption.delivery_owner,'original');assert.equal(connected.adoption.live,false);
 assert.equal(importedConnectionReadiness(x.store,x.config,x.imported.work_id),null);
 assert.equal(x.runtime.bind(request).deduplicated,true);assert.equal(count(x),before);assert.deepEqual(x.requests,[]);
 assert.equal(x.store.hermesState.prepare('SELECT count(*) n FROM hermes_turn').get().n,0);assert.deepEqual(x.store.officeRuns(x.config.project.id,x.imported.work_id),[]);
 const restored=new WorkAdoptionRuntime(x.store,x.config,x.hermes,x.remote);assert.equal(restored.status(x.imported.work_id).adoption.target_work_id,target);
 assert.equal(await readFile(join(x.project,'run.py'),'utf8'),x.code);
});
test('runtime fixture imported controls reach the selected registered Hermes runtime and preserve source instructions',async t=>{
 const x=await fixture(t),target=addHermes(x),request=bind(x,target);x.runtime.bind(request);
 assert.equal((await x.runtime.action(action(x,'pause'))).adoption.state,'paused');assert.equal(x.hermes.status(target).hermes.paused,true);
 assert.equal((await x.runtime.action(action(x,'resume'))).adoption.state,'ready');assert.equal(x.hermes.status(target).hermes.paused,false);
 assert.equal(x.store.intakeWork(x.config.project.id,x.imported.work_id).paused,true);assert.deepEqual(x.requests,[]);
 assert.ok(x.runtime.status(x.imported.work_id).adoption.activity.some(e=>e.kind==='paused'));
});
test('runtime fixture adoption actions reject stale revision, changed runtime identity and foreign Work pointers',async t=>{
 const x=await fixture(t),target=addHermes(x),request=bind(x,target);
 assert.throws(()=>x.runtime.bind({...request,revision:request.revision+1}),/REVISION_CONFLICT/u);
 assert.throws(()=>x.runtime.bind({...request,target_revision:request.target_revision+1}),/TARGET_CHANGED/u);
 assert.throws(()=>x.runtime.bind({...request,target_work_id:randomUUID()}),/NOT_REGISTERED/u);
 x.runtime.bind(request);await assert.rejects(x.runtime.action({...action(x,'pause'),target_revision:9999}),/REVISION_CONFLICT/u);
 const definition=x.hermes.status(target).definition;x.store.hermesState.prepare('UPDATE hermes_work SET definition=? WHERE work_id=?').run(JSON.stringify({...definition,instruction:'Changed original binding'}),target);
 assert.equal(importedWorkAdoption(x.store,x.config,x.imported.work_id).connection,'binding_changed');
 await assert.rejects(x.runtime.action(action(x,'pause')),/BINDING_CHANGED/u);assert.equal(x.hermes.status(target).hermes.paused,false);
 const foreign=new WorkAdoptionRuntime(x.store,{...x.config,project:{...x.config.project,id:'foreign-project'}},x.hermes,x.remote);assert.throws(()=>foreign.targets({work_id:x.imported.work_id}),/WORK_NOT_FOUND/u);
});
test('runtime fixture adopted send requires model consent and reuses one original-runtime request receipt',async t=>{
 const x=await fixture(t),target=addHermes(x);x.runtime.bind(bind(x,target));
 await assert.rejects(x.runtime.action(action(x,'send',{request_id:randomUUID(),instruction:'Read disposable records'})),/CONSENT/u);
 const request=action(x,'send',{request_id:randomUUID(),instruction:'Read disposable records',cost_acknowledged:true});await x.runtime.action(request);
 for(let i=0;i<40&&x.hermes.status(target).hermes.turns[0].status!=='finished';i++)await new Promise(r=>setTimeout(r,10));
 assert.equal(x.hermes.status(target).hermes.turns[0].status,'finished');const again=await x.runtime.action(request);
 assert.equal(again.adoption.snapshot.reply,'Disposable verified reply\n');assert.equal(x.requests.filter(m=>m==='session/prompt').length,1);
 await assert.rejects(x.runtime.action({...request,instruction:'Different instruction'}),/REQUEST_ID_CONFLICT/u);
});
test('runtime fixture remote job adoption observes original execution without running, stopping or delivering anything',async t=>{
 const x=await fixture(t),target_id=x.remote.register(remoteTarget).id,linked=await x.remote.link({target_id,kind:'job',source_id:'original-job',acknowledged:true});
 const request=bind(x,linked.work_id);x.runtime.bind(request);assert.equal(x.runtime.status(x.imported.work_id).adoption.connection,'refresh_required');
 const observed=await x.runtime.action(action(x,'refresh'));assert.equal(observed.adoption.connection,'observed');assert.equal(observed.adoption.runtime_verified,true);
 assert.equal(observed.adoption.live,false);assert.equal(observed.adoption.scope,'original_remote_job');
 assert.deepEqual(observed.adoption.capabilities,{observe:true,send:false,pause:false,resume:false,review:false,permission:false});
 assert.doesNotMatch(JSON.stringify(observed),/private-example/u);await assert.rejects(x.runtime.action(action(x,'send',{request_id:randomUUID(),instruction:'Run duplicate',cost_acknowledged:true})),/ACTION_UNSUPPORTED/u);
 assert.ok(x.calls.every(c=>['sessions.list','cron.list','cron.runs'].includes(c.method)));assert.equal(x.store.hermesState.prepare('SELECT count(*) n FROM office_remote_turn').get().n,0);
});
test('runtime fixture remote session adoption refresh exposes only the bridge capabilities and preserves failed observation',async t=>{
 const x=await fixture(t),target_id=x.remote.register(remoteTarget).id,linked=await x.remote.link({target_id,kind:'session',source_id:'session:existing',acknowledged:true});x.runtime.bind(bind(x,linked.work_id));
 const observed=await x.runtime.action(action(x,'refresh'));assert.equal(observed.adoption.snapshot.reply,'Original session reply');assert.equal(observed.adoption.capabilities.send,true);assert.equal(observed.adoption.capabilities.resume,false);
 x.remote.transport.call=async()=>{throw Error('unavailable')};const failed=await x.runtime.action(action(x,'refresh'));assert.equal(failed.adoption.connection,'unreachable');assert.equal(failed.adoption.runtime_verified,false);assert.equal(failed.adoption.snapshot.reply,'Original session reply');assert.equal(failed.adoption.capabilities.send,false);
});
test('runtime fixture a registered runtime can be adopted only once and coding work uses its own session contract',async t=>{
 const x=await fixture(t),target=addHermes(x),original=x.imported.work_id;x.runtime.bind(bind(x,target));
 const spec=x.store.intakeWork(x.config.project.id,original).spec,record=x.store.createWorkImport(x.config.project.id,'pasted',{fixture:'distinct'},'1'.repeat(64)),second=x.store.acceptWorkImport(x.config.project.id,record.id,'Observe second work',spec,false,false);
 assert.ok(!x.runtime.targets({work_id:second.id}).targets.some(t=>t.id===target));
 assert.throws(()=>x.runtime.bind({...bind(x,target),work_id:second.id,revision:second.revision}),/ALREADY_BOUND/u);
 x.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify({...spec,route:{kind:'pack',pack_family:'coding.orchestrate'}}),second.id);
 assert.throws(()=>x.runtime.targets({work_id:second.id}),/CODING_USE_SESSION/u);
});
test('runtime fixture HTTP adoption is origin-fenced and changes only its selected existing runtime',async t=>{
 const {startControlCenter}=await import('../dist/observability/control-center.js'),x=await fixture(t),target=addHermes(x),server=await startControlCenter(x.config);
 t.after(()=>server.close());
 const headers={'content-type':'application/json','x-agent-driver':'human-office',origin:new URL(server.url).origin};
 const post=async(route,body,overrides={})=>fetch(server.url+'work/adoption/'+route,{method:'POST',headers:{...headers,...overrides},body:JSON.stringify(body)});
 assert.equal((await post('targets',{work_id:x.imported.work_id},{origin:'https://foreign.invalid'})).status,403);
 const listed=await post('targets',{work_id:x.imported.work_id});assert.equal(listed.status,200);const targets=await listed.json();assert.ok(targets.targets.some(t=>t.id===target));
 assert.ok(targets.targets.every(t=>!('snapshot' in t)));const selected=targets.targets.find(t=>t.id===target);
 const request={work_id:targets.work_id,revision:targets.revision,target_work_id:target,target_revision:selected.revision,target_fingerprint:selected.fingerprint,acknowledged:true};
 const bound=await post('bind',request);assert.equal(bound.status,200);assert.equal((await bound.json()).adoption.target_work_id,target);
 const paused=await post('action',action(x,'pause'));assert.equal(paused.status,200);assert.equal((await paused.json()).adoption.state,'paused');
 assert.equal(x.hermes.status(target).hermes.paused,true);assert.equal(x.store.hermesState.prepare('SELECT count(*) n FROM hermes_turn').get().n,0);
 const detail=await (await fetch(server.url+'work/detail?id='+x.imported.work_id)).json();assert.equal(detail.adoption.target_work_id,target);assert.equal(detail.display_status,'paused');
 assert.equal(detail.execution_action,null);assert.equal(detail.work_control?.can_pause??false,false);
});
test('runtime fixture browser connects and controls imported Work in Korean/English desktop/mobile without bot execution',async t=>{
 const {startControlCenter}=await import('../dist/observability/control-center.js'),{chromium}=await import('playwright'),x=await fixture(t),target=addHermes(x),server=await startControlCenter(x.config),errors=[],browser=await chromium.launch({headless:true});
 t.after(async()=>{await browser.close();await server.close();assert.deepEqual(errors,[])});
 for(const language of ['ko','en']){
  const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(l=>localStorage.setItem('office-lang',l),language);await page.goto(server.url+'?work='+x.imported.work_id);
  if(language==='ko'){
   await page.locator('#adoption-targets').click();await page.locator('#adoption-target option[value="'+target+'"]').waitFor({state:'attached'});await page.locator('#adoption-target').selectOption(target);await page.locator('#adoption-bind').click();await page.locator('[data-adoption-action="pause"]').waitFor();
   await page.locator('[data-adoption-action="pause"]').click();await page.locator('[data-adoption-action="resume"]').waitFor();assert.equal(x.hermes.status(target).hermes.paused,true);
   await page.locator('[data-adoption-action="resume"]').click();await page.locator('#adoption-instruction').waitFor();
  }
  const text=await page.locator('#office-work-adoption').innerText();if(language==='en')assert.doesNotMatch(text,/[가-힣]/u);
  for(const width of [1280,390]){await page.setViewportSize({width,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await page.locator('#office-work-adoption').isVisible(),true)}
  await page.close();
 }
 assert.equal(x.store.hermesState.prepare('SELECT count(*) n FROM hermes_turn').get().n,0);assert.deepEqual(x.requests,[]);
});
