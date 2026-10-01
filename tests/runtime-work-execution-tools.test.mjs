import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {execFileSync} from 'node:child_process';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {WorkExecutionTools} from '../dist/work/execution-tools.js';
import {BoundedWorkClientExecutor,WorkClientToolInputError,WORK_CLIENT_EXECUTION_INSTRUCTIONS} from '../dist/work/client-executor.js';
import {initialWorkPlan} from '../dist/work/plan.js';
import {initWorkExecution} from '../dist/work/activity.js';
import {CodingRuntime} from '../dist/coding/runtime.js';
import {nativeProcessRunner} from '../dist/integrations/subscription-auth.js';
import {sha} from '../dist/packs/data.js';
import {hashJson} from '../dist/taskpack/adaptive-spec.js';
import {setSiteAuth} from '../dist/swarm/browser-auth.js';
import {workPlanningContext,WORK_DEFINITION_INSTRUCTIONS} from '../dist/work/runtime.js';

const model={calls:[],async call(){throw Error('No paid model in this test');}};
const proposal=(family='research.search')=>({title:'Disposable work',desired_outcome:'Observe the delegated source',completion_checks:[{id:'source',result:'Read source',evidence:'Source receipt'}],assumptions:[],route:{kind:'pack',pack_family:family},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:initialWorkPlan('Observe the delegated source','read_only')});
const recipe={version:1,family:'research.search',request:'Read delegated source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],query:'',search_fields:['name'],relevance:null,sort:null,limit:10};
function ready(store,config,spec=proposal(),prompt='Read https://example.test/start'){
 const begun=store.beginWork(config.project.id,randomUUID(),prompt,'quick'),owner=store.claimWorkDefinition(config.project.id,begun.work.id);
 return store.finishWorkDefinition(config.project.id,begun.work.id,owner,spec,[],'ready');
}
async function fixture(t,{spec=proposal(),prompt='Read https://example.test/start',packs,coding}={}){
 const root=await mkdtemp(join(tmpdir(),'office-execution-tools-')),paths=await prepareLocalConnection(join(root,'office'));
 const raw=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));raw.environment='fixture';raw.account_ref='account-a';raw.fixture_url='http://127.0.0.1:9999/test/account-a/';if(packs)raw.packs=packs;if(coding)raw.coding=coding;await writeFile(paths.runtimeConfig,JSON.stringify(raw));
 const config=loadHostConfig(paths.runtimeConfig),store=new PackStore(config.dbPath);store.registerProject(config.project);initWorkExecution(store);const work=ready(store,config,spec,prompt),calls=[];
 const api={async call(name,args){calls.push({name,args:structuredClone(args)});return {status:'succeeded'};}},toolkit=new WorkExecutionTools(store,config,api,work.id,randomUUID(),spec,prompt,()=>{},model);
 t.after(async()=>{await toolkit.close();store.close();await rm(root,{recursive:true,force:true});});
 return {root,config,store,spec,work,calls,api,toolkit};
}
function windowsRun(x,work=x.work,extra={}){
 x.store.desktopState.exec('CREATE TABLE IF NOT EXISTS windows_workflow_run(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_id TEXT NOT NULL,work_id TEXT NOT NULL,body TEXT NOT NULL)');
 const id=randomUUID(),body={id,work_id:work.id,status:'ready',revision:0,reason:'AWAITING_OBSERVATION',receipts:[],...extra};
 x.store.desktopState.prepare('INSERT INTO windows_workflow_run VALUES(?,?,?,?,?)').run(id,x.config.project.id,randomUUID(),work.id,JSON.stringify(body));return body;
}
test('runtime contract missing Pack policy and unregistered sources are rejected before dispatch, with usable browser guidance',async t=>{
 const absent=await fixture(t);assert.equal(absent.config.packs,null);
 assert.throws(()=>absent.toolkit.validate('runtime_pack_run',{recipe},'no-policy'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_PACK_CONNECTION_REQUIRED');
 assert.deepEqual(absent.calls,[]);assert.deepEqual(absent.store.officeRuns(absent.config.project.id,absent.work.id),[]);
 const empty=await fixture(t,{packs:{sources:[],targets:[],models:'off'}});
 assert.throws(()=>empty.toolkit.validate('runtime_pack_run',{recipe},'no-source'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_PACK_SOURCE_NOT_CONNECTED');
 assert.deepEqual(empty.calls,[]);assert.deepEqual(empty.store.officeRuns(empty.config.project.id,empty.work.id),[]);
 assert.match(absent.toolkit.catalog().find(tool=>tool.name==='office_web_search').description,/provider_change_allowed=true search with bing or open a known official page/u);
});
test('runtime contract registered Pack file source is not treated as an ungranted user folder',async t=>{
 const source={id:'nyc311_file',kind:'file',path:join(tmpdir(),'registered-pack-source.json'),format:'json'};
 const x=await fixture(t,{spec:proposal('file.pipeline'),packs:{sources:[source],targets:[],models:'off'}});
 const context=workPlanningContext(x.store,x.config);
 assert.deepEqual(context.connected_file_sources,[{kind:'file',id:'nyc311_file',format:'json'}]);
 assert.equal(JSON.stringify(context).includes(source.path),false,'Planning inventory does not reveal the registered local path');
 assert.match(WORK_DEFINITION_INSTRUCTIONS,/registered Pack file source.*runtime_pack_plan and runtime_pack_run/u);
 const mistaken={purpose:'Inspect connected nyc311_file to prepare its pipeline',read_content:true,allow_move:false};
 assert.throws(()=>x.toolkit.validate('runtime_files_request',mistaken,'mistaken-folder'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_PACK_FILE_ALREADY_CONNECTED'&&error.not_dispatched===true);
 await assert.rejects(x.toolkit.execute('runtime_files_request',mistaken,'direct-mistaken-folder'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_PACK_FILE_ALREADY_CONNECTED');
 assert.deepEqual(x.calls,[],'No folder permission request was dispatched');
 assert.doesNotThrow(()=>x.toolkit.validate('runtime_files_request',{purpose:'Organize a different unregistered user folder',allow_move:true},'real-folder'));
});
test('runtime contract Work tool catalog distinguishes durable drafts, local artifacts and external-capable effects; no grant/approve or cross-Work resume tool',async t=>{
 const x=await fixture(t),map=Object.fromEntries(x.toolkit.catalog().map(v=>[v.name,v]));
 assert.equal(map.runtime_pack_run.effect,'local_write');assert.equal(map.runtime_pack_execute_approved.effect,'external_write');assert.equal(map.runtime_windows_step.effect,'external_write');
 for(const name of ['runtime_files_request','runtime_files_scan','runtime_files_classify','runtime_files_propose','runtime_windows_design','runtime_windows_start'])assert.equal(map[name].effect,'draft_only');
 assert.equal(map.office_browser_read.effect,'read_only');assert.equal(map.runtime_pack_status.effect,'read_only');
 assert.match(map.office_result_draft.description,/actual TXT, JSON or CSV.*Agent Office/u);assert.match(map.office_result_draft.description,/explicitly requested CSV, JSON, Word or Excel/u);
 assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/"Office 결과 파일".*Agent Office/u);assert.match(WORK_CLIENT_EXECUTION_INSTRUCTIONS,/An explicit CSV, JSON, Word or Excel format requires actual bytes/u);
 for(const name of ['runtime_files_grant','runtime_files_apply','runtime_pack_approve','runtime_coding_last','runtime_windows_act'])assert.equal(map[name],undefined);
 assert.match(map.runtime_files_request.description,/never grants access/u);assert.match(map.runtime_pack_execute_approved.description,/cannot approve/u);
});
test('runtime fixture ticker social read uses only the historically ready registered profile and independently observes signed-in DOM',async t=>{
 const target={id:'neo-social',engine:'neo',environment:'host_foreground',profile_ref:'social',platform:process.platform,endpoint:'http://127.0.0.1:9010',priority:70};
 const spec={...proposal(),desired_outcome:'ASTS 기사 리서치',browser:{environment:'host_foreground',preferred_engine:'neo'}};
 const x=await fixture(t,{spec,prompt:'ASTS 기사 리서치'});x.config.browserExecutors={targets:[target]};
 const before=x.toolkit.catalog();assert.equal(before.some(tool=>tool.name==='office_social_search'),false);
 setSiteAuth(x.store,x.config,'x.com','ready',false,target);
 const selected=[],opens=[];let liveMarker=true,loginLimited=false;
 const tool=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),spec,'ASTS 기사 리서치',()=>{},model,{browserFactory:chosen=>{
   selected.push(chosen.id);let current='';return {target:chosen,async probe(){},async open(url){current=url;opens.push(url);},async navigate(url){current=url;},async observe(){return {url:loginLimited?'https://x.com/i/flow/login':current,title:'ASTS discussion',text:loginLimited?"We've temporarily limited your login. Please try again later.":'Visible discussion about ASTS; claims remain unverified.',links:[{text:'Visible post',url:'https://x.com/example/status/123'}],observed_at:new Date().toISOString()};},async extract(){return liveMarker?[{marker:'visible'}]:[];},async scroll(){},async close(){}};
 }});t.after(()=>tool.close());
 assert.equal(tool.catalog().find(item=>item.name==='office_social_search')?.effect,'read_only');
 await assert.rejects(tool.execute('office_social_search',{site:'reddit.com',query:'ASTS'},'reddit-unready'),/WORK_SOCIAL_PROFILE_NOT_READY/u);
 const observed=await tool.execute('office_social_search',{site:'x.com',query:'ASTS'},'social-ready');
 assert.deepEqual(selected,['neo-social']);assert.match(opens[0],/^https:\/\/x\.com\/search\?q=ASTS/u);
 assert.equal(observed.social_access,'signed_in_marker_observed');assert.equal(observed.provenance,'live_browser_dom');assert.equal(observed.executor,'neo-social');assert.equal(observed.links[0].url,'https://x.com/example/status/123');
 const receipt=await tool.receipt('office_social_search',observed,'social-ready');assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'none');
 loginLimited=true;const blocked=await tool.execute('office_social_search',{site:'x.com',query:'ASTS'},'social-limited');
 assert.equal(blocked.social_access,'not_verified');assert.equal(blocked.reason,'WORK_SOCIAL_LOGIN_LIMITED');assert.deepEqual(blocked.links,[]);assert.equal((await tool.receipt('office_social_search',blocked,'social-limited')).status,'retryable_failure');assert.deepEqual(selected,['neo-social']);
 await assert.rejects(tool.execute('office_social_search',{site:'x.com',query:'ASTS'},'social-retry'),/WORK_SOCIAL_PROFILE_NOT_READY/u);
});
test('runtime contract invalid Pack status ID is correctable before dispatch without exposing foreign runs',async t=>{
 const x=await fixture(t),owned=x.store.beginPack(x.config.project.id,'owned-status',recipe,'binding',x.work.id).run;
 const foreign=ready(x.store,x.config),other=x.store.beginPack(x.config.project.id,'foreign-status',recipe,'binding',foreign.id).run;
 assert.throws(()=>x.toolkit.validate('runtime_pack_status',{run_id:other.id},'invalid-read'),error=>{
   assert.ok(error instanceof WorkClientToolInputError);assert.equal(error.code,'WORK_TOOL_RUN_SCOPE_MISMATCH');
   assert.ok(error.detail.includes(owned.id));assert.equal(error.detail.includes(other.id),false);return true;
 });
 assert.equal(x.calls.length,0);
 assert.equal(x.toolkit.validate('runtime_pack_status',{run_id:owned.id},'valid-read').run_id,owned.id);
 await assert.rejects(x.toolkit.execute('runtime_pack_status',{run_id:other.id},'still-foreign'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
});
test('runtime fixture generic acronym article does not infer a signed-in social source',async t=>{
 const x=await fixture(t,{spec:{...proposal(),desired_outcome:'Read a generic API article'},prompt:'API 기사 리서치'});
 assert.equal(x.toolkit.catalog().some(item=>item.name==='office_social_search'),false);
});
test('runtime fixture social source never crosses an explicit browser environment or engine',async t=>{
 const target={id:'neo-social',engine:'neo',environment:'host_foreground',profile_ref:'social',platform:process.platform,endpoint:'http://127.0.0.1:9010',priority:70};
 const x=await fixture(t,{spec:{...proposal(),browser:{environment:'host_foreground',preferred_engine:'aside'}},prompt:'Read stock ticker discussion from X'});x.config.browserExecutors={targets:[target]};setSiteAuth(x.store,x.config,'x.com','ready',false,target);
 assert.equal(x.toolkit.catalog().some(item=>item.name==='office_social_search'),false);
 await assert.rejects(x.toolkit.execute('office_social_search',{site:'x.com',query:'ASTS'},'wrong-profile'),/WORK_SOCIAL_PROFILE_NOT_READY/u);
 await assert.rejects(x.toolkit.execute('office_browser_read',{url:'https://x.com/example/status/123'},'wrong-profile-link'),/WORK_SOCIAL_PROFILE_NOT_READY|BROWSER_URL_NOT_OBSERVED/u);
});
test('runtime contract API inputs are parsed before dispatch and every Work/run identity is scoped',async t=>{
 const x=await fixture(t),foreign=ready(x.store,x.config),theirPack=x.store.beginPack(x.config.project.id,'foreign-pack',recipe,'binding',foreign.id).run;
 await assert.rejects(x.toolkit.execute('runtime_pack_status',{run_id:theirPack.id},'foreign-status'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
 const theirWindows=windowsRun(x,foreign);
 for(const name of ['runtime_windows_status','runtime_windows_step'])await assert.rejects(x.toolkit.execute(name,{run_id:theirWindows.id,...(name.endsWith('step')?{expected_revision:0}:{})},name),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
 await assert.rejects(x.toolkit.execute('runtime_files_request',{work_id:foreign.id,purpose:'Read'},'foreign-work'),/WORK_TOOL_SCOPE_MISMATCH/u);
 await assert.rejects(x.toolkit.execute('runtime_windows_step',{run_id:randomUUID(),expected_revision:0,shell:'delete'},'raw-shell'),/unrecognized|Unrecognized/u);
 await assert.rejects(x.toolkit.execute('runtime_coding_last',{project_ref:'unrelated'},'unrelated-coding'),/WORK_TOOL_NOT_AVAILABLE/u);
 assert.equal(x.calls.length,0);
 await x.toolkit.execute('runtime_pack_plan',{prompt:'Read this source'},'planning');assert.equal(x.calls.at(-1).args.work_id,x.work.id);
});
test('runtime contract Pack family and browser placement cannot be enlarged by model arguments',async t=>{
 const x=await fixture(t,{spec:{...proposal(),browser:{environment:'owned_headless'}}});
 await assert.rejects(x.toolkit.execute('runtime_pack_run',{recipe:{...recipe,family:'portal.collect',format:'json',query:undefined,search_fields:undefined,relevance:undefined,sort:undefined,limit:undefined}},'wrong-family'));
 await assert.rejects(x.toolkit.execute('runtime_pack_run',{recipe:{...recipe,browser:{environment:'host_foreground'}}},'wrong-environment'),/BROWSER_WORK_ENVIRONMENT_CONFLICT/u);
 assert.equal(x.calls.length,0);
});
test('runtime native filesystem folder list and scans expose only this Work human-granted folder; request never grants',async t=>{
 const x=await fixture(t),a=join(x.root,'mine'),b=join(x.root,'other');await mkdir(a);await mkdir(b);await writeFile(join(a,'owned.txt'),'owned document');await writeFile(join(b,'other.txt'),'other work document');
 const files=x.store.localFileExplorer(x.config.project.id),foreign=ready(x.store,x.config),mine=files.request({work_id:x.work.id,path:a,purpose:'Read folder'}),other=files.request({work_id:foreign.id,path:b,purpose:'Read other folder'});
 const myRoot=files.grantRequest({work_id:x.work.id,request_id:mine.id,path:a}),otherRoot=files.grantRequest({work_id:foreign.id,request_id:other.id,path:b});x.api.call=async(name,input)=>files.call(name,input);
 const listed=await x.toolkit.execute('runtime_files_roots',{},'roots');assert.deepEqual(listed.map(r=>r.id),[myRoot.root.id]);
 await assert.rejects(x.toolkit.execute('runtime_files_scan',{root_id:otherRoot.root.id},'foreign-scan'),/WORK_TOOL_FILE_SCOPE_MISMATCH/u);
 const theirs=files.scan({root_id:otherRoot.root.id,work_id:foreign.id});
 for(const [name,input] of [['runtime_files_inspect',{scan_id:theirs.id}],['runtime_files_classify',{scan_id:theirs.id,items:[{file_id:theirs.files[0].id,category:'Document',reason:'Path',evidence_ids:['path']}]}]])await assert.rejects(x.toolkit.execute(name,input,'foreign-item'),/WORK_TOOL_FILE_SCOPE_MISMATCH/u);
 const scan=await x.toolkit.execute('runtime_files_scan',{root_id:myRoot.root.id},'scan');assert.equal(scan.files[0].path,'owned.txt');assert.equal(files.report({work_id:x.work.id}).observations[0].scan_id,scan.id);
 const inspected=await x.toolkit.execute('runtime_files_inspect',{scan_id:scan.id},'inspect');assert.equal(inspected.files.length,1);
 const pending=await x.toolkit.execute('runtime_files_request',{path:join(x.root,'ungranted'),purpose:'Need permission'},'access');assert.equal(pending.root_id,null);
 const receipt=await x.toolkit.receipt('runtime_files_request',pending,'access');assert.equal(receipt.status,'waiting_approval');assert.equal(receipt.effect_state,'none');assert.equal(files.roots().length,2);
});
test('runtime contract reply loss fences write-capable APIs across bounded-executor restart',async t=>{
 const x=await fixture(t),run=windowsRun(x),tool=x.toolkit.catalog().find(t=>t.name==='runtime_windows_step');let effects=0;
 x.api.call=async()=>{effects++;throw Error('LOST_REPLY_AFTER_EFFECT');};
 const decision={action:'tool',stage_id:'act',tool_name:tool.name,arguments_json:JSON.stringify({run_id:run.id,expected_revision:0}),summary:'Perform one approved native step',completed_checks:[],wait_reason:null},request={work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,max_turns:1};
 const host={tools:[tool],async checkpoint(){},executeTool:async(name,args,ctx)=>x.toolkit.receipt(name,await x.toolkit.execute(name,args,ctx.request_id),ctx.request_id)};
 const first=await new BoundedWorkClientExecutor({calls:[],async call(){return decision;}}).execute(request,host);assert.equal(first.status,'reconciliation_required');assert.equal(first.checkpoint.pending.effect,'external_write');assert.equal(effects,1);
 const restart=await new BoundedWorkClientExecutor(model).execute({...request,checkpoint:first.checkpoint},host);assert.equal(restart.status,'reconciliation_required');assert.equal(effects,1);
});
test('runtime contract status reads are successful observations, while drafts, missing permissions and uncertainty remain explicit',async t=>{
 const x=await fixture(t);
 assert.equal((await x.toolkit.receipt('runtime_windows_status',{status:'waiting_approval'},'status')).status,'succeeded');
 assert.equal((await x.toolkit.receipt('runtime_files_propose',{state:'preview'},'preview')).status,'waiting_approval');
 assert.equal((await x.toolkit.receipt('runtime_windows_step',{status:'waiting_connection'},'not-ready')).status,'retryable_failure');
 const uncertain=await x.toolkit.receipt('runtime_windows_step',{status:'ready',run_id:randomUUID()},'no-proof');assert.equal(uncertain.status,'reconciliation_required');assert.equal(uncertain.effect_state,'uncertain');assert.equal(uncertain.retry_safe,false);
});
test('runtime native Pack local export is independently hash-verified and stable request identity does not duplicate outputs',async t=>{
 const root=await mkdtemp(join(tmpdir(),'office-export-source-')),source=join(root,'source.json');await writeFile(source,JSON.stringify([{name:'Alpha',value:42}]));t.after(()=>rm(root,{recursive:true,force:true}));
 const x=await fixture(t,{spec:proposal('file.pipeline'),packs:{sources:[{id:'records',kind:'file',path:source,format:'json'}]}}),family=new FamilyRuntime(x.store,x.config);t.after(()=>family.drain());x.api.call=(name,input)=>family.call(name,input);
 const exportRecipe={version:1,family:'file.pipeline',request:'Export delegated source',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],columns:['name','value'],numeric_columns:['value'],sort:null,format:'json'};
 const result=await x.toolkit.execute('runtime_pack_run',{request_id:'model-cannot-change-id',recipe:exportRecipe},'stable-export');assert.equal(result.status,'succeeded');assert.equal(x.store.packRun(x.config.project.id,result.run_id).request_id,'stable-export');
 const receipt=await x.toolkit.receipt('runtime_pack_run',result,'stable-export');assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');assert.deepEqual(JSON.parse(await readFile(result.result.artifact.path,'utf8')),[{name:'Alpha',value:42}]);
 const contents=await x.toolkit.execute('office_result_read',{request_id:'stable-export'},'export-readback');assert.equal(contents.source_tool,'runtime_pack_run');assert.equal(contents.source_run_id,result.run_id);assert.deepEqual(JSON.parse(contents.text),[{name:'Alpha',value:42}]);
 const inode=(await stat(result.result.artifact.path)).ino,again=await x.toolkit.execute('runtime_pack_run',{recipe:exportRecipe},'stable-export');assert.equal(again.run_id,result.run_id);assert.equal((await stat(result.result.artifact.path)).ino,inode);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,1);
 await writeFile(result.result.artifact.path,'modified output');const invalid=await x.toolkit.receipt('runtime_pack_run',result,'stable-export');assert.equal(invalid.status,'reconciliation_required');assert.equal(invalid.effect_state,'uncertain');
});
test('runtime contract Windows verified receipt must be a fresh current-run postcondition, not a success string',async t=>{
 const x=await fixture(t),run=windowsRun(x);
 x.api.call=async(_name,input)=>{const receipt={step_id:'draft',action_id:'actual-effect',capture_id:'fresh-capture',evidence_refs:['actual-readback']},body={...run,revision:1,status:'ready',reason:'POSTCONDITION_VERIFIED',receipts:[receipt]};x.store.desktopState.prepare('UPDATE windows_workflow_run SET body=? WHERE id=?').run(JSON.stringify(body),run.id);return {run_id:run.id,status:'ready',revision:1,receipts:[receipt]};};
 const result=await x.toolkit.execute('runtime_windows_step',{run_id:run.id,expected_revision:0},'native-step'),receipt=await x.toolkit.receipt('runtime_windows_step',result,'native-step');assert.equal(receipt.effect_state,'verified');assert.equal(receipt.status,'succeeded');
 const stale=await x.toolkit.receipt('runtime_windows_step',result,'unbound-invocation');assert.equal(stale.effect_state,'uncertain');assert.equal(stale.status,'reconciliation_required');
});
test('runtime contract known Pack unapproved write is held without making an approval or invoking its API',async t=>{
 const x=await fixture(t),owned=x.store.beginPack(x.config.project.id,'owned-pack',recipe,'binding',x.work.id).run,task=randomUUID();
 x.store.desktopState.prepare('UPDATE family_run SET task_id=? WHERE id=?').run(task,owned.id);
 const actualTask=x.store.task.bind(x.store),actualProposal=x.store.proposal.bind(x.store);x.store.task=id=>id===task?{id:task,project_id:x.config.project.id,status:'waiting_approval',effect_state:'none'}:actualTask(id);x.store.proposal=id=>id===task?{state:'waiting_approval'}:actualProposal(id);
 const result=await x.toolkit.execute('runtime_pack_execute_approved',{run_id:owned.id},'unapproved');assert.equal(result.status,'waiting_approval');assert.equal(result.approval_created,false);assert.equal(x.calls.length,0);
 const receipt=await x.toolkit.receipt('runtime_pack_execute_approved',result,'unapproved');assert.equal(receipt.effect_state,'none');assert.equal(receipt.status,'waiting_approval');
 x.store.proposal=()=>({state:'consumed'});const uncertain=await x.toolkit.execute('runtime_pack_execute_approved',{run_id:owned.id},'consumed');assert.equal(uncertain.status,'reconciliation_required');assert.equal(uncertain.write_replayed,false);assert.equal(x.calls.length,0);
});
test('runtime native live browser result keeps exact observed redirect URL and anchor hrefs; unobserved URLs cannot be opened',async t=>{
 let posts=0;const server=createServer((request,response)=>{if(request.method!=='GET')posts++;if(request.url==='/start'){response.writeHead(302,{location:'/result?sort=price'});response.end();return;}response.setHeader('content-type','text/html; charset=utf-8');response.end('<title>Observed source</title><h1>Actual readback</h1><a href="/next?x=one&amp;y=two">Next evidence</a><a href="https://example.org/known">External observed</a><a href="https://example.org/?token=private">Sensitive link</a>');});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`,x=await fixture(t,{prompt:`Read ${origin}/start`});t.after(async()=>{await x.toolkit.close();await new Promise(resolve=>server.close(resolve));});
 const result=await x.toolkit.execute('office_browser_read',{url:origin+'/start'},'read');assert.equal(result.url,origin+'/result?sort=price');assert.equal(result.requested_url,origin+'/start');assert.equal(result.provenance,'live_browser_dom');assert.match(result.text,/Actual readback/u);assert.deepEqual(result.links.map(l=>l.url),[origin+'/next?x=one&y=two','https://example.org/known']);assert.equal(result.omitted_sensitive_links,1);assert.doesNotMatch(JSON.stringify(result),/token=private/u);
 const available=await x.toolkit.execute('office_browser_links',{},'links');assert.ok(available.urls.includes(result.url));assert.ok(available.urls.includes(result.links[0].url));assert.ok(!available.urls.includes('https://example.org/?token=private'));
 await assert.rejects(x.toolkit.execute('office_browser_read',{url:origin+'/invented'},'invented'),/BROWSER_URL_NOT_OBSERVED/u);await assert.rejects(x.toolkit.execute('office_browser_links',{url:'invented'},'bad-input'));
 assert.equal((await x.toolkit.receipt('office_browser_read',result,'read')).effect_state,'none');assert.equal(posts,0);
});
test('runtime native Office result draft is scoped, immutable per request, hash-verified and served without external delivery',async t=>{
 const x=await fixture(t),args={label:'Source summary',text:'Read the observed source.\nA second factual sentence.'};
 const result=await x.toolkit.execute('office_result_draft',args,'report-one');assert.equal(result.external_delivery,false);assert.equal(result.work_id,x.work.id);assert.equal(result.run_id,x.toolkit.runId);assert.equal(result.title,args.label);assert.match(result.artifact.path,new RegExp(x.work.id));
 assert.equal(await readFile(result.artifact.path,'utf8'),args.text+'\n');assert.equal((await x.toolkit.receipt('office_result_draft',result,'report-one')).effect_state,'verified');
 const readback=await x.toolkit.execute('office_result_read',{request_id:result.request_id},'read-report');assert.equal(readback.text,args.text+'\n');assert.equal(Buffer.byteLength(readback.text),readback.page.returned_bytes);assert.equal(readback.verified_by,'independent_sha256_and_bytes_readback');assert.deepEqual(readback.artifact,result.artifact);
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'unobserved-report'},'not-ours'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'report-one',path:'/other-work.txt'},'arbitrary-path'));
 const again=await x.toolkit.execute('office_result_draft',args,'report-one');assert.equal(again.deduplicated,true);assert.equal(again.artifact.path,result.artifact.path);
 await assert.rejects(x.toolkit.execute('office_result_draft',{...args,text:'Conflicting replacement'},'report-one'),/WORK_RESULT_REQUEST_ID_CONFLICT/u);assert.equal(await readFile(result.artifact.path,'utf8'),args.text+'\n');
 const other=x.store.beginWork(x.config.project.id,'other-report','Other report','quick').work;
 assert.equal((await x.toolkit.receipt('office_result_draft',{...result,work_id:other.id},'report-one')).status,'reconciliation_required');assert.equal((await x.toolkit.receipt('office_result_draft',result,'different-request')).status,'reconciliation_required');
 await writeFile(result.artifact.path,'Interrupted or modified report');assert.equal((await x.toolkit.receipt('office_result_draft',result,'report-one')).status,'reconciliation_required');assert.equal(x.calls.length,0);
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'report-one'},'tampered'),/WORK_RESULT_READBACK_MISMATCH/u);
});
test('runtime contract a returned write receipt survives an intervening pause instead of becoming replayable failure',async t=>{
 const x=await fixture(t),run=windowsRun(x);let paused=false,guards=0;
 const toolkit=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),x.spec,x.work.prompt,()=>{guards++;if(paused)throw Error('WORK_PAUSED');},model);t.after(()=>toolkit.close());
 x.api.call=async()=>{paused=true;return {run_id:run.id,status:'waiting_approval',revision:1};};
 const value=await toolkit.execute('runtime_windows_step',{run_id:run.id,expected_revision:0},'pause-after-dispatch');assert.equal(value.status,'waiting_approval');assert.equal(guards,1);assert.equal((await toolkit.receipt('runtime_windows_step',value,'pause-after-dispatch')).status,'waiting_approval');
 await assert.rejects(toolkit.execute('runtime_windows_status',{run_id:run.id},'next-operation'),/WORK_PAUSED/u);
});
test('runtime contract pre-dispatch validation retains Zod refinements and same host identity without any execution',async t=>{
 const x=await fixture(t);
 assert.throws(()=>x.toolkit.validate('runtime_work_context',{actor:'planner',reference_ids:['source'],selection:{focus:'source'}},'bad-context'),error=>error.name==='ZodError'&&/Choose explicit reference/u.test(error.message));
 const input=x.toolkit.validate('runtime_work_context',{actor:'planner',run_id:x.toolkit.runId},'valid-context');assert.equal(input.work_id,x.work.id);assert.equal(input.run_id,undefined);
 assert.throws(()=>x.toolkit.validate('runtime_files_request',{work_id:'another',purpose:'Inspect'},'foreign-work'),/WORK_TOOL_SCOPE_MISMATCH/u);
 assert.throws(()=>x.toolkit.validate('office_result_draft',{text:''},'empty'),error=>error.name==='ZodError');assert.equal(x.calls.length,0);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,0);
});
test('runtime native Office result read resumes only verified same Work/run persisted receipts',async t=>{
 const x=await fixture(t),draft=await x.toolkit.execute('office_result_draft',{text:'Persisted result'},'persisted-report'),receipt=await x.toolkit.receipt('office_result_draft',draft,'persisted-report');
 x.store.desktopState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,checkpoint TEXT)');
 x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(x.toolkit.runId,x.config.project.id,x.work.id,JSON.stringify({observations:[{invocation:{tool_name:'office_result_draft',request_id:'persisted-report'},receipt}]}));
 const restored=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,x.toolkit.runId,x.spec,x.work.prompt,()=>{},model);t.after(()=>restored.close());
 assert.equal((await restored.execute('office_result_read',{request_id:'persisted-report'},'read-after-restart')).text,'Persisted result\n');
 const otherRun=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),x.spec,x.work.prompt,()=>{},model);t.after(()=>otherRun.close());
 await assert.rejects(otherRun.execute('office_result_read',{request_id:'persisted-report'},'wrong-run'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);
});
async function codingFixture(t,{effect='local_file_write',approved=true}={}){
 const root=await mkdtemp(join(tmpdir(),'office-tool-coding-')),repo=join(root,'repo');await mkdir(repo);await writeFile(join(repo,'README.md'),'# Disposable CLI fixture\n');await writeFile(join(repo,'main.txt'),'initial\n');
 const gitExecutable=process.platform==='win32'?'git.exe':'/usr/bin/git',git=(...args)=>execFileSync(gitExecutable,['-C',repo,...args],{encoding:'utf8',windowsHide:true});
 git('init','-q');git('config','user.name','Disposable fixture');git('config','user.email','fixture@example.test');git('add','.');git('commit','-qm','base');t.after(()=>rm(root,{recursive:true,force:true}));
 const spec={...proposal('coding.orchestrate'),requested_effect:effect},x=await fixture(t,{spec,prompt:'demo 프로젝트 기능을 구현하고 Claude로 검토한 후 수정해줘',coding:{projects:[{id:'demo',root:repo,allow_write:true,allow_commit:false,verify:[]}],model_data_approved:approved}}),cli=[];
 const plan={goal:'Implement and verify disposable fixture',stages:[{id:'implement',actor:'codex',operation:'implement',instruction:'Implement delegated main.txt fixture change',evidence:'Exact diff and configured checks',source_paths:['main.txt']},{id:'review',actor:'claude',operation:'review',instruction:'Review the actual implementation diff',evidence:'Typed independent review',source_paths:['main.txt']},{id:'followup',actor:'codex',operation:'implement',instruction:'Apply the reviewed follow-up fixture change',evidence:'Saved same-session response and diff',source_paths:['main.txt']}],completion_checks:['Verify delegated local change']};
 const planner={calls:[],async call(){this.calls.push('plan');return structuredClone(plan);}},runner={async run(request){
  if(request.executable===gitExecutable)return nativeProcessRunner.run(request);cli.push(request);
  if(request.executable==='/fake/codex'){await writeFile(join(repo,'main.txt'),`delegated fixture change ${cli.length}\n`);const stdout=[{type:'thread.started',thread_id:'11111111-1111-4111-8111-111111111111'},{type:'item.completed',item:{type:'agent_message',text:'Actual fixture CLI result.'}},{type:'turn.completed'}].map(v=>JSON.stringify(v)).join('\n')+'\n';request.onStdout?.(stdout);return {code:0,stdout,stderr:''};}
  if(request.executable==='/fake/claude'){const session=request.args[request.args.indexOf('--session-id')+1];return {code:0,stdout:JSON.stringify({session_id:session,structured_output:{approved:true,summary:'Fixture diff inspected.',issues:[]}}),stderr:''};}
  throw Error('UNEXPECTED_EXECUTABLE');
 }};
 const runtime=new CodingRuntime(x.store,x.config,planner,{runner,executables:{codex:'/fake/codex',claude:'/fake/claude'}});t.after(async()=>{runtime.close();await runtime.drain();});
 x.api.call=async(name,args)=>{x.calls.push({name,args:structuredClone(args)});const method={runtime_coding_start:'start',runtime_coding_step:'step',runtime_coding_status:'status',runtime_coding_pause:'pause',runtime_coding_reconcile:'reconcile'}[name];if(!method)throw Error('UNEXPECTED_TOOL');return runtime[method](args);};
 return {...x,repo,git,cli,planner,runtime};
}
test('runtime contract coding CLI stages execute under this Work and only the same saved session resumes; no duplicate run or foreign access',async t=>{
 const x=await codingFixture(t),map=Object.fromEntries(x.toolkit.catalog().map(v=>[v.name,v]));assert.equal(map.runtime_coding_start.effect,'local_write');assert.equal(map.runtime_coding_step.effect,'local_write');assert.equal(map.runtime_coding_dialog_turn,undefined);
 const begun=await x.toolkit.execute('runtime_coding_start',{project_ref:'demo',request_id:'untrusted-model-id'},'owned-coding');assert.equal(begun.work_id,x.work.id);assert.equal(x.store.codingRun(x.config.project.id,begun.run_id).request_id,'owned-coding');assert.equal((await x.toolkit.receipt('runtime_coding_start',begun,'owned-coding')).effect_state,'verified');
 let current=begun;for(let index=0;index<3;index++){const requestId=`stage-${index}`;current=await x.toolkit.execute('runtime_coding_step',{run_id:begun.run_id,expected_revision:current.revision},requestId);assert.equal((await x.toolkit.receipt('runtime_coding_step',current,requestId)).effect_state,'verified');}
 assert.equal(current.status,'completed');assert.equal(current.completion_verified,false);assert.equal(current.stages[0].summary,'Actual fixture CLI result.');assert.equal(current.stages[1].receipt.approved,true);assert.equal(x.planner.calls.length,1);
 const again=await x.toolkit.execute('runtime_coding_start',{project_ref:'demo'},'no-new-run');assert.equal(again.run_id,begun.run_id);assert.equal(again.reused_existing,true);assert.equal(x.planner.calls.length,1);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).filter(r=>r.source_kind==='coding').length,1);assert.equal((await x.toolkit.receipt('runtime_coding_start',again,'no-new-run')).effect_state,'verified');
 const codex=x.cli.filter(item=>item.executable==='/fake/codex');assert.equal(codex.length,2);assert.deepEqual(codex[1].args.slice(codex[1].args.indexOf('resume'),codex[1].args.indexOf('resume')+3),['resume','--json','11111111-1111-4111-8111-111111111111']);assert.equal(codex[1].args.includes('--last'),false);
 assert.equal((await x.toolkit.receipt('runtime_coding_step',current,'unbound-call')).status,'reconciliation_required');
 const other=ready(x.store,x.config,x.spec),otherTools=new WorkExecutionTools(x.store,x.config,x.api,other.id,randomUUID(),x.spec,other.prompt,()=>{},model);t.after(()=>otherTools.close());
 await assert.rejects(otherTools.execute('runtime_coding_status',{run_id:begun.run_id},'foreign-coding'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
 await writeFile(join(x.repo,'main.txt'),'unobserved concurrent edit\n');assert.equal((await x.toolkit.receipt('runtime_coding_start',again,'no-new-run')).status,'reconciliation_required');
});
test('runtime contract coding consent, Work write scope and imported approval remain human-owned without CLI launch',async t=>{
 const absent=await codingFixture(t,{approved:false}),needsConsent=await absent.toolkit.execute('runtime_coding_start',{project_ref:'demo'},'consent-needed');assert.equal(needsConsent.status,'waiting_approval');assert.equal(needsConsent.approval_created,false);assert.equal(absent.planner.calls.length,0);assert.equal(absent.cli.length,0);
 const readOnly=await codingFixture(t,{effect:'read_only'}),prepared=await readOnly.toolkit.execute('runtime_coding_start',{project_ref:'demo'},'readonly-plan'),held=await readOnly.toolkit.execute('runtime_coding_step',{run_id:prepared.run_id,expected_revision:prepared.revision},'no-write');assert.equal(held.reason,'WORK_CODING_WRITE_NOT_DELEGATED');assert.equal(held.approval_created,false);assert.equal(readOnly.cli.length,0);
 const imported=await codingFixture(t),id=randomUUID(),at=new Date().toISOString();imported.store.desktopState.prepare('INSERT INTO office_import VALUES(?,?,?,?,?,?,?,?,?)').run(id,imported.config.project.id,'project','accepted',JSON.stringify({scan:{root:imported.repo}}),'fixture-sha',imported.work.id,at,at);
 const heldImport=await imported.toolkit.execute('runtime_coding_start',{project_ref:'demo'},'not-approved');assert.equal(heldImport.reason,'WORK_IMPORT_CODING_PLAN_APPROVAL_REQUIRED');assert.equal(heldImport.approval_created,false);assert.equal(imported.planner.calls.length,0);assert.equal(imported.cli.length,0);assert.equal(imported.store.desktopState.prepare('SELECT COUNT(*) AS count FROM office_import_coding_approval').get().count,0);
 const ordinary=await fixture(t);assert.equal(ordinary.toolkit.catalog().some(tool=>tool.name==='runtime_coding_step'),false);await assert.rejects(ordinary.toolkit.execute('runtime_coding_start',{project_ref:'demo'},'wrong-family'),/WORK_TOOL_NOT_AVAILABLE/u);
});
test('runtime native task-free Pack data quality failure corrects through the bounded loop without a false human boundary',async t=>{
 const sourceRoot=await mkdtemp(join(tmpdir(),'office-quality-source-')),source=join(sourceRoot,'source.json'),original=JSON.stringify([{name:'Alpha',value:42,source_text:'Alpha is the observed name.'}]);await writeFile(source,original);t.after(()=>rm(sourceRoot,{recursive:true,force:true}));
 const x=await fixture(t,{spec:proposal('file.pipeline'),packs:{sources:[{id:'records',kind:'file',path:source,format:'json'}]}}),family=new FamilyRuntime(x.store,x.config);t.after(()=>family.drain());x.api.call=(name,input)=>family.call(name,input);
 const bad={version:1,family:'file.pipeline',request:'Export the exact delegated values',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],columns:['name','value'],numeric_columns:['value'],sort:null,format:'json',verification:[{id:'copied_name',kind:'literal_copy',source_field:'acceptance_records',value_field:'name'}]},good={...bad,verification:[{...bad.verification[0],source_field:'source_text'}]},receipts=[];
 const planning={calls:[],async call(_purpose,_instructions,input){this.calls.push(input);if(this.calls.length<=2){return {action:'tool',stage_id:'act',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe:this.calls.length===1?bad:good}),summary:this.calls.length===1?'Verify source fields':'Correct the field using observed source text',completed_checks:[],wait_reason:null};}return {action:'complete',stage_id:'complete',tool_name:null,arguments_json:null,summary:'Verified delegated values and artifact.',completed_checks:[{id:'source',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}],wait_reason:null};}};
 const result=await new BoundedWorkClientExecutor(planning).execute({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,max_turns:3},{tools:x.toolkit.catalog(),async checkpoint(){},validateTool:(name,args,context)=>x.toolkit.validate(name,args,context.request_id),executeTool:async(name,args,context)=>{const receipt=await x.toolkit.receipt(name,await x.toolkit.execute(name,args,context.request_id),context.request_id);receipts.push(receipt);return receipt;},verifyCompletion:async(_checks,observations)=>{const observed=observations.at(-1).receipt;return observed.status==='succeeded'&&observed.effect_state==='verified'&&observed.value.result.verification.all_checks_passed===true&&await readFile(source,'utf8')===original&&JSON.stringify(JSON.parse(await readFile(observed.value.result.artifact.path,'utf8')))===JSON.stringify([{name:'Alpha',value:42}]);}});
 assert.equal(receipts[0].status,'retryable_failure');assert.equal(receipts[0].effect_state,'verified');assert.equal(receipts[0].value.task_id,null);assert.equal(receipts[0].value.result.verification.originals_modified,false);assert.equal(receipts[0].value.result.verification.receipts[0].reason,'SOURCE_OR_VALUE_MISSING');assert.equal(receipts[0].value.correction.automatic_correction_allowed,true);assert.equal(receipts[0].value.correction.user_confirmation_required,false);assert.deepEqual(receipts[0].evidence_ids,[]);
 assert.equal(receipts[1].status,'succeeded');assert.equal(receipts[1].value.result.verification.all_checks_passed,true);assert.equal(result.status,'succeeded');assert.equal(planning.calls.length,3);assert.equal(await readFile(source,'utf8'),original);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,2);assert.deepEqual(JSON.parse(await readFile(receipts[1].value.result.artifact.path,'utf8')),[{name:'Alpha',value:42}]);
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:result.checkpoint.observations[0].invocation.request_id},'failed-quality-artifact'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);
});

async function qualityReadFixture(t,{foreign=false}={}){
 const sourceRoot=await mkdtemp(join(tmpdir(),'office-quality-read-')),source=join(sourceRoot,'source.json'),original=JSON.stringify([{name:'Alpha',value:42,source_text:'Alpha is the observed name.'}]);await writeFile(source,original);t.after(()=>rm(sourceRoot,{recursive:true,force:true}));
 const x=await fixture(t,{spec:proposal('file.pipeline'),packs:{sources:[{id:'records',kind:'file',path:source,format:'json'}]}}),family=new FamilyRuntime(x.store,x.config);t.after(()=>family.drain());x.api.call=async(name,args)=>{x.calls.push({name,args:structuredClone(args)});return family.call(name,args);};
 const bad={version:1,family:'file.pipeline',request:'Export the exact delegated values',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],columns:['name','value'],numeric_columns:['value'],sort:null,format:'json',verification:[{id:'copied_name',kind:'literal_copy',source_field:'missing_source_text',value_field:'name'}]},good={...bad,verification:[{...bad.verification[0],source_field:'source_text'}]},canonical='failed-quality-host-request',alias='model-proposed-pack-request';
 let toolkit=x.toolkit;
 if(foreign){const other=ready(x.store,x.config,x.spec);toolkit=new WorkExecutionTools(x.store,x.config,x.api,other.id,randomUUID(),x.spec,other.prompt,()=>{},model);t.after(()=>toolkit.close());}
 const value=await toolkit.execute('runtime_pack_run',{request_id:alias,recipe:bad},canonical),receipt=await toolkit.receipt('runtime_pack_run',value,canonical);assert.equal(receipt.status,'retryable_failure');assert.equal(receipt.value.correction.kind,'data_quality');assert.equal(receipt.effect_state,'verified');
 const checkpoint={format:1,work_id:x.work.id,run_id:x.toolkit.runId,binding:hashJson({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,checks:x.spec.completion_checks,tools:x.toolkit.catalog()}),turn:1,pending:null,observations:[{invocation:{request_id:canonical,turn:0,stage_id:'source',tool_name:'runtime_pack_run',arguments:{request_id:alias,recipe:bad},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()}],summary:'A preserved Pack quality failure.'};
 x.store.desktopState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,checkpoint TEXT)');x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(x.toolkit.runId,x.config.project.id,x.work.id,JSON.stringify(checkpoint));
 const save=cp=>x.store.desktopState.prepare('UPDATE office_supervisor SET checkpoint=? WHERE run_id=?').run(JSON.stringify(cp),x.toolkit.runId);
 return {...x,family,source,original,bad,good,value,canonical,alias,checkpoint,save};
}

test('runtime fixture native-shaped Pack plan over 16KB reuses typed catalog descriptions while preserving actual Work scope and connections',async t=>{
 const x=await qualityReadFixture(t),prompt='Plan the observed source without widening the Work.',full=await x.family.call('runtime_pack_plan',{prompt,work_id:x.work.id}),original=structuredClone(full);
 assert.ok(Buffer.byteLength(JSON.stringify(full))>16000,'The real planning response reproduces the metadata budget failure.');assert.ok(full.recipe_schema.oneOf.length>1);assert.ok(full.windows_profiles.length>0);
 const adapted=await x.toolkit.execute('runtime_pack_plan',{prompt},'bounded-plan');assert.deepEqual(full,original,'The direct MCP response remains complete and unmodified.');assert.ok(Buffer.byteLength(JSON.stringify(adapted))<=16000);
 for(const key of ['status','dispatch_allowed','cache_hit','recipe','instructions','execution_binding','requested_family','bound_runs','connections','browser_executors','windows_route','next_action'])assert.deepEqual(adapted[key],full[key],`${key} is not discarded or weakened.`);
 assert.deepEqual(adapted.families,full.families.filter(item=>item.id===x.spec.route.pack_family));assert.deepEqual(adapted.families_catalog_ref.ids,full.families.map(item=>item.id));assert.equal(adapted.families_catalog_ref.sha256,hashJson(full.families));
 assert.equal(adapted.recipe_schema.catalog_tool,'runtime_pack_run');assert.equal(adapted.recipe_schema.input_schema_pointer,'/properties/recipe');assert.equal(adapted.recipe_schema.response_sha256,hashJson(full.recipe_schema));assert.equal(adapted.recipe_schema.response_bytes,Buffer.byteLength(JSON.stringify(full.recipe_schema)));assert.equal(adapted.recipe_schema.sha256,hashJson(x.toolkit.catalog().find(tool=>tool.name==='runtime_pack_run').input_schema.properties.recipe));
 assert.equal(adapted.windows_profiles.catalog_tool,'runtime_windows_catalog');assert.deepEqual(adapted.windows_profiles.ids,full.windows_profiles.map(item=>item.id));assert.equal(adapted.windows_profiles.sha256,hashJson(full.windows_profiles));assert.equal(adapted.plan_view.unscoped_sha256,hashJson(full));
 const planning={calls:[],async call(){return {action:'tool',stage_id:'plan',tool_name:'runtime_pack_plan',arguments_json:JSON.stringify({prompt}),summary:'Inspect the exact Work family and configured sources.',completed_checks:[],wait_reason:null};}},result=await new BoundedWorkClientExecutor(planning).execute({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,max_turns:1},{tools:x.toolkit.catalog(),async checkpoint(){},validateTool:async(name,args,context)=>{await x.toolkit.validate(name,args,context.request_id);},executeTool:async(name,args,context)=>x.toolkit.receipt(name,await x.toolkit.execute(name,args,context.request_id),context.request_id)});
 assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED','Planning is not whole-Work completion, but metadata no longer stops the loop.');assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations.length,1);assert.equal(result.checkpoint.observations[0].receipt.status,'succeeded');assert.deepEqual(result.checkpoint.observations[0].receipt.value.connections,full.connections);assert.ok(Buffer.byteLength(JSON.stringify(result.checkpoint.observations[0].receipt.value))<=16000);assert.equal(await readFile(x.source,'utf8'),x.original);
});

test('runtime contract Work planning references never mask a changed tool schema or an unauthorized family',async t=>{
 const x=await qualityReadFixture(t),full=await x.family.call('runtime_pack_plan',{prompt:'Plan the exact Work.',work_id:x.work.id}),badSchema=structuredClone(full);badSchema.recipe_schema.oneOf[0].properties.family.const='forged-family';x.api.call=async()=>badSchema;
 await assert.rejects(x.toolkit.execute('runtime_pack_plan',{prompt:'Use changed schema'},'bad-plan-schema'),/WORK_TOOL_PLAN_SCHEMA_MISMATCH/u);assert.equal(badSchema.recipe_schema.oneOf[0].properties.family.const,'forged-family');
 x.api.call=async()=>({...full,requested_family:'form.draft-submit'});await assert.rejects(x.toolkit.execute('runtime_pack_plan',{prompt:'Change the family'},'bad-plan-family'),/WORK_TOOL_PACK_FAMILY_MISMATCH/u);assert.equal(await readFile(x.source,'utf8'),x.original);
});

test('runtime fixture successful Pack alias feedback resumes readback under the host ID without rerunning the Pack',async t=>{
 const x=await qualityReadFixture(t),canonical='successful-pack-host-id',alias='model-success-alias';
 const value=await x.toolkit.execute('runtime_pack_run',{request_id:alias,recipe:x.good},canonical),receipt=await x.toolkit.receipt('runtime_pack_run',value,canonical);
 assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');assert.equal(value.request_id,canonical);
 x.checkpoint.observations.push({invocation:{request_id:canonical,turn:1,stage_id:'source',tool_name:'runtime_pack_run',arguments:{request_id:alias,recipe:x.good},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()});
 x.checkpoint.turn=2;x.save(x.checkpoint);
 const before=await readFile(value.result.artifact.path),packCount=x.store.officeRuns(x.config.project.id,x.work.id).length,callCount=x.calls.length,executed=[];
 const planning={calls:[],async call(_purpose,_instructions,input){
   this.calls.push(structuredClone(input));
   if(this.calls.length===1)return {action:'tool',stage_id:'read-alias',tool_name:'office_result_read',arguments_json:JSON.stringify({request_id:alias}),summary:'Read the already verified Pack output.',completed_checks:[],wait_reason:null};
   if(this.calls.length===2){const rejected=input.checkpoint.observations.at(-1);assert.equal(rejected.invocation.dispatched,false);assert.equal(rejected.receipt.value.issues[0].code,'WORK_RESULT_REQUEST_ID_REQUIRED');assert.match(rejected.receipt.value.issues[0].message,new RegExp(canonical,'u'));assert.deepEqual(rejected.receipt.evidence_ids,[]);return {action:'tool',stage_id:'read-canonical',tool_name:'office_result_read',arguments_json:JSON.stringify({request_id:canonical}),summary:'Read the same output using the host ID.',completed_checks:[],wait_reason:null};}
   return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Verified Pack output was read.',completed_checks:[{id:'source',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}],wait_reason:null};
 }};
 const result=await new BoundedWorkClientExecutor(planning).execute({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,checkpoint:x.checkpoint,max_turns:3},{tools:x.toolkit.catalog(),checkpoint:x.save,validateTool:(name,args,context)=>x.toolkit.validate(name,args,context.request_id),executeTool:async(name,args,context)=>{executed.push(name);return x.toolkit.receipt(name,await x.toolkit.execute(name,args,context.request_id),context.request_id);},verifyCompletion:async(_checks,observations)=>{const read=observations.at(-1).receipt;return read.status==='succeeded'&&read.effect_state==='none'&&read.value.request_id===canonical&&JSON.stringify(JSON.parse(read.value.text))===JSON.stringify([{name:'Alpha',value:42}]);}});
 assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.deepEqual(executed,['office_result_read']);assert.equal(planning.calls.length,3);
 assert.equal(x.calls.length,callCount);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,packCount);assert.deepEqual(await readFile(value.result.artifact.path),before);assert.equal(await readFile(x.source,'utf8'),x.original);
});

for(const identity of ['canonical','alias'])test(`runtime fixture known owned quality result ${identity} read gives undispatched correction and the bounded Work finishes from a new verified receipt`,async t=>{
 const x=await qualityReadFixture(t),before=await readFile(x.value.result.artifact.path),executed=[];
 const planning={calls:[],inputs:[],async call(_purpose,_instructions,input){
  this.inputs.push(structuredClone(input));
  if(this.inputs.length===1)return {action:'tool',stage_id:'read-old',tool_name:'office_result_read',arguments_json:JSON.stringify({request_id:x[identity]}),summary:'Inspect the prior Pack output.',completed_checks:[],wait_reason:null};
  if(this.inputs.length===2){const rejected=input.checkpoint.observations.at(-1);assert.equal(rejected.invocation.dispatched,false);assert.equal(rejected.receipt.value.status,'not_dispatched');assert.equal(rejected.receipt.value.issues[0].code,'WORK_RESULT_QUALITY_NOT_VERIFIED');assert.ok(rejected.receipt.value.issues[0].message.includes(x.canonical));assert.deepEqual(rejected.receipt.evidence_ids,[]);return {action:'tool',stage_id:'correct-source',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({recipe:x.good}),summary:'Correct the source field without weakening the check.',completed_checks:[],wait_reason:null};}
  if(this.inputs.length===3)return {action:'tool',stage_id:'read-verified',tool_name:'office_result_read',arguments_json:JSON.stringify({request_id:input.checkpoint.observations.at(-1).invocation.request_id}),summary:'Read only the successful verified output.',completed_checks:[],wait_reason:null};
  return {action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Alpha: 42',completed_checks:[{id:'source',evidence_ids:input.checkpoint.observations.at(-1).receipt.evidence_ids}],wait_reason:null};
 }};
 const result=await new BoundedWorkClientExecutor(planning).execute({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,checkpoint:x.checkpoint,max_turns:4},{tools:x.toolkit.catalog(),checkpoint:x.save,validateTool:async(name,args,context)=>{await x.toolkit.validate(name,args,context.request_id);},executeTool:async(name,args,context)=>{executed.push({name,args});return x.toolkit.receipt(name,await x.toolkit.execute(name,args,context.request_id),context.request_id);},verifyCompletion:async(_checks,observations)=>{const last=observations.at(-1).receipt;return last.status==='succeeded'&&last.effect_state==='none'&&JSON.stringify(JSON.parse(last.value.text))===JSON.stringify([{name:'Alpha',value:42}])&&await readFile(x.source,'utf8')===x.original;}});
 assert.equal(result.status,'succeeded');assert.equal(result.completion_verified,true);assert.equal(planning.inputs.length,4);assert.deepEqual(executed.map(item=>item.name),['runtime_pack_run','office_result_read']);assert.equal(x.calls.length,2);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,2);assert.deepEqual(await readFile(x.value.result.artifact.path),before);assert.equal(await readFile(x.source,'utf8'),x.original);assert.equal(result.checkpoint.pending,null);assert.equal(result.checkpoint.observations[1].invocation.dispatched,false);
});

for(const boundary of ['foreign_work','other_run','arbitrary_request','changed_result_hash','changed_artifact_bytes','approval','uncertain_write','wrong_canonical_id'])test(`runtime fixture quality result read never converts ${boundary} into correctable authority`,async t=>{
 const x=await qualityReadFixture(t,{foreign:boundary==='foreign_work'});let toolkit=x.toolkit,requestId=x.canonical;
 if(boundary==='other_run'){toolkit=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),x.spec,x.work.prompt,()=>{},model);t.after(()=>toolkit.close());}
 if(boundary==='arbitrary_request')requestId='not-an-observed-request';
 if(boundary==='changed_result_hash')x.checkpoint.observations[0].receipt.value.result.verification.receipts[0].reason='Invented quality reason';
 if(boundary==='changed_artifact_bytes')await writeFile(x.value.result.artifact.path,'changed bytes');
 if(boundary==='approval'){x.store.finishPack(x.config.project.id,x.value.run_id,'waiting_approval',x.value.result,null);x.checkpoint.observations[0].receipt.value.status='waiting_approval';}
 if(boundary==='uncertain_write'){x.checkpoint.observations[0].receipt.effect_state='uncertain';x.checkpoint.observations[0].receipt.status='reconciliation_required';}
 if(boundary==='wrong_canonical_id'){x.checkpoint.observations[0].invocation.request_id='another-host-id';requestId=x.alias;}
 x.save(x.checkpoint);let failure;try{await toolkit.validate('office_result_read',{request_id:requestId},'preflight-read');}catch(error){failure=error;}
 assert.equal(failure instanceof WorkClientToolInputError,false,'Scope, uncertainty and changed receipts cannot use typed correction feedback.');
 if(['foreign_work','wrong_canonical_id'].includes(boundary))assert.match(failure?.message??'',/WORK_TOOL_RUN_SCOPE_MISMATCH/u);else assert.equal(failure,undefined);
 await assert.rejects(toolkit.execute('office_result_read',{request_id:requestId},'strict-read'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);assert.equal(x.calls.length,1);assert.equal(await readFile(x.source,'utf8'),x.original);
});

test('runtime fixture repeated failed quality read cannot dispatch or create an unbounded retry loop',async t=>{
 const x=await qualityReadFixture(t);let modelCalls=0,effects=0;
 const result=await new BoundedWorkClientExecutor({calls:[],async call(){modelCalls++;return {action:'tool',stage_id:'read-old',tool_name:'office_result_read',arguments_json:JSON.stringify({request_id:x.canonical}),summary:'Try the same rejected quality read.',completed_checks:[],wait_reason:null};}}).execute({work_id:x.work.id,run_id:x.toolkit.runId,prompt:x.work.prompt,completion_checks:x.spec.completion_checks,checkpoint:x.checkpoint,max_turns:4},{tools:x.toolkit.catalog(),checkpoint:x.save,validateTool:async(name,args,context)=>{await x.toolkit.validate(name,args,context.request_id);},executeTool:async()=>{effects++;throw Error('Rejected input must not dispatch.');}});
 assert.equal(result.status,'retryable_failure');assert.equal(result.reason,'WORK_CLIENT_TURN_BUDGET_REACHED');assert.equal(modelCalls,4,'Bounded by the run attempt turn budget.');assert.equal(effects,0);
 assert.ok(result.checkpoint.observations.every(item=>!item.invocation.dispatched||item.invocation.request_id===x.canonical),'No rejected read was dispatched.');assert.equal(result.checkpoint.pending,null);assert.equal(x.calls.length,1);assert.equal(await readFile(x.source,'utf8'),x.original);
});

test('runtime native registered file Pack receipts contain actual before/after hashes without exposing original contents and retain them after resume',async t=>{
 const x=await qualityReadFixture(t),raw=await x.toolkit.execute('runtime_pack_run',{recipe:x.good},'source-integrity-success'),receipt=await x.toolkit.receipt('runtime_pack_run',raw,'source-integrity-success'),expected=sha(Buffer.from(x.original));
 assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');assert.equal(receipt.value.source_integrity.length,1);const snapshot=receipt.value.source_integrity[0];
 assert.equal(snapshot.source_id,'records');assert.equal(snapshot.before_sha256,expected);assert.equal(snapshot.after_sha256,expected);assert.equal(snapshot.unchanged,true);assert.ok(Number.isFinite(Date.parse(snapshot.before_observed_at)));assert.ok(Date.parse(snapshot.after_observed_at)>=Date.parse(snapshot.before_observed_at));assert.ok(!JSON.stringify(receipt.value.source_integrity).includes('Alpha'));assert.equal(await readFile(x.source,'utf8'),x.original);
 x.checkpoint.observations.push({invocation:{request_id:'source-integrity-success',turn:1,stage_id:'source',tool_name:'runtime_pack_run',arguments:{recipe:x.good},effect:'local_write',dispatched:true},receipt,observed_at:new Date().toISOString()});x.save(x.checkpoint);
 const restored=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,x.toolkit.runId,x.spec,x.work.prompt,()=>{},model);t.after(()=>restored.close());
 assert.deepEqual((await restored.receipt('runtime_pack_run',raw,'source-integrity-success')).value.source_integrity,receipt.value.source_integrity);
 const count=x.store.officeRuns(x.config.project.id,x.work.id).length,again=await restored.execute('runtime_pack_run',{recipe:x.good},'source-integrity-success');assert.equal(again.deduplicated,true);assert.deepEqual(again.source_integrity,receipt.value.source_integrity);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,count);
});

test('runtime native a file modified during Pack execution has false hash evidence rather than a false unchanged claim',async t=>{
 const x=await qualityReadFixture(t),originalCall=x.api.call,changed=JSON.stringify([{name:'Beta',value:99,source_text:'Beta is observed after execution.'}]);
 x.api.call=async(name,args)=>{const value=await originalCall(name,args);await writeFile(x.source,changed);return value;};
 const raw=await x.toolkit.execute('runtime_pack_run',{recipe:x.good},'changed-during-pack'),receipt=await x.toolkit.receipt('runtime_pack_run',raw,'changed-during-pack'),integrity=receipt.value.source_integrity[0];
 assert.equal(integrity.before_sha256,sha(Buffer.from(x.original)));assert.equal(integrity.after_sha256,sha(Buffer.from(changed)));assert.equal(integrity.unchanged,false);assert.notEqual(integrity.before_sha256,integrity.after_sha256);assert.equal(raw.result.artifact.originals_modified,false,'Output generation alone is not source integrity proof.');assert.deepEqual(JSON.parse(await readFile(raw.result.artifact.path,'utf8')),[{name:'Alpha',value:42}]);assert.equal(await readFile(x.source,'utf8'),changed);
});

test('runtime native an unobserved file snapshot remains unknown and an old deduplicated Pack cannot gain fabricated fresh hashes',async t=>{
 const x=await qualityReadFixture(t),originalCall=x.api.call;await rm(x.source);
 x.api.call=async(name,args)=>{await writeFile(x.source,x.original);return originalCall(name,args);};
 const raw=await x.toolkit.execute('runtime_pack_run',{recipe:x.good},'initially-unobserved-source'),receipt=await x.toolkit.receipt('runtime_pack_run',raw,'initially-unobserved-source'),snapshot=receipt.value.source_integrity[0];
 assert.equal(snapshot.before_sha256,null);assert.equal(snapshot.before_observed_at,null);assert.equal(snapshot.after_sha256,sha(Buffer.from(x.original)));assert.equal(snapshot.unchanged,'unknown');
 const otherRun=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),x.spec,x.work.prompt,()=>{},model);t.after(()=>otherRun.close());
 const dedup=await otherRun.execute('runtime_pack_run',{recipe:x.good},'initially-unobserved-source');assert.equal(dedup.deduplicated,true);assert.equal(dedup.source_integrity,null);
});

test('runtime contract source integrity cannot be forged by model output, foreign Work, wrong invocation or legacy metadata absence',async t=>{
 const x=await qualityReadFixture(t),forged=[{source_id:'records',before_sha256:'a'.repeat(64),after_sha256:'a'.repeat(64),before_observed_at:new Date().toISOString(),after_observed_at:new Date().toISOString(),unchanged:true}];
 const own=await x.toolkit.receipt('runtime_pack_run',{...x.value,source_integrity:forged},x.canonical);assert.notEqual(own.value.source_integrity[0].before_sha256,forged[0].before_sha256);assert.equal(own.value.source_integrity[0].before_sha256,sha(Buffer.from(x.original)));
 const unobserved=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,randomUUID(),x.spec,x.work.prompt,()=>{},model);t.after(()=>unobserved.close());
 assert.equal((await unobserved.receipt('runtime_pack_run',{...x.value,source_integrity:forged},x.canonical)).value.source_integrity,null);assert.equal((await x.toolkit.receipt('runtime_pack_run',{...x.value,source_integrity:forged},'wrong-host-invocation')).value.source_integrity,null);
 const foreign=ready(x.store,x.config,x.spec),foreignTools=new WorkExecutionTools(x.store,x.config,x.api,foreign.id,randomUUID(),x.spec,foreign.prompt,()=>{},model);t.after(()=>foreignTools.close());const rejected=await foreignTools.receipt('runtime_pack_run',{...x.value,source_integrity:forged},x.canonical);assert.equal(rejected.status,'reconciliation_required');assert.equal(rejected.value.source_integrity,null);
 delete x.checkpoint.observations[0].receipt.value.source_integrity;x.save(x.checkpoint);const legacy=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,x.toolkit.runId,x.spec,x.work.prompt,()=>{},model);t.after(()=>legacy.close());assert.equal((await legacy.receipt('runtime_pack_run',x.value,x.canonical)).value.source_integrity,null);
});
test('runtime contract data quality correction cannot turn real approvals, unknown writes or unproven reviews into automatic execution',async t=>{
 const x=await fixture(t),owned=x.store.beginPack(x.config.project.id,'reviewed-data',recipe,'binding',x.work.id).run,report={verification:{scope:'supplied_source_snapshot',all_checks_passed:false,originals_modified:false,receipts:[{status:'unobserved',reason:'SOURCE_OR_VALUE_MISSING'}]}};
 x.store.finishPack(x.config.project.id,owned.id,'needs_review',report,null);
 const raw={run_id:owned.id,status:'needs_review',result:report,task_id:null};assert.equal((await x.toolkit.receipt('runtime_pack_run',raw,owned.request_id)).status,'retryable_failure');assert.equal((await x.toolkit.receipt('runtime_pack_run',raw,owned.request_id)).effect_state,'none');
 x.store.finishPack(x.config.project.id,owned.id,'needs_review',{verification:{...report.verification,originals_modified:true}},null);const unproven={...raw,result:{verification:{...report.verification,originals_modified:true}}};assert.equal((await x.toolkit.receipt('runtime_pack_run',unproven,'not-proven')).status,'waiting_approval');
 x.store.finishPack(x.config.project.id,owned.id,'waiting_approval',report,null);assert.equal((await x.toolkit.receipt('runtime_pack_run',{...raw,status:'waiting_approval'},'approval')).status,'waiting_approval');
 const task=randomUUID();x.store.desktopState.prepare('UPDATE family_run SET status=?,task_id=?,result=? WHERE id=?').run('needs_review',task,JSON.stringify(report),owned.id);
 const actualTask=x.store.task.bind(x.store),actualProposal=x.store.proposal.bind(x.store);x.store.task=id=>id===task?{project_id:x.config.project.id,status:'waiting_approval',effect_state:'none'}:actualTask(id);x.store.proposal=id=>id===task?{state:'waiting_approval'}:actualProposal(id);
 assert.equal((await x.toolkit.receipt('runtime_pack_run',{...raw,task_id:task},'approval-task')).status,'waiting_approval');
 x.store.task=()=>({project_id:x.config.project.id,status:'reconciliation_required',effect_state:'unknown'});const uncertain=await x.toolkit.receipt('runtime_pack_run',{...raw,task_id:task},'unknown-write');assert.equal(uncertain.status,'reconciliation_required');assert.equal(uncertain.effect_state,'uncertain');assert.equal(uncertain.retry_safe,false);assert.equal(x.calls.length,0);
});
test('runtime native verified Pack artifact readback survives restart and rejects foreign Work or changed bytes',async t=>{
 const sourceRoot=await mkdtemp(join(tmpdir(),'office-read-pack-')),source=join(sourceRoot,'source.json');await writeFile(source,JSON.stringify([{value:23},{value:17}]));t.after(()=>rm(sourceRoot,{recursive:true,force:true}));
 const x=await fixture(t,{spec:proposal('file.pipeline'),packs:{sources:[{id:'records',kind:'file',path:source,format:'json'}]}}),family=new FamilyRuntime(x.store,x.config);t.after(()=>family.drain());x.api.call=(name,args)=>family.call(name,args);
 const exportRecipe={version:1,family:'file.pipeline',request:'Read two delegated values',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:[],columns:['value'],numeric_columns:['value'],sort:null,format:'json'},result=await x.toolkit.execute('runtime_pack_run',{recipe:exportRecipe},'pack-output'),receipt=await x.toolkit.receipt('runtime_pack_run',result,'pack-output');assert.equal(receipt.status,'succeeded');assert.equal(receipt.effect_state,'verified');
 x.store.desktopState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,checkpoint TEXT)');const checkpoint=JSON.stringify({observations:[{invocation:{tool_name:'runtime_pack_run',request_id:'pack-output'},receipt}]});x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(x.toolkit.runId,x.config.project.id,x.work.id,checkpoint);
 const restored=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,x.toolkit.runId,x.spec,x.work.prompt,()=>{},model);t.after(()=>restored.close());const readback=await restored.execute('office_result_read',{request_id:'pack-output'},'after-restart');assert.equal(readback.source_tool,'runtime_pack_run');assert.equal(JSON.parse(readback.text).reduce((sum,row)=>sum+row.value,0),40);assert.equal(readback.artifact.sha256,result.result.artifact.sha256);assert.equal(readback.external_delivery,false);
 const foreign=ready(x.store,x.config,x.spec),foreignRun=randomUUID();x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(foreignRun,x.config.project.id,foreign.id,checkpoint);const foreignTools=new WorkExecutionTools(x.store,x.config,x.api,foreign.id,foreignRun,x.spec,foreign.prompt,()=>{},model);t.after(()=>foreignTools.close());await assert.rejects(foreignTools.execute('office_result_read',{request_id:'pack-output'},'copied-foreign-receipt'),/WORK_TOOL_RUN_SCOPE_MISMATCH/u);
 await writeFile(result.result.artifact.path,'changed output bytes');await assert.rejects(restored.execute('office_result_read',{request_id:'pack-output'},'bad-bytes'),/WORK_RESULT_READBACK_MISMATCH/u);await assert.rejects(restored.execute('office_result_read',{request_id:'pack-output',path:source},'raw-path'));
});
test('runtime contract Pack readback rejects binary formats without granting arbitrary folder access',async t=>{
 const x=await fixture(t),run=x.store.beginPack(x.config.project.id,'binary-readback',recipe,'binding',x.work.id).run;
 // Match the actual Office-owned artifact root rather than a user folder.
 const artifactRoot=join(dirname(x.config.dbPath),'pack-artifacts');await mkdir(artifactRoot,{recursive:true});
 for(const [id,format,bytes,expected]of [['binary','xlsx',Buffer.from([0,255,123,12]),'WORK_RESULT_UNSUPPORTED_FORMAT']]){
  const path=join(artifactRoot,`${run.id}-${id}.${format}`);await writeFile(path,bytes);const result={artifact:{path,sha256:sha(bytes),bytes:bytes.length,format,originals_modified:false}};x.store.finishPack(x.config.project.id,run.id,'succeeded',result,null);
  const raw={run_id:run.id,status:'succeeded',task_id:null,result},receipt=await x.toolkit.receipt('runtime_pack_run',raw,run.request_id);assert.equal(receipt.effect_state,'verified');await assert.rejects(x.toolkit.execute('office_result_read',{request_id:run.request_id},`${id}-read`),new RegExp(expected));
 }
 assert.equal(x.calls.length,0);assert.deepEqual(x.store.localFileExplorer(x.config.project.id).roots(),[]);
});

test('runtime native large Pack artifacts use bounded verified UTF-8 pages and retain full integrity checks',async t=>{
 const x=await fixture(t),run=x.store.beginPack(x.config.project.id,'paged-output',recipe,'binding',x.work.id).run;
 const root=join(dirname(x.config.dbPath),'pack-artifacts');await mkdir(root,{recursive:true});
 const path=join(root,run.id+'.txt'),bytes=Buffer.from('실제 자료 🌤️\n'.repeat(4000));await writeFile(path,bytes);
 const result={artifact:{path,sha256:sha(bytes),bytes:bytes.length,format:'txt',originals_modified:false}};
 x.store.finishPack(x.config.project.id,run.id,'succeeded',result,null);
 assert.equal((await x.toolkit.receipt('runtime_pack_run',{run_id:run.id,status:'succeeded',task_id:null,result},'paged-output')).effect_state,'verified');
 let offset=0,parts=[],pages=0;
 do{const page=await x.toolkit.execute('office_result_read',{request_id:'paged-output',offset,max_bytes:12000},'page-'+pages++);
   assert.equal(page.artifact.sha256,sha(bytes));assert.equal(page.page.total_bytes,bytes.length);assert.ok(page.page.returned_bytes<=12000);assert.equal(Buffer.byteLength(page.text),page.page.returned_bytes);assert.ok(!page.text.includes('\uFFFD'));
   parts.push(page.text);offset=page.page.next_offset;
 }while(offset!==null);
 assert.ok(pages>1);assert.equal(parts.join(''),bytes.toString('utf8'));
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'paged-output',offset:1},'bad-offset'),/WORK_RESULT_PAGE_OFFSET_INVALID/);
 await writeFile(path,Buffer.concat([bytes,Buffer.from('changed')]));
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:'paged-output',offset:12000},'changed'),/WORK_RESULT_READBACK_MISMATCH/);
 assert.deepEqual(x.store.localFileExplorer(x.config.project.id).roots(),[]);
});

test('runtime contract Pack result read rejects an alias of the durable host request ID, including after resume',async t=>{
 const x=await fixture(t),canonical='canonical-pack-result',alias='aliased-pack-result';
 const run=x.store.beginPack(x.config.project.id,canonical,recipe,'binding',x.work.id).run;
 const root=join(dirname(x.config.dbPath),'pack-artifacts');await mkdir(root,{recursive:true});
 const path=join(root,run.id+'.json'),bytes=Buffer.from('[{"value":42}]','utf8');await writeFile(path,bytes);
 const result={artifact:{path,sha256:sha(bytes),bytes:bytes.length,format:'json',originals_modified:false}};
 x.store.finishPack(x.config.project.id,run.id,'succeeded',result,null);
 const value={run_id:run.id,status:'succeeded',task_id:null,result};
 const wrong=await x.toolkit.receipt('runtime_pack_run',value,alias);
 assert.notEqual(wrong.effect_state,'verified');
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:alias},'alias-read'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);
 const verified=await x.toolkit.receipt('runtime_pack_run',value,canonical);
 assert.equal(verified.effect_state,'verified');
 x.store.desktopState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,checkpoint TEXT)');
 const forged={observations:[{invocation:{tool_name:'runtime_pack_run',request_id:alias},receipt:{...verified,value}},{invocation:{tool_name:'runtime_pack_run',request_id:canonical},receipt:verified}]};
 x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(x.toolkit.runId,x.config.project.id,x.work.id,JSON.stringify(forged));
 const restored=new WorkExecutionTools(x.store,x.config,x.api,x.work.id,x.toolkit.runId,x.spec,x.work.prompt,()=>{},model);t.after(()=>restored.close());
 await assert.rejects(restored.execute('office_result_read',{request_id:alias},'alias-after-resume'),/WORK_RESULT_RECEIPT_NOT_FOUND/u);
 assert.equal((await restored.execute('office_result_read',{request_id:canonical},'canonical-after-resume')).text,bytes.toString('utf8'));
});

test('runtime fixture artifactless successful Pack read gives a scoped Office draft ID without dispatch or file-scope failure',async t=>{
 const x=await fixture(t,{spec:proposal('inbox.triage')}),packId='triage-host-id',draftId='saved-report-host-id';
 const triage={version:1,family:'inbox.triage',request:'Classify connected records',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],judgment:{question:'Classify record',labels:{normal:'Routine'}},draft_by_label:{normal:'Internal note'}};
 const run=x.store.beginPack(x.config.project.id,packId,triage,'binding',x.work.id).run,rows={items:[{record:{id:'one'},label:'normal',draft:'Internal note',sent:false}],unknown_count:0,external_messages_sent:0};
 x.store.finishPack(x.config.project.id,run.id,'succeeded',rows,null);
 const packValue={run_id:run.id,status:'succeeded',task_id:null,result:rows},packReceipt=await x.toolkit.receipt('runtime_pack_run',packValue,packId);
 assert.equal(packReceipt.effect_state,'verified');
 const draft=await x.toolkit.execute('office_result_draft',{text:'One classified record; no message sent.'},draftId),draftReceipt=await x.toolkit.receipt('office_result_draft',draft,draftId);
 assert.equal(draftReceipt.effect_state,'verified');
 x.store.desktopState.exec('CREATE TABLE office_supervisor(run_id TEXT PRIMARY KEY,project_id TEXT,work_id TEXT,checkpoint TEXT)');
 const observations=[{invocation:{tool_name:'runtime_pack_run',request_id:packId},receipt:packReceipt},{invocation:{tool_name:'office_result_draft',request_id:draftId},receipt:draftReceipt}];
 x.store.desktopState.prepare('INSERT INTO office_supervisor VALUES(?,?,?,?)').run(x.toolkit.runId,x.config.project.id,x.work.id,JSON.stringify({observations}));
 await assert.rejects(x.toolkit.validate('office_result_read',{request_id:packId},'preflight'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_RESULT_PACK_ARTIFACT_NOT_AVAILABLE'&&error.detail.includes(draftId)&&!error.detail.includes(draft.artifact.path));
 await assert.rejects(x.toolkit.execute('office_result_read',{request_id:packId},'direct-read'),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_RESULT_PACK_ARTIFACT_NOT_AVAILABLE');
 const read=await x.toolkit.execute('office_result_read',{request_id:draftId},'draft-read');assert.equal(read.text,'One classified record; no message sent.\n');
 assert.deepEqual(x.calls,[]);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,1);
});


test('runtime native Work JSON and CSV artifacts are format-valid, fresh readback and immutable across format changes',async t=>{
 const x=await fixture(t);
 for(const [format,text]of [['json','[{"category":"quake","count":2}]'],['csv','id,category\n1,"quake, shallow"\n']]){
  const requestId='structured-'+format,args={text,format};
  const result=await x.toolkit.execute('office_result_draft',args,requestId);
  assert.equal(result.artifact.format,format);assert.ok(result.artifact.path.endsWith('.'+format));
  assert.equal(await readFile(result.artifact.path,'utf8'),text.endsWith('\n')?text:text+'\n');
  assert.equal((await x.toolkit.receipt('office_result_draft',result,requestId)).effect_state,'verified');
  assert.equal((await x.toolkit.execute('office_result_read',{request_id:requestId},'read-'+format)).text,text.endsWith('\n')?text:text+'\n');
  await assert.rejects(x.toolkit.execute('office_result_draft',{text:'replacement',format:'txt'},requestId),/WORK_RESULT_REQUEST_ID_CONFLICT/u);
  assert.equal((await x.toolkit.execute('office_result_draft',args,requestId)).deduplicated,true);
 }
 for(const [format,text]of [['json','plain text'],['csv','id,value\n1'],['csv','id,id\n1,2']])assert.throws(()=>x.toolkit.validate('office_result_draft',{format,text},'invalid-'+format),error=>error instanceof WorkClientToolInputError&&error.code==='WORK_RESULT_FORMAT_INVALID');
 const legacy=await x.toolkit.execute('office_result_draft',{text:'original TXT'},'legacy-format');
 await assert.rejects(x.toolkit.execute('office_result_draft',{format:'json',text:'{}'},'legacy-format'),/WORK_RESULT_REQUEST_ID_CONFLICT/u);
 assert.equal(await readFile(legacy.artifact.path,'utf8'),'original TXT\n');
 assert.equal(x.calls.length,0);
});

test('runtime contract Work field preflight reports declared schema before dispatch and omits sensitive field names',async t=>{
 const x=await fixture(t,{spec:proposal('monitor.watch'),packs:{sources:[{id:'release',kind:'http',url:'https://example.org/releases',parameters:[],format:'json',json_fields:['version','first_released','session_cookie']}],targets:[],models:'off'}});
 const watch={version:1,family:'monitor.watch',request:'Watch first release',sources:[{id:'release',parameters:{}}],filters:[],deduplicate_by:[],comparison_fields:['first_release'],mode:'any_change',value_field:null,interval_seconds:60};
 assert.throws(()=>x.toolkit.validate('runtime_pack_run',{recipe:watch},'typo'),error=>{assert.equal(error.code,'PACK_DECLARED_SOURCE_FIELD_MISSING');assert.match(error.detail,/first_released/u);assert.doesNotMatch(error.detail,/session_cookie/u);return true;});
 assert.equal(x.calls.length,0);assert.equal(x.store.officeRuns(x.config.project.id,x.work.id).length,0);
 assert.equal(x.toolkit.validate('runtime_pack_run',{recipe:{...watch,comparison_fields:['first_released']}},'corrected').recipe.comparison_fields[0],'first_released');
});
