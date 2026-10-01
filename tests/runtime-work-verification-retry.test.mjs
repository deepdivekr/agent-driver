import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const request={work_id:'verify-work',run_id:'verify-run',prompt:'Read and retain the observed source title.',completion_checks:[{id:'title',result:'Retain the observed title.',evidence:'A successful source receipt.'}],max_turns:4};
const tools=[{name:'read_source',description:'Read a source.',input_schema:{type:'object',properties:{},additionalProperties:false},effect:'read_only'}];
const read={action:'tool',stage_id:'read',tool_name:'read_source',arguments_json:'{}',summary:'Read source.',completed_checks:[],wait_reason:null};
const claim={action:'complete',stage_id:'done',tool_name:null,arguments_json:null,summary:'Observed title was retained.',completed_checks:[{id:'title',evidence_ids:['source-1']}],wait_reason:null};
const wait={action:'wait',stage_id:null,tool_name:null,arguments_json:null,summary:'The updated Work needs a new decision.',completed_checks:[],wait_reason:'model'};
const receipt={status:'succeeded',value:{title:'Observed title'},evidence_ids:['source-1'],effect_state:'none',retry_safe:true};
const copied=value=>JSON.parse(JSON.stringify(value));
function model(queue=[]){return {calls:[],decisions:0,async call(purpose,instructions,input,schema){hashJson({instructions,input,schema});this.decisions++;const next=queue.shift();assert.ok(next,'No worker model replay is allowed');this.calls.push({purpose,provider:'fixture',model:'fixture',elapsed_ms:1,input_sha256:'a'.repeat(64),status:'accepted',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return copied(next);}};}
function host(verify){let persisted=null;const events=[],dispatches=[];return {events,dispatches,get saved(){return persisted;},tools,async checkpoint(value){persisted=copied(value);},async progress(value){events.push(copied(value));},async executeTool(name,args,context){dispatches.push({name,args,context});return receipt;},verifyCompletion:verify};}
async function run(provider,hostFixture,checkpoint=null,context=null){return new BoundedWorkClientExecutor(provider).execute({...request,...(checkpoint?{checkpoint:copied(checkpoint)}:{}),...(context?{context}:{})},hostFixture);}

test('runtime fixture: transient verifier transport resumes twice from durable claim without worker or tool replay',async()=>{
  let checks=0;const verifier=async(_checks,observations,savedClaim)=>{checks++;assert.equal(observations.length,1);assert.deepEqual(savedClaim,claim);if(checks===1)throw Error('STRUCTURED_MODEL_TIMEOUT');if(checks===2)throw Error('STRUCTURED_MODEL_UNAVAILABLE');return true;};
  const firstHost=host(verifier),worker=model([read,claim]),first=await run(worker,firstHost);
  assert.equal(first.status,'retryable_failure');assert.equal(first.reason,'WORK_CLIENT_VERIFICATION_TRANSIENT');assert.equal(first.completion_verified,false);
  assert.equal(firstHost.dispatches.length,1);assert.equal(worker.decisions,2);assert.equal(first.checkpoint.verification_pending.transient_failures,1);
  const pending=copied(first.checkpoint.verification_pending),observations=copied(first.checkpoint.observations);
  const secondHost=host(verifier),secondWorker=model(),second=await run(secondWorker,secondHost,firstHost.saved);
  assert.equal(second.status,'retryable_failure');assert.equal(second.completion_verified,false);assert.equal(second.checkpoint.verification_pending.transient_failures,2);
  assert.deepEqual(second.checkpoint.verification_pending.claim,pending.claim);assert.equal(second.checkpoint.verification_pending.scope_sha256,pending.scope_sha256);
  assert.deepEqual(second.checkpoint.observations,observations);assert.equal(secondWorker.decisions,0);assert.equal(secondHost.dispatches.length,0);
  const thirdHost=host(verifier),thirdWorker=model(),third=await run(thirdWorker,thirdHost,secondHost.saved);
  assert.equal(third.status,'succeeded');assert.equal(third.completion_verified,true);assert.equal(third.checkpoint.verification_pending,undefined);
  assert.equal(thirdWorker.decisions,0);assert.equal(thirdHost.dispatches.length,0);assert.equal(checks,3);
  assert.deepEqual(firstHost.events.filter(e=>e.kind.startsWith('verification.')).map(e=>e.kind),['verification.retry_scheduled']);
  assert.deepEqual(secondHost.events.filter(e=>e.kind.startsWith('verification.')).map(e=>e.kind),['verification.retry_started','verification.retry_scheduled']);
  assert.deepEqual(thirdHost.events.filter(e=>e.kind.startsWith('verification.')).map(e=>e.kind),['verification.retry_started']);
});

test('runtime fixture: verifier outage has a durable two-retry ceiling, no false completion or replay',async()=>{
  let calls=0;const verifier=async()=>{calls++;throw Error('STRUCTURED_MODEL_TIMEOUT');};
  let checkpoint=null;const statuses=[];
  for(let activation=0;activation<4;activation++){
    const fixture=host(verifier),worker=model(activation===0?[read,claim]:[]),result=await run(worker,fixture,checkpoint);
    statuses.push(result.status);checkpoint=copied(fixture.saved??result.checkpoint);
    assert.equal(result.completion_verified,false);assert.equal(worker.decisions,activation===0?2:0);assert.equal(fixture.dispatches.length,activation===0?1:0);
    assert.equal(checkpoint.verification_pending.transient_failures,Math.min(activation+1,3));
  }
  assert.deepEqual(statuses,['retryable_failure','retryable_failure','waiting_model','waiting_model']);assert.equal(calls,3);
});

test('runtime fixture: changed user context drops old claim; changed task binding cannot reuse checkpoint',async()=>{
  const firstHost=host(async()=>{throw Error('STRUCTURED_MODEL_TIMEOUT');}),first=await run(model([read,claim]),firstHost);
  const staleHost=host(async()=>{throw Error('Verifier must not use the old claim');}),next=model([wait]);
  const stale=await run(next,staleHost,first.checkpoint,{user_directions:[{instruction:'Use a different title.'}]});
  assert.equal(stale.status,'waiting_model');assert.equal(stale.completion_verified,false);assert.equal(stale.checkpoint.verification_pending,undefined);
  assert.equal(Object.hasOwn(stale.checkpoint,'verification_pending'),false,'Changed context must remove a stale claim without creating noncanonical undefined input');
  assert.equal(next.decisions,1);assert.equal(staleHost.dispatches.length,0);assert.deepEqual(stale.checkpoint.observations,first.checkpoint.observations);
  assert.ok(staleHost.events.some(event=>event.reason==='WORK_CLIENT_VERIFICATION_SCOPE_CHANGED'));
  await assert.rejects(new BoundedWorkClientExecutor(model()).execute({...request,prompt:'A different task.',checkpoint:first.checkpoint},host(async()=>true)),/WORK_CLIENT_CHECKPOINT_MISMATCH/u);
});

test('runtime fixture: definitive false and typed repair keep original non-transport policy',async()=>{
  for(const reply of [false,{verified:false,repair:{code:'WORK_COMPLETION_CHECK_NOT_SUPPORTED',check_id:'title',verdict:'unknown'}}]){
    let count=0;const verifier=async()=>{count++;if(count===1)throw Error('STRUCTURED_MODEL_TIMEOUT');return reply;};
    const first=await run(model([read,claim]),host(verifier)),fixture=host(verifier),result=await run(model(reply===false?[]:[wait]),fixture,first.checkpoint);
    assert.equal(result.status,reply===false?'awaiting_review':'waiting_model');assert.equal(result.completion_verified,false);assert.equal(result.checkpoint.verification_pending,undefined);
    assert.equal(Boolean(result.checkpoint.completion_repair),reply!==false);
    assert.equal(count,2);assert.equal(fixture.dispatches.length,0);assert.equal(fixture.events.filter(event=>event.kind==='verification.retry_scheduled').length,0);
  }
});

test('runtime fixture: auth, quota, schema, invalid output and unsupported verifier failures are not transport retries',async()=>{
  for(const code of ['AUTH_EXPIRED','QUOTA_EXHAUSTED','STRUCTURED_MODEL_UNSUPPORTED','CLIENT_SCHEMA_INVALID','CLIENT_OUTPUT_SCHEMA_UNSUPPORTED','CLIENT_STRUCTURED_OUTPUT_INVALID']){
    const fixture=host(async()=>{throw Error(code);}),result=await run(model([read,claim]),fixture);
    assert.equal(result.completion_verified,false);assert.notEqual(result.reason,'WORK_CLIENT_VERIFICATION_TRANSIENT');
    assert.equal(fixture.events.filter(event=>event.kind.startsWith('verification.')).length,0);
  }
});

test('runtime fixture: supervisor persists verifier-only retries and completes without a second Pack dispatch',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-verification-retry-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  const configFile=join(root,'host.json');
  await writeFile(configFile,JSON.stringify({schema_version:1,project_id:'verify-retry-project',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(configFile),store=new PackStore(config.dbPath);t.after(()=>store.close());store.registerProject(config.project);
  const proposal={title:'테스트 자료 수집',desired_outcome:'실제 로컬 원본의 값을 결과에 남긴다',completion_checks:[{id:'records',result:'원본 제목과 값 23 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
  const recipe={version:1,family:'research.search',request:'Read the source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
  let workerCalls=0,verifierCalls=0;
  const native={calls:[],verifierFailureKind:null,async call(purpose,instructions,input){
    this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});
    if(instructions.startsWith('Define one durable'))return proposal;
    if(instructions.startsWith('Independently verify')){
      if(this.verifierFailureKind){this.calls.at(-1).status='failed';this.calls.at(-1).failure_kind=this.verifierFailureKind;throw Error('STRUCTURED_MODEL_UNAVAILABLE');}
      verifierCalls++;if(verifierCalls<=2)throw Error('STRUCTURED_MODEL_TIMEOUT');
      return {checks:input.checks.map(check=>{
        const records=input.observations.filter(observation=>observation.tool_name!=='office_controlled_run_trace'&&observation.evidence_ids.some(id=>check.allowed_evidence_ids.includes(id))&&JSON.stringify(observation.value).includes('Observed source')&&JSON.stringify(observation.value).includes('23'));
        const refs=records.flatMap(record=>record.evidence_ids.filter(id=>check.allowed_evidence_ids.includes(id)).map(id=>({evidence_id:id,quote_ref:input.literal_leaf_manifest?.find(item=>item.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path.endsWith('/title'))?.[0]})));
        return refs.length&&refs.every(ref=>typeof ref.quote_ref==='string')?{id:check.id,verdict:'supported',evidence_ids:refs.map(ref=>ref.evidence_id),evidence_quote_refs:refs,reason:'The original Pack receipt has the observed source and value 23.'}:{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'Original source value was not observable.'};
      })};
    }
    assert.ok(instructions.startsWith('Execute the registered Work'));
    workerCalls++;
    const observed=input.checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run');
    if(observed)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:observed.receipt.evidence_ids})),wait_reason:null};
    return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the registered source.',completed_checks:[],wait_reason:null};
  }};
  const work=await new WorkRuntime(store,config,native).start({request_id:'verification-retry-work',prompt:'자료를 확인해줘'});
  assert.equal(work.status,'ready',JSON.stringify(work));
  const supervisor=new WorkSupervisor(store,config,native,{tick_ms:25});t.after(()=>supervisor.close());
  supervisor.start(work.work_id,work.revision,true);
  let end;
  for(let index=0;index<420;index++){
    end=supervisorStatus(store,config.project.id,work.work_id);
    if(end?.state==='succeeded'||end?.state==='failed'||end?.state==='awaiting_review'||end?.state==='waiting_model')break;
    await delay(25);
  }
  assert.equal(end?.state,'succeeded',JSON.stringify(end));assert.equal(end.result.completion_verified,true);
  assert.ok(verifierCalls>=3&&verifierCalls<=6);assert.equal(workerCalls,2);
  const checkpoint=JSON.parse(store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE work_id=?').get(work.work_id).checkpoint);
  assert.equal(checkpoint.observations.filter(item=>item.invocation.tool_name==='runtime_pack_run').length,1);
  const rows=store.hermesState.prepare("SELECT kind,metadata FROM office_activity WHERE work_id=? AND kind LIKE 'verification.retry_%' ORDER BY id").all(work.work_id);
  assert.ok(rows.length>=2&&rows.length<=4,JSON.stringify(rows));
  assert.deepEqual(rows.map(row=>row.kind),rows.length===2?['verification.retry_scheduled','verification.retry_started']:['verification.retry_scheduled','verification.retry_started','verification.retry_scheduled','verification.retry_started']);
  assert.ok(rows.every(row=>JSON.parse(row.metadata).run_id===end.run_id));

  // The verifier owns a different ConfiguredStructuredModel calls array from
  // the worker's forWork instance. Its original typed failure must still gate
  // a generic unavailable wrapper before scheduling any technical retry.
  native.verifierFailureKind='auth_error';
  const authWork=await new WorkRuntime(store,config,native).start({request_id:'verification-auth-work',prompt:'자료를 확인해줘'});
  assert.equal(authWork.status,'ready');supervisor.start(authWork.work_id,authWork.revision,true);
  let authEnd;
  for(let index=0;index<120;index++){
    authEnd=supervisorStatus(store,config.project.id,authWork.work_id);
    if(['waiting_model','failed','awaiting_review','succeeded'].includes(authEnd?.state))break;
    await delay(25);
  }
  assert.equal(authEnd?.state,'waiting_model',JSON.stringify(authEnd));assert.equal(authEnd.reason,'auth_expired');
  const authRetry=store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_activity WHERE work_id=? AND kind LIKE 'verification.retry_%'").get(authWork.work_id);
  assert.equal(authRetry.n,0);assert.equal(authEnd.result?.completion_verified,false);

  native.verifierFailureKind='schema_invalid';
  const schemaWork=await new WorkRuntime(store,config,native).start({request_id:'verification-schema-work',prompt:'자료를 확인해줘'});
  assert.equal(schemaWork.status,'ready');supervisor.start(schemaWork.work_id,schemaWork.revision,true);
  let schemaEnd;
  for(let index=0;index<120;index++){
    schemaEnd=supervisorStatus(store,config.project.id,schemaWork.work_id);
    if(['waiting_model','failed','awaiting_review','succeeded'].includes(schemaEnd?.state))break;
    await delay(25);
  }
  assert.equal(schemaEnd?.state,'failed',JSON.stringify(schemaEnd));assert.equal(schemaEnd.reason,'CLIENT_SCHEMA_INVALID');
  const schemaRetry=store.hermesState.prepare("SELECT COUNT(*) AS n FROM office_activity WHERE work_id=? AND kind LIKE 'verification.retry_%'").get(schemaWork.work_id);
  assert.equal(schemaRetry.n,0);assert.equal(schemaEnd.result?.completion_verified,false);
});
