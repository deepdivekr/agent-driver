import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkResults} from '../dist/work/results.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {sha} from '../dist/packs/data.js';
import {startControlCenter} from '../dist/observability/control-center.js';
const proposal={title:'테스트 자료 수집',desired_outcome:'실제 로컬 원본의 값을 결과에 남긴다',completion_checks:[{id:'records',result:'원본 제목과 값 23 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
function fixture(options={}){const calls=[];return {calls,async call(purpose,instructions,input){
  calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
  if(instructions.startsWith('Define one durable'))return proposal;
  if(instructions.startsWith('Revise this existing'))return {...proposal,title:'자료 요약',desired_outcome:'수집한 자료를 요약문으로 반환'};
  if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{const resultIds=check.allowed_evidence_ids.filter(id=>input.observations.some(observation=>observation.tool_name!=='office_controlled_run_trace'&&observation.evidence_ids.includes(id)));return {id:check.id,verdict:'supported',evidence_ids:resultIds,evidence_quotes:resultIds.map(id=>({evidence_id:id,quote:'Observed source'})),reason:'The real file result contains the requested row.'};})};
  assert.ok(instructions.startsWith('Execute the registered Work'));
  if(options.gate&&input.checkpoint.observations.length===0)await options.gate;
  const result=input.checkpoint.observations.find(o=>o.invocation.tool_name==='runtime_pack_run');
  if(result)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(c=>({id:c.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null};
  return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the delegated source through the actual Pack runtime.',completed_checks:[],wait_reason:null};
}};}
async function setup(t,options={}){
 const root=await mkdtemp(join(tmpdir(),'work-supervisor-')),host=join(root,'host.json');await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
 await writeFile(host,JSON.stringify({schema_version:1,project_id:'supervisor-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
 const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);const model=fixture(options),runtime=new WorkRuntime(store,config,model);const work=await runtime.start({request_id:'work-test',prompt:'자료를 확인해줘'});
 const cleanup=[];t.after(async()=>{for(const operation of cleanup.reverse())await operation();store.close();await rm(root,{recursive:true,force:true});});return {root,config,store,model,work,cleanup};
}
async function finished(x,states=['succeeded','failed','awaiting_review','reconciliation_required']){for(let i=0;i<120;i++){const s=supervisorStatus(x.store,x.config.project.id,x.work.work_id);if(states.includes(s?.state))return s;await delay(25);}assert.fail(JSON.stringify(supervisorStatus(x.store,x.config.project.id,x.work.work_id)));}
test('runtime fixture supervised Work performs native Pack file I/O, independent verification and result capture',async t=>{
 const x=await setup(t),results=new WorkResults(x.store),supervisor=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25,onResult:id=>results.capture(x.config.project.id,id)});x.cleanup.push(()=>supervisor.close());
 assert.throws(()=>supervisor.start(x.work.work_id,999,true),/REVISION/);assert.throws(()=>supervisor.start(x.work.work_id,x.work.revision,false),/CONSENT/);
 const started=supervisor.start(x.work.work_id,x.work.revision,true);assert.equal(started.accepted,true);assert.equal(supervisor.start(x.work.work_id,x.work.revision,true).deduplicated,true);
 const end=await finished(x);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
 assert.equal(x.store.officeRuns(x.config.project.id,x.work.work_id).length,1);const output=results.capture(x.config.project.id,x.work.work_id)[0];assert.ok(output.text.includes('23'));assert.equal(output.deliveries[0].status,'available');
 assert.equal(JSON.parse(await readFile(join(x.root,'source.json'),'utf8'))[0].value,23);
});
test('runtime fixture pause/edit/resume races retain receipts and do not let old result overwrite new direction',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),x=await setup(t,{gate});const s=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25});x.cleanup.push(async()=>{release();await s.close();});s.start(x.work.work_id,x.work.revision,true);await delay(40);
 const edited=s.action({work_id:x.work.work_id,revision:x.work.revision,action:'edit',instruction:'카드가 아닌 요약문으로 반환해줘.'});assert.equal(edited.state,'paused');
 const resumed=s.action({work_id:x.work.work_id,revision:edited.revision,action:'resume'});assert.equal(resumed.state,'queued');release();const end=await finished(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
 const work=x.store.intakeWork(x.config.project.id,x.work.work_id);assert.equal(work.spec.title,'자료 요약');assert.equal(work.revision,3);assert.equal(x.store.officeRuns(x.config.project.id,work.id).length,1);assert.equal(x.store.workDirections(x.config.project.id,work.id).length,1);
});
test('runtime fixture service restart continues the same paused run without repeated successful source work',async t=>{
 const x=await setup(t);let release,entered;const waiting=new Promise(r=>entered=r),gate=new Promise(r=>release=r),base=x.model.call.bind(x.model);x.model.call=async(...args)=>{if(args[2]?.checkpoint?.observations?.length){entered();await gate;}return base(...args);};
 let s=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25});s.start(x.work.work_id,x.work.revision,true);await waiting;const paused=s.action({work_id:x.work.work_id,revision:x.work.revision,action:'pause'});release();await s.close();
 const count=x.store.officeRuns(x.config.project.id,x.work.work_id).length,oldRun=paused.run_id;s=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25});x.cleanup.push(()=>s.close());s.action({work_id:x.work.work_id,revision:paused.revision,action:'resume'});const end=await finished(x);
 assert.equal(end.state,'succeeded');assert.equal(end.run_id,oldRun);assert.equal(x.store.officeRuns(x.config.project.id,x.work.work_id).length,count);assert.equal(end.steps.filter(v=>v.tool==='runtime_pack_run').length,1);
});
test('runtime fixture separate MCP/UI supervisors share the host Work concurrency budget and durable admission',async t=>{
 const hold=(()=>{let release;const promise=new Promise(r=>release=r);return {promise,release};})(),x=await setup(t,{gate:hold.promise});
 const a=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:20,max_parallel:1}),b=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:20,max_parallel:1});x.cleanup.push(async()=>{hold.release();await Promise.all([a.close(),b.close()]);});
 const runtime=new WorkRuntime(x.store,x.config,x.model),second=await runtime.start({request_id:'another-work',prompt:'다른 업무로 원본을 조회해줘'});
 a.start(x.work.work_id,x.work.revision,true);b.start(second.work_id,second.revision,true);await delay(100);
 const live=x.store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_supervisor WHERE state='running' AND owner IS NOT NULL AND lease_until_ms>?").get(Date.now()).n;
 assert.equal(live,1);assert.equal(supervisorStatus(x.store,x.config.project.id,second.work_id).state,'queued');hold.release();
 assert.equal((await finished(x)).state,'succeeded');assert.equal((await finished({...x,work:second})).state,'succeeded');
 assert.equal(x.store.officeRuns(x.config.project.id,x.work.work_id).length,1);assert.equal(x.store.officeRuns(x.config.project.id,second.work_id).length,1);
});

async function legacyQualityCheckpoint(t,{foreign=false}={}){
 const x=await setup(t),spec={...x.store.intakeWork(x.config.project.id,x.work.work_id).spec,route:{kind:'pack',pack_family:'file.pipeline'}};
 x.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE project_id=? AND work_id=?').run(JSON.stringify(spec),x.config.project.id,x.work.work_id);
 const source=JSON.stringify([{id:'one',title:'Observed source',value:23,source_text:'Observed source is the actual title.'}]);await writeFile(join(x.root,'source.json'),source);
 const bad={version:1,family:'file.pipeline',request:'Export the exact delegated values',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],columns:['title','value'],numeric_columns:['value'],sort:null,format:'json',verification:[{id:'title_copy',kind:'literal_copy',source_field:'missing_source_text',value_field:'title'}]},good={...bad,verification:[{...bad.verification[0],source_field:'source_text'}]};
 const calls=[],family=new FamilyRuntime(x.store,x.config),api={async call(name,input){calls.push({name,input:structuredClone(input)});return family.call(name,input);}};
 x.cleanup.push(()=>family.drain());const runId=randomUUID(),requestId='legacy-quality-request';
 let packWork=x.work.work_id;
 if(foreign){const begun=x.store.beginWork(x.config.project.id,randomUUID(),'Read another Work source','quick'),owner=x.store.claimWorkDefinition(x.config.project.id,begun.work.id);packWork=x.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,spec,[],'ready').id;}
 const tools=new WorkExecutionTools(x.store,x.config,api,packWork,runId,spec,x.work.prompt??'자료를 확인해줘',()=>{},x.model);x.cleanup.push(()=>tools.close());
 const value=await tools.execute('runtime_pack_run',{recipe:bad},requestId),receipt=await tools.receipt('runtime_pack_run',value,requestId);
 assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.effect_state,'verified');assert.equal(value.status,'needs_review');assert.equal(value.task_id,null);assert.equal(value.result.verification.all_checks_passed,false);
 const artifactBytes=await readFile(value.result.artifact.path);assert.equal(sha(artifactBytes),value.result.artifact.sha256);
 const legacy={...receipt,status:'waiting_approval',effect_state:'none',retry_safe:false,value:structuredClone(value)};
 const invocation={request_id:requestId,turn:0,stage_id:'legacy-source',tool_name:'runtime_pack_run',arguments:{recipe:bad},effect:'local_write',dispatched:true};
 const checkpoint={format:1,work_id:x.work.work_id,run_id:runId,binding:'legacy-binding',turn:1,pending:null,observations:[{invocation,receipt:legacy,observed_at:new Date().toISOString()}],summary:'The old build incorrectly held source quality for user approval.'};
 const supervisor=new WorkSupervisor(x.store,x.config,x.model,{auto_start:false,tick_ms:25,api,verifyCompletion:async(_checks,observations)=>{
  const last=observations.at(-1).receipt;if(last.status!=='succeeded'||last.effect_state!=='verified')return false;
  const bytes=await readFile(last.value.result.artifact.path);return sha(bytes)===last.value.result.artifact.sha256&&last.value.result.verification.all_checks_passed===true&&await readFile(join(x.root,'source.json'),'utf8')===source&&JSON.stringify(JSON.parse(bytes))===JSON.stringify([{title:'Observed source',value:23}]);
 }});x.cleanup.push(()=>supervisor.close());
 const at=new Date().toISOString();x.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,reason,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(runId,x.config.project.id,x.work.work_id,x.work.revision,'waiting_approval',JSON.stringify(checkpoint),'WORK_CLIENT_WAITING_APPROVAL',x.config.fingerprint,0,at,at);
 supervisor.activate();
 const saved=()=>JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(runId).checkpoint);
 const storeCheckpoint=()=>x.store.hermesState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(checkpoint),runId);
 return {...x,spec,source,bad,good,calls,value,artifactBytes,checkpoint,supervisor,saved,storeCheckpoint};
}

test('runtime fixture resume rechecks legacy owned Pack quality receipt and corrects once without replaying its original invocation',async t=>{
 const x=await legacyQualityCheckpoint(t),seen=[];x.model.call=async(_purpose,instructions,input)=>{
  assert.ok(instructions.startsWith('Execute the registered Work'));seen.push(structuredClone(input));x.model.calls.push({purpose:'correct',status:'accepted',provider:'fixture',model:'fixture'});
  if(input.checkpoint.observations.length===1){const receipt=input.checkpoint.observations[0].receipt;assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.effect_state,'verified');assert.equal(receipt.value.correction.kind,'data_quality');assert.equal(receipt.value.correction.user_confirmation_required,false);return {action:'tool',stage_id:'correct-source',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe:x.good}),summary:'Correct only the observed source field.',completed_checks:[],wait_reason:null};}
  const last=input.checkpoint.observations.at(-1).receipt;return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:last.evidence_ids})),wait_reason:null};
 };
 const beforeCalls=x.calls.length;x.supervisor.action({work_id:x.work.work_id,revision:x.work.revision,action:'resume'});const end=await finished(x);
 assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.run_id,x.checkpoint.run_id);assert.equal(end.result.completion_verified,true);assert.equal(seen.length,2);
 assert.equal(x.calls.length,beforeCalls+1);assert.equal(x.calls.at(-1).name,'runtime_pack_run');assert.deepEqual(x.calls.at(-1).input.recipe,x.good);assert.notEqual(x.calls.at(-1).input.request_id,'legacy-quality-request');
 assert.equal(x.store.officeRuns(x.config.project.id,x.work.work_id).length,2);assert.equal(x.store.packRun(x.config.project.id,x.value.run_id).status,'needs_review');
 const saved=x.saved();assert.equal(saved.observations.length,2);assert.equal(saved.observations[0].invocation.request_id,'legacy-quality-request');assert.equal(saved.observations[0].receipt.value.correction.kind,'data_quality');assert.equal(hashJson(saved.observations[0].receipt.value.result),hashJson(x.value.result));
 assert.equal(await readFile(join(x.root,'source.json'),'utf8'),x.source);assert.deepEqual(await readFile(x.value.result.artifact.path),x.artifactBytes);
 assert.equal(x.store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_activity WHERE work_id=? AND kind='supervisor.receipt_rechecked'").get(x.work.work_id).n,1);
});

for(const boundary of ['real_approval','foreign_work','changed_result_hash','changed_artifact_bytes','uncertain_write'])test(`runtime fixture legacy Pack resume does not bypass ${boundary}`,async t=>{
 const x=await legacyQualityCheckpoint(t,{foreign:boundary==='foreign_work'});let modelCalls=0;
 if(boundary==='real_approval'){x.store.finishPack(x.config.project.id,x.value.run_id,'waiting_approval',x.value.result,null);x.checkpoint.observations[0].receipt.value.status='waiting_approval';}
 if(boundary==='changed_result_hash')x.checkpoint.observations[0].receipt.value.result.verification.receipts[0].reason='Invented verification result';
 if(boundary==='changed_artifact_bytes')await writeFile(x.value.result.artifact.path,'Unobserved replacement artifact');
 if(boundary==='uncertain_write'){x.checkpoint.observations[0].receipt.effect_state='uncertain';x.checkpoint.pending={...x.checkpoint.observations[0].invocation,turn:1,request_id:'uncertain-pending-write'};}
 x.storeCheckpoint();x.model.call=async(_purpose,instructions,input)=>{assert.ok(instructions.startsWith('Execute the registered Work'));modelCalls++;assert.equal(input.checkpoint.observations[0].receipt.status,'waiting_approval');assert.equal(input.checkpoint.observations[0].receipt.value.correction,undefined);return {action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The original approval/provenance boundary still needs review.',completed_checks:[],wait_reason:'approval'};};
 const before=x.calls.length;x.supervisor.action({work_id:x.work.work_id,revision:x.work.revision,action:'resume'});const end=await finished(x,['waiting_approval','reconciliation_required','failed']);
 assert.equal(end.state,boundary==='uncertain_write'?'reconciliation_required':'waiting_approval',JSON.stringify(end));assert.equal(end.result?.completion_verified??false,false);assert.equal(x.calls.length,before);assert.equal(modelCalls,boundary==='uncertain_write'?0:1);
 const saved=x.saved();assert.equal(saved.observations[0].receipt.status,'waiting_approval');assert.equal(saved.observations[0].receipt.value.correction,undefined);assert.equal(x.store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_activity WHERE work_id=? AND kind='supervisor.receipt_rechecked'").get(x.work.work_id).n,0);
 assert.equal(await readFile(join(x.root,'source.json'),'utf8'),x.source);
});
test('runtime fixture actual desktop/mobile UI has execute, true live tail, controls and locally served result',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve),x=await setup(t,{gate}),server=await startControlCenter(x.config,{workModel:x.model}),browser=await chromium.launch({headless:true});x.cleanup.push(async()=>{release();await browser.close();await server.close();});
 for(const [index,[lang,width,theme]] of [['ko',1280,'dark'],['en',390,'dark'],['en',1280,'light'],['ko',390,'light']].entries()){
  const page=await browser.newPage({viewport:{width,height:900},timezoneId:'Asia/Seoul'});await page.addInitScript(({lang,theme})=>{localStorage.setItem('office-lang',lang);localStorage.setItem('office-theme',theme);},{lang,theme});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(server.url+'?work='+x.work.work_id);if(index===0){
   await page.locator('#execution-consent').check();await page.locator('#execute-work').click();
   await page.waitForFunction(()=>document.getElementById('work-tail-output')?.textContent.includes('model.started'));
   await page.locator('.supervisor-control .live-stage[data-busy=true]').waitFor();
   await page.locator('#supervisor-instruction').fill('Return the collected data as a summary.');release();
  }
  await page.waitForFunction(()=>document.querySelector('#work-tail-output')?.textContent.includes('supervisor.result'));
  await page.locator('.work-results').waitFor();assert.ok(await page.locator('.work-results').innerText().then(v=>v.includes('23')));assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.equal(await page.getByRole('button',{name:lang==='ko'?'일시정지 미지원':'Pause not supported',exact:true}).count(),0);
  if(index===0){
   assert.equal(await page.locator('#supervisor-instruction').inputValue(),'Return the collected data as a summary.');assert.equal(await page.evaluate(()=>document.activeElement.id),'supervisor-instruction');
   assert.equal(x.store.hermesState.prepare('SELECT timezone FROM office_supervisor WHERE work_id=?').get(x.work.work_id).timezone,'Asia/Seoul');
   await page.locator('[data-supervisor-action="edit"]').click();await page.locator('[data-supervisor-action="resume"]').waitFor();
   assert.equal(supervisorStatus(x.store,x.config.project.id,x.work.work_id).state,'paused');
   await page.locator('[data-supervisor-action="resume"]').click();await page.waitForFunction(()=>document.querySelector('.supervisor-control .badge')?.textContent.includes('실행 완료'));
   assert.equal(x.store.intakeWork(x.config.project.id,x.work.work_id).spec.title,'자료 요약');assert.equal(x.store.officeRuns(x.config.project.id,x.work.work_id).length,1);
  }else if(lang==='en')assert.doesNotMatch(await page.locator('.work-tail').innerText(),/[가-힣]/u);
  assert.deepEqual(errors,[]);await page.close();
 }
});
