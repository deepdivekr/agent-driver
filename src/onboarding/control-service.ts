import {spawn,type ChildProcess} from 'node:child_process';
import {readFile,open,unlink,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {prepareLocalConnection} from './connection.js';
import {loadHostConfig,type HostConfig} from '../interface/config.js';
import type {ControlCenterServer} from '../observability/control-center.js';

export function validControlUrl(value:unknown):value is string{try{const url=new URL(String(value));return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Boolean(url.port)&&/^\/[a-f0-9]{48}\/$/u.test(url.pathname)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
type HostCommandResult={code:number|null;stdout:string};
function runWindowsProbe(script:string):Promise<HostCommandResult>{
  return new Promise(resolve=>{
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{stdio:['ignore','pipe','ignore'],windowsHide:true,shell:false});
    let stdout='',settled=false;
    const finish=(code:number|null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({code,stdout});};
    const timer=setTimeout(()=>{child.kill();finish(null);},6000);
    child.stdout.on('data',chunk=>{stdout+=String(chunk);if(stdout.length>256){child.kill();finish(null);}});
    child.once('error',()=>finish(null));child.once('exit',finish);
  });
}
/** WSL's localhost may be occupied by a different Windows program. A guest-only
 * probe cannot establish that the user's Windows browser can reach this service. */
export async function controlHostReachable(url:string,options:{environment?:NodeJS.ProcessEnv;platform?:NodeJS.Platform;run?:(script:string)=>Promise<HostCommandResult>}={}){
  if(!validControlUrl(url))throw Error('CONTROL_CENTER_URL_INVALID');
  const environment=options.environment??process.env;
  if((options.platform??process.platform)!=='linux'||!Boolean(environment.WSL_INTEROP||environment.WSL_DISTRO_NAME))return true;
  const script=`$ErrorActionPreference='Stop'; try { $r=Invoke-WebRequest -UseBasicParsing -Uri '${url}settings/status' -TimeoutSec 3 -MaximumRedirection 0 -Proxy $null; $v=ConvertFrom-Json -InputObject $r.Content; if ($r.StatusCode -eq 200 -and $v.credentials_exposed -eq $false) { exit 0 } } catch {}; exit 1`;
  return (await (options.run??runWindowsProbe)(script)).code===0;
}
export interface ControlReloadStatus {state:'idle'|'reloading'|'restored'|'failed';reason:string|null;}
interface ControlStartHooks {onReload?:()=>Promise<void>;reloadStatus?:()=>ControlReloadStatus;}
type ControlStarter=(config:HostConfig,options:ControlStartHooks&{port?:number;capability_token?:string})=>Promise<ControlCenterServer>;
/** Retry only an unpublished UI service. No Work, browser or CLI action is replayed. */
export async function startHostReachableControlCenter(config:HostConfig,previous?:URL,probe:(url:string)=>Promise<boolean>=controlHostReachable,hooks:ControlStartHooks={},start?:ControlStarter){
  if(previous&&!validControlUrl(previous.href))throw Error('CONTROL_CENTER_URL_INVALID');
  const startControlCenter=start??(await import('../observability/control-center.js')).startControlCenter;
  for(let attempt=0;attempt<3;attempt++){
    const service=await startControlCenter(config,{...hooks,...(previous?{...(attempt===0?{port:Number(previous.port)}:{}),capability_token:previous.pathname.slice(1,-1)}:{})});
    try{if(await probe(service.url))return service;}catch(error){await service.close();throw error;}
    await service.close();
  }
  throw Error('CONTROL_CENTER_WINDOWS_UNREACHABLE');
}
export interface ManagedControlService extends ControlCenterServer {
  /** Host-owned callback. The HTTP layer must finish its explicit user reply and
   * fence admission/prove idle before invoking this callback. */
  reload():Promise<void>;
  reloadStatus():ControlReloadStatus;
}
export interface ManagedControlServiceOptions {
  /** Pure host/test seams, never browser input or runtime configuration. */
  load?:(path:string)=>HostConfig;
  start?:ControlStarter;
  probe?:(url:string)=>Promise<boolean>;
  onReloadState?:(status:ControlReloadStatus)=>void|Promise<void>;
  close_timeout_ms?:number;
}
const sameControlIdentity=(a:HostConfig,b:HostConfig)=>a.path===b.path&&a.dbPath===b.dbPath&&a.project.id===b.project.id&&a.project.callerRef===b.project.callerRef&&a.project.accountRef===b.project.accountRef&&a.project.worktree===b.project.worktree&&a.project.profileRef===b.project.profileRef;
/** Keep the managed daemon's logical lifetime across an explicitly requested
 * same-PID reload. Published addresses never use the alternate-port retry path.
 * Existing execution/config hashes and the private service record are untouched. */
export async function startManagedControlService(configPath:string,previous?:URL,options:ManagedControlServiceOptions={}):Promise<ManagedControlService>{
  const load=options.load??loadHostConfig,probe=options.probe??controlHostReachable,start=options.start??(await import('../observability/control-center.js')).startControlCenter;
  let config=load(configPath),current:ControlCenterServer|null=null,stopped=false,operation:Promise<void>|null=null,stopOperation:Promise<void>|null=null;
  let status:ControlReloadStatus={state:'idle',reason:null},finish:()=>void=()=>undefined;
  const closed=new Promise<void>(resolve=>finish=resolve),snapshot=()=>({...status});
  const publish=async(value:ControlReloadStatus)=>{status=value;try{await options.onReloadState?.(snapshot());}catch{/* Failure to record a fixed diagnostic never grants execution or makes a failed reload succeed. */}};
  const watch=(service:ControlCenterServer)=>{current=service;void service.closed.then(()=>{if(current===service&&!operation){current=null;stopped=true;finish();}}).catch(()=>{if(current===service&&!operation){status={state:'failed',reason:'CONTROL_CENTER_CLOSED_UNCONFIRMED'};stopped=true;finish();}});};
  const closeOwned=async(service:ControlCenterServer)=>{
    let timer:NodeJS.Timeout|undefined;
    try{await Promise.race([Promise.all([service.close(),service.closed]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('CONTROL_CENTER_RELOAD_CLOSE_UNCONFIRMED')),options.close_timeout_ms??30_000);})]);}
    finally{if(timer)clearTimeout(timer);}
    if(current===service)current=null;
  };
  let url='';
  const hooks:ControlStartHooks={onReload:()=>reload(),reloadStatus:snapshot};
  const exactStart=async(next:HostConfig)=>{
    const address=new URL(url),service=await start(next,{...hooks,port:Number(address.port),capability_token:address.pathname.slice(1,-1)});watch(service);
    try{
      if(service.url!==url)throw Error('CONTROL_CENTER_RELOAD_ADDRESS_CHANGED');
      if(!await probe(url))throw Error('CONTROL_CENTER_WINDOWS_UNREACHABLE');
      if(stopped)throw Error('CONTROL_CENTER_CLOSING');
      return service;
    }catch(error){
      try{await closeOwned(service);}catch{throw Error('CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED');}
      throw error;
    }
  };
  function reload():Promise<void>{
    if(stopped)return Promise.reject(Error('CONTROL_CENTER_CLOSING'));
    if(operation)return Promise.reject(Error('CONTROL_CENTER_RELOAD_IN_PROGRESS'));
    if(!current||!url)return Promise.reject(Error('CONTROL_CENTER_RELOAD_NOT_READY'));
    // A referenced bridge keeps the same Node process alive while its old
    // listener is closed and the replacement/restore listener is being opened.
    const bridge=setInterval(()=>{},1000),oldConfig=config,oldService=current;
    operation=(async()=>{
      let next:HostConfig;
      try{next=load(configPath);if(!sameControlIdentity(oldConfig,next))throw Error('CONTROL_CENTER_RELOAD_IDENTITY_CHANGED');}
      catch{await publish({state:'restored',reason:'CONTROL_CENTER_RELOAD_CONFIG_REJECTED'});throw Error('CONTROL_CENTER_RELOAD_CONFIG_REJECTED');}
      await publish({state:'reloading',reason:null});
      try{await closeOwned(oldService);}catch{await publish({state:'failed',reason:'CONTROL_CENTER_RELOAD_CLOSE_UNCONFIRMED'});throw Error('CONTROL_CENTER_RELOAD_CLOSE_UNCONFIRMED');}
      if(stopped)return;
      try{
        if(load(configPath).fingerprint!==next.fingerprint)throw Error('CONTROL_CENTER_RELOAD_CONFIG_CHANGED');
        await exactStart(next);
        if(load(configPath).fingerprint!==next.fingerprint)throw Error('CONTROL_CENTER_RELOAD_CONFIG_CHANGED');
        config=next;await publish({state:'idle',reason:null});
      }catch(error){
        if(stopped){if(current)await closeOwned(current);return;}
        // Do not bind a duplicate when replacement cleanup or old close could
        // not be confirmed. Keep ownership so a later explicit stop can drain it.
        if(error instanceof Error&&error.message==='CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED'){await publish({state:'failed',reason:error.message});throw error;}
        if(current)try{await closeOwned(current);}catch{await publish({state:'failed',reason:'CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED'});throw Error('CONTROL_CENTER_RELOAD_CLEANUP_UNCONFIRMED');}
        try{await exactStart(oldConfig);config=oldConfig;await publish({state:'restored',reason:'CONTROL_CENTER_RELOAD_FAILED_RESTORED'});}
        catch{await publish({state:'failed',reason:'CONTROL_CENTER_RELOAD_RESTORE_FAILED'});if(!current){stopped=true;finish();}throw Error('CONTROL_CENTER_RELOAD_RESTORE_FAILED');}
        throw Error('CONTROL_CENTER_RELOAD_FAILED_RESTORED');
      }
    })().finally(()=>{clearInterval(bridge);operation=null;if(current)watch(current);});
    return operation;
  }
  const first=await startHostReachableControlCenter(config,previous,probe,hooks,start);url=first.url;watch(first);
  return {get url(){return url;},closed,reload,reloadStatus:snapshot,close(){
    if(stopOperation)return stopOperation;stopped=true;
    stopOperation=(async()=>{await operation?.catch(()=>{});if(current)await closeOwned(current);finish();})();return stopOperation;
  }};
}
export async function openControlUrl(url:string){
  if(!validControlUrl(url))throw Error('CONTROL_CENTER_URL_INVALID');
  const target=url+'settings',windows=process.platform==='win32'||Boolean(process.env.WSL_INTEROP||process.env.WSL_DISTRO_NAME),executable=windows?'powershell.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=windows?['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${target}'`]:[target];
  return new Promise<boolean>(resolve=>{const child=spawn(executable,args,{stdio:'ignore',windowsHide:true,shell:false});const timer=setTimeout(()=>{child.kill();resolve(false);},5000);child.once('error',()=>{clearTimeout(timer);resolve(false);});child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});});
}
export interface ControlServiceRecord{format:1;pid:number;url:string;config:string;started_at:string;}
export interface ControlServiceStartOptions {
  /** Host/test injection only; never a setting, model argument or process ID. */
  spawnChild?:(entry:string,config:string,previous?:string)=>ChildProcess;
  publishRecord?:(path:string,record:ControlServiceRecord)=>Promise<void>;
}
export async function publishControlServiceRecord(path:string,record:ControlServiceRecord){
  const temporary=path+'.'+randomUUID()+'.tmp',file=await open(temporary,'wx',0o600);
  try{await file.writeFile(JSON.stringify(record)+'\n');await file.close();await rename(temporary,path);}
  catch(error){await file.close().catch(()=>{});await unlink(temporary).catch(()=>{});throw error;}
}
function waitForOwnedExit(child:ChildProcess,timeout:number):Promise<boolean>{
  if(child.exitCode!==null||child.signalCode!==null)return Promise.resolve(true);
  return new Promise(resolve=>{
    let finished=false;
    const finish=(confirmed:boolean)=>{if(finished)return;finished=true;clearTimeout(timer);child.off('exit',exited);resolve(confirmed);};
    const exited=()=>finish(true),timer=setTimeout(()=>finish(child.exitCode!==null||child.signalCode!==null),timeout);
    child.once('exit',exited);
    if(child.exitCode!==null||child.signalCode!==null)finish(true);
  });
}
/** Only the just-created ChildProcess handle is signalled. An old record's PID
 * is never used for failed-start cleanup, and a signal is not proof of exit. */
async function cleanupFailedControlStart(child:ChildProcess):Promise<boolean>{
  if(child.pid===undefined||child.exitCode!==null||child.signalCode!==null)return true;
  // IPC alone can keep the otherwise gracefully closed Node child alive.
  if(child.connected)try{child.disconnect();}catch{}
  try{child.kill('SIGTERM');}catch{}
  if(await waitForOwnedExit(child,2000))return true;
  try{child.kill('SIGKILL');}catch{}
  return waitForOwnedExit(child,2000);
}
/** One reusable, detached Control Center per local connection. MCP reconnection does not open a window. */
export async function ensureControlService(root:string,options:ControlServiceStartOptions={}){
  const paths=await prepareLocalConnection(root),recordPath=join(paths.root,'control-center.json'),lockPath=join(paths.root,'.control-center.lock');
  let prior:ControlServiceRecord|undefined;
  try{prior=JSON.parse(await readFile(recordPath,'utf8')) as ControlServiceRecord;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('CONTROL_CENTER_RECORD_INVALID');}
  if(prior){
    if(!validControlUrl(prior.url)||prior.config!==paths.runtimeConfig||!Number.isInteger(prior.pid)||prior.pid<1)throw Error('CONTROL_CENTER_RECORD_INVALID');
    let guestReady=false;
    try{const response=await fetch(prior.url+'settings/status',{redirect:'error',signal:AbortSignal.timeout(2000)});guestReady=response.ok&&(await response.json() as {credentials_exposed?:boolean}).credentials_exposed===false;}catch{}
    if(guestReady){if(!await controlHostReachable(prior.url))throw Error('CONTROL_CENTER_WINDOWS_UNREACHABLE');return {...prior,reused:true};}
    try{process.kill(prior.pid,0);throw Error('CONTROL_CENTER_RUNNING_BUT_UNREACHABLE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  let lock;try{lock=await open(lockPath,'wx',0o600);}catch{throw Error('CONTROL_CENTER_START_IN_PROGRESS');}
  let child:ChildProcess|undefined,startFailure:unknown,lockReleased=false;
  try{
    const entry=fileURLToPath(new URL('./control-service-entry.js',import.meta.url));
    child=(options.spawnChild??((entry,config,previous)=>spawn(process.execPath,[entry,config,...(previous?[previous]:[])],{detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,shell:false})))(entry,paths.runtimeConfig,prior?.url);
    const owned=child;
    const record=await new Promise<ControlServiceRecord>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('CONTROL_CENTER_START_TIMEOUT')),30_000);owned.once('error',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});owned.once('exit',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});owned.once('message',message=>{const value=message as ControlServiceRecord&{start_error?:unknown};if(value?.start_error==='CONTROL_CENTER_WINDOWS_UNREACHABLE'){clearTimeout(timer);reject(Error(value.start_error));return;}if(!value||value.pid!==owned.pid||!validControlUrl(value.url)||value.config!==paths.runtimeConfig){clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));return;}clearTimeout(timer);resolve(value);});});
    await (options.publishRecord??publishControlServiceRecord)(recordPath,record);
    await lock.close();await unlink(lockPath);lockReleased=true;
    if(child.connected)child.disconnect();child.unref();return {...record,reused:false};
  }catch(error){
    startFailure=error;
    if(child&&!await cleanupFailedControlStart(child)){startFailure=Error('CONTROL_CENTER_FAILED_START_CLEANUP_UNCONFIRMED');throw startFailure;}
    throw error;
  }finally{
    // Do not mask an unconfirmed owned child with a secondary lock-file error.
    if(!lockReleased){await lock.close().catch(error=>{if(!startFailure)throw error;});await unlink(lockPath).catch(error=>{if(!startFailure)throw error;});}
  }
}
