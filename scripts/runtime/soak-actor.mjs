// Trusted synthetic fault injector, never a production/public capability.
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {loadHostConfig} from '../../dist/interface/config.js';
import {Supervisor,launchWorker} from '../../dist/supervisor/supervisor.js';
import {processIdentity} from '../../dist/supervisor/identity.js';
const [mode,path,...args]=process.argv.slice(2);
if(mode==='worker'){
 const {runWorker}=await import('../../dist/interface/worker.js');
 const [task,ticket,generation,point]=args;
 try{await runWorker(path,task,ticket,Number(generation),async p=>{
  if(p===point){process.send({kind:'checkpoint',task,point});await new Promise(r=>process.once('message',r));}
 });}catch{process.exitCode=1;}finally{process.disconnect?.();}
}else if(mode==='supervisor'){
 const children=new Map();let stopping=false;
 const launch=async(config,row)=>{
  const kind=row.request_id.split('.').at(-1),point={claimed:'claimed',prepare:'claimed',after_save:'after_save',uncertain:'intent_recorded'}[kind];
  if(row.attempt_count!==1||!point)return launchWorker(config,row);
  const child=fork(fileURLToPath(import.meta.url),['worker',path,row.task_id,row.launch_nonce,String(row.dispatch_generation),point],{stdio:['ignore','ignore','ignore','ipc']});
  children.set(row.task_id,child);
  child.on('message',message=>{if(message.kind==='checkpoint')process.send({...message,pid:child.pid});});
  child.on('exit',(code,signal)=>process.send?.({kind:'worker_exit',task:row.task_id,code,signal}));
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  return processIdentity(child.pid);
 };
 const supervisor=new Supervisor(loadHostConfig(path),launch);
 process.on('message',message=>{
  if(message.kind==='kill'){const child=children.get(message.task);if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
 });
 process.on('SIGTERM',()=>{stopping=true;});
 try{await supervisor.start();process.send({kind:'ready',identity:await processIdentity(process.pid)});
  while(!stopping){await supervisor.step();await delay(100);}
 }catch{process.exitCode=1;}finally{supervisor.close();process.disconnect?.();}
}else throw Error('SOAK_ACTOR_INVALID');
