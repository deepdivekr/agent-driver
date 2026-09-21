// Opt-in actual Claude subscription + runtime broker + independent namespace checks.
import {mkdirSync, writeFileSync, readFileSync, existsSync} from 'node:fs';
import {resolve, join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {stopTerminalHost} from '../../dist/terminal/manager.js';
import {liveness} from '../../dist/supervisor/identity.js';
import {sha256} from '../../dist/terminal/scoped-files.js';
import {evidenceInputs, changedInputs} from './evidence-inputs.mjs';
import {inspectBudget,readBudget,assertBudgetMembership,managerEnvironment} from '../../dist/resources/budget.js';
import {execFileSync} from 'node:child_process';
if (!process.argv[2] || process.argv[3] !== '--run') throw Error('Explicit executable and --run required');
const id = `terminal-files-native-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0,8)}`, root = resolve('.runtime', id), worktree = join(root, 'owned'), path = join(root, 'host.json');
const resources=process.argv.includes('--resources')?{domain:id,cpu_percent:100,memory_mb:1024,tasks_max:256}:null;
const storage=process.argv.includes('--storage')?{max_bytes:67108864,min_free_bytes:33554432,journal_margin_bytes:8388608,segment_bytes:65536,retention_days:30,cleanup_enabled:false}:null;
mkdirSync(join(worktree, 'src'), {recursive: true, mode: 0o700});
writeFileSync(join(worktree, 'src/app.mjs'), "process.stdout.write('broken');\n");
writeFileSync(join(root, 'outside-sentinel'), 'must stay unchanged');
const cases = [{id:'positive',args:['sum','2','3'],stdout:'5'}, {id:'negative',args:['sum','-8','3'],stdout:'-5'}, {id:'decimal',args:['sum','1.25','2.5'],stdout:'3.75'}, {id:'unicode',args:['greet','고양이🐈'],stdout:'안녕, 고양이🐈!'}];
writeFileSync(path, JSON.stringify({schema_version:1,project_id:'actual-files',caller_ref:'synthetic-native-test',account_ref:'cli-subscription',worktree,data_dir:join(root,'data'),...(resources?{resources}:{}),...(storage?{storage}:{}),terminal:{executable:process.argv[2],version:'2.1.126',max_turns:4,turn_deadline_ms:180000,files:{ownership:'exclusive_runtime',read:['src/app.mjs','README.md'],write:['src/app.mjs','README.md'],verifier:{kind:'node_stdio_cases',entry:'src/app.mjs',cases}}}}), {mode:0o600});
const config = loadHostConfig(path), api = new RuntimeApi(config), receipt = {id, status:'NOT_RUN', cli_version:'2.1.126', auth:'existing_cli_subscription', native_tools:[], prompts_accepted:0, inference_count:'unobserved', turns:[], verifications:[], project_completed:false, inputs:evidenceInputs()};
let session, originalCli;
const save = () => writeFileSync(join(root,'receipt.json'),JSON.stringify(receipt,null,2),{mode:0o600});
async function until(predicate, transition) {const deadline=performance.now()+190000;while(performance.now()<deadline){const s=api.store.session(session);if(predicate(s))return s;if(s.error_code&&s.error_code!==transition)throw Error(s.error_code);await delay(100);}throw Error('NATIVE_FILES_TIMEOUT');}
async function turn(n,prompt) {
 const s=await until(s=>s.state==='input_ready'), start=performance.now();
 const accepted=await api.call('runtime_terminal_submit_prompt',{request_id:`turn-${n}`,session_ref:session,expected_generation:s.generation,expected_previous_turn_id:s.last_turn_id,prompt}); receipt.prompts_accepted++; save();
 const done=await until(s=>s.last_turn_id===accepted.turn_id&&s.state==='input_ready');
 receipt.turns.push({index:n,turn_id:accepted.turn_id,generation:done.generation,status:'PASS',elapsed_ms:performance.now()-start,same_cli_session:done.cli_session_id===originalCli}); save();return done;
}
async function verify(label, expected) {const s=api.store.session(session);const start=performance.now();const observed=await api.call('runtime_terminal_verify',{request_id:label,session_ref:session,expected_generation:s.generation,expected_turn_id:s.last_turn_id});receipt.verifications.push({label,...observed,elapsed_ms:performance.now()-start,expected_status:expected});save();if(observed.result?.status!==expected)throw Error('INDEPENDENT_CHECK_MISMATCH');}
try {
 const accepted=await api.call('runtime_terminal_start',{request_id:'files-session'});session=accepted.session_ref;originalCli=(await until(s=>s.state==='input_ready')).cli_session_id;
 if(resources){
  const handle=await inspectBudget(resources),host=JSON.parse(api.store.terminalHost(config.project.id).identity_json),cli=JSON.parse(api.store.session(session).process_identity_json);
  assertBudgetMembership(handle,host.pid);assertBudgetMembership(handle,cli.pid);receipt.resources_before=readBudget(handle);
 }
 await turn(1,'src/app.mjs를 읽고 현재 동작을 짧게 설명해. 이 턴에서는 파일을 바꾸지 마.');
 await verify('before-fix','FAIL');
 await turn(2,'src/app.mjs를 고쳐줘. node src/app.mjs sum A B는 두 수의 합만, node src/app.mjs greet NAME은 안녕, NAME!만 출력해야 해. 소수·음수와 한국어·이모지를 지원하고 끝에 줄바꿈은 넣지 마.');
 await verify('after-code','PASS');
 await turn(3,'README.md를 새로 만들어 방금 구현한 sum과 greet의 사용법을 한국어로 적어줘. 다른 파일은 바꾸지 마.');
 await verify('after-docs','PASS');
 await api.call('runtime_terminal_interrupt',{session_ref:session,expected_generation:1});await until(s=>s.state==='process_exited','INTERRUPTED');
 await api.call('runtime_terminal_resume',{session_ref:session,expected_generation:1});await until(s=>s.state==='input_ready'&&s.generation===2,'INTERRUPTED');
 await turn(4,'README.md를 읽고 마지막에 재개 확인: 고양이🐈라는 문장을 한 번 추가해줘. 앱 코드는 바꾸지 마.');
 await verify('after-resume','PASS');
 const handoff=await api.call('runtime_terminal_handoff',{session_ref:session,expected_generation:2});
 receipt.handoff={project_tests:handoff.handoff.verification.find(v=>v.check==='project_tests').status,project_completed:handoff.project_completed,file_effect_count:handoff.observations.file_effects.length,artifact_sha256:handoff.artifact.sha256};
 const intents=api.store.fileIntents(session);receipt.effects=intents.map(i=>({turn_id:i.turn_id,generation:i.generation,path:i.path,status:i.status,after_sha256:i.after_hash}));
 receipt.readback={readme_has_resume:readFileSync(join(worktree,'README.md'),'utf8').includes('재개 확인: 고양이🐈'),outside_unchanged:readFileSync(join(root,'outside-sentinel'),'utf8')==='must stay unchanged',app_sha256:sha256(readFileSync(join(worktree,'src/app.mjs')))};
 if(receipt.handoff.project_tests!=='PASS'||receipt.handoff.project_completed||!receipt.readback.readme_has_resume||!receipt.readback.outside_unchanged||intents.length<3||intents.some(i=>i.status!=='verified'))throw Error('NATIVE_FILES_ORACLE_FAILED');
 receipt.status='PASS';
}catch(error){receipt.status='FAIL';receipt.error=/^[A-Z_]+$/.test(error.message)?error.message:'NATIVE_FILES_FAILED';process.exitCode=1;}
finally {
 receipt.host_stop=await stopTerminalHost(config);
 if(session){const s=api.store.session(session);receipt.final_state={state:s.state,error:s.error_code,cli_liveness:s.process_identity_json?await liveness(JSON.parse(s.process_identity_json)):'unobserved'};
  receipt.broker_liveness=[];for(let generation=1;generation<=s.generation;generation++){const row=api.store.broker(session,generation);receipt.broker_liveness.push(row?await liveness(JSON.parse(row.identity_json)):'unobserved');}
  const events=api.store.events(config.project.id,'native-files-receipt',1000);receipt.event_counts=Object.fromEntries(['terminal.prompt_received','terminal.tool_requested','terminal.tool_result_observed','terminal.file_intent','terminal.file_observed','terminal.verification_observed'].map(k=>[k,events.filter(e=>e.kind===k).length]));
  const spool=join(root,'data','terminal-spool',`${session}.jsonl`);receipt.observed_models=existsSync(spool)?[...new Set(readFileSync(spool,'utf8').trim().split('\n').map(JSON.parse).map(e=>e.model).filter(Boolean))]:[];
 }
 if(!receipt.host_stop.stopped||receipt.final_state?.cli_liveness!=='dead'||receipt.broker_liveness?.some(x=>x!=='dead')){receipt.status='FAIL';process.exitCode=1;}
 if(resources)try{
  const handle=await inspectBudget(resources),end=performance.now()+5000;
  while(readBudget(handle).events.populated&&performance.now()<end)await delay(50);
  receipt.resources_after=readBudget(handle);
  if(receipt.resources_after.events.populated){receipt.status='FAIL';process.exitCode=1;}
  else {execFileSync('/usr/bin/systemctl',['--user','stop',handle.unit],{env:managerEnvironment(),timeout:5000});receipt.resource_test_group_removed=true;}
 }catch{receipt.resources_after={status:'unobserved',reason:'RESOURCE_FINAL_OBSERVATION_FAILED'};receipt.status='FAIL';process.exitCode=1;}
 if(storage){receipt.storage_after=api.store.storage(config).status();receipt.storage_plan=api.store.retention(config).plan();if(receipt.storage_after.status!=='admission_available'||receipt.storage_after.reserved_bytes!==0||receipt.storage_plan.candidates.length!==0){receipt.status='FAIL';process.exitCode=1;}}
 api.close();receipt.changed_inputs=changedInputs(receipt.inputs,evidenceInputs());if(receipt.changed_inputs.length){receipt.status='FAIL';process.exitCode=1;}save();writeFileSync(`tests/evidence/${id}.json`,JSON.stringify(receipt,null,2));
 const report=JSON.parse(readFileSync('tests/report.json','utf8'));report.cases.push({case_id:id,evidence_level:'native_integration',status:receipt.status,environment:'WSL Linux / actual Claude 2.1.126 / bubblewrap isolated Node 22.22.0',observations:receipt,evidence_paths:[`tests/evidence/${id}.json`]});writeFileSync('tests/report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({id,status:receipt.status,prompts_accepted:receipt.prompts_accepted,turns:receipt.turns,verifications:receipt.verifications.map(v=>({label:v.label,status:v.result?.status,elapsed_ms:v.elapsed_ms})),error:receipt.error,receipt:join(root,'receipt.json')}));
}
