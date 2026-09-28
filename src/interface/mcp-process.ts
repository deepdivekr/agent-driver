import {mkdir,writeFile,readdir,readFile,rename,unlink,rmdir} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {processIdentitySync,liveness,type ProcessIdentity} from '../supervisor/identity.js';

export interface McpOwner{pid:number;identity:ProcessIdentity|null;nonce:string;}
export function mcpOwner():McpOwner{const identity=processIdentitySync(process.pid);return {pid:process.pid,identity:typeof identity==='object'?identity:null,nonce:randomUUID()};}
export async function ownerAlive(owner:McpOwner){
  if(!Number.isSafeInteger(owner.pid)||owner.pid<1)throw Error('MCP_OWNER_INVALID');
  if(owner.identity)return (await liveness(owner.identity))!=='dead';
  try{process.kill(owner.pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;return true;}
}
/** Publish a nonempty directory atomically. A stale reaper removes only the exact
 * nonce it observed, never a newly acquired lock belonging to another process. */
export async function tryMcpLock(path:string){
  await mkdir(dirname(path),{recursive:true,mode:0o700});
  const owner=mcpOwner(),marker=owner.nonce+'.json',candidate=path+'.'+owner.nonce;
  await mkdir(candidate,{mode:0o700});await writeFile(join(candidate,marker),JSON.stringify(owner),{mode:0o600,flag:'wx'});
  try{await rename(candidate,path);}
  catch(error){
    await unlink(join(candidate,marker));await rmdir(candidate);
    if(!['EEXIST','ENOTEMPTY','EPERM','EACCES'].includes((error as NodeJS.ErrnoException).code??''))throw error;
    try{
      const names=await readdir(path);if(names.length!==1||!/^[-a-f0-9]+\.json$/u.test(names[0]!))return null;
      const name=names[0]!,prior=JSON.parse(await readFile(join(path,name),'utf8')) as McpOwner;
      if(prior.nonce+'.json'!==name||await ownerAlive(prior))return null;
      await unlink(join(path,name));await rmdir(path);
    }catch(error){if(!['ENOENT','ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
    return null;
  }
  let released=false;
  return {owner,async release(){if(released)return;released=true;await unlink(join(path,marker));
    // Another contender may atomically replace the now-empty directory before
    // rmdir. Its new, nonempty nonce belongs to it and must be left untouched.
    try{await rmdir(path);}catch(error){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((error as NodeJS.ErrnoException).code??''))throw error;}
  }};
}
export async function mcpLock(path:string,timeoutMs=20_000){
  const until=Date.now()+timeoutMs;
  do{const lease=await tryMcpLock(path);if(lease)return lease;await delay(60);}while(Date.now()<until);
  throw Error('MCP_START_IN_PROGRESS');
}
/** Compatibility/direct servers cannot accumulate without bound either.
 * The limit is per OS user, not a fictitious cross-machine global semaphore. */
export async function acquireMcpProcess(){
  const root=join(homedir(),'.agent-driver','mcp-processes');
  for(let attempt=0;attempt<2;attempt++)for(let slot=0;slot<3;slot++){
    const lease=await tryMcpLock(join(root,String(slot)));if(lease)return lease;
  }
  throw Error('MCP_PROCESS_LIMIT_USE_SHARED_SERVER');
}
