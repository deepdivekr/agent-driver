import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {scanProject} from '../dist/work/project-scan.js';
import {validatedImportJevRecommendations} from '../dist/work/jev-import-recommendation.js';
import {projectJevRecommendations,PROJECT_IMPORT_ANALYSIS_INSTRUCTIONS} from '../dist/work/import-runtime.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';

const workflow='export async function reviewIncoming(client, messages) {\n for (const message of messages) {\n  const answer = await client.responses.create({model: "configured", input: "Return yes or no: urgent message? " + message});\n  results.push(answer);\n }\n}\n';
async function fixture(t,source=workflow){
 const root=await mkdtemp(join(tmpdir(),'single-jev-')),project=join(root,'project');await mkdir(project);
 await writeFile(join(project,'agent.ts'),source);
 t.after(()=>rm(root,{recursive:true,force:true}));
 return {root,project,scan:await scanProject(project)};
}
function proposal(scan,selected=scan.evidence.find(e=>e.signal==='model_call')){
 return {step_id:'review',judgment:'메시지가 긴급한지 판단',answer_shape:'yes_no',why_fit:'변하는 메시지의 뜻을 읽어 짧게 예 또는 아니오를 판단합니다.',evidence_ids:[selected.id],
  benefit_kind:'replace_llm_judgment',baseline:'각 메시지에 기존 LLM을 호출하여 긴급 여부를 판단합니다.',expected_gain:'반복되는 짧은 판정을 분리하여 긴 LLM 생성을 줄일 여지가 있습니다.',why_selected:'관측된 호출 중 짧은 답으로 결과가 결정되는 반복 판단을 선정했습니다.',repetition_basis:'messages 반복문 안에서 메시지마다 호출합니다.',state_inputs:[{name:'message 원문',evidence_id:selected.id}],fallback:'입력 부족이나 오류 또는 불확실성이 있으면 기존 LLM 판단을 유지합니다.',compared_evidence_ids:scan.evidence.filter(e=>e.signal==='model_call').map(e=>e.id)};
}
const steps=scan=>[{id:'review',evidence_ids:scan.evidence.map(e=>e.id)}];

test('runtime fixture import discovers bounded model decisions without semantic function keywords',async t=>{
 const {scan}=await fixture(t);
 const e=scan.evidence.find(e=>e.signal==='model_call');
 assert.ok(e.context.text.includes('for (const message of messages)'));
 assert.ok(e.context.text.includes('Return yes or no'));
 assert.ok(!scan.evidence.some(e=>e.signal==='semantic_judgment'));
 assert.equal(validatedImportJevRecommendations([proposal(scan)],scan,steps(scan)).length,1);
});

test('runtime fixture import never promotes a numeric classify name without model decision evidence',async t=>{
 const {scan}=await fixture(t,'export function classifyMessage(count) { return count > 10 ? "high" : "low"; }');
 const e=scan.evidence.find(e=>e.signal==='semantic_judgment');assert.ok(e);
 assert.deepEqual(validatedImportJevRecommendations([proposal(scan,e)],scan,steps(scan)),[]);
});

test('runtime fixture import retains multiple model sites and requires comparison before one selection',async t=>{
 const {scan}=await fixture(t,workflow+'\nexport async function compose(client, summary) {\n return client.responses.create({model:"configured",input:"Write a report: " + summary});\n}\n');
 const calls=scan.evidence.filter(e=>e.signal==='model_call');assert.equal(calls.length,2);
 assert.notEqual(calls[0].line,calls[1].line);
 const winner=proposal(scan,calls[1]);
 assert.equal(validatedImportJevRecommendations([winner],scan,steps(scan))[0].evidence_ids[0],calls[1].id);
 assert.deepEqual(validatedImportJevRecommendations([{...winner,compared_evidence_ids:[calls[1].id]}],scan,steps(scan)),[]);
 assert.deepEqual(validatedImportJevRecommendations([proposal(scan),winner],scan,steps(scan)),[]);
 assert.deepEqual(validatedImportJevRecommendations([],scan,steps(scan)),[]);
});

test('runtime fixture import requires complete savings, state and fallback rationale, not scores',async t=>{
 const {scan}=await fixture(t),p=proposal(scan);
 for(const field of ['baseline','expected_gain','why_selected','repetition_basis','state_inputs','fallback']){
  const incomplete={...p};delete incomplete[field];assert.deepEqual(validatedImportJevRecommendations([incomplete],scan,steps(scan)),[],field);
 }
 assert.deepEqual(validatedImportJevRecommendations([{...p,state_inputs:[{name:'invented',evidence_id:'missing'}]}],scan,steps(scan)),[]);
 assert.match(PROJECT_IMPORT_ANALYSIS_INSTRUCTIONS,/at most ONE/u);
 assert.match(PROJECT_IMPORT_ANALYSIS_INSTRUCTIONS,/not names/u);
 assert.match(PROJECT_IMPORT_ANALYSIS_INSTRUCTIONS,/Exact arithmetic/u);
 assert.match(PROJECT_IMPORT_ANALYSIS_INSTRUCTIONS,/Never give the user a shortlist/u);
});

test('runtime fixture import redacts code secrets and reports scan/context coverage limits',async t=>{
 const secret=['sk','proj','abcdefghijklmnop123456789'].join('-');
 const credentialLines='\n const api_key="private-value-do-not-send";\n const password = "opaque-password";\n const key="'+secret+'";\n';
 const {project,scan}=await fixture(t,workflow.replace('{\n','{'+credentialLines));
 const serialized=JSON.stringify(scan);
 for(const value of ['private-value-do-not-send','opaque-password',secret])assert.ok(!serialized.includes(value));
 assert.ok(serialized.includes('REDACTED'));
 await writeFile(join(project,'large.ts'),'// padding\n'.repeat(6500)+workflow);
 const limited=await scanProject(project);assert.equal(limited.limits.truncated,true);assert.ok(limited.unknowns.some(x=>x.includes('제한')));
 await writeFile(join(project,'large.ts'),workflow.repeat(70));
 const contexts=await scanProject(project);assert.ok(contexts.limits.context_chars<=32_000);assert.equal(contexts.limits.context_truncated,true);
});

test('runtime fixture legacy multi-point recommendations are preserved but not arbitrarily ranked on read',async t=>{
 const {scan}=await fixture(t),p=proposal(scan),body={scan,analysis_status:'complete',analysis:{steps:steps(scan),jev_recommendations:[p,p]}};
 assert.deepEqual(projectJevRecommendations(body),[]);assert.equal(body.analysis.jev_recommendations.length,2);
 body.analysis.jev_recommendations=[p];
 const selected=projectJevRecommendations(body);assert.equal(selected.length,1);assert.equal(selected[0].benefit_status,'unmeasured');assert.equal(selected[0].enabled,false);
});

test('runtime contract invalid shortlist leaves the main import usable and never calls Jev',async t=>{
 const {root,project}=await fixture(t);
 const configPath=join(root,'host.json');await writeFile(configPath,JSON.stringify({schema_version:1,project_id:'single-jev',caller_ref:'local',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',coding:{projects:[{id:'test',root:project,allow_write:false,allow_commit:false,verify:[]}],model_data_approved:true}}));
 let mode='multiple',calls=0;
 const model={async call(_purpose,instructions,input,schema){
  calls++;assert.ok(input.evidence.some(e=>e.context?.text.includes('Return yes or no')));assert.ok(input.scan_limits);
  assert.equal(schema.properties.jev_recommendations.maxItems,1);assert.match(instructions,/at most ONE/u);
  const p=proposal(input),e=p.evidence_ids[0];
  return {title:'검토',goal:'메시지 검토',prompt:'메시지를 검토해 줘',steps:[{id:'review',goal:'메시지 판단',depends_on:[],evidence_ids:[e]}],completion:[{id:'done',result:'결과 기록',proof:'결과 재조회',evidence_ids:[e]}],unknowns:[],jev_recommendations:mode==='multiple'?[p,p]:mode==='skip'?[]:[p]};
 }};
 const api=new RuntimeApi(loadHostConfig(configPath),{swarmModel:model});t.after(()=>api.close());
 api.packs.providers.jev={async systemOne(){throw Error('PAID_JEV_MUST_NOT_RUN');}};
 for(const current of ['multiple','skip','one']){
  mode=current;const result=await api.imports.scan({path:project});
  assert.equal(result.preview.analysis_status,'complete');assert.equal(result.preview.analysis.steps.length,1);
  assert.equal(result.preview.jev_recommendations.length,current==='one'?1:0);
  assert.equal(result.execution,false);assert.equal(result.preview.jev.enabled,false);
  if(current==='one'){
   const accepted=await api.imports.accept({import_id:result.import_id,goal:'메시지 검토',completion:'결과 확인'});
   assert.equal(accepted.jev.enabled,false);
  }
 }
 assert.equal(calls,3);
});
