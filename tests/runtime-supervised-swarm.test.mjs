import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {executeSupervisedSwarm,assessSupervisedStages,supervisedSwarmCheckpointSchema} from '../dist/work/swarm-executor.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkResults} from '../dist/work/results.js';
import {initialWorkPlan,validateWorkPlan} from '../dist/work/plan.js';
import {stageBinding} from '../dist/work/stages.js';
import {observedCompletionFixture} from './helpers/observed-completion-fixture.mjs';

const goal='Research six physical AI sources, preserve citations and summarize their common findings.';
const draft=()=>{const sources=Array.from({length:6},(_,i)=>({id:`source-${i+1}`,role:'Read one source',objective:`Read https://example.test/source-${i+1} and report the observed evidence.`,stage:'source_read',source_urls:[`https://example.test/source-${i+1}`],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Source-backed fact cards.'],max_steps:12,timeout_ms:75000}));return {summary:'Read six sources in parallel, reduce and synthesize.',workers:[...sources,{...sources[0],id:'reduce',role:'Reduce evidence',objective:'Combine all source facts without losing their evidence.',stage:'reduction',source_urls:[],depends_on:sources.map(worker=>worker.id)},{...sources[0],id:'final',role:'Synthesize results',objective:'Produce the final source-backed digest.',stage:'synthesis',source_urls:[],depends_on:['reduce']}]};};
const proposal={title:'Physical AI sources',desired_outcome:goal,completion_checks:[{id:'report',result:'Source-backed digest.',evidence:'Observed source evidence.'}],assumptions:[],route:{kind:'swarm',pack_family:null},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'office-supervised-swarm-')),path=join(root,'host.json'),calls=[],inputs=[];
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'supervised-swarm',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true,max_logical_workers:24,max_concurrency:4,lease_ms:120000,visual:{enabled:true,max_contexts:4}}}));
  const model={calls,async call(purpose,instructions,input){
    inputs.push({purpose,instructions,input:structuredClone(input)});
    calls.push({purpose,provider:'fixture',model:'fixture-llm',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});
    if(instructions.startsWith('Define one durable'))return proposal;
    if(instructions.startsWith('Assess only the listed business stages'))return {completed_stages:input.stages.map(stage=>({stage_id:stage.id,evidence_ids:[stage.verified_workers?.[0]?.evidence_ids?.[0]??stage.host_readbacks?.find(item=>item.tool_name==='office_result_read')?.evidence_ids?.[0]]}))};
    if(instructions.startsWith('Independently verify')){
      if(options.finalUnsupported)return {checks:input.checks.map(check=>({id:check.id,verdict:'unknown',evidence_use:'observed_result',evidence_ids:[],evidence_quote_refs:[],reason:'The requested extra field was not observed.'}))};
      return observedCompletionFixture(input,{prompt:/Research (?:six|one) physical AI source/u,needle:'Physical AI',accept:item=>item.tool_name==='office_swarm_readback',assertResult:value=>{
        const readback=value.observations.find(item=>item.tool_name==='office_swarm_readback')?.value;
        const single=/Research one physical AI source/u.test(value.original_user_request.prompt);
        assert.equal(readback?.required_workers,single?1:8);assert.equal(readback?.source_coverage?.length,single?1:6);
        assert.ok(readback.source_coverage.every(source=>source.source_urls.length>0&&source.readback?.verified));
        assert.ok(value.observations.some(item=>item.tool_name==='office_result_draft'&&item.effect_state==='verified'),'The Office report must have a verified saved receipt.');
      }});
    }
    if(purpose==='design')return options.plan??draft();
    if(instructions.startsWith('Revise only the allowed existing worker')){
      await options.rebaseHook?.(input);
      const targets=options.rebaseTargets??(input.required_worker_ids.length?input.required_worker_ids:['final']);
      return {reason:'Apply the saved explicit user direction to the smallest existing target.',changes:targets.map(worker_id=>({worker_id,objective:`Follow the new direction: ${input.directions.at(-1).instruction}`,completion_evidence:['The revised source-backed result satisfies the current requested output.']}))};
    }
    if(instructions.startsWith('Execute the registered Work')){
      const tool=input.tools[0].name,worker=input.context.worker.id;
      if(!input.checkpoint.observations.length)return {action:'tool',stage_id:worker,tool_name:tool,arguments_json:'{}',summary:'Read delegated evidence.',completed_checks:[],wait_reason:null};
      return {action:'complete',stage_id:worker,tool_name:null,arguments_json:null,summary:'Evidence was independently observed.',completed_checks:[{id:'observed',evidence_ids:[(tool==='source_read'?'sources-':'predecessors-')+worker]}],wait_reason:null};
    }
    if(instructions.startsWith('Create a concise evidence-backed')){
      const source=input.grounding.sources?.[0],card=input.grounding.predecessors?.[0].report.fact_cards[0];
      return {summary:input.stage_id==='final'&&input.user_directions?.length?`Requested summary: ${input.user_directions.at(-1).instruction}`:'Physical AI evidence-backed result.',facts:[{claim:'Physical AI integrates sensors and control.',source_url:source?.url??card.source_url,source_type:'article',evidence_excerpt:options.invented?'Unobserved invented quotation.':source?.text??card.evidence_excerpt}]};
    }
    if(instructions.startsWith('Score each'))return {relevance:4,evidence:4,usability:4};
    if(instructions.includes('Choices:'))return {choice:input.all_workers_verified?'COMPLETE':'CONTINUE'};
    if(instructions.startsWith('Choose one currently'))return {choice:input.candidates[0]};
    throw Error('UNEXPECTED_FIXTURE_MODEL_CALL');
  }};
  let active=0,peak=0;const reads=[],released=[],visual={async assign(){return {surface_id:'fixture-surface',kind:'browser'};},async perform(_run,worker,_lease,command){
    reads.push({worker,command});active++;peak=Math.max(peak,active);await delay(15);active--;
    if(options.blockSource===worker)throw Error('BROWSER_AUTH_REQUIRED');
    const text=options.changedReadback&&command.action==='observe'?'Page changed, the first excerpt disappeared.':`Physical AI integrates sensors and control. Observed ${worker}.`;
    return {surface_id:`surface-${worker}`,url:`https://example.test/${worker}`,title:'Physical AI',text,links:[],captured_at:new Date().toISOString()};
  },async release(_run,worker){released.push(worker);},async close(){}};
  const api=new RuntimeApi(loadHostConfig(path),{swarmModel:model,swarmVisual:visual});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const work=await api.call('runtime_work_start',{request_id:'supervised-work',prompt:options.prompt??goal});
  const saved=[],events=[],hooks={guard:()=>{},checkpoint:value=>saved.push(structuredClone(value)),progress:event=>events.push(event)};
  return {api,model,work,saved,events,hooks,reads,released,inputs,peak:()=>peak};
}

function semanticPlan(steps){
  const base=initialWorkPlan(goal,'local_file_write');
  return validateWorkPlan({...base,steps:steps.map(step=>({tool_hints:[],evidence_ids:[],...step}))});
}
const semanticSteps=()=>[
  {id:'collect',goal:'Read public source evidence.',observable_outcome:'Source claims and excerpts are independently observed.',depends_on:[],effect:'read_only'},
  {id:'report',goal:'Save a concise report.',observable_outcome:'The report file is saved and read back.',depends_on:['collect'],effect:'local_write'},
];
const semanticDraft=()=>({summary:'Read and report.',work_output_stage_id:'report',workers:[{...draft().workers[0],work_stage_id:'collect'}]});

test('runtime fixture semantic Swarm does not equate a finished worker with saved business output',async t=>{
  const plan=semanticPlan(semanticSteps()),x=await setup(t,{plan:semanticDraft()});
  const request={work_id:x.work.work_id,request_id:'semantic-swarm',goal,plan},result=await executeSupervisedSwarm(x.api,x.model,request,x.hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,false);
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect']);
  assert.equal(result.checkpoint.final_observations.length,0);
  const state=x.api.store.swarmRun(x.api.config.project.id,result.run_id).snapshot;
  assert.equal(state.plan.work_output_stage_id,'report');assert.equal(state.plan.workers[0].work_stage_id,'collect');
  assert.ok(x.events.some(event=>event.worker_id==='source-1'&&event.stage_id==='collect'&&event.stage_binding===stageBinding(plan.steps[0])));
  const at=new Date().toISOString(),binding=stageBinding(plan.steps[1]);
  for(const [tool_name,effect,evidence_id] of [['office_result_draft','local_write','saved-report'],['office_result_read','read_only','read-report']]){
    result.checkpoint.final_observations.push({invocation:{request_id:evidence_id,turn:1,stage_id:'report',stage_binding:binding,tool_name,arguments:{},effect,dispatched:true},receipt:{status:'succeeded',value:{artifact:{path:'/isolated/report.txt',sha256:'a'.repeat(64)}},evidence_ids:[evidence_id],effect_state:effect==='read_only'?'none':'verified',retry_safe:true},observed_at:at});
  }
  await assessSupervisedStages(x.api,x.model,request,result.checkpoint,x.hooks);
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect','report']);
  assert.deepEqual(result.checkpoint.stage_reports[1].evidence_ids,['read-report']);
  const count=x.model.calls.length;
  await assessSupervisedStages(x.api,x.model,request,result.checkpoint,x.hooks);
  assert.equal(x.model.calls.length,count,'unchanged evidence does not rerun stage verification');
});

test('runtime fixture two workers sharing one business stage retain separate worker identities and receipts',async t=>{
  const plan=semanticPlan(semanticSteps()),sources=draft().workers.slice(0,2).map(worker=>({...worker,work_stage_id:'collect'}));
  const workers=[...sources,{...draft().workers.at(-1),depends_on:sources.map(worker=>worker.id),work_stage_id:'collect'}];
  const x=await setup(t,{plan:{summary:'Two independent reads.',work_output_stage_id:'report',workers}});
  const result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'shared-business-stage',goal,plan},x.hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,false);
  assert.deepEqual(result.checkpoint.completed_workers.sort(),['final','source-1','source-2']);
  for(const id of ['source-1','source-2'])assert.equal(result.checkpoint.workers[id].observations[0].invocation.stage_id,'collect');
  assert.deepEqual(new Set(x.events.filter(event=>event.worker_id&&event.stage_id==='collect').map(event=>event.worker_id)),new Set(['source-1','source-2','final']));
  assert.deepEqual(result.checkpoint.stage_reports.map(report=>report.stage_id),['collect']);
});

test('runtime fixture business-stage direction resets all bound workers and dependents but preserves unrelated evidence',async t=>{
  const steps=[
    {id:'collect',goal:'Read two sources.',observable_outcome:'Two source claims are observed.',depends_on:[],effect:'read_only'},
    {id:'other',goal:'Read another source.',observable_outcome:'An independent source claim is observed.',depends_on:[],effect:'read_only'},
    {id:'compose',goal:'Synthesize claims.',observable_outcome:'Source-backed synthesis is read back.',depends_on:['collect','other'],effect:'read_only'},
    {id:'report',goal:'Save report.',observable_outcome:'Report file is saved and read back.',depends_on:['compose'],effect:'local_write'},
  ];
  const plan=semanticPlan(steps),all=draft().workers;
  const workers=[{...all[0],work_stage_id:'collect'},{...all[1],work_stage_id:'collect'},{...all[2],work_stage_id:'other'},{...all.at(-1),depends_on:['source-1','source-2','source-3'],work_stage_id:'compose'}];
  const x=await setup(t,{plan:{summary:'Bound source and synthesis workers.',work_output_stage_id:'report',workers}});
  const request={work_id:x.work.work_id,request_id:'business-direction',goal,plan};
  const first=await executeSupervisedSwarm(x.api,x.model,request,x.hooks),before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,first.run_id).snapshot);
  assert.equal(first.status,'succeeded');assert.deepEqual(first.checkpoint.stage_reports.map(report=>report.stage_id),['collect','other','compose']);
  const direction=saveDirection(x,first.run_id,'collect','Recheck the two collected sources and shorten the synthesis.');
  const next=await executeSupervisedSwarm(x.api,x.model,{...request,checkpoint:first.checkpoint,...direction},x.hooks),after=x.api.store.swarmRun(x.api.config.project.id,first.run_id).snapshot;
  assert.equal(next.status,'succeeded');assert.deepEqual(after.workers['source-3'],before.workers['source-3']);
  const rebase=x.api.store.swarmActivities(x.api.config.project.id,0,500,first.run_id).find(event=>event.kind==='work.direction_rebased');
  assert.deepEqual(new Set(rebase.body.reset_workers),new Set(['source-1','source-2','final']));
  assert.equal(x.reads.filter(read=>read.worker==='source-3').length,2,'unaffected source is not replayed');
  assert.deepEqual(next.checkpoint.stage_reports.map(report=>report.stage_id),['other','collect','compose']);
  const unknown=saveDirection(x,first.run_id,'unlisted_business_stage','Do not silently map unknown business steps.');
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{...request,checkpoint:next.checkpoint,...unknown},x.hooks),/SWARM_DIRECTION_STAGE_NOT_FOUND/u);
});

// Plan B6: a replan that revises an existing stage continues in the same run instead of stopping for review.
test('B6: a revised business stage reruns only its workers and dependents in the same run; added stages still need review',async t=>{
  const steps=[
    {id:'collect',goal:'Read two sources.',observable_outcome:'Two source claims are observed.',depends_on:[],effect:'read_only'},
    {id:'other',goal:'Read another source.',observable_outcome:'An independent source claim is observed.',depends_on:[],effect:'read_only'},
    {id:'compose',goal:'Synthesize claims.',observable_outcome:'Source-backed synthesis is read back.',depends_on:['collect','other'],effect:'read_only'},
    {id:'report',goal:'Save report.',observable_outcome:'Report file is saved and read back.',depends_on:['compose'],effect:'local_write'},
  ];
  const plan=semanticPlan(steps),all=draft().workers;
  const workers=[{...all[0],work_stage_id:'collect'},{...all[1],work_stage_id:'collect'},{...all[2],work_stage_id:'other'},{...all.at(-1),depends_on:['source-1','source-2','source-3'],work_stage_id:'compose'}];
  const x=await setup(t,{plan:{summary:'Bound source and synthesis workers.',work_output_stage_id:'report',workers}});
  const request={work_id:x.work.work_id,request_id:'stage-revision',goal,plan};
  const first=await executeSupervisedSwarm(x.api,x.model,request,x.hooks),before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,first.run_id).snapshot);
  assert.equal(first.status,'succeeded');
  const revised=semanticPlan(steps.map(step=>step.id==='collect'?{...step,goal:'Read two sources and note their publication dates.',observable_outcome:'Two source claims and their dates are observed.'}:step));
  const next=await executeSupervisedSwarm(x.api,x.model,{...request,plan:revised,checkpoint:first.checkpoint},x.hooks),after=x.api.store.swarmRun(x.api.config.project.id,first.run_id).snapshot;
  assert.equal(next.status,'succeeded');assert.equal(next.run_id,first.run_id,'The same run continues.');
  assert.deepEqual(after.workers['source-3'],before.workers['source-3'],'A stage that was not revised keeps its verified worker.');
  const rebase=x.api.store.swarmActivities(x.api.config.project.id,0,500,first.run_id).find(event=>event.kind==='work.direction_rebased');
  assert.deepEqual(new Set(rebase.body.reset_workers),new Set(['source-1','source-2','final']));
  assert.equal(x.reads.filter(read=>read.worker==='source-3').length,2,'The unaffected source is not read again.');
  assert.ok(x.events.some(event=>/Revised stage collect continue/u.test(event.summary)));
  const again=await executeSupervisedSwarm(x.api,x.model,{...request,plan:revised,checkpoint:next.checkpoint},x.hooks);
  assert.equal(again.status,'succeeded');assert.equal(x.api.store.swarmActivities(x.api.config.project.id,0,500,first.run_id).filter(event=>event.kind==='work.direction_rebased').length,1,'Reopening does not rebase again.');
  const added=semanticPlan([...steps.slice(0,3),{id:'translate',goal:'Translate the synthesis.',observable_outcome:'A translated synthesis exists.',depends_on:['compose'],effect:'read_only'},{...steps[3],depends_on:['translate']}]);
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{...request,plan:added,checkpoint:again.checkpoint},x.hooks),/SWARM_DIRECTION_REQUIRES_REVIEW/u,'A stage without workers cannot be continued by keeping workers.');
});

// Fixture equivalent of a persisted, explicitly approved UI edit; no private bot or outbound effect.
function saveDirection(x,runId,stepId,instruction){
  const project=x.api.config.project.id,work=x.api.store.intakeWork(project,x.work.work_id),revision=work.revision+1,at=new Date().toISOString(),direction={run_id:runId,step_id:stepId,instruction,created_at:at};
  x.api.store.transaction(()=>{
    x.api.store.hermesState.prepare('UPDATE office_intake SET revision=?,paused=0,updated_at=? WHERE project_id=? AND work_id=? AND revision=?').run(revision,at,project,work.id,work.revision);
    x.api.store.hermesState.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(work.id,revision,'direction_changed',JSON.stringify(direction),JSON.stringify(work.answers),at);
  });
  return {revision,directions:x.api.store.workDirections(project,work.id)};
}

test('runtime contract supervised Swarm executes three parallel source workers and dependent model workers through existing quality gates',async t=>{
  const x=await setup(t),result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'supervised-swarm',goal,max_parallel:3},x.hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(x.peak(),3);
  assert.equal(result.checkpoint.peak_active_workers,3);assert.equal(result.checkpoint.peak_active_workers,x.peak());
  assert.ok(x.saved.some(checkpoint=>checkpoint.peak_active_workers===3));
  const state=x.api.store.swarmRun(x.api.config.project.id,result.run_id).snapshot;
  assert.equal(state.plan.workers.length,8);assert.equal(state.plan.max_concurrency,3);assert.ok(Object.values(state.workers).every(worker=>worker.status==='succeeded'&&worker.result.readback.verified===true&&worker.quality.accepted===true));
  assert.equal(x.reads.length,12);assert.ok(x.reads.every(read=>read.worker.startsWith('source-')));assert.equal(result.checkpoint.completed_workers.length,8);
  assert.ok(x.saved.some(checkpoint=>Object.keys(checkpoint.workers).length===8));assert.ok(x.events.some(event=>event.worker_id==='reduce'));
  assert.equal(x.inputs.filter(entry=>entry.instructions.startsWith('Execute the registered Work')).length,0);
  assert.equal(x.inputs.filter(entry=>entry.instructions.startsWith('Create a concise evidence-backed')).length,8);
  assert.ok(Object.values(result.checkpoint.workers).every(worker=>worker.observations.length===1&&worker.pending===null&&worker.observations[0].invocation.dispatched===true&&worker.observations[0].receipt.status==='succeeded'));
  for(const worker of Object.values(result.checkpoint.workers)){
    assert.ok(worker.observations.every(item=>item.invocation.effect==='read_only'&&item.receipt.effect_state==='none'));
    assert.ok(worker.observations[0].receipt.value.sources?.length>0||worker.observations[0].receipt.value.predecessors?.length>0);
  }
});

test('runtime fixture single-worker adaptive research verifies completion and writes the same evidence-backed Work result',async t=>{
  const plan={summary:'One bounded source is enough.',workers:[draft().workers[0]]},x=await setup(t,{plan,prompt:'Research one physical AI source, preserve its citation and summarize its finding.'}),results=new WorkResults(x.api.store),s=new WorkSupervisor(x.api.store,x.api.config,x.model,{api:x.api,tick_ms:20});
  t.after(()=>s.close());s.start(x.work.work_id,x.work.revision,true);let end;
  for(let i=0;i<300;i++){end=supervisorStatus(x.api.store,x.api.config.project.id,x.work.work_id);if(['succeeded','failed','awaiting_review'].includes(end?.state))break;await delay(20);}
  assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
  const cp=JSON.parse(x.api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint);
  assert.equal(cp.peak_active_workers,1);assert.equal(cp.final_observations[0].receipt.value.required_workers,1);assert.equal(cp.final_observations[0].receipt.value.fact_cards.length,1);
  const output=results.capture(x.api.config.project.id,x.work.work_id).find(result=>result.source_kind==='client');assert.equal(output.work_completion_verified,true);assert.equal(output.artifacts.length,1);assert.equal(x.reads.length,2);
  await s.close();
});

test('runtime fixture small adaptive graph synthesizes directly and reopens with stable workers without replay',async t=>{
  const all=draft().workers,plan={summary:'Compare two sources.',workers:[...all.slice(0,2),{...all.at(-1),depends_on:all.slice(0,2).map(worker=>worker.id)}]},x=await setup(t,{plan});
  const first=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'small-adaptive',goal},x.hooks);assert.equal(first.status,'succeeded');assert.equal(first.checkpoint.completed_workers.length,3);assert.equal(x.reads.length,4);
  const before=x.model.calls.length,second=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'small-adaptive',goal,checkpoint:first.checkpoint},x.hooks);
  assert.equal(second.run_id,first.run_id);assert.equal(x.model.calls.length,before);assert.equal(x.reads.length,4);
});

test('runtime fixture Work-level Swarm completion requires separate checks and saves an actual Office result artifact',async t=>{
 for(const finalUnsupported of [false,true]){
  const x=await setup(t,{finalUnsupported}),results=new WorkResults(x.api.store),s=new WorkSupervisor(x.api.store,x.api.config,x.model,{api:x.api,tick_ms:20,onResult:id=>results.capture(x.api.config.project.id,id)});
  t.after(()=>s.close());s.start(x.work.work_id,x.work.revision,true);let end;
  for(let i=0;i<300;i++){end=supervisorStatus(x.api.store,x.api.config.project.id,x.work.work_id);if(['succeeded','failed','awaiting_review'].includes(end?.state))break;await delay(20);}
  assert.equal(end.state,finalUnsupported?'awaiting_review':'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,!finalUnsupported);
  const cp=JSON.parse(x.api.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint);
  assert.equal(cp.final_observations.length,2);assert.equal(cp.final_observations[1].receipt.effect_state,'verified');
  assert.equal(cp.peak_active_workers,3);assert.equal(cp.peak_active_workers,x.peak());
  const readback=cp.final_observations[0].receipt.value;
  assert.equal(readback.observed_peak_active_workers,3);assert.equal(readback.host_concurrency_limit,3);
  assert.equal(readback.required_workers,8);assert.equal(readback.verified_worker_stages.length,8);
  assert.ok(readback.verified_worker_stages.every(worker=>worker.status==='succeeded'&&worker.readback_verified&&worker.quality_accepted));
  const output=results.capture(x.api.config.project.id,x.work.work_id).find(result=>result.source_kind==='client');assert.equal(output.work_completion_verified,!finalUnsupported);assert.equal(output.artifacts.length,1);
  const artifact=await results.readArtifact(x.api.config.project.id,x.work.work_id,output.id,output.artifacts[0].id,[join(x.api.config.project.worktree,'data')]);assert.ok(artifact.bytes.toString('utf8').includes('Physical AI evidence-backed result.'));
  await s.close();
 }
});

test('runtime contract a completed supervised Swarm can be reopened without source replay or another model call',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'repeat-swarm',goal},x.hooks),count=x.model.calls.length;
  const reopened=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'repeat-swarm',goal,run_id:initial.run_id,checkpoint:initial.checkpoint},x.hooks);
  assert.equal(reopened.status,'succeeded');assert.equal(x.model.calls.length,count);assert.equal(x.reads.length,12);
  assert.equal(initial.checkpoint.peak_active_workers,3);assert.equal(reopened.checkpoint.peak_active_workers,3);
});

test('runtime contract legacy completed Swarm checkpoint keeps missing concurrency unobserved after serialized resume',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'legacy-concurrency',goal},x.hooks),before=x.model.calls.length;
  assert.equal(initial.checkpoint.peak_active_workers,3);
  const legacy=structuredClone(initial.checkpoint);delete legacy.peak_active_workers;
  const restarted=supervisedSwarmCheckpointSchema.parse(JSON.parse(JSON.stringify(legacy)));
  assert.equal(restarted.peak_active_workers,null);
  const reopened=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'legacy-concurrency',goal,run_id:initial.run_id,checkpoint:restarted},x.hooks);
  assert.equal(reopened.status,'succeeded');assert.equal(reopened.checkpoint.peak_active_workers,null);
  assert.equal(x.model.calls.length,before);assert.equal(x.reads.length,12);
  assert.equal(x.saved.at(-1).peak_active_workers,null);
});

test('runtime contract invented or changed source excerpts fail readback and never become verified success',async t=>{
  for(const options of [{invented:true},{changedReadback:true}]){
    const x=await setup(t,options),result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'bad-evidence',goal},x.hooks);
    assert.notEqual(result.status,'succeeded');assert.equal(result.completion_verified,false);const state=x.api.store.swarmRun(x.api.config.project.id,result.run_id).snapshot;
    assert.ok(Object.values(state.workers).every(worker=>worker.status!=='succeeded'));assert.ok(Object.values(state.workers).some(worker=>worker.result?.error_code==='UNOBSERVED_EVIDENCE_SPAN'));
  }
});

test('runtime contract a supervised Swarm pause retains worker checkpoints and cannot continue dispatching',async t=>{
  const x=await setup(t);let paused=false;
  x.hooks.guard=()=>{if(paused)throw Error('WORK_PAUSED');};x.hooks.progress=event=>{x.events.push(event);if(event.kind==='tool.result')paused=true;};
  const result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'pause-swarm',goal},x.hooks);
  assert.equal(result.status,'paused');assert.ok(Object.keys(result.checkpoint.workers).length>0);assert.ok(x.saved.length>0);assert.equal(x.reads.filter(read=>read.worker==='reduce').length,0);
  assert.equal(result.checkpoint.peak_active_workers,3);assert.equal(x.saved.at(-1).peak_active_workers,3);
});

test('runtime contract cooperative pause requeues the owned read lease and resumes the same run without replaying verified sources',async t=>{
  const x=await setup(t);let paused=false,oldToken;
  x.hooks.guard=()=>{if(paused)throw Error('WORK_PAUSED');};
  x.hooks.progress=event=>{x.events.push(event);if(event.worker_id==='reduce'&&event.kind==='tool.result'){
    oldToken=x.api.store.swarmRun(x.api.config.project.id,x.saved.at(-1).run_id).snapshot.workers.reduce.lease_token;paused=true;
  }};
  const initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'plain-pause-resume',goal},x.hooks);
  assert.equal(initial.status,'paused');assert.ok(oldToken);assert.equal(x.reads.length,12);
  assert.equal(initial.checkpoint.peak_active_workers,3);assert.equal(x.saved.at(-1).peak_active_workers,3);
  const pausedState=structuredClone(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot);
  assert.ok(Object.values(pausedState.workers).filter(worker=>worker.id.startsWith('source-')).every(worker=>worker.status==='succeeded'));
  assert.equal(pausedState.workers.reduce.status,'pending');assert.equal(pausedState.workers.reduce.lease_token,null);assert.equal(initial.checkpoint.workers.reduce.pending,null);
  assert.equal(initial.checkpoint.workers.reduce.observations[0].receipt.status,'succeeded');
  assert.throws(()=>x.api.swarm.activity(initial.run_id,'reduce',oldToken,{kind:'checkpoint',summary:'Stopped actor',endpoint:null}),/STALE_SWARM_LEASE/);
  await assert.rejects(x.api.swarm.report(initial.run_id,'reduce',oldToken,pausedState.workers['source-1'].result),/STALE_SWARM_LEASE/);
  paused=false;x.hooks.progress=event=>x.events.push(event);
  const restoredCheckpoint=supervisedSwarmCheckpointSchema.parse(JSON.parse(JSON.stringify(initial.checkpoint)));
  assert.equal(restoredCheckpoint.peak_active_workers,3);
  const resumed=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'plain-pause-resume',goal,run_id:initial.run_id,checkpoint:restoredCheckpoint},x.hooks);
  assert.equal(resumed.status,'succeeded');assert.equal(resumed.run_id,initial.run_id);assert.equal(x.reads.length,12);
  assert.equal(resumed.checkpoint.peak_active_workers,3);assert.equal(x.saved.at(-1).peak_active_workers,3);
  const after=x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot;
  for(const workerId of ['source-1','source-2','source-3','source-4','source-5','source-6'])assert.deepEqual(after.workers[workerId],pausedState.workers[workerId]);
  assert.equal(resumed.checkpoint.workers.reduce.observations.length,2);
  const released=x.api.store.swarmActivities(x.api.config.project.id,0,500,initial.run_id).filter(event=>event.kind==='worker.lease_released');
  assert.equal(released.length,1);assert.equal(released[0].worker_id,'reduce');assert.equal(released[0].body.reason,'WORK_PAUSED');
  assert.equal(x.inputs.filter(entry=>entry.instructions.startsWith('Revise only the allowed existing worker')).length,0);
});

test('runtime contract source receipts survive pause and resumed unfinished sources require fresh independent readback',async t=>{
  const x=await setup(t);let paused=false;
  x.hooks.guard=()=>{if(paused)throw Error('WORK_SUPERVISOR_STOPPED');};x.hooks.progress=event=>{if(event.kind==='tool.result')paused=true;};
  const initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'source-pause-resume',goal},x.hooks);
  assert.equal(initial.status,'paused');assert.ok(Object.values(initial.checkpoint.workers).some(worker=>worker.pending===null&&worker.observations.at(-1)?.receipt.status==='succeeded'));
  assert.equal(initial.checkpoint.peak_active_workers,3);
  const before=x.reads.length,unfinished=new Set(x.reads.map(read=>read.worker));paused=false;x.hooks.progress=event=>x.events.push(event);
  const resumed=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'source-pause-resume',goal,checkpoint:initial.checkpoint},x.hooks);
  assert.equal(resumed.status,'succeeded');assert.equal(resumed.run_id,initial.run_id);assert.ok(x.reads.length>before);
  assert.equal(resumed.checkpoint.peak_active_workers,3);
  for(const workerId of unfinished)assert.ok(x.reads.slice(before).filter(read=>read.worker===workerId).length>=2);
  assert.ok(Object.values(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot.workers).every(worker=>worker.status==='succeeded'));
  assert.equal(resumed.checkpoint.final_observations.length,0);
});

test('runtime contract read-lease release rejects wrong tokens, unsupported reasons and non-read effects without changing the snapshot',async t=>{
  const x=await setup(t),planned=await x.api.swarm.plan(goal,{},'standard'),run=x.api.swarm.run('lease-release-safety',planned.plan.plan_id,x.work.work_id),batch=await x.api.swarm.batchTick(run.run_id),leased=batch.dispatches[0];
  const before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,run.run_id).snapshot);
  await assert.rejects(x.api.swarm.releaseReadLease(run.run_id,leased.worker_id,'wrong-token','WORK_PAUSED'),/STALE_SWARM_LEASE/);
  await assert.rejects(x.api.swarm.releaseReadLease(run.run_id,leased.worker_id,leased.lease_token,'MODEL_RETRY'),/SWARM_LEASE_RELEASE_REASON_INVALID/);
  assert.deepEqual(x.api.store.swarmRun(x.api.config.project.id,run.run_id).snapshot,before);
  const changed=structuredClone(before);changed.plan.workers.find(worker=>worker.id===leased.worker_id).effect='external_write';changed.revision++;
  x.api.store.updateSwarmRun(x.api.config.project.id,run.run_id,before.revision,changed);
  await assert.rejects(x.api.swarm.releaseReadLease(run.run_id,leased.worker_id,leased.lease_token,'WORK_PAUSED'),/SWARM_LEASE_RELEASE_EFFECT_UNSAFE/);
  assert.deepEqual(x.api.store.swarmRun(x.api.config.project.id,run.run_id).snapshot,changed);
});

test('runtime contract synthesis edit resumes the same run with verified sources and reduction intact',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'edit-final',goal},x.hooks),before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot);
  const direction=saveDirection(x,initial.run_id,'final','Do not create cards. Return a short Korean summary with citations.'),checks=[{id:'summary',result:'A short Korean summary with citations.',evidence:'Verified source evidence, not cards.'}];
  const request={work_id:x.work.work_id,request_id:'edit-final',goal,run_id:initial.run_id,checkpoint:initial.checkpoint,completion_checks:checks,...direction};
  const updated=await executeSupervisedSwarm(x.api,x.model,request,x.hooks),state=x.api.store.swarmRun(x.api.config.project.id,updated.run_id).snapshot;
  assert.equal(updated.status,'succeeded');assert.equal(updated.run_id,initial.run_id);assert.equal(x.reads.length,12);assert.ok(updated.summary.includes('short Korean summary'));
  assert.notEqual(state.plan.plan_id,before.plan.plan_id);assert.ok(state.plan.workers.find(worker=>worker.id==='final').objective.includes('Do not create cards'));
  for(const workerId of ['source-1','source-2','source-3','source-4','source-5','source-6','reduce']){assert.deepEqual(state.workers[workerId],before.workers[workerId]);assert.deepEqual(updated.checkpoint.workers[workerId],initial.checkpoint.workers[workerId]);}
  const rebase=x.api.store.swarmActivities(x.api.config.project.id,0,500,initial.run_id).find(event=>event.kind==='work.direction_rebased');
  assert.deepEqual(rebase.body.changed_workers,['final']);assert.deepEqual(rebase.body.reset_workers,['final']);assert.deepEqual(rebase.body.previous_workers.final,before.workers.final);
  assert.equal(x.api.store.swarmPlan(x.api.config.project.id,before.plan.plan_id).plan.workers.find(worker=>worker.id==='final').objective,'Produce the final source-backed digest.');
  const finalInput=x.inputs.filter(entry=>entry.instructions.startsWith('Create a concise evidence-backed')&&entry.input.stage_id==='final').at(-1).input;
  assert.deepEqual(finalInput.work_completion_checks,checks);assert.equal(finalInput.user_directions.at(-1).instruction,direction.directions[0].instruction);
  const count=x.model.calls.length,reopened=await executeSupervisedSwarm(x.api,x.model,{...request,checkpoint:updated.checkpoint},x.hooks);assert.equal(reopened.status,'succeeded');assert.equal(x.model.calls.length,count);assert.equal(x.reads.length,12);
});

test('runtime contract source-stage edit invalidates only that source and its downstream dependency closure',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'edit-source',goal},x.hooks),before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot),direction=saveDirection(x,initial.run_id,'source-2','Recheck the supplied source for sensor and control details.');
  const updated=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'edit-source',goal,checkpoint:initial.checkpoint,...direction},x.hooks),after=x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot;
  assert.equal(updated.status,'succeeded');assert.equal(x.reads.length,14);assert.equal(x.reads.filter(read=>read.worker==='source-2').length,4);
  for(const workerId of ['source-1','source-3','source-4','source-5','source-6'])assert.deepEqual(after.workers[workerId],before.workers[workerId]);
  const rebase=x.api.store.swarmActivities(x.api.config.project.id,0,500,initial.run_id).find(event=>event.kind==='work.direction_rebased');assert.deepEqual(rebase.body.reset_workers,['source-2','reduce','final']);
  assert.ok(after.plan.workers.every((worker,index)=>JSON.stringify(worker.source_urls)===JSON.stringify(before.plan.workers[index].source_urls)));
});

test('runtime contract edit fences an old read lease so its worker cannot publish against the revised run',async t=>{
  const x=await setup(t);let paused=false;
  x.hooks.guard=()=>{if(paused)throw Error('WORK_PAUSED');};x.hooks.progress=event=>{x.events.push(event);if(event.worker_id==='reduce'&&event.summary==='Worker reduce: succeeded')paused=true;};
  const initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'edit-leased',goal},x.hooks);assert.equal(initial.status,'paused');
  paused=false;const batch=await x.api.swarm.batchTick(initial.run_id),old=batch.dispatches.find(worker=>worker.worker_id==='final');assert.ok(old);
  const parent=x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot.workers.reduce.result,direction=saveDirection(x,initial.run_id,'final','Return only a concise summary.'),oldLease=[];
  x.hooks.progress=async event=>{x.events.push(event);if(event.stage_id==='swarm.rebase'&&event.kind==='model.result'){
    oldLease.push(old.lease_token);assert.throws(()=>x.api.swarm.activity(initial.run_id,'final',old.lease_token,{kind:'checkpoint',summary:'Late old worker',endpoint:null}),/STALE_SWARM_LEASE/);
    await assert.rejects(x.api.swarm.report(initial.run_id,'final',old.lease_token,parent),/STALE_SWARM_LEASE/);
  }};
  const updated=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'edit-leased',goal,checkpoint:initial.checkpoint,...direction},x.hooks);
  assert.equal(updated.status,'succeeded');assert.equal(oldLease.length,1);assert.equal(x.reads.length,12);
});

test('runtime contract rebase rejects uncertain dispatched effects, stale revisions and unsaved injected directions',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'unsafe-edit',goal},x.hooks),direction=saveDirection(x,initial.run_id,'final','Return a concise summary.'),before=x.model.calls.length,checkpoint=structuredClone(initial.checkpoint);
  checkpoint.workers.final.pending={request_id:'possible-send',turn:checkpoint.workers.final.turn,stage_id:'final',tool_name:'send_message',arguments:{text:'Unknown effect'},effect:'external_write',dispatched:true};
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'unsafe-edit',goal,checkpoint,...direction},x.hooks),/SWARM_DIRECTION_EFFECT_UNCERTAIN/);
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'unsafe-edit',goal,checkpoint:initial.checkpoint,...direction,revision:direction.revision-1},x.hooks),/SWARM_SUPERVISED_REVISION_CONFLICT/);
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'unsafe-edit',goal,checkpoint:initial.checkpoint,revision:direction.revision,directions:[{...direction.directions[0],instruction:'Unsaved hostile direction.'}]},x.hooks),/SWARM_DIRECTION_NOT_AUTHORIZED/);
  assert.equal(x.model.calls.length,before);assert.equal(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot.status,'completed');assert.equal(x.reads.length,12);
});

test('runtime contract invalid model target cannot expand the affected scope or overwrite an immutable plan',async t=>{
  const x=await setup(t,{rebaseTargets:['source-1']}),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'bad-target',goal},x.hooks),before=structuredClone(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot),direction=saveDirection(x,initial.run_id,'final','Produce a concise summary.');
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'bad-target',goal,checkpoint:initial.checkpoint,...direction},x.hooks),/SWARM_DIRECTION_TARGET_NOT_DELEGATED/);
  assert.deepEqual(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot,before);assert.equal(x.reads.length,12);
});

test('runtime contract concurrent snapshot change causes CAS rejection and rolls back the replacement plan and journal',async t=>{
  const options={},x=await setup(t,options),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'rebase-race',goal},x.hooks),direction=saveDirection(x,initial.run_id,'final','Return a concise summary.');
  const planCount=Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM swarm_plan').get().count);
  options.rebaseHook=()=>{const state=x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot;state.revision++;state.updated_at=new Date().toISOString();x.api.store.updateSwarmRun(x.api.config.project.id,initial.run_id,state.revision-1,state);};
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'rebase-race',goal,checkpoint:initial.checkpoint,...direction},x.hooks),/SWARM_REVISION_CONFLICT/);
  assert.equal(Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM swarm_plan').get().count),planCount);
  assert.equal(x.api.store.swarmActivities(x.api.config.project.id,0,500,initial.run_id).filter(event=>event.kind==='work.direction_rebased').length,0);assert.equal(x.reads.length,12);
});

test('runtime contract persisted rebase survives a lost supervisor checkpoint without reapplying user changes or replaying sources',async t=>{
  const x=await setup(t),initial=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'lost-rebase-checkpoint',goal},x.hooks),direction=saveDirection(x,initial.run_id,'final','Use a concise Korean summary.'),request={work_id:x.work.work_id,request_id:'lost-rebase-checkpoint',goal,checkpoint:initial.checkpoint,...direction};
  let rejectOnce=true;const hooks={...x.hooks,checkpoint:value=>{if(rejectOnce){rejectOnce=false;throw Error('FIXTURE_CHECKPOINT_WRITE_LOST');}x.saved.push(structuredClone(value));}};
  await assert.rejects(executeSupervisedSwarm(x.api,x.model,request,hooks),/FIXTURE_CHECKPOINT_WRITE_LOST/);
  assert.equal(x.api.store.swarmRun(x.api.config.project.id,initial.run_id).snapshot.workers.final.status,'pending');
  const resumed=await executeSupervisedSwarm(x.api,x.model,request,hooks);assert.equal(resumed.status,'succeeded');assert.equal(x.reads.length,12);
  assert.equal(x.inputs.filter(entry=>entry.instructions.startsWith('Revise only the allowed existing worker')).length,1);
  assert.equal(x.api.store.swarmActivities(x.api.config.project.id,0,500,initial.run_id).filter(event=>event.kind==='work.direction_rebased').length,1);
});
