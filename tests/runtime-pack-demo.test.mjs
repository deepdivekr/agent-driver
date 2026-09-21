import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeStore} from '../dist/store/runtime-store.js';
import {ApprovedBrowserProtocol} from '../dist/taskpack/protocol.js';
import {BASE_PACK_CATALOG,basePackFamilyById} from '../dist/taskpacks/base-pack-catalog.js';
import {FORM_DRAFT_SUBMIT_DEMO_CAPABILITY,FORM_DRAFT_SUBMIT_DEMO_INPUT,FORM_DRAFT_SUBMIT_DEMO_PACK,SyntheticFormDraftSubmitBrowserAdapter,normalizeFormDraftSubmit,renderFormDraftSubmitDemo,startSyntheticFormDraftSubmitSite} from '../dist/demo/form-draft-submit-demo.js';

test('runtime contract generic base Pack catalog is user-neutral and keeps write routes approval-bound',()=>{
  assert.deepEqual(BASE_PACK_CATALOG.map(pack=>pack.id),['research.search','portal.collect','form.draft-submit','record.update','inbox.triage','monitor.watch','file.pipeline','choose.stage']);
  assert.equal(basePackFamilyById('form.draft-submit')?.approval,'before_external_effect');
  assert.equal(basePackFamilyById('portal.collect')?.effect,'local_file_write');
  assert.equal(basePackFamilyById('choose.stage')?.approval,'before_external_effect');
  assert.equal(JSON.stringify(BASE_PACK_CATALOG).toLowerCase().includes('sampleportal'),false);
  assert.throws(()=>normalizeFormDraftSubmit({...FORM_DRAFT_SUBMIT_DEMO_INPUT,follow_up_at:FORM_DRAFT_SUBMIT_DEMO_INPUT.effective_at}),/FOLLOW_UP_MUST_FOLLOW_EFFECTIVE_TIME/);
});

test('runtime fixture integration form.draft-submit creates a bounded approval then independently reads back one synthetic effect',{timeout:60000},async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-form-pack-')),site=await startSyntheticFormDraftSubmitSite(),store=new RuntimeStore(join(root,'runtime.sqlite'));
  t.after(async()=>{store.close();await site.close();await rm(root,{recursive:true,force:true});});
  const project={id:'form-pack-project',callerRef:'form-pack-caller',worktree:root,profileRef:join(root,'profile'),accountRef:'synthetic-demo-account',allowedOrigins:[site.baseUrl],capabilities:[FORM_DRAFT_SUBMIT_DEMO_CAPABILITY.id]};store.registerProject(project);
  const protocol=new ApprovedBrowserProtocol(store,FORM_DRAFT_SUBMIT_DEMO_PACK,FORM_DRAFT_SUBMIT_DEMO_CAPABILITY,new SyntheticFormDraftSubmitBrowserAdapter(site.url,project.profileRef,join(root,'captures')));
  const prepared=await protocol.prepare(project.id,project.callerRef,FORM_DRAFT_SUBMIT_DEMO_INPUT);
  assert.ok('approval_token' in prepared);assert.equal(store.task(prepared.task_id).status,'waiting_approval');assert.equal(site.snapshot().effects.length,0);
  store.acceptProposalApproval(prepared.task_id,prepared.approval_token,'fixture-test-channel',{approved_by:'fixture'});
  const result=await protocol.executeApproved(prepared.task_id);
  assert.equal(result.status,'succeeded');assert.deepEqual(site.snapshot().records,[FORM_DRAFT_SUBMIT_DEMO_INPUT]);assert.equal(site.snapshot().effects.length,1);
});

test('runtime fixture integration promotional recording is a real owned-browser prepare only and leaves zero effects',{timeout:60000},async t=>{
  const output=await mkdtemp(join(tmpdir(),'driver-form-demo-output-'));
  t.after(async()=>{await rm(output,{recursive:true,force:true});});
  const result=await renderFormDraftSubmitDemo(output),receipt=JSON.parse(await readFile(join(output,'receipt.json'),'utf8'));
  assert.equal(result.receipt.status,'waiting_approval');assert.equal(result.receipt.effects,0);assert.equal(receipt.automation.external_submit,false);assert.equal(receipt.disclosure.includes('Synthetic loopback fixture'),true);
  assert.equal((await stat(join(output,result.receipt.video))).size>1_024,true);assert.equal((await stat(join(output,result.receipt.capture))).size>1_024,true);
  assert.equal(JSON.stringify(receipt).includes('apv_'),false);
});
