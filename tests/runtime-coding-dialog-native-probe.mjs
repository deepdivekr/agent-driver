// Opt-in native WSL smoke: owns an isolated temporary Git repository only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable} from '../dist/integrations/subscription-auth.js';
import {NativeCodexSessionCatalog} from '../dist/coding/session-catalog.js';

const proposal={title:'임시 코딩 대화 검증',desired_outcome:'Codex CLI 기존 대화 세션을 안전하게 이어받아 답변한다',completion_checks:[{id:'reply',result:'Codex 답변을 사용자가 확인한다',evidence:'영속 저장된 원문 답변'}],assumptions:[],route:{kind:'pack',pack_family:'coding.orchestrate'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};
const root=await mkdtemp(join(tmpdir(),'agent-driver-dialog-native-')),repo=join(root,'repo');
let api;
try{
  await mkdir(repo);await writeFile(join(repo,'README.md'),'# Isolated fixture\nNo production project files are here.\n');
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('add','.');git('commit','-qm','fixture');
  const executable=resolveSubscriptionClientExecutable('codex');
  const seed=await nativeProcessRunner.run({executable,args:['-C',repo,'-s','read-only','-a','never','exec','--json','-'],cwd:repo,stdin:'Read README.md and answer in one short sentence: what kind of repository is this? Do not change files.',timeout_ms:180_000,output_limit_bytes:8_388_608});
  assert.equal(seed.code,0,'seed Codex CLI turn failed');
  const events=seed.stdout.split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const sessionId=events.find(event=>event.type==='thread.started')?.thread_id;
  assert.match(sessionId,/^[0-9a-f-]{36}$/u);assert.ok(events.some(event=>event.type==='turn.completed'));
  const catalog=new NativeCodexSessionCatalog(executable,{timeout_ms:20_000});
  const sessions=await catalog.list(repo);
  assert.ok(sessions.some(session=>session.id===sessionId),'new native exec session missing from project catalog');
  const selected=await catalog.inspect(repo,sessionId);assert.ok(['idle','notLoaded'].includes(selected.status));
  const path=join(root,'host.json');await writeFile(path,JSON.stringify({schema_version:1,project_id:'native-dialog',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',coding:{projects:[{id:'demo',root:repo,allow_write:false,allow_commit:false,verify:[]}],model_data_approved:true}}));
  const model={async call(purpose){return purpose==='correct'?{assessment:'Codex CLI 응답이 저장됐습니다.',recommendation:'사용자가 원문을 확인하고 다음 지시를 정하세요.',suggested_next_instruction:null}:proposal;}};
  api=new RuntimeApi(loadHostConfig(path),{swarmModel:model,coding:{executables:{codex:executable,claude:'/unused/claude'},sessionCatalog:catalog}});
  const work=await api.call('runtime_work_start',{request_id:'native-work',prompt:'임시 프로젝트의 README를 읽고 결과를 알려줘'});
  const dialog=await api.call('runtime_coding_dialog_attach',{request_id:'native-dialog',work_id:work.work_id,project_ref:'demo',session_id:sessionId});
  assert.equal(dialog.status,'waiting_user');
  await api.call('runtime_coding_dialog_turn',{dialog_id:dialog.dialog_id,expected_revision:dialog.revision,request_id:'native-turn',instruction:'같은 README를 다시 읽고 제목을 알려줘. 파일은 수정하지 마.'});
  await api.codingDialog.drain();
  const result=await api.call('runtime_coding_dialog_status',{dialog_id:dialog.dialog_id});
  assert.equal(result.status,'waiting_user');assert.equal(result.turns.length,1);assert.ok(result.turns[0].reply?.length);assert.ok(result.turns[0].advice?.length);
  assert.equal(git('status','--porcelain').trim(),'');
  process.stdout.write(JSON.stringify({evidence_level:'native_integration',status:'PASS',session_resumed_exactly:true,reply_preserved:true,supervisor_advice_separate:true,git_clean:true})+'\n');
}catch(error){process.stderr.write(JSON.stringify({evidence_level:'native_integration',status:'FAIL',error:error instanceof Error?error.message:'UNKNOWN'})+'\n');process.exitCode=1;}
finally{if(api){api.close();await api.drain();}await rm(root,{recursive:true,force:true});}
