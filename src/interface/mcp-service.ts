import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import {StreamableHTTPServerTransport} from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {isInitializeRequest} from '@modelcontextprotocol/sdk/types.js';
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js';
import {RuntimeApi} from './api.js';
import {loadHostConfig} from './config.js';
import {connectMcp} from './mcp.js';

interface Session{transport:StreamableHTTPServerTransport;connection:Awaited<ReturnType<typeof connectMcp>>;last:number;}
export async function startMcpService(configPath:string,options:{token:string;port?:number;maxSessions?:number;idleMs?:number} ){
  if(!/^[a-f0-9]{64}$/u.test(options.token))throw Error('MCP_SERVICE_TOKEN_INVALID');
  loadHostConfig(configPath);
  const sessions=new Map<string,Session>(),all=new Set<Session>();
  const maxSessions=options.maxSessions??32,idleMs=options.idleMs??30*60_000;
  let stopping=false,pending=0,origin='';
  const reject=(res:ServerResponse,status:number,code:string)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({error:code}));};
  const authorized=(req:IncomingMessage)=>{
    const supplied=Buffer.from(req.headers.authorization??''),expected=Buffer.from('Bearer '+options.token);
    return supplied.length===expected.length&&timingSafeEqual(supplied,expected);
  };
  async function handle(req:IncomingMessage,res:ServerResponse){
    // Reject DNS rebinding, browser-origin requests and ambient-cookie authority.
    if(req.headers.host!==new URL(origin).host||req.headers.origin!==undefined){reject(res,403,'MCP_HOST_OR_ORIGIN_DENIED');return;}
    if(!authorized(req)){reject(res,401,'MCP_AUTH_REQUIRED');return;}
    if(req.url==='/health'&&req.method==='GET'){
      res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({service:'agent-driver-mcp',pid:process.pid,sessions:all.size,max_sessions:maxSessions,stopping}));return;
    }
    if(req.url!=='/mcp'){reject(res,404,'MCP_NOT_FOUND');return;}
    if(stopping){reject(res,503,'MCP_STOPPING');return;}
    if(!['POST','GET','DELETE'].includes(req.method??'')){reject(res,405,'MCP_METHOD_NOT_ALLOWED');return;}
    let body:unknown;
    if(req.method==='POST'){
      if(!/^application\/json(?:\s*;|$)/iu.test(req.headers['content-type']??'')){reject(res,415,'MCP_JSON_REQUIRED');return;}
      if(Number(req.headers['content-length']??0)>65536){reject(res,413,'MCP_REQUEST_TOO_LARGE');req.resume();return;}
      const chunks:Buffer[]=[];let bytes=0;
      for await(const chunk of req){const data=Buffer.from(chunk);bytes+=data.length;if(bytes>65536){reject(res,413,'MCP_REQUEST_TOO_LARGE');return;}chunks.push(data);}
      try{body=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{reject(res,400,'MCP_INVALID_JSON');return;}
    }
    if(stopping){reject(res,503,'MCP_STOPPING');return;}
    const sessionId=req.headers['mcp-session-id'];
    if(sessionId!==undefined){
      if(typeof sessionId!=='string'||!sessions.has(sessionId)){reject(res,404,'MCP_SESSION_NOT_FOUND');return;}
      const session=sessions.get(sessionId)!;session.last=Date.now();await session.transport.handleRequest(req,res,body);return;
    }
    if(req.method!=='POST'||!isInitializeRequest(body)){reject(res,400,'MCP_INITIALIZE_REQUIRED');return;}
    if(all.size+pending>=maxSessions){reject(res,429,'MCP_SESSION_LIMIT');return;}
    pending++;
    let api:RuntimeApi|undefined,session:Session|undefined;
    try{
      api=new RuntimeApi(loadHostConfig(configPath));
      const transport=new StreamableHTTPServerTransport({sessionIdGenerator:randomUUID,onsessioninitialized:id=>{if(session)sessions.set(id,session);}});
      // SDK 1.30 declares optional hooks differently with exactOptionalPropertyTypes;
      // both transports implement the same wire Transport contract at runtime.
      const connection=await connectMcp(api,transport as Transport,{transport:'streamable-http',onClosed:()=>{if(session){all.delete(session);if(transport.sessionId)sessions.delete(transport.sessionId);}}});
      session={transport,connection,last:Date.now()};all.add(session);
      if(stopping){await connection.close();reject(res,503,'MCP_STOPPING');return;}
      await transport.handleRequest(req,res,body);
      if(!transport.sessionId)await connection.close();
    }catch(error){if(session)await session.connection.close();else if(api){api.close();await api.drain();}throw error;}
    finally{pending--;}
  }
  const server=createServer((req,res)=>{void handle(req,res).catch(()=>{if(!res.headersSent)reject(res,500,'MCP_REQUEST_FAILED');else res.end();});});
  server.requestTimeout=15_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.maxConnections=128;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(options.port??0,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
  const address=server.address();if(!address||typeof address==='string')throw Error('MCP_BIND_FAILED');origin=`http://127.0.0.1:${address.port}`;
  const reaper=setInterval(()=>{for(const session of all)if(!session.connection.busy()&&Date.now()-session.last>idleMs)void session.connection.close().catch(()=>{});},Math.min(30_000,idleMs));reaper.unref();
  let closing:Promise<void>|undefined;
  return {url:origin+'/mcp',async close(){
    if(!closing)closing=(async()=>{stopping=true;clearInterval(reaper);const closed=new Promise<void>(resolve=>server.close(()=>resolve()));
      // Already admitted RPCs are drained by each connection; no replay.
      await Promise.allSettled([...all].map(s=>s.connection.close()));server.closeAllConnections();await closed;
    })();return closing;
  }};
}
