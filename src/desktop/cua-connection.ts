import {readFileSync,statSync,realpathSync} from 'node:fs';
import {isAbsolute,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {requireCondition} from '../core/contracts.js';
import {type WindowsCuaConfig} from './cua-contracts.js';

export interface CuaPort {call(name:'list_windows'|'get_window_state'|'set_value',args:Record<string,unknown>):Promise<unknown>;close():Promise<void>;connected():boolean;}
export interface CuaTiming {operation:string;elapsed_ms:number;status:'ok'|'failed';}
export type CuaConnectionConfig=Pick<WindowsCuaConfig,'executable'|'executable_sha256'|'version'|'manifest'|'manifest_sha256'|'manifest_reviewed'>;
export type CuaChatTool='list_windows'|'get_window_state'|'click'|'set_value'|'scroll';
export type CuaDesktopTool=CuaChatTool|'bring_to_front';
/** Private child owned by Agent Office, not a Codex tool or shared CUA daemon.
 * No arbitrary tool proxy, shell, implicit foreground escalation,
 * credential environment, telemetry, automatic update or retry-after-write. */
export class OwnedCuaConnection implements CuaPort {
  private client:Client|null=null;
  private transport:StdioClientTransport|null=null;
  private opening:Promise<void>|null=null;
  private stopped=false;
  private ready=false;
  private screenshot:Buffer|null=null;
  readonly timings:CuaTiming[]=[];
  constructor(readonly config:CuaConnectionConfig,private readonly profile:'field'|'reviewed_chat'|'desktop'='field'){}
  connected(){return this.ready&&!this.stopped;}
  get pid(){return this.transport?.pid??null;}
  /** Private caller-owned artifact, never included in timings or MCP logs. */
  takeScreenshot(){const image=this.screenshot;this.screenshot=null;return image;}
  private async open(){
    requireCondition(!this.stopped,'CUA_CONNECTION_CLOSED');
    if(this.ready)return;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      const started=performance.now();
      try{
        requireCondition(this.config.manifest_reviewed===true,'CUA_MANIFEST_REVIEW_REQUIRED');
        requireCondition(process.platform==='win32','CUA_WINDOWS_HOST_REQUIRED');
        for(const [path,hash,limit] of [[this.config.executable,this.config.executable_sha256,100_000_000],[this.config.manifest,this.config.manifest_sha256,64_000]] as const){
          requireCondition(isAbsolute(path),'CUA_ABSOLUTE_PATH_REQUIRED');
          const stat=statSync(path);requireCondition(stat.isFile()&&stat.size<=limit,'CUA_FILE_INVALID');
          requireCondition(createHash('sha256').update(readFileSync(path)).digest('hex')===hash,'CUA_FILE_HASH_CHANGED');
        }
        this.transport=new StdioClientTransport({command:realpathSync(this.config.executable),args:['mcp','--direct','--no-overlay'],
          cwd:dirname(this.config.executable),stderr:'pipe',maxBufferSize:this.profile==='desktop'?12_000_000:512_000,env:{
            CUA_DRIVER_PERMISSION_MODE:'bounded',CUA_DRIVER_CAPABILITY_MANIFEST_FILE:realpathSync(this.config.manifest),
            CUA_DRIVER_CAPABILITY_MANIFEST_APPROVED:'1',CUA_DRIVER_RS_TELEMETRY_ENABLED:'false',CUA_DRIVER_RS_UPDATE_CHECK:'false',
          }});
        // Drain, never persist private native diagnostics or permit pipe blockage.
        this.transport.stderr?.on('data',()=>{});
        this.client=new Client({name:'agent-office-windows',version:'0.2.0'});
        this.client.onclose=()=>{this.ready=false;this.stopped=true;};
        await this.client.connect(this.transport,{timeout:15_000});
        requireCondition(!this.stopped,'CUA_CONNECTION_CLOSED');
        requireCondition(this.client.getServerVersion()?.version===this.config.version,'CUA_VERSION_MISMATCH');
        this.ready=true;this.timings.push({operation:'connect',elapsed_ms:Math.round(performance.now()-started),status:'ok'});
      }catch(error){
        this.timings.push({operation:'connect',elapsed_ms:Math.round(performance.now()-started),status:'failed'});
        await this.close();throw error;
      }
    })();
    return this.opening;
  }
  async call(name:CuaDesktopTool,args:Record<string,unknown>){
    const allowed=this.profile==='field'?['list_windows','get_window_state','set_value']:['list_windows','get_window_state','click','set_value','scroll',...(this.profile==='desktop'?['bring_to_front']:[])];
    requireCondition(allowed.includes(name),'CUA_TOOL_FORBIDDEN');
    if(this.profile!=='field'){
      requireCondition(Number.isSafeInteger(args.pid)&&Number(args.pid)>0,'CUA_CHAT_PID_REQUIRED');
      if(name!=='list_windows')requireCondition(Number.isSafeInteger(args.window_id)&&Number(args.window_id)>0,'CUA_CHAT_WINDOW_REQUIRED');
      requireCondition(args.scope!== 'desktop'&&!args.target,'CUA_CHAT_DESKTOP_FORBIDDEN');
    }
    await this.open();const started=performance.now();
    try{
      const response=await this.client!.callTool({name,arguments:args},undefined,{timeout:10_000});
      requireCondition(!response.isError,'CUA_TOOL_REFUSED');
      requireCondition(response.structuredContent!==undefined,'CUA_STRUCTURED_RESULT_REQUIRED');
      this.screenshot=null;
      if((this.profile==='reviewed_chat'||this.profile==='desktop')&&name==='get_window_state'&&args.include_screenshot===true){
        const content=response.content;
        if(Array.isArray(content))for(const item of content as {type?:unknown;mimeType?:unknown;data?:unknown}[]){
          if(item.type==='image'&&item.mimeType==='image/png'&&typeof item.data==='string'){
            requireCondition(item.data.length<=(this.profile==='desktop'?11_000_000:500_000),'CUA_IMAGE_TOO_LARGE');
            this.screenshot=Buffer.from(item.data,'base64');break;
          }
        }
      }
      this.timings.push({operation:name,elapsed_ms:Math.round(performance.now()-started),status:'ok'});
      return response.structuredContent;
    }catch(error){
      this.timings.push({operation:name,elapsed_ms:Math.round(performance.now()-started),status:'failed'});
      // The write may already have happened. Stop the child; reconciliation is
      // a separate path. Never reconnect and replay from here.
      await this.close();throw error;
    }finally{if(this.timings.length>200)this.timings.splice(0,this.timings.length-200);}
  }
  async close(){this.screenshot=null;this.ready=false;this.stopped=true;await this.client?.close();await this.transport?.close();}
}
