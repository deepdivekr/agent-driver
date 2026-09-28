import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir,hostname} from 'node:os';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {CuaDesktopDriver} from '../dist/desktop/cua-desktop-driver.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {compileDesktopProcedure} from '../dist/desktop/work-procedure.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {sameDesktopLabel} from '../dist/desktop/windows-decision.js';
import {OwnedCuaConnection} from '../dist/desktop/cua-connection.js';

async function fixture(t,{jev=false,mixed=false,checkbox=false}={}){
  const root=await mkdtemp(join(tmpdir(),'office-visual-contract-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'visual-test',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}}));
  const config=loadHostConfig(path),state={phase:0,x:40,degraded:false,width:800,truncated:false,duplicate:false,boundsInvalid:false,overlay:false,sensitive:false,ocrDown:false,drop:false,noop:false,chrome:false,shot:0,uia:0,modelHook:null,confirmHook:null},calls=[],actions=[],modelCalls=[],jevCalls=[];
  const plan={title:'Navigate a canvas',boundary:'Read-only navigation in the authorized window',completion:'Details ready label independently observed',inputs:[],steps:[{id:'open',goal:'Open the requested details view',action:'invoke',input:null,effect:'navigate',desktop:{window_ref:'window',target:{label:'Open details',role:'visual'},before:[{kind:'control_present',label:'Open details',role:'visual'}],after:[{kind:'control_present',label:'Details ready',role:'visual'}]}}]};
  if(checkbox){state.selected=false;plan.steps[0].desktop={window_ref:'window',target:{label:'Open details',role:'checkbox'},before:[{kind:'control_selected',label:'Open details',role:'checkbox',selected:false}],after:[{kind:'control_selected',label:'Open details',role:'checkbox',selected:true}]};}
  const llm={calls:[],async call(purpose,instructions,input){modelCalls.push({purpose,input});await state.modelHook?.(purpose,input);if(input.capabilities)return structuredClone(plan);if(purpose==='design'||purpose==='repair')return {ready_when:'The requested navigation label is present',target_when:'Choose Open details',reobserve_when:'Missing or ambiguous label'};const [key,row]=Object.entries(input.candidates).find(([,v])=>v.label==='Open details')??['unknown',{}];return {state:'ready',target:key,evidence_quote:row.label??''};}};
  const api=new RuntimeApi(config,{swarmModel:llm});t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const work=api.store.beginWork(config.project.id,'first','Open the details view without changing data','quick').work;
  const spec={title:'Open details',desired_outcome:'Show requested details without changing data',completion_checks:[{id:'open',result:'Details view',evidence:'Current label'}],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',assumptions:[],recurrence:{kind:'once',rule:null},questions:[]};
  api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify(spec),work.id);
  saveModelSettings(modelSettingsPath(config),{revision:0,onboarding_step:2,selection:{mode:'subscription',client:'auto',client_models:{codex:null,claude:null,opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'fixture',api_base_url:'',reasoning:'low',jev:jev?'on':'off'}},{TYPESAFE_API_KEY:'fixture'});
  const cfg={kind:'cua-desktop',executable:'fixture.exe',executable_sha256:'a'.repeat(64),version:'0.30.2',manifest:'fixture.yaml',manifest_sha256:'b'.repeat(64),manifest_reviewed:true,grants:[{grant_id:'test',work_id:work.id,expires_at_ms:Date.now()+60000,effects:['navigate','local_draft','external_send'],windows:[{ref:'window',pid:42,window_id:7,app_name:'ArbitraryCanvas.exe',title:'Owned canvas',value_encoding:'exact'}]}]};
  let image=null;
  const port={connected:()=>true,async close(){},takeScreenshot(){const result=image;image=null;return result;},async call(name,args){calls.push({name,args});
    if(name==='list_windows'){
      await state.onList?.();
      return {windows:state.missingWindow?[]:[{pid:42,window_id:state.listWindowId??7,app_name:'ArbitraryCanvas.exe',title:state.listTitle??'Owned canvas',minimized:state.minimized??Boolean(state.captureFailure),is_on_screen:state.minimized===false||!state.captureFailure,...(state.responding===undefined?{}:{responding:state.responding})}]};
    }
    if(name==='bring_to_front'){
      state.restores=(state.restores??0)+1;await state.onRestore?.();
      if(state.restoreDrop)throw Error('PRIVATE_NATIVE_RESTORE_REPLY_LOST');
      if(!state.restoreNoop)state.captureFailure=null;
      return {previous_fg_hwnd:123,now_fg_hwnd:7};
    }
    if(name==='get_window_state'){
      const id='s'+(++state.uia).toString(16).padStart(8,'0');
      const result={pid:42,window_id:7,app_name:'ArbitraryCanvas.exe',window_title:'Owned canvas',snapshot_id:id,truncated:state.truncated,window_bounds:{x:80,y:90,width:state.width,height:600},elements:mixed?[{element_index:0,element_token:id+':0',role:'Edit',label:'Filter',value:'',enabled:true,actions:['set_value'],frame:{x:90,y:100,w:100,h:30}}]:[]};
      if(checkbox)result.elements.push({element_index:2,element_token:id+':2',role:'CheckBox',label:'Open details',selected:state.selected,enabled:true,actions:['invoke','toggle'],frame:{x:90,y:120,w:160,h:30}});
      if(state.chrome)result.elements.push({element_index:20,element_token:id+':20',role:'TitleBar',label:'Owned canvas',enabled:true,actions:[],frame:{x:80,y:90,w:800,h:30}},{element_index:21,element_token:id+':21',parent_index:20,role:'Button',label:'Close',enabled:true,actions:['invoke'],frame:{x:850,y:90,w:30,h:30}});
      if(args.include_screenshot){state.shot++;await state.onCapture?.();
        if(state.captureFailure&&(!state.failAfterAction||actions.length)){image=null;return {...result,screenshot_error:state.captureFailure};}
        if(state.missingCapture){image=null;return result;}
        image=Buffer.from('fixture image');Object.assign(result,{capture_id:'capture-'+state.shot,screenshot_width:state.width,screenshot_height:600,screenshot_frame_valid:!state.degraded,degraded:state.degraded});}return result;
    }
    actions.push({name,args});if(!state.noop){state.phase=1;if(checkbox)state.selected=!state.selected;}if(state.drop)throw Error('LOST_RESPONSE');return {effect:'unverifiable',route:'synthetic_events'};
  }};
  let lastHash=null;
  const visual={async close(){},async read(frame){if(state.ocrDown)throw Error('WINDOWS_OCR_UNAVAILABLE');const hash=snapshotHash({phase:state.phase,x:state.x,overlay:state.overlay,width:state.width,sensitive:state.sensitive});const regions=[{text:state.phase?'Details ready':'Open details',bounds:{x:state.boundsInvalid?9999:state.x,y:100,width:120,height:22}},...(state.duplicate?[{text:'Open details',bounds:{x:40,y:300,width:120,height:22}}]:[]),...(state.overlay?[{text:'Unexpected modal',bounds:{x:200,y:200,width:140,height:24}}]:[]),...(state.sensitive?[{text:'Password',bounds:{x:20,y:20,width:80,height:20}}]:[])];const mode=hash===lastHash?'unchanged':'full';lastHash=hash;return {regions,frame_sha256:hash,mode,elapsed_ms:2,processed_pixels:mode==='unchanged'?0:480000,source:'windows_ocr',confidence:null};}};
  const driver=new CuaDesktopDriver(cfg,api.store.desktopState,port,async()=>{await state.confirmHook?.();return true;},visual);api.windows.options.driver=driver;
  api.windows.options.jev={async systemOne(request){jevCalls.push(request);return {model:'fixture',usage:{input_tokens:18,output_tokens:4},answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{const choice=key==='state'?'ready':'c0';return [key,{type:'choice',choice,confidence:.99,probabilities:Object.fromEntries(Object.keys(q.criteria).map(k=>[k,k===choice?1:0]))}];}))};}};
  const design=(options={})=>api.call('runtime_windows_design',{work_id:work.id,...options});
  const start=async(id='first',options={})=>{const planned=await design(options);const run=await api.call('runtime_windows_start',{...planned.start_arguments,request_id:id});return {planned,run};};
  const step=run=>api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});
  return {api,driver,cfg,config,work,spec,state,plan,calls,actions,modelCalls,jevCalls,design,start,step};
}

test('runtime contract no UIA automatically uses local visual candidates and independently confirms navigation',async t=>{
  const x=await fixture(t),{planned,run}=await x.start(),done=await x.step(run);assert.equal(done.status,'completed',JSON.stringify(done));
  const controls=x.modelCalls[0].input.capabilities.windows[0].controls;assert.equal(controls[0].role,'visual');assert.equal(controls[0].enabled,null);assert.equal(controls[0].confidence,null);assert.equal(controls[0].source,'windows_ocr');
  assert.equal(x.actions.length,1);assert.equal(x.actions[0].name,'click');assert.equal(x.actions[0].args.scope,'window');assert.equal(x.actions[0].args.delivery_mode,'background');assert.equal(x.actions[0].args.x,100);
  const captures=x.calls.filter(c=>c.args.include_screenshot);assert.equal(x.actions[0].args.capture_id,'capture-'+(captures.length-1));
  assert.ok(x.driver.counters.visual_reused_reads>0);assert.equal(x.driver.diagnostics().retained_observations,0);assert.equal(done.receipts[0].decision.decider,'llm');
  assert.equal(planned.execution_authority,false);assert.equal(done.work_completion_verified,false);
});
test('runtime contract mixed UIA screen remains screenshot-free until a visual gap is requested',async t=>{
  const x=await fixture(t,{mixed:true});const snapshot=await x.driver.planningSnapshot(x.work.id);assert.equal(snapshot.windows[0].controls[0].source,'uia');assert.equal(x.state.shot,0);
  const {run}=await x.start('mixed',{observation:'visual'});assert.equal((await x.step(run)).status,'completed');assert.ok(x.state.shot>0);
});
test('runtime contract titlebar buttons are not evidence of accessible application content',async t=>{
  const x=await fixture(t);x.state.chrome=true;const snapshot=await x.driver.planningSnapshot(x.work.id);assert.ok(x.state.shot>0);assert.deepEqual(snapshot.windows[0].controls.map(c=>c.label),['Open details']);const {run}=await x.start();assert.equal((await x.step(run)).status,'completed');
});
test('runtime contract Pack Jev receives bounded OCR evidence, not screenshots or invented confidence',async t=>{
  const x=await fixture(t,{jev:true}),{run}=await x.start();const done=await x.step(run);assert.equal(done.status,'completed');assert.equal(done.receipts[0].decision.decider,'jev');assert.equal(done.receipts[0].decision.confidence,.99);
  assert.equal(x.jevCalls.length,1);const candidate=x.jevCalls[0].state.candidates.c0;assert.equal(candidate.confidence,null);assert.equal(candidate.interactivity,'unobserved');assert.equal(candidate.enabled,null);
  assert.doesNotMatch(JSON.stringify(x.jevCalls),/base64|capture-|screenshot_width|"bounds"|"x":/);
});
test('runtime contract independently verified repeat avoids model rediscovery but always captures fresh pixels',async t=>{
  const x=await fixture(t),first=await x.start();assert.equal((await x.step(first.run)).status,'completed');x.state.phase=0;
  const count=x.modelCalls.length,shots=x.state.shot,second=await x.start('second');assert.equal(second.planned.procedure_reused,true);
  const done=await x.step(second.run);assert.equal(done.status,'completed');assert.equal(x.modelCalls.length,count);assert.equal(done.receipts[0].decision.reason,'VERIFIED_CURRENT_VISUAL_STATE');assert.equal(x.actions.length,2);assert.notEqual(x.actions[0].args.capture_id,x.actions[1].args.capture_id);assert.ok(x.state.shot>shots);
});
for(const change of ['position','outside_target_modal'])test('runtime contract visual '+change+' drift is reobserved before any input',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.modelHook=(purpose)=>{if(purpose==='correct'){if(change==='position')x.state.x=250;else x.state.overlay=true;}};
  const result=await x.step(run);assert.equal(result.status,'completed');assert.equal(result.observation_recoveries.length,1);assert.equal(x.actions.length,1);
  assert.equal(x.modelCalls.filter(c=>c.purpose==='correct').length,2);
  if(change==='position')assert.equal(x.actions[0].args.x,310);
});
test('runtime contract changed pixels on verified repeat invalidate exact-target shortcut',async t=>{
  const x=await fixture(t),first=await x.start();await x.step(first.run);x.state.phase=0;x.state.x=260;
  const count=x.modelCalls.length,second=await x.start('moved'),done=await x.step(second.run);assert.equal(done.status,'completed');assert.equal(done.receipts[0].decision.decider,'llm');assert.ok(x.modelCalls.length>count);assert.equal(x.actions[1].args.x,320);
});
test('runtime contract screenshot click returning no changed result never proves navigation',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.noop=true;const result=await x.step(run);assert.equal(result.status,'reconciliation_required');assert.equal(result.reason,'EFFECT_READBACK_UNVERIFIED');assert.equal(x.actions.length,1);await x.step(result);assert.equal(x.actions.length,1);
});
test('runtime contract lost visual click reply preserves uncertainty and cannot replay or promote',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.drop=true;const result=await x.step(run);assert.equal(result.status,'reconciliation_required');await x.step(result);assert.equal(x.actions.length,1);await assert.rejects(x.design({refresh:true}),/RECONCILIATION_REQUIRED/);
  const next=await x.api.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:result.revision});assert.equal(next.reconciliation_blocked,'WINDOWS_EFFECT_STILL_UNCERTAIN');
});
for(const field of ['degraded','boundsInvalid','ocrDown','duplicate'])test('runtime contract bad visual evidence '+field+' never dispatches',async t=>{
  const x=await fixture(t);x.state[field]=true;
  if(field==='degraded')assert.equal((await x.design()).status,'waiting_observation');else await assert.rejects(x.design());assert.equal(x.actions.length,0);
});
test('runtime contract sensitive visual labels block ordinary execution',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.sensitive=true;const result=await x.step(run);assert.equal(result.status,'waiting_auth');assert.equal(x.actions.length,0);
});
test('runtime contract visual observations cannot grant typing, send or write authority',async t=>{
  const x=await fixture(t),snapshot=await x.driver.planningSnapshot(x.work.id);for(const effect of ['local_draft','local_write','external_send']){const plan=structuredClone(x.plan);plan.steps[0].effect=effect;assert.throws(()=>compileDesktopProcedure(plan,{...x.spec,requested_effect:'external_effect_requested'},snapshot),/OUT_OF_SCOPE|VISUAL_NAVIGATION_ONLY/);}
  const plan=structuredClone(x.plan);plan.steps[0].action='replace_text';plan.steps[0].input='body';plan.inputs=[{id:'body',value:'text'}];assert.throws(()=>compileDesktopProcedure(plan,x.spec,snapshot),/OPERATION_INPUT_INVALID/);
});
test('runtime contract expired scope blocks visual capture before OCR',async t=>{
  const x=await fixture(t);x.driver.config.grants[0].expires_at_ms=1;await assert.rejects(x.design(),/WORK_SCOPE_REQUIRED/);assert.equal(x.state.shot,0);
});
test('runtime unit OCR matching normalizes case/width/spacing, not fuzzy targets or UIA values',()=>{
  assert.equal(sameDesktopLabel({label:'Return tO  workspace',role:'visual'},{label:'return to workspace',role:'visual'}),true);
  assert.equal(sameDesktopLabel({label:'Ｏpen details',role:'visual'},{label:'Open details',role:'visual'}),true);
  assert.equal(sameDesktopLabel({label:'Open detai1s',role:'visual'},{label:'Open details',role:'visual'}),false);
  assert.equal(sameDesktopLabel({label:'Send',role:'button'},{label:'send',role:'button'}),false);
});
test('runtime contract case-only OCR alternatives remain ambiguous, never a hidden target choice',async t=>{
  const x=await fixture(t),snapshot=await x.driver.planningSnapshot(x.work.id);snapshot.windows[0].controls.push({...snapshot.windows[0].controls[0],label:'OPEN DETAILS'});assert.throws(()=>compileDesktopProcedure(x.plan,x.spec,snapshot),/INITIAL_TARGET_UNOBSERVED/);
});
test('runtime contract pause during final visual read refuses before dispatch with durable non-performance',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.onCapture=()=>{if(x.state.shot===5){const work=x.api.store.intakeWork(x.config.project.id,x.work.id);x.api.store.setIntakePaused(x.config.project.id,work.id,work.revision,true);}};
  const result=await x.step(run);assert.equal(result.status,'needs_review');assert.equal(result.reason,'DRIVER_CONFIRMED_NOT_PERFORMED');assert.equal(x.actions.length,0);
  assert.equal(x.api.store.desktopState.prepare('SELECT status FROM cua_desktop_effect').get().status,'not_performed');
});

for(const mixed of [false,true])test('runtime contract minimized '+(mixed?'mixed':'canvas')+' window exposes recoverable observation state without focus or model calls',async t=>{
  const x=await fixture(t,{mixed});x.state.captureFailure='cannot capture minimized window 0xabc: private native detail';
  const result=await x.design(mixed?{observation:'visual'}:{});
  assert.equal(result.status,'waiting_observation');assert.equal(result.reason,'CUA_VISUAL_WINDOW_MINIMIZED');
  assert.equal(result.next_action,'restore_authorized_window_then_retry');assert.equal(result.foreground_changed,'unobserved');
  assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);assert.doesNotMatch(JSON.stringify(result),/private native|0xabc/);
  x.state.captureFailure=null;const {run}=await x.start('restored',mixed?{observation:'visual'}:{});assert.equal((await x.step(run)).status,'completed');
});
test('runtime contract missing screenshot metadata never becomes empty evidence or leaked schema diagnostics',async t=>{
  const x=await fixture(t);x.state.missingCapture=true;const result=await x.design();
  assert.equal(result.status,'waiting_observation');assert.equal(result.reason,'CUA_VISUAL_CAPTURE_UNAVAILABLE');
  assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);
});
test('runtime contract capture lost after an actual click preserves uncertainty and no replay',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.captureFailure='backend capture failure';x.state.failAfterAction=true;
  const result=await x.step(run);assert.equal(result.status,'reconciliation_required');assert.equal(result.reason,'CUA_VISUAL_CAPTURE_UNAVAILABLE');
  await x.step(result);assert.equal(x.actions.length,1);
});
test('runtime contract one pre-input correction repairs only an observed initial target and remains compiler checked',async t=>{
  const x=await fixture(t),original=x.api.windows.options.llm.call.bind(x.api.windows.options.llm);let repairs=0;
  x.api.windows.options.llm.call=async(purpose,...args)=>{
    const value=await original(purpose,...args);
    if(args[1]?.capabilities){if(purpose==='design')value.steps[0].desktop.target.label='Invented control';else repairs++;}
    return value;
  };
  const {run}=await x.start();assert.equal(repairs,1);assert.equal(x.actions.length,0);
  assert.equal((await x.step(run)).status,'completed');
});
test('runtime contract failed correction cannot loop or widen Work authority',async t=>{
  const x=await fixture(t);let calls=0;
  x.api.windows.options.llm.call=async(purpose,instructions,input)=>{
    calls++;const plan=structuredClone(x.plan);
    if(purpose==='design')plan.steps[0].desktop.target.label='Invented control';
    else plan.steps[0].effect='external_send';
    return plan;
  };
  await assert.rejects(x.design(),/OUT_OF_SCOPE/);assert.equal(calls,2);assert.equal(x.actions.length,0);
});
test('runtime contract planner can request observation without a fake executable step',async t=>{
  const x=await fixture(t);x.plan.steps=[];
  const result=await x.design();assert.equal(result.status,'waiting_observation');assert.equal(result.reason,'WINDOWS_PLANNER_NEEDS_OBSERVATION');assert.equal(result.execution_authority,false);
  assert.equal(x.api.store.desktopState.prepare('SELECT COUNT(*) AS n FROM windows_work_procedure').get().n,0);
  assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,1);
});
test('runtime contract invented initial precondition is corrected once or remains unexecutable',async t=>{
  const x=await fixture(t);x.plan.steps[0].desktop.before=[{kind:'control_present',label:'Invented readiness',role:'visual'}];
  await assert.rejects(x.design(),/INITIAL_CONTEXT_UNOBSERVED/);assert.equal(x.modelCalls.length,2);assert.equal(x.actions.length,0);
});
test('runtime contract checkbox uses current positive UIA state and repeated navigation needs no screenshot or model',async t=>{
  const x=await fixture(t,{checkbox:true}),first=await x.start();assert.equal((await x.step(first.run)).status,'completed');assert.equal(x.state.selected,true);assert.equal(x.state.shot,0);
  x.state.selected=false;const count=x.modelCalls.length,second=await x.start('second'),done=await x.step(second.run);
  assert.equal(second.planned.procedure_reused,true);assert.equal(done.status,'completed');assert.equal(done.receipts[0].decision.reason,'VERIFIED_CURRENT_UIA_STATE');assert.equal(x.modelCalls.length,count);
});
test('runtime contract unknown checkbox state is not unchecked and unchanged state cannot prove a toggle',async t=>{
  const x=await fixture(t,{checkbox:true});x.state.selected=undefined;await assert.rejects(x.design(),/INITIAL_CONTEXT_UNOBSERVED/);assert.equal(x.actions.length,0);
  x.state.selected=false;const {run}=await x.start();x.state.noop=true;const result=await x.step(run);
  assert.equal(result.status,'reconciliation_required');await x.step(result);assert.equal(x.actions.length,1);
});

for(const jev of [false,true])test('runtime contract '+(jev?'Jev':'LLM')+' receives actual UIA visibility enabled selection and navigation effect',async t=>{
  const x=await fixture(t,{checkbox:true,jev}),{run}=await x.start();
  assert.equal((await x.step(run)).status,'completed');
  const state=jev?x.jevCalls[0].state:x.modelCalls.find(c=>c.purpose==='correct').input;
  assert.deepEqual(state.candidates.c0,{label:'Open details',role:'checkbox',enabled:true,visible:true,source:'uia',selected:false});
  assert.equal(state.step.effect,'navigate');assert.equal(x.state.shot,0);
});

const minimized='cannot capture minimized window 0xabc: private native detail';
const allowRestore=x=>{x.driver.config.grants[0].windows[0].allow_window_restore=true;};
for(const mixed of [false,true])test('runtime contract allowed minimized '+(mixed?'mixed':'canvas')+' window is restored once and freshly observed',async t=>{
  const x=await fixture(t,{mixed});allowRestore(x);x.state.captureFailure=minimized;
  const result=await x.design(mixed?{observation:'visual'}:{});
  assert.equal(result.status,'planned');assert.equal(x.state.restores,1);assert.equal(x.driver.diagnostics().window_restores,1);assert.equal(x.actions.length,0);
  const restore=x.calls.findIndex(c=>c.name==='bring_to_front');
  assert.deepEqual(x.calls[restore].args,{pid:42,window_id:7});
  assert.ok(x.calls.slice(restore+1).some(c=>c.name==='get_window_state'&&c.args.include_screenshot));
  await x.design(mixed?{observation:'visual'}:{});assert.equal(x.state.restores,1);
});
test('runtime contract a rendered window incurs no restore preflight or foreground call',async t=>{
  const x=await fixture(t);allowRestore(x);await x.design();
  assert.ok(x.calls.every(c=>c.name==='get_window_state'));assert.equal(x.driver.counters.window_restore_attempts,0);
});
test('runtime contract restored-by-user race observes freshly without stealing focus',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;x.state.onList=()=>{x.state.captureFailure=null;};
  assert.equal((await x.design()).status,'planned');assert.equal(x.driver.counters.window_restore_attempts,0);
});
for(const change of ['pause','revision','expired','scope','identity','window_id','model_settings'])test('runtime contract '+change+' during recovery preflight prevents restoration',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;
  x.state.onList=()=>{
    if(change==='pause'){const work=x.api.store.intakeWork(x.config.project.id,x.work.id);x.api.store.setIntakePaused(x.config.project.id,work.id,work.revision,true);}
    if(change==='revision')x.api.store.desktopState.prepare('UPDATE office_intake SET revision=revision+1 WHERE work_id=?').run(x.work.id);
    if(change==='expired')x.driver.config.grants[0].expires_at_ms=1;
    if(change==='scope')x.driver.config.grants[0].windows[0].allow_window_restore=false;
    if(change==='identity')x.state.listTitle='Another window';
    if(change==='window_id')x.state.listWindowId=999;
    if(change==='model_settings')x.api.windows.settingsRevision=()=>99;
  };
  if(['identity','window_id'].includes(change))assert.equal((await x.design()).status,'waiting_observation');
  else await assert.rejects(x.design(),/WORK_PAUSED|WORK_REVISION_CHANGED|WORK_SCOPE_REQUIRED|CUA_WINDOW_SCOPE_CHANGED|MODEL_SETTINGS_CHANGED/);
  assert.equal(x.driver.counters.window_restore_attempts,0);assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);
  assert.equal(x.api.store.desktopState.prepare('SELECT COUNT(*) n FROM windows_workflow_lock').get().n,0);
});
for(const failure of ['restoreNoop','restoreDrop'])test('runtime contract '+failure+' is a single uncertain recovery, never a loop or model call',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;x.state[failure]=true;
  const result=await x.design();assert.equal(result.status,'waiting_observation');assert.equal(result.reason,'CUA_WINDOW_RESTORE_UNVERIFIED');assert.equal(result.foreground_changed,'unobserved');
  assert.equal(x.state.restores,1);assert.equal(x.driver.counters.window_restores,0);assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE_NATIVE/);
});
test('runtime contract one successful restore cannot recursively retry a still-unrendered capture',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;
  x.state.onCapture=()=>{x.state.captureFailure=minimized;};
  const result=await x.design();assert.equal(result.reason,'CUA_WINDOW_RESTORE_OBSERVATION_UNAVAILABLE');
  assert.equal(x.state.restores,1);assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);
});
test('runtime contract pause while restore is in flight prevents further model work or input',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;
  x.state.onRestore=()=>{const work=x.api.store.intakeWork(x.config.project.id,x.work.id);x.api.store.setIntakePaused(x.config.project.id,work.id,work.revision,true);};
  await assert.rejects(x.design(),/WORK_PAUSED/);assert.equal(x.state.restores,1);assert.equal(x.modelCalls.length,0);assert.equal(x.actions.length,0);
});
test('runtime contract design cannot restore while another run owns the executor',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;
  x.api.store.desktopState.prepare('INSERT INTO windows_workflow_lock VALUES (?,?)').run(x.driver.id,'other-run');
  const result=await x.design();assert.equal(result.status,'waiting_executor');assert.equal(x.calls.length,0);
  assert.equal(x.api.store.desktopState.prepare('SELECT run_id FROM windows_workflow_lock').get().run_id,'other-run');
});
test('runtime native dead observation owner releases only its observation lock, not an effect claim',async t=>{
  const x=await fixture(t),child=spawn(process.execPath,['-e','process.exit(0)'],{stdio:'ignore',windowsHide:true});
  await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});
  assert.ok(child.pid);assert.throws(()=>process.kill(child.pid,0),{code:'ESRCH'});
  const lock='design:'+snapshotHash({platform:process.platform,hostname:hostname()}).slice(0,16)+':'+child.pid+':dead-probe';
  x.api.store.desktopState.prepare('INSERT INTO windows_workflow_lock VALUES (?,?)').run(x.driver.id,lock);
  assert.equal((await x.design()).status,'planned');
  assert.equal(x.api.store.desktopState.prepare('SELECT COUNT(*) n FROM windows_workflow_lock').get().n,0);
});
for(const owner of ['live','other-host'])test('runtime contract '+owner+' observation lock cannot be reclaimed',async t=>{
  const x=await fixture(t),prefix=owner==='live'?snapshotHash({platform:process.platform,hostname:hostname()}).slice(0,16):'unverified-host';
  const lock='design:'+prefix+':'+process.pid+':active-probe';
  x.api.store.desktopState.prepare('INSERT INTO windows_workflow_lock VALUES (?,?)').run(x.driver.id,lock);
  assert.equal((await x.design()).status,'waiting_executor');assert.equal(x.calls.length,0);
});
test('runtime contract an executing step recovers minimization and continues instead of asking for a human',async t=>{
  const x=await fixture(t);allowRestore(x);const {run}=await x.start();x.state.captureFailure=minimized;
  const result=await x.step(run);assert.equal(result.status,'completed');assert.equal(x.state.restores,1);assert.equal(x.actions.length,1);
});
test('runtime contract background-only minimized step waits without invalidating its saved procedure',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.captureFailure=minimized;
  const result=await x.step(run);assert.equal(result.status,'waiting_observation');assert.equal(x.actions.length,0);assert.equal(x.driver.counters.window_restore_attempts,0);
  x.state.captureFailure=null;assert.equal((await x.step(result)).status,'completed');
});
test('runtime contract restoration discards old verified target shortcut and current approvals',async t=>{
  const x=await fixture(t);allowRestore(x);const first=await x.start();await x.step(first.run);x.state.phase=0;x.state.captureFailure=minimized;
  const second=await x.start('restored-repeat'),result=await x.step(second.run);
  assert.equal(result.status,'completed');assert.equal(result.receipts[0].decision.decider,'llm');assert.equal(x.driver.counters.verified_target_hits,0);
});
test('runtime contract uncertain effect reconciliation remains read-only even with restore permission',async t=>{
  const x=await fixture(t);allowRestore(x);const {run}=await x.start();x.state.captureFailure='backend temporarily unavailable';x.state.failAfterAction=true;
  const result=await x.step(run);assert.equal(result.status,'reconciliation_required');const restores=x.state.restores??0;
  x.state.captureFailure=minimized;
  const reconciled=await x.api.call('runtime_windows_reconcile',{run_id:run.run_id,expected_revision:result.revision});
  assert.equal(reconciled.reconciliation_blocked,'CUA_VISUAL_WINDOW_MINIMIZED');assert.equal(x.state.restores??0,restores);assert.equal(x.actions.length,1);
});
for(const profile of ['field','reviewed_chat'])test('runtime contract '+profile+' profile cannot escalate to foreground restoration',async()=>{
  const port=new OwnedCuaConnection({},profile);await assert.rejects(port.call('bring_to_front',{pid:42,window_id:7}),/CUA_TOOL_FORBIDDEN/);
});
test('runtime contract foreground recovery is a host grant, not an LLM procedure field',async t=>{
  const x=await fixture(t);x.plan.steps[0].desktop.allow_window_restore=true;await assert.rejects(x.design());assert.equal(x.driver.counters.window_restore_attempts,0);
});

test('runtime contract covered but readable window stays background without extra probes',async t=>{
  const x=await fixture(t);x.driver.config.grants[0].windows[0].allow_window_activation=true;
  assert.equal((await x.design()).status,'planned');assert.ok(x.calls.every(c=>c.name==='get_window_state'));
});
test('runtime contract failed restored-window capture activates once with a separate foreground grant',async t=>{
  const x=await fixture(t);x.driver.config.grants[0].windows[0].allow_window_activation=true;
  x.state.minimized=false;x.state.captureFailure='window frame unavailable';
  assert.equal((await x.design()).status,'planned');assert.equal(x.state.restores,1);
  const row=x.api.store.desktopState.prepare('SELECT status,reason FROM cua_window_recovery').get();
  assert.equal(row.status,'verified');assert.equal(row.reason,'CUA_VISUAL_CAPTURE_UNAVAILABLE');
});
test('runtime contract minimize permission cannot silently authorize foreground activation',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.minimized=false;x.state.captureFailure='frame unavailable';
  const result=await x.design();assert.equal(result.reason,'CUA_WINDOW_ACTIVATION_REQUIRED');assert.equal(x.state.restores??0,0);assert.equal(x.modelCalls.length,0);
});
for(const failure of ['restoreNoop','restoreDrop'])test('runtime contract persisted '+failure+' cannot repeat focus changes across calls',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;x.state[failure]=true;
  await x.design();const next=await x.design();assert.equal(next.reason,'CUA_WINDOW_RECOVERY_EXHAUSTED');assert.equal(x.state.restores,1);
});
for(const state of ['missingWindow','unresponsive','identity'])test('runtime contract '+state+' is classified without restarting or binding another app',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;
  if(state==='missingWindow')x.state.missingWindow=true;if(state==='unresponsive')x.state.responding=false;if(state==='identity')x.state.listTitle='different';
  const result=await x.design();assert.equal(result.status,'waiting_observation');
  assert.equal(result.reason,{missingWindow:'CUA_TARGET_WINDOW_MISSING',unresponsive:'CUA_WINDOW_UNRESPONSIVE',identity:'CUA_WINDOW_CHANGED'}[state]);
  assert.equal(x.state.restores??0,0);assert.equal(x.actions.length,0);assert.equal(x.modelCalls.length,0);
});
test('runtime contract continuous layout drift exhausts a durable budget without clicking',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.modelHook=(purpose)=>{if(purpose==='correct')x.state.x+=20;};
  let result=await x.step(run);assert.equal(result.status,'needs_review');assert.equal(x.actions.length,0);
  result=await x.step(result);assert.equal(result.status,'needs_review');assert.equal(result.observation_recoveries.length,2);
  result=await x.step(result);assert.equal(result.observation_recoveries.length,2);assert.equal(x.actions.length,0);
});
test('runtime contract authentication appearing on reobservation never becomes a recovery click',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.modelHook=(purpose)=>{if(purpose==='correct')x.state.sensitive=true;};
  assert.equal((await x.step(run)).status,'waiting_auth');assert.equal(x.actions.length,0);
});
test('runtime contract no foreground recovery after an effect has been dispatched',async t=>{
  const x=await fixture(t);allowRestore(x);const {run}=await x.start();x.state.captureFailure=minimized;x.state.failAfterAction=true;
  const result=await x.step(run);assert.equal(result.status,'reconciliation_required');assert.equal(x.actions.length,1);assert.equal(x.state.restores??0,0);
});

test('runtime contract model-recognized modal does not click through or blindly dismiss it',async t=>{
  const x=await fixture(t),{run}=await x.start();x.state.overlay=true;
  x.api.windows.options.llm.call=async()=>({state:'blocked',target:'unknown',evidence_quote:''});
  const result=await x.step(run);assert.equal(result.status,'needs_review');assert.equal(result.next_action,'runtime_windows_design');assert.equal(x.actions.length,0);
});
test('runtime contract expired foreground grant cannot be renewed by a saved recovery record',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;await x.design();
  x.driver.config.grants[0].expires_at_ms=1;x.state.captureFailure=minimized;
  await assert.rejects(x.design(),/WORK_SCOPE_REQUIRED/);assert.equal(x.state.restores,1);
});
test('runtime contract successful recovery cooldown prevents repeated focus thrashing',async t=>{
  const x=await fixture(t);allowRestore(x);x.state.captureFailure=minimized;await x.design();x.state.captureFailure=minimized;
  assert.equal((await x.design()).reason,'CUA_WINDOW_RECOVERY_EXHAUSTED');assert.equal(x.state.restores,1);
  assert.deepEqual(Object.keys(x.driver.diagnostics().recent_recovery[0]).sort(),['attempted_at','elapsed_ms','reason','status']);
});
