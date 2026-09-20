import {mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {startFixture} from '../../dist/evaluation-v2/fixture.js';
import {makeCase} from '../../dist/evaluation-v2/oracle.js';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {inspectBudget,readBudget,assertBudgetMembership} from '../../dist/resources/budget.js';
import {measureStorage} from '../../dist/storage/budget.js';
import {processIdentity,liveness,profileOccupancy,bootClock} from '../../dist/supervisor/identity.js';
import {pingTerminalHost,stopTerminalHost} from '../../dist/terminal/manager.js';
import {evidenceInputs,changedInputs} from './evidence-inputs.mjs';
import {schedule,metrics,twoHourGate} from './soak-contract.mjs';
import {manifestAt,atomicJson,journal,check} from './soak-io.mjs';

export async function runSoak(input){
 const {root,manifest}=manifestAt(input),config=manifest.config,handle=await inspectBudget(manifest.budget);
 assertBudgetMembership(handle);const identity=await processIdentity(process.pid);check(typeof identity==='object','SOAK_IDENTITY_UNOBSERVED');
 const start=performance.now(),cases=[],samples=[],actors=[],lanes=[];
 let state='running',error='unobserved',cycles=0,activeStart=null,activeEnd=null,heartbeat,lastProgress=0,terminal,fixture,sessionId,sessionSerial=0,cleanup='unobserved';
 // Unexpected acknowledged-turn loss and streaming cancellation deliberately consume
 // session capacity. Inject each once, then re-observe the same unresolved boundary.
 const retainedHazards={cli_crash:null,output_load:null};
 const elapsed=()=>performance.now()-start;
 const stopped=()=>existsSync(join(root,'stop.json'));
 const checkStop=()=>check(!stopped(),'SOAK_STOPPED');
 const emit=record=>{journal(root,{...record,elapsed_ms:elapsed()});lastProgress=elapsed();};
 const activeDuration=()=>activeStart===null?'unobserved':(activeEnd??performance.now())-activeStart;
 const summary=()=>({schema_version:1,id:manifest.id,state,status:state==='completed'?'PASS':state==='failed'?'FAIL':'NOT_RUN',error,requested_duration_ms:config.duration_ms,active_duration_ms:activeDuration(),total_elapsed_ms:elapsed(),cycles,case_count:cases.length,metrics:metrics(cases,samples),last_case:cases.at(-1)??'unobserved',cleanup,actual_cli:false,model_calls:0,inputs_changed:changedInputs(manifest.inputs,evidenceInputs()),two_hour_gate:twoHourGate(config.duration_ms,activeDuration(),state,cycles,cases.map(c=>c.scenario))});
 const beat=()=>{
  const clock=bootClock();atomicJson(root,'heartbeat.json',{identity,boot_id:clock.bootId,uptime_ms:clock.uptimeMs,elapsed_ms:elapsed(),last_progress_elapsed_ms:lastProgress,cycles,state});
 };
 const sample=()=>{
  const usage=readBudget(handle),storage=measureStorage(root);
  check(storage.accounted_bytes<=config.max_bytes,'SOAK_STORAGE_LIMIT');
  check(usage.memory_events.oom_kill===0&&usage.pid_events.max===0,'SOAK_RESOURCE_DENIAL');
  const row={kind:'sample',elapsed_ms:elapsed(),memory_current:usage.memory_current,memory_peak:usage.memory_peak,tasks_current:usage.tasks_current,data_bytes:storage.accounted_bytes,cpu:usage.cpu,memory_events:usage.memory_events,pid_events:usage.pid_events};
  samples.push(row);journal(root,row);beat();
 };
 const until=async(fn,timeout=75000)=>{
  const end=performance.now()+timeout;
  while(performance.now()<end){checkStop();const value=await fn();if(value)return value;await delay(50);}
  throw Error('SOAK_OBSERVATION_TIMEOUT');
 };
 const actor=async lane=>{
  const child=fork(fileURLToPath(new URL('./soak-actor.mjs',import.meta.url)),['supervisor',lane.path],{stdio:['ignore','ignore','ignore','ipc']});
  const rec={child,events:[],exit:once(child,'exit')};actors.push(rec);
  child.on('message',m=>{rec.events.push(m);if(rec.events.length>1000)rec.events.shift();});
  await until(()=>rec.events.some(e=>e.kind==='ready'),15000);lane.actor=rec;return rec;
 };
 const ownedKill=async id=>{
  check(id&&await liveness(id)==='alive','SOAK_KILL_IDENTITY_MISMATCH');assertBudgetMembership(handle,id.pid);
  process.kill(id.pid,'SIGKILL');await until(async()=>await liveness(id)==='dead',10000);
 };
 const makeLane=async(name,policy)=>{
  const dir=join(root,name);mkdirSync(dir,{mode:0o700});
  const spec=makeCase('soak-'+manifest.id+'-'+name,'S02',101,'normal'),url=fixture.create(spec),path=join(dir,'host.json');
  writeFileSync(path,JSON.stringify({schema_version:1,project_id:name,caller_ref:'soak-fixture',account_ref:'account-a',worktree:dir,data_dir:join(dir,'data'),environment:'fixture',fixture_url:url,recovery_policy:policy,resources:manifest.budget,storage:{max_bytes:134217728,min_free_bytes:67108864}}),{mode:0o600});
  const c=loadHostConfig(path),api=new RuntimeApi(c),lane={name,spec,path,config:c,api};lanes.push(lane);await actor(lane);return lane;
 };
 const browser=async(lane,scenario,number)=>{
  const request_id='soak-'+number+'.'+scenario,input={name:'task '+number,note:'owned fixture '+number};
  const record={kind:'case',cycle:number,scenario,workload:'browser',expected_outcome:scenario==='uncertain'?'reconciliation_required':'succeeded',status:'NOT_RUN',effect_count:'unobserved',record_matches:'unobserved',observed_status:'unobserved',account_sentinel_ok:'unobserved',harness_actions:0,fault_path:['claimed','prepare','after_save','uncertain'].includes(scenario)?'checkpoint_pending':'not_applicable'};
  const before=fixture.snapshot(lane.spec.runId).effects.filter(e=>e.kind==='save').length,at=performance.now();let task;
  try{
   const args={request_id,capability:'fixture.draft.save',account_ref:'account-a',input,deadline_ms:60000};
   const accepted=await lane.api.call('runtime_task_start',args);task=accepted.task_id;
   check((await lane.api.call('runtime_task_start',args)).task_id===task,'SOAK_DUPLICATE_TASK');
   let preparedBeforeCheckpoint=false;
   if(['claimed','prepare','after_save','uncertain'].includes(scenario)){
    const observed=await until(()=>{
      const checkpoint=lane.actor.events.find(e=>e.kind==='checkpoint'&&e.task===task);
      if(checkpoint)return {kind:'checkpoint',checkpoint};
      // prepare_only intentionally ends a pre-claim startup timeout in a
      // non-executable ready state.  That is a valid safety boundary, not an
      // excuse to wait for a checkpoint that can no longer exist.
      const row=lane.api.store.submission(task);
      if(scenario==='prepare'&&['done','blocked','prepared'].includes(row.recovery_state))return {kind:'prepared',outcome:lane.api.store.outcome(task)};
      return false;
    });
    if(observed.kind==='checkpoint'){
      const {checkpoint}=observed;
      lane.actor.child.send({kind:'kill',task,generation:checkpoint.generation});record.harness_actions++;
      // IPC exit delivery races with the supervisor's recovery loop.  Bind the
      // injector acknowledgement to this generation, then prove the profile is
      // released before asking the product to recover; do not make a pass depend
      // on the order in which an informational exit event arrives.
      await until(()=>lane.actor.events.find(e=>e.kind==='kill_delivered'&&e.task===task&&e.generation===checkpoint.generation));
      await until(async()=>await profileOccupancy(lane.config.project.profileRef)==='clear');
      record.fault_path='checkpoint_kill';record.recovery_kind=scenario==='prepare'?'explicit':'automatic';record.recovery_ready_at_ms=elapsed();
    }else{
      check(observed.outcome.status==='ready_to_resume','SOAK_PREPARE_PRECHECKPOINT_STATE');
      const ready=await lane.api.call('runtime_recovery_prepare',{task_id:task,expected_recovery_generation:observed.outcome.recovery_generation});
      check(ready.automatic_execution===false,'SOAK_PREPARE_PRECHECKPOINT_EXECUTED');
      await lane.api.call('runtime_task_resume',{task_id:task,expected_recovery_generation:observed.outcome.recovery_generation});
      preparedBeforeCheckpoint=true;record.fault_path='startup_timeout_pre_checkpoint';record.recovery_kind='explicit';record.recovery_ready_at_ms=elapsed();record.harness_actions++;
    }
   }
   const result=await until(()=>{const row=lane.api.store.submission(task);return ['done','blocked','prepared'].includes(row.recovery_state)?lane.api.store.outcome(task):false;});
   if(scenario==='prepare'&&!preparedBeforeCheckpoint){
    check(result.status==='ready_to_resume','SOAK_PREPARE_MISMATCH');
    const ready=await lane.api.call('runtime_recovery_prepare',{task_id:task,expected_recovery_generation:result.recovery_generation});check(ready.automatic_execution===false,'SOAK_PREPARE_EXECUTED');
    await lane.api.call('runtime_task_resume',{task_id:task,expected_recovery_generation:result.recovery_generation});record.harness_actions++;
    await until(()=>['done','blocked','prepared'].includes(lane.api.store.submission(task).recovery_state));
   }
   record.observed_status=lane.api.store.outcome(task).status;
   const snapshot=fixture.snapshot(lane.spec.runId);record.effect_count=snapshot.effects.filter(e=>e.kind==='save').length-before;
   record.record_matches=snapshot.records['account-a'].name===input.name&&snapshot.records['account-a'].note===input.note;
   record.account_sentinel_ok=snapshot.records['account-b'].name==='untouched'&&snapshot.records['account-b'].note==='sentinel';
   record.attempts=lane.api.store.submission(task).attempt_count;
   if(record.recovery_ready_at_ms!==undefined)record.recovery_ms=elapsed()-record.recovery_ready_at_ms;
   record.status=record.observed_status===record.expected_outcome&&record.effect_count===(scenario==='uncertain'?0:1)&&record.record_matches===(scenario!=='uncertain')&&record.account_sentinel_ok?'PASS':'FAIL';
  }catch(e){record.status=e.message==='SOAK_STOPPED'?'NOT_RUN':'FAIL';record.error=/^[A-Z_]+$/.test(e.message)?e.message:'SOAK_CASE_FAILED';throw e;}
  finally{
   record.duration_ms=performance.now()-at;
   if(task){
    record.observed_status=lane.api.store.outcome(task).status;
    const snapshot=fixture.snapshot(lane.spec.runId);record.effect_count=snapshot.effects.filter(e=>e.kind==='save').length-before;
    record.record_matches=snapshot.records['account-a'].name===input.name&&snapshot.records['account-a'].note===input.note;
    record.account_sentinel_ok=snapshot.records['account-b'].name==='untouched'&&snapshot.records['account-b'].note==='sentinel';
    const events=lane.api.store.events(lane.config.project.id,'soak-diagnostic',1000);
    record.diagnostics=events.filter(e=>e.task_id===task&&['worker.progress','worker.failure','recovery.observed','task.state'].includes(e.kind)).map(e=>({kind:e.kind,data:e.data}));
    if(events.length)lane.api.store.ack(lane.config.project.id,'soak-diagnostic',events.at(-1).id);
   }
   cases.push(record);emit(record);
  }
  check(record.status==='PASS','SOAK_BROWSER_ORACLE_FAILED');return task;
 };
 const receiptCount=turn=>{
  const file=join(root,'terminal','received.jsonl');if(!existsSync(file))return 0;
  const text=readFileSync(file,'utf8');check(Buffer.byteLength(text)<=16777216,'SOAK_RECEIPT_LIMIT');
  return text.trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.uuid===turn).length;
 };
 const startSession=async()=>{
  const a=await terminal.api.call('runtime_terminal_start',{request_id:'session-'+sessionSerial++});
  await until(()=>terminal.api.store.session(a.session_ref).state==='input_ready',15000);sessionId=a.session_ref;
 };
 const interrupt=async id=>{
  const s=terminal.api.store.session(id);
  await terminal.api.call('runtime_terminal_interrupt',{session_ref:id,expected_generation:s.generation});
  await until(()=>terminal.api.store.session(id).state==='process_exited',10000);
 };
 const cli=async(scenario,number)=>{
  const record={kind:'case',cycle:number,scenario,workload:'synthetic_cli',status:'NOT_RUN',receipt_count:'unobserved',harness_actions:0};
  let turn;const at=performance.now(),prompt='fixture turn '+number;
  if(scenario==='cli_crash'&&retainedHazards.cli_crash){
   const prior=retainedHazards.cli_crash;
   try{
    const crashed=terminal.api.store.session(prior.session),priorTurn=terminal.api.store.turn(prior.turn);
    check(crashed.state==='reconciliation_required'&&crashed.error_code==='PROCESS_EXITED'&&crashed.active_turn_id===null&&priorTurn.status==='uncertain','SOAK_RETAINED_CLI_CRASH_CHANGED');
    let resumeRejected=false;try{await terminal.api.call('runtime_terminal_resume',{session_ref:prior.session,expected_generation:crashed.generation});}catch{resumeRejected=true;}
    check(resumeRejected,'SOAK_RETAINED_CLI_CRASH_RESUME_ALLOWED');
    record.observed_status=priorTurn.status;record.receipt_count=receiptCount(prior.turn);record.fault_injected=false;record.status=record.receipt_count===1?'PASS':'FAIL';
   }catch(e){record.status='FAIL';record.error=/^[A-Z_]+$/.test(e.message)?e.message:'SOAK_CLI_STATE_CHECK_FAILED';throw e;}
   finally{record.duration_ms=performance.now()-at;cases.push(record);emit(record);}
   check(record.status==='PASS','SOAK_CLI_ORACLE_FAILED');return;
  }
  if(!sessionId)await startSession();
  let s=terminal.api.store.session(sessionId);if(s.turn_count>=80){await interrupt(sessionId);await startSession();s=terminal.api.store.session(sessionId);}
  try{
   if(scenario==='cli_crash')writeFileSync(join(root,'terminal','mode.txt'),'after-ack');
   const request={request_id:'prompt-'+number,session_ref:sessionId,expected_generation:s.generation,expected_previous_turn_id:s.last_turn_id,prompt};
   const accepted=await terminal.api.call('runtime_terminal_submit_prompt',request);turn=accepted.turn_id;
   check((await terminal.api.call('runtime_terminal_submit_prompt',request)).turn_id===turn,'SOAK_DUPLICATE_TURN');
   if(scenario==='cli_crash'){
    await until(()=>terminal.api.store.turn(turn).status==='acknowledged');
    await ownedKill(JSON.parse(terminal.api.store.session(sessionId).process_identity_json));record.harness_actions++;
    // A killed acknowledged turn is deliberately uncertain, not a cleanly resumable
    // process exit. Wait for the durable safety transition and prove resume is refused.
    await until(()=>{const row=terminal.api.store.session(sessionId);return terminal.api.store.turn(turn).status==='uncertain'&&row.active_turn_id===null;});
    const crashed=terminal.api.store.session(sessionId);
    check(crashed.state==='reconciliation_required'&&crashed.error_code==='PROCESS_EXITED','SOAK_CLI_CRASH_STATE');
    let resumeRejected=false;try{await terminal.api.call('runtime_terminal_resume',{session_ref:sessionId,expected_generation:crashed.generation});}catch{resumeRejected=true;}
    check(resumeRejected,'SOAK_CLI_CRASH_RESUME_ALLOWED');
    record.observed_status=terminal.api.store.turn(turn).status;record.fault_injected=true;record.status=record.observed_status==='uncertain'?'PASS':'FAIL';
    retainedHazards.cli_crash={session:sessionId,turn};
    writeFileSync(join(root,'terminal','mode.txt'),'normal');sessionId=null;
   }else{
    await until(()=>terminal.api.store.session(sessionId).state==='input_ready');
    const t=terminal.api.store.turn(turn),result=JSON.parse(t.result_json);
    record.observed_status=t.status;record.status=t.status==='turn_completed'&&result.text===prompt&&result.project_completed===false?'PASS':'FAIL';
    if(['cli_resume','host_restart'].includes(scenario)){
     const before=terminal.api.store.session(sessionId),startRecovery=performance.now();
     if(scenario==='host_restart'){
      await ownedKill(JSON.parse(terminal.api.store.terminalHost(terminal.config.project.id).identity_json));
      await until(async()=>await liveness(JSON.parse(before.process_identity_json))==='dead',10000);
     }else await interrupt(sessionId);
     await terminal.api.call('runtime_terminal_resume',{session_ref:sessionId,expected_generation:before.generation});
     await until(()=>terminal.api.store.session(sessionId).state==='input_ready');
     const after=terminal.api.store.session(sessionId);check(after.generation===before.generation+1&&after.cli_session_id===before.cli_session_id,'SOAK_RESUME_BINDING');
     record.recovery_kind='explicit';record.recovery_ms=performance.now()-startRecovery;record.harness_actions+=2;
    }
   }
   record.receipt_count=receiptCount(turn);if(record.receipt_count!==1)record.status='FAIL';
  }catch(e){record.status=e.message==='SOAK_STOPPED'?'NOT_RUN':'FAIL';record.error=/^[A-Z_]+$/.test(e.message)?e.message:'SOAK_CLI_FAILED';throw e;}
  finally{if(turn)record.receipt_count=receiptCount(turn);record.duration_ms=performance.now()-at;cases.push(record);emit(record);}
  check(record.status==='PASS','SOAK_CLI_ORACLE_FAILED');
 };
 try{
  beat();heartbeat=setInterval(()=>{try{sample();}catch{state='failed';error='SOAK_SAMPLE_FAILED';}},5000);
  fixture=await startFixture();
  const auto=await makeLane('auto','auto_resume'),prepare=await makeLane('prepare','prepare_only'),uncertain=await makeLane('uncertain','auto_resume');
  const dir=join(root,'terminal');mkdirSync(dir,{mode:0o700});const executable=join(dir,'synthetic-cli.mjs');
  const helper=new URL('../../tests/helpers/terminal-fixture.mjs',import.meta.url).href;
  // Explicit fixture version emulation; never evidence of an installed Claude CLI.
  writeFileSync(executable,'#!/usr/bin/env node\n'+
   'if(process.argv.includes("--version")){console.log("2.1.126 (Claude Code)");process.exit(0);}\n'+
   'const args=process.argv.slice(2),i=args.findIndex(x=>x==="--session-id"||x==="--resume");if(i<0)throw Error("FIXTURE_SESSION_REQUIRED");\n'+
   'process.argv=[process.execPath,process.argv[1],args[i+1],process.cwd()];await import('+JSON.stringify(helper)+');\n',{mode:0o700});
  const path=join(dir,'host.json');writeFileSync(path,JSON.stringify({schema_version:1,project_id:'terminal',caller_ref:'soak-fixture',account_ref:'synthetic',worktree:dir,data_dir:join(dir,'data'),resources:manifest.budget,storage:{max_bytes:134217728,min_free_bytes:67108864},terminal:{executable,version:'2.1.126',max_turns:100,turn_deadline_ms:60000,spool_bytes:16777216}}),{mode:0o600});
  const c=loadHostConfig(path);terminal={config:c,api:new RuntimeApi(c)};
  const uncertainTask=await browser(uncertain,'uncertain',-1);
  activeStart=performance.now();emit({kind:'workload_started',setup_ms:elapsed()});
  while(performance.now()-activeStart<config.duration_ms){
   checkStop();check(state==='running','SOAK_BACKGROUND_OBSERVER_FAILED');
   check(cycles<config.max_cycles,'SOAK_CYCLE_LIMIT_BEFORE_DURATION');
   check(changedInputs(manifest.inputs,evidenceInputs()).length===0,'SOAK_INPUT_CHANGED');
   const tick=performance.now(),scenario=schedule[cycles%schedule.length];
   if(scenario==='supervisor_restart'){
    auto.actor.child.kill('SIGKILL');await auto.actor.exit;await actor(auto);emit({kind:'harness_action',action:'supervisor_restart'});
   }
   if(cycles>0&&cycles%8===0){
    // Reconnect the gateway objects without closing the long-lived product hosts.
    auto.api.close();auto.api=new RuntimeApi(auto.config);
    terminal.api.close();terminal.api=new RuntimeApi(terminal.config);emit({kind:'harness_action',action:'gateway_reconnect'});
   }
   await browser(scenario==='prepare'?prepare:auto,['claimed','prepare','after_save'].includes(scenario)?scenario:'normal',cycles);
   let load;
   if(scenario==='output_load'&&!retainedHazards.output_load){
    const a=await terminal.api.call('runtime_terminal_start',{request_id:'load-'+cycles});load=a.session_ref;
    await until(()=>terminal.api.store.session(load).state==='input_ready');
    const s=terminal.api.store.session(load);
    const t=await terminal.api.call('runtime_terminal_submit_prompt',{request_id:'stream-'+cycles,session_ref:load,expected_generation:s.generation,expected_previous_turn_id:null,prompt:'owned-load-stream'});
    await until(()=>terminal.api.store.turn(t.turn_id).status==='acknowledged');
    load={id:load,turn:t.turn_id};
   }
   await cli(scenario,cycles);
   if(load){
    const at=performance.now(),ok=await pingTerminalHost(terminal.api.store.terminalHost(terminal.config.project.id));
    check(ok&&performance.now()-at<1000,'SOAK_CONTROL_UNRESPONSIVE');
    const loadSession=terminal.api.store.session(load.id);
    await terminal.api.call('runtime_terminal_interrupt',{session_ref:load.id,expected_generation:loadSession.generation});
    await until(()=>{const row=terminal.api.store.session(load.id);return terminal.api.store.turn(load.turn).status==='uncertain'&&row.active_turn_id===null;});
    const stoppedLoad=terminal.api.store.session(load.id);
    check(stoppedLoad.state==='reconciliation_required'&&stoppedLoad.error_code==='INTERRUPTED'&&receiptCount(load.turn)===1,'SOAK_LOAD_REPLAY_OR_FALSE_SUCCESS');
    retainedHazards.output_load={session:load.id,turn:load.turn};
    emit({kind:'load',cycle:cycles,receipt_count:1,expected_stop:'uncertain',fault_injected:true});
   }else if(scenario==='output_load'){
    const prior=retainedHazards.output_load,loadState={kind:'case',cycle:cycles,scenario,workload:'synthetic_cli_state_check',status:'NOT_RUN',fault_injected:false,receipt_count:'unobserved'};
    try{
     check(prior,'SOAK_RETAINED_LOAD_MISSING');const row=terminal.api.store.session(prior.session),turn=terminal.api.store.turn(prior.turn);
     check(row.state==='reconciliation_required'&&row.error_code==='INTERRUPTED'&&row.active_turn_id===null&&turn.status==='uncertain','SOAK_RETAINED_LOAD_CHANGED');
     loadState.receipt_count=receiptCount(prior.turn);loadState.status=loadState.receipt_count===1?'PASS':'FAIL';
    }catch(e){loadState.status='FAIL';loadState.error=/^[A-Z_]+$/.test(e.message)?e.message:'SOAK_LOAD_STATE_CHECK_FAILED';throw e;}
    finally{cases.push(loadState);emit(loadState);}
    check(loadState.status==='PASS','SOAK_LOAD_REPLAY_OR_FALSE_SUCCESS');
   }
   check(uncertain.api.store.outcome(uncertainTask).status==='reconciliation_required'&&fixture.snapshot(uncertain.spec.runId).effects.length===0,'SOAK_UNCERTAIN_REPLAY');
   const events=auto.api.store.events(auto.config.project.id,'soak-delivery',1000);
   check(JSON.stringify(events)===JSON.stringify(auto.api.store.events(auto.config.project.id,'soak-delivery',1000)),'SOAK_REDELIVERY_CHANGED');
   if(events.length)auto.api.store.ack(auto.config.project.id,'soak-delivery',events.at(-1).id);
   cycles++;sample();atomicJson(root,'progress.json',summary());
   while(performance.now()-tick<config.interval_ms&&performance.now()-activeStart<config.duration_ms){checkStop();await delay(Math.min(200,config.interval_ms));}
  }
  check(twoHourGate(config.duration_ms,activeDuration(),'completed',cycles,cases.map(c=>c.scenario))!=='FAIL','SOAK_COVERAGE_INCOMPLETE');
  state='completed';
 }catch(e){state=e.message==='SOAK_STOPPED'?'stopped':'failed';error=/^[A-Z_]+$/.test(e.message)?e.message:'SOAK_EXECUTION_FAILED';}
 finally{
  activeEnd=performance.now();
  if(heartbeat)clearInterval(heartbeat);
  try{
   // Stop only our registered terminal host; its owned unit reaps CLI descendants.
   if(terminal){const stopped=await stopTerminalHost(terminal.config);check(stopped.stopped,'SOAK_TERMINAL_STOP_FAILED');}
   for(const lane of lanes){
    const rec=lane.actor;if(rec.child.exitCode===null&&rec.child.signalCode===null){rec.child.kill('SIGTERM');await rec.exit;}
    for(const row of lane.api.store.submissions(lane.config.project.id))if(row.worker_identity_json){
     const id=JSON.parse(row.worker_identity_json);if(await liveness(id)!=='dead'){
      // No blind kill/restart of a claimed write. Keep evidence; operator may stop this unique domain.
      throw Error('SOAK_WORKER_CLEANUP_UNRESOLVED');
     }
    }
   }
   cleanup='confirmed';
  }catch{cleanup='unconfirmed';if(state==='completed')state='failed';if(error==='unobserved')error='SOAK_CLEANUP_UNCONFIRMED';}
  for(const lane of lanes)lane.api.close();terminal?.api.close();await fixture?.close();
  if(changedInputs(manifest.inputs,evidenceInputs()).length){state='failed';error='SOAK_INPUT_CHANGED';}
  const result=summary();atomicJson(root,'report.json',result);emit({kind:'finished',state,status:result.status});beat();
 }
}
