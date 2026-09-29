import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {executeSupervisedSwarm,compactSwarmPredecessors} from '../dist/work/swarm-executor.js';
import {boundWorkToolValue} from '../dist/work/client-executor.js';

const at='2026-09-29T00:00:00.000Z',failureCode='WORK_CLIENT_TOOL_METADATA_BUDGET_EXCEEDED';
const counts=[1,2,1,5,4,2]; // Actual native six-report shape: fifteen fact cards.
const sentence=label=>(label+' '+ 'bounded independently observed source evidence '.repeat(8)).slice(0,205);
const sourceUrl=worker=>`https://example.test/docs/${worker}`;
const sha=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const factsFor=worker=>Array.from({length:counts[Number(worker.split('-').at(-1))-1]},(_,index)=>({claim:sentence(`Claim ${worker} ${index+1}`),source_url:sourceUrl(worker),source_type:'official_documentation',evidence_excerpt:sentence(`Evidence ${worker} ${index+1}`)}));
const reportFor=worker=>{
  const facts=factsFor(worker),summary=sentence(`Summary ${worker}`);
  return {status:'succeeded',summary,artifacts:[{kind:'grounded_result',ref:`office://swarm/${worker}`,sha256:sha({summary,facts}),summary}],evidence:facts.map(fact=>({source_url:fact.source_url,claim:fact.claim,observed_at:at,verification:'source_reopen'})),fact_cards:facts.map(fact=>({...fact,observed_at:at,verification:'source_reopen',freshness:'unknown',contradiction_refs:[]})),readback:{verified:true,method:'source_reopen',evidence_sha256:sha(facts),observed_at:at},error_code:null};
};
const plan=()=>{
  const sources=counts.map((_,index)=>({id:`source-${index+1}`,role:'Read one source',objective:`Read only source-${index+1} and return its observed fact cards.`,stage:'source_read',source_urls:[sourceUrl(`source-${index+1}`)],executor:'sub_agent',depends_on:[],required_capabilities:[],effect:'read_only',completion_evidence:['Source-backed verbatim fact cards.'],max_steps:8,timeout_ms:75000}));
  return {summary:'Six independently read sources, one reducer and one synthesis worker.',workers:[...sources,{...sources[0],id:'reduce',role:'Reduce fact cards',objective:'Reduce the verified predecessor evidence.',stage:'reduction',source_urls:[],depends_on:sources.map(worker=>worker.id)},{...sources[0],id:'final',role:'Synthesize report',objective:'Return a source-backed final digest.',stage:'synthesis',source_urls:[],depends_on:['reduce']}]};
};
const goal='Read six sources, preserve their evidence and produce a source-backed digest.';
async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'office-derived-budget-')),path=join(root,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'derived-budget',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',swarm:{enabled:true,model_data_approved:true,max_logical_workers:24,max_concurrency:3,lease_ms:120000,visual:{enabled:true,max_contexts:3}}}));
  const calls=[],inputs=[],reads=[],saved=[],events=[];let api,paused=false;
  const model={calls,async call(purpose,instructions,input){
    calls.push({purpose,model:'fixture-model',status:'accepted',elapsed_ms:1,input_sha256:sha({instructions,input}),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});inputs.push({purpose,instructions,input:structuredClone(input)});
    if(instructions.startsWith('Define one durable'))return {title:'Six evidence sources',desired_outcome:goal,completion_checks:[{id:'digest',result:'Source-backed digest.',evidence:'Independent source evidence.'}],assumptions:[],route:{kind:'swarm',pack_family:null},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
    if(purpose==='design')return plan();
    if(instructions.startsWith('Create a concise evidence-backed')){
      if(input.stage_id.startsWith('source-'))return {summary:sentence(`Summary ${input.stage_id}`),facts:factsFor(input.stage_id)};
      const card=input.grounding.predecessors[0].report.fact_cards[0];
      return {summary:sentence(`Summary ${input.stage_id}`),facts:[{claim:card.claim,source_url:card.source_url,source_type:card.source_type,evidence_excerpt:card.evidence_excerpt}]};
    }
    if(instructions.startsWith('Score each'))return {relevance:4,evidence:4,usability:4};
    if(instructions.startsWith('Choose one currently'))return {choice:input.candidates[0]};
    if(instructions.includes('Choices:'))return {choice:input.all_workers_verified?'COMPLETE':'CONTINUE'};
    throw Error('UNEXPECTED_FIXTURE_MODEL_CALL');
  }};
  const visual={async assign(){return {surface_id:'fixture-surface',kind:'browser'};},async perform(_run,worker,_lease,command){
    reads.push({worker,command});const text=factsFor(worker).map(fact=>fact.evidence_excerpt).join('\n');
    return {surface_id:`surface-${worker}`,url:sourceUrl(worker),title:'Bounded source',text,links:[],captured_at:new Date().toISOString()};
  },async release(){},async close(){}};
  api=new RuntimeApi(loadHostConfig(path),{swarmModel:model,swarmVisual:visual});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const work=await api.call('runtime_work_start',{request_id:'derived-budget-work',prompt:goal});
  const hooks={guard:()=>{if(paused)throw Error('WORK_PAUSED');},checkpoint:value=>saved.push(structuredClone(value)),progress:event=>{
    events.push(event);if(event.worker_id?.startsWith('source-')&&event.summary.endsWith(': succeeded')&&api.store.swarmRun(api.config.project.id,saved.at(-1).run_id).snapshot.workers&&Object.values(api.store.swarmRun(api.config.project.id,saved.at(-1).run_id).snapshot.workers).filter(worker=>worker.id.startsWith('source-')).every(worker=>worker.status==='succeeded'))paused=true;
  }};
  const initial=await executeSupervisedSwarm(api,model,{work_id:work.work_id,request_id:'derived-budget-run',goal},hooks);
  assert.equal(initial.status,'paused');assert.equal(reads.length,12);assert.equal(initial.checkpoint.completed_workers.length,6);
  paused=false;hooks.progress=event=>events.push(event);
  return {api,model,work,initial,hooks,reads,saved,events,inputs};
}
function reducerCheckpoint(x){
  const state=x.api.store.swarmRun(x.api.config.project.id,x.initial.run_id).snapshot,worker=state.plan.workers.find(worker=>worker.id==='reduce'),run=`${x.initial.run_id}.reduce`.slice(0,80);
  const tool={name:'predecessor_evidence',description:'Read the independently verified fact cards of dependency workers. No web access.',input_schema:z.toJSONSchema(z.object({}).strict()),effect:'read_only'};
  const checks=[{id:'observed',result:worker.completion_evidence.join(' '),evidence:'Verified predecessor fact cards.'}];
  return {format:1,work_id:x.work.work_id,run_id:run,binding:hashJson({work_id:x.work.work_id,run_id:run,prompt:worker.objective,checks,tools:[tool]}),turn:0,pending:{request_id:`work-tool-${hashJson({run_id:run,turn:0,tool:tool.name,args:{}}).slice(0,48)}`,turn:0,stage_id:'reduce',tool_name:tool.name,arguments:{},effect:'read_only',dispatched:true},observations:[],summary:''};
}
async function failReducer(x,errorCode=failureCode,legacyTimeouts=null){
  const batch=await x.api.swarm.batchTick(x.initial.run_id),worker=batch.dispatches.find(worker=>worker.worker_id==='reduce');assert.ok(worker);
  await x.api.swarm.report(x.initial.run_id,'reduce',worker.lease_token,{status:'failed',summary:`Worker could not finish: ${errorCode}`,error_code:errorCode});
  x.initial.checkpoint.workers.reduce=reducerCheckpoint(x);
  const state=x.api.store.swarmRun(x.api.config.project.id,x.initial.run_id).snapshot;
  const expired={...state,revision:state.revision+1,target_deadline_at_ms:Date.now()-2000,hard_deadline_at_ms:Date.now()-1000,updated_at:new Date().toISOString()};
  // Disposable fixture of a pre-normalization saved plan, never the user's DB.
  if(legacyTimeouts){expired.plan=structuredClone(expired.plan);delete expired.plan.planner.worker_timeout_budget;expired.plan.workers.find(worker=>worker.id==='reduce').timeout_ms=15000;expired.plan.workers.find(worker=>worker.id==='final').timeout_ms=20000;expired.plan.execution_profile.worker_timeout_ms=legacyTimeouts.host_timeout_ms;}
  x.api.store.updateSwarmRun(x.api.config.project.id,x.initial.run_id,state.revision,expired);
  return structuredClone(expired);
}
function savedResume(x,kind='resumed'){
  const db=x.api.store.hermesState,work=x.api.store.intakeWork(x.api.config.project.id,x.work.work_id),revision=work.revision+1,stamp=new Date().toISOString();
  x.api.store.transaction(()=>{db.prepare('UPDATE office_intake SET revision=?,paused=0,updated_at=? WHERE project_id=? AND work_id=? AND revision=?').run(revision,stamp,x.api.config.project.id,work.id,work.revision);db.prepare('INSERT INTO office_work_revision VALUES(?,?,?,?,?,?)').run(work.id,revision,kind,JSON.stringify(work.spec),JSON.stringify(work.answers),stamp);});return revision;
}

test('runtime contract native-shaped six predecessor reports compact without changing any original fact or digest',()=>{
  const work=randomUUID(),run=randomUUID(),reports=counts.map((_,index)=>({worker_id:`source-${index+1}`,report:reportFor(`source-${index+1}`)})),original=structuredClone(reports);
  const full={predecessors:reports,digest:sha(reports)};assert.ok(Buffer.byteLength(JSON.stringify(full))>16000);
  assert.throws(()=>boundWorkToolValue(full),new RegExp(failureCode));
  const compact={predecessors:compactSwarmPredecessors(work,run,reports),digest:sha(reports)};
  assert.ok(Buffer.byteLength(JSON.stringify(compact))<16000);assert.deepEqual(boundWorkToolValue(compact),compact);assert.deepEqual(reports,original);
  for(const [index,predecessor] of compact.predecessors.entries()){
    assert.deepEqual(predecessor.report.fact_cards,reports[index].report.fact_cards);
    assert.deepEqual(Object.keys(predecessor.report),['fact_cards']);
    assert.equal(predecessor.reference.report_sha256,sha(reports[index].report));assert.equal(predecessor.reference.evidence_sha256,reports[index].report.readback.evidence_sha256);
    assert.equal(predecessor.reference.work_id,work);assert.equal(predecessor.reference.run_id,run);assert.equal(predecessor.reference.readback_verified,true);
  }
});

test('runtime fixture explicit Work resume corrects only the failed reducer and preserves six verified sources and original failure',async t=>{
  const x=await setup(t),before=await failReducer(x),reads=x.reads.length,revision=savedResume(x);
  const result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'derived-budget-run',goal,checkpoint:JSON.parse(JSON.stringify(x.initial.checkpoint)),revision},x.hooks);
  assert.equal(result.status,'succeeded');assert.equal(result.run_id,x.initial.run_id);assert.equal(x.reads.length,reads);
  const after=x.api.store.swarmRun(x.api.config.project.id,result.run_id).snapshot;
  for(const workerId of counts.map((_,index)=>`source-${index+1}`))assert.deepEqual(after.workers[workerId],before.workers[workerId]);
  assert.equal(after.workers.reduce.attempts,2);assert.equal(after.workers.final.attempts,1);
  const recovered=x.api.store.swarmActivities(x.api.config.project.id,0,500,result.run_id).filter(event=>event.kind==='work.derivation_budget_recovered');
  assert.equal(recovered.length,1);const event=recovered[0].body;
  assert.equal(event.original_hard_deadline_at_ms,before.hard_deadline_at_ms);assert.equal(event.previous_workers.reduce.result.error_code,failureCode);
  assert.equal(event.previous_worker_checkpoints.reduce.pending.dispatched,true);assert.equal(event.previous_worker_checkpoints.reduce.pending.effect,'read_only');
  assert.deepEqual(event.reset_worker_ids,['reduce']);assert.deepEqual(event.remaining_worker_ids,['reduce','final']);assert.equal(event.preserved_worker_ids.length,6);
  assert.equal(event.recovery_window_ms,150000);assert.equal(event.new_hard_deadline_at_ms,after.hard_deadline_at_ms);assert.equal(event.max_attempts,2);assert.equal(event.resume_work_revision,revision);
  assert.equal(event.recovery_budget_owner,'host');assert.equal(event.recovery_worker_timeout_ms,75000);
  const reduce=result.checkpoint.workers.reduce.observations.at(-1).receipt.value,grounding=x.inputs.find(entry=>entry.instructions.startsWith('Create a concise evidence-backed')&&entry.input.stage_id==='reduce').input.grounding;
  assert.equal(reduce.predecessors.length,6);assert.deepEqual(grounding.predecessors,reduce.predecessors);assert.ok(Buffer.byteLength(JSON.stringify(reduce))<16000);
  assert.equal(reduce.digest,sha(before.plan.workers.find(worker=>worker.id==='reduce').depends_on.map(worker_id=>({worker_id,report:before.workers[worker_id].result}))));
  assert.equal(result.checkpoint.peak_active_workers,3);
});

test('runtime fixture explicit derivation recovery uses the host budget instead of old shorter proposed times and remains capped',async t=>{
  for(const [hostTimeout,expectedWindow] of [[50000,100000],[180000,150000]]){
    const x=await setup(t),before=await failReducer(x,failureCode,{host_timeout_ms:hostTimeout}),reads=x.reads.length,revision=savedResume(x);
    const result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'derived-budget-run',goal,checkpoint:structuredClone(x.initial.checkpoint),revision},x.hooks);
    assert.equal(result.status,'succeeded');assert.equal(x.reads.length,reads);assert.equal(result.run_id,x.initial.run_id);
    const after=x.api.store.swarmRun(x.api.config.project.id,result.run_id).snapshot;
    assert.deepEqual(after.plan,before.plan);assert.equal(after.workers.reduce.attempts,2);
    const event=x.api.store.swarmActivities(x.api.config.project.id,0,500,result.run_id).find(event=>event.kind==='work.derivation_budget_recovered').body;
    assert.equal(event.recovery_window_ms,expectedWindow);assert.equal(event.recovery_worker_timeout_ms,Math.min(hostTimeout,75000));
    assert.equal(event.recovery_budget_owner,'host');assert.equal(event.previous_workers.reduce.result.error_code,failureCode);
  }
});

test('runtime fixture derivation recovery never auto-resumes without a saved new Work resume or across unrelated boundaries',async t=>{
  for(const scenario of ['no_resume','other_revision','unrelated_failure','pending_write','partial_evidence','second_attempt']){
    const x=await setup(t),before=await failReducer(x,scenario==='unrelated_failure'?'BROWSER_AUTH_REQUIRED':failureCode);
    let revision=x.initial.checkpoint.work_revision;
    if(scenario!=='no_resume')revision=savedResume(x,scenario==='other_revision'?'jev_enabled':'resumed');
    if(scenario==='pending_write')x.initial.checkpoint.workers.reduce.pending.effect='external_write';
    if(['partial_evidence','second_attempt'].includes(scenario)){
      const next=structuredClone(before);next.revision++;next.updated_at=new Date().toISOString();
      if(scenario==='partial_evidence')next.status='partial_evidence';else next.workers.reduce.attempts=2;
      x.api.store.updateSwarmRun(x.api.config.project.id,x.initial.run_id,before.revision,next);
    }
    const expected=structuredClone(x.api.store.swarmRun(x.api.config.project.id,x.initial.run_id).snapshot),calls=x.model.calls.length,reads=x.reads.length;
    const result=await executeSupervisedSwarm(x.api,x.model,{work_id:x.work.work_id,request_id:'derived-budget-run',goal,checkpoint:x.initial.checkpoint,revision},x.hooks);
    assert.equal(result.status,'awaiting_review',scenario);assert.equal(x.model.calls.length,calls,scenario);assert.equal(x.reads.length,reads,scenario);
    assert.deepEqual(x.api.store.swarmRun(x.api.config.project.id,x.initial.run_id).snapshot,expected,scenario);
    assert.equal(x.api.store.swarmActivities(x.api.config.project.id,0,500,x.initial.run_id).filter(event=>event.kind==='work.derivation_budget_recovered').length,0,scenario);
  }
});
