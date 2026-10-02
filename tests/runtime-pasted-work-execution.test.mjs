import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {connectMcp} from '../dist/interface/mcp.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {readWorkDetail} from '../dist/observability/work-view.js';
import {workImportExecutionOwner} from '../dist/work/import-authority.js';
import {WorkAdoptionRuntime} from '../dist/work/adoption.js';
import {workDispatchOptions} from '../dist/work/dispatch.js';
import {WorkSchedules} from '../dist/work/schedule.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {catalogCompletionFixture} from './helpers/catalog-completion-fixture.mjs';

function payload(recurring=false){return {
  format:1,source:{platform:'chatgpt_work',name:'Disposable catalog workflow',reference:null},
  title:{value:'Read Pack catalog',evidence_ids:['e1']},goal:{value:'Report the registered research.search Pack family.',evidence_ids:['e1']},
  trigger:{kind:recurring?'schedule':'once',rule:recurring?'Every day at 20:00':null,timezone:recurring?'Asia/Seoul':null,evidence_ids:['e1']},
  steps:[{id:'catalog',goal:'Read the host Pack catalog',depends_on:[],tool_hints:['runtime_pack_catalog'],effect:'read_only',evidence_ids:['e1']}],
  completion:[{id:'catalog',result:'Find the research.search Pack in the host catalog.',proof:'The observed host Pack family ID.',evidence_ids:['e1']}],
  delivery:{channel:'chat',target:null,evidence_ids:['e1']},dependencies:[],approval_boundary:{value:null,evidence_ids:[]},unknowns:[],
  evidence:[{id:'e1',source_ref:'Disposable task instruction',quote:'Report the registered research.search Pack family.'}],
};}
function gate(){let enter,release;const ready=new Promise(r=>{enter=r;}),wait=new Promise(r=>{release=r;});return {ready,release,async block(){enter();await wait;}};}
function model(options={}){let actionCount=0;return {calls:[],inputs:[],async call(purpose,instructions,input,schema){
  this.inputs.push({purpose,instructions,input:structuredClone(input)});let result;
  if(schema.properties?.title)result={...structuredClone(input.previous_spec),title:'Read catalog summary',plan:{...structuredClone(input.previous_spec.plan),source:'request',source_id:null,source_digest:null,provenance:'user_request',import_mode:'observe',steps:input.previous_spec.plan.steps.map(step=>({...step,observable_outcome:'The host Pack catalog identifies the registered research.search family.'}))}};
  else if(schema.properties?.action){if(actionCount++===0)await options.firstAction?.();const semantic=schema.required?.includes('completed_stages')??false;result=input.checkpoint.observations.length?
    {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'The host catalog includes research.search.',completed_checks:[{id:'catalog',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}],wait_reason:null,...(semantic?{completed_stages:[{stage_id:'catalog',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}]}:{})}:
    {action:'tool',stage_id:'catalog',tool_name:'runtime_pack_catalog',arguments_json:'{}',summary:'Read the configured host catalog.',completed_checks:[],wait_reason:null,...(semantic?{completed_stages:[]}:{})};}
  else if(schema.properties?.findings||schema.properties?.checks)result=catalogCompletionFixture(input,schema);
  else if(instructions.startsWith('Normalize the user'))result={kind:'daily',timezone:'Asia/Seoul',hour:20,minute:0};else throw Error('UNEXPECTED_FIXTURE_SCHEMA');
  this.calls.push({purpose,provider:'contract_fixture',model:'fixture-model',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return result;
}};}
async function setup(t,provider=model()){
  const root=await mkdtemp(join(tmpdir(),'office-pasted-execute-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'pasted-work',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(path),api=new RuntimeApi(config,{swarmModel:provider}),resources=[],releases=[];
  t.after(async()=>{for(const release of releases)release();for(const close of resources.reverse())await close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {root,path,config,api,provider,onClose:close=>resources.push(close),onRelease:release=>releases.push(release),async paste(recurring=false){const imported=api.imports.paste({text:JSON.stringify(payload(recurring))}),accepted=await api.imports.accept({import_id:imported.import_id,mode:'migrate'});return {imported,accepted,work:api.store.intakeWork(config.project.id,accepted.work_id)};}};
}
async function settle(x,id,expected='succeeded'){for(let n=0;n<200;n++){const state=supervisorStatus(x.api.store,x.config.project.id,id);if(state?.state===expected)return state;if(state?.state==='failed'&&expected!=='failed')assert.fail(JSON.stringify(state));await delay(15);}assert.fail(JSON.stringify(supervisorStatus(x.api.store,x.config.project.id,id)));}
function specUpdate(x,work,spec){x.api.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify(spec),x.config.project.id,work.id);}

test('runtime pasted migration preserves definition-only intake and admits the same Work after explicit consent',async t=>{
  const x=await setup(t),{imported,accepted,work}=await x.paste();assert.equal(imported.execution,false);assert.equal(accepted.execution,false);assert.equal(accepted.schedule_active,false);assert.equal(work.spec.plan.import_mode,'migrate');assert.equal(x.provider.inputs.length,0);
  const duplicate=await x.api.imports.accept({import_id:imported.import_id,mode:'migrate'});assert.equal(duplicate.work_id,work.id);assert.equal(duplicate.deduplicated,true);
  assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'office');assert.equal(workDispatchOptions(x.api.store,x.config,work.id).can_execute,true);
  const detail=readWorkDetail(x.api.store,x.config,work.id);assert.equal(detail.adoption_eligible,false);assert.equal(detail.imported_execution_owner,'office');assert.equal(detail.imported_connection,null);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision}),/WORK_MODEL_USAGE_CONSENT_REQUIRED/u);
  await assert.rejects(x.api.call('runtime_work_execute',{work_id:work.id,revision:999,cost_acknowledged:true}),/WORK_REVISION_CONFLICT/u);assert.equal(x.provider.inputs.length,0);assert.equal(supervisorStatus(x.api.store,x.config.project.id,work.id),null);
  const adoption=new WorkAdoptionRuntime(x.api.store,x.config,null,x.api.remote);assert.throws(()=>adoption.targets({work_id:work.id}),/WORK_ADOPTION_ORIGINAL_RUNTIME_REQUIRED/u);
  const admission=await x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true});assert.equal(admission.accepted,true);
  const finished=await settle(x,work.id);assert.equal(finished.result.completion_verified,true);assert.equal(finished.steps[0].tool,'runtime_pack_catalog');assert.equal(finished.steps[0].effect_state,'none');
  assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);
});

test('runtime pasted migration source/status/body mismatch stays passive and valid accepted legacy mode remains usable',async t=>{
  const x=await setup(t),{imported,work}=await x.paste(),original=structuredClone(work.spec),db=x.api.store.hermesState;
  const legacy=structuredClone(original);delete legacy.plan.import_mode;specUpdate(x,work,legacy);assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'office');
  for(const change of [p=>{p.plan.source='request';},p=>{p.plan.source_id='foreign';},p=>{p.plan.source_digest='b'.repeat(64);},p=>{p.plan.provenance='user_request';},p=>{p.plan.import_mode='observe';},p=>{p.plan.import_mode='augment';}]){const spec=structuredClone(original);change(spec);specUpdate(x,work,spec);assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'original_runtime');await assert.rejects(x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true}),/ORIGINAL_RUNTIME_CONNECTION_REQUIRED/u);}
  specUpdate(x,work,original);db.prepare("UPDATE office_import SET status='draft' WHERE id=?").run(imported.import_id);assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'original_runtime');db.prepare("UPDATE office_import SET status='accepted' WHERE id=?").run(imported.import_id);
  const body=x.api.store.workImport(x.config.project.id,imported.import_id).body;db.prepare('UPDATE office_import SET body=? WHERE id=?').run(JSON.stringify({...body,goal:{...body.goal,value:'Different source goal.'}}),imported.import_id);assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'original_runtime');assert.equal(x.provider.inputs.length,0);
});

test('runtime pasted migration pause/edit/resume keeps host-owned source binding and the original operation',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);const {work}=await x.paste();
  const begun=await x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true});await hold.ready;
  const edited=await x.api.call('runtime_work_control',{work_id:work.id,revision:work.revision,action:'edit',stage_id:'result',instruction:'Keep the observed family and provide a concise summary.'});assert.equal(edited.state,'paused');
  await assert.rejects(x.api.call('runtime_work_control',{work_id:work.id,revision:work.revision,action:'resume'}),/WORK_REVISION_CONFLICT/u);hold.release();for(let n=0;n<80&&supervisorStatus(x.api.store,x.config.project.id,work.id).live;n++)await delay(10);
  const resumed=await x.api.call('runtime_work_control',{work_id:work.id,revision:edited.revision,action:'resume'});assert.equal(resumed.run_id,begun.run_id);const complete=await settle(x,work.id);assert.equal(complete.result.completion_verified,true);
  const current=x.api.store.intakeWork(x.config.project.id,work.id);assert.equal(current.spec.plan.source,'pasted_import');assert.equal(current.spec.plan.source_id,work.spec.plan.source_id);assert.equal(current.spec.plan.source_digest,work.spec.plan.source_digest);assert.equal(current.spec.plan.import_mode,'migrate');assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'office');assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);
});

test('runtime pasted migration live duplicate and paused admission preserve one operation without extra model calls',async t=>{
  const hold=gate(),x=await setup(t,model({firstAction:hold.block}));x.onRelease(hold.release);const {work}=await x.paste();
  x.api.store.hermesState.prepare('UPDATE office_intake SET paused=1 WHERE work_id=?').run(work.id);await assert.rejects(x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true}),/WORK_NOT_READY/u);assert.equal(x.provider.inputs.length,0);x.api.store.hermesState.prepare('UPDATE office_intake SET paused=0 WHERE work_id=?').run(work.id);
  const begun=await x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true});await hold.ready;const duplicate=await x.api.call('runtime_work_execute',{work_id:work.id,revision:work.revision,cost_acknowledged:true});assert.equal(duplicate.deduplicated,true);assert.equal(duplicate.run_id,begun.run_id);hold.release();assert.equal((await settle(x,work.id)).steps.length,1);assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor').get().n,1);
});

test('runtime pasted migration is not external-write permission; unknown effects remain fenced and approval is never synthesized',async t=>{
  const x=await setup(t),raw=payload();raw.steps[0].effect='unknown';const imported=x.api.imports.paste({text:JSON.stringify(raw)}),accepted=await x.api.imports.accept({import_id:imported.import_id,mode:'migrate'}),work=x.api.store.intakeWork(x.config.project.id,accepted.work_id);assert.equal(work.spec.requested_effect,'unknown');assert.equal(workImportExecutionOwner(x.api.store,x.config.project.id,work.id),'office');
  const toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,'owned-pasted-run',work.spec,work.prompt,()=>{},x.provider);x.onClose(()=>toolkit.close());const names=toolkit.catalog().map(tool=>tool.name);for(const name of ['runtime_files_grant','runtime_files_apply','runtime_pack_approve','runtime_windows_act'])assert.equal(names.includes(name),false);
  const receipt=await toolkit.receipt('runtime_windows_step',{status:'ready',run_id:'not-an-owned-verified-run'},'unproven-effect');assert.equal(receipt.status,'reconciliation_required');assert.equal(receipt.effect_state,'uncertain');assert.equal(receipt.retry_safe,false);assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM task').get().n,0);assert.equal(x.provider.inputs.length,0);
});

test('runtime pasted migration authority changed before queued dispatch or resume cannot start another original bot',async t=>{
  const x=await setup(t),{work}=await x.paste(),supervisor=new WorkSupervisor(x.api.store,x.config,x.provider,{api:x.api,auto_start:false});x.onClose(()=>supervisor.close());
  // Durable admission is real; prevent this fixture timer from dispatching until
  // it can simulate a legacy saved queue whose authority was changed.
  supervisor.activate=()=>{};const admitted=supervisor.start(work.id,work.revision,true),changed=structuredClone(work.spec);changed.plan.import_mode='observe';specUpdate(x,work,changed);
  x.api.store.hermesState.prepare("UPDATE office_supervisor SET state='paused' WHERE run_id=?").run(admitted.run_id);
  assert.throws(()=>supervisor.action({work_id:work.id,revision:work.revision,action:'resume'}),/ORIGINAL_RUNTIME_CONNECTION_REQUIRED/u);
  await assert.rejects(x.api.call('runtime_work_control',{work_id:work.id,revision:work.revision,action:'retry'}),/ORIGINAL_RUNTIME_CONNECTION_REQUIRED/u);
  x.api.store.hermesState.prepare("UPDATE office_supervisor SET state='queued' WHERE run_id=?").run(admitted.run_id);WorkSupervisor.prototype.activate.call(supervisor);
  const stopped=await settle(x,work.id,'waiting_connection');assert.equal(stopped.reason,'ORIGINAL_RUNTIME_CONNECTION_REQUIRED');assert.equal(stopped.steps.length,0);assert.equal(x.provider.inputs.length,0);
});

test('runtime pasted migration recurrence requires explicit future execution consent; existing project schedule remains original',async t=>{
  const x=await setup(t),{work}=await x.paste(true);let at=Date.parse('2026-09-29T00:00:00Z');const schedules=new WorkSchedules(x.api.store,x.config.project.id,{clock:()=>at,default_timezone:'Asia/Seoul'});
  assert.equal(schedules.status(work.id),null);const prepared=await schedules.prepare(work.id,work.revision,x.provider);assert.equal(prepared.state,'disabled');assert.equal(prepared.owner,'office');assert.equal(prepared.enabled,false);assert.equal(schedules.due().length,0);
  assert.throws(()=>schedules.enable(work.id,work.revision,{acknowledged:false}),/SCHEDULE_WORK_START_REQUIRED/u);schedules.enable(work.id,work.revision,{acknowledged:true});at=Date.parse('2026-09-29T11:00:00Z');const due=schedules.due();assert.equal(due.length,1);const claim=schedules.claim(due[0]);assert.ok(claim);assert.equal(schedules.claim(due[0]),null);
  const record=x.api.store.createWorkImport(x.config.project.id,'project',{scan:'original bot'},'a'.repeat(64)),original=x.api.store.acceptWorkImport(x.config.project.id,record.id,'Observe the original bot.',work.spec),calls=x.provider.inputs.length;
  assert.equal((await schedules.prepare(original.id,original.revision,x.provider)).owner,'original_runtime');assert.equal(x.provider.inputs.length,calls);assert.throws(()=>schedules.enable(original.id,original.revision,{acknowledged:true}),/SCHEDULE_ORIGINAL_RUNTIME_AUTHORITY/u);
});

test('runtime pasted migration actual MCP transport executes an accepted definition without original-bot adoption',async t=>{
  const x=await setup(t),{work}=await x.paste(),[clientTransport,serverTransport]=InMemoryTransport.createLinkedPair(),connection=await connectMcp(x.api,serverTransport,{transport:'streamable-http'}),client=new Client({name:'pasted-migration-fixture',version:'1'});x.onClose(async()=>{await client.close();await connection.close();});await client.connect(clientTransport);
  const reply=await client.callTool({name:'runtime_work_execute',arguments:{work_id:work.id,revision:work.revision,cost_acknowledged:true}});assert.notEqual(reply.isError,true,JSON.stringify(reply));const accepted=JSON.parse(reply.content[0].text);assert.equal(accepted.accepted,true);assert.equal((await settle(x,work.id)).result.completion_verified,true);
});

test('runtime pasted migration actual UI exposes Execute after consent, no misleading original-runtime chooser, and live host receipts',{timeout:20000},async t=>{
  const x=await setup(t),{work}=await x.paste(),server=await startControlCenter(x.config,{workModel:x.provider});x.onClose(()=>server.close());const browser=await chromium.launch({headless:true});x.onClose(()=>browser.close());const page=await browser.newPage();await page.goto(server.url+'?work='+work.id,{waitUntil:'domcontentloaded'});await page.locator('#execute-work').waitFor();assert.equal(await page.locator('#office-work-adoption').count(),0);assert.equal(await page.locator('#execution-consent').count(),0);assert.equal(await page.locator('#execute-work').isEnabled(),true);
  const response=page.waitForResponse(r=>r.url().endsWith('/work/execute')&&r.request().method()==='POST');await page.locator('#execute-work').click();assert.equal((await response).status(),202);await page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('supervisor.result'),{},{timeout:7000});
  const detail=await (await fetch(server.url+'work/detail?id='+work.id)).json();assert.equal(detail.supervisor.state,'succeeded');assert.equal(detail.supervisor.result.completion_verified,true);assert.equal(detail.activity.some(e=>e.kind==='supervisor.started'),true);assert.ok(detail.supervisor.run_id);assert.equal(x.api.store.hermesState.prepare('SELECT count(*) AS n FROM office_supervisor WHERE work_id=?').get(work.id).n,1);assert.equal(detail.adoption_eligible,false);
});

test('runtime pasted migration recurring UI warns about original platform duplicate scheduling in Korean and English',{timeout:20000},async t=>{
  const x=await setup(t),{work}=await x.paste(true),server=await startControlCenter(x.config,{workModel:x.provider});x.onClose(()=>server.close());const browser=await chromium.launch({headless:true});x.onClose(()=>browser.close());
  for(const [language,width] of [['ko',1280],['en',375]]){const context=await browser.newContext({viewport:{width,height:900}});await context.addInitScript(lang=>localStorage.setItem('office-lang',lang),language);const page=await context.newPage();await page.goto(server.url+'?work='+work.id,{waitUntil:'domcontentloaded'});const note=page.locator('#office-work-migration-notice');await note.waitFor();const text=await note.textContent();assert.match(text,language==='en'?/turn off the original platform schedule/u:/기존 플랫폼의 예약은 직접 꺼/u);assert.equal(text,language==='en'?'Only this cycle runs by default. If you enable recurring runs here, turn off the original platform schedule. Leaving both on runs the work in both places.':'기본은 이번 회차만 실행해요. 반복 실행을 켜려면 기존 플랫폼의 예약은 직접 꺼 주세요. 둘 다 켜 두면 양쪽에서 실행돼요.');assert.equal(await page.locator('#office-work-adoption').count(),0);assert.equal(await page.locator('#execute-work').isEnabled(),true);assert.equal(await page.locator('#execution-consent').isChecked(),false);assert.equal((await (await fetch(server.url+'work/detail?id='+work.id)).json()).schedule,null);await context.close();}
  assert.equal(x.provider.inputs.length,0);
});
