import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {adaptiveSpecSchema,obtainAdaptiveSpec,promoteAdaptiveSpec,hashJson,validateAdaptiveSpec,adaptiveLlmFromHostEnvironment} from '../dist/taskpack/adaptive-spec.js';
import {compileAdaptiveRequest,decodeAdaptiveDecision,validateAdaptiveAction,decideAdaptiveStep,modelObservation} from '../dist/taskpack/adaptive-decision.js';
import {startModelConnectionScreen} from '../dist/onboarding/model-screen.js';
import {AdaptiveBrowser,assertReadOnlyControl} from '../dist/taskpack/adaptive-browser.js';
import {runAdaptivePack} from '../dist/taskpack/adaptive-runner.js';
import {ADAPTIVE_TRAVEL_TARGETS,verifyBookingReadback,adaptiveTravelTask,googleRouteMatches} from '../dist/taskpacks/adaptive-travel.js';

const task={request:'Find Tokyo 5-star hotels, 2 adults for 5 nights.',start_url:'https://example.test/search',allowed_origins:['https://example.test']};
const spec={states:[{id:'search',meaning:'Search fields are visible.'},{id:'results',meaning:'Requested matching results are visible.'}],operation_rules:['Dismiss a blocking welcome popup before filling fields.','Set the destination and hotel classification, then search.'],click_target:'If clicking, close the welcome popup or submit the filled search.',fill_target:'If filling, select the missing destination field.',select_target:'If selecting, set the hotel classification to 5 stars.',values:[{id:'city',meaning:'Destination city',value:'Tokyo',source_quote:'Tokyo'}],completion_rules:['Destination Tokyo and 5-star hotel classification applied; visible matching results.'],recovery_rules:['Reobserve changed targets and correct unapplied filters.']};
const element={id:'e1',label:'Search',role:'button',tag:'button',value:'',href:'',operations:['CLICK'],options:[],checked:null,signature:'fixture'};
const snapshot={id:'s1',url:task.start_url,title:'Search',text:'Search hotels',elements:[element,{...element,id:'e2',label:'Destination',tag:'input',role:'text',operations:['CLICK','FILL']}],truncated:false,observed_at:'2026-09-21T00:00:00Z',fingerprint:'fixture'};
const answersFor=(request,selected={})=>({model:'fixture-model',answers:Object.fromEntries(Object.entries(request.questions).map(([id,q])=>{
  if(q.type==='noul')return [id,{type:'noul',noul:1}];
  const ids=Object.keys(q.criteria),value=selected[id]??ids[0];
  return [id,{type:'choice',choice:value,confidence:1,probabilities:Object.fromEntries(ids.map(key=>[key,key===value?1:0]))}];
}))});
function modelFixture(correct){const calls=[];return {calls,async call(purpose,_instructions,input){calls.push({purpose,model:'fixture-model',elapsed_ms:0,input_sha256:'fixture',status:'accepted'});return purpose==='correct'?correct(input):structuredClone(spec);}};}

test('runtime contract adaptive specification caches matching request scope and rejects tampering or ungrounded values',async t=>{
  const root=await mkdtemp(join(tmpdir(),'adaptive-spec-'));t.after(()=>rm(root,{recursive:true,force:true}));const model=modelFixture();
  const first=await obtainAdaptiveSpec(task,snapshot,model,root),draft=await obtainAdaptiveSpec(task,{...snapshot,id:'fresh'},model,root);
  assert.equal(draft.cache_hit,false);await promoteAdaptiveSpec(draft.path,draft.binding,hashJson(draft.spec));
  const second=await obtainAdaptiveSpec(task,{...snapshot,id:'fresh'},model,root);
  assert.equal(first.cache_hit,false);assert.equal(second.cache_hit,true);assert.equal(model.calls.length,2);
  const other=await obtainAdaptiveSpec({...task,request:`${task.request} Compare prices.`},snapshot,model,root);assert.notEqual(first.binding,other.binding);
  const stored=JSON.parse(await readFile(second.path,'utf8'));stored.spec.click_target='Modified';await writeFile(second.path,JSON.stringify(stored));
  await assert.rejects(obtainAdaptiveSpec(task,snapshot,model,root),/SPEC_CACHE_INVALID/);
  assert.throws(()=>validateAdaptiveSpec({...spec,values:[{...spec.values[0],source_quote:'Osaka'}]},task),/SPEC_VALUE_SOURCE_MISSING/);
  assert.throws(()=>adaptiveSpecSchema.parse({...spec,allowed_origins:['https://untrusted.test']}));
});

test('runtime contract adaptive provider observation removes session URL fields and local execution signatures',()=>{
  const observed=modelObservation({...snapshot,url:'https://example.test/?sid=private&city=Tokyo',elements:[{...element,signature:'local-only',href:'https://example.test/hotel?token=private&hotel=1'}]});
  assert.equal(JSON.stringify(observed).includes('private'),false);assert.equal(JSON.stringify(observed).includes('local-only'),false);assert.match(observed.elements[0].href,/hotel=1/);
});

test('runtime contract local model connection requires same origin and a single-use form, and returns secrets only in memory',async t=>{
  const screen=await startModelConnectionScreen(10000);t.after(()=>screen.close());
  const page=await (await fetch(screen.url)).text(),token=page.match(/name="token" value="([a-f0-9]+)"/u)?.[1];assert.ok(token);
  const data=new URLSearchParams({token,jev:'fixture-jev-key-not-live',llm:'fixture-openai-key-not-live'});
  const bad=await fetch(new URL('/connect',screen.url),{method:'POST',headers:{origin:'https://untrusted.test'},body:data});assert.equal(bad.status,403);
  const good=await fetch(new URL('/connect',screen.url),{method:'POST',headers:{origin:new URL(screen.url).origin},body:data});assert.equal(good.status,200);assert.equal((await good.text()).includes('fixture-jev-key'),false);
  const environment=await screen.connected;assert.equal(environment.TYPESAFE_API_KEY,'fixture-jev-key-not-live');
  const duplicate=await fetch(new URL('/connect',screen.url),{method:'POST',headers:{origin:new URL(screen.url).origin},body:data});assert.equal(duplicate.status,404);
});

test('runtime contract adaptive Jev batches operation and targets while ignoring invalid unused heads',()=>{
  const compiled=compileAdaptiveRequest(task,spec,snapshot,[]),raw=answersFor(compiled.request,{state:'search',operation:'CLICK',CLICK_target:'e1'});
  assert.ok(compiled.request.questions.FILL_target);assert.ok(compiled.request.questions.value_e2);
  assert.deepEqual(compiled.request.state.policy.priorities,spec.operation_rules);
  raw.answers.FILL_target={invalid:true};raw.answers.value_e2={invalid:true};
  const action=decodeAdaptiveDecision(raw,compiled,snapshot,spec);assert.equal(action.operation,'CLICK');assert.equal(action.target_id,'e1');assert.equal(action.value_id,null);
  raw.answers.CLICK_target.choice='not_observed';assert.throws(()=>decodeAdaptiveDecision(raw,compiled,snapshot,spec),/INVALID_ADAPTIVE_CHOICE/);
});

test('runtime contract adaptive selected fill head and option binding cannot be invented or used after a new observation',()=>{
  const compiled=compileAdaptiveRequest(task,spec,snapshot,[]),raw=answersFor(compiled.request,{state:'search',operation:'FILL',FILL_target:'e2',value_e2:'city'});
  const action=decodeAdaptiveDecision(raw,compiled,snapshot,spec);assert.equal(action.value_id,'city');
  assert.throws(()=>validateAdaptiveAction(action,spec,{...snapshot,id:'new'}),/ADAPTIVE_STALE_SNAPSHOT/);
  assert.throws(()=>validateAdaptiveAction({...action,value_id:'invented'},spec,snapshot),/ADAPTIVE_VALUE_NOT_OFFERED/);
  raw.answers.value_e2={type:'choice',choice:'NONE',confidence:1,probabilities:{city:0,NONE:1}};
  assert.throws(()=>decodeAdaptiveDecision(raw,compiled,snapshot,spec),/ADAPTIVE_VALUE_NOT_OFFERED/);
});

test('runtime contract adaptive SELECT resolves only a current option and rejects malformed probability mass',()=>{
  const state={...snapshot,elements:[{...element,id:'e3',label:'Hotel class',tag:'select',operations:['SELECT'],options:[{id:'o1',label:'5 stars',value:'5'}]}]};
  const compiled=compileAdaptiveRequest(task,spec,state,[]),raw=answersFor(compiled.request,{state:'search',operation:'SELECT',SELECT_target:'e3_o1'});
  const action=decodeAdaptiveDecision(raw,compiled,state,spec);assert.equal(action.target_id,'e3');assert.equal(action.value_id,'o1');
  raw.answers.operation.probabilities.DONE=1;assert.throws(()=>decodeAdaptiveDecision(raw,compiled,state,spec),/INVALID_ADAPTIVE_DISTRIBUTION/);
});

test('runtime contract adaptive human challenge and unavailable provider never turn into an authorized action',async()=>{
  const compiled=compileAdaptiveRequest(task,spec,snapshot,[]),raw=answersFor(compiled.request,{state:'challenge',operation:'CLICK',CLICK_target:'e1'});
  assert.throws(()=>decodeAdaptiveDecision(raw,compiled,snapshot,spec),/ADAPTIVE_HUMAN_GATE/);
  const result=await decideAdaptiveStep({async systemOne(){throw Error('private provider error');}},task,spec,snapshot,[]);
  assert.equal(result.action,null);assert.equal(result.trace.reason,'ADAPTIVE_JEV_UNAVAILABLE');assert.equal(JSON.stringify(result).includes('private provider error'),false);
  assert.throws(()=>assertReadOnlyControl({...element,label:'Pay now'},'CLICK'),/ADAPTIVE_EFFECT_NOT_DELEGATED/);
  assert.throws(()=>assertReadOnlyControl({...element,label:'Next',href:'https://example.test/checkout'},'CLICK'),/ADAPTIVE_EFFECT_NOT_DELEGATED/);
});

test('runtime contract adaptive Luna adapter preserves model low effort and rejects incomplete output without leaking credentials',async()=>{
  const key='fixture-private-key-only-for-test';let request;
  const model=adaptiveLlmFromHostEnvironment({OPENAI_API_KEY:key},async(_url,options)=>{request=JSON.parse(options.body);return new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(spec)}]}]}));});
  assert.deepEqual(await model.call('design','instructions',{},{}),spec);assert.equal(request.model,'gpt-5.6-luna');assert.equal(request.reasoning.effort,'low');assert.equal(request.store,false);assert.deepEqual(request.tools,[]);assert.equal(JSON.stringify(model.calls).includes(key),false);
  const failed=adaptiveLlmFromHostEnvironment({OPENAI_API_KEY:key},async()=>new Response(JSON.stringify({status:'incomplete',output:[]})));
  await assert.rejects(failed.call('design','instructions',{},{}),/ADAPTIVE_LLM_UNAVAILABLE/);assert.equal(failed.calls[0].status,'failed');
  const message=(phase,text)=>({type:'message',phase,content:[{type:'output_text',text:JSON.stringify(text)}]});
  const phased=adaptiveLlmFromHostEnvironment({OPENAI_API_KEY:key},async()=>new Response(JSON.stringify({status:'completed',output:[message('commentary',{operation:'CLICK'}),message('final_answer',{operation:'BLOCKED'})]})));
  assert.deepEqual(await phased.call('correct','instructions',{},{}),{operation:'BLOCKED'});
  const ambiguous=adaptiveLlmFromHostEnvironment({OPENAI_API_KEY:key},async()=>new Response(JSON.stringify({status:'completed',output:[message(undefined,{operation:'CLICK'}),message(undefined,{operation:'DONE'})]})));
  await assert.rejects(ambiguous.call('correct','instructions',{},{}),/ADAPTIVE_LLM_UNAVAILABLE/);
});

const html=`<!doctype html><html><body><h1>Hotel finder</h1><div role="dialog" id="welcome">Welcome offer<button id="close" onclick="document.getElementById('welcome').remove()">Close welcome</button></div><label>Destination<input id="city"></label><label>Hotel class<select id="stars"><option value="all">All</option><option value="5">5 stars</option></select></label><button id="search" onclick="document.getElementById('results').textContent='Results '+document.getElementById('city').value+' '+document.getElementById('stars').value+' stars';window.searchCount=(window.searchCount||0)+1">Search</button><button id="pay" onclick="window.paid=true">Pay now</button><div id="results"></div></body></html>`;
async function fixture(t){
  const root=await mkdtemp(join(tmpdir(),'adaptive-browser-')),server=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/html'});res.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url=`http://127.0.0.1:${server.address().port}`;
  const browser=await chromium.launch({headless:true}),page=await browser.newPage();await page.goto(url);
  t.after(async()=>{await browser.close();await new Promise(resolve=>server.close(resolve));await rm(root,{recursive:true,force:true});});
  const boundTask={...task,start_url:url,allowed_origins:[url]},adapter=new AdaptiveBrowser(page,boundTask);
  return {root,page,task:boundTask,adapter};
}
function nextAction(state){
  const close=state.elements.find(e=>e.label==='Close welcome');if(close)return {operation:'CLICK',target_id:close.id,value_id:null,state:'search'};
  const city=state.elements.find(e=>e.label==='Destination');if(city?.value!=='Tokyo')return {operation:'FILL',target_id:city.id,value_id:'city',state:'search'};
  const stars=state.elements.find(e=>e.label==='Hotel class');if(stars?.value!=='5')return {operation:'SELECT',target_id:stars.id,value_id:stars.options.find(o=>o.value==='5').id,state:'search'};
  if(!state.text.includes('Results Tokyo 5 stars'))return {operation:'CLICK',target_id:state.elements.find(e=>e.label==='Search').id,value_id:null,state:'search'};
  return {operation:'DONE',target_id:null,value_id:null,state:'results'};
}

test('runtime fixture adaptive browser rejects changed target identity and excludes unapproved payment controls',async t=>{
  const {page,adapter}=await fixture(t),observed=await adapter.observe();assert.equal(observed.elements.some(e=>e.label==='Pay now'),false);
  const search=observed.elements.find(e=>e.label==='Search');await page.locator('#search').evaluate(el=>el.textContent='Reserve');
  await assert.rejects(adapter.execute({operation:'CLICK',target_id:search.id,value_id:null,state:'search',snapshot_id:observed.id,confidence:1},spec,observed),/ADAPTIVE_STALE_TARGET/);
  assert.equal(await page.evaluate(()=>Boolean(window.searchCount)),false);
  const fresh=await adapter.observe();assert.equal(fresh.elements.some(e=>e.label==='Reserve'),false);
});

test('runtime fixture adaptive first design then Jev loop corrects a false DONE and reuses the learned specification',{timeout:60000},async t=>{
  const {root,page,task:boundTask,adapter}=await fixture(t),model=modelFixture(input=>nextAction(input.snapshot));let decisions=0;
  const jev={async systemOne(request){
    const next=decisions++===0?{operation:'DONE',state:'results'}:nextAction(request.state.page);
    const selected={state:next.state,operation:next.operation};
    if(next.operation==='CLICK')selected.CLICK_target=next.target_id;
    if(next.operation==='FILL'){selected.FILL_target=next.target_id;selected[`value_${next.target_id}`]=next.value_id;}
    if(next.operation==='SELECT')selected.SELECT_target=`${next.target_id}_${next.value_id}`;
    return answersFor(request,selected);
  }};
  const verify=async()=>{const actual=await page.locator('#results').innerText();return {status:actual==='Results Tokyo 5 stars'?'MATCH':'NOT_MATCH',reason:'independent_fixture_result',details:{actual}};};
  const first=await runAdaptivePack({task:boundTask,browser:adapter,jev,llm:model,cacheDir:join(root,'cache'),outputDir:join(root,'first'),verify});
  if(first.status!=='succeeded')t.diagnostic(JSON.stringify({reason:first.reason,steps:first.steps,model_calls:first.llm_calls}));
  assert.equal(first.status,'succeeded');assert.equal(first.cache_hit,false);assert.ok(first.steps.some(step=>step.operation==='DONE'&&step.result==='NOT_MATCH'));assert.ok(first.steps.some(step=>step.decider==='llm'));assert.equal(await page.evaluate(()=>window.searchCount),1);assert.equal(await page.evaluate(()=>Boolean(window.paid)),false);
  assert.equal(first.llm_calls.filter(call=>call.purpose==='design').length,1);
  await page.goto(boundTask.start_url);
  const second=await runAdaptivePack({task:boundTask,browser:adapter,jev,llm:model,cacheDir:join(root,'cache'),outputDir:join(root,'second'),verify});
  assert.equal(second.status,'succeeded');assert.equal(second.cache_hit,true);assert.equal(second.llm_calls.length,0);assert.ok(second.steps.some(step=>step.operation==='FILL'));assert.ok(second.steps.some(step=>step.operation==='SELECT'));
});

test('runtime contract hotel readback distinguishes star class, full stay price, occupancy, taxes and incomplete conditions',()=>{
  const hotel=ADAPTIVE_TRAVEL_TARGETS.find(t=>t.source==='booking');assert.ok(hotel);const request=adaptiveTravelTask(hotel);assert.match(request.request,/5-star/);assert.match(request.request,/2026-12-28/);
  const card={name:'Fixture hotel',url:'https://example.test/hotel',stars:5,amount:2000000,currency:'KRW',nights:5,adults:2,tax_basis:'included',evidence_sha256:'fixture'};
  const readback={destination_matches:true,dates_match:true,occupancy_matches:true,five_star_filter:true,price_sort:true,cards:[card,{...card,name:'Guest review 5',stars:null,amount:100},{...card,name:'One night',nights:1,amount:150},{...card,name:'Taxes excluded',tax_basis:'excluded',amount:1900000}]};
  const result=verifyBookingReadback(readback,hotel);assert.equal(result.status,'MATCH');assert.equal(result.details.eligible_cards,2);assert.equal(result.details.lowest_by_tax_basis.length,2);assert.equal(result.details.lowest_by_tax_basis[0].lowest_observed.amount,2000000);
  assert.equal(verifyBookingReadback({...readback,dates_match:false},hotel).status,'NOT_MATCH');assert.equal(verifyBookingReadback({...readback,cards:[]},hotel).status,'UNKNOWN');
});

test('runtime contract Google route oracle accepts sort metadata but rejects altered dates airports cabin and currency',()=>{
  const target=ADAPTIVE_TRAVEL_TARGETS.find(item=>item.source==='google_flights'),original=adaptiveTravelTask(target).start_url;
  assert.equal(googleRouteMatches(original,target),true);
  const sorted=new URL(original),payload=Buffer.from(sorted.searchParams.get('tfs'),'base64url');
  sorted.searchParams.set('tfs',Buffer.concat([payload,Buffer.from([0xc0,0x02,1])]).toString('base64url'));
  assert.equal(googleRouteMatches(sorted.toString(),target),true);
  for(const change of [{departure_date:'2026-11-02'},{origin:'GMP'},{destination:'HND'}])assert.equal(googleRouteMatches(adaptiveTravelTask({...target,...change}).start_url,target),false);
  sorted.searchParams.set('curr','USD');assert.equal(googleRouteMatches(sorted.toString(),target),false);
  sorted.searchParams.set('curr','KRW');sorted.searchParams.set('tfs',Buffer.concat([payload,Buffer.from([0x48,2])]).toString('base64url'));assert.equal(googleRouteMatches(sorted.toString(),target),false);
  sorted.searchParams.set('tfs','malformed');assert.equal(googleRouteMatches(sorted.toString(),target),false);
});

test('runtime fixture adaptive observation includes selected tab state and refreshes after initial design',async t=>{
  const {root,page,task:boundTask,adapter}=await fixture(t);
  await page.evaluate(()=>{const tab=document.createElement('button');tab.textContent='Cheapest';tab.setAttribute('role','tab');tab.setAttribute('aria-selected','true');document.body.append(tab);});
  assert.equal((await adapter.observe()).elements.find(element=>element.label==='Cheapest').checked,true);
  const model=modelFixture();const oldCall=model.call;model.call=async(...args)=>{const answer=await oldCall(...args);if(args[0]==='design')await page.locator('#welcome').evaluate(el=>el.remove());return answer;};
  let observedAfterDesign=false;
  const jev={async systemOne(request){observedAfterDesign=!request.state.page.elements.some(element=>element.label==='Close welcome');return answersFor(request,{state:'results',operation:'DONE'});}};
  const result=await runAdaptivePack({task:boundTask,browser:adapter,jev,llm:model,cacheDir:join(root,'cache'),outputDir:join(root,'run'),verify:async()=>({status:'MATCH',reason:'fixture_only',details:{}})});
  assert.equal(result.status,'succeeded');assert.equal(observedAfterDesign,true);
});

test('runtime fixture optional login false alarm receives LLM review but confirmed human gates do not execute',async t=>{
  const {root,task:boundTask,adapter}=await fixture(t);
  const jev={async systemOne(request){return answersFor(request,{state:'authentication',operation:'BLOCKED'});}};
  const reviewed=modelFixture(()=>({operation:'DONE',target_id:null,value_id:null,state:'results'}));
  const result=await runAdaptivePack({task:boundTask,browser:adapter,jev,llm:reviewed,cacheDir:join(root,'cache'),outputDir:join(root,'optional'),verify:async()=>({status:'MATCH',reason:'fixture_only',details:{}})});
  assert.equal(result.status,'succeeded');assert.equal(result.steps[0].decider,'llm');
  const confirmed=modelFixture(()=>({operation:'BLOCKED',target_id:null,value_id:null,state:'challenge'}));
  const hold=await runAdaptivePack({task:boundTask,browser:adapter,jev,llm:confirmed,cacheDir:join(root,'another-cache'),outputDir:join(root,'confirmed'),verify:async()=>{throw Error('must_not_verify');}});
  assert.equal(hold.status,'blocked');assert.equal(hold.reason,'ADAPTIVE_HUMAN_GATE');assert.equal(hold.steps.length,0);
});

test('runtime contract adaptive observer reacquires a navigated page and bounds repeated navigation failures',async()=>{
  let attempts=0,waits=0;const page={url:()=>task.start_url,async evaluate(){if(attempts++===0)throw Error('Execution context was destroyed, most likely because of a navigation.');return {url:task.start_url,title:'Search',text:'Search',elements:[element],truncated:false};},async waitForLoadState(){waits++;}};
  const observed=await new AdaptiveBrowser(page,task).observe();assert.equal(observed.elements.length,1);assert.equal(attempts,2);assert.equal(waits,1);
  page.evaluate=async()=>{throw Error('Execution context was destroyed');};
  await assert.rejects(new AdaptiveBrowser(page,task).observe(),/ADAPTIVE_OBSERVATION_NAVIGATING/);assert.equal(waits,3);
});
