import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {nativeProcessRunner} from '../dist/integrations/subscription-auth.js';
import {startControlCenter} from '../dist/observability/control-center.js';

const sessionId='11111111-1111-4111-8111-111111111111';
const proposal={title:'대화형 코딩',desired_outcome:'등록된 프로젝트의 요청 사항을 Codex CLI와 대화하며 구현',completion_checks:[{id:'check',result:'변경 사항을 직접 확인한다',evidence:'Git diff와 검증 결과'}],assumptions:[],route:{kind:'pack',pack_family:'coding.orchestrate'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]};

async function setup(t,{fail=false,write=true}={}){
  const home=await mkdtemp(join(tmpdir(),'driver-dialog-')),repo=join(home,'repo');await mkdir(repo);
  await writeFile(join(repo,'README.md'),'# Fixture\n');await writeFile(join(repo,'main.txt'),'base\n');
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});
  git('init','-q');git('config','user.name','Fixture');git('config','user.email','fixture@example.test');git('add','.');git('commit','-qm','initial');
  const configPath=join(home,'host.json');await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'dialog-fixture',caller_ref:'agent',account_ref:'owner',worktree:home,data_dir:join(home,'data'),environment:'production',coding:{projects:[{id:'demo',root:repo,allow_write:write,allow_commit:false,verify:[]}],model_data_approved:true}}));
  const config=loadHostConfig(configPath),calls=[];
  const model={calls:[],async call(purpose,instructions,input){this.calls.push({purpose,input});return purpose==='correct'?{assessment:'Codex 응답은 수신됐지만 전체 완료는 별도 검증이 필요합니다.',recommendation:'변경 파일과 테스트를 검토하세요.',suggested_next_instruction:'추가 테스트를 진행해줘'}:proposal;}};
  const catalog={async list(root){assert.equal(root,repo);return [{id:sessionId,title:'Prior CLI conversation',preview:'Previously working on fixture',status:'idle',created_at:1,updated_at:2}];},async inspect(root,id){assert.equal(root,repo);assert.equal(id,sessionId);return {id,title:'Prior CLI conversation',preview:'Previously working on fixture',status:'idle',created_at:1,updated_at:2};}};
  const runner={async run(request){
    if(request.executable==='/usr/bin/git')return nativeProcessRunner.run(request);
    assert.equal(request.executable,'/fake/codex');calls.push(request);
    assert.equal(request.args.includes('--last'),false);assert.equal(request.args[request.args.indexOf('resume')+2],sessionId);
    if(fail){await writeFile(join(repo,'main.txt'),'partially changed\n');return {code:1,stdout:'',stderr:'Weekly usage limit reached'};}
    const before=await readFile(join(repo,'main.txt'),'utf8');await writeFile(join(repo,'main.txt'),before+'updated\n');
    const events=[{type:'thread.started',thread_id:sessionId},{type:'item.completed',item:{type:'agent_message',text:'Codex answer, full URL https://example.test/path?q=one&month=9\nChange complete.'}},{type:'turn.completed'}];
    const stdout=events.map(event=>JSON.stringify(event)).join('\n')+'\n';request.onStdout?.(stdout);return {code:0,stdout,stderr:''};
  }};
  const api=new RuntimeApi(config,{swarmModel:model,coding:{runner,executables:{codex:'/fake/codex',claude:'/fake/claude'},sessionCatalog:catalog}});
  t.after(async()=>{api.close();await api.drain();await rm(home,{recursive:true,force:true});});
  const work=await api.call('runtime_work_start',{request_id:'work-one',prompt:'demo 프로젝트에 기능을 추가하고 진행을 상의해줘'});
  assert.equal(work.status,'ready');
  return {api,config,repo,calls,model,work,git};
}

test('explicit exact-session attach sends no prompt; one turn persists full Codex answer and separate advice, then waits',async t=>{
  const x=await setup(t);
  const sessions=await x.api.call('runtime_coding_dialog_sessions',{project_ref:'demo'});
  assert.equal(sessions.auto_selected,false);assert.equal(sessions.sessions[0].selectable,true);
  const attached=await x.api.call('runtime_coding_dialog_attach',{request_id:'dialog-one',work_id:x.work.work_id,project_ref:'demo',session_id:sessionId});
  assert.equal(attached.status,'waiting_user');assert.equal(attached.execution_started,false);assert.equal(x.calls.length,0);
  const first=await x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:attached.revision,request_id:'turn-one',instruction:'main.txt에 변경을 추가하고 결과를 알려줘'});
  assert.equal(first.status,'running');await x.api.codingDialog.drain();
  const done=await x.api.call('runtime_coding_dialog_status',{dialog_id:attached.dialog_id});
  assert.equal(done.status,'waiting_user');assert.equal(done.auto_continue,false);assert.equal(x.calls.length,1);
  assert.equal(done.turns[0].reply,'Codex answer, full URL https://example.test/path?q=one&month=9\nChange complete.');
  assert.match(done.turns[0].advice,/별도 검증이 필요/u);assert.equal(done.session_id,sessionId);
  const duplicate=await x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:attached.revision,request_id:'turn-one',instruction:'main.txt에 변경을 추가하고 결과를 알려줘'});
  assert.equal(duplicate.deduplicated,true);assert.equal(x.calls.length,1);
  const second=await x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:done.revision,request_id:'turn-two',instruction:'이전 변경을 확인하고 다음 내용을 추가해줘'});
  assert.equal(second.status,'running');await x.api.codingDialog.drain();
  const later=await x.api.call('runtime_coding_dialog_status',{dialog_id:attached.dialog_id});assert.equal(later.turns.length,2);assert.equal(x.calls.length,2);
  assert.equal(x.calls.every(call=>call.args.includes(sessionId)),true);
});

test('Git state drift blocks a new turn before Codex and stop prevents continuation',async t=>{
  const x=await setup(t),attached=await x.api.call('runtime_coding_dialog_attach',{request_id:'dialog-two',work_id:x.work.work_id,project_ref:'demo',session_id:sessionId});
  await writeFile(join(x.repo,'main.txt'),'manual edit\n');
  await assert.rejects(x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:attached.revision,request_id:'turn-one',instruction:'코드를 수정한 뒤 결과를 알려줘'}),/CODING_GIT_CHECKPOINT_CHANGED/u);
  assert.equal(x.calls.length,0);
  const stopped=await x.api.call('runtime_coding_dialog_stop',{dialog_id:attached.dialog_id,expected_revision:attached.revision});
  assert.equal(stopped.status,'stopped');
  await assert.rejects(x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:stopped.revision,request_id:'turn-two',instruction:'수정을 이어서 진행해줘'}),/CODING_DIALOG_REVISION_CONFLICT/u);
});

test('a failed Codex write becomes reconciliation_required and is never automatically replayed',async t=>{
  const x=await setup(t,{fail:true}),attached=await x.api.call('runtime_coding_dialog_attach',{request_id:'dialog-three',work_id:x.work.work_id,project_ref:'demo',session_id:sessionId});
  await x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:attached.revision,request_id:'turn-one',instruction:'코드를 구현하고 결과를 알려줘'});
  await x.api.codingDialog.drain();
  const status=await x.api.call('runtime_coding_dialog_status',{dialog_id:attached.dialog_id});
  assert.equal(status.status,'reconciliation_required');assert.equal(status.turns[0].status,'uncertain');assert.equal(x.calls.length,1);
  const recovery=await x.api.call('runtime_coding_dialog_reconcile',{dialog_id:attached.dialog_id});
  assert.equal(recovery.manual_review_required,true);assert.equal(recovery.auto_replay,false);assert.notEqual(recovery.stored_git.state_sha256,recovery.observed_git.state_sha256);
  await assert.rejects(x.api.call('runtime_coding_dialog_turn',{dialog_id:attached.dialog_id,expected_revision:status.revision,request_id:'turn-two',instruction:'동일 작업을 재실행해줘'}),/CODING_DIALOG_REVISION_CONFLICT/u);
  assert.equal(x.calls.length,1);
});

test('Control Center enforces same-origin user action and exposes full persisted answer in Work detail',async t=>{
  const x=await setup(t),server=await startControlCenter(x.config,{workModel:x.model,coding:x.api.options.coding,poll_ms:1000});
  t.after(()=>server.close());
  const post=(path,body,headers={})=>fetch(new URL(path,server.url),{method:'POST',headers:{origin:new URL(server.url).origin,'x-agent-driver':'human-office','content-type':'application/json',...headers},body:JSON.stringify(body)});
  const denied=await post('work/coding/attach',{request_id:'dialog-http',work_id:x.work.work_id,project_ref:'demo',session_id:sessionId},{'x-agent-driver':'wrong'});
  assert.equal(denied.status,403);
  const list=await fetch(new URL('work/coding/sessions?project_ref=demo',server.url)).then(response=>response.json());
  assert.equal(list.sessions[0].id,sessionId);
  const attached=await post('work/coding/attach',{request_id:'dialog-http',work_id:x.work.work_id,project_ref:'demo',session_id:sessionId}).then(response=>response.json());
  assert.equal(attached.status,'waiting_user');assert.equal(x.calls.length,0);
  const begun=await post('work/coding/turn',{dialog_id:attached.dialog_id,expected_revision:attached.revision,request_id:'http-turn',instruction:'README를 읽고 변경을 진행해줘'}).then(response=>response.json());
  assert.equal(begun.status,'running');
  let detail;
  for(let i=0;i<40;i++){
    detail=await fetch(new URL(`work/detail?id=${x.work.work_id}`,server.url)).then(response=>response.json());
    if(detail.coding_dialog?.status==='waiting_user')break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal(detail.coding_dialog.status,'waiting_user');
  assert.match(detail.coding_dialog.turns[0].reply,/https:\/\/example\.test\/path\?q=one&month=9/u);
  assert.match(detail.coding_dialog.turns[0].advice,/검토하세요/u);
  assert.equal(x.calls.length,1);
});
