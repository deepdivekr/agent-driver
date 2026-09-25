import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {chromium} from 'playwright';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {modelSettingsPath,scopedModelSettingsPath,saveModelSettings,readModelSettings,scopedModelConfiguration,modelScopeBase,publicModelSettings} from '../dist/onboarding/model-settings.js';
const choice={mode:'subscription',client:'codex',client_models:{codex:'global-code',claude:'global-review',opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'global-api',api_base_url:'',reasoning:'low',jev:'off'};
const body=(revision,selection=choice,extra={})=>({revision,selection,onboarding_step:3,...extra});
const secret='fixture-key-not-real-1234567890';
async function setup(t){const root=await mkdtemp(join(tmpdir(),'coding-models-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig),path=modelSettingsPath(config);return {root,config,path,coding:scopedModelSettingsPath(path,'coding')}}

test('runtime unit coding settings inherit by default, override only coding, and return to current global values',async t=>{
 const x=await setup(t);saveModelSettings(x.path,body(0),{});const before=await readFile(x.path,'utf8');assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_CODEX_MODEL,'global-code');
 const local={...choice,client_models:{...choice.client_models,codex:'coding-code'}};
 saveModelSettings(x.coding,body(0,local,{inherit_global:false}),{});assert.equal(await readFile(x.path,'utf8'),before);
 assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_CODEX_MODEL,'coding-code');assert.equal(scopedModelConfiguration(x.path,'global',{}).environment.AGENT_DRIVER_CODEX_MODEL,'global-code');
 assert.throws(()=>saveModelSettings(x.coding,body(0,choice),{}),/CONFLICT/);
 saveModelSettings(x.path,body(1,{...choice,client_models:{...choice.client_models,codex:'new-global'}}),{});assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_CODEX_MODEL,'coding-code');
 saveModelSettings(x.coding,body(1,local,{inherit_global:true}),{});assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_CODEX_MODEL,'new-global');
});

test('runtime unit coding API key inheritance is endpoint bound, private, and explicitly removable',async t=>{
 const x=await setup(t);const api={...choice,mode:'api'};saveModelSettings(x.path,body(0,api,{api_action:'replace',api_key:secret}),{});
 const override={...api,api_model:'coding-api'},base=modelScopeBase(x.path,'coding',override,{});
 saveModelSettings(x.coding,body(0,override,{inherit_global:false}),base);
 assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_API_KEY,secret);assert.doesNotMatch(await readFile(x.coding,'utf8'),new RegExp(secret));
 const other={...override,api_provider:'openrouter'};assert.equal(modelScopeBase(x.path,'coding',other,{}).AGENT_DRIVER_API_KEY,undefined);
 assert.throws(()=>saveModelSettings(x.coding,body(1,other),modelScopeBase(x.path,'coding',other,{})),/CREDENTIAL_REQUIRED/);
 const compatible={...api,api_provider:'openai_compatible',api_base_url:'https://provider.example/v1'};
 saveModelSettings(x.path,body(1,compatible),{});assert.equal(modelScopeBase(x.path,'coding',{...compatible,api_base_url:'https://different.example/v1'},{}).AGENT_DRIVER_API_KEY,undefined);
 saveModelSettings(x.coding,body(1,{...override,mode:'subscription'},{api_action:'remove'}),{});assert.equal(scopedModelConfiguration(x.path,'coding',{}).environment.AGENT_DRIVER_API_KEY,undefined);assert.equal(readModelSettings(x.path).api_key,secret);
 const providerChoice={format:1,revision:1,selection:{...choice,api_provider:'anthropic'},onboarding_step:2};assert.equal(publicModelSettings(providerChoice,{ANTHROPIC_API_KEY:secret}).api_key_present,true);assert.equal(publicModelSettings(providerChoice,{OPENAI_API_KEY:secret}).api_key_present,false);
});

test('runtime contract coding planner and advice use scoped models while existing calls and MCP sampling stay pinned',async t=>{
 const x=await setup(t);saveModelSettings(x.path,body(0),{});saveModelSettings(x.coding,body(0,{...choice,client_models:{...choice.client_models,codex:'coding-code'}},{inherit_global:false}),{});
 let release;const gate=new Promise(r=>release=r),seen=[];let blocked=true;
 const model=new ConfiguredStructuredModel(x.path,{}, {subscription:options=>({calls:[],async call(){const result=options.environment.AGENT_DRIVER_CODEX_MODEL;seen.push(result);if(blocked){blocked=false;await gate}return result}})});
 const api=new RuntimeApi(x.config,{swarmModel:model});t.after(async()=>{api.close();await api.drain()});
 assert.equal(api.coding.model.scope,'coding');assert.equal(api.codingDialog.model.scope,'coding');
 const pending=api.coding.model.call('design','',{},{});saveModelSettings(x.coding,body(1,{...choice,client_models:{...choice.client_models,codex:'coding-new'}},{inherit_global:false}),{});release();assert.equal(await pending,'coding-code');
 assert.equal(await api.codingDialog.model.call('correct','',{},{}),'coding-new');assert.equal(await model.call('design','',{},{}),'global-code');assert.deepEqual(seen,['coding-code','coding-new','global-code']);
 const native=new RuntimeApi(x.config);t.after(async()=>{native.close();await native.drain()});const sampling={test:'sampling'};native.attachClientSampling(sampling);assert.equal(native.coding.model.sampling,sampling);assert.equal(native.codingDialog.model.sampling,sampling);
});

test('runtime contract coding API fallback uses coding CLI choice and subscription never falls into paid API',async t=>{
 const x=await setup(t);saveModelSettings(x.path,body(0),{});const scoped={...choice,mode:'api',api_to_subscription:true,api_model:'coding-api',client_models:{...choice.client_models,codex:'coding-code'}};
 saveModelSettings(x.coding,body(0,scoped,{inherit_global:false,api_action:'replace',api_key:secret}),{});let apiCalls=0;const events=[];
 const model=new ConfiguredStructuredModel(x.path,{}, {api:env=>({calls:[],async call(){apiCalls++;this.calls.push({model:env.AGENT_DRIVER_API_MODEL,http_status:429,status:'failed'});throw Error('quota')}}),subscription:options=>({calls:[],async call(){assert.equal(options.subscriptionOnly,true);assert.equal(options.environment.AGENT_DRIVER_CODEX_MODEL,'coding-code');this.calls.push({status:'accepted',provider:'codex',model:'coding-code'});return 'fallback'}})},event=>events.push(event),'coding');
 assert.equal(await model.call('correct','',{},{}),'fallback');assert.equal(apiCalls,1);assert.equal(events[0].source_model,'coding-api');assert.equal(events[0].target_model,'coding-code');
 saveModelSettings(x.coding,body(1,{...scoped,mode:'subscription'}),{});const noPaid=new ConfiguredStructuredModel(x.path,{OPENAI_API_KEY:secret},{api:()=>{throw Error('PAID_API_NOT_ALLOWED')},subscription:options=>({calls:[],async call(){assert.equal(options.fallbackModel,undefined);throw Error('QUOTA')}})},undefined,'coding');await assert.rejects(noPaid.call('correct','',{},{}),/QUOTA/);
});

async function serverFor(t,x){let providerCalls=0;const auth={async connections(){return []},view(){return {state:'idle'}},close(){},async start(){throw Error('not used')}};
 const mcp={async view(){return {registered_count:1,agent_driver:{installed:true},clients:[],windows_bridge:null}}},bootstrap={view(){return {clients:[]}},async install(){throw Error('not used')}};
 const fetcher=async()=>{providerCalls++;return new Response(JSON.stringify({status:'completed',model:'coding-api',output:[{type:'message',content:[{type:'output_text',text:'{"status":"ok","nonce":"agent-driver-provider-probe"}'}]}]}),{status:200})};
 const settings=new ControlSettings(x.config,auth,{},fetcher,mcp,undefined,bootstrap);let host;const server=createServer(async(req,res)=>{if(!await settings.handle(req,res,req.url.slice(1),host)){res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));host='127.0.0.1:'+server.address().port;
 t.after(async()=>{settings.close();server.closeAllConnections();await new Promise(r=>server.close(r))});return {url:'http://'+host,headers:{origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'},calls:()=>providerCalls};
}
test('runtime fixture coding settings HTTP preserves global revisions, requires human origin and API probe',async t=>{
 const x=await setup(t);saveModelSettings(x.path,body(0,{...choice,mode:'api'},{api_action:'replace',api_key:secret}),{});const server=await serverFor(t,x);
 const call=(suffix,value,headers=server.headers)=>fetch(server.url+'/settings/'+suffix,{method:'POST',headers,body:JSON.stringify(value)});
 const payload=body(0,{...choice,mode:'api',api_model:'coding-api'},{inherit_global:false});
 assert.equal((await call('coding/save',payload,{...server.headers,origin:'http://evil.example'})).status,403);
 assert.equal((await call('coding/save',payload)).status,400);assert.equal(server.calls(),0);
 const probe=await(await call('coding/provider-probe',payload)).json();assert.ok(probe.probe_token);assert.equal(server.calls(),1);
 const saved=await(await call('coding/save',{...payload,api_probe_token:probe.probe_token})).json();assert.equal(saved.scope,'coding');assert.equal(saved.inherit_global,false);assert.doesNotMatch(JSON.stringify(saved),new RegExp(secret));assert.equal(readModelSettings(x.path).revision,1);
 assert.equal((await call('save',body(1,choice,{inherit_global:true}))).status,400);
 assert.equal((await call('coding/save',body(1,choice,{inherit_global:true}))).status,200);assert.equal(server.calls(),1);
});

test('runtime fixture coding settings UI persists priority and inheritance on desktop/mobile without model calls',{timeout:60000},async t=>{
 const x=await setup(t);saveModelSettings(x.path,body(0,{...choice,mode:'api'},{api_action:'replace',api_key:secret}),{});const before=await readFile(x.path,'utf8'),server=await serverFor(t,x),browser=await chromium.launch({headless:true});
 t.after(()=>browser.close());await mkdir('tests/evidence/phase66',{recursive:true});
 for(const width of [1440,390]){const page=await browser.newPage({viewport:{width,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));
 await page.route(/\/settings\/(?:coding\/)?models$/,route=>route.fulfill({json:route.request().method()==='POST'?{status:'unavailable',models:[],selected:'global-api'}:{codex:{status:'available',models:[{id:'coding-ui',label:'Coding UI'},{id:'global-code',label:'Global'}]},claude:{status:'available',models:[]},opencode:{status:'available',models:[]}}}));
 await page.goto(server.url+'/settings');await page.locator('[data-step="2"]').click();await page.locator('#model-scope').selectOption('coding');await page.locator('#coding-scope-options').waitFor();await page.waitForFunction(()=>!busy);
 if(!await page.locator('#coding-inherit').isChecked())await page.locator('#coding-inherit').check();await page.locator('#save-model').click();await page.waitForFunction(()=>!busy);assert.equal(await page.locator('#mode').isDisabled(),true);
 await page.locator('#coding-inherit').uncheck();await page.locator('#mode').selectOption('subscription');await page.locator('#codex-model').selectOption('coding-ui');await page.locator('#save-model').click();await page.waitForFunction(()=>!busy&&state.selection.client_models.codex==='coding-ui');
 assert.equal(readModelSettings(x.coding).selection.client_models.codex,'coding-ui');assert.equal(await readFile(x.path,'utf8'),before);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'tests/evidence/phase66/coding-models-'+width+'.png',fullPage:true});
 await page.reload();await page.locator('[data-step="2"]').click();await page.locator('#model-scope').selectOption('coding');await page.waitForFunction(()=>!busy&&modelScope==='coding');assert.equal(await page.locator('#codex-model').inputValue(),'coding-ui');assert.equal(await page.locator('#coding-inherit').isChecked(),false);
 await page.locator('#mode').selectOption('api');await page.locator('#api-model-custom').fill('not a valid model');await page.locator('#api-key').fill('unfinished');await page.locator('#coding-inherit').check();await page.locator('#save-model').click();await page.waitForFunction(()=>!busy);assert.equal(scopedModelConfiguration(x.path,'coding',{}).source,'global');assert.equal(readModelSettings(x.coding).selection.client_models.codex,'coding-ui');await page.locator('[data-step="3"]').click();await page.waitForFunction(()=>modelScope==='global'&&step===3);assert.deepEqual(errors,[]);await page.close();}
 assert.equal(server.calls(),0);assert.equal(await readFile(x.path,'utf8'),before);
});
