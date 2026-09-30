import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WORK_PLANNING_CONTEXT_INSTRUCTIONS,WORK_REPLANNING_INSTRUCTIONS,WORK_DEFINITION_INSTRUCTIONS,validateOrCorrectWorkProposal} from '../dist/work/runtime.js';

const proposal={title:'ASTS source research',desired_outcome:'Read observed ASTS sources and provide a summary.',completion_checks:[{id:'sources',result:'Sources are retained',evidence:'Actual source receipts'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],browser:{environment:'owned_headless'}};
const aside={id:'windows-host-aside',engine:'aside',environment:'host_foreground',platform:'win32',profile_ref:'registered-aside',executable:'/mnt/c/fixture/aside.exe'};
const wait={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The fixture stops before browser dispatch.',completed_checks:[],wait_reason:'configuration'};
const noPlan=spec=>{const {plan,...raw}=spec;return raw;};
const preferRegisteredAside=input=>{const target=input.executor_capabilities.browser_executors.find(item=>item.id===aside.id);assert.ok(target);return {...noPlan(input.previous_spec),browser:{environment:target.environment,preferred_engine:target.engine}};};

async function fixture(t,{replan=preferRegisteredAside,correction=null,initialBrowser=proposal.browser,direction='Use the connected Windows host Aside to continue the same research.'}={}){
  const root=await mkdtemp(join(tmpdir(),'work-planning-context-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'planning-fixture',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true},browser_executors:{targets:[{id:'public-headless',engine:'playwright',environment:'owned_headless',platform:process.platform,profile_ref:'public'},aside]}}));
  const config=loadHostConfig(path),model={calls:[],inputs:[],async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});this.inputs.push({purpose,instructions,input:structuredClone(input)});
    if(instructions.includes('OUTPUT-ONLY CORRECTION:')){assert.ok(correction,'No unexpected correction');return correction(input);}
    if(instructions.startsWith('Define one durable'))return structuredClone({...proposal,browser:initialBrowser});
    if(instructions.startsWith('Revise this existing'))return replan(input);
    assert.ok(instructions.startsWith('Execute the registered Work'));return structuredClone(wait);
  }},api=new RuntimeApi(config,{swarmModel:model});
  const work=await api.work.start({request_id:'planning-work',prompt:'Read ASTS sources.'}),supervisor=new WorkSupervisor(api.store,config,model,{api,auto_start:false,tick_ms:10}),run=randomUUID(),at=new Date().toISOString();
  const observation={invocation:{request_id:'preserved-source',turn:0,stage_id:'source',tool_name:'office_browser_read',arguments:{url:'https://example.org/actual-source'},effect:'read_only',dispatched:true},receipt:{status:'succeeded',effect_state:'none',value:{title:'Observed source'},evidence_ids:['preserved-source'],retry_safe:true},observed_at:at};
  const checkpoint={format:1,work_id:work.work_id,run_id:run,binding:'a'.repeat(64),turn:1,pending:null,observations:[observation],summary:'Preserved source observation.'};
  api.store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(run,config.project.id,work.work_id,work.revision,'paused',JSON.stringify(checkpoint),config.fingerprint,0,at,at);
  t.after(async()=>{await supervisor.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const edited=supervisor.action({work_id:work.work_id,revision:work.revision,action:'edit',instruction:direction});supervisor.action({work_id:work.work_id,revision:edited.revision,action:'resume'});supervisor.activate();
  let status;for(let i=0;i<100;i++){status=supervisorStatus(api.store,config.project.id,work.work_id,config);if(!['queued','running'].includes(status.state))break;await delay(20);}
  assert.ok(['paused','failed'].includes(status.state),JSON.stringify(status));
  return {config,api,model,work,run,status,checkpoint,saved:JSON.parse(api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(run).checkpoint),spec:api.store.intakeWork(config.project.id,work.work_id).spec};
}

test('runtime fixture replan uses the definition capability inventory and selects registered Windows host Aside without inventing a guest',async t=>{
  const x=await fixture(t),definition=x.model.inputs.find(call=>call.instructions.startsWith('Define one durable')),replan=x.model.inputs.find(call=>call.instructions.startsWith('Revise this existing'));
  assert.deepEqual(replan.input.executor_capabilities,definition.input.executor_capabilities);assert.deepEqual(replan.input.executor_capabilities, x.api.work.planningContext().executor_capabilities);
  const actual=replan.input.executor_capabilities.browser_executors.find(target=>target.id===aside.id);assert.equal(actual.platform,'win32');assert.equal(actual.environment,'host_foreground');assert.equal(actual.engine,'aside');assert.equal(actual.health,'unknown');assert.equal(actual.verified_for_environment,false);
  assert.ok(!replan.input.executor_capabilities.browser_executors.some(target=>target.environment==='windows_vm'));assert.ok(replan.input.executor_capabilities.windows,'Replan retains the same native capability context as API definition');
  assert.deepEqual(replan.input.connected_sources,definition.input.connected_sources);assert.deepEqual(replan.input.social_source_candidates,definition.input.social_source_candidates);assert.deepEqual(replan.input.windows_profiles,definition.input.windows_profiles);assert.equal(replan.input.work_id,x.work.work_id);assert.equal(replan.input.mode,'quick');assert.deepEqual(replan.input.answers,{});
  assert.deepEqual(x.spec.browser,{environment:'host_foreground',preferred_engine:'aside'});assert.deepEqual(replan.input.previous_spec.browser,{environment:'owned_headless'});assert.equal(x.status.run_id,x.run);assert.deepEqual(x.saved.observations,x.checkpoint.observations);assert.equal(x.saved.pending,null);assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);
  for(const instructions of [definition.instructions,replan.instructions]){assert.ok(instructions.includes(WORK_PLANNING_CONTEXT_INSTRUCTIONS));assert.match(instructions,/platform=win32 does not mean environment=windows_vm/u);assert.match(instructions,/Do not replace that failure with Bing or DuckDuckGo or change the query/u);assert.match(instructions,/Other login\/CAPTCHA\/access challenges remain stop boundaries/u);assert.doesNotMatch(instructions,/A blocked public search provider is not a reason to abandon/u);}
});

test('runtime contract explicitly requested unavailable Windows VM stays a connection requirement and is never silently relocated to host Aside',async t=>{
  const requested={environment:'windows_vm',preferred_engine:'aside'},x=await fixture(t,{direction:'Use Aside only inside a Windows VM. Do not use the host browser.',replan:input=>{assert.match(input.user_directions.at(-1).instruction,/only inside a Windows VM/u);return {...noPlan(input.previous_spec),browser:requested,assumptions:[{field:'browser connection',value:'Windows VM Aside is missing; wait for its registration.',basis:'The user explicitly requires the unregistered VM environment.'}]};}});
  assert.equal(x.status.state,'paused',JSON.stringify(x.status));assert.deepEqual(x.spec.browser,requested);assert.deepEqual(x.saved.observations,x.checkpoint.observations);assert.equal(x.model.inputs.filter(call=>call.instructions.includes('OUTPUT-ONLY CORRECTION:')).length,0);assert.ok(x.spec.assumptions[0].value.includes('missing'));
});

test('runtime fixture a latest host-browser direction can correct an earlier model-proposed Windows VM without schema-correction freezing it',async t=>{
  const initialBrowser={environment:'windows_vm',preferred_engine:'aside'},x=await fixture(t,{initialBrowser});
  const replanning=x.model.inputs.find(call=>call.instructions.startsWith('Revise this existing'));assert.deepEqual(replanning.input.previous_spec.browser,initialBrowser);assert.deepEqual(x.spec.browser,{environment:'host_foreground',preferred_engine:'aside'});assert.equal(x.model.inputs.filter(call=>call.instructions.includes('OUTPUT-ONLY CORRECTION:')).length,0);assert.deepEqual(x.saved.observations,x.checkpoint.observations);
});

test('runtime fixture one schema correction during replan receives the same complete capabilities and keeps its proposed browser constraint',async t=>{
  const x=await fixture(t,{replan:input=>({...preferRegisteredAside(input),route:{kind:'pack',pack_family:null}}),correction:input=>({...preferRegisteredAside(input.original_input),route:{kind:'pack',pack_family:'research.search'}})});
  const initial=x.model.inputs.find(call=>call.instructions.startsWith('Revise this existing')&&!call.instructions.includes('OUTPUT-ONLY CORRECTION:')),repairs=x.model.inputs.filter(call=>call.instructions.includes('OUTPUT-ONLY CORRECTION:'));
  assert.equal(repairs.length,1);assert.deepEqual(repairs[0].input.original_input,initial.input);assert.equal(repairs[0].input.validation_error.code,'WORK_ROUTE_FAMILY_REQUIRED');assert.deepEqual(x.spec.browser,{environment:'host_foreground',preferred_engine:'aside'});assert.equal(x.status.state,'paused');assert.deepEqual(x.saved.observations,x.checkpoint.observations);
});

for(const boundary of ['changed_environment','second_invalid','provider_error'])test(`runtime contract replan ${boundary} fails without an unbounded correction, spec replacement or dispatched source`,async t=>{
  const x=await fixture(t,{replan:input=>{if(boundary==='provider_error')throw Error('MODEL_CONNECTION_UNAVAILABLE');return {...noPlan(input.previous_spec),browser:{environment:'windows_vm',preferred_engine:'aside'},route:{kind:'pack',pack_family:null}};},correction:input=>({...noPlan(input.original_input.previous_spec),browser:boundary==='changed_environment'?{environment:'host_foreground',preferred_engine:'aside'}:{environment:'windows_vm',preferred_engine:'aside'},route:{kind:'pack',pack_family:boundary==='second_invalid'?null:'research.search'}})});
  assert.equal(x.status.state,'failed');assert.deepEqual(x.spec.browser,proposal.browser);assert.deepEqual(x.saved,x.checkpoint);assert.equal(x.model.inputs.filter(call=>call.instructions.includes('OUTPUT-ONLY CORRECTION:')).length,boundary==='provider_error'?0:1);assert.equal(x.model.inputs.filter(call=>call.instructions.startsWith('Execute the registered Work')).length,0);assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run').get().n,0);
});

test('runtime contract output-only schema repair preserves explicit unavailable environments and an omitted browser default',async()=>{
  for(const browser of [undefined,{environment:'windows_vm',preferred_engine:'aside'}]){
    const base={...proposal,...(browser?{browser}:{})};if(!browser)delete base.browser;
    const invalid={...base,route:{kind:'pack',pack_family:null}},scopeChanges=[];
    const rejected={calls:[],async call(...args){scopeChanges.push(args);return {...base,browser:{environment:'host_foreground',preferred_engine:'aside'}};}};
    await assert.rejects(validateOrCorrectWorkProposal(invalid,'quick',false,{model:rejected,instructions:WORK_REPLANNING_INSTRUCTIONS,input:{prompt:'Retain my exact browser choice'}}),/WORK_DEFINITION_INVALID_AFTER_CORRECTION/u);assert.equal(scopeChanges.length,1);
    const preserving={calls:[],async call(){return base;}};assert.deepEqual((await validateOrCorrectWorkProposal(invalid,'quick',false,{model:preserving,instructions:WORK_DEFINITION_INSTRUCTIONS,input:{}})).browser,browser);
  }
});
