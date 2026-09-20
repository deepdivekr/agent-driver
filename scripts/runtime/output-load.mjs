// Independent synthetic CLI load observer. Does not certify actual Claude or long-term uptime.
import {mkdtemp,writeFile,readFile,rm,readdir,stat} from 'node:fs/promises';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../../dist/interface/config.js';
import {RuntimeApi} from '../../dist/interface/api.js';
import {pingTerminalHost} from '../../dist/terminal/manager.js';
import {liveness} from '../../dist/supervisor/identity.js';
import {evidenceInputs,changedInputs} from './evidence-inputs.mjs';

async function until(predicate,ms=10000){const end=performance.now()+ms;while(performance.now()<end){if(await predicate())return;await delay(20);}throw Error('LOAD_OBSERVATION_TIMEOUT');}
async function bytes(path){let total=0;for(const e of await readdir(path,{withFileTypes:true})){const p=join(path,e.name);if(e.isDirectory())total+=await bytes(p);else if(e.isFile()){const s=await stat(p);total+=Math.max(s.size,s.blocks*512);}}return total;}
async function rss(pid){try{const s=await readFile(`/proc/${pid}/status`,'utf8');return Number(s.match(/^VmRSS:\s+(\d+) kB/m)?.[1])*1024||'unobserved';}catch{return 'unobserved';}}
export async function runOutputLoad({durationMs=3000,onProgress=()=>{}}={}){
 if(!Number.isInteger(durationMs)||durationMs<500||durationMs>540000)throw Error('INVALID_LOAD_DURATION');
 const root=await mkdtemp(join(tmpdir(),'apd-output-load-')),path=join(root,'host.json');
 const raw={schema_version:1,project_id:'owned-load',caller_ref:'load-fixture',account_ref:'synthetic',environment:'production',worktree:root,data_dir:join(root,'data'),terminal:{executable:process.execPath,version:'2.1.126',spool_bytes:16777216,turn_deadline_ms:durationMs+30000}};
 await writeFile(path,JSON.stringify(raw));const config=loadHostConfig(path),api=new RuntimeApi(config);
 const host=spawn(process.execPath,[fileURLToPath(new URL('../../tests/helpers/terminal-host.mjs',import.meta.url)),path],{stdio:'ignore'}),closed=once(host,'exit');
 const result={evidence_level:'fixture_integration',status:'NOT_RUN',requested_duration_ms:durationMs,host_pid:host.pid,samples:[],normal_turn:'NOT_RUN',api_calls:0,actual_cli:false};
 const start=performance.now();let loadId,normalId;
 const observe=async()=>{
  const at=performance.now(),row=api.store.terminalHost(config.project.id),pingStart=performance.now();
  const ping_ok=await pingTerminalHost(row),ping_ms=performance.now()-pingStart;
  const statusStart=performance.now();const status=await api.call('runtime_terminal_status',{session_ref:loadId});
  const status_ms=performance.now()-statusStart,s=api.store.session(loadId);
  result.samples.push({elapsed_ms:performance.now()-start,observation_ms:performance.now()-at,ping_ok,ping_ms,status_ms,state:status.session_state??s.state,spool_bytes:s.spool_bytes,host_rss_bytes:await rss(host.pid),cli_rss_bytes:s.process_identity_json?await rss(JSON.parse(s.process_identity_json).pid):'unobserved',data_bytes:await bytes(dirname(config.dbPath))});
  onProgress(result);
 };
 try{
  await until(async()=>{const row=api.store.terminalHost(config.project.id);return row&&await pingTerminalHost(row);});
  for(const name of ['load','normal']){const accepted=await api.call('runtime_terminal_start',{request_id:name});await until(()=>api.store.session(accepted.session_ref).state==='input_ready');if(name==='load')loadId=accepted.session_ref;else normalId=accepted.session_ref;}
  const s=api.store.session(loadId);const accepted=await api.call('runtime_terminal_submit_prompt',{request_id:'flood',session_ref:loadId,expected_generation:s.generation,expected_previous_turn_id:null,prompt:'owned-load-stream'});
  await until(()=>api.store.turn(accepted.turn_id).status==='acknowledged');const loadStart=performance.now();
  await observe();
  const normalStart=performance.now();
  try{const a=await api.call('runtime_terminal_submit_prompt',{request_id:'fairness',session_ref:normalId,expected_generation:1,expected_previous_turn_id:null,prompt:'other session stays responsive'});result.normal_turn_id=a.turn_id;result.normal_turn='accepted';}catch(e){result.normal_turn='FAIL';result.normal_error=/^[A-Z_]+$/.test(e.message)?e.message:'SUBMIT_ERROR';}
  result.normal_submit_ms=performance.now()-normalStart;
  while(performance.now()-loadStart<durationMs){await delay(200);await observe();if(result.normal_turn==='accepted'&&api.store.session(normalId).state==='input_ready'){result.normal_turn='PASS';result.normal_completed_ms=performance.now()-normalStart;}}
  result.actual_load_ms=performance.now()-loadStart;
  const before=api.store.session(loadId),identity=JSON.parse(before.process_identity_json),cancelStart=performance.now();
  await api.call('runtime_terminal_interrupt',{session_ref:loadId,expected_generation:before.generation});result.interrupt_accept_ms=performance.now()-cancelStart;
  await until(async()=>await liveness(identity)==='dead',15000);result.interrupt_to_dead_ms=performance.now()-cancelStart;
  const after=api.store.session(loadId);result.final={state:after.state,error_code:after.error_code,turn_status:api.store.turn(accepted.turn_id).status,last_turn_id:after.last_turn_id,spool_bytes:after.spool_bytes,cli_liveness:await liveness(identity)};
  result.receipts=(await readFile(join(root,'received.jsonl'),'utf8')).trim().split('\n').map(JSON.parse).map(x=>({uuid:x.uuid,kind:x.message.content==='owned-load-stream'?'load':'normal'}));
  if(result.normal_turn==='accepted'&&api.store.session(normalId).state==='input_ready'){result.normal_turn='PASS';result.normal_completed_ms=performance.now()-normalStart;}
  result.status=result.samples.every(x=>x.ping_ok&&x.ping_ms<=1000)&&result.normal_submit_ms<=1000&&result.interrupt_to_dead_ms<=3000&&result.normal_turn==='PASS'&&result.final.turn_status==='uncertain'&&result.final.last_turn_id===null&&result.receipts.filter(x=>x.kind==='load').length===1?'PASS':'FAIL';
 }catch(e){result.status='FAIL';result.error=/^[A-Z_]+$/.test(e.message)?e.message:'LOAD_FAILED';result.error_code=typeof e.code==='string'&&/^[A-Z_]+$/.test(e.code)?e.code:'unobserved';}
 finally{
  host.kill('SIGTERM');const timeout=setTimeout(()=>host.kill('SIGKILL'),10000);await closed;clearTimeout(timeout);
  result.host_exit={exit_code:host.exitCode,signal:host.signalCode};
  result.children=[];for(const s of api.store.sessions(config.project.id))if(s.process_identity_json)result.children.push(await liveness(JSON.parse(s.process_identity_json)));
  if(result.children.some(s=>s!=='dead')||host.signalCode)result.status='FAIL';
  result.data_bytes_final=await bytes(dirname(config.dbPath));result.elapsed_ms=performance.now()-start;api.close();
  // Only this mkdtemp-owned fixture tree; preserve on failed ownership cleanup.
  if(result.children.every(s=>s==='dead'))await rm(root,{recursive:true,force:true});else result.retained_fixture=root;
 }
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv.includes('--run'))throw Error('Explicit --run required');
 const value=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
 const durationMs=Number(value('--duration-ms')??3000),id=`output-load-${new Date().toISOString().replace(/[:.]/g,'-')}`,inputs=evidenceInputs();
 mkdirSync('tests/evidence',{recursive:true});let last=0;
 const result=await runOutputLoad({durationMs,onProgress:r=>{if(performance.now()-last>5000){last=performance.now();writeFileSync(`tests/evidence/${id}-progress.json`,JSON.stringify({id,host_pid:r.host_pid,requested_duration_ms:durationMs,last_sample:r.samples.at(-1)},null,2));}}});
 const receipt={id,inputs,...result,changed_inputs:changedInputs(inputs,evidenceInputs())};if(receipt.changed_inputs.length)receipt.status='FAIL';
 writeFileSync(`tests/evidence/${id}.json`,JSON.stringify(receipt,null,2)+'\n');
 const report=JSON.parse(readFileSync('tests/report.json','utf8'));report.cases.push({case_id:id,evidence_level:'fixture_integration',status:receipt.status,environment:`WSL Linux / Node ${process.version} / synthetic CLI stream`,observations:receipt,evidence_paths:[`tests/evidence/${id}.json`]});writeFileSync('tests/report.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({id,status:receipt.status,elapsed_ms:receipt.elapsed_ms,samples:receipt.samples.length,ping_failures:receipt.samples.filter(x=>!x.ping_ok).length,max_ping_ms:Math.max(...receipt.samples.map(x=>x.ping_ms)),interrupt_to_dead_ms:receipt.interrupt_to_dead_ms,normal_turn:receipt.normal_turn,error:receipt.error,children:receipt.children}));if(receipt.status!=='PASS')process.exitCode=1;
}
