import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {McpSamplingStructuredModel,SubscriptionAuthFlowController,SubscriptionAwareStructuredModel,nativeProcessRunner,probeSubscriptionClient,probeSubscriptionClients,resolveSubscriptionClientExecutable} from '../dist/integrations/subscription-auth.js';
import {startModelConnectionScreen} from '../dist/onboarding/model-screen.js';
import {optionalTypeSafeTransportFromHostEnvironment} from '../dist/taskpack/typesafe-jev.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {LlmSwarmPlanner} from '../dist/swarm/planner.js';

const schema={type:'object',additionalProperties:false,required:['choice'],properties:{choice:{type:'string',enum:['A','B']}}};
const fixtureExecutables={
  AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',
  AGENT_DRIVER_OPENCODE_EXECUTABLE:'/fixture/opencode',AGENT_DRIVER_CURSOR_EXECUTABLE:'/fixture/agent',
  AGENT_DRIVER_HERMES_EXECUTABLE:'/fixture/hermes'
};
const fixtureEnvironment=(values={})=>({...fixtureExecutables,...values});
const executableId=request=>request.executable.split('/').at(-1);

test('runtime subscription auth probes client-owned status only and returns no identity or credential material',async()=>{
  const seen=[];const runner={async run(request){seen.push(request);
    if(executableId(request)==='codex')return {code:0,stdout:'Logged in using ChatGPT\n',stderr:''};
    if(executableId(request)==='claude')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'pro',email:'private@example.test',projectsDirectory:'/secret'}),stderr:''};
    if(executableId(request)==='opencode')return {code:0,stdout:JSON.stringify([{provider:'openrouter',credential:'never-return'}]),stderr:''};
    if(executableId(request)==='agent')return {code:0,stdout:'Not authenticated\n',stderr:''};
    return {code:0,stdout:'[nous] Nous Portal — not logged in\n',stderr:''};
  }};
  const result=await probeSubscriptionClients(fixtureEnvironment(),runner);
  assert.deepEqual(result.map(item=>[item.id,item.status]),[['codex','ready'],['claude','ready'],['opencode','ready'],['cursor','unavailable'],['hermes','signed_out']]);
  assert.equal(JSON.stringify(result).includes('private@example.test'),false);assert.equal(JSON.stringify(result).includes('/secret'),false);
  assert.deepEqual(seen.map(item=>item.args),[['login','status'],['auth','status'],['auth','list','--format','json'],['proxy','status']]);
  assert.ok(seen.every(item=>item.stdin===undefined));
});

test('runtime official auth flow exposes only allowlisted device URL and one-time code, then verifies client status',async()=>{
  let finishLogin;let ready=false;const seen=[];
  const runner={async run(request){seen.push(request);
    if(request.args.join(' ')==='login status')return ready?{code:0,stdout:'Logged in using ChatGPT\nprivate@example.test',stderr:''}:{code:1,stdout:'',stderr:'Not logged in'};
    if(request.args.join(' ')==='login --device-auth'){
      request.onStdout?.('Open https://auth.openai.com/codex/device\nDevice code: ABCD-1234\nEmail private@example.test token sk-secret-never-return');
      return new Promise(resolve=>{finishLogin=()=>{ready=true;resolve({code:0,stdout:'private@example.test',stderr:'sk-secret-never-return'});};});
    }
    throw Error('unexpected command');
  }};
  const controller=new SubscriptionAuthFlowController(fixtureEnvironment(),runner),waiting=await controller.start('codex','device');
  assert.deepEqual(waiting,{client_id:'codex',flow:'device',state:'waiting',reason:'waiting_for_device_confirmation',device_url:'https://auth.openai.com/codex/device',user_code:'ABCD-1234',credentials_exposed:false});
  assert.equal(JSON.stringify(waiting).includes('private@example.test'),false);assert.equal(JSON.stringify(waiting).includes('sk-secret'),false);
  assert.deepEqual(seen.slice(0,2).map(item=>item.args),[['login','status'],['login','--device-auth']]);
  assert.ok(seen[1].signal);assert.equal('shell' in seen[1],false);
  finishLogin();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  assert.equal(controller.view('codex').state,'completed');assert.equal(controller.view('codex').reason,'client_reported_ready');controller.close();
});

test('runtime status probe distinguishes an expired client session even when the official status command exits nonzero',async()=>{
  const status=await probeSubscriptionClient('codex',fixtureEnvironment(), {async run(){return {code:1,stdout:'',stderr:'Your session expired. Run codex login again for private@example.test.'};}});
  assert.deepEqual(status,{id:'codex',status:'expired',auth:'unknown',structured_bridge:true,reason:'client_reported_expired'});
  assert.equal(JSON.stringify(status).includes('private@example.test'),false);
});

test('runtime auth flow does not guess an unsupported Cursor login contract',async()=>{
  let calls=0;const controller=new SubscriptionAuthFlowController({}, {async run(){calls++;throw Error('must not run');}});
  assert.deepEqual(await controller.start('cursor','browser'),{client_id:'cursor',flow:'browser',state:'unavailable',reason:'login_contract_unavailable',credentials_exposed:false});
  assert.equal(calls,0);
});

test('runtime auth process runner passes metacharacters as an argument instead of invoking a shell',async()=>{
  const literal='$(printf should-not-execute)';const result=await nativeProcessRunner.run({executable:process.execPath,args:['-e','process.stdout.write(process.argv[1])',literal],timeout_ms:2_000});
  assert.equal(result.code,0);assert.equal(result.stdout,literal);
});

test('runtime WSL resolver ignores Windows PATH shims and selects a WSL-native subscription client',async t=>{
  const root=await mkdtemp(join(tmpdir(),'agent-driver-wsl-client-')),nativeBin=join(root,'.npm-global','bin');
  await mkdir(nativeBin,{recursive:true});await writeFile(join(nativeBin,'codex'),'#!/bin/sh\nexit 0\n',{mode:0o700});t.after(()=>rm(root,{recursive:true,force:true}));
  const environment={WSL_DISTRO_NAME:'Ubuntu-24.04',HOME:root,PATH:'/usr/bin:/mnt/c/Users/test/AppData/Roaming/npm'};
  assert.equal(resolveSubscriptionClientExecutable('codex',environment),join(nativeBin,'codex'));
});

test('runtime WSL resolver fails closed instead of binding a Windows-only CLI shim',()=>{
  const environment={WSL_DISTRO_NAME:'Ubuntu-24.04',HOME:'/nonexistent-agent-driver-home',PATH:'/usr/bin:/mnt/c/Users/test/AppData/Roaming/npm'};
  assert.throws(()=>resolveSubscriptionClientExecutable('codex',environment),/WSL_NATIVE_CLIENT_EXECUTABLE_NOT_FOUND/);
});

test('runtime WSL probe explains that the native client is missing without exposing the foreign path',async()=>{
  const environment={WSL_DISTRO_NAME:'Ubuntu-24.04',HOME:'/nonexistent-agent-driver-home',PATH:'/mnt/c/Users/private/AppData/Roaming/npm'};
  const status=await probeSubscriptionClient('codex',environment,{async run(){throw Error('must not dispatch');}});
  assert.equal(status.status,'unavailable');assert.equal(status.reason,'wsl_native_client_not_found');assert.equal(JSON.stringify(status).includes('/mnt/c/Users/private'),false);
});

test('runtime local connection UI starts Claude-owned browser login and never returns CLI identity output',async t=>{
  let finishLogin;let claudeReady=false;const seen=[];
  const runner={async run(request){seen.push(request);const command=executableId(request)+' '+request.args.join(' ');
    if(command==='codex login status')return {code:1,stdout:'Not logged in',stderr:''};
    if(command==='claude auth status')return {code:0,stdout:JSON.stringify({loggedIn:claudeReady,authMethod:claudeReady?'claude.ai':null,email:'private@example.test'}),stderr:''};
    if(command==='hermes proxy status')return {code:0,stdout:'[nous] Nous Portal — not logged in',stderr:''};
    if(command==='claude auth login --claudeai'){request.onStdout?.('Continue in browser as private@example.test with token secret-value');return new Promise(resolve=>{finishLogin=()=>{claudeReady=true;resolve({code:0,stdout:'private@example.test',stderr:'secret-value'});};});}
    throw Error('unexpected '+command);
  }};
  const controller=new SubscriptionAuthFlowController(fixtureEnvironment(),runner),screen=await startModelConnectionScreen(10_000,{authController:controller});void screen.connected.catch(()=>undefined);t.after(()=>screen.close());
  const page=await (await fetch(screen.url)).text(),token=page.match(/name="token" value="([a-f0-9]+)"/u)?.[1];assert.ok(token);
  assert.match(page,/Codex/u);assert.match(page,/Claude Code/u);assert.match(page,/기기 코드로 연결/u);assert.match(page,/브라우저로 연결/u);assert.match(page,/Jev API 키[^<]*<small>선택 사항/u);
  assert.equal(page.includes('private@example.test'),false);
  const response=await fetch(new URL('/client-connect',screen.url),{method:'POST',headers:{origin:new URL(screen.url).origin},body:new URLSearchParams({token,client:'claude',flow:'browser'})});
  assert.equal(response.status,202);const waiting=await response.json();assert.equal(waiting.state,'waiting');assert.equal(JSON.stringify(waiting).includes('private@example.test'),false);
  assert.ok(seen.some(item=>executableId(item)==='claude'&&item.args.join(' ')==='auth login --claudeai'));
  finishLogin();await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));
  const completed=await (await fetch(new URL('/client-flow?id=claude',screen.url))).json();assert.equal(completed.state,'completed');assert.equal(JSON.stringify(completed).includes('private@example.test'),false);
});

test('runtime subscription model uses MCP client sampling first without tools or server context',async()=>{
  let request;const sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(params){request=params;return {model:'client-subscription-model',stopReason:'endTurn',content:{type:'text',text:'{"choice":"A"}'}};}});
  let probes=0;const runner={async run(){probes++;throw Error('not installed');}},model=new SubscriptionAwareStructuredModel({environment:{AGENT_DRIVER_LLM_CLIENT:'mcp'},runner,sampling});
  assert.deepEqual(await model.call('correct','Choose one.',{value:1},schema),{choice:'A'});
  assert.equal(request.includeContext,'none');assert.equal('tools' in request,false);assert.equal(request.temperature,0);
  assert.equal(probes,0);
  assert.equal(model.calls[0].provider,'mcp_sampling');assert.equal(model.calls[0].auth,'client_subscription');
});

test('runtime subscription model falls from failed Codex to Claude while preserving no-tools structured contracts',async()=>{
  const invocations=[];const runner={async run(request){invocations.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT\n',stderr:''};
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',subscriptionType:'max'}),stderr:''};
    if(request.args.join(' ')==='status')return {code:1,stdout:'',stderr:''};
    if(request.args.join(' ')==='proxy status')return {code:1,stdout:'',stderr:''};
    if(executableId(request)==='codex'&&request.args[0]==='exec')return {code:1,stdout:'',stderr:'private provider failure'};
    if(executableId(request)==='claude'&&request.args[0]==='-p')return {code:0,stdout:JSON.stringify({is_error:false,structured_output:{choice:'B'},email:'never-return'}),stderr:''};
    throw Error('unexpected');
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex,claude'}),runner});
  assert.deepEqual(await model.call('correct','Choose one.',{},schema),{choice:'B'});
  const claude=invocations.find(item=>executableId(item)==='claude'&&item.args[0]==='-p');
  assert.ok(claude.args.includes('--tools'));assert.ok(claude.args.includes('--no-session-persistence'));assert.equal(claude.args.includes('--safe-mode'),false);
  const codex=invocations.find(item=>executableId(item)==='codex'&&item.args[0]==='exec');
  assert.ok(codex.args.includes('--ephemeral'));assert.ok(codex.args.includes('--sandbox'));assert.ok(codex.args.includes('read-only'));assert.ok(codex.args.includes('--ignore-rules'));
  assert.deepEqual(model.calls.map(item=>[item.provider,item.status]),[['codex','failed'],['claude','accepted']]);
  assert.equal(JSON.stringify(model.calls).includes('private provider failure'),false);
});

test('runtime OpenCode bridge reuses its configured provider but denies every tool and validates JSON output',async()=>{
  let projectConfig;const runner={async run(request){
    if(request.args.join(' ')==='auth list --format json')return {code:0,stdout:'[{"provider":"openrouter"}]',stderr:''};
    assert.equal(request.args[0],'run');assert.ok(request.args.includes('--format'));projectConfig=JSON.parse(await readFile(join(request.cwd,'opencode.json'),'utf8'));
    return {code:0,stdout:JSON.stringify({type:'text',part:{type:'text',text:'{"choice":"A"}'}})+'\n',stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'opencode',AGENT_DRIVER_OPENCODE_MODEL:'openrouter/test-model'}),runner});
  assert.deepEqual(await model.call('correct','Choose.',{},schema),{choice:'A'});assert.deepEqual(projectConfig.permission,{'*':'deny'});assert.equal(projectConfig.share,'disabled');
  assert.deepEqual(model.calls.map(item=>[item.provider,item.model,item.status]),[['opencode','openrouter/test-model','accepted']]);
});

test('runtime Codex schema transport removes nested URI annotations without mutating original constraints, literals, prompt or hash',async()=>{
  const original={type:'object',additionalProperties:false,required:['workers'],properties:{workers:{type:'array',minItems:2,maxItems:8,items:{type:'object',required:['source_urls'],additionalProperties:false,properties:{source_urls:{type:'array',items:{type:'string',format:'uri',maxLength:2000,pattern:'^https://'}},relative:{anyOf:[{type:'string',format:'uri-reference'},{type:'null'}]},timestamp:{type:'string',format:'date-time'},format:{const:'uri'},metadata:{const:{format:'uri',example:1},enum:[{format:'uri-reference',example:2}]}}}}},$defs:{reference:{type:'string',format:'uri-reference'}},allOf:[{properties:{more:{type:'array',prefixItems:[{type:'string',format:'uri'}]}}}]};
  const before=structuredClone(original),freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(original);
  const instructions='Return bounded source URLs.',input={topic:'ASTS'};let transported,stdin;
  const runner={async run(request){
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    assert.equal(request.args[0],'exec');transported=JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema')+1],'utf8'));stdin=request.stdin;
    return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{"workers":[]}'}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});
  await model.call('design',instructions,input,original);
  const expected=structuredClone(before);delete expected.properties.workers.items.properties.source_urls.items.format;delete expected.properties.workers.items.properties.relative.anyOf[0].format;delete expected.$defs.reference.format;delete expected.allOf[0].properties.more.prefixItems[0].format;
  assert.deepEqual(transported,expected);assert.deepEqual(original,before);
  assert.ok(stdin.includes('SCHEMA:\n'+JSON.stringify(original)+'\nINPUT:'));
  assert.equal(model.calls[0].input_sha256,hashJson({instructions,input,schema:original}));
});

test('Claude exact JSON fences are accepted, but surrounding prose and multiple blocks are rejected',async()=>{
  for(const [result,accepted] of [['```json\n{"choice":"A"}\n```',true],['Here is JSON\n```json\n{"choice":"A"}\n```',false],['```json\n{}\n```\n```json\n{}\n```',false]]){
    const runner={async run(request){return {code:0,stdout:JSON.stringify(request.args.join(' ')==='auth status'?{loggedIn:true,authMethod:'claude.ai'}:{is_error:false,result}),stderr:''};}};
    const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'claude'}),runner});
    if(accepted)assert.deepEqual(await model.call('design','Choose.',{},schema),{choice:'A'});
    else await assert.rejects(model.call('design','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
  }
});

test('runtime URI transport compatibility is Codex-only and leaves Claude structured schema unchanged',async()=>{
  const original={type:'object',properties:{url:{type:'string',format:'uri'}},additionalProperties:false,required:['url']};let transported;
  const runner={async run(request){
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai'}),stderr:''};
    transported=JSON.parse(request.args[request.args.indexOf('--json-schema')+1]);
    return {code:0,stdout:JSON.stringify({is_error:false,structured_output:{url:'https://example.test/'}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'claude'}),runner});
  await model.call('design','Return one URL.',{},original);assert.deepEqual(transported,original);assert.equal(transported.properties.url.format,'uri');
});

test('runtime Codex transport normalization does not authorize an invalid URL returned to the Swarm planner',async()=>{
  const worker=id=>({id,role:id,objective:'Read one source.',stage:'source_read',source_urls:['not a valid URL'],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Source readback.'],max_steps:4,timeout_ms:10_000}),draft={summary:'Bounded source review.',workers:[worker('first'),worker('second')]};
  const runner={async run(request){
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    const transported=JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema')+1],'utf8'));
    assert.equal(transported.properties.workers.items.properties.source_urls.items.format,undefined);
    return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(draft)}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner}),planner=new LlmSwarmPlanner(model);
  await assert.rejects(planner.plan('Read and verify sources.',{},{max_workers:4,max_concurrency:2,capabilities:[]}),/Invalid URL/u);
  assert.equal(model.calls[0].status,'accepted'); // Provider returned JSON; the domain validator still rejected the plan.
});

test('runtime optional Jev treats a missing key as a supported LLM-direct mode and rejects malformed configured keys',()=>{
  assert.deepEqual(optionalTypeSafeTransportFromHostEnvironment({}),{status:'skipped_not_configured',transport:null,reason:'api_key_absent'});
  assert.deepEqual(optionalTypeSafeTransportFromHostEnvironment({TYPESAFE_API_KEY:'  '}),{status:'skipped_not_configured',transport:null,reason:'api_key_absent'});
  assert.throws(()=>optionalTypeSafeTransportFromHostEnvironment({TYPESAFE_API_KEY:'short'}),/TYPESAFE_CREDENTIAL_INVALID/);
  const ready=optionalTypeSafeTransportFromHostEnvironment({TYPESAFE_API_KEY:'fixture-jev-key-long-enough'});assert.equal(ready.status,'ready');assert.ok(ready.transport);
});

test('runtime subscription model fails typed when no subscription or configured fallback exists',async()=>{
  const runner={async run(){throw Error('missing');}},model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex,claude,cursor,api'}),runner});
  await assert.rejects(model.call('correct','Choose one.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);
  const status=await model.status();assert.equal(status.credentials_exposed,false);assert.equal(status.fallback,'not_configured');
});
