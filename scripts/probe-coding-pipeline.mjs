// Explicit native smoke test. Creates and removes only its own temporary Git project.
// The Work planner is fixed so this checks the real Codex/Claude CLI handoff, not planning quality.
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';

const root=await mkdtemp(join(tmpdir(),'agent-driver-native-coding-'));
const repo=join(root,'repo');
let api;
try{
  await mkdir(repo);
  await writeFile(join(repo,'README.md'),'# Native coding probe\n');
  await writeFile(join(repo,'main.txt'),'base\n');
  const git=(...args)=>execFileSync('/usr/bin/git',['-C',repo,...args],{encoding:'utf8'});
  git('init','-q');git('config','user.name','Agent Driver Probe');git('config','user.email','probe@example.test');git('add','.');git('commit','-qm','initial');
  const configPath=join(root,'host.json');
  await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'native-coding-probe',caller_ref:'local-probe',account_ref:'probe',worktree:root,data_dir:join(root,'data'),environment:'production',coding:{model_data_approved:true,projects:[{id:'scratch',root:repo,allow_write:true,allow_commit:false,verify:[]}]}}));
  const proposal={title:'코딩 CLI 인계 검사',desired_outcome:'임시 Git 파일 변경과 독립 검토를 수행한다',completion_checks:[{id:'changed',result:'main.txt 값 변경',evidence:'파일 읽기'},{id:'reviewed',result:'Claude 검토 완료',evidence:'구조화된 검토 결과'}],assumptions:[],route:{kind:'pack',pack_family:'coding.orchestrate'},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]};
  const plan={goal:'임시 Git 파일 변경과 독립 검토',stages:[{id:'implement',actor:'codex',operation:'implement',instruction:'In this scratch Git repository, change only main.txt from base to implemented and then stop. Do not alter README.md.',evidence:'main.txt Git diff confirms the exact change',source_paths:[]},{id:'review',actor:'claude',operation:'review',instruction:'Review the main.txt diff for the requested exact change. Approve only if base became implemented and no other file changed.',evidence:'Structured approved judgment and issue list',source_paths:[]}],completion_checks:['main.txt contains implemented','Claude review approved']};
  const model={async call(_purpose,_instructions,input){return input.project_ref?plan:proposal;}};
  api=new RuntimeApi(loadHostConfig(configPath),{swarmModel:model});
  const work=await api.call('runtime_work_start',{request_id:'native-coding-probe',prompt:'scratch 프로젝트 main.txt를 구현하고 Claude로 변경분을 검토해줘'});
  const run=await api.call('runtime_coding_start',{request_id:'native-coding-probe',work_id:work.work_id,project_ref:'scratch'});
  const implemented=await api.call('runtime_coding_step',{run_id:run.run_id,expected_revision:run.revision});
  const changed=(await readFile(join(repo,'main.txt'),'utf8')).trim()==='implemented';
  let reviewed=null;
  if(implemented.stages[0]?.status==='succeeded')reviewed=await api.call('runtime_coding_step',{run_id:run.run_id,expected_revision:implemented.revision});
  const handoff=await readFile(join(repo,'.git','agent-driver','handoffs',`${run.run_id}.md`),'utf8');
  const checkpointUpdated=handoff.includes('## Completed and verified stages')&&handoff.includes('- implement:')&&handoff.includes('- review:')&&handoff.includes('## Codebase map');
  const result={status:reviewed?.status??implemented.status,codex_stage:implemented.stages[0]?.status,claude_stage:reviewed?.stages[1]?.status??'NOT_RUN',claude_error:reviewed?.stages[1]?.receipt?.error_code??null,changed,review_approved:reviewed?.stages[1]?.receipt?.approved??null,checkpoint_updated:checkpointUpdated,work_completion_verified:reviewed?.completion_verified??false,git_files:git('diff','--name-only').trim().split(/\r?\n/u).filter(Boolean)};
  console.log(JSON.stringify(result));
  if(result.status!=='completed'||!changed||result.review_approved!==true||!checkpointUpdated||result.git_files.length!==1||result.git_files[0]!=='main.txt')process.exitCode=1;
}finally{
  if(api){api.close();await api.drain();}
  await rm(root,{recursive:true,force:true});
}
