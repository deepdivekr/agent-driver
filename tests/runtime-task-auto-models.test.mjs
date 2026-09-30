import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ConfiguredStructuredModel} from '../dist/onboarding/configured-model.js';
import {saveModelSettings,readModelSettings,roleModelConfiguration,scopedModelSettingsPath,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {subscriptionTaskModelCandidates,validateTaskModelAllocation} from '../dist/onboarding/task-models.js';
import {allocateWorkModels,readTaskModelReceipt,taskModelReceiptView} from '../dist/work/task-models.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {readWorkDetail} from '../dist/observability/work-view.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {chromium} from 'playwright';
import {startControlCenter} from '../dist/observability/control-center.js';

const roles=['planner','worker','verifier','synthesis'];
const choice={mode:'subscription',client:'codex',role_model_mode:'auto',client_models:{codex:'base-model',claude:'base-review',opencode:null},codex_reasoning_effort:'high',api_model:'api-model',reasoning:'high',jev:'off'};
const candidates=roles.map((role,i)=>({id:(i===2?'claude-':'codex-')+hashJson(role).slice(0,16),client:i===2?'claude':'codex',model:role+'-model',label:role+' model'}));
const allocation=()=>({assignments:candidates.map((candidate,i)=>({role:roles[i],candidate_id:candidate.id,reason:'Fits this task role from the supplied candidates.'}))});
const proposal={title:'Collect source',desired_outcome:'Read the value from the source.',completion_checks:[{id:'read',result:'Source value 23',evidence:'Observed file result.'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'Read source.',sources:[{id:'source',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
const scalarSchema={type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false};
async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'task-auto-models-')),host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'task-model-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'source',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const path=modelSettingsPath(config);saveModelSettings(path,{revision:0,onboarding_step:3,selection:{...choice,...options.selection},...(options.selection?.mode==='api'?{api_action:'replace',api_key:'fixture-only-not-a-real-provider-key'}:{})},{});
  const requests=[];let candidateReads=0;
  const answer=async(purpose,instructions,input)=>{
    if(instructions.startsWith('Assign the four'))return options.allocation?options.allocation(input):allocation();
    if(instructions.startsWith('Define one durable'))return proposal;
    if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{const ids=check.allowed_evidence_ids.filter(id=>input.observations.some(o=>o.tool_name!=='office_controlled_run_trace'&&o.evidence_ids.includes(id)));return {id:check.id,verdict:'supported',evidence_ids:ids,evidence_quotes:ids.map(id=>({evidence_id:id,quote:'Observed source'})),reason:'Actual file result contains the requested value.'};})};
    if(instructions.startsWith('Execute the registered Work')){
      const result=input.checkpoint.observations.find(o=>o.invocation.tool_name==='runtime_pack_run');
      return result?{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(c=>({id:c.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null}:{action:'tool',stage_id:'read',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'host-overrides-id',recipe}),summary:'Read the source through the Pack.',completed_checks:[],wait_reason:null};
    }
    return {ok:true};
  };
  const factories={taskCandidates:async()=>{candidateReads++;return options.candidates??candidates;},api:()=>{throw Error('PAID_API_MUST_NOT_RUN');},subscription:settings=>({calls:[],async call(purpose,instructions,input,schema){
    const provider=settings.environment.AGENT_DRIVER_LLM_CLIENT.split(',')[0],model=settings.environment['AGENT_DRIVER_'+provider.toUpperCase()+'_MODEL'];
    requests.push({purpose,instructions,input:structuredClone(input),schema:structuredClone(schema),settings,provider,model});
    const result=await answer(purpose,instructions,input);this.calls.push({purpose,provider,model,status:'accepted',elapsed_ms:1,input_sha256:hashJson(input),input_tokens:10,output_tokens:5,total_tokens:15});return result;
  }})};
  const fresh=()=>new ConfiguredStructuredModel(path,{},factories),model=fresh(),runtime=new WorkRuntime(store,config,model),work=await runtime.start({request_id:'work-one',prompt:'Read the local source.'});
  const cleanup=[];t.after(async()=>{for(const close of cleanup.reverse())await close();store.close();await rm(root,{recursive:true,force:true});});
  const bind=(run=randomUUID(),id=work.work_id)=>fresh().forWork({work_id:id,run_id:run});
  return {root,config,store,path,model,runtime,work,requests,factories,fresh,bind,cleanup,candidateReads:()=>candidateReads,task:{prompt:work.prompt,spec:work.spec}};
}
test('runtime unit automatic candidates require observed subscription auth and use installed model catalogs only',async()=>{
  const cataloged=[];
  const found=await subscriptionTaskModelCandidates({}, {probe:async id=>({id,status:'ready',auth:id==='opencode'?'unknown':'subscription',structured_bridge:true,reason:'fixture'}),catalog:async id=>{cataloged.push(id);return {status:'available',source:'fixture',fetched_at:new Date().toISOString(),models:[{id:'live-'+id,label:'live-'+id},{id:'bad model',label:'invalid'},{id:'apikey_not-a-model',label:'secret-shaped'}]};}});
  assert.deepEqual(cataloged.sort(),['claude','codex']);assert.equal(found.length,2);assert.ok(found.every(c=>c.model==='live-'+c.client));
  assert.deepEqual(await subscriptionTaskModelCandidates({}, {probe:async id=>({id,status:'expired',auth:'subscription',structured_bridge:true}),catalog:async()=>{throw Error('MUST_NOT_DISCOVER');}}),[]);
});
test('runtime unit allocation validates all roles and candidate membership without accepting provider or authority fields',()=>{
  assert.equal(validateTaskModelAllocation(allocation(),candidates).length,4);
  const inherited=allocation();inherited.assignments[0].candidate_id='INHERIT';assert.equal(validateTaskModelAllocation(inherited,candidates)[0].model,null);
  for(const mutate of [a=>a.assignments[0].candidate_id='openrouter-paid',a=>a.assignments[0].role='worker',a=>a.assignments.pop(),a=>a.assignments[1].api_key='not-allowed',a=>a.execute=true]){const value=allocation();mutate(value);assert.throws(()=>validateTaskModelAllocation(value,candidates));}
});
test('runtime contract inherit and manual preserve legacy choices; auto does not accidentally use hidden manual overrides',async t=>{
  const x=await setup(t),selection={...choice,role_models:{worker:{codex:'manual-reader',claude:null,opencode:null}}};
  for(const [mode,expected] of [[undefined,'manual-reader'],['manual','manual-reader'],['inherit','base-model'],['auto','base-model']]){
    const saved=readModelSettings(x.path),next={...selection};if(mode===undefined)delete next.role_model_mode;else next.role_model_mode=mode;
    saveModelSettings(x.path,{revision:saved.revision,onboarding_step:3,selection:next},{});
    assert.equal(roleModelConfiguration(x.path,'global',{},'worker').environment.AGENT_DRIVER_CODEX_MODEL,expected);
  }
});
test('runtime fixture task allocation reaches each role, persists through restart and never leaks into another Work',async t=>{
  const x=await setup(t),workId=x.work.work_id,project=x.config.project.id;
  const model=await allocateWorkModels(x.store,project,workId,x.bind(),x.task,()=>{});
  assert.equal(x.candidateReads(),1);assert.equal(x.requests.filter(r=>r.instructions.startsWith('Assign the four')).length,1);
  const allocationRequest=x.requests.find(r=>r.instructions.startsWith('Assign the four'));
  assert.equal(allocationRequest.input.defaults.models.codex,'base-model');assert.equal(allocationRequest.input.defaults.codex_reasoning_effort,'high');
  for(const role of roles)await model.forRole(role).call('correct','Read only',{task:'current'},scalarSchema);
  assert.deepEqual(x.requests.slice(-4).map(r=>r.model),roles.map(r=>r+'-model'));assert.ok(x.requests.slice(-4).every(r=>r.settings.subscriptionOnly));assert.ok(x.requests.every(r=>r.settings.environment.AGENT_DRIVER_CODEX_REASONING_EFFORT==='high'));
  const restarted=await allocateWorkModels(x.store,project,workId,x.bind(),x.task,()=>{});await restarted.forRole('worker').call('correct','Read only',{},scalarSchema);
  assert.equal(x.candidateReads(),1);assert.equal(x.requests.at(-1).model,'worker-model');
  const other=await x.runtime.start({request_id:'other-work',prompt:'Read another source.'});
  await model.forWork({work_id:other.work_id,run_id:randomUUID()}).forRole('worker').call('correct','Read only',{},scalarSchema);
  assert.equal(x.requests.at(-1).model,'base-model');
  await allocateWorkModels(x.store,project,other.work_id,x.bind(undefined,other.work_id),x.task,()=>{});assert.equal(x.candidateReads(),2);
  assert.equal(readModelSettings(x.path).selection.client_models.codex,'base-model');
  const receipt=readTaskModelReceipt(x.store,project,workId);assert.equal(receipt.status,'assigned');assert.equal(receipt.allocator.total_tokens,15);
  const view=taskModelReceiptView(x.store,project,workId);assert.equal(view.execution_proven,false);assert.equal(view.assignments[2].client,'claude');assert.equal(readWorkDetail(x.store,x.config,workId).task_models.status,'assigned');
});
test('runtime fixture task or settings changes invalidate allocation; in-flight settings change never commits stale choices',async t=>{
  const x=await setup(t),project=x.config.project.id,id=x.work.work_id;
  await allocateWorkModels(x.store,project,id,x.bind(),x.task,()=>{});
  await allocateWorkModels(x.store,project,id,x.bind(),{...x.task,prompt:'A changed task.'},()=>{});assert.equal(x.candidateReads(),2);
  const prior=readModelSettings(x.path);saveModelSettings(x.path,{revision:prior.revision,onboarding_step:3,selection:{...prior.selection,client_models:{...prior.selection.client_models,codex:'new-default'}}},{});
  await allocateWorkModels(x.store,project,id,x.bind(),x.task,()=>{});assert.equal(x.candidateReads(),3);
  const before=readTaskModelReceipt(x.store,project,id);let guards=0;
  await assert.rejects(allocateWorkModels(x.store,project,id,x.bind(),{new:true},()=>{if(++guards===3){const old=readModelSettings(x.path);saveModelSettings(x.path,{revision:old.revision,onboarding_step:3,selection:{...old.selection,role_model_mode:'inherit'}},{});}}),/MODEL_SETTINGS_CHANGED/);
  assert.deepEqual(readTaskModelReceipt(x.store,project,id),before);
});
test('runtime fixture missing invalid or unavailable allocation falls back visibly and does not retry every model turn',async t=>{
  for(const options of [{candidates:[]},{allocation:()=>({assignments:[{role:'worker',candidate_id:'API',reason:'untrusted'}]})},{allocation:()=>{throw Error('MODEL_UNAVAILABLE');}}]){
    const x=await setup(t,options),project=x.config.project.id,id=x.work.work_id,run=randomUUID(),model=await allocateWorkModels(x.store,project,id,x.bind(run),x.task,()=>{});
    assert.equal(readTaskModelReceipt(x.store,project,id).status,'fallback');
    for(let i=0;i<2;i++)await model.forRole('worker').call('correct','Read only',{},scalarSchema);
    assert.equal(x.requests.at(-1).model,'base-model');await allocateWorkModels(x.store,project,id,x.bind(run),x.task,()=>{});assert.equal(x.candidateReads(),1);
    await allocateWorkModels(x.store,project,id,x.bind(),x.task,()=>{});assert.equal(x.candidateReads(),2,'a later run can retry a formerly unavailable connection');
  }
});
test('runtime contract optional allocation does not swallow session receipt or connection safety fences',async t=>{
  for(const code of ['CLIENT_SESSION_BUSY','CLIENT_SESSION_UNSAFE_STORAGE','CLIENT_SESSION_PERSIST_FAILED','CLIENT_HANDOFF_PERSIST_FAILED','CLIENT_CONNECTION_CHANGED']){
    const x=await setup(t,{allocation:()=>{throw Error(code);}});
    await assert.rejects(allocateWorkModels(x.store,x.config.project.id,x.work.work_id,x.bind(),x.task,()=>{}),error=>error.message===code);
    assert.equal(readTaskModelReceipt(x.store,x.config.project.id,x.work.work_id),null);
    assert.equal(x.requests.filter(r=>r.instructions.startsWith('Assign the four')).length,1);
    assert.equal(x.requests.filter(r=>r.instructions.startsWith('Execute the registered Work')).length,0);
  }
});
test('runtime contract API mode API-to-auth and dedicated coding settings never apply automatic allocation',async t=>{
  const x=await setup(t),project=x.config.project.id,id=x.work.work_id;
  const allocated=await allocateWorkModels(x.store,project,id,x.bind(),x.task,()=>{});
  saveModelSettings(scopedModelSettingsPath(x.path,'coding'),{revision:0,onboarding_step:3,inherit_global:false,selection:{...choice,client_models:{...choice.client_models,codex:'coding-default'}}},{});
  const coding=allocated.forScope('coding');assert.equal(await allocateWorkModels(x.store,project,id,coding,x.task,()=>{}),coding);await coding.forRole('worker').call('correct','Read only',{},scalarSchema);assert.equal(x.requests.at(-1).model,'coding-default');
  const saved=readModelSettings(x.path);saveModelSettings(x.path,{revision:saved.revision,onboarding_step:3,selection:{...choice,mode:'api',api_to_subscription:true},api_action:'replace',api_key:'fixture-only-not-a-real-provider-key'},{});
  assert.equal(allocated.taskModelContext(),null);assert.equal(await allocateWorkModels(x.store,project,id,allocated,x.task,()=>{}),allocated);assert.equal(x.candidateReads(),1);
  const api={calls:[],async call(purpose){this.calls.push({purpose,provider:'openai_api',model:'api-model',status:'failed',http_status:429});throw Error('quota');}};
  const fallback=new ConfiguredStructuredModel(x.path,{}, {...x.factories,api:()=>api}).forWork({work_id:id,run_id:randomUUID()});
  await fallback.forRole('worker').call('correct','Read only',{},scalarSchema);assert.equal(x.requests.at(-1).model,'base-model');
});
test('runtime fixture supervisor allocates before actual Pack I/O and verifier receives its independent role model',async t=>{
  const x=await setup(t),supervisor=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25});x.cleanup.push(()=>supervisor.close());
  supervisor.start(x.work.work_id,x.work.revision,true);
  let end;for(let i=0;i<160;i++){end=supervisorStatus(x.store,x.config.project.id,x.work.work_id);if(['succeeded','failed','awaiting_review','waiting_model','paused'].includes(end?.state))break;await delay(25);}
  assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
  const execution=x.requests.filter(r=>r.instructions.startsWith('Execute the registered Work')),verification=x.requests.filter(r=>r.instructions.startsWith('Independently verify'));
  assert.ok(execution.length>0&&execution.every(r=>r.model==='worker-model'));assert.ok(verification.length>0&&verification.every(r=>r.model==='verifier-model'&&r.provider==='claude'));
  const detail=readWorkDetail(x.store,x.config,x.work.work_id);assert.equal(detail.task_models.status,'assigned');assert.ok(detail.activity.some(e=>e.kind==='models.allocating'));assert.ok(detail.activity.some(e=>e.kind==='models.assigned'));
  assert.equal(x.requests.filter(r=>r.instructions.startsWith('Assign the four')).length,1);
});

test('runtime fixture Work allocation detail is localized escaped and readable at desktop and mobile sizes',{timeout:60000},async t=>{
  const x=await setup(t,{allocation:()=>{const value=allocation();value.assignments[0].reason='<img src=x onerror=alert(1)> Candidate fit.';return value;}});
  const supervisor=new WorkSupervisor(x.store,x.config,x.model,{tick_ms:25});x.cleanup.push(()=>supervisor.close());
  supervisor.start(x.work.work_id,x.work.revision,true);
  let end;for(let i=0;i<160;i++){end=supervisorStatus(x.store,x.config.project.id,x.work.work_id);if(['succeeded','failed','awaiting_review','waiting_model','paused'].includes(end?.state))break;await delay(25);}
  assert.equal(end?.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
  const server=await startControlCenter(x.config,{workModel:x.model}),browser=await chromium.launch({headless:true});x.cleanup.push(async()=>{await browser.close();await server.close();});await mkdir('tests/evidence/phase108',{recursive:true});
  for(const width of [1280,390])for(const lang of ['ko','en']){
    const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(value=>{localStorage.setItem('office-lang',value);localStorage.setItem('office-theme','dark');},lang);
    await page.goto(server.url+'?work='+x.work.work_id);const panel=page.locator('#task-model-allocation');await panel.locator('summary').click();
    assert.equal(await panel.locator('li').count(),4);assert.ok((await panel.innerText()).includes('verifier-model'));assert.equal(await panel.locator('img').count(),0);
    assert.match(await page.locator('#work-timeline').innerText(),/worker-model/u);
    assert.doesNotMatch(await page.locator('#work-timeline').innerText(),/상세 원인|detailed cause/u);
    await page.evaluate(()=>renderDetail());assert.equal(await panel.evaluate(element=>element.open),true,'a live detail refresh keeps this Work allocation disclosure open');
    await panel.evaluate(element=>element.dataset.workId='different-work');await page.evaluate(()=>renderDetail());assert.equal(await panel.evaluate(element=>element.open),false,'another Work never inherits this disclosure state');
    await page.evaluate(()=>{const previous=detail;detail=null;renderDetail();detail=previous;renderDetail();});assert.equal(await panel.evaluate(element=>element.open),false,'an empty/loading detail renders without an old allocation panel');
    await panel.locator('summary').click();
    if(lang==='en')assert.doesNotMatch(await panel.innerText(),/[가-힣]/u);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
    await page.screenshot({path:`tests/evidence/phase108/task-allocation-${lang}-${width}.png`,fullPage:true});assert.deepEqual(errors,[]);await page.close();
  }
});
