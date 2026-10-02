import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createWorkCompletionVerifier,createWorkRunTraceEvidence,completionRiskTier} from '../dist/work/completion.js';

// A5 regression: verification strength follows the host-closed execution trace.
// Reads, drafts and Office-owned outputs get one compact judgment; anything with
// an external or non-Office write keeps the strict path. Fixture models only.
const work_id='tier-work',run_id='tier-run';
const at=turn=>`2026-10-01T00:00:${String(turn).padStart(2,'0')}.000Z`;
const right='Summary: Node.js 24 is the latest release.';
const source=turn=>({invocation:{request_id:`source-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url:'https://nodejs.org/en/blog',title:'Node.js blog',text:'Node.js 24 is the current release.\nMore'},evidence_ids:[`ev-source-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
const draft=turn=>({invocation:{request_id:'draft-1',turn,stage_id:'write',tool_name:'office_result_draft',arguments:{},effect:'local_write',dispatched:true},receipt:{status:'succeeded',value:{status:'succeeded',work_id,run_id,request_id:'draft-1',title:'Node release summary',text:right,artifact:{path:'/work-artifacts/draft-1.txt',sha256:'a'.repeat(64),bytes:right.length,format:'txt'},deduplicated:false,external_delivery:false},evidence_ids:['ev-draft-1'],effect_state:'verified',retry_safe:false},observed_at:at(turn)});
const write=(turn,tool_name,effect)=>({invocation:{request_id:`${tool_name}-${turn}`,turn,stage_id:'write',tool_name,arguments:{},effect,dispatched:true},receipt:{status:'succeeded',value:{status:'sent',summary:right},evidence_ids:[`ev-${tool_name}-${turn}`],effect_state:'verified',retry_safe:false},observed_at:at(turn)});
const checks=[{id:'summary_saved',result:'A summary naming the latest Node.js release is saved.',evidence:'The saved summary.'}];
const originalUserRequest={prompt:'Find the latest Node.js release and save a one-line summary.',completion_condition:null,delivery_target_ids:null,user_directions:[]};
const claimFor=ids=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'A claim, not evidence.',wait_reason:null,completed_checks:[{id:'summary_saved',evidence_ids:ids}]});

/** Seal the host trace exactly as the supervisor does: from the persisted checkpoint. */
function sealed(t,observations,{admission_closed=true}={}){
  const checkpoint={format:1,work_id,run_id,binding:'a'.repeat(64),turn:observations.length,pending:null,observations,summary:''};
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE office_supervisor(project_id TEXT,work_id TEXT,run_id TEXT,owner TEXT,lease_until_ms INTEGER,state TEXT,work_revision INTEGER,checkpoint TEXT)');
  db.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?,?,?,?,?)').run('p',work_id,run_id,'owner',Date.now()+60000,'running',0,JSON.stringify(checkpoint));
  return [...observations,createWorkRunTraceEvidence({hermesState:db,intakeWork:()=>({revision:0})},'p',{work_id,run_id,owner:'owner',checkpoint,observations,admission_closed})];
}

const isLight=instructions=>instructions.startsWith('Verify each completion check of an Office Work');
/** light(input) answers the compact judgment; strict answers by literal leaf refs. */
function fixture(light){
  const model={inputs:[],kinds:[],calls:[],async call(purpose,instructions,input){
    this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});this.inputs.push(structuredClone(input));
    if(isLight(instructions)){this.kinds.push('light');return light(input);}
    this.kinds.push('strict');
    return {checks:input.checks.map(check=>{
      const record=input.literal_leaf_manifest.find(item=>item.evidence_ids.includes('ev-draft-1'));
      return {id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],evidence_quote_refs:[{evidence_id:'ev-draft-1',quote_ref:record.leaf_refs.find(row=>row[1]==='$/text')[0]}],reason:'The saved summary names the latest release.'};
    })};
  }};
  return model;
}
const supported=(evidence_id='ev-draft-1',quote='Node.js 24 is the latest release')=>input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:[evidence_id],quotes:[{evidence_id,quote}],reason:'The saved summary names the latest release.'}))});

test('A5: the tier comes only from the host-closed trace, never from a declaration',t=>{
  assert.equal(completionRiskTier(sealed(t,[source(0),draft(1)])),'light','Reads and an Office result file.');
  assert.equal(completionRiskTier([source(0),draft(1)]),'strict','No trace: legacy and unit paths stay strict.');
  assert.equal(completionRiskTier(sealed(t,[source(0),draft(1)],{admission_closed:false})),'strict','An open trace cannot prove the absence of writes.');
  assert.equal(completionRiskTier(sealed(t,[source(0),write(1,'mail_send','external_write')])),'strict','An external write is always strict.');
  assert.equal(completionRiskTier(sealed(t,[source(0),write(1,'coding_apply_patch','local_write')])),'strict','A write outside Office-owned outputs is strict.');
  assert.equal(completionRiskTier(sealed(t,[source(0),write(1,'office_result_draft','external_write')])),'strict','The recorded effect decides, not the tool name.');
  const observations=sealed(t,[source(0),draft(1)]),tampered=[observations[0],{...observations[1],receipt:{...observations[1].receipt,value:{...observations[1].receipt.value,text:'Edited after sealing.'}}},observations[2]];
  assert.equal(completionRiskTier(tampered),'strict','Receipts changed after sealing break the binding.');
  const twice=sealed(t,[source(0),draft(1)]);
  assert.equal(completionRiskTier([...twice,twice.at(-1)]),'strict','Exactly one trace.');
});

test('A5: a read-and-draft Work is verified with exactly one compact model call',async t=>{
  const model=fixture(supported()),audits=[],progress=[];
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event),progress:event=>progress.push(event.summary)});
  assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claimFor(['ev-source-0','ev-draft-1'])),true,JSON.stringify(audits.map(event=>event.code)));
  assert.deepEqual(model.kinds,['light']);
  const input=model.inputs[0];
  assert.deepEqual(input.checks.map(check=>check.id),['summary_saved','original_user_request'],'The original request is judged in the same call.');
  assert.ok(input.evidence.some(item=>item.evidence_id==='ev-draft-1'&&item.content.endsWith(`\n${right}`)&&item.content.includes(`"sha256":"${'a'.repeat(64)}"`)&&item.content.includes('"request_id":"draft-1"')),'Office output text is shown directly after its saved-file identity.');
  assert.equal(Object.hasOwn(input,'literal_leaf_manifest'),false);
  assert.equal(audits.at(-1).code,'WORK_COMPLETION_LIGHT_VERIFIED');assert.equal(audits.at(-1).verifier,'light');
  assert.ok(progress.some(summary=>/light verification/iu.test(summary)));
});

// A7 regression: live answers quoted the receipt exactly as shown ("full_source_read":true)
// and asked for the saved file's identity; both sent every Office-output Work to strict.
test('A7: a light quote of a shown key and value or of the saved file identity is grounded; keys alone are not',async t=>{
  const cases={key_value:['ev-source-0','"title":"Node.js blog"',['light']],saved_identity:['ev-draft-1',`"bytes":${right.length}`,['light']],
    escaped_newline:['ev-source-0','release.\\nMore',['light']],
    key_only:['ev-source-0','"title":"',['light','strict']],run_metadata_only:['ev-draft-1','"request_id":"draft-1"',['light','strict']],
    metadata_beside_value:['ev-draft-1',['"request_id":"draft-1"','Node.js 24 is the latest release'],['light']]};
  for(const [name,[id,quote,kinds]] of Object.entries(cases)){
    const quotes=Array.isArray(quote)?quote:[quote];
    const model=fixture(input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:[id],quotes:quotes.map(text=>({evidence_id:id,quote:text})),reason:'Shown content.'}))})),audits=[];
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
    assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claimFor(['ev-source-0','ev-draft-1'])),true,`${name}: ${JSON.stringify(audits.map(event=>event.code))}`);
    assert.deepEqual(model.kinds,kinds,name);
    assert.equal(audits.some(event=>event.code==='WORK_COMPLETION_LIGHT_VERIFIED'),kinds.length===1,name);
  }
});

test('A5: a clear light denial is a denial, with its reason sent to the repair step',async t=>{
  const model=fixture(input=>({checks:input.checks.map(check=>check.id==='summary_saved'?{id:check.id,verdict:'unsupported',evidence_ids:['ev-draft-1'],quotes:[],reason:'The summary names release 24 but the request asked for the LTS line.'}:{id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],quotes:[{evidence_id:'ev-draft-1',quote:'Node.js 24'}],reason:'Saved.'})}));
  const audits=[],denials=[];
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event),denial:denial=>denials.push(denial)});
  assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claimFor(['ev-draft-1'])),false);
  assert.deepEqual(model.kinds,['light'],'No second model approval of a clear denial.');
  assert.equal(denials.length,1);assert.equal(denials[0].check_id,'summary_saved');assert.match(denials[0].reason,/LTS line/u);
  const rejected=audits.find(event=>event.status==='rejected');
  assert.equal(rejected.code,'WORK_COMPLETION_CHECK_NOT_SUPPORTED');assert.equal(rejected.verifier,'light');
  assert.equal(JSON.stringify(rejected).includes('LTS line'),false,'The audit keeps only the reason hash.');
});

test('A5: an undecided or ungrounded light answer falls back to the strict path',async t=>{
  const variants={
    unknown:input=>({checks:input.checks.map(check=>({id:check.id,verdict:'unknown',evidence_ids:[],quotes:[],reason:'Not enough content shown.'}))}),
    invented_quote:supported('ev-draft-1','Node.js 25 is the latest release'),
    trace_only_original:input=>({checks:input.checks.map(check=>{const id=check.id==='original_user_request'?input.evidence.find(item=>item.tool_name==='office_controlled_run_trace').evidence_id:'ev-draft-1';return {id:check.id,verdict:'supported',evidence_ids:[id],quotes:[{evidence_id:id,quote:check.id==='original_user_request'?'host-closed Office-controlled run':'Node.js 24'}],reason:'Observed.'};})}),
    bad_shape:()=>({verdict:'ok'}),
  };
  for(const [name,light] of Object.entries(variants)){
    const model=fixture(light),audits=[];
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
    assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claimFor(['ev-source-0','ev-draft-1'])),true,`${name}: ${JSON.stringify(audits.map(event=>event.code))}`);
    assert.deepEqual(model.kinds,['light','strict'],name);
    assert.equal(audits.some(event=>event.code==='WORK_COMPLETION_LIGHT_VERIFIED'),false,name);
    assert.equal(audits.at(-1).code,'WORK_COMPLETION_VERIFIED',name);
  }
});

// Live: one quote cited to the wrong receipt sent a correct result to four more verification calls.
test('A5: a real quote cited to the wrong receipt is moved to the receipt that shows it; a paraphrase beside it is not relied on',async t=>{
  for(const [name,light] of Object.entries({
    wrong_receipt:supported('ev-invented','Node.js 24'),
    paraphrase_beside_real:input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],quotes:[{evidence_id:'ev-draft-1',quote:'Node.js 24'},{evidence_id:'ev-draft-1',quote:'the newest long-term release, roughly speaking'}],reason:'Observed.'}))}),
  })){
    const model=fixture(light),audits=[];
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
    assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claimFor(['ev-source-0','ev-draft-1'])),true,name);
    assert.deepEqual(model.kinds,['light'],name);assert.equal(audits.at(-1).code,'WORK_COMPLETION_LIGHT_VERIFIED',name);
  }
});

test('A5: external writes and unsealed Works keep the strict path',async t=>{
  for(const [name,observations] of Object.entries({
    external_write:sealed(t,[source(0),draft(1),write(2,'mail_send','external_write')]),
    non_office_write:sealed(t,[source(0),draft(1),write(2,'coding_apply_patch','local_write')]),
    no_trace:[source(0),draft(1)],
  })){
    const model=fixture(supported()),audits=[];
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
    assert.equal(await verify(checks,observations,claimFor(['ev-draft-1'])),true,`${name}: ${JSON.stringify(audits.map(event=>event.code))}`);
    assert.deepEqual(model.kinds,['strict'],name);
  }
});

test('A5: structural gates stay in code on the light tier',async t=>{
  const pending={...draft(1),receipt:{...draft(1).receipt,effect_state:'uncertain'}};
  // An unverifiable write never reaches a sealed closed trace; the claim gates are checked here.
  for(const [name,claim] of Object.entries({
    unknown_evidence:claimFor(['ev-missing']),
    wrong_action:{...claimFor(['ev-draft-1']),action:'tool'},
  })){
    const model=fixture(supported());
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest});
    assert.equal(await verify(checks,sealed(t,[source(0),draft(1)]),claim),false,name);
    assert.equal(model.kinds.includes('light'),false,`${name}: a malformed claim is never sent to the light judgment.`);
  }
  assert.equal(completionRiskTier(sealed(t,[source(0),pending])),'strict','An uncertain write cannot be in a closed trace.');
});

test('A5: a supervised read-only Pack Work finishes with one light verification call',t=>supervisedLightRun(t,model=>model));

// A7 regression: the real configured model gives each role its own view. The
// verifier's calls must still reach the run's count (0 was reported live).
test('A7: verification calls through a configured model are counted for the run',async t=>{
  const {ConfiguredStructuredModel}=await import('../dist/onboarding/configured-model.js'),{join}=await import('node:path'),{tmpdir}=await import('node:os');
  await supervisedLightRun(t,fixture=>new ConfiguredStructuredModel(join(tmpdir(),'absent-models.json'),{},{subscription:()=>fixture,api:()=>{throw Error('PAID_API_MUST_NOT_RUN');}}));
});

async function supervisedLightRun(t,wrap){
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{setTimeout:delay}=await import('node:timers/promises');
  const {PackStore}=await import('../dist/packs/store.js'),{loadHostConfig}=await import('../dist/interface/config.js'),{WorkRuntime}=await import('../dist/work/runtime.js'),{WorkSupervisor}=await import('../dist/work/supervisor.js');
  const proposal={title:'자료 수집',desired_outcome:'원본 값을 확인한다',completion_checks:[{id:'records',result:'원본 제목 Observed source 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
  const recipe={version:1,family:'research.search',request:'자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
  const kinds=[],fixtureModel={calls:[],async call(purpose,instructions,input){
    this.calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
    if(instructions.startsWith('Define one durable'))return proposal;
    if(isLight(instructions)){kinds.push('light');return {checks:input.checks.map(check=>{const item=input.evidence.find(row=>row.tool_name==='runtime_pack_run'&&row.content.includes('Observed source'));return {id:check.id,verdict:'supported',evidence_ids:[item.evidence_id],quotes:[{evidence_id:item.evidence_id,quote:'Observed source'}],reason:'The observed title is present.'};})};}
    if(instructions.startsWith('Independently verify')){kinds.push('strict');return {checks:input.checks.map(check=>({id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'Strict path not expected.'}))};}
    const result=input.checkpoint.observations.find(item=>item.invocation.tool_name==='runtime_pack_run'&&item.receipt.status==='succeeded');
    if(result)return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source.',completed_checks:input.completion_checks.map(check=>({id:check.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null};
    return {action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the source.',completed_checks:[],wait_reason:null};
  }};
  const root=await mkdtemp(join(tmpdir(),'work-tier-')),host=join(root,'host.json');await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'tier-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath),model=wrap(fixtureModel);store.registerProject(config.project);
  const work=await new WorkRuntime(store,config,model).start({request_id:'tier',prompt:'자료를 확인해줘'});
  const supervisor=new WorkSupervisor(store,config,model,{auto_start:false,tick_ms:25});
  t.after(async()=>{await supervisor.close();store.close();await rm(root,{recursive:true,force:true});});
  supervisor.start(work.work_id,work.revision,true);supervisor.activate();
  let row;for(let i=0;i<200;i++){row=store.hermesState.prepare('SELECT * FROM office_supervisor WHERE work_id=?').get(work.work_id);if(row&&['succeeded','failed','awaiting_review'].includes(row.state))break;await delay(25);}
  assert.equal(row.state,'succeeded',row.reason);
  assert.deepEqual(kinds,['light'],'One compact judgment; no strict second approval of a read-only collection.');
  const activity=store.hermesState.prepare("SELECT summary FROM office_activity WHERE work_id=? AND kind='supervisor.verification.calls'").all(work.work_id).map(item=>item.summary);
  assert.ok(activity.some(summary=>new RegExp(`used ${kinds.length} model call`).test(summary)),JSON.stringify(activity));
}

// A7 live: five pages of one CSV feed pushed the light input over 40KB and the Work went straight to strict batches.
test('A7: an oversized light input is fitted by shortening the largest source receipts, never the result file',async t=>{
  const page=turn=>({invocation:{request_id:`page-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url:'https://example.org/feed.csv',title:'feed.csv',text:`row-${turn},`.repeat(1800),provenance:'http_text_resource',has_more:false},evidence_ids:[`ev-page-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
  const model=fixture(supported()),audits=[];
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  assert.equal(await verify(checks,sealed(t,[page(0),page(1),page(2),page(3),page(4),source(5),draft(6)]),claimFor(['ev-source-5','ev-draft-1'])),true,JSON.stringify(audits.map(event=>event.code)));
  assert.deepEqual(model.kinds,['light'],'The judgment is asked once instead of being skipped.');
  const input=model.inputs[0];assert.ok(Buffer.byteLength(JSON.stringify(input))<=90000);
  assert.ok(input.evidence.filter(item=>item.evidence_id.startsWith('ev-page-')).some(item=>item.truncated),'Large source pages are shortened and marked.');
  assert.ok(input.evidence.find(item=>item.evidence_id==='ev-draft-1').content.endsWith(right),'The result file is never shortened.');
});

// A7 live: a search page receipt was cut at 3000 characters before its links, so a check about the first result's
// URL could not be decided. A page read shows its address, title and first links ahead of its text.
test('A7: a page read is shown with its links before its text',async t=>{
  const search={invocation:{request_id:'search-0',turn:0,stage_id:'collect',tool_name:'office_web_search',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url:'https://www.bing.com/search?q=x',title:'x - Search',text:'filler '.repeat(900),links:[{text:'Node.js Releases',url:'https://nodejs.org/en/about/previous-releases'}],provenance:'live_browser_dom',requested_url:'https://www.bing.com/search?q=x',effect:'read_only'},evidence_ids:['ev-search-0'],effect_state:'none',retry_safe:true},observed_at:at(0)};
  const model=fixture(supported('ev-search-0','https://nodejs.org/en/about/previous-releases')),audits=[];
  const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event)});
  assert.equal(await verify(checks,sealed(t,[search,draft(1)]),claimFor(['ev-search-0','ev-draft-1'])),true,JSON.stringify(audits.map(event=>event.code)));
  assert.deepEqual(model.kinds,['light']);
  const shown=model.inputs[0].evidence.find(item=>item.evidence_id==='ev-search-0').content;
  assert.ok(shown.indexOf('previous-releases')<shown.indexOf('filler'),'Links come before the page text.');
});

// Live: a news digest that read sixty pages went to twenty-seven strict batches and nine minutes without a decision.
// Live: twenty pages shortened to fit one call left the verifier unable to compare summaries with their articles.
test('A7: the fast judgment compares the saved result with each page it names; a supported page is shown short and marked',async t=>{
  const page=(turn,url,body)=>({invocation:{request_id:`source-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{url},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url,title:`Title ${turn}`,text:body+' '+'filler '.repeat(900),links:[],provenance:'live_browser_dom',effect:'read_only',observed_at:at(turn)},evidence_ids:[`ev-source-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
  const report='News of 2026-10-01\n\n'+[0,1,2].map(i=>`${i+1}. Post ${i}\nSource: https://example.org/post-${i}\nSummary: Post ${i} says agents improved by ${i+10} percent.`).join('\n\n');
  const pages=[0,1,2].map(i=>page(i,`https://example.org/post-${i}`,`Post ${i} says agents improved by ${i+10} percent.`));
  const saved={...draft(3),receipt:{...draft(3).receipt,value:{...draft(3).receipt.value,text:report}}};
  const asked=[],jev={async systemOne(request){const record=request.state.record;asked.push(record);const choice=record.statement.includes('post-2')?'unknown':'supported';return {answers:{label:{type:'choice',choice,confidence:.97,probabilities:{supported:.01,not_supported:.01,unknown:.01,[choice]:.97}}}};}};
  const model=fixture(input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],quotes:[{evidence_id:'ev-draft-1',quote:'Post 1 says agents improved by 11 percent.'}],reason:'The saved report names its posts.'}))}));
  let counted=0;const notes=[],verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,fastJudgment:()=>jev,onPaidJudgment:calls=>{counted+=calls;},progress:event=>notes.push(event.summary)});
  assert.equal(await verify(checks,sealed(t,[...pages,saved]),claimFor(['ev-draft-1'])),true,JSON.stringify(notes));assert.deepEqual(model.kinds,['light']);
  assert.equal(asked.length,3);assert.equal(counted,3);assert.match(asked[0].statement,/Summary: Post 0 says/u);assert.doesNotMatch(asked[0].statement,/Post 1 says/u,'Each page is asked only about the block that names it.');
  const shown=id=>model.inputs[0].evidence.find(item=>item.evidence_id===id);
  assert.match(shown('ev-source-0').grounded_by_host,/supported/u);assert.equal(shown('ev-source-0').truncated,false);assert.ok(shown('ev-source-0').content.length<1700);
  assert.equal(shown('ev-source-2').grounded_by_host,undefined,'A page the fast judgment did not confirm is shown as before.');assert.ok(shown('ev-source-2').content.length>5000);
  assert.ok(notes.some(note=>/compared the saved result with 3 pages it names: 2 supported/u.test(note)));
});

// Owner direction 2026-10-02: single conditions are yes/no questions; the fast judgment answers them in parallel.
test('A7: checks the fast judgment answers yes are settled without the verifier model; the rest go to it alone',async t=>{
  const page=(turn,url,body)=>({invocation:{request_id:`source-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{url},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url,title:`Title ${turn}`,text:body,links:[],provenance:'live_browser_dom',effect:'read_only',observed_at:at(turn)},evidence_ids:[`ev-source-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn)});
  const report='News of 2026-10-01\n\n1. Post 0\nSource: https://example.org/post-0\nSummary: Post 0 says agents improved by 10 percent.';
  const saved={...draft(1),receipt:{...draft(1).receipt,value:{...draft(1).receipt.value,text:report}}},observed=()=>sealed(t,[page(0,'https://example.org/post-0','Post 0 says agents improved by 10 percent.'),saved]);
  const jevFor=doubt=>({asked:[],async systemOne(request){const record=request.state.record;this.asked.push(record);const choice=record.page_text?'supported':doubt(record.condition)?'unknown':'yes';const others=record.page_text?{supported:.01,not_supported:.01,unknown:.01}:{yes:.01,no:.01,unknown:.01};return {answers:{label:{type:'choice',choice,confidence:.97,probabilities:{...others,[choice]:.97}}}};}});
  {
    const jev=jevFor(()=>false),model=fixture(()=>{throw Error('The verifier model must not be asked.');}),audits=[],notes=[];let counted=0;
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,fastJudgment:()=>jev,onPaidJudgment:calls=>{counted+=calls;},audit:event=>audits.push(event),progress:event=>notes.push(event.summary)});
    assert.equal(await verify(checks,observed(),claimFor(['ev-draft-1'])),true,JSON.stringify(notes));assert.deepEqual(model.kinds,[]);
    const conditions=jev.asked.filter(record=>record.condition);assert.ok(conditions.length>=checks.length&&conditions.every(record=>record.saved_report===report&&/office_browser_read succeeded https:\/\/example\.org\/post-0/u.test(record.host_steps)));
    assert.equal(counted,1+conditions.length);assert.ok(audits.some(event=>event.verifier==='fast'&&event.code==='WORK_COMPLETION_FAST_JUDGMENT'&&event.checks.length===conditions.length));
  }
  {
    const doubted=checks[0].result,jev=jevFor(condition=>condition===doubted);
    const model=fixture(input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],quotes:[{evidence_id:'ev-draft-1',quote:'Post 0 says agents improved by 10 percent.'}],reason:'Shown in the saved report.'}))}));
    const verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,fastJudgment:()=>jev});
    assert.equal(await verify(checks,observed(),claimFor(['ev-draft-1'])),true);assert.deepEqual(model.kinds,['light']);
    assert.deepEqual(model.inputs[0].checks.map(check=>check.id),[checks[0].id],'Only the check the fast judgment left open reaches the verifier model.');
  }
});

test('A5: a wide run shows the verifier the reads its saved result rests on and lists the others; one light call decides',async t=>{
  const page=(turn,url,body)=>({invocation:{request_id:`source-${turn}`,turn,stage_id:'collect',tool_name:'office_browser_read',arguments:{url},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{url,title:`Title ${turn}`,text:body+' '+'filler '.repeat(900)},evidence_ids:[`ev-source-${turn}`],effect_state:'none',retry_safe:true},observed_at:at(turn%60)});
  // A long digest that names twelve of its sources, saved and read back in full.
  const digest='Digest of the sources read on 2026-10-01: 1. Post 3 — https://example.org/post-3 — agents improved. 2. Post 17 — https://example.org/post-17 — agents improved. '+[4,6,8,10,12,14,16,18,20,22].map(i=>`Post ${i} — https://example.org/post-${i}/ — agents improved.`).join(' ')+' Limits: '+'no author stated; '.repeat(520);
  const pages=Array.from({length:29},(_,i)=>page(i,`https://example.org/post-${i}${i%2?'':'/'}`,`Post ${i} says agents improved.`));
  const saved={...draft(29),receipt:{...draft(29).receipt,value:{...draft(29).receipt.value,text:digest}}};
  const readback={invocation:{request_id:'read-1',turn:30,stage_id:'write',tool_name:'office_result_read',arguments:{request_id:'draft-1'},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{status:'succeeded',request_id:'draft-1',text:digest,bytes:digest.length},evidence_ids:['ev-read-1'],effect_state:'none',retry_safe:true},observed_at:at(30)};
  const model=fixture(input=>({checks:input.checks.map(check=>({id:check.id,verdict:'supported',evidence_ids:['ev-draft-1'],quotes:[{evidence_id:'ev-draft-1',quote:'Post 17 — https://example.org/post-17'}],reason:'The saved digest names the posts and they are shown.'}))})),audits=[];
  const notes=[],verify=createWorkCompletionVerifier(model,{literalRefMode:true,originalUserRequest,audit:event=>audits.push(event),progress:event=>notes.push(event.summary)});
  const all=sealed(t,[...pages,saved,readback]),verdict=await verify(checks,all,claimFor(['ev-draft-1']));assert.equal(verdict,true,JSON.stringify({tier:completionRiskTier(all),kinds:model.kinds.slice(0,2),notes:notes.slice(0,3)}));
  assert.deepEqual(model.kinds,['light'],'Thirty-two receipts are decided by one call.');
  const input=model.inputs[0],shownIds=input.evidence.map(item=>item.evidence_id);
  assert.ok(shownIds.includes('ev-source-3')&&shownIds.includes('ev-source-17')&&shownIds.includes('ev-draft-1'));assert.ok(!shownIds.includes('ev-source-5'),'A read the result does not name is not shown in full.');
  assert.ok(input.other_reads_not_shown.length>=14&&input.other_reads_not_shown.some(item=>item.url==='https://example.org/post-5'));
  assert.ok(digest.length>9000);assert.match(input.evidence.find(item=>item.evidence_id==='ev-read-1').content,/identical to the saved result shown in ev-draft-1/u,'The readback does not repeat the 9 KB text.');
  assert.ok(Buffer.byteLength(JSON.stringify(input))<=90000);
});
