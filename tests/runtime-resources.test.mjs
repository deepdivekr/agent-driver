import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile,spawn} from 'node:child_process';
import {readFileSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {resourceBudgetSchema,budgetIdentity,ensureBudget,inspectBudget,readBudget,assertBudgetMembership,
  launchResourceUnit,resourceUnit,managerEnvironment} from '../dist/resources/budget.js';
const exec=promisify(execFile),fixture=new URL('./helpers/resource-load.mjs',import.meta.url).pathname;
import {runSandbox} from '../dist/terminal/verify-files.js';
import {processIdentitySync} from '../dist/supervisor/identity.js';
import {loadHostConfig} from '../dist/interface/config.js';
import {RuntimeApi} from '../dist/interface/api.js';
import {startFixture} from '../dist/evaluation-v2/fixture.js';
import {makeCase} from '../dist/evaluation-v2/oracle.js';
import {stopSupervisor} from '../dist/supervisor/manager.js';
import {stopTerminalHost} from '../dist/terminal/manager.js';
const budget=(overrides={})=>({domain:'test-'+randomUUID(),cpu_percent:20,memory_mb:128,tasks_max:64,...overrides});
async function until(fn,ms=6000){const end=performance.now()+ms;while(performance.now()<end){if(await fn())return;await delay(25);}throw Error('resource barrier timeout');}
async function setup(t,overrides={}){
  const limits=budget(overrides),handle=await ensureBudget(limits),scopes=[];
  t.after(async()=>{
    for(const scope of scopes)await scope.stop();
    const checked=await inspectBudget(limits);
    assert.equal(readBudget(checked).events.populated,0,'do not stop a populated budget');
    // Only this test's random domain; no external launcher can know this private fixture ID.
    await exec('/usr/bin/systemctl',['--user','stop',handle.unit],{env:managerEnvironment(),timeout:5000});
  });
  const launch=async(mode,{start=true}={})=>{
    const scope=await launchResourceUnit(limits,process.execPath,[fixture,mode],{},mode==='memory'?30000:10000);scopes.push(scope);
    let stdout='',stderr='';scope.child.stdout.on('data',b=>stdout+=b);scope.child.stderr.on('data',b=>stderr+=b);
    scope.child.stdin.on('error',()=>{});
    const done=new Promise((resolve,reject)=>{scope.child.once('error',reject);scope.child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
    try {await until(()=>stdout.includes('\n')||scope.child.exitCode!==null,15000);}
    catch (error) {
      const state=await resourceUnit(scope.unit);
      throw Error('resource barrier timeout '+JSON.stringify({mode,stdout,stderr,exitCode:scope.child.exitCode,signalCode:scope.child.signalCode,state}));
    }
    assert.ok(stdout.includes('\n'),'scope must start inside a verified resource domain: '+stderr);
    const info=JSON.parse(stdout.split('\n')[0]);assertBudgetMembership(handle,info.pid,scope.unit);
    if(start)scope.child.stdin.write('run\n');
    return {...scope,done,info,output:()=>stdout};
  };
  return {limits,handle,scopes,launch};
}

test('runtime contract resource budgets reject unbounded, inherited, malformed and oversized settings',()=>{
  for(const change of [{cpu_percent:0},{cpu_percent:201},{memory_mb:63},{memory_high_mb:129},{tasks_max:0},{domain:'../user.slice'},{approved:true}])
    assert.throws(()=>resourceBudgetSchema.parse({...budget(),...change}));
  const a=budget({domain:'stable'}),b={...a,cpu_percent:30};
  assert.equal(budgetIdentity(a).unit,budgetIdentity(b).unit);
  assert.notEqual(budgetIdentity(a).description,budgetIdentity(b).description);
});

test('runtime native resource slice reads actual limits and rejects other members or changed domain config',async t=>{
  const {limits,handle,launch}=await setup(t);
  assert.equal(readBudget(handle).limits.cpu_max,'20000 100000');
  assert.equal(readBudget(handle).limits.memory_max,128*1048576);
  assert.equal(readBudget(handle).limits.tasks_max,64);
  assert.throws(()=>assertBudgetMembership(handle),/OUTSIDE_BOUNDARY/);
  await assert.rejects(ensureBudget({...limits,cpu_percent:40}),/NOT_OWNED_OR_CHANGED/);
  const run=await launch('hold');
  assert.equal((await run.observe()).status,'observed');
  await run.stop();await run.done;
  assert.throws(()=>assertBudgetMembership({...handle,inode:handle.inode+1}),/IDENTITY_CHANGED/);
});

test('runtime native aggregate CPU quota throttles two concurrent scopes while unrelated sentinel survives',async t=>{
  const {handle,launch}=await setup(t,{memory_mb:256});
  const sentinel=spawn('/usr/bin/sleep',['20'],{stdio:'ignore'});t.after(()=>sentinel.kill());
  await new Promise((r,j)=>{sentinel.once('spawn',r);sentinel.once('error',j);});
  const sentinelMembership=readFileSync('/proc/'+sentinel.pid+'/cgroup','utf8');
  // Both targets must be ready before either consumes the shared CPU quota.
  // Starting the first load during the second bootstrap made readiness a race.
  const [a,b]=await Promise.all([launch('cpu',{start:false}),launch('cpu',{start:false})]);
  const before=readBudget(handle),started=performance.now();
  a.child.stdin.write('run\n');b.child.stdin.write('run\n');
  const results=await Promise.all([a.done,b.done]),elapsed=performance.now()-started,after=readBudget(handle);
  for(const result of results)assert.equal(result.code,0,JSON.stringify(result));
  assert.ok(after.cpu.nr_throttled>before.cpu.nr_throttled);
  const usedMs=(after.cpu.usage_usec-before.cpu.usage_usec)/1000;
  // Includes concurrent bootstrap monitoring; one quota period plus measurement margin.
  assert.ok(usedMs<=elapsed*0.20+200,`cpu ${usedMs}ms exceeds aggregate window ${elapsed}ms`);
  assert.equal(sentinel.exitCode,null);
  assert.equal(readFileSync('/proc/'+sentinel.pid+'/cgroup','utf8'),sentinelMembership);
});

test('runtime native resource PID limit rejects finite child attempts and counts kernel denials',async t=>{
  const {handle,launch}=await setup(t),before=readBudget(handle);
  const run=await launch('pids');
  await until(()=>run.output().trim().split('\n').length>=2);
  const observed=await run.observe();
  run.child.stdin.end('finish\n');
  const result=await run.done;
  assert.equal(result.code,0,result.stderr);
  const counts=JSON.parse(result.stdout.trim().split('\n').at(-1));
  assert.ok(counts.denied>0);assert.ok(counts.started<64);
  const after=readBudget(handle);
  // pids_localevents/older kernels attribute denial to the forking leaf; newer
  // kernels count the cgroup whose limit was hit. Both are real kernel evidence.
  assert.ok(observed.scope_metrics.pid_events.max>0 || after.pid_events.max>before.pid_events.max,
    JSON.stringify({counts,leaf:observed.scope_metrics.pid_events,before:before.pid_events,after:after.pid_events}));
  assert.equal(after.events.populated,0);
});

test('runtime native memory exhaustion stays inside the owned cgroup and records OOM without a false PASS',async t=>{
  const {handle,launch}=await setup(t,{cpu_percent:100,memory_high_mb:128}),before=readBudget(handle);
  const sentinel=spawn('/usr/bin/sleep',['20'],{stdio:'ignore'});t.after(()=>sentinel.kill());
  const run=await launch('memory'),result=await run.done,after=readBudget(handle);
  assert.notEqual(result.code,0);
  assert.ok(after.memory_events.oom_kill>before.memory_events.oom_kill,JSON.stringify({before,after,result}));
  assert.equal(after.limits.memory_max,134217728);
  assert.equal(sentinel.exitCode,null);
});

test('runtime native changed kernel limit is detected before target code starts',async t=>{
  const {limits,handle}=await setup(t);
  await exec('/usr/bin/systemctl',['--user','set-property','--runtime',handle.unit,'CPUQuota=30%'],{env:managerEnvironment()});
  try{
    assert.throws(()=>readBudget(handle),/LIMIT_CHANGED/);
    await assert.rejects(launchResourceUnit(limits,'/usr/bin/true',[]),/LIMIT_CHANGED/);
  } finally {
    await exec('/usr/bin/systemctl',['--user','set-property','--runtime',handle.unit,'CPUQuota=20%'],{env:managerEnvironment()});
  }
});

test('runtime native execution main SIGKILL removes its owned descendants, not just the direct child',async t=>{
  const {handle,launch}=await setup(t,{memory_mb:256}),run=await launch('descendant');
  await until(()=>run.output().trim().split('\n').length>=2);
  const descendant=JSON.parse(run.output().trim().split('\n')[1]).descendant;
  const observed=await run.observe(),main=Number(observed.state.MainPID);
  assertBudgetMembership(handle,main,run.unit);assertBudgetMembership(handle,descendant,run.unit);
  const identity=processIdentitySync(main);assert.equal(typeof identity,'object');
  assert.deepEqual(processIdentitySync(main),identity);
  process.kill(main,'SIGKILL');
  const result=await run.done;assert.notEqual(result.code,0);
  await until(()=>processIdentitySync(descendant)==='dead'&&readBudget(handle).events.populated===0);
});

test('runtime native bounded resource execution stops after its exact launching owner dies',async t=>{
  const {limits,handle}=await setup(t,{memory_mb:256});
  const parent=spawn(process.execPath,[new URL('./helpers/resource-parent.mjs',import.meta.url).pathname,JSON.stringify(limits)],{stdio:['pipe','pipe','pipe']});
  let output='',stderr='',unit=null;
  parent.stdout.on('data',b=>output+=b);parent.stderr.on('data',b=>stderr+=b);parent.stdin.on('error',()=>{});
  t.after(async()=>{
    if(parent.exitCode===null)parent.kill('SIGKILL');
    if(unit){
      const state=await resourceUnit(unit);
      if(state.LoadState!=='not-found'){
        assert.equal(state.ControlGroup,handle.cgroup+'/'+unit);
        await exec('/usr/bin/systemctl',['--user','stop',unit],{env:managerEnvironment(),timeout:5000});
      }
    }
  });
  await until(()=>output.trim().split('\n').length>=2);
  const records=output.trim().split('\n').map(JSON.parse);unit=records[0].unit;
  const target=records[1].pid;assertBudgetMembership(handle,target,unit);
  parent.stdin.write('run\n');
  await until(()=>output.trim().split('\n').length>=3);
  const descendant=JSON.parse(output.trim().split('\n')[2]).descendant;
  assertBudgetMembership(handle,descendant,unit);
  parent.kill('SIGKILL');
  await until(()=>processIdentitySync(target)==='dead'&&processIdentitySync(descendant)==='dead'&&readBudget(handle).events.populated===0,5000);
  assert.equal(stderr,'');
});

test('runtime native sandbox preserves its exact output and cancellation contract inside aggregate resources',async t=>{
  const {limits,handle}=await setup(t,{cpu_percent:100,memory_mb:256});
  const snapshot=mkdtempSync(join(tmpdir(),'apd-resource-snapshot-'));t.after(()=>rmSync(snapshot,{recursive:true,force:true}));
  const good=await runSandbox(snapshot,['--eval',"process.stdout.write('resource-isolated')"],'',4000,()=>false,limits);
  assert.equal(good.exit,0,JSON.stringify(good));assert.equal(good.reason,null);
  assert.equal(good.stdout,'resource-isolated');assert.equal(good.stderr,'');
  assert.equal(good.resources.after.limits.memory_max,268435456);
  const started=performance.now();
  const cancelled=await runSandbox(snapshot,['--eval','setTimeout(()=>{},15000)'],'',5000,()=>performance.now()-started>700,limits);
  assert.equal(cancelled.reason,'VERIFICATION_CANCELLED',JSON.stringify(cancelled));
  await until(()=>readBudget(handle).events.populated===0);
});

test('runtime native configured resource boundary contains actual supervisor worker and Chromium without changing save semantics',async t=>{
  const {limits,handle}=await setup(t,{cpu_percent:100,memory_mb:1024,tasks_max:256});
  const root=mkdtempSync(join(tmpdir(),'apd-resource-browser-')),fixture=await startFixture();
  const spec=makeCase('resource','S02',83,'normal'),url=fixture.create(spec),path=join(root,'host.json');
  writeFileSync(path,JSON.stringify({schema_version:1,project_id:'resource-browser',caller_ref:'test',account_ref:'account-a',
    worktree:root,data_dir:join(root,'data'),environment:'fixture',fixture_url:url,resources:limits}));
  const config=loadHostConfig(path),api=new RuntimeApi(config);
  try{
    const accepted=await api.call('runtime_task_start',{request_id:'resource-save',capability:'fixture.draft.save',account_ref:'account-a',
      input:{name:'자원 경계 🐈',note:'실제 headless 저장'},deadline_ms:20000});
    const supervisor=api.store.supervisor(config.project.id),identity=JSON.parse(supervisor.identity_json);
    assertBudgetMembership(handle,identity.pid);
    let chromeObserved=false,workerObserved=false;
    await until(()=>{
      const row=api.store.submission(accepted.task_id);
      if(row.worker_identity_json){
        const worker=JSON.parse(row.worker_identity_json);
        if(typeof processIdentitySync(worker.pid)==='object'){assertBudgetMembership(handle,worker.pid);workerObserved=true;}
      }
      const group=readFileSync('/proc/'+identity.pid+'/cgroup','utf8').trim().slice(3);
      for(const text of readFileSync('/sys/fs/cgroup'+group+'/cgroup.procs','utf8').trim().split('\n'))try{
        const pid=Number(text),args=readFileSync('/proc/'+pid+'/cmdline','utf8');
        if(args.includes('--user-data-dir='+config.project.profileRef)){assertBudgetMembership(handle,pid);chromeObserved=true;}
      }catch(e){if(e.code!=='ENOENT')throw e;}
      return api.store.task(accepted.task_id).status==='succeeded';
    },20000);
    assert.ok(workerObserved&&chromeObserved,'actual worker and profile-bound browser membership must both be observed');
    assert.equal(fixture.snapshot(spec.runId).effects.filter(e=>e.kind==='save').length,1);
    const health=await api.call('runtime_health',{});assert.equal(health.resource_boundary.status,'enforced');
    assert.equal(health.verified_for_environment,false);
  }finally{
    assert.equal((await stopSupervisor(config)).stopped,true);
    await until(()=>readBudget(handle).events.populated===0);
    api.close();await fixture.close();rmSync(root,{recursive:true,force:true});
  }
});

test('runtime fixture configured resource terminal host and CLI inherit one budget and survive gateway replacement',async t=>{
  const {limits,handle,scopes}=await setup(t,{cpu_percent:100,memory_mb:256,tasks_max:128});
  const root=mkdtempSync(join(tmpdir(),'apd-resource-terminal-')),path=join(root,'host.json');
  writeFileSync(path,JSON.stringify({schema_version:1,project_id:'resource-terminal',caller_ref:'test',account_ref:'test',
    worktree:root,data_dir:join(root,'data'),resources:limits,terminal:{executable:process.execPath,version:'2.1.126'}}));
  const config=loadHostConfig(path),host=await launchResourceUnit(limits,process.execPath,[new URL('./helpers/terminal-host.mjs',import.meta.url).pathname,path],{stdio:'ignore'});
  scopes.push(host);let api=new RuntimeApi(config);
  try{
    await until(()=>api.store.terminalHost(config.project.id)?.active);
    const accepted=await api.call('runtime_terminal_start',{request_id:'resource-cli'});
    await until(()=>api.store.session(accepted.session_ref).state==='input_ready');
    const s=api.store.session(accepted.session_ref),cli=JSON.parse(s.process_identity_json);
    assertBudgetMembership(handle,cli.pid);assertBudgetMembership(handle,JSON.parse(api.store.terminalHost(config.project.id).identity_json).pid);
    api.close();api=new RuntimeApi(config);
    const submitted=await api.call('runtime_terminal_submit_prompt',{request_id:'one',session_ref:s.id,expected_generation:1,expected_previous_turn_id:null,prompt:'자원 경계의 동일 CLI'});
    await until(()=>api.store.session(s.id).last_turn_id===submitted.turn_id);
    assert.equal(api.store.session(s.id).cli_session_id,s.cli_session_id);
    assert.equal(api.store.turn(submitted.turn_id).status,'turn_completed');
    assert.equal(readFileSync(join(root,'received.jsonl'),'utf8').trim().split('\n').length,1);
  }finally{
    assert.equal((await stopTerminalHost(config)).stopped,true);
    await until(()=>readBudget(handle).events.populated===0);
    api.close();rmSync(root,{recursive:true,force:true});
  }
});

test('runtime native in-flight budget changes terminate the owned execution tree without adopting relaxed limits',async t=>{
  const {handle,launch}=await setup(t,{memory_mb:256}),run=await launch('descendant');
  await until(()=>run.output().trim().split('\n').length>=2);
  const descendant=JSON.parse(run.output().trim().split('\n')[1]).descendant;
  try{
    await exec('/usr/bin/systemctl',['--user','set-property','--runtime',handle.unit,'CPUQuota=30%'],{env:managerEnvironment()});
    const result=await run.done;assert.notEqual(result.code,0);
    await until(()=>processIdentitySync(descendant)==='dead');
  }finally{
    await exec('/usr/bin/systemctl',['--user','set-property','--runtime',handle.unit,'CPUQuota=20%'],{env:managerEnvironment()});
  }
  assert.equal(readBudget(handle).events.populated,0);
});
