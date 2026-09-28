import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {WindowsProcedureStore,focusedLocatorSchema,windowsJudgmentSpecSchema} from '../dist/desktop/windows-procedure.js';
import {CuaFieldDriver} from '../dist/desktop/cua-field-driver.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';

const digest='a'.repeat(64),locator={label:'Note',automation_id:'104',class_name:'Edit',role:'Edit',value_encoding:'exact'};
function setup(t){
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const field={grant_id:randomUUID(),work_id:randomUUID(),pid:123,window_id:456,app_name:'LocalForm.exe',window_title:'Local draft',element_index:0,label:'Note',request_field:'Local note',expires_at_ms:Date.now()+60_000,local_draft_only:true,auto_submits:false,sensitive:false,approved_value:'First value',value_encoding:'exact'};
  const config={kind:'cua',executable:'C:/approved/cua.exe',executable_sha256:digest,version:'0.30.2',manifest:'C:/approved/grant.yaml',manifest_sha256:digest,manifest_reviewed:true,observation_strategy:'focused',fields:[field]};
  const state={value:'',snapshot:0,tools:[],reads:0,writes:0,runtime_id:'42.1',started:'123456',automation_id:'104',fail:null,drop:false,closed:false};
  const focused={async close(){state.closed=true;},async read(f,l){state.reads++;if(state.fail)throw Error(state.fail);if(l&&l.automation_id!==state.automation_id)throw Error('WINDOWS_FOCUSED_LOCATOR_CHANGED');return {pid:f.pid,window_id:f.window_id,app_name:f.app_name,window_title:f.window_title,process_started_ticks:state.started,field:{...locator,automation_id:state.automation_id,runtime_id:state.runtime_id,value:state.value,enabled:true,visible:true,frame:{x:10,y:10,w:200,h:40}},window_bounds:{x:0,y:0,width:500,height:500}};}};
  const port={connected:()=>true,async close(){},async call(name,args){state.tools.push({name,args});if(name==='set_value'){state.writes++;assert.equal(args.element_token,'s'+state.snapshot.toString(16).padStart(8,'0')+':0');if(!state.drop)state.value=args.value;return {success:true};}assert.equal(name,'get_window_state');const snapshot='s'+(++state.snapshot).toString(16).padStart(8,'0');return {pid:123,window_id:456,app_name:field.app_name,window_title:field.window_title,window_bounds:{x:0,y:0,width:500,height:500},snapshot_id:snapshot,truncated:false,elements:[{element_index:0,element_token:snapshot+':0',role:'Edit',label:'Note',value:state.value,enabled:true,actions:['set_value'],frame:{x:10,y:10,w:200,h:40}}]};}};
  const create=(value='First value')=>{const next={...config,fields:[{...field,grant_id:randomUUID(),approved_value:value}]};const driver=new CuaFieldDriver(next,db,port,focused);const job={run_id:randomUUID(),work_id:field.work_id,workflow_id:'windows.form.draft',binding_sha256:snapshotHash(randomUUID()),inputs:{field:field.request_field,value}};return {driver,job};};
  async function command(driver,job){const obs=await driver.observe(job),{capture_id,captured_at_ms,...body}=obs;return {action_id:randomUUID(),run_id:job.run_id,work_id:job.work_id,workflow_id:job.workflow_id,step_id:'field',application:obs.application,window_ref:obs.window_ref,capture_id,target_id:obs.controls[0]?.id,observation_sha256:snapshotHash(body),binding_sha256:job.binding_sha256,action:'replace_text',effect:'local_draft',text:job.inputs.value};}
  async function execute(value){const {driver,job}=create(value),cmd=await command(driver,job);assert.equal(await driver.authorize(cmd),true);await driver.act(cmd);const after=await driver.observe(job);await driver.verified(job,cmd,after);return {driver,job,cmd,after};}
  return {db,field,config,state,focused,port,create,command,execute};
}
test('runtime contract Windows procedures promote only verified metadata and evict corrupt or expired records',t=>{
  const x=setup(t),store=new WindowsProcedureStore(x.db);assert.equal(store.read(digest,'locator',focusedLocatorSchema),null);
  store.verify(digest,'locator',locator,digest);assert.deepEqual(store.read(digest,'locator',focusedLocatorSchema),locator);
  assert.throws(()=>store.verify(digest,'locator',{...locator,element_token:'stale'},digest));
  const row=x.db.prepare('SELECT * FROM windows_procedure').get();assert.ok(!row.body.includes('First value'));assert.ok(!row.body.includes('window_id'));
  x.db.prepare("UPDATE windows_procedure SET body_sha='bad'").run();assert.equal(store.read(digest,'locator',focusedLocatorSchema),null);
  store.verify(digest,'locator',locator,digest,0);assert.equal(store.read(digest,'locator',focusedLocatorSchema),null);
});
test('runtime contract focused CUA keeps input-time and independent readback checks with one full tree and no inventory',async t=>{
  const x=setup(t),result=await x.execute();assert.equal(x.state.writes,1);assert.equal(x.state.reads,3);
  assert.equal(x.state.tools.filter(t=>t.name==='get_window_state').length,1);assert.equal(x.state.tools.filter(t=>t.name==='list_windows').length,0);
  assert.deepEqual(result.driver.diagnostics().observations.map(o=>[o.purpose,o.path]),[['observe','full'],['pre_input','focused'],['readback','focused']]);
  assert.ok(result.after.facts.some(f=>f.key==='form_field_matches'&&f.action_id===result.cmd.action_id));
});
test('runtime contract repeat uses verified locator across driver restart but obtains a new current CUA token and grant',async t=>{
  const x=setup(t);await x.execute();x.state.tools=[];x.state.reads=0;
  const repeated=await x.execute('Second value');assert.equal(x.state.writes,2);assert.equal(repeated.driver.diagnostics().procedures.cache_hits,1);
  assert.deepEqual(repeated.driver.diagnostics().observations.map(o=>o.path),['focused','projection','focused']);
  assert.equal(x.state.tools.find(t=>t.name==='get_window_state').args.query,'Note');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM windows_cua_grant').get().n,2);
});
test('runtime contract a completed turn cannot lend its live CUA token to the next turn',async t=>{
  const x=setup(t),{driver,job}=await x.execute();x.state.tools=[];
  const scope={work_id:job.work_id,window:{id:x.field.window_id,app:x.field.app_name,title:x.field.window_title},window_title:x.field.window_title,automation_id:'cua-index:0',label:x.field.label};
  const initial=await driver.client.readField(scope,'observe');assert.equal(initial.field.token,undefined);
  const before=await driver.client.readField(scope,'pre_input');assert.ok(before.field.token);
  assert.equal(x.state.tools.filter(t=>t.name==='get_window_state').length,1);
  assert.equal(x.state.writes,1);
});
test('runtime contract no independent readback means no procedure promotion',async t=>{
  const x=setup(t),{driver,job}=x.create(),cmd=await x.command(driver,job);await driver.authorize(cmd);x.state.drop=true;await driver.act(cmd);
  await assert.rejects(driver.verified(job,cmd,await driver.observe(job)),/READBACK_REQUIRED/);assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM windows_procedure').get().n,0);
});
for(const drift of ['value','runtime_id','started'])test('runtime contract focused '+drift+' drift after approval cannot write',async t=>{
  const x=setup(t),{driver,job}=x.create(),cmd=await x.command(driver,job);await driver.authorize(cmd);x.state[drift]+='changed';
  await assert.rejects(driver.act(cmd));assert.equal(x.state.writes,0);assert.equal((await driver.reconcile(job,cmd)).outcome,'not_performed');
});
test('runtime contract stale saved locator triggers one read-only rediscovery and remains unpromoted',async t=>{
  const x=setup(t);await x.execute();x.state.automation_id='105';x.state.runtime_id='42.2';x.state.tools=[];
  const {driver,job}=x.create('Changed request');await driver.observe(job);
  const d=driver.diagnostics();assert.equal(d.procedures.invalidations,1);assert.deepEqual(d.observations.map(o=>o.path),['focused','rediscovery']);
  assert.equal(x.state.tools.length,1);assert.equal(x.state.writes,1);assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM windows_procedure').get().n,0);
});
test('runtime contract blocked focused target after input remains uncertain and cannot promote a recipe',async t=>{
  const x=setup(t),{driver,job}=x.create(),cmd=await x.command(driver,job);await driver.authorize(cmd);await driver.act(cmd);x.state.fail='WINDOWS_FOCUSED_WINDOW_BLOCKED';
  await assert.rejects(driver.observe(job),/BLOCKED/);assert.equal(x.state.writes,1);assert.equal(x.state.tools.filter(t=>t.name==='get_window_state').length,1);
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM windows_procedure').get().n,0);
});
test('runtime contract procedure scope excludes input values and fresh grants but includes Work and readback profile',async t=>{
  const x=setup(t),first=x.create(),second=x.create('Different');assert.equal(first.driver.procedureScope(first.job),second.driver.procedureScope(second.job));
  const config={...x.config,fields:[{...x.field,value_encoding:'uia_single_line_document'}]},changed=new CuaFieldDriver(config,x.db,x.port,x.focused);
  assert.notEqual(changed.procedureScope(first.job),first.driver.procedureScope(first.job));
  assert.throws(()=>first.driver.procedureScope({...first.job,work_id:randomUUID()}),/SCOPE_REQUIRED/);
});
test('runtime contract judgment cache has its own validated schema and cannot overwrite a locator',t=>{
  const x=setup(t),store=new WindowsProcedureStore(x.db),spec={ready_when:'ready',target_when:'target',reobserve_when:'unknown'};
  store.verify(digest,'locator',locator,digest);store.verify(digest,'judgment',spec,digest);
  assert.deepEqual(store.read(digest,'judgment',windowsJudgmentSpecSchema),spec);assert.deepEqual(store.read(digest,'locator',focusedLocatorSchema),locator);
});
