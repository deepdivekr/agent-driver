import {loadHostConfig} from '../interface/config.js';
import {startHostReachableControlCenter,validControlUrl} from './control-service.js';
try{
  const path=process.argv[2],previous=process.argv[3];if(!path||previous&&!validControlUrl(previous))throw Error('INVALID_CONNECTION_OPTIONS');
  const service=await startHostReachableControlCenter(loadHostConfig(path),previous?new URL(previous):undefined);
  process.once('SIGTERM',()=>void service.close());process.once('SIGINT',()=>void service.close());
  process.send?.({format:1,pid:process.pid,url:service.url,config:path,started_at:new Date().toISOString()});await service.closed;
}catch(error){
  if(error instanceof Error&&error.message==='CONTROL_CENTER_WINDOWS_UNREACHABLE')process.send?.({format:1,start_error:error.message});
  process.exitCode=1;
}
