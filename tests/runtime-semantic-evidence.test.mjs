import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DecisionPlane} from '../dist/decision-plane/index.js';
import {SEMANTIC_DECISION_CATALOG,semanticDecisionProfile,semanticBatch} from '../dist/decision-plane/semantic.js';
import {replaySemanticCases} from '../dist/decision-plane/regression.js';
import {verifyEvidence} from '../dist/packs/evidence.js';
import {recipeSchema} from '../dist/packs/contracts.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {selectWorkReferences} from '../dist/work/reference-selection.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

function answer(question,value,confidence=.98){const keys=Object.keys(question.criteria);return {type:'choice',choice:value,confidence,probabilities:Object.fromEntries(keys.map(key=>[key,key===value?.toString()?1:0]))};}
function transport(pick,seen=[]){return {async systemOne(request){seen.push(request);return {model:'jev-fixture',answers:Object.fromEntries(Object.entries(request.questions).map(([key,question])=>[key,answer(question,pick(request.state.items[key],key,request))])),usage:{input_tokens:20,output_tokens:8}};}};}
function plane(provider,extra={}){return new DecisionPlane({catalog:SEMANTIC_DECISION_CATALOG,profile:semanticDecisionProfile(.9),primary:{id:'fixture',systemOne:(...args)=>provider.systemOne(...args)},...extra});}
const citation={id:'claim',kind:'citation',source_field:'source',claim_field:'claim',quote_field:'quote'};
const extraction={id:'field',kind:'extraction',source_field:'source',value_field:'value',quote_field:'quote',meaning:'Exit oxygen percentage'};
const literal={id:'copy',kind:'literal_copy',source_field:'source',value_field:'value'};
const row={id:'one',source:'Tickets are optional for this event.',claim:'A ticket is mandatory.',quote:'Tickets are optional'};
const item={id:'one',decision_id:'citation.support',question:'Does source support subject?',source:row.source,subject:row.claim,quote:row.quote};

test('runtime contract evidence exact missing quotes and literal copies do not call either model',async()=>{
  let providers=0;const get=async()=>{providers++;throw Error('must not load models');};
  const report=await verifyEvidence([{...row,quote:'Not in the source'}],[citation],get,'test');
  assert.equal(providers,0);assert.equal(report.receipts[0].status,'quote_missing');assert.equal(report.receipts[0].decision,null);
  const copy=await verifyEvidence([{source:'0 errors recorded',value:0}],[literal],get,'copy');
  assert.equal(copy.all_checks_passed,true);assert.equal(copy.receipts[0].semantic_verified,false);assert.equal(copy.receipts[0].status,'literal_match');
  const absent=await verifyEvidence([{source:null,value:0}],[literal],get,'absent');assert.equal(absent.receipts[0].quote_present,null);assert.equal(absent.all_checks_passed,false);
});

test('runtime contract evidence retains absent inputs and empty batches as unverified rather than invented zero or success',async()=>{
  const report=await verifyEvidence([{source:'x',claim:null,quote:'x'},{source:'x',claim:'y',quote:''}],[citation],async()=>({}),'missing');
  assert.deepEqual(report.receipts.map(value=>value.status),['unobserved','unobserved']);assert.equal(report.all_checks_passed,false);
  assert.equal((await verifyEvidence([],[citation],async()=>({}),'empty')).all_checks_passed,false);
});

test('runtime contract semantic batches name each state item explicitly and distinguish exact quote from entailment',async()=>{
  const seen=[],fake=transport(state=>state.subject==='A ticket is mandatory.'?'CONTRADICTED':'SUPPORTED',seen);
  const report=await verifyEvidence([row,{...row,claim:'No ticket needed.'}],[citation],async()=>({plane:plane(fake)}),'check');
  assert.equal(seen.length,1);assert.equal(Object.keys(seen[0].questions).length,2);
  for(const key of Object.keys(seen[0].questions))assert.match(seen[0].questions[key].instructions.question,new RegExp(`items.${key}`));
  assert.deepEqual(report.receipts.map(value=>value.status),['contradicted','supported']);assert.equal(report.all_checks_passed,false);
});

test('runtime contract questionable extraction checks field meaning even when the number occurs in the source',async()=>{
  const seen=[],report=await verifyEvidence([{source:'Inlet 8.2%; exit 11.4%.',value:8.2,quote:'Inlet 8.2%'}],[extraction],async()=>({plane:plane(transport(()=> 'CONTRADICTED',seen))}),'extract');
  assert.match(seen[0].questions.item_0.instructions.question,/Exit oxygen percentage/);assert.equal(report.receipts[0].quote_present,true);assert.equal(report.receipts[0].status,'contradicted');
});

test('runtime contract Jev uncertain answers use one bounded grounded LLM correction batch',async()=>{
  const seen=[],fake=transport(()=> 'UNKNOWN',seen);let corrections=0;
  const llm={calls:[],async call(_purpose,_instruction,input){corrections++;return {answers:input.items.map(value=>({id:value.key,value:'CONTRADICTED',evidence_quote:'Tickets are optional'}))};}};
  const report=await verifyEvidence([row,row],[citation],async()=>({plane:plane(fake),llm}),'fallback');
  assert.equal(seen.length,1);assert.equal(corrections,1);assert.ok(report.receipts.every(value=>value.decision.decider==='llm'&&value.decision.confidence===null));
});

test('runtime contract malformed, duplicate or fabricated LLM corrections never become verified evidence',async()=>{
  for(const mode of ['quote','duplicate','foreign-option']){
    const llm={calls:[],async call(_p,_i,input){return {answers:input.items.map((value,index)=>({id:mode==='duplicate'?'item_0':value.key,value:mode==='foreign-option'?'KEEP':'SUPPORTED',evidence_quote:mode==='quote'?'made up':'Tickets are optional'}))};}};
    const report=await verifyEvidence([row,row],[citation],async()=>({llm}),'invalid');
    assert.equal(report.all_checks_passed,false);assert.ok(report.receipts.every(value=>value.status==='review'&&value.decision.reason==='LLM_CORRECTION_INVALID'));
  }
});

test('runtime contract provider outage falls back to LLM, and unavailable models remain review',async()=>{
  const failing=plane({async systemOne(){throw Error('network');}}),llm={calls:[],async call(){return {answers:[{id:'item_0',value:'CONTRADICTED',evidence_quote:'optional'}]};}};
  assert.equal((await semanticBatch([item],{plane:failing,llm},'outage'))[0].decider,'llm');
  const noModel=(await semanticBatch([item],{},'off'))[0];assert.equal(noModel.value,'UNKNOWN');assert.equal(noModel.reason,'NOT_CONFIGURED');
});

test('runtime contract secret-like source text is not uploaded and filtering preserves question-to-row identity',async()=>{
  const seen=[],sensitive={...item,id:'secret',source:'Password='+['sensitive','example'].join('')};
  const result=await semanticBatch([sensitive,{...item,id:'safe'}],{plane:plane(transport(()=> 'CONTRADICTED',seen))},'private');
  assert.equal(result[0].reason,'REDACTION_REQUIRED');assert.equal(result[1].value,'CONTRADICTED');assert.deepEqual(Object.keys(seen[0].questions),['item_1']);assert.ok(!JSON.stringify(seen).includes('sensitiveexample'));
});

test('runtime contract invalid distributions, foreign labels and high-confidence shadow conflicts do not bypass correction',async()=>{
  for(const bad of [{type:'choice',choice:'SUPPORTED',confidence:1,probabilities:{SUPPORTED:1}}, {type:'choice',choice:'UNAUTHORIZED',confidence:1,probabilities:{SUPPORTED:1,UNSUPPORTED:0,CONTRADICTED:0,UNKNOWN:0}}]){
    const decision=(await semanticBatch([item],{plane:plane({async systemOne(){return {answers:{item_0:bad}};}})},'bad'))[0];assert.equal(decision.value,'UNKNOWN');assert.equal(decision.reason,'INVALID_TYPED_ANSWER');
  }
  const shadow=transport(()=> 'CONTRADICTED'),primary=transport(()=> 'SUPPORTED');
  const decision=(await semanticBatch([item],{plane:plane(primary,{shadow:{id:'shadow',systemOne:(...args)=>shadow.systemOne(...args)},shadow_sample_rate:1})},'shadow'))[0];assert.equal(decision.value,'UNKNOWN');assert.equal(decision.decider,'none');
});

test('runtime contract semantic inputs and call counts are bounded without clipping away negation',async()=>{
  const seen=[];const report=await verifyEvidence(Array.from({length:25},(_,index)=>({...row,id:String(index)})),[citation],async()=>({plane:plane(transport(()=> 'SUPPORTED',seen))}),'bounded');
  assert.equal(seen.length,3);assert.equal(report.receipts.length,25);assert.deepEqual(seen.map(value=>Object.keys(value.questions).length),[12,12,1]);
  await assert.rejects(verifyEvidence(Array(201).fill(row),[citation],async()=>({}),'oversize'),/EVIDENCE_CHECK_LIMIT/);
  await assert.rejects(semanticBatch(Array(13).fill(item),{},'oversize'),/SEMANTIC_BATCH_INVALID/);
});

test('runtime contract reference selection returns only recorded verbatim IDs within a UTF-8 byte budget',async()=>{
  const refs=[{id:'export',source:'1',text:'내보내기 확인 절차'.repeat(100),trust:'unverified_external'},{id:'noise',source:'2',text:'logo color',trust:'unverified_external'}];
  const seen=[],get=async()=>({plane:plane(transport(state=>state.source.includes('logo')?'SKIP':'KEEP',seen))});
  const small=await selectWorkReferences(refs,{focus:'내보내기',max_references:2,max_bytes:256},get,'context');assert.equal(small.status,'review');assert.deepEqual(small.selected_ids,[]);
  const enough=await selectWorkReferences(refs,{focus:'내보내기',max_references:2,max_bytes:8000},get,'context2');assert.deepEqual(enough.selected_ids,['export']);assert.equal(enough.selected_bytes,Buffer.byteLength(refs[0].text));assert.equal(enough.mandatory_context_pruned,false);assert.equal(enough.token_savings,'unobserved');
});

test('runtime contract reference selection checks at most 24 candidates and stops if input binding changes',async()=>{
  const refs=Array.from({length:100},(_,index)=>({id:`ref${index}`,source:'observed',text:`Record ${index}`,trust:'unverified_external'})),seen=[];
  const report=await selectWorkReferences(refs,{focus:'Record',max_references:3,max_bytes:2000},async()=>({plane:plane(transport(()=> 'KEEP',seen))}),'bounded');
  assert.equal(seen.length,2);assert.equal(report.shortlisted,24);assert.equal(report.selected_ids.length,3);assert.equal(report.omitted,97);
  let guards=0;await assert.rejects(selectWorkReferences(refs,{focus:'Record',max_references:3,max_bytes:2000},async()=>({}), 'stale',()=>{if(++guards===2)throw Error('WORK_CONTEXT_CHANGED');}),/WORK_CONTEXT_CHANGED/);
});

test('runtime contract semantic regression flags confidently wrong decisions and outages without promoting calibration',async()=>{
  const cases=JSON.parse(await readFile(new URL('./fixtures/semantic-evidence-regression.json',import.meta.url),'utf8'));
  const fixture=transport(state=>cases.find(value=>value.item.source===state.source&&value.item.subject===state.subject).expected);
  const replay=await replaySemanticCases(cases,{plane:plane(fixture)},'contract_fake');assert.equal(replay.status,'PASS');assert.equal(replay.results.length,10);assert.equal(replay.live_accuracy,'unmeasured');assert.equal(replay.calibration_changed,false);
  const broken=await replaySemanticCases(cases,{plane:plane(transport(()=> 'SUPPORTED'))},'contract_fake');assert.equal(broken.status,'FAIL');assert.ok(broken.results.some(value=>value.status==='FAIL'&&value.confidence===.98));
  const offline=await replaySemanticCases(cases,{},'contract_fake');assert.equal(offline.status,'BLOCKED_ENV');assert.ok(offline.results.every(value=>value.status==='BLOCKED_ENV'));
});

async function setup(t,{models='jev_llm',approved=true,rows=[row]}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-semantic-')),path=join(root,'host.json');let api;
  t.after(async()=>{if(api){api.close();await api.drain();}await rm(root,{recursive:true,force:true});});
  await writeFile(join(root,'source.json'),JSON.stringify(rows));
  await writeFile(path,JSON.stringify({schema_version:1,project_id:'semantic-test',caller_ref:'agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{models,confidence:.9,model_data_approved:approved,sources:[{id:'source',kind:'file',path:'source.json',format:'json'}],targets:[]}}));
  const config=loadHostConfig(path);api=new RuntimeApi(config,{swarmModel:{calls:[],async call(){throw Error('fixture LLM not installed');}}});return {root,path,config,api};
}
const collectRecipe=(family='portal.collect')=>({version:1,family,request:'Check collected evidence.',sources:[{id:'source',parameters:{}}],filters:[],deduplicate_by:[],verification:[citation],...(family==='research.search'?{query:'',search_fields:['claim'],sort:null,limit:10}:family==='file.pipeline'?{format:'json',columns:['id','claim'],numeric_columns:[],sort:null}:{format:'json'})});

test('runtime fixture all three evidence Pack paths report review and preserve raw records instead of silently dropping contradictions',async t=>{
  const x=await setup(t),seen=[];x.api.packs.providers.jev=transport(()=> 'CONTRADICTED',seen);
  for(const [index,family]of ['research.search','portal.collect','file.pipeline'].entries()){
    const result=await x.api.call('runtime_pack_run',{request_id:`check${index}`,recipe:collectRecipe(family)});
    assert.equal(result.status,'needs_review');assert.equal(result.result.verification.receipts[0].status,'contradicted');
    const rows=result.result.rows??JSON.parse(await readFile(result.result.artifact.path,'utf8'));assert.equal(rows[0].claim,row.claim);
    const duplicate=await x.api.call('runtime_pack_run',{request_id:`check${index}`,recipe:collectRecipe(family)});assert.equal(duplicate.deduplicated,true);
  }
  assert.equal(seen.length,3);const status=await x.api.call('runtime_decision_status',{});assert.equal(status.decisions.find(value=>value.catalog_id==='pack.semantic').events,3);
  const journal=await readFile(join(x.root,'data','decisions','semantic.jsonl'),'utf8');assert.ok(!journal.includes(row.source));
});

test('runtime fixture absent verification and literal-only recipes never load models, and schema rejects duplicate check IDs',async t=>{
  const x=await setup(t,{models:'off',approved:false,rows:[{source:'zero 0',value:0}]});let calls=0;x.api.packs.providers.jev={async systemOne(){calls++;throw Error('must not run');}};
  const plain=collectRecipe();delete plain.verification;assert.equal((await x.api.call('runtime_pack_run',{request_id:'plain',recipe:plain})).status,'succeeded');
  assert.equal((await x.api.call('runtime_pack_run',{request_id:'literal',recipe:{...plain,verification:[literal]}})).status,'succeeded');assert.equal(calls,0);
  assert.equal(recipeSchema.safeParse({...plain,verification:[citation,citation]}).success,false);
});

test('runtime fixture missing model-data consent does not upload records',async t=>{
  await assert.rejects(setup(t,{approved:false}),/MODEL_DATA_APPROVAL_REQUIRED/);
});

function importedDraft(){return {format:1,source:{platform:'other',name:'Example',reference:null},title:{value:'Export',evidence_ids:['title']},goal:{value:'Export rows',evidence_ids:['goal']},trigger:{kind:'unknown',rule:null,timezone:null,evidence_ids:[]},steps:[{id:'collect',goal:'Export rows',depends_on:[],tool_hints:['file'],effect:'read_only',evidence_ids:['goal']}],completion:[{id:'saved',result:'Exported file',proof:'File receipt',evidence_ids:['goal']}],delivery:{channel:'file',target:null,evidence_ids:['goal']},dependencies:[],approval_boundary:{value:null,evidence_ids:[]},unknowns:[],evidence:[{id:'title',source_ref:'title',quote:'Export'},{id:'goal',source_ref:'instructions',quote:'Export rows. Verify file receipt before retrying.'},{id:'noise',source_ref:'style',quote:'The logo is a green circle.'}]};}
async function imported(x){const draft=await x.api.call('runtime_work_import_paste',{text:JSON.stringify(importedDraft())});return x.api.imports.accept({import_id:draft.import_id});}

test('runtime fixture Work context uses recorded references and preserves core, untrusted provenance and opt-out via LLM',async t=>{
  const x=await setup(t),work=await imported(x);let jev=0,llm=0;x.api.packs.providers.jev={async systemOne(){jev++;throw Error('explicit Work OFF');}};
  x.api.packs.providers.llm={calls:[],async call(_p,_i,input){llm++;return {answers:input.items.map(value=>({id:value.key,value:value.source.startsWith('Export rows')?'KEEP':'SKIP',evidence_quote:value.source}))};}};
  const explicit=await x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',reference_ids:['goal']});assert.equal(jev+llm,0);
  const selected=await x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',selection:{focus:'Export rows'}});
  assert.equal(jev,0);assert.equal(llm,1);assert.deepEqual(selected.capsule.core,explicit.capsule.core);assert.deepEqual(selected.selected_references,explicit.selected_references);assert.equal(selected.selected_references[0].trust,'unverified_external');assert.equal(selected.selection.token_savings,'unobserved');
  assert.equal(selected.selection.evidence,undefined);assert.equal(selected.selection.uncertain_references,0);
  await assert.rejects(x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',reference_ids:['goal'],selection:{focus:'Export'}}));
  await assert.rejects(x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',run_id:'11111111-1111-4111-8111-111111111111',selection:{focus:'Export'}}),/WORK_CONTEXT_RUN_MISMATCH/);assert.equal(llm,1);
});

test('runtime fixture global Jev OFF is respected by evidence checks while saved LLM path remains available',async t=>{
  const x=await setup(t);saveModelSettings(modelSettingsPath(x.config),{revision:0,onboarding_step:2,selection:{mode:'subscription',client:'auto',jev:'off',api_model:'fixture',reasoning:'low'}},{});let jev=0;
  x.api.packs.providers.jev={async systemOne(){jev++;throw Error('off');}};x.api.packs.providers.llm={calls:[],async call(){return {answers:[{id:'item_0',value:'CONTRADICTED',evidence_quote:'Tickets are optional'}]};}};
  const result=await x.api.call('runtime_pack_run',{request_id:'jev-off',recipe:collectRecipe()});assert.equal(jev,0);assert.equal(result.result.verification.receipts[0].decision.decider,'llm');
});

test('runtime fixture Work context discards a selection if user instructions change during judgment',async t=>{
  const x=await setup(t),work=await imported(x);
  x.api.packs.providers.llm={calls:[],async call(_p,_i,input){const current=x.api.store.intakeWork(x.config.project.id,work.work_id);x.api.store.setIntakePaused(x.config.project.id,work.work_id,current.revision,true);return {answers:input.items.map(value=>({id:value.key,value:'KEEP',evidence_quote:value.source}))};}};
  await assert.rejects(x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',selection:{focus:'Export'}}),/WORK_CONTEXT_CHANGED/);
  assert.equal(x.api.store.workContextDeliveries(x.config.project.id,work.work_id).length,0);
});

test('runtime fixture changed evidence Work does not export or reuse the stale recipe, and a fresh request can proceed',async t=>{
  const x=await setup(t);x.api.work.model.call=async()=>({title:'Check evidence',desired_outcome:'Export rows with verification',completion_checks:[{id:'file',result:'Exported records',evidence:'Saved file receipt'}],assumptions:[],route:{kind:'pack',pack_family:'portal.collect'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]});
  const work=await x.api.call('runtime_work_start',{request_id:'pause-check',prompt:'Export rows with verification'});assert.equal(work.status,'ready');
  x.api.packs.providers.jev={async systemOne(request){const current=x.api.store.intakeWork(x.config.project.id,work.work_id);x.api.store.setWorkJev(x.config.project.id,work.work_id,current.revision,true,true);return transport(()=> 'SUPPORTED').systemOne(request);}};
  const stale=await x.api.call('runtime_pack_run',{request_id:'pause-check',work_id:work.work_id,recipe:collectRecipe()});assert.equal(stale.status,'needs_replan');assert.equal(stale.next_action,'read_updated_work_then_create_new_recipe');await assert.rejects(access(join(x.root,'data','pack-artifacts',`${stale.run_id}.json`)));
  x.api.packs.providers.jev=transport(()=> 'SUPPORTED');
  const duplicate=await x.api.call('runtime_pack_run',{request_id:'pause-check',work_id:work.work_id,recipe:collectRecipe()});assert.equal(duplicate.deduplicated,true);assert.equal(duplicate.status,'needs_replan');
  const resumed=await x.api.call('runtime_pack_run',{request_id:'fresh-check',work_id:work.work_id,recipe:collectRecipe()});assert.notEqual(resumed.run_id,stale.run_id);assert.equal(resumed.status,'succeeded');assert.equal(JSON.parse(await readFile(resumed.result.artifact.path,'utf8')).length,1);
});

test('runtime fixture model policy OFF leaves optional context selection uncertain without any injected provider call',async t=>{
  const x=await setup(t,{models:'off',approved:false}),work=await imported(x);let calls=0;
  x.api.packs.providers.jev={async systemOne(){calls++;throw Error('must not run');}};x.api.packs.providers.llm={calls:[],async call(){calls++;throw Error('must not run');}};
  const context=await x.api.call('runtime_work_context',{work_id:work.work_id,actor:'test',selection:{focus:'Export'}});assert.equal(calls,0);assert.equal(context.selection.status,'review');assert.deepEqual(context.selected_references,[]);assert.ok(context.capsule.core.completion_checks.length);
});

test('runtime native MCP advertises semantic recipe and context options without changing execution authority',async t=>{
  const x=await setup(t,{models:'off',approved:false}),client=new Client({name:'semantic-contract',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp','--config',x.path],stderr:'pipe'});
  try{
    await client.connect(transport);const catalog=await client.listTools();assert.ok(catalog.tools.find(item=>item.name==='runtime_work_context').inputSchema.properties.selection);
    assert.match(JSON.stringify(catalog.tools.find(item=>item.name==='runtime_pack_run').inputSchema),/verification/);
    const result=await client.callTool({name:'runtime_decision_status',arguments:{}}),status=JSON.parse(result.content.find(item=>item.type==='text').text);assert.equal(status.mutation_allowed,false);assert.ok(status.decisions.some(item=>item.catalog_id==='pack.semantic'));
  }finally{await client.close();}
});
