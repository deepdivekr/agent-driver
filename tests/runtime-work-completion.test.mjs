import test from 'node:test';
import assert from 'node:assert/strict';
import {WORK_DEFINITION_INSTRUCTIONS} from '../dist/work/runtime.js';
import {DatabaseSync} from 'node:sqlite';
import {createWorkCompletionVerifier,createWorkRunTraceEvidence,captureWorkRunAdmissionCheckpoint,WORK_COMPLETION_VERIFICATION_INSTRUCTIONS} from '../dist/work/completion.js';
import {BoundedWorkClientExecutor} from '../dist/work/client-executor.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';

const checks=[{id:'read',result:'Report the latest physical AI article title.',evidence:'A current retrieved source containing its title.'}];
const claim={action:'complete',stage_id:'report',tool_name:null,arguments_json:null,summary:'Claimed title: Physical AI.',completed_checks:[{id:'read',evidence_ids:['source-1']}],wait_reason:null};
const observe=(value={title:'Physical AI',text:'Physical AI connects intelligent robots to the real world.'},options={})=>({
  invocation:{request_id:'request-1',turn:0,stage_id:'collect',tool_name:'browser_read',arguments:{url:'https://example.test/news',title:'requested-not-observed'},effect:'read_only',dispatched:true,...options.invocation},
  receipt:{status:'succeeded',value,evidence_ids:['source-1'],effect_state:'none',retry_safe:true,...options.receipt},observed_at:'2026-09-29T00:00:00.000Z',
});
const supported=(quote='Physical AI',id='read',evidence_id='source-1')=>({checks:[{id,verdict:'supported',evidence_ids:[evidence_id],evidence_quotes:[{evidence_id,quote}],reason:'The retrieved source contains the requested title.'}]});
const unsupported=reason=>({checks:[{id:'read',verdict:'unsupported',evidence_ids:[],evidence_quotes:[],reason}]});
function fixtureModel(queue){return {calls:[],inputs:[],async call(purpose,instructions,input,schema){this.inputs.push({purpose,instructions,input:structuredClone(input),schema});const response=queue.shift();if(response instanceof Error)throw response;this.calls.push({purpose,provider:'contract_fixture',model:'fixture-verifier',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return response;}};}
function fixture(queue){const model=fixtureModel(queue),events=[],verify=createWorkCompletionVerifier(model,{progress:event=>events.push(event)});return {model,events,verify};}

test('completion contract: live-looking browser data requires a separate typed judgment and exact observed excerpts',async()=>{
  const {verify,model,events}=fixture([supported()]);assert.equal(await verify(checks,[observe()],claim),true);
  assert.equal(model.inputs.length,1);assert.equal(model.inputs[0].instructions,WORK_COMPLETION_VERIFICATION_INSTRUCTIONS);assert.equal(model.inputs[0].purpose,'verify');
  assert.deepEqual(model.inputs[0].input.checks[0].allowed_evidence_ids,['source-1']);assert.equal(model.inputs[0].input.observations[0].value.title,'Physical AI');
  assert.ok(!JSON.stringify(model.inputs[0].input).includes(claim.summary));assert.ok(!JSON.stringify(model.inputs[0].input).includes('requested-not-observed'));assert.equal(events.at(-1).model,'fixture-verifier');
});

test('completion contract: real file observable path and content can support the exact requested artifact',async()=>{
  const fileChecks=[{id:'file',result:'Create a UTF-8 summary file named report.md.',evidence:'The saved file path and read-back text.'}],fileClaim={...claim,completed_checks:[{id:'file',evidence_ids:['file-1']}]};
  const item=observe({path:'/workspace/report.md',encoding:'utf8',content:'# Physical AI\nObserved research summary.',sha256:'b'.repeat(64)},{invocation:{tool_name:'file_readback',effect:'local_write'},receipt:{evidence_ids:['file-1'],effect_state:'verified',retry_safe:false}});
  const {verify}=fixture([supported('/workspace/report.md','file','file-1')]);assert.equal(await verify(fileChecks,[item],fileClaim),true);
});

test('completion contract: a false claimant summary and an irrelevant observed tool result do not satisfy the work',async()=>{
  const falseClaim={...claim,summary:'Physical AI article collected; all requested research is complete.'},item=observe({title:'Shopping cart',text:'Your cart is empty.'});
  const reason='The observed shopping page has no physical AI article.',model=fixtureModel([unsupported(reason)]),events=[],audits=[],verify=createWorkCompletionVerifier(model,{progress:event=>events.push(event),audit:event=>audits.push(event)});assert.equal(await verify(checks,[item],falseClaim),false);
  assert.ok(!JSON.stringify(model.inputs[0].input).includes(falseClaim.summary));assert.match(events.at(-1).summary,/unsupported.*reason_sha256: [a-f0-9]{64}/u);assert.equal(model.inputs.length,1);
  assert.equal(audits[0].code,'WORK_COMPLETION_CHECK_NOT_SUPPORTED');assert.equal(audits[0].checks[0].verdict,'unsupported');assert.match(audits[0].checks[0].reason_sha256,/^[a-f0-9]{64}$/u);
  assert.ok(events.at(-1).summary.includes(reason));assert.ok(!JSON.stringify(audits).includes(reason));assert.ok(!JSON.stringify({events,audits}).includes(item.receipt.value.text));
});

test('completion contract: empty, failed, metadata-only and invented evidence are rejected before model dispatch',async()=>{
  for(const item of [observe(null),observe('  '),observe({}),observe([]),observe({status:'succeeded',ok:true}),observe({title:'Physical AI'},{receipt:{status:'failed'}}),observe({title:'Physical AI'},{receipt:{evidence_ids:['other']}})]){
    const {verify,model,events}=fixture([supported()]);assert.equal(await verify(checks,[item],claim),false);assert.equal(model.inputs.length,0);assert.match(events.at(-1).summary,/WORK_COMPLETION_EVIDENCE_MISSING/u);
  }
});

test('completion contract: uncertain and unverified write effects cannot become success',async()=>{
  for(const item of [observe({title:'Physical AI'},{receipt:{status:'reconciliation_required',effect_state:'uncertain'}}),observe({title:'Physical AI'},{invocation:{effect:'external_write'}})]){
    const {verify,model,events}=fixture([supported()]);assert.equal(await verify(checks,[item],claim),false);assert.equal(model.inputs.length,0);assert.match(events.at(-1).summary,/WORK_COMPLETION_(?:EFFECT_UNCERTAIN|WRITE_UNVERIFIED)/u);
  }
});

test('completion contract: only requested check IDs and their claimed real evidence can be used',async()=>{
  for(const answer of [supported('Physical AI','other'),supported('Physical AI','read','invented'),{checks:[...supported().checks,...supported().checks]},supported('A fabricated article')]){
    const {verify,events}=fixture([answer,answer]);assert.equal(await verify(checks,[observe()],claim),false);assert.match(events.at(-1).summary,/WORK_COMPLETION_VERIFIER_(?:CHECKS_MISMATCH|EVIDENCE_INVALID|QUOTE_UNOBSERVED)/u);
  }
  const {verify,model}=fixture([supported()]);assert.equal(await verify(checks,[observe()],{...claim,completed_checks:[{id:'other',evidence_ids:['source-1']}]}),false);assert.equal(model.inputs.length,0);
});

test('completion contract: supported requires quotes from every cited receipt, not an accepted model answer alone',async()=>{
  const noQuotes=supported();noQuotes.checks[0].evidence_quotes=[];
  const unrelatedId=supported();unrelatedId.checks[0].evidence_quotes[0].evidence_id='another';
  const keyQuote=supported('title');
  for(const answer of [noQuotes,unrelatedId,keyQuote]){const {verify,events}=fixture([answer,answer]);assert.equal(await verify(checks,[observe()],claim),false);assert.match(events.at(-1).summary,/WORK_COMPLETION_VERIFIER_QUOTE_(?:MISSING|UNOBSERVED)/u);}
});

test('completion contract: model unknown and malformed outputs never produce verified completion',async()=>{
  const uncertain=unsupported('The source date is not observed.');uncertain.checks[0].verdict='unknown';
  for(const answer of [uncertain,{complete:true}]){const {verify,events}=fixture([answer,answer]);assert.equal(await verify(checks,[observe()],claim),false);assert.match(events.at(-1).summary,/unknown|OUTPUT_INVALID/u);}
});

test('completion contract: each requested result is verified independently with its allowed evidence',async()=>{
  const twoChecks=[...checks,{id:'date',result:'Report publication date.',evidence:'A publication date observed in the source.'}],twoClaim={...claim,completed_checks:[...claim.completed_checks,{id:'date',evidence_ids:['source-2']}]};
  const answer={checks:[...supported().checks,{id:'date',verdict:'supported',evidence_ids:['source-2'],evidence_quotes:[{evidence_id:'source-2',quote:'2026-09-29'}],reason:'The source exposes publication_date.'}]};
  const items=[observe(),observe({publication_date:'2026-09-29'},{receipt:{evidence_ids:['source-2']}})];
  const {verify}=fixture([answer]);assert.equal(await verify(twoChecks,items,twoClaim),true);
  const mismatch=structuredClone(answer);mismatch.checks[1].evidence_ids=['source-1'];mismatch.checks[1].evidence_quotes=[{evidence_id:'source-1',quote:'Physical AI'}];assert.equal(await fixture([mismatch,mismatch]).verify(twoChecks,items,twoClaim),false);
});

test('completion contract: conflicting receipt IDs are rejected rather than silently selecting favorable values',async()=>{
  const {verify,model,events}=fixture([supported()]);assert.equal(await verify(checks,[observe(),observe({title:'Wrong source'})],claim),false);assert.equal(model.inputs.length,0);assert.match(events.at(-1).summary,/EVIDENCE_ID_CONFLICT/u);
});

test('completion contract: exact strings containing JSON escapes and observed zero remain usable evidence',async()=>{
  const value='A "quoted" title\nSecond line',{verify}=fixture([supported(value)]);assert.equal(await verify(checks,[observe({title:value})],claim),true);
  const countChecks=[{id:'read',result:'Report how many entries were found.',evidence:'An observed count, including zero.'}];assert.equal(await fixture([supported('0')]).verify(countChecks,[observe({count:0})],claim),true);
});

test('completion contract: unchanged verified receipts are cached; changed values require new independent verification',async()=>{
  const {verify,model,events}=fixture([supported(),unsupported('The source changed to an unrelated article.')]);
  assert.equal(await verify(checks,[observe()],claim),true);assert.equal(await verify(checks,[observe()],{...claim,summary:'Changed assertion, not evidence.'}),true);assert.equal(model.inputs.length,1);assert.match(events.at(-1).summary,/cached/u);
  assert.equal(await verify(checks,[observe({title:'Unrelated page'})],claim),false);assert.equal(model.inputs.length,2);
});

test('completion contract: provider failure preserves receipts and reports its real reason without caching failure',async()=>{
  const observations=[observe()],before=structuredClone(observations),{verify,model,events}=fixture([Error('STRUCTURED_MODEL_UNAVAILABLE'),supported()]);
  assert.equal(await verify(checks,observations,claim),false);assert.deepEqual(observations,before);assert.match(events.at(-1).summary,/STRUCTURED_MODEL_UNAVAILABLE/u);
  assert.equal(await verify(checks,observations,claim),true);assert.equal(model.inputs.length,2);
});

test('completion contract: concurrent identical verification shares a bounded invocation and model failures are safe',async()=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const model=fixtureModel([]);model.call=async function(purpose,instructions,input,schema){this.inputs.push({purpose,instructions,input,schema});entered();await gate;return supported();};
  const verify=createWorkCompletionVerifier(model),first=verify(checks,[observe()],claim);await started;const second=verify(checks,[observe()],claim);release();assert.deepEqual(await Promise.all([first,second]),[true,true]);assert.equal(model.inputs.length,1);
});

test('completion contract: input and evidence budget failures have accurate reasons and cannot invoke a provider',async()=>{
  const {verify,model,events}=fixture([supported()]);assert.equal(await verify([{...checks[0],result:''}],[observe()],claim),false);assert.match(events.at(-1).summary,/WORK_COMPLETION_CHECKS_INVALID/u);
  assert.equal(await verify(checks,[observe({text:'x'.repeat(17000)})],claim),false);assert.match(events.at(-1).summary,/WORK_COMPLETION_VALUE_INVALID/u);assert.equal(model.inputs.length,0);
});

test('completion contract: callback can be injected into the bounded Work client without asserting fixture as native success',async()=>{
  const chooser=fixtureModel([{action:'tool',stage_id:'collect',tool_name:'browser_read',arguments_json:'{}',summary:'Read source.',completed_checks:[],wait_reason:null},claim]);
  const {verify}=fixture([supported()]),saved=[],value=observe().receipt;
  const result=await new BoundedWorkClientExecutor(chooser).execute({work_id:'work-1',run_id:'run-1',prompt:'Read physical AI news.',completion_checks:checks},{tools:[{name:'browser_read',description:'A fixture source reader.',input_schema:{type:'object',properties:{},additionalProperties:false},effect:'read_only'}],executeTool:async()=>value,checkpoint:cp=>saved.push(cp),verifyCompletion:verify});
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(result.checkpoint.observations.length,1);assert.equal(saved.at(-1).observations[0].receipt.value.title,'Physical AI');
});

test('completion contract: one ungrounded quote is corrected against identical receipts and records content-free audit diagnostics',async()=>{
  const privateValue='PRIVATE SOURCE TITLE 219',privateReason='PRIVATE completion reasoning 481',item=observe({title:privateValue,text:'A current source.'}),bad=supported('{"title":"'+privateValue+'"}'),good=supported(privateValue);good.checks[0].reason=privateReason;
  const model=fixtureModel([bad,good]),events=[],audits=[],before=structuredClone(item),verify=createWorkCompletionVerifier(model,{progress:event=>events.push(event),audit:event=>audits.push(event)});
  assert.equal(await verify(checks,[item],claim),true);assert.equal(model.inputs.length,2);assert.deepEqual(item,before);
  assert.deepEqual(model.inputs[1].input.observations,model.inputs[0].input.observations);assert.equal(model.inputs[1].input.correction.issue.code,'WORK_COMPLETION_VERIFIER_QUOTE_UNOBSERVED');assert.equal(model.inputs[1].input.correction.issue.check_id,'read');assert.equal(model.inputs[1].input.correction.issue.evidence_id,'source-1');
  assert.ok(model.inputs[1].input.correction.eligible_leaf_examples.includes(privateValue));assert.ok(model.inputs[1].instructions.includes('only correction attempt'));
  assert.deepEqual(audits.map(event=>[event.attempt,event.status]),[[1,'rejected'],[2,'accepted']]);assert.match(audits[0].issue.quote_sha256,/^[a-f0-9]{64}$/u);assert.match(audits[1].checks[0].reason_sha256,/^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify({events,audits}).includes(privateValue));assert.ok(!JSON.stringify({events,audits}).includes(privateReason));assert.match(events.at(-1).summary,/after one output correction/u);
  assert.equal(await verify(checks,[item],claim),true);assert.equal(model.inputs.length,2);assert.match(events.at(-1).summary,/cached/u);
});

test('completion contract: a second invalid quote remains false without tools, observation mutation or a third verifier call',async()=>{
  const bad=supported('A fabricated quotation'),model=fixtureModel([bad,bad,supported()]),audits=[],observations=[observe()],before=structuredClone(observations),verify=createWorkCompletionVerifier(model,{audit:event=>audits.push(event)});
  assert.equal(await verify(checks,observations,claim),false);assert.equal(model.inputs.length,2);assert.deepEqual(observations,before);assert.ok(audits.every(event=>event.status==='rejected'));assert.equal(audits.at(-1).issue.code,'WORK_COMPLETION_VERIFIER_QUOTE_UNOBSERVED');
});

test('completion contract: unsupported and unknown are substantive results, not an opportunity for a corrective upgrade',async()=>{
  for(const verdict of ['unsupported','unknown']){
    const answer=unsupported('The requested fact is not present.');answer.checks[0].verdict=verdict;
    const model=fixtureModel([answer,supported()]),audit=[],verify=createWorkCompletionVerifier(model,{audit:event=>audit.push(event)});
    assert.equal(await verify(checks,[observe()],claim),false);assert.equal(model.inputs.length,1);assert.equal(audit[0].code,'WORK_COMPLETION_CHECK_NOT_SUPPORTED');assert.equal(audit[0].checks[0].verdict,verdict);
  }
});

test('completion contract: malformed typed output has one repair, and every corrected field is validated again',async()=>{
  const model=fixtureModel([{complete:true},supported()]),verify=createWorkCompletionVerifier(model);assert.equal(await verify(checks,[observe()],claim),true);assert.equal(model.inputs.length,2);assert.equal(model.inputs[1].input.correction.issue.code,'WORK_COMPLETION_VERIFIER_OUTPUT_INVALID');assert.ok(model.inputs[1].input.correction.issue.schema_paths.length>0);
  const wrongId=supported('Physical AI','read','invented'),failed=fixtureModel([supported('not observed'),wrongId,supported()]),audits=[];
  assert.equal(await createWorkCompletionVerifier(failed,{audit:event=>audits.push(event)})(checks,[observe()],claim),false);assert.equal(failed.inputs.length,2);assert.equal(audits.at(-1).code,'WORK_COMPLETION_VERIFIER_EVIDENCE_INVALID');
});

test('completion contract: provider failure on the output-only correction preserves all work receipts and does not retry again',async()=>{
  const observations=[observe()],before=structuredClone(observations),model=fixtureModel([supported('not observed'),Error('STRUCTURED_MODEL_UNAVAILABLE'),supported()]),events=[],audits=[];
  const verify=createWorkCompletionVerifier(model,{progress:event=>events.push(event),audit:event=>audits.push(event)});
  assert.equal(await verify(checks,observations,claim),false);assert.equal(model.inputs.length,2);assert.deepEqual(observations,before);assert.equal(audits.at(-1).status,'unavailable');assert.equal(audits.at(-1).code,'STRUCTURED_MODEL_UNAVAILABLE');assert.match(events.at(-1).summary,/STRUCTURED_MODEL_UNAVAILABLE/u);
});

// Real SQLite readback with an explicitly synthetic host ownership witness; never a live run claim.
function traceFixture(t,observations,options={}){
  const work_id='trace-work',run_id='trace-run',owner='trace-owner',project='trace-project',db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const checkpoint=options.checkpoint??{format:1,work_id,run_id,binding:'a'.repeat(64),turn:observations.length,pending:null,observations:structuredClone(observations),summary:'Not proof: the claimant says everything is done.'};
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  db.exec('CREATE TABLE swarm_activity(project_id TEXT,run_id TEXT,kind TEXT)');
  db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run(project,work_id,run_id,owner,Date.now()+60000,'running',0,JSON.stringify(checkpoint));
  const store={hermesState:db,intakeWork:()=>({revision:options.work_revision??0}),officeWork:()=>({id:work_id}),swarmRun:()=>({snapshot:options.swarmSnapshot})};
  const request={work_id,run_id,owner,checkpoint,observations:structuredClone(observations),admission_closed:true};
  return {db,store,project,request,checkpoint,trace:(changes={})=>createWorkRunTraceEvidence(store,project,{...request,...changes})};
}
const noSendChecks=[{id:'no_send',result:'This Office-controlled run must not dispatch an external-write capability.',evidence:'A host-closed trace of this controlled run, not assumptions from a research result.'}];
const traceClaim=trace=>({...claim,completed_checks:[{id:'no_send',evidence_ids:[trace.receipt.evidence_ids[0]]}]});
const traceSupported=trace=>({checks:[{id:'no_send',verdict:'supported',evidence_use:'controlled_run_constraint',evidence_ids:[trace.receipt.evidence_ids[0]],evidence_quotes:[{evidence_id:trace.receipt.evidence_ids[0],quote:'This host-closed Office-controlled run dispatched 0 external_write capabilities through the bound checkpoint.'}],reason:'The closed host trace records zero external-write capability dispatches within this run and explicitly excludes other apps and runs.'}]});

test('completion contract: host-closed trace reads the same leased persisted checkpoint and counts controlled reads/writes without exposing source content',async t=>{
  const privateText='PRIVATE SOURCE CONTENT 625',observations=[observe({text:privateText}),observe({path:'/workspace/report.txt',text:'Saved result.'},{invocation:{request_id:'draft-1',turn:1,tool_name:'office_result_draft',effect:'local_write'},receipt:{effect_state:'verified',evidence_ids:['draft-1']}})],x=traceFixture(t,observations),trace=x.trace(),value=trace.receipt.value;
  assert.equal(value.closure,'closed');assert.deepEqual(value.dispatch_counts,{total:2,read_only:1,draft_only:0,local_write:1,external_write:0,verified_effects:1,uncertain_effects:0});
  assert.equal(value.checkpoint_sha256,hashJson(x.checkpoint));assert.equal(value.source_observations_sha256,hashJson(observations));assert.ok(value.scope.includes('Not other apps'));assert.ok(!JSON.stringify(trace).includes(privateText));assert.ok(!JSON.stringify(trace).includes('trace-owner'));
  const answer=traceSupported(trace),model=fixtureModel([answer]),verify=createWorkCompletionVerifier(model);assert.equal(await verify(noSendChecks,[...observations,trace],traceClaim(trace)),true);
  assert.equal(model.inputs.length,1);assert.equal(model.inputs[0].input.observations.length,1);assert.ok(model.inputs[0].instructions.includes('cannot establish a positive result'));
});

test('completion contract: host trace cannot replace positive result receipts and every requested result remains independently checked',async t=>{
  const observations=[observe()],x=traceFixture(t,observations),trace=x.trace(),traceId=trace.receipt.evidence_ids[0];
  const positiveOnly=supported('This host-closed Office-controlled run','read',traceId),falseModel=fixtureModel([positiveOnly,supported()]),audit=[];
  assert.equal(await createWorkCompletionVerifier(falseModel,{audit:event=>audit.push(event)})(checks,[...observations,trace],{...claim,completed_checks:[{id:'read',evidence_ids:[traceId]}]}),false);
  assert.equal(falseModel.inputs.length,1);assert.equal(audit[0].code,'WORK_COMPLETION_TRACE_NOT_RESULT_EVIDENCE');
  const both=[...checks,...noSendChecks],bothClaim={...claim,completed_checks:[...claim.completed_checks,...traceClaim(trace).completed_checks]},answer={checks:[...supported().checks,...traceSupported(trace).checks]},model=fixtureModel([answer]);
  assert.equal(await createWorkCompletionVerifier(model)(both,[...observations,trace],bothClaim),true);assert.equal(model.inputs.length,1);
  const missingPositive={checks:[...unsupported('The requested current publication date was never observed.').checks,...traceSupported(trace).checks]},missing=fixtureModel([missingPositive,answer]);
  assert.equal(await createWorkCompletionVerifier(missing)(both,[...observations,trace],bothClaim),false);assert.equal(missing.inputs.length,1);
});

test('completion contract: ordinary process prohibition means this controlled Work; source HTTP reads are not external delivery',async t=>{
  const observations=[observe({title:'Observed requested source',requested_url:'https://example.com/',provenance:'live_browser_dom'},{invocation:{tool_name:'office_browser_read'}})],x=traceFixture(t,observations),trace=x.trace();
  const scopedChecks=[{id:'no_send',result:'로그인, 폼 입력, 제출, 외부 전송이 전혀 없었음',evidence:'This Work\'s closed host capability history; do not infer activity in other applications.'}],answer=traceSupported(trace);
  answer.checks[0].evidence_quotes.push({evidence_id:trace.receipt.evidence_ids[0],quote:'office_browser_read'});answer.checks[0].reason='The only dispatched capability is office_browser_read; this closed Work history contains no login, form-input, submission or delivery operation. The requested source read is not message sending.';const model=fixtureModel([answer]);
  assert.equal(trace.receipt.value.closure,'closed');assert.equal(trace.receipt.value.dispatch_counts.read_only,1);assert.equal(trace.receipt.value.dispatch_counts.external_write,0);assert.equal(trace.receipt.value.dispatched_tools[0].name,'office_browser_read');
  assert.equal(await createWorkCompletionVerifier(model)(scopedChecks,[...observations,trace],traceClaim(trace)),true);assert.equal(model.inputs.length,1);assert.equal(model.inputs[0].input.checks[0].result,scopedChecks[0].result,'Scope guidance does not rewrite the requested check');
  for(const instructions of [WORK_DEFINITION_INSTRUCTIONS,model.inputs[0].instructions]){assert.ok(instructions.includes('로그인, 폼 입력, 제출, 외부 전송이 전혀 없었음'));assert.ok(instructions.includes('this specific Work\'s Office-controlled capability dispatches'));assert.ok(instructions.includes('external_write=0 alone'));}
  assert.ok(model.inputs[0].instructions.includes('HTTP reads of the requested source are not message/result sending'));assert.ok(WORK_DEFINITION_INSTRUCTIONS.includes('do not invent a globally unobservable completion condition'));assert.ok(WORK_DEFINITION_INSTRUCTIONS.includes('retain that requirement and explain the missing observability'));
});

test('completion contract: explicit global or all-network requirements stay unknown or unsupported without upgrading them to scoped absence',async t=>{
  const observations=[observe({requested_url:'https://example.com/'},{invocation:{tool_name:'office_browser_read'}})],x=traceFixture(t,observations),trace=x.trace();
  for(const [result,verdict,reason] of [['No login or form input occurred anywhere on the entire PC, including other applications and uninstrumented internals.','unknown','The host trace excludes other apps and uninstrumented internals.'],['This Work made no network requests, including HTTP source reads.','unsupported','The observed office_browser_read accessed the requested HTTPS source.']]){
    const broadChecks=[{id:'no_send',result,evidence:'The explicitly requested broader scope must not be silently narrowed.'}],answer=traceSupported(trace);answer.checks[0].verdict=verdict;answer.checks[0].reason=reason;
    const model=fixtureModel([answer,traceSupported(trace)]),events=[];assert.equal(await createWorkCompletionVerifier(model,{progress:event=>events.push(event)})(broadChecks,[...observations,trace],traceClaim(trace)),false);assert.equal(model.inputs.length,1);assert.ok(events.at(-1).summary.includes(verdict));assert.equal(model.inputs[0].input.checks[0].result,result);
    assert.ok(model.inputs[0].instructions.includes('An explicit prohibition on all network requests, including source reads, remains broader'));assert.ok(model.inputs[0].instructions.includes('Explicit machine-wide, other-application, uninstrumented-internal or all-network absence must remain unknown or unsupported'));
  }
});

test('completion contract: absent closure, wrong ownership/revision or mismatched readback produces unknown counts, never an inferred zero',async t=>{
  for(const variation of ['open','owner','expired','revision','checkpoint','observations','foreign-run']){
    const observations=[observe()],x=traceFixture(t,observations,{work_revision:variation==='revision'?1:0});let changes={};
    if(variation==='open')changes={admission_closed:false};if(variation==='owner')changes={owner:'other-owner'};if(variation==='expired')x.db.prepare('UPDATE office_supervisor SET lease_until_ms=0').run();
    if(variation==='checkpoint')changes={checkpoint:{...x.checkpoint,summary:'A stale in-memory checkpoint.'}};if(variation==='observations')changes={observations:[observe({title:'Different source'})]};if(variation==='foreign-run')changes={run_id:'other-run'};
    const trace=x.trace(changes);assert.equal(trace.receipt.value.closure,'unknown',variation);assert.ok(Object.values(trace.receipt.value.dispatch_counts).every(count=>count==='unknown'),variation);assert.ok(trace.receipt.value.reason.startsWith('WORK_TRACE_'));
    if(variation==='open'){
      const model=fixtureModel([traceSupported(trace),traceSupported(trace)]),events=[];
      assert.equal(await createWorkCompletionVerifier(model,{progress:event=>events.push(event)})(noSendChecks,[...observations,trace],traceClaim(trace)),false);assert.equal(model.inputs.length,1);assert.match(events.at(-1).summary,/unknown.*not host-closed/u);
    }
  }
});

test('completion contract: pruned history, pending operations and unverified or uncertain writes cannot close a trace',async t=>{
  for(const variation of ['pruned','pending','uncertain','unverified','duplicate','inconsistent']){
    const observations=[observe()],x=traceFixture(t,observations),cp=x.checkpoint;
    if(variation==='pruned'){cp.turn=8;cp.observations[0].invocation.turn=7;}
    if(variation==='pending')cp.pending={...cp.observations[0].invocation,request_id:'unsettled-write',turn:1,tool_name:'send_message',effect:'external_write',dispatched:true};
    if(variation==='uncertain'){cp.observations[0].receipt.effect_state='uncertain';cp.observations[0].receipt.status='reconciliation_required';cp.observations[0].invocation.effect='external_write';}
    if(variation==='unverified')cp.observations[0].invocation.effect='external_write';
    if(variation==='duplicate'){cp.observations.push({...structuredClone(cp.observations[0]),invocation:{...cp.observations[0].invocation,turn:1}});cp.turn=2;}
    if(variation==='inconsistent')cp.observations[0].invocation.dispatched=false;
    x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(cp));const trace=x.trace({checkpoint:cp,observations:cp.observations});
    assert.equal(trace.receipt.value.closure,'unknown',variation);assert.equal(trace.receipt.value.dispatch_counts.external_write,'unknown');
  }
});

test('completion contract: forged, changed or differently scoped trace receipts are rejected before a verifier model is called',async t=>{
  const observations=[observe()],x=traceFixture(t,observations),trace=x.trace(),forged=structuredClone(trace);forged.receipt.value.dispatch_counts.external_write=55;
  const clone=structuredClone(trace),invented=structuredClone(trace);invented.receipt.evidence_ids=['made-up-trace'];
  for(const items of [[...observations,forged],[...observations,invented],[observe({title:'A changed ordinary source'}),clone]]){
    const model=fixtureModel([traceSupported(trace)]),events=[];assert.equal(await createWorkCompletionVerifier(model,{progress:event=>events.push(event)})(noSendChecks,items,traceClaim(trace)),false);assert.equal(model.inputs.length,0);assert.match(events.at(-1).summary,/WORK_COMPLETION_TRACE_NOT_HOST_BOUND/u);
  }
  assert.equal(await createWorkCompletionVerifier(fixtureModel([traceSupported(trace)]))(noSendChecks,[...observations,clone],traceClaim(trace)),true);
});

test('completion contract: Swarm trace includes every terminal worker checkpoint and final actual output, not only the synthesis assertion',async t=>{
  const swarmRun='swarm-run',sourceCp={format:1,work_id:'trace-work',run_id:`${swarmRun}.source`,binding:'b'.repeat(64),turn:1,pending:null,observations:[observe()],summary:'A source claim.'},finals=[observe({text:'Final independently read-back result.'},{invocation:{request_id:'final-read',tool_name:'office_swarm_readback'},receipt:{evidence_ids:['final-read']}}),observe({path:'/workspace/swarm.txt'},{invocation:{request_id:'final-draft',turn:1,tool_name:'office_result_draft',effect:'local_write'},receipt:{evidence_ids:['final-draft'],effect_state:'verified'}})];
  const checkpoint={format:1,kind:'swarm',run_id:swarmRun,work_id:'trace-work',workers:{source:sourceCp},completed_workers:['source'],work_revision:0,final_observations:finals},swarmSnapshot={status:'completed',plan:{workers:[{id:'source',effect:'read_only'}]},workers:{source:{status:'succeeded',result:{readback:{verified:true}},quality:{accepted:true}}}},x=traceFixture(t,finals,{checkpoint,swarmSnapshot}),trace=x.trace();
  assert.equal(trace.receipt.value.closure,'closed');assert.equal(trace.receipt.value.execution_kind,'swarm');assert.equal(trace.receipt.value.dispatch_counts.total,3);assert.equal(trace.receipt.value.dispatch_counts.read_only,2);assert.equal(trace.receipt.value.dispatch_counts.local_write,1);
  assert.equal(await createWorkCompletionVerifier(fixtureModel([traceSupported(trace)]))(noSendChecks,[...finals,trace],traceClaim(trace)),true);
  swarmSnapshot.workers.source.status='leased';const unclosed=x.trace();assert.equal(unclosed.receipt.value.closure,'unknown');assert.equal(unclosed.receipt.value.dispatch_counts.total,'unknown');assert.equal(unclosed.receipt.value.reason,'WORK_TRACE_SWARM_NOT_CLOSED');
});

test('completion contract: one host trace may accompany 32 real receipt IDs without changing the ordinary evidence limit',async t=>{
  const observations=Array.from({length:32},(_,index)=>observe({title:'Physical AI'},{invocation:{request_id:`source-${index}`,turn:index},receipt:{evidence_ids:[`source-${index}`]}})),x=traceFixture(t,observations),trace=x.trace(),traceId=trace.receipt.evidence_ids[0],sourceIds=observations.flatMap(item=>item.receipt.evidence_ids);
  const positive={id:'read',verdict:'supported',evidence_ids:sourceIds,evidence_quotes:sourceIds.map(id=>({evidence_id:id,quote:'Physical AI'})),reason:'Each requested source title is present in its real observed receipt.'},answer={checks:[positive,...traceSupported(trace).checks]},model=fixtureModel([answer]),bothChecks=[...checks,...noSendChecks],bothClaim={...claim,completed_checks:[{id:'read',evidence_ids:[...sourceIds,traceId]},{id:'no_send',evidence_ids:[traceId]}]};
  assert.equal(trace.receipt.value.closure,'closed');assert.equal(trace.receipt.value.dispatch_counts.total,32);assert.equal(await createWorkCompletionVerifier(model)(bothChecks,[...observations,trace],bothClaim),true);assert.equal(model.inputs.length,1);
  const extra=observe({title:'Physical AI'},{invocation:{request_id:'source-33',turn:32},receipt:{evidence_ids:['source-33']}}),overflow=fixtureModel([answer]);
  assert.equal(await createWorkCompletionVerifier(overflow)(bothChecks,[...observations,extra,trace],bothClaim),false);assert.equal(overflow.inputs.length,0);
});

test('completion contract: an actual verified external dispatch is counted, not hidden behind source reads or a zero inferred from another category',async t=>{
  const observations=[observe({recipient:'approved-fixture-recipient',delivery:'verified-fixture-receipt'},{invocation:{tool_name:'send_message',effect:'external_write'},receipt:{effect_state:'verified'}})],x=traceFixture(t,observations),trace=x.trace();
  assert.equal(trace.receipt.value.closure,'closed');assert.equal(trace.receipt.value.dispatch_counts.external_write,1);assert.equal(trace.receipt.value.dispatch_counts.read_only,0);
  const bad=traceSupported(trace),model=fixtureModel([bad,bad]);assert.equal(await createWorkCompletionVerifier(model)(noSendChecks,[...observations,trace],traceClaim(trace)),false);assert.equal(model.inputs.length,2);
});

test('completion contract: resumed admission proves zero new reads while retaining the real prior browser receipt and lifetime count',async t=>{
  const observations=[observe()],x=traceFixture(t,observations),admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request);
  const current={...structuredClone(x.checkpoint),binding:'c'.repeat(64),summary:'Rebound capabilities, same retained tool receipts.'};x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(current));
  const trace=x.trace({checkpoint:current,admission_checkpoint:admission}),value=trace.receipt.value;
  assert.equal(value.closure,'closed');assert.equal(value.admission_trace.closure,'closed');assert.equal(value.lifetime_dispatch_counts.read_only,1);assert.equal(value.dispatch_counts.read_only,1);assert.equal(value.since_admission_counts.read_only,0);
  assert.deepEqual(value.since_admission_tools,[{name:'browser_read',dispatches:0}]);assert.deepEqual(value.inherited_evidence_ids,['source-1']);assert.equal(value.admission_trace.checkpoint_sha256,hashJson(admission));
  const resumeChecks=[{id:'reused',result:'Reuse retained source evidence without any new read capability in this resumed Office admission.',evidence:'Independent host entry checkpoint and a prefix-verified closed trace.'}],id=trace.receipt.evidence_ids[0],answer={checks:[{id:'reused',verdict:'supported',evidence_use:'controlled_run_constraint',evidence_ids:[id],evidence_quotes:[{evidence_id:id,quote:'Since this host-captured admission, this Office-controlled run dispatched 0 new read_only capabilities through the bound checkpoint.'}],reason:'The lifetime browser observation is retained but the independently captured suffix contains no new read dispatches.'}]};
  assert.equal(await createWorkCompletionVerifier(fixtureModel([answer]))(resumeChecks,[...observations,trace],{...claim,completed_checks:[{id:'reused',evidence_ids:[id]}]}),true);
});

test('completion contract: mixed retained-result and no-new-read checks receive separate grounded result and host-admission evidence',async t=>{
  const text='Python, Node.js and SQLite are observed source values.',observations=[observe({text})],x=traceFixture(t,observations),admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request);
  const file=observe({path:'/workspace/report.txt',text},{invocation:{request_id:'saved-file',turn:1,tool_name:'office_result_draft',effect:'local_write'},receipt:{evidence_ids:['saved-file'],effect_state:'verified',retry_safe:false}});
  const current={...structuredClone(x.checkpoint),turn:2,observations:[...observations,file]};x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(current));
  const trace=x.trace({checkpoint:current,observations:current.observations,admission_checkpoint:admission}),traceId=trace.receipt.evidence_ids[0];
  const mixedChecks=[{id:'reused',result:'Save the retained source values in a TXT without any new browser read during this resumed Office admission.',evidence:'The original source text, saved file text and host-captured admission dispatch history.'}];
  const mixedClaim={...claim,completed_checks:[{id:'reused',evidence_ids:['source-1','saved-file',traceId]}]},answer={checks:[{id:'reused',verdict:'supported',evidence_use:'observed_result',evidence_ids:['source-1','saved-file',traceId],evidence_quotes:[{evidence_id:'source-1',quote:text},{evidence_id:'saved-file',quote:text},{evidence_id:traceId,quote:'Since this host-captured admission, this Office-controlled run dispatched 0 new read_only capabilities through the bound checkpoint.'}],reason:'Actual source and saved file values match, the source receipt was retained at host admission, and its closed suffix contains no new read dispatch.'}]};
  const model=fixtureModel([answer]),audit=[],verify=createWorkCompletionVerifier(model,{audit:event=>audit.push(event)});
  assert.equal(trace.receipt.value.closure,'closed');assert.equal(trace.receipt.value.admission_trace.closure,'closed');assert.equal(trace.receipt.value.lifetime_dispatch_counts.read_only,1);assert.equal(trace.receipt.value.since_admission_counts.read_only,0);assert.deepEqual(trace.receipt.value.inherited_evidence_ids,['source-1']);
  assert.equal(await verify(mixedChecks,[...current.observations,trace],mixedClaim),true);assert.equal(model.inputs.length,1);assert.equal(audit[0].status,'accepted');
  const instructions=model.inputs[0].instructions;assert.ok(instructions.includes('host observations, not the executor\'s summary'));assert.ok(instructions.includes('lifetime_dispatch_counts includes earlier operations'));assert.ok(instructions.includes('Require both closure=closed and admission_trace.closure=closed'));assert.ok(instructions.includes('needs BOTH actual source/file leaf values'));assert.ok(instructions.includes('evidence_use observed_result for that mixed result'));assert.ok(!JSON.stringify(model.inputs[0].input).includes(claim.summary));
});

test('completion contract: mixed process guidance does not upgrade an independent unknown verdict or an unclosed host trace',async t=>{
  const observations=[observe()],x=traceFixture(t,observations),admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request),trace=x.trace({admission_checkpoint:admission}),traceId=trace.receipt.evidence_ids[0];
  const mixedChecks=[{id:'read',result:'Retain the observed Physical AI title without a new browser read during this resumed Office admission.',evidence:'Actual original title and the closed host admission trace.'}],mixedClaim={...claim,completed_checks:[{id:'read',evidence_ids:['source-1',traceId]}]};
  const unknown=unsupported('An unrelated requested result remains unobserved.');unknown.checks[0].verdict='unknown';
  const model=fixtureModel([unknown,supported()]);assert.equal(await createWorkCompletionVerifier(model)(mixedChecks,[...observations,trace],mixedClaim),false);assert.equal(model.inputs.length,1);
  const open=x.trace({admission_checkpoint:admission,admission_closed:false}),openId=open.receipt.evidence_ids[0],modelAnswer={checks:[{id:'read',verdict:'supported',evidence_use:'observed_result',evidence_ids:['source-1',openId],evidence_quotes:[{evidence_id:'source-1',quote:'Physical AI'},{evidence_id:openId,quote:'The execution trace is not host-closed; absence of effects is unknown.'}],reason:'This is deliberately invalid fixture evidence.'}]},invalid=fixtureModel([modelAnswer,supported()]),events=[];
  assert.equal(await createWorkCompletionVerifier(invalid,{progress:event=>events.push(event)})(mixedChecks,[...observations,open],{...mixedClaim,completed_checks:[{id:'read',evidence_ids:['source-1',openId]}]}),false);assert.equal(invalid.inputs.length,1);assert.match(events.at(-1).summary,/not host-closed/u);
});

test('completion contract: resumed admission counts only actual new dispatched operations and independently seals null for a new run',async t=>{
  const observations=[observe()],x=traceFixture(t,observations),admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request),newRead=observe({title:'A newly read source.'},{invocation:{request_id:'new-read',turn:1},receipt:{evidence_ids:['source-2']}}),newWrite=observe({path:'/workspace/new.txt'},{invocation:{request_id:'new-write',turn:2,tool_name:'office_result_draft',effect:'local_write'},receipt:{evidence_ids:['draft-2'],effect_state:'verified'}}),current={...structuredClone(x.checkpoint),turn:3,observations:[...observations,newRead,newWrite]};
  x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(current));const trace=x.trace({checkpoint:current,observations:current.observations,admission_checkpoint:admission});
  assert.equal(trace.receipt.value.lifetime_dispatch_counts.total,3);assert.equal(trace.receipt.value.since_admission_counts.total,2);assert.equal(trace.receipt.value.since_admission_counts.read_only,1);assert.equal(trace.receipt.value.since_admission_counts.local_write,1);assert.deepEqual(trace.receipt.value.inherited_evidence_ids,['source-1']);
  const fresh=traceFixture(t,observations);fresh.db.prepare('UPDATE office_supervisor SET checkpoint=NULL').run();const emptyAdmission=captureWorkRunAdmissionCheckpoint(fresh.store,fresh.project,fresh.request);assert.equal(emptyAdmission,null);
  fresh.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(fresh.checkpoint));const freshTrace=fresh.trace({admission_checkpoint:emptyAdmission});assert.equal(freshTrace.receipt.value.admission_trace.closure,'closed');assert.equal(freshTrace.receipt.value.since_admission_counts.read_only,1);assert.deepEqual(freshTrace.receipt.value.inherited_evidence_ids,[]);
});

test('completion contract: absent, unsealed, modified, foreign or non-prefix entry history never implies zero new operations',async t=>{
  for(const variation of ['absent','unsealed','modified','foreign','prefix','pruned','pending','uncertain']){
    const observations=[observe()],x=traceFixture(t,observations);let admission;
    if(variation==='pruned'){x.checkpoint.turn=8;x.checkpoint.observations[0].invocation.turn=7;}
    if(variation==='pending')x.checkpoint.pending={...x.checkpoint.observations[0].invocation,request_id:'pending-read',turn:1};
    if(variation==='uncertain'){x.checkpoint.observations[0].receipt.effect_state='uncertain';x.checkpoint.observations[0].receipt.status='reconciliation_required';}
    x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(x.checkpoint));
    if(variation==='unsealed')admission={...x.checkpoint,summary:'Not captured by the host.'};else if(variation!=='absent')admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request);
    if(variation==='modified')admission.summary='Changed after host capture.';if(variation==='foreign')admission.run_id='foreign-run';
    const current={...structuredClone(x.checkpoint),turn:1,pending:null,observations:structuredClone(observations)};
    if(variation==='prefix')current.observations[0].receipt.value={title:'Substituted old source.'};
    x.db.prepare('UPDATE office_supervisor SET checkpoint=?').run(JSON.stringify(current));const trace=x.trace({checkpoint:current,observations:current.observations,...(variation==='absent'?{}:{admission_checkpoint:admission})});
    assert.equal(trace.receipt.value.closure,'closed',variation);assert.equal(trace.receipt.value.admission_trace.closure,'unknown',variation);assert.ok(Object.values(trace.receipt.value.since_admission_counts).every(value=>value==='unknown'),variation);assert.deepEqual(trace.receipt.value.inherited_evidence_ids,[]);assert.ok(trace.receipt.value.admission_trace.reason.startsWith('WORK_TRACE_'));
  }
});

test('completion contract: host entry capture requires the real current owner, live lease and matching Work revision',async t=>{
  const observations=[observe()],x=traceFixture(t,observations);assert.throws(()=>captureWorkRunAdmissionCheckpoint(x.store,x.project,{...x.request,owner:'wrong-owner'}),/WORK_TRACE_ADMISSION_OWNER_NOT_CURRENT/u);
  x.db.prepare('UPDATE office_supervisor SET lease_until_ms=0').run();assert.throws(()=>captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request),/WORK_TRACE_ADMISSION_OWNER_NOT_CURRENT/u);
  const stale=traceFixture(t,observations,{work_revision:1});assert.throws(()=>captureWorkRunAdmissionCheckpoint(stale.store,stale.project,stale.request),/WORK_TRACE_ADMISSION_REVISION_CONFLICT/u);
});

test('completion contract: actual Swarm rebase history cannot claim lifetime closure or a zero after old worker receipts were discarded',async t=>{
  const swarmRun='rebased-swarm',finals=[observe({text:'Retained final result.'},{invocation:{request_id:'final',tool_name:'office_swarm_readback'},receipt:{evidence_ids:['final']}})],source={format:1,work_id:'trace-work',run_id:`${swarmRun}.source`,binding:'b'.repeat(64),turn:1,pending:null,observations:[observe()],summary:'Only the current source checkpoint remains.'},checkpoint={format:1,kind:'swarm',work_id:'trace-work',run_id:swarmRun,workers:{source},completed_workers:['source'],work_revision:1,final_observations:finals},snapshot={status:'completed',plan:{workers:[{id:'source',effect:'read_only'}]},workers:{source:{status:'succeeded',result:{readback:{verified:true}},quality:{accepted:true}}}},x=traceFixture(t,finals,{checkpoint,swarmSnapshot:snapshot}),insert=x.db.prepare('INSERT INTO swarm_activity VALUES(?,?,?)');
  insert.run('foreign-project',swarmRun,'work.direction_rebased');insert.run(x.project,'another-swarm','work.direction_rebased');insert.run(x.project,swarmRun,'worker.lease_released');assert.equal(x.trace().receipt.value.closure,'closed');
  const admission=captureWorkRunAdmissionCheckpoint(x.store,x.project,x.request);insert.run(x.project,swarmRun,'work.direction_rebased');const trace=x.trace({admission_checkpoint:admission});
  assert.equal(trace.receipt.value.closure,'unknown');assert.equal(trace.receipt.value.reason,'WORK_TRACE_HISTORY_INCOMPLETE');assert.ok(Object.values(trace.receipt.value.lifetime_dispatch_counts).every(count=>count==='unknown'));assert.ok(Object.values(trace.receipt.value.since_admission_counts).every(count=>count==='unknown'));assert.deepEqual(trace.receipt.value.inherited_evidence_ids,[]);
  const model=fixtureModel([traceSupported(trace),traceSupported(trace)]),audits=[];assert.equal(await createWorkCompletionVerifier(model,{audit:event=>audits.push(event)})(noSendChecks,[...finals,trace],traceClaim(trace)),false);assert.equal(model.inputs.length,1);assert.equal(audits[0].code,'WORK_COMPLETION_TRACE_NOT_CLOSED');
});

test('completion contract: rejected typed verdict explains the missing evidence in at most 400 safe characters while audit retains only a hash',async()=>{
  const apiKey='apikey_'+'a'.repeat(32),token='private-session-value',password='private-password-value',reason=(`Prior evidence was retained, but no cited file receipt proves its source. api_key=${apiKey} token=${token} password=${password} https://example.test/report?token=private-query `+'extra-detail '.repeat(45)).trim(),answer=unsupported(reason);answer.checks[0].verdict='unknown';
  const model=fixtureModel([answer,supported()]),events=[],audits=[],verify=createWorkCompletionVerifier(model,{progress:event=>events.push(event),audit:event=>audits.push(event)}),observations=[observe()],before=structuredClone(observations);
  assert.equal(await verify(checks,observations,claim),false);assert.equal(model.inputs.length,1);assert.deepEqual(observations,before);assert.match(events.at(-1).summary,/unknown — Prior evidence was retained, but no cited file receipt proves its source/u);assert.match(events.at(-1).summary,/reason_sha256: [a-f0-9]{64}/u);
  const explanation=events.at(-1).summary.split(' — ')[1].split(' (reason_sha256:')[0];assert.ok(explanation.length<=400);assert.ok(explanation.endsWith('…'));assert.match(explanation,/REDACTED/u);assert.equal(audits[0].checks[0].reason_sha256,hashJson(reason));
  for(const secret of [apiKey,token,password,'private-query'])assert.ok(!JSON.stringify({events,audits}).includes(secret),secret);
  assert.ok(!JSON.stringify(audits).includes('Prior evidence was retained'));assert.ok(!JSON.stringify({events,audits}).includes(observations[0].receipt.value.text));
});
