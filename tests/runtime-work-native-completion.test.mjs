import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {createWorkCompletionVerifier} from '../dist/work/completion.js';
import {createNativeCompletionResolver} from '../dist/work/native-completion.js';
import {nativeCompletionCheck,nativeCompletionPredicateSchema} from '../dist/work/completion-checks.js';
import {validateWorkProposal} from '../dist/work/contracts.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';

const sourceRows=[{id:'A',status:'Open',score:'4'},{id:'B',status:'Closed',score:'8'},{id:'C',status:'Open',score:'6'}];
const fileRecipe={version:1,family:'file.pipeline',request:'Preserve every source row, normalize scores and sort descending.',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],columns:['id','score'],numeric_columns:['score'],sort:{field:'score',direction:'desc'},format:'json'};
const filePredicate={version:1,kind:'native_pack_output',family:'file.pipeline',format:'json',columns:['id','score'],output_rows:3,numeric_columns:['score'],sort:{field:'score',direction:'desc'}};
const originalUserRequest={prompt:'Preserve all three original rows in a JSON output, ordered by descending score.',completion_condition:'Do not omit source row B.',delivery_target_ids:null,user_directions:[]};
const claim=(checks,ids)=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Unverified executor statement.',wait_reason:null,completed_checks:checks.map(check=>({id:check.id,evidence_ids:ids}))});

async function setup(t){
  const root=await mkdtemp(join(tmpdir(),'work-native-completion-')),sourcePath=join(root,'rows.json'),hostPath=join(root,'host.json');
  await writeFile(sourcePath,JSON.stringify(sourceRows));
  await writeFile(hostPath,JSON.stringify({schema_version:1,project_id:'work-native-completion',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:sourcePath,format:'json'}],targets:[]}}));
  const config=loadHostConfig(hostPath),api=new RuntimeApi(config);initWorkExecution(api.store);
  const toolkits=[];
  t.after(async()=>{for(const toolkit of toolkits)await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  function work(predicate=filePredicate,prompt=originalUserRequest.prompt){
    const check=nativeCompletionCheck('native_output',predicate);
    const spec={title:'Specific recurring source transformation',desired_outcome:prompt,completion_checks:[check],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write')};
    const started=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,started.work.id),saved=api.store.finishWorkDefinition(config.project.id,started.work.id,owner,validateWorkProposal(spec,'quick'),[],'ready');
    const toolkit=new WorkExecutionTools(api.store,config,api,saved.id,randomUUID(),spec,prompt,()=>{},{async call(){assert.fail('Native execution does not use a model.');}});toolkits.push(toolkit);
    return {saved,spec,toolkit,resolver:createNativeCompletionResolver(api.store,config,saved.id)};
  }
  async function execute(owner,recipe=fileRecipe){
    const requestId=`native-${randomUUID()}`,value=await owner.toolkit.execute('runtime_pack_run',{recipe},requestId);
    assert.equal(value.status,'succeeded');
    const receipt=await owner.toolkit.receipt('runtime_pack_run',value,requestId);
    const observation={invocation:{request_id:requestId,turn:0,stage_id:'transform',tool_name:'runtime_pack_run',arguments:{recipe},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()};
    return {value,observation,ids:receipt.evidence_ids};
  }
  return {api,config,sourcePath,work,execute};
}

function originalRequestModel({reject=false,assertInput}={}){
  return {calls:[],inputs:[],async call(purpose,_instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});this.inputs.push(structuredClone(input));
    assert.equal(input.checks.length,1);assert.equal(input.checks[0].id,'original_user_request','The original goal must still reach the model after technical success.');
    assert.deepEqual(input.original_user_request,originalUserRequest);assertInput?.(input);
    const check=input.checks[0];
    if(reject)return {checks:[{id:check.id,verdict:'unsupported',evidence_ids:[],evidence_quote_refs:[],reason:'The original request requires source row B; the observed filtered output omits it.'}]};
    const observation=input.observations.find(item=>item.value.result?.artifact?.rows===3),id=observation.evidence_ids[0],record=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id)),ref=record.leaf_refs.find(([,path])=>path==='$/result/artifact/rows')[0];
    return {checks:[{id:check.id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'Fixture original-goal verifier independently accepted the retained output observation.'}]};
  }};
}

test('native completion uses actual artifact verification and still makes an independent original-request model call',async t=>{
  const x=await setup(t),owner=x.work(),run=await x.execute(owner),before=structuredClone(run.observation),audits=[],model=originalRequestModel();
  assert.deepEqual(JSON.parse(await readFile(run.value.result.artifact.path,'utf8')),[{id:'B',score:8},{id:'C',score:6},{id:'A',score:4}],'Check real output rather than a completion flag.');
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver,audit:event=>audits.push(event)});
  assert.equal(await verify(owner.spec.completion_checks,[run.observation],claim(owner.spec.completion_checks,run.ids)),true);
  assert.equal(model.inputs.length,1,'The native technical check needs zero model judgments.');
  assert.ok(audits.some(event=>event.code==='WORK_COMPLETION_NATIVE_VERIFIED'&&event.verifier==='native'&&event.certificate_sha256));
  assert.deepEqual(run.observation,before);
});

test('the default supervisor executes a saved native contract and still verifies the original goal with its closed trace',async t=>{
  const x=await setup(t),owner=x.work(),verifyInputs=[],model={calls:[],async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});
    if(instructions.startsWith('Execute the registered Work')){
      if(input.checkpoint.observations.length===0)return {action:'tool',stage_id:'transform',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe:fileRecipe}),summary:'Transform the actual source rows.',completed_checks:[],wait_reason:null};
      const ids=input.checkpoint.observations.flatMap(item=>item.receipt.evidence_ids);
      return claim(owner.spec.completion_checks,ids);
    }
    assert.ok(instructions.startsWith('Independently verify'));
    verifyInputs.push(structuredClone(input));
    assert.equal(input.checks[0].id,'original_user_request');assert.equal(input.original_user_request.prompt,originalUserRequest.prompt);
    const trace=input.observations.find(item=>item.tool_name==='office_controlled_run_trace');assert.equal(trace.value.closure,'closed');
    const result=input.observations.find(item=>item.tool_name==='runtime_pack_run'),id=result.evidence_ids[0],manifest=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id)),ref=manifest.leaf_refs.find(([,path])=>path==='$/result/artifact/rows')[0];
    return {checks:[{id:input.checks[0].id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'Fixture verifier accepted the original task against the observed result.'}]};
  }};
  const supervisor=new WorkSupervisor(x.api.store,x.config,model,{api:x.api,auto_start:false,tick_ms:20});
  try{
    const started=supervisor.start(owner.saved.id,owner.saved.revision,true);let status;
    for(let attempt=0;attempt<120;attempt++){
      status=supervisorStatus(x.api.store,x.config.project.id,owner.saved.id);
      if(['succeeded','failed','awaiting_review','reconciliation_required'].includes(status?.state))break;
      await delay(25);
    }
    assert.equal(status?.state,'succeeded',JSON.stringify(status));assert.equal(status.run_id,started.run_id);assert.equal(status.result.completion_verified,true);
    assert.equal(verifyInputs.length,1,'The default host resolver replaced only the native technical model judgment.');
    const run=x.api.store.officeRuns(x.config.project.id,owner.saved.id).find(item=>item.source_kind==='pack');
    const artifact=x.api.store.packRun(x.config.project.id,run.source_id).result.artifact;
    assert.deepEqual(JSON.parse(await readFile(artifact.path,'utf8')).map(row=>row.id),['B','C','A']);
  }finally{await supervisor.close();}
});

test('a genuine filtered output cannot satisfy an all-row native expectation and cannot bypass original-user semantics',async t=>{
  const x=await setup(t),owner=x.work(),filtered=await x.execute(owner,{...fileRecipe,filters:[{field:'status',op:'eq',value:'Open'}]});
  assert.deepEqual(JSON.parse(await readFile(filtered.value.result.artifact.path,'utf8')).map(row=>row.id),['C','A']);
  const noCalls={calls:[],async call(){assert.fail('The failed native predicate must stop before the semantic verifier.');}};
  assert.equal(await createWorkCompletionVerifier(noCalls,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})(owner.spec.completion_checks,[filtered.observation],claim(owner.spec.completion_checks,filtered.ids)),false);
  const subsetChecks=[nativeCompletionCheck('native_output',{...filePredicate,output_rows:2})],model=originalRequestModel({reject:true});
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})(subsetChecks,[filtered.observation],claim(subsetChecks,filtered.ids)),false);
  assert.equal(model.inputs.length,1,'Even a valid technical subset must face the complete original goal.');
});

test('an explicit all-observed-source-rows contract adapts to new cycle cardinality while filtered subsets still fail',async t=>{
  const x=await setup(t),predicate={...filePredicate,output_rows:'observed_source_rows'},original={prompt:'Save all rows observed in the source for this execution.',completion_condition:null,delivery_target_ids:null,user_directions:[]};
  const model={calls:[],async call(purpose,_instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});assert.equal(input.checks[0].id,'original_user_request');assert.deepEqual(input.original_user_request,original);
    const result=input.observations.find(item=>item.value.result?.artifact),id=result.evidence_ids[0],record=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes(id)),ref=record.leaf_refs.find(([,path])=>path==='$/result/artifact/rows')[0];
    assert.equal(result.value.result.collected_rows,result.value.result.artifact.rows);
    return {checks:[{id:input.checks[0].id,verdict:'supported',evidence_ids:[id],evidence_quote_refs:[{evidence_id:id,quote_ref:ref}],reason:'Fixture original-goal verifier accepted every current source row.'}]};
  }};
  const first=x.work(predicate,original.prompt),firstRun=await x.execute(first);
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:original,nativeResolver:first.resolver})(first.spec.completion_checks,[firstRun.observation],claim(first.spec.completion_checks,firstRun.ids)),true);
  const expanded=[...sourceRows,{id:'D',status:'Open',score:'12'}];await writeFile(x.sourcePath,JSON.stringify(expanded));
  const second=x.work(predicate,original.prompt),secondRun=await x.execute(second);
  assert.deepEqual(JSON.parse(await readFile(secondRun.value.result.artifact.path,'utf8')).map(row=>row.id),['D','B','C','A']);
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:original,nativeResolver:second.resolver})(second.spec.completion_checks,[secondRun.observation],claim(second.spec.completion_checks,secondRun.ids)),true);
  assert.equal(model.calls.length,2,'Every new cycle still requires its own original-goal verification.');
  const filtered=await x.execute(second,{...fileRecipe,filters:[{field:'status',op:'eq',value:'Open'}]});
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest:original,nativeResolver:second.resolver})(second.spec.completion_checks,[filtered.observation],claim(second.spec.completion_checks,filtered.ids)),false);
  assert.equal(model.calls.length,2);
});

test('native completion never grants authority to forged certificate JSON, missing resolver or foreign owned runs',async t=>{
  const x=await setup(t),owner=x.work(),foreign=x.work(),run=await x.execute(owner),checks=owner.spec.completion_checks;
  const model={calls:[],async call(){assert.fail('Missing native authority must not reach a claimed success.');}};
  const forged=structuredClone(run.observation);forged.receipt.value.native_output_certificate={exact_native_bytes_match:true,output_rows:3,user_goal_verified:true};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest})(checks,[forged],claim(checks,run.ids)),false);
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:foreign.resolver})(checks,[forged],claim(checks,run.ids)),false);
  const changed=structuredClone(forged);changed.receipt.value.result.artifact.rows=99;
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})(checks,[changed],claim(checks,run.ids)),false);
  assert.equal(await createWorkCompletionVerifier(model,{nativeResolver:owner.resolver})(checks,[run.observation],claim(checks,run.ids)),false,'A native check alone may not declare whole-user completion.');
});

test('changing current source or same-length artifact bytes invalidates native completion even after earlier success',async t=>{
  const x=await setup(t),owner=x.work(),run=await x.execute(owner),checks=owner.spec.completion_checks,model=originalRequestModel();
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver});
  assert.equal(await verify(checks,[run.observation],claim(checks,run.ids)),true);
  const originalBytes=await readFile(run.value.result.artifact.path),tampered=Buffer.from(originalBytes);tampered[tampered.indexOf(Buffer.from('8'))]='9'.charCodeAt(0);
  await writeFile(run.value.result.artifact.path,tampered);
  assert.equal(await verify(checks,[run.observation],claim(checks,run.ids)),false);assert.equal(model.inputs.length,1);
  await writeFile(run.value.result.artifact.path,originalBytes);await writeFile(x.sourcePath,JSON.stringify([{id:'A',status:'Open',score:'4'}]));
  assert.equal(await verify(checks,[run.observation],claim(checks,run.ids)),false);assert.equal(model.inputs.length,1);
});

test('stored recipe changes cannot reuse a formerly valid run binding even when output bytes would still match',async t=>{
  const x=await setup(t),owner=x.work(),run=await x.execute(owner),checks=owner.spec.completion_checks;
  const before=x.api.store.packRun(x.config.project.id,run.value.run_id),changedRecipe={...before.recipe,request:'A different saved execution contract.'};
  x.api.store.hermesState.prepare('UPDATE family_run SET recipe=? WHERE project_id=? AND id=?').run(JSON.stringify(changedRecipe),x.config.project.id,before.id);
  const model={calls:[],async call(){assert.fail('A mutated recipe must fail host provenance before semantic verification.');}};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})(checks,[run.observation],claim(checks,run.ids)),false);
});

test('original-request verification retains contradictory older receipts beside native proof',async t=>{
  const x=await setup(t),owner=x.work(),run=await x.execute(owner),older={invocation:{request_id:'older-source',turn:1,stage_id:'collect',tool_name:'source_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{fact:'Source row B must not be omitted.'},evidence_ids:['older-evidence'],effect_state:'none',retry_safe:true},observed_at:new Date().toISOString()};
  const model=originalRequestModel({reject:true,assertInput:input=>{assert.ok(input.observations.some(item=>item.value.fact==='Source row B must not be omitted.'));assert.ok(input.checks[0].allowed_evidence_ids.includes('older-evidence'));}});
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})(owner.spec.completion_checks,[run.observation,older],claim(owner.spec.completion_checks,run.ids)),false);
  assert.equal(model.inputs.length,1);
});

test('arbitrary business prose cannot acquire native authority, and invalid technical contracts are rejected',async t=>{
  const x=await setup(t),owner=x.work(),run=await x.execute(owner),bad={...owner.spec.completion_checks[0],result:'All required business analysis is correct.'};
  assert.throws(()=>validateWorkProposal({...owner.spec,completion_checks:[bad]},'quick'),/NATIVE_COMPLETION_TEXT_NOT_CANONICAL/u);
  const model={calls:[],async call(){assert.fail('Noncanonical text must be rejected before any native or semantic success.');}};
  assert.equal(await createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,nativeResolver:owner.resolver})([bad],[run.observation],claim([bad],run.ids)),false);
  assert.equal(nativeCompletionPredicateSchema.safeParse({...filePredicate,columns:['id','id']}).success,false);
  assert.equal(nativeCompletionPredicateSchema.safeParse({...filePredicate,family:'portal.collect'}).success,false);
});
