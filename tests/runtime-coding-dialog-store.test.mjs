import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PackStore} from '../dist/packs/store.js';

const project='coding-dialog-fixture',git={head:'a'.repeat(40),state_sha256:'b'.repeat(64),changed_paths:[]};
const session='11111111-1111-4111-8111-111111111111';
const sha256=value=>createHash('sha256').update(value).digest('hex');

async function setup(t,route={kind:'pack',pack_family:'coding.orchestrate'}){
  const directory=await mkdtemp(join(tmpdir(),'coding-dialog-store-'));
  const store=new PackStore(join(directory,'state.db'));
  t.after(async()=>{store.close();await rm(directory,{recursive:true,force:true});});
  const workId='work-1',requestId='request-1',at=new Date().toISOString();
  store.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run(workId,project,'코딩 업무','프로젝트의 기능 구현',at,at);
  store.connection.prepare("INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,'ready',0,? ,?,'[]','{}',?,?)").run(workId,project,requestId,'fixture-hash','quick','프로젝트를 구현해줘',JSON.stringify({route}),at,at);
  return {store,directory,workId,requestId};
}

test('a Codex dialog retains exact session, full redacted reply, separate advice, and user-gated turns',async t=>{
  const {store,workId,requestId}=await setup(t);
  const start=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현');
  assert.equal(start.created,true);assert.equal(start.dialog.status,'waiting_user');
  assert.equal(store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현').created,false);
  assert.deepEqual(store.officeRuns(project,workId).map(item=>item.source_kind),['coding_dialog']);
  assert.equal(store.officeWorkSummaries(project)[0].coding_status,'waiting_user');
  const queued=store.queueCodingDialogTurn(project,start.dialog.id,start.dialog.revision,'turn-1','Codex에게 첫 기능을 구현해 달라고 요청');
  assert.equal(queued.dialog.status,'queued');
  assert.equal(store.queueCodingDialogTurn(project,start.dialog.id,start.dialog.revision,'turn-1','Codex에게 첫 기능을 구현해 달라고 요청').created,false);
  assert.throws(()=>store.queueCodingDialogTurn(project,start.dialog.id,queued.dialog.revision,'turn-2','다른 기능도 구현해줘'),/CODING_DIALOG_NOT_WAITING_USER/u);
  const claimed=store.claimCodingDialogTurn(project,start.dialog.id,queued.dialog.revision);
  assert.equal(claimed.dialog.status,'running');
  assert.equal(store.renewCodingDialogTurn(project,start.dialog.id,claimed.turn.id,claimed.owner),true);
  store.setCodingDialogSession(project,start.dialog.id,claimed.turn.id,claimed.owner,session);
  const reply=`Implemented the requested feature.\nhttps://example.test/path?ticket=public-reference\n${'Detailed result. '.repeat(300)}\n`+'sk-proj-'+'x'.repeat(32);
  const after=store.completeCodingDialogTurn(project,start.dialog.id,claimed.turn.id,claimed.owner,session,'gpt-test',reply,{...git,changed_paths:['src/main.ts']});
  assert.equal(after.status,'advising');assert.equal(after.session_id,session);
  const [first]=store.codingDialogTurns(project,start.dialog.id);
  assert.equal(first.status,'completed');assert.equal(first.reply_sha256,sha256(reply));assert.equal(first.reply_redacted,true);
  assert.equal(store.codingDialogTurnById(project,start.dialog.id,claimed.turn.id)?.id,claimed.turn.id);
  assert.equal(store.codingDialogTurnByRequestId(project,start.dialog.id,'turn-1')?.id,claimed.turn.id);
  assert.equal(store.codingDialogTurnById(project,start.dialog.id,'missing'),null);
  assert.ok(first.reply.length>4_000);assert.match(first.reply,/\[REDACTED\]/u);assert.match(first.reply,/https:\/\/example\.test\/path\?ticket=public-reference/u);assert.ok(!first.reply.includes('sk-proj-'));
  assert.equal(first.advice,null);
  assert.throws(()=>store.queueCodingDialogTurn(project,start.dialog.id,after.revision,'turn-2','계속 구현해줘'),/CODING_DIALOG_NOT_WAITING_USER/u);
  const advised=store.setCodingDialogAdvice(project,start.dialog.id,after.revision,claimed.turn.id,'Codex 작업을 확인했고, 다음에는 검증을 요청하세요.');
  assert.equal(advised.status,'waiting_user');
  assert.match(store.codingDialogTurns(project,start.dialog.id)[0].advice,/다음에는 검증/u);
  const second=store.queueCodingDialogTurn(project,start.dialog.id,advised.revision,'turn-2','이번에는 코드 검증을 진행해줘');
  assert.equal(second.turn.session_id,session);
  const next=store.claimCodingDialogTurn(project,start.dialog.id,second.dialog.revision);
  const completed=store.completeCodingDialogTurn(project,start.dialog.id,next.turn.id,next.owner,session,'gpt-test','Verification completed.',git);
  const noAdvice=store.setCodingDialogAdvice(project,start.dialog.id,completed.revision,next.turn.id,null);
  assert.equal(noAdvice.status,'waiting_user');assert.equal(store.codingDialogTurns(project,start.dialog.id)[1].advice,null);
  assert.equal(store.stopCodingDialog(project,start.dialog.id,noAdvice.revision).status,'stopped');
});

test('dialog fencing rejects duplicate effects and expired ownership requires reconciliation',async t=>{
  const {store,workId,requestId}=await setup(t),start=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,session,'기존 대화 이어받기');
  assert.throws(()=>store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','other-model',git,session,'기존 대화 이어받기'),/CODING_DIALOG_REQUEST_ID_CONFLICT/u);
  const queued=store.queueCodingDialogTurn(project,start.dialog.id,start.dialog.revision,'turn-1','기존 세션을 이어서 작업해줘');
  assert.throws(()=>store.queueCodingDialogTurn(project,start.dialog.id,queued.dialog.revision,'turn-1','다른 내용을 실행해줘'),/CODING_DIALOG_TURN_REQUEST_ID_CONFLICT/u);
  assert.throws(()=>store.claimCodingDialogTurn(project,start.dialog.id,start.dialog.revision),/CODING_DIALOG_REVISION_CONFLICT/u);
  const claimed=store.claimCodingDialogTurn(project,start.dialog.id,queued.dialog.revision);
  assert.throws(()=>store.stopCodingDialog(project,start.dialog.id,claimed.dialog.revision),/CODING_DIALOG_NOT_STOPPABLE/u);
  assert.throws(()=>store.completeCodingDialogTurn(project,start.dialog.id,claimed.turn.id,'not-owner',session,'gpt-test','No effect.',git),/CODING_DIALOG_OWNER_LOST/u);
  assert.throws(()=>store.setCodingDialogSession(project,start.dialog.id,claimed.turn.id,claimed.owner,'22222222-2222-4222-8222-222222222222'),/CODING_DIALOG_SESSION_MISMATCH/u);
  store.connection.prepare('UPDATE coding_dialog_turn SET lease_until_ms=0 WHERE id=?').run(claimed.turn.id);
  assert.equal(store.renewCodingDialogTurn(project,start.dialog.id,claimed.turn.id,claimed.owner),false);
  const uncertain=store.markExpiredCodingDialogTurn(project,start.dialog.id);
  assert.equal(uncertain.status,'reconciliation_required');assert.equal(store.codingDialogTurns(project,start.dialog.id)[0].status,'uncertain');
  assert.throws(()=>store.claimCodingDialogTurn(project,start.dialog.id,uncertain.revision),/CODING_DIALOG_NOT_QUEUED/u);
  assert.equal(store.markExpiredCodingDialogTurn(project,start.dialog.id).revision,uncertain.revision);
});

test('unverified route and oversized Codex reply fail closed without truncating saved output',async t=>{
  const bad=await setup(t,{kind:'pack',pack_family:'search'});
  assert.throws(()=>bad.store.beginCodingDialog(project,bad.requestId,bad.workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현'),/WORK_PACK_FAMILY_MISMATCH/u);
  const {store,workId,requestId}=await setup(t),start=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현');
  const queued=store.queueCodingDialogTurn(project,start.dialog.id,start.dialog.revision,'turn-1','큰 결과를 반환하는 작업 수행');
  const claimed=store.claimCodingDialogTurn(project,start.dialog.id,queued.dialog.revision);
  assert.throws(()=>store.completeCodingDialogTurn(project,start.dialog.id,claimed.turn.id,claimed.owner,session,'gpt-test','x'.repeat(1024*1024+1),git),/CODING_DIALOG_REPLY_TOO_LARGE/u);
  assert.equal(store.codingDialogTurns(project,start.dialog.id)[0].reply,null);
  const uncertain=store.markCodingDialogUncertain(project,start.dialog.id,claimed.turn.id,claimed.owner,'Output exceeded the storage contract');
  assert.equal(uncertain.status,'reconciliation_required');
  assert.equal(store.codingDialogTurns(project,start.dialog.id)[0].reply,null);
  assert.throws(()=>store.queueCodingDialogTurn(project,start.dialog.id,uncertain.revision,'turn-2','계속 진행해줘'),/CODING_DIALOG_NOT_WAITING_USER/u);
});

test('completed reply survives another process opening the database; queued failure cannot replay automatically',async t=>{
  const {store,directory,workId,requestId}=await setup(t);
  const first=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현');
  const pending=store.queueCodingDialogTurn(project,first.dialog.id,first.dialog.revision,'turn-1','기능을 구현하고 결과를 알려줘');
  const claimed=store.claimCodingDialogTurn(project,first.dialog.id,pending.dialog.revision);
  const result=store.completeCodingDialogTurn(project,first.dialog.id,claimed.turn.id,claimed.owner,session,'gpt-test','Full Codex reply\nwith two lines.',git);
  const reader=new PackStore(join(directory,'state.db'));
  try{
    assert.equal(reader.codingDialog(project,first.dialog.id).status,'advising');
    assert.equal(reader.codingDialogTurns(project,first.dialog.id)[0].reply,'Full Codex reply\nwith two lines.');
    const waiting=reader.setCodingDialogAdvice(project,first.dialog.id,result.revision,claimed.turn.id,null);
    const queued=reader.queueCodingDialogTurn(project,first.dialog.id,waiting.revision,'turn-2','다음 작업을 계속 진행해줘');
    const uncertain=reader.markCodingDialogUncertain(project,first.dialog.id,queued.turn.id,null,'Could not dispatch');
    assert.equal(uncertain.status,'reconciliation_required');
    assert.equal(reader.codingDialogTurns(project,first.dialog.id)[1].status,'uncertain');
    assert.throws(()=>reader.claimCodingDialogTurn(project,first.dialog.id,uncertain.revision),/CODING_DIALOG_NOT_QUEUED/u);
  }finally{reader.close();}
});

test('imported coding Work requires explicit approval and consumes it atomically on dialog attach',async t=>{
  const {store,workId,requestId}=await setup(t),at=new Date().toISOString();
  store.connection.prepare('INSERT INTO office_import VALUES (?,?,?,?,?,?,?,?,?)').run('import-1',project,'project','accepted',JSON.stringify({scan:{root:'/fixture/repo'}}),'source-sha',workId,at,at);
  assert.throws(()=>store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현'),/WORK_IMPORT_CODING_PLAN_APPROVAL_REQUIRED/u);
  assert.equal(store.officeRuns(project,workId).length,0);
  store.approveImportedCodingPlan(project,workId,'demo');
  assert.throws(()=>store.beginCodingDialog(project,requestId,workId,'demo','/wrong/repo','fingerprint','gpt-test',git,null,'프로젝트 구현'),/WORK_IMPORT_CODING_PROJECT_NOT_WRITABLE/u);
  assert.ok(store.connection.prepare('SELECT plan_approved_at FROM office_import_coding_approval WHERE work_id=?').get(workId).plan_approved_at);
  const created=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,null,'프로젝트 구현');
  assert.equal(created.created,true);
  assert.equal(store.connection.prepare('SELECT plan_approved_at FROM office_import_coding_approval WHERE work_id=?').get(workId).plan_approved_at,null);
});

test('one live Work owns an exact Codex session until stopped',async t=>{
  const {store,workId,requestId}=await setup(t),at=new Date().toISOString();
  const first=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,session,'첫 번째 업무');
  store.connection.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run('work-2',project,'다른 업무','다른 기능 구현',at,at);
  store.connection.prepare("INSERT INTO office_intake(work_id,project_id,request_id,prompt_hash,mode,status,revision,prompt,spec,questions,answers,created_at,updated_at) VALUES (?,?,?,?,?,'ready',0,? ,?,'[]','{}',?,?)").run('work-2',project,'request-2','fixture-hash-2','quick','다른 기능을 구현해줘',JSON.stringify({route:{kind:'pack',pack_family:'coding.orchestrate'}}),at,at);
  assert.throws(()=>store.beginCodingDialog(project,'request-2','work-2','demo','/fixture/repo','fingerprint','gpt-test',git,session,'두 번째 업무'),/CODING_DIALOG_SESSION_ALREADY_ATTACHED/u);
  const stopped=store.stopCodingDialog(project,first.dialog.id,first.dialog.revision);
  assert.equal(stopped.status,'stopped');
  const second=store.beginCodingDialog(project,'request-2','work-2','demo','/fixture/repo','fingerprint','gpt-test',git,session,'두 번째 업무');
  assert.equal(second.dialog.session_id,session);
});

test('stale supervisor advice expires to waiting_user without losing the Codex reply',async t=>{
  const {store,workId,requestId}=await setup(t);
  const first=store.beginCodingDialog(project,requestId,workId,'demo','/fixture/repo','fingerprint','gpt-test',git,session,'프로젝트 구현');
  const queued=store.queueCodingDialogTurn(project,first.dialog.id,first.dialog.revision,'turn-1','작업하고 결과를 알려줘');
  const claimed=store.claimCodingDialogTurn(project,first.dialog.id,queued.dialog.revision);
  const completed=store.completeCodingDialogTurn(project,first.dialog.id,claimed.turn.id,claimed.owner,session,'gpt-test','Codex result survives an advice crash.',git);
  const at=Date.parse(store.codingDialogTurnById(project,first.dialog.id,claimed.turn.id).completed_at);
  assert.equal(store.markExpiredCodingDialogAdvice(project,first.dialog.id,at+119_999).status,'advising');
  const recovered=store.markExpiredCodingDialogAdvice(project,first.dialog.id,at+120_000);
  assert.equal(recovered.status,'waiting_user');
  assert.equal(store.codingDialogTurnById(project,first.dialog.id,claimed.turn.id).reply,'Codex result survives an advice crash.');
  assert.equal(store.codingDialogTurnById(project,first.dialog.id,claimed.turn.id).advice,null);
  assert.equal(store.markExpiredCodingDialogAdvice(project,first.dialog.id,at+240_000).revision,recovered.revision);
  assert.throws(()=>store.setCodingDialogAdvice(project,first.dialog.id,completed.revision,claimed.turn.id,'Late advice'),/CODING_DIALOG_REVISION_CONFLICT/u);
  assert.ok(store.officeEvents(project,first.dialog.id).some(event=>event.kind==='coding_dialog.advice_unavailable'));
});
