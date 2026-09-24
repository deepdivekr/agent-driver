import {randomUUID,createHash} from 'node:crypto';
import {existsSync,lstatSync,readFileSync} from 'node:fs';
import {chmod,mkdir,rename,writeFile} from 'node:fs/promises';
import {homedir,userInfo} from 'node:os';
import {dirname,isAbsolute,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {configureHermes,hermesDoctor,hermesHome} from '../integrations/hermes.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable,type SafeProcessRunner,type SubscriptionClientId} from '../integrations/subscription-auth.js';
import {localConnectionPaths} from './connection.js';

export type McpRegistrationClient=SubscriptionClientId;
const clientIds=['codex','claude','opencode','cursor','hermes'] as const;
const receiptSchema=z.object({format:z.literal(1),registrations:z.partialRecord(z.enum(clientIds),z.object({registered_at:z.string().datetime(),command_fingerprint:z.string().regex(/^[a-f0-9]{64}$/u)}).strict()).default({})}).strict();
type Receipts=z.infer<typeof receiptSchema>;
export interface McpClientRegistrationView {id:McpRegistrationClient;installed:boolean;registration:'registered'|'not_registered'|'unavailable'|'conflict'|'unknown';automatic:boolean;reason:string;restart_required:boolean;}
export interface WindowsMcpBridge {command:'wsl.exe';args:string[];registration:'manual_unverified';}
export interface McpRegistrationView {agent_driver:{installed:true;mcp_command:'agent-driver mcp'};clients:McpClientRegistrationView[];registered_count:number;windows_bridge?:WindowsMcpBridge;credentials_exposed:false;}

function entrypoint(){return resolve(fileURLToPath(new URL('../cli.js',import.meta.url)));}
/** Windows desktop MCP clients can launch the same WSL stdio server without a shell or credential copy. */
export function windowsMcpBridge(environment:NodeJS.ProcessEnv=process.env):WindowsMcpBridge|undefined{
  const distro=environment.WSL_DISTRO_NAME;
  if(!distro||distro.length>128||/[\u0000-\u001f\u007f]/u.test(distro))return undefined;
  const user=userInfo().username;
  if(!user||user.length>128||/[\u0000-\u001f\u007f]/u.test(user))return undefined;
  return {command:'wsl.exe',args:['--distribution',distro,'--user',user,'--exec',process.execPath,entrypoint(),'mcp'],registration:'manual_unverified'};
}
function fingerprint(command:string,args:readonly string[]){return createHash('sha256').update(JSON.stringify({command,args})).digest('hex');}
function privatePath(root:string){return join(localConnectionPaths(root).root,'mcp-registrations.json');}
function readReceipts(root:string):Receipts{const path=privatePath(root);if(!existsSync(path))return {format:1,registrations:{}};return receiptSchema.parse(JSON.parse(readFileSync(path,'utf8')));}
async function writeReceipts(root:string,value:Receipts){const path=privatePath(root),temporary=path+'.'+randomUUID()+'.tmp';await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);}
function cursorConfigPath(environment:NodeJS.ProcessEnv){const configured=environment.AGENT_DRIVER_CURSOR_MCP_CONFIG;if(configured!==undefined){requireCondition(isAbsolute(configured),'CURSOR_MCP_CONFIG_ABSOLUTE_REQUIRED');return resolve(configured);}return join(environment.HOME??homedir(),'.cursor','mcp.json');}
function exactCursorEntry(value:unknown,command:string,args:readonly string[]){if(!value||typeof value!=='object'||Array.isArray(value))return false;const entry=(value as {mcpServers?:Record<string,unknown>}).mcpServers?.['agent-driver'];if(!entry||typeof entry!=='object'||Array.isArray(entry))return false;const typed=entry as {command?:unknown;args?:unknown};return typed.command===command&&Array.isArray(typed.args)&&JSON.stringify(typed.args)===JSON.stringify(args);}
function cursorRegistration(environment:NodeJS.ProcessEnv,command:string,args:readonly string[]){const path=cursorConfigPath(environment);if(!existsSync(path))return 'not_registered' as const;const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink(),'CURSOR_MCP_CONFIG_UNSAFE');const value=JSON.parse(readFileSync(path,'utf8')) as unknown;if(exactCursorEntry(value,command,args))return 'registered' as const;const existing=value&&typeof value==='object'&&!Array.isArray(value)?(value as {mcpServers?:Record<string,unknown>}).mcpServers?.['agent-driver']:undefined;return existing===undefined?'not_registered' as const:'conflict' as const;}
async function writeCursor(environment:NodeJS.ProcessEnv,command:string,args:readonly string[]){
  const path=cursorConfigPath(environment);let value:Record<string,unknown>={};
  if(existsSync(path)){const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink(),'CURSOR_MCP_CONFIG_UNSAFE');value=JSON.parse(readFileSync(path,'utf8')) as Record<string,unknown>;requireCondition(value&&typeof value==='object'&&!Array.isArray(value),'CURSOR_MCP_CONFIG_INVALID');}
  const servers=value.mcpServers===undefined?{}:value.mcpServers;requireCondition(servers&&typeof servers==='object'&&!Array.isArray(servers),'CURSOR_MCP_CONFIG_INVALID');
  const current=(servers as Record<string,unknown>)['agent-driver'];requireCondition(current===undefined||exactCursorEntry(value,command,args),'MCP_REGISTRATION_CONFLICT');
  const next={...value,mcpServers:{...(servers as Record<string,unknown>),'agent-driver':{command,args:[...args]}}},temporary=path+'.'+randomUUID()+'.tmp';await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(temporary,JSON.stringify(next,null,2)+'\n',{mode:0o600});await chmod(temporary,0o600);await rename(temporary,path);await chmod(path,0o600);
}
function installed(id:McpRegistrationClient,environment:NodeJS.ProcessEnv){try{resolveSubscriptionClientExecutable(id,environment);return true;}catch{return false;}}
function runnerArgs(id:Exclude<McpRegistrationClient,'cursor'|'hermes'>,command:string,args:readonly string[]){
  if(id==='codex')return ['mcp','add','agent-driver','--',command,...args];
  if(id==='claude')return ['mcp','add','--scope','user','agent-driver','--',command,...args];
  return ['mcp','add','agent-driver','--global','--',command,...args];
}

/** Registers the absolute Node/CLI entrypoint. No shell is used and client auth stores are never read. */
export class McpRegistrationController{
  readonly command=process.execPath;readonly args=[entrypoint(),'mcp'] as const;
  constructor(readonly root:string,readonly environment:NodeJS.ProcessEnv=process.env,readonly runner:SafeProcessRunner=nativeProcessRunner){}
  async view():Promise<McpRegistrationView>{
    const receipts=readReceipts(this.root),signature=fingerprint(this.command,this.args),clients:McpClientRegistrationView[]=[];
    for(const id of clientIds){
      const present=installed(id,this.environment);let registration:McpClientRegistrationView['registration']='not_registered',reason='not_registered';
      try{
        if(id==='cursor'){registration=cursorRegistration(this.environment,this.command,this.args);reason=registration;}
        else if(id==='hermes'){const doctor=hermesDoctor(hermesHome(this.environment));registration=doctor.agent_driver_mcp==='ready'?'registered':receipts.registrations[id]?.command_fingerprint===signature?'unknown':'not_registered';reason=doctor.agent_driver_mcp;}
        else if(receipts.registrations[id]?.command_fingerprint===signature){registration='registered';reason='registered_by_agent_driver';}
      }catch{registration='conflict';reason='existing_configuration_requires_review';}
      if(!present){registration='unavailable';reason=this.environment.WSL_DISTRO_NAME||this.environment.WSL_INTEROP?'wsl_native_client_not_found':'client_not_available';}
      clients.push({id,installed:present,registration,automatic:present,reason,restart_required:registration==='registered'});
    }
    const windows_bridge=windowsMcpBridge(this.environment);
    return {agent_driver:{installed:true,mcp_command:'agent-driver mcp'},clients,registered_count:clients.filter(item=>item.registration==='registered').length,...(windows_bridge?{windows_bridge}:{}),credentials_exposed:false};
  }
  async register(id:McpRegistrationClient){
    requireCondition(clientIds.includes(id),'MCP_CLIENT_INVALID');const present=installed(id,this.environment);requireCondition(present,'MCP_CLIENT_UNAVAILABLE');
    const receipts=readReceipts(this.root),signature=fingerprint(this.command,this.args);
    if(id==='cursor')await writeCursor(this.environment,this.command,this.args);
    else if(id==='hermes'){
      const doctor=hermesDoctor(hermesHome(this.environment));
      if(doctor.agent_driver_mcp==='misconfigured'&&receipts.registrations[id]?.command_fingerprint!==signature)throw Error('MCP_REGISTRATION_CONFLICT');
      await configureHermes({home:hermesHome(this.environment),command:this.command,args:[...this.args]});
    }else{
      const executable=resolveSubscriptionClientExecutable(id,this.environment),result=await this.runner.run({executable,args:runnerArgs(id,this.command,this.args),timeout_ms:15_000});
      requireCondition(result.code===0,'MCP_REGISTRATION_FAILED');
    }
    receipts.registrations[id]={registered_at:new Date().toISOString(),command_fingerprint:signature};await writeReceipts(this.root,receipts);return this.view();
  }
}
