import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {createServer} from 'node:http';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {readSetupActivity} from '../dist/onboarding/setup-activity.js';

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'office-maintenance-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);
  let view={revision:0,enabled:true,interval_hours:24,next_due_at:null,state:'due',clients:[]},updates=0,checks=0,closed=false;
  const maintenance={view:()=>structuredClone(view),async save(value){if(value.revision!==view.revision)throw Error('CLIENT_MAINTENANCE_REVISION_CONFLICT');view={...view,revision:view.revision+1,enabled:value.enabled,state:value.enabled?'due':'disabled'};return this.view();},async runNow(){updates++;return {state:'idle',attempted_ids:[],updated_ids:[],skipped:[],next_due_at:null};},async runDue(){checks++;return this.runNow();},async close(){closed=true;}};
  return {config,maintenance,get updates(){return updates;},get checks(){return checks;},get closed(){return closed;}};
}
test('runtime contract maintenance settings require a local user POST and preserve exact revisions without raw CLI output',async t=>{
  const x=await setup(t),auth={connections:async()=>[],view:()=>({state:'idle'}),start:async()=>({state:'idle'}),close(){}};
  const settings=new ControlSettings(x.config,auth,{},undefined,undefined,undefined,undefined,undefined,x.maintenance);
  let host;const server=createServer((req,res)=>void settings.handle(req,res,req.url.slice(1),host));await new Promise(r=>server.listen(0,'127.0.0.1',r));host='127.0.0.1:'+server.address().port;
  t.after(async()=>{await settings.close();await new Promise(r=>server.close(r));});
  const url='http://'+host+'/settings/maintenance',headers={origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'};
  assert.equal((await (await fetch(url+'/status')).json()).enabled,true);assert.equal(x.updates,0);
  assert.equal((await fetch(url+'/update-now',{method:'POST',headers:{...headers,origin:'https://other.invalid'},body:'{}'})).status,403);assert.equal(x.updates,0);
  const save=await fetch(url+'/settings',{method:'POST',headers,body:JSON.stringify({revision:0,enabled:false})});assert.equal(save.status,200);assert.equal((await save.json()).state,'disabled');
  const stale=await fetch(url+'/settings',{method:'POST',headers,body:JSON.stringify({revision:0,enabled:true})});assert.equal(stale.status,409);assert.equal((await stale.json()).error,'CLIENT_MAINTENANCE_REVISION_CONFLICT');
  const invalid=await fetch(url+'/update-now',{method:'POST',headers,body:'{"command":"unsafe"}'});assert.equal(invalid.status,400);assert.equal(x.updates,0);
  const manual=await fetch(url+'/update-now',{method:'POST',headers,body:'{}'});assert.equal(manual.status,200);assert.equal(x.updates,1);assert.doesNotMatch(JSON.stringify(await manual.json()),/stdout|stderr|credential/);
  await settings.tickMaintenance('startup');assert.equal(x.checks,0,'no durable preference means no implicit package writes');
  x.maintenance.runNow=async()=>{throw Error('RAW_SECRET_UPDATER_OUTPUT_MUST_NOT_LEAK');};
  const failed=await fetch(url+'/update-now',{method:'POST',headers,body:'{}'});assert.equal(failed.status,400);assert.deepEqual(await failed.json(),{error:'CLIENT_MAINTENANCE_CHECK_FAILED'});
  const history=readSetupActivity(dirname(x.config.path));assert.equal(history.at(-1).state,'warning');assert.equal(history.at(-1).message,'CLI 업데이트 확인에 실패했습니다. 다시 시도해 주세요.');assert.doesNotMatch(JSON.stringify(history),/RAW_SECRET_UPDATER_OUTPUT/);assert.equal(settings.maintenanceRunning,false);
});
test('runtime native Control Center fences new work and model discovery while its bounded maintenance action runs, then drains',async t=>{
  const x=await setup(t);let release,entered;const started=new Promise(r=>entered=r),wait=new Promise(r=>release=r);
  x.maintenance.runNow=async()=>{entered();await wait;return {state:'idle',attempted_ids:[],updated_ids:[],skipped:[],next_due_at:null};};
  const model={calls:[],async call(){throw Error('MODEL_MUST_NOT_BE_CALLED');}};
  const service=await startControlCenter(x.config,{workModel:model,clientMaintenance:x.maintenance});t.after(async()=>{release();await service.close();});
  const origin=new URL(service.url).origin,headers={origin,'content-type':'application/json','x-agent-driver':'human-settings'};
  const pending=fetch(new URL('settings/maintenance/update-now',service.url),{method:'POST',headers,body:'{}'});await started;
  const status=await fetch(new URL('settings/maintenance/status',service.url));assert.equal(status.status,200);
  const discovery=await fetch(new URL('settings/models',service.url));assert.equal(discovery.status,503);assert.equal((await discovery.json()).error,'CLI_UPDATE_IN_PROGRESS');
  const work=await fetch(new URL('work/intake',service.url),{method:'POST',headers:{...headers,'x-agent-driver':'human-office'},body:'{}'});assert.equal(work.status,503);assert.equal((await work.json()).error,'CLI_UPDATE_IN_PROGRESS');
  release();assert.equal((await pending).status,200);assert.equal((await fetch(new URL('settings/maintenance/status',service.url))).status,200);
  await service.close();assert.equal(x.closed,true);
});
