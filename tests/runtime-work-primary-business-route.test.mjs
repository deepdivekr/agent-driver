import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {WORK_DEFINITION_INSTRUCTIONS,WORK_INTAKE_REQUIREMENTS_INSTRUCTIONS,WORK_REPLANNING_INSTRUCTIONS} from '../dist/work/runtime.js';

test('runtime contract primary business route is independent of output serialization and permits a real goal change',()=>{
  for(const guidance of [WORK_DEFINITION_INSTRUCTIONS,WORK_REPLANNING_INSTRUCTIONS]){
    assert.match(guidance,/primary Pack family by the user-required business operation on its input/u);
    assert.match(guidance,/authorized secondary Pack or Office result tool/u);
    assert.match(guidance,/when transforming or organizing files is itself the primary user goal, file\.pipeline remains appropriate/u);
  }
  assert.match(WORK_INTAKE_REQUIREMENTS_INSTRUCTIONS,/requested JSON, CSV, TXT or other artifact does not by itself change the Work's Pack family/u);
  assert.match(WORK_REPLANNING_INSTRUCTIONS,/original prompt, its explicit completion_condition, previous_spec and latest user_directions/u);
  assert.match(WORK_REPLANNING_INSTRUCTIONS,/only changes output serialization or result delivery/u);
  assert.match(WORK_REPLANNING_INSTRUCTIONS,/must not discard the original business operation or its required Pack capability/u);
  assert.match(WORK_REPLANNING_INSTRUCTIONS,/An explicit user change to the business goal, or an earlier model route shown inconsistent/u);
  assert.match(WORK_REPLANNING_INSTRUCTIONS,/do not freeze a mistaken route/u);
});

test('runtime fixture definition passes full four-row triage and monitoring conditions alongside secondary artifact formats',async t=>{
  const root=await mkdtemp(join(tmpdir(),'office-primary-route-')),host=join(root,'host.json');
  await writeFile(join(root,'source.json'),JSON.stringify([{id:'one',kind:'fixture row'}]));
  await writeFile(host,JSON.stringify({schema_version:1,project_id:'primary-route-fixture',caller_ref:'fixture',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:true},packs:{sources:[{id:'input_rows',kind:'file',path:'source.json',format:'json'}],targets:[],models:'off'},swarm:{enabled:true,model_data_approved:true}}));
  const cases=[
    {request_id:'triage-json',prompt:'Classify all four supplied inbox rows and prepare a JSON result.',completion_condition:'Use inbox.triage for all four rows, save and read back the JSON artifact.',family:'inbox.triage',check:'All four inbox rows are triaged and present in the saved JSON.'},
    {request_id:'watch-csv',prompt:'Check the three monitored event conditions once and prepare a CSV result.',completion_condition:'Use monitor.watch for all three conditions, save and read back the CSV artifact.',family:'monitor.watch',check:'All three watch conditions are represented in the saved CSV.'},
    {request_id:'transform-csv',prompt:'Transform the registered input file rows into a CSV result.',completion_condition:'Use the registered source and save and read back every transformed CSV row.',family:'file.pipeline',check:'Every input row is transformed and read back from CSV.'},
  ];
  let index=0;
  const model={calls:[],async call(_purpose,instructions,input){
    const expected=cases[index++];assert.ok(expected,'Unexpected extra model call');
    assert.match(instructions,/primary Pack family by the user-required business operation on its input/u);
    assert.match(instructions,/Output serialization and delivery are separate from the primary business operation/u);
    assert.equal(input.prompt,expected.prompt);assert.equal(input.user_intake.completion_condition,expected.completion_condition);
    return {title:'Scoped business result',desired_outcome:expected.prompt,completion_checks:[{id:'business_result',result:expected.check,evidence:'Actual source and saved result receipts'}],assumptions:[],route:{kind:'pack',pack_family:expected.family},requested_effect:'local_file_write',recurrence:{kind:'once',rule:null},questions:[]};
  }};
  const api=new RuntimeApi(loadHostConfig(host),{swarmModel:model});
  t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
  for(const item of cases){
    const work=await api.work.start({request_id:item.request_id,prompt:item.prompt,completion_condition:item.completion_condition});
    assert.equal(work.status,'ready');assert.deepEqual(work.spec.route,{kind:'pack',pack_family:item.family});
    assert.equal(work.spec.completion_checks[0].result,item.check);assert.equal(work.completion_verified,false);assert.deepEqual(work.runs,[]);
  }
  assert.equal(index,cases.length);
});
