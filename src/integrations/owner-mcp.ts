import {existsSync,readFileSync,statSync} from 'node:fs';
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
 * - a server with any tool that reads files, folders or code on this computer is left out as a whole: Office has its
 *   own folder permissions, a server's file tool would read around them, and its other tools work on the same local
 *   project (live: a code-analysis server offered read_file, and after those were dropped it still offered
 *   find_declaration, activate_project and onboarding, which change its own project state).
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
const localFiles=/(?:file|dir(?:ectory)?|folder|path|symbol|pattern|memor(?:y|ies)|workspace|repo|project|declaration|implementation|onboarding)/iu;
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
/** A server section as the owner wrote it; only the keys needed to start a server are read. */
interface ServerEntry {key:string;command?:string|undefined;args:string[];url?:string|undefined;env:Record<string,string>;disabled:boolean;startup_timeout_sec?:number|undefined;tool_timeout_sec?:number|undefined;}
/** Server sections of a Codex config.toml. */
function codexEntries(config:string):ServerEntry[]{
  const sections=new Map<string,{body:string;env:string}>();
  for(const match of config.matchAll(/^\[mcp_servers\.(?:"([^"\]]+)"|([A-Za-z0-9_-]+))(\.env)?\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/gmu)){
    const key=match[1]??match[2]!,entry=sections.get(key)??{body:'',env:''};if(match[3])entry.env=match[4]!;else entry.body=match[4]!;sections.set(key,entry);
  }
  // A basic "string" (with escapes) or a literal 'string' (as written, often a Windows path).
  const scalar=(body:string,key:string)=>new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`,'mu').exec(body)?.[1]?.replace(/\\\\/gu,'\\').replace(/\\"/gu,'"')??new RegExp(`^${key}\\s*=\\s*'([^'\\n]*)'`,'mu').exec(body)?.[1];
  const array=(body:string,key:string)=>{const raw=new RegExp(`^${key}\\s*=\\s*(\\[[^\\]]*\\])`,'mu').exec(body)?.[1];try{return raw?strings(JSON.parse(raw)):[];}catch{return [];}};
  const number=(body:string,key:string)=>{const raw=new RegExp(`^${key}\\s*=\\s*([0-9]+(?:\\.[0-9]+)?)\\s*$`,'mu').exec(body)?.[1];return raw?Number(raw):undefined;};
  return [...sections].map(([key,entry])=>({key,command:scalar(entry.body,'command'),args:array(entry.body,'args'),url:scalar(entry.body,'url'),disabled:/^enabled\s*=\s*false/mu.test(entry.body),
    env:Object.fromEntries([...entry.env.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:[^"\\]|\\.)*)"/gmu)].map(match=>[match[1]!,match[2]!])),startup_timeout_sec:number(entry.body,'startup_timeout_sec'),tool_timeout_sec:number(entry.body,'tool_timeout_sec')}));
}
function jsonEntries(path:string):ServerEntry[]{
  let parsed:{mcpServers?:Record<string,{command?:unknown;args?:unknown;env?:unknown;url?:unknown;disabled?:unknown}>}={};
  try{parsed=JSON.parse(text(path)||'{}') as typeof parsed;}catch{return [];}
  return Object.entries(parsed.mcpServers??{}).filter(([,value])=>value&&typeof value==='object').map(([key,value])=>({key,command:typeof value.command==='string'?value.command:undefined,args:strings(value.args),url:typeof value.url==='string'?value.url:undefined,env:stringMap(value.env),disabled:value.disabled===true}));
}
const definition=(side:EnvironmentHome['side'])=>(entry:ServerEntry):ServerDefinition=>({id:identity(entry.key),side,disabled:entry.disabled,launch:launchOf(side,entry)});
export function ownerMcpServers(environment:NodeJS.ProcessEnv=process.env,homes:EnvironmentHome[]=environmentHomes(environment)):ServerDefinition[]{
  const found:ServerDefinition[]=[];
  for(const place of homes){
    const codex=place.side==='local'&&environment.CODEX_HOME||join(place.home,'.codex');
    found.push(...[...codexEntries(text(join(codex,'config.toml'))),...jsonEntries(join(place.home,'.claude.json'))].map(definition(place.side)));
    if(place.side==='windows')found.push(...jsonEntries(join(place.home,'AppData','Roaming','Claude','claude_desktop_config.json')).map(definition(place.side)));
  }
  // One entry per name: a server that can be started here wins over the same name on the other side.
  const byId=new Map<string,ServerDefinition>();
  for(const server of found.filter(item=>item.id))if(!byId.has(server.id)||!byId.get(server.id)!.launch&&server.launch)byId.set(server.id,server);
  return [...byId.values()];
}

/** An MCP server the owner set up on the Windows side of this computer, as a client run started here can use it. */
export interface ClientRunMcpServer {id:string;command?:string;args?:string[];url?:string;startup_timeout_sec?:number;tool_timeout_sec?:number;}
// The Codex desktop app's own runtimes (its REPL and computer-use bridge) work only inside that app.
const desktopInternal=/\\(?:OpenAI\\Codex|WindowsApps\\OpenAI\.Codex)/iu;
/** Windows-side servers a client started here cannot see (live 2026-10-03: Aside, the owner's main browser, is registered
 * only in the Windows Codex app). A Windows program is started from here through the /mnt mount; a URL server is kept when
 * it answers from here. A server the local side already defines, a disabled one and one that needs configured environment
 * values are left out. Unlike the owner's tools Office calls itself, these are handed to the owner's own client. */
export async function windowsClientServers(environment:NodeJS.ProcessEnv=process.env,homes:EnvironmentHome[]=environmentHomes(environment),options:{mount?:string;reachable?:(url:string)=>Promise<boolean>}={}):Promise<ClientRunMcpServer[]>{
  const windows=homes.find(place=>place.side==='windows'),local=homes.find(place=>place.side==='local');if(!windows)return [];
  const mount=options.mount??'/mnt',reachable=options.reachable??(async(url:string)=>{try{await fetch(url,{method:'GET',signal:AbortSignal.timeout(1500)});return true;}catch{return false;}});
  const localCodex=environment.CODEX_HOME??(local?join(local.home,'.codex'):''),localNames=new Set([...codexEntries(text(join(localCodex,'config.toml'))),...(local?jsonEntries(join(local.home,'.claude.json')):[])].map(entry=>entry.key));
  const found=[...codexEntries(text(join(windows.home,'.codex','config.toml'))),...jsonEntries(join(windows.home,'.claude.json')),...jsonEntries(join(windows.home,'AppData','Roaming','Claude','claude_desktop_config.json'))];
  const servers:ClientRunMcpServer[]=[],seen=new Set<string>();
  for(const entry of found){
    if(!/^[A-Za-z0-9_-]{1,40}$/u.test(entry.key)||seen.has(entry.key)||localNames.has(entry.key)||entry.disabled||Object.keys(entry.env).length)continue;seen.add(entry.key);
    const timeouts={...(entry.startup_timeout_sec?{startup_timeout_sec:entry.startup_timeout_sec}:{}),...(entry.tool_timeout_sec?{tool_timeout_sec:entry.tool_timeout_sec}:{})};
    if(entry.url){if(/^https?:\/\//u.test(entry.url)&&await reachable(entry.url))servers.push({id:entry.key,url:entry.url,...timeouts});continue;}
    const program=entry.command?.match(/^([A-Za-z]):\\(.+\.exe)$/iu);
    if(!program||desktopInternal.test(entry.command!))continue;
    const path=join(mount,program[1]!.toLowerCase(),...program[2]!.split('\\'));
    if(existsSync(path))servers.push({id:entry.key,command:path,args:entry.args,...timeouts});
  }
  return servers;
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
        if(listed.tools.some(tool=>localFiles.test(tool.name)))return leave('reads_local_files');
        const reading=listed.tools.filter(reads),tools=reading.filter(tool=>/^[A-Za-z0-9][A-Za-z0-9._-]{0,60}$/u.test(tool.name)&&Buffer.byteLength(JSON.stringify(tool.inputSchema??{}))<=4000).slice(0,TOOLS_PER_SERVER);
        if(!tools.length)return leave('no_read_tool');
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
