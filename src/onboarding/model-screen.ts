import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,type ServerResponse} from 'node:http';

/** Ephemeral host-only credentials. Never written to disk, URLs, logs or model state. */
export async function startModelConnectionScreen(timeoutMs=20*60*1000){
  const token=randomBytes(32).toString('hex');let settled=false,origin='';
  let accept:(environment:NodeJS.ProcessEnv)=>void=()=>undefined;
  let reject:(error:Error)=>void=()=>undefined;
  const connected=new Promise<NodeJS.ProcessEnv>((resolve,fail)=>{accept=resolve;reject=fail;});
  const send=(response:ServerResponse,status:number,body:string)=>{
    response.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});response.end(body);
  };
  const server=createServer((request,response)=>{void(async()=>{
    if(request.headers.host!==new URL(origin).host){send(response,403,'Invalid local host');return;}
    if(request.method==='GET'&&request.url==='/'){
      send(response,200,`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>검증용 모델 연결</title><style>body{font:17px system-ui;max-width:650px;margin:48px auto;padding:0 20px;color:#172b4d}label{display:block;margin:22px 0 8px}input{box-sizing:border-box;padding:12px;width:100%;border:1px solid #8796ac;border-radius:8px}button{background:#1763d3;color:white;border:0;border-radius:8px;padding:14px 20px;margin-top:22px;font-size:17px}small{display:block;color:#526177;margin-top:16px;line-height:1.6}</style><h1>검증용 모델 연결</h1><p>Google Flights 항공편과 도쿄 연말 5성급 호텔을 검색합니다. 예약·결제는 하지 않습니다.</p><form method="post" action="/connect" autocomplete="off"><input type="hidden" name="token" value="${token}"><label for="jev">TypeSafe / Jev API 키</label><input id="jev" name="jev" type="password" required minlength="16" autocomplete="off"><label for="llm">OpenAI API 키 — Luna low</label><input id="llm" name="llm" type="password" required minlength="16" autocomplete="off"><button>연결하고 검증 시작</button></form><small>키는 이 PC의 검증 프로세스 메모리에서만 사용합니다. 파일·로그·채팅에 저장하지 않습니다. 유료 API를 사용하며, 사이트별 최대 35단계와 제한된 보정 호출 후 종료합니다. 입력 없이 20분이 지나면 창의 연결이 만료됩니다.</small></html>`);return;
    }
    if(request.method!=='POST'||request.url!=='/connect'||settled){send(response,404,'Not available');return;}
    if(request.headers.origin!==origin||request.headers['content-type']?.split(';')[0]!=='application/x-www-form-urlencoded'){send(response,403,'Invalid origin');return;}
    let length=0;const chunks:Buffer[]=[];
    for await(const chunk of request){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>16384){send(response,413,'Input too large');return;}chunks.push(bytes);}
    const values=new URLSearchParams(Buffer.concat(chunks).toString('utf8')),provided=values.get('token')??'';
    if(provided.length!==token.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(token))){send(response,403,'Invalid request');return;}
    const jev=values.get('jev')?.trim(),llm=values.get('llm')?.trim();
    if(!jev||!llm||jev.length<16||llm.length<16||jev.length>4096||llm.length>4096){send(response,400,'두 API 키를 입력해주세요.');return;}
    if(settled){send(response,409,'Already consumed or expired');return;}
    settled=true;clearTimeout(timer);send(response,200,'<!doctype html><meta charset="utf-8"><title>검증 시작</title><h1>연결했습니다</h1><p>전용 브라우저에서 검색 검증을 시작합니다. 결과는 작업 대화에서 확인할 수 있습니다. 이 창은 닫아도 됩니다.</p>');
    accept({TYPESAFE_API_KEY:jev,OPENAI_API_KEY:llm});
  })().catch(()=>send(response,400,'Invalid local request'));});
  await new Promise<void>((resolve,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('MODEL_SCREEN_BIND_FAILED');origin=`http://127.0.0.1:${address.port}`;
  const timer=setTimeout(()=>{if(!settled){settled=true;reject(Error('MODEL_CONNECTION_EXPIRED'));server.close();}},timeoutMs);
  return {url:`${origin}/`,connected,async close(){clearTimeout(timer);if(!settled){settled=true;reject(Error('MODEL_CONNECTION_CLOSED'));}await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});}};
}
