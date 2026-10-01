import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkRuntime} from '../dist/work/runtime.js';

async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'work-definition-lease-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'definition-lease',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},packs:{sources:[],targets:[],models:'off'}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  return {config,store};
}

test('definition lease renewal requires the same current owner, unexpired claim and defining state',async t=>{
  const {store,config}=await fixture(t),project=config.project.id,first=store.beginWork(project,'first','Review one source','quick').work;
  const at=Date.now(),owner=store.claimWorkDefinition(project,first.id,at);assert.ok(owner);
  assert.equal(store.renewWorkDefinition(project,first.id,'wrong-owner',at+20_000),false);
  assert.equal(store.renewWorkDefinition(project,first.id,owner,at+60_000),true);
  assert.equal(store.renewWorkDefinition(project,first.id,owner,at+120_000),true);
  assert.equal(store.renewWorkDefinition(project,first.id,owner,at+210_001),false,'An expired owner cannot revive its claim');
  const replacement=store.claimWorkDefinition(project,first.id,at+210_001);assert.ok(replacement);assert.notEqual(replacement,owner);
  assert.equal(store.renewWorkDefinition(project,first.id,owner,at+220_000),false);
  assert.equal(store.renewWorkDefinition(project,first.id,replacement,at+220_000),true);
  store.failWorkDefinition(project,first.id,replacement);
  assert.equal(store.renewWorkDefinition(project,first.id,replacement,at+240_000),false,'A cleared owner cannot renew');
});

test('slow valid Work definition remains saveable beyond the original 90-second lease through owned heartbeat',async t=>{
  const {store,config}=await fixture(t),base=Date.now();let now=base,tick=null,cleared=false,release;
  t.mock.method(Date,'now',()=>now);
  t.mock.method(globalThis,'setInterval',(callback,interval)=>{assert.equal(interval,20_000);tick={callback,unref(){}};return tick;});
  t.mock.method(globalThis,'clearInterval',timer=>{assert.equal(timer,tick);cleared=true;});
  const proposal={title:'Source review',desired_outcome:'Review one connected source',completion_checks:[{id:'review',result:'Source reviewed',evidence:'Actual source receipt'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:{steps:[{id:'review',goal:'Read the connected source',depends_on:[],observable_outcome:'Actual source receipt is preserved',effect:'read_only',tool_hints:['runtime_pack_run']}]}};
  const model={calls:[],async call(){return new Promise(resolve=>{release=()=>resolve(proposal);});}};
  const runtime=new WorkRuntime(store,config,model),workPromise=runtime.start({request_id:'slow-valid-definition',prompt:'Review one connected source'});
  await Promise.resolve();assert.ok(tick);assert.equal(typeof release,'function');
  for(let step=0;step<7;step++){now+=20_000;tick.callback();}
  assert.ok(now-base>90_000);release();
  const work=await workPromise;
  assert.equal(work.definition_status,'ready');assert.equal(work.reason,undefined);assert.equal(cleared,true);
  assert.equal(store.intakeWork(config.project.id,work.work_id).spec.title,'Source review');
});
