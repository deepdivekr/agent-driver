import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {prepareLocalConnection} from '../dist/onboarding/connection.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {PackStore} from '../dist/packs/store.js';
import {HermesMigrationRuntime} from '../dist/work/hermes-migration.js';
import {HermesWorkRuntime,hermesWorkDetail,importHermesWork} from '../dist/work/hermes.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {startControlCenter} from '../dist/observability/control-center.js';
import {tools} from '../dist/interface/catalog.js';
import {UNIVERSAL_WORK_MIGRATION_PROMPT} from '../dist/work/import-draft.js';
import {chromium} from 'playwright';

const definition={title:'주간 자료 확인',goal:'지정한 공개 자료를 확인하고 결과를 정리한다',checks:['출처와 결과를 대조한다'],steps:['자료 확인','결과 검토'],instruction:'지정한 자료만 읽고 결과를 알려주세요. 전송하지 마세요.'};
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'hermes-migration-')),home=join(root,'hermes');await mkdir(join(home,'cron'),{recursive:true});
 const jobsFile=join(home,'cron/jobs.json'),job={id:'job-one',name:'자료 조회',prompt:'공개 자료를 조회하고 요약해줘',schedule:{kind:'cron',expr:'0 8 * * 1'},enabled:true};
 await writeFile(jobsFile,JSON.stringify({jobs:[job]}));await writeFile(join(home,'.env'),'PRIVATE_VALUE=must-not-read');
 const source=new DatabaseSync(join(home,'state.db'));source.exec('CREATE TABLE sessions(id TEXT PRIMARY KEY,source TEXT,title TEXT,started_at REAL); CREATE TABLE messages(id INTEGER PRIMARY KEY,session_id TEXT,role TEXT,content TEXT,reasoning_content TEXT);');
 source.prepare('INSERT INTO sessions VALUES(?,?,?,?)').run('session-one','telegram','조회 대화',1);
 source.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(1,'session-one','user','자료 확인. password=secret-test-value','HIDDEN MUST NOT READ');
 source.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(2,'session-one','tool','TOOL RESULT MUST NOT READ',null);source.close();
 const paths=await prepareLocalConnection(join(root,'driver')),config=loadHostConfig(paths.runtimeConfig),store=new PackStore(config.dbPath);store.registerProject(config.project);
 const runtime=new HermesMigrationRuntime(store,config),selection={home,kind:'job',source_id:job.id};
 t.after(async()=>{store.close();await rm(root,{recursive:true,force:true})});return {root,home,jobsFile,job,config,store,runtime,selection};
}
const apply=(preview,overrides={})=>({migration_id:preview.migration_id,source_fingerprint:preview.source_fingerprint,definition,acknowledged:true,...overrides});
const works=x=>Number(x.store.hermesState.prepare('SELECT COUNT(*) n FROM office_work').get().n);
test('runtime fixture Hermes migration notices an earlier manual import without duplicating or rewriting it',async t=>{
 const x=await fixture(t),id=importHermesWork(x.store,x.config.project.id,'legacy-import',{...definition,runtime_home:x.home,family:'workflow.imported',history:[{source:'Hermes job · '+x.job.id,summary:'기존 수동 이전'}]});
 const preview=await x.runtime.preview(x.selection);assert.equal(preview.legacy_work_id,id);assert.equal(preview.existing_work_id,id);
 await assert.rejects(x.runtime.apply(apply(preview)),/LEGACY_WORK_REVIEW/u);assert.equal(works(x),1);
});
test('runtime fixture Hermes migration scans only bounded source fields and never reads secrets, tools or thoughts',async t=>{
 const x=await fixture(t),before=await readFile(x.jobsFile),listed=await x.runtime.discover({home:x.home});assert.equal(listed.candidates.length,2);
 const preview=await x.runtime.preview({home:x.home,kind:'session',source_id:'session-one'});const text=JSON.stringify(preview);
 assert.doesNotMatch(text,/secret-test-value|HIDDEN MUST|TOOL RESULT|must-not-read/u);assert.match(text,/REDACTED/u);assert.equal(works(x),0);assert.deepEqual(await readFile(x.jobsFile),before);
 assert.equal(preview.execution,false);assert.equal(preview.jev_used,false);
});
test('runtime fixture Hermes migration repeat preview, concurrent acceptance and restart reuse a single durable Work',async t=>{
 const x=await fixture(t),preview=await x.runtime.preview(x.selection);assert.equal((await x.runtime.preview(x.selection)).migration_id,preview.migration_id);
 const otherStore=new PackStore(x.config.dbPath),other=new HermesMigrationRuntime(otherStore,x.config);t.after(()=>otherStore.close());
 const [first,second]=await Promise.all([x.runtime.apply(apply(preview)),other.apply(apply(preview))]);assert.equal(first.work_id,second.work_id);assert.equal(works(x),1);
 const restored=new HermesMigrationRuntime(x.store,x.config);const again=await restored.apply(apply(preview));assert.equal(again.work_id,first.work_id);assert.equal(again.deduplicated,true);
 assert.equal(hermesWorkDetail(x.store,x.config.project.id,first.work_id).hermes.turns.length,0);assert.equal(hermesWorkDetail(x.store,x.config.project.id,first.work_id).definition.runtime_home,x.home);
 const record=x.store.hermesState.prepare('SELECT backup_path FROM office_hermes_migration WHERE id=?').get(preview.migration_id),backup=new DatabaseSync(record.backup_path,{readOnly:true});assert.equal(backup.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(backup.prepare('SELECT COUNT(*) n FROM office_work').get().n,0);backup.close();
 await assert.rejects(restored.apply(apply(preview,{definition:{...definition,goal:'다른 목적의 자료를 변경한다'}})),/APPROVAL_CONFLICT/u);
});
test('runtime fixture Hermes migration rolls back partial creation after injected failure and retries without an orphan',async t=>{
 const x=await fixture(t);let first=true;const runtime=new HermesMigrationRuntime(x.store,x.config,{beforeCommit(){if(first){first=false;throw Error('INJECTED_FAILURE')}}});const preview=await runtime.preview(x.selection);
 await assert.rejects(runtime.apply(apply(preview)),/INJECTED/u);assert.equal(works(x),0);assert.equal(runtime.status({migration_id:preview.migration_id}).status,'prepared');
 assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) n FROM hermes_work').get().n,0);assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) n FROM hermes_event').get().n,0);
 const accepted=await runtime.apply(apply(preview));assert.equal(accepted.status,'applied');assert.equal(works(x),1);
});
test('runtime fixture Hermes migration fails closed for backup errors and source drift before acceptance',async t=>{
 const x=await fixture(t),preview=await x.runtime.preview(x.selection),broken=new HermesMigrationRuntime(x.store,x.config,{async backup(){throw Error('BACKUP_UNAVAILABLE')}});
 await assert.rejects(broken.apply(apply(preview)),/BACKUP_UNAVAILABLE/u);assert.equal(works(x),0);
 await writeFile(x.jobsFile,JSON.stringify({jobs:[{...x.job,prompt:'변경된 지침'}]}));await assert.rejects(x.runtime.apply(apply(preview)),/SOURCE_CHANGED/u);assert.equal(works(x),0);
 const fresh=await x.runtime.preview(x.selection);assert.notEqual(fresh.source_fingerprint,preview.source_fingerprint);
});
test('runtime fixture Hermes migration detects source drift during backup and cross-project manifest use',async t=>{
 const x=await fixture(t),preview=await x.runtime.preview(x.selection);
 const runtime=new HermesMigrationRuntime(x.store,x.config,{async backup(store,path){await writeFile(path,'fixture backup');await writeFile(x.jobsFile,JSON.stringify({jobs:[{...x.job,prompt:'새 내용'}]}))}});
 await assert.rejects(runtime.apply(apply(preview)),/SOURCE_CHANGED/u);assert.equal(works(x),0);
 const foreign=new HermesMigrationRuntime(x.store,{...x.config,project:{...x.config.project,id:'foreign'}});assert.throws(()=>foreign.status({migration_id:preview.migration_id}),/NOT_FOUND/u);
});
test('runtime fixture Hermes migration preserves originals, supports pre-execution undo and prevents resuming detached Work',async t=>{
 const x=await fixture(t),before=await readFile(x.jobsFile),preview=await x.runtime.preview(x.selection),accepted=await x.runtime.apply(apply(preview));
 assert.equal(x.runtime.undo({migration_id:preview.migration_id}).status,'detached');assert.equal(x.runtime.undo({migration_id:preview.migration_id}).status,'detached');assert.equal(works(x),1);
 const runtime=new HermesWorkRuntime(x.store,x.config);t.after(()=>runtime.close());const state=runtime.status(accepted.work_id);assert.equal(state.hermes.detached,true);assert.throws(()=>runtime.action({work_id:accepted.work_id,revision:state.revision,action:'resume'}),/DETACHED/u);
 const again=await x.runtime.preview(x.selection);assert.notEqual(again.migration_id,preview.migration_id);assert.equal((await x.runtime.apply(apply(again))).status,'applied');assert.equal(works(x),2);assert.deepEqual(await readFile(x.jobsFile),before);
});
test('runtime fixture Hermes migration cannot undo a Work once execution has been requested',async t=>{
 const x=await fixture(t),preview=await x.runtime.preview(x.selection),accepted=await x.runtime.apply(apply(preview)),at=new Date().toISOString();
 x.store.hermesState.prepare("INSERT INTO hermes_turn(id,project_id,work_id,request_id,instruction,status,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?)").run(randomUUID(),x.config.project.id,accepted.work_id,randomUUID(),'새 지시',at,at);
 assert.throws(()=>x.runtime.undo({migration_id:preview.migration_id}),/ALREADY_EXECUTED/u);assert.equal(x.runtime.status({migration_id:preview.migration_id}).status,'applied');
});
test('runtime fixture Hermes migration rejects altered confirmation, credentials, unsupported jobs and linked revisions',async t=>{
 const x=await fixture(t),preview=await x.runtime.preview(x.selection);
 await assert.rejects(x.runtime.apply(apply(preview,{acknowledged:false})));await assert.rejects(x.runtime.apply(apply(preview,{source_fingerprint:'0'.repeat(64)})),/FINGERPRINT/u);
 await assert.rejects(x.runtime.apply(apply(preview,{definition:{...definition,instruction:'password=private-value'}})),/CREDENTIAL/u);
 const accepted=await x.runtime.apply(apply(preview));await writeFile(x.jobsFile,JSON.stringify({jobs:[{...x.job,prompt:'업무가 바뀜'}]}));const changed=await x.runtime.preview(x.selection);assert.equal(changed.existing_work_id,accepted.work_id);await assert.rejects(x.runtime.apply(apply(changed)),/ALREADY_LINKED/u);
 await writeFile(x.jobsFile,JSON.stringify({jobs:[{...x.job,id:'model-job',model:'pinned-model'}]}));const unsupported=await x.runtime.preview({...x.selection,source_id:'model-job'});assert.equal(unsupported.source.blockers.length,1);await assert.rejects(x.runtime.apply(apply(unsupported)),/UNSUPPORTED/u);
});
test('runtime fixture Hermes migration refuses corrupt, duplicate, oversized and escaped sources without repairing them',async t=>{
 const x=await fixture(t);await writeFile(x.jobsFile,'not json');await assert.rejects(x.runtime.discover({home:x.home}),/JOBS_INVALID/u);assert.equal(await readFile(x.jobsFile,'utf8'),'not json');
 await writeFile(x.jobsFile,JSON.stringify({jobs:[x.job,x.job]}));await assert.rejects(x.runtime.discover({home:x.home}),/SCHEMA/u);
 await writeFile(x.jobsFile,'x'.repeat(2_000_001));await assert.rejects(x.runtime.discover({home:x.home}),/UNSUPPORTED/u);
 const linked=join(x.root,'linked');await symlink(x.home,linked);await assert.rejects(x.runtime.discover({home:linked}),/DIRECTORY/u);
});
test('runtime fixture migration HTTP requires human origin while MCP can only discover and propose',async t=>{
 const x=await fixture(t),server=await startControlCenter(x.config);t.after(()=>server.close());
 const result=await fetch(server.url+'work/migration/discover',{method:'POST',headers:{'content-type':'application/json','x-agent-driver':'human-office'},body:JSON.stringify({home:x.home})});assert.equal(result.status,403);
 assert.ok(tools.runtime_work_migration_preview);assert.equal(tools.runtime_work_migration_apply,undefined);assert.equal(tools.runtime_work_migration_undo,undefined);
 const api=new RuntimeApi(x.config);t.after(()=>api.close());await assert.rejects(api.call('runtime_work_migration_discover',{home:x.home}));
});
test('runtime fixture generic JSON import reuses the same preview and rejects conflicting re-acceptance',async t=>{
 const x=await fixture(t),api=new RuntimeApi(x.config);t.after(()=>api.close());
 const draft=JSON.parse(UNIVERSAL_WORK_MIGRATION_PROMPT.match(/\n(\{\n[\s\S]*?\n\})\n/u)[1]);
 draft.title={value:'자료 확인',evidence_ids:['e1']};draft.goal={value:'공개 자료를 검토한다',evidence_ids:['e1']};draft.completion=[{id:'result',result:'결과와 근거 확인',proof:'원본 대조',evidence_ids:['e1']}];draft.evidence=[{id:'e1',source_ref:'원본 지침',quote:'공개 자료를 검토하고 결과와 근거를 확인한다'}];
 const one=api.imports.paste({text:JSON.stringify(draft)}),two=api.imports.paste({text:JSON.stringify(draft,null,2)});assert.equal(one.import_id,two.import_id);
 const accepted=await api.imports.accept({import_id:one.import_id}),again=await api.imports.accept({import_id:two.import_id});assert.equal(accepted.work_id,again.work_id);assert.equal(works(x),1);
 await assert.rejects(api.imports.accept({import_id:one.import_id,goal:'전혀 다른 업무로 덮어쓰기'}),/APPROVAL_CONFLICT/u);
});
test('runtime fixture Hermes migration UI previews, accepts once, reloads receipt and undoes on desktop and mobile',async t=>{
 const x=await fixture(t),server=await startControlCenter(x.config),errors=[];let browser;
 // Close EventSource/browser connections before waiting for HTTP server shutdown.
 t.after(async()=>{try{await browser?.close()}finally{await server.close()}assert.deepEqual(errors,[])});
 browser=await chromium.launch({headless:true});const page=await browser.newPage();page.on('pageerror',error=>errors.push(error.message));
 await page.addInitScript(()=>localStorage.setItem('office-lang','ko'));await page.goto(server.url+'?import=1');
 await page.locator('[data-import-route="hermes"]').click();await page.locator('#migration-home').fill(x.home);await page.locator('#migration-discover').click();
 await page.locator('[data-migration-source="0"]').click();await page.locator('#migration-goal').waitFor();
 await page.locator('#migration-apply').click();assert.equal(works(x),0);await page.locator('#migration-ack').check();await page.locator('#migration-apply').click();await page.locator('#migration-open-work').waitFor();assert.equal(works(x),1);
 const id=x.store.hermesState.prepare('SELECT id FROM office_hermes_migration').get().id;
 await page.goto(server.url+'?import=1&migration_id='+id);await page.locator('#migration-undo').waitFor();
 for(const width of [1280,390]){await page.setViewportSize({width,height:850});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)}
 await page.locator('#migration-undo').click();await page.getByRole('heading',{name:'가져오기 연결 취소됨'}).waitFor();assert.equal(works(x),1);
 assert.equal(x.store.hermesState.prepare('SELECT COUNT(*) n FROM hermes_turn').get().n,0);
});
