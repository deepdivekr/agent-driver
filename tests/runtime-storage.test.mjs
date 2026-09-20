import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,linkSync,openSync,ftruncateSync,closeSync,renameSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DatabaseSync} from 'node:sqlite';
import {measureStorage,storagePolicySchema} from '../dist/storage/budget.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {TerminalStore} from '../dist/terminal/store.js';
import {MIGRATION_1,MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5} from '../dist/store/migration.js';
const exec=promisify(execFile),MiB=1048576;
function setup(t,storage={max_bytes:32*MiB,min_free_bytes:16*MiB,journal_margin_bytes:MiB}) {
  const root=mkdtempSync(join(tmpdir(),'apd-storage-')),worktree=join(root,'work');mkdirSync(worktree);
  const path=join(root,'host.json'),raw={schema_version:1,project_id:'storage',caller_ref:'synthetic',account_ref:'synthetic',worktree,data_dir:join(root,'data'),terminal:{executable:process.execPath,version:'2.1.126'},...(storage?{storage}:{})};
  writeFileSync(path,JSON.stringify(raw));const config=loadHostConfig(path),store=new TerminalStore(config.dbPath);store.registerProject(config.project);
  t.after(()=>{try{store.close();}catch{}rmSync(root,{recursive:true,force:true});});return {root,path,raw,config,store,ledger:store.storage(config)};
}
function child(config,bytes){
  const proc=spawn(process.execPath,['tests/helpers/storage-reservation.mjs',config.path,String(bytes)],{stdio:['pipe','pipe','pipe']});
  let out='',err='';proc.stderr.on('data',b=>err+=b);const done=new Promise((r,j)=>{proc.once('error',j);proc.once('close',code=>r({code,out,err}));});
  const ready=new Promise((r,j)=>{proc.stdout.on('data',b=>{out+=b;if(out.includes('\n'))r(JSON.parse(out.split('\n')[0]));});proc.once('error',j);proc.once('exit',()=>{if(!out)j(Error(err||'child exited'));});});
  return {proc,done,ready};
}
test('runtime contract storage policy rejects oversized budgets, unknown grants and unconfigured enforcement claims',t=>{
  for(const value of [{max_bytes:1},{max_bytes:32*MiB,approved:true},{max_bytes:32*MiB,journal_margin_bytes:32*MiB},{max_bytes:32*MiB,segment_bytes:1}])assert.throws(()=>storagePolicySchema.parse(value));
  const x=setup(t,null);assert.deepEqual(x.ledger.status(),{status:'unconfigured',verified:false,usage:'unobserved'});
});
test('runtime native storage accounting counts sparse logical size once and never follows outside symlinks',t=>{
  const x=setup(t),directory=join(x.root,'data'),outside=join(x.root,'outside');writeFileSync(outside,'sentinel');
  const before=measureStorage(directory),fd=openSync(join(directory,'sparse'),'wx');ftruncateSync(fd,4*MiB);closeSync(fd);
  linkSync(join(directory,'sparse'),join(directory,'same-inode'));symlinkSync(outside,join(directory,'outside-link'));
  const after=measureStorage(directory);assert.ok(after.logical_bytes-before.logical_bytes>=4*MiB);assert.ok(after.logical_bytes-before.logical_bytes<4*MiB+4096);assert.equal(after.symlinks_not_followed,1);assert.equal(readFileSync(outside,'utf8'),'sentinel');
});
test('runtime native storage reservation is atomic across real processes and does not reap living owners',async t=>{
  const x=setup(t),a=child(x.config,20*MiB);t.after(()=>a.proc.kill());assert.equal((await a.ready).status,'reserved');
  assert.equal(x.ledger.reapDeadOwners().released,0);
  const b=child(x.config,20*MiB);t.after(()=>b.proc.kill());const denied=await b.ready;assert.equal(denied.reason,'STORAGE_BUDGET_EXCEEDED');await b.done;
  a.proc.stdin.end('release');assert.equal((await a.done).code,0);assert.equal(x.ledger.status().reserved_bytes,0);
});
test('runtime native storage reservations survive owner SIGKILL until exact dead-owner recovery',async t=>{
  const x=setup(t),a=child(x.config,20*MiB);t.after(()=>a.proc.kill());await a.ready;a.proc.kill('SIGKILL');await a.done;
  assert.equal(x.ledger.status().reserved_bytes,20*MiB);assert.equal(x.ledger.reapDeadOwners().released,1);assert.equal(x.ledger.status().reserved_bytes,0);
});
test('runtime native storage policy and root replacement fail closed without adopting relaxed limits',t=>{
  const x=setup(t),id=x.ledger.reserve('probe',MiB);x.ledger.release(id);
  writeFileSync(x.path,JSON.stringify({...x.raw,storage:{...x.raw.storage,max_bytes:64*MiB}}));
  assert.equal(x.store.storage(loadHostConfig(x.path)).status().reason,'STORAGE_POLICY_OR_ROOT_CHANGED');
  renameSync(join(x.root,'data'),join(x.root,'old-data'));mkdirSync(join(x.root,'data'));assert.equal(x.ledger.status().reason,'STORAGE_POLICY_OR_ROOT_CHANGED');
});
test('runtime native storage exhaustion blocks API dispatch while health history and cancellation remain available',async t=>{
  const x=setup(t),session=x.store.startSession(x.config,'old').session;
  const fd=openSync(join(x.root,'data','budget-fixture'),'wx');ftruncateSync(fd,32*MiB);closeSync(fd);
  const api=new RuntimeApi(x.config);try{
    await assert.rejects(api.call('runtime_terminal_start',{request_id:'new'}),/STORAGE_BUDGET_EXCEEDED/);
    assert.equal((await api.call('runtime_health',{})).storage_boundary.status,'blocked');
    assert.equal(x.store.sessions(x.config.project.id).length,1);assert.equal(x.store.terminalHost(x.config.project.id),undefined);
    await api.call('runtime_terminal_interrupt',{session_ref:session.id,expected_generation:1});
    assert.equal((await api.call('runtime_terminal_status',{session_ref:session.id})).session_ref,session.id);
  }finally{api.close();}
});
test('runtime native storage schema v5 migration preserves prior project records and does not require writes on current-version reopen',t=>{
  const x=setup(t),path=join(x.root,'old.sqlite'),db=new DatabaseSync(path);db.exec(MIGRATION_1);db.exec('INSERT INTO schema_version VALUES (1)');for(const sql of [MIGRATION_2,MIGRATION_3,MIGRATION_4,MIGRATION_5])db.exec(sql);db.prepare('INSERT INTO project VALUES (?,?)').run('prior',JSON.stringify({id:'prior'}));db.close();
  const current=new TerminalStore(path);assert.equal(current.project('prior').id,'prior');current.close();
  const check=new DatabaseSync(path);assert.equal(check.prepare('SELECT version FROM schema_version').get().version,7);check.close();
});
test('runtime native actual ENOSPC and SQLITE_FULL preserve committed intent and forbid replay inside finite private tmpfs',async t=>{
  const x=setup(t),outside=join(x.root,'outside-sentinel');writeFileSync(outside,'unchanged');
  const args=['--unshare-all','--unshare-user','--disable-userns','--die-with-parent','--new-session','--cap-drop','ALL','--size','8388608','--tmpfs','/',
    '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64','--proc','/proc','--dev','/dev',
    '--dir','/runtime','--ro-bind',process.execPath,'/runtime/node','--ro-bind',resolve('dist'),'/runtime/dist','--ro-bind',resolve('node_modules'),'/runtime/node_modules',
    '--ro-bind',resolve('tests/helpers/storage-enospc.mjs'),'/runtime/check.mjs','--size','33554432','--tmpfs','/work','--chdir','/work','--clearenv','--setenv','PATH','/usr/bin:/bin',
    '/usr/bin/prlimit','--as=8589934592','--cpu=10','--nofile=128','--','/runtime/node','/runtime/check.mjs'];
  const result=await exec('/usr/bin/bwrap',args,{timeout:15000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin'}});
  const receipt=JSON.parse(result.stdout);assert.equal(receipt.os_error,'ENOSPC');assert.equal(receipt.sqlite_error_code,13);assert.equal(receipt.prior_intent_retained,true);assert.equal(receipt.reopened_while_full,true);assert.equal(receipt.spool_error,'ENOSPC');assert.equal(receipt.spool_gap_append_blocked,true);assert.equal(readFileSync(outside,'utf8'),'unchanged');
});
