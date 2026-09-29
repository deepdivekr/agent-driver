import {spawn} from 'node:child_process';
import {readFile,open,unlink,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {prepareLocalConnection} from './connection.js';
import type {HostConfig} from '../interface/config.js';

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
/** Retry only an unpublished UI service. No Work, browser or CLI action is replayed. */
export async function startHostReachableControlCenter(config:HostConfig,previous?:URL,probe:(url:string)=>Promise<boolean>=controlHostReachable){
  if(previous&&!validControlUrl(previous.href))throw Error('CONTROL_CENTER_URL_INVALID');
  const {startControlCenter}=await import('../observability/control-center.js');
  for(let attempt=0;attempt<3;attempt++){
    const service=await startControlCenter(config,previous?{...(attempt===0?{port:Number(previous.port)}:{}),capability_token:previous.pathname.slice(1,-1)}:{});
    try{if(await probe(service.url))return service;}catch(error){await service.close();throw error;}
    await service.close();
  }
  throw Error('CONTROL_CENTER_WINDOWS_UNREACHABLE');
}
export async function openControlUrl(url:string){
  if(!validControlUrl(url))throw Error('CONTROL_CENTER_URL_INVALID');
  const target=url+'settings',windows=process.platform==='win32'||Boolean(process.env.WSL_INTEROP||process.env.WSL_DISTRO_NAME),executable=windows?'powershell.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=windows?['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${target}'`]:[target];
  return new Promise<boolean>(resolve=>{const child=spawn(executable,args,{stdio:'ignore',windowsHide:true,shell:false});const timer=setTimeout(()=>{child.kill();resolve(false);},5000);child.once('error',()=>{clearTimeout(timer);resolve(false);});child.once('exit',code=>{clearTimeout(timer);resolve(code===0);});});
}
export interface ControlServiceRecord{format:1;pid:number;url:string;config:string;started_at:string;}
/** One reusable, detached Control Center per local connection. MCP reconnection does not open a window. */
export async function ensureControlService(root:string){
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
  try{
    const entry=fileURLToPath(new URL('./control-service-entry.js',import.meta.url));
    const child=spawn(process.execPath,[entry,paths.runtimeConfig,...(prior?[prior.url]:[])],{detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,shell:false});
    const record=await new Promise<ControlServiceRecord>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('CONTROL_CENTER_START_TIMEOUT'));},30_000);child.once('error',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});child.once('message',message=>{const value=message as ControlServiceRecord&{start_error?:unknown};if(value?.start_error==='CONTROL_CENTER_WINDOWS_UNREACHABLE'){child.kill();clearTimeout(timer);reject(Error(value.start_error));return;}if(!value||value.pid!==child.pid||!validControlUrl(value.url)||value.config!==paths.runtimeConfig){child.kill();clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));return;}clearTimeout(timer);resolve(value);});});
    const temporary=recordPath+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,recordPath);child.disconnect();child.unref();return {...record,reused:false};
  }finally{await lock.close();await unlink(lockPath);}
}
