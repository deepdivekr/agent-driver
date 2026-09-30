import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {supervisorCompletionClaim} from '../dist/work/supervisor.js';
import {createWorkCompletionVerifier,createWorkRunTraceEvidence} from '../dist/work/completion.js';

const claim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'An assertion, never independent evidence.',completed_checks:[{id:'source',evidence_ids:['alias-0']}],wait_reason:null};
const observation=index=>({invocation:{request_id:`request-${index}`,turn:index,stage_id:'read',tool_name:'browser_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{title:'Observed source'},evidence_ids:[`canonical-${index}`,`alias-${index}`],effect_state:'none',retry_safe:true},observed_at:'2026-09-29T00:00:00.000Z'});

test('runtime contract: supervisor normalizes 32 claimed aliases to the same 32 real canonical receipts plus one host trace',async t=>{
  const observations=Array.from({length:32},(_,index)=>observation(index)),original={...claim,completed_checks:[{id:'source',evidence_ids:observations.map(item=>item.receipt.evidence_ids[1])}]},before=structuredClone({observations,original}),db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  const checkpoint={format:1,work_id:'work-evidence',run_id:'run-evidence',binding:'a'.repeat(64),turn:32,pending:null,observations,summary:''};db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run('evidence-project',checkpoint.work_id,checkpoint.run_id,'host-owner',Date.now()+60000,'running',0,JSON.stringify(checkpoint));
  const trace=createWorkRunTraceEvidence({hermesState:db,intakeWork:()=>({revision:0})},'evidence-project',{work_id:checkpoint.work_id,run_id:checkpoint.run_id,owner:'host-owner',checkpoint,observations,admission_closed:true}),traceId=trace.receipt.evidence_ids[0],normalized=supervisorCompletionClaim(observations,original,traceId),expected=observations.map(item=>item.receipt.evidence_ids[0]);
  assert.deepEqual(normalized.completed_checks[0].evidence_ids,[...expected,traceId]);assert.equal(normalized.completed_checks[0].evidence_ids.length,33);assert.deepEqual({observations,original},before);
  const calls=[],model={calls,async call(purpose,instructions,input){calls.push({purpose,status:'accepted',provider:'contract_fixture',model:'fixture'});assert.deepEqual(input.checks[0].allowed_evidence_ids,[...expected,traceId]);assert.equal(input.observations.length,33);return {checks:[{id:'source',verdict:'supported',evidence_use:'observed_result',evidence_ids:expected,evidence_quotes:expected.map(evidence_id=>({evidence_id,quote:'Observed source'})),reason:'All cited canonical receipts contain the real observed title.'}]};}};
  assert.equal(await createWorkCompletionVerifier(model)([{id:'source',result:'Read the source titles.',evidence:'Actual source title observations.'}],[...observations,trace],normalized),true);assert.equal(calls.length,1);
});

test('runtime contract: canonical normalization preserves contradictory successful evidence and deduplicates aliases without mutating the claim',()=>{
  const first=observation(0),second=observation(1);second.receipt.value={title:'Contradictory later title'};const original={...claim,completed_checks:[{id:'source',evidence_ids:['alias-0','canonical-0','alias-0']},{id:'other',evidence_ids:['alias-1']}]},before=structuredClone(original),normalized=supervisorCompletionClaim([first,second],original,'trace-id');
  assert.deepEqual(normalized.completed_checks[0].evidence_ids,['canonical-0','canonical-1','trace-id']);assert.deepEqual(normalized.completed_checks[1].evidence_ids,['canonical-1','canonical-0','trace-id']);assert.deepEqual(original,before);
});

test('runtime contract: production compound checks retain all source/output and contradictory receipts despite narrow worker citations',()=>{
  const first=observation(0),second=observation(1);second.receipt.value={title:'Contradictory later title'};
  const normalized=supervisorCompletionClaim([first,second],claim,'trace-id',true);
  assert.deepEqual(normalized.completed_checks[0].evidence_ids,['canonical-0','canonical-1','trace-id']);
  assert.equal(second.receipt.value.title,'Contradictory later title');
});

test('runtime contract: an empty successful receipt is not falsely widened into observable completion evidence',()=>{
  const source=observation(0),empty=observation(1);empty.receipt.value={};empty.invocation.tool_name='runtime_files_roots';
  const normalized=supervisorCompletionClaim([source,empty],claim,'trace-id');
  assert.deepEqual(normalized.completed_checks[0].evidence_ids,['canonical-0','trace-id']);
  const citingEmpty={...claim,completed_checks:[{id:'source',evidence_ids:['alias-1']}]};
  assert.throws(()=>supervisorCompletionClaim([source,empty],citingEmpty,'trace-id'),/WORK_COMPLETION_CLAIM_EVIDENCE_NOT_OBSERVED/u);
});

test('runtime contract: unknown, foreign, failed or uncertain claim IDs are rejected rather than silently discarded and repaired by real evidence',()=>{
  for(const variant of ['unknown','foreign','failed','uncertain','empty']){
    const first=observation(0),second=observation(1);if(variant==='failed')second.receipt.status='failed';if(variant==='uncertain')second.receipt.effect_state='uncertain';if(variant==='empty')second.receipt.evidence_ids=[];
    const invalid=variant==='unknown'?'invented-id':variant==='foreign'?'another-work-receipt':'alias-1',original={...claim,completed_checks:[{id:'source',evidence_ids:['alias-0',invalid]}]};
    assert.throws(()=>supervisorCompletionClaim([first,second],original,'trace-id'),/WORK_COMPLETION_CLAIM_EVIDENCE_NOT_OBSERVED/u,variant);
  }
});

test('runtime contract: ambiguous receipt aliases, host trace collisions and more than 32 observations fail closed',()=>{
  const first=observation(0),second=observation(1);second.receipt.evidence_ids.push('alias-0');assert.throws(()=>supervisorCompletionClaim([first,second],claim,'trace-id'),/WORK_COMPLETION_EVIDENCE_ALIAS_CONFLICT/u);
  assert.throws(()=>supervisorCompletionClaim([first],claim,'alias-0'),/WORK_COMPLETION_EVIDENCE_ID_CONFLICT/u);assert.throws(()=>supervisorCompletionClaim(Array.from({length:33},(_,index)=>observation(index)),claim,'trace-id'),/WORK_COMPLETION_OBSERVATION_LIMIT/u);
});

test('runtime contract: normalization does not relax independent unknown, exact-quote or write-effect checks',async()=>{
  const checks=[{id:'source',result:'Read the requested title.',evidence:'The actual title value.'}],observations=[observation(0)],normalized=supervisorCompletionClaim(observations,claim,'unused-trace');normalized.completed_checks[0].evidence_ids=normalized.completed_checks[0].evidence_ids.filter(id=>id!=='unused-trace');
  for(const variant of ['unknown','quote','write']){
    const actual=structuredClone(observations);if(variant==='write'){actual[0].invocation.effect='external_write';actual[0].receipt.effect_state='none';}
    const calls=[],model={calls,async call(){calls.push({purpose:'correct',status:'accepted'});return {checks:[{id:'source',verdict:variant==='unknown'?'unknown':'supported',evidence_use:'observed_result',evidence_ids:['canonical-0'],evidence_quotes:[{evidence_id:'canonical-0',quote:variant==='quote'?'Fabricated source':'Observed source'}],reason:'The required meaning or grounded evidence remains unavailable.'}]};}};
    assert.equal(await createWorkCompletionVerifier(model)(checks,actual,normalized),false,variant);assert.equal(calls.length,variant==='unknown'?1:variant==='quote'?2:0,variant);
  }
});
