import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,rmdirSync,statSync,existsSync,copyFileSync,cpSync,unlinkSync,symlinkSync,linkSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fork,execFile} from 'node:child_process';
import {once} from 'node:events';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {RuntimeStore} from '../dist/store/runtime-store.js';
import {TerminalStore} from '../dist/terminal/store.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {processIdentitySync} from '../dist/supervisor/identity.js';
import {prepareTerminalHandoff} from '../dist/terminal/handoff.js';
import {createBackup,restoreBackup,inspectBundle,checkpointDatabase} from '../dist/storage/backup.js';
import {inspectSnapshot} from '../dist/storage/snapshot.js';
import {MIGRATION_1,MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5,MIGRATION_6} from '../dist/store/migration.js';
const exec=promisify(execFile),MiB=1048576,hash=b=>createHash('sha256').update(b).digest('hex');
function setup(t){
 const root=mkdtempSync(join(tmpdir(),'apd-backup-')),work=join(root,'work');mkdirSync(work);
 const configPath=join(root,'host.json'),raw={schema_version:1,project_id:'backup',caller_ref:'synthetic',account_ref:'synthetic',worktree:work,data_dir:join(root,'data'),terminal:{executable:process.execPath,version:'2.1.126'}};
 writeFileSync(configPath,JSON.stringify(raw));const config=loadHostConfig(configPath),store=new TerminalStore(config.dbPath);store.registerProject(config.project);
 const task=store.createTask(config.project.id,'coding.session');
 const db=new DatabaseSync(config.dbPath);db.exec('PRAGMA wal_autocheckpoint=0;');
 t.after(()=>{db.close();store.close();rmSync(root,{recursive:true,force:true});});
 return {root,configPath,raw,config,store,db,task,backup:join(root,'backup'),restored:join(root,'restored')};
}
const manifest=path=>JSON.parse(readFileSync(join(path,'manifest.json'),'utf8'));
function modifyManifest(path,fn){const m=manifest(path);fn(m);writeFileSync(join(path,'manifest.json'),JSON.stringify(m,null,2)+'\n');}
async function artifact(x){
 const identity=processIdentitySync(process.pid),host=x.store.claimTerminalHost(x.config,identity,null,'fixture','private-test-only');
 const session=x.store.startSession(x.config,'output').session;x.store.claimSession(session.id,host,x.config);x.store.bindProcess(session.id,host,1,identity);
 const append=text=>{const line=Buffer.from(JSON.stringify({type:'result',session_id:session.cli_session_id,result:text})+'\n');x.store.appendSpool(x.config,session.id,host,1,line,'result');return line;};
 const first=append('백업🐈');await prepareTerminalHandoff(x.store,x.config,session.id,1,false);
 return {session,append,first,file:join(x.root,'data','terminal-spool',session.id+'.jsonl')};
}
function actor(t,args){
 const child=fork('tests/helpers/backup-actor.mjs',args,{stdio:['ignore','pipe','pipe','ipc']});let errors='';child.stderr.on('data',b=>errors+=b);child.stdout.resume();
 const done=once(child,'close').then(([code,signal])=>({code,signal,errors}));t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});return {child,done};
}
test('runtime native online backup preserves WAL-only records and cursors with intrinsic non-executable identity',async t=>{
 const x=setup(t),events=x.store.events('backup','consumer');x.store.ack('backup','consumer',events.at(-1).id);
 const before=inspectSnapshot(x.db);assert.ok(statSync(x.config.dbPath+'-wal').size>0);
 const result=await createBackup(x.config.dbPath,x.backup);const m=manifest(x.backup);
 assert.deepEqual(m.source_snapshot,before);assert.equal(m.snapshot.mode,'quarantined');assert.notEqual(m.snapshot.instance_id,before.instance_id);
 assert.equal(inspectBundle(x.backup,result.manifest_sha256).snapshot.events,before.events);assert.equal(inspectSnapshot(x.db).instance_id,before.instance_id);
 assert.equal(statSync(x.backup).mode&0o777,0o700);for(const e of m.entries)assert.equal(statSync(join(x.backup,e.path)).mode&0o777,0o600);
 assert.throws(()=>new RuntimeStore(join(x.backup,'runtime.sqlite')),/RESTORE_RECONCILIATION_REQUIRED/);
 const loose=join(x.root,'loose.sqlite');copyFileSync(join(x.backup,'runtime.sqlite'),loose);assert.throws(()=>new RuntimeStore(loose),/RESTORE_RECONCILIATION_REQUIRED/);
});
test('runtime native restore does not replay queued work after source records a later external effect',async t=>{
 const x=setup(t);await createBackup(x.config.dbPath,x.backup);
 const lease=x.store.acquire(x.task.id,'owned-resource','fixture'),intent=x.store.begin(lease,'coding.session','write_external',{request:'once'},'fixture');
 const effect=join(x.root,'owned-effect');writeFileSync(effect,'one observed effect');x.store.response(lease,intent,true);x.store.complete(lease,intent,{result:'MATCH',source:'fixture-readback'});
 const result=await restoreBackup(x.backup,x.restored),check=inspectBundle(x.restored,result.manifest_sha256);
 assert.equal(check.post_snapshot_effects,'unknown');assert.equal(check.automatic_execution,false);assert.deepEqual(check.snapshot.task_states,[{status:'queued',count:1}]);
 assert.notEqual(check.snapshot.instance_id,manifest(x.backup).snapshot.instance_id);
 assert.throws(()=>new RuntimeStore(join(x.restored,'runtime.sqlite')),/RESTORE_RECONCILIATION_REQUIRED/);
 const loose=join(x.root,'restored-loose.sqlite');copyFileSync(join(x.restored,'runtime.sqlite'),loose);assert.throws(()=>new RuntimeStore(loose),/RESTORE_RECONCILIATION_REQUIRED/);
 writeFileSync(x.configPath,JSON.stringify({...x.raw,data_dir:x.restored}));assert.throws(()=>new RuntimeApi(loadHostConfig(x.configPath)),/RESTORE_RECONCILIATION_REQUIRED/);
 for(const args of [['tasks','--project','backup','--db',loose],['recover','--task',x.task.id,'--db',loose],['mcp','--config',x.configPath],['supervisor','start','--config',x.configPath]]){
  await assert.rejects(exec(process.execPath,['dist/cli.js',...args],{timeout:30000}),error=>{
   assert.notEqual(error.code,'ETIMEDOUT',`CLI timed out before checking restored database: ${args[0]}`);
   assert.match(String(error.stderr),/RESTORE_RECONCILIATION_REQUIRED/,`CLI did not reject restored database: ${args[0]}`);
   return true;
  });
 }
 assert.equal(readFileSync(effect,'utf8'),'one observed effect');assert.equal(x.store.task(x.task.id).status,'succeeded');
});
test('runtime native backup binds live spool prefix and handoff without copying worktree or unknown files',async t=>{
 const x=setup(t),a=await artifact(x);writeFileSync(join(x.root,'work','private.txt'),'excluded');writeFileSync(join(x.root,'data','terminal-spool','unknown.txt'),'excluded');
 await createBackup(x.config.dbPath,x.backup,{cut:p=>{if(p==='database_copied')a.append('later committed output');}});
 const m=manifest(x.backup);assert.equal(m.entries.length,3);assert.ok(statSync(a.file).size>a.first.length);assert.deepEqual(readFileSync(join(x.backup,'terminal-spool',a.session.id+'.jsonl')),a.first);
 assert.equal(existsSync(join(x.backup,'work')),false);assert.equal(existsSync(join(x.backup,'terminal-spool','unknown.txt')),false);assert.equal(inspectBundle(x.backup).entries,3);
 await restoreBackup(x.backup,x.restored);assert.equal(inspectBundle(x.restored).entries,3);
});
test('runtime native pinned backup snapshot permits real concurrent writer and excludes its later commits',async t=>{
 const x=setup(t),before=inspectSnapshot(x.db);let writer;
 await createBackup(x.config.dbPath,x.backup,{rate:1,cut:async p=>{if(p==='before_database'){writer=actor(t,['writer',x.config.dbPath]);await once(writer.child,'message');writer.child.send('stop');assert.equal((await writer.done).code,0);}}});
 assert.ok(inspectSnapshot(x.db).projects>before.projects);assert.equal(manifest(x.backup).source_snapshot.projects,before.projects);assert.equal(inspectBundle(x.backup).snapshot.projects,before.projects);
});
test('runtime native PASSIVE checkpoint reports reader-held WAL without deletion and completes after reader release',t=>{
 const x=setup(t),reader=new DatabaseSync(x.config.dbPath);reader.exec('BEGIN; SELECT * FROM project;');
 try{x.store.createTask('backup','coding.session');const held=checkpointDatabase(x.config.dbPath);assert.equal(held.fully_checkpointed,false);assert.ok(held.log_frames>held.checkpointed_frames);assert.equal(held.automatic_truncate,false);assert.ok(existsSync(x.config.dbPath+'-wal'));}
 finally{reader.exec('ROLLBACK');reader.close();}
 assert.equal(checkpointDatabase(x.config.dbPath).fully_checkpointed,true);assert.equal(x.store.tasks('backup').length,2);
});
test('runtime native schema six backup upgrades only quarantined copy and preserves source version and records',async t=>{
 const x=setup(t),path=join(x.root,'v6.sqlite'),old=new DatabaseSync(path);old.exec(MIGRATION_1);old.exec('INSERT INTO schema_version VALUES(1)');for(const m of [MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5,MIGRATION_6])old.exec(m);old.prepare('INSERT INTO project VALUES (?,?)').run('legacy','{"id":"legacy"}');old.close();
 await createBackup(path,x.backup);assert.equal(manifest(x.backup).source_snapshot.schema_version,6);assert.equal(manifest(x.backup).snapshot.schema_version,8);
 const source=new DatabaseSync(path);assert.equal(source.prepare('SELECT version FROM schema_version').get().version,6);source.close();await restoreBackup(x.backup,x.restored);assert.equal(inspectBundle(x.restored).snapshot.projects,1);
});
for(const point of ['before_database','database_progress','database_copied','artifacts_copied','before_publish','published'])test('runtime native backup SIGKILL cut '+point+' leaves no executable snapshot',async t=>{
 const x=setup(t),job=actor(t,['backup',x.config.dbPath,x.backup,point]),result=await job.done;assert.equal(result.signal,'SIGKILL',result.errors);
 assert.throws(()=>new RuntimeStore(join(x.backup,'runtime.sqlite')),/RESTORE_RECONCILIATION_REQUIRED/);
 if(point==='published')assert.equal(inspectBundle(x.backup).kind,'backup');else assert.throws(()=>inspectBundle(x.backup));
 assert.equal(x.store.task(x.task.id).status,'queued');assert.equal(inspectSnapshot(x.db).mode,'active');
});
for(const point of ['restore_copied','restore_quarantined','before_publish','published'])test('runtime native restore SIGKILL cut '+point+' leaves intrinsic quarantine and no completed partial bundle',async t=>{
 const x=setup(t);await createBackup(x.config.dbPath,x.backup);const result=await actor(t,['restore',x.backup,x.restored,point]).done;assert.equal(result.signal,'SIGKILL',result.errors);
 const loose=join(x.root,'interrupted.sqlite');copyFileSync(join(x.restored,'runtime.sqlite'),loose);assert.throws(()=>new RuntimeStore(loose),/RESTORE_RECONCILIATION_REQUIRED/);
 if(point==='published')assert.equal(inspectBundle(x.restored).kind,'quarantined_restore');else assert.throws(()=>inspectBundle(x.restored));
});
test('runtime native missing changed pruning and unverified legacy artifacts fail without completed manifest',async t=>{
 for(const mode of ['missing','changed','pruning','legacy']){
  const x=setup(t),a=await artifact(x);if(mode==='missing')unlinkSync(a.file);if(mode==='changed')writeFileSync(a.file,Buffer.alloc(a.first.length,65));
  if(mode==='pruning')x.db.exec("UPDATE storage_artifact SET state='pruning'");if(mode==='legacy')x.db.exec("DELETE FROM storage_artifact WHERE kind='spool'");
  await assert.rejects(createBackup(x.config.dbPath,x.backup));assert.equal(existsSync(join(x.backup,'manifest.json')),false);assert.throws(()=>inspectBundle(x.backup));
 }
});
test('runtime native bundle rejects altered bytes missing inventory traversal symlinks hardlinks extra WAL and schema injection',async t=>{
 const x=setup(t);await artifact(x);await createBackup(x.config.dbPath,x.backup);const outside=join(x.root,'sentinel');writeFileSync(outside,'unchanged');
 const cases={
  bytes:p=>appendFileSync(join(p,'runtime.sqlite'),'changed'),
  omitted:p=>{const item=manifest(p).entries.find(e=>e.path.startsWith('terminal-spool/'));unlinkSync(join(p,item.path));rmdirSync(join(p,'terminal-spool'));modifyManifest(p,m=>m.entries=m.entries.filter(e=>e.path!==item.path));},
  traversal:p=>modifyManifest(p,m=>m.entries[1].path='../sentinel'),
  symlink:p=>{unlinkSync(join(p,'runtime.sqlite'));symlinkSync(outside,join(p,'runtime.sqlite'));},
  hardlink:p=>linkSync(join(p,'runtime.sqlite'),join(x.root,'linked.sqlite')),
  wal:p=>writeFileSync(join(p,'runtime.sqlite-wal'),'untrusted'),
  schema:p=>{const d=new DatabaseSync(join(p,'runtime.sqlite'));d.exec('CREATE TABLE malicious(x)');d.close();const bytes=readFileSync(join(p,'runtime.sqlite'));modifyManifest(p,m=>m.entries[0]={path:'runtime.sqlite',bytes:bytes.length,sha256:hash(bytes)});},
 };
 for(const [name,mutate] of Object.entries(cases)){const p=join(x.root,name);cpSync(x.backup,p,{recursive:true});mutate(p);assert.throws(()=>inspectBundle(p),undefined,name);await assert.rejects(restoreBackup(p,join(x.root,name+'-restore')));assert.equal(existsSync(join(x.root,name+'-restore')),false);}
 assert.equal(readFileSync(outside,'utf8'),'unchanged');
});
test('runtime native fresh destination and bounded operator CLI reject collisions malformed options and digest mismatch',async t=>{
 const x=setup(t);const result=await exec(process.execPath,['dist/cli.js','maintenance','backup','--db',x.config.dbPath,'--destination',x.backup,'--max-bytes',String(8*MiB)],{timeout:15000});const receipt=JSON.parse(result.stdout);
 assert.equal(JSON.parse((await exec(process.execPath,['dist/cli.js','maintenance','inspect','--backup',x.backup,'--expected-sha256',receipt.manifest_sha256])).stdout).automatic_execution,false);
 await assert.rejects(createBackup(x.config.dbPath,x.backup),/EEXIST/);await assert.rejects(restoreBackup(x.backup,x.backup),/EEXIST/);assert.throws(()=>inspectBundle(x.backup,'a'.repeat(64)),/BACKUP_MANIFEST_MISMATCH/);
 await assert.rejects(createBackup(x.config.dbPath,join(x.root,'bad-budget'),{maxBytes:1024}),/BACKUP_INVALID_BUDGET/);
 await assert.rejects(exec(process.execPath,['dist/cli.js','maintenance','restore','--backup',x.backup,'--destination',x.restored,'--approved','true']));assert.equal(existsSync(x.restored),false);
 assert.ok(receipt.snapshot.tasks>0);
});
test('runtime native maintenance target substitution is rejected before overwriting any outside file',async t=>{
 const x=setup(t),outside=join(x.root,'sentinel');writeFileSync(outside,'unchanged');
 await assert.rejects(createBackup(x.config.dbPath,x.backup,{cut:p=>{if(p==='before_database'){unlinkSync(join(x.backup,'runtime.sqlite'));symlinkSync(outside,join(x.backup,'runtime.sqlite'));}}}),/BACKUP_UNSAFE_FILE/);
 assert.equal(readFileSync(outside,'utf8'),'unchanged');assert.equal(existsSync(join(x.backup,'manifest.json')),false);
});
test('runtime native database and artifact size budgets reject incomplete snapshots without deleting source data',async t=>{
 const large=setup(t);large.db.prepare('INSERT INTO project VALUES (?,?)').run('large',JSON.stringify({data:'x'.repeat(2*MiB)}));
 await assert.rejects(createBackup(large.config.dbPath,large.backup,{maxBytes:MiB}),/BACKUP_BUDGET_EXCEEDED/);assert.equal(existsSync(large.backup),false);
 const x=setup(t),a=await artifact(x);for(let n=0;n<3;n++)a.append('x'.repeat(400000));const before=hash(readFileSync(a.file));
 await assert.rejects(createBackup(x.config.dbPath,x.backup,{maxBytes:MiB}),/BACKUP_BUDGET_EXCEEDED/);assert.equal(existsSync(join(x.backup,'manifest.json')),false);assert.equal(hash(readFileSync(a.file)),before);
 assert.throws(()=>new RuntimeStore(join(x.backup,'runtime.sqlite')),/RESTORE_RECONCILIATION_REQUIRED/);
});
test('runtime native invalid FK outbox and quarantine sources are never advertised as valid backup or checkpoint',async t=>{
 const x=setup(t);await createBackup(x.config.dbPath,x.backup);await assert.rejects(createBackup(join(x.backup,'runtime.sqlite'),join(x.root,'second')),/BACKUP_SOURCE_QUARANTINED/);assert.throws(()=>checkpointDatabase(join(x.backup,'runtime.sqlite')),/RESTORE_RECONCILIATION_REQUIRED/);
 x.db.exec('DELETE FROM outbox');await assert.rejects(createBackup(x.config.dbPath,join(x.root,'gap')),/BACKUP_OUTBOX_GAP/);
 x.db.exec('INSERT INTO outbox SELECT id FROM event; PRAGMA foreign_keys=OFF;');x.db.prepare('UPDATE task SET project_id=?').run('missing');await assert.rejects(createBackup(x.config.dbPath,join(x.root,'fk')),/BACKUP_FOREIGN_KEY_FAILED/);
});
test('runtime native live identity revocation fences existing lease and prevents subsequent durable writes',t=>{
 const x=setup(t),lease=x.store.acquire(x.task.id,'resource','fixture'),before=inspectSnapshot(x.db).events;
 x.db.exec("UPDATE runtime_identity SET mode='quarantined'");
 assert.throws(()=>x.store.assertLease(lease),/RUNTIME_IDENTITY_REVOKED/);assert.throws(()=>x.store.cancel(x.task.id),/RUNTIME_IDENTITY_REVOKED/);assert.throws(()=>x.store.registerProject(x.config.project),/RUNTIME_IDENTITY_REVOKED/);
 assert.equal(inspectSnapshot(x.db).events,before);
});
