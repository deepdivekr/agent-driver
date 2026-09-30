import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorkCompletionVerifier,createWorkRunTraceEvidence} from '../dist/work/completion.js';

const checks=[{id:'combined',result:'Report both independently observed Alpha and Beta source values.',evidence:'The actual source values from two different receipts.'}];
const observations=()=>Array.from({length:9},(_,index)=>({
  invocation:{request_id:`request_${index}`,turn:index,stage_id:'collect',tool_name:'browser_read',arguments:{},effect:'read_only',dispatched:true},
  receipt:{status:'succeeded',value:{fact:index===0?'Alpha':index===8?'Beta':`Unrelated ${index}`,content:`Source ${index}: `+'x'.repeat(9500)},evidence_ids:[`source_${index}`],effect_state:'none',retry_safe:true},
  observed_at:'2026-09-29T00:00:00.000Z',
}));
const claim=ids=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'A model claim, not evidence.',completed_checks:[{id:'combined',evidence_ids:ids}],wait_reason:null});
function model(options={}){
  const inputs=[];return {inputs,calls:[],async call(purpose,instructions,input){
    inputs.push(structuredClone(input));let result;
    if(input.batch_index){
      if(options.outage&&input.batch_index===2)throw Error('STRUCTURED_MODEL_UNAVAILABLE');
      result={findings:input.observations.flatMap(record=>input.checks.filter(check=>check.allowed_evidence_ids.some(id=>record.evidence_ids.includes(id))).map(check=>{
        const fact=record.value.fact,relation=options.conflict&&fact==='Beta'?'contradicts':options.uncertain&&fact==='Beta'?'unresolved_material':options.context&&fact==='Unrelated 1'?'context':fact==='Alpha'||fact==='Beta'?'supports':'irrelevant';
        return {check_id:check.id,record_id:record.record_id,relation,quotes:['supports','context','contradicts'].includes(relation)?[options.forged&&fact==='Beta'&&(!options.recover||!input.correction)?'UNOBSERVED PRIVATE VALUE':fact]:[],reason:relation==='irrelevant'?'Unrelated source content.':'Observed source value.'};
      }))};
      if(options.omit&&input.batch_index===2)result.findings.pop();
      if(options.malformed&&input.batch_index===2)result.findings[0].quotes=1;
    }else if(input.projection){
      const findings=input.observations.flatMap(record=>record.findings.filter(finding=>finding.relation==='supports').map(finding=>({id:record.evidence_ids[0],quote:finding.quotes[0],ref:finding.quote_refs[0]})));
      assert.deepEqual(findings.map(item=>item.quote),['Alpha','Beta'],'Final synthesis sees facts from different original batches.');
      result={checks:[{id:'combined',verdict:'supported',evidence_ids:findings.map(item=>item.id),evidence_quote_refs:findings.map(item=>({evidence_id:item.id,quote_ref:options.finalForgery&&item.quote==='Beta'?'q_invalid_reference':item.ref})),reason:'The two original source receipts contain both values.'}]};
    }else throw Error('UNEXPECTED_NON_BATCH_INPUT');
    this.calls.push({purpose,provider:'contract_fixture',model:'fixture-verifier',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return result;
  }};
}

test('runtime contract oversized evidence inspects every whole receipt, then verifies cross-receipt facts from host-bound excerpts',async()=>{
  const items=observations(),before=structuredClone(items),provider=model(),audits=[],events=[],verify=createWorkCompletionVerifier(provider,{audit:event=>audits.push(event),progress:event=>events.push(event)});
  assert.ok(Buffer.byteLength(JSON.stringify(items.map(item=>item.receipt.value)))>64000);
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),true);
  const batches=provider.inputs.filter(input=>input.batch_index),final=provider.inputs.at(-1);
  assert.ok(batches.length>=2);assert.equal(provider.inputs.length,batches.length+1);assert.equal(final.projection,'host_validated_leaf_findings');
  assert.deepEqual(batches.flatMap(batch=>batch.observations.map(item=>item.record_id)),items.map((_,index)=>`record_${index}`));
  assert.ok(batches.every(batch=>Buffer.byteLength(JSON.stringify(batch))<=64000));assert.ok(Buffer.byteLength(JSON.stringify(final))<=64000);
  assert.equal(final.manifest.length,items.length);assert.match(final.evidence_manifest_sha256,/^[a-f0-9]{64}$/u);assert.equal(audits.at(-1).status,'accepted');assert.equal(audits.at(-1).evidence_manifest_sha256,final.evidence_manifest_sha256);
  assert.deepEqual(items,before,'Inspection never changes a receipt or invokes a tool.');assert.ok(events.some(event=>/evidence batch/u.test(event.summary)));
});

test('runtime contract a pause during the first batch stops every remaining verifier model call',async()=>{
  const items=observations(),provider=model(),base=provider.call.bind(provider),audits=[];let paused=false;
  provider.call=async(...args)=>{const result=await base(...args);if(args[2].batch_index===1)paused=true;return result;};
  const verify=createWorkCompletionVerifier(provider,{guard:()=>{if(paused)throw Error('WORK_PAUSED');},audit:event=>audits.push(event)});
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),false);
  assert.equal(provider.inputs.length,1);assert.equal(provider.inputs[0].batch_index,1);assert.equal(audits.length,0,'A lost guard is not misreported as a model outage or accepted verification.');
});

test('runtime contract projected evidence keeps verified write state and observation time without treating metadata as proof',async()=>{
  const items=observations();items[7].invocation.effect='local_write';items[7].invocation.tool_name='office_result_draft';items[7].receipt.effect_state='verified';
  const provider=model(),verify=createWorkCompletionVerifier(provider);
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),true);
  const saved=provider.inputs.at(-1).observations.find(record=>record.evidence_ids.includes('source_7'));
  assert.equal(saved.effect_state,'verified');assert.equal(saved.observed_at,items[7].observed_at);
  assert.equal(provider.inputs.at(-1).manifest.find(record=>record.evidence_ids.includes('source_7')).effect_state,'verified');
});

test('runtime contract a context-only leaf stays visible but cannot become a positive citation reference',async()=>{
  const items=observations(),provider=model({context:true}),verify=createWorkCompletionVerifier(provider);
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),true);
  const context=provider.inputs.at(-1).observations.find(record=>record.evidence_ids.includes('source_1')).findings[0];
  assert.equal(context.relation,'context');assert.deepEqual(context.quotes,['Unrelated 1']);assert.deepEqual(context.quote_refs,[]);
});

for(const [name,option,code] of [['contradiction','conflict','BATCH_CONTRADICTS'],['material uncertainty','uncertain','BATCH_UNRESOLVED_MATERIAL'],['missing pair','omit','BATCH_COVERAGE_INVALID'],['malformed response','malformed','VERIFIER_OUTPUT_INVALID'],['invented excerpt','forged','BATCH_QUOTE_UNOBSERVED'],['provider outage','outage','STRUCTURED_MODEL_UNAVAILABLE']])test(`runtime contract oversized evidence ${name} blocks completion without tool replay`,async()=>{
  const items=observations(),provider=model({[option]:true}),audits=[],events=[],verify=createWorkCompletionVerifier(provider,{audit:event=>audits.push(event),progress:event=>events.push(event)});
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),false);
  assert.equal(provider.inputs.some(input=>input.projection),false);assert.match(events.at(-1).summary,new RegExp(code,'u'));
  assert.ok(audits.some(event=>event.batch_index&&event.evidence_manifest_sha256&&event.code.includes(code)));
  if(option==='forged'){
    const retries=provider.inputs.filter(input=>input.batch_index===2);
    assert.equal(retries.length,2,'An unobserved quote gets exactly one correction attempt.');
    assert.equal(retries[1].correction.issue.code,'WORK_COMPLETION_BATCH_QUOTE_UNOBSERVED');
    assert.equal(audits.filter(event=>event.code==='WORK_COMPLETION_BATCH_QUOTE_UNOBSERVED').length,2);
    assert.ok(audits.every(event=>!event.issue?.quote_sha256||!JSON.stringify(event).includes('UNOBSERVED PRIVATE VALUE')),'Private output text stays out of audit receipts.');
  }else if(option==='omit'||option==='malformed'||option==='outage')assert.equal(provider.inputs.filter(input=>input.batch_index===2).length,1,'Schema, coverage and provider failures must not trigger a model retry.');
});

test('runtime contract unobserved batch quote can be corrected once against identical whole receipts',async()=>{
  const items=observations(),provider=model({forged:true,recover:true}),audits=[],verify=createWorkCompletionVerifier(provider,{audit:event=>audits.push(event)});
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),true);
  const retries=provider.inputs.filter(input=>input.batch_index===2),{correction,...retryOriginal}=retries[1];
  assert.equal(retries.length,2);
  assert.deepEqual(retryOriginal,retries[0],'Correction reuses every original receipt and eligible pair.');
  assert.equal(correction.issue.record_id,'record_8');
  assert.equal(correction.issue.quote_index,0);
  assert.match(correction.issue.quote_sha256,/^[a-f0-9]{64}$/u);
  assert.equal(correction.issue.quote_bytes,Buffer.byteLength('UNOBSERVED PRIVATE VALUE'));
  assert.equal(audits[0].status,'rejected');assert.equal(audits.at(-1).status,'accepted');
  assert.deepEqual(provider.inputs.at(-1).observations.flatMap(record=>record.findings.flatMap(finding=>finding.quotes)).filter(quote=>quote==='Beta'),['Beta']);
});

test('runtime contract final projection cannot cite an unprojected reference even when the raw receipt contains other facts',async()=>{
  const items=observations(),provider=model({finalForgery:true}),verify=createWorkCompletionVerifier(provider);
  assert.equal(await verify(checks,items,claim(items.flatMap(item=>item.receipt.evidence_ids))),false);
  assert.equal(provider.inputs.filter(input=>input.projection).length,2,'One bounded output-only correction cannot upgrade an invented quote.');
});

test('runtime contract two different final citation errors stay false after one correction without replay',async()=>{
  const items=observations(),before=structuredClone(items),ids=items.flatMap(item=>item.receipt.evidence_ids);
  const two=[{id:'brief_format_verified',result:'Report Alpha.',evidence:'The Alpha receipt.'},{id:'readback_verified',result:'Report Beta.',evidence:'The Beta receipt.'}];
  const provider={inputs:[],calls:[],async call(purpose,_instructions,input){
    this.inputs.push(structuredClone(input));let output;
    if(input.batch_index)output={findings:input.observations.flatMap(record=>input.eligible_pairs.filter(pair=>pair.record_id===record.record_id).map(pair=>{
      const supported=pair.check_id==='brief_format_verified'&&record.value.fact==='Alpha'||pair.check_id==='readback_verified'&&record.value.fact==='Beta';
      return {check_id:pair.check_id,record_id:record.record_id,relation:supported?'supports':'irrelevant',quotes:supported?[record.value.fact]:[],reason:supported?'Observed source value.':'Unrelated source.'};
    }))};
    else {const first=this.inputs.filter(item=>item.projection).length===1,ref=(checkId,id)=>input.observations.find(record=>record.evidence_ids.includes(id)).findings.find(finding=>finding.check_id===checkId).quote_refs[0];
      output={checks:[{id:'brief_format_verified',verdict:'supported',evidence_ids:['source_0'],evidence_quote_refs:[{evidence_id:'source_0',quote_ref:first?ref('readback_verified','source_8'):ref('brief_format_verified','source_0')}],reason:'Alpha observed.'},{id:'readback_verified',verdict:'supported',evidence_ids:['source_8'],evidence_quote_refs:[{evidence_id:'source_8',quote_ref:first?ref('readback_verified','source_8'):ref('brief_format_verified','source_0')}],reason:'Beta observed.'}]};
    }
    this.calls.push({purpose,provider:'contract_fixture',model:'fixture-verifier',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return output;
  }};
  const audits=[],verify=createWorkCompletionVerifier(provider,{audit:event=>audits.push(event)});
  const selected={...claim(ids),completed_checks:two.map(check=>({id:check.id,evidence_ids:ids}))};
  assert.equal(await verify(two,items,selected),false);
  assert.equal(provider.inputs.filter(input=>input.projection).length,2);
  assert.deepEqual(audits.filter(event=>event.code==='WORK_COMPLETION_BATCH_QUOTE_REF_INVALID').map(event=>event.issue.check_id),['brief_format_verified','readback_verified']);
  assert.equal(provider.inputs.some(input=>input.projection&&input.correction?.authority?.includes('replay')),true);
  assert.deepEqual(items,before,'Neither citation correction changes a receipt or dispatches another tool.');
});

test('runtime contract batch only evaluates each check against its originally allowed receipt IDs',async()=>{
  const items=observations(),two=[...checks,{id:'beta',result:'Report Beta.',evidence:'The Beta receipt.'}],ids=items.flatMap(item=>item.receipt.evidence_ids),provider={inputs:[],calls:[],async call(purpose,_instructions,input){
    this.inputs.push(structuredClone(input));let response;
    if(input.batch_index)response={findings:input.observations.flatMap(record=>input.checks.filter(check=>check.allowed_evidence_ids.some(id=>record.evidence_ids.includes(id))).map(check=>({check_id:check.id,record_id:record.record_id,relation:record.value.fact==='Alpha'||record.value.fact==='Beta'?'supports':'irrelevant',quotes:record.value.fact==='Alpha'||record.value.fact==='Beta'?[record.value.fact]:[],reason:'Exact observed value or irrelevant receipt.'})))};
    else {const ref=(checkId,evidenceId)=>input.observations.find(record=>record.evidence_ids.includes(evidenceId)).findings.find(finding=>finding.check_id===checkId).quote_refs[0];response={checks:[{id:'combined',verdict:'supported',evidence_ids:['source_0','source_8'],evidence_quote_refs:[{evidence_id:'source_0',quote_ref:ref('combined','source_0')},{evidence_id:'source_8',quote_ref:ref('combined','source_8')}],reason:'Both values observed.'},{id:'beta',verdict:'supported',evidence_ids:['source_8'],evidence_quote_refs:[{evidence_id:'source_8',quote_ref:ref('beta','source_8')}],reason:'Beta observed.'}]};}
    this.calls.push({purpose,provider:'contract_fixture',model:'fixture-verifier',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return response;
  }};
  const both={...claim(ids),completed_checks:[{id:'combined',evidence_ids:ids},{id:'beta',evidence_ids:['source_8']}]};
  assert.equal(await createWorkCompletionVerifier(provider)(two,items,both),true);
  for(const batch of provider.inputs.filter(input=>input.batch_index)){const betaPairs=batch.observations.filter(record=>record.evidence_ids.includes('source_8')).length;assert.equal(betaPairs<=1,true);}
});

test('runtime contract oversized evidence retains a host-sealed negative trace and cites its exact scoped statement',async t=>{
  const items=observations(),work_id='trace-work',run_id='trace-run',owner='trace-owner',project='trace-project',db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const checkpoint={format:1,work_id,run_id,binding:'a'.repeat(64),turn:items.length,pending:null,observations:items,summary:'Not evidence.'};
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  db.exec('CREATE TABLE swarm_activity(project_id TEXT,run_id TEXT,kind TEXT)');
  db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run(project,work_id,run_id,owner,Date.now()+60000,'running',0,JSON.stringify(checkpoint));
  const store={hermesState:db,intakeWork:()=>({revision:0}),officeWork:()=>({id:work_id}),swarmRun:()=>({snapshot:null})};
  const trace=createWorkRunTraceEvidence(store,project,{work_id,run_id,owner,checkpoint,observations:items,admission_closed:true,admission_checkpoint:null}),traceId=trace.receipt.evidence_ids[0];
  assert.equal(trace.receipt.value.closure,'closed');
  const check=[{id:'no_send',result:'This Office-controlled run dispatched no external-write capabilities.',evidence:'The host-closed controlled-run trace.'}];
  const provider={inputs:[],calls:[],async call(purpose,_instructions,input){this.inputs.push(structuredClone(input));let output;
    if(input.batch_index)output={findings:input.observations.flatMap(record=>input.checks.map(item=>({check_id:item.id,record_id:record.record_id,relation:record.tool_name==='office_controlled_run_trace'?'supports':'irrelevant',quotes:record.tool_name==='office_controlled_run_trace'?['This host-closed Office-controlled run dispatched 0 external_write capabilities through the bound checkpoint.']:[],reason:'Scoped host trace or unrelated source.'})))};
    else output={checks:[{id:'no_send',verdict:'supported',evidence_use:'controlled_run_constraint',evidence_ids:[traceId],evidence_quote_refs:[{evidence_id:traceId,quote_ref:input.observations.find(record=>record.evidence_ids.includes(traceId)).findings[0].quote_refs[0]}],reason:'The host trace is closed and scoped to this run.'}]};
    this.calls.push({purpose,provider:'contract_fixture',model:'fixture-verifier',status:'accepted',elapsed_ms:1,input_sha256:'a'.repeat(64),input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved'});return output;
  }};
  assert.equal(await createWorkCompletionVerifier(provider)(check,[...items,trace],{...claim([traceId]),completed_checks:[{id:'no_send',evidence_ids:[...items.flatMap(item=>item.receipt.evidence_ids),traceId]}]}),true);
  assert.ok(provider.inputs.filter(input=>input.batch_index).some(batch=>batch.observations.some(record=>record.tool_name==='office_controlled_run_trace')));
});
