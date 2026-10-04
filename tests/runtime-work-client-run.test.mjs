import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {writeFileSync,utimesSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkResults} from '../dist/work/results.js';
import {WorkDeliverySettings,deliverySettingsPath} from '../dist/work/delivery-settings.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {enableClientRun,disableClientRun,pinWorkClient,workClientChoice,workFolder,clientRunEnvironment,clientRunArgs,clientRunEligible,defaultWorkClient} from '../dist/work/client-run.js';
import {mkdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';

// Owner direction 2026-10-03: the client's own agent runs the Work with the owner's settings and full permissions;
// Office streams its events, keeps its session, takes the files it made as the result and verifies them.
const proposal={title:'파생상품 사례 이미지',desired_outcome:'사례 이미지와 해설을 만든다',completion_checks:[{id:'images',result:'사례 이미지 파일과 해설이 있다',evidence:'업무 폴더의 파일'}],assumptions:[],route:{kind:'workflow',pack_family:null},requested_effect:'draft_only',recurrence:{kind:'once',rule:null},questions:[]};
function fixture(options={}){const calls=[];let verifications=0;return {calls,get verifications(){return verifications;},async call(purpose,instructions,input){
  calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
  if(instructions.startsWith('Define one durable')||instructions.startsWith('Revise this existing'))return options.proposal??proposal;
  if(instructions.startsWith('Normalize the user'))return {kind:'daily',timezone:'Asia/Seoul',hour:8,minute:30,also_at:[{hour:21,minute:30}],weekdays:null,seconds:null,reason:null};
  if(options.verifyError)throw Error(options.verifyError);
  assert.ok(instructions.startsWith('Verify each completion check of an Office Work'),'a client run is verified by the light tier');
  verifications++;
  const saved=input.evidence.find(item=>item.tool_name==='office_result_draft');
  options.evidence?.push(input.evidence.map(item=>item.tool_name));
  return {checks:input.checks.map(check=>options.denyFirst&&verifications===1&&check.id==='images'
    ?{id:check.id,verdict:'unsupported',evidence_ids:[saved.evidence_id],quotes:[],reason:'Only one image was made; five were asked.'}
    :{id:check.id,verdict:'supported',evidence_ids:[saved.evidence_id],quotes:[{evidence_id:saved.evidence_id,quote:'case-1.png'}],reason:'The saved result lists the image and its explanation.'})};
}};}
async function setup(t,options={}){
  // A client order exported in the shell must not decide which client these Works get.
  const ambient=process.env.AGENT_DRIVER_LLM_CLIENT;delete process.env.AGENT_DRIVER_LLM_CLIENT;t.after(()=>{if(ambient!==undefined)process.env.AGENT_DRIVER_LLM_CLIENT=ambient;});
  const root=await mkdtemp(join(tmpdir(),'work-client-run-')),host=join(root,'host.json');
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'client-run-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const model=fixture(options),runtime=new WorkRuntime(store,config,model),work=await runtime.start({request_id:'client-run',prompt:'파생상품 사례 이미지와 짧은 해설을 만들어줘',...(options.choice?{client:options.choice}:{})});
  const runs=[],looks=[],asks=[];enableClientRun({runner:{run:request=>{
    // The image readback is a separate call of the client: it answers with descriptions and is not a Work turn.
    if(request.args.includes('-i')||/Describe each image below/u.test(request.stdin??'')){looks.push(request);const names=request.args.includes('-i')?request.args.filter((value,index)=>request.args[index-1]==='-i').map(path=>path.split('/').pop()):[...(request.stdin.match(/^- (.+)$/gmu)??[])].map(line=>line.slice(2));
      const reply=JSON.stringify(names.map(file=>({file,description:`공책 손필기 스타일의 질문 이미지. 보이는 글: "${file.replace(/\.png$/u,'')} 사례 질문". 정답은 적혀 있지 않다. `+'세부 묘사가 길게 이어집니다. '.repeat(200)})));
      for(const event of request.args.includes('-i')?[{type:'thread.started',thread_id:'11111111-2222-4333-8444-555555555555'},{type:'item.completed',item:{id:'i0',type:'agent_message',text:reply}},{type:'turn.completed'}]:[{type:'result',subtype:'success',result:reply,session_id:'11111111-2222-4333-8444-555555555555'}])request.onStdout(JSON.stringify(event)+'\n');
      return {code:0,stdout:'',stderr:''};}
    // The one-line turn that asks for the completion report: a client of these cases answers without one unless told to.
    if(/^Office decides completion from COMPLETION\.json/u.test(request.stdin??'')){asks.push(request);if(options.report)options.report(request);
      const resumed=request.args[request.args.indexOf('--resume')+1];
      for(const event of request.executable.endsWith('claude')?[{type:'result',subtype:'success',result:'checked',session_id:resumed}]:[{type:'item.completed',item:{id:'a0',type:'agent_message',text:'checked'}},{type:'turn.completed'}])request.onStdout(JSON.stringify(event)+'\n');return {code:0,stdout:'',stderr:''};}
    runs.push(request);return options.client(request,runs.length);}},executable:client=>`/fake/${client}`});
  const supervisor=new WorkSupervisor(store,config,model,{auto_start:false,tick_ms:20,...(options.verifyCompletion?{verifyCompletion:options.verifyCompletion}:{})});
  t.after(async()=>{supervisor.close();disableClientRun();store.close();await rm(root,{recursive:true,force:true});});
  return {root,config,store,model,work,runs,looks,asks,supervisor};
}
const line=value=>JSON.stringify(value)+'\n';
const thread='0b7d3c52-8f8e-4b56-9b3e-2f1d4c6a7e10';
function codexTurn(request,{session=thread,reply='case-1.png 과 해설 explanations.md 를 만들었습니다.'}={}){
  writeFileSync(join(request.cwd,'case-1.png'),Buffer.from([0x89,0x50,0x4e,0x47]));writeFileSync(join(request.cwd,'explanations.md'),'# 사례 1\n옵션 만기일 감마 노출');
  for(const event of [{type:'thread.started',thread_id:session},{type:'turn.started'},
    {type:'item.started',item:{id:'item_0',type:'command_execution',command:"/bin/bash -lc 'echo hi > a.txt'",aggregated_output:'',exit_code:null,status:'in_progress'}},
    {type:'item.completed',item:{id:'item_0',type:'command_execution',command:"/bin/bash -lc 'echo hi > a.txt'",aggregated_output:'',exit_code:0,status:'completed'}},
    {type:'item.completed',item:{id:'item_1',type:'file_change',changes:[{path:join(request.cwd,'explanations.md'),kind:'add'}],status:'completed'}},
    {type:'item.completed',item:{id:'item_2',type:'agent_message',text:reply}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}])request.onStdout(line(event));
  return {code:0,stdout:'',stderr:''};
}
async function settle(x,states=['succeeded','failed','awaiting_review','waiting_auth','paused']){for(let i=0;i<200;i++){const s=supervisorStatus(x.store,x.config.project.id,x.work.work_id);if(states.includes(s?.state))return s;await delay(25);}assert.fail(JSON.stringify(supervisorStatus(x.store,x.config.project.id,x.work.work_id)));}
const activity=x=>x.store.hermesState.prepare('SELECT kind,summary,metadata FROM office_activity WHERE work_id=? ORDER BY id').all(x.work.work_id).map(row=>({...row,metadata:JSON.parse(String(row.metadata??'{}'))}));

test('runtime fixture a Work runs on Codex with the owner settings and full permissions; its files are the verified result',async t=>{
  process.env.OPENAI_API_KEY='sk-test-should-not-reach-the-client';t.after(()=>{delete process.env.OPENAI_API_KEY;});
  const x=await setup(t,{client:request=>codexTurn(request)});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const [run]=x.runs,folder=join(workFolder(x.config,x.work.work_id),end.run_id);
  assert.deepEqual([run.args.slice(0,3),run.args.slice(-4)],[['-C',folder,'--dangerously-bypass-approvals-and-sandbox'],['exec','--json','--skip-git-repo-check','-']]);
  assert.deepEqual(clientRunArgs({id:'codex',model:null,effort:null},folder,null,true).slice(3,5),['-c','mcp_servers.agent-driver.disabled_tools=["runtime_work_start","runtime_work_execute","runtime_work_control"]'],'a run cannot start Works through Office');
  assert.equal(run.executable,'/fake/codex');assert.equal(run.cwd,folder);assert.equal(run.keep_stdout,false);
  assert.equal(run.env.OPENAI_API_KEY,undefined,'an API key would bill a paid API');assert.equal(run.env.HOME,process.env.HOME);
  assert.match(run.stdin,/파생상품 사례 이미지와 짧은 해설을 만들어줘/u);assert.match(run.stdin,/images: 사례 이미지 파일과 해설이 있다/u);
  const rows=activity(x);
  assert.ok(rows.some(row=>row.kind==='tool.result'&&row.summary==='shell · exit 0 · echo hi > a.txt'&&row.metadata.status==='succeeded'&&row.metadata.model_provider==='codex'));
  assert.ok(rows.some(row=>row.kind==='tool.result'&&row.summary==='file_change · add explanations.md'));
  const [result]=await new WorkResults(x.store).capture(x.config.project.id,x.work.work_id);
  assert.equal(result.verification,'verified');
  assert.deepEqual(result.artifacts.map(item=>item.label).sort(),['case-1.png','explanations.md'].concat(result.artifacts.filter(item=>item.label.startsWith('report-')).map(item=>item.label)).sort());
  assert.match(result.text,/case-1\.png \(image\/png, 4 bytes\)/u);assert.match(result.text,/옵션 만기일 감마 노출/u);
  assert.deepEqual(pinWorkClient(x.store,x.config.project.id,x.work.work_id,{id:'claude',model:null,effort:null},null),{id:'codex',model:null,effort:null},'the Work keeps its client');
});

test('runtime fixture a verification denial goes back to the same Codex session',async t=>{
  const x=await setup(t,{denyFirst:true,client:request=>codexTurn(request)});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  assert.equal(x.runs.length,2);assert.equal(x.model.verifications,2);
  assert.deepEqual(x.runs[1].args.slice(-6),['exec','resume','--json','--skip-git-repo-check',thread,'-']);
  assert.match(x.runs[1].stdin,/Not met: images \(사례 이미지 파일과 해설이 있다\)\. Reason: Only one image was made; five were asked\./u);
  assert.ok(activity(x).some(row=>row.kind==='supervisor.client_run'&&/거절된 조건 images의 수정을 같은 세션에 요청합니다 \(1\/3\): Only one image was made/u.test(row.summary)),'the owner sees the repair request');
  // Every turn's receipts stay in order (live: a record rewritten each turn failed the trace's admission-prefix check on resume).
  const record=JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint).observations;
  const drafts=record.filter(item=>item.invocation.tool_name==='office_result_draft');assert.equal(drafts.length,2);assert.ok(drafts[0].invocation.turn<drafts[1].invocation.turn);
  assert.equal(new Set(record.map(item=>item.invocation.request_id)).size,record.length,'request ids stay unique across turns');
});

test('runtime fixture the AI chosen at intake runs the Work; a Claude run stopped for a new direction resumes its own session with that direction',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});
  const x=await setup(t,{choice:{id:'claude',model:'opus',effort:'high'},client:async(request,count)=>{
    const id=request.args[request.args.indexOf(count===1?'--session-id':'--resume')+1];
    request.onStdout(line({type:'system',subtype:'init',session_id:id,permissionMode:'bypassPermissions'}));
    if(count===1){release();await new Promise((_,reject)=>request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));}
    writeFileSync(join(request.cwd,'case-1.png'),'png');
    request.onStdout(line({type:'assistant',message:{content:[{type:'tool_use',id:'tu1',name:'Write',input:{file_path:join(request.cwd,'case-1.png')}}]}}));
    request.onStdout(line({type:'user',message:{content:[{type:'tool_result',tool_use_id:'tu1',content:'File created',is_error:false}]}}));
    request.onStdout(line({type:'result',subtype:'success',is_error:false,result:'case-1.png 를 만들었습니다.',session_id:id}));
    return {code:0,stdout:'',stderr:''};
  }});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  await gate;await delay(50);
  let work=x.store.intakeWork(x.config.project.id,x.work.work_id);x.supervisor.action({work_id:x.work.work_id,revision:work.revision,action:'edit',instruction:'사례는 옵션 만기일 위주로 바꿔줘'});
  assert.equal((await settle(x,['paused'])).state,'paused');
  work=x.store.intakeWork(x.config.project.id,x.work.work_id);x.supervisor.action({work_id:x.work.work_id,revision:work.revision,action:'resume'});x.supervisor.tick();
  const end=await settle(x,['succeeded','failed','awaiting_review','waiting_auth']);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const first=x.runs[0].args,session=first[first.indexOf('--session-id')+1];
  assert.ok(first.includes('--dangerously-skip-permissions'));assert.equal(first[0],'-p');assert.equal(x.runs[0].executable,'/fake/claude');
  assert.deepEqual([first[first.indexOf('--model')+1],first[first.indexOf('--effort')+1]],['opus','high']);
  assert.deepEqual(workClientChoice(x.store,x.config.project.id,x.work.work_id),{id:'claude',model:'opus',effort:'high'});
  assert.equal(first[first.indexOf('--disallowedTools')+1],'mcp__agent-driver__runtime_work_start,mcp__agent-driver__runtime_work_execute,mcp__agent-driver__runtime_work_control');
  assert.deepEqual(x.runs[1].args.slice(-2),['--resume',session]);assert.match(x.runs[1].stdin,/The owner changed the instruction for this Work:\n- 사례는 옵션 만기일 위주로 바꿔줘/u);
  assert.ok(activity(x).some(row=>row.kind==='tool.started'&&row.summary.startsWith('file_change · ')&&row.metadata.model_provider==='claude'));
});

test('runtime fixture a recurring Work run shows the verifier Office schedule record, which the client does not set up',async t=>{
  const evidence=[],x=await setup(t,{evidence,proposal:{...proposal,recurrence:{kind:'recurring',rule:'매일 08:30과 21:30'}},client:request=>codexTurn(request)});
  x.supervisor.start(x.work.work_id,x.work.revision,true,'Asia/Seoul',false);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  assert.ok(evidence[0].includes('office_schedule_status'),JSON.stringify(evidence));
  assert.match(x.runs[0].stdin,/do not set up schedules/iu);assert.match(x.runs[0].stdin,/"host_schedule"/u);
});

test('runtime fixture the verifier sees the Office delivery selection of a client run, with no target secret',async t=>{
  const evidence=[],x=await setup(t,{evidence,client:request=>codexTurn(request)});
  // Live: a Work asked that the owner's Telegram chat be the delivery target; intake had not recorded it, so no evidence showed it.
  mkdirSync(join(x.config.dbPath,'..','.connection'),{recursive:true,mode:0o700});
  writeFileSync(deliverySettingsPath(x.config),JSON.stringify({format:1,revision:1,targets:[{id:'tg-owner',platform:'telegram',label:'내 텔레그램',telegram_bot_token:'123456:SECRETTOKENVALUE0000000000',telegram_chat_id:'987654321'}],default_target_ids:['app']}),{mode:0o600});
  new WorkResults(x.store,[],WorkDeliverySettings.fromConfig(x.config)).setSelection(x.config.project.id,x.work.work_id,{revision:0,target_ids:['app','tg-owner']});
  x.supervisor.start(x.work.work_id,x.work.revision,true,'Asia/Seoul',false);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  assert.ok(evidence[0].includes('office_delivery_status'),JSON.stringify(evidence));
  // Office reads its saved result back, as the host path did (live: "saved and readable" stayed undecided without it).
  assert.ok(evidence[0].includes('office_result_read'),JSON.stringify(evidence));
  const checkpoint=JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint),delivery=checkpoint.observations.find(item=>item.invocation.tool_name==='office_delivery_status');
  assert.equal(delivery.receipt.status,'succeeded');
  assert.deepEqual(delivery.receipt.value.targets,[{id:'app',platform:'app',label:'Agent Office app'},{id:'tg-owner',platform:'telegram',label:'내 텔레그램'}]);
  assert.doesNotMatch(JSON.stringify(checkpoint),/SECRETTOKEN|987654321/u);
});

test('runtime fixture an imported Work gives the client its own steps and tools, and a request that sends by itself is not told to keep the result',async t=>{
  // Live 2026-10-03: the imported ASTS Work ran without its runbook and commands, and its own Telegram helper was held back by the Office note.
  const plan={format:1,revision:1,source:'pasted_import',source_id:'imp-1',source_digest:'a'.repeat(64),provenance:'unverified_external',import_mode:'migrate',steps:[
    {id:'load_runbook',goal:'Read the runbook and seen state.',depends_on:[],effect:'read_only',tool_hints:['C:\\Users\\owner\\projects\\asts\\docs\\runbook.md'],evidence_ids:[]},
    {id:'deliver',goal:'Send the new items through the helper.',depends_on:['load_runbook'],effect:'external_write',tool_hints:['py -3.12 scripts\\asts_monitor.py'],evidence_ids:[]}]};
  const x=await setup(t,{client:request=>codexTurn(request)});
  // The plan's source and provenance are host-owned (an import writes them), never taken from the planner: set them as an import would.
  const row=x.store.hermesState.prepare('SELECT spec FROM office_intake WHERE work_id=?').get(x.work.work_id);
  x.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify({...JSON.parse(row.spec),requested_effect:'external_effect_requested',plan}),x.work.work_id);
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const stdin=x.runs[0].stdin;
  assert.match(stdin,/The owner's own automation, as imported into Office[\s\S]*- load_runbook \(read_only\): Read the runbook and seen state\.\n  uses: C:\\Users\\owner\\projects\\asts\\docs\\runbook\.md\n- deliver \(external_write\)[\s\S]*uses: py -3\.12 scripts\\asts_monitor\.py/u);
  assert.match(stdin,/The request itself includes sending or submitting something[\s\S]*do that part as the request says/u);assert.doesNotMatch(stdin,/Do not send the result anywhere/u);
  const plain=await setup(t,{client:request=>codexTurn(request)});
  plain.supervisor.start(plain.work.work_id,plain.work.revision,true);plain.supervisor.activate();plain.supervisor.tick();await settle(plain);
  assert.match(plain.runs[0].stdin,/Do not send the result anywhere/u);assert.doesNotMatch(plain.runs[0].stdin,/as imported into Office/u);
});

test('runtime fixture a host-tool run that only read or wrote Office outputs moves to the client when the owner resumes it; one that wrote elsewhere stays',async t=>{
  // Live 2026-10-03: a run parked in the host executor's own wait for a setting met the same wait again on every resume.
  for(const [tool,effect,expectClient] of [['runtime_pack_catalog','read_only',true],['office_result_draft','local_write',true],['runtime_files_report','local_write',false]]){
    const x=await setup(t,{client:request=>codexTurn(request)});
    const run=randomUUID(),at=new Date().toISOString();
    const checkpoint={format:1,work_id:x.work.work_id,run_id:run,binding:'',turn:1,pending:null,summary:'',observations:[{invocation:{request_id:'host-read-1',turn:0,stage_id:'execution',tool_name:tool,arguments:{},effect,dispatched:true},receipt:{status:'succeeded',value:{status:'succeeded'},evidence_ids:['host-read-1'],effect_state:effect==='read_only'?'none':'verified',retry_safe:effect==='read_only'},observed_at:at}]};
    x.store.hermesState.prepare("INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,reason,checkpoint,config_hash,model_revision,current_run_only,created_at,updated_at) VALUES(?,?,?,?,'paused','WORK_CLIENT_WAIT_CONFIGURATION',?,?,0,1,?,?)").run(run,x.config.project.id,x.work.work_id,x.work.revision,JSON.stringify(checkpoint),x.config.fingerprint,at,at);
    x.supervisor.action({work_id:x.work.work_id,revision:x.store.intakeWork(x.config.project.id,x.work.work_id).revision,action:'resume'});x.supervisor.activate();x.supervisor.tick();
    if(expectClient){const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(x.runs.length,1,JSON.stringify(activity(x).map(a=>a.kind+' '+a.summary.slice(0,90))));assert.equal(end.run_id,run,'the same run continues on the client');}
    else{await delay(600);assert.equal(x.runs.length,0,'a run that already wrote through Office stays on the host path');}
  }
});

test('runtime fixture saving Office AI settings does not stop a running client, which keeps its own settings',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let running;const started=new Promise(resolve=>{running=resolve;});
  const x=await setup(t,{client:async request=>{running();await gate;return codexTurn(request);}});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  await started;
  saveModelSettings(modelSettingsPath(x.config),{revision:0,onboarding_step:2,selection:{mode:'subscription',client:'claude',client_models:{codex:null,claude:null,opencode:null},api_to_subscription:false,api_provider:'openai',api_model:'gpt-5.6-luna',api_base_url:'',reasoning:'low',jev:'off'}},{});
  await delay(5_600);release();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(x.runs.length,1);
});

test('runtime fixture a signed-out client waits for the owner instead of moving the Work to another client',async t=>{
  const x=await setup(t,{client:()=>({code:1,stdout:'',stderr:'Error: authentication required. Please run codex login.'})});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'waiting_auth');assert.equal(end.reason,'CLIENT_AUTH_EXPIRED');
  assert.equal(x.runs.length,1);assert.equal(x.runs[0].executable,'/fake/codex');
});

test('runtime fixture Works that Office proves in code or writes through approved Pack execution keep the host path',async t=>{
  const x=await setup(t,{client:request=>codexTurn(request)}),project=x.config.project.id,id=x.work.work_id,base={route:{pack_family:null},completion_checks:[{id:'a'}]};
  assert.equal(clientRunEligible(x.store,project,id,base),true);
  for(const family of ['coding.orchestrate','form.draft-submit','record.update','choose.stage'])assert.equal(clientRunEligible(x.store,project,id,{...base,route:{pack_family:family}}),false,family);
  assert.equal(clientRunEligible(x.store,project,id,{...base,collection_contract:{recipe:{}}}),false);
  assert.equal(clientRunEligible(x.store,project,id,{...base,completion_checks:[{id:'a',native_check:{kind:'x'}}]}),false);
});

test('runtime fixture the client environment keeps the owner variables and withholds API keys and Office internals',()=>{
  const env=clientRunEnvironment({HOME:'/home/owner',PATH:'/bin',DISPLAY:':0',HTTPS_PROXY:'http://proxy',CODEX_HOME:'/home/owner/.codex',ANTHROPIC_API_KEY:'k',OPENAI_API_KEY:'k',CODEX_API_KEY:'k',ANTHROPIC_AUTH_TOKEN:'k',TYPESAFE_API_KEY:'k',AGENT_DRIVER_LLM_CLIENT:'codex',AGENT_OFFICE_OWNER_MCP:'on',CLAUDECODE:'1'});
  assert.deepEqual(Object.keys(env).sort(),['CODEX_HOME','DISPLAY','HOME','HTTPS_PROXY','PATH']);
});

test('runtime fixture Office judgments for a pinned Work go to its client and model only',async()=>{
  const {ConfiguredStructuredModel}=await import('../dist/onboarding/configured-model.js');
  const seen=[],model=new ConfiguredStructuredModel('/nonexistent/models.json',{AGENT_DRIVER_LLM_CLIENT:'codex,claude',PATH:process.env.PATH},{subscription:options=>({calls:[],async call(){seen.push(options.environment);return {ok:true};}})});
  await model.forWork({work_id:'w1',run_id:'r1'}).forClient('claude','opus').forRole('verifier').call('verify','x',{},{type:'object'});
  assert.equal(seen[0].AGENT_DRIVER_LLM_CLIENT,'claude');assert.equal(seen[0].AGENT_DRIVER_CLAUDE_MODEL,'opus');
});

// Review of PR #48 (2026-10-03): each case below was a confirmed defect.
test('runtime fixture a briefly unavailable verifier makes a finished client run wait, not fail',async t=>{
  const x=await setup(t,{verifyError:'STRUCTURED_MODEL_UNAVAILABLE',client:request=>codexTurn(request)});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x,['retry_wait','failed','succeeded','awaiting_review']);assert.equal(end.state,'retry_wait',JSON.stringify(end));assert.equal(end.reason,'STRUCTURED_MODEL_UNAVAILABLE');
});

test('runtime fixture every file of the run folder is its result: old timestamps count, large files are listed but not offered',async t=>{
  const x=await setup(t,{proposal:{...proposal,title:'가'.repeat(150)},client:request=>{
    writeFileSync(join(request.cwd,'unpacked.csv'),'a,b\n1,2\n');utimesSync(join(request.cwd,'unpacked.csv'),new Date('2020-01-01'),new Date('2020-01-01'));
    writeFileSync(join(request.cwd,'video.mp4'),Buffer.alloc(17*1024*1024));
    mkdirSync(join(request.cwd,'data'));for(let i=0;i<210;i++)writeFileSync(join(request.cwd,'data',`row-${String(i).padStart(3,'0')}.txt`),'x');writeFileSync(join(request.cwd,'report.pdf'),'%PDF-1.4');
    return codexTurn(request,{reply:'case-1.png 완료. token=abcdefghijklmnopqrstuvwxyz0123456789ABCDEF 사용'});
  }});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const [result]=await new WorkResults(x.store).capture(x.config.project.id,x.work.work_id);
  const labels=result.artifacts.map(item=>item.label);assert.ok(labels.includes('unpacked.csv'));assert.ok(labels.includes('report.pdf'),'top-level files come before an unpacked folder');assert.equal(labels.includes('video.mp4'),false);
  assert.match(result.text,/video\.mp4 \(video\/mp4, 17825792 bytes, too large to download from Office/u);
  assert.doesNotMatch(JSON.stringify([end.result.summary,result.summary,result.text]),/abcdefghijklmnopqrstuvwxyz0123456789ABCDEF/u);
});

test('runtime fixture the intake correction call goes to the Work client too',async t=>{
  const {ConfiguredStructuredModel}=await import('../dist/onboarding/configured-model.js');
  const root=await mkdtemp(join(tmpdir(),'work-client-correct-')),host=join(root,'host.json');t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'client-correct',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);t.after(()=>store.close());
  const seen=[];let designs=0;
  const model=new ConfiguredStructuredModel(join(root,'data','.connection','models.json'),{AGENT_DRIVER_LLM_CLIENT:'codex'},{subscription:options=>({calls:[],async call(purpose){seen.push([purpose,options.environment.AGENT_DRIVER_LLM_CLIENT]);if(purpose==='design'&&designs++===0)return {...proposal,route:{kind:'pack',pack_family:null}};return proposal;}})});
  await new WorkRuntime(store,config,model).start({request_id:'correct',prompt:'사례 이미지를 만들어줘',client:{id:'claude',model:null,effort:null}});
  assert.ok(seen.length>=2,JSON.stringify(seen));assert.ok(seen.every(([,client])=>client==='claude'),JSON.stringify(seen));
});

test('runtime fixture a client provider outage waits with backoff instead of failing after three tries',async t=>{
  const x=await setup(t,{client:()=>({code:1,stdout:'',stderr:'upstream connect error: service unavailable'})});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x,['retry_wait','failed','waiting_auth']);assert.equal(end.state,'retry_wait',JSON.stringify(end));assert.equal(end.reason,'CLIENT_PROVIDER_UNAVAILABLE');
});

test('runtime fixture the default client is the owner default, the other installed client, or none for OpenCode',t=>{
  const selection=client=>({selection:{client,client_models:{codex:'gpt-x',claude:'opus',opencode:null},codex_reasoning_effort:'high'}});
  enableClientRun({executable:client=>`/fake/${client}`});t.after(()=>disableClientRun());
  const ambient=process.env.AGENT_DRIVER_LLM_CLIENT;delete process.env.AGENT_DRIVER_LLM_CLIENT;t.after(()=>{if(ambient!==undefined)process.env.AGENT_DRIVER_LLM_CLIENT=ambient;});
  assert.deepEqual(defaultWorkClient(selection('claude')),{id:'claude',model:'opus',effort:null});
  assert.deepEqual(defaultWorkClient(selection('auto')),{id:'codex',model:'gpt-x',effort:'high'});
  assert.equal(defaultWorkClient(selection('opencode')),null);
  enableClientRun({executable:client=>{if(client==='codex')throw Error('WSL_NATIVE_CLIENT_EXECUTABLE_NOT_FOUND');return '/fake/claude';}});
  assert.equal(defaultWorkClient(selection('codex')).id,'claude','only Claude is installed');
});

test('runtime fixture the client run gets the owner Windows-side MCP servers and instructions it does not load by itself',async t=>{
  const {enableOwnerEnvironment,disableOwnerEnvironment}=await import('../dist/integrations/client-environment.js');
  enableOwnerEnvironment(()=>({instructions:[{app:'codex',file:'AGENTS.md (Windows)',text:'Browse signed-in sites with Aside.'},{app:'codex',file:'AGENTS.md',text:'Local rules the client loads itself.'},{app:'claude',file:'CLAUDE.md (Windows)',text:'Claude only.'}],skills:[]}));t.after(()=>disableOwnerEnvironment());
  const x=await setup(t,{client:request=>codexTurn(request)});
  enableClientRun({servers:async()=>[{id:'aside',command:'/mnt/c/Tools/aside.exe',args:['mcp','--host','local'],startup_timeout_sec:20},{id:'docs',url:'https://docs.example/mcp'}]});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  // The pictures the run made are read by the client and recorded for the verifier (live: a check on what a PNG shows stayed unknown).
  assert.equal(x.looks.length,1);assert.ok(x.looks[0].args.includes('-i')&&x.looks[0].args.some(value=>value.endsWith('case-1.png')));
  const seen=JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint).observations.find(item=>item.invocation.tool_name==='office_image_read');
  assert.equal(seen.receipt.value.images[0].name,'case-1.png');assert.match(seen.receipt.value.images[0].description,/손필기/u);assert.equal(seen.receipt.value.provenance,'client_image_readback');
  // Ten descriptions must fit one receipt whole (live: five long ones were compacted and the verifier saw the fourth cut and the fifth missing).
  assert.ok(Buffer.byteLength(seen.receipt.value.images[0].description)<=1200);assert.ok(!('_office_compaction' in seen.receipt.value));
  const args=x.runs[0].args;
  for(const value of ['mcp_servers.aside.command="/mnt/c/Tools/aside.exe"','mcp_servers.aside.args=["mcp","--host","local"]','mcp_servers.aside.startup_timeout_sec=20','mcp_servers.docs.url="https://docs.example/mcp"'])assert.equal(args[args.indexOf(value)-1],'-c',value);
  assert.ok(args.indexOf('mcp_servers.aside.command="/mnt/c/Tools/aside.exe"')<args.indexOf('exec'),'config overrides come before exec');
  assert.match(x.runs[0].stdin,/Browse signed-in sites with Aside\./u);assert.doesNotMatch(x.runs[0].stdin,/Local rules the client loads itself|Claude only/u);
  assert.ok(activity(x).some(row=>row.summary==='windows_mcp · aside, docs'));
  assert.match(x.runs[0].stdin,/connected to this run: aside, docs\. "aside" is an MCP server, not a shell command: its tools drive the owner's own signed-in browser\. Read X, Reddit/u);
  const claude=clientRunArgs({id:'claude',model:null,effort:null},'/w',null,false,[{id:'aside',command:'/mnt/c/Tools/aside.exe',args:['mcp']},{id:'docs',url:'https://docs.example/mcp'}]);
  assert.deepEqual(JSON.parse(claude[claude.indexOf('--mcp-config')+1]),{mcpServers:{aside:{type:'stdio',command:'/mnt/c/Tools/aside.exe',args:['mcp']},docs:{type:'http',url:'https://docs.example/mcp'}}});
});

test('runtime fixture the owner receives the client DELIVERY.md, not the verification record',async t=>{
  // Live 2026-10-03: the owner's Telegram got the saved record (file list, check notes) instead of the five explanations.
  const x=await setup(t,{client:request=>{writeFileSync(join(request.cwd,'DELIVERY.md'),'## 1. 레버리지\n증거금 10%로 계약금액 전체를 거래하면 …\n');return codexTurn(request);}});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  assert.match(x.runs[0].stdin,/save DELIVERY\.md in the Work folder/u);
  const [result]=await new WorkResults(x.store).capture(x.config.project.id,x.work.work_id);
  assert.equal(result.delivery_text,'## 1. 레버리지\n증거금 10%로 계약금액 전체를 거래하면 …');
  assert.match(result.text,/Files made in this run/u,'the saved record keeps the file list for verification');
});

test('runtime fixture the saved record fits one readback page whole and the readback covers it',async t=>{
  // Live 2026-10-03: a check on the delivery text stayed unresolved because the one readback page ended mid-way.
  const x=await setup(t,{client:request=>{writeFileSync(join(request.cwd,'explanations-long.md'),Array.from({length:120},(_,i)=>`## 사례 ${i+1}\n파생상품 해설 문장이 이어집니다. 증거금과 레버리지, 만기와 시간가치를 쉬운 말로 설명합니다. 번호 ${i+1}.`).join('\n\n'));return codexTurn(request);}});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const checkpoint=JSON.parse(x.store.hermesState.prepare('SELECT checkpoint FROM office_supervisor WHERE run_id=?').get(end.run_id).checkpoint),pages=checkpoint.observations.filter(item=>item.invocation.tool_name==='office_result_read');
  // The record is kept within one readback page; the paging follows has_more when a page ever ends early.
  assert.ok(pages.length>=1,`pages: ${pages.length}`);assert.equal(pages[0].invocation.arguments.offset,0);
  for(let i=1;i<pages.length;i++)assert.equal(pages[i].invocation.arguments.offset,pages[i-1].receipt.value.page.next_offset);
  assert.equal(pages.at(-1).receipt.value.page.has_more,false);
  assert.equal(pages.reduce((sum,page)=>sum+page.receipt.value.page.returned_bytes,0),pages[0].receipt.value.page.total_bytes,'the pages add up to the whole saved result');
  const draft=checkpoint.observations.find(item=>item.invocation.tool_name==='office_result_draft');
  assert.ok(!('_office_compaction' in draft.receipt.value),'the saved record fits a receipt whole');assert.ok(Buffer.byteLength(JSON.stringify(draft.receipt.value))<=16000);
});

test('runtime fixture after a denial the claim cites only the latest turn, while the record keeps every turn',async t=>{
  // Live 2026-10-04: a run resumed six times cited all its turns; verification ran out of budget and the owner got "확인 필요".
  const claims=[];let calls=0;
  const x=await setup(t,{client:request=>codexTurn(request,{reply:`turn ${request.stdin.length}`}),verifyCompletion:async(checks,observations,claim)=>{claims.push({ids:claim.completed_checks[0].evidence_ids,all:observations.map(item=>item.invocation.request_id)});calls++;return calls===1?{verified:false,repair:{check_id:'images',reason:'Show all five.'}}:true;}});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));assert.equal(claims.length,2);
  assert.ok(claims[1].all.length>claims[1].ids.length,'the record keeps the first turn');
  assert.ok(claims[1].ids.every(id=>!claims[0].ids.includes(id)),'the second claim cites no receipt of the first turn');
  assert.ok(claims[1].ids.some(id=>id.startsWith('client-run-'))&&claims[1].ids.some(id=>id.startsWith('client-output-')));
});

// Owner decision 2026-10-04: a client run is complete when its client reports each condition met; Office verifies
// independently only Works that send or submit outside.
test('runtime fixture the client report decides completion; an external Work still gets independent verification',async t=>{
  const report=(request,met)=>writeFileSync(join(request.cwd,'COMPLETION.json'),JSON.stringify({checks:[{id:'images',met,note:met?'다섯 장과 해설이 폴더에 있다':'세 장만 만들었다'}]}));
  const done=await setup(t,{client:request=>{report(request,true);return codexTurn(request);}});
  done.supervisor.start(done.work.work_id,done.work.revision,true);done.supervisor.activate();done.supervisor.tick();
  const ok=await settle(done);assert.equal(ok.state,'succeeded',JSON.stringify(ok));assert.equal(done.model.verifications,0,'no verifier call');
  assert.match(done.runs[0].stdin,/Also write COMPLETION\.json in the Work folder/u);
  assert.ok(activity(done).some(row=>row.kind==='supervisor.verification'&&/완료 조건 1개를 모두 충족했다고 보고했어요/u.test(row.summary)));
  const short=await setup(t,{client:request=>{report(request,false);return codexTurn(request);}});
  short.supervisor.start(short.work.work_id,short.work.revision,true);short.supervisor.activate();short.supervisor.tick();
  const review=await settle(short);assert.equal(review.state,'awaiting_review');assert.equal(review.reason,'WORK_CLIENT_REPORTED_INCOMPLETE');assert.equal(short.model.verifications,0);
  assert.ok(activity(short).some(row=>/images \(세 장만 만들었다\)/u.test(row.summary)));
  // A Work whose request sends something outside keeps Office's own check, whatever the client reports.
  const outside=await setup(t,{client:request=>{report(request,true);return codexTurn(request);}});
  const row=outside.store.hermesState.prepare('SELECT spec FROM office_intake WHERE work_id=?').get(outside.work.work_id);
  outside.store.hermesState.prepare('UPDATE office_intake SET spec=? WHERE work_id=?').run(JSON.stringify({...JSON.parse(row.spec),requested_effect:'external_effect_requested'}),outside.work.work_id);
  outside.supervisor.start(outside.work.work_id,outside.work.revision,true);outside.supervisor.activate();outside.supervisor.tick();
  const verified=await settle(outside);assert.equal(verified.state,'succeeded',JSON.stringify(verified));assert.equal(outside.model.verifications,1);
});

test('runtime fixture a turn without a completion report is asked for it once in the same session',async t=>{
  // Live 2026-10-04: a resume with nothing new ran no turn, found no report and fell back to Office's own check, which sent "확인 필요".
  const x=await setup(t,{client:request=>codexTurn(request),report:request=>writeFileSync(join(request.cwd,'COMPLETION.json'),JSON.stringify({checks:[{id:'images',met:true,note:'다섯 장과 해설이 있다'}]}))});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  assert.equal(x.asks.length,1);assert.equal(x.model.verifications,0,'the report decides; no verifier call');
  assert.deepEqual(x.asks[0].args.slice(-6),['exec','resume','--json','--skip-git-repo-check',thread,'-'],'the same session is asked');
  assert.match(x.asks[0].stdin,/- images: 사례 이미지 파일과 해설이 있다/u);
});

// Owner decision 2026-10-04: Office passes a direction to the client session as it is; it does not replan a client-run Work.
test('runtime fixture a direction for a client-run Work goes to the client session without an Office replan',async t=>{
  const x=await setup(t,{client:request=>codexTurn(request)});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();
  await settle(x);const before=x.store.intakeWork(x.config.project.id,x.work.work_id),calls=x.model.calls.length;
  x.supervisor.action({work_id:x.work.work_id,revision:before.revision,action:'edit',instruction:'사례를 중급 난이도로 올려줘'});
  x.supervisor.action({work_id:x.work.work_id,revision:x.store.intakeWork(x.config.project.id,x.work.work_id).revision,action:'resume'});x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const after=x.store.intakeWork(x.config.project.id,x.work.work_id);
  assert.deepEqual(after.spec,before.spec,'the Work definition is unchanged');
  assert.ok(!x.model.calls.slice(calls).some(call=>call.purpose==='correct'),'no replanning call');
  const directed=x.runs.at(-1);assert.match(directed.stdin,/The owner changed the instruction for this Work:\n- 사례를 중급 난이도로 올려줘/u);assert.match(directed.stdin,/did not change the Work/u);
  assert.ok(activity(x).some(row=>row.kind==='supervisor.direction'));
});

test('runtime fixture the result is what the latest turn made; older files in the folder stay out of it',async t=>{
  // Live 2026-10-04: copies of yesterday's cases in the run folder took the result's file slots; three of today's five pictures went out.
  const x=await setup(t,{client:(request,turn)=>{if(turn===2){writeFileSync(join(request.cwd,'today.png'),Buffer.from([0x89,0x50,0x4e,0x47,9]));for(const event of [{type:'item.completed',item:{id:'i9',type:'agent_message',text:'today.png 를 만들었습니다.'}},{type:'turn.completed'}])request.onStdout(JSON.stringify(event)+'\n');return {code:0,stdout:'',stderr:''};}return codexTurn(request);}});
  x.supervisor.start(x.work.work_id,x.work.revision,true);x.supervisor.activate();x.supervisor.tick();await settle(x);
  await delay(1100);
  x.supervisor.action({work_id:x.work.work_id,revision:x.store.intakeWork(x.config.project.id,x.work.work_id).revision,action:'edit',instruction:'오늘 것을 새로 만들어'});
  x.supervisor.action({work_id:x.work.work_id,revision:x.store.intakeWork(x.config.project.id,x.work.work_id).revision,action:'resume'});x.supervisor.tick();
  const end=await settle(x);assert.equal(end.state,'succeeded',JSON.stringify(end));
  const results=await new WorkResults(x.store).capture(x.config.project.id,x.work.work_id),labels=results[0].artifacts.map(item=>item.label);
  assert.ok(labels.includes('today.png'),JSON.stringify(labels));assert.ok(!labels.includes('case-1.png'),'the first turn\'s picture is not part of this result');
});
