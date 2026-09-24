import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {PackStore} from '../dist/packs/store.js';
import {FamilyRuntime} from '../dist/packs/runtime.js';
import {LocalApprovalDispatcher} from '../dist/packs/local-approval.js';
import {snapshotHash} from '../dist/taskpack/contracts.js';

const familyIds=['research.search','portal.collect','form.draft-submit','record.update','inbox.triage','monitor.watch','file.pipeline','choose.stage'];
async function base(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'driver-families-')),data=join(root,'source.json'),configPath=join(root,'host.json');
  const rows=options.rows??[{id:'a',title:'Tokyo hotel',price:120,tags:'five star'},{id:'b',title:'Osaka inn',price:80,tags:'three star'}];
  await writeFile(data,JSON.stringify(rows));
  const config={schema_version:1,project_id:'pack-project',caller_ref:'pack-agent',account_ref:'account-a',worktree:root,data_dir:join(root,'runtime'),environment:options.environment??'production',
    ...(options.fixture_url?{fixture_url:options.fixture_url}:{}),packs:{models:options.models??'off',confidence:.9,model_data_approved:options.models&&options.models!=='off',
      sources:options.sources??[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:options.targets??[]}};
  await writeFile(configPath,JSON.stringify(config));
  t.after(async()=>{await rm(root,{recursive:true,force:true});});
  return {root,data,configPath,config:loadHostConfig(configPath)};
}
const collection={sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id']};
const recipe=(family,request='do it')=>({version:1,family,request});

function auditRecipe(family){
  const common={...recipe(family),...collection};
  if(['form.draft-submit','record.update','choose.stage'].includes(family))return {...recipe(family),target:'audit-target',values:{id:'a'},expected_before_sha256:null};
  if(family==='research.search')return {...common,query:'',search_fields:['id'],sort:null,limit:10};
  if(family==='file.pipeline')return {...common,columns:['id'],numeric_columns:[],sort:null,format:'json'};
  if(family==='inbox.triage')return {...common,judgment:{question:'Classify.',labels:{normal:'Routine'}},draft_by_label:{}};
  if(family==='monitor.watch')return {...common,interval_seconds:60,mode:'any_change',value_field:null,comparison_fields:['id']};
  return {...common,format:'json'};
}

test('audit all eight families preserve interrupted receipts and expose the same-request recovery entry',async t=>{
  const x=await base(t);let api=new RuntimeApi(x.config);
  const runs=familyIds.map((family,index)=>api.store.beginPack(x.config.project.id,`interrupted-${index}`,auditRecipe(family),'audit-binding').run);
  api.close();api=new RuntimeApi(loadHostConfig(x.configPath));t.after(()=>api.close());
  for(const run of runs){const status=await api.call('runtime_pack_status',{run_id:run.id});assert.equal(status.status,'running');assert.equal(status.next_action,'wait_or_resume_same_request');}
  // Status is read-only. Native kill/restart coverage is in runtime-pack-recovery.
});

test('audit five collection families resume the same request after source restoration',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());
  const original=await readFile(x.data);await writeFile(x.data,'invalid-json');
  const families=familyIds.filter(f=>!['form.draft-submit','record.update','choose.stage'].includes(f));
  const failed=[];
  for(const [index,family] of families.entries()){const r=await api.call('runtime_pack_run',{request_id:`unavailable-${index}`,recipe:auditRecipe(family)});assert.equal(r.status,'retryable_failure');failed.push(r);}
  await writeFile(x.data,original);
  for(const [index,family] of families.entries()){const r=await api.call('runtime_pack_run',{request_id:`unavailable-${index}`,recipe:auditRecipe(family)});assert.equal(r.status,family==='monitor.watch'?'watching':family==='inbox.triage'?'needs_review':'succeeded');assert.equal(r.run_id,failed[index].run_id);}
  // No configured model means inbox still truthfully requires semantic review.
});

test('runtime contract nine Pack families share one MCP surface and natural-language plan never grants dispatch',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());
  const catalog=await api.call('runtime_pack_catalog',{});assert.deepEqual(catalog.families.map(f=>f.id),[...familyIds,'coding.orchestrate']);assert.equal(catalog.connected,true);
  const plan=await api.call('runtime_pack_plan',{prompt:'도쿄 호텔을 찾아줘'});assert.equal(plan.status,'needs_agent_design');assert.equal(plan.dispatch_allowed,false);assert.equal(plan.connections.sources[0].id,'records');assert.ok(plan.recipe_schema);
  const client=new Client({name:'pack-test',version:'1'}),transport=new StdioClientTransport({command:process.execPath,args:['dist/cli.js','mcp','--config',x.configPath],stderr:'pipe'});
  await client.connect(transport);t.after(()=>client.close());const listed=await client.listTools();
  for(const name of ['runtime_pack_catalog','runtime_pack_plan','runtime_pack_run','runtime_pack_status','runtime_pack_execute_approved','runtime_pack_watch_tick'])assert.ok(listed.tools.some(tool=>tool.name===name),name);
});

test('runtime native research.search, portal.collect and file.pipeline execute bounded sources and verified exports without changing originals',async t=>{
  const x=await base(t),api=new RuntimeApi(x.config);t.after(()=>api.close());const before=await readFile(x.data);
  const search={...recipe('research.search','find tokyo'),...collection,query:'tokyo five',search_fields:['title','tags'],sort:{field:'price',direction:'asc'},limit:10};
  const found=await api.call('runtime_pack_run',{request_id:'search-1',recipe:search});assert.equal(found.status,'succeeded');assert.equal(found.result.rows.length,1);assert.equal(found.result.rows[0].id,'a');assert.equal(found.result.global_minimum_verified,false);
  const cached=await api.call('runtime_pack_plan',{prompt:'find tokyo'});assert.equal(cached.status,'ready_to_run');assert.equal(cached.cache_hit,true);
  const again=await api.call('runtime_pack_run',{request_id:'search-1',recipe:search});assert.equal(again.deduplicated,true);
  await assert.rejects(api.call('runtime_pack_run',{request_id:'search-1',recipe:{...search,limit:1}}),/PACK_REQUEST_ID_CONFLICT/);
  const portal=await api.call('runtime_pack_run',{request_id:'collect-1',recipe:{...recipe('portal.collect'),...collection,format:'csv'}});
  assert.equal(portal.status,'succeeded');assert.equal(portal.result.artifact.rows,2);assert.equal(portal.result.artifact.csv_formula_escaped,true);assert.ok((await stat(portal.result.artifact.path)).size>10);
  const pipeline=await api.call('runtime_pack_run',{request_id:'pipe-1',recipe:{...recipe('file.pipeline'),...collection,columns:['id','price'],numeric_columns:['price'],sort:{field:'price',direction:'desc'},format:'json'}});
  assert.equal(pipeline.status,'succeeded');const output=JSON.parse(await readFile(pipeline.result.artifact.path,'utf8'));assert.deepEqual(output,[{id:'a',price:120},{id:'b',price:80}]);assert.deepEqual(await readFile(x.data),before);
});

test('runtime fixture portal sources support bounded HTTP GET and owned-browser tables, while auth gates and unsafe connections do not become data',{timeout:60000},async t=>{
  const server=createServer((req,res)=>{
    const url=new URL(req.url??'/','http://fixture');
    if(url.pathname==='/lab/account-a/'){res.end('ok');return;}
    if(url.pathname==='/api/list'){assert.equal(url.searchParams.get('month'),'09');res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify([{id:'http-1',amount:12}]));return;}
    if(url.pathname==='/table'){res.writeHead(200,{'content-type':'text/html'});res.end('<span id=ready>Ready</span><span id=account>account-a</span><table><tbody><tr><td class=id>browser-1</td><td class=amount>24</td></tr></tbody></table>');return;}
    if(url.pathname==='/auth'){res.writeHead(200,{'content-type':'text/html'});res.end('<span class=auth>Login required</span>');return;}
    res.writeHead(404);res.end();
  });server.listen(0,'127.0.0.1');await once(server,'listening');const origin=`http://127.0.0.1:${server.address().port}`;t.after(()=>{server.closeAllConnections();server.close();});
  const browser=(id,path,ready)=>({id,kind:'browser',url:`${origin}${path}`,parameters:[],rows:'tbody tr',columns:{id:'.id',amount:'.amount'},ready,auth_gate:'.auth',account_selector:'#account',account_text:'account-a'});
  const sources=[{id:'api',kind:'http',url:`${origin}/api/list`,parameters:['month'],format:'json'},browser('table','/table','#ready'),browser('gate','/auth','#ready')];
  const x=await base(t,{environment:'fixture',fixture_url:`${origin}/lab/account-a/`,sources}),api=new RuntimeApi(x.config);t.after(()=>api.close());
  const http=await api.call('runtime_pack_run',{request_id:'http-source',recipe:{...recipe('portal.collect'),sources:[{id:'api',parameters:{month:'09'}}],filters:[],deduplicate_by:['id'],format:'json'}});assert.equal(http.status,'succeeded');assert.equal(http.result.evidence[0].executor,'http_get');
  const browserResult=await api.call('runtime_pack_run',{request_id:'browser-source',recipe:{...recipe('research.search'),sources:[{id:'table',parameters:{}}],filters:[],deduplicate_by:['id'],query:'browser',search_fields:['id'],relevance:null,sort:null,limit:5}});assert.equal(browserResult.status,'succeeded');assert.equal(browserResult.result.rows[0].id,'browser-1');assert.equal(browserResult.result.evidence[0].executor,'playwright');
  const gated=await api.call('runtime_pack_run',{request_id:'browser-auth',recipe:{...recipe('research.search'),sources:[{id:'gate',parameters:{}}],filters:[],deduplicate_by:[],query:'',search_fields:['id'],relevance:null,sort:null,limit:5}});assert.equal(gated.status,'waiting_auth');assert.equal(gated.result.error,'PACK_WAITING_AUTH');
  const unsafe=JSON.parse(await readFile(x.configPath,'utf8'));unsafe.environment='production';delete unsafe.fixture_url;await writeFile(join(x.root,'unsafe.json'),JSON.stringify(unsafe));assert.throws(()=>loadHostConfig(join(x.root,'unsafe.json')),/PACK_URL_NOT_ALLOWED/);
});

test('runtime contract inbox.triage uses one typed Jev judgment per row, holds provider outages for retry and never sends',async t=>{
  const x=await base(t,{rows:[{id:'m1',subject:'server down',body:'Production is unavailable'}],models:'jev'}),store=new PackStore(x.config.dbPath);store.registerProject(x.config.project);t.after(()=>store.close());
  const fake={async systemOne(request){const keys=Object.keys(request.questions.label.criteria);assert.deepEqual(keys.sort(),['normal','unknown','urgent']);return {answers:{label:{type:'choice',choice:'urgent',confidence:.97,probabilities:{urgent:.97,normal:.01,unknown:.02}}}};}};
  const runtime=new FamilyRuntime(store,x.config,{jev:fake});t.after(()=>runtime.close());
  const triage={...recipe('inbox.triage'),...collection,judgment:{question:'Does this require urgent attention?',labels:{urgent:'An outage or safety issue',normal:'Routine request'}},draft_by_label:{urgent:'확인 중입니다.'}};
  const result=await runtime.call('runtime_pack_run',{request_id:'triage-1',recipe:triage});assert.equal(result.status,'succeeded');assert.equal(result.result.items[0].label,'urgent');assert.equal(result.result.items[0].decider,'jev');assert.equal(result.result.items[0].sent,false);assert.equal(result.result.external_messages_sent,0);
  const unavailable=new FamilyRuntime(store,x.config,{jev:{async systemOne(){throw Error('offline');}}});
  const unknown=await unavailable.call('runtime_pack_run',{request_id:'triage-2',recipe:{...triage,request:'second'}});assert.equal(unknown.status,'retryable_failure');assert.equal(unknown.result.error,'PACK_MODEL_UNAVAILABLE');assert.equal(unknown.result.checkpointed_decisions,0);
});

test('runtime native monitor.watch persists across restart, emits one local change, suppresses duplicates and supports pause',async t=>{
  const x=await base(t,{rows:[{id:'flight',route:'ICN-NRT',price:100}]}),watch={...recipe('monitor.watch'),...collection,interval_seconds:60,mode:'minimum_decreases',value_field:'price',comparison_fields:['route']};
  let api=new RuntimeApi(x.config);const started=await api.call('runtime_pack_run',{request_id:'watch-1',recipe:watch});assert.equal(started.status,'watching');api.close();
  await writeFile(x.data,JSON.stringify([{id:'flight',route:'ICN-NRT',price:90}]));api=new RuntimeApi(loadHostConfig(x.configPath));t.after(()=>api.close());
  const tick=await api.packs.tick(Date.now()+61000);assert.equal(tick.processed[0].status,'changed');let events=await api.call('runtime_pack_events',{after:0,limit:10});assert.equal(events.events.length,1);assert.equal(events.events[0].kind,'changed');assert.equal(events.events[0].body.external_notifications_sent,0);
  const duplicate=await api.packs.tick(Date.now()+122000);assert.equal(duplicate.processed[0].status,'unchanged');events=await api.call('runtime_pack_events',{after:0,limit:10});assert.equal(events.events.length,1);
  await api.call('runtime_pack_watch_pause',{run_id:started.run_id,paused:true});const paused=await api.packs.tick(Date.now()+200000);assert.deepEqual(paused.processed,[]);
});

function mutationSite(){
  const records={
    'form.draft-submit':new Map(),
    'record.update':new Map([['r1',{id:'r1',title:'old',untouched:'keep'}]]),
    'choose.stage':new Map(),
  };
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url??'/','http://fixture'),parts=url.pathname.split('/').filter(Boolean),family=parts.at(-1);
    if(parts[0]==='lab'&&family==='account-a'){res.end('ok');return;}
    if(parts[0]==='work'&&records[family]){
      res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><meta charset=utf-8><span id=ready>Ready</span><span id=account>account-a</span><input id=id><input id=title><button id=submit>Save</button><script>submit.onclick=async()=>{await fetch('/api/${family}',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id.value,title:title.value})});document.body.dataset.done='yes'}</script>`);return;
    }
    if(parts[0]==='api'&&records[family]){
      if(req.method==='GET'){const record=records[family].get(url.searchParams.get('id'));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(record??null));return;}
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));records[family].set(body.id,{...(records[family].get(body.id)??{}),...body});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true}));return;
    }
    res.writeHead(404);res.end();
  });
  return {server,records};
}
test('runtime fixture three write families draft first, expose no approval secret, then use trusted approval and independent readback exactly once',{timeout:90000},async t=>{
  const site=mutationSite();site.server.listen(0,'127.0.0.1');await once(site.server,'listening');const origin=`http://127.0.0.1:${site.server.address().port}`;
  t.after(()=>{site.server.closeAllConnections();site.server.close();});
  const target=(family,action,effect_boundary)=>({id:`${family}.demo`,family,action,effect_boundary,url:`${origin}/work/${family}`,draft_is_local:true,ready:'#ready',auth_gate:'.auth',account_selector:'#account',account_text:'account-a',fields:{id:{selector:'#id',kind:'text'},title:{selector:'#title',kind:'text'}},identity_field:'id',submit:'#submit',readback_url:`${origin}/api/${family}`,identity_parameter:'id',known_popups:[]});
  const targets=[target('form.draft-submit','submit_form','single_form_submission'),target('record.update','update_record','allowlisted_field_update'),target('choose.stage','stage_cart','cart_or_draft_only')];
  const x=await base(t,{environment:'fixture',fixture_url:`${origin}/lab/account-a/`,targets}),store=new PackStore(x.config.dbPath);store.registerProject(x.config.project);t.after(()=>store.close());
  let delivered=0;const approval=new LocalApprovalDispatcher(store,async url=>{
    delivered++;const page=await fetch(url),html=await page.text();assert.equal(page.status,200);const token=html.match(/name="token" value="([a-f0-9]+)"/)?.[1],action=html.match(/action="(\/approve\/[a-f0-9]+)"/)?.[1],image=html.match(/src="(\/capture\/[a-f0-9]+)"/)?.[1];assert.ok(token&&action&&image);
    const origin=new URL(url).origin,capture=await fetch(origin+image);assert.equal(capture.headers.get('content-type'),'image/png');assert.ok((await capture.arrayBuffer()).byteLength>100);
    const response=await fetch(origin+action,{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});assert.equal(response.status,200);
  });
  const runtime=new FamilyRuntime(store,x.config,{approval});t.after(()=>runtime.close());
  for(const [index,family]of ['form.draft-submit','record.update','choose.stage'].entries()){
    const before=family==='record.update'?{id:'r1',title:'old',untouched:'keep'}:null,id=family==='record.update'?'r1':`n${index}`;
    const draft=await runtime.call('runtime_pack_run',{request_id:`write-${index}`,recipe:{...recipe(family),target:`${family}.demo`,values:{id,title:`new-${index}`},expected_before_sha256:before?snapshotHash(before):null}});
    assert.equal(draft.status,'approved');assert.equal(draft.result.external_submit,false);assert.equal(draft.result.approval_secret_exposed,false);assert.equal(JSON.stringify(draft).includes('apv_'),false);assert.equal(site.records[family].get(id)?.title,before?.title);
    const done=await runtime.call('runtime_pack_execute_approved',{run_id:draft.run_id});assert.equal(done.status,'succeeded');assert.equal(site.records[family].get(id).title,`new-${index}`);if(before)assert.equal(site.records[family].get(id).untouched,'keep');
    const repeat=await runtime.call('runtime_pack_execute_approved',{run_id:draft.run_id});assert.equal(repeat.status,'succeeded');assert.equal(site.records[family].size,1);
  }
  assert.equal(delivered,3);
});
