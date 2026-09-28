import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Window2FieldDriver,readWindow2Editable} from '../dist/desktop/window2-field-driver.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {modelSettingsPath,saveModelSettings} from '../dist/onboarding/model-settings.js';

function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const window={id:22,app:'process:C:\\Example\\LocalForm.exe',title:'Local draft'},state={value:'',index:3,disabled:false,focus:'3 edit',fail:false,drop:false,absent:false,noTree:false,onRead:null,calls:0};
  const tree=()=>`Window: "Local draft"\n\t${state.index} Edit (settable, string${state.disabled?', disabled':''}) Note Value: ${state.value} ID: 104`;
  const client={async list_windows(){return state.absent?[]:[window];},async get_window_state(){await state.onRead?.();return {window:{...window},accessibility:state.noTree?null:{tree:tree(),focused_element:state.focus}};},async set_value(input){state.calls++;assert.equal(input.element_index,state.index);if(state.fail)throw Error('NATIVE_INPUT_UNKNOWN');if(!state.drop)state.value=input.value;}};
  const driver=new Window2FieldDriver(client,db,'window2-test'),job={run_id:randomUUID(),work_id:randomUUID(),workflow_id:'windows.form.draft',binding_sha256:'a'.repeat(64),inputs:{field:'Local draft Note',value:'Native acceptance text'}};
  const scope={work_id:job.work_id,window,window_title:window.title,automation_id:'104',label:'Note',request_field:job.inputs.field,expires_at_ms:Date.now()+60_000,local_draft_only:true,auto_submits:false,sensitive:false};driver.bind(scope);
  async function command(){const observation=await driver.observe(job),{capture_id,captured_at_ms,...content}=observation;return {action_id:randomUUID(),run_id:job.run_id,work_id:job.work_id,workflow_id:job.workflow_id,step_id:'field',application:'host-registered',window_ref:observation.window_ref,capture_id,target_id:observation.controls[0]?.id??'missing',observation_sha256:snapshotHash(content),binding_sha256:job.binding_sha256,action:'replace_text',effect:'local_draft',text:job.inputs.value};}
  async function approve(c){assert.equal(await driver.authorize(c),false);driver.approveLocalDraft(driver.pendingReviews()[0].review_id);assert.equal(await driver.authorize(c),true);}
  return {db,window,state,client,driver,job,scope,command,approve};
}

test('runtime unit window2 exact editable values parse Korean and English without losing colons',()=>{
  const field=readWindow2Editable(' 3 편집 (settable, string) 복사할 문자(A): Value: 테스트: 123 ID: 104','104','복사할 문자(A):');assert.equal(field.value,'테스트: 123');assert.equal(field.index,3);
  assert.throws(()=>readWindow2Editable('3 Edit Note ID: 104','104','Note'),/NOT_UNIQUE/);
  const row='3 Edit (settable, string) Note Value:  ID: 104';assert.throws(()=>readWindow2Editable(row+'\n'+row,'104','Note'),/NOT_UNIQUE/);
  assert.throws(()=>readWindow2Editable(row.replace('string','string, offscreen'),'104','Note'),/STATE_UNKNOWN/);
});
test('runtime contract window2 native-shaped observation excludes raw values and requires one-use draft review',async t=>{
  const x=setup(t);x.state.value='private source text';const observation=await x.driver.observe(x.job);assert.ok(!JSON.stringify(observation).includes('private source text'));
  const c=await x.command();await assert.rejects(x.driver.act(c),/APPROVAL_REQUIRED/);assert.equal(x.state.calls,0);
  await x.approve(c);const receipt=await x.driver.act(c);assert.equal(receipt.outcome,'performed');assert.equal(x.state.calls,1);
  const after=await x.driver.observe(x.job);assert.ok(after.facts.some(f=>f.key==='form_field_matches'&&f.action_id===c.action_id));
  await assert.rejects(x.driver.act({...c,capture_id:after.capture_id}),/TARGET_CHANGED|ALREADY_CLAIMED/);assert.equal(x.state.calls,1);
});
for(const reason of ['missing_window','title','no_tree','disabled','wrong_field','scope_expired'])test(`runtime contract window2 ${reason} does not create an actionable target`,async t=>{
  const x=setup(t);
  if(reason==='missing_window')x.state.absent=true;if(reason==='title')x.window.title='Other form';if(reason==='no_tree')x.state.noTree=true;if(reason==='disabled')x.state.disabled=true;
  if(reason==='wrong_field')x.job.inputs.field='Different field';if(reason==='scope_expired')x.driver.revoke(x.job.work_id);
  if(reason==='disabled')assert.equal((await x.driver.observe(x.job)).controls.length,0);else await assert.rejects(x.driver.observe(x.job));assert.equal(x.state.calls,0);
});
for(const change of ['index','focus','value','disconnect','revoke'])test(`runtime contract window2 ${change} after approval cannot dispatch`,async t=>{
  const x=setup(t),c=await x.command();await x.approve(c);
  if(change==='index')x.state.index++;if(change==='focus')x.state.focus='other';if(change==='value')x.state.value='user edit';if(change==='disconnect')x.driver.disconnect();if(change==='revoke')x.driver.revoke(x.job.work_id);
  await assert.rejects(x.driver.act(c));assert.equal(x.state.calls,0);
});
test('runtime contract window2 external sends, authentication apps and sensitive fields are not host form support',async t=>{
  const x=setup(t),c=await x.command();await assert.rejects(x.driver.authorize({...c,effect:'external_send'}),/EFFECT_FORBIDDEN/);
  assert.throws(()=>x.driver.bind({...x.scope,window:{...x.window,app:'process:C:\\KakaoTalk.exe'}}),/APPLICATION_FORBIDDEN/);
  assert.throws(()=>x.driver.bind({...x.scope,label:'Password'}),/SENSITIVE_FIELD/);
  assert.throws(()=>x.driver.bind({...x.scope,auto_submits:true}),/REVIEWED_LOCAL_FIELD_REQUIRED/);assert.equal(x.state.calls,0);
});
test('runtime contract window2 unknown setter result never becomes performed from matching screen alone',async t=>{
  const x=setup(t),c=await x.command();await x.approve(c);x.state.fail=true;await assert.rejects(x.driver.act(c));x.state.value=x.job.inputs.value;
  assert.equal((await x.driver.reconcile(x.job,c)).outcome,'unknown');await assert.rejects(x.driver.act(c));assert.equal(x.state.calls,1);
});
test('runtime contract window2 setter return without independent value readback cannot prove completion',async t=>{
  const x=setup(t),c=await x.command();await x.approve(c);x.state.drop=true;await x.driver.act(c);
  assert.ok(!(await x.driver.observe(x.job)).facts.some(f=>f.key==='form_field_matches'));assert.equal((await x.driver.reconcile(x.job,c)).outcome,'unknown');
});
test('runtime contract window2 concurrent dispatch owns one foreground and one durable claim',async t=>{
  const x=setup(t),c=await x.command();await x.approve(c);let release;const waiting=new Promise(r=>release=r);x.state.onRead=()=>waiting;
  const action=x.driver.act(c);await assert.rejects(x.driver.act({...c,action_id:randomUUID()}),/FOREGROUND_BUSY/);release();await action;assert.equal(x.state.calls,1);
});
test('runtime fixture Window2 driver traverses Work, native command boundary, readback and disconnect',async t=>{
  const x=setup(t),root=await mkdtemp(join(tmpdir(),'window2-runtime-')),file=join(root,'host.json');let api;
  t.after(async()=>{api?.close();await api?.drain();await rm(root,{recursive:true,force:true});});
  await writeFile(file,JSON.stringify({schema_version:1,project_id:'native-adapter-test',caller_ref:'caller',account_ref:'owner',worktree:root,data_dir:join(root,'data'),packs:{models:'jev_llm',model_data_approved:true,sources:[],targets:[]}}));
  const model={calls:[],async call(_purpose,_prompt,state){return {state:'ready',target:'c0',evidence_quote:state.candidates.c0.label};}};
  const config=loadHostConfig(file);
  saveModelSettings(modelSettingsPath(config),{revision:0,selection:{mode:'subscription',client:'auto',api_model:'test-only',reasoning:'low',jev:'off'},onboarding_step:0},{});
  api=new RuntimeApi(config,{windows:{driver:x.driver,llm:model},swarmModel:model});
  const work=api.store.beginWork(api.config.project.id,'native-test','Fill a local draft','quick').work;
  api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify({route:{kind:'pack',pack_family:'form.draft-submit'}}),work.id);
  x.driver.bind({...x.scope,work_id:work.id});
  let run=await api.call('runtime_windows_start',{work_id:work.id,request_id:'native-test',workflow_id:'windows.form.draft',inputs:x.job.inputs});
  const step=()=>api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});run=await step();assert.equal(run.status,'waiting_approval');assert.equal(x.state.calls,0);
  x.driver.approveLocalDraft(x.driver.pendingReviews()[0].review_id);run=await step();assert.equal(run.status,'completed');assert.equal(run.work_completion_verified,false);assert.equal(x.state.calls,1);
  const catalog=await api.call('runtime_windows_catalog',{});assert.equal(catalog.native_executor,'host_adapter_connected');assert.deepEqual(catalog.supported_workflows,['windows.form.draft']);x.driver.disconnect();assert.equal((await api.call('runtime_windows_catalog',{})).native_executor,'not_connected');
});
