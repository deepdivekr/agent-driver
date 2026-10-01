import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {WorkClientToolInputError} from '../dist/work/client-executor.js';
import {workReferenceMap} from '../dist/work/context.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {savedResearchSourceReadback} from '../dist/packs/native-output-certificate.js';

const model={async call(){assert.fail('No model call is permitted in this contract test.');}};
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'work-context-reference-')),host=join(root,'host.json');
  await writeFile(join(root,'rows.json'),JSON.stringify([{id:'one',status:'In Progress'},{id:'two',status:'Closed'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'context-reference-test',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models:'off',sources:[{id:'rows',kind:'file',path:'rows.json',format:'json'}],targets:[]}}));
  const config=loadHostConfig(host),api=new RuntimeApi(config);initWorkExecution(api.store);
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  const pasted=(label,reference)=>({format:1,source:{platform:'chatgpt_work',name:label,reference:null},title:{value:label,evidence_ids:[reference]},goal:{value:`Review ${label}`,evidence_ids:[reference]},trigger:{kind:'manual',rule:null,timezone:null,evidence_ids:[reference]},steps:[{id:'review',goal:'Read one source',depends_on:[],tool_hints:[],effect:'read_only',evidence_ids:[reference]}],completion:[{id:'read',result:'Source reviewed',proof:'Observed receipt',evidence_ids:[reference]}],delivery:{channel:'chat',target:null,evidence_ids:[reference]},dependencies:[],approval_boundary:{value:null,evidence_ids:[]},unknowns:[],evidence:[{id:reference,source_ref:`${label} source`,quote:`Review ${label}`}]});
  async function imported(label,reference){const draft=api.imports.paste({text:JSON.stringify(pasted(label,reference))}),accepted=await api.imports.accept({import_id:draft.import_id});return api.store.intakeWork(config.project.id,accepted.work_id);}
  const own=await imported('Own import','own_reference'),foreign=await imported('Foreign import','foreign_reference');
  const toolkit=new WorkExecutionTools(api.store,config,api,own.id,randomUUID(),own.spec,own.prompt,()=>{},model);t.after(()=>toolkit.close());
  return {config,api,own,foreign,toolkit};
}

test('Work context accepts only this Work reference-map IDs, never tool receipt or foreign Work IDs',async t=>{
  const x=await fixture(t),own=workReferenceMap(x.api.store,x.config.project.id,x.own.id).references[0].id,foreign=workReferenceMap(x.api.store,x.config.project.id,x.foreign.id).references[0].id;
  assert.equal(own,'own_reference');assert.equal(foreign,'foreign_reference');
  assert.match(x.toolkit.catalog().find(tool=>tool.name==='runtime_work_context').description,/evidence_ids are a different namespace/u);
  const realCall=x.api.call.bind(x.api);let calls=0;x.api.call=(...args)=>{calls++;return realCall(...args);};
  for(const invalid of ['work-tool-receipt-id',foreign]){
    assert.throws(()=>x.toolkit.validate('runtime_work_context',{actor:'fixture',reference_ids:[invalid]},`check-${invalid}`),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_CONTEXT_REFERENCE_ID_INVALID'&&error.not_dispatched===true&&/reference_map\.references/u.test(error.detail));
    await assert.rejects(x.toolkit.execute('runtime_work_context',{actor:'fixture',reference_ids:[invalid]},`run-${invalid}`),/WORK_CONTEXT_REFERENCE_ID_INVALID/u);
    assert.equal(calls,0,'invalid reference never reached RuntimeApi');
  }
  const core=await x.toolkit.execute('runtime_work_context',{actor:'fixture'},'core');
  assert.deepEqual(core.selected_references,[]);assert.equal(calls,1);
  const empty=await x.toolkit.execute('runtime_work_context',{actor:'fixture',reference_ids:[]},'empty');
  assert.deepEqual(empty.selected_references,[]);assert.equal(calls,2);
  const selected=await x.toolkit.execute('runtime_work_context',{actor:'fixture',reference_ids:[own]},'selected');
  assert.deepEqual(selected.selected_references.map(value=>value.id),[own]);assert.equal(calls,3);
});

test('verified Pack receipt exposes only a durable bound recipe contract, never source paths or unverified claims',async t=>{
  const x=await fixture(t),spec={title:'Collect IDs',desired_outcome:'Save an ID-only CSV',completion_checks:[{id:'csv',result:'ID-only CSV exists',evidence:'Pack artifact and readback'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Save an ID-only CSV','local_file_write')};
  const started=x.api.store.beginWork(x.config.project.id,randomUUID(),'Save an ID-only CSV','quick'),owner=x.api.store.claimWorkDefinition(x.config.project.id,started.work.id),work=x.api.store.finishWorkDefinition(x.config.project.id,started.work.id,owner,spec,[],'ready');
  const toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,randomUUID(),spec,work.prompt,()=>{},model);t.after(()=>toolkit.close());
  const recipe={version:1,family:'portal.collect',request:'Collect observed IDs',sources:[{id:'rows',parameters:{}}],filters:[{field:'status',op:'eq',value:'In Progress'}],deduplicate_by:['id'],columns:['id'],format:'csv'};
  const result=await toolkit.execute('runtime_pack_run',{recipe},'host-pack-request');assert.equal(result.status,'succeeded');
  const receipt=await toolkit.receipt('runtime_pack_run',result,'host-pack-request');
  assert.equal(receipt.effect_state,'verified');assert.equal(receipt.status,'succeeded');
  assert.equal(receipt.value.host_run_observation.state,'succeeded');
  assert.equal(receipt.value.host_run_observation.family,'portal.collect');
  assert.equal(receipt.value.host_run_observation.request_id,'host-pack-request');
  assert.match(receipt.value.host_run_observation.result_sha256,/^[a-f0-9]{64}$/u);
  assert.equal(receipt.value.host_run_observation.stored_result_sha256,receipt.value.host_run_observation.result_sha256);
  assert.equal(receipt.value.host_run_observation.response_result_sha256,receipt.value.host_run_observation.stored_result_sha256);
  assert.equal(receipt.value.host_run_observation.result_matches_stored,true);
  assert.deepEqual(receipt.value.executed_contract.sources,[{id:'rows',parameter_names:[]}]);
  assert.deepEqual(receipt.value.executed_contract.filters,recipe.filters);
  assert.deepEqual(receipt.value.executed_contract.columns,['id']);assert.deepEqual(receipt.value.executed_contract.deduplicate_by,['id']);
  assert.equal(receipt.value.executed_contract.format,'csv');assert.match(receipt.value.executed_contract.recipe_sha256,/^[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(receipt.value.executed_contract).includes(x.config.packs.sources[0].path),false);
  assert.equal('request' in receipt.value.executed_contract,false);
  const forged=structuredClone(result);forged.result.matched_rows=100;forged.host_run_observation={state:'draft_ready'};
  const unverified=await toolkit.receipt('runtime_pack_run',forged,'host-pack-request');
  assert.equal(unverified.effect_state,'uncertain');assert.equal(unverified.value.executed_contract,null);
  assert.equal(unverified.value.host_run_observation,null,'an untrusted return cannot forge a host state observation');
  const statusValue=await toolkit.execute('runtime_pack_status',{run_id:result.run_id},'host-status-request');
  const statusReceipt=await toolkit.receipt('runtime_pack_status',statusValue,'host-status-request');
  assert.equal(statusReceipt.status,'succeeded');assert.equal(statusReceipt.effect_state,'none');
  assert.deepEqual(statusReceipt.value.executed_contract,receipt.value.executed_contract);
  assert.deepEqual(statusReceipt.value.host_run_observation,receipt.value.host_run_observation);
  const changedStatus=structuredClone(statusValue);changedStatus.result.matched_rows=100;
  const changedReceipt=await toolkit.receipt('runtime_pack_status',changedStatus,'host-status-request');
  assert.equal(changedReceipt.value.executed_contract,null,'changed observed status cannot claim a recipe');
  assert.equal(changedReceipt.value.host_run_observation,null);
  const unboundReceipt=await toolkit.receipt('runtime_pack_status',statusValue,'unbound-status-request');
  assert.equal(unboundReceipt.value.executed_contract,null,'a status receipt must be bound to the dispatched same-Work read');
  assert.equal(unboundReceipt.value.host_run_observation,null);
  await assert.rejects(toolkit.execute('runtime_pack_status',{run_id:'foreign-run'},'foreign-status-request'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
  const failedRecipe={...recipe,columns:['missing_field']};
  const failedRun=await toolkit.execute('runtime_pack_run',{recipe:failedRecipe},'host-failed-pack-request');
  assert.equal(failedRun.status,'failed');
  const failedStatus=await toolkit.execute('runtime_pack_status',{run_id:failedRun.run_id},'host-failed-status-request');
  const failedReceipt=await toolkit.receipt('runtime_pack_status',failedStatus,'host-failed-status-request');
  assert.equal(failedReceipt.value.executed_contract,null,'a failed run cannot advertise an executed contract');
  assert.equal(failedReceipt.value.host_run_observation,null);
});

test('runtime contract research status reads complete saved source rows without another source request',async t=>{
  const x=await fixture(t),spec={title:'Research IDs',desired_outcome:'Find one ID',completion_checks:[{id:'one',result:'Observed ID one',evidence:'Source receipt'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Find one ID','read_only')};
  const started=x.api.store.beginWork(x.config.project.id,randomUUID(),'Find one ID','quick'),owner=x.api.store.claimWorkDefinition(x.config.project.id,started.work.id),work=x.api.store.finishWorkDefinition(x.config.project.id,started.work.id,owner,spec,[],'ready');
  const toolkit=new WorkExecutionTools(x.api.store,x.config,x.api,work.id,randomUUID(),spec,work.prompt,()=>{},model);t.after(()=>toolkit.close());
  const recipe={version:1,family:'research.search',request:'Find one observed ID',sources:[{id:'rows',parameters:{}}],filters:[],deduplicate_by:[],query:'one',search_fields:['id'],relevance:null,sort:null,limit:1};
  const result=await toolkit.execute('runtime_pack_run',{recipe},'research-source-request');assert.equal(result.status,'succeeded');
  const status=await toolkit.execute('runtime_pack_status',{run_id:result.run_id},'research-readback-request');
  const receipt=await toolkit.receipt('runtime_pack_status',status,'research-readback-request'),readback=receipt.value.saved_source_readback;
  assert.equal(readback.observed_source_rows,2);assert.deepEqual(readback.sources[0].rows,[{id:'one',status:'In Progress'},{id:'two',status:'Closed'}]);
  assert.equal(readback.user_goal_verified,'not_asserted');assert.equal(JSON.stringify(readback).includes(x.config.packs.sources[0].path),false);
  const run=x.api.store.packRun(x.config.project.id,result.run_id),execution=x.api.store.packExecution(x.config.project.id,run.id),changed=structuredClone(execution);
  changed.checkpoint.sources['0'].result.rows[0].id='forged';
  assert.equal(savedResearchSourceReadback({packExecution:()=>changed},x.config,run),null,'changed cached source rows never gain provenance');
  const unbound=await toolkit.receipt('runtime_pack_status',status,'unbound-source-readback');assert.equal(unbound.value.saved_source_readback,null);
  const forged=structuredClone(status);forged.result.collected_rows=100;forged.saved_source_readback=readback;
  const rejected=await toolkit.receipt('runtime_pack_status',forged,'research-readback-request');assert.equal(rejected.value.saved_source_readback,null);
});
