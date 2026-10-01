import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {z} from 'zod';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {bindWorkIntakeOptions} from '../dist/work/intake-options.js';
import {collectionContractSchema,modelCollectionContractSchema,compileModelCollectionContract,sealCollectionContract,readSealedCollectionContract,assertSealedCollectionRecipe,verifySealedCollectionRun,createCollectionCompletionResolver} from '../dist/work/collection-contract.js';

const original=[{id:'A',status:'Open',note:'keep A'},{id:'B',status:'Closed',note:'keep B'},{id:'C',status:'Open',note:'keep C'}];
const recipe={version:1,family:'file.pipeline',request:'Export all matching observed Open rows',sources:[{id:'rows',parameters:{}}],filters:[{field:'status',op:'eq',value:'Open'}],deduplicate_by:['id'],columns:['id','status'],numeric_columns:[],sort:{field:'id',direction:'asc'},format:'json'};
const check=id=>({id,result:`Verify ${id}`,evidence:`Saved ${id} result`});
const makeSpec=(contract={version:1,recipe,scope:'all_matching_observed_rows',covered_check_ids:['rows','format']})=>({
  title:'Save selected records',desired_outcome:'Save every matching observed row',completion_checks:[check('rows'),check('format'),check('semantic')],
  assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',
  recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Save every matching observed row','local_file_write'),
  ...(contract?{collection_contract:contract}:{}),
});
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'collection-contract-')),path=join(root,'rows.json'),host=join(root,'host.json');
  await writeFile(path,JSON.stringify(original));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'collection-contract',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'rows',kind:'file',path,format:'json'}],targets:[],models:'off'}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config),spec=makeSpec(),started=api.store.beginWork(config.project.id,randomUUID(),'Save every Open row from the registered file as JSON.','quick');
  bindWorkIntakeOptions(api.store,config.project.id,started.work.id,{completion_condition:'Keep all matching observed rows and exclude Closed rows.',delivery_target_ids:null});
  const owner=api.store.claimWorkDefinition(config.project.id,started.work.id),work=api.store.finishWorkDefinition(config.project.id,started.work.id,owner,spec,[],'ready');
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {root,path,api,config,spec,work};
}
const observation=(run,requestId,id='pack-evidence',observedRecipe=recipe)=>({invocation:{request_id:requestId,turn:0,stage_id:'collect',tool_name:'runtime_pack_run',arguments:{recipe:observedRecipe},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:run,evidence_ids:[id],effect_state:'verified',retry_safe:false},observed_at:new Date().toISOString()});
const claim=ids=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Proposed complete',wait_reason:null,completed_checks:['rows','format','semantic'].map(id=>({id,evidence_ids:ids}))});

test('model-facing parameter pairs compile to the canonical exact recipe without dynamic propertyNames',()=>{
  const model={version:1,scope:'all_matching_observed_rows',covered_check_ids:['rows'],recipe:{...recipe,sources:[{id:'rows',parameters:[{name:'month',value:'2026-10'},{name:'state',value:'Open'}]}]}};
  assert.equal(JSON.stringify(z.toJSONSchema(modelCollectionContractSchema)).includes('propertyNames'),false);
  const compiled=compileModelCollectionContract(model);
  assert.deepEqual(compiled.recipe.sources,[{id:'rows',parameters:{month:'2026-10',state:'Open'}}]);
  assert.deepEqual(compileModelCollectionContract(compiled),compiled,'Canonical saved/fixture recipes remain readable.');
  assert.throws(()=>compileModelCollectionContract({...model,recipe:{...model.recipe,sources:[{id:'rows',parameters:[{name:'month',value:'one'},{name:'month',value:'two'}]}]}}),/WORK_COLLECTION_PARAMETER_DUPLICATE/u);
  assert.throws(()=>compileModelCollectionContract({...model,recipe:{...model.recipe,sources:[{id:'rows',parameters:[{name:'__proto__',value:'bad'}]}]}}),error=>error instanceof z.ZodError&&error.issues[0]?.code==='invalid_format'&&error.issues[0]?.path.join('.')==='recipe.sources.0.parameters.0.name');
  assert.throws(()=>compileModelCollectionContract({...model,recipe:{...model.recipe,sources:[{id:'rows',parameters:[{name:'constructor',value:'bad'}]}]}}),/WORK_COLLECTION_PARAMETER_NAME_UNSAFE/u);
  assert.throws(()=>compileModelCollectionContract({...model,recipe:{...model.recipe,sources:[{id:'rows',parameters:[]},{id:'other',parameters:{}}]}}));
});

test('first Work interpretation seals one exact recipe and checks only the declared covered IDs',{timeout:30000},async t=>{
  const x=await fixture(t);
  assert.equal(collectionContractSchema.parse(x.spec.collection_contract).recipe.family,'file.pipeline');
  const saved=sealCollectionContract(x.api.store,x.config,x.work.id,x.spec);
  assert.equal(saved.sealed_work_revision,x.work.revision);assert.equal(saved.contract.covered_check_ids.length,2);
  assert.deepEqual(sealCollectionContract(x.api.store,x.config,x.work.id,x.spec),saved,'A repeated same-revision seal is idempotent.');
  assert.deepEqual(readSealedCollectionContract(x.api.store,x.config,x.work.id,x.spec),saved);
  assert.deepEqual(assertSealedCollectionRecipe(x.api.store,x.config,x.work.id,recipe),saved);
  assert.throws(()=>assertSealedCollectionRecipe(x.api.store,x.config,x.work.id,{...recipe,filters:[]}),/WORK_COLLECTION_RECIPE_CHANGED/u);
  assert.throws(()=>assertSealedCollectionRecipe(x.api.store,x.config,x.work.id,{...recipe,columns:['id']}),/WORK_COLLECTION_RECIPE_CHANGED/u);
  assert.equal(x.api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM office_collection_contract WHERE work_id=?').get(x.work.id).n,1);
  const requestId=`sealed-${randomUUID()}`,run=await x.api.call('runtime_pack_run',{request_id:requestId,work_id:x.work.id,recipe});
  assert.equal(run.status,'succeeded');assert.deepEqual(JSON.parse(await readFile(run.result.artifact.path,'utf8')),[{id:'A',status:'Open'},{id:'C',status:'Open'}]);
  const verified=await verifySealedCollectionRun(x.api.store,x.config,x.work.id,run.run_id);
  assert.equal(verified?.certificate.output_rows,2);assert.equal(verified?.certificate.observed_source_rows,3);
  const resolved=await createCollectionCompletionResolver(x.api.store,x.config,x.work.id)(x.spec.completion_checks,[observation(run,requestId)],claim(['pack-evidence']));
  assert.equal(resolved.verified,true);assert.deepEqual(resolved.covered_check_ids,['rows','format']);assert.deepEqual(resolved.evidence_ids,['pack-evidence']);
  const noCoveredCitation=claim(['other-evidence']);assert.equal((await createCollectionCompletionResolver(x.api.store,x.config,x.work.id)(x.spec.completion_checks,[observation(run,requestId)],noCoveredCitation)).verified,false);
  const forged=observation({...run,result:{...run.result,artifact:{...run.result.artifact,rows:3}}},requestId);
  assert.equal((await createCollectionCompletionResolver(x.api.store,x.config,x.work.id)(x.spec.completion_checks,[forged],claim(['pack-evidence']))).verified,false);
  await writeFile(run.result.artifact.path,'{"changed":true}\n');
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,x.work.id,run.run_id),null,'A changed output never inherits the earlier certificate.');
});

test('source changes, foreign Works and user-direction drift cannot inherit the seal',{timeout:30000},async t=>{
  const x=await fixture(t),saved=sealCollectionContract(x.api.store,x.config,x.work.id,x.spec);
  const requestId=`sealed-${randomUUID()}`,run=await x.api.call('runtime_pack_run',{request_id:requestId,work_id:x.work.id,recipe});assert.equal(run.status,'succeeded');
  const begun=x.api.store.beginWork(x.config.project.id,randomUUID(),'A different request','quick'),owner=x.api.store.claimWorkDefinition(x.config.project.id,begun.work.id),foreign=x.api.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,x.spec,[],'ready');
  sealCollectionContract(x.api.store,x.config,foreign.id,x.spec);
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,foreign.id,run.run_id),null);
  await writeFile(x.path,JSON.stringify([...original,{id:'D',status:'Open',note:'new'}]));
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,x.work.id,run.run_id),null,'Current file bytes no longer match the saved source.');
  assert.equal((await createCollectionCompletionResolver(x.api.store,x.config,x.work.id)(x.spec.completion_checks,[observation(run,requestId)],claim(['pack-evidence']))).verified,false);
  x.api.store.hermesState.prepare('INSERT INTO office_work_revision VALUES (?,?,?,?,?,?)').run(x.work.id,x.work.revision+1,'direction_changed',JSON.stringify({run_id:randomUUID(),step_id:'scope',instruction:'Include Closed rows too',created_at:new Date().toISOString()}),'{}',new Date().toISOString());
  assert.throws(()=>readSealedCollectionContract(x.api.store,x.config,x.work.id),/WORK_COLLECTION_CONTRACT_CHANGED/u);
  assert.equal(saved.recipe_sha256.length,64);
});

test('unsafe or incomplete proposals never create a completion authority',async t=>{
  const x=await fixture(t);
  assert.throws(()=>readSealedCollectionContract(x.api.store,x.config,x.work.id,x.spec),/WORK_COLLECTION_SEAL_MISSING/u);
  assert.throws(()=>sealCollectionContract(x.api.store,x.config,x.work.id,{...x.spec,collection_contract:{...x.spec.collection_contract,covered_check_ids:['missing']}}),/WORK_COLLECTION_SPEC_NOT_STORED/u);
  const noContract=makeSpec(null),begun=x.api.store.beginWork(x.config.project.id,randomUUID(),'Uncontracted legacy Work','quick'),owner=x.api.store.claimWorkDefinition(x.config.project.id,begun.work.id),legacy=x.api.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,noContract,[],'ready');
  assert.equal(readSealedCollectionContract(x.api.store,x.config,legacy.id,noContract),null);
  assert.equal(await createCollectionCompletionResolver(x.api.store,x.config,legacy.id)(noContract.completion_checks,[],claim([])),null);
});

test('a covered explicit native row count must agree with the fresh certificate',{timeout:30000},async t=>{
  const x=await fixture(t),predicate={version:1,kind:'native_pack_output',family:'file.pipeline',format:'json',columns:['id','status'],output_rows:3,numeric_columns:[],sort:{field:'id',direction:'asc'}};
  const spec={...x.spec,completion_checks:[{...check('rows'),native_check:predicate},check('format'),check('semantic')]};
  const begun=x.api.store.beginWork(x.config.project.id,randomUUID(),'Count every matching Open row','quick'),owner=x.api.store.claimWorkDefinition(x.config.project.id,begun.work.id),work=x.api.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,spec,[],'ready');
  sealCollectionContract(x.api.store,x.config,work.id,spec);
  const requestId=`native-count-${randomUUID()}`,run=await x.api.call('runtime_pack_run',{request_id:requestId,work_id:work.id,recipe});
  assert.equal(run.status,'succeeded');assert.equal(run.result.artifact.rows,2);
  const verdict=await createCollectionCompletionResolver(x.api.store,x.config,work.id)(spec.completion_checks,[observation(run,requestId)],claim(['pack-evidence']));
  assert.equal(verdict.verified,false,'The sealed recipe cannot override a different explicit fixed row count.');
});

test('a later same-Work exact recipe run supersedes an older valid observation',{timeout:30000},async t=>{
  const x=await fixture(t);sealCollectionContract(x.api.store,x.config,x.work.id,x.spec);
  const oldRequest=`old-${randomUUID()}`,old=await x.api.call('runtime_pack_run',{request_id:oldRequest,work_id:x.work.id,recipe});
  assert.equal(old.status,'succeeded');assert.ok(await verifySealedCollectionRun(x.api.store,x.config,x.work.id,old.run_id));
  const newRequest=`new-${randomUUID()}`,latest=await x.api.call('runtime_pack_run',{request_id:newRequest,work_id:x.work.id,recipe});
  assert.equal(latest.status,'succeeded');assert.equal(await verifySealedCollectionRun(x.api.store,x.config,x.work.id,old.run_id),null);
  await writeFile(latest.result.artifact.path,'{"incomplete":true}\n');
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,x.work.id,latest.run_id),null);
  const oldReceipt=observation(old,oldRequest),verdict=await createCollectionCompletionResolver(x.api.store,x.config,x.work.id)(x.spec.completion_checks,[oldReceipt],claim(['pack-evidence']));
  assert.equal(verdict.verified,false,'The intact older artifact cannot hide an invalid latest same-recipe output.');
});

test('a legacy run with only different request prose can be reverified, but never dispatched under the new seal',{timeout:30000},async t=>{
  const x=await fixture(t),legacyRecipe={...recipe,request:'Earlier wording for the same native transformation'};
  const begun=x.api.store.beginWork(x.config.project.id,randomUUID(),'Legacy Work before a collection contract','quick');
  const owner=x.api.store.claimWorkDefinition(x.config.project.id,begun.work.id);
  const oldSpec=makeSpec(null),work=x.api.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,oldSpec,[],'ready');
  const oldRequest=`legacy-${randomUUID()}`,old=await x.api.call('runtime_pack_run',{request_id:oldRequest,work_id:work.id,recipe:legacyRecipe});
  assert.equal(old.status,'succeeded');
  x.api.store.hermesState.prepare('UPDATE office_intake SET spec=?,revision=revision+1 WHERE work_id=?').run(JSON.stringify(x.spec),work.id);
  const seal=sealCollectionContract(x.api.store,x.config,work.id,x.spec);
  assert.notEqual(seal.recipe_sha256,x.api.store.packRun(x.config.project.id,old.run_id).binding,'The seal and original run retain separate full bindings.');
  assert.throws(()=>assertSealedCollectionRecipe(x.api.store,x.config,work.id,legacyRecipe),/WORK_COLLECTION_RECIPE_CHANGED/u);
  assert.ok(await verifySealedCollectionRun(x.api.store,x.config,work.id,old.run_id),'The original full run binding and certificate remain valid.');
  const resolved=await createCollectionCompletionResolver(x.api.store,x.config,work.id)(x.spec.completion_checks,[observation(old,oldRequest,'pack-evidence',legacyRecipe)],claim(['pack-evidence']));
  assert.equal(resolved.verified,true);
  const newRequest=`current-${randomUUID()}`,current=await x.api.call('runtime_pack_run',{request_id:newRequest,work_id:work.id,recipe});
  assert.equal(current.status,'succeeded');
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,work.id,old.run_id),null,'The latest mechanically equivalent run supersedes the legacy one.');
  await writeFile(current.result.artifact.path,'{"changed":true}\n');
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,work.id,current.run_id),null,'Changed output bytes remain forbidden.');
});

test('a legacy run with changed filter cannot be inherited by a new contract',{timeout:30000},async t=>{
  const x=await fixture(t),legacyRecipe={...recipe,request:'Earlier wording',filters:[]};
  const begun=x.api.store.beginWork(x.config.project.id,randomUUID(),'Legacy Work with a different filter','quick');
  const owner=x.api.store.claimWorkDefinition(x.config.project.id,begun.work.id);
  const oldSpec=makeSpec(null),work=x.api.store.finishWorkDefinition(x.config.project.id,begun.work.id,owner,oldSpec,[],'ready');
  const requestId=`different-filter-${randomUUID()}`,run=await x.api.call('runtime_pack_run',{request_id:requestId,work_id:work.id,recipe:legacyRecipe});
  assert.equal(run.status,'succeeded');
  x.api.store.hermesState.prepare('UPDATE office_intake SET spec=?,revision=revision+1 WHERE work_id=?').run(JSON.stringify(x.spec),work.id);
  sealCollectionContract(x.api.store,x.config,work.id,x.spec);
  assert.equal(await verifySealedCollectionRun(x.api.store,x.config,work.id,run.run_id),null);
  const verdict=await createCollectionCompletionResolver(x.api.store,x.config,work.id)(x.spec.completion_checks,[observation(run,requestId,'pack-evidence',legacyRecipe)],claim(['pack-evidence']));
  assert.equal(verdict.verified,false);assert.equal(verdict.reason,'WORK_COLLECTION_MECHANICAL_RECIPE_MISMATCH');
});

test('direct Pack API rejects changed same-family recipe before HTTP dispatch, including inferred Work identity',{timeout:30000},async t=>{
  let requests=0;const server=createServer((_request,response)=>{requests++;response.writeHead(200,{'content-type':'application/json'});response.end(JSON.stringify(original));});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const root=await mkdtemp(join(tmpdir(),'collection-contract-http-')),host=join(root,'host.json'),origin=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const source={id:'http-rows',kind:'http',url:`${origin}/rows`,format:'json'},httpRecipe={version:1,family:'portal.collect',request:'Export matching observed rows',sources:[{id:'http-rows',parameters:{}}],filters:[{field:'status',op:'eq',value:'Open'}],deduplicate_by:[],columns:['id','status'],format:'json'};
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'collection-http',caller_ref:'fixture',account_ref:'account-a',worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:`${origin}/lab/account-a/`,packs:{sources:[source],targets:[],models:'off'}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);t.after(async()=>{api.close();await api.drain();});
  const spec={...makeSpec({version:1,recipe:httpRecipe,scope:'all_matching_observed_rows',covered_check_ids:['rows']}),route:{kind:'pack',pack_family:'portal.collect'}};
  const workRequest=randomUUID(),begun=api.store.beginWork(config.project.id,workRequest,'Export every Open row from this registered response','quick'),owner=api.store.claimWorkDefinition(config.project.id,begun.work.id),work=api.store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
  sealCollectionContract(api.store,config,work.id,spec);
  const changed={...httpRecipe,filters:[]};
  await assert.rejects(api.call('runtime_pack_run',{request_id:`wrong-${randomUUID()}`,work_id:work.id,recipe:changed}),/WORK_COLLECTION_RECIPE_CHANGED/u);
  await assert.rejects(api.call('runtime_pack_run',{request_id:workRequest,recipe:changed}),/WORK_COLLECTION_RECIPE_CHANGED/u);
  assert.equal(requests,0);assert.equal(api.store.hermesState.prepare('SELECT COUNT(*) AS n FROM family_run WHERE project_id=?').get(config.project.id).n,0);
});
