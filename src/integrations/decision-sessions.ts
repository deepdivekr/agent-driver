import {randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {hashJson,type ModelRole} from '../taskpack/adaptive-spec.js';

export interface DecisionSessionScope {root:string;work_id:string;run_id:string;actor_id:string;role:ModelRole;}
export interface DecisionSessionTurn {directory:string;session_id:string|null;}
const recordSchema=z.object({format:z.literal(1),binding:z.string().regex(/^[a-f0-9]{64}$/u),session_id:z.string().uuid().nullable(),turns:z.number().int().min(0).max(32),updated_at:z.number().int().nonnegative(),in_flight:z.boolean()}).strict();
const scopeId=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u);
const maxAgeMs=24*60*60*1000;
function privateDirectory(path:string){
  for(let current=resolve(path);;current=dirname(current)){
    if(existsSync(current)){const stat=lstatSync(current);requireCondition(stat.isDirectory()&&!stat.isSymbolicLink(),'CLIENT_SESSION_UNSAFE_STORAGE');}
    if(dirname(current)===current)break;
  }
  mkdirSync(path,{recursive:true,mode:0o700});
  const stat=lstatSync(path);requireCondition(stat.isDirectory()&&!stat.isSymbolicLink(),'CLIENT_SESSION_UNSAFE_STORAGE');
}
function safeRead(path:string){
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{const stat=fstatSync(fd);requireCondition(stat.isFile()&&stat.nlink===1&&stat.size<=4096,'CLIENT_SESSION_UNSAFE_STORAGE');return JSON.parse(readFileSync(fd,'utf8')) as unknown;}finally{closeSync(fd);}
}
function atomicRecord(path:string,value:z.infer<typeof recordSchema>){
  if(existsSync(path)){const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'CLIENT_SESSION_UNSAFE_STORAGE');}
  const temp=join(dirname(path),`.${randomUUID()}.tmp`);
  try{
    const fd=openSync(temp,'wx',0o600);
    try{writeFileSync(fd,JSON.stringify(value));}finally{closeSync(fd);}
    renameSync(temp,path);
  }catch{throw Error('CLIENT_SESSION_PERSIST_FAILED');}
  finally{if(existsSync(temp))try{unlinkSync(temp);}catch{/* The failed receipt is already fenced. */}}
}
function lock(path:string):number{
  try{const fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));return fd;}catch(error){
    if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
    const stat=lstatSync(path),record=safeRead(path) as {pid?:unknown};
    requireCondition(Number.isInteger(record?.pid)&&Number(record.pid)>0,'CLIENT_SESSION_BUSY');
    try{process.kill(Number(record.pid),0);throw Error('CLIENT_SESSION_BUSY');}catch(probe){
      if((probe as NodeJS.ErrnoException).code!=='ESRCH')throw Error('CLIENT_SESSION_BUSY');
    }
    const fresh=lstatSync(path);requireCondition(stat.ino===fresh.ino&&stat.mtimeMs===fresh.mtimeMs,'CLIENT_SESSION_BUSY');
    unlinkSync(path);try{const fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid}));return fd;}catch{throw Error('CLIENT_SESSION_BUSY');}
  }
}

/** Persist only an opaque, app-created CLI session reference, never credentials
 * or raw page/answer text. No process is retained between model calls. A crash,
 * changed contract, TTL or turn cap starts fresh from the host checkpoint. */
export async function withDecisionSession<T extends {session_id?:string|null}>(scope:DecisionSessionScope,contract:{provider:string;model:string;instructions:string;schema:Record<string,unknown>;connection:string;effort:string|null},invoke:(turn:DecisionSessionTurn)=>Promise<T>){
  requireCondition(isAbsolute(scope.root),'CLIENT_SESSION_UNSAFE_STORAGE');
  for(const value of [scope.work_id,scope.run_id,scope.actor_id,scope.role])scopeId.parse(value);
  const key=hashJson({work_id:scope.work_id,run_id:scope.run_id,actor_id:scope.actor_id,role:scope.role,provider:contract.provider});
  const directory=join(scope.root,key),file=join(directory,'session.json'),lockFile=join(directory,'turn.lock');
  privateDirectory(directory);const fd=lock(lockFile),binding=hashJson({...contract,scope:{...scope,root:resolve(scope.root)}});
  try{
    let prior:z.infer<typeof recordSchema>|null=null;
    if(existsSync(file)){try{prior=recordSchema.parse(safeRead(file));}catch{throw Error('CLIENT_SESSION_UNSAFE_STORAGE');}}
    const age=prior?Date.now()-prior.updated_at:null;
    const reusable=prior&&prior.binding===binding&&!prior.in_flight&&prior.session_id!==null&&prior.turns<32&&age!==null&&age>=0&&age<maxAgeMs;
    let session_id=reusable?prior!.session_id:null,turns=reusable?prior!.turns:0;
    atomicRecord(file,{format:1,binding,session_id,turns,updated_at:Date.now(),in_flight:true});
    try{
      let result:T;
      try{result=await invoke({directory,session_id});}catch(error){
        if(!session_id||!(error instanceof Error)||error.message!=='CLIENT_NATIVE_SESSION_MISSING')throw error;
        // Only the CLI's explicit missing-session rejection is safe to restart
        // here. Timeouts, quota, bad output and unknown failures are not replayed.
        session_id=null;turns=0;result=await invoke({directory,session_id});
      }
      if(result.session_id)z.string().uuid().parse(result.session_id);
      requireCondition(!session_id||result.session_id===session_id,'CLIENT_STRUCTURED_OUTPUT_INVALID');
      atomicRecord(file,{format:1,binding,session_id:result.session_id??null,turns:turns+1,updated_at:Date.now(),in_flight:false});
      return {...result,continuity:result.session_id?(session_id?'resumed_session' as const:'new_session' as const):'checkpoint_only' as const,session_turn:turns+1};
    }catch(error){
      // Never resume an unacknowledged/invalid turn. The host's last checkpoint
      // remains authoritative; no tool operation is retried by this module.
      atomicRecord(file,{format:1,binding,session_id:null,turns:0,updated_at:Date.now(),in_flight:false});throw error;
    }
  }finally{closeSync(fd);try{unlinkSync(lockFile);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw Error('CLIENT_SESSION_PERSIST_FAILED');}}
}
