import test from 'node:test';
import assert from 'node:assert/strict';
import {access, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {tools} from '../dist/interface/catalog.js';
import {PackStore} from '../dist/packs/store.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {readWorkDetail} from '../dist/observability/work-view.js';
import {parseWorkImportDraft, UNIVERSAL_WORK_MIGRATION_PROMPT} from '../dist/work/import-draft.js';
import {normalizeProjectPath, scanProject} from '../dist/work/project-scan.js';
const syntheticSecret=['sk','proj','abcdefghijklmnopqrstuvwxyz123456'].join('-');

function externalDraft(){
  return {
    format:1,
    source:{platform:'telegram',name:'Daily briefing',reference:null},
    title:{value:'아침 브리핑',evidence_ids:['title']},
    goal:{value:'새 소식을 확인하고 요약을 보낸다',evidence_ids:['goal']},
    trigger:{kind:'schedule',rule:'매일 08:00',timezone:'Asia/Seoul',evidence_ids:['schedule']},
    steps:[
      {id:'collect',goal:'새 소식 조회',depends_on:[],tool_hints:['browser'],effect:'read_only',evidence_ids:['collect']},
      {id:'deliver',goal:'요약 전송',depends_on:['collect'],tool_hints:['telegram'],effect:'external_write',evidence_ids:['deliver']},
    ],
    completion:[{id:'receipt',result:'요약 전송이 확인됨',proof:'메시지 영수증',evidence_ids:['deliver']}],
    delivery:{channel:'telegram',target:null,evidence_ids:['deliver']},
    dependencies:[{name:'Telegram 계정 연결',kind:'account',evidence_ids:['deliver']}],
    approval_boundary:{value:null,evidence_ids:[]},
    unknowns:[],
    evidence:[
      {id:'title',source_ref:'자동화 제목',quote:'아침 브리핑'},
      {id:'goal',source_ref:'자동화 설명',quote:'새 소식을 확인하고 요약을 보낸다'},
      {id:'schedule',source_ref:'예약 설정',quote:'매일 08:00 Asia/Seoul'},
      {id:'collect',source_ref:'단계 1',quote:'새 소식 조회'},
      {id:'deliver',source_ref:'단계 2',quote:'요약을 Telegram으로 전송'},
    ],
  };
}

async function setup(t,{modelApproved=false,model,packModels=null}={}){
  const root=await mkdtemp(join(tmpdir(),'driver-migration-'));
  const project=join(root,'selected-project');await mkdir(project);
  const path=join(root,'host.json');
  await writeFile(path,JSON.stringify({
    schema_version:1,project_id:'migration-test',caller_ref:'local-agent',account_ref:'owner',worktree:root,
    data_dir:join(root,'data'),environment:'production',
    coding:{projects:[{id:'selected',root:project,allow_write:false,allow_commit:false,verify:[]}],model_data_approved:modelApproved},
    ...(packModels?{packs:{models:packModels,model_data_approved:true,sources:[{id:'messages',kind:'file',path:'selected-project/messages.json',format:'json'}],targets:[]}}:{}),
  }));
  const config=loadHostConfig(path);
  const api=new RuntimeApi(config,model?{swarmModel:model}:{});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {root,project,config,api};
}

async function makeBot(project){
  await writeFile(join(project,'README.md'),'# Weather Bot\nReplies to weather requests.\n');
  await writeFile(join(project,'package.json'),JSON.stringify({scripts:{start:'node bot.js'}}));
  await writeFile(join(project,'bot.js'),"import TelegramBot from 'telegram-bot';\nconst bot = {};\nbot.command('weather', () => bot.sendMessage('forecast'));\n");
}

async function makeSemanticWorkflow(project){
  await writeFile(join(project,'README.md'),'# Message workflow\nChecks incoming messages.\n');
  await writeFile(join(project,'agent.py'),'from openai import OpenAI\ncreate_agent()\ntool_call()\ncheckpoint = True\nclassifyMessage(message)\n');
}

function semanticAnalysis(input,recommendations){
  const semantic=input.evidence.find(item=>item.signal==='semantic_judgment'&&item.source==='observed_code');
  const other=input.evidence.find(item=>item.id!==semantic?.id&&item.source==='observed_code');
  const evidence=semantic?.id??other?.id??input.evidence[0]?.id;
  return {
    title:'메시지 검토',goal:'들어온 메시지를 검토한다',prompt:'새 메시지를 검토해 줘',
    steps:[{id:'triage',goal:'메시지 뜻을 읽고 분류한다',depends_on:[],evidence_ids:[evidence]}],
    completion:[{id:'checked',result:'분류 결과를 확인한다',proof:'결과 기록',evidence_ids:[evidence]}],
    unknowns:['실제 분류 정확도는 미확인'],
    jev_recommendations:recommendations?.({semantic,other,evidence})??[],
  };
}

const jevSuggestion=evidenceId=>({
  step_id:'triage',judgment:'새 메시지가 긴급한지 판단',answer_shape:'yes_no',
  why_fit:'들어오는 메시지마다 표현이 달라져서, 내용을 읽고 짧게 판단하는 단계입니다.',
  evidence_ids:[evidenceId],
});

test('universal prompt produces an untrusted, evidence-linked draft and rejects invented evidence or credentials',()=>{
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/기존 자동화의 실행·수정·중지는 하지 마세요/u);
  assert.match(UNIVERSAL_WORK_MIGRATION_PROMPT,/API 키·비밀번호·쿠키·토큰/u);
  const draft=parseWorkImportDraft('```json\n'+JSON.stringify(externalDraft())+'\n```');
  assert.equal(draft.provenance.independently_verified,false);
  assert.deepEqual(draft.authority,{execution:false,activation:false});
  assert.deepEqual(draft.steps.map(step=>step.depends_on),[[],['collect']]);
  assert.ok(draft.unknowns.some(item=>item.field==='approval_boundary'));
  const unsupported=externalDraft();unsupported.steps[1].evidence_ids=['absent'];
  assert.throws(()=>parseWorkImportDraft(JSON.stringify(unsupported)),/WORK_IMPORT_EVIDENCE_REFERENCE_INVALID/u);
  const cyclic=externalDraft();cyclic.steps[0].depends_on=['deliver'];
  assert.throws(()=>parseWorkImportDraft(JSON.stringify(cyclic)),/WORK_IMPORT_STEP_CYCLE/u);
  const secret=externalDraft();secret.evidence[0].quote=syntheticSecret;
  assert.throws(()=>parseWorkImportDraft(JSON.stringify(secret)),/WORK_IMPORT_SECRET_REJECTED/u);
});

test('local and WSL project scan reads bounded evidence without executing code, following links, or returning secrets',async t=>{
  const x=await setup(t);await makeBot(x.project);
  const marker=join(x.root,'should-not-run');
  await writeFile(join(x.project,'danger.js'),`import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`);
  await writeFile(join(x.project,'.env'),`API_KEY=${syntheticSecret}\n`);
  const outside=join(x.root,'outside.ts');await writeFile(outside,'OpenAI create_agent tool_call checkpoint');
  await symlink(outside,join(x.project,'linked.ts'));
  const result=await scanProject(x.project);
  assert.equal(result.kind,'bot_only');
  assert.equal(result.authority.execution,false);assert.equal(result.authority.project_write,false);
  assert.equal(result.authority.jev_call,false);
  assert.ok(result.evidence.some(item=>item.signal==='bot_channel'&&item.file==='bot.js'));
  assert.ok(result.recommendations.some(item=>item.includes('LLM')));
  assert.ok(!JSON.stringify(result).includes('sk-proj-'));
  assert.ok(!result.evidence.some(item=>item.file==='linked.ts'||item.file==='.env'));
  await assert.rejects(access(marker));
  assert.equal((await scanProject(x.project)).content_sha256,result.content_sha256);
  assert.equal(normalizeProjectPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\bot','linux','Ubuntu-24.04'),'/home/me/bot');
  assert.throws(()=>normalizeProjectPath('\\\\wsl.localhost\\Other\\home\\me\\bot','linux','Ubuntu-24.04'),/PROJECT_WSL_DISTRO_MISMATCH/u);
  assert.throws(()=>normalizeProjectPath('relative/path','linux'),/PROJECT_PATH_ABSOLUTE_REQUIRED/u);
  await writeFile(join(x.project,'bot.js'),"import TelegramBot from 'telegram-bot'; bot.command('weather', () => bot.sendMessage('changed'));\n");
  assert.notEqual((await scanProject(x.project)).content_sha256,result.content_sha256);
});

test('README claims remain documentation evidence and cannot classify a bot as an agent workflow',async t=>{
  const x=await setup(t);await makeBot(x.project);
  await writeFile(join(x.project,'README.md'),'# Weather Bot\nPlanned: openai create_agent tool_call checkpoint. This is documentation, not implemented code.\n');
  await writeFile(join(x.project,'comment.py'),'# classifyMessage(message) is only a future idea\n');
  const result=await scanProject(x.project);
  assert.equal(result.kind,'bot_only');
  const claim=result.evidence.find(item=>item.file==='README.md'&&item.signal==='agent_loop');
  assert.ok(claim);
  assert.equal(claim.source,'observed_documentation');
  assert.ok(result.evidence.some(item=>item.file==='bot.js'&&item.signal==='bot_channel'&&item.source==='observed_code'));
  assert.ok(!result.evidence.some(item=>item.file==='comment.py'&&item.signal==='semantic_judgment'));
});

test('registered project scan distinguishes agent workflow, preserves model evidence, and does not activate it',async t=>{
  let calls=0,seen=null;
  const model={async call(_purpose,_instructions,input){calls++;seen=input;const evidence=input.evidence[0].id;return {
    title:'뉴스 조사',goal:'새 소식을 조사하고 결과를 저장한다',prompt:'새 소식 조사 결과를 만들어줘',
    steps:[{id:'research',goal:'소식 조사',depends_on:[],evidence_ids:[evidence]},{id:'save',goal:'검토한 결과 저장',depends_on:['research'],evidence_ids:[evidence]}],
    completion:[{id:'checked',result:'저장 결과를 재조회한다',proof:'재조회 기록',evidence_ids:[evidence]}],unknowns:['실제 로그인 상태 미확인'],
  };}};
  const x=await setup(t,{modelApproved:true,model});
  await writeFile(join(x.project,'README.md'),'# News Workflow\nCollects news.\n');
  await writeFile(join(x.project,'agent.py'),'from openai import OpenAI\ncreate_agent()\ntool_call()\ncheckpoint = True\n');
  const result=await x.api.call('runtime_work_import_scan',{project_ref:'selected'});
  assert.equal(result.preview.kind,'agentic_workflow');
  assert.equal(result.preview.analysis_status,'complete');
  assert.equal(result.preview.analysis.steps[1].depends_on[0],'research');
  assert.equal(result.preview.jev.enabled,false);
  assert.equal(result.activation,false);assert.equal(result.execution,false);
  assert.equal(calls,1);assert.ok(seen.evidence.every(item=>item.source==='observed_code'));
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,0);
  const status=await x.api.call('runtime_work_import_status',{import_id:result.import_id});
  assert.equal(status.status,'draft');assert.equal(status.accepted_work_id,null);
  await assert.rejects(x.api.call('runtime_work_import_scan',{project_ref:'not-registered'}),/WORK_IMPORT_PROJECT_NOT_REGISTERED/u);
});

test('project scan recommends only an observed semantic step, preserves its plain explanation after acceptance and restart, and never calls Jev',async t=>{
  let modelCalls=0,jevCalls=0;
  const model={async call(_purpose,_instructions,input){modelCalls++;return semanticAnalysis(input,({semantic})=>[jevSuggestion(semantic.id)]);}};
  const x=await setup(t,{modelApproved:true,model});await makeSemanticWorkflow(x.project);
  x.api.packs.providers.jev={async systemOne(){jevCalls++;throw Error('JEV_MUST_REMAIN_OFF');}};
  const scanned=await x.api.imports.scan({path:x.project});
  assert.equal(scanned.preview.analysis_status,'complete');
  assert.equal(modelCalls,1);assert.equal(jevCalls,0);
  const recommendation=scanned.preview.jev_recommendations[0];
  assert.equal(scanned.preview.jev_recommendations.length,1);
  assert.equal(recommendation.judgment,'새 메시지가 긴급한지 판단');
  assert.equal(recommendation.step_goal,'메시지 뜻을 읽고 분류한다');
  assert.equal(recommendation.answer_shape,'yes_no');
  assert.match(recommendation.why_fit,/표현이 달라져서/u);
  assert.deepEqual(recommendation.evidence.map(item=>item.signal),['semantic_judgment']);
  assert.deepEqual(recommendation.evidence.map(item=>item.file),['agent.py']);
  assert.equal(recommendation.status,'proposal_unverified');assert.equal(recommendation.enabled,false);
  assert.equal(scanned.preview.jev.enabled,false);
  const accepted=await x.api.imports.accept({import_id:scanned.import_id,goal:'메시지 검토 업무를 옮긴다',completion:'분류 결과를 확인한다'});
  assert.equal(accepted.jev.enabled,false);assert.equal(accepted.execution,false);assert.equal(jevCalls,0);
  const detail=readWorkDetail(x.api.store,x.config,accepted.work_id);
  assert.deepEqual(detail.jev_recommendations,scanned.preview.jev_recommendations);
  assert.equal(detail.jev_recommendation_status,'complete');assert.equal(detail.jev.enabled,false);
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  const persisted=readWorkDetail(reopened,x.config,accepted.work_id);
  assert.deepEqual(persisted.jev_recommendations,scanned.preview.jev_recommendations);
  assert.equal(persisted.jev.enabled,false);assert.equal(jevCalls,0);
});

test('unsupported Jev evidence is dropped while the main project analysis remains available',async t=>{
  let recommendationFor=({semantic})=>[jevSuggestion('invented-evidence')];
  const model={async call(_purpose,_instructions,input){return semanticAnalysis(input,recommendationFor);}};
  const x=await setup(t,{modelApproved:true,model});await makeSemanticWorkflow(x.project);
  const cases=[
    ['missing evidence',()=>[jevSuggestion('invented-evidence')]],
    ['code without semantic judgment',({other})=>[jevSuggestion(other.id)]],
    ['step without matching evidence',({semantic,other})=>[{...jevSuggestion(semantic.id),step_id:'lookup'}],true],
  ];
  for(const [label,create,extraStep] of cases){
    recommendationFor=refs=>create(refs);
    const original=model.call;
    if(extraStep)model.call=async(purpose,instructions,input,schema)=>{
      const analysis=await original(purpose,instructions,input,schema);
      analysis.steps.push({id:'lookup',goal:'자료 조회',depends_on:[],evidence_ids:[input.evidence.find(item=>item.source==='observed_code'&&item.signal!=='semantic_judgment').id]});
      return analysis;
    };
    const result=await x.api.imports.scan({path:x.project});
    assert.equal(result.preview.analysis_status,'complete',label);
    assert.equal(result.preview.analysis.steps.length,extraStep?2:1,label);
    assert.deepEqual(result.preview.jev_recommendations,[],label);
    assert.deepEqual(result.preview.analysis.jev_recommendations,[],label);
    model.call=original;
  }
});

test('scan does not invent a Jev point without model approval or supported code evidence',async t=>{
  let unapprovedCalls=0;
  const unapproved=await setup(t,{model:{async call(){unapprovedCalls++;throw Error('MODEL_MUST_NOT_RUN');}}});
  await makeSemanticWorkflow(unapproved.project);
  const noApproval=await unapproved.api.imports.scan({path:unapproved.project});
  assert.equal(noApproval.preview.analysis_status,'not_approved');
  assert.deepEqual(noApproval.preview.jev_recommendations,[]);
  assert.equal(unapprovedCalls,0);
  let approvedCalls=0;
  const approved=await setup(t,{modelApproved:true,model:{async call(_purpose,_instructions,input){approvedCalls++;return semanticAnalysis(input,({evidence})=>[jevSuggestion(evidence)]);}}});
  await writeFile(join(approved.project,'README.md'),'# Ideas\nWe might classifyMessage(message) later.\n');
  await writeFile(join(approved.project,'agent.py'),'from openai import OpenAI\ncreate_agent()\n');
  const unsupported=await approved.api.imports.scan({path:approved.project});
  assert.equal(unsupported.preview.analysis_status,'complete');assert.equal(approvedCalls,1);
  assert.deepEqual(unsupported.preview.jev_recommendations,[]);
  assert.deepEqual(unsupported.preview.analysis.jev_recommendations,[]);
  assert.ok(unsupported.preview.evidence.some(item=>item.signal==='semantic_judgment'&&item.source==='observed_documentation'));
  assert.ok(!unsupported.preview.evidence.some(item=>item.signal==='semantic_judgment'&&item.source==='observed_code'));
});

test('pasted import is durable, requires explicit acceptance, and persists per-Work Jev consent across restart',async t=>{
  const x=await setup(t),prompt=await x.api.call('runtime_work_import_prompt',{});
  assert.match(prompt.prompt,/evidence_ids/u);
  const pasted=await x.api.call('runtime_work_import_paste',{text:JSON.stringify(externalDraft())});
  assert.equal(pasted.preview.status,'draft');
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,0);
  await assert.rejects(x.api.imports.accept({import_id:pasted.import_id,jev_enabled:true}),/JEV_API_COST_CONSENT_REQUIRED/u);
  const accepted=await x.api.imports.accept({import_id:pasted.import_id});
  assert.equal(accepted.activation,false);assert.equal(accepted.execution,false);assert.equal(accepted.schedule_active,false);
  assert.equal(accepted.jev.enabled,false);
  const stored=x.api.store.intakeWork(x.config.project.id,accepted.work_id);
  assert.equal(stored.spec.recurrence.kind,'recurring');
  assert.equal(stored.spec.requested_effect,'external_effect_requested');
  assert.deepEqual(x.api.store.workRevisions(x.config.project.id,accepted.work_id).map(item=>item.kind),['received','imported']);
  const duplicate=await x.api.imports.accept({import_id:pasted.import_id});
  assert.equal(duplicate.work_id,accepted.work_id);assert.equal(duplicate.deduplicated,true);
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  assert.equal(reopened.workImport(x.config.project.id,pasted.import_id).accepted_work_id,accepted.work_id);
  assert.equal(reopened.intakeWork(x.config.project.id,accepted.work_id).jev_enabled,false);
});

test('MCP offers preview routes but cannot accept an import or turn on paid Jev',async t=>{
  const x=await setup(t);
  for(const name of ['runtime_work_import_prompt','runtime_work_import_paste','runtime_work_import_status','runtime_work_import_scan'])assert.equal(tools[name].implemented,true);
  assert.equal(tools.runtime_work_import_accept,undefined);
  assert.equal(tools.runtime_work_jev,undefined);
  await assert.rejects(x.api.call('runtime_work_import_accept',{import_id:'00000000-0000-4000-8000-000000000000'}),/UNKNOWN_TOOL/u);
  await assert.rejects(x.api.call('runtime_work_jev',{work_id:'00000000-0000-4000-8000-000000000000',enabled:true,cost_acknowledged:true,revision:1}),/UNKNOWN_TOOL/u);
});

test('changed source blocks project acceptance and preserves a reviewable draft',async t=>{
  const x=await setup(t);await makeBot(x.project);
  const scanned=await x.api.imports.scan({path:x.project});
  assert.equal(scanned.preview.kind,'bot_only');
  assert.equal(scanned.preview.analysis_status,'not_approved');
  await writeFile(join(x.project,'bot.js'),"import TelegramBot from 'telegram-bot'; bot.command('weather', () => bot.sendMessage('new forecast'));\n");
  await assert.rejects(x.api.imports.accept({import_id:scanned.import_id,mode:'augment',goal:'예상 밖 질문을 분류한다',completion:'기존 날씨 응답과 새 분류 결과를 확인한다'}),/WORK_IMPORT_SOURCE_CHANGED_RESCAN/u);
  assert.equal(x.api.store.workImport(x.config.project.id,scanned.import_id).status,'draft');
  assert.equal(x.api.store.intakeWorks(x.config.project.id).length,0);
});

test('local Control Center protects import acceptance and Jev toggle, then persists the selected setting',async t=>{
  const x=await setup(t);await makeBot(x.project);
  const server=await startControlCenter(x.config,{poll_ms:25});t.after(()=>server.close());
  const origin=new URL(server.url).origin,headers={origin,'content-type':'application/json','x-agent-driver':'human-office'};
  const post=(path,body,extra={})=>fetch(new URL(path,server.url),{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const scanResponse=await post('work/import/scan',{path:x.project});
  assert.equal(scanResponse.status,200);const scan=await scanResponse.json();
  assert.equal(scan.preview.kind,'bot_only');
  const body={import_id:scan.import_id,mode:'augment',goal:'날씨 봇의 예상 밖 질문을 검토한다',completion:'기존 응답과 새 기능을 각각 확인한다'};
  assert.equal((await post('work/import/accept',body,{origin:'http://attacker.invalid'})).status,403);
  const acceptedResponse=await post('work/import/accept',body);
  assert.equal(acceptedResponse.status,200);const accepted=await acceptedResponse.json();
  assert.equal(accepted.jev.enabled,false);
  assert.equal(accepted.activation,false);assert.equal(accepted.execution,false);
  assert.equal(accepted.next_action,'register_project_with_write_permission_then_review_coding_work');
  assert.equal(accepted.project_ref,null);
  const detail=await (await fetch(new URL('work/detail?id='+accepted.work_id,server.url))).json();
  assert.equal(detail.jev.enabled,false);
  assert.equal(detail.spec.requested_effect,'local_file_write');
  assert.deepEqual(detail.spec.route,{kind:'pack',pack_family:'coding.orchestrate'});
  assert.equal(x.api.store.officeRuns(x.config.project.id,accepted.work_id).length,0);
  assert.equal((await post('work/jev',{work_id:accepted.work_id,revision:detail.revision,enabled:true,cost_acknowledged:false})).status,409);
  assert.equal((await post('work/jev',{work_id:accepted.work_id,revision:detail.revision,enabled:true,cost_acknowledged:true},{origin:'http://attacker.invalid'})).status,403);
  const enabledResponse=await post('work/jev',{work_id:accepted.work_id,revision:detail.revision,enabled:true,cost_acknowledged:true});
  assert.equal(enabledResponse.status,200);const enabled=await enabledResponse.json();
  assert.equal(enabled.jev.enabled,true);assert.ok(enabled.jev.cost_consent_at);
  assert.equal((await post('work/jev',{work_id:accepted.work_id,revision:detail.revision,enabled:false})).status,409);
  const disabledResponse=await post('work/jev',{work_id:accepted.work_id,revision:enabled.revision,enabled:false});
  assert.equal(disabledResponse.status,200);assert.equal((await disabledResponse.json()).jev.enabled,false);
  const reopened=new PackStore(x.config.dbPath);t.after(()=>reopened.close());
  const persisted=reopened.intakeWork(x.config.project.id,accepted.work_id);
  assert.equal(persisted.jev_enabled,false);assert.ok(persisted.jev_cost_consent_at);
  assert.deepEqual(reopened.workRevisions(x.config.project.id,accepted.work_id).map(item=>item.kind),['received','imported','jev_enabled','jev_disabled']);
  assert.equal((await readFile(join(x.project,'bot.js'),'utf8')).includes("sendMessage('forecast')"),true);
});

test('a Work-bound Pack uses LLM with Jev off, calls Jev only after consent, and returns to LLM when off',async t=>{
  let llmCalls=0,jevCalls=0;
  const model={async call(purpose){
    if(purpose==='design')return {
      title:'메시지 분류',desired_outcome:'긴급 메시지와 일반 메시지를 분류한다',
      completion_checks:[{id:'classified',result:'메시지 분류 결과를 확인한다',evidence:'분류 영수증'}],
      assumptions:[],route:{kind:'pack',pack_family:'inbox.triage'},requested_effect:'draft_only',
      recurrence:{kind:'once',rule:null},questions:[],
    };
    if(purpose==='correct'){llmCalls++;return {label:'urgent',evidence_quote:'server down'};}
    throw Error('UNEXPECTED_MODEL_PURPOSE');
  }};
  const x=await setup(t,{packModels:'jev',model});
  await writeFile(join(x.project,'messages.json'),JSON.stringify([{id:'m1',subject:'server down',body:'Production is unavailable'}]));
  x.api.packs.providers.jev={async systemOne(){jevCalls++;return {answers:{label:{type:'choice',choice:'urgent',confidence:.99,probabilities:{urgent:.99,routine:.005,unknown:.005}}}};}};
  const work=await x.api.call('runtime_work_start',{request_id:'triage-work',prompt:'메시지 중요도 분류'});
  assert.equal(work.status,'ready');assert.equal(work.jev.enabled,false);
  const recipe={version:1,family:'inbox.triage',request:'메시지 중요도 분류',sources:[{id:'messages',parameters:{}}],filters:[],deduplicate_by:['id'],judgment:{question:'긴급 대응이 필요한가?',labels:{urgent:'장애 또는 안전 문제',routine:'일반 요청'}},draft_by_label:{}};
  const first=await x.api.call('runtime_pack_run',{request_id:'triage-off-1',work_id:work.work_id,recipe});
  assert.equal(first.status,'succeeded');assert.equal(first.result.items[0].decider,'llm');
  assert.equal(llmCalls,1);assert.equal(jevCalls,0);
  const enabled=x.api.work.jev({work_id:work.work_id,revision:work.revision,enabled:true,cost_acknowledged:true});
  const second=await x.api.call('runtime_pack_run',{request_id:'triage-on-1',work_id:work.work_id,recipe});
  assert.equal(second.status,'succeeded');assert.equal(second.result.items[0].decider,'jev');
  assert.equal(llmCalls,1);assert.equal(jevCalls,1);
  x.api.work.jev({work_id:work.work_id,revision:enabled.revision,enabled:false});
  const third=await x.api.call('runtime_pack_run',{request_id:'triage-off-2',work_id:work.work_id,recipe});
  assert.equal(third.status,'succeeded');assert.equal(third.result.items[0].decider,'llm');
  assert.equal(llmCalls,2);assert.equal(jevCalls,1);
  assert.equal(x.api.store.officeRuns(x.config.project.id,work.work_id).length,3);
});

test('Jev changes during a multi-row Pack run apply to the next judgment',async t=>{
  let x,workId,jevCalls=0,llmCalls=0;
  const changeJev=enabled=>{
    const current=x.api.store.intakeWork(x.config.project.id,workId);
    x.api.work.jev({work_id:workId,revision:current.revision,enabled,cost_acknowledged:enabled});
  };
  const model={async call(purpose,_instructions,input){
    if(purpose==='design')return {
      title:'메시지 분류',desired_outcome:'세 메시지를 분류한다',
      completion_checks:[{id:'classified',result:'세 메시지의 분류 결과를 확인한다',evidence:'분류 영수증'}],
      assumptions:[],route:{kind:'pack',pack_family:'inbox.triage'},requested_effect:'draft_only',
      recurrence:{kind:'once',rule:null},questions:[],
    };
    if(purpose==='correct'){
      llmCalls++;
      if(llmCalls===1)changeJev(true);
      return {label:'urgent',evidence_quote:input.state.record.subject};
    }
    throw Error('UNEXPECTED_MODEL_PURPOSE');
  }};
  x=await setup(t,{packModels:'jev',model});
  await writeFile(join(x.project,'messages.json'),JSON.stringify([
    {id:'m1',subject:'server down first'},
    {id:'m2',subject:'server down second'},
    {id:'m3',subject:'server down third'},
  ]));
  x.api.packs.providers.jev={async systemOne(){
    jevCalls++;
    if(jevCalls===1)changeJev(false);
    return {answers:{label:{type:'choice',choice:'urgent',confidence:.99,probabilities:{urgent:.99,routine:.005,unknown:.005}}}};
  }};
  const work=await x.api.call('runtime_work_start',{request_id:'triage-live-toggle',prompt:'세 메시지 중요도 분류'});
  workId=work.work_id;
  changeJev(true);
  const recipe={version:1,family:'inbox.triage',request:'세 메시지 중요도 분류',sources:[{id:'messages',parameters:{}}],filters:[],deduplicate_by:['id'],judgment:{question:'긴급 대응이 필요한가?',labels:{urgent:'장애 또는 안전 문제',routine:'일반 요청'}},draft_by_label:{}};
  const result=await x.api.call('runtime_pack_run',{request_id:'triage-live-toggle-run',work_id:workId,recipe});
  assert.equal(result.status,'succeeded');
  assert.deepEqual(result.result.items.map(item=>item.decider),['jev','llm','jev']);
  assert.equal(jevCalls,2);assert.equal(llmCalls,1);
  assert.equal(x.api.store.intakeWork(x.config.project.id,workId).jev_enabled,true);
});

test('legacy office_intake rows migrate with Jev off and their existing Work data preserved',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-legacy-jev-')),path=join(root,'legacy.sqlite');
  t.after(async()=>rm(root,{recursive:true,force:true}));
  const workId='11111111-1111-4111-8111-111111111111',at='2026-01-01T00:00:00.000Z';
  const old=new DatabaseSync(path);
  old.exec(`CREATE TABLE office_work(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,title TEXT NOT NULL,goal TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE office_intake(work_id TEXT PRIMARY KEY REFERENCES office_work(id),project_id TEXT NOT NULL,request_id TEXT NOT NULL,prompt_hash TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,prompt TEXT NOT NULL,spec TEXT NOT NULL,questions TEXT NOT NULL,answers TEXT NOT NULL,define_owner TEXT,define_lease_until_ms INTEGER NOT NULL DEFAULT 0,paused INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(project_id,request_id));`);
  old.prepare('INSERT INTO office_work VALUES (?,?,?,?,?,?)').run(workId,'legacy-project','기존 업무','기존 결과',at,at);
  old.prepare('INSERT INTO office_intake VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(workId,'legacy-project','legacy-request','a'.repeat(64),'quick','ready',4,'기존 요청','null','[]','{}',null,0,0,at,at);
  old.close();
  for(let attempt=0;attempt<2;attempt++){
    const store=new PackStore(path);
    const work=store.intakeWork('legacy-project',workId);
    assert.equal(work.prompt,'기존 요청');assert.equal(work.status,'ready');assert.equal(work.revision,4);
    assert.equal(work.jev_enabled,false);assert.equal(work.jev_cost_consent_at,null);
    store.close();
  }
  const check=new DatabaseSync(path);
  assert.ok(check.prepare('PRAGMA table_info(office_intake)').all().some(column=>column.name==='jev_enabled'));
  assert.ok(check.prepare('PRAGMA table_info(office_intake)').all().some(column=>column.name==='jev_cost_consent_at'));
  assert.equal(check.prepare('SELECT title FROM office_work WHERE id=?').get(workId).title,'기존 업무');
  check.close();
});
