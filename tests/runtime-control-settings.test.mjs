import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {Script} from 'node:vm';
import {createServer} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {modelSettingsPath,readModelSettings,saveModelSettings,publicModelSettings,effectiveModelEnvironment} from '../dist/onboarding/model-settings.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {prepareLocalConnection,approveNonInterferingConnection,readLocalConnection,approvedMcpConfigPath} from '../dist/onboarding/connection.js';
import {ensureControlService,validControlUrl} from '../dist/onboarding/control-service.js';
import {ControlSettings} from '../dist/observability/control-settings.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {SubscriptionAuthFlowController} from '../dist/integrations/subscription-auth.js';

const secret='fixture-key-not-a-real-secret-12345678';
const selection={mode:'subscription',client:'codex',api_provider:'openai',api_model:'gpt-5.6-luna',api_base_url:'',reasoning:'low',jev:'off'};
const update=(revision,extra={})=>({revision,selection,onboarding_step:1,...extra});
async function setup(t){const root=await mkdtemp(join(tmpdir(),'driver-settings-'));t.after(()=>rm(root,{recursive:true,force:true}));const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);return {root,paths,config,path:modelSettingsPath(config)};}

test('runtime native settings transactions persist selection but never return keys and enforce revision/private storage',async t=>{
  const x=await setup(t),result=saveModelSettings(x.path,update(0,{openai_action:'replace',openai_key:secret}),{});
  assert.equal(result.revision,1);assert.equal(result.openai_key_present,true);assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));assert.equal((await stat(x.path)).mode&0o077,0);
  assert.equal((await stat(dirname(x.path))).mode&0o077,0);
  assert.throws(()=>saveModelSettings(x.path,update(0),{}),/MODEL_SETTINGS_CONFLICT/);
  const second=saveModelSettings(x.path,update(1,{selection:{...selection,mode:'api'}}),{});assert.equal(second.selection.mode,'api');
  saveModelSettings(x.path,update(2,{api_action:'remove'}),{OPENAI_API_KEY:secret});const saved=readModelSettings(x.path);assert.equal(saved.api_key,null);assert.equal(effectiveModelEnvironment(saved,{OPENAI_API_KEY:secret}).OPENAI_API_KEY,undefined);
  assert.equal(publicModelSettings(saved,{OPENAI_API_KEY:secret}).openai_key_present,false);
});
test('runtime legacy OpenAI settings load with provider defaults and migrate the secret without loss or echo',async t=>{
  const x=await setup(t),legacy={format:1,revision:1,selection:{mode:'api',client:'auto',api_model:'gpt-5.6-luna',reasoning:'low',jev:'off'},onboarding_step:1,openai_key:secret,jev_key:null};await mkdir(dirname(x.path),{recursive:true,mode:0o700});await writeFile(x.path,JSON.stringify(legacy),{mode:0o600});
  const loaded=readModelSettings(x.path);assert.equal(loaded.selection.api_provider,'openai');assert.equal(loaded.selection.api_base_url,'');assert.equal(effectiveModelEnvironment(loaded,{}).AGENT_DRIVER_API_KEY,secret);
  const result=saveModelSettings(x.path,update(1,{selection:{...selection,mode:'api'}}),{});const migrated=readModelSettings(x.path);assert.equal(result.api_key_stored,true);assert.equal(migrated.api_key,secret);assert.equal(migrated.openai_key,undefined);assert.doesNotMatch(JSON.stringify(result),new RegExp(secret));
});
test('runtime settings missing keys invalid input and symlink are rejected without changing the previous revision',async t=>{
  const x=await setup(t);assert.throws(()=>saveModelSettings(x.path,update(0,{selection:{...selection,mode:'api'}}),{}),/MODEL_PROVIDER_CREDENTIAL_REQUIRED/);
  assert.throws(()=>saveModelSettings(x.path,update(0,{selection:{...selection,jev:'on'}}),{}),/JEV_CREDENTIAL_REQUIRED/);
  assert.throws(()=>saveModelSettings(x.path,update(0,{openai_key:secret}),{}),/MODEL_KEY_ACTION_INVALID/);
  assert.equal(readModelSettings(x.path),null);const target=join(x.root,'target');await writeFile(target,'unchanged');await symlink(target,x.path);
  assert.throws(()=>saveModelSettings(x.path,update(0),{}),/MODEL_SETTINGS_UNSAFE_FILE/);assert.equal(await readFile(target,'utf8'),'unchanged');
});
test('runtime contract model switching applies next call across model instances and preserves in-flight provider',async t=>{
  const x=await setup(t);let release;const gate=new Promise(resolve=>release=resolve),seen=[];
  const factories={subscription:options=>({calls:[],async call(){seen.push({kind:'subscription',fallback:Boolean(options.fallbackModel),clients:options.environment.AGENT_DRIVER_LLM_CLIENT});await gate;return 'subscription';}}),api:env=>({calls:[],async call(){seen.push({kind:'api',model:env.AGENT_DRIVER_API_MODEL});return 'api';}})};
  saveModelSettings(x.path,update(0),{OPENAI_API_KEY:secret});const a=new ConfiguredStructuredModel(x.path,{OPENAI_API_KEY:secret},factories),b=new ConfiguredStructuredModel(x.path,{OPENAI_API_KEY:secret},factories),inFlight=a.call('correct','',{},{});
  saveModelSettings(x.path,update(1,{selection:{...selection,mode:'api'}}),{OPENAI_API_KEY:secret});assert.equal(await b.call('correct','',{},{}),'api');release();assert.equal(await inFlight,'subscription');assert.equal(await a.call('correct','',{},{}),'api');assert.deepEqual(seen.map(item=>item.kind),['subscription','api','api']);assert.equal(seen[0].fallback,false);
  saveModelSettings(x.path,update(2),{OPENAI_API_KEY:secret});assert.equal(await a.call('correct','',{},{}),'subscription');
});
test('runtime configured Pack and Swarm model reads a changed non-OpenAI provider on the next call',async t=>{
  const x=await setup(t),seen=[],factories={subscription:()=>{throw Error('not used');},api:env=>({calls:[],async call(){seen.push({provider:env.AGENT_DRIVER_API_PROVIDER,model:env.AGENT_DRIVER_API_MODEL,base:env.AGENT_DRIVER_API_BASE_URL});return env.AGENT_DRIVER_API_PROVIDER;}})};
  saveModelSettings(x.path,update(0,{selection:{...selection,mode:'api',api_provider:'openrouter',api_model:'anthropic/claude-sonnet-4.5'},api_action:'replace',api_key:secret}),{});const model=new ConfiguredStructuredModel(x.path,{},factories);assert.equal(await model.call('design','',{},{}),'openrouter');
  saveModelSettings(x.path,update(1,{selection:{...selection,mode:'api',api_provider:'anthropic',api_model:'claude-sonnet-4-5'}}),{});assert.equal(await model.call('correct','',{},{}),'anthropic');assert.deepEqual(seen,[{provider:'openrouter',model:'anthropic/claude-sonnet-4.5',base:undefined},{provider:'anthropic',model:'claude-sonnet-4-5',base:undefined}]);
});
test('runtime contract subscription error cannot silently spend API credit after explicit subscription selection',async t=>{
  const x=await setup(t);saveModelSettings(x.path,update(0),{OPENAI_API_KEY:secret});let apiCalls=0;
  const model=new ConfiguredStructuredModel(x.path,{OPENAI_API_KEY:secret},{api:()=>{apiCalls++;throw Error('should not construct');},subscription:options=>{assert.equal(options.fallbackModel,undefined);return {calls:[],async call(){throw Error('SIGNED_OUT');}};}});
  await assert.rejects(model.call('correct','',{},{}),/SIGNED_OUT/);assert.equal(apiCalls,0);
});
test('runtime native preparation and repeated computer approval preserve existing runtime config and connection identity',async t=>{
  const x=await setup(t);assert.equal(readLocalConnection(x.root),null);assert.throws(()=>approvedMcpConfigPath(x.root),/COMPUTER_CONNECTION_REQUIRED/);
  const config=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));config.swarm={enabled:true,model_data_approved:true};await writeFile(x.paths.runtimeConfig,JSON.stringify(config));
  const first=await approveNonInterferingConnection(x.root);await prepareLocalConnection(x.root);const again=await approveNonInterferingConnection(x.root);assert.equal(first.state.connection_id,again.state.connection_id);assert.deepEqual(JSON.parse(await readFile(x.paths.runtimeConfig,'utf8')),config);
});
test('runtime native settings HTTP gates writes by capability origin header and body limit, with no secret echo',async t=>{
  const x=await setup(t),server=await startControlCenter(x.config);t.after(()=>server.close());const origin=new URL(server.url).origin,url=server.url+'settings';
  const page=await fetch(url),html=await page.text();assert.equal(page.status,200);assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);assert.doesNotThrow(()=>new Script(html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/u)[1]));
  const headers={'content-type':'application/json','X-Agent-Driver':'human-settings',origin},payload=update(0,{openai_action:'replace',openai_key:secret});
  assert.equal((await fetch(url+'/save',{method:'POST',body:JSON.stringify(payload)})).status,403);
  assert.equal((await fetch(url+'/save',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify(payload)})).status,403);
  const response=await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,200);assert.doesNotMatch(await response.text(),new RegExp(secret));
  assert.equal((await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify(payload)})).status,409);
  assert.equal((await fetch(url+'/save',{method:'POST',headers,body:'x'.repeat(20_001)})).status,413);
  assert.equal((await fetch(new URL('/settings/save',url),{method:'POST',headers,body:'{}'})).status,404);
  const status=await (await fetch(url+'/status')).json();assert.equal(status.computer.connected,false);assert.equal(status.selection.mode,'subscription');assert.doesNotMatch(JSON.stringify(status),new RegExp(secret));
  assert.equal((await fetch(url+'/computer',{method:'POST',headers,body:JSON.stringify({mode:'non_interfering'})})).status,200);assert.ok(readLocalConnection(x.root));
});
test('runtime API settings require a fresh exact provider probe before the local UI can persist them',async t=>{
  const x=await setup(t),fetcher=async(url,options)=>{assert.equal(String(url),'https://openrouter.ai/api/v1/chat/completions');const body=JSON.parse(String(options.body));assert.equal(body.provider.require_parameters,true);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:'{"status":"ok","nonce":"agent-driver-provider-probe"}'}}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200});};
  const settings=new ControlSettings(x.config,{connections:async()=>[],view:()=>({state:'idle'}),start:async()=>({state:'idle'}),close(){}},{},fetcher);let host;const server=createServer((req,res)=>void settings.handle(req,res,req.url.slice(1),host));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;t.after(async()=>{settings.close();await new Promise(resolve=>server.close(resolve));});
  const url='http://'+host+'/settings',headers={origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'},payload=update(0,{selection:{...selection,mode:'api',api_provider:'openrouter',api_model:'openai/gpt-5-mini'},api_action:'replace',api_key:secret});
  let response=await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,400);assert.equal((await response.json()).error,'MODEL_PROVIDER_PROBE_REQUIRED');assert.equal(readModelSettings(x.path),null);
  response=await fetch(url+'/provider-probe',{method:'POST',headers,body:JSON.stringify(payload)});assert.equal(response.status,200);const probe=await response.json();assert.equal(probe.status,'ready');assert.doesNotMatch(JSON.stringify(probe),new RegExp(secret));
  response=await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify({...payload,api_probe_token:probe.probe_token})});assert.equal(response.status,200);const saved=readModelSettings(x.path);assert.equal(saved.selection.api_provider,'openrouter');assert.equal(saved.api_verification.provider,'openrouter');assert.equal(publicModelSettings(saved,{}).api_connection,'ready');
  response=await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify(update(1,{selection:{...selection,mode:'api',api_provider:'openrouter',api_model:'openai/gpt-5-mini'},onboarding_step:2}))});assert.equal(response.status,200);assert.equal(readModelSettings(x.path).api_verification.provider,'openrouter');
  response=await fetch(url+'/save',{method:'POST',headers,body:JSON.stringify(update(2,{selection:{...selection,mode:'api',api_provider:'anthropic',api_model:'claude-sonnet-4-5'}}))});assert.equal(response.status,400);assert.equal((await response.json()).error,'MODEL_PROVIDER_PROBE_REQUIRED');
});
test('runtime contract unified auth routes use official CLI device flow without returning raw output',async t=>{
  const x=await setup(t);let starts=0;const auth=new SubscriptionAuthFlowController({AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex'}, {async run(request){if(request.args.join(' ')==='login status')return {code:1,stdout:'Not logged in',stderr:''};if(request.args.join(' ')==='login --device-auth'){starts++;request.onStdout?.('https://auth.openai.com/codex/device Device code: ABCD-1234 private@example.test '+secret);return new Promise(resolve=>request.signal.addEventListener('abort',()=>resolve({code:1,stdout:'',stderr:''})));}return {code:1,stdout:'',stderr:''};}});
  const settings=new ControlSettings(x.config,auth,{});let host;const server=createServer((req,res)=>void settings.handle(req,res,req.url.slice(1),host));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;t.after(async()=>{settings.close();await new Promise(resolve=>server.close(resolve));});
  const url='http://'+host+'/settings',headers={origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'};
  const response=await fetch(url+'/login',{method:'POST',headers,body:JSON.stringify({client:'codex',flow:'device'})}),flow=await response.json();assert.equal(response.status,202);assert.equal(flow.device_url,'https://auth.openai.com/codex/device');assert.equal(flow.user_code,'ABCD-1234');assert.doesNotMatch(JSON.stringify(flow),/private@example|fixture-key/);
  await fetch(url+'/login',{method:'POST',headers,body:JSON.stringify({client:'codex',flow:'device'})});assert.equal(starts,1);
});
test('runtime contract control settings exposes guided client bootstrap and installs only after a local user POST',async t=>{
  const x=await setup(t);let installs=0;const client={id:'codex',label:'Codex',docs_url:'https://learn.chatgpt.com/docs/codex/cli',installer_url:'https://chatgpt.com/codex/install.sh',install_command:'curl -fsSL https://chatgpt.com/codex/install.sh | sh',auth_guide_url:'https://learn.chatgpt.com/docs/auth',installed:false,managed_install:true,reason:'not_installed',credentials_exposed:false};
  const bootstrap={view(){return {clients:[client],credentials_exposed:false};},async install(id,onStage){assert.equal(id,'codex');installs++;for(const stage of ['downloading','running','verifying'])await onStage(stage);return {clients:[{...client,installed:true,reason:'installed'}],credentials_exposed:false};}};
  const auth={async connections(){return [{id:'codex',status:'unavailable',auth:'unknown',structured_bridge:true,reason:'client_not_available',supported_login_flows:['device'],connection:{client_id:'codex',flow:null,state:'idle',reason:'not_started',credentials_exposed:false}}];},view(){return {state:'idle'};},async start(){throw Error('not used');},close(){}};
  const settings=new ControlSettings(x.config,auth,{},fetch,undefined,undefined,bootstrap);let host;const server=createServer((req,res)=>void settings.handle(req,res,req.url.slice(1),host));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));host='127.0.0.1:'+server.address().port;t.after(async()=>{settings.close();await new Promise(resolve=>server.close(resolve));});
  const url='http://'+host+'/settings',headers={origin:'http://'+host,'content-type':'application/json','x-agent-driver':'human-settings'};const view=await (await fetch(url+'/bootstrap')).json();assert.equal(view.clients[0].installed,false);assert.equal(installs,0);
  assert.equal((await fetch(url+'/client/install',{method:'POST',headers:{...headers,origin:'https://evil.test'},body:JSON.stringify({client:'codex'})})).status,403);assert.equal(installs,0);
  const response=await fetch(url+'/client/install',{method:'POST',headers,body:JSON.stringify({client:'codex'})});assert.equal(response.status,200);assert.equal(installs,1);assert.doesNotMatch(await response.text(),/token|password|secret/iu);
});
test('runtime native detached control service survives launcher completion and is reused without overwriting config',async t=>{
  const x=await setup(t),first=await ensureControlService(x.root);t.after(async()=>{try{process.kill(first.pid,'SIGTERM');}catch{}for(let i=0;i<40;i++){try{await fetch(first.url,{signal:AbortSignal.timeout(100)});}catch{return;}await delay(50);}});
  assert.equal(first.reused,false);assert.equal(validControlUrl(first.url),true);assert.equal(validControlUrl('https://evil.test/'),false);
  const second=await ensureControlService(x.root);assert.equal(second.pid,first.pid);assert.equal(second.reused,true);assert.equal(readLocalConnection(x.root),null);assert.equal((await fetch(first.url+'settings/status')).status,200);
});
test('runtime contract existing RuntimeApi observes saved Jev toggles without restart and no API call is needed',async t=>{
  const x=await setup(t),config=JSON.parse(await readFile(x.paths.runtimeConfig,'utf8'));config.swarm={enabled:true,model_data_approved:true};await writeFile(x.paths.runtimeConfig,JSON.stringify(config));const api=new RuntimeApi(loadHostConfig(x.paths.runtimeConfig));t.after(()=>api.close());
  saveModelSettings(x.path,update(0,{selection:{...selection,jev:'on'},jev_action:'replace',jev_key:secret}),{});await assert.rejects(api.call('runtime_swarm_status',{run_id:'missing'}));assert.equal(api.swarm.providers.decision.id,'typesafe-jev');
  saveModelSettings(x.path,update(1),{});await assert.rejects(api.call('runtime_swarm_status',{run_id:'missing'}));assert.equal(api.swarm.providers.decision,undefined);
});
