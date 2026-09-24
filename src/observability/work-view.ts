import {type HostConfig} from '../interface/config.js';
import {type IntakeWork,type PackStore} from '../packs/store.js';
import {type SwarmRunSnapshot} from '../swarm/contracts.js';
import {redact} from '../terminal/contracts.js';
import {type WorkProposal} from '../work/contracts.js';
import {authSites} from '../swarm/browser-auth.js';

const clean=(value:string,max=800)=>{const text=redact(value).replace(/https?:\/\/[^\s<>"']+/giu,raw=>{try{const url=new URL(raw);return url.origin+url.pathname;}catch{return '[URL]';}});return text.length<=max?text:text.slice(0,max-1)+'…';};
const verified=(worker:SwarmRunSnapshot['workers'][string])=>worker.status==='succeeded'&&worker.result?.readback?.verified===true&&worker.quality?.accepted===true;
function pendingDownstream(snapshot:SwarmRunSnapshot,id:string){
  const affected=new Set([id]);let changed=true;
  while(changed){changed=false;for(const step of snapshot.plan.workers)if(!affected.has(step.id)&&step.depends_on.some(parent=>affected.has(parent))){affected.add(step.id);changed=true;}}
  affected.delete(id);return [...affected].every(next=>snapshot.workers[next]?.status==='pending');
}
type OfficeRow=ReturnType<PackStore['officeWorkSummaries']>[number];

function boardRow(row:OfficeRow){
  const intake=row.intake_status===null?null:{status:row.intake_status,revision:row.intake_revision??0,mode:row.mode,paused:Boolean(row.paused)};
  const run=row.source_id?{kind:row.source_kind,id:row.source_id,status:row.source_kind==='pack'?row.pack_status:row.source_kind==='coding'?row.coding_status:row.swarm_status}:null;
  const state=intake?.paused?'paused':run?.status??intake?.status??'unobserved';
  return {id:row.id,title:clean(row.title,64),status:state,work_status:intake?.status??null,run,run_revision:row.run_revision,updated_at:row.display_updated_at,has_contract:Boolean(intake),paused:Boolean(intake?.paused)};
}

export function readWorkBoard(store:PackStore,config:HostConfig,limit=60){
  const project=config.project.id;store.expireCodingStages(project);
  const works=store.officeWorkSummaries(project,limit).map(boardRow);
  const auth_attention_count=authSites(store,config).filter(site=>site.handoff||site.state!=='ready'&&site.state!=='retry_requested').length;
  return {format:1,project_id:project,generated_at:new Date().toISOString(),works,auth_attention_count,read_only:false,coverage:{runtime_only:true,unobserved_work:'not_shown'}};
}

export function readWorkDetail(store:PackStore,config:HostConfig,id:string){
  const project=config.project.id;store.expireCodingStages(project);
  const record=store.officeWorkById(project,id);
  const intake: IntakeWork|null=store.intakeWorkOptional(project,id);
  const spec=intake?.spec as WorkProposal|null??null,runs=store.officeRuns(project,id).slice(0,20);
  const latest=runs[0]??null;
  let stages:Array<{id:string;label:string;objective:string;status:string;verified:boolean;executor:string|null;can_edit:boolean;attempts:number;owner:string|null}>=[];
  let control:{paused:boolean;revision:number;can_pause:boolean}|null=null;
  let events:Array<{id:string;kind:string;detail:string;worker_id:string|null;created_at:string}>=[];
  let runStatus:string|null=null,pack:string|null=spec?.route.pack_family??null,swarm=false,coding=false;
  if(latest?.source_kind==='swarm'){
    const snapshot=store.swarmRun(project,latest.source_id).snapshot as SwarmRunSnapshot;
    const office=store.officeControl(project,latest.source_id),activity=store.swarmActivities(project,0,120,latest.source_id);
    const actors=new Map<string,string>();
    for(const item of activity){if(item.worker_id&&item.kind==='worker.activity'&&item.body&&typeof item.body==='object'&&'actor_id' in item.body&&typeof item.body.actor_id==='string')actors.set(item.worker_id,clean(item.body.actor_id,80));}
    runStatus=snapshot.status;swarm=true;control={paused:office.paused,revision:office.revision,can_pause:['running','needs_human'].includes(snapshot.status)};
    stages=snapshot.plan.workers.map(def=>{const worker=snapshot.workers[def.id]!;return {id:def.id,label:clean(def.stage,80),objective:clean(def.objective,500),status:worker.status,verified:verified(worker),executor:def.executor,can_edit:def.effect==='read_only'&&worker.status==='pending'&&pendingDownstream(snapshot,def.id),attempts:worker.attempts,owner:worker.status==='leased'?actors.get(def.id)??null:null};});
    events=store.officeEvents(project,latest.source_id).slice(-20).map(item=>({id:String(item.id),kind:item.kind,detail:clean(item.detail,240),worker_id:item.worker_id,created_at:item.created_at}));
  }else if(latest?.source_kind==='pack'){
    const run=store.packRun(project,latest.source_id);runStatus=run.status;pack=run.recipe.family;
    stages=[{id:'pack',label:'Task Pack',objective:clean(run.recipe.request,500),status:run.status,verified:false,executor:run.recipe.family,can_edit:false,attempts:store.packExecution(project,run.id)?.attempts??0,owner:null}];
  }else if(latest?.source_kind==='coding'){
    const run=store.codingRun(project,latest.source_id),rows=store.codingStages(project,run.id);runStatus=run.status;pack='coding.orchestrate';coding=true;
    control={paused:run.paused,revision:run.revision,can_pause:['ready','running'].includes(run.status)};
    stages=run.plan.stages.map((def,index)=>{const stage=rows[index]!;return {id:def.id,label:clean(def.operation,80),objective:clean(def.instruction,500),status:stage.status,verified:stage.status==='succeeded',executor:def.actor,can_edit:stage.status==='pending'&&['ready','running'].includes(run.status),attempts:stage.attempts,owner:stage.status==='running'?def.actor:null};});
    events=store.officeEvents(project,run.id).slice(-20).map(item=>({id:String(item.id),kind:item.kind,detail:clean(item.detail,240),worker_id:item.worker_id,created_at:item.created_at}));
  }else if(spec?.completion_checks){
    stages=spec.completion_checks.map(check=>({id:check.id,label:'완료 확인',objective:clean(check.result,500),status:'pending',verified:false,executor:null,can_edit:false,attempts:0,owner:null}));
  }
  const verifiedSteps=stages.filter(stage=>stage.verified).length;
  const activePack=latest?.source_kind==='pack'&&runStatus!==null&&['running','retryable_failure','waiting_auth','waiting_approval','approved','reconciliation_required'].includes(runStatus);
  const activeSwarm=latest?.source_kind==='swarm'&&runStatus!==null&&['running','needs_human'].includes(runStatus);
  const activeCoding=latest?.source_kind==='coding'&&runStatus!==null&&['ready','running','reconciliation_required'].includes(runStatus);
  const workControl=intake?{paused:intake.paused,revision:intake.revision,can_pause:!activePack&&!activeSwarm&&!activeCoding&&['ready','running','needs_model'].includes(intake.status),scope:'future_dispatch' as const}:null;
  const progress=(swarm||coding)&&stages.length?Math.floor(verifiedSteps*100/stages.length):null;
  return {format:1,id,title:clean(record.title,160),goal:clean(record.goal,2000),prompt:intake?clean(intake.prompt,8000):null,work_status:intake?.status??null,mode:intake?.mode??null,revision:intake?.revision??null,paused:Boolean(intake?.paused||control?.paused),spec:intake?.spec??null,questions:intake?.questions??[],answers:intake?.answers??{},route:spec?.route??null,pack,run_id:latest?.source_id??null,run_status:runStatus,runs,client_handoffs:store.clientHandoffs(project,id),swarm,coding,agent_count:stages.filter(stage=>stage.status==='leased'||stage.status==='running').length,verified_steps:verifiedSteps,total_steps:stages.length,progress_percent:progress,progress_basis:swarm?'독립 확인과 품질 승인된 단계만 계산':coding?'단계 실행·검증 완료 기준이며 업무 완료 조건은 별도 확인':'이 실행 경로는 단계별 독립 검증 진행률을 제공하지 않음',stages,control,work_control:workControl,events,updated_at:record.updated_at,completion_verified:false,completion_note:'Run 성공은 Work의 모든 완료조건 충족을 자동으로 뜻하지 않습니다.'};
}
