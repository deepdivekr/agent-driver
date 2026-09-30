import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,readdir,writeFile,symlink,stat,rename} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {saveModelSettings,readModelSettings,roleModelConfiguration,scopedModelSettingsPath} from '../dist/onboarding/model-settings.js';
import {SubscriptionAwareStructuredModel} from '../dist/integrations/subscription-auth.js';
import {validateSwarmPlanDraft,swarmPlanDraftSchema} from '../dist/swarm/contracts.js';
import {LlmSwarmPlanner,STANDARD_RESEARCH_INSTRUCTIONS} from '../dist/swarm/planner.js';
import {withDecisionSession} from '../dist/integrations/decision-sessions.js';

const schema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
const selection={mode:'subscription',client:'codex',client_models:{codex:'selected-code',claude:'selected-review',opencode:null},role_models:{planner:{codex:'plan-model',claude:null,opencode:null},worker:{codex:'work-model',claude:null,opencode:null},verifier:{codex:'review-model',claude:'review-claude',opencode:null},synthesis:{codex:'write-model',claude:null,opencode:null}},api_to_subscription:false,api_provider:'openai',api_model:'selected-api',api_base_url:'',reasoning:'high',jev:'off'};
const env={AGENT_DRIVER_CODEX_EXECUTABLE:'/fixture/codex',AGENT_DRIVER_CLAUDE_EXECUTABLE:'/fixture/claude',AGENT_DRIVER_OPENCODE_EXECUTABLE:'/fixture/opencode'};
const context={work_id:'work-a',run_id:'run-a',stage_id:'reader-a'};
const input={prompt:'Read only the assigned source.',checkpoint:{summary:'Already read the first page.',observations:[]}};
async function setup(t,choice=selection){const root=await mkdtemp(join(tmpdir(),'adaptive-workers-'));t.after(()=>rm(root,{recursive:true,force:true}));const path=join(root,'models.json');saveModelSettings(path,{revision:0,onboarding_step:3,selection:choice,...(choice.mode==='api'?{api_action:'replace',api_key:'fixture-key-no-real-provider-12345'}:{})},{});return {root,path};}
function runnerFor(hook){
  const requests=[];return {requests,async run(request){
    requests.push(request);
    if(request.args.join(' ')==='login status')return {code:0,stdout:'Logged in using ChatGPT',stderr:''};
    if(request.args.join(' ')==='auth status')return {code:0,stdout:JSON.stringify({loggedIn:true,authMethod:'claude.ai',apiProvider:'firstParty'}),stderr:''};
    const alternative=await hook?.(request);if(alternative)return alternative;
    if(request.executable==='/fixture/claude')return {code:0,stdout:JSON.stringify({session_id:request.args.includes('--resume')?request.args[request.args.indexOf('--resume')+1]:request.args[request.args.indexOf('--session-id')+1],structured_output:{ok:true}}),stderr:''};
    assert.equal(request.executable,'/fixture/codex');
    return {code:0,stdout:[{type:'thread.started',thread_id:request.args.includes('resume')?request.args.at(-2):randomUUID()},{type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}].map(value=>JSON.stringify(value)).join('\n'),stderr:''};
  }};
}
const factory=(path,runner,options={})=>new ConfiguredStructuredModel(path,env,{subscription:settings=>new SubscriptionAwareStructuredModel({...settings,runner}),api:()=>{throw Error('PAID_API_MUST_NOT_RUN');},...options});
const invocations=runner=>runner.requests.filter(r=>r.args.includes('exec')||r.args.includes('-p'));
const worker=(id,extra={})=>({id,role:'Read source',objective:'Return exact source-backed evidence.',stage:'source_read',source_urls:[`https://example.test/${id}`],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Observed quoted evidence.'],max_steps:5,timeout_ms:75000,...extra});
const limits={mode:'standard',max_workers:24,max_concurrency:3,capabilities:[],worker_timeout_ms:75000,max_sources_per_worker:2,target_wall_ms:180000,hard_deadline_ms:240000,synthesis_reserve_ms:35000};

test('runtime unit adaptive Standard accepts one reader or a small graph without a reducer and keeps all evidence gates',()=>{
  const one={summary:'Small research',workers:[worker('one')]};assert.equal(validateSwarmPlanDraft(one,limits).workers.length,1);
  const small={summary:'Compare two sources',workers:[worker('one'),worker('two'),worker('final',{stage:'synthesis',source_urls:[],depends_on:['one','two']})]};assert.equal(validateSwarmPlanDraft(small,limits).workers.length,3);
  assert.throws(()=>swarmPlanDraftSchema.parse({summary:'No work',workers:[]}));
  for(const mutation of [d=>d.workers[0].effect='external_effect',d=>d.workers[0].required_capabilities=['unapproved'],d=>d.workers[2].depends_on=['one'],d=>d.workers[0].depends_on=['final'],d=>d.workers[2].source_urls=['https://example.test/extra'],d=>d.workers[0].timeout_ms=75001]){const copy=structuredClone(small);mutation(copy);assert.throws(()=>validateSwarmPlanDraft(copy,limits));}
});

test('runtime contract planner requests the smallest graph, binds planning role and does not manufacture a minimum swarm',async()=>{
  const roles=[],model={calls:[],forRole(role){roles.push(role);return this;},async call(purpose){this.calls.push({purpose,model:'fixture',input_sha256:'a'.repeat(64),status:'accepted'});return {summary:'Small source read.',workers:[worker('one')]};}};
  const plan=await new LlmSwarmPlanner(model).plan('Read the one assigned source.',{},limits);
  assert.deepEqual(roles,['planner']);assert.equal(plan.workers.length,1);assert.equal(plan.max_concurrency,1);assert.equal(model.calls.length,1);
  assert.match(STANDARD_RESEARCH_INSTRUCTIONS,/smallest useful graph/u);assert.doesNotMatch(STANDARD_RESEARCH_INSTRUCTIONS,/8 to 24|at least six/u);
});

test('runtime contract semantic Work stages bind every Swarm worker and correction cannot invent a stage',async()=>{
  const stages=JSON.stringify([{id:'collect',outcome:'Two public sources were read.',effect:'read_only'},{id:'report',outcome:'A brief was saved and read back.',effect:'local_write'}]);
  let turns=0;const model={calls:[],async call(purpose,_instructions,input){
    turns++;this.calls.push({purpose,model:'fixture',input_sha256:'b'.repeat(64),status:'accepted'});
    assert.equal(input.context?.work_stages??input.original_input?.context?.work_stages,stages);
    return {summary:'One reader',...(turns>1?{work_output_stage_id:'report'}:{}),workers:[worker('one',{...(turns>1?{work_stage_id:'collect'}:{})})]};
  }};
  const plan=await new LlmSwarmPlanner(model).plan('Read a public source.',{work_stages:stages},limits);
  assert.equal(turns,2);assert.equal(plan.workers[0].work_stage_id,'collect');assert.equal(plan.work_output_stage_id,'report');
  assert.throws(()=>validateSwarmPlanDraft({summary:'Wrong stage',work_output_stage_id:'report',workers:[worker('one',{work_stage_id:'missing'})]},{...limits,work_stage_ids:['collect','report'],work_output_stage_ids:['report']}),/SWARM_WORK_STAGE_UNKNOWN|SWARM_WORK_STAGE_UNCOVERED/u);
  assert.throws(()=>validateSwarmPlanDraft({summary:'Unbound stage',work_output_stage_id:'report',workers:[worker('one')]},{...limits,work_stage_ids:['collect','report'],work_output_stage_ids:['report']}),/SWARM_WORK_STAGE_REQUIRED|SWARM_WORK_STAGE_UNCOVERED/u);
});

test('runtime contract subscription roles use exact saved models while inherited choices and coding overrides remain intact',async t=>{
  const {path}=await setup(t),seen=[];
  const model=new ConfiguredStructuredModel(path,{}, {subscription:options=>({calls:[],async call(){seen.push(options.environment.AGENT_DRIVER_CODEX_MODEL);return {};}})});
  await model.call('design','',{},schema);for(const role of ['worker','verifier','synthesis'])await model.forRole(role).call('correct','',{},schema);
  assert.deepEqual(seen,['plan-model','work-model','review-model','write-model']);
  saveModelSettings(scopedModelSettingsPath(path,'coding'),{revision:0,onboarding_step:3,inherit_global:false,selection:{...selection,client_models:{...selection.client_models,codex:'coding-model'}}},{});
  await model.forScope('coding').forRole('verifier').call('correct','',{},schema);assert.equal(seen.at(-1),'coding-model');
  assert.equal(roleModelConfiguration(path,'global',{},'planner').environment.AGENT_DRIVER_CLAUDE_MODEL,'selected-review');
  assert.equal(readModelSettings(path).selection.client_models.codex,'selected-code');
  saveModelSettings(scopedModelSettingsPath(path,'coding'),{revision:1,onboarding_step:3,inherit_global:true,selection},{});
  await model.forScope('coding').forRole('verifier').call('correct','',{},schema);assert.equal(seen.at(-1),'review-model');
});

test('runtime contract API mode and API-to-auth fallback ignore role overrides and subscription never calls a paid API',async t=>{
  const {path}=await setup(t,{...selection,mode:'api',api_to_subscription:true}),seen=[],events=[];
  const api={calls:[],async call(purpose){this.calls.push({purpose,provider:'openai_api',model:'selected-api',status:'failed',http_status:429});throw Error('quota exhausted');}};
  const model=new ConfiguredStructuredModel(path,{}, {api:environment=>{assert.equal(environment.AGENT_DRIVER_API_MODEL,'selected-api');return api;},subscription:options=>({calls:[],async call(purpose){seen.push(options.environment.AGENT_DRIVER_CODEX_MODEL);this.calls.push({purpose,provider:'codex',model:options.environment.AGENT_DRIVER_CODEX_MODEL,status:'accepted'});return {ok:true};}})},event=>events.push(event));
  for(const role of ['planner','worker','verifier','synthesis'])assert.deepEqual(await model.forRole(role).call('correct','',{},schema),{ok:true});
  assert.deepEqual(seen,Array(4).fill('selected-code'));assert.ok(events.every(event=>event.source==='api'&&event.target==='codex'&&event.target_model==='selected-code'));
  saveModelSettings(scopedModelSettingsPath(path,'coding'),{revision:0,onboarding_step:3,inherit_global:false,selection},{});
  assert.equal(roleModelConfiguration(path,'coding',{},'verifier').environment.AGENT_DRIVER_CODEX_MODEL,'selected-code');
});

test('runtime contract native Codex assignee resumes after a wrapper restart and never crosses Work run actor or model contracts',async t=>{
  const {path,root}=await setup(t),runner=runnerFor();
  const call=async(binding=context,role='worker',instructions='Decide from current observed evidence.')=>{const model=factory(path,runner).forWork(binding).forRole(role);await model.call('correct',instructions,input,schema);return model.calls.at(-1);};
  assert.equal((await call()).continuity,'new_session');assert.equal((await call()).continuity,'resumed_session');
  let requests=invocations(runner);assert.equal(requests[0].args.includes('--ephemeral'),false);assert.equal(requests[1].args.includes('resume'),true);assert.equal(requests[0].cwd,requests[1].cwd);assert.deepEqual(JSON.parse(requests[1].stdin.split('INPUT:\n')[1]).checkpoint,input.checkpoint);
  for(const binding of [{...context,work_id:'work-b'},{...context,run_id:'run-b'},{...context,stage_id:'reader-b'}])assert.equal((await call(binding)).continuity,'new_session');
  assert.equal((await call(context,'verifier')).continuity,'new_session');assert.equal((await call(context,'worker','Changed instructions.')).continuity,'new_session');
  saveModelSettings(path,{revision:1,onboarding_step:3,selection:{...selection,role_models:{...selection.role_models,worker:{codex:'new-worker-model',claude:null,opencode:null}}}},{});
  assert.equal((await call()).continuity,'new_session');
  const records=await readdir(join(root,'decision-sessions'));for(const dir of records){const text=await readFile(join(root,'decision-sessions',dir,'session.json'),'utf8');assert.doesNotMatch(text,/Already read|Read only|token|password/u);}
});

test('runtime contract two workers in one business stage keep separate native sessions and shared stage provenance',async t=>{
  const {path}=await setup(t),runner=runnerFor(),base=factory(path,runner);
  const call=async actor=>{const model=base.forWork({work_id:'work-a',run_id:'run-a',stage_id:'collect',actor_id:actor});
    await model.call('correct','Report source-backed evidence.',input,schema);return model.calls.at(-1);};
  assert.equal((await call('reader-one')).continuity,'new_session');
  assert.equal((await call('reader-two')).continuity,'new_session');
  assert.equal((await call('reader-one')).continuity,'resumed_session');
  assert.equal((await call('reader-two')).continuity,'resumed_session');
  const requests=invocations(runner);assert.equal(requests.length,4);
  assert.notEqual(requests[0].cwd,requests[1].cwd);
  assert.equal(requests[0].cwd,requests[2].cwd);assert.equal(requests[1].cwd,requests[3].cwd);
  for(const request of requests)assert.equal(JSON.parse(request.stdin.split('INPUT:\n')[1]).stage_id,'collect');
  assert.throws(()=>base.forWork({work_id:'work-a',run_id:'run-a',stage_id:'collect',actor_id:'bad actor'}),/CLIENT_SESSION_ACTOR_INVALID/u);
});

test('runtime contract Claude uses its own persistent ID and exact resume, with tools and hooks still disabled',async t=>{
  const {path}=await setup(t,{...selection,client:'claude'}),runner=runnerFor();
  for(let i=0;i<2;i++){const model=factory(path,runner).forWork(context);await model.call('correct','Decide.',input,schema);assert.equal(model.calls.at(-1).continuity,i?'resumed_session':'new_session');}
  const [first,second]=invocations(runner);assert.equal(first.args.includes('--no-session-persistence'),false);assert.equal(second.args[second.args.indexOf('--resume')+1],first.args[first.args.indexOf('--session-id')+1]);
  for(const request of [first,second]){assert.equal(request.args[request.args.indexOf('--tools')+1],'');assert.ok(request.args.includes('--strict-mcp-config'));assert.ok(request.args.includes('{"disableAllHooks":true}'));}
});

test('runtime contract a missing native session restarts once from the checkpoint but invalid response does not replay',async t=>{
  const {path}=await setup(t);let missing=false,bad=false;
  const runner=runnerFor(request=>{if(request.args.includes('resume')&&missing){missing=false;return {code:1,stdout:'',stderr:'Session not found'};}if(bad)return {code:0,stdout:'invalid output',stderr:''};});
  const call=async()=>{const model=factory(path,runner).forWork(context);await model.call('correct','Decide.',input,schema);return model.calls.at(-1);};
  await call();missing=true;assert.equal((await call()).continuity,'new_session');assert.equal(invocations(runner).length,3);
  bad=true;await assert.rejects(call(),/CLIENT_STRUCTURED_OUTPUT_INVALID/u);assert.equal(invocations(runner).length,4);
  bad=false;assert.equal((await call()).continuity,'new_session');assert.equal(invocations(runner).at(-1).args.includes('resume'),false);
});

test('runtime contract a busy assignee is fenced instead of creating a second provider session',async t=>{
  const {path}=await setup(t);let release,entered;const gate=new Promise(r=>release=r),started=new Promise(r=>entered=r);let blocked=true;
  const runner=runnerFor(async()=>{if(blocked){blocked=false;entered();await gate;}}),a=factory(path,runner).forWork(context),b=factory(path,runner).forWork(context);
  const first=a.call('correct','Decide.',input,schema);await started;
  try{await assert.rejects(b.call('correct','Decide.',input,schema),/CLIENT_SESSION_BUSY/u);assert.equal(invocations(runner).length,1);}finally{release();await first;}
});

test('runtime contract quota handoff starts the receiver session with the same checkpoint but never forwards another provider session ID',async t=>{
  const {path}=await setup(t),runner=runnerFor(request=>request.executable==='/fixture/codex'?{code:1,stdout:'',stderr:'quota exhausted'}:undefined),events=[];
  const model=new ConfiguredStructuredModel(path,env,{subscription:options=>new SubscriptionAwareStructuredModel({...options,runner}),api:()=>{throw Error('NO_PAID_API');}},event=>events.push(event)).forWork(context);
  await model.call('correct','Decide.',input,schema);await model.call('correct','Decide.',input,schema);
  const claude=invocations(runner).filter(request=>request.executable==='/fixture/claude');assert.ok(claude[0].args.includes('--session-id'));assert.ok(claude[1].args.includes('--resume'));
  assert.deepEqual(JSON.parse(claude[1].stdin.split('INPUT:\n')[1]).checkpoint,input.checkpoint);assert.equal(events.length,2);assert.ok(events.every(event=>event.source==='codex'&&event.target==='claude'&&event.work_id===context.work_id));
});

test('runtime contract unbound decisions stay ephemeral and unsafe session storage does not become provider failover',async t=>{
  const {path,root}=await setup(t),runner=runnerFor();await factory(path,runner).call('correct','Decide.',input,schema);
  assert.ok(invocations(runner)[0].args.includes('--ephemeral'));assert.equal((await readdir(root)).includes('decision-sessions'),false);
  await symlink(tmpdir(),join(root,'decision-sessions'),'dir');
  await assert.rejects(factory(path,runner).forWork(context).call('correct','Decide.',input,schema),/CLIENT_SESSION_UNSAFE_STORAGE/u);
  assert.equal(invocations(runner).length,1);
});

test('runtime unit assignee TTL turn cap and interrupted state restart safely while proven dead locks recover',async t=>{
  const {root}=await setup(t),scope={root:join(root,'sessions'),...context,actor_id:context.stage_id,role:'worker'},contract={provider:'codex',model:'selected-code',instructions:'Decide.',schema,connection:'fixture',effort:'high'};
  let directory;const starts=[];
  const invoke=async turn=>{directory=turn.directory;starts.push(turn.session_id);return {session_id:turn.session_id??randomUUID(),value:{ok:true}};};
  const call=()=>withDecisionSession(scope,contract,invoke);
  await call();assert.equal((await call()).continuity,'resumed_session');
  for(const patch of [{turns:32},{updated_at:Date.now()-86400001},{updated_at:Date.now()+60000},{in_flight:true}]){
    const file=join(directory,'session.json'),prior=JSON.parse(await readFile(file,'utf8'));await writeFile(file,JSON.stringify({...prior,...patch}));
    const fresh=await call();assert.equal(fresh.continuity,'new_session');assert.equal(fresh.session_turn,1);assert.equal(starts.at(-1),null);
  }
  const dead=spawnSync(process.execPath,['-e','process.exit(0)']);assert.equal(dead.status,0);assert.throws(()=>process.kill(dead.pid,0),{code:'ESRCH'});
  await writeFile(join(directory,'turn.lock'),JSON.stringify({pid:dead.pid}));assert.equal((await call()).continuity,'resumed_session');
  if(process.platform!=='win32'){assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,'session.json'))).mode&0o777,0o600);}
});

test('runtime contract mismatched native session IDs invalidate continuity without replay or provider handoff',async t=>{
  const {path}=await setup(t);let wrong=false;
  const runner=runnerFor(request=>wrong?{code:0,stdout:[{type:'thread.started',thread_id:randomUUID()},{type:'item.completed',item:{type:'agent_message',text:'{"ok":true}'}}].map(JSON.stringify).join('\n'),stderr:''}:undefined);
  const call=()=>factory(path,runner).forWork(context).call('correct','Decide.',input,schema);
  await call();wrong=true;await assert.rejects(call(),/CLIENT_STRUCTURED_OUTPUT_INVALID/u);assert.equal(invocations(runner).length,2);
  wrong=false;await call();assert.equal(invocations(runner).at(-1).args.includes('resume'),false);
});

test('runtime contract failure to persist an accepted session receipt does not call a second provider',async t=>{
  const {path}=await setup(t),runner=runnerFor(async request=>{if(request.args.includes('exec'))await rename(request.cwd,request.cwd+'-moved');});
  await assert.rejects(factory(path,runner).forWork(context).call('correct','Decide.',input,schema),/CLIENT_SESSION_PERSIST_FAILED/u);
  assert.equal(invocations(runner).length,1);
});
