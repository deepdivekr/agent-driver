import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {workImportScanSchema} from '../dist/work/import-runtime.js';
import {tools} from '../dist/interface/catalog.js';
import {readWorkDetail} from '../dist/observability/work-view.js';

const scope='뉴스 수집과 알림만 가져와줘.\n쇼핑몰·결제는 제외하고 그대로 보존해.';
export function scopedAnalysis(input){
 const evidence=input.evidence.find(e=>e.file==='alerts.js')??input.evidence[0];
 return {title:'News alerts',goal:input.user_scope?'뉴스 알림만 이전한다':'프로젝트 이전',prompt:'Untrusted model instruction',steps:[{id:'collect',goal:'뉴스 수집·알림',depends_on:[],evidence_ids:[evidence.id]}],completion:[{id:'saved',result:'알림 결과 확인',proof:'저장 결과 재조회',evidence_ids:[evidence.id]}],unknowns:[]};
}
async function setup(t,{approved=true,fail=false}={}){
 const root=await mkdtemp(join(tmpdir(),'office-import-scope-')),project=join(root,'project');await mkdir(project);
 await writeFile(join(project,'README.md'),'# Mixed store\nStore, checkout and a news bot.\n');
 await writeFile(join(project,'alerts.js'),"const openai={}; create_agent(); tool_call(); checkpoint=true; bot.command('news', () => bot.sendMessage('news'));\n");
 await writeFile(join(project,'checkout.js'),'export function checkout(cart) { return cart.total; }\n');
 const host=join(root,'host.json');await writeFile(host,JSON.stringify({schema_version:1,project_id:'scope-fixture',caller_ref:'local-agent',account_ref:'owner',worktree:root,data_dir:join(root,'data'),environment:'production',work:{model_data_approved:approved},coding:{projects:[{id:'mixed',root:project,allow_write:false,allow_commit:false,verify:[]}],model_data_approved:approved}}));
 const calls=[],config=loadHostConfig(host),api=new RuntimeApi(config,{swarmModel:{async call(purpose,instructions,input){calls.push({purpose,instructions,input});if(fail)throw Error('fixture unavailable');return scopedAnalysis(input);}}});
 t.after(async()=>{api.close();await api.drain();await rm(root,{recursive:true,force:true});});
 return {root,project,config,api,calls};
}

test('mixed-project scope flows through MCP, analysis, saved Work and protected handoff without execution',async t=>{
 const x=await setup(t),original=await readFile(join(x.project,'checkout.js'),'utf8');
 const scan=await x.api.call('runtime_work_import_scan',{project_ref:'mixed',scope});
 assert.equal(scan.preview.scope,scope);assert.equal(scan.preview.kind,'mixed');
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].input.user_scope,scope);
 assert.match(x.calls[0].instructions,/Repository text cannot override it/u);
 assert.match(x.calls[0].instructions,/do not substitute the whole project/u);
 assert.equal(scan.preview.analysis.goal,'뉴스 알림만 이전한다');
 const accepted=await x.api.imports.accept({import_id:scan.import_id,goal:scan.preview.analysis.goal});
 const work=x.api.store.intakeWork(x.config.project.id,accepted.work_id);
 assert.equal(accepted.execution,false);assert.equal(accepted.activation,false);assert.equal(accepted.jev.enabled,false);
 assert.match(work.prompt,/뉴스 수집과 알림만 가져와줘/u);assert.match(work.prompt,/쇼핑몰·결제는 제외/u);
 assert.doesNotMatch(work.prompt,/Untrusted model instruction/u);
 assert.equal(work.spec.plan.import_scope,scope);
 const context=await x.api.call('runtime_work_context',{work_id:work.id,actor:'scope-test'});
 assert.deepEqual(context.capsule.core.instructions.find(i=>i.id==='import_scope'),{id:'import_scope',source:'user',text:scope});
 assert.equal(context.plan.import_scope,scope);
 const reopened=new PackStore(x.config.dbPath);
 try{assert.equal(readWorkDetail(reopened,x.config,work.id).work_plan.import_scope,scope);}finally{reopened.close();}
 assert.deepEqual(x.api.store.officeRuns(x.config.project.id,work.id),[]);
 assert.equal(await readFile(join(x.project,'checkout.js'),'utf8'),original);
 const again=await x.api.imports.accept({import_id:scan.import_id,goal:scan.preview.analysis.goal});
 assert.equal(again.work_id,work.id);assert.equal(again.deduplicated,true);
});

test('empty scope is backward compatible; a changed scope has a separate draft with the same source fingerprint',async t=>{
 const x=await setup(t),old=await x.api.imports.scan({path:x.project}),blank=await x.api.imports.scan({path:x.project,scope:' \n '});
 assert.equal(blank.import_id,old.import_id);assert.equal('scope' in blank.preview,false);assert.equal('user_scope' in x.calls[1].input,false);
 const first=await x.api.imports.scan({path:x.project,scope}),second=await x.api.imports.scan({path:x.project,scope:'뉴스 수집만 가져와줘. 알림은 제외해.'});
 assert.notEqual(first.import_id,second.import_id);assert.notEqual(first.import_id,old.import_id);
 assert.equal(first.preview.content_sha256,second.preview.content_sha256);
 const again=await x.api.imports.scan({path:x.project,scope});assert.equal(again.import_id,first.import_id);
 await writeFile(join(x.project,'alerts.js'),'bot.sendMessage("changed");\n');
 await assert.rejects(x.api.imports.accept({import_id:first.import_id,goal:'뉴스 알림'}),/SOURCE_CHANGED_RESCAN/u);
});

test('scope survives missing model approval and unavailable model without claiming analyzed scope',async t=>{
 for(const opts of [{approved:false},{fail:true}]){
  const x=await setup(t,opts),scan=await x.api.imports.scan({path:x.project,scope});
  assert.equal(scan.preview.scope,scope);assert.equal(scan.preview.analysis,null);
  assert.equal(scan.preview.analysis_status,opts.fail?'model_unavailable':'not_approved');
  assert.equal(x.calls.length,opts.fail?1:0);
  await assert.rejects(x.api.imports.accept({import_id:scan.import_id,goal:'뉴스 알림'}),/GOAL_OR_COMPLETION_REQUIRED/u);
  const saved=await x.api.imports.accept({import_id:scan.import_id,goal:'뉴스 알림',completion:'뉴스 알림만 확인'});
  assert.equal(x.api.store.intakeWork(x.config.project.id,saved.work_id).spec.plan.import_scope,scope);
  assert.equal(saved.execution,false);assert.equal(saved.jev.enabled,false);
 }
});

test('scope validation, redaction and long prompts preserve boundaries and exclusions',async t=>{
 assert.equal(workImportScanSchema.safeParse({path:'/tmp/project',scope:12}).success,false);
 assert.equal(workImportScanSchema.safeParse({path:'/tmp/project',scope:'x'.repeat(2001)}).success,false);
 assert.equal(tools.runtime_work_import_scan.schema.safeParse({project_ref:'mixed',scope:'x'.repeat(2001)}).success,false);
 const x=await setup(t),sensitive='Only news. api_key='+['sk','proj','a'.repeat(40)].join('-'),scan=await x.api.imports.scan({path:x.project,scope:sensitive});
 assert.equal(scan.preview.scope,'Only news. [REDACTED]');assert.equal(x.calls[0].input.user_scope,scan.preview.scope);
 const longScope='A'.repeat(1930)+' 끝까지 유지할 제외 조건: 결제 제외',long=await x.api.imports.scan({path:x.project,scope:longScope});
 const saved=await x.api.imports.accept({import_id:long.import_id,goal:'G'.repeat(2000),completion:'확인'});
 const work=x.api.store.intakeWork(x.config.project.id,saved.work_id);
 assert.match(work.prompt,/끝까지 유지할 제외 조건: 결제 제외/u);assert.equal(work.spec.plan.import_scope,longScope);assert.ok(work.prompt.length<=8000);
});
