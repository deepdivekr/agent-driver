import {randomBytes} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {approveNonInterferingConnection,connectionRoot,localConnectionScreen,type LocalConnectionPaths} from './connection.js';

export interface LocalConnectionScreenServer {url:string;approved:Promise<{paths:LocalConnectionPaths}>;close():Promise<void>;}
function reply(response:ServerResponse,status:number,body:string,contentType='text/html; charset=utf-8'){
  response.writeHead(status,{'content-type':contentType,'cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});response.end(body);
}
async function body(request:IncomingMessage){
  const chunks:Buffer[]=[];let length=0;for await(const chunk of request){const value=Buffer.from(chunk);length+=value.length;if(length>4096)throw Error('LOCAL_CONNECTION_REQUEST_TOO_LARGE');chunks.push(value);}return Buffer.concat(chunks).toString('utf8');
}
function page(token:string){
  const modes=localConnectionScreen.modes.map(mode=>`<article><h2>${mode.label}</h2><p>${mode.detail}</p>${mode.available?`<form method="post" action="/approve"><input type="hidden" name="token" value="${token}"><input type="hidden" name="mode" value="${mode.id}"><button type="submit">${mode.default?'이 컴퓨터 연결':'선택'}</button></form>`:'<button disabled>현재 사용할 수 없음</button>'}</article>`).join('');
  const status=Object.entries(localConnectionScreen.status).map(([name,value])=>`<li><strong>${name}</strong>: ${value}</li>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${localConnectionScreen.title}</title><style>body{font:16px system-ui,sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#14213d}article{border:1px solid #d8e1ee;border-radius:12px;padding:16px;margin:12px 0}button{padding:10px 15px;border:0;border-radius:8px;background:#1267d6;color:#fff;font-weight:700}button:disabled{background:#aab6c6}small{color:#52657b}</style><main><h1>${localConnectionScreen.title}</h1><p>${localConnectionScreen.description}</p>${modes}<h2>상태</h2><ul>${status}</ul><small>로그인·브라우저 준비·Jev 연결은 실제 필요한 작업에서만 요청합니다.</small></main></html>`;
}
function success(){return '<!doctype html><meta charset="utf-8"><title>연결 완료</title><main><h1>이 컴퓨터가 연결되었습니다</h1><p>이제 에이전트에게 자연어로 브라우저·개발 작업을 요청하면 됩니다.</p><p>Jev와 로그인은 필요한 경우에만 안내합니다.</p></main>';}

/** Loopback-only, one-time local consent surface. It never opens or attaches the user's browser itself. */
export async function startLocalConnectionScreen(root=connectionRoot()):Promise<LocalConnectionScreenServer>{
  const token=randomBytes(32).toString('hex');let resolved=false;let resolveApproved:(value:{paths:LocalConnectionPaths})=>void=()=>undefined;
  const approved=new Promise<{paths:LocalConnectionPaths}>(resolve=>{resolveApproved=resolve;});
  const server=createServer((request,response)=>{void(async()=>{
    const url=new URL(request.url??'/','http://127.0.0.1');
    if(request.method==='GET'&&url.pathname==='/'){reply(response,200,page(token));return;}
    if(request.method==='POST'&&url.pathname==='/approve'&&!resolved){
      const values=new URLSearchParams(await body(request));if(values.get('token')!==token||values.get('mode')!=='non_interfering'){reply(response,403,'forbidden','text/plain; charset=utf-8');return;}
      const connected=await approveNonInterferingConnection(root);resolved=true;reply(response,200,success());resolveApproved({paths:connected.paths});return;
    }
    reply(response,404,'not found','text/plain; charset=utf-8');
  })().catch(()=>reply(response,400,'invalid request','text/plain; charset=utf-8'));});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
  const address=server.address();if(address===null||typeof address==='string')throw Error('LOCAL_CONNECTION_BIND_FAILED');
  return {url:`http://127.0.0.1:${address.port}/`,approved,async close(){await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
