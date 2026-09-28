import {readFile,writeFile,rename,realpath} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {mcpLock,ownerAlive,type McpOwner} from './mcp-process.js';

// Captured at process start: an in-place package update must not make a live
// old server appear to be running the new version.
export const mcpServiceVersion=String(JSON.parse(readFileSync(new URL('../../package.json',import.meta.url),'utf8')).version);
export interface McpServiceRecord{format:1;owner:McpOwner;config:string;entry:string;version?:string;url:string;token:string;started_at:string;}
function valid(record:McpServiceRecord,config:string){
  const url=new URL(record.url);
  if(record.format!==1||record.config!==config||url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/mcp'||url.username||url.password||url.search||url.hash||!/^[a-f0-9]{64}$/u.test(record.token))throw Error('MCP_SERVICE_RECORD_INVALID');
}
export async function mcpServiceHealth(record:McpServiceRecord){
  const result=await fetch(new URL('/health',record.url),{headers:{authorization:'Bearer '+record.token},signal:AbortSignal.timeout(2000),redirect:'error'});
  if(!result.ok)throw Error('MCP_SERVICE_UNREACHABLE');
  const value=await result.json() as {service:string;pid:number;sessions:number;max_sessions:number};
  if(value.service!=='agent-driver-mcp'||value.pid!==record.owner.pid)throw Error('MCP_SERVICE_IDENTITY_MISMATCH');return value;
}
export async function readMcpService(configPath:string){
  const config=await realpath(configPath),recordPath=join(dirname(config),'.mcp-service.json');
  try{const record=JSON.parse(await readFile(recordPath,'utf8')) as McpServiceRecord;valid(record,config);return record;}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
}
/** Explicit, identity-checked stop of this configuration's idle shared server.
 * Never kill an unrelated PID, force active work, or remove its stable receipt. */
export async function stopMcpService(configPath:string){
  const config=await realpath(configPath),lock=await mcpLock(join(dirname(config),'.mcp-service.json.lock'));
  try{
    const record=await readMcpService(config);
    if(!record||!await ownerAlive(record.owner))return {stopped:true,already_stopped:true};
    const health=await mcpServiceHealth(record);
    if(health.sessions!==0)throw Error('MCP_SERVICE_DISCONNECT_CLIENTS_FIRST');
    if(await ownerAlive(record.owner))process.kill(record.owner.pid,'SIGTERM');
    for(let i=0;i<150;i++){if(!await ownerAlive(record.owner))return {stopped:true,already_stopped:false};await delay(100);}
    throw Error('MCP_SERVICE_STOP_PENDING');
  }finally{await lock.release();}
}
/** Concurrent callers wait for one owner, then re-read its durable receipt.
 * A live but unreachable owner is an error, never permission to fork another. */
export async function ensureMcpService(configPath:string){
  const config=await realpath(configPath),recordPath=join(dirname(config),'.mcp-service.json'),entry=fileURLToPath(new URL('./mcp-service-entry.js',import.meta.url));
  const lock=await mcpLock(recordPath+'.lock');
  try{
    const prior=await readMcpService(config);
    if(prior&&await ownerAlive(prior.owner)){
      if(prior.entry!==entry||prior.version!==mcpServiceVersion)throw Error('MCP_SERVICE_VERSION_RESTART_REQUIRED');
      await mcpServiceHealth(prior);return {...prior,reused:true};
    }
    const token=prior?.token??randomBytes(32).toString('hex'),port=prior?Number(new URL(prior.url).port):0;
    const child=spawn(process.execPath,[entry,config,String(port)],{stdio:['ignore','ignore','ignore','ipc'],detached:true,windowsHide:true,shell:false});
    const record=await new Promise<McpServiceRecord>((resolve,reject)=>{
      const fail=()=>{clearTimeout(timer);child.kill();reject(Error('MCP_SERVICE_START_FAILED'));};
      const timer=setTimeout(fail,15_000);child.once('error',fail);child.once('exit',fail);
      child.once('message',message=>{
        try{const record=message as McpServiceRecord;valid(record,config);if(record.owner.pid!==child.pid||record.entry!==entry||record.token!==token||record.version!==mcpServiceVersion)throw Error();
          clearTimeout(timer);child.off('error',fail);child.off('exit',fail);resolve(record);
        }catch{fail();}
      });child.send({token});
    });
    // Child holds the startup lock until this acknowledgement: if the launcher
    // dies before publishing, it exits instead of becoming an unrecorded daemon.
    try{const temp=recordPath+'.'+randomUUID()+'.tmp';await writeFile(temp,JSON.stringify(record)+'\n',{mode:0o600,flag:'wx'});await rename(temp,recordPath);child.send({committed:true});}
    catch(error){child.kill();throw error;}
    child.disconnect();child.unref();return {...record,reused:false};
  }finally{await lock.release();}
}
