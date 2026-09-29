import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {BASE_PACK_CATALOG} from '../dist/taskpacks/base-pack-catalog.js';
import {validateWorkProposal} from '../dist/work/contracts.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';

const proposal=family=>({title:'수신 자료 정리',desired_outcome:'파일의 결과를 확인한다',completion_checks:[{id:'result',result:'결과가 원본과 일치한다',evidence:'파일 내용과 hash'}],assumptions:[],route:{kind:'pack',pack_family:family},requested_effect:'read_only',recurrence:{kind:'once',rule:null},questions:[]});
async function setup(t,family='research.search'){
  const root=await mkdtemp(join(tmpdir(),'driver-dispatch-')),host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',title:'observed value'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'dispatch',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',packs:{sources:[{id:'records',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const api=new RuntimeApi(loadHostConfig(host),{swarmModel:{async call(){return proposal(family);}}});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  return {api,root};
}
const recipe=prompt=>({version:1,family:'research.search',request:prompt,sources:[{id:'records',parameters:{}}],filters:[],deduplicate_by:['id'],query:'',search_fields:['title'],sort:null,limit:10});

test('runtime contract new Work accepts exactly nine named families and rejects an unselected Pack',()=>{
  assert.equal(BASE_PACK_CATALOG.length,9);
  for(const family of BASE_PACK_CATALOG)assert.equal(validateWorkProposal(proposal(family.id),'quick').route.pack_family,family.id);
  assert.throws(()=>validateWorkProposal(proposal(null),'quick'),/WORK_ROUTE_FAMILY_REQUIRED/);
  assert.throws(()=>validateWorkProposal(proposal('desktop.cleanup'),'quick'));
  assert.equal(validateWorkProposal({...proposal(null),route:{kind:'unknown',pack_family:null}},'quick').route.kind,'unknown');
});

test('runtime fixture Work -> Pack design -> file executor -> same Work receipt stays bound and deduplicated',async t=>{
  const x=await setup(t),prompt='등록된 자료를 읽고 결과를 확인해줘',request_id='x'.repeat(128);
  const before=await readFile(join(x.root,'source.json'));
  const work=await x.api.call('runtime_work_start',{request_id,prompt});
  assert.equal(work.dispatch_owner,'agent-office');assert.equal(work.status,'ready');assert.equal(work.next_action,'runtime_work_execute');
  assert.equal(work.execution_binding.work_id,work.work_id);assert.ok(work.execution_binding.request_id.length<=80);
  const design=await x.api.call('runtime_pack_plan',{prompt,work_id:work.work_id});
  assert.equal(design.requested_family,'research.search');assert.equal(design.dispatch_allowed,false);
  assert.deepEqual(design.execution_binding,work.execution_binding);assert.deepEqual(design.bound_runs,[]);
  assert.equal(design.connections.sources[0].kind,'file');
  const result=await x.api.call('runtime_pack_run',{...design.execution_binding,recipe:recipe(prompt)});
  assert.equal(result.status,'succeeded');assert.equal(result.result.rows[0].title,'observed value');
  const repeat=await x.api.call('runtime_pack_run',{...design.execution_binding,recipe:recipe(prompt)});
  assert.equal(repeat.run_id,result.run_id);assert.equal(repeat.deduplicated,true);
  const resumed=await x.api.call('runtime_work_status',{work_id:work.work_id});
  assert.equal(resumed.runs.length,1);assert.equal(resumed.runs[0].run_id,result.run_id);assert.equal(resumed.completion_verified,false);
  const cached=await x.api.call('runtime_pack_plan',{prompt,work_id:work.work_id});
  assert.equal(cached.cache_hit,true);assert.equal(cached.next_action,'inspect_bound_run_before_new_execution');
  assert.equal(cached.bound_runs[0].run_id,result.run_id);
  assert.deepEqual(await readFile(join(x.root,'source.json')),before);
});

test('runtime contract cached recipe cannot change the selected family or bypass Work pause',async t=>{
  const x=await setup(t,'portal.collect'),prompt='등록된 자료를 수집해줘';
  await x.api.call('runtime_pack_run',{request_id:'standalone',recipe:recipe(prompt)});
  const work=await x.api.call('runtime_work_start',{request_id:'collect',prompt});
  const planned=await x.api.call('runtime_pack_plan',{prompt,work_id:work.work_id});
  assert.equal(planned.cache_hit,false);assert.equal(planned.recipe,null);assert.equal(planned.requested_family,'portal.collect');
  await x.api.call('runtime_work_pause',{work_id:work.work_id,revision:work.revision,paused:true});
  await assert.rejects(x.api.call('runtime_pack_plan',{prompt,work_id:work.work_id}),/WORK_PAUSED/);
});

test('runtime contract coding Work uses the coding executor, never an eight-family recipe',async t=>{
  const x=await setup(t,'coding.orchestrate');
  const work=await x.api.call('runtime_work_start',{request_id:'coding',prompt:'등록된 프로젝트를 검토해줘'});
  assert.equal(work.next_action,'runtime_work_execute');
  await assert.rejects(x.api.call('runtime_pack_plan',{prompt:work.prompt,work_id:work.work_id}),/WORK_PACK_ROUTE_REQUIRED/);
  assert.equal((await x.api.call('runtime_work_status',{work_id:work.work_id})).runs.length,0);
});
