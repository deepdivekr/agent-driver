import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PackStore} from '../dist/packs/store.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {nativeProcessRunner} from '../dist/integrations/subscription-auth.js';

const session='11111111-1111-4111-8111-111111111111';
const checkpoint={head:'a'.repeat(40),state_sha256:'b'.repeat(64),changed_paths:[]};
const route={kind:'pack',pack_family:'coding.orchestrate'};

async function storeFixture(t){
  const directory=await mkdtemp(join(tmpdir(),'driver-dialog-recovery-store-'));
  const store=new PackStore(join(directory,'state.db'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const at=new Date().toISOString();
  store.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run('work-one','project-one','Coding','Implement feature',at,at);
  store.connection.prepare("INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,'ready',0,?,?,'[]','{}',?,?)").run('work-one','project-one','intake-one','hash-one','quick','Implement feature',JSON.stringify({route}),at,at);
  return {store,at};
}

test('before-CLI preflight failure is retryable with a new instruction, while no old request is replayed',async t=>{
  const {store}=await storeFixture(t);
  const first=store.beginCodingDialog('project-one','intake-one','work-one','demo','/repo','config','default',checkpoint,session,'Implement feature');
  const queued=store.queueCodingDialogTurn('project-one',first.dialog.id,first.dialog.revision,'request-one','Implement the requested feature');
  const claim=store.claimCodingDialogTurn('project-one',first.dialog.id,queued.dialog.revision);
  const failed=store.markCodingDialogPreflightFailed('project-one',first.dialog.id,claim.turn.id,claim.owner,'CODING_SESSION_BUSY_OR_UNKNOWN');
  assert.equal(failed.status,'waiting_user');assert.equal(failed.active_turn_id,null);
  assert.equal(store.codingDialogTurnById('project-one',first.dialog.id,claim.turn.id).status,'failed_preflight');
  assert.equal(store.queueCodingDialogTurn('project-one',first.dialog.id,first.dialog.revision,'request-one','Implement the requested feature').created,false);
  const retry=store.queueCodingDialogTurn('project-one',first.dialog.id,failed.revision,'request-two','Implement the requested feature');
  assert.equal(retry.created,true);assert.equal(store.codingDialogTurnCount('project-one',first.dialog.id),2);
});

test('imported Work requires a local, revision-and-instruction-bound approval for every dialog turn',async t=>{
  const {store,at}=await storeFixture(t);
  store.connection.prepare('INSERT INTO office_import VALUES (?,?,?,?,?,?,?,?,?)').run('import-one','project-one','project','accepted',JSON.stringify({scan:{root:'/repo'}}),'source-sha','work-one',at,at);
  store.approveImportedCodingPlan('project-one','work-one','demo');
  const started=store.beginCodingDialog('project-one','intake-one','work-one','demo','/repo','config','default',checkpoint,session,'Implement feature');
  const args=['project-one',started.dialog.id,started.dialog.revision,'turn-one','Implement the requested feature'];
  assert.throws(()=>store.queueCodingDialogTurn(...args),/WORK_IMPORT_CODING_DIALOG_TURN_APPROVAL_REQUIRED/u);
  store.approveImportedCodingDialogTurn('project-one',started.dialog.id,started.dialog.revision,'Review an unrelated file');
  assert.throws(()=>store.queueCodingDialogTurn(...args),/WORK_IMPORT_CODING_DIALOG_TURN_APPROVAL_REQUIRED/u);
  store.approveImportedCodingDialogTurn('project-one',started.dialog.id,started.dialog.revision,args[4]);
  const queued=store.queueCodingDialogTurn(...args);
  assert.equal(queued.dialog.status,'queued');
  assert.equal(store.connection.prepare('SELECT * FROM office_import_coding_dialog_turn_approval WHERE work_id=?').get('work-one'),undefined);
});

test('one live Codex session cannot be attached to different projects in the same store',async t=>{
  const {store,at}=await storeFixture(t);
  const first=store.beginCodingDialog('project-one','intake-one','work-one','demo','/repo','config','default',checkpoint,session,'Implement feature');
  store.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run('work-two','project-two','Other','Check feature',at,at);
  store.connection.prepare("INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,'ready',0,?,?,'[]','{}',?,?)").run('work-two','project-two','intake-two','hash-two','quick','Check feature',JSON.stringify({route}),at,at);
  assert.throws(()=>store.beginCodingDialog('project-two','intake-two','work-two','other','/other','config','default',checkpoint,session,'Check feature'),/CODING_DIALOG_SESSION_ALREADY_ATTACHED/u);
  store.stopCodingDialog('project-one',first.dialog.id,first.dialog.revision);
  assert.equal(store.beginCodingDialog('project-two','intake-two','work-two','other','/other','config','default',checkpoint,session,'Check feature').dialog.session_id,session);
});

async function runtimeFixture(t,{busyOnThird=false,unexpectedCommit=false,failAfterLaunch=false}={}){
  const home=await mkdtemp(join(tmpdir(),'driver-dialog-recovery-runtime-')),repo=join(home,'repo');await mkdir(repo);
  await writeFile(join(repo,'README.md'),'Fixture\n');
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('add','.');git('commit','-qm','initial');
  const path=join(home,'host.json');
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'dialog-recovery',caller_ref:'agent',account_ref:'owner',worktree:home,data_dir:join(home,'data'),environment:'production',coding:{projects:[{id:'demo',root:repo,allow_write:true,allow_commit:false,verify:[]}],model_data_approved:true}}));
  const config=loadHostConfig(path),calls=[],model={calls:[],async call(purpose){this.calls.push(purpose);return purpose==='correct'?{assessment:'Review the output',recommendation:'Inspect Git',suggested_next_instruction:null}:{title:'Coding',desired_outcome:'Implement requested change',completion_checks:[{id:'check',result:'Inspect diff',evidence:'Git diff'}],assumptions:[],route,requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]};}};
  let inspectCount=0;
  const catalog={async list(){return [{id:session,status:'idle',title:'Exact session',preview:null}];},async inspect(){inspectCount++;return {id:session,status:busyOnThird&&inspectCount===3?'active':'idle',title:'Exact session',preview:null};}};
  const runner={async run(request){
    if(request.executable==='/usr/bin/git')return nativeProcessRunner.run(request);
    calls.push(request);
    if(failAfterLaunch){await writeFile(join(repo,'README.md'),'Partial change\n');return {code:1,stdout:'',stderr:'usage limit reached'};}
    if(unexpectedCommit){await writeFile(join(repo,'README.md'),'Unexpected commit\n');git('add','.');git('commit','-qm','unexpected');}
    const events=[{type:'thread.started',thread_id:session},{type:'item.completed',item:{type:'agent_message',text:'Codex completed. Cookie: session-secret\nNo tests run.'}},{type:'turn.completed'}];
    const stdout=events.map(event=>JSON.stringify(event)).join('\n')+'\n';request.onStdout?.(stdout);return {code:0,stdout,stderr:''};
  }};
  const api=new RuntimeApi(config,{swarmModel:model,coding:{runner,executables:{codex:'/fake/codex'},sessionCatalog:catalog}});
  t.after(async()=>{api.close();await api.drain();await rm(home,{recursive:true,force:true});});
  const work=await api.call('runtime_work_start',{request_id:'work-one',prompt:'demo 프로젝트의 기능을 구현하고 결과를 알려줘'});
  const attached=await api.call('runtime_coding_dialog_attach',{request_id:'dialog-one',work_id:work.work_id,project_ref:'demo',session_id:session});
  return {api,attached,calls,model,git,repo};
}

test('catalog turns busy after queue: no CLI launch, no uncertain effect, next user turn remains possible',async t=>{
  const x=await runtimeFixture(t,{busyOnThird:true});
  await x.api.call('runtime_coding_dialog_turn',{dialog_id:x.attached.dialog_id,expected_revision:x.attached.revision,request_id:'turn-one',instruction:'Implement the requested feature'});
  await x.api.codingDialog.drain();
  const state=await x.api.call('runtime_coding_dialog_status',{dialog_id:x.attached.dialog_id});
  assert.equal(x.calls.length,0);assert.equal(state.status,'waiting_user');assert.equal(state.turns[0].status,'failed_preflight');
  assert.equal(state.turns[0].reason,'CODING_SESSION_BUSY_OR_UNKNOWN');
  assert.equal(state.auto_continue,false);
});

test('an unexpected commit retains sanitized Codex answer but blocks continuation until exact reviewed Git acceptance',async t=>{
  const x=await runtimeFixture(t,{unexpectedCommit:true});
  await x.api.call('runtime_coding_dialog_turn',{dialog_id:x.attached.dialog_id,expected_revision:x.attached.revision,request_id:'turn-one',instruction:'Implement the requested feature'});
  await x.api.codingDialog.drain();
  const state=await x.api.call('runtime_coding_dialog_status',{dialog_id:x.attached.dialog_id});
  assert.equal(state.status,'reconciliation_required');assert.equal(state.turns[0].status,'completed');
  assert.equal(state.turns[0].reason,'CODING_DIALOG_UNEXPECTED_COMMIT');
  assert.match(state.turns[0].reply,/Codex completed/u);assert.doesNotMatch(state.turns[0].reply,/session-secret/u);
  assert.equal(state.turns[0].reply_redacted,true);assert.equal(x.model.calls.filter(call=>call==='correct').length,0);
  const inspection=await x.api.call('runtime_coding_dialog_reconcile',{dialog_id:x.attached.dialog_id});
  assert.notEqual(inspection.stored_git.head,inspection.observed_git.head);
  const accept={dialog_id:x.attached.dialog_id,action:'accept_current_git',expected_revision:inspection.revision,observed_git_head:inspection.observed_git.head,observed_git_state_sha256:inspection.observed_git.state_sha256,confirm_git_reviewed:true,confirm_session_reviewed:true};
  await assert.rejects(x.api.call('runtime_coding_dialog_reconcile',accept));
  await assert.rejects(x.api.codingDialog.reconcile({...accept,confirm_session_reviewed:undefined}),/CODING_DIALOG_MANUAL_REVIEW_REQUIRED/u);
  await assert.rejects(x.api.codingDialog.reconcile({...accept,observed_git_head:'0'.repeat(40)}),/CODING_DIALOG_OBSERVED_GIT_CHANGED/u);
  const recovered=await x.api.codingDialog.reconcile(accept);
  assert.equal(recovered.status,'waiting_user');assert.equal(recovered.auto_replay,false);assert.equal(x.calls.length,1);
  assert.equal(recovered.turns[0].reply_redacted,true);
});

test('failed launch with partial Git write cannot auto-replay; reviewed acceptance resumes from observed checkpoint only',async t=>{
  const x=await runtimeFixture(t,{failAfterLaunch:true});
  await x.api.call('runtime_coding_dialog_turn',{dialog_id:x.attached.dialog_id,expected_revision:x.attached.revision,request_id:'turn-one',instruction:'Implement the requested feature'});
  await x.api.codingDialog.drain();
  const inspection=await x.api.call('runtime_coding_dialog_reconcile',{dialog_id:x.attached.dialog_id});
  assert.equal(inspection.status,'reconciliation_required');assert.equal(inspection.manual_review_required,true);
  const accepted=await x.api.codingDialog.reconcile({dialog_id:x.attached.dialog_id,action:'accept_current_git',expected_revision:inspection.revision,observed_git_head:inspection.observed_git.head,observed_git_state_sha256:inspection.observed_git.state_sha256,confirm_git_reviewed:true,confirm_session_reviewed:true});
  assert.equal(accepted.status,'waiting_user');assert.equal(accepted.turns[0].status,'uncertain');assert.equal(x.calls.length,1);
});
