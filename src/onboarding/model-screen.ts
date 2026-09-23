import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {SubscriptionAuthFlowController,type SubscriptionAuthFlowKind,type SubscriptionClientConnection,type SubscriptionClientId} from '../integrations/subscription-auth.js';

export interface ModelConnectionScreenOptions {authController?:SubscriptionAuthFlowController;}

const clientIds=new Set<SubscriptionClientId>(['codex','claude','opencode','cursor','hermes']);
const flowKinds=new Set<SubscriptionAuthFlowKind>(['browser','device']);
const statusLabel:Record<SubscriptionClientConnection['status'],string>={ready:'연결됨',signed_out:'연결 필요',expired:'연결 만료',unavailable:'사용할 수 없음',unknown:'확인할 수 없음'};
const clientLabel:Record<SubscriptionClientId,string>={codex:'Codex',claude:'Claude Code',opencode:'OpenCode',cursor:'Cursor',hermes:'Hermes'};

async function formValues(request:IncomingMessage){
  let length=0;const chunks:Buffer[]=[];
  for await(const chunk of request){const bytes=Buffer.from(chunk);length+=bytes.length;if(length>16_384)throw Error('INPUT_TOO_LARGE');chunks.push(bytes);}
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
function safeToken(provided:string,expected:string){return provided.length===expected.length&&timingSafeEqual(Buffer.from(provided),Buffer.from(expected));}
function connectionCards(connections:SubscriptionClientConnection[]){return connections.map(client=>{
  const buttons=client.supported_login_flows.map(flow=>`<button type="button" class="client-connect" data-client="${client.id}" data-flow="${flow}">${flow==='device'?'기기 코드로 연결':'브라우저로 연결'}</button>`).join('');
  const actionable=(client.status==='signed_out'||client.status==='expired')&&buttons.length>0;
  const unavailable=client.reason==='wsl_native_client_not_found'?'Agent Driver가 WSL에서 실행 중입니다. 같은 WSL에 이 클라이언트를 설치하면 자동으로 연결됩니다.':'이 버전에서 확인된 공식 연결 명령이 없습니다.';
  return `<article class="client-card" id="client-${client.id}"><div><strong>${clientLabel[client.id]}</strong><span class="badge state-${client.status}" data-role="status">${statusLabel[client.status]}</span></div><p data-role="flow">${client.status==='ready'?'기존 로그인 세션을 그대로 사용합니다.':client.status==='unavailable'?unavailable:'클라이언트의 공식 로그인 화면에서 연결합니다.'}</p><div class="actions"${actionable?'':' hidden'}>${buttons}</div><div class="device" data-role="device" hidden><a target="_blank" rel="noreferrer" data-role="device-url"></a><code data-role="device-code"></code></div></article>`;
}).join('');}
function page(token:string,nonce:string,connections:SubscriptionClientConnection[]){
  const initial=JSON.stringify(connections.map(client=>client.connection)).replaceAll('<','\\u003c');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>모델 연결</title><style>body{font:17px system-ui;max-width:720px;margin:42px auto;padding:0 20px;color:#172b4d}h1{margin-bottom:8px}.client-list{display:grid;gap:12px;margin:24px 0}.client-card{border:1px solid #d7deea;border-radius:12px;padding:16px}.client-card>div:first-child{display:flex;justify-content:space-between;gap:16px}.badge{font-size:14px;padding:3px 9px;border-radius:999px;background:#eef2f8}.state-ready{color:#116329;background:#dcf5e4}.state-expired,.state-signed_out{color:#805500;background:#fff0c2}.actions{display:flex;flex-wrap:wrap;gap:8px}.client-connect{margin:0;padding:9px 12px;background:#1763d3}.device{margin-top:12px;padding:12px;background:#f4f7fb;border-radius:8px}.device a,.device code{display:block;margin-top:6px}label{display:block;margin:22px 0 8px}input{box-sizing:border-box;padding:12px;width:100%;border:1px solid #8796ac;border-radius:8px}button{background:#1763d3;color:white;border:0;border-radius:8px;padding:14px 20px;margin-top:22px;font-size:16px;cursor:pointer}button:disabled{opacity:.55;cursor:wait}small{display:block;color:#526177;margin-top:16px;line-height:1.6}</style><main id="connection" data-token="${token}"><h1>모델 연결</h1><p>이미 로그인된 구독을 먼저 사용하며 자동으로 재사용합니다. 연결이 필요하면 아래에서 해당 클라이언트의 공식 로그인을 시작하세요.</p><section class="client-list">${connectionCards(connections)}</section><form method="post" action="/connect" autocomplete="off"><input type="hidden" name="token" value="${token}"><label for="jev">TypeSafe / Jev API 키 <small>선택 사항 — 없으면 LLM이 바로 판단합니다.</small></label><input id="jev" name="jev" type="password" minlength="16" autocomplete="off"><label for="llm">OpenAI API 키 <small>선택 사항 — 구독 클라이언트를 사용할 수 없을 때만 사용합니다.</small></label><input id="llm" name="llm" type="password" minlength="16" autocomplete="off"><button>연결 계속하기</button></form><small>Agent Driver는 클라이언트의 OAuth 토큰이나 인증 파일을 읽지 않습니다. 로그인은 각 클라이언트가 직접 처리합니다. 입력한 키는 이 프로세스 메모리에서만 사용하며 파일·로그·채팅에 저장하지 않습니다. 입력 없이 20분이 지나면 창이 만료됩니다.</small></main><script nonce="${nonce}">(()=>{const root=document.querySelector('#connection'),token=root.dataset.token,active=new Set(),initial=${initial};const labels={starting:'로그인을 시작하는 중입니다.',waiting:'클라이언트에서 로그인을 완료해주세요.',completed:'연결되었습니다.',failed:'연결하지 못했습니다. 다시 시도해주세요.',unavailable:'이 연결 방식은 사용할 수 없습니다.'};function render(flow){const card=document.querySelector('#client-'+flow.client_id);if(!card)return;const status=card.querySelector('[data-role=status]'),message=card.querySelector('[data-role=flow]'),actions=card.querySelector('.actions'),device=card.querySelector('[data-role=device]');message.textContent=labels[flow.state]||message.textContent;if(flow.state==='completed'){status.textContent='연결됨';status.className='badge state-ready';actions.hidden=true;}else if(flow.state==='failed'||flow.state==='unavailable'){actions.hidden=false;}else if(flow.state==='starting'||flow.state==='waiting'){actions.hidden=true;}if(flow.device_url||flow.user_code){device.hidden=false;const link=device.querySelector('[data-role=device-url]'),code=device.querySelector('[data-role=device-code]');if(flow.device_url){link.href=flow.device_url;link.textContent='인증 페이지 열기';}if(flow.user_code)code.textContent='코드: '+flow.user_code;}if(flow.state==='starting'||flow.state==='waiting')active.add(flow.client_id);else active.delete(flow.client_id);}async function poll(id){try{const response=await fetch('/client-flow?id='+encodeURIComponent(id),{cache:'no-store'});if(response.ok)render(await response.json());}finally{if(active.has(id))setTimeout(()=>poll(id),750);}}for(const button of document.querySelectorAll('.client-connect'))button.addEventListener('click',async()=>{button.disabled=true;try{const body=new URLSearchParams({token,client:button.dataset.client,flow:button.dataset.flow}),response=await fetch('/client-connect',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});if(response.ok){const value=await response.json();render(value);if(active.has(value.client_id))poll(value.client_id);}}finally{button.disabled=false;}});for(const flow of initial){render(flow);if(active.has(flow.client_id))poll(flow.client_id);}})();</script></html>`;
}

/** Ephemeral host-only credentials. Never written to disk, URLs, logs or model state. */
export async function startModelConnectionScreen(timeoutMs=20*60*1000,options:ModelConnectionScreenOptions={}){
  const token=randomBytes(32).toString('hex'),nonce=randomBytes(18).toString('base64'),authController=options.authController??new SubscriptionAuthFlowController();let settled=false,origin='';
  let accept:(environment:NodeJS.ProcessEnv)=>void=()=>undefined;
  let reject:(error:Error)=>void=()=>undefined;
  const connected=new Promise<NodeJS.ProcessEnv>((resolve,fail)=>{accept=resolve;reject=fail;});
  const send=(response:ServerResponse,status:number,body:string,contentType='text/html; charset=utf-8')=>{
    response.writeHead(status,{'content-type':contentType,'cache-control':'no-store','referrer-policy':'no-referrer','content-security-policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`});response.end(body);
  };
  const sendJson=(response:ServerResponse,status:number,value:unknown)=>send(response,status,JSON.stringify(value),'application/json; charset=utf-8');
  const validPost=(request:IncomingMessage)=>request.headers.origin===origin&&request.headers['content-type']?.split(';')[0]==='application/x-www-form-urlencoded';
  const server=createServer((request,response)=>{void(async()=>{
    if(request.headers.host!==new URL(origin).host){send(response,403,'Invalid local host');return;}
    if(request.method==='GET'&&request.url==='/'){send(response,200,page(token,nonce,await authController.connections()));return;}
    if(request.method==='GET'&&request.url?.startsWith('/client-flow?')){
      const id=new URL(request.url,origin).searchParams.get('id');if(!id||!clientIds.has(id as SubscriptionClientId)){sendJson(response,404,{error:'CLIENT_NOT_SUPPORTED'});return;}
      sendJson(response,200,authController.view(id as SubscriptionClientId));return;
    }
    if(request.method==='POST'&&request.url==='/client-connect'){
      if(!validPost(request)){sendJson(response,403,{error:'INVALID_ORIGIN'});return;}const values=await formValues(request),provided=values.get('token')??'',id=values.get('client'),flow=values.get('flow');
      if(!safeToken(provided,token)){sendJson(response,403,{error:'INVALID_REQUEST'});return;}
      if(!id||!clientIds.has(id as SubscriptionClientId)||!flow||!flowKinds.has(flow as SubscriptionAuthFlowKind)){sendJson(response,400,{error:'INVALID_CLIENT_FLOW'});return;}
      sendJson(response,202,await authController.start(id as SubscriptionClientId,flow as SubscriptionAuthFlowKind));return;
    }
    if(request.method!=='POST'||request.url!=='/connect'||settled){send(response,404,'Not available');return;}
    if(!validPost(request)){send(response,403,'Invalid origin');return;}
    const values=await formValues(request),provided=values.get('token')??'';
    if(!safeToken(provided,token)){send(response,403,'Invalid request');return;}
    const jev=values.get('jev')?.trim()??'',llm=values.get('llm')?.trim()??'';
    if((jev.length>0&&jev.length<16)||(llm.length>0&&llm.length<16)||jev.length>4096||llm.length>4096){send(response,400,'입력한 API 키 형식을 확인해주세요.');return;}
    if(settled){send(response,409,'Already consumed or expired');return;}
    settled=true;clearTimeout(timer);send(response,200,'<!doctype html><meta charset="utf-8"><title>검증 시작</title><h1>연결했습니다</h1><p>전용 브라우저에서 검색 검증을 시작합니다. 결과는 작업 대화에서 확인할 수 있습니다. 이 창은 닫아도 됩니다.</p>');
    accept({...(jev?{TYPESAFE_API_KEY:jev}:{}),...(llm?{OPENAI_API_KEY:llm}:{})});
  })().catch(error=>send(response,error instanceof Error&&error.message==='INPUT_TOO_LARGE'?413:400,'Invalid local request'));});
  await new Promise<void>((resolve,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',resolve);});
  const address=server.address();if(!address||typeof address==='string')throw Error('MODEL_SCREEN_BIND_FAILED');origin=`http://127.0.0.1:${address.port}`;
  const timer=setTimeout(()=>{if(!settled){settled=true;authController.close();reject(Error('MODEL_CONNECTION_EXPIRED'));server.close();}},timeoutMs);
  return {url:`${origin}/`,connected,async close(){clearTimeout(timer);authController.close();if(!settled){settled=true;reject(Error('MODEL_CONNECTION_CLOSED'));}await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeIdleConnections();});}};
}
