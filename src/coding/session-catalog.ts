import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {requireCondition} from '../core/contracts.js';

const sessionIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const maxLineBytes=1_048_576;
const pageLimit=50;
const maxPages=20;

export type CodexSessionStatus='notLoaded'|'idle'|'active'|'systemError'|'unknown';
export interface CodexSessionSummary {
  id:string;
  title:string|null;
  preview:string|null;
  status:CodexSessionStatus;
  created_at:number|null;
  updated_at:number|null;
}
export interface CodexSessionCatalog {
  list(projectRoot:string):Promise<CodexSessionSummary[]>;
  inspect(projectRoot:string,sessionId:string):Promise<CodexSessionSummary>;
}

interface RpcReply {id?:unknown;result?:unknown;error?:unknown;}
interface RpcWaiter {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timeout:NodeJS.Timeout;}
const record=(value:unknown):Record<string,unknown>|null=>value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
const status=(value:unknown):CodexSessionStatus=>{
  const kind=record(value)?.type;
  return kind==='notLoaded'||kind==='idle'||kind==='active'||kind==='systemError'?kind:'unknown';
};
const short=(value:unknown,max:number)=>typeof value==='string'&&value.trim()?value.trim().slice(0,max):null;
const timestamp=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
function summary(value:unknown):CodexSessionSummary|null {
  const item=record(value),id=item?.id;
  if(typeof id!=='string'||!sessionIdPattern.test(id))return null;
  return {id,title:short(item?.name,160),preview:short(item?.preview,240),status:status(item?.status),created_at:timestamp(item?.createdAt),updated_at:timestamp(item?.updatedAt)};
}
function projectRoot(root:string){
  requireCondition(isAbsolute(root)&&realpathSync(root)===root,'CODING_PROJECT_ROOT_CHANGED');
  return root;
}
function environment(){
  const value:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','USERPROFILE','CODEX_HOME','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot'])if(process.env[key])value[key]=process.env[key];
  return value;
}

/** A short-lived stdio connection. It discards unsolicited notifications and never logs session content. */
class AppServerConnection {
  private readonly child:ChildProcessWithoutNullStreams;
  private readonly pending=new Map<number,RpcWaiter>();
  private nextId=1;
  private buffer='';
  private closed=false;
  constructor(executable:string,args:string[],root:string,private readonly timeoutMs:number){
    this.child=spawn(executable,args,{cwd:root,env:environment(),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data',(chunk:string)=>this.receive(chunk));
    this.child.stderr.resume();
    this.child.once('error',()=>this.fail('CODEX_SESSION_CATALOG_PROCESS_FAILED'));
    this.child.once('close',()=>this.fail('CODEX_SESSION_CATALOG_PROCESS_CLOSED'));
  }
  private fail(code:string){
    if(this.closed)return;
    this.closed=true;
    for(const [id,waiter] of this.pending){clearTimeout(waiter.timeout);waiter.reject(Error(code));this.pending.delete(id);}
    this.child.kill('SIGTERM');
  }
  private receive(chunk:string){
    if(this.closed)return;
    this.buffer+=chunk;
    if(Buffer.byteLength(this.buffer)>maxLineBytes){this.fail('CODEX_SESSION_CATALOG_OUTPUT_TOO_LARGE');return;}
    for(;;){
      const end=this.buffer.indexOf('\n');if(end<0)break;
      const line=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+1);
      if(!line.trim())continue;
      let reply:RpcReply;try{reply=JSON.parse(line) as RpcReply;}catch{this.fail('CODEX_SESSION_CATALOG_INVALID_JSON');return;}
      if(typeof reply.id!=='number')continue;
      const waiter=this.pending.get(reply.id);if(!waiter)continue;
      this.pending.delete(reply.id);clearTimeout(waiter.timeout);
      if(reply.error!==undefined)waiter.reject(Error('CODEX_SESSION_CATALOG_REMOTE_ERROR'));
      else waiter.resolve(reply.result);
    }
  }
  private send(value:unknown){
    requireCondition(!this.closed,'CODEX_SESSION_CATALOG_PROCESS_CLOSED');
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  request(method:string,params:Record<string,unknown>):Promise<unknown>{
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{this.pending.delete(id);reject(Error('CODEX_SESSION_CATALOG_TIMEOUT'));this.fail('CODEX_SESSION_CATALOG_TIMEOUT');},this.timeoutMs);
      this.pending.set(id,{resolve,reject,timeout});
      try{this.send({id,method,params});}catch(error){clearTimeout(timeout);this.pending.delete(id);reject(error);}
    });
  }
  async initialize(){
    await this.request('initialize',{clientInfo:{name:'agent_driver_session_catalog',title:'Agent Driver session catalog',version:'1.0.0'}});
    this.send({method:'initialized',params:{}});
  }
  close(){this.fail('CODEX_SESSION_CATALOG_CLOSED');}
}

/** Lists only Codex CLI/exec sessions in the exact registered project. No turn is started. */
export class NativeCodexSessionCatalog implements CodexSessionCatalog {
  constructor(private readonly executable:string,private readonly options:{args?:string[];timeout_ms?:number}={}){}
  private async connection<T>(root:string,action:(rpc:AppServerConnection)=>Promise<T>):Promise<T>{
    const rpc=new AppServerConnection(this.executable,this.options.args??['app-server','--stdio'],projectRoot(root),this.options.timeout_ms??8_000);
    try{await rpc.initialize();return await action(rpc);}finally{rpc.close();}
  }
  private async listOn(rpc:AppServerConnection,root:string){
    const found:CodexSessionSummary[]=[],seen=new Set<string>();let cursor:string|null=null;
    for(let page=0;page<maxPages;page++){
      // The default JSONL repair scan can block for minutes on a long-lived Codex home.
      // Session selection is interactive, so use the indexed state database only.
      const result=record(await rpc.request('thread/list',{cwd:root,sourceKinds:['cli','exec'],archived:false,useStateDbOnly:true,limit:pageLimit,...(cursor?{cursor}:{})}));
      requireCondition(Array.isArray(result?.data),'CODEX_SESSION_CATALOG_INVALID_REPLY');
      for(const value of result.data){
        const item=record(value),parsed=summary(value);
        if(!parsed||seen.has(parsed.id))continue;
        if(item?.cwd!==root)continue;
        seen.add(parsed.id);found.push(parsed);
      }
      if(result.nextCursor===null||result.nextCursor===undefined)return found;
      requireCondition(typeof result.nextCursor==='string'&&result.nextCursor.length>0&&result.nextCursor!==cursor,'CODEX_SESSION_CATALOG_INVALID_CURSOR');
      cursor=result.nextCursor;
    }
    throw Error('CODEX_SESSION_CATALOG_PAGE_LIMIT');
  }
  list(projectRootPath:string){
    const root=projectRoot(projectRootPath);
    return this.connection(root,rpc=>this.listOn(rpc,root));
  }
  inspect(projectRootPath:string,sessionId:string){
    requireCondition(sessionIdPattern.test(sessionId),'CODING_SESSION_ID_INVALID');
    const root=projectRoot(projectRootPath);
    return this.connection(root,async rpc=>{
      const matched=(await this.listOn(rpc,root)).find(item=>item.id===sessionId);
      requireCondition(matched,'CODING_SESSION_PROJECT_MISMATCH');
      const result=record(await rpc.request('thread/read',{threadId:sessionId,includeTurns:false}));
      const raw=record(result?.thread),fresh=summary(raw);
      requireCondition(fresh?.id===sessionId,'CODEX_SESSION_CATALOG_INVALID_REPLY');
      requireCondition(raw?.cwd===root,'CODING_SESSION_PROJECT_MISMATCH');
      return {...matched,...fresh};
    });
  }
}
