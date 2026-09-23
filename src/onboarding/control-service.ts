import {spawn} from 'node:child_process';
import {readFile,open,unlink,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {prepareLocalConnection} from './connection.js';

export function validControlUrl(value:unknown):value is string{try{const url=new URL(String(value));return url.protocol==='http:'&&url.hostname==='127.0.0.1'&&Boolean(url.port)&&/^\/[a-f0-9]{48}\/$/u.test(url.pathname)&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}}
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
    try{const response=await fetch(prior.url+'settings/status',{redirect:'error',signal:AbortSignal.timeout(2000)});if(response.ok&&(await response.json() as {credentials_exposed?:boolean}).credentials_exposed===false)return {...prior,reused:true};}catch{}
    try{process.kill(prior.pid,0);throw Error('CONTROL_CENTER_RUNNING_BUT_UNREACHABLE');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
  }
  let lock;try{lock=await open(lockPath,'wx',0o600);}catch{throw Error('CONTROL_CENTER_START_IN_PROGRESS');}
  try{
    const entry=fileURLToPath(new URL('./control-service-entry.js',import.meta.url));
    const child=spawn(process.execPath,[entry,paths.runtimeConfig,...(prior?[prior.url]:[])],{detached:true,stdio:['ignore','ignore','ignore','ipc'],windowsHide:true,shell:false});
    const record=await new Promise<ControlServiceRecord>((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('CONTROL_CENTER_START_TIMEOUT'));},15_000);child.once('error',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});child.once('exit',()=>{clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));});child.once('message',message=>{const value=message as ControlServiceRecord;if(!value||value.pid!==child.pid||!validControlUrl(value.url)||value.config!==paths.runtimeConfig){child.kill();clearTimeout(timer);reject(Error('CONTROL_CENTER_START_FAILED'));return;}clearTimeout(timer);resolve(value);});});
    const temporary=recordPath+'.'+randomUUID()+'.tmp';await writeFile(temporary,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});await rename(temporary,recordPath);child.disconnect();child.unref();return {...record,reused:false};
  }finally{await lock.close();await unlink(lockPath);}
}
