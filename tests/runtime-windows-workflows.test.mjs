import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {WINDOWS_WORKFLOWS,windowsWorkflow} from '../dist/desktop/windows-workflows.js';
import {compileWindowsDecision,desktopObservationSchema,decideWindowsTarget} from '../dist/desktop/windows-decision.js';
import {BASE_PACK_CATALOG} from '../dist/taskpacks/base-pack-catalog.js';
import {WindowsWorkflowRuntime} from '../dist/desktop/windows-runtime.js';
import {PackStore} from '../dist/packs/store.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';

const fixtureJev=(calls,selected='c0')=>({async systemOne(request){calls.push(request);return {model:'fixture-not-live',usage:{input_tokens:101,output_tokens:22},answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{const value=id==='state'?'ready':selected;return [id,{type:'choice',choice:value,confidence:.99,probabilities:Object.fromEntries(Object.keys(q.criteria).map(key=>[key,key===value?1:0]))}];}))};}});
const fixtureLlm=calls=>({calls:[],async call(purpose,_instructions,state){calls.push({purpose,state});if(purpose==='design'||purpose==='repair')return {ready_when:'The current step has one visible enabled matching control.',target_when:'Choose the control whose label and role match the requested step.',reobserve_when:'The target is missing, ambiguous or blocked.'};return {state:'ready',target:'c0',evidence_quote:state.candidates.c0.label};}});
const selection={mode:'subscription',client:'auto',client_models:{codex:null,claude:null,opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'fixture-model',api_base_url:'',reasoning:'low',jev:'on'};

async function setup(t,{driver=true,models='jev_llm',approved=true,jevChoice='c0',llm=true}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-windows-pack-')),path=join(root,'host.json');
  let api;
  t.after(async()=>{if(api){api.close();await api.drain();}await rm(root,{recursive:true,force:true});});
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'windows-test',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models,model_data_approved:approved,sources:[],targets:[]}}));
  const config=loadHostConfig(path),jevCalls=[],llmCalls=[],actions=[],authorizations=[];
  const state={facts:[],capture:0,screen:'workspace',recipient:'self',approval:true,job:null,workflow:null,stage:0,observations:0,
    onObserve:null,onAuthorize:null,onAct:null,dropReceipt:false,badReadback:false};
  const transport={id:'fixture-desktop',async observe(job){
    state.job=job;state.workflow=windowsWorkflow(job.workflow_id);state.observations++;
    const step=state.workflow.steps[state.stage]??state.workflow.steps.at(-1),role=step.roles[0];
    const observation={capture_id:`capture-${++state.capture}`,window_ref:'fixture-window',application:state.workflow.applications[0],captured_at_ms:Date.now(),screen:state.screen,recipient:state.recipient,recipient_evidence:state.recipient==='self'?['fixture-self-marker']:[],
      controls:[{id:'target',label:'Fixture '+step.id,role,visible:true,enabled:true,sensitive:false}],facts:[...state.facts]};
    await state.onObserve?.(observation,job);return observation;
  },async authorize(command){authorizations.push(command);await state.onAuthorize?.(command);return state.approval;},async act(command){
    actions.push(command);await state.onAct?.(command);
    const step=state.workflow.steps[state.stage];
    state.facts.push(...step.verifies.map(key=>({key,evidence_ref:`proof-${key}`,binding_sha256:command.binding_sha256,action_id:state.badReadback?'wrong-action':command.action_id})));
    // Originals are verified locally by the synthetic adapter, never an LLM.
    if(!state.facts.some(f=>f.key==='original_unchanged'))state.facts.push({key:'original_unchanged',evidence_ref:'original-hash',binding_sha256:command.binding_sha256,action_id:null});
    state.stage++;if(state.dropReceipt)throw Error('FIXTURE_LOST_RESPONSE');
    return {action_id:command.action_id,capture_id:command.capture_id,window_ref:command.window_ref,target_id:command.target_id,outcome:'performed'};
  }};
  const fallback=fixtureLlm(llmCalls);api=new RuntimeApi(config,{swarmModel:fallback,windows:{...(driver?{driver:transport}:{}),jev:fixtureJev(jevCalls,jevChoice),...(llm?{llm:fallback}:{llm:{calls:[],async call(){throw Error('FIXTURE_NO_LLM');}}})}});
  async function start(id='windows.kakao.self-note',request='request-1'){
    const profile=windowsWorkflow(id),work=api.store.beginWork(config.project.id,request,profile.example,'quick').work;
    api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify({route:{kind:'pack',pack_family:profile.family}}),work.id);
    const args={request_id:request,work_id:work.id,workflow_id:id,inputs:Object.fromEntries(Object.keys(profile.inputs).map(key=>[key,`fixture ${key}`]))};
    const run=await api.call('runtime_windows_start',args);return {run,args,work};
  }
  const step=run=>api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});
  return {root,config,api,state,transport,actions,authorizations,jevCalls,llmCalls,start,step};
}

test('runtime contract Windows catalog has ten explicit profiles without adding Pack families',()=>{
  assert.equal(WINDOWS_WORKFLOWS.length,10);assert.equal(new Set(WINDOWS_WORKFLOWS.map(p=>p.id)).size,10);assert.equal(BASE_PACK_CATALOG.length,9);
  for(const profile of WINDOWS_WORKFLOWS){assert.ok(BASE_PACK_CATALOG.some(f=>f.id===profile.family));assert.ok(profile.jev_value&&profile.boundary&&profile.completion);assert.ok(profile.steps.every(s=>s.verifies.length&&s.goal));}
});
for(const profile of WINDOWS_WORKFLOWS)test(`runtime contract Windows ${profile.id} completes with synthetic host evidence only`,async t=>{
  const x=await setup(t);let {run}=await x.start(profile.id);
  for(let i=0;i<profile.steps.length;i++){run=await x.step(run);assert.ok(['ready','completed'].includes(run.status),JSON.stringify(run));}
  assert.equal(run.status,'completed');assert.equal(run.progress,1);assert.equal(run.receipts.length,profile.steps.length);
  assert.equal(run.work_completion_verified,false);assert.equal(x.actions.length,profile.steps.length);assert.equal(x.jevCalls.length,profile.steps.length);assert.equal(x.llmCalls.filter(c=>c.purpose==='design').length,profile.steps.length);assert.equal(x.llmCalls.filter(c=>c.purpose==='correct').length,0);
  for(const receipt of run.receipts){assert.equal(receipt.decision.decider,'jev');assert.equal(receipt.decision.selected_probability,1);assert.equal(receipt.decision.input_tokens,101);assert.ok(receipt.evidence_refs.length);}
  const before=x.actions.length;assert.equal((await x.step(run)).status,'completed');assert.equal(x.actions.length,before);
  const audit=JSON.parse((await readFile(join(x.root,'data','decisions','windows.jsonl'),'utf8')).trim().split('\n')[0]);assert.ok(JSON.stringify(audit).includes('windows.workflow'));
});

test('runtime contract Windows unconnected executor admits a waiting Work but makes no model or desktop call',async t=>{
  const x=await setup(t,{driver:false}),{run,args,work}=await x.start();assert.equal(run.status,'waiting_connection');
  assert.equal((await x.api.call('runtime_windows_catalog',{})).native_executor,'not_connected');
  assert.equal((await x.api.call('runtime_pack_plan',{prompt:'Windows 메모장'})).windows_profiles.length,10);
  assert.equal((await x.api.call('runtime_windows_plan',{workflow_id:args.workflow_id})).dispatch_allowed,false);
  assert.equal((await x.api.call('runtime_windows_start',args)).deduplicated,true);
  assert.equal((await x.api.call('runtime_work_status',{work_id:work.id})).windows_runs[0].run_id,run.run_id);
  await x.step(run);assert.equal(x.jevCalls.length,0);assert.equal(x.actions.length,0);
});
test('runtime contract Windows binds request identity and family to the exact ready Work',async t=>{
  const x=await setup(t),{args,run}=await x.start();
  await assert.rejects(x.api.call('runtime_windows_start',{...args,inputs:{message:'changed'}}),/REQUEST_ID_CONFLICT/);
  await assert.rejects(x.api.call('runtime_windows_start',{...args,request_id:'another',workflow_id:'windows.note.capture',inputs:{body:'memo'}}),/WORK_PACK_FAMILY_MISMATCH/);
  await assert.rejects(x.api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:99}),/REVISION_CONFLICT/);
});
test('runtime contract Windows pre-existing self message is not proof of a new send',async t=>{
  const x=await setup(t);let {run}=await x.start();for(let i=0;i<3;i++)run=await x.step(run);
  x.state.facts.push({key:'new_self_message_verified',evidence_ref:'old-message',binding_sha256:x.state.job.binding_sha256,action_id:null});
  x.state.approval=false;run=await x.step(run);assert.equal(run.status,'waiting_approval');assert.equal(x.actions.length,3);
});
for(const recipient of ['other','unknown'])test(`runtime contract Windows ${recipient} chat cannot receive self-note draft or send`,async t=>{
  const x=await setup(t);let {run}=await x.start();run=await x.step(run);run=await x.step(run);x.state.recipient=recipient;
  run=await x.step(run);assert.equal(run.status,'needs_review');assert.equal(x.actions.length,2);assert.equal(x.jevCalls.length,2);
});
for(const screen of ['authentication','security','locked','unknown'])test(`runtime contract Windows ${screen} screen produces no input and no model call`,async t=>{
  const x=await setup(t),{run}=await x.start();x.state.screen=screen;assert.ok(['waiting_auth','needs_review'].includes((await x.step(run)).status));assert.equal(x.actions.length,0);assert.equal(x.jevCalls.length,0);
});
test('runtime contract Windows Jev unknown is corrected by configured LLM without synthetic confidence',async t=>{
  const x=await setup(t,{jevChoice:'unknown'}),{run}=await x.start();const result=await x.step(run);
  assert.equal(result.receipts[0].decision.decider,'llm');assert.equal(result.receipts[0].decision.confidence,null);assert.deepEqual(x.llmCalls.map(c=>c.purpose),['design','correct','repair']);
});

async function repeatDraft(x,first,overrides={}){
  x.state.stage=0;x.state.facts=[];
  return x.api.call('runtime_windows_start',{...first.args,request_id:'repeat-'+x.state.capture,inputs:{...first.args.inputs,value:'second private draft',...overrides}});
}
test('runtime contract verified Windows judgment skips repeated LLM design but still judges fresh state',async t=>{
  const x=await setup(t),first=await x.start('windows.form.draft');
  const a=await x.step(first.run);assert.equal(a.status,'completed');
  assert.equal(a.receipts[0].decision.procedure.design_status,'designed');
  const b=await x.step(await repeatDraft(x,first));assert.equal(b.status,'completed');
  assert.equal(b.receipts[0].decision.procedure.cache_hit,true);
  assert.equal(b.receipts[0].decision.procedure.llm_calls,0);
  assert.equal(x.llmCalls.length,1);assert.equal(x.jevCalls.length,2);assert.equal(x.actions.length,2);
  const rows=x.api.store.desktopState.prepare("SELECT body FROM windows_procedure WHERE kind='judgment'").all();
  assert.equal(rows.length,1);assert.ok(!JSON.stringify(rows).includes('second private draft'));
  assert.ok(x.jevCalls[1].state.task_conditions);
});
test('runtime contract unverified Windows effect never promotes judgment conditions',async t=>{
  const x=await setup(t),first=await x.start('windows.form.draft');x.state.badReadback=true;
  assert.equal((await x.step(first.run)).status,'reconciliation_required');
  assert.equal(x.api.store.desktopState.prepare('SELECT count(*) n FROM windows_procedure').get().n,0);
});
test('runtime contract corrected Windows conditions promote only after verified effect',async t=>{
  const x=await setup(t,{jevChoice:'unknown'}),first=await x.start('windows.form.draft');
  const a=await x.step(first.run);assert.equal(a.status,'completed');
  assert.deepEqual(x.llmCalls.map(c=>c.purpose),['design','correct','repair']);
  const b=await x.step(await repeatDraft(x,first));assert.equal(b.status,'completed');
  assert.equal(b.receipts[0].decision.procedure.cache_hit,true);
  assert.deepEqual(x.llmCalls.map(c=>c.purpose),['design','correct','repair','correct','repair']);
});
for(const change of ['target','intent','settings'])test(`runtime contract Windows ${change} change cannot reuse an obsolete judgment`,async t=>{
  const x=await setup(t),first=await x.start('windows.form.draft');assert.equal((await x.step(first.run)).status,'completed');
  if(change==='target')x.state.onObserve=obs=>{obs.controls[0].label+=' new';};
  if(change==='settings')saveModelSettings(modelSettingsPath(x.config),{revision:0,onboarding_step:2,selection},{TYPESAFE_API_KEY:'fixture-only-not-live'});
  const b=await x.step(await repeatDraft(x,first,change==='intent'?{field:'different intended field'}:{}));
  assert.equal(b.status,'completed');assert.equal(b.receipts[0].decision.procedure.cache_hit,false);
  assert.equal(x.llmCalls.filter(c=>c.purpose==='design').length,2);
});
test('runtime contract disabling Jev overrides a previously learned Windows judgment',async t=>{
  const x=await setup(t),first=await x.start('windows.form.draft');assert.equal((await x.step(first.run)).status,'completed');
  saveModelSettings(modelSettingsPath(x.config),{revision:0,onboarding_step:2,selection:{...selection,jev:'off'}},{});
  const b=await x.step(await repeatDraft(x,first));assert.equal(b.status,'completed');
  assert.equal(b.receipts[0].decision.decider,'llm');assert.equal(x.jevCalls.length,1);
  assert.deepEqual(x.llmCalls.map(c=>c.purpose),['design','correct']);
});
for(const mode of ['global_off','work_off','models_off','data_not_approved'])test(`runtime contract Windows ${mode} preserves model-use limits`,async t=>{
  // Production config admission itself rejects enabled models without consent.
  if(mode==='data_not_approved'){await assert.rejects(setup(t,{approved:false}),/MODEL_DATA_APPROVAL_REQUIRED/);return;}
  const x=await setup(t,{models:mode==='models_off'?'off':'jev_llm',approved:mode!=='data_not_approved'}),{run,work}=await x.start();
  if(mode==='global_off')saveModelSettings(modelSettingsPath(x.config),{revision:0,onboarding_step:2,selection:{...selection,jev:'off'}},{});
  if(mode==='work_off')x.api.store.desktopState.prepare('UPDATE office_intake SET jev_override=0 WHERE work_id=?').run(work.id);
  const result=await x.step(run);assert.equal(x.jevCalls.length,0);
  if(['global_off','work_off'].includes(mode)){assert.equal(result.receipts[0].decision.decider,'llm');assert.equal(x.actions.length,1);}
  else {assert.equal(x.llmCalls.length,0);assert.equal(x.actions.length,0);assert.equal(result.status,'needs_review');}
});
test('runtime contract Windows moved target after Jev selection cannot receive a click',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.onObserve=obs=>{if(x.state.observations===2)obs.controls[0].label='Different target';};
  assert.equal((await x.step(run)).reason,'WINDOWS_STATE_CHANGED_REOBSERVE');assert.equal(x.actions.length,0);
});
test('runtime contract Windows changed chat during human approval cannot receive text',async t=>{
  const x=await setup(t);let {run}=await x.start();run=await x.step(run);run=await x.step(run);
  x.state.onAuthorize=()=>{x.state.recipient='other';};assert.equal((await x.step(run)).reason,'WINDOWS_STATE_CHANGED_AFTER_APPROVAL');assert.equal(x.actions.length,2);
});
test('runtime contract Windows Work pause during approval prevents late dispatch',async t=>{
  const x=await setup(t),{run,work}=await x.start();x.state.onAuthorize=()=>x.api.store.desktopState.prepare('UPDATE office_intake SET paused=1 WHERE work_id=?').run(work.id);
  assert.equal((await x.step(run)).reason,'WORK_PAUSED');assert.equal(x.actions.length,0);
});
test('runtime contract Windows unknown post-effect state is durable and cannot be replayed',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.dropReceipt=true;const failed=await x.step(run);
  assert.equal(failed.status,'reconciliation_required');assert.equal((await x.step(failed)).status,'reconciliation_required');assert.equal(x.actions.length,1);
  const stored=x.api.store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE id=?').get(run.run_id);assert.equal(JSON.parse(stored.body).last_action_id,x.actions[0].action_id);
  const reopened=new PackStore(x.config.dbPath);
  try{const runner=new WindowsWorkflowRuntime(reopened,x.config,{driver:x.transport});assert.equal(runner.status(run.run_id).status,'reconciliation_required');assert.equal((await runner.call('runtime_windows_step',{run_id:failed.run_id,expected_revision:failed.revision})).status,'reconciliation_required');await runner.drain();}finally{reopened.close();}
  const other=await x.start('windows.note.capture','other');assert.equal((await x.step(other.run)).dispatch_blocked,'WINDOWS_EXECUTOR_BUSY_OR_UNRECONCILED');assert.equal(x.actions.length,1);
});
test('runtime contract Windows workflow changes or executor replacement cannot resume the old action contract',async t=>{
  const x=await setup(t),{run}=await x.start();const progressed=await x.step(run);
  const replacement=new WindowsWorkflowRuntime(x.api.store,x.config,{driver:{...x.transport,id:'different-desktop'}});
  await assert.rejects(replacement.call('runtime_windows_step',{run_id:run.run_id,expected_revision:progressed.revision}),/WINDOWS_EXECUTOR_CHANGED/);await replacement.drain();
  const raw=JSON.parse(x.api.store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE id=?').get(run.run_id).body);raw.workflow_hash='0'.repeat(64);
  x.api.store.desktopState.prepare('UPDATE windows_workflow_run SET body=? WHERE id=?').run(JSON.stringify(raw),run.run_id);
  await assert.rejects(x.step(progressed),/WINDOWS_WORKFLOW_CHANGED/);assert.equal(x.actions.length,1);
});
test('runtime contract Windows wrong-action readback cannot complete a stage',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.badReadback=true;const result=await x.step(run);assert.equal(result.status,'reconciliation_required');assert.equal(result.completed_steps,0);
});
test('runtime contract Windows concurrent steps share a durable foreground exclusion lock',async t=>{
  const x=await setup(t),{run}=await x.start();let release;const held=new Promise(resolve=>{release=resolve;});let entered;const ready=new Promise(resolve=>{entered=resolve;});
  x.state.onObserve=async()=>{if(x.state.observations===1){entered();await held;}};
  const first=x.step(run);await ready;assert.equal((await x.step(run)).dispatch_blocked,'WINDOWS_EXECUTOR_BUSY_OR_UNRECONCILED');release();await first;assert.equal(x.actions.length,1);
});
test('runtime contract Windows observations reject credentials, arbitrary trees, duplicate IDs and stale captures',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.onObserve=obs=>{obs.captured_at_ms=Date.now()-16000;};assert.equal((await x.step(run)).reason,'WINDOWS_OBSERVATION_STALE');assert.equal(x.actions.length,0);
  const obs={capture_id:'c',window_ref:'w',application:'kakaotalk',captured_at_ms:Date.now(),screen:'workspace',recipient:'unknown',recipient_evidence:[],controls:[],facts:[]};
  assert.throws(()=>desktopObservationSchema.parse({...obs,raw_tree:'private'}));
  const control={id:'t',role:'button',label:'same',visible:true,enabled:true,sensitive:false};assert.throws(()=>desktopObservationSchema.parse({...obs,controls:[control,control]}));
  const profile=windowsWorkflow('windows.kakao.self-note');assert.throws(()=>compileWindowsDecision(profile,profile.steps[0],{...obs,controls:[{...control,label:['sk','proj','abcdefghijklmnopqrstuvwx'].join('-')}]}),/CREDENTIAL/);
});
test('runtime contract Windows request sends only bounded UI labels to Jev, not message bodies or private evidence',async t=>{
  const x=await setup(t);let {run}=await x.start();for(let i=0;i<3;i++)run=await x.step(run);
  const payload=JSON.stringify(x.jevCalls);assert.equal(payload.includes('fixture message'),false);assert.equal(payload.includes('binding_sha256'),false);assert.equal(payload.includes('recipient_evidence'),false);
});

test('runtime contract Windows target selection receives explicit task intent without the replacement content',async t=>{
  const x=await setup(t),{run}=await x.start('windows.form.draft');await x.step(run);
  assert.deepEqual(x.jevCalls[0].state.intent,{field:'fixture field'});
  assert.equal(JSON.stringify(x.jevCalls[0]).includes('fixture value'),false);
  const profile=windowsWorkflow('windows.file.find-open'),observation={capture_id:'c',window_ref:'w',application:'explorer',captured_at_ms:Date.now(),screen:'workspace',recipient:'unknown',recipient_evidence:[],controls:[],facts:[]};
  assert.throws(()=>compileWindowsDecision(profile,profile.steps[1],observation),/INTENT_REQUIRED/);
  assert.equal(compileWindowsDecision(profile,profile.steps[1],observation,{query:'견적서.pdf'}).state.intent.query,'견적서.pdf');
});

test('runtime contract Windows LLM blocked state cannot authorize a selected target',async()=>{
  const profile=windowsWorkflow('windows.kakao.self-note'),observation={capture_id:'c',window_ref:'w',application:'kakaotalk',captured_at_ms:Date.now(),screen:'workspace',recipient:'unknown',recipient_evidence:[],controls:[{id:'p',label:'내 프로필',role:'button',visible:true,enabled:true,sensitive:false}],facts:[]};
  const result=await decideWindowsTarget(profile,profile.steps[0],observation,'blocked-llm',undefined,{calls:[],async call(){return {state:'blocked',target:'c0',evidence_quote:'내 프로필'};}});
  assert.equal(result.target_id,null);assert.equal(result.input_tokens,'unobserved');
});

test('runtime contract Windows shutdown drains an in-flight observation before closing SQLite',async t=>{
  const x=await setup(t),{run}=await x.start();let release,entered;
  const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  x.state.onObserve=async()=>{entered();await held;};const pending=x.step(run);await ready;
  x.api.close();release();const result=await pending;await x.api.drain();
  assert.equal(result.reason,'WINDOWS_RUNTIME_CLOSED');assert.equal(x.actions.length,0);
});

const reconcile=(x,run)=>x.api.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:run.revision});
const recoveryProof=async(x,job,command)=>({action_id:command.action_id,binding_sha256:command.binding_sha256,quiescent:true,outcome:'performed',evidence_ref:'fixture-host-fenced-action',observation:await x.transport.observe(job)});

test('runtime contract Windows reconciles a lost receipt after restart without repeating the action, including while paused',async t=>{
  const x=await setup(t),{run,work}=await x.start();x.state.dropReceipt=true;const uncertain=await x.step(run);
  x.transport.reconcile=(job,command)=>recoveryProof(x,job,command);
  x.api.store.desktopState.prepare('UPDATE office_intake SET paused=1 WHERE work_id=?').run(work.id);
  const store=new PackStore(x.config.dbPath),runner=new WindowsWorkflowRuntime(store,x.config,{driver:x.transport});
  try{
    const recovered=await runner.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:uncertain.revision});
    assert.equal(recovered.status,'ready');assert.equal(recovered.completed_steps,1);assert.equal(x.actions.length,1);
    assert.equal(recovered.recovery_receipts[0].outcome,'performed');assert.equal(recovered.receipts[0].action_id,x.actions[0].action_id);
    assert.equal(store.desktopState.prepare('SELECT count(*) AS n FROM windows_workflow_lock').get().n,0);
    const stored=JSON.parse(store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE id=?').get(run.run_id).body);assert.equal(stored.pending_command,null);
    await assert.rejects(runner.call('runtime_windows_step',{run_id:run.run_id,expected_revision:recovered.revision}),/WORK_PAUSED/);
  }finally{await runner.drain();store.close();}
});

test('runtime contract Windows verified non-dispatch releases the lock but still requires a new approved action',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.onAct=()=>{throw Error('FIXTURE_BEFORE_INPUT');};const uncertain=await x.step(run);
  x.transport.reconcile=async(_job,command)=>({action_id:command.action_id,binding_sha256:command.binding_sha256,quiescent:true,outcome:'not_performed',evidence_ref:'fixture-host-never-dispatched'});
  const recovered=await reconcile(x,uncertain);assert.equal(recovered.status,'ready');assert.equal(recovered.completed_steps,0);assert.equal(recovered.reason,'HOST_VERIFIED_NOT_PERFORMED');
  x.state.onAct=null;x.state.approval=false;const held=await x.step(recovered);assert.equal(held.status,'waiting_approval');assert.equal(x.actions.length,1);
});

for(const fault of ['unknown','still_running','wrong_action','wrong_binding','wrong_window','wrong_capture','old_capture','wrong_fact'])test(`runtime contract Windows ${fault} recovery proof cannot unlock or advance a run`,async t=>{
  const x=await setup(t),{run}=await x.start();x.state.dropReceipt=true;const uncertain=await x.step(run);
  x.transport.reconcile=async(job,command)=>{
    const proof=await recoveryProof(x,job,command);
    if(fault==='unknown')proof.outcome='unknown';if(fault==='still_running')proof.quiescent=false;
    if(fault==='wrong_action')proof.action_id='wrong';if(fault==='wrong_binding')proof.binding_sha256='wrong';
    if(fault==='wrong_window')proof.observation.window_ref='different';if(fault==='wrong_capture')proof.observation.capture_id=command.capture_id;
    if(fault==='old_capture')proof.observation.captured_at_ms-=16000;if(fault==='wrong_fact')proof.observation.facts=proof.observation.facts.map(fact=>({...fact,action_id:'wrong'}));
    return proof;
  };
  const result=await reconcile(x,uncertain);assert.equal(result.status,'reconciliation_required');assert.equal(result.completed_steps,0);assert.equal(result.revision,uncertain.revision);assert.ok(result.reconciliation_blocked);
  assert.equal(x.api.store.desktopState.prepare('SELECT count(*) AS n FROM windows_workflow_lock').get().n,1);assert.equal(x.actions.length,1);
});

test('runtime contract Windows missing recovery adapter or legacy command never silently clears a lock',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.dropReceipt=true;const uncertain=await x.step(run);
  assert.equal((await reconcile(x,uncertain)).reconciliation_blocked,'WINDOWS_HOST_RECONCILIATION_UNAVAILABLE');
  x.transport.reconcile=(job,command)=>recoveryProof(x,job,command);
  const row=JSON.parse(x.api.store.desktopState.prepare('SELECT body FROM windows_workflow_run WHERE id=?').get(run.run_id).body);delete row.pending_command;
  x.api.store.desktopState.prepare('UPDATE windows_workflow_run SET body=? WHERE id=?').run(JSON.stringify(row),run.run_id);
  assert.equal((await reconcile(x,uncertain)).reconciliation_blocked,'WINDOWS_HOST_RECONCILIATION_UNAVAILABLE');
  await assert.rejects(x.api.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:uncertain.revision,approved:true}));
});

test('runtime contract Windows concurrent recovery inspections advance one step exactly once',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.dropReceipt=true;const uncertain=await x.step(run);
  let release;const held=new Promise(resolve=>{release=resolve;});let count=0,entered;const ready=new Promise(resolve=>{entered=resolve;});
  x.transport.reconcile=async(job,command)=>{if(++count===2)entered();await held;return recoveryProof(x,job,command);};
  const first=reconcile(x,uncertain),second=reconcile(x,uncertain);await ready;release();
  const values=await Promise.all([first,second]);assert.ok(values.every(value=>value.completed_steps===1));
  const current=await x.api.call('runtime_windows_status',{run_id:run.run_id});assert.equal(current.receipts.length,1);assert.equal(current.recovery_receipts.length,1);assert.equal(x.actions.length,1);
});

test('runtime contract Windows an active dispatch cannot be reconciled while its effect is still in flight',async t=>{
  const x=await setup(t),{run}=await x.start();let release,entered;const held=new Promise(resolve=>{release=resolve;}),ready=new Promise(resolve=>{entered=resolve;});
  x.state.onAct=async()=>{entered();await held;};let inspected=0;x.transport.reconcile=async(job,command)=>{inspected++;return recoveryProof(x,job,command);};
  const pending=x.step(run);await ready;
  try{const executing=await x.api.call('runtime_windows_status',{run_id:run.run_id});assert.equal((await reconcile(x,executing)).reconciliation_blocked,'WINDOWS_ACTION_IN_FLIGHT');assert.equal(inspected,0);}finally{release();await pending;}
});

test('runtime contract Windows self-chat recovery rejects an observation from another recipient',async t=>{
  const x=await setup(t);let {run}=await x.start();for(let i=0;i<3;i++)run=await x.step(run);
  x.state.dropReceipt=true;run=await x.step(run);x.state.recipient='other';x.transport.reconcile=(job,command)=>recoveryProof(x,job,command);
  const result=await reconcile(x,run);assert.equal(result.status,'reconciliation_required');assert.equal(result.reconciliation_blocked,'WINDOWS_RECONCILIATION_RECIPIENT_UNVERIFIED');assert.equal(x.actions.length,4);
});
