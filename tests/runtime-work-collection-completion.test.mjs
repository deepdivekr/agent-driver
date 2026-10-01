import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {createWorkCompletionVerifier,createWorkRunTraceEvidence} from '../dist/work/completion.js';
import {createCollectionCompletionResolver,readSealedCollectionContract,sealCollectionContract,verifySealedCollectionRun} from '../dist/work/collection-contract.js';
import {supervisorStatus} from '../dist/work/supervisor.js';
import {sha} from '../dist/packs/data.js';

const rows=[{id:'A',status:'Open',score:'4'},{id:'B',status:'Closed',score:'8'},{id:'C',status:'Open',score:'6'}];
const request={prompt:'Read every registered row and write an exact local JSON result.',completion_condition:'Keep all source rows.',delivery_target_ids:null,user_directions:[]};
const fileRecipe={version:1,family:'file.pipeline',request:'Preserve every source row and normalize its score.',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],columns:['id','status','score'],numeric_columns:['score'],sort:{field:'score',direction:'desc'},format:'json'};
const portalRecipe={version:1,family:'portal.collect',request:'Collect every registered row into local JSON.',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:['id'],format:'json'};
const claim=(checks,ids)=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Executor proposal, not completion evidence.',wait_reason:null,completed_checks:checks.map(check=>({id:check.id,evidence_ids:ids}))});
const noModel=()=>({calls:[],async call(){assert.fail('A fully sealed deterministic collection must not ask a model to verify it.');}});

async function setup(t,{model=null,httpBase=null}={}){
  const root=await mkdtemp(join(tmpdir(),'work-collection-completion-')),sourcePath=join(root,'rows.json'),hostPath=join(root,'host.json');
  await writeFile(sourcePath,JSON.stringify(rows));
  await writeFile(hostPath,JSON.stringify({schema_version:1,project_id:'work-collection-completion',caller_ref:'fixture',account_ref:httpBase?'account-a':'owner',worktree:root,data_dir:join(root,'data'),environment:httpBase?'fixture':'production',...(httpBase?{fixture_url:httpBase}:{}),packs:{models:'off',sources:httpBase?[{id:'rows',kind:'http',url:httpBase+'records',parameters:['period'],format:'json'}]:[{id:'rows',kind:'file',path:sourcePath,format:'json'}],targets:[]},...(model?{work:{model_data_approved:true}}:{})}));
  const config=loadHostConfig(hostPath),api=new RuntimeApi(config,model?{swarmModel:model}:{}),toolkits=[];initWorkExecution(api.store);
  t.after(async()=>{for(const toolkit of toolkits)await toolkit.close();api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  function work(recipe=fileRecipe,{semantic=false,prompt=request.prompt,unsealed=false}={}){
    const checks=[{id:'all_rows',result:'The local JSON result contains every observed source row.',evidence:'Fresh native source and artifact byte/count comparison.'}];
    if(semantic)checks.push({id:'semantic_meaning',result:'The output has the intended business meaning.',evidence:'Independent interpretation of actual observed result values.'});
    if(semantic==='multiple')checks.push({id:'semantic_context',result:'The stated interpretation preserves its business context.',evidence:'Independent interpretation of actual observed context.'});
    const spec={title:'Exact local collection',desired_outcome:prompt,completion_checks:checks,assumptions:[],route:{kind:'pack',pack_family:recipe.family},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan(prompt,'local_file_write'),...(!unsealed?{collection_contract:{version:1,recipe,scope:'all_matching_observed_rows',covered_check_ids:['all_rows']}}:{})};
    const begun=api.store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),saved=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
    if(unsealed)assert.equal(sealCollectionContract(api.store,config,saved.id,saved.spec),null);
    else assert.ok(sealCollectionContract(api.store,config,saved.id,saved.spec));
    const toolkit=new WorkExecutionTools(api.store,config,api,saved.id,randomUUID(),saved.spec,prompt,()=>{},{async call(){assert.fail('A Pack run needs no model.');}});toolkits.push(toolkit);
    return {saved,checks,toolkit,resolver:createCollectionCompletionResolver(api.store,config,saved.id)};
  }
  async function run(owner,recipe){
    const requestId=`collect-${randomUUID()}`,value=await owner.toolkit.execute('runtime_pack_run',{recipe},requestId);assert.equal(value.status,'succeeded');
    const receipt=await owner.toolkit.receipt('runtime_pack_run',value,requestId);assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');
    const observation={invocation:{request_id:requestId,turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{recipe},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()};
    return {value,observation,ids:receipt.evidence_ids};
  }
  return {api,config,sourcePath,work,run};
}

for(const [family,recipe,expected] of [
  ['file.pipeline',fileRecipe,[{id:'B',status:'Closed',score:8},{id:'C',status:'Open',score:6},{id:'A',status:'Open',score:4}]],
  ['portal.collect',portalRecipe,rows],
])test(`runtime fixture ${family} completes only after fresh sealed all-row artifact verification, with zero model calls`,async t=>{
  const x=await setup(t),owner=x.work(recipe),run=await x.run(owner,recipe),audits=[],model=noModel();
  const actualBytes=await readFile(run.value.result.artifact.path),actual=JSON.parse(actualBytes.toString('utf8'));
  assert.deepEqual(actual,expected,'Read actual output values, not only a Pack succeeded flag.');
  const independent=await verifySealedCollectionRun(x.api.store,x.config,owner.saved.id,run.value.run_id);
  assert.ok(independent);assert.equal(independent.certificate.observed_source_rows,rows.length);
  assert.equal(independent.certificate.output_rows,expected.length);
  assert.equal(independent.certificate.exact_native_bytes_match,true);
  assert.equal(run.value.result.artifact.sha256,sha(actualBytes));
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:owner.resolver,audit:event=>audits.push(event)});
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),true);
  assert.equal(model.calls.length,0);assert.ok(audits.some(event=>event.code==='WORK_COLLECTION_CONTRACT_VERIFIED'&&event.verifier==='native'&&event.certificate_sha256));
});

test('runtime fixture mixed contract verifies covered rows in code and calls the model only for the uncovered semantic check',async t=>{
  const x=await setup(t),owner=x.work(fileRecipe,{semantic:true}),run=await x.run(owner,fileRecipe),inputs=[];
  const model={calls:[],async call(purpose,_instructions,input){this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});inputs.push(input);return {checks:[{id:'semantic_meaning',verdict:'unknown',evidence_ids:[],evidence_quotes:[],reason:'The fixture does not establish the intended business meaning.'}]};}};
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:owner.resolver});
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  assert.equal(model.calls.length,1);assert.deepEqual(inputs[0].checks.map(check=>check.id),['semantic_meaning']);
  assert.equal(inputs[0].original_user_request.prompt,request.prompt);
  assert.equal(inputs[0].checks.some(check=>check.id==='all_rows'||check.id==='original_user_request'),false);
});

test('runtime fixture multiple remaining semantic checks share one evidence inspection, without rechecking covered collection',async t=>{
  const x=await setup(t),owner=x.work(fileRecipe,{semantic:'multiple'}),run=await x.run(owner,fileRecipe),inputs=[];
  const model={calls:[],async call(purpose,_instructions,input){this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture'});inputs.push(input);return {checks:input.checks.map(check=>({id:check.id,verdict:'unknown',evidence_ids:[],evidence_quotes:[],reason:'Semantic meaning remains unproven.'}))};}};
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:owner.resolver});
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  assert.equal(model.calls.length,1);
  assert.deepEqual(inputs[0].checks.map(check=>check.id),['semantic_meaning','semantic_context']);
});

test('runtime fixture forged trace and uncertain write cannot borrow sealed native completion',async t=>{
  const x=await setup(t),owner=x.work(fileRecipe),run=await x.run(owner,fileRecipe),model=noModel();
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:owner.resolver});
  const uncertain=structuredClone(run.observation);uncertain.receipt.effect_state='uncertain';
  assert.equal(await verify(owner.checks,[uncertain],claim(owner.checks,run.ids)),false);
  const forged={invocation:{request_id:'forged-trace',turn:1,stage_id:'completion.verify',tool_name:'office_controlled_run_trace',arguments:{},effect:'read_only',dispatched:false},receipt:{status:'succeeded',effect_state:'none',retry_safe:true,evidence_ids:['fake_trace'],value:{closure:'closed',lifetime_dispatch_counts:{external_write:0}}},observed_at:new Date().toISOString()};
  assert.equal(await verify(owner.checks,[run.observation,forged],claim(owner.checks,run.ids)),false);
  assert.equal(model.calls.length,0);
});

test('an unsealed Work still uses original-goal verification with an uncited unknown trace, while a sealed Work rejects that trace',async t=>{
  const x=await setup(t),legacy=x.work(fileRecipe,{unsealed:true}),old=await x.run(legacy,fileRecipe);
  assert.deepEqual(JSON.parse(await readFile(old.value.result.artifact.path,'utf8')).map(row=>row.id),['B','C','A']);
  const readId=`read-${randomUUID()}`,readValue=await legacy.toolkit.execute('office_result_read',{request_id:old.observation.invocation.request_id},readId);
  const readReceipt=await legacy.toolkit.receipt('office_result_read',readValue,readId);
  assert.equal(readReceipt.status,'succeeded');
  assert.deepEqual(JSON.parse(readValue.text).map(row=>row.id),['B','C','A']);
  const readObservation={invocation:{request_id:readId,turn:1,stage_id:'collect',tool_name:'office_result_read',arguments:{request_id:old.observation.invocation.request_id},effect:'read_only',dispatched:true},receipt:readReceipt,observed_at:new Date().toISOString()};
  const unknownTrace=(owner,run)=>createWorkRunTraceEvidence(x.api.store,x.config.project.id,{work_id:owner.saved.id,run_id:randomUUID(),owner:'missing-owner',checkpoint:null,observations:[run.observation],admission_closed:true});
  const trace=createWorkRunTraceEvidence(x.api.store,x.config.project.id,{work_id:legacy.saved.id,run_id:randomUUID(),owner:'missing-owner',checkpoint:null,observations:[old.observation,readObservation],admission_closed:true});assert.equal(trace.receipt.value.closure,'unknown');
  const model={calls:[],async call(_purpose,instructions,input){
    this.calls.push(input);assert.ok(instructions.startsWith('Independently verify'));
    assert.deepEqual(input.checks.map(check=>check.id),['all_rows','original_user_request']);
    assert.ok(input.observations.some(item=>item.evidence_ids.includes(readId)));
    return {checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_use:'observed_result',evidence_ids:[readId],evidence_quotes:[{evidence_id:readId,quote:readValue.text}],reason:'The independently read complete local output contains all three source rows.'}))};
  }};
  const verifyLegacy=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:legacy.resolver});
  assert.equal(await verifyLegacy(legacy.checks,[old.observation,readObservation,trace],claim(legacy.checks,[readId])),true);
  assert.equal(model.calls.length,1,'An unsealed Work still invokes independent original-goal verification.');
  const sealed=x.work(fileRecipe),current=await x.run(sealed,fileRecipe),sealedTrace=unknownTrace(sealed,current),neverModel=noModel();
  assert.equal(sealedTrace.receipt.value.closure,'unknown');
  const verifySealed=createWorkCompletionVerifier(neverModel,{originalUserRequest:request,collectionResolver:sealed.resolver});
  assert.equal(await verifySealed(sealed.checks,[current.observation,sealedTrace],claim(sealed.checks,current.ids)),false);
  assert.equal(neverModel.calls.length,0,'The collection contract does not accept an unclosed host trace.');
});

test('runtime fixture foreign Work, changed source, recipe and stored request drift fail closed',async t=>{
  const x=await setup(t),owner=x.work(fileRecipe),foreign=x.work(fileRecipe),run=await x.run(owner,fileRecipe),model=noModel();
  const verify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:owner.resolver});
  const foreignVerify=createWorkCompletionVerifier(model,{originalUserRequest:request,collectionResolver:foreign.resolver});
  assert.equal(await foreignVerify(foreign.checks,[run.observation],claim(foreign.checks,run.ids)),false);
  const wrongReceipt=structuredClone(run.observation);wrongReceipt.receipt.value.result.artifact.rows=99;
  assert.equal(await verify(owner.checks,[wrongReceipt],claim(owner.checks,run.ids)),false);
  await writeFile(x.sourcePath,JSON.stringify([{id:'replaced',status:'Open',score:'999'}]));
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  await writeFile(x.sourcePath,JSON.stringify(rows));
  const changedRecipe={...fileRecipe,filters:[{field:'status',op:'eq',value:'Open'}]};
  assert.throws(()=>owner.toolkit.validate('runtime_pack_run',{recipe:changedRecipe},'changed-recipe'),/WORK_COLLECTION_RECIPE_CHANGED/u);
  const originalRunRecipe=x.api.store.hermesState.prepare('SELECT recipe FROM family_run WHERE id=?').get(run.value.run_id).recipe;
  x.api.store.hermesState.prepare('UPDATE family_run SET recipe=? WHERE id=?').run(JSON.stringify(changedRecipe),run.value.run_id);
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  x.api.store.hermesState.prepare('UPDATE family_run SET recipe=? WHERE id=?').run(originalRunRecipe,run.value.run_id);
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),true);
  x.api.store.hermesState.prepare('UPDATE office_intake SET prompt=? WHERE work_id=?').run('Changed original instruction',owner.saved.id);
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  x.api.store.hermesState.prepare('UPDATE office_intake SET prompt=? WHERE work_id=?').run(request.prompt,owner.saved.id);
  x.api.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify({...owner.saved.spec,desired_outcome:'Changed saved specification'}),owner.saved.id);
  assert.equal(await verify(owner.checks,[run.observation],claim(owner.checks,run.ids)),false);
  assert.equal(model.calls.length,0);
});

const modelProposal=(recipe=fileRecipe)=>({title:'Collect exact local rows',desired_outcome:request.prompt,completion_checks:[{id:'all_rows',result:'The local JSON result contains every observed source row.',evidence:'Fresh native source and artifact byte/count comparison.'}],assumptions:[],route:{kind:'pack',pack_family:recipe.family},requested_effect:'local_file_write',collection_contract:{version:1,recipe,scope:'all_matching_observed_rows',covered_check_ids:['all_rows']},recurrence:{kind:'once',rule:null},questions:[],plan:{steps:[{id:'collect',goal:'Save all registered records as local JSON.',observable_outcome:'All source rows are represented in the saved result.',depends_on:[],effect:'local_write',tool_hints:['runtime_pack_run']}]}});

function lifecycleModel(recipe=fileRecipe){return {calls:[],async call(purpose,instructions,input){
  this.calls.push({purpose,instructions});
  if(instructions.startsWith('Define one durable'))return modelProposal(recipe);
  if(instructions.startsWith('Execute the registered Work')){
    const output=input.checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run');
    if(!output)return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe}),summary:'Run the sealed registered-source collection.',completed_checks:[],completed_stages:[],wait_reason:null};
    return {...claim(input.completion_checks,output.receipt.evidence_ids),completed_stages:[{stage_id:'collect',evidence_ids:output.receipt.evidence_ids}]};
  }
  assert.fail('A fully sealed first-interpretation collection must not call the model verifier.');
}};}

test('runtime fixture first model definition atomically seals the exact recipe and default supervisor finishes without verifier model calls; custom repeat seals a fresh Work',async t=>{
  const model=lifecycleModel();
  const x=await setup(t,{model});
  const defined=await x.api.work.start({request_id:'sealed-first-definition',prompt:request.prompt,completion_condition:request.completion_condition});
  assert.equal(defined.status,'ready');assert.equal(model.calls.filter(item=>item.purpose==='design').length,1);
  const sealed=readSealedCollectionContract(x.api.store,x.config,defined.work_id);
  assert.ok(sealed);assert.deepEqual(sealed.contract.recipe,fileRecipe);
  await x.api.call('runtime_work_execute',{work_id:defined.work_id,revision:defined.revision,cost_acknowledged:true});
  let status;
  for(let attempt=0;attempt<200;attempt++){
    status=supervisorStatus(x.api.store,x.config.project.id,defined.work_id);
    if(['succeeded','failed','awaiting_review','reconciliation_required','paused'].includes(status?.state))break;
    await delay(25);
  }
  const diagnostics=x.api.store.hermesState.prepare('SELECT kind,metadata FROM office_activity WHERE work_id=? ORDER BY id DESC LIMIT 8').all(defined.work_id);
  assert.equal(status?.state,'succeeded',JSON.stringify({status,model_calls:model.calls.map(item=>({purpose:item.purpose,kind:item.instructions.slice(0,90)})),diagnostics}));assert.equal(status.result.completion_verified,true);
  assert.equal(model.calls.filter(item=>item.purpose==='design').length,1);
  assert.equal(model.calls.filter(item=>item.instructions.startsWith('Execute the registered Work')).length,2);
  assert.equal(model.calls.filter(item=>item.instructions.startsWith('Independently verify')).length,0);
  const [bound]=x.api.store.officeRuns(x.config.project.id,defined.work_id).filter(item=>item.source_kind==='pack');assert.ok(bound);
  const artifact=x.api.store.packRun(x.config.project.id,bound.source_id).result.artifact;
  assert.deepEqual(JSON.parse(await readFile(artifact.path,'utf8')).map(row=>row.id),['B','C','A']);
  const published=await x.api.call('runtime_custom_pack_publish',{key:'sealed_collection',title:'Repeat exact collection',work_id:defined.work_id,supervisor_run_id:status.run_id,pack_run_id:bound.source_id});
  assert.equal(published.pack.version,1);
  const repeat=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'sealed_collection',cycle_id:'second_cycle'});
  assert.equal(repeat.created,true);assert.notEqual(repeat.work_id,defined.work_id);
  const next=readSealedCollectionContract(x.api.store,x.config,repeat.work_id);
  assert.ok(next);assert.deepEqual(next.contract.recipe,fileRecipe);
  assert.deepEqual(x.api.store.officeRuns(x.config.project.id,repeat.work_id),[],'Preparing a custom repeat does not inherit earlier evidence or execute a Pack.');
});

test('runtime fixture an invalid first-definition source rolls back spec, revision and seal atomically',async t=>{
  const invalid={...modelProposal(),collection_contract:{...modelProposal().collection_contract,recipe:{...fileRecipe,sources:[{id:'not_connected',parameters:{}}]}}};
  const model={calls:[],async call(purpose,instructions){this.calls.push({purpose});assert.ok(instructions.startsWith('Define one durable'));return invalid;}};
  const x=await setup(t,{model});
  const result=await x.api.work.start({request_id:'invalid-sealed-definition',prompt:request.prompt,completion_condition:request.completion_condition});
  assert.equal(result.status,'needs_model');assert.equal(model.calls.length,1);
  const stored=x.api.store.intakeWork(x.config.project.id,result.work_id);
  assert.equal(stored.revision,0);assert.equal(stored.spec,null);
  const revisions=x.api.store.hermesState.prepare('SELECT kind FROM office_work_revision WHERE work_id=? ORDER BY revision').all(result.work_id);
  assert.deepEqual(revisions.map(row=>row.kind),['received']);
  const table=x.api.store.hermesState.prepare("SELECT 1 FROM sqlite_master WHERE name='office_collection_contract'").get();
  if(table)assert.equal(Number(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM office_collection_contract WHERE work_id=?').get(result.work_id).count),0);
});

test('runtime fixture a custom repeat keeps the sealed source period and rejects an unapproved period substitution',async t=>{
  const served=[];
  const server=createServer((incoming,response)=>{
    const url=new URL(incoming.url,'http://127.0.0.1');const period=url.searchParams.get('period');served.push(period);
    response.setHeader('content-type','application/json');response.end(JSON.stringify([{id:'A',period},{id:'B',period}]));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(resolve=>server.close(resolve)));
  const httpBase=`http://127.0.0.1:${server.address().port}/test/account-a/`,recipe={...portalRecipe,sources:[{id:'rows',parameters:{period:'2026-09'}}],deduplicate_by:[]};
  const model=lifecycleModel(recipe),x=await setup(t,{model,httpBase});
  const defined=await x.api.work.start({request_id:'sealed-http-period',prompt:request.prompt,completion_condition:request.completion_condition});
  assert.equal(defined.status,'ready');assert.deepEqual(readSealedCollectionContract(x.api.store,x.config,defined.work_id).contract.recipe,recipe);
  await x.api.call('runtime_work_execute',{work_id:defined.work_id,revision:defined.revision,cost_acknowledged:true});
  let status;
  for(let attempt=0;attempt<200;attempt++){
    status=supervisorStatus(x.api.store,x.config.project.id,defined.work_id);
    if(['succeeded','failed','awaiting_review','reconciliation_required','paused'].includes(status?.state))break;
    await delay(25);
  }
  assert.equal(status?.state,'succeeded',JSON.stringify(status));assert.equal(status.result.completion_verified,true);
  assert.deepEqual(served,['2026-09']);
  const [bound]=x.api.store.officeRuns(x.config.project.id,defined.work_id).filter(item=>item.source_kind==='pack');assert.ok(bound);
  await x.api.call('runtime_custom_pack_publish',{key:'period_bound_collection',title:'Period-bound collection',work_id:defined.work_id,supervisor_run_id:status.run_id,pack_run_id:bound.source_id});
  await assert.rejects(x.api.call('runtime_custom_pack_prepare_repeat',{key:'period_bound_collection',cycle_id:'changed_period',parameters:{rows:{period:'2026-10'}}}),/CUSTOM_PACK_COLLECTION_SCOPE_REDEFINITION_REQUIRED/u);
  assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM office_custom_pack_repeat_work').get().count,0);
  assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS count FROM office_custom_pack_cycle WHERE cycle_id=?').get('changed_period').count,0,'A rejected repeat must not reserve its cycle ID.');
  const repeated=await x.api.call('runtime_custom_pack_prepare_repeat',{key:'period_bound_collection',cycle_id:'changed_period',parameters:{rows:{period:'2026-09'}}});
  assert.equal(repeated.created,true);assert.deepEqual(readSealedCollectionContract(x.api.store,x.config,repeated.work_id).contract.recipe,recipe);
  assert.deepEqual(served,['2026-09'],'Repeat preparation does not re-fetch the HTTP source.');
});
