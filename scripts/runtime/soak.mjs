// Operator-only, finite synthetic workload. Never an agent authority/grant endpoint.
import {mkdirSync,lstatSync,existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {soakConfig} from './soak-contract.mjs';
import {check,readJson,atomicJson,manifestAt,hash} from './soak-io.mjs';
import {launchResourceUnit,inspectBudget,resourceUnit,managerEnvironment,readBudget,budgetIdentity} from '../../dist/resources/budget.js';
import {liveness,bootClock} from '../../dist/supervisor/identity.js';
import {evidenceInputs} from './evidence-inputs.mjs';
const source=fileURLToPath(new URL('../../',import.meta.url));
function options(args){
 check(args.length===3&&['start','status','stop'].includes(args[0]),'SOAK_INVALID_OPTIONS');
 check(args[1]===(args[0]==='start'?'--config-file':'--run')&&args[2]&&!args[2].startsWith('--'),'SOAK_INVALID_OPTIONS');
 return {command:args[0],path:args[2]};
}
async function inspect(root){
 const {manifest}=manifestAt(root);let resource;
 try{resource=readBudget(await inspectBudget(manifest.budget));}catch{resource={status:'unavailable_or_stopped',usage:'unobserved'};}
 const launch=existsSync(join(root,'launch.json'))?readJson(join(root,'launch.json')):null;
 const heartbeat=existsSync(join(root,'heartbeat.json'))?readJson(join(root,'heartbeat.json')):null;
 const report=existsSync(join(root,'report.json'))?readJson(join(root,'report.json')):null;
 const progress=existsSync(join(root,'progress.json'))?readJson(join(root,'progress.json')):null;
 const live=heartbeat?.identity?await liveness(heartbeat.identity):'unknown',clock=bootClock();
 const age=heartbeat&&clock.bootId===heartbeat.boot_id?clock.uptimeMs-heartbeat.uptime_ms:'unobserved';
 return {run:root,id:manifest.id,launch,process_liveness:live,heartbeat_age_ms:age,heartbeat_stale:typeof age==='number'?age>15000:'unobserved',state:report?.state??(live==='dead'?'interrupted':live==='alive'?'running':heartbeat?'unobserved':'starting'),report,progress,resource};
}
async function start(path){
 const config=soakConfig.parse(readJson(resolve(path),16384)),root=resolve(config.output_dir);
 // Only the installation-owned default parent is created implicitly.
 if(dirname(root)===join(process.cwd(),'.runtime'))mkdirSync(dirname(root),{recursive:true,mode:0o700});
 check(!existsSync(root)&&!lstatSync(dirname(root)).isSymbolicLink()&&realpathSync(dirname(root))===dirname(root),'SOAK_DESTINATION_EXISTS_OR_UNSAFE');
 mkdirSync(root,{mode:0o700});const stat=lstatSync(root),id=randomUUID().replaceAll('-','');
 const budget={domain:'soak-'+id,cpu_percent:config.cpu_percent,memory_mb:config.memory_mb,tasks_max:config.tasks_max};
 const oldCwd=process.cwd();process.chdir(source);const inputs=evidenceInputs();process.chdir(oldCwd);
 atomicJson(root,'manifest.json',{schema_version:1,id,root,device:stat.dev,inode:stat.ino,source,config,config_hash:hash(config),budget,inputs,created_at:new Date().toISOString(),actual_cli:false,model_calls:0});
 const execution=await launchResourceUnit(budget,process.execPath,[fileURLToPath(import.meta.url),'serve',root],{cwd:source,stdio:'ignore'});
 execution.child.on('error',()=>{});execution.child.unref();
 atomicJson(root,'launch.json',{unit:execution.unit,budget_unit:execution.handle.unit,wrapper_pid:execution.child.pid,started_at:new Date().toISOString()});
 const end=performance.now()+15000;let state;
 while(performance.now()<end){
  state=await inspect(root);if(state.process_liveness==='alive'||state.report)break;await delay(100);
 }
 return {...state,accepted:true,independent_service:true,readiness:state?.process_liveness==='alive'?'observed':'unconfirmed'};
}
async function stop(root){
 const {manifest}=manifestAt(root),expected=budgetIdentity(manifest.budget),group=await resourceUnit(expected.unit);
 if(group.LoadState==='not-found'||(group.ActiveState==='inactive'&&group.ControlGroup===''))return {...await inspect(root),owned_domain_stopped:true};
 const handle=await inspectBudget(manifest.budget);
 const launch=readJson(join(root,'launch.json'));check(launch.budget_unit===handle.unit&&/^apdexec[a-f0-9]{32}\.service$/.test(launch.unit),'SOAK_LAUNCH_CHANGED');
 const state=await resourceUnit(launch.unit);
 if(state.LoadState!=='not-found'){
  check(state.Transient==='yes'&&state.Slice===handle.unit&&state.Description==='agent-driver execution v1 '+hash(handle.budget)+' '+launch.unit.slice(7,-8),'SOAK_UNIT_CHANGED');
 }
 atomicJson(root,'stop.json',{requested_at:new Date().toISOString(),kind:'operator_stop'});
 // Cooperative completion first. The budget slice is unique to this manifest.
 const end=performance.now()+15000;while(performance.now()<end&&!existsSync(join(root,'report.json'))){await delay(200);}
 const before=await inspect(root);
 await promisify(execFile)('/usr/bin/systemctl',['--user','stop',handle.unit],{env:managerEnvironment(),timeout:10000,windowsHide:true});
 return {run:root,state:before.report?.state??'interrupted',report:before.report,owned_domain_stopped:true,effects_not_rolled_back:true};
}
if(process.argv[2]==='serve'){
 const {runSoak}=await import('./soak-run.mjs');await runSoak(process.argv[3]);
}else{
 try{const input=options(process.argv.slice(2));const result=input.command==='start'?await start(input.path):input.command==='stop'?await stop(resolve(input.path)):await inspect(resolve(input.path));console.log(JSON.stringify(result));}
 catch(error){console.error(JSON.stringify({error:/^SOAK_[A-Z_]+$/.test(error?.message)?error.message:'SOAK_OPERATION_FAILED'}));process.exitCode=1;}
}
