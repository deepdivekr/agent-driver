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
import {z} from 'zod';

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
    if(executableId(request)==='claude')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'pro',email:'private@example.test',projectsDirectory:'/secret'}),stderr:''};
    if(executableId(request)==='opencode')return {code:0,stdout:'┌ Credentials\n│ OpenRouter api\n└ 1 credentials',stderr:''};
    if(executableId(request)==='agent')return {code:0,stdout:JSON.stringify({status:'unauthenticated',isAuthenticated:false,hasAccessToken:false}),stderr:''};
    return {code:0,stdout:'[nous] Nous Portal — not logged in\n',stderr:''};
  }};
  const result=await probeSubscriptionClients(fixtureEnvironment(),runner);
  assert.deepEqual(result.map(item=>[item.id,item.status]),[['codex','ready'],['claude','ready'],['opencode','ready'],['cursor','signed_out'],['hermes','signed_out']]);
  assert.equal(JSON.stringify(result).includes('private@example.test'),false);assert.equal(JSON.stringify(result).includes('/secret'),false);
  assert.deepEqual(seen.map(item=>item.args),[['login','status'],['auth','status'],['auth','list'],['status','--format','json'],['proxy','status']]);
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

test('runtime auth flow fails closed when the installed Cursor executable cannot report its official status',async()=>{
  let calls=0;const controller=new SubscriptionAuthFlowController({}, {async run(){calls++;throw Error('must not run');}});
  const view=await controller.start('cursor','browser');assert.equal(view.state,'unavailable');assert.equal(view.credentials_exposed,false);
  assert.ok(calls<=1);
});

test('runtime auth process runner passes metacharacters as an argument instead of invoking a shell',async()=>{
  const literal='$(printf should-not-execute)';const result=await nativeProcessRunner.run({executable:process.execPath,args:['-e','process.stdout.write(process.argv[1])',literal],timeout_ms:2_000});
  assert.equal(result.code,0);assert.equal(result.stdout,literal);
});

test('runtime contract Cursor browser login uses its installed official CLI, typed status and an allowlisted URL without a model call',async()=>{
  let finish,ready=false;const requests=[];
  const runner={async run(request){requests.push(request);if(request.args[0]==='status')return {code:0,stdout:JSON.stringify({status:ready?'authenticated':'unauthenticated',isAuthenticated:ready,hasAccessToken:ready,email:'private@example.test'}),stderr:''};
    assert.deepEqual(request.args,['login']);assert.equal(request.login_browser,'ui');
    request.onStdout?.('Open https://evil.test/login and https://cursor.com/loginDeepControl?mode=login&redirectTarget=cli&uuid=fixture&challenge=fixture\nsecret never returned');
    return new Promise(resolve=>finish=()=>{ready=true;resolve({code:0,stdout:'private@example.test',stderr:''});});}};
  const controller=new SubscriptionAuthFlowController(fixtureEnvironment(),runner);const view=await controller.start('cursor','browser');
  assert.equal(view.state,'waiting');assert.match(view.auth_url,/^https:\/\/cursor\.com\/loginDeepControl\?/u);assert.doesNotMatch(JSON.stringify(view),/evil|private@example|secret/u);
  finish();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(controller.view('cursor').state,'completed');assert.equal(requests.length,3);controller.close();
});

test('runtime contract OpenCode device login chooses the official ChatGPT OAuth method and only exposes its device code',async()=>{
  let finish,ready=false;const runner={async run(request){if(request.args.join(' ')==='auth list')return {code:0,stdout:'┌ Credentials\n└ '+(ready?'1':'0')+' credentials',stderr:''};
    assert.deepEqual(request.args,['auth','login','--provider','openai','--method','ChatGPT Pro/Plus (headless)']);request.onStdout?.('\u001b[0mhttps://auth.openai.com/codex/device\nEnter code: ABCD-1234\n');
    return new Promise(resolve=>finish=()=>{ready=true;resolve({code:0,stdout:'',stderr:''});});}};
  const controller=new SubscriptionAuthFlowController(fixtureEnvironment(),runner),view=await controller.start('opencode','device');assert.equal(view.device_url,'https://auth.openai.com/codex/device');assert.equal(view.user_code,'ABCD-1234');
  finish();await new Promise(r=>setImmediate(r));await new Promise(r=>setImmediate(r));assert.equal(controller.view('opencode').state,'completed');controller.close();
});

test('runtime contract Cursor incomplete status and externally injected API authentication remain unknown',async()=>{
  for(const value of [{status:'authenticated',isAuthenticated:true},{status:'authenticated',isAuthenticated:true,hasAccessToken:true,usingApiKeyFromEnv:true},{status:'authenticated',isAuthenticated:true,hasAccessToken:true,usingAuthTokenFromEnv:true}]){const status=await probeSubscriptionClient('cursor',fixtureEnvironment(),{async run(){return {code:0,stdout:JSON.stringify(value),stderr:''};}});assert.equal(status.status,'unknown');}
  const status=await probeSubscriptionClient('opencode',fixtureEnvironment(),{async run(){return {code:0,stdout:'some unknown response',stderr:''};}});assert.equal(status.status,'unknown');
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
    if(command==='claude auth status')return {code:0,stdout:JSON.stringify({loggedIn:claudeReady,authMethod:claudeReady?'claude.ai':null,apiProvider:'firstParty',email:'private@example.test'}),stderr:''};
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

test('runtime contract verification budget is scoped to verify and MCP sampling keeps corrections bounded',async()=>{
  const requests=[];const sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(params,options){requests.push({params,options});return {model:'fixture',stopReason:'endTurn',content:{type:'text',text:'{"choice":"A"}'}};}});
  await sampling.call('correct','Choose.',{},schema);await sampling.call('verify','Verify.',{},schema);
  assert.deepEqual(requests.map(item=>[item.params.maxTokens,item.options.timeout]),[[1500,60000],[12000,180000]]);
  assert.ok(requests.every(item=>item.params.includeContext==='none'&&item.params.temperature===0));
});

test('runtime contract Codex verifier uses extended bounded timeout and records typed timeout without raw output',async()=>{
  const requests=[];const runner={async run(request){requests.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.args.includes('exec'))throw Error('CLIENT_TIMEOUT');
    throw Error('unexpected command');
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});
  await assert.rejects(model.call('verify','Inspect original evidence.',{stage_id:'completion.verify'},schema),/^Error: STRUCTURED_MODEL_TIMEOUT$/u);
  const invocation=requests.find(item=>item.args.includes('exec'));
  assert.equal(invocation.timeout_ms,180000);assert.equal(model.calls.at(-1).purpose,'verify');assert.equal(model.calls.at(-1).failure_kind,'timeout');
  assert.equal(JSON.stringify(model.calls).includes(invocation.stdin),false);
});

test('runtime subscription model falls from failed Codex to Claude while preserving no-tools structured contracts',async()=>{
  const invocations=[];const runner={async run(request){invocations.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT\n',stderr:''};
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty',subscriptionType:'max'}),stderr:''};
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
    if(request.args.join(' ')==='auth list')return {code:0,stdout:'┌ Credentials\n│ OpenRouter api\n└ 1 credentials',stderr:''};
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
  const row=expected.properties.workers.items;row.required.push('relative','timestamp','format','metadata');
  for(const key of ['timestamp','format','metadata'])row.properties[key]={anyOf:[row.properties[key],{type:'null'}]};
  expected.allOf[0].required=['more'];expected.allOf[0].properties.more={anyOf:[expected.allOf[0].properties.more,{type:'null'}]};
  assert.deepEqual(transported,expected);assert.deepEqual(original,before);
  assert.ok(stdin.includes('SCHEMA:\n'+JSON.stringify(original)+'\nINPUT:'));
  assert.equal(model.calls[0].input_sha256,hashJson({instructions,input,schema:original}));
});

async function codexSchemaRoundTrip(original,response){
  let transport,stdin;
  const runner={async run(request){
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    assert.ok(request.args.includes('--output-schema'));transport=JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema')+1],'utf8'));stdin=request.stdin;
    return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(response)}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});
  return {value:await model.call('design','Return the requested bounded shape.',{},original),transport,stdin,calls:model.calls};
}

test('runtime contract Codex optional transport is required-nullable and decodes nested arrays/unions before original Zod validation',async()=>{
  const domain=z.object({
    required_null:z.string().nullable(),optional_null:z.string().nullable().optional(),
    browser:z.object({mode:z.enum(['background','foreground']),preferred_engine:z.enum(['playwright','aside']).optional()}).strict().optional(),
    workers:z.array(z.discriminatedUnion('kind',[
      z.object({kind:z.literal('click'),target:z.string().optional(),domain_null:z.string().nullable()}).strict(),
      z.object({kind:z.literal('read'),url:z.url().optional(),values:z.array(z.object({note:z.string().optional()}).strict())}).strict(),
    ])),
  }).strict(),original=z.toJSONSchema(domain),before=structuredClone(original);
  const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}};freeze(original);
  const reply={required_null:null,optional_null:null,browser:null,workers:[{kind:'click',target:null,domain_null:null},{kind:'read',url:null,values:[{note:null}]}]};
  const result=await codexSchemaRoundTrip(original,reply);
  assert.deepEqual(domain.parse(result.value),{required_null:null,optional_null:null,workers:[{kind:'click',domain_null:null},{kind:'read',values:[{}]}]});
  assert.deepEqual(result.transport.required.toSorted(),Object.keys(original.properties).toSorted());
  assert.deepEqual(result.transport.properties.browser.anyOf.at(-1),{type:'null'});
  const nested=result.transport.properties.browser.anyOf[0];assert.deepEqual(nested.required,['mode','preferred_engine']);assert.deepEqual(nested.properties.preferred_engine.anyOf.at(-1),{type:'null'});
  assert.deepEqual(result.transport.properties.required_null,original.properties.required_null);assert.deepEqual(result.transport.properties.optional_null,original.properties.optional_null);
  assert.deepEqual(original,before);assert.deepEqual(reply.browser,null);assert.equal(reply.workers[0].target,null);
  assert.ok(result.stdin.includes('SCHEMA:\n'+JSON.stringify(original)+'\nINPUT:'));
  assert.equal(result.calls[0].input_sha256,hashJson({instructions:'Return the requested bounded shape.',input:{},schema:original}));
  const second=await codexSchemaRoundTrip(original,{required_null:null,optional_null:null,browser:{mode:'foreground',preferred_engine:null},workers:[]});
  assert.deepEqual(domain.parse(second.value).browser,{mode:'foreground'});
});

test('runtime contract Codex local schema references retain required and optional domain nulls while stripping only added absence markers',async()=>{
  const original={type:'object',additionalProperties:false,required:['payload','required_nullable'],properties:{
    payload:{$ref:'#/$defs/payload'},optional_ref:{$ref:'#/$defs/payload'},optional_nullable:{$ref:'#/$defs/nullable'},required_nullable:{$ref:'#/$defs/nullable'},
  },$defs:{payload:{type:'object',additionalProperties:false,required:['keep'],properties:{keep:{type:['string','null']},extra:{type:'string',enum:['yes']}}},nullable:{anyOf:[{type:'string'},{type:'null'}]}}};
  const before=structuredClone(original),result=await codexSchemaRoundTrip(original,{payload:{keep:null,extra:null},optional_ref:null,optional_nullable:null,required_nullable:null});
  assert.deepEqual(result.value,{payload:{keep:null},optional_nullable:null,required_nullable:null});
  assert.deepEqual(result.transport.properties.optional_ref,{anyOf:[{$ref:'#/$defs/payload'},{type:'null'}]});
  assert.deepEqual(result.transport.properties.optional_nullable,{$ref:'#/$defs/nullable'});
  assert.deepEqual(result.transport.$defs.payload.required,['keep','extra']);assert.equal(result.transport.$defs.payload.additionalProperties,false);
  assert.deepEqual(original,before);
});

test('runtime contract Codex transport never deletes required nulls, unknown keys, dictionary values or broadens caller allowlists',async()=>{
  const domain=z.object({required:z.string(),optional:z.string().optional(),dictionary:z.record(z.string(),z.string().nullable())}).strict();
  const original=z.toJSONSchema(domain),before=structuredClone(original),result=await codexSchemaRoundTrip(original,{required:null,optional:null,dictionary:{customer:null},unexpected:null});
  assert.deepEqual(result.value,{required:null,dictionary:{customer:null},unexpected:null});assert.equal(domain.safeParse(result.value).success,false);
  assert.equal(result.transport.additionalProperties,false);
  assert.deepEqual(result.transport.properties.dictionary.additionalProperties,original.properties.dictionary.additionalProperties);
  assert.deepEqual(original,before);
});

test('runtime contract Codex overlapping union branches preserve a legitimate optional null instead of selecting an absence sentinel',async()=>{
  const domain=z.object({variant:z.union([z.object({value:z.string().optional()}).strict(),z.object({value:z.string().nullable().optional()}).strict()])}).strict();
  const result=await codexSchemaRoundTrip(z.toJSONSchema(domain),{variant:{value:null}});
  assert.deepEqual(result.value,{variant:{value:null}});assert.deepEqual(domain.parse(result.value),{variant:{value:null}});
});

test('Claude exact JSON fences are accepted, but surrounding prose and multiple blocks are rejected',async()=>{
  for(const [result,accepted] of [['```json\n{"choice":"A"}\n```',true],['Here is JSON\n```json\n{"choice":"A"}\n```',false],['```json\n{}\n```\n```json\n{}\n```',false]]){
    const runner={async run(request){return {code:0,stdout:JSON.stringify(request.args.join(' ')==='auth status'?{loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}:{is_error:false,result}),stderr:''};}};
    const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'claude'}),runner});
    if(accepted)assert.deepEqual(await model.call('design','Choose.',{},schema),{choice:'A'});
    else await assert.rejects(model.call('design','Choose.',{},schema),/CLIENT_STRUCTURED_OUTPUT_INVALID/);
  }
});

test('runtime URI transport compatibility is Codex-only and leaves Claude structured schema unchanged',async()=>{
  const original={type:'object',properties:{url:{type:'string',format:'uri'}},additionalProperties:false,required:['url']};let transported;
  const runner={async run(request){
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),stderr:''};
    transported=JSON.parse(request.args[request.args.indexOf('--json-schema')+1]);
    return {code:0,stdout:JSON.stringify({is_error:false,structured_output:{url:'https://example.test/'}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'claude'}),runner});
  await model.call('design','Return one URL.',{},original);assert.deepEqual(transported,original);assert.equal(transported.properties.url.format,'uri');
});

test('runtime Codex transport normalization does not authorize an invalid URL returned to the Swarm planner',async()=>{
  const worker=id=>({id,role:id,objective:'Read one source.',stage:'source_read',source_urls:['not a valid URL'],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Source readback.'],max_steps:4,timeout_ms:10_000}),draft={summary:'Bounded source review.',workers:[worker('first'),worker('second')]};
  const requests=[];
  const runner={async run(request){
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    requests.push(request);
    const transported=JSON.parse(await readFile(request.args[request.args.indexOf('--output-schema')+1],'utf8'));
    assert.equal(transported.properties.workers.items.properties.source_urls.items.format,undefined);
    return {code:0,stdout:JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(draft)}}),stderr:''};
  }};
  const model=new SubscriptionAwareStructuredModel({environment:fixtureEnvironment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner}),planner=new LlmSwarmPlanner(model);
  await assert.rejects(planner.plan('Read and verify sources.',{},{max_workers:4,max_concurrency:2,capabilities:[]}),/^Error: SWARM_PLANNER_CORRECTION_FAILED_SWARM_PLAN_SCHEMA_INVALID$/u);
  assert.equal(requests.length,2,'Exactly one output-only repair is allowed; an invalid URL is never a valid source.');
  assert.doesNotMatch(requests[0].stdin,/OUTPUT-ONLY CORRECTION/u);assert.match(requests[1].stdin,/OUTPUT-ONLY CORRECTION/u);assert.match(requests[1].stdin,/SWARM_PLAN_SCHEMA_INVALID/u);assert.match(requests[1].stdin,/not a valid URL/u);
  assert.deepEqual(model.calls.map(call=>[call.purpose,call.status]),[['design','accepted'],['repair','accepted']]); // Both JSON outputs reached, and failed, the original URL/domain validation.
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
