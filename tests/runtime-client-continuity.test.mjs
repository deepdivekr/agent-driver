import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {decisionClientCapabilities,supportsStructuredJudgment} from '../dist/integrations/client-capabilities.js';
import {McpSamplingStructuredModel,SubscriptionAuthFlowController,SubscriptionAwareStructuredModel,nativeProcessRunner,probeSubscriptionClient} from '../dist/integrations/subscription-auth.js';
import {makeClientHandoff,classifyClientFailure} from '../dist/integrations/client-handoff.js';
import {structuredModelFromEnvironment} from '../dist/integrations/model-provider.js';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {saveModelSettings} from '../dist/onboarding/model-settings.js';
import {PackStore} from '../dist/packs/store.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const unitCases=new Set(['decision capability contracts gate negotiated sampling without claiming native session transfer','handoff contract rejects uncertain, unbound or self-reported contradictory transfers']);
const nativeCases=new Set(['persisted handoffs remain project and Work scoped after restarting SQLite','native process cancellation terminates only the owned synthetic client process']);
const test=(name,fn)=>nodeTest((unitCases.has(name)?'':nativeCases.has(name)?'runtime native ':'runtime contract ')+name,fn);

const schema={type:'object',properties:{choice:{type:'string'}},required:['choice'],additionalProperties:false};
const environment=(patch={})=>({AGENT_DRIVER_LLM_CLIENT:'codex,claude',AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_CODEX_MODEL:'saved-codex',AGENT_DRIVER_CLAUDE_MODEL:'saved-claude',...patch});
const result=(stdout='',code=0,stderr='')=>({code,stdout,stderr});
const codexReady=()=>result('Logged in using ChatGPT');
const signedOut=()=>result('',1,'Not logged in');
const claudeReady=()=>result(JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}));
const codexAnswer=(value={choice:'A'})=>result(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify(value)}}));
const claudeAnswer=()=>result(JSON.stringify({is_error:false,structured_output:{choice:'B'}}));
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(done=>setImmediate(done));
async function directory(t){const root=await mkdtemp(join(tmpdir(),'driver-continuity-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
const apiSelection={mode:'api',client:'codex',client_models:{codex:'saved-codex',claude:'saved-claude',opencode:'provider/model'},api_to_subscription:true,api_provider:'openai',api_model:'saved-api',api_base_url:'',reasoning:'low',jev:'off'};
async function apiSettings(t){const root=await directory(t),path=join(root,'models.json');saveModelSettings(path,{revision:0,onboarding_step:2,selection:apiSelection,api_action:'replace',api_key:'fixture-api-key-not-real-12345'},{});return path;}

test('decision capability contracts gate negotiated sampling without claiming native session transfer',()=>{
  for(const id of ['codex','claude','opencode','api'])assert.equal(supportsStructuredJudgment(id),true);
  for(const id of ['cursor','hermes','mcp'])assert.equal(supportsStructuredJudgment(id),false);
  assert.equal(supportsStructuredJudgment('mcp',true),true);
  const contract=decisionClientCapabilities('claude');assert.equal(contract.version,1);assert.equal(contract.tool_authority,'none');assert.equal(contract.session_continuity,'new_bounded_turn');assert.equal(contract.evidence,'adapter_contract');assert.ok(Object.isFrozen(contract));
});

test('simultaneous status requests join one process and return independent observations',async()=>{
  const gate=deferred();let probes=0;const runner={async run(){probes++;await gate.promise;return codexReady();}};
  const pending=Array.from({length:10},()=>probeSubscriptionClient('codex',environment(),runner));assert.equal(probes,1);gate.resolve();const states=await Promise.all(pending);
  states[0].status='expired';assert.ok(states.slice(1).every(state=>state.status==='ready'));
  await probeSubscriptionClient('codex',environment(),runner);assert.equal(probes,2,'in-flight joining must not cache status indefinitely');
});

test('a failed shared status probe is evicted immediately',async()=>{
  let probes=0;const runner={async run(){if(++probes===1)throw Error('offline');return codexReady();}};
  assert.equal((await probeSubscriptionClient('codex',environment(),runner)).status,'unavailable');assert.equal((await probeSubscriptionClient('codex',environment(),runner)).status,'ready');assert.equal(probes,2);
});

test('ready-looking output with a failed exit status cannot authorize a model turn',async()=>{
  let turns=0;const runner={async run(request){if(request.args.join(' ')==='login status')return result('Logged in using ChatGPT',1);turns++;return codexAnswer();}};
  const state=await probeSubscriptionClient('codex',environment(),runner);assert.equal(state.status,'unknown');assert.equal(state.reason,'status_command_failed');
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);assert.equal(turns,0);
});

test('signed-out status never pins a later successful connection for thirty seconds',async()=>{
  let ready=false,probes=0;const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;return ready?codexReady():signedOut();}return codexAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});await assert.rejects(model.call('correct','Choose.',{},schema));ready=true;assert.deepEqual(await model.call('correct','Choose.',{},schema),{choice:'A'});assert.equal(probes,2);
});

test('different executable or authentication-home bindings never share a status process',async()=>{
  const gate=deferred();let probes=0;const runner={async run(){probes++;await gate.promise;return codexReady();}};
  const pending=[environment({CODEX_HOME:'/account/a'}),environment({CODEX_HOME:'/account/b'}),environment({AGENT_DRIVER_CODEX_EXECUTABLE:'/other/codex'})].map(env=>probeSubscriptionClient('codex',env,runner));assert.equal(probes,3);gate.resolve();await Promise.all(pending);
});

test('positive status cache is invalidated when the configured executable changes',async()=>{
  const env=environment({AGENT_DRIVER_LLM_CLIENT:'codex'});let probes=0;
  const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;return request.executable==='/fixture/codex'?codexReady():signedOut();}return codexAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:env,runner});await model.call('correct','Choose.',{},schema);env.AGENT_DRIVER_CODEX_EXECUTABLE='/changed/codex';
  await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);assert.equal(probes,2);
});

test('replacing an executable invalidates a ready probe even at the same path',async t=>{
  const root=await directory(t),path=join(root,'fixture-client');await writeFile(path,'v1');let probes=0;
  const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;return codexReady();}return codexAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex',AGENT_DRIVER_CODEX_EXECUTABLE:path}),runner});await model.call('correct','Choose.',{},schema);await writeFile(path,'version-two-different-size');await model.call('correct','Choose.',{},schema);assert.equal(probes,2);
});

test('a failed model invocation invalidates other model instances sharing its connection',async()=>{
  let probes=0,fail=false;const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;return codexReady();}return fail?result('',1,'Session expired'):codexAnswer();}};
  const first=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner}),second=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner});
  await first.call('correct','Choose.',{},schema);fail=true;await assert.rejects(second.call('correct','Choose.',{},schema));fail=false;await first.call('correct','Choose.',{},schema);assert.equal(probes,3);
});

test('concurrent model instances share only preflight, never actual judgment turns',async()=>{
  const gate=deferred();let probes=0,turns=0;
  const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;await gate.promise;return codexReady();}turns++;return codexAnswer();}};
  const models=Array.from({length:4},()=>new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex'}),runner})),pending=models.map(model=>model.call('correct','Choose.',{},schema));assert.equal(probes,1);gate.resolve();await Promise.all(pending);assert.equal(turns,4);assert.ok(models.every(model=>model.calls.length===1));
});

test('model selection is frozen at invocation start while settings change during a probe',async()=>{
  const gate=deferred(),env=environment({AGENT_DRIVER_LLM_CLIENT:'codex'});let args;
  const runner={async run(request){if(request.args.join(' ')==='login status'){await gate.promise;return codexReady();}args=request.args;return codexAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:env,runner}),pending=model.call('correct','Choose.',{},schema);env.AGENT_DRIVER_CODEX_MODEL='new-selection';gate.resolve();await pending;assert.equal(args[args.indexOf('--model')+1],'saved-codex');assert.equal(model.calls[0].model,'saved-codex');
});

test('subscription handoff freezes task input, constraints and receipt hash before awaiting providers',async()=>{
  const gate=deferred(),input={work_id:'original-work',value:1},constraints=structuredClone(schema),expectedHash=hashJson({instructions:'Choose.',input,schema:constraints}),events=[];let received;
  const runner={async run(request){if(request.args.join(' ')==='login status'){await gate.promise;return codexReady();}if(request.args.join(' ')==='auth status')return claudeReady();if(request.executable==='/fixture/codex')return result('',1,'quota exhausted');received=request.stdin;return claudeAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:environment(),runner,onHandoff:event=>events.push(event)}),pending=model.call('correct','Choose.',input,constraints);
  input.work_id='different-work';input.value=99;constraints.properties.choice.type='number';gate.resolve();await pending;
  assert.match(received,/"work_id":"original-work","value":1/);assert.doesNotMatch(received,/different-work/);assert.match(received,/"choice":\{"type":"string"\}/);assert.equal(events[0].work_id,'original-work');assert.equal(events[0].input_sha256,expectedHash);
});

test('two simultaneous login starts join preflight and own just one login process',async()=>{
  const gate=deferred(),login=deferred();let probes=0,starts=0,signal;
  const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;await gate.promise;return signedOut();}starts++;signal=request.signal;request.onStdout('Device code: ABCD-1234');return login.promise;}};
  const controller=new SubscriptionAuthFlowController(environment(),runner),first=controller.start('codex','device'),second=controller.start('codex','browser');assert.equal(probes,1);gate.resolve();const [a,b]=await Promise.all([first,second]);assert.equal(starts,1);assert.equal(a.flow,'device');assert.deepEqual(a,b);controller.close();assert.equal(signal.aborted,true);login.resolve(result());await tick();
});

test('closing while preflight is pending prevents a late orphaned login process',async()=>{
  const gate=deferred();let processes=0;const runner={async run(){processes++;await gate.promise;return signedOut();}};
  const controller=new SubscriptionAuthFlowController(environment(),runner),pending=controller.start('codex','device');controller.close();gate.resolve();assert.equal((await pending).reason,'connection_controller_closed');assert.equal(processes,1);assert.equal((await controller.start('codex','device')).reason,'connection_controller_closed');assert.equal(processes,1);
});

test('closing during login aborts it and ignores late output and completion',async()=>{
  const login=deferred();let signal,observe,probes=0;const runner={async run(request){if(request.args.join(' ')==='login status'){probes++;return signedOut();}signal=request.signal;observe=request.onStdout;return login.promise;}};
  const controller=new SubscriptionAuthFlowController(environment(),runner);await controller.start('codex','device');controller.close();assert.equal(signal.aborted,true);observe('Device code: ABCD-1234');login.resolve(result());await tick();assert.equal(probes,1);assert.notEqual(controller.view('codex').state,'completed');assert.equal(controller.view('codex').user_code,undefined);
});

test('changing the connection during login cancels it and cannot complete another connection',async()=>{
  const env=environment(),login=deferred();let signal;
  const runner={async run(request){if(request.args.join(' ')==='login status')return signedOut();signal=request.signal;return login.promise;}};
  const controller=new SubscriptionAuthFlowController(env,runner);await controller.start('codex','device');env.AGENT_DRIVER_CODEX_EXECUTABLE='/new/codex';assert.equal(controller.view('codex').reason,'connection_changed');assert.equal(signal.aborted,true);login.resolve(result());await tick();assert.equal(controller.view('codex').reason,'connection_changed');controller.close();
});

test('synchronously failing login launch becomes retryable failure instead of sticky starting state',async()=>{
  const runner={run(request){if(request.args.join(' ')==='login status')return Promise.resolve(signedOut());throw Error('spawn unavailable');}};
  const controller=new SubscriptionAuthFlowController(environment(),runner);await controller.start('codex','device');await tick();assert.equal(controller.view('codex').state,'failed');await controller.start('codex','device');await tick();assert.equal(controller.view('codex').state,'failed');controller.close();
});

test('changing the executable during login preflight does not launch against another connection',async()=>{
  const gate=deferred(),env=environment();let processes=0;const runner={async run(){processes++;await gate.promise;return signedOut();}};
  const controller=new SubscriptionAuthFlowController(env,runner),pending=controller.start('codex','device');env.AGENT_DRIVER_CODEX_EXECUTABLE='/different/codex';gate.resolve();assert.equal((await pending).reason,'connection_changed');assert.equal(processes,1);controller.close();
});

test('Claude subscription requires explicit first-party provider and rejects API/helper/cloud credentials',async()=>{
  for(const entry of [
    {loggedIn:true,authMethod:'claude.ai'},
    {loggedIn:true,subscriptionType:'max'},
    {loggedIn:true,authMethod:'claude.ai',apiProvider:'bedrock'},
    {loggedIn:true,authMethod:'claude.ai',apiProvider:'vertex'},
    {loggedIn:true,authMethod:'api_key',apiProvider:'firstParty'},
    {loggedIn:true,authMethod:'apiKeyHelper',apiProvider:'firstParty'},
  ]){
    let turns=0;const runner={async run(request){if(request.args.join(' ')==='auth status')return result(JSON.stringify(entry));turns++;return claudeAnswer();}};
    const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'claude'}),runner});await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);assert.equal(turns,0,JSON.stringify(entry));
  }
});

test('malformed CLI output is not a provider outage and never invokes a successor or paid API',async()=>{
  for(const stdout of ['{bad JSON}','null',JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'{broken}'}})]){
    const seen=[],events=[];let apiCalls=0;const runner={async run(request){seen.push(request);return request.args.join(' ')==='login status'?codexReady():result(stdout);}};
    const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex,claude,api'}),runner,onHandoff:event=>events.push(event),fallbackModel:{calls:[],async call(){apiCalls++;return {};}}});
    await assert.rejects(model.call('correct','Choose.',{},schema),/CLIENT_STRUCTURED_OUTPUT_INVALID/);assert.equal(seen.length,2);assert.equal(apiCalls,0);assert.equal(events.length,0);assert.equal(model.calls[0].failure_kind,'invalid_output');assert.equal(classifyClientFailure(new SyntaxError('private output')),'invalid_output');
  }
});

test('invalid sampling output is preserved as invalid output without calling another client',async()=>{
  let probes=0;const sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(){return {model:'host-model',content:{type:'text',text:'not JSON'}};}}),model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'mcp,codex'}),sampling,runner:{async run(){probes++;return codexReady();}}});
  await assert.rejects(model.call('correct','Choose.',{},schema),/MCP_SAMPLING_INVALID/);assert.equal(probes,0);assert.equal(model.calls[0].failure_kind,'invalid_output');assert.equal(sampling.calls.length,1);
});

test('malformed sampling envelopes are validation failures, never connection outages',async()=>{
  for(const response of [null,{model:null,content:{type:'text',text:'{}'}},{model:'model',content:null}]){
    const sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(){return response;}});
    await assert.rejects(sampling.call('correct','Choose.',{},schema),/MCP_SAMPLING_INVALID/);assert.equal(sampling.calls[0].failure_kind,'invalid_output');
  }
});

test('sampling transport failure permits a no-tools successor and records its actual failure kind',async()=>{
  const events=[],sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(){throw Error('disconnected');}}),runner={async run(request){return request.args.join(' ')==='login status'?codexReady():codexAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'mcp,codex'}),sampling,runner,onHandoff:event=>events.push(event)});await model.call('correct','Choose.',{work_id:'work-a'},schema);assert.equal(model.calls[0].failure_kind,'provider_unavailable');assert.equal(events[0].target_model,'saved-codex');
});

test('concurrent sampling receipts remain attached to their own input and model',async()=>{
  const gates=new Map(),sampling=new McpSamplingStructuredModel({available:()=>true,async createMessage(params){const id=JSON.parse(params.messages[0].content.text.split('\nINPUT:\n')[1]).work_id,gate=deferred();gates.set(id,gate);await gate.promise;return {model:'model-'+id,content:{type:'text',text:'{"choice":"A"}'}};}}),model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'mcp'}),sampling});
  const inputs=[{work_id:'first'},{work_id:'second'}],pending=inputs.map(input=>model.call('correct','Choose.',input,schema));gates.get('second').resolve();await pending[1];gates.get('first').resolve();await pending[0];assert.equal(model.calls.length,2);
  for(const input of inputs){const call=model.calls.find(item=>item.input_sha256===hashJson({instructions:'Choose.',input,schema}));assert.equal(call.model,'model-'+input.work_id);}
});

test('handoff receipt failure never replays an already accepted judgment on a third client',async()=>{
  let turns=0,samplingCalls=0,writes=0;const runner={async run(request){if(request.args.join(' ')==='login status')return codexReady();if(request.args.join(' ')==='auth status')return claudeReady();turns++;return request.executable==='/fixture/codex'?result('',1,'quota exhausted'):claudeAnswer();}};
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex,claude,mcp'}),runner,sampling:new McpSamplingStructuredModel({available:()=>true,async createMessage(){samplingCalls++;throw Error('must not run');}}),onHandoff(){writes++;throw Error('disk full and private path');}});
  await assert.rejects(model.call('correct','Choose.',{},schema),/CLIENT_HANDOFF_PERSIST_FAILED/);assert.equal(turns,2);assert.equal(samplingCalls,0);assert.equal(writes,1);assert.equal(model.calls.at(-1).status,'accepted');
});

test('API malformed response envelopes and malformed JSON never trigger subscription fallback',async t=>{
  const path=await apiSettings(t);
  for(const body of ['not JSON',JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{broken}'}]}]}),JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'null'}]}]})]){
    let fallbacks=0;const model=new ConfiguredStructuredModel(path,{}, {api:env=>structuredModelFromEnvironment(env,async()=>new Response(body,{status:200})),subscription:()=>{fallbacks++;throw Error('must not run');}});
    await assert.rejects(model.call('correct','Choose.',{},schema),/MODEL_PROVIDER_RESPONSE_INVALID/);assert.equal(fallbacks,0);assert.equal(model.calls[0].failure_kind,'invalid_output');
  }
});

test('API handoff receipt failure is not rewritten as a no-candidate failure',async t=>{
  const path=await apiSettings(t),events=[];
  const model=new ConfiguredStructuredModel(path,{}, {api:()=>({calls:[{model:'saved-api',status:'failed',http_status:429}],async call(){throw Error('MODEL_PROVIDER_UNAVAILABLE');}}),subscription:()=>({calls:[],async call(){this.calls.push({model:'saved-codex',provider:'codex',status:'accepted'});return {choice:'A'};}})},event=>{events.push(event);throw Error('write failed');});
  await assert.rejects(model.call('correct','Choose.',{},schema),/CLIENT_HANDOFF_PERSIST_FAILED/);assert.deepEqual(events.map(event=>event.status),['transferred']);assert.equal(model.calls.filter(call=>call.status==='accepted').length,1);
});

test('API to subscription handoff uses the original input snapshot and bound receipt',async t=>{
  const path=await apiSettings(t),gate=deferred(),input={work_id:'api-original',value:1},constraints=structuredClone(schema),expectedHash=hashJson({instructions:'Choose.',input,schema:constraints}),events=[];let received;
  const model=new ConfiguredStructuredModel(path,{}, {api:()=>({calls:[{model:'saved-api',http_status:429,status:'failed'}],async call(){await gate.promise;throw Error('quota');}}),subscription:()=>({calls:[],async call(_purpose,_instructions,body,contract){received={body,contract};this.calls.push({model:'saved-codex',provider:'codex',status:'accepted'});return {choice:'A'};}})},event=>events.push(event));
  const pending=model.call('correct','Choose.',input,constraints);input.work_id='changed';constraints.properties.choice.type='number';gate.resolve();await pending;
  assert.equal(received.body.work_id,'api-original');assert.equal(received.contract.properties.choice.type,'string');assert.equal(events[0].work_id,'api-original');assert.equal(events[0].input_sha256,expectedHash);
});

test('a fallback without accepted turn provenance cannot claim a successful transfer',async t=>{
  const path=await apiSettings(t),events=[];const model=new ConfiguredStructuredModel(path,{}, {api:()=>({calls:[{http_status:429}],async call(){throw Error('offline');}}),subscription:()=>({calls:[],async call(){return {choice:'A'};}})},event=>events.push(event));await assert.rejects(model.call('correct','Choose.',{},schema),/CLIENT_HANDOFF_RECEIPT_MISSING/);assert.deepEqual(events,[]);
});

const receipt={project_id:'p1',work_id:'work-1',run_id:'run-1',stage_id:'stage-1',source:'codex',target:'claude',source_model:'saved-codex',target_model:'saved-claude',reason:'quota_exhausted',effect_state:'none',status:'transferred',input_sha256:'a'.repeat(64)};
test('handoff contract rejects uncertain, unbound or self-reported contradictory transfers',()=>{
  assert.equal(makeClientHandoff(receipt).status,'transferred');
  for(const patch of [{target:null},{target_model:null},{input_sha256:null},{effect_state:'uncertain'},{target:'codex'},{reason:'invalid_output'},{status:'no_candidate'},{status:'requires_reconciliation'},{status:'no_candidate',target:null,target_model:null,effect_state:'uncertain'}])assert.throws(()=>makeClientHandoff({...receipt,...patch}));
  assert.equal(makeClientHandoff({...receipt,target:null,target_model:null,status:'requires_reconciliation',effect_state:'uncertain'}).status,'requires_reconciliation');
});

test('persisted handoffs remain project and Work scoped after restarting SQLite',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-continuity-db-')),path=join(root,'store.sqlite');let store=new PackStore(path);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const {project_id,...event}=receipt;store.recordClientHandoff(project_id,event);store.recordClientHandoff('p2',{...event,target:null,target_model:null,status:'requires_reconciliation',effect_state:'uncertain'});store.close();store=new PackStore(path);
  assert.equal(store.clientHandoffs('p1','work-1')[0].status,'transferred');assert.equal(store.clientHandoffs('p2','work-1')[0].status,'requires_reconciliation');assert.deepEqual(store.clientHandoffs('p1','another-work'),[]);
});

test('duplicate client names never replay a failed turn on the same client',async()=>{
  let turns=0;const runner={async run(request){if(request.args.join(' ')==='login status')return codexReady();turns++;return result('',1,'quota exhausted');}};
  const model=new SubscriptionAwareStructuredModel({environment:environment({AGENT_DRIVER_LLM_CLIENT:'codex,codex'}),runner});await assert.rejects(model.call('correct','Choose.',{},schema),/STRUCTURED_MODEL_UNAVAILABLE/);assert.equal(turns,1);
});

test('native process cancellation terminates only the owned synthetic client process',async()=>{
  const abort=new AbortController();let observed=false;
  const pending=nativeProcessRunner.run({executable:process.execPath,args:['-e','process.stdout.write("ready");setInterval(()=>{},1000);'],timeout_ms:5_000,signal:abort.signal,onStdout:text=>{if(text.includes('ready')){observed=true;abort.abort();}}});
  await assert.rejects(pending,error=>error.name==='AbortError');assert.equal(observed,true);
});
