import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {ensureMcpService} from './mcp-service-manager.js';

/** Protocol bridge only: no RuntimeApi, DB, browser or provider lives here.
 * Responses, sampling and elicitation retain the client's original IDs. */
export async function serveMcpProxy(configPath:string){
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
    if(!closing)void input.send(message).catch(fail);
  };
  input.onmessage=message=>{if(closing)return;if('method'in message&&message.method==='initialize'&&'id'in message)initializeId=message.id;void remote.send(message).catch(fail);};
  remote.onerror=fail;input.onerror=fail;
  try{await remote.start();await input.start();if(process.stdin.readableEnded||process.stdin.destroyed)end();}catch{await close();throw Error('MCP_PROXY_CONNECTION_FAILED');}
}
