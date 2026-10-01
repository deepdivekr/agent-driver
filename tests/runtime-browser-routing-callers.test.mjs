import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {RoutedBrowser,eligibleBrowserTargets} from '../dist/browser/executor-routing.js';
import {RoutedSwarmBrowser} from '../dist/swarm/routed-browser.js';
import {authSites,setSiteAuth} from '../dist/swarm/browser-auth.js';

const target=(id,engine='playwright',environment='owned_headless')=>({id,engine,environment,platform:process.platform,profile_ref:id,...(engine==='aside'?{executable:'/fixture/aside'}:engine==='neo'?{endpoint:'http://127.0.0.1:49112/mcp'}:{})});
const publicRecovery=[{environment:'ubuntu_vm',preferred_engine:'playwright'},{environment:'host_foreground',preferred_engine:'aside'}];
async function fixture(t,{sources=[],registered=true}={}){
  const root=await mkdtemp(join(tmpdir(),'browser-routing-callers-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'routing-callers',caller_ref:'fixture',account_ref:'fixture-account',worktree:root,data_dir:'data',environment:'production',
    ...(registered?{browser_executors:{targets:[target('headless'),target('guest','playwright','ubuntu_vm'),target('aside','aside','host_foreground'),target('neo','neo','host_foreground')]}}:{}),
    swarm:{enabled:true,model_data_approved:true,visual:{enabled:true,max_contexts:4,owned_vm:{id:'fixture-vm',storage_root:join(root,'vm'),devtools_port:49222,vnc_port:45901}}},
    packs:{sources,models:'off',model_data_approved:false}}));
  const config=loadHostConfig(path),store=new PackStore(config.dbPath),cleanups=[];store.registerProject(config.project);
  t.after(async()=>{for(const cleanup of cleanups)await cleanup();store.close();await rm(root,{recursive:true,force:true});});return {config,store,cleanups};
}
function fakeBrowser(t){
  const opened=[];let observed={url:'https://x.com/home',title:'Timeline',text:'Public posts',links:[],observed_at:new Date().toISOString()};
  t.mock.method(RoutedBrowser.prototype,'open',async function(url){
    this.options.guard?.();opened.push({config:this.config,options:this.options,url});
    const selected=eligibleBrowserTargets(this.config,this.options.preference)[0];
    if(!selected)throw Error('BROWSER_NO_ELIGIBLE_EXECUTOR');
    Object.defineProperty(this,'target',{value:selected,configurable:true});
  });
  t.mock.method(RoutedBrowser.prototype,'extract',async function(){this.options.guard?.();return [{name:'Alpha'}];});
  t.mock.method(RoutedBrowser.prototype,'observe',async function(){this.options.guard?.();return observed;});
  t.mock.method(RoutedBrowser.prototype,'close',async()=>{});
  return {opened,setObservation(value){observed={...observed,...value};}};
}
const source=auth=>({id:'table',kind:'browser',url:'https://example.test/',parameters:[],ready:'#ready',auth_gate:'#login',auth_required:auth,account_selector:'#account',account_text:'fixture',rows:'.row',columns:{name:'.name'}});
const recipe=browser=>({version:1,family:'portal.collect',request:'Collect fixture evidence',sources:[{id:'table',parameters:{}}],filters:[],deduplicate_by:[],format:'json',...(browser?{browser}:{})});

test('runtime contract Family collection defaults public recovery and private Aside while preserving explicit browser choices',async t=>{
  const fake=fakeBrowser(t);
  for(const scenario of [
    {auth:false,expected:undefined,recovery:publicRecovery},
    {auth:true,expected:{environment:'host_foreground',preferred_engine:'aside'},recovery:[]},
    {auth:true,browser:{environment:'owned_headless'},expected:{environment:'host_foreground',preferred_engine:'aside'},recovery:[]},
    {auth:true,browser:{environment:'ubuntu_vm'},expected:{environment:'ubuntu_vm'},recovery:[]},
    {auth:false,browser:{environment:'ubuntu_vm',preferred_engine:'playwright'},expected:{environment:'ubuntu_vm',preferred_engine:'playwright'},recovery:[]},
    {auth:false,registered:false,expected:undefined,recovery:publicRecovery},
  ]){
    const f=await fixture(t,{sources:[source(scenario.auth)],registered:scenario.registered}),runtime=new FamilyRuntime(f.store,f.config);
    const result=await runtime.call('runtime_pack_run',{request_id:'read-fixture',recipe:recipe(scenario.browser)});runtime.close();
    assert.equal(result.status,'succeeded');
    const options=fake.opened.at(-1).options;assert.deepEqual(options.preference,scenario.expected);assert.deepEqual(options.fallback_preferences,scenario.recovery);
  }
  const missing=await fixture(t,{sources:[source(true)],registered:false}),runtime=new FamilyRuntime(missing.store,missing.config);
  const result=await runtime.call('runtime_pack_run',{request_id:'no-private-transport',recipe:recipe()});runtime.close();
  assert.equal(result.status,'failed');assert.equal(result.result.error,'BROWSER_NO_ELIGIBLE_EXECUTOR');
  assert.deepEqual(fake.opened.at(-1).options.preference,{environment:'host_foreground',preferred_engine:'aside'});
});

test('runtime contract recurring collection keeps the same public recovery order and remains read-only',async t=>{
  const fake=fakeBrowser(t),f=await fixture(t,{sources:[source(false)]}),runtime=new FamilyRuntime(f.store,f.config);
  const watch={version:1,family:'monitor.watch',request:'Watch fixture table',sources:[{id:'table',parameters:{}}],filters:[],deduplicate_by:[],comparison_fields:['name'],mode:'any_change',value_field:null,interval_seconds:60};
  const result=await runtime.call('runtime_pack_run',{request_id:'watch-fixture',recipe:watch});assert.equal(result.status,'watching');
  const cycle=await runtime.tick(Date.now()+120000);runtime.close();
  assert.equal(cycle.processed.length,1);assert.equal(cycle.processed[0].status,'unchanged');assert.equal(fake.opened.length,2);
  for(const entry of fake.opened)assert.deepEqual(entry.options.fallback_preferences,publicRecovery);
});

function swarmStore(t,f,{url='https://example.test/',browser,workBrowser}={}){
  const definition={id:'worker',objective:'Read one delegated source',effect:'read_only',stage:'source_read',source_urls:[url],max_steps:8,...(browser?{browser}:{})};
  t.mock.method(f.store,'swarmRun',()=>({snapshot:{status:'running',revision:1,plan:{workers:[definition]},workers:{worker:{status:'leased',lease_token:'lease',lease_expires_at_ms:Date.now()+60000}}}}));
  t.mock.method(f.store,'officeWork',()=>workBrowser?{id:'fixture-work'}:null);
  t.mock.method(f.store,'intakeWorkOptional',()=>({spec:{browser:workBrowser}}));
  for(const name of ['bindControlSurface','recordSwarmActivity','endControlSurface','recordObservedUrl'])t.mock.method(f.store,name,()=>{});
  // URL authorization/DNS have separate boundary tests; this contract isolates
  // the caller's browser and profile choices without contacting public sites.
  t.mock.method(RoutedSwarmBrowser.prototype,'url',async value=>new URL(value));
  const pool=new RoutedSwarmBrowser(f.store,f.config);f.cleanups.push(()=>pool.close());return pool;
}

test('runtime contract public Swarm keeps headless first even with a configured guest',async t=>{
  const fake=fakeBrowser(t),f=await fixture(t),pool=swarmStore(t,f);
  await pool.assign('run','worker','lease');
  assert.deepEqual(fake.opened[0].options.preference,{environment:'owned_headless'});
  assert.deepEqual(fake.opened[0].options.fallback_preferences,publicRecovery);
});

test('runtime contract social Swarm binds ready Aside despite a generic headless Work default and records new auth gates',async t=>{
  const fake=fakeBrowser(t),f=await fixture(t),pool=swarmStore(t,f,{url:'https://x.com/home',workBrowser:{environment:'owned_headless'}});
  for(const target of f.config.browserExecutors.targets.filter(target=>target.environment!=='owned_headless'))setSiteAuth(f.store,f.config,'x.com','ready',false,target);
  await pool.perform('run','worker','lease',{action:'observe'});
  const selected=fake.opened[0];assert.deepEqual(selected.options.preference,{environment:'host_foreground',preferred_engine:'aside'});
  assert.deepEqual(selected.config.browserExecutors.targets.map(target=>target.id),['aside']);assert.deepEqual(selected.options.fallback_preferences,[]);
  fake.setObservation({url:'https://x.com/i/flow/login',title:'Login'});
  await assert.rejects(pool.perform('run','worker','lease',{action:'observe'}),/BROWSER_AUTH_REQUIRED/);
  const aside=f.config.browserExecutors.targets.find(target=>target.id==='aside'),neo=f.config.browserExecutors.targets.find(target=>target.id==='neo');
  assert.equal(authSites(f.store,f.config,aside).find(row=>row.site==='x.com').state,'needs_login');
  assert.equal(authSites(f.store,f.config,neo).find(row=>row.site==='x.com').state,'ready');
  await assert.rejects(pool.perform('run','worker','lease',{action:'observe'}),/BROWSER_AUTH_REQUIRED/);assert.equal(fake.opened.length,1,'Authentication failure must not select another account profile');
});

test('runtime contract social Swarm respects an explicit guest and refuses an unverified requested profile',async t=>{
  const fake=fakeBrowser(t),f=await fixture(t),pool=swarmStore(t,f,{url:'https://x.com/home',browser:{environment:'ubuntu_vm',preferred_engine:'playwright'}});
  const aside=f.config.browserExecutors.targets.find(target=>target.id==='aside'),guest=f.config.browserExecutors.targets.find(target=>target.id==='guest');
  setSiteAuth(f.store,f.config,'x.com','ready',false,aside);
  await assert.rejects(pool.assign('run','worker','lease'),/BROWSER_AUTH_REQUIRED/);assert.equal(fake.opened.length,0);
  setSiteAuth(f.store,f.config,'x.com','ready',false,guest);await pool.assign('run','worker','lease');
  assert.deepEqual(fake.opened[0].config.browserExecutors.targets.map(target=>target.id),['guest']);assert.deepEqual(fake.opened[0].options.fallback_preferences,[]);
});
