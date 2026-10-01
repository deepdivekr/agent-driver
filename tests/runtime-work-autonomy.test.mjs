import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig,workAutonomy,workDelegation} from '../dist/interface/config.js';
import {setWorkModelDataApproval} from '../dist/onboarding/connection.js';
import {draftPublicForm} from '../dist/work/execution-tools.js';
import {cadenceInterval,scheduleFromProposal} from '../dist/work/schedule.js';

// Part B1: the owner's standing delegation. A Work the owner asked for runs to its
// result and keeps its own schedule without a click per run; absent means per-run.
test('B1: autonomy is read live from the host file; a new AI-data approval delegates and keeps an explicit per-run choice',async t=>{
  const root=await mkdtemp(join(tmpdir(),'work-autonomy-')),path=join(root,'host.json');t.after(()=>rm(root,{recursive:true,force:true}));
  const base={schema_version:1,project_id:'autonomy',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production'};
  await writeFile(path,JSON.stringify(base));const config=loadHostConfig(path);
  assert.equal(workAutonomy(config),'per_run','No policy means the per-run behaviour existing installs have.');
  await setWorkModelDataApproval(path,true);assert.equal(workAutonomy(config),'delegated','Read live, no restart.');
  assert.equal(loadHostConfig(path).fingerprint,config.fingerprint,'The policy is not part of the run binding.');
  await writeFile(path,JSON.stringify({...base,work:{model_data_approved:true,autonomy:'per_run'}}));
  await setWorkModelDataApproval(path,true);assert.equal(JSON.parse(await readFile(path,'utf8')).work.autonomy,'per_run','An explicit owner choice is kept.');
  // The budget of the delegation: host-started (scheduled) runs per day. Read live, kept across a new approval.
  assert.deepEqual(workDelegation(config),{daily_scheduled_runs:50},'A delegation has a default daily limit.');
  await writeFile(path,JSON.stringify({...base,work:{model_data_approved:true,autonomy:'delegated',delegation:{daily_scheduled_runs:3}}}));
  assert.equal(workDelegation(config).daily_scheduled_runs,3);await setWorkModelDataApproval(path,true);
  assert.equal(JSON.parse(await readFile(path,'utf8')).work.delegation.daily_scheduled_runs,3,'An approval does not reset the owner limit.');
  assert.equal(loadHostConfig(path).fingerprint,config.fingerprint);
});

// P6 (live): a public order form draft. The page may only GET; nothing is submitted.
test('B5: a public form draft fills text, radio, select and checkbox fields, reads them back and cannot submit',async t=>{
  let posts=0;
  const html=`<!doctype html><title>Order</title><form method="post" action="/post" id="f">
    <label>Customer name: <input name="custname"></label>
    <fieldset><legend> Pizza Size </legend><label><input type="radio" name="size" value="small"> Small</label><label><input type="radio" name="size" value="medium"> Medium</label></fieldset>
    <label>Crust <select name="crust"><option value="thin">Thin</option><option value="deep">Deep dish</option></select></label>
    <label><input type="checkbox" name="topping" value="bacon"> Bacon</label><input type="password" name="secret">
    <button>Submit order</button></form><script>document.querySelector('[name=custname]').addEventListener('input',()=>fetch('/post',{method:'POST',body:'x'}).catch(()=>{}));</script>`;
  const server=createServer((request,response)=>{if(request.method!=='GET'){posts++;response.writeHead(200);response.end('posted');return;}response.writeHead(200,{'content-type':'text/html'});response.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.close(resolve);server.closeAllConnections();}));
  const url=`http://127.0.0.1:${server.address().port}/form`;
  await assert.rejects(draftPublicForm({url,fields:[{name:'custname',value:'Kim'}]}),/FORM_DRAFT_LEFT_PAGE/u,'A page that tries to send data while being filled is not reported as a clean draft.');
  assert.equal(posts,0,'The host aborted the non-GET request.');
  const quiet=createServer((request,response)=>{if(request.method!=='GET'){posts++;response.end();return;}response.writeHead(200,{'content-type':'text/html'});response.end(html.replace(/<script>.*<\/script>/su,''));});
  await new Promise(resolve=>quiet.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{quiet.close(resolve);quiet.closeAllConnections();}));
  const draft=await draftPublicForm({url:`http://127.0.0.1:${quiet.address().port}/form`,fields:[{name:'custname',value:'Kim'},{name:'size',value:'Medium'},{label:'Crust',value:'Deep dish'},{name:'topping',value:true}]});
  assert.equal(draft.status,'succeeded');assert.equal(draft.submitted,false);assert.equal(draft.non_get_requests,0);
  assert.deepEqual(draft.fields.map(field=>[field.kind,field.observed]),[['text','Kim'],['radio','medium'],['select','deep'],['checkbox',true]]);
  await assert.rejects(draftPublicForm({url:`http://127.0.0.1:${quiet.address().port}/form`,fields:[{name:'secret',value:'x'}]}),/FORM_FIELD_NOT_ALLOWED/u);
  await assert.rejects(draftPublicForm({url:`http://127.0.0.1:${quiet.address().port}/form`,fields:[{name:'size',value:'Gigantic'}]}),/FORM_OPTION_NOT_FOUND/u);
  const legend=await draftPublicForm({url:`http://127.0.0.1:${quiet.address().port}/form`,fields:[{label:'Pizza Size',value:'Medium'}]});
  assert.deepEqual(legend.fields.map(field=>[field.kind,field.observed]),[['radio','medium']],'A radio group is found by its legend (live: the model named the group, not an option).');
  await assert.rejects(draftPublicForm({url:`http://127.0.0.1:${quiet.address().port}/form`,fields:[{label:'Delivery date',value:'x'}]}),error=>error.message==='FORM_FIELD_NOT_FOUND'&&error.available.some(line=>line.startsWith('custname [text]')),'An unknown field reports the fields that exist.');
  assert.equal(posts,0);
});

// Live: a recurring Work never got a schedule from a real subscription CLI (union schema rejected), and
// "once a day" without a clock time came back unsupported. The model fills a flat object; code decides cadence.
test('B1: a flat model proposal becomes a schedule and a stated cadence without a clock time is an interval',()=>{
  assert.deepEqual(scheduleFromProposal({kind:'daily',timezone:null,hour:9,minute:null,weekdays:null,seconds:null,reason:null},'Asia/Seoul'),{kind:'daily',timezone:'Asia/Seoul',hour:9,minute:0});
  assert.deepEqual(scheduleFromProposal({kind:'interval',timezone:'UTC',hour:null,minute:null,weekdays:null,seconds:3600,reason:null},'Asia/Seoul'),{kind:'interval',timezone:'UTC',seconds:3600});
  assert.equal(scheduleFromProposal({kind:'unsupported',timezone:null,hour:null,minute:null,weekdays:null,seconds:null,reason:null},'UTC').kind,'unsupported');
  assert.throws(()=>scheduleFromProposal({kind:'daily',timezone:null,hour:99,minute:0,weekdays:null,seconds:null,reason:null},'UTC'));
  for(const [rule,seconds] of [['하루에 한 번 nodejs.org 공식 블로그의 새 글 확인',86400],['매일 확인',86400],['every 30 minutes',1800],['2시간마다 확인',7200],['hourly',3600],['매주 점검',604800],['새 글 감시를 설정해줘',86400],['check once a day',86400]])assert.equal(cadenceInterval(rule),seconds,rule);
  assert.equal(cadenceInterval('다음 달 첫 영업일에 한 번'),null);
  for(const rule of ['Every day at 20:00 in Asia/Seoul','매일 오전 9시에 확인','daily at 9 am'])assert.equal(cadenceInterval(rule),null,'A rule with a clock time is left to the normalizer: '+rule);
});

// Clean-install check: the full MCP surface is 114 tools and about 115 KB of descriptions in every client
// session. The default listing is the Work surface; every other tool keeps its name and stays callable.
test('B1: the default MCP listing is the compact Work surface and can be widened explicitly',async()=>{
  const {COMPACT_MCP_TOOLS,compactMcpTools}=await import('../dist/interface/mcp-proxy.js'),{tools}=await import('../dist/interface/catalog.js');
  const all=Object.keys(tools).map(name=>({name})),listed=compactMcpTools(all).map(tool=>tool.name);
  assert.ok(all.length>100,'The full catalog stays intact for callers that name a tool.');
  assert.ok(listed.length<=12&&listed.length>=8,String(listed.length));
  for(const name of ['runtime_work_start','runtime_work_status','runtime_work_answer','runtime_work_result'])assert.ok(listed.includes(name),name);
  assert.ok([...COMPACT_MCP_TOOLS].every(name=>Object.hasOwn(tools,name)),'Every listed name is a real tool.');
  assert.ok(!listed.some(name=>/^runtime_(?:pack|swarm|terminal|coding|windows|files)_/u.test(name)));
});
