import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {initWorkSupervisor} from '../dist/work/supervisor.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {BoundedWorkClientExecutor,WorkClientToolInputError,WORK_CLIENT_EXECUTION_INSTRUCTIONS,boundWorkToolValue} from '../dist/work/client-executor.js';
import {workTail} from '../dist/work/activity.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {RoutedBrowser,browserCheckpointBinding} from '../dist/browser/executor-routing.js';

const spec={title:'ASTS sources',desired_outcome:'Read a public article and save a sourced summary.',completion_checks:[{id:'summary',result:'A sourced summary is saved',evidence:'Observed article and verified Office report'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const at='2026-09-29T00:00:00.000Z',article='https://example.org/observed-article';
const entry=(provider,query)=>{const url=new URL({google:'https://www.google.com/search',bing:'https://www.bing.com/search',duckduckgo:'https://duckduckgo.com/'}[provider]);url.searchParams.set('q',query);url.searchParams.set(provider==='google'?'num':provider==='bing'?'count':'ia',provider==='duckduckgo'?'web':'10');return url.href;};
const page=(url,extra={})=>({url,title:'Observed search DOM',text:'Observed fixture DOM only.',links:[{text:'Article',url:article}],observed_at:at,...extra});
const challenge=url=>page('https://www.google.com/sorry/index',{title:'Observed access challenge',text:'Human verification is required.',links:[{text:'Help',url:'https://support.google.com/blocked'},{text:'Sensitive',url:'https://example.org/?access_token=private'}]});
const unusualChallenge=url=>({...challenge(url),text:'Our systems have detected unusual traffic from your computer network.'});

async function setup(t,{observe=url=>page(url),browserTargets=null,prompt='Research ASTS articles'}={}){
  const root=await mkdtemp(join(tmpdir(),'work-search-provider-')),path=join(root,'host.json'),raw={schema_version:1,project_id:'search-provider',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}};
  if(browserTargets)raw.browser_executors={targets:browserTargets};
  await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkSupervisor(store);
  const ai={calls:[],async call(){return structuredClone(spec);}},runtime=new WorkRuntime(store,config,ai),work=await runtime.start({request_id:'search-provider-work',prompt}),run=randomUUID(),events=[],api={async call(name){assert.equal(name,'runtime_pack_catalog');return {families:[{id:'research.search'}],connected:true,models:'off',execution:'bounded_sources_and_reviewed_browser_targets'};}},instances=[];
  const factory=target=>{let current='';events.push({kind:'factory',engine:target.engine,environment:target.environment,id:target.id});return {target,async probe(){events.push({kind:'probe',id:target.id});},async open(url){current=url;events.push({kind:'open',url,id:target.id});},async navigate(url){current=url;events.push({kind:'navigate',url,id:target.id});},async observe(){return observe(current);},async extract(){return [];},async scroll(){},async close(){events.push({kind:'close',id:target.id});}};};
  const create=(runId=run)=>{const tools=new WorkExecutionTools(store,config,api,work.work_id,runId,work.spec,work.prompt,()=>{},ai,{browserFactory:factory});instances.push(tools);return tools;};
  const seed=checkpoint=>{const stamp=new Date().toISOString();store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(run_id) DO UPDATE SET checkpoint=excluded.checkpoint').run(run,config.project.id,work.work_id,work.revision,'paused',JSON.stringify(checkpoint),config.fingerprint,0,stamp,stamp);};
  t.after(async()=>{for(const tools of instances)await tools.close();store.close();await rm(root,{recursive:true,force:true});});
  return {config,store,work,run,events,create,seed,factory};
}

const routeOptions=x=>({profile_key:`work-${x.work.work_id}`,context_id:x.run,request:x.work.prompt,preference:x.work.spec.browser??{environment:'owned_headless'},ephemeral:true});
const exactBrowserKey=(x,url,run=x.run)=>`work:${run}:${new URL(url).origin}:${hashJson({entry_url:url})}`;
const legacyBrowserKey=(x,url)=>`work:${x.run}:${new URL(url).origin}`;
const browserCheckpoint=(x,entryUrl,currentUrl=entryUrl)=>({version:1,entry_url:entryUrl,url:currentUrl,target_id:'playwright',environment:'owned_headless',completed_steps:['observe'],effect_state:'none',binding:browserCheckpointBinding(x.config,routeOptions(x)),observation_sha256:'b'.repeat(64)});
const checkpointBytes=(x,key)=>x.store.hermesState.prepare('SELECT body FROM browser_executor_checkpoints WHERE project_id=? AND context_id=?').get(x.config.project.id,key)?.body??null;
const saveBrowserCheckpoint=(x,key,value)=>x.store.browserExecutors().saveCheckpoint(x.config.project.id,key,value);
const queriedPage=url=>{const query=new URL(url).searchParams.get('q');return page(url,{title:query===null?'Article DOM '+url:'Search DOM '+query,text:query===null?'Observed article '+url:'Observed query '+query});};
const recordedRead=async(x,tools,name,args,id)=>{const value=await tools.execute(name,args,id),receipt=await tools.receipt(name,value,id);return {invocation:{request_id:id,turn:0,stage_id:'research',tool_name:name,arguments:args,effect:'read_only',dispatched:true},receipt,observed_at:at};};
const seedObserved=(x,observations,run=x.run)=>x.seed({format:1,work_id:x.work.work_id,run_id:run,binding:'a'.repeat(64),turn:observations.length,pending:null,observations,summary:'Preserved host DOM receipts'});

test('runtime contract public search provider is optional Google and the catalog cannot accept an arbitrary endpoint or executor',async t=>{
  const x=await setup(t),tools=x.create(),catalog=tools.catalog(),search=catalog.find(tool=>tool.name==='office_web_search');
  assert.deepEqual(search.input_schema.properties.provider.enum,['google','bing','duckduckgo']);assert.equal(search.input_schema.properties.provider.default,'google');assert.ok(!search.input_schema.required.includes('provider'));assert.equal(search.input_schema.additionalProperties,false);assert.equal(search.effect,'read_only');
  assert.equal(tools.validate('office_web_search',{query:' ASTS ',provider:'google'},'default').provider,'google');
  for(const args of [{query:'ASTS',provider:'https://private.invalid/'},{query:'ASTS',endpoint:'https://private.invalid/'},{query:'ASTS',engine:'aside'},{query:'ASTS',profile:'personal'}])assert.throws(()=>tools.validate('office_web_search',args,'rejected'));
  assert.deepEqual(x.events,[]);assert.match(catalog.find(tool=>tool.name==='runtime_pack_catalog').description,/models=off does not disable the configured Work LLM or office_web_search/u);assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/One unavailable public search provider is not missing configuration/u);
  // A6: provider-specific rules travel with the search capability itself and are enforced by WORK_SEARCH_ENVIRONMENT_BLOCKED.
  const searchDescription=catalog.find(tool=>tool.name==='office_web_search').description;assert.match(searchDescription,/hands the identical Google query directly to registered Aside once/u);assert.match(searchDescription,/provider_change_allowed=true search with bing or open a known official page/u);assert.match(searchDescription,/follow next_action/u);
  assert.equal(tools.validate('office_web_search',{query:'ASTS'},'host-default').provider,'bing','Without a registered foreground browser the host default is the provider that answers a background browser.');
});

test('runtime fixture three fixed providers encode the same query and return actual unclassified DOM through the same read-only environment',async t=>{
  const x=await setup(t),tools=x.create(),query='ASTS & launch 한글';
  for(const provider of ['google','bing','duckduckgo']){const args={query,provider},value=await tools.execute('office_web_search',args,provider),receipt=await tools.receipt('office_web_search',value,provider);assert.equal(value.requested_url,entry(provider,query));assert.equal(value.url,entry(provider,query));assert.equal(value.search_provider,provider);assert.equal(value.search_access,'unclassified_dom');assert.equal(value.text,'Observed fixture DOM only.');assert.equal(value.provenance,'live_browser_dom');assert.equal(value.effect,'read_only');assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'none');assert.deepEqual(receipt.evidence_ids,[provider]);}
  assert.ok(x.events.filter(event=>event.kind==='factory').every(event=>event.engine==='playwright'&&event.environment==='owned_headless'));
  const read=await tools.execute('office_browser_read',{url:article},'article');assert.equal(read.url,article);assert.equal(read.text,'Observed fixture DOM only.');assert.equal(read.search_provider,undefined);
});

test('runtime fixture every public provider rejects credential and private query URLs before browser admission',async t=>{
  const x=await setup(t),tools=x.create(),queries=['apikey_abcdefghijklmnopqrstuvwxyz','Bearer abcdefghijklmnopqrstuvwxyz','http://127.0.0.1/private','https://vault.internal/private','https://app.localhost/private','https://2130706433/private','https://public.example/?access_token=private','https://public.example/?session_id=private','cookie=private'];
  for(const provider of ['google','bing','duckduckgo'])for(const query of queries)await assert.rejects(tools.execute('office_web_search',{query,provider},'secret'));
  assert.deepEqual(x.events,[]);
});

test('runtime fixture observed Google challenge is preserved without source-success evidence or blocked link navigation authority',async t=>{
  const x=await setup(t,{observe:unusualChallenge}),tools=x.create(),value=await tools.execute('office_web_search',{query:'ASTS',provider:'google'},'blocked'),receipt=await tools.receipt('office_web_search',value,'blocked');
  assert.equal(value.url,'https://www.google.com/sorry/index');assert.equal(value.text,'Our systems have detected unusual traffic from your computer network.');assert.equal(value.search_provider,'google');assert.equal(value.search_access,'challenge_observed');assert.equal(value.omitted_sensitive_links,1);assert.doesNotMatch(JSON.stringify(value.links),/access_token|private/u);assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.effect_state,'none');assert.equal(receipt.retry_safe,false);assert.deepEqual(receipt.evidence_ids,[]);
  assert.ok(workTail(x.store,x.config.project.id,x.work.work_id).some(event=>event.kind==='search.blocked'&&event.metadata.reason==='WORK_SEARCH_PROVIDER_CHALLENGE'));
  assert.deepEqual((await tools.execute('office_browser_links',{},'links')).urls,[]);
  await assert.rejects(tools.execute('office_browser_read',{url:entry('google','ASTS')},'same-service-read'),/WORK_SEARCH_PROVIDER_BLOCKED/u);
  assert.equal(tools.validate('office_browser_read',{url:'https://support.google.com/blocked'},'blocked-link').url,'https://support.google.com/blocked');
  assert.ok(workTail(x.store,x.config.project.id,x.work.work_id).some(event=>event.kind==='source.proposed'),'A public page may be opened as a recorded model proposal, never by authority from the challenge page.');
  assert.equal(value.next_action,'search_with_bing_or_open_a_known_official_page');assert.equal(value.provider_change_allowed,true,'No foreground browser is registered here, so another provider is the recovery instead of waiting for a person.');
  assert.equal(tools.validate('office_web_search',{query:'ASTS',provider:'bing'},'provider-substitution').provider,'bing');
});

test('runtime fixture identical challenged provider and trimmed query are rejected before any repeated navigation while another independent provider remains available',async t=>{
  const x=await setup(t,{observe:url=>new URL(url).hostname==='www.google.com'?challenge(url):page(url)}),tools=x.create();await tools.execute('office_web_search',{query:'ASTS',provider:'google'},'first');const before=x.events.length;
  assert.throws(()=>tools.validate('office_web_search',{query:' ASTS ',provider:'google'},'repeat'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_SEARCH_PROVIDER_BLOCKED'&&error.not_dispatched===true);
  await assert.rejects(tools.execute('office_web_search',{query:'ASTS',provider:'google'},'repeat'),/WORK_SEARCH_PROVIDER_BLOCKED/u);assert.equal(x.events.length,before);
  assert.equal((await tools.execute('office_web_search',{query:'ASTS',provider:'bing'},'alternative')).search_provider,'bing');
});

test('runtime fixture challenge retryable receipt allows the next bounded client turn, Pack models off does not disable search, and no challenged URL is replayed in another browser',async t=>{
  const x=await setup(t,{observe:url=>new URL(url).hostname==='www.google.com'?challenge(url):page(url)}),tools=x.create(),inputs=[],model={calls:[],async call(_purpose,instructions,input){inputs.push(structuredClone(input));this.calls.push({purpose:'correct',status:'accepted',provider:'fixture',model:'fixture'});assert.match(input.tools.find(tool=>tool.name==='runtime_pack_catalog').description,/models=off does not disable/u);const previous=input.checkpoint.observations.at(-1),common={stage_id:'research',summary:'Follow observed public evidence.',completed_checks:[],wait_reason:null};
    if(!previous)return {...common,action:'tool',tool_name:'office_web_search',arguments_json:JSON.stringify({query:'ASTS',provider:'google'})};
    if(previous.receipt.status==='retryable_failure'){assert.equal(previous.receipt.value.search_access,'challenge_observed');assert.deepEqual(previous.receipt.evidence_ids,[]);return {...common,action:'tool',tool_name:'runtime_pack_catalog',arguments_json:'{}'};}
    if(previous.invocation.tool_name==='runtime_pack_catalog'){assert.equal(previous.receipt.value.models,'off');return {...common,action:'tool',tool_name:'office_web_search',arguments_json:JSON.stringify({query:'ASTS',provider:'bing'})};}
    if(previous.invocation.tool_name==='office_web_search')return {...common,action:'tool',tool_name:'office_browser_read',arguments_json:JSON.stringify({url:article})};
    if(previous.invocation.tool_name==='office_browser_read')return {...common,action:'tool',tool_name:'office_result_draft',arguments_json:JSON.stringify({text:'Observed fixture DOM only. Source: '+article})};
    return {...common,action:'complete',tool_name:null,arguments_json:null,completed_checks:[{id:'summary',evidence_ids:previous.receipt.evidence_ids}]};
  }};
  const result=await new BoundedWorkClientExecutor(model).execute({work_id:x.work.work_id,run_id:x.run,prompt:x.work.prompt,completion_checks:x.work.spec.completion_checks,max_turns:8},{tools:tools.catalog(),guard:()=>{},checkpoint:checkpoint=>x.seed(checkpoint),validateTool:(name,args,context)=>tools.validate(name,args,context.request_id),executeTool:async(name,args,context)=>tools.receipt(name,await tools.execute(name,args,context.request_id),context.request_id),verifyCompletion:async(_checks,observations)=>observations.some(observation=>observation.invocation.tool_name==='office_browser_read'&&observation.receipt.value.url===article)&&observations.at(-1).receipt.effect_state==='verified'&&observations.at(-1).receipt.value.text==='Observed fixture DOM only. Source: '+article});
  assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(inputs.length,6);assert.equal(result.checkpoint.observations[0].receipt.status,'retryable_failure');assert.equal(x.events.filter(event=>event.kind==='open'&&new URL(event.url).hostname==='www.google.com').length,1);assert.ok(x.events.filter(event=>event.kind==='factory').every(event=>event.engine==='playwright'&&event.environment==='owned_headless'));
});

test('runtime fixture a client repeatedly selecting the identical challenged query stops after bounded preflight corrections without another navigation',async t=>{
  const x=await setup(t,{observe:challenge}),tools=x.create(),model={calls:[],async call(){this.calls.push({purpose:'correct',status:'accepted',provider:'fixture',model:'fixture'});return {action:'tool',stage_id:'search',tool_name:'office_web_search',arguments_json:JSON.stringify({query:'ASTS',provider:'google'}),summary:'The fixture repeats the blocked input to test the host bound.',completed_checks:[],wait_reason:null};}};
  const result=await new BoundedWorkClientExecutor(model).execute({work_id:x.work.work_id,run_id:x.run,prompt:x.work.prompt,completion_checks:x.work.spec.completion_checks,max_turns:8},{tools:tools.catalog(),checkpoint:checkpoint=>x.seed(checkpoint),validateTool:(name,args,context)=>tools.validate(name,args,context.request_id),executeTool:async(name,args,context)=>tools.receipt(name,await tools.execute(name,args,context.request_id),context.request_id)});
  assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED');assert.equal(model.calls.length,8,'Bounded by the run attempt turn budget.');assert.equal(x.events.filter(event=>event.kind==='open').length,1);
  assert.ok(result.checkpoint.observations.slice(3).every(observation=>observation.receipt.value.issues[0].code==='WORK_CLIENT_TOOL_NOT_AVAILABLE'),'After the same blocked input twice, the capability is set aside for this attempt.');assert.equal(result.checkpoint.observations[0].receipt.value.search_access,'challenge_observed');assert.ok(result.checkpoint.observations.slice(1).every(observation=>!observation.invocation.dispatched&&observation.receipt.value.status==='not_dispatched'&&observation.receipt.effect_state==='none'));
});

test('runtime fixture same-run legacy succeeded challenge observation restores only the retry block, while foreign and uncertain receipts remain excluded',async t=>{
  const x=await setup(t,{observe:challenge}),tools=x.create(),value=await tools.execute('office_web_search',{query:'ASTS',provider:'google'},'legacy'),receipt=await tools.receipt('office_web_search',value,'legacy'),legacy={...value};delete legacy.search_provider;delete legacy.search_access;delete legacy.status;delete legacy.reason;
  const checkpoint={format:1,work_id:x.work.work_id,run_id:x.run,binding:'a'.repeat(64),turn:1,pending:null,observations:[{invocation:{request_id:'legacy',turn:0,stage_id:'search',tool_name:'office_web_search',arguments:{query:'ASTS'},effect:'read_only',dispatched:true},receipt,observed_at:at}],summary:'Observed access challenge'};x.seed(checkpoint);const retryableRestore=x.create();assert.throws(()=>retryableRestore.validate('office_web_search',{query:'ASTS',provider:'google'},'retryable'),/WORK_SEARCH_PROVIDER_BLOCKED/u);assert.deepEqual((await retryableRestore.execute('office_browser_links',{},'retryable-links')).urls,[]);
  checkpoint.observations[0].receipt={...receipt,status:'succeeded',value:legacy,evidence_ids:['legacy'],retry_safe:true};x.seed(checkpoint);
  const restored=x.create();assert.throws(()=>restored.validate('office_web_search',{query:'ASTS',provider:'google'},'same'),/WORK_SEARCH_PROVIDER_BLOCKED/u);assert.deepEqual((await restored.execute('office_browser_links',{},'same-links')).urls,[]);
  const foreignRun=x.create(randomUUID());assert.equal(foreignRun.validate('office_web_search',{query:'ASTS',provider:'google'},'foreign-run').provider,'google');
  checkpoint.work_id=randomUUID();x.seed(checkpoint);assert.equal(x.create().validate('office_web_search',{query:'ASTS',provider:'google'},'foreign-work').provider,'google');
  checkpoint.work_id=x.work.work_id;checkpoint.observations[0].receipt={...receipt,status:'reconciliation_required',effect_state:'uncertain',retry_safe:false};x.seed(checkpoint);assert.equal(x.create().validate('office_web_search',{query:'ASTS',provider:'google'},'uncertain').provider,'google');
  checkpoint.observations[0].receipt=receipt;checkpoint.observations[0].invocation.dispatched=false;x.seed(checkpoint);assert.equal(x.create().validate('office_web_search',{query:'ASTS',provider:'google'},'not-dispatched').provider,'google');
});

test('runtime fixture unrelated article text mentioning CAPTCHA is not reclassified as a search challenge',async t=>{
  const x=await setup(t,{observe:url=>page(url,{title:'Public research results',text:'An article explains CAPTCHA research and robotics; this is not an access challenge.'})}),tools=x.create(),value=await tools.execute('office_web_search',{query:'CAPTCHA research',provider:'bing'},'ordinary');assert.equal(value.search_access,'unclassified_dom');assert.equal((await tools.receipt('office_web_search',value,'ordinary')).status,'succeeded');assert.equal(tools.validate('office_web_search',{query:'CAPTCHA research',provider:'bing'},'again').provider,'bing');
});

test('runtime fixture a browser authentication refusal is not an executor availability failure and does not route to another engine',async t=>{
  const targets=[{id:'playwright',engine:'playwright',environment:'host_foreground',profile_ref:'owned',platform:process.platform,priority:100},{id:'neo',engine:'neo',environment:'host_foreground',profile_ref:'owned',platform:process.platform,endpoint:'http://127.0.0.1:9010/mcp',priority:50}],x=await setup(t,{browserTargets:targets,observe:()=>{throw Error('PACK_WAITING_AUTH');}}),specWithForeground={...x.work.spec,browser:{environment:'host_foreground',preferred_engine:'playwright'}},tools=new WorkExecutionTools(x.store,x.config,{call:async()=>assert.fail('auth refusal cannot call another tool')},x.work.work_id,x.run,specWithForeground,x.work.prompt,()=>{},{calls:[],call:async()=>assert.fail('executor selection must not invoke a model')},{browserFactory:target=>{x.events.push({kind:'factory',engine:target.engine});return {target,probe:async()=>{},open:async()=>{},navigate:async()=>{},observe:async()=>{throw Error('PACK_WAITING_AUTH');},extract:async()=>[],scroll:async()=>{},close:async()=>{}};}});t.after(()=>tools.close());
  await assert.rejects(tools.execute('office_web_search',{query:'ASTS',provider:'google'},'auth'),/PACK_WAITING_AUTH/u);assert.deepEqual(x.events,[{kind:'factory',engine:'playwright'}]);
});

test('runtime fixture same-origin queries keep one page and a later attempt opens its new exact query instead of rejecting the first entry',async t=>{
  const x=await setup(t,{observe:queriedPage}),first=x.create(),queries=['ASTS first source','ASTS second source','ASTS third source'];
  for(const query of queries.slice(0,2)){const value=await first.execute('office_web_search',{query,provider:'bing'},query);assert.equal(value.url,entry('bing',query));assert.equal(value.text,'Observed query '+query);}
  assert.equal(x.events.filter(event=>event.kind==='factory').length,1);assert.deepEqual(x.events.filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),queries.slice(0,2).map(query=>entry('bing',query)));
  await first.close();assert.equal(x.events.filter(event=>event.kind==='close').length,1);
  const second=x.create(),value=await second.execute('office_web_search',{query:queries[2],provider:'bing'},'resumed-third');assert.equal(value.url,value.requested_url);assert.equal(value.url,entry('bing',queries[2]));assert.equal(value.text,'Observed query '+queries[2]);assert.equal(x.events.filter(event=>event.kind==='factory').length,2);
  assert.equal(x.events.filter(event=>event.kind==='open').at(-1).url,entry('bing',queries[2]));await second.close();assert.equal(x.events.filter(event=>event.kind==='close').length,2);
});

test('runtime fixture restoring the first exact search entry reobserves that query and never opens the last query first',async t=>{
  const x=await setup(t,{observe:queriedPage}),first=x.create(),q1='ASTS first entry',q2='ASTS last cursor',u1=entry('bing',q1),u2=entry('bing',q2);
  await first.execute('office_web_search',{query:q1,provider:'bing'},'first');await first.execute('office_web_search',{query:q2,provider:'bing'},'last');await first.close();
  const saved=x.store.browserExecutors().checkpoint(x.config.project.id,exactBrowserKey(x,u1));assert.equal(saved.entry_url,u1);assert.equal(saved.url,u2);const before=x.events.length;
  const resumed=x.create(),value=await resumed.execute('office_web_search',{query:q1,provider:'bing'},'repeat-first');assert.equal(value.requested_url,u1);assert.equal(value.url,u1);assert.equal(value.title,'Search DOM '+q1);assert.equal(value.text,'Observed query '+q1);
  assert.deepEqual(x.events.slice(before).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[u1]);assert.equal(x.store.browserExecutors().checkpoint(x.config.project.id,exactBrowserKey(x,u1)).binding,saved.binding);
});

test('runtime fixture same-origin article receipts restore only observed hrefs and each resumed read matches its requested article',async t=>{
  const a='https://example.org/source-a',b='https://example.org/source-b',x=await setup(t,{observe:url=>page(url,{title:'Article '+url,text:'Observed article '+url,links:[{text:'Source A',url:a},{text:'Source B',url:b}]})}),first=x.create();
  const search=await recordedRead(x,first,'office_web_search',{query:'ASTS sources',provider:'bing'},'sources'),readA=await recordedRead(x,first,'office_browser_read',{url:a},'a'),readB=await recordedRead(x,first,'office_browser_read',{url:b},'b');seedObserved(x,[search,readA,readB]);
  assert.equal(x.events.filter(event=>event.kind==='factory').length,2);await first.close();
  for(const url of [b,a]){const before=x.events.length,resumed=x.create(),value=await resumed.execute('office_browser_read',{url},'resumed-'+url.at(-1));assert.equal(value.requested_url,url);assert.equal(value.url,url);assert.equal(value.text,'Observed article '+url);assert.deepEqual(x.events.slice(before).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[url]);const count=x.events.length;const unobserved=await resumed.execute('office_browser_read',{url:'https://example.org/unobserved'},'unobserved');assert.equal(unobserved.url,'https://example.org/unobserved');assert.deepEqual(x.events.slice(count).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),['https://example.org/unobserved'],'An unobserved public page is a recorded proposal read, never a restored cursor.');await resumed.close();}
  assert.equal(x.events.filter(event=>event.kind==='factory').length,4);assert.equal(x.events.filter(event=>event.kind==='close').length,4);
});

test('runtime fixture a validated legacy checkpoint for another query starts a fresh exact read without modifying legacy bytes',async t=>{
  const x=await setup(t,{observe:queriedPage}),u1=entry('bing','Legacy first query'),u2=entry('bing','Legacy last cursor'),u3=entry('bing','Fresh requested query'),key=legacyBrowserKey(x,u1),legacy=browserCheckpoint(x,u1,u2);saveBrowserCheckpoint(x,key,legacy);const original=checkpointBytes(x,key);
  const value=await x.create().execute('office_web_search',{query:'Fresh requested query',provider:'bing'},'fresh');assert.equal(value.url,u3);assert.equal(value.requested_url,u3);assert.equal(value.text,'Observed query Fresh requested query');assert.deepEqual(x.events.filter(event=>event.kind==='open').map(event=>event.url),[u3]);assert.equal(checkpointBytes(x,key),original);
  const exact=x.store.browserExecutors().checkpoint(x.config.project.id,exactBrowserKey(x,u3));assert.equal(exact.entry_url,u3);assert.equal(exact.url,u3);assert.equal(exact.binding,legacy.binding);assert.equal(x.events.filter(event=>event.kind==='factory').length,1);
});

test('runtime fixture a matching legacy entry reobserves its requested URL without replaying its saved cursor or rebinding its hash',async t=>{
  const x=await setup(t,{observe:queriedPage}),query='Legacy requested first',u1=entry('bing',query),u2=entry('bing','Legacy different last'),key=legacyBrowserKey(x,u1),legacy=browserCheckpoint(x,u1,u2);saveBrowserCheckpoint(x,key,legacy);const original=checkpointBytes(x,key);
  const value=await x.create().execute('office_web_search',{query,provider:'bing'},'legacy-resume');assert.equal(value.url,u1);assert.equal(value.requested_url,u1);assert.equal(value.text,'Observed query '+query);assert.deepEqual(x.events.filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[u1]);assert.equal(checkpointBytes(x,key),original);
  assert.equal(x.store.browserExecutors().checkpoint(x.config.project.id,exactBrowserKey(x,u1)).binding,legacy.binding);
});

test('runtime fixture legacy different-entry recovery cannot escape configuration, uncertainty, version or origin fences',async t=>{
  const x=await setup(t,{observe:queriedPage}),old=entry('bing','Old entry'),requested='Different requested entry',key=legacyBrowserKey(x,old),base=browserCheckpoint(x,old);
  const changedBinding=browserCheckpointBinding({...x.config,fingerprint:'c'.repeat(64)},routeOptions(x));assert.notEqual(changedBinding,base.binding);
  for(const [change,error] of [[{binding:changedBinding},/BROWSER_CHECKPOINT_BINDING_CHANGED/u],[{effect_state:'uncertain'},/BROWSER_RECONCILIATION_REQUIRED/u],[{version:2},/BROWSER_CHECKPOINT_BINDING_CHANGED/u],[{entry_url:'https://foreign.example/entry'},/BROWSER_URL_NOT_DELEGATED/u],[{url:'https://foreign.example/cursor'},/BROWSER_URL_NOT_DELEGATED/u]]){saveBrowserCheckpoint(x,key,{...base,...change});const original=checkpointBytes(x,key),before=x.events.length;await assert.rejects(x.create().execute('office_web_search',{query:requested,provider:'bing'},'blocked-legacy'),error);assert.equal(x.events.length,before);assert.equal(checkpointBytes(x,key),original);assert.equal(checkpointBytes(x,exactBrowserKey(x,entry('bing',requested))),null);}
});

test('runtime fixture exact URL recovery preserves config and effect fences and rejects a foreign entry instead of silently freshening it',async t=>{
  const x=await setup(t,{observe:queriedPage}),query='Exact protected entry',url=entry('bing',query),key=exactBrowserKey(x,url),base=browserCheckpoint(x,url),changedBinding=browserCheckpointBinding({...x.config,fingerprint:'c'.repeat(64)},routeOptions(x));
  for(const [change,error] of [[{binding:changedBinding},/BROWSER_CHECKPOINT_BINDING_CHANGED/u],[{effect_state:'uncertain'},/BROWSER_RECONCILIATION_REQUIRED/u],[{entry_url:entry('bing','Foreign same-origin entry')},/BROWSER_CHECKPOINT_BINDING_CHANGED/u],[{url:'https://foreign.example/cursor'},/BROWSER_URL_NOT_DELEGATED/u]]){saveBrowserCheckpoint(x,key,{...base,...change});const original=checkpointBytes(x,key),before=x.events.length;await assert.rejects(x.create().execute('office_web_search',{query,provider:'bing'},'blocked-exact'),error);assert.equal(x.events.length,before);assert.equal(checkpointBytes(x,key),original);}
});

test('runtime fixture exact browser checkpoints and observed links from a foreign run neither grant article access nor redirect a fresh read',async t=>{
  const x=await setup(t,{observe:queriedPage}),foreign=randomUUID(),query='Fresh scoped query',url=entry('bing',query),foreignKey=exactBrowserKey(x,url,foreign),foreignCheckpoint={...browserCheckpoint(x,url),effect_state:'uncertain'};saveBrowserCheckpoint(x,foreignKey,foreignCheckpoint);const original=checkpointBytes(x,foreignKey);
  seedObserved(x,[{invocation:{request_id:'foreign-source',turn:0,stage_id:'search',tool_name:'office_web_search',arguments:{query,provider:'bing'},effect:'read_only',dispatched:true},receipt:{status:'succeeded',effect_state:'none',evidence_ids:['foreign-source'],retry_safe:true,value:{...page(url),requested_url:url,provenance:'live_browser_dom',effect:'read_only'}},observed_at:at}],foreign);
  const tools=x.create();const proposed=await tools.execute('office_browser_read',{url:article},'foreign-article');assert.equal(proposed.url,article);assert.deepEqual(x.events.filter(event=>event.kind==='open').map(event=>event.url),[article],'Foreign-run history grants nothing; the article is opened as a fresh recorded proposal.');const value=await tools.execute('office_web_search',{query,provider:'bing'},'fresh');assert.equal(value.url,url);assert.deepEqual(x.events.filter(event=>event.kind==='open').map(event=>event.url),[article,url]);assert.equal(checkpointBytes(x,foreignKey),original);
});

test('runtime fixture legacy challenge recovery does not reopen its challenge cursor and only an independent search provider is observed',async t=>{
  const x=await setup(t,{observe:url=>new URL(url).hostname==='www.google.com'?challenge(url):queriedPage(url)}),first=x.create(),query='ASTS legacy challenge',requested=entry('google',query),observed=await recordedRead(x,first,'office_web_search',{query,provider:'google'},'legacy-challenge');
  const legacyValue={...observed.receipt.value};delete legacyValue.search_provider;delete legacyValue.search_access;delete legacyValue.status;delete legacyValue.reason;seedObserved(x,[{...observed,receipt:{...observed.receipt,status:'succeeded',value:legacyValue,evidence_ids:['legacy-challenge'],retry_safe:true}}]);
  const key=legacyBrowserKey(x,requested);saveBrowserCheckpoint(x,key,browserCheckpoint(x,requested,'https://www.google.com/sorry/index'));const original=checkpointBytes(x,key);await first.close();const before=x.events.length,resumed=x.create();
  assert.throws(()=>resumed.validate('office_web_search',{query,provider:'google'},'again'),/WORK_SEARCH_PROVIDER_BLOCKED/u);await assert.rejects(resumed.execute('office_web_search',{query,provider:'google'},'again'),/WORK_SEARCH_PROVIDER_BLOCKED/u);await assert.rejects(resumed.execute('office_browser_read',{url:'https://www.google.com/sorry/index'},'challenge-cursor'),/BROWSER_URL_NOT_OBSERVED/u);assert.equal(x.events.length,before);
  const value=await resumed.execute('office_web_search',{query,provider:'bing'},'independent');assert.equal(value.url,entry('bing',query));assert.deepEqual(x.events.slice(before).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[entry('bing',query)]);assert.equal(checkpointBytes(x,key),original);assert.ok(x.events.every(event=>event.url!=='https://www.google.com/sorry/index'));
});

test('runtime fixture generic saved-cursor restoration remains the default while explicit read-only entry restoration opens only its requested URL',async t=>{
  const x=await setup(t,{observe:queriedPage}),u1=entry('bing','Generic entry'),u2=entry('bing','Generic saved cursor'),saved=browserCheckpoint(x,u1,u2),original=structuredClone(saved),snapshots=[];
  for(const mode of [undefined,'entry_url']){const before=x.events.length,router=new RoutedBrowser(x.config,{...routeOptions(x),...(mode?{restore_navigation:mode}:{}),factory:x.factory,checkpoint:{load:()=>saved,save:value=>snapshots.push(structuredClone(value))}},[new URL(u1).origin]);try{await router.open(u1);const observed=await router.observe(),expected=mode?u1:u2;assert.equal(observed.url,expected);assert.equal(observed.text,'Observed query '+new URL(expected).searchParams.get('q'));assert.deepEqual(x.events.slice(before).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[expected]);assert.equal(snapshots.at(-1).binding,saved.binding);}finally{await router.close();}}
  assert.deepEqual(saved,original);assert.equal(x.events.filter(event=>event.kind==='factory').length,2);assert.equal(x.events.filter(event=>event.kind==='close').length,2);
});

const googleAliases=query=>{const raw='https://www.google.com/search?q='+encodeURIComponent(query),ordered=new URL('https://www.google.com/search');ordered.searchParams.set('num','10');ordered.searchParams.set('q',query);const spaced=new URL('https://www.google.com/search');spaced.searchParams.set('q',' '+query+' ');return [raw,entry('google',query),ordered.href,spaced.href];};

test('runtime fixture first direct search reads preserve the exact user URL but observed provider challenges never become successful evidence',async t=>{
  const query='ASTS direct search',urls={google:googleAliases(query)[0],bing:'https://www.bing.com/search?q='+encodeURIComponent(query),duckduckgo:'https://duckduckgo.com/html?q='+encodeURIComponent(query)};
  for(const provider of ['google','bing','duckduckgo']){const url=urls[provider],x=await setup(t,{prompt:'Read this public search page '+url,observe:current=>provider==='google'?challenge(current):page(current,{title:provider==='bing'?'Verify you are human':'Observed search challenge',text:provider==='duckduckgo'?'Unfortunately, bots use DuckDuckGo too.':'Human verification is required.'})}),tools=x.create(),value=await tools.execute('office_browser_read',{url},provider),receipt=await tools.receipt('office_browser_read',value,provider);
    assert.equal(value.requested_url,url);assert.equal(value.provenance,'live_browser_dom');assert.equal(value.effect,'read_only');assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.effect_state,'none');assert.equal(receipt.retry_safe,false);assert.deepEqual(receipt.evidence_ids,[]);assert.deepEqual(x.events.filter(event=>event.kind==='open').map(event=>event.url),[url]);assert.equal(workTail(x.store,x.config.project.id,x.work.work_id).filter(event=>event.kind==='source.observed').length,0);assert.deepEqual((await tools.execute('office_browser_links',{},'blocked-links')).urls,[]);
    assert.equal(tools.validate('office_browser_read',{url:article},'blocked-result-link').url,article,'A public page may be opened as a recorded proposal; the challenge page grants no link authority.');await tools.close();}
});

test('runtime fixture a preserved search challenge blocks every user-supplied equivalent browser-read alias before any resumed navigation',async t=>{
  const query='ASTS alias scope',aliases=googleAliases(query),x=await setup(t,{prompt:'Research these public sources '+aliases.join(' '),observe:url=>new URL(url).hostname==='www.google.com'?challenge(url):queriedPage(url)}),first=x.create(),observed=await recordedRead(x,first,'office_web_search',{query,provider:'google'},'original-search');seedObserved(x,[observed]);await first.close();const before=x.events.length,resumed=x.create();
  for(const url of aliases){assert.throws(()=>resumed.validate('office_browser_read',{url},'alias-preflight'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_SEARCH_PROVIDER_BLOCKED'&&error.not_dispatched===true);await assert.rejects(resumed.execute('office_browser_read',{url},'alias-direct'),/WORK_SEARCH_PROVIDER_BLOCKED/u);}
  assert.equal(x.events.length,before);assert.deepEqual((await resumed.execute('office_browser_links',{},'blocked-alias-list')).urls,[]);
  const value=await resumed.execute('office_web_search',{query,provider:'bing'},'independent-source');assert.equal(value.url,entry('bing',query));assert.deepEqual(x.events.slice(before).filter(event=>event.kind==='open'||event.kind==='navigate').map(event=>event.url),[entry('bing',query)]);
});

test('runtime fixture a same-run direct-read challenge restores the canonical provider-query block without normalizing the user navigation URL',async t=>{
  const query='ASTS direct alias scope',aliases=googleAliases(query),url=aliases[0],x=await setup(t,{prompt:'Read these public search URLs '+aliases.join(' '),observe:challenge}),first=x.create(),observed=await recordedRead(x,first,'office_browser_read',{url},'direct-search');assert.equal(observed.receipt.value.requested_url,url);assert.deepEqual(x.events.filter(event=>event.kind==='open').map(event=>event.url),[url]);seedObserved(x,[observed]);await first.close();const before=x.events.length,resumed=x.create();
  for(const alias of aliases){assert.throws(()=>resumed.validate('office_browser_read',{url:alias},'resumed-alias'),/WORK_SEARCH_PROVIDER_BLOCKED/u);await assert.rejects(resumed.execute('office_browser_read',{url:alias},'resumed-alias'),/WORK_SEARCH_PROVIDER_BLOCKED/u);}
  assert.throws(()=>resumed.validate('office_web_search',{query,provider:'google'},'fixed-search-alias'),/WORK_SEARCH_PROVIDER_BLOCKED/u);assert.deepEqual((await resumed.execute('office_browser_links',{},'resumed-links')).urls,[]);assert.equal(x.events.length,before);
});

test('runtime fixture only proven same-run direct challenge receipts restore refusal while legacy evidence stays intact and foreign or uncertain records are excluded',async t=>{
  const query='ASTS legacy direct read',url=googleAliases(query)[0],x=await setup(t,{prompt:'Read this public search page '+url,observe:challenge}),first=x.create(),observed=await recordedRead(x,first,'office_browser_read',{url},'legacy-direct'),legacyValue={...observed.receipt.value};delete legacyValue.search_provider;delete legacyValue.search_access;delete legacyValue.status;delete legacyValue.reason;
  const legacy={...observed,receipt:{...observed.receipt,status:'succeeded',value:legacyValue,evidence_ids:['legacy-direct'],retry_safe:true}},baseline=structuredClone(legacy);seedObserved(x,[legacy]);await first.close();const before=x.events.length;
  assert.throws(()=>x.create().validate('office_browser_read',{url},'legacy-block'),/WORK_SEARCH_PROVIDER_BLOCKED/u);assert.deepEqual(legacy,baseline);assert.deepEqual((await x.create().execute('office_browser_links',{},'legacy-links')).urls,[]);
  const variants=[{work_id:randomUUID()},{run_id:randomUUID()},{receipt:{...legacy.receipt,status:'reconciliation_required',effect_state:'uncertain'}},{receipt:{...legacy.receipt,effect_state:'uncertain'}},{invocation:{...legacy.invocation,dispatched:false}},{invocation:{...legacy.invocation,effect:'external_write'}}];
  for(const change of variants){const checkpoint={format:1,work_id:x.work.work_id,run_id:x.run,binding:'a'.repeat(64),turn:1,pending:null,observations:[{...legacy,...(change.receipt?{receipt:change.receipt}:{}),...(change.invocation?{invocation:change.invocation}:{})}],summary:'Excluded provenance fixture',...(change.work_id?{work_id:change.work_id}:{}),...(change.run_id?{run_id:change.run_id}:{})};x.seed(checkpoint);const tools=x.create();assert.equal(tools.validate('office_browser_read',{url},'excluded-proof').url,url);assert.deepEqual((await tools.execute('office_browser_links',{},'excluded-links')).urls,[url]);}
  assert.equal(x.events.length,before);
});

test('runtime fixture search URL recognition grants no unobserved URL and ordinary CAPTCHA research articles remain successful direct reads',async t=>{
  const blocked=await setup(t),searchUrl=googleAliases('ASTS undelegated search')[0];await assert.rejects(blocked.create().execute('office_browser_read',{url:searchUrl},'undelegated-search'),/BROWSER_URL_NOT_OBSERVED/u);assert.deepEqual(blocked.events,[]);
  const url='https://example.org/captcha-research',x=await setup(t,{prompt:'Read this research article '+url,observe:current=>page(current,{title:'Article about CAPTCHA research',text:'Researchers compare CAPTCHA approaches; this is an ordinary article, not an access challenge.',links:[]})}),tools=x.create(),value=await tools.execute('office_browser_read',{url},'article'),receipt=await tools.receipt('office_browser_read',value,'article');assert.equal(value.requested_url,url);assert.equal(value.url,url);assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'none');assert.deepEqual(receipt.evidence_ids,['article']);assert.equal(value.search_access,undefined);
});

async function observedLinkCatalog(t,urls,browserTargets=null){
  const rootUrl='https://evidence.example/observed-index',chunks=[];let chunk=[];
  // Every seeded receipt first comes from a real call to the fixture browser
  // port and fits the same metadata budget. No invented model URLs are seeded.
  for(const url of urls){const link={text:'Observed source',url},next=[...chunk,link];if(chunk.length&&(next.length>120||Buffer.byteLength(JSON.stringify(next))>10000)){chunks.push(chunk);chunk=[];}chunk.push(link);}
  if(chunk.length)chunks.push(chunk);let observed=0;
  const x=await setup(t,{prompt:'Read this public index '+rootUrl,browserTargets,observe:url=>page(url,{title:'Observed source index',text:'Fixture observation of exact public hrefs.',links:chunks[observed]??[]})}),reader=x.create(),receipts=[];
  for(let i=0;i<chunks.length;i++){observed=i;const row=await recordedRead(x,reader,'office_browser_read',{url:rootUrl},'source-page-'+i);assert.ok(Buffer.byteLength(JSON.stringify(row.receipt.value))<16000);receipts.push(row);}
  seedObserved(x,receipts);await reader.close();const rawCheckpoint=x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(x.run).checkpoint;
  return {...x,tools:x.create(),expected:[rootUrl,...urls],rawCheckpoint};
}

test('runtime contract browser link pagination preserves empty-argument compatibility and advertises strict default and maximum page sizes',async t=>{
  const urls=Array.from({length:44},(_,i)=>'https://evidence.example/source-'+i),x=await observedLinkCatalog(t,urls),tool=x.tools.catalog().find(item=>item.name==='office_browser_links');
  assert.equal(tool.effect,'read_only');assert.equal(tool.input_schema.additionalProperties,false);assert.equal(tool.input_schema.properties.offset.default,0);assert.equal(tool.input_schema.properties.offset.minimum,0);assert.equal(tool.input_schema.properties.limit.default,20);assert.equal(tool.input_schema.properties.limit.minimum,1);assert.equal(tool.input_schema.properties.limit.maximum,40);
  assert.deepEqual(x.tools.validate('office_browser_links',{},'default-input'),{offset:0,limit:20});const before=x.events.length,first=await x.tools.execute('office_browser_links',{},'default-page');
  assert.deepEqual(first.urls,x.expected.slice(0,20));assert.equal(first.total_urls,45);assert.equal(first.offset,0);assert.equal(first.next_offset,20);assert.equal(first.has_more,true);assert.match(first.snapshot_id,/^[a-f0-9]{64}$/u);
  const wider=await x.tools.execute('office_browser_links',{limit:40},'maximum-page');assert.deepEqual(wider.urls,x.expected.slice(0,40));assert.equal(wider.next_offset,40);assert.equal(wider.snapshot_id,first.snapshot_id);assert.deepEqual(wider.executors,first.executors);assert.equal(x.events.length,before);
});

test('runtime fixture 250 mixed whole URLs paginate without truncation loss or duplicates under URL and complete metadata byte budgets',async t=>{
  const longIndexes=new Set([0,1,2,63,127,191,248]),urls=Array.from({length:249},(_,i)=>{const prefix='https://evidence.example/source-'+i+'?observed=';return longIndexes.has(i)?prefix+'a'.repeat(4096-prefix.length):new URL(prefix+'한글-'+i).href;}),targets=Array.from({length:16},(_,i)=>({id:('executor_'+i+'_').padEnd(64,'a'),engine:'playwright',environment:'owned_headless',profile_ref:('profile_'+i+'_').padEnd(64,'b'),platform:process.platform,priority:50})),x=await observedLinkCatalog(t,urls,targets),before=x.events.length,seen=[];
  let offset=0,snapshot,executors,byteLimited=false,pages=0;
  for(;;){const args={offset,limit:40,...(snapshot?{snapshot_id:snapshot}:{})},value=await x.tools.execute('office_browser_links',args,'links-'+pages++);assert.equal(value.offset,offset);assert.equal(value.total_urls,250);assert.ok(value.urls.length>0&&value.urls.length<=40);assert.ok(Buffer.byteLength(JSON.stringify(value.urls))<=10000);assert.ok(Buffer.byteLength(JSON.stringify(value))<16000);assert.deepEqual(boundWorkToolValue(value),value);assert.equal(value._office_compaction,undefined);
    assert.deepEqual(value.urls,x.expected.slice(offset,offset+value.urls.length));if(snapshot)assert.equal(value.snapshot_id,snapshot);else snapshot=value.snapshot_id;if(executors)assert.deepEqual(value.executors,executors);else executors=value.executors;
    seen.push(...value.urls);if(!value.has_more){assert.equal(value.next_offset,null);break;}assert.equal(value.next_offset,offset+value.urls.length);assert.ok(value.next_offset>offset);if(value.urls.length<40)byteLimited=true;offset=value.next_offset;assert.ok(pages<=250,'pagination must make finite forward progress');}
  assert.equal(seen.length,250);assert.equal(new Set(seen).size,250);assert.deepEqual(seen,x.expected);assert.ok(byteLimited,'long exact hrefs must reduce a page instead of being shortened');assert.equal(executors.length,16);for(const index of longIndexes)assert.equal(seen[index+1].length,4096);
  assert.equal(x.events.length,before);assert.equal(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(x.run).checkpoint,x.rawCheckpoint);
});

test('runtime contract invalid browser link cursors limits snapshots and unknown arguments are rejected before any navigation',async t=>{
  const x=await setup(t),tools=x.create(),invalid=[{offset:-1},{offset:0.5},{offset:'0'},{offset:100001},{limit:0},{limit:41},{limit:1.5},{limit:'20'},{snapshot_id:'a'.repeat(63)},{snapshot_id:'g'.repeat(64)},{snapshot_id:12},{url:'https://example.org/invented'},{provider:'bing'},{offset:0,limit:20,extra:true}];
  for(const args of invalid)assert.throws(()=>tools.validate('office_browser_links',args,'invalid-cursor'));assert.deepEqual(x.events,[]);assert.equal(x.store.browserExecutors().checkpoint(x.config.project.id,legacyBrowserKey(x,article)),null);
});

test('runtime fixture a changed observed link snapshot is a non-dispatched correction and never alters the previous page or opens a source',async t=>{
  const rootUrl='https://example.org/public-index',x=await setup(t,{prompt:'Read this public index '+rootUrl}),tools=x.create(),first=await tools.execute('office_browser_links',{},'before-observation'),original=structuredClone(first);
  assert.deepEqual(first.urls,[rootUrl]);const observed=await recordedRead(x,tools,'office_browser_read',{url:rootUrl},'new-observed-source');seedObserved(x,[observed]);const before=x.events.length,args={offset:1,limit:20,snapshot_id:first.snapshot_id};
  assert.throws(()=>tools.validate('office_browser_links',args,'stale-preflight'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_BROWSER_LINKS_SNAPSHOT_CHANGED'&&error.not_dispatched===true);
  await assert.rejects(tools.execute('office_browser_links',args,'stale-execution'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_BROWSER_LINKS_SNAPSHOT_CHANGED'&&error.not_dispatched===true);assert.equal(x.events.length,before);assert.deepEqual(first,original);
  const current=await tools.execute('office_browser_links',{},'restart-zero');assert.deepEqual(current.urls,[rootUrl,article]);assert.equal(current.offset,0);assert.equal(current.next_offset,null);assert.equal(current.has_more,false);assert.notEqual(current.snapshot_id,first.snapshot_id);
  const resumed=x.create(),restored=await resumed.execute('office_browser_links',{snapshot_id:current.snapshot_id},'restored-snapshot');assert.deepEqual(restored,current);assert.equal(x.events.length,before);
});

test('runtime fixture end-of-list cursors are explicit and pagination does not expand unobserved source navigation authority',async t=>{
  const urls=['https://evidence.example/observed-a','https://evidence.example/observed-b'],x=await observedLinkCatalog(t,urls),before=x.events.length,first=await x.tools.execute('office_browser_links',{},'all');
  const last=await x.tools.execute('office_browser_links',{offset:2,limit:1,snapshot_id:first.snapshot_id},'last');assert.deepEqual(last.urls,[urls[1]]);assert.equal(last.has_more,false);assert.equal(last.next_offset,null);
  for(const offset of [3,100000]){const value=await x.tools.execute('office_browser_links',{offset,snapshot_id:first.snapshot_id},'past-end');assert.deepEqual(value.urls,[]);assert.equal(value.total_urls,3);assert.equal(value.offset,offset);assert.equal(value.next_offset,null);assert.equal(value.has_more,false);assert.equal(value.snapshot_id,first.snapshot_id);}
  const unknown='https://evidence.example/unobserved';assert.throws(()=>x.tools.validate('office_browser_links',{url:unknown,offset:0},'invented-cursor'));assert.equal(x.tools.validate('office_browser_read',{url:unknown},'invented-source').url,unknown,'Pagination grants no authority; an unobserved public page is only a recorded proposal.');assert.equal(x.events.length,before);
  const value=await x.tools.execute('office_browser_read',{url:urls[1]},'delegated-source');assert.equal(value.requested_url,urls[1]);assert.equal(value.url,urls[1]);assert.equal(value.effect,'read_only');
});
