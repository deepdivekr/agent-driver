import {runWorker} from '../../dist/interface/worker.js';
import {loadHostConfig} from '../../dist/interface/config.js';
import {Supervisor} from '../../dist/supervisor/supervisor.js';
import {RuntimeApi} from '../../dist/interface/api.js';
const [mode,path,...args]=process.argv.slice(2);
const wait=()=>new Promise(resolve=>process.once('message',resolve));
try{
  if(mode==='worker'){
    const [task,ticket,generation,cut]=args;
    await runWorker(path,task,ticket,Number(generation),async point=>{if(point===cut){process.send({point});await wait();}});
  }else if(mode==='supervisor'){
    const supervisor=new Supervisor(loadHostConfig(path));await supervisor.start();
    if(args[0]){const reserved=supervisor.store.reserve(supervisor.config.project.id,supervisor.nonce,args[0]);process.send({reserved});}
    else process.send({nonce:supervisor.nonce});
    await wait();supervisor.close();
  }else if(mode==='gateway'){
    const api=new RuntimeApi(loadHostConfig(path));process.send(await api.call('runtime_task_start',JSON.parse(args[0])));await wait();api.close();
  }else if(mode==='profile'){process.send({ready:true});await wait();}
}catch{process.exitCode=1;}
finally{process.disconnect?.();}
