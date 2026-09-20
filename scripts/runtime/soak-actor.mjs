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
  if(p===point){process.send({kind:'checkpoint',task,point,generation:Number(generation)});await new Promise(r=>process.once('message',r));}
 });}catch{process.exitCode=1;}finally{process.disconnect?.();}
}else if(mode==='supervisor'){
 const children=new Map(),faultDelivered=new Set();let stopping=false;
 const launch=async(config,row)=>{
  const kind=row.request_id.split('.').at(-1),point={claimed:'claimed',prepare:'claimed',after_save:'after_save',uncertain:'intent_recorded'}[kind];
  // A startup timeout may happen before a fault checkpoint. Keep the hook armed
  // until one worker reaches the requested checkpoint, then let product recovery
  // run normally. Re-arming after delivery would leave a recovery worker paused
  // forever because the harness correctly injects one fault per task.
  if(!point||faultDelivered.has(row.task_id))return launchWorker(config,row);
  const child=fork(fileURLToPath(import.meta.url),['worker',path,row.task_id,row.launch_nonce,String(row.dispatch_generation),point],{stdio:['ignore','ignore','ignore','ipc']});
  const childRecord={child,generation:row.dispatch_generation};children.set(row.task_id,childRecord);
  child.on('message',message=>{if(message.kind==='checkpoint'){faultDelivered.add(row.task_id);process.send({...message,pid:child.pid});}});
  child.on('exit',(code,signal)=>{if(children.get(row.task_id)===childRecord)children.delete(row.task_id);process.send?.({kind:'worker_exit',task:row.task_id,generation:row.dispatch_generation,code,signal});});
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
  return processIdentity(child.pid);
 };
 const supervisor=new Supervisor(loadHostConfig(path),launch);
 process.on('message',message=>{
  if(message.kind==='kill'){
   const record=children.get(message.task),child=record?.child;
   if(record&&record.generation===message.generation&&child.exitCode===null&&child.signalCode===null&&child.kill('SIGKILL')){
    // This acknowledgement is emitted by the actor that owns the exact child.
    // The runner separately observes profile release before accepting recovery.
    process.send?.({kind:'kill_delivered',task:message.task,generation:message.generation,pid:child.pid});
   }
  }
 });
 process.on('SIGTERM',()=>{stopping=true;});
 try{await supervisor.start();process.send({kind:'ready',identity:await processIdentity(process.pid)});
  while(!stopping){await supervisor.step();await delay(100);}
 }catch{process.exitCode=1;}finally{supervisor.close();process.disconnect?.();}
}else throw Error('SOAK_ACTOR_INVALID');
