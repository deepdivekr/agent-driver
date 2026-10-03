import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor,supervisorStatus} from '../dist/work/supervisor.js';
import {WorkResults} from '../dist/work/results.js';
import {saveModelSettings,modelSettingsPath} from '../dist/onboarding/model-settings.js';
import {enableClientRun,disableClientRun,pinWorkClient,workClientChoice,workFolder,clientRunEnvironment,clientRunArgs,clientRunEligible} from '../dist/work/client-run.js';

// Owner direction 2026-10-03: the client's own agent runs the Work with the owner's settings and full permissions;
// Office streams its events, keeps its session, takes the files it made as the result and verifies them.
const proposal={title:'파생상품 사례 이미지',desired_outcome:'사례 이미지와 해설을 만든다',completion_checks:[{id:'images',result:'사례 이미지 파일과 해설이 있다',evidence:'업무 폴더의 파일'}],assumptions:[],route:{kind:'workflow',pack_family:null},requested_effect:'draft_only',recurrence:{kind:'once',rule:null},questions:[]};
function fixture(options={}){const calls=[];let verifications=0;return {calls,get verifications(){return verifications;},async call(purpose,instructions,input){
  calls.push({purpose,status:'accepted',provider:'fixture',model:'fixture',duration_ms:0});
  if(instructions.startsWith('Define one durable')||instructions.startsWith('Revise this existing'))return options.proposal??proposal;
  if(instructions.startsWith('Normalize the user'))return {kind:'daily',timezone:'Asia/Seoul',hour:8,minute:30,also_at:[{hour:21,minute:30}],weekdays:null,seconds:null,reason:null};
  assert.ok(instructions.startsWith('Verify each completion check of an Office Work'),'a client run is verified by the light tier');
  verifications++;
  const saved=input.evidence.find(item=>item.tool_name==='office_result_draft');
  options.evidence?.push(input.evidence.map(item=>item.tool_name));
  return {checks:input.checks.map(check=>options.denyFirst&&verifications===1&&check.id==='images'
    ?{id:check.id,verdict:'unsupported',evidence_ids:[saved.evidence_id],quotes:[],reason:'Only one image was made; five were asked.'}
    :{id:check.id,verdict:'supported',evidence_ids:[saved.evidence_id],quotes:[{evidence_id:saved.evidence_id,quote:'case-1.png'}],reason:'The saved result lists the image and its explanation.'})};
}};}
async function setup(t,options={}){
  const root=await mkdtemp(join(tmpdir(),'work-client-run-')),host=join(root,'host.json');
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'client-run-test',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  const model=fixture(options),runtime=new WorkRuntime(store,config,model),work=await runtime.start({request_id:'client-run',prompt:'파생상품 사례 이미지와 짧은 해설을 만들어줘',...(options.choice?{client:options.choice}:{})});
  const runs=[];enableClientRun({runner:{run:request=>{runs.push(request);return options.client(request,runs.length);}},executable:client=>`/fake/${client}`});
  const supervisor=new WorkSupervisor(store,config,model,{auto_start:false,tick_ms:20});
  t.after(async()=>{supervisor.close();disableClientRun();store.close();await rm(root,{recursive:true,force:true});});
  return {root,config,store,model,work,runs,supervisor};
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
  assert.match(x.runs[0].stdin,/do not set up schedules/u);assert.match(x.runs[0].stdin,/"host_schedule"/u);
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
  const env=clientRunEnvironment({HOME:'/home/owner',PATH:'/bin',DISPLAY:':0',HTTPS_PROXY:'http://proxy',CODEX_HOME:'/home/owner/.codex',ANTHROPIC_API_KEY:'k',OPENAI_API_KEY:'k',TYPESAFE_API_KEY:'k',AGENT_DRIVER_LLM_CLIENT:'codex',AGENT_OFFICE_OWNER_MCP:'on',CLAUDECODE:'1'});
  assert.deepEqual(Object.keys(env).sort(),['CODEX_HOME','DISPLAY','HOME','HTTPS_PROXY','PATH']);
});

test('runtime fixture Office judgments for a pinned Work go to its client and model only',async()=>{
  const {ConfiguredStructuredModel}=await import('../dist/onboarding/configured-model.js');
  const seen=[],model=new ConfiguredStructuredModel('/nonexistent/models.json',{AGENT_DRIVER_LLM_CLIENT:'codex,claude',PATH:process.env.PATH},{subscription:options=>({calls:[],async call(){seen.push(options.environment);return {ok:true};}})});
  await model.forWork({work_id:'w1',run_id:'r1'}).forClient('claude','opus').forRole('verifier').call('verify','x',{},{type:'object'});
  assert.equal(seen[0].AGENT_DRIVER_LLM_CLIENT,'claude');assert.equal(seen[0].AGENT_DRIVER_CLAUDE_MODEL,'opus');
});
