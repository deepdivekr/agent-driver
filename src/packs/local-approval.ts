import {createServer,type ServerResponse} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import {type AddressInfo} from 'node:net';
import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {type PreparedApproval} from '../taskpack/protocol.js';
import {type PackApprovalDispatcher} from './runtime.js';
import {type PackStore} from './store.js';

const escape=(value:string)=>value.replace(/[&<>"']/gu,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]!));
async function openLocalUrl(url:string){
  if(!/^http:\/\/127\.0\.0\.1:\d+\/review\/[a-f0-9]{48}$/u.test(url))throw Error('LOCAL_APPROVAL_URL_INVALID');
  const windows=process.platform==='win32'||Boolean(process.env.WSL_INTEROP),command=windows?'powershell.exe':process.platform==='darwin'?'open':'xdg-open';
  const args=windows?['-NoProfile','-NonInteractive','-Command',`Start-Process -FilePath '${url}'`]:[url];
  await new Promise<void>((resolve,reject)=>{const child=spawn(command,args,{detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});
}
interface Pending {close():void;}
/** Trusted local UI: its capability and URL never cross the MCP response boundary. */
export class LocalApprovalDispatcher implements PackApprovalDispatcher {
  private readonly pending=new Set<Pending>();
  constructor(readonly store:PackStore,readonly opener:(url:string)=>Promise<void>=openLocalUrl){}
  async deliver(delivery:PreparedApproval):Promise<{opened:boolean}>{
    const nonce=randomBytes(24).toString('hex'),csrf=randomBytes(32).toString('hex');let origin='',settled=false,timer:NodeJS.Timeout;
    let handle:Pending;const send=(response:ServerResponse,status:number,body:string)=>{response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});response.end(body);};
    const close=()=>{settled=true;clearTimeout(timer);this.pending.delete(handle);server.closeAllConnections();server.close();};
    const server=createServer((request,response)=>{void(async()=>{
      if(request.headers.host!==new URL(origin).host||!['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress??'')){send(response,403,'Invalid local request');return;}
      if(settled||Date.now()>=delivery.expires_at_ms){send(response,410,'이 승인은 만료되었습니다. 작업을 다시 준비해 주세요.');return;}
      if(request.method==='GET'&&request.url===`/capture/${nonce}`){
        const file=await open(delivery.capture_ref,constants.O_RDONLY|constants.O_NOFOLLOW);try{const info=await file.stat();if(!info.isFile()||info.nlink!==1||info.size>16_777_216){send(response,404,'Capture unavailable');return;}const bytes=await file.readFile();response.writeHead(200,{'content-type':'image/png','content-length':bytes.length,'cache-control':'no-store','x-content-type-options':'nosniff'});response.end(bytes);return;}finally{await file.close();}
      }
      if(request.method==='GET'&&request.url===`/review/${nonce}`){const proposal=this.store.proposal(delivery.task_id);
        send(response,200,`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>작업 확인 · Agent Driver</title><style>body{font:17px/1.6 system-ui;max-width:760px;margin:42px auto;padding:0 22px;color:#172b4d}img{max-width:100%;border:1px solid #ccd5e1;border-radius:10px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f6fa;padding:20px;border-radius:10px}form{display:inline}button{font:inherit;padding:12px 18px;margin:10px 12px 0 0}.approve{background:#1763d3;color:white;border:0;border-radius:8px}</style><h1>이 작업을 실행할까요?</h1><p>아래 캡처와 내용에 대한 한 번의 실행만 승인합니다. 내용이 바뀌면 이 승인은 사용할 수 없습니다.</p><img src="/capture/${nonce}" alt="제출 직전 화면"><pre>${escape(JSON.stringify(proposal.snapshot,null,2))}</pre><form method="post" action="/approve/${nonce}"><input type="hidden" name="token" value="${csrf}"><button class="approve">확인한 내용 실행 승인</button></form><form method="post" action="/cancel/${nonce}"><input type="hidden" name="token" value="${csrf}"><button>취소</button></form></html>`);return;}
      if(request.method!=='POST'||request.headers.origin!==origin||request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'||![`/approve/${nonce}`,`/cancel/${nonce}`].includes(request.url??'')){send(response,403,'Invalid local request');return;}
      let size=0;const chunks:Buffer[]=[];for await(const chunk of request){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>4096){send(response,413,'Request too large');return;}chunks.push(bytes);}
      const supplied=new URLSearchParams(Buffer.concat(chunks).toString('utf8')).get('token')??'';
      if(supplied.length!==csrf.length||!timingSafeEqual(Buffer.from(supplied),Buffer.from(csrf))){send(response,403,'Invalid local request');return;}
      try{
        if(request.url===`/approve/${nonce}`)this.store.acceptProposalApproval(delivery.task_id,delivery.approval_token,'local-review-screen',{format:'reviewed_snapshot_hash',proposal_hash:delivery.proposal_hash});
        else this.store.cancel(delivery.task_id);
        settled=true;clearTimeout(timer);send(response,200,request.url?.startsWith('/approve')===true?'<h1>승인했습니다</h1><p>Agent Driver가 검증 후 한 번 실행합니다. 이 창을 닫아도 됩니다.</p>':'<h1>취소했습니다</h1><p>외부 작업은 실행되지 않습니다.</p>');setImmediate(close);
      }catch{send(response,409,'작업 상태가 변경되었거나 승인이 만료되었습니다.');}
    })().catch(()=>send(response,400,'Invalid local request'));});
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    handle={close};this.pending.add(handle);timer=setTimeout(close,Math.max(1,delivery.expires_at_ms-Date.now()));timer.unref();server.unref();
    try {await this.opener(`${origin}/review/${nonce}`);return {opened:true};}catch{close();return {opened:false};}
  }
  close(){for(const pending of [...this.pending])pending.close();}
}
