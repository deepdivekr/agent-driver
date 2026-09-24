import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadHostConfig,workModelDataApproved} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {prepareLocalConnection,setWorkModelDataApproval} from '../dist/onboarding/connection.js';

function proposal(){return {title:'AI 소식 정리',desired_outcome:'이번 주 AI 소식을 표로 정리한다',completion_checks:[{id:'sources',result:'소식 5건을 찾는다',evidence:'출처 링크'}],assumptions:[],route:{kind:'pack',pack_family:'research.search'},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]};}

test('fresh onboarding config asks for AI data consent, then defines Work after the local approval without restart',async t=>{
  const root=await mkdtemp(join(tmpdir(),'driver-work-data-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const paths=await prepareLocalConnection(root),config=loadHostConfig(paths.runtimeConfig);let calls=0;
  const api=new RuntimeApi(config,{swarmModel:{async call(){calls++;return structuredClone(proposal());}}});t.after(async()=>{api.close();await api.drain();});
  assert.equal(workModelDataApproved(config),false);
  const first=await api.call('runtime_work_start',{request_id:'news',prompt:'이번 주 AI 에이전트 뉴스 5건 표로 정리해줘'});
  assert.equal(first.status,'needs_model');assert.equal(first.reason,'MODEL_DATA_APPROVAL_REQUIRED');assert.equal(calls,0);
  const work=await setWorkModelDataApproval(paths.runtimeConfig,true,new Date('2026-09-24T00:00:00Z'));
  assert.deepEqual(work,{model_data_approved:true,approved_at:'2026-09-24T00:00:00.000Z'});
  const saved=JSON.parse(await readFile(paths.runtimeConfig,'utf8'));
  assert.equal(saved.project_id,'agent-driver-local');assert.deepEqual(saved.work,work);
  assert.equal(loadHostConfig(paths.runtimeConfig).fingerprint,config.fingerprint,'consent must not invalidate bound runs');
  const defined=await api.call('runtime_work_define',{work_id:first.work_id});
  assert.equal(defined.status,'ready');assert.equal(calls,1);
  await setWorkModelDataApproval(paths.runtimeConfig,false);assert.equal(workModelDataApproved(config),false);
});
