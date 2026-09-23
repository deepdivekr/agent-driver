import {loadHostConfig} from '../interface/config.js';
import {startControlCenter} from '../observability/control-center.js';
import {validControlUrl} from './control-service.js';
try{
  const path=process.argv[2],previous=process.argv[3];if(!path||previous&&!validControlUrl(previous))throw Error('INVALID_CONNECTION_OPTIONS');
  const url=previous?new URL(previous):null,service=await startControlCenter(loadHostConfig(path),url?{port:Number(url.port),capability_token:url.pathname.slice(1,-1)}:{});
  process.once('SIGTERM',()=>void service.close());process.once('SIGINT',()=>void service.close());
  process.send?.({format:1,pid:process.pid,url:service.url,config:path,started_at:new Date().toISOString()});await service.closed;
}catch{process.exitCode=1;}
