import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {PackStore} from '../dist/packs/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WorkRuntime} from '../dist/work/runtime.js';
import {WorkSupervisor} from '../dist/work/supervisor.js';
import {readWorkDetail} from '../dist/observability/work-view.js';
import {workActivity} from '../dist/work/activity.js';
import {stageBinding} from '../dist/work/stages.js';

test('runtime fixture Work detail groups current-run stage evidence and keeps execution claims separate from verification',async t=>{
  const root=await mkdtemp(join(tmpdir(),'work-business-view-')),host=join(root,'host.json');
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'business-view',caller_ref:'owner',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const config=loadHostConfig(host),store=new PackStore(config.dbPath);store.registerProject(config.project);
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const model={async call(){return {title:'Public source report',desired_outcome:'Save a cited summary.',completion_checks:[{id:'summary',result:'Cited summary is saved',evidence:'Observed source and result file'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[],plan:{steps:[{id:'collect',goal:'Collect a primary source',observable_outcome:'A source URL and title are observed.',depends_on:[],effect:'read_only',tool_hints:[]},{id:'write',goal:'Write a cited summary',observable_outcome:'A cited summary file is saved.',depends_on:['collect'],effect:'draft_only',tool_hints:[]}]}};}};
  const work=await new WorkRuntime(store,config,model).start({request_id:'view-test',prompt:'Collect one public source and write a cited summary.'});
  const supervisor=new WorkSupervisor(store,config,model,{auto_start:false});t.after(()=>supervisor.close());
  const spec=store.intakeWork(config.project.id,work.work_id).spec,steps=spec.plan.steps,runId=randomUUID(),at=new Date().toISOString(),first={stage_id:'collect',binding:stageBinding(steps[0]),evidence_ids:['source-1'],reported_at:at};
  const checkpoint={format:1,work_id:work.work_id,run_id:runId,binding:'a'.repeat(64),turn:1,pending:null,observations:[],stage_reports:[first],summary:'Source collected.'};
  store.hermesState.prepare('INSERT INTO office_supervisor(run_id,project_id,work_id,work_revision,state,checkpoint,result,config_hash,model_revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(runId,config.project.id,work.work_id,work.revision,'awaiting_review',JSON.stringify(checkpoint),JSON.stringify({completion_verified:false}),config.fingerprint,0,at,at);
  workActivity(store,config.project.id,work.work_id,'source.started','Attempted a site.',{run_id:runId,stage_id:'collect',stage_binding:first.binding,target_url:'https://example.org/not-observed'});
  workActivity(store,config.project.id,work.work_id,'source.observed','Observed a source.',{run_id:runId,stage_id:'collect',stage_binding:first.binding,source:{url:'https://example.org/observed',title:'Observed source',observed_at:at}});
  workActivity(store,config.project.id,work.work_id,'source.observed','Stale source.',{run_id:randomUUID(),stage_id:'collect',stage_binding:first.binding,source:{url:'https://example.org/stale',title:'Stale source',observed_at:at}});
  let detail=readWorkDetail(store,config,work.work_id);
  assert.deepEqual(detail.stages.map(stage=>stage.id),['collect','write']);assert.equal(detail.executed_steps,1);assert.equal(detail.verified_steps,0);assert.equal(detail.progress_percent,50);assert.equal(detail.stages[0].status,'execution_completed');assert.equal(detail.stages[0].verified,false);
  assert.deepEqual(detail.stages[0].activities.map(activity=>activity.kind),['source.started','source.observed']);assert.deepEqual(detail.stages[0].sources.map(source=>source.url),['https://example.org/observed']);assert.equal(detail.stages[1].status,'pending');
  // Before a stage report, old source evidence remains visible while only the
  // latest bound activity may be called active in a single-client run.
  store.hermesState.prepare("UPDATE office_supervisor SET state='running',owner='test-owner',lease_until_ms=?,checkpoint=? WHERE run_id=?").run(Date.now()+60_000,JSON.stringify({...checkpoint,stage_reports:[]}),runId);
  workActivity(store,config.project.id,work.work_id,'tool.started','Further source processing.',{run_id:runId,stage_id:'collect',stage_binding:first.binding,tool_name:'office_browser_read',status:'running'});
  workActivity(store,config.project.id,work.work_id,'tool.started','Writing result.',{run_id:runId,stage_id:'write',stage_binding:stageBinding(steps[1]),tool_name:'office_result_draft',status:'running'});
  detail=readWorkDetail(store,config,work.work_id);assert.equal(detail.stages[0].status,'result_observed');assert.equal(detail.stages[1].status,'running');
  workActivity(store,config.project.id,work.work_id,'tool.result','Login required.',{run_id:runId,stage_id:'write',stage_binding:stageBinding(steps[1]),tool_name:'office_result_draft',status:'waiting_auth',reason:'WORK_SEARCH_PROVIDER_CHALLENGE'});
  store.hermesState.prepare("UPDATE office_supervisor SET state='waiting_auth',owner=NULL,lease_until_ms=0,reason=? WHERE run_id=?").run('WORK_SEARCH_PROVIDER_CHALLENGE',runId);
  detail=readWorkDetail(store,config,work.work_id);assert.equal(detail.stages[0].status,'result_observed');assert.equal(detail.stages[1].status,'waiting_auth');assert.equal(detail.stages[1].block_reason,'WORK_SEARCH_PROVIDER_CHALLENGE');
  const second={stage_id:'write',binding:stageBinding(steps[1]),evidence_ids:['draft-1'],reported_at:at};
  store.hermesState.prepare("UPDATE office_supervisor SET state='succeeded',checkpoint=?,result=? WHERE run_id=?").run(JSON.stringify({...checkpoint,stage_reports:[first,second]}),JSON.stringify({completion_verified:true}),runId);
  detail=readWorkDetail(store,config,work.work_id);assert.equal(detail.executed_steps,2);assert.equal(detail.verified_steps,2);assert.equal(detail.progress_percent,100);assert.equal(detail.stages.every(stage=>stage.verified),true);
});
