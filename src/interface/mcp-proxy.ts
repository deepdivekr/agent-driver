import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ensureMcpService} from './mcp-service-manager.js';

/** Protocol bridge only: no RuntimeApi, DB, browser or provider lives here.
 * Responses, sampling and elicitation retain the client's original IDs. */
/** What an agent needs to hand work to Agent Office and follow it. The full surface is 114 tools and about
 * 115 KB of descriptions (≈29k tokens) in every client session, and some clients cap the tool count. The other
 * tools keep their names and stay callable; `agent-office mcp --all-tools` or AGENT_OFFICE_MCP_TOOLS=all lists them. */
export const COMPACT_MCP_TOOLS=new Set(['runtime_work_start','runtime_work_status','runtime_work_answer','runtime_work_control','runtime_work_list','runtime_work_result','runtime_work_execute','runtime_work_context','runtime_health','runtime_capabilities_list']);
export const compactMcpTools=<T extends {name:string}>(tools:readonly T[])=>tools.filter(tool=>COMPACT_MCP_TOOLS.has(tool.name));
export async function serveMcpProxy(configPath:string,options:{allTools?:boolean}={}){
  const allTools=options.allTools===true||process.env.AGENT_OFFICE_MCP_TOOLS==='all',listRequests=new Set<string|number>();
  const record=await ensureMcpService(configPath);
  const input=new StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:65536});
  const remote=new StreamableHTTPClientTransport(new URL(record.url),{requestInit:{headers:{authorization:'Bearer '+record.token}},reconnectionOptions:{maxRetries:0,maxReconnectionDelay:1000,initialReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
  let closing:Promise<void>|undefined,initializeId:string|number|undefined;
  const close=()=>closing??=(async()=>{detach();clearTimeout(initializationTimer);await input.close();process.stdin.destroy();try{await remote.terminateSession();}finally{await remote.close();}})();
  const end=()=>{void close().catch(()=>{process.exitCode=1;});};
  const fail=()=>{process.exitCode=1;end();},interrupt=()=>{process.exitCode=130;end();},terminate=()=>{process.exitCode=143;end();};
  const detach=()=>{process.stdin.off('end',end);process.stdin.off('close',end);process.stdin.off('error',fail);process.stdout.off('error',fail);process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);};
  const initializationTimer=setTimeout(fail,30_000);initializationTimer.unref();
  process.stdin.once('end',end);process.stdin.once('close',end);process.stdin.on('error',fail);process.stdout.on('error',fail);process.on('SIGINT',interrupt);process.on('SIGTERM',terminate);
  remote.onmessage=message=>{
    if('id'in message&&message.id===initializeId&&'result'in message&&typeof message.result.protocolVersion==='string'){clearTimeout(initializationTimer);remote.setProtocolVersion(message.result.protocolVersion);}
    if(!allTools&&'id'in message&&listRequests.delete(message.id as string|number)&&'result'in message&&Array.isArray((message.result as {tools?:unknown}).tools))message={...message,result:{...message.result,tools:compactMcpTools((message.result as {tools:Array<{name:string}>}).tools)}};
    if(!closing)void input.send(message).catch(fail);
  };
  input.onmessage=message=>{if(closing)return;if('method'in message&&message.method==='initialize'&&'id'in message)initializeId=message.id;if('method'in message&&message.method==='tools/list'&&'id'in message)listRequests.add(message.id);void remote.send(message).catch(fail);};
  remote.onerror=fail;input.onerror=fail;
  try{await remote.start();await input.start();if(process.stdin.readableEnded||process.stdin.destroyed)end();}catch{await close();throw Error('MCP_PROXY_CONNECTION_FAILED');}
}
