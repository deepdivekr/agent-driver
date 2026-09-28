import {fileURLToPath} from 'node:url';
import {acquireMcpProcess,mcpOwner} from './mcp-process.js';
import {startMcpService} from './mcp-service.js';
import {mcpServiceVersion} from './mcp-service-manager.js';
const config=process.argv[2]!,port=Number(process.argv[3]);
let service:Awaited<ReturnType<typeof startMcpService>>|undefined,lease:Awaited<ReturnType<typeof acquireMcpProcess>>|undefined,stopping=false,committed=false;
let closing:Promise<void>|undefined;
const close=()=>{stopping=true;return closing??=(async()=>{await service?.close();await lease?.release();})();};
process.once('SIGTERM',()=>{void close();});process.once('SIGINT',()=>{void close();});
process.on('disconnect',()=>{if(!committed)void close();});
process.once('message',async message=>{
  try{
    const token=(message as {token:string}).token;lease=await acquireMcpProcess();
    if(stopping){await lease.release();return;}
    service=await startMcpService(config,{token,port});
    if(stopping){await service.close();await lease.release();return;}
    process.on('message',message=>{if((message as {committed?:boolean}).committed===true)committed=true;});
    process.send?.({format:1,owner:mcpOwner(),config,entry:fileURLToPath(import.meta.url),version:mcpServiceVersion,url:service.url,token,started_at:new Date().toISOString()});
  }catch{process.exitCode=1;await close();if(process.connected)process.disconnect();}
});
