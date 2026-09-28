import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {CuaFieldDriver,parseCuaField,decodeCuaFieldValue} from '../dist/desktop/cua-field-driver.js';
import {OwnedCuaConnection} from '../dist/desktop/cua-connection.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
const digest='a'.repeat(64);
function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const work=randomUUID(),field={grant_id:randomUUID(),work_id:work,pid:123,window_id:456,app_name:'LocalForm.exe',window_title:'Local draft',element_index:0,label:'Note',
    request_field:'Local form note',expires_at_ms:Date.now()+60_000,local_draft_only:true,auto_submits:false,sensitive:false,approved_value:'Runtime input'};
  const config={kind:'cua',executable:'C:/approved/cua-driver.exe',executable_sha256:digest,version:'0.30.2',manifest:'C:/approved/manifest.yaml',manifest_sha256:digest,manifest_reviewed:true,fields:[field]};
  const state={value:undefined,writes:0,snapshot:0,open:false,closed:false,drop:false,fail:false,mutate:null,tools:[]};
  const port={connected:()=>state.open,async close(){state.closed=true;state.open=false;},async call(name,args){
    state.open=true;state.tools.push(name);
    if(name==='list_windows')return {windows:[{window_id:456,pid:123,app_name:'LocalForm.exe',title:'Local draft',is_on_screen:true,minimized:false}]};
    if(name==='get_window_state'){
      const snapshot='s'+(++state.snapshot).toString(16).padStart(8,'0');
      const raw={pid:123,window_id:456,app_name:'LocalForm.exe',window_title:'Local draft',window_bounds:{x:0,y:0,width:500,height:500},snapshot_id:snapshot,truncated:false,elements_complete:false,elements:[
        {element_index:0,element_token:snapshot+':0',role:'Edit',label:'Note',enabled:true,actions:['set_value'],frame:{x:10,y:10,w:200,h:40},...(state.value!==undefined?{value:state.value}:{})}]};
      state.mutate?.(raw);return raw;
    }
    if(name==='set_value'){
      state.writes++;assert.equal(args.element_token,'s'+state.snapshot.toString(16).padStart(8,'0')+':0');
      if(state.fail)throw Error('CUA_TOOL_UNCERTAIN');if(!state.drop)state.value=args.value;return {success:true};
    }
    throw Error('unexpected tool');
  }};
  const driver=new CuaFieldDriver(config,db,port),job={run_id:randomUUID(),work_id:work,workflow_id:'windows.form.draft',binding_sha256:digest,inputs:{field:field.request_field,value:field.approved_value}};
  const scope={...field,window:{id:456,app:'LocalForm.exe',title:'Local draft'},automation_id:'cua-index:0'};
  async function command(){const o=await driver.observe(job),{capture_id,captured_at_ms,...body}=o;return {action_id:randomUUID(),run_id:job.run_id,work_id:job.work_id,workflow_id:job.workflow_id,step_id:'field',application:o.application,window_ref:o.window_ref,capture_id,target_id:o.controls[0]?.id??'absent',observation_sha256:snapshotHash(body),binding_sha256:job.binding_sha256,action:'replace_text',effect:'local_draft',text:job.inputs.value};}
  return {db,field,config,state,port,driver,job,scope,command};
}
test('runtime contract CUA structured field keeps missing value unknown and uses fresh native tokens',async t=>{
  const x=setup(t),raw=await x.port.call('get_window_state',{}),parsed=parseCuaField(raw,x.scope,123,0,true);
  assert.equal(parsed.field.value,null);assert.equal(parsed.field.token,'s00000001:0');
  const observation=await x.driver.observe(x.job);assert.ok(!JSON.stringify(observation).includes('Runtime input'));
  const c=await x.command();assert.equal(await x.driver.authorize(c),true);await x.driver.act(c);
  const after=await x.driver.observe(x.job);assert.equal(x.state.writes,1);assert.ok(after.facts.some(f=>f.key==='form_field_matches'&&f.action_id===c.action_id));
});
for(const condition of ['pid','window','app','title','role','label','token','duplicate','truncated','missing_enabled','not_settable']){
  test('runtime contract CUA '+condition+' mismatch blocks input',async t=>{
    const x=setup(t);x.state.mutate=raw=>{
      const e=raw.elements[0];
      if(condition==='pid')raw.pid=999;if(condition==='window')raw.window_id=789;if(condition==='app')raw.app_name='Other.exe';if(condition==='title')raw.window_title='Other';
      if(condition==='role')e.role='Button';if(condition==='label')e.label='Password';if(condition==='token')e.element_token='sffffffff:0';
      if(condition==='duplicate')raw.elements.push({...e});if(condition==='truncated')raw.truncated=true;if(condition==='missing_enabled')delete e.enabled;if(condition==='not_settable')e.actions=[];
    };
    await assert.rejects(x.driver.observe(x.job));assert.equal(x.state.writes,0);
  });
}
test('runtime contract CUA exact field uses code only with matching Work and intent',async t=>{
  const x=setup(t),o=await x.driver.observe(x.job);assert.equal(await x.driver.selectExactTarget(x.job,o),o.controls[0].id);
  assert.equal(await x.driver.selectExactTarget({...x.job,inputs:{...x.job.inputs,field:'Other field'}},o),null);
  assert.equal(await x.driver.selectExactTarget({...x.job,work_id:randomUUID()},o),null);
});
test('runtime contract CUA exact-code path still rejects a changed field between approval and input',async t=>{
  const x=setup(t),c=await x.command();assert.equal(await x.driver.authorize(c),true);
  x.state.value='User changed the field';
  await assert.rejects(x.driver.act(c),/TARGET_CHANGED|STATE_CHANGED/);assert.equal(x.state.writes,0);
  assert.equal((await x.driver.reconcile(x.job,c)).outcome,'not_performed');
});
test('runtime contract CUA unapproved or altered value cannot use local exact grant',async t=>{
  const x=setup(t);x.job.inputs.value='Changed';const c=await x.command();assert.equal(await x.driver.authorize(c),false);
  await assert.rejects(x.driver.act(c),/APPROVAL_REQUIRED/);assert.equal(x.state.writes,0);
});
test('runtime contract CUA consumed grants persist across driver restart and unknown effects never replay',async t=>{
  const x=setup(t),c=await x.command();assert.equal(await x.driver.authorize(c),true);x.state.fail=true;
  await assert.rejects(x.driver.act(c),/UNCERTAIN/);x.state.value=x.job.inputs.value;
  assert.equal((await x.driver.reconcile(x.job,c)).outcome,'unknown');
  const second=new CuaFieldDriver(x.config,x.db,x.port),fresh=await second.observe(x.job),{capture_id,captured_at_ms,...body}=fresh;
  const next={...c,action_id:randomUUID(),capture_id,observation_sha256:snapshotHash(body)};
  assert.equal(await second.authorize(next),false);await assert.rejects(second.act(next),/GRANT_ALREADY_CONSUMED/);assert.equal(x.state.writes,1);
});
test('runtime contract CUA dispatch without changed readback is not completed',async t=>{
  const x=setup(t),c=await x.command();await x.driver.authorize(c);x.state.drop=true;await x.driver.act(c);
  assert.ok(!(await x.driver.observe(x.job)).facts.some(f=>f.key==='form_field_matches'));
  assert.equal((await x.driver.reconcile(x.job,c)).outcome,'unknown');
});
test('runtime contract CUA explicit shutdown disconnects and fences future observations',async t=>{
  const x=setup(t);await x.driver.observe(x.job);await x.driver.shutdown();assert.equal(x.state.closed,true);assert.equal(x.driver.availability().connected,false);
  await assert.rejects(x.driver.observe(x.job),/DISCONNECTED/);
});
test('runtime unit CUA expired scope does not prevent unrelated runtime startup',t=>{
  const x=setup(t);x.config.fields[0].expires_at_ms=Date.now()-1;
  assert.doesNotThrow(()=>new CuaFieldDriver(x.config,x.db,x.port));
});
test('runtime unit CUA TextPattern paragraph handling requires an explicit profile and never loose-trims values',()=>{
  assert.equal(decodeCuaFieldValue(undefined,'uia_single_line_document'),null);
  assert.equal(decodeCuaFieldValue('text\r','exact'),'text\r');
  assert.equal(decodeCuaFieldValue('text\r','uia_single_line_document'),'text');
  for(const input of ['text\r\r','text\n','text\r\n','text\rinside',' text ','text '])assert.equal(decodeCuaFieldValue(input,'uia_single_line_document'),input);
});
test('runtime contract CUA fresh bounds and identity are verified even after inventory reuse',async t=>{
  const x=setup(t);await x.driver.observe(x.job);
  x.state.mutate=raw=>raw.window_bounds={x:-32000,y:-32000,width:160,height:30};
  assert.equal((await x.driver.observe(x.job)).controls.length,0);
  x.state.mutate=raw=>raw.pid=999;await assert.rejects(x.driver.observe(x.job),/WINDOW_CHANGED/);
  assert.equal(x.state.tools.filter(name=>name==='list_windows').length,1);assert.equal(x.state.writes,0);
});
test('runtime contract owned CUA connection forbids arbitrary tool proxy and closes idempotently',async t=>{
  const x=setup(t),connection=new OwnedCuaConnection(x.config);
  await assert.rejects(connection.call('launch_app',{}),/TOOL_FORBIDDEN/);assert.equal(connection.pid,null);
  await connection.close();await connection.close();await assert.rejects(connection.call('list_windows',{}),/CLOSED/);
});
test('runtime fixture CUA Work runtime skips models for reviewed field and drains the owned port',async t=>{
  const x=setup(t),root=await mkdtemp(join(tmpdir(),'cua-runtime-')),file=join(root,'host.json');let api;
  t.after(async()=>{api?.close();await api?.drain();await rm(root,{recursive:true,force:true});});
  await writeFile(file,JSON.stringify({schema_version:1,project_id:'cua-work-test',caller_ref:'caller',account_ref:'owner',worktree:root,data_dir:join(root,'data'),windows_executor:x.config}));
  const config=loadHostConfig(file);assert.equal(config.windowsExecutor.kind,'cua');let modelCalls=0;
  api=new RuntimeApi(config,{windows:{driver:x.driver,llm:{async call(){modelCalls++;throw Error('MODEL_NOT_REQUIRED');}}}});
  const work=api.store.beginWork(config.project.id,'cua-work','Fill the reviewed local note','quick').work;
  api.store.desktopState.prepare("UPDATE office_intake SET status='ready',revision=1,spec=? WHERE work_id=?").run(JSON.stringify({route:{kind:'pack',pack_family:'form.draft-submit'}}),work.id);
  const nativeConfig={...x.config,fields:[{...x.field,work_id:work.id}]};
  const driver=new CuaFieldDriver(nativeConfig,api.store.desktopState,x.port);
  api.windows.options.driver=driver;
  let run=await api.call('runtime_windows_start',{work_id:work.id,request_id:'cua-work',workflow_id:'windows.form.draft',inputs:x.job.inputs});
  run=await api.call('runtime_windows_step',{run_id:run.run_id,expected_revision:run.revision});
  assert.equal(run.status,'completed');assert.equal(run.work_completion_verified,false);assert.equal(run.receipts[0].decision.decider,'code');
  assert.equal(modelCalls,0);assert.equal(x.state.writes,1);
  assert.equal(x.state.tools.filter(name=>name==='get_window_state').length,3);
  assert.equal(x.state.tools.filter(name=>name==='list_windows').length,1);
  api.close();await api.drain();assert.equal(x.state.closed,true);
});
