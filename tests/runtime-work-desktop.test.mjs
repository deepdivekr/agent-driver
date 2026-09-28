import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {CuaDesktopDriver} from '../dist/desktop/cua-desktop-driver.js';
import {compileDesktopProcedure} from '../dist/desktop/work-procedure.js';
import {WORK_DEFINITION_INSTRUCTIONS} from '../dist/work/runtime.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {desktopProcedureProposalSchema} from '../dist/desktop/work-procedure.js';
import {z} from 'zod';

const settings={mode:'subscription',client:'auto',client_models:{codex:null,claude:null,opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'fixture-model',api_base_url:'',reasoning:'low',jev:'off'};
const spec={title:'Write an authorized draft',desired_outcome:'Fill the requested field without submitting',completion_checks:[{id:'draft',result:'Exact value',evidence:'independent readback'}],
  route:{kind:'pack',pack_family:'form.draft-submit'},requested_effect:'draft_only',assumptions:[],recurrence:{kind:'once',rule:null},questions:[]};
const procedure=(label='Memo')=>({title:'Work-generated procedure',boundary:'Draft only in the authorized window',completion:'Exact independent readback',inputs:[{id:'value',value:'A useful draft'}],
  steps:[{id:'write',goal:'Fill the requested '+label+' field',action:'replace_text',input:'value',effect:'local_draft',
    desktop:{window_ref:'window-1',target:{label,role:'edit'},before:[],after:[{kind:'field_equals',label,role:'edit',input:'value'}]}}]});
async function setup(t,{app='UnlistedClient.exe',label='Memo',jev=false,approval=true}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-work-desktop-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'desktop-work',caller_ref:'agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}}));
  const config=loadHostConfig(path),calls=[],actions=[],state={value:'',label,index:0,snapshot:0,reads:0,drop:false,truncated:false,changeOnInput:false,extra:[],plan:procedure(label),onModel:null};
  const llm={calls:[],async call(purpose,instructions,input){calls.push({purpose,instructions,input});await state.onModel?.(purpose,input);
    if(input.capabilities)return structuredClone(state.plan);
    if(purpose==='design'||purpose==='repair')return {ready_when:'Requested field is visible',target_when:'Match the requested exact label',reobserve_when:'Field is absent or changed'};
    return {state:'ready',target:'c0',evidence_quote:input.candidates.c0.label};
  }};
  const api=new RuntimeApi(config,{swarmModel:llm});t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const work=api.store.beginWork(config.project.id,'first','Fill the requested field without submitting','quick').work;
  api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify(spec),work.id);
  saveModelSettings(modelSettingsPath(config),{revision:0,onboarding_step:2,selection:{...settings,jev:jev?'on':'off'}},{TYPESAFE_API_KEY:'fixture-not-live'});
  const cfg={kind:'cua-desktop',executable:'fixture.exe',executable_sha256:'a'.repeat(64),version:'0.30.2',manifest:'fixture.yaml',manifest_sha256:'b'.repeat(64),manifest_reviewed:true,
    grants:[{grant_id:'session',work_id:work.id,expires_at_ms:Date.now()+60_000,effects:['navigate','local_draft','external_send'],windows:[{ref:'window-1',pid:42,window_id:7,app_name:app,title:'Authorized workspace',value_encoding:'exact'}]}]};
  const port={connected:()=>true,async close(){},async call(name,args){
    if(name==='get_window_state'){state.reads++;const snap='s'+(++state.snapshot).toString(16).padStart(8,'0');
      return {pid:42,window_id:7,app_name:app,window_title:'Authorized workspace',snapshot_id:snap,truncated:state.truncated,window_bounds:{x:0,y:0,width:800,height:600},
        elements:[{element_index:state.index,element_token:snap+':'+state.index,role:'Edit',label:state.label,value:state.value,enabled:true,actions:['set_value'],frame:{x:10,y:20,w:100,h:40}},...state.extra.map((row,i)=>({element_index:10+i,element_token:snap+':'+(10+i),role:'Button',label:'Action',value:'',enabled:true,actions:['click'],frame:{x:10,y:80,w:100,h:40},...row}))]};
    }
    actions.push({name,args});if(name==='set_value')state.value=args.value;if(state.drop)throw Error('LOST_RESPONSE');return {success:true};
  }};
  const driver=new CuaDesktopDriver(cfg,api.store.desktopState,port,async()=>approval);api.windows.options.driver=driver;
  const jevCalls=[];api.windows.options.jev={async systemOne(request){jevCalls.push(request);return {model:'fixture-not-live',usage:{input_tokens:20,output_tokens:5},
    answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{const choice=key==='state'?'ready':'c0';return [key,{type:'choice',choice,confidence:.99,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];}))};}};
  const design=(refresh=false)=>api.call('runtime_windows_design',{work_id:work.id,refresh});
  const start=async(request='first')=>{const plan=await design();const run=await api.call('runtime_windows_start',{...plan.start_arguments,request_id:request});return {plan,run};};
  const step=run=>api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});
  return {api,config,root,work,state,calls,actions,driver,port,cfg,jevCalls,design,start,step};
}

test('runtime contract Work instructions do not convert an example self-chat into a product recipient restriction',()=>{
  assert.doesNotMatch(WORK_DEFINITION_INSTRUCTIONS,/supports only.*self-chat|self-chat, not other recipients/u);
  assert.match(WORK_DEFINITION_INSTRUCTIONS,/optional examples/u);assert.match(WORK_DEFINITION_INSTRUCTIONS,/runtime_windows_design/u);
  assert.match(WORK_DEFINITION_INSTRUCTIONS,/Classify a supported outcome independently of connection readiness/u);
  assert.match(WORK_DEFINITION_INSTRUCTIONS,/opening and restoring a view, tab or disclosure checkbox/u);
  assert.match(WORK_DEFINITION_INSTRUCTIONS,/Persistent settings, security choices and data-changing controls require their actual effect boundary/u);
});
for(const app of ['BrandNewNotes.exe','UnknownCRM.exe','KakaoTalk.exe'])test('runtime contract generated Work runs without a handwritten adapter: '+app,async t=>{
  const x=await setup(t,{app});const {plan,run}=await x.start();assert.equal(plan.procedure_reused,false);assert.equal(plan.workflow.self_only,false);
  const done=await x.step(run);assert.equal(done.status,'completed',JSON.stringify(done));assert.equal(x.state.value,'A useful draft');
  assert.equal(x.actions.length,1);assert.equal(x.actions[0].name,'set_value');assert.equal(done.receipts[0].decision.decider,'code');
  assert.equal(x.calls.length,1);assert.equal(x.driver.counters.planned_exact_hits,1);
  assert.equal((await x.api.call('runtime_work_status',{work_id:x.work.id})).windows_runs[0].status,'completed');
  assert.equal((await x.api.call('runtime_windows_catalog',{})).profiles_required,false);
  assert.equal(done.work_completion_verified,false);
});
test('runtime contract verified repeat reuses the plan and exact target without another LLM or Jev call',async t=>{
  const x=await setup(t),first=await x.start();assert.equal((await x.step(first.run)).status,'completed');
  const count=x.calls.length;x.state.value='';x.state.index=4; // Live tokens/indices are not a stored procedure.
  const repeated=await x.start('second');assert.equal(repeated.plan.procedure_reused,true);
  const done=await x.step(repeated.run);assert.equal(done.status,'completed');assert.equal(done.receipts[0].decision.decider,'code');
  assert.equal(x.calls.length,count);assert.equal(x.jevCalls.length,0);assert.equal(x.driver.counters.verified_target_hits,1);
  assert.equal(x.driver.diagnostics().retained_observations,0);assert.equal(x.driver.diagnostics().pending_approvals,0);
});

test('runtime contract abandoned desktop captures do not retain an unbounded per-Work history',async t=>{
  const x=await setup(t),{plan,run}=await x.start();
  for(let i=0;i<40;i++)await x.driver.observe({run_id:'abandoned-'+i,work_id:x.work.id,binding_sha256:'a'.repeat(64),workflow:plan.workflow,step_id:'write',inputs:{value:'A useful draft'}});
  assert.equal(x.driver.diagnostics().retained_observations,32);assert.equal(x.driver.diagnostics().pending_approvals,0);
  assert.equal((await x.step(run)).status,'completed');assert.ok(x.driver.diagnostics().retained_observations<=31);
});
test('runtime contract optional Pack Jev selects first-run targets and retains observed probabilities',async t=>{
  const x=await setup(t,{jev:true}),{run}=await x.start();x.driver.selectExactTarget=async()=>null;const done=await x.step(run);
  assert.equal(done.status,'completed');assert.equal(done.receipts[0].decision.decider,'jev');assert.equal(x.jevCalls.length,1);
  assert.equal(done.receipts[0].decision.confidence,.99);assert.equal(done.receipts[0].decision.selected_probability,1);
  assert.ok(!JSON.stringify(x.jevCalls).includes('A useful draft'));
});
test('runtime contract planning is not learning: an unexecuted plan is not reused',async t=>{
  const x=await setup(t);await x.design();await x.design();assert.equal(x.calls.filter(c=>c.input.capabilities).length,2);assert.equal(x.actions.length,0);
});
test('runtime contract target change requires replan; observed app needs no new adapter',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.label='New memo';
  const stale=await x.step(run);assert.equal(stale.status,'needs_review');assert.equal(x.actions.length,0);
  x.state.plan=procedure('New memo');const replanned=await x.design(true);
  assert.notEqual(replanned.workflow.id,run.workflow_id);
  const next=await x.api.call('runtime_windows_start',{...replanned.start_arguments,request_id:'replan'});
  assert.equal((await x.step(next)).status,'completed');
});
test('runtime contract uncertain effects block plan promotion and replanning; no duplicate input',async t=>{
  const x=await setup(t),{run}=await x.start();x.state.drop=true;
  const failed=await x.step(run);assert.equal(failed.status,'reconciliation_required');assert.equal(x.actions.length,1);
  await assert.rejects(x.design(true),/RECONCILIATION_REQUIRED/);
  assert.equal((await x.step(failed)).status,'reconciliation_required');assert.equal(x.actions.length,1);
  assert.equal((await x.api.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:failed.revision})).reconciliation_blocked,'WINDOWS_EFFECT_STILL_UNCERTAIN');
});
test('runtime contract pause or revision change during LLM planning persists no executable plan',async t=>{
  const x=await setup(t);x.state.onModel=async()=>{const work=x.api.store.intakeWork(x.config.project.id,x.work.id);x.api.store.setIntakePaused(x.config.project.id,work.id,work.revision,true);};
  await assert.rejects(x.design(),/WORK_PAUSED/);
  assert.equal(x.api.store.desktopState.prepare('SELECT count(*) AS n FROM windows_work_procedure').get().n,0);
});
test('runtime contract concurrent design joins one model call',async t=>{
  const x=await setup(t);const [a,b]=await Promise.all([x.design(),x.design()]);assert.equal(a.workflow.id,b.workflow.id);assert.equal(x.calls.length,1);
});
test('runtime contract inputs and Work identity are frozen after design',async t=>{
  const x=await setup(t),plan=await x.design();
  await assert.rejects(x.api.call('runtime_windows_start',{...plan.start_arguments,inputs:{value:'different'}}),/PROCEDURE_INPUT_CHANGED/);
  x.api.store.desktopState.prepare('UPDATE office_intake SET revision=2 WHERE work_id=?').run(x.work.id);
  await assert.rejects(x.api.call('runtime_windows_start',plan.start_arguments),/PROCEDURE_WORK_CHANGED/);
});
test('runtime contract draft-only Work cannot become a send; old message is not send evidence',async t=>{
  const x=await setup(t);const snap=await x.driver.planningSnapshot(x.work.id),p=procedure();
  p.steps[0].effect='external_send';assert.throws(()=>compileDesktopProcedure(p,spec,snap),/OUT_OF_SCOPE/);
  p.steps[0]={...p.steps[0],action:'invoke',input:null,desktop:{window_ref:'window-1',target:{label:'Send',role:'button'},before:[],after:[{kind:'control_present',label:'Old message',role:'document'}]}};
  assert.throws(()=>compileDesktopProcedure(p,{...spec,requested_effect:'external_effect_requested'},snap),/NEW_EFFECT_EVIDENCE_REQUIRED/);
});
test('runtime contract no current target, truncated tree and expired scope are not executor success',async t=>{
  const x=await setup(t);x.state.plan=procedure('Unobserved');await assert.rejects(x.design(),/INITIAL_TARGET_UNOBSERVED/);
  x.state.truncated=true;const missing=await x.design();assert.equal(missing.status,'waiting_observation');assert.equal(missing.reason,'CUA_VISUAL_CAPTURE_UNAVAILABLE');x.state.truncated=false;
  x.driver.config.grants[0].expires_at_ms=1;await assert.rejects(x.design(),/WORK_SCOPE_REQUIRED/);assert.equal(x.actions.length,0);
});
test('runtime contract existing self-chat example still cannot redirect its recipient',async t=>{
  const x=await setup(t);assert.equal((await x.api.call('runtime_windows_plan',{workflow_id:'windows.kakao.self-note'})).workflow.self_only,true);
  assert.equal((await x.api.call('runtime_windows_catalog',{})).profile_count,10);
});
test('runtime contract generated procedure schema is strict-provider compatible',()=>{
  const visit=node=>{if(!node||typeof node!=='object')return;
    assert.ok(!node.oneOf,'Use supported anyOf alternatives');
    if(node.type==='object'){assert.equal(node.additionalProperties,false);assert.deepEqual([...node.required].sort(),Object.keys(node.properties).sort());}
    for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);
  };visit(z.toJSONSchema(desktopProcedureProposalSchema));
});
test('runtime contract effect confirmation cannot be supplied by a generated procedure or model',async t=>{
  const x=await setup(t,{approval:false});x.state.extra=[{label:'Send'}];
  const newSpec={...spec,requested_effect:'external_effect_requested'};
  x.api.store.desktopState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify(newSpec),x.work.id);
  x.state.plan.steps=[{id:'send',goal:'Send once to the user-requested target',action:'invoke',input:null,effect:'external_send',
    desktop:{window_ref:'window-1',target:{label:'Send',role:'button'},before:[],after:[{kind:'label_count_increased',label:'New message',role:'document'}]}}];
  const {run}=await x.start();const waiting=await x.step(run);assert.equal(waiting.status,'waiting_approval');assert.equal(x.actions.length,0);
});
test('runtime contract changed state between model choice and execution produces no input',async t=>{
  const x=await setup(t),{run}=await x.start();
  x.driver.selectExactTarget=async()=>null;
  x.state.onModel=async(purpose)=>{if(purpose==='correct')x.state.value='human edit';};
  const result=await x.step(run);assert.equal(result.status,'needs_review');assert.equal(result.next_action,'runtime_windows_design');assert.equal(x.actions.length,0);
});
test('runtime contract closed or corrupt persisted procedure cannot gain execution authority',async t=>{
  const x=await setup(t),plan=await x.design();
  const db=x.api.store.desktopState,row=db.prepare('SELECT body FROM windows_work_procedure WHERE id=?').get(plan.workflow.id),body=JSON.parse(row.body);
  body.workflow.steps[0].effect='external_send';
  db.prepare('UPDATE windows_work_procedure SET body=? WHERE id=?').run(JSON.stringify(body),plan.workflow.id);
  await assert.rejects(x.api.call('runtime_windows_start',plan.start_arguments),/PROCEDURE_CORRUPT/);
  assert.equal(x.actions.length,0);
});
test('runtime contract state changed after success does not reuse the old plan',async t=>{
  const x=await setup(t),first=await x.start();await x.step(first.run);
  x.state.label='Renamed';x.state.plan=procedure('Renamed');
  const next=await x.design();assert.equal(next.procedure_reused,false);assert.notEqual(next.workflow.id,first.plan.workflow.id);
  assert.notEqual(next.start_arguments.request_id,first.plan.start_arguments.request_id);
});
