import {readFileSync} from 'node:fs';
import {readFile,readdir} from 'node:fs/promises';
import {uptime} from 'node:os';
import {resolve} from 'node:path';

export interface ProcessIdentity {platform:'linux';pid:number;bootId:string;startTicks:string}
export type Liveness='alive'|'dead'|'unknown';
export function bootClock(){
  try{return {bootId:readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim(),uptimeMs:Number(readFileSync('/proc/uptime','utf8').split(' ')[0])*1000};}
  catch{return {bootId:'unknown',uptimeMs:uptime()*1000};}
}
export async function processIdentity(pid:number):Promise<ProcessIdentity|'dead'|'unknown'>{
  if(process.platform!=='linux'||!Number.isSafeInteger(pid)||pid<1)return 'unknown';
  try{
    const stat=await readFile(`/proc/${pid}/stat`,'utf8');
    const fields=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\s+/);
    if(['Z','X'].includes(fields[0]??''))return 'dead';
    const startTicks=fields[19],bootId=bootClock().bootId;
    if(!startTicks||!/^\d+$/.test(startTicks)||bootId==='unknown')return 'unknown';
    return {platform:'linux',pid,bootId,startTicks};
  }catch(e){return (e as NodeJS.ErrnoException).code==='ENOENT'?'dead':'unknown';}
}
export async function liveness(identity:ProcessIdentity|null):Promise<Liveness>{
  if(!identity)return 'unknown';
  const current=await processIdentity(identity.pid);
  if(typeof current==='string')return current;
  return current.platform===identity.platform&&current.bootId===identity.bootId&&current.startTicks===identity.startTicks?'alive':'dead';
}
export async function profileOccupancy(profile:string):Promise<'clear'|'busy'|'unknown'>{
  if(process.platform!=='linux')return 'unknown';
  try{
    const pids=(await readdir('/proc')).filter(p=>/^\d+$/.test(p));let uncertain=false;
    for(const pid of pids){
      try{
        const args=(await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0');
        for(let i=0;i<args.length;i++){
          const arg=args[i]!,value=arg.startsWith('--user-data-dir=')?arg.slice(16):arg==='--user-data-dir'?args[i+1]:undefined;
          if(value&&resolve(value)===resolve(profile)&&await processIdentity(Number(pid))!=='dead')return 'busy';
        }
      }catch(e){if(!['ENOENT','ESRCH'].includes((e as NodeJS.ErrnoException).code??''))uncertain=true;}
    }
    return uncertain?'unknown':'clear';
  }catch{return 'unknown';}
}
