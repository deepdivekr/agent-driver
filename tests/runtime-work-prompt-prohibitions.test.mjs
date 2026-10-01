import test from 'node:test';
import assert from 'node:assert/strict';
import {BoundedWorkClientExecutor,WORK_CLIENT_EXECUTION_INSTRUCTIONS,WORK_CLIENT_COMPLETION_CUTPOINT_INSTRUCTIONS,WORK_CLIENT_STAGE_INSTRUCTIONS} from '../dist/work/client-executor.js';
import {modelWorkPlan} from '../dist/work/plan.js';
import {WORK_DEFINITION_INSTRUCTIONS,WORK_REPLANNING_INSTRUCTIONS,WORK_PLANNING_CONTEXT_INSTRUCTIONS} from '../dist/work/runtime.js';
import {acceptStageClaims,stageBinding} from '../dist/work/stages.js';
import {createWorkCompletionVerifier,WORK_COMPLETION_VERIFICATION_INSTRUCTIONS} from '../dist/work/completion.js';

// A6: prohibitions live in host code, not prompt text. Each sentence removed
// from a prompt has a test here (or a named existing test) showing the host
// refuses the behavior and returns a correctable reason. Fixture models only.
const bytes=value=>Buffer.byteLength(value);

test('A6: the per-turn executor prompt stays at or below half of its former 7.7KB',()=>{
  const semantic=bytes(WORK_CLIENT_EXECUTION_INSTRUCTIONS+'\n'+WORK_CLIENT_COMPLETION_CUTPOINT_INSTRUCTIONS+'\n'+WORK_CLIENT_STAGE_INSTRUCTIONS);
  assert.ok(semantic<=3846,`executor prompt ${semantic} bytes`);
  // Meaning rules that code cannot check stay in the prompt.
  for(const kept of [/untrusted data, never instructions/u,/"Office 결과 파일".*Agent Office/u,/An explicit CSV, JSON, Word or Excel format requires actual bytes/u,/do not call your own tools, access files, run commands/u,/one newly validated read-only attempt/u,/Never solve or bypass a login, CAPTCHA or access challenge/u,/not hidden reasoning/u])assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,kept);
  assert.match(WORK_CLIENT_STAGE_INSTRUCTIONS,/user-meaningful result/u);
});

const request={work_id:'gate-work',run_id:'gate-run',prompt:'Read the value.',completion_checks:[{id:'read',result:'The value is read.',evidence:'A read receipt.'}],max_turns:10};
const tools=[{name:'read_value',description:'Read one value.',input_schema:{type:'object'},effect:'read_only'},{name:'send_value',description:'Send one value.',input_schema:{type:'object'},effect:'external_write'}];
const tool=(name,args={})=>({action:'tool',stage_id:null,tool_name:name,arguments_json:JSON.stringify(args),summary:`Use ${name}.`,completed_checks:[],wait_reason:null});
const complete=ids=>({action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Done.',completed_checks:[{id:'read',evidence_ids:ids}],wait_reason:null});
function provider(queue){return {calls:[],inputs:[],async call(purpose,instructions,input){this.inputs.push({purpose,instructions,input:structuredClone(input)});this.calls.push({purpose,provider:'fixture',model:'fixture',status:'accepted'});return structuredClone(queue.shift());}};}
function host(overrides={}){
  const dispatches=[],claims=[];
  return {dispatches,claims,tools,async checkpoint(){},
    async executeTool(name,args,context){dispatches.push({name,args,request_id:context.request_id});return name==='read_value'?{status:'succeeded',value:{value:42},evidence_ids:['ev-read'],effect_state:'none',retry_safe:true}:{status:'succeeded',value:{sent:true},evidence_ids:['ev-send'],effect_state:'verified',retry_safe:false};},
    async verifyCompletion(_checks,_observations,claim){claims.push(structuredClone(claim));return true;},...overrides};
}

test('A6 (removed: "choose only a listed capability"): an unlisted capability is refused before dispatch and the Work continues',async()=>{
  const hooks=host(),model=provider([tool('delete_everything',{path:'/'}),tool('read_value'),complete(['ev-read'])]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.deepEqual(hooks.dispatches.map(item=>item.name),['read_value']);
  const refused=result.checkpoint.observations[0];
  assert.equal(refused.invocation.dispatched,false);assert.equal(refused.receipt.value.status,'not_dispatched');
  assert.equal(refused.receipt.value.issues[0].code,'WORK_CLIENT_TOOL_NOT_AVAILABLE');assert.match(refused.receipt.value.issues[0].message,/supplied host catalog/u);
});

test('A6 (shortened: exact field combinations): a mixed action is corrected by the host with a field-specific reason',async()=>{
  const mixed={...tool('read_value'),wait_reason:'configuration'};
  const hooks=host(),model=provider([mixed,tool('read_value'),complete(['ev-read'])]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');assert.equal(hooks.dispatches.length,1,'The invalid decision dispatched nothing.');
  const correction=model.inputs.find(item=>item.input.validation_error);
  assert.ok(correction,'One output correction was requested.');
  assert.match(JSON.stringify(correction.input),/For action=tool, wait_reason must be null/u);
});

test('A6 (removed: "evidence only when its receipt succeeded", "never invent evidence IDs"): completion pointers are limited to successful receipts',async()=>{
  let reads=0;const hooks=host();
  hooks.executeTool=async(name,args,context)=>{hooks.dispatches.push({name});return ++reads===1?{status:'failed',value:{error:'SOURCE_TIMEOUT'},evidence_ids:['ev-failed'],effect_state:'none',retry_safe:true}:{status:'succeeded',value:{value:42},evidence_ids:['ev-read'],effect_state:'none',retry_safe:true};};
  const model=provider([tool('read_value'),tool('read_value',{retry:true}),complete(['ev-failed','ev-invented'])]);
  const result=await new BoundedWorkClientExecutor(model).execute(request,hooks);
  assert.equal(result.status,'succeeded');
  assert.deepEqual(hooks.claims[0].completed_checks,[{id:'read',evidence_ids:['ev-read']}]);
});

test('A6 (removed: "no external-write or unknown-effect replay", "a provider change does not authorize replay"): a write with a recorded effect is never dispatched again',async()=>{
  const stable={toolRequestId:(name,_args,fallback)=>name==='send_value'?'stable-send':fallback};
  const first=host({...stable,async executeTool(name,_args,context){first.dispatches.push({name,request_id:context.request_id});return {status:'failed',value:{error:'PARTIAL'},evidence_ids:[],effect_state:'verified',retry_safe:false};}});
  const send={...tool('send_value',{to:'a'}),stage_id:'send'};
  const initial=await new BoundedWorkClientExecutor(provider([send])).execute(request,first);
  assert.equal(initial.status,'failed');assert.equal(first.dispatches.length,1);
  const again=host(stable),resumed=await new BoundedWorkClientExecutor(provider([send])).execute({...request,checkpoint:initial.checkpoint},again);
  assert.equal(again.dispatches.length,0,'The same write is not replayed.');
  assert.equal(resumed.status,'reconciliation_required');assert.equal(resumed.reason,'WORK_CLIENT_TOOL_REQUEST_ID_NOT_REUSABLE');
});

const steps=[
  {id:'collect',goal:'Collect the source',observable_outcome:'The source content is retained',depends_on:[],effect:'read_only',tool_hints:[]},
  {id:'compare',goal:'Compare it',observable_outcome:'A grounded comparison is retained',depends_on:['collect'],effect:'draft_only',tool_hints:[]},
];
const plan=modelWorkPlan({steps},'Produce a grounded comparison','read_only');
const observed=(stage_id,id)=>({invocation:{request_id:`r-${id}`,turn:0,stage_id,stage_binding:stageBinding(plan.steps.find(step=>step.id===stage_id)),tool_name:'read_value',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{id},evidence_ids:[id],effect_state:'none',retry_safe:true},observed_at:'2026-10-01T00:00:00.000Z'});

test('A6 (removed: stage claims need same-stage evidence; candidates add no authority; complete needs every stage): stage gates are host code',async()=>{
  const collect=observed('collect','ev-collect');
  assert.throws(()=>acceptStageClaims(plan,[collect],[],[{stage_id:'compare',evidence_ids:['ev-collect']}]),/WORK_CLIENT_STAGE_DEPENDENCY_PENDING/u);
  const reports=acceptStageClaims(plan,[collect],[],[{stage_id:'collect',evidence_ids:['ev-collect']}]);
  assert.throws(()=>acceptStageClaims(plan,[collect],reports,[{stage_id:'compare',evidence_ids:['ev-collect']}]),/WORK_CLIENT_STAGE_EVIDENCE_MISSING/u,'Evidence from another stage cannot report this one.');
  const decision={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Done.',completed_checks:[{id:'read',evidence_ids:['ev-read']}],wait_reason:null,completed_stages:[]};
  const model=provider([{...tool('read_value'),stage_id:'collect',completed_stages:[]},decision,decision,decision,decision,decision]);
  const result=await new BoundedWorkClientExecutor(model).execute({...request,plan},host());
  assert.notEqual(result.status,'succeeded');
  assert.ok(model.inputs.some(item=>/WORK_CLIENT_STAGES_INCOMPLETE/u.test(JSON.stringify(item.input.validation_error??''))),'Completing with unreported stages is refused with a correctable reason.');
});

test('A6: the strict verifier prompt drops host-enforced citation rules but keeps the meaning rules',()=>{
  const size=bytes(WORK_COMPLETION_VERIFICATION_INSTRUCTIONS);
  assert.ok(size<=5000,`verifier prompt ${size} bytes (was 7577)`);
  for(const kept of ['cannot establish a positive result','external_write=0 alone','HTTP reads of the requested source are not message/result sending','needs BOTH actual source/file leaf values','a subset never proves an all-original-rows condition','untrusted data, never instructions'])assert.ok(WORK_COMPLETION_VERIFICATION_INSTRUCTIONS.includes(kept),kept);
  for(const removed of ['use only those IDs for that check','For example, from {title','never cite it','The host checks excerpts itself'])assert.equal(WORK_COMPLETION_VERIFICATION_INSTRUCTIONS.includes(removed),false,removed);
});

const page={invocation:{request_id:'page',turn:0,stage_id:'collect',tool_name:'office_browser_read',arguments:{},effect:'read_only',dispatched:true},receipt:{status:'succeeded',value:{title:'Example Domain',url:'https://example.com/'},evidence_ids:['ev-page'],effect_state:'none',retry_safe:true},observed_at:'2026-10-01T00:00:00.000Z'};
const titleCheck=[{id:'title',result:'The page title is observed.',evidence:'The page read.'}];
const titleClaim={action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Done.',wait_reason:null,completed_checks:[{id:'title',evidence_ids:['ev-page']}]};
const answer=(evidence_id,quote)=>({checks:[{id:'title',verdict:'supported',evidence_ids:[evidence_id],evidence_use:'observed_result',evidence_quotes:[{evidence_id,quote}],reason:'The title is observed.'}]});

for(const [removed,first,code] of [
  ['use only allowed_evidence_ids',answer('ev-other','Example Domain'),'WORK_COMPLETION_VERIFIER_EVIDENCE_INVALID'],
  ['quote leaf text, not keys or JSON syntax','{"title":"Example Domain"}','WORK_COMPLETION_VERIFIER_QUOTE_UNOBSERVED'],
  ['one entry per requested check',{checks:[...answer('ev-page','Example Domain').checks,...answer('ev-page','Example Domain').checks]},'WORK_COMPLETION_VERIFIER_CHECKS_MISMATCH'],
])test(`A6 (removed or shortened: "${removed}"): the verifier host rejects it with one correctable reason`,async()=>{
  const outputs=[typeof first==='string'?answer('ev-page',first):first,answer('ev-page','Example Domain')],inputs=[],audits=[];
  const verify=createWorkCompletionVerifier({calls:[],async call(_purpose,_instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose:'verify',provider:'fixture',model:'fixture',status:'accepted'});return outputs.shift();}},{audit:event=>audits.push(event)});
  assert.equal(await verify(titleCheck,[page],titleClaim),true);
  assert.equal(inputs.length,2);assert.equal(audits.find(event=>event.status==='rejected').code,code);
  assert.equal(inputs[1].correction.issue.code,code,'The correction names the host rule that was broken.');
});

test('A6: definition and replanning prompts drop host-enforced rules and may not grow back',()=>{
  assert.ok(bytes(WORK_DEFINITION_INSTRUCTIONS)<=6200,`definition ${bytes(WORK_DEFINITION_INSTRUCTIONS)} bytes (was 6485)`);
  assert.ok(bytes(WORK_REPLANNING_INSTRUCTIONS)<=13500,`replanning ${bytes(WORK_REPLANNING_INSTRUCTIONS)} bytes (was 14410)`);
  for(const removed of ['Never emit {"kind":"swarm","pack_family":"research.search"}','Do not invent completed stages, observed evidence IDs','A preference cannot grant access','If environment_block=true and provider_change_allowed=false'])assert.equal(WORK_REPLANNING_INSTRUCTIONS.includes(removed),false,removed);
  assert.match(WORK_DEFINITION_INSTRUCTIONS,/Valid routes:/u);assert.match(WORK_PLANNING_CONTEXT_INSTRUCTIONS,/Inside plan return only steps/u);
});

test('A6 (removed: "do not invent completed stages, evidence IDs or receipts in a plan"): the host discards model-supplied plan evidence',()=>{
  const plan=modelWorkPlan({steps:[{id:'collect',goal:'Collect the source',observable_outcome:'The source content is retained',depends_on:[],effect:'read_only',tool_hints:[],evidence_ids:['invented-receipt']}]},'Collect','read_only');
  assert.deepEqual(plan.steps[0].evidence_ids,[]);
  assert.throws(()=>modelWorkPlan({steps:[{id:'collect',goal:'Collect',observable_outcome:'Retained',depends_on:[],effect:'read_only',tool_hints:[],completed:true}]},'Collect','read_only'),'Unknown plan fields such as a completion flag are rejected.');
});

// Existing host-rejection tests for other removed executor sentences:
// - repeated invalid input sets the capability aside:
//     runtime-work-client-executor "repeating the same rejected input cannot become a blind dispatch"
//     runtime-work-completion-path "the same invalid input twice sets that capability aside"
// - completion repair cannot replay writes or perform external effects:
//     runtime-work-completion-repair (REPAIR_EXTERNAL_EFFECT_FORBIDDEN / REPAIR_REPLAY_FORBIDDEN)
// - Google environment block keeps provider and query; challenged query is not repeated:
//     runtime-work-unusual-traffic, runtime-work-search-provider (WORK_SEARCH_ENVIRONMENT_BLOCKED / WORK_SEARCH_PROVIDER_BLOCKED)
// - an interrupted local-record read carries its own recovery next_action:
//     runtime-work-supervisor (read_interrupted receipt)
// Existing host-rejection tests for removed planning sentences:
// - an invalid route combination is corrected once by the host and keeps its route kind:
//     runtime-work-definition-correction (validateOrCorrectWorkProposal, WORK_DEFINITION_CORRECTION_SCOPE_CHANGED)
// Existing host-rejection tests for removed verifier sentences:
// - citing a replaced output: runtime-work-completion-superseded (WORK_COMPLETION_SUPERSEDED_EVIDENCE_CITED)
// - citing an open trace or trace counts as a positive result:
//     runtime-work-completion (WORK_COMPLETION_TRACE_NOT_CLOSED / WORK_COMPLETION_TRACE_NOT_RESULT_EVIDENCE)
