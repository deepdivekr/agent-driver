import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,existsSync,symlinkSync,linkSync,mkdirSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {soakConfig,metrics,schedule,twoHourGate} from '../scripts/runtime/soak-contract.mjs';
import {journal,readJson,manifestAt,hash} from '../scripts/runtime/soak-io.mjs';
import {inspectBudget,assertBudgetMembership} from '../dist/resources/budget.js';
import {liveness} from '../dist/supervisor/identity.js';
const exec=promisify(execFile);
test('runtime contract two-hour gate requires actual duration, coverage and completion independently',()=>{
 assert.equal(twoHourGate(1000,7200000,'completed',100,schedule),'NOT_RUN');
 assert.equal(twoHourGate(7200000,7200000,'completed',100,schedule),'PASS');
 for(const input of [[7200000,7199999,'completed',100,schedule],[7200000,'unobserved','completed',100,schedule],[7200000,7200000,'completed',99,schedule],[7200000,7200000,'completed',100,['normal']],[7200000,1000,'failed',1,schedule]])assert.equal(twoHourGate(...input),'FAIL');
 assert.equal(twoHourGate(7200000,1000,'running',1,schedule),'NOT_RUN');assert.equal(twoHourGate(7200000,1000,'stopped',1,schedule),'NOT_RUN');
});
test('runtime native control plane imports exclude browser modules until actual driver import',async()=>{
 const code=`import {createRequire} from 'node:module';import {sep} from 'node:path';import assert from 'node:assert/strict';const require=createRequire(import.meta.url),loaded=()=>Object.keys(require.cache).filter(p=>p.includes('node_modules'+sep+'playwright'));const observations=[];for(const path of ['interface/catalog','supervisor/supervisor','terminal/host']){const at=performance.now();await import('./dist/'+path+'.js');assert.equal(loaded().length,0,path);observations.push({module:path,rss_bytes:process.memoryUsage().rss,elapsed_ms:performance.now()-at});}const a=await import('./dist/browser/fixture-capability.js'),b=await import('./dist/browser/fixture-driver.js');assert.equal(a.FIXTURE_DRAFT,b.FIXTURE_DRAFT);assert.ok(loaded().length>0);console.log(JSON.stringify(observations));`;
 const result=await exec(process.execPath,['--input-type=module','-e',code],{timeout:15000});assert.equal(JSON.parse(result.stdout).length,3);
});

test('runtime native soak manifest rejects changed root and budget before acting',()=>{
 const root=mkdtempSync(join(tmpdir(),'driver-soak-binding-')),s=statSync(root),id='a'.repeat(32),config=soakConfig.parse({schema_version:1,output_dir:root,duration_ms:1000});
 const manifest={schema_version:1,id,root,device:s.dev,inode:s.ino,config,config_hash:hash(config),budget:{domain:'soak-'+id,cpu_percent:config.cpu_percent,memory_mb:config.memory_mb,tasks_max:config.tasks_max}};
 const write=m=>writeFileSync(join(root,'manifest.json'),JSON.stringify(m));write(manifest);assert.equal(manifestAt(root).manifest.id,id);
 for(const patch of [{root:root+'-changed'},{inode:s.ino+1},{config:{...config,duration_ms:2000}},{budget:{...manifest.budget,domain:'soak-'+ 'b'.repeat(32)}},{budget:{...manifest.budget,memory_mb:1024}}]){write({...manifest,...patch});assert.throws(()=>manifestAt(root));}
});
const command=async(...args)=>JSON.parse((await exec(process.execPath,['dist/cli.js','soak',...args],{timeout:30000,maxBuffer:1048576})).stdout);
async function until(fn,timeout=90000){const end=performance.now()+timeout;while(performance.now()<end){const r=await fn();if(r)return r;await delay(100);}throw Error('soak test observation timeout');}
function setup(t,changes={}){
 const root=mkdtempSync(join(tmpdir(),'driver-soak-')),run=join(root,'run'),path=join(root,'config.json');
 writeFileSync(path,JSON.stringify({schema_version:1,output_dir:run,duration_ms:1000,interval_ms:0,max_cycles:20,...changes}));
 t.after(async()=>{if(existsSync(join(run,'launch.json')))await command('stop','--run',run);});
 return {root,run,path};
}
test('runtime contract soak rejects unbounded unknown and invalid configuration',()=>{
 const input={schema_version:1,output_dir:'owned',duration_ms:1000};
 assert.equal(soakConfig.parse(input).memory_mb,768);
 for(const patch of [{duration_ms:0},{duration_ms:72*3600000+1},{cpu_percent:200},{memory_mb:99999},{max_cycles:0},{command:'shell'}])assert.equal(soakConfig.safeParse({...input,...patch}).success,false);
});

test('runtime native soak operator stop is incomplete and retains run identity',{timeout:90000},async t=>{
 const x=setup(t,{duration_ms:120000,interval_ms:60000});await command('start','--config-file',x.path);
 await until(()=>existsSync(join(x.run,'progress.json')));
 const before=await command('status','--run',x.run);assert.equal(before.state,'running');assert.ok(before.progress.cycles>=1);
 const stopped=await command('stop','--run',x.run);assert.equal(stopped.owned_domain_stopped,true);
 assert.equal(stopped.report.state,'stopped');assert.equal(stopped.report.status,'NOT_RUN');assert.equal(stopped.report.two_hour_gate,'NOT_RUN');
 const after=await command('status','--run',x.run);assert.equal(after.id,before.id);assert.equal(after.process_liveness,'dead');
});

test('runtime native soak abrupt runner loss is interrupted not success and explicit stop reaps owned domain',{timeout:90000},async t=>{
 const x=setup(t,{duration_ms:120000,interval_ms:60000});await command('start','--config-file',x.path);
 await until(()=>existsSync(join(x.run,'progress.json')));
 const manifest=readJson(join(x.run,'manifest.json')),heartbeat=readJson(join(x.run,'heartbeat.json'));
 assert.equal(await liveness(heartbeat.identity),'alive');const handle=await inspectBudget(manifest.budget);assertBudgetMembership(handle,heartbeat.identity.pid);
 process.kill(heartbeat.identity.pid,'SIGKILL');await until(async()=>await liveness(heartbeat.identity)==='dead');
 const status=await command('status','--run',x.run);assert.equal(status.state,'interrupted');assert.equal(status.report,null);
 const stopped=await command('stop','--run',x.run);assert.equal(stopped.owned_domain_stopped,true);assert.equal(stopped.state,'interrupted');
});

test('runtime native soak cycle bound before elapsed duration is failure not shortened success',{timeout:90000},async t=>{
 const x=setup(t,{duration_ms:60000,max_cycles:1});await command('start','--config-file',x.path);
 const report=await until(()=>existsSync(join(x.run,'report.json'))&&readJson(join(x.run,'report.json')));
 assert.equal(report.status,'FAIL');assert.equal(report.error,'SOAK_CYCLE_LIMIT_BEFORE_DURATION');assert.equal(report.two_hour_gate,'NOT_RUN');assert.equal(report.cycles,1);
});

test('runtime native soak exercises every scheduled fault with persistent state and independent counters',{timeout:300000},async t=>{
 const x=setup(t,{duration_ms:200000,max_cycles:500});await command('start','--config-file',x.path);
 const report=await until(()=>existsSync(join(x.run,'report.json'))&&readJson(join(x.run,'report.json')),270000);
 assert.equal(report.status,'PASS',JSON.stringify(report));assert.ok(report.active_duration_ms>=120000);assert.equal(report.two_hour_gate,'NOT_RUN');
 const rows=readFileSync(join(x.run,'journal.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 for(const scenario of new Set(schedule))assert.ok(rows.some(r=>r.kind==='case'&&r.scenario===scenario),'missing '+scenario);
 assert.ok(report.metrics.recovery.automatic_recovery>0);assert.ok(report.metrics.recovery.explicit_resume>0);
 assert.equal(report.metrics.false_success_and_duplicates.false_success,0);assert.equal(report.metrics.false_success_and_duplicates.duplicate_effects,0);assert.equal(report.metrics.false_success_and_duplicates.duplicate_cli_receipts,0);
 assert.equal(report.cleanup,'confirmed');assert.deepEqual(report.inputs_changed,[]);
});
test('runtime contract soak metrics separate successful work, correct stops, duplicates and unobserved domains',()=>{
 const result=metrics([
  {workload:'browser',expected_outcome:'succeeded',observed_status:'succeeded',effect_count:1,record_matches:true,status:'PASS'},
  {workload:'browser',expected_outcome:'reconciliation_required',observed_status:'reconciliation_required',effect_count:0,status:'PASS'},
  {workload:'browser',expected_outcome:'succeeded',observed_status:'succeeded',effect_count:2,record_matches:false,status:'FAIL'},
  {workload:'synthetic_cli',receipt_count:2,status:'FAIL'}
 ],[]);
 assert.equal(result.task_success.overall_completion_rate,1/3);assert.equal(result.task_success.eligible_success_rate,.5);
 assert.equal(result.recovery.correct_stops,1);assert.equal(result.false_success_and_duplicates.false_success,1);
 assert.equal(result.false_success_and_duplicates.duplicate_effects,1);assert.equal(result.false_success_and_duplicates.duplicate_cli_receipts,1);
 assert.equal(result.interference.windows_foreground,'unobserved');assert.equal(result.interventions.technical_manual,'unobserved');assert.equal(result.recovery_time.p95_ms,'unobserved');
});
test('runtime native soak journal rejects redirected and multiply linked targets without changing sentinel',()=>{
 const root=mkdtempSync(join(tmpdir(),'driver-soak-io-')),sentinel=join(root,'sentinel');writeFileSync(sentinel,'untouched');
 const a=join(root,'a'),b=join(root,'b');mkdirSync(a);mkdirSync(b);symlinkSync(sentinel,join(a,'journal.jsonl'));linkSync(sentinel,join(b,'journal.jsonl'));
 assert.throws(()=>journal(a,{record:1}));assert.throws(()=>journal(b,{record:1}));assert.equal(readFileSync(sentinel,'utf8'),'untouched');
 assert.throws(()=>readJson(join(a,'journal.jsonl')));
});
test('runtime native soak survives start CLI exit, preserves real effects and reports actual finite duration',{timeout:120000},async t=>{
 const x=setup(t),started=await command('start','--config-file',x.path);
 assert.equal(started.accepted,true);assert.equal(started.independent_service,true);
 assert.equal(started.resource.status,'enforced');
 await assert.rejects(command('start','--config-file',x.path),/SOAK_DESTINATION_EXISTS_OR_UNSAFE/);
 const report=await until(()=>existsSync(join(x.run,'report.json'))&&JSON.parse(readFileSync(join(x.run,'report.json'),'utf8')));
 assert.equal(report.status,'PASS',JSON.stringify(report));assert.ok(report.active_duration_ms>=1000);
 assert.equal(report.cleanup,'confirmed');assert.equal(report.two_hour_gate,'NOT_RUN');
 assert.equal(report.metrics.false_success_and_duplicates.duplicate_effects,0);
 assert.equal(report.metrics.recovery.correct_stops,1);assert.ok(report.metrics.task_success.completed>=1);assert.ok(report.metrics.task_success.synthetic_cli_pass>=1);
 assert.deepEqual(report.inputs_changed,[]);assert.equal(report.actual_cli,false);assert.equal(report.model_calls,0);
 const status=await command('status','--run',x.run);assert.equal(status.state,'completed');
 const first=await command('stop','--run',x.run);assert.equal(first.owned_domain_stopped,true);
 const second=await command('stop','--run',x.run);assert.equal(second.owned_domain_stopped,true);
});
