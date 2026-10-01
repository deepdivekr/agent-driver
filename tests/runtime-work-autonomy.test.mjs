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

// B2–B4 first slice: a verified Work leaves its procedure; a similar later request gets it as guidance.
test('B2: a verified procedure is saved, offered to a similar request, and dropped when it keeps failing',async t=>{
  const {PackStore}=await import('../dist/packs/store.js'),{recordVerifiedProcedure,similarProcedure,recordProcedureFailure,procedureSteps,requestTerms,procedureGuidance,REPLAY_SIMILARITY}=await import('../dist/work/procedures.js');
  const root=await mkdtemp(join(tmpdir(),'work-procedure-')),store=new PackStore(join(root,'runtime.sqlite'));t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const observation=(turn,tool,args,status='succeeded',dispatched=true)=>({invocation:{request_id:`r-${turn}`,turn,stage_id:'s',tool_name:tool,arguments:args,effect:'read_only',dispatched},receipt:{status,value:{},evidence_ids:[`e-${turn}`],effect_state:'none',retry_safe:true},observed_at:new Date().toISOString()});
  const run=[observation(0,'office_web_search',{query:'python downloads',provider:'google'},'retryable_failure'),observation(1,'office_browser_read',{url:'https://www.python.org/downloads/',offset:0,max_bytes:12000}),observation(2,'office_result_draft',{format:'json',text:'{"long":"content"}',label:'versions',request_id:'x'}),observation(3,'office_result_read',{request_id:'r-2'}),observation(4,'office_controlled_run_trace',{})];
  assert.deepEqual(procedureSteps(run),[{tool:'office_browser_read',arguments:{url:'https://www.python.org/downloads/'}},{tool:'office_result_draft',arguments:{format:'json',label:'versions'}}],'Only successful dispatched steps, without run-scoped arguments, readbacks or the trace.');
  assert.ok(requestTerms('Python과 Node.js 최신 안정 버전을 각 공식 사이트에서 확인해 JSON으로 저장해줘').includes('node.js'));
  const request='Python과 Node.js 최신 안정 버전을 각 공식 사이트에서 확인해 JSON으로 저장해줘';
  assert.equal(similarProcedure(store,'p',request),null);
  const saved=recordVerifiedProcedure(store,'p','work-1',request,run);assert.equal(saved.successes,1);
  const again=similarProcedure(store,'p','Python과 Node.js 최신 안정 버전을 공식 사이트에서 확인해 JSON 파일로 저장해줘');
  assert.equal(again.id,saved.id);assert.ok(again.similarity>=REPLAY_SIMILARITY,'Particles do not make a reworded request a different task (live: 0.5 before stemming).');
  assert.equal(recordVerifiedProcedure(store,'p','work-1b','Python과 Node.js의 최신 안정 버전을 공식 사이트에서 확인해 JSON 파일로 저장해줘',run,again.id).successes,2,'A guided run that passed verification is the offered procedure\'s next success, not a duplicate.');
  assert.equal(store.hermesState.prepare('SELECT count(*) c FROM office_procedure').get().c,1);assert.match(procedureGuidance(again).meaning,/guidance, not evidence/u);
  assert.equal(similarProcedure(store,'p','USGS 공개 피드에서 지난 24시간 지진을 CSV 저장해줘'),null,'An unrelated request gets nothing.');
  assert.equal(similarProcedure(store,'other-project',request),null,'Procedures stay inside their project.');
  assert.equal(recordVerifiedProcedure(store,'p','work-2',request,run).successes,3,'The same request verified again raises its score.');
  recordProcedureFailure(store,'p',saved.id);recordProcedureFailure(store,'p',saved.id);assert.ok(similarProcedure(store,'p',request),'Three verified runs against two failures: still offered.');
  recordProcedureFailure(store,'p',saved.id);assert.equal(similarProcedure(store,'p',request),null,'A procedure that fails as often as it succeeds is no longer offered.');
});

// B1: `awaiting_review` is not a place to leave the owner when the run only read. Live, a fresh attempt of a
// Work whose verification stayed undecided completed; under delegation the host makes that attempt itself, once.
test('B1: under delegation an unverified read-only run gets exactly one fresh attempt; per-run installs stop as before',async t=>{
  const {PackStore}=await import('../dist/packs/store.js'),{WorkRuntime}=await import('../dist/work/runtime.js'),{WorkSupervisor}=await import('../dist/work/supervisor.js');
  const proposal={title:'자료 확인',desired_outcome:'원본의 값을 결과에 남긴다',completion_checks:[{id:'records',result:'원본 제목과 값 23 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
  const recipe={version:1,family:'research.search',request:'자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
  const scenario=async(work,acceptFromRun)=>{
    const root=await mkdtemp(join(tmpdir(),'work-fresh-')),host=join(root,'host.json');await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
    await writeFile(host,JSON.stringify({schema_version:1,project_id:'fresh',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true},work}));
    let runs=0;const calls=[],model={calls,async call(purpose,instructions,input){
      calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
      if(instructions.startsWith('Define one durable'))return proposal;
      if(instructions.startsWith('Execute the registered Work')){
        if(input.checkpoint.observations.length===0)runs++;
        const result=input.checkpoint.observations.find(o=>o.invocation.tool_name==='runtime_pack_run');
        return result?{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(c=>({id:c.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null}
          :{action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the source.',completed_checks:[],wait_reason:null};
      }
      return {checks:input.checks.map(check=>{
        const ids=check.allowed_evidence_ids.filter(id=>input.observations.some(o=>o.tool_name!=='office_controlled_run_trace'&&o.evidence_ids.includes(id)&&JSON.stringify(o.value).includes('Observed source')));
        const refs=ids.map(id=>({evidence_id:id,quote_ref:input.literal_leaf_manifest?.find(record=>record.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path.endsWith('/title'))?.[0]}));
        return runs>=acceptFromRun&&ids.length&&refs.every(row=>typeof row.quote_ref==='string')?{id:check.id,verdict:'supported',evidence_ids:ids,evidence_quote_refs:refs,reason:'The receipt contains the title and value.'}:{id:check.id,verdict:'unknown',evidence_ids:[],evidence_quote_refs:[],reason:'Undecided.'};
      })};
    }};
    const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
    const started=await new WorkRuntime(store,config,model).start({request_id:'fresh',prompt:'자료를 확인해줘'}),supervisor=new WorkSupervisor(store,config,model,{tick_ms:25});
    t.after(async()=>{await supervisor.close();store.close();await rm(root,{recursive:true,force:true});});
    supervisor.start(started.work_id,started.revision,true);
    const rows=()=>store.hermesState.prepare('SELECT state FROM office_supervisor WHERE work_id=? ORDER BY created_at,rowid').all(started.work_id).map(row=>row.state);
    const settled=states=>states.every(state=>['succeeded','failed','awaiting_review'].includes(state));
    let last=[];for(let i=0;i<400;i++){const states=rows();if(settled(states)&&settled(last)&&states.length===last.length&&i>0)break;last=states;await new Promise(resolve=>setTimeout(resolve,50));}
    return {states:rows(),attempts:store.hermesState.prepare("SELECT count(*) c FROM office_activity WHERE work_id=? AND kind='supervisor.fresh_attempt'").get(started.work_id).c};
  };
  assert.deepEqual(await scenario({model_data_approved:true,autonomy:'delegated'},2),{states:['awaiting_review','succeeded'],attempts:1},'The fresh attempt completes; the unverified run stays in history.');
  assert.deepEqual(await scenario({model_data_approved:true,autonomy:'delegated'},99),{states:['awaiting_review','awaiting_review'],attempts:1},'A fresh attempt that also fails stops for the owner.');
  assert.deepEqual(await scenario({model_data_approved:true,autonomy:'per_run'},99),{states:['awaiting_review'],attempts:0},'Without delegation nothing is started on the owner\'s behalf.');
});

// B1 budget: host-started (scheduled) runs stop at the owner's daily limit and continue when it is raised.
test('B1: a due scheduled run waits at the daily limit with one note, and starts once the owner raises it',async t=>{
  const {PackStore}=await import('../dist/packs/store.js'),{WorkRuntime}=await import('../dist/work/runtime.js'),{WorkSupervisor}=await import('../dist/work/supervisor.js');
  const proposal={title:'자료 확인',desired_outcome:'원본의 값을 결과에 남긴다',completion_checks:[{id:'records',result:'원본 제목과 값 23 확인',evidence:'실제 파일 조회 결과'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'recurring',rule:'Every day at 20:00 UTC'},questions:[]};
  const recipe={version:1,family:'research.search',request:'매일 자료를 확인해줘',sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10};
  const root=await mkdtemp(join(tmpdir(),'work-budget-')),host=join(root,'host.json');await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'Observed source',value:23}]));
  const base={schema_version:1,project_id:'budget',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}};
  await writeFile(host,JSON.stringify({...base,work:{model_data_approved:true,autonomy:'delegated',delegation:{daily_scheduled_runs:0}}}));
  const calls=[],model={calls,async call(purpose,instructions,input){
    calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
    if(instructions.startsWith('Define one durable'))return proposal;
    if(instructions.startsWith('Normalize the user'))return {kind:'daily',timezone:'UTC',hour:20,minute:0};
    if(instructions.startsWith('Execute the registered Work')){
      const result=input.checkpoint.observations.find(o=>o.invocation.tool_name==='runtime_pack_run');
      return result?{action:'complete',stage_id:null,tool_name:null,arguments_json:null,summary:'Observed source: 23',completed_checks:input.completion_checks.map(c=>({id:c.id,evidence_ids:result.receipt.evidence_ids})),wait_reason:null}
        :{action:'tool',stage_id:'collect',tool_name:'runtime_pack_run',arguments_json:JSON.stringify({work_id:input.work_id,request_id:'placeholder',recipe}),summary:'Read the source.',completed_checks:[],wait_reason:null};
    }
    return {checks:input.checks.map(check=>{
      const ids=check.allowed_evidence_ids.filter(id=>input.observations.some(o=>o.tool_name!=='office_controlled_run_trace'&&o.evidence_ids.includes(id)&&JSON.stringify(o.value).includes('Observed source')));
      const refs=ids.map(id=>({evidence_id:id,quote_ref:input.literal_leaf_manifest?.find(record=>record.evidence_ids.includes(id))?.leaf_refs.find(([,path])=>path.endsWith('/title'))?.[0]}));
      return {id:check.id,verdict:'supported',evidence_ids:ids,evidence_quote_refs:refs,reason:'The receipt contains the title and value.'};
    })};
  }};
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const started=await new WorkRuntime(store,config,model).start({request_id:'budget',prompt:'매일 자료를 확인해줘'}),supervisor=new WorkSupervisor(store,config,model,{tick_ms:25});
  t.after(async()=>{await supervisor.close();store.close();await rm(root,{recursive:true,force:true});});
  const db=store.hermesState,runs=()=>db.prepare('SELECT state FROM office_supervisor WHERE work_id=? ORDER BY created_at,rowid').all(started.work_id).map(row=>row.state);
  const until=async(check,label)=>{for(let i=0;i<300;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,50));}assert.fail(`${label}: ${JSON.stringify(runs())}`);};
  const work=store.intakeWork(config.project.id,started.work_id);
  supervisor.start(started.work_id,work.revision,true,'UTC',false);await until(()=>runs()[0]==='succeeded','first run');
  const schedule=db.prepare('SELECT state,next_run_ms FROM office_work_schedule WHERE work_id=?').get(started.work_id);
  assert.equal(schedule?.state,'enabled','The delegated recurring Work keeps its own schedule.');
  db.prepare('UPDATE office_work_schedule SET next_run_ms=?,anchor_ms=? WHERE work_id=?').run(Date.now()-48*3600_000,Date.now()-48*3600_000,started.work_id);
  const notes=()=>db.prepare("SELECT count(*) c FROM office_activity WHERE work_id=? AND kind='schedule.budget_reached'").get(started.work_id).c;
  await until(()=>notes()===1,'budget note');await new Promise(resolve=>setTimeout(resolve,200));
  assert.equal(notes(),1,'One note per Work per day, not one per tick.');assert.equal(runs().length,1,'No run starts beyond the daily limit.');
  await writeFile(host,JSON.stringify({...base,work:{model_data_approved:true,autonomy:'delegated',delegation:{daily_scheduled_runs:5}}}));
  await until(()=>runs().length===2&&runs()[1]==='succeeded','raised limit');
  // The limit counts runs started today, whatever day their slot belonged to (the slot above was a past one).
  await writeFile(host,JSON.stringify({...base,work:{model_data_approved:true,autonomy:'delegated',delegation:{daily_scheduled_runs:1}}}));
  db.prepare('UPDATE office_work_schedule SET next_run_ms=?,last_slot=NULL WHERE work_id=?').run(Date.now()-72*3600_000,started.work_id);
  db.prepare('UPDATE office_work_schedule SET anchor_ms=? WHERE work_id=?').run(Date.now()-96*3600_000,started.work_id);
  await new Promise(resolve=>setTimeout(resolve,500));assert.equal(runs().length,2,'A caught-up past slot started today is counted against today.');
});
