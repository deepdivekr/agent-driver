import {dirname} from 'node:path';
import {appendSetupActivity} from './setup-activity.js';
import {startManagedControlService,validControlUrl} from './control-service.js';
try{
  const path=process.argv[2],previous=process.argv[3];if(!path||previous&&!validControlUrl(previous))throw Error('INVALID_CONNECTION_OPTIONS');
  const service=await startManagedControlService(path,previous?new URL(previous):undefined,{onReloadState:async state=>{
    const message=state.state==='reloading'?'Applying the saved runtime settings. No Work is being replayed.':state.state==='idle'?'Saved runtime settings applied. No Work was replayed.':state.state==='restored'?'Applying runtime settings failed. The previous runtime was preserved or restored; no Work was replayed.':'Applying runtime settings failed. Recovery needs review; no Work was replayed.';
    await appendSetupActivity(dirname(path),'runtime',state.state==='reloading'?'running':state.state==='idle'?'success':'error',message);
  }});
  const stop=()=>void service.close().catch(()=>{process.exitCode=1;});process.once('SIGTERM',stop);process.once('SIGINT',stop);
  process.send?.({format:1,pid:process.pid,url:service.url,config:path,started_at:new Date().toISOString()});await service.closed;
  if(service.reloadStatus().state==='failed')process.exitCode=1;
}catch(error){
  if(error instanceof Error&&error.message==='CONTROL_CENTER_WINDOWS_UNREACHABLE')process.send?.({format:1,start_error:error.message});
  process.exitCode=1;
}
