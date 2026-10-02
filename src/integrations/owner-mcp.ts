import {readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {environmentHomes,type EnvironmentHome} from './client-environment.js';

/** The MCP servers the owner already set up for their AI apps, used by Office without a setup step (owner direction
 * 2026-10-03: "use what fits, drop what does not, by itself").
 *
 * What fits is decided here, not by the owner one server at a time:
 * - a server Office already covers (its own MCP, a browser) or one that runs code or controls the computer is left out;
 * - a server that does not answer is left out;
 * - of an answering server only tools that read are offered. A tool reads when the server says so
 *   (readOnlyHint) or, without a hint, when its name is a plain read verb and carries no write verb. Everything else
 *   is left out, so no call through this path changes anything outside Office;
 * - a tool that reads files, folders or code on this computer is left out too: Office has its own folder permissions,
 *   and a server's file tool would read around them (live: a code-analysis server offered read_file and list_dir).
 * A server's command, arguments and environment are read from the owner's own configuration when it is started and
 * are never stored, logged or shown. */
export interface OwnerMcpTool {name:string;server:string;tool:string;description:string;input_schema:Record<string,unknown>;}
export interface OwnerMcpSnapshot {tools:OwnerMcpTool[];used:Array<{server:string;tools:string[]}>;left_out:Array<{server:string;reason:'covered_by_office'|'runs_code_or_controls_computer'|'reads_local_files'|'not_reachable'|'no_read_tool'|'other_computer'|'disabled'}>;checked_at:string;}
type Launch={kind:'stdio';command:string;args:string[];env:Record<string,string>}|{kind:'http';url:string};
interface ServerDefinition {id:string;side:EnvironmentHome['side'];disabled:boolean;launch:Launch|null;}

const TOOLS_PER_SERVER=6,SERVERS=8,RESULT_BYTES=10_000;
const covered=/(?:^|[^a-z])(?:agent[-_ ]?(?:driver|office)|aside|neo|browser(?:os)?|chrome|openchrome|playwright|puppeteer|selenium)(?:[^a-z]|$)/iu;
const runsCode=/(?:repl|(?:^|[^a-z])cua(?:[^a-z]|$)|computer|shell|terminal|desktop|exec|sandbox)/iu;
const readVerb=/^(?:get|list|search|read|find|query|resolve|fetch|lookup|describe|show|check)(?:[-_A-Z]|$)/u,writeVerb=/(?:create|update|delete|write|send|post|remove|insert|upload|execute|install|edit|apply|commit|push|merge|cancel|set(?:[-_A-Z]|$)|run(?:[-_A-Z]|$))/iu;
const localFiles=/(?:file|dir(?:ectory)?|folder|path|symbol|pattern|memory|workspace|repo)/iu;
const text=(path:string)=>{try{return statSync(path).size>4_000_000?'':readFileSync(path,'utf8').replace(/\r\n/gu,'\n');}catch{return '';}};
const identity=(value:string)=>value.toLowerCase().replace(/[^a-z0-9]+/gu,'_').replace(/^_+|_+$/gu,'').slice(0,24);
const strings=(value:unknown)=>Array.isArray(value)&&value.every(item=>typeof item==='string')?value as string[]:[];
const stringMap=(value:unknown)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.entries(value).filter((entry):entry is [string,string]=>typeof entry[1]==='string')):{};
function reachableUrl(value:unknown){
  if(typeof value!=='string')return null;
  try{const url=new URL(value),loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);return url.protocol==='https:'||url.protocol==='http:'&&loopback?url.href:null;}catch{return null;}
}
function launchOf(side:EnvironmentHome['side'],value:{command?:unknown;args?:unknown;env?:unknown;url?:unknown}):Launch|null{
  const url=reachableUrl(value.url);if(url)return {kind:'http',url};
  // A program configured on the Windows side is a Windows program; it is not started from here.
  return side==='local'&&typeof value.command==='string'&&value.command?{kind:'stdio',command:value.command,args:strings(value.args),env:stringMap(value.env)}:null;
}
/** Server sections of a Codex config.toml. Only the keys needed to start a server are read. */
function codexServers(config:string,side:EnvironmentHome['side']):ServerDefinition[]{
  const sections=new Map<string,{body:string;env:string}>();
  for(const match of config.matchAll(/^\[mcp_servers\.(?:"([^"\]]+)"|([A-Za-z0-9_-]+))(\.env)?\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gmu)){
    const key=match[1]??match[2]!,entry=sections.get(key)??{body:'',env:''};if(match[3])entry.env=match[4]!;else entry.body=match[4]!;sections.set(key,entry);
  }
  const scalar=(body:string,key:string)=>new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`,'mu').exec(body)?.[1]?.replace(/\\\\/gu,'\\').replace(/\\"/gu,'"');
  const array=(body:string,key:string)=>{const raw=new RegExp(`^${key}\\s*=\\s*(\\[[^\\]]*\\])`,'mu').exec(body)?.[1];try{return raw?strings(JSON.parse(raw)):[];}catch{return [];}};
  return [...sections].map(([key,entry])=>({id:identity(key),side,disabled:/^enabled\s*=\s*false/mu.test(entry.body),
    launch:launchOf(side,{command:scalar(entry.body,'command'),args:array(entry.body,'args'),url:scalar(entry.body,'url'),env:Object.fromEntries([...entry.env.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/gmu)].map(match=>[match[1]!,match[2]!]))})}));
}
function jsonServers(path:string,side:EnvironmentHome['side']):ServerDefinition[]{
  let parsed:{mcpServers?:Record<string,{command?:unknown;args?:unknown;env?:unknown;url?:unknown;disabled?:unknown}>}={};
  try{parsed=JSON.parse(text(path)||'{}') as typeof parsed;}catch{return [];}
  return Object.entries(parsed.mcpServers??{}).map(([key,value])=>({id:identity(key),side,disabled:value?.disabled===true,launch:value&&typeof value==='object'?launchOf(side,value):null}));
}
export function ownerMcpServers(environment:NodeJS.ProcessEnv=process.env,homes:EnvironmentHome[]=environmentHomes(environment)):ServerDefinition[]{
  const found:ServerDefinition[]=[];
  for(const place of homes){
    const codex=place.side==='local'&&environment.CODEX_HOME||join(place.home,'.codex');
    found.push(...codexServers(text(join(codex,'config.toml')),place.side),...jsonServers(join(place.home,'.claude.json'),place.side));
    if(place.side==='windows')found.push(...jsonServers(join(place.home,'AppData','Roaming','Claude','claude_desktop_config.json'),place.side));
  }
  // One entry per name: a server that can be started here wins over the same name on the other side.
  const byId=new Map<string,ServerDefinition>();
  for(const server of found.filter(item=>item.id))if(!byId.has(server.id)||!byId.get(server.id)!.launch&&server.launch)byId.set(server.id,server);
  return [...byId.values()];
}

type Connect=(launch:Launch,environment:NodeJS.ProcessEnv)=>Promise<{client:Pick<Client,'listTools'|'callTool'|'close'>}>;
const connectLaunch:Connect=async(launch,environment)=>{
  const client=new Client({name:'agent-office',version:'1'});
  const transport=launch.kind==='http'?new StreamableHTTPClientTransport(new URL(launch.url)):new StdioClientTransport({command:launch.command,args:launch.args,env:{...Object.fromEntries(Object.entries(environment).filter((entry):entry is [string,string]=>typeof entry[1]==='string')),...launch.env},stderr:'pipe'});
  if(transport instanceof StdioClientTransport)transport.stderr?.on('data',()=>{});
  try{await client.connect(transport as Transport,{timeout:launch.kind==='http'?8000:30_000});}catch(error){await client.close().catch(()=>{});throw error;}
  return {client};
};
const reads=(tool:{name:string;annotations?:{readOnlyHint?:boolean|undefined;destructiveHint?:boolean|undefined}|undefined})=>tool.annotations?.destructiveHint!==true&&(tool.annotations?.readOnlyHint===true||tool.annotations?.readOnlyHint===undefined&&readVerb.test(tool.name)&&!writeVerb.test(tool.name));

let snapshot:OwnerMcpSnapshot|null=null,definitions=new Map<string,ServerDefinition>(),refreshing:Promise<OwnerMcpSnapshot>|null=null,enabled=false;
/** Looks at every server once and keeps the result until it is asked to look again. */
export function refreshOwnerMcp(environment:NodeJS.ProcessEnv=process.env,dependencies:{servers?:ServerDefinition[];connect?:Connect}={}):Promise<OwnerMcpSnapshot>{
  return refreshing??=(async()=>{
    const connect=dependencies.connect??connectLaunch,servers=dependencies.servers??ownerMcpServers(environment),next:OwnerMcpSnapshot={tools:[],used:[],left_out:[],checked_at:new Date().toISOString()},kept=new Map<string,ServerDefinition>();
    await Promise.all(servers.map(async server=>{
      const leave=(reason:OwnerMcpSnapshot['left_out'][number]['reason'])=>{next.left_out.push({server:server.id,reason});};
      if(covered.test(server.id))return leave('covered_by_office');
      if(runsCode.test(server.id))return leave('runs_code_or_controls_computer');
      if(server.disabled)return leave('disabled');
      if(!server.launch)return leave('other_computer');
      let connection:Awaited<ReturnType<Connect>>|null=null;
      try{
        connection=await connect(server.launch,environment);
        const listed=await connection.client.listTools(undefined,{timeout:10_000});
        const reading=listed.tools.filter(reads),tools=reading.filter(tool=>!localFiles.test(tool.name)).filter(tool=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/u.test(tool.name)&&Buffer.byteLength(JSON.stringify(tool.inputSchema??{}))<=4000).slice(0,TOOLS_PER_SERVER);
        if(!tools.length)return leave(reading.some(tool=>localFiles.test(tool.name))?'reads_local_files':'no_read_tool');
        kept.set(server.id,server);next.used.push({server:server.id,tools:tools.map(tool=>tool.name)});
        for(const tool of tools)next.tools.push({name:`owner_${server.id}_${identity(tool.name)}`.slice(0,60),server:server.id,tool:tool.name,description:`From the owner's MCP server "${server.id}" (read-only). ${String(tool.description??'').replace(/\s+/gu,' ').slice(0,300)}`,input_schema:(tool.inputSchema??{type:'object'}) as Record<string,unknown>});
      }catch{leave('not_reachable');}
      finally{await connection?.client.close().catch(()=>{});}
    }));
    next.used.sort((a,b)=>a.server.localeCompare(b.server));next.left_out.sort((a,b)=>a.server.localeCompare(b.server));
    const allowed=new Set(next.used.slice(0,SERVERS).map(item=>item.server));next.used=next.used.filter(item=>allowed.has(item.server));
    next.tools=next.tools.filter((tool,index,all)=>allowed.has(tool.server)&&all.findIndex(other=>other.name===tool.name)===index).sort((a,b)=>a.name.localeCompare(b.name));
    snapshot=next;definitions=kept;return next;
  })().finally(()=>{refreshing=null;});
}
/** Only a real service process starts the owner's servers; a test or a library use never does unless it asks. */
export function enableOwnerMcp(){enabled=process.env.AGENT_OFFICE_OWNER_MCP!=='off';}
export function disableOwnerMcp(){enabled=false;snapshot=null;definitions=new Map();}
export function ownerMcpEnabled(){return enabled||process.env.AGENT_OFFICE_OWNER_MCP==='on';}
export function ownerMcpSnapshot(){return ownerMcpEnabled()?snapshot:null;}
/** The snapshot for a run that is about to start: the first look is waited for, briefly. */
export async function ownerMcpReady(waitMs=20_000):Promise<OwnerMcpSnapshot|null>{
  if(!ownerMcpEnabled())return null;
  if(snapshot)return snapshot;
  return Promise.race([refreshOwnerMcp().catch(()=>null),new Promise<null>(resolve=>setTimeout(()=>resolve(null),waitMs).unref())]);
}
/** One read through the owner's server. The answer is text the server returned: data, never an instruction. */
export async function callOwnerMcp(tool:OwnerMcpTool,args:Record<string,unknown>,environment:NodeJS.ProcessEnv=process.env,connect:Connect=connectLaunch){
  const server=definitions.get(tool.server);
  if(!server?.launch)return {status:'retryable_failure' as const,reason:'OWNER_MCP_SERVER_NOT_AVAILABLE',server:tool.server,tool:tool.tool,provenance:'owner_mcp_server' as const,effect:'read_only' as const};
  let connection:Awaited<ReturnType<Connect>>|null=null;
  try{
    connection=await connect(server.launch,environment);
    const result=await connection.client.callTool({name:tool.tool,arguments:args},undefined,{timeout:45_000}) as {content?:Array<{type?:string;text?:unknown}>;isError?:boolean};
    const whole=Buffer.from((result.content??[]).filter(item=>item.type==='text'&&typeof item.text==='string').map(item=>item.text as string).join('\n'),'utf8');
    let end=Math.min(whole.length,RESULT_BYTES);while(end<whole.length&&end>0&&(whole[end]!&0xC0)===0x80)end--;
    return {status:result.isError?'retryable_failure' as const:'succeeded' as const,...(result.isError?{reason:'OWNER_MCP_TOOL_ERROR'}:{}),server:tool.server,tool:tool.tool,text:whole.subarray(0,end).toString('utf8'),text_bytes_total:whole.length,truncated:end<whole.length,observed_at:new Date().toISOString(),provenance:'owner_mcp_server' as const,effect:'read_only' as const};
  }catch{return {status:'retryable_failure' as const,reason:'OWNER_MCP_CALL_FAILED',server:tool.server,tool:tool.tool,provenance:'owner_mcp_server' as const,effect:'read_only' as const};}
  finally{await connection?.client.close().catch(()=>{});}
}
