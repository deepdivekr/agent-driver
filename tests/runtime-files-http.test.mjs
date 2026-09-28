import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,utimes,readFile,rm} from 'node:fs/promises';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {tools} from '../dist/interface/catalog.js';
import {WorkRuntime,WORK_DEFINITION_INSTRUCTIONS} from '../dist/work/runtime.js';

async function setup(t){
 const base=await mkdtemp(join(process.platform==='win32'?homedir():tmpdir(),'driver-files-http-')),folder=join(base,'Desktop');await mkdir(folder);const path=join(base,'host.json');
 await writeFile(path,JSON.stringify({schema_version:1,project_id:'files-http',caller_ref:'test-agent',account_ref:'owner',worktree:base,data_dir:join(base,'data'),environment:'production',work:{model_data_approved:true}}));
 const config=loadHostConfig(path),api=new RuntimeApi(config),server=await startControlCenter(config);t.after(async()=>{await server.close();api.close();await api.drain();await rm(base,{recursive:true,force:true});});
 const post=async(action,body={},authorized=true)=>{const response=await fetch(server.url+'files/'+action,{method:'POST',headers:{'content-type':'application/json',...(authorized?{origin:new URL(server.url).origin,'x-agent-driver':'human-office'}:{})},body:JSON.stringify(body)});return {status:response.status,body:response.status===403?await response.text():await response.json()};};
 const created=api.store.beginWork(config.project.id,'file-request','바탕화면을 업무별로 정리해줘','quick').work;const owner=api.store.claimWorkDefinition(config.project.id,created.id);const work=api.store.failWorkDefinition(config.project.id,created.id,owner);
 return {base,folder,api,server,post,work,config};
}
test('Work-bound MCP -> human access and move approval -> accurate report and undo',async t=>{
 const c=await setup(t),work_id=c.work.id;assert.equal(tools.runtime_files_apply,undefined);assert.equal(tools.runtime_files_grant,undefined);
 const request=await c.api.call('runtime_files_request',{work_id,path:c.folder,purpose:'요청한 바탕화면 정리',read_content:true,allow_move:true});
 assert.equal((await c.post('grant',{work_id,request_id:request.id,path:c.folder},false)).status,403);
 const granted=await c.post('grant',{work_id,request_id:request.id,path:c.folder,read_content:true,allow_move:true});assert.equal(granted.status,200);
 await writeFile(join(c.folder,'견적.txt'),'견적 검토 문서');const old=new Date(Date.now()-3*86400000);await utimes(join(c.folder,'견적.txt'),old,old);await writeFile(join(c.folder,'최근.txt'),'최근 작업');
 const scan=await c.api.call('runtime_files_scan',{root_id:granted.body.root.id}),f=scan.files.find(f=>f.path==='견적.txt');
 await c.api.call('runtime_files_classify',{scan_id:scan.id,items:[{file_id:f.id,category:'업무',reason:'견적 표현을 근거로 추정',evidence_ids:['text-0']}]});
 const p=await c.api.call('runtime_files_propose',{work_id,scan_id:scan.id,moves:[{file_id:f.id,to:'업무/견적.txt',reason:'견적 문구가 있는 문서',evidence_ids:['text-0']}]});
 assert.equal(p.state,'preview');assert.equal(await readFile(join(c.folder,'견적.txt'),'utf8'),'견적 검토 문서');
 assert.equal((await c.post('apply',{work_id,plan_id:p.id},false)).status,403);
 const other=c.api.store.beginWork(c.config.project.id,'other','다른 업무','quick').work;assert.equal((await c.post('apply',{work_id:other.id,plan_id:p.id})).status,409);
 const paused=c.api.store.setIntakePaused(c.config.project.id,work_id,c.work.revision,true);assert.equal((await c.post('apply',{work_id,plan_id:p.id})).body.error,'FILES_WORK_PAUSED');c.api.store.setIntakePaused(c.config.project.id,work_id,paused.revision,false);
 assert.equal((await c.post('apply',{work_id,plan_id:p.id})).body.state,'done');
 const report=await c.api.call('runtime_files_report',{work_id});assert.equal(report.moved.length,1);assert.equal(report.observations[0].preserved[0].path,'최근.txt');assert.equal(report.work_completion_verified,false);
 const detail=await (await fetch(c.server.url+'work/detail?id='+work_id)).json();assert.equal(detail.file_activity.moved.length,1);
 assert.equal((await c.post('undo',{work_id,plan_id:p.id})).body.state,'undone');assert.equal((await c.api.call('runtime_files_report',{work_id})).restored.length,1);assert.equal(await readFile(join(c.folder,'견적.txt'),'utf8'),'견적 검토 문서');
 assert.equal((await fetch(c.server.url+'files')).status,404);assert.equal((await fetch(c.server.url+'files/apply')).status,405);assert.equal((await fetch(c.server.url+'files/grant',{method:'POST',headers:{'content-type':'application/json',origin:'https://untrusted.invalid','x-agent-driver':'human-office'},body:JSON.stringify({work_id})})).status,403);assert.equal((await (await fetch(c.server.url)).text()).includes('href="files"'),false);
});
test('prompt definition exposes file tools without a separate file-manager step (fixture model)',async t=>{
 const c=await setup(t);let observed=null;
 const model={call:async(purpose,instructions,input)=>{observed={purpose,instructions,input};return {title:'바탕화면 정리',desired_outcome:'분류 근거에 따라 정리하고 결과 확인',completion_checks:[{id:'readback',result:'승인한 파일 이동 확인',evidence:'runtime_files_report의 경로와 해시'}],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]};}};
 const runtime=new WorkRuntime(c.api.store,c.config,model),work=await runtime.start({request_id:'natural-file-work',prompt:'내 바탕화면 정리해줘'});
 assert.equal(work.status,'ready');assert.equal(work.next_action,'connected_agent_choose_file_tools_or_runtime_pack_plan');assert.equal(observed.input.file_tools.result,'runtime_files_report');assert.ok(observed.instructions.includes('runtime_files_request'));assert.ok(WORK_DEFINITION_INSTRUCTIONS.includes('Existing folder permission does not approve a new move'));
 const detail=await (await fetch(c.server.url+'work/detail?id='+work.work_id)).json();assert.equal(detail.file_activity,null);
});

test('file history remains bound to its Work after more than 100 other records',async t=>{
 const c=await setup(t),work_id=c.work.id;
 const request=c.api.files.request({work_id,path:c.folder,purpose:'정리',allow_move:true});
 c.api.files.grantRequest({work_id,request_id:request.id,path:c.folder,allow_move:true});
 await writeFile(join(c.folder,'old.txt'),'old');const old=new Date(Date.now()-3*86400000);await utimes(join(c.folder,'old.txt'),old,old);
 const scan=c.api.files.scan({root_id:c.api.files.roots()[0].id});
 const plan=c.api.files.propose({work_id,scan_id:scan.id,moves:[{file_id:scan.files[0].id,to:'sorted/old.txt',reason:'정리',evidence_ids:['path']}]});
 const insert=c.api.store.hermesState.prepare('INSERT INTO file_explorer_record VALUES(?,?,?,?)');
 for(let i=0;i<101;i++)for(const [kind,record]of [['access',request],['plan',plan]]){const id=crypto.randomUUID();insert.run(c.config.project.id,kind,id,JSON.stringify({...record,id,work_id:'other-work'}));}
 const report=c.api.files.report({work_id});assert.equal(report.requests.length,1);assert.equal(report.plans[0]?.id,plan.id);
 assert.equal((await c.post('apply',{work_id,plan_id:plan.id})).body.state,'done');
});

test('observations survive later scans from another Work and retained-scan eviction',async t=>{
 const c=await setup(t),work_id=c.work.id,other=c.api.store.beginWork(c.config.project.id,'observation-other','다른 업무','quick').work;
 const root=c.api.files.grant({path:c.folder});await writeFile(join(c.folder,'first.txt'),'first');
 const scan=await c.api.call('runtime_files_scan',{work_id,root_id:root.id});
 await writeFile(join(c.folder,'second.txt'),'second');
 for(let i=0;i<6;i++)await c.api.call('runtime_files_scan',{work_id:other.id,root_id:root.id});
 const report=c.api.files.report({work_id});assert.equal(report.observations[0]?.scan_id,scan.id);assert.equal(report.observations[0]?.files_observed,1);
 assert.equal(c.api.files.report({work_id:other.id}).observations[0]?.files_observed,2);
});

test('file result is visible in board, Work status and a new agent handoff; revoke retains receipts',async t=>{
 const c=await setup(t),model={call:async()=>({title:'파일 정리',desired_outcome:'파일 정리 결과 보고',completion_checks:[{id:'readback',result:'승인된 이동 확인',evidence:'runtime_files_report'}],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]})};
 const runtime=new WorkRuntime(c.api.store,c.config,model),work=await runtime.start({request_id:'receipt-work',prompt:'파일 정리'}),work_id=work.work_id;
 const request=c.api.files.request({work_id,path:c.folder,purpose:'정리',allow_move:true});
 const grant=await c.post('grant',{work_id,request_id:request.id,path:c.folder,allow_move:true});
 assert.equal(runtime.status({work_id}).next_action,'runtime_files_report_then_continue_file_tools');
 await writeFile(join(c.folder,'memo.txt'),'memo');const old=new Date(Date.now()-3*86400000);await utimes(join(c.folder,'memo.txt'),old,old);
 const scan=c.api.files.scan({root_id:grant.body.root.id,work_id}),p=c.api.files.propose({work_id,scan_id:scan.id,moves:[{file_id:scan.files[0].id,to:'sorted/memo.txt',reason:'문서 정리',evidence_ids:['path']}]});
 assert.equal(runtime.status({work_id}).file_activity.status,'waiting_approval');
 await c.post('apply',{work_id,plan_id:p.id});
 const status=runtime.status({work_id});assert.equal(status.file_activity.status,'needs_verification');assert.equal(status.next_action,'runtime_files_report_then_verify_work_outcome');
 const board=await(await fetch(c.server.url+'work/board')).json();assert.equal(board.works.find(w=>w.id===work_id).status,'needs_verification');
 const detail=await(await fetch(c.server.url+'work/detail?id='+work_id)).json();assert.equal(detail.run_status,'needs_verification');assert.equal(detail.stages.some(s=>s.id===p.id&&s.verified),true);assert.equal(detail.completion_verified,false);
 const context=await c.api.call('runtime_work_context',{work_id,actor:'new-agent'});assert.ok(JSON.stringify(context.capsule).includes('file_plan:'+p.id));assert.ok(context.capsule.core.next_action.includes('runtime_files_report'));
 const revoked=await c.post('revoke',{work_id,request_id:request.id});assert.equal(revoked.status,200);
 const report=c.api.files.report({work_id});assert.equal(report.requests[0].granted,false);assert.equal(report.moved.length,1);assert.equal(report.plans[0].permission_active,false);
 assert.equal((await c.post('undo',{work_id,plan_id:p.id})).status,409);assert.equal(await readFile(join(c.folder,'sorted/memo.txt'),'utf8'),'memo');
});

test('interrupted file effects stay uncertain in the Work handoff',async t=>{
 const c=await setup(t),model={call:async()=>({title:'정리',desired_outcome:'정리 결과 확인',completion_checks:[{id:'check',result:'결과 확인',evidence:'file report'}],assumptions:[],route:{kind:'pack',pack_family:'file.pipeline'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]})};
 const runtime=new WorkRuntime(c.api.store,c.config,model),work=await runtime.start({request_id:'interrupted',prompt:'파일 정리'}),work_id=work.work_id;
 const root=c.api.files.grant({path:c.folder,allow_move:true});await writeFile(join(c.folder,'memo.txt'),'memo');const old=new Date(Date.now()-3*86400000);await utimes(join(c.folder,'memo.txt'),old,old);
 const scan=c.api.files.scan({root_id:root.id,work_id}),plan=c.api.files.propose({work_id,scan_id:scan.id,moves:[{file_id:scan.files[0].id,to:'sorted/memo.txt',reason:'정리',evidence_ids:['path']}]});
 plan.state='applying';plan.moves[0].state='copying';c.api.store.hermesState.prepare("UPDATE file_explorer_record SET body=? WHERE project=? AND kind='plan' AND id=?").run(JSON.stringify(plan),c.config.project.id,plan.id);
 const context=await c.api.call('runtime_work_context',{work_id,actor:'recovery'});
 assert.equal(runtime.status({work_id}).file_activity.status,'reconciliation_required');assert.ok(JSON.stringify(context.capsule).includes('uncertain'));assert.ok(context.capsule.core.next_action.includes('never replay'));
 assert.equal((await c.post('apply',{work_id,plan_id:plan.id})).status,409);assert.equal(await readFile(join(c.folder,'memo.txt'),'utf8'),'memo');
});
