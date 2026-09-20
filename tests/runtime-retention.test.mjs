import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,appendFileSync,renameSync,symlinkSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {TerminalStore} from '../dist/terminal/store.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {processIdentitySync} from '../dist/supervisor/identity.js';
import {readTerminalOutput} from '../dist/terminal/output.js';
import {prepareTerminalHandoff} from '../dist/terminal/handoff.js';
import {RuntimeApi} from '../dist/interface/api.js';

const MiB=1048576;
function setup(t,enabled=true){
  t.mock.timers.enable({apis:['Date'],now:Date.now()});
  const root=mkdtempSync(join(tmpdir(),'apd-retention-')),worktree=join(root,'work');mkdirSync(worktree);
  const path=join(root,'host.json'),raw={schema_version:1,project_id:'retention',caller_ref:'synthetic',account_ref:'synthetic',worktree,data_dir:join(root,'data'),
    terminal:{executable:process.execPath,version:'2.1.126',spool_bytes:2*MiB},storage:{max_bytes:64*MiB,min_free_bytes:16*MiB,journal_margin_bytes:MiB,segment_bytes:65536,retention_days:1,cleanup_enabled:enabled}};
  writeFileSync(path,JSON.stringify(raw));const config=loadHostConfig(path),store=new TerminalStore(config.dbPath);store.registerProject(config.project);
  const identity=processIdentitySync(process.pid),host=store.claimTerminalHost(config,identity,null,'fixture','private-test-only');
  const session=store.startSession(config,'rotation').session;store.claimSession(session.id,host,config);store.bindProcess(session.id,host,1,identity);
  const db=new DatabaseSync(config.dbPath);t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
  const append=(text)=>{const line=Buffer.from(JSON.stringify({type:'result',session_id:session.cli_session_id,result:text})+'\n');store.appendSpool(config,session.id,host,1,line,'result');return line;};
  const output=(limit=10,cursor)=>readTerminalOutput(store,config,{session_ref:session.id,expected_generation:1,limit,...(cursor?{cursor}:{})});
  // Advance only the test clock. Durable events remain append-only throughout the test.
  const age=()=>t.mock.timers.setTime(Date.now()+2*86400000);
  const finish=()=>{
    // A real short-lived owned process supplies a dead kernel identity, not a fabricated PID.
    const identityUrl=pathToFileURL(resolve('dist/supervisor/identity.js')).href;
    const child=spawnSync(process.execPath,['--input-type=module','-e',`import {processIdentitySync} from ${JSON.stringify(identityUrl)};process.stdout.write(JSON.stringify(processIdentitySync(process.pid)));`],{encoding:'utf8'});
    assert.equal(child.status,0);const dead=JSON.parse(child.stdout);assert.equal(processIdentitySync(dead.pid),'dead');
    db.prepare("UPDATE terminal_session SET state='process_exited',process_identity_json=? WHERE id=?").run(JSON.stringify(dead),session.id);age();
  };
  return {root,path,raw,config,store,db,session,host,append,output,age,finish,retention:store.retention(config)};
}
test('runtime fixture spool rotation preserves global offsets hashes and pagination across three real files',t=>{
  const x=setup(t),a=x.append('a'.repeat(40000)),b=x.append('b'.repeat(40000)),c=x.append('c'.repeat(40000));
  const segments=x.store.spoolSegments(x.session.id);assert.equal(segments.length,3);assert.deepEqual(segments.map(s=>s.state),['sealed','sealed','open']);
  assert.deepEqual(segments.map(s=>s.start_offset),[0,a.length,a.length+b.length]);
  const first=x.output(2),next=x.output(2,first.next_cursor);assert.equal(first.frames.length,2);assert.equal(next.frames[0].end_offset,a.length+b.length+c.length);assert.equal(next.next_cursor,null);
  assert.equal(next.frames[0].integrity,'sha256_matches_durable_event');
  assert.equal(x.db.prepare('SELECT COUNT(*) AS n FROM storage_artifact').get().n,3);
});
test('runtime fixture spool large bounded frames are not split and partial tail prevents append or fabricated completion',t=>{
  const x=setup(t),line=x.append('x'.repeat(100000));assert.equal(x.store.spoolSegments(x.session.id)[0].bytes,line.length);assert.equal(x.output().frames.length,1);
  const file=join(x.root,'data','terminal-spool',x.session.id+'.jsonl');appendFileSync(file,'partial');
  assert.throws(()=>x.append('later'),/STORAGE_ARTIFACT_CHANGED|CLI_SPOOL_HASH_MISMATCH|CLI_SPOOL_DURABILITY_GAP/);
  assert.equal(x.store.session(x.session.id).spool_bytes,line.length);assert.throws(()=>x.output(),/CLI_SPOOL_DURABILITY_GAP/);
});
test('runtime fixture spool does not adopt same-sized tampering as a new owned artifact',t=>{
  const x=setup(t);x.append('original');const file=join(x.root,'data','terminal-spool',x.session.id+'.jsonl');writeFileSync(file,readFileSync(file,'utf8').replace('original','tampered'));
  assert.throws(()=>x.append('later'),/CLI_SPOOL_HASH_MISMATCH/);assert.throws(()=>x.output(),/CLI_SPOOL_HASH_MISMATCH/);
});
test('runtime fixture retention protects active sessions living owners and unexpired output',t=>{
  const x=setup(t);x.append('retain');assert.equal(x.retention.plan().protected[0].reason,'STORAGE_SESSION_ACTIVE');
  x.db.prepare("UPDATE terminal_session SET state='process_exited'").run();x.age();assert.equal(x.retention.plan().protected[0].reason,'STORAGE_PROCESS_ALIVE_OR_UNKNOWN');
  x.finish();x.db.prepare('UPDATE storage_artifact SET created_at=?').run(new Date().toISOString());assert.equal(x.retention.plan().protected[0].reason,'STORAGE_RETENTION_NOT_EXPIRED');
});
test('runtime fixture retention deletes only owned expired copies and leaves DB events worktree and unknown files intact',t=>{
  const x=setup(t);x.append('retain history');x.finish();
  const unknown=join(x.root,'data','terminal-spool','user-notes.txt'),outside=join(x.root,'work','user.txt');writeFileSync(unknown,'leave me');writeFileSync(outside,'outside');
  const before=x.store.outputPage(x.config.project.id,{session_ref:x.session.id,expected_generation:1,limit:10}).rows;
  const plan=x.retention.plan();assert.equal(plan.candidates.length,1);assert.equal(x.retention.execute(plan.plan_sha256).removed,1);
  assert.equal(x.output().frames[0].availability,'retention_expired');assert.equal(x.output().frames[0].integrity,'unobserved');
  assert.deepEqual(x.store.outputPage(x.config.project.id,{session_ref:x.session.id,expected_generation:1,limit:10}).rows,before);
  assert.equal(readFileSync(unknown,'utf8'),'leave me');assert.equal(readFileSync(outside,'utf8'),'outside');assert.equal(x.retention.plan().candidates.length,0);
  assert.equal(x.retention.execute(x.retention.plan().plan_sha256).removed,0);assert.throws(()=>x.store.requestResume(x.session.id,1,x.config),/SESSION_RETENTION_EXPIRED/);
});
test('runtime fixture retention plan is not deletion authority when trusted cleanup is disabled',async t=>{
  const x=setup(t,false);x.append('keep');x.finish();const api=new RuntimeApi(x.config);try{
    const plan=await api.call('runtime_storage_plan',{});assert.equal(plan.candidates.length,1);await assert.rejects(api.call('runtime_storage_prune',{plan_sha256:plan.plan_sha256}),/STORAGE_CLEANUP_DISABLED/);
    await assert.rejects(api.call('runtime_storage_prune',{plan_sha256:plan.plan_sha256,path:x.root}),/Unrecognized key/);
    assert.equal(x.output().frames[0].frame.result,'keep');
  }finally{api.close();}
});
for(const change of ['generation','resume','recent_activity','uncertain_turn','pending_verification'])test(`runtime fixture retention rechecks ${change} after plan and never deletes`,t=>{
  const x=setup(t);x.append('keep');x.finish();const plan=x.retention.plan();assert.equal(plan.candidates.length,1);
  if(change==='generation')x.db.prepare('UPDATE terminal_session SET generation=generation+1').run();
  if(change==='resume')x.db.prepare('UPDATE terminal_session SET resume_requested=1').run();
  if(change==='recent_activity')x.store.noteStorage(x.session.id,'terminal.interrupt_requested',{fixture:true});
  if(change==='uncertain_turn')x.db.prepare("INSERT INTO terminal_turn(id,session_id,request_id,request_hash,generation,prompt,status,created_at) VALUES ('turn',?,'r','h',1,'fixture','uncertain','2000-01-01')").run(x.session.id);
  if(change==='pending_verification'){
    x.db.prepare("INSERT INTO terminal_turn(id,session_id,request_id,request_hash,generation,prompt,status,created_at) VALUES ('turn',?,'r','h',1,'fixture','turn_completed','2000-01-01')").run(x.session.id);
    x.db.prepare("INSERT INTO terminal_verification(id,session_id,turn_id,generation,request_id,config_hash,manifest_json,owner_identity_json,created_at) VALUES ('verify',?,'turn',1,'r','h','[]','{}','2000-01-01')").run(x.session.id);
  }
  assert.throws(()=>x.retention.execute(plan.plan_sha256),/STORAGE_PLAN_CHANGED/);assert.ok(existsSync(join(x.root,'data','terminal-spool',x.session.id+'.jsonl')));
});
for(const change of ['missing','replacement','symlink','hardlink','parent'])test(`runtime fixture retention protects ${change} artifact without touching external data`,t=>{
  const x=setup(t);x.append('keep');x.finish();const plan=x.retention.plan(),dir=join(x.root,'data','terminal-spool'),file=join(dir,x.session.id+'.jsonl'),outside=join(x.root,'sentinel');writeFileSync(outside,'unchanged');
  if(change==='missing')unlinkSync(file);
  if(change==='replacement'){renameSync(file,file+'.saved');writeFileSync(file,'foreign');}
  if(change==='symlink'){unlinkSync(file);symlinkSync(outside,file);}
  if(change==='hardlink')linkSync(file,join(x.root,'linked-copy'));
  if(change==='parent'){renameSync(dir,dir+'.saved');mkdirSync(dir);writeFileSync(file,'foreign');}
  assert.equal(x.retention.plan().candidates.length,0);assert.throws(()=>x.retention.execute(plan.plan_sha256),/STORAGE_PLAN_CHANGED/);assert.equal(readFileSync(outside,'utf8'),'unchanged');
});
for(const stage of ['journaled','quarantined','unlinked'])test(`runtime fixture retention resumes durable ${stage} cut without replay or unknown-file removal`,t=>{
  const x=setup(t);x.append('expired');x.finish();let cut=false;
  assert.throws(()=>x.retention.execute(x.retention.plan().plan_sha256,at=>{if(at===stage&&!cut){cut=true;throw Error('injected-cut');}}),/injected-cut/);assert.equal(cut,true);
  assert.equal(x.output().frames[0].availability,'retention_pruning');
  // A new database connection, as after process death, observes the committed deletion intent.
  const reopened=new TerminalStore(x.config.dbPath);try{
    const engine=reopened.retention(x.config),plan=engine.plan();assert.equal(plan.candidates.length,1);const result=engine.execute(plan.plan_sha256);
    assert.equal(result.recovered_missing,stage==='unlinked'?1:0);assert.equal(x.output().frames[0].availability,'retention_expired');
  }finally{reopened.close();}
});
test('runtime fixture retention quarantines a changed file but never irreversibly removes it',t=>{
  const x=setup(t);x.append('expired');x.finish();let quarantined;
  assert.throws(()=>x.retention.execute(x.retention.plan().plan_sha256,(at,id)=>{if(at==='quarantined'){quarantined=join(x.root,'data','terminal-spool','.prune-'+id);writeFileSync(quarantined,'changed after plan');}}),/STORAGE_ARTIFACT_CHANGED/);
  assert.equal(readFileSync(quarantined,'utf8'),'changed after plan');assert.equal(x.retention.plan().candidates.length,0);
});
test('runtime fixture handoff output is registered idempotently and prunable without losing durable session history',async t=>{
  const x=setup(t);x.append('done');x.finish();const first=await prepareTerminalHandoff(x.store,x.config,x.session.id,1,false),second=await prepareTerminalHandoff(x.store,x.config,x.session.id,1,false);
  assert.equal(first.artifact.filename,second.artifact.filename);assert.equal(x.db.prepare("SELECT COUNT(*) AS n FROM storage_artifact WHERE kind='handoff'").get().n,1);x.age();
  const plan=x.retention.plan();assert.equal(plan.candidates.length,2);assert.equal(x.retention.execute(plan.plan_sha256).removed,2);assert.equal(x.store.session(x.session.id).id,x.session.id);
});
test('runtime native database rejects dangling symlink without creating a file outside owned data',t=>{
  const x=setup(t),target=join(x.root,'not-created'),link=join(x.root,'dangling.sqlite');symlinkSync(target,link);
  assert.throws(()=>new TerminalStore(link),/STORAGE_DATABASE_REDIRECTED/);assert.equal(existsSync(target),false);
});
for(const stage of ['journaled','quarantined','unlinked'])test(`runtime native owned pruning process SIGKILL at ${stage} retains journal and permits safe recovery`,t=>{
  const x=setup(t);x.append('expired');x.finish();
  const child=spawnSync(process.execPath,['tests/helpers/storage-prune-crash.mjs',x.config.path,stage,String(Date.now())],{encoding:'utf8',timeout:10000});
  assert.equal(child.signal,'SIGKILL',child.stderr);assert.equal(child.status,null);
  assert.equal(x.db.prepare('SELECT state FROM storage_artifact').get().state,'pruning');assert.equal(x.output().frames[0].availability,'retention_pruning');
  const plan=x.retention.plan();assert.equal(plan.candidates.length,1);x.retention.execute(plan.plan_sha256);assert.equal(x.output().frames[0].availability,'retention_expired');
});
