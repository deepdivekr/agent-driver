// Real UI + isolated sample data. No model calls, task execution or private state.
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {prepareLocalConnection} from '../../dist/onboarding/connection.js';
import {loadHostConfig} from '../../dist/interface/config.js';
import {PackStore} from '../../dist/packs/store.js';
import {validateWorkProposal} from '../../dist/work/contracts.js';
import {startControlCenter} from '../../dist/observability/control-center.js';

const root=await mkdtemp(join(tmpdir(),'office-readme-'));
const paths=await prepareLocalConnection(root);
const config=loadHostConfig(paths.runtimeConfig);
const store=new PackStore(config.dbPath);
store.registerProject(config.project);
const samples=[
  ['AI 소식 주간 요약','공식 발표 5건을 출처 링크와 함께 요약하고, 중복 소식을 제외합니다.','research.search',false,'read_only',['출처와 범위 확인','자료 수집 및 중복 제거','근거 확인 후 요약 작성']],
  ['문의 양식 초안','문의 양식을 작성하고 제출 버튼을 누르기 전에 멈춥니다.','form.draft-submit',true,'draft_only',['입력 항목 확인','초안 작성','제출 전 검토']],
  ['월별 자료 통합','월별 파일을 한 표로 합치고 중복·누락 내역을 기록합니다.','file.pipeline',false,'local_file_write',['원본 파일 확인','중복·누락 검사','통합본 저장']],
  ['프로젝트 이어서 개발','저장된 체크포인트를 읽고 코딩 CLI에 다음 작업을 전달합니다.','coding.orchestrate',true,'local_file_write',['체크포인트 확인','코딩 CLI에 지시','변경 내역 검토']],
];
const ids=[];
for(const [title,goal,family,paused,effect,steps] of samples){
  const proposal=validateWorkProposal({
    title,desired_outcome:goal,
    completion_checks:[{id:'result',result:goal,evidence:'산출물과 출처·검증 기록'},
      {id:'scope',result:'허용된 범위 안에서 작업합니다.',evidence:'실행 및 승인 기록'}],
    assumptions:[{field:'데이터',value:'README 화면 설명용 예시',basis:'실제 업무·모델 실행 아님'}],
    route:{kind:'pack',pack_family:family},requested_effect:effect,
    recurrence:{kind:'once',rule:null},questions:[],
    plan:{format:1,revision:1,source:'request',source_id:null,source_digest:null,provenance:'user_request',
      steps:steps.map((goal,index)=>({
        id:'step_'+index,goal,depends_on:index?['step_'+(index-1)]:[],effect:effect==='local_file_write'?'local_write':effect,tool_hints:[],evidence_ids:[],
      }))},
  },'quick');
  const work=store.beginWork(config.project.id,'readme-'+ids.length,goal,'quick').work;
  const owner=store.claimWorkDefinition(config.project.id,work.id);
  const ready=store.finishWorkDefinition(config.project.id,work.id,owner,proposal,[],'ready');
  if(paused)store.setIntakePaused(config.project.id,work.id,ready.revision,true);
  ids.push(work.id);
}
store.close();
const server=await startControlCenter(config,{poll_ms:1000,workModel:{async call(){throw Error('README_NO_MODEL_CALLS');}}});
const version=JSON.parse(await readFile(new URL('../../package.json',import.meta.url),'utf8')).version;
const receipt={pid:process.pid,root,url:server.url,detail_url:server.url+'?work='+ids[0],sample_data:true,version};
await writeFile(join(root,'server.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt));
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{
  if(stopping)return;stopping=true;await server.close();process.exit(0);
});
await server.closed;
