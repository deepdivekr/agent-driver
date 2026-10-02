import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {workProgress} from '../dist/work/client-executor.js';

// A4 regression: a Work that is making progress, waiting on a model quota, or
// whose host configuration changed must keep going instead of stalling.
const proposal={title:'자료 수집',desired_outcome:'원본 값을 확인한다',completion_checks:[{id:'records',result:'원본 제목과 값 23 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const recipe={version:1,family:'research.search',request:'자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
function fixture(behavior){const calls=[];return {calls,executorCalls:0,async call(purpose,instructions,input){
  calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
  if(instructions.startsWith('Define one durable'))return proposal;
  if(instructions.startsWith('Independently verify'))return {checks:input.checks.map(check=>{
    const ids=check.allowed_evidence_ids.filter(id=>input.observations.some(observation=>observation.tool_name!=='office_controlled_run_trace'&&observation.evidence_ids.includes(id)&&JSON.stringify(observation.value).includes('Observed source')));
    const refs=ids.map(id=>({evidence_id:id,quote_ref:input.literal_leaf_manifest?.find(record=>record.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path.endsWith('/title'))?.[0]}));
    return ids.length&&refs.every(row=>row.quote_ref)?{id:check.id,verdict:'supported',evidence_ids:ids,evidence_quote_refs:refs,reason:'Observed title.'}:{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'No observed title.'};
  })};
  this.executorCalls++;
  const step=behavior(input,this.executorCalls);if(step instanceof Error)throw step;if(step)return step;
  const result=input.checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run'&&item.receipt.status==='succeeded');
  if(result)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source.',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null};
  return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the source.',completed_checks:[],wait_reason:null};
}};}
async function setup(t,behavior=()=>null){
  const root=await mkdtemp(join(tmpdir(),'work-continuity-')),host=join(root,'host.json');await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  const raw={schema_version:1,project_id:'continuity-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}};
  await writeFile(host,JSON.stringify(raw));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);const model=fixture(behavior),work=await new WorkRuntime(store,config,model).start({request_id:'continuity',prompt:'자료를 확인해줘'});
  const cleanup=[];t.after(async()=>{for(const operation of cleanup.reverse())await operation();store.close();await rm(root,{recursive:true,force:true});});
  return {root,host,raw,config,store,model,work,cleanup,row:()=>store.hermesState.prepare('SELECT * FROM office_supervisor WHERE work_id=?').get(work.work_id)};
}
async function until(x,check){for(let i=0;i<200;i++){const row=x.row();if(row&&check(row))return row;await delay(25);}assert.fail(JSON.stringify(x.row()));}

test('A4: a run that made new progress keeps retrying instead of failing on the attempt count',async t=>{
  let allowed=false;const x=await setup(t,(input,call)=>call===2?Error('FIXTURE_TRANSIENT'):null),supervisor=new WorkSupervisor(x.store,x.config,x.model,{auto_start:false,tick_ms:25,can_start:()=>allowed});x.cleanup.push(()=>supervisor.close());
  supervisor.start(x.work.work_id,x.work.revision,true);x.store.hermesState.prepare('UPDATE office_supervisor SET attempts=5 WHERE work_id=?').run(x.work.work_id);
  allowed=true;
  const row=await until(x,row=>row.state==='retry_wait'||row.state==='failed');
  assert.equal(row.state,'retry_wait','A successful read in this attempt resets the no-progress budget.');assert.equal(row.attempts,0);
  const done=await until(x,row=>['succeeded','failed','awaiting_review'].includes(row.state));
  assert.equal(done.state,'succeeded',done.reason);
});

test('A4: a run with no progress still stops after its bounded attempts',async t=>{
  let allowed=false;const x=await setup(t,()=>Error('FIXTURE_TRANSIENT')),supervisor=new WorkSupervisor(x.store,x.config,x.model,{auto_start:false,tick_ms:25,can_start:()=>allowed});x.cleanup.push(()=>supervisor.close());
  supervisor.start(x.work.work_id,x.work.revision,true);x.store.hermesState.prepare('UPDATE office_supervisor SET attempts=5 WHERE work_id=?').run(x.work.work_id);
  allowed=true;
  const row=await until(x,row=>['retry_wait','failed'].includes(row.state)&&row.owner===null);
  assert.equal(row.state,'failed');assert.equal(row.reason,'FIXTURE_TRANSIENT');
});

test('A4: a temporarily unavailable model is retried automatically with backoff, not parked for the user',async t=>{
  const x=await setup(t,(input,call)=>call===1?Error('STRUCTURED_MODEL_UNAVAILABLE'):null),supervisor=new WorkSupervisor(x.store,x.config,x.model,{auto_start:false,tick_ms:25});x.cleanup.push(()=>supervisor.close());
  supervisor.start(x.work.work_id,x.work.revision,true);supervisor.activate();
  const row=await until(x,row=>row.owner===null&&row.state!=='queued'&&row.state!=='running');
  assert.equal(row.state,'retry_wait');assert.equal(row.reason,'STRUCTURED_MODEL_UNAVAILABLE');
  const wait=row.retry_at_ms-Date.now();assert.ok(wait>40_000&&wait<=60_000,`backoff ${wait}ms`);
  x.store.hermesState.prepare('UPDATE office_supervisor SET retry_at_ms=0 WHERE work_id=?').run(x.work.work_id);
  const done=await until(x,row=>['succeeded','failed','awaiting_review'].includes(row.state));assert.equal(done.state,'succeeded',done.reason);
  const unsupported=await setup(t,()=>Error('STRUCTURED_MODEL_UNSUPPORTED')),other=new WorkSupervisor(unsupported.store,unsupported.config,unsupported.model,{auto_start:false,tick_ms:25});unsupported.cleanup.push(()=>other.close());
  other.start(unsupported.work.work_id,unsupported.work.revision,true);other.activate();
  const parked=await until(unsupported,row=>row.owner===null&&!['queued','running'].includes(row.state));assert.equal(parked.state,'waiting_model','An unsupported model still needs the user.');
});

test('A4: a host configuration change continues the run under the reloaded configuration instead of parking it forever',async t=>{
  let allowed=false;const x=await setup(t),stale=new WorkSupervisor(x.store,x.config,x.model,{auto_start:false,tick_ms:25,can_start:()=>allowed});x.cleanup.push(()=>stale.close());
  stale.start(x.work.work_id,x.work.revision,true);
  await writeFile(join(x.root,'extra.json'),'[]');
  await writeFile(x.host,JSON.stringify({...x.raw,packs:{...x.raw.packs,sources:[...x.raw.packs.sources,{id:'extra',kind:'file',path:'extra.json',format:'json'}]}}));
  allowed=true;
  const waiting=await until(x,row=>row.reason==='CONFIG_RELOAD_REQUIRED');
  assert.equal(waiting.state,'queued','A supervisor holding the old configuration does not run or park the Work.');await delay(150);assert.equal(x.model.executorCalls,0);assert.equal(x.row().attempts,0,'No claim loop.');
  await stale.close();
  const reloaded=loadHostConfig(x.host),current=new WorkSupervisor(x.store,reloaded,x.model,{auto_start:false,tick_ms:25});x.cleanup.push(()=>current.close());
  current.activate();
  const done=await until(x,row=>['succeeded','failed','awaiting_review','waiting_connection'].includes(row.state));
  assert.equal(done.state,'succeeded',done.reason);assert.equal(done.config_hash,reloaded.fingerprint);
  const rebound=x.store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_activity WHERE work_id=? AND kind='supervisor.rebound'").get(x.work.work_id).n;
  assert.equal(rebound,1);
});

test('A4: progress counts successful operations and stage reports, never refusals or notes',()=>{
  const ok={invocation:{dispatched:true},receipt:{status:'succeeded'}},refused={invocation:{dispatched:false},receipt:{status:'retryable_failure'}},failed={invocation:{dispatched:true},receipt:{status:'failed'}};
  assert.equal(workProgress({observations:[ok,refused,failed],stage_reports:[{}]}),2);
  assert.equal(workProgress({observations:[refused,refused]}),0);
  assert.equal(workProgress({observations:[ok],evicted_observations:{succeeded:3}}),4);
  assert.equal(workProgress(null),0);
});
