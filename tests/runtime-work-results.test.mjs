import test from 'node:test';
import {catalogCompletionFixture} from './helpers/catalog-completion-fixture.mjs';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,readFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';
import {taskModelUiScript} from '../dist/observability/task-model-ui.js';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {collectSource} from '../dist/packs/sources.js';
import {exportRows} from '../dist/packs/data.js';
import {WorkResults} from '../dist/work/results.js';
import {WorkImportRuntime} from '../dist/work/import-runtime.js';
import {initHermesWorks} from '../dist/work/hermes.js';
import {RemoteOffice} from '../dist/work/remote.js';
import {renderWorkResults,workResultsScript} from '../dist/observability/work-results-ui.js';
import {workHtml} from '../dist/observability/work-ui.js';
import {i18nScript} from '../dist/observability/i18n.js';
import {readWorkDetail,readWorkBoard} from '../dist/observability/work-view.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {connectMcp} from '../dist/interface/mcp.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {setTimeout as delay} from 'node:timers/promises';

const hash=value=>createHash('sha256').update(value).digest('hex');
const recipe={version:1,family:'portal.collect',request:'Collect the local report',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
async function setup(t,connectors=[]){
 const root=await mkdtemp(join(tmpdir(),'work-result-')),host=join(root,'host.json');
 await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed data',value:23},{id:'two',title:'Second record',value:17}]));
 await writeFile(host,JSON.stringify({schema_version:1,project_id:'result-test',caller_ref:'test',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'}}));
 const config=loadHostConfig(host),store=new PackStore(config.dbPath),run=store.beginPack(config.project.id,'result-request',recipe,config.fingerprint).run,work=store.officeWork(config.project.id,'pack',run.id);
 const results=new WorkResults(store,connectors);
 const source=await collectSource(config.packs.sources[0],{},config),artifact=await exportRows(join(dirname(config.dbPath),'pack-artifacts'),run.id,source.rows,'json');
 store.finishPack(config.project.id,run.id,'succeeded',{collected_rows:2,matched_rows:2,artifact,evidence:[source.evidence],rows:source.rows});
 const output=results.capture(config.project.id,work.id)[0];
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
 return {root,config,store,work,run,results,output,artifact,source};
}
async function pastedResultWork(x){
 const suffix=randomUUID().slice(0,8),description=`Prepare a local report ${suffix}; Telegram is an optional reported destination.`;
 const payload={format:1,source:{platform:'chatgpt_work',name:`Copied report ${suffix}`,reference:null},title:{value:`Copied report ${suffix}`,evidence_ids:['instructions']},goal:{value:description,evidence_ids:['instructions']},trigger:{kind:'manual',rule:null,timezone:null,evidence_ids:['instructions']},steps:[{id:'report',goal:'Prepare the report draft.',depends_on:[],tool_hints:[],effect:'draft_only',evidence_ids:['instructions']}],completion:[{id:'report',result:'The draft is available for review.',proof:'Saved report receipt',evidence_ids:['instructions']}],delivery:{channel:'telegram',target:'reported_destination',evidence_ids:['instructions']},dependencies:[],approval_boundary:{value:null,evidence_ids:[]},unknowns:[],evidence:[{id:'instructions',source_ref:'Copied automation instructions',quote:description}]};
 const imports=new WorkImportRuntime(x.store,x.config,{calls:[],async call(){assert.fail('Pasted acceptance must not call a model.');}}),pasted=imports.paste({text:JSON.stringify(payload)}),accepted=await imports.accept({import_id:pasted.import_id});
 assert.equal(accepted.execution,false);assert.equal(accepted.activation,false);assert.equal(accepted.schedule_active,false);
 const work=x.store.intakeWork(x.config.project.id,accepted.work_id),runId=randomUUID(),time=new Date().toISOString();
 x.store.hermesState.exec('CREATE TABLE IF NOT EXISTS office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,work_revision INTEGER,state TEXT,result TEXT,checkpoint TEXT,created_at TEXT)');
 // A contract fixture of an owned, saved draft; neither execution nor completion is claimed.
 x.store.hermesState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run(runId,x.config.project.id,work.id,work.revision,'awaiting_review',JSON.stringify({summary:'Saved copied Work draft',text:'Reviewable report',completion_verified:false}),JSON.stringify({observations:[]}),time);
 return {work,runId,importId:pasted.import_id};
}
function recordPastedResult(x,fixture){
 return x.results.record(x.config.project.id,{work_id:fixture.work.id,run_id:fixture.runId,source_kind:'client',work_revision:fixture.work.revision,summary:'Saved copied Work draft',text:'Reviewable report'});
}
function updateImportMode(x,fixture,mode){
 const spec=structuredClone(fixture.work.spec);if(mode===undefined)delete spec.plan.import_mode;else spec.plan.import_mode=mode;
 x.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify(spec),x.config.project.id,fixture.work.id);
}
function bindResultHermes(x,fixture,importKey){
 initHermesWorks(x.store);
 x.store.hermesState.prepare('INSERT INTO hermes_work(project_id,work_id,import_key,definition,updated_at) VALUES(?,?,?,?,?)').run(x.config.project.id,fixture.work.id,importKey,'{}',new Date().toISOString());
}
test('runtime native SQLite and local file output survive reopen, deduplicate and stay Work scoped',async t=>{
 const x=await setup(t),project=x.config.project.id;
 assert.equal(x.output.source_status,'succeeded');assert.equal(x.output.verification,'reported');assert.equal(x.output.work_completion_verified,false);
 assert.ok(x.output.text.includes('Observed data'));assert.equal(x.output.artifacts.length,1);assert.equal(x.output.sources[0].reference,x.source.evidence.content_sha256);
 assert.equal(x.results.capture(project,x.work.id)[0].id,x.output.id);
 assert.equal(x.results.list(project,x.work.id).length,1);assert.equal(x.output.deliveries[0].status,'available');
 assert.throws(()=>x.results.list('another-project',x.work.id),/WORK_NOT_FOUND/);
 const time=new Date().toISOString(),other=randomUUID();x.store.hermesState.prepare('INSERT INTO office_work VALUES(?,?,?,?,?,?)').run(other,project,'Another Work','Another goal',time,time);
 assert.throws(()=>x.results.get(project,other,x.output.id),/WORK_RESULT_NOT_FOUND/);
 assert.throws(()=>x.results.record(project,{work_id:other,run_id:x.run.id,source_kind:'pack',work_revision:null,summary:'Wrong Work'}),/RESULT_RUN_WORK_MISMATCH/);
 assert.throws(()=>x.results.record(project,{work_id:x.work.id,run_id:x.run.id,source_kind:'pack',work_revision:10,summary:'Stale revision'}),/RESULT_WORK_REVISION_CONFLICT/);
 const observer=new PackStore(x.config.dbPath);try{const reopened=new WorkResults(observer);assert.equal(reopened.get(project,x.work.id,x.output.id).content_sha256,x.output.content_sha256);}finally{observer.close();}
});
test('runtime native artifact download independently verifies digest, scope, symlink and changed bytes',async t=>{
 const x=await setup(t),project=x.config.project.id,roots=[join(dirname(x.config.dbPath),'pack-artifacts')],id=x.output.artifacts[0].id;
 const download=await x.results.readArtifact(project,x.work.id,x.output.id,id,roots);
 assert.deepEqual(JSON.parse(download.bytes.toString('utf8')),x.source.rows);assert.equal(download.sha256,hash(download.bytes));
 await assert.rejects(x.results.readArtifact(project,x.work.id,x.output.id,id,[join(x.root,'missing-root')]));
 await assert.rejects(x.results.readArtifact(project,x.work.id,x.output.id,id,[x.root+'-other']),/ENOENT/);
 await writeFile(x.artifact.path,'changed');await assert.rejects(x.results.readArtifact(project,x.work.id,x.output.id,id,roots),/RESULT_ARTIFACT_CHANGED/);
 const outside=join(x.root,'outside.txt');await writeFile(outside,'not delegated');const link=join(roots[0],'outside-link.txt');await symlink(outside,link);
 const receipt=x.results.record(project,{work_id:x.work.id,run_id:x.run.id,source_kind:'pack',work_revision:null,result_key:'symlink',summary:'Recorded symlink',artifacts:[{label:'outside-link',path:link,sha256:hash('not delegated')}]});
 await assert.rejects(x.results.readArtifact(project,x.work.id,receipt.id,receipt.artifacts[0].id,roots),/RESULT_ARTIFACT_OUT_OF_SCOPE/);
});
test('runtime contract delivery retries only the saved output, with explicit connector and no job replay',async t=>{
 let sends=0;const keys=[];
 const connector={id:'telegram-fixture',channel:'telegram',async send(input){sends++;keys.push(input.idempotency_key);return sends===1?{status:'failed',effect_state:'not_dispatched',reason:'FIXTURE_BEFORE_DISPATCH'}:{status:'delivered',receipt_id:'fixture-receipt'};}};
 const x=await setup(t,[connector]),project=x.config.project.id;
 assert.equal(sends,0);assert.throws(()=>x.results.requestDelivery(project,x.work.id,x.output.id,{channel:'email',connector_id:'not-connected',target_alias:'owner',acknowledged:true}),/RESULT_DELIVERY_CONNECTOR_UNAVAILABLE/);
 assert.throws(()=>x.results.requestDelivery(project,x.work.id,x.output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:false}),/RESULT_DELIVERY_CONFIRMATION_REQUIRED/);
 const deliveryId=x.results.requestDelivery(project,x.work.id,x.output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:true});assert.equal(sends,0);
 const failed=await x.results.deliver(project,x.work.id,x.output.id,deliveryId,0),delivery=failed.deliveries.find(value=>value.id===deliveryId);
 assert.equal(delivery.status,'failed');assert.equal(delivery.can_retry,true);
 await assert.rejects(x.results.retryDelivery(project,x.work.id,x.output.id,deliveryId,0),/RESULT_DELIVERY_REVISION_CONFLICT/);
 const delivered=await x.results.retryDelivery(project,x.work.id,x.output.id,deliveryId,delivery.revision);
 assert.equal(delivered.deliveries.find(value=>value.id===deliveryId).status,'delivered');assert.equal(sends,2);assert.equal(keys[0],keys[1]);
 assert.equal(x.store.officeRuns(project,x.work.id).length,1);assert.deepEqual(x.store.packRun(project,x.run.id).result.rows,x.source.rows);
 assert.equal(JSON.parse(await readFile(join(x.root,'source.json'),'utf8')).length,2);
 await assert.rejects(x.results.retryDelivery(project,x.work.id,x.output.id,deliveryId,delivered.deliveries.find(value=>value.id===deliveryId).revision),/RESULT_DELIVERY_NOT_RETRYABLE/);
});
test('runtime contract uncertain sends and imported delivery cannot be replayed or duplicate the original sender',async t=>{
 let sends=0;const connector={id:'uncertain-fixture',channel:'telegram',async send(){sends++;throw Error('unknown response');}};
 const x=await setup(t,[connector]),project=x.config.project.id,id=x.results.requestDelivery(project,x.work.id,x.output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:true});
 const uncertain=await x.results.deliver(project,x.work.id,x.output.id,id,0),delivery=uncertain.deliveries.find(value=>value.id===id);
 assert.equal(delivery.status,'reconciliation_required');assert.equal(delivery.can_retry,false);
 await assert.rejects(x.results.retryDelivery(project,x.work.id,x.output.id,id,delivery.revision),/RESULT_DELIVERY_NOT_RETRYABLE/);assert.equal(sends,1);
 const time=new Date().toISOString();x.store.hermesState.prepare('INSERT INTO office_import VALUES(?,?,?,?,?,?,?,?,?)').run(randomUUID(),project,'pasted','accepted',JSON.stringify({delivery:{channel:'telegram',target:'existing channel'}}),'import-digest',x.work.id,time,time);
 const imported=x.results.record(project,{work_id:x.work.id,run_id:x.run.id,source_kind:'pack',work_revision:null,result_key:'imported-output',summary:'Original bot output'});
 assert.equal(imported.deliveries.find(value=>value.channel==='telegram').authority,'original_runtime');
 assert.throws(()=>x.results.requestDelivery(project,x.work.id,imported.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:true}),/RESULT_ORIGINAL_DELIVERY_AUTHORITY/);assert.equal(sends,1);
});
test('runtime contract accepted pasted migration defaults to app output and still requires connector and delivery consent',async t=>{
 let sends=0;const connector={id:'copied-fixture',channel:'telegram',async send(){sends++;return {status:'delivered',receipt_id:'not-invoked'};}};
 const x=await setup(t,[connector]),fixture=await pastedResultWork(x),project=x.config.project.id,output=recordPastedResult(x,fixture);
 assert.equal(output.source_status,'awaiting_review');assert.equal(output.work_completion_verified,false);
 assert.deepEqual(output.deliveries.map(({channel,authority,status})=>({channel,authority,status})),[{channel:'app',authority:'office',status:'available'}]);
 assert.equal(x.store.officeRuns(project,fixture.work.id).length,0);
 assert.throws(()=>x.results.requestDelivery(project,fixture.work.id,output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:false}),/RESULT_DELIVERY_CONFIRMATION_REQUIRED/);
 assert.throws(()=>x.results.requestDelivery(project,fixture.work.id,output.id,{channel:'telegram',connector_id:'absent',target_alias:'owner',acknowledged:true}),/RESULT_DELIVERY_CONNECTOR_UNAVAILABLE/);
 const delivery=x.results.requestDelivery(project,fixture.work.id,output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:true});
 assert.equal(x.results.get(project,fixture.work.id,output.id).deliveries.find(row=>row.id===delivery).status,'pending');assert.equal(sends,0);
});
test('runtime contract valid older accepted pasted draft without import mode keeps Office app delivery',async t=>{
 const x=await setup(t),fixture=await pastedResultWork(x);updateImportMode(x,fixture,undefined);
 const output=recordPastedResult(x,fixture);assert.equal(output.deliveries.length,1);assert.equal(output.deliveries[0].authority,'office');assert.equal(output.deliveries[0].channel,'app');
});
test('runtime contract intake Hermes binding does not invent an original sender for a pasted Office draft',async t=>{
 const x=await setup(t),fixture=await pastedResultWork(x);bindResultHermes(x,fixture,`intake:${fixture.work.id}`);
 const output=recordPastedResult(x,fixture);assert.equal(output.deliveries.length,1);assert.equal(output.deliveries[0].channel,'app');
});
for(const variant of ['project','observe','augment','adoption','remote','hermes','invalid_legacy','invalid_evidence','invalid_dependency'])test(`runtime contract ${variant} import retains original result delivery authority`,async t=>{
 let sends=0;const connector={id:'original-fixture',channel:'telegram',async send(){sends++;return {status:'delivered',receipt_id:'not-invoked'};}};
 const x=await setup(t,[connector]),fixture=await pastedResultWork(x),project=x.config.project.id;
 if(variant==='project')x.store.hermesState.prepare('UPDATE office_import SET kind=? WHERE id=?').run('project',fixture.importId);
 if(variant==='observe'||variant==='augment')updateImportMode(x,fixture,variant);
 if(variant==='adoption'){x.store.hermesState.exec('CREATE TABLE office_work_adoption(project_id TEXT,work_id TEXT)');x.store.hermesState.prepare('INSERT INTO office_work_adoption VALUES(?,?)').run(project,fixture.work.id);}
 if(variant==='remote'){
  const remote=new RemoteOffice(x.store,x.config,{async call(){assert.fail('Result authority inspection must not contact the original runtime.');}});
  const target=remote.register({name:'Original result runtime',host:'example.invalid',user:'agent',entry:'/app/openclaw.mjs'});
  x.store.hermesState.prepare('INSERT INTO office_remote_work(project_id,work_id,target_id,kind,source_id,title) VALUES(?,?,?,?,?,?)').run(project,fixture.work.id,target.id,'job','original-job','Original scheduled job');
 }
 if(variant==='hermes')bindResultHermes(x,fixture,'original:scheduled-job');
 if(variant.startsWith('invalid_')){
  const body=structuredClone(x.store.workImport(project,fixture.importId).body);
  if(variant==='invalid_legacy')delete body.provenance;
  if(variant==='invalid_evidence')body.steps[0].evidence_ids=['absent'];
  if(variant==='invalid_dependency')body.steps[0].depends_on=['absent'];
  x.store.hermesState.prepare('UPDATE office_import SET body=? WHERE id=?').run(JSON.stringify(body),fixture.importId);
 }
 const output=recordPastedResult(x,fixture),original=output.deliveries.find(row=>row.authority==='original_runtime');
 assert.ok(original);assert.equal(original.channel,'telegram');assert.equal(original.status,'unobserved');assert.equal(original.attempts,0);
 assert.throws(()=>x.results.requestDelivery(project,fixture.work.id,output.id,{channel:'telegram',connector_id:connector.id,target_alias:'owner',acknowledged:true}),/RESULT_ORIGINAL_DELIVERY_AUTHORITY/);assert.equal(sends,0);
});
test('runtime contract result text is bounded and redacted, UI escapes output and renders Korean or English labels',async t=>{
 const x=await setup(t),project=x.config.project.id;
 const output=x.results.record(project,{work_id:x.work.id,run_id:x.run.id,source_kind:'pack',work_revision:null,result_key:'redacted-output',summary:'<script>fake</script> password=private-value',text:'{"password":"private-json-value"} Bearer private-bearer-token '+['123456789','abcdefghijklmnopqrstuvwxyz0123456789'].join(':'),sources:[{label:'Observed page',url:'https://user:secret@example.com/report?token=private-url-token#secret'}]});
 const serialized=JSON.stringify(output);assert.doesNotMatch(serialized,/private-value|private-json-value|private-bearer-token|private-url-token|user:secret|abcdefghijklmnopqrstuvwxyz0123456789/u);
 assert.equal(output.sources[0].url,'https://example.com/report');
 const ko=renderWorkResults([output],'ko'),en=renderWorkResults([output],'en');assert.ok(ko.includes('결과'));assert.ok(en.includes('Results'));assert.ok(en.includes('&lt;script&gt;'));assert.ok(!en.includes('<script>fake</script>'));assert.ok(en.includes('Original')===false);assert.ok(en.includes('Available in this app'));
 assert.doesNotMatch(renderWorkResults([],'en'),/[가-힣]/u);
 const context={document:{documentElement:{lang:'en'}},app:{addEventListener(){}},esc:value=>String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),encodeURIComponent,Date};vm.runInNewContext(workResultsScript+'\nthis.html=workResultsHtml({results:[]});',context);assert.match(context.html,/No saved output yet/);
});
test('runtime contract completed client output captures only real successful tool receipts and preserves pending completion',async t=>{
 const x=await setup(t),project=x.config.project.id,runId=randomUUID(),time=new Date().toISOString();
 x.store.hermesState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,work_revision INTEGER,state TEXT,result TEXT,checkpoint TEXT,created_at TEXT)');
 x.store.hermesState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run(runId,project,x.work.id,0,'needs_review',JSON.stringify({summary:'Observed client output',text:'Actual tool report',completion_verified:false}),JSON.stringify({observations:[{receipt:{status:'succeeded',value:{url:'https://example.com/current',title:'Observed page',artifact:x.artifact}},observed_at:time},{receipt:{status:'failed',value:{url:'https://example.com/not-observed',title:'Not observed'}},observed_at:time}]}),time);
 const output=x.results.capture(project,x.work.id).find(value=>value.source_kind==='client');assert.ok(output);assert.equal(output.run_id,runId);assert.equal(output.summary,'Observed client output');assert.equal(output.verification,'reported');assert.equal(output.work_completion_verified,false);assert.equal(output.sources.length,1);assert.equal(output.sources[0].url,'https://example.com/current');assert.equal(output.artifacts.length,1);
 x.store.hermesState.prepare('UPDATE office_supervisor SET state=?,result=? WHERE run_id=?').run('waiting_auth',JSON.stringify({summary:'Current observation preserved; authentication required.',text:'User authentication is pending.',completion_verified:true}),runId);
 const waiting=x.results.capture(project,x.work.id).find(value=>value.source_kind==='client');assert.equal(waiting.source_status,'waiting_auth');assert.equal(waiting.work_completion_verified,false);assert.equal(waiting.verification,'reported');
 x.store.hermesState.prepare('UPDATE office_supervisor SET state=?,result=? WHERE run_id=?').run('succeeded',JSON.stringify({summary:'Fixture verifier accepted the observed output.',text:'Actual tool report',completion_verified:true}),runId);
 const completed=x.results.capture(project,x.work.id).find(value=>value.source_kind==='client');assert.equal(completed.verification,'verified');assert.equal(completed.work_completion_verified,true);assert.notEqual(completed.id,waiting.id);
 assert.equal(completed.work_revision,0);assert.throws(()=>x.results.record(project,{work_id:x.work.id,run_id:runId,source_kind:'client',work_revision:1,summary:'Wrong checkpoint revision'}),/RESULT_WORK_REVISION_CONFLICT/);
 x.store.hermesState.prepare('UPDATE office_supervisor SET work_revision=? WHERE run_id=?').run(2,runId);
 const revised=x.results.capture(project,x.work.id).find(value=>value.source_kind==='client');assert.equal(revised.work_revision,2);assert.notEqual(revised.id,completed.id);assert.equal(x.results.get(project,x.work.id,completed.id).work_revision,0);
});

test('runtime unit supervisor UI uses actual activity for motion, distinguishes waits and renders one schedule in English',()=>{
 const html=workHtml('unit-nonce'),script=html.match(/<script nonce="unit-nonce">([\s\S]*?)<\/script>/u)[1];
 const fragment=script.slice(script.indexOf('let activityStream='),script.indexOf('const stageDialog='));
 const reasonStart=script.indexOf('function executionReason'),reasonEnd=script.indexOf('function observedExecutor');assert.ok(reasonStart>=0&&reasonEnd>reasonStart);
 const dependencies=script.slice(reasonStart,reasonEnd);
 const dialog={open:false,innerHTML:''};
 const context={document:{documentElement:{lang:'en'},readyState:'loading',addEventListener(){},getElementById:id=>id==='stage-dialog'?dialog:null},localStorage:{getItem:()=> 'en'},window:{},app:{addEventListener(){}},esc:value=>String(value).replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char])),labels:{running:'Running',waiting_auth:'Sign-in required',awaiting_review:'Review completion',paused:'Paused'},tone:()=>'',encodeURIComponent,Date,Intl};
 vm.runInNewContext(i18nScript+dependencies+fragment+workResultsScript,context);
 context.sample={supervisor:{state:'running',live:true,can_pause:true,can_resume:false,can_edit:true},activity:[{kind:'model.started',created_at:'2026-09-29T05:00:00Z'}],stages:[]};
 const running=vm.runInNewContext('supervisorHtml(sample)',context);assert.match(running,/data-busy="true"/);assert.match(running,/AI chooses/);assert.doesNotMatch(running,/data-supervisor-action|[가-힣]/u);
 vm.runInNewContext("detail=sample;modalStageId='next';renderStageDialog()",context);assert.match(dialog.innerHTML,/data-stage-action="edit"/);assert.match(dialog.innerHTML,/지침 저장/u);
 context.sample.activity=[{kind:'model.result'}];assert.match(vm.runInNewContext('liveStageHtml(sample)',context),/data-busy="false"/);
 context.sample.supervisor.live=false;assert.equal(vm.runInNewContext('liveStageHtml(sample)',context),'');
 context.sample.supervisor={state:'waiting_auth',live:false,reason:'BROWSER_AUTH_REQUIRED',can_pause:false,can_resume:true,can_edit:true};
 const waiting=vm.runInNewContext('supervisorHtml(sample)',context);assert.match(waiting,/Complete authentication in Site sign-in/);assert.doesNotMatch(waiting,/data-busy="true"|data-supervisor-action|[가-힣]/u);
 vm.runInNewContext('renderStageDialog()',context);assert.match(dialog.innerHTML,/data-stage-action="resume"/);
 context.sample.schedule={state:'enabled',owner:'office',next_run_at:'2026-09-30T11:00:00Z',timezone:'Asia/Seoul'};
 const combined=vm.runInNewContext('scheduleHtml(sample)+workResultsHtml(sample)',context);assert.equal((combined.match(/class="panel work-schedule"/gu)||[]).length,1);assert.match(combined,/Asia\/Seoul/);assert.match(combined,/Next run/);
 const old=vm.runInNewContext('activityViewKey(sample)',context);context.sample.supervisor.updated_at='2026-09-29T06:00:00Z';assert.notEqual(vm.runInNewContext('activityViewKey(sample)',context),old);
 assert.match(script,/resolvedOptions\(\)\.timeZone/u);assert.match(script,/timezone\?\{timezone\}/u);assert.match(script,/완료조건과 다음 단계를 갱신/u);
});

test('runtime fixture SDK MCP exposes read-only persisted results and captures a completed public supervisor without replay',async t=>{
 const x=await setup(t),raw=JSON.parse(await readFile(x.config.path,'utf8'));raw.swarm={enabled:true,model_data_approved:true};await writeFile(x.config.path,JSON.stringify(raw));
 const model={calls:[],async call(purpose,instructions,input,schema){
  let output;
  if(schema.properties?.title)output={title:'Host Pack catalog',desired_outcome:'Report the registered research.search family',completion_checks:[{id:'catalog',result:'Confirm research.search exists.',evidence:'Observed host catalog ID'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
  else if(schema.properties?.action){const observation=input.checkpoint.observations.at(-1);output=observation?{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'The observed host catalog includes research.search.',completed_checks:[{id:'catalog',evidence_ids:observation.receipt.evidence_ids}],wait_reason:null}:{action:'tool',stage_id:'catalog',tool_name:'runtime_pack_catalog',arguments_json:'{}',summary:'Read the real local catalog.',completed_checks:[],wait_reason:null};}
  else if(schema.properties?.findings||schema.properties?.checks)output=catalogCompletionFixture(input,schema);
  else throw Error('UNEXPECTED_RESULT_FIXTURE_SCHEMA');
  this.calls.push({purpose,status:'accepted',provider:'contract_fixture',model:'fixture'});return output;
 }};
 const api=new RuntimeApi(loadHostConfig(x.config.path),{swarmModel:model}),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),connection=await connectMcp(api,serverTransport,{transport:'streamable-http'}),client=new Client({name:'result-read-fixture',version:'1'});
 try{
  await client.connect(clientTransport);const tools=await client.listTools();for(const name of ['runtime_work_results','runtime_work_result'])assert.equal(tools.tools.find(tool=>tool.name===name)?.annotations?.readOnlyHint,true);
  const call=async(name,args)=>{const result=await client.callTool({name,arguments:args});assert.notEqual(result.isError,true,JSON.stringify(result));return JSON.parse(result.content[0].text);};
  const existing=await call('runtime_work_results',{work_id:x.work.id});assert.equal(existing.results[0].id,x.output.id);assert.equal(model.calls.length,0);assert.equal(api.store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_supervisor'").get(),undefined);
  const work=await call('runtime_work_start',{request_id:'sdk-output',prompt:'Read the local Pack catalog and confirm the research.search family.'});
  assert.equal((await call('runtime_work_results',{work_id:work.work_id})).results.length,0);
  const started=await call('runtime_work_execute',{work_id:work.work_id,revision:work.revision,cost_acknowledged:true});assert.equal(started.accepted,true);
  let state;for(let i=0;i<160;i++){state=await call('runtime_work_status',{work_id:work.work_id});if(state.status==='succeeded')break;if(['failed','awaiting_review'].includes(state.status))assert.fail(JSON.stringify(state));await delay(25);}
  assert.equal(state.status,'succeeded');const list=await call('runtime_work_results',{work_id:work.work_id});assert.equal(list.results.length,1);assert.equal(list.results[0].run_id,started.run_id);assert.equal(list.results[0].work_revision,work.revision);assert.equal(list.results[0].work_completion_verified,true);assert.equal(list.results[0].deliveries[0].channel,'app');
  const detail=readWorkDetail(api.store,api.config,work.work_id);assert.equal(detail.run_id,null);assert.equal(detail.supervisor.run_id,started.run_id);assert.equal(detail.completion_verified,true);assert.equal(detail.progress_percent,100);
  const before=model.calls.length,read=await call('runtime_work_result',{work_id:work.work_id,result_id:list.results[0].id});assert.equal(read.id,list.results[0].id);assert.equal(read.verification,'verified');assert.ok(read.text.includes('research.search'));await call('runtime_work_results',{work_id:work.work_id});assert.equal(model.calls.length,before);assert.equal(api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_supervisor WHERE work_id=?').get(work.work_id).n,1);
  const wrong=await client.callTool({name:'runtime_work_result',arguments:{work_id:x.work.id,result_id:read.id}});assert.equal(wrong.isError,true);
  api.store.hermesState.prepare('UPDATE office_supervisor SET state=? WHERE run_id=?').run('paused',started.run_id);
  const paused=readWorkDetail(api.store,api.config,work.work_id);assert.equal(paused.supervisor.result.completion_verified,true);assert.equal(paused.completion_verified,false);assert.equal(paused.progress_percent,null);assert.equal(paused.run_status,'paused');
  api.store.hermesState.prepare('UPDATE office_work SET title=? WHERE id=?').run('A lengthy research request with many details that should stay only in the Work detail',work.work_id);
  const tile=readWorkBoard(api.store,api.config).works.find(value=>value.id===work.work_id);assert.ok(tile.title.length<=28);assert.ok(tile.full_title.length>tile.title.length);
 }finally{await client.close();await connection.close();api.close();await api.drain();}
});

test('runtime unit supervised Work detail uses its real run identity and hides legacy dispatch guidance in every state',()=>{
 const html=workHtml('detail-contract'),script=html.match(/<script nonce="detail-contract">([\s\S]*?)<\/script>/u)[1],analysis=script.slice(script.indexOf('function activitySummary'),script.indexOf('function renderDetailBody')),body=script.slice(script.indexOf('function renderDetailBody()'),script.indexOf('let activityStream='));
 const app={innerHTML:'',querySelectorAll(){return [];}},back={};
 const context={app,document:{getElementById:id=>id==='back'?back:null},window:{officeText:value=>value},updateConnection(){},showBoard(){},liveStageHtml(){return '';},fileWorkPanel(){return '';},editing:null,aiDataApproved:false,attention:()=>false,labels:{running:'진행 중',awaiting_review:'완료조건 확인 필요',paused:'일시정지됨'},esc:value=>String(value??'').replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]))};
 vm.runInNewContext(taskModelUiScript+analysis+body,context);
 for(const state of ['running','awaiting_review','paused']){
  context.detail={id:'work-identity',title:'Observed Work',goal:'Actual source',work_status:'ready',display_status:state,run_id:null,supervisor:{run_id:'sup-actual-identity',state},stages:[],runs:[],questions:[],events:[],verified_steps:0,total_steps:0,agent_count:0,progress_percent:null};
  vm.runInNewContext('renderDetailBody()',context);
  assert.match(app.innerHTML,/run #SUP-ACTU/u);assert.doesNotMatch(app.innerHTML,/run not started|에이전트 실행 배정 대기|copy-work-dispatch|일시정지 미지원|안전한 중간 수정|<h3>작업 제어<\/h3>/u);assert.match(app.innerHTML,new RegExp(context.labels[state],'u'));
 }
 context.detail.supervisor=null;context.detail.work_status='paused';context.detail.paused=true;vm.runInNewContext('renderDetailBody()',context);assert.match(app.innerHTML,/<small>실행 전<\/small>/u);
});
