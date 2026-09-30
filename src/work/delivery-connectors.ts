import {createHash} from 'node:crypto';
import {type ResultDeliveryConnector,type WorkResult} from './results.js';
import {type DeliveryTarget,validateDeliveryTarget} from './delivery-settings.js';

const receipt=(value:string)=>value.slice(0,500);
const hash=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,24);
function content(result:WorkResult){return `Work result ${result.id}\n${result.summary}${result.text?`\n\n${result.text}`:''}${result.artifacts.length?'\n\nOriginal files: download in the app.':''}`;}
const length=(value:string)=>[...value].length;
async function boundedBody(response:Response,limit=8192){
  const reader=response.body?.getReader();if(!reader)return '';
  const chunks:Uint8Array[]=[];let size=0;
  try{while(true){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw Error('DELIVERY_RESPONSE_TOO_LARGE');chunks.push(next.value);}}finally{await reader.cancel().catch(()=>undefined);}
  return Buffer.concat(chunks).toString('utf8');
}
function failed(status:number){return {status:'failed' as const,effect_state:[400,401,403,404,410,413,422,429].includes(status)?'not_dispatched' as const:'uncertain' as const,reason:`DELIVERY_PROVIDER_HTTP_${status}`};}
/** Provider requests are pinned to exact provider hosts by saved settings validation. Redirects are disabled. */
export function createDeliveryConnector(target:DeliveryTarget,transport:typeof fetch=fetch):ResultDeliveryConnector{
  const validated=validateDeliveryTarget(target);
  return {id:validated.id,channel:validated.platform,async send({result,idempotency_key}){
    const full=content(result);let url:string,body:BodyInit,headers:HeadersInit|undefined;
    if(validated.platform==='telegram'){
      const base=`https://api.telegram.org/bot${validated.telegram_bot_token}/`;
      if(length(full)<=4096){url=base+'sendMessage';body=JSON.stringify({chat_id:validated.telegram_chat_id,text:full,disable_web_page_preview:true});headers={'content-type':'application/json'};}
      else{url=base+'sendDocument';const form=new FormData();form.append('chat_id',validated.telegram_chat_id!);form.append('document',new Blob([full],{type:'text/plain;charset=utf-8'}),'result.txt');form.append('caption',`Work result ${result.id}: full text attached as result.txt. Original files remain in the app.`);body=form;}
    }else if(validated.platform==='slack'){
      if(length(full)>40_000)return {status:'failed',effect_state:'not_dispatched',reason:'DELIVERY_BODY_TOO_LARGE'};
      url=validated.webhook_url!;body=JSON.stringify({text:full,mrkdwn:false,unfurl_links:false,unfurl_media:false});headers={'content-type':'application/json'};
    }else{
      url=validated.webhook_url!+'?wait=true';
      if(length(full)<=1900){body=JSON.stringify({content:full,allowed_mentions:{parse:[]}});headers={'content-type':'application/json'};}
      else{const form=new FormData();form.append('payload_json',JSON.stringify({content:`Work result ${result.id}: full text attached as result.txt. Original files remain in the app.`,allowed_mentions:{parse:[]}}));form.append('files[0]',new Blob([full],{type:'text/plain;charset=utf-8'}),'result.txt');body=form;}
    }
    let response:Response;
    try{response=await transport(url,{method:'POST',...(headers?{headers}:{}),body,redirect:'error',signal:AbortSignal.timeout(15_000)});}catch{return {status:'failed',effect_state:'uncertain',reason:'DELIVERY_RESPONSE_UNOBSERVED'};}
    if(!response.ok)return failed(response.status);
    let raw:string;try{raw=await boundedBody(response);}catch{return {status:'failed',effect_state:'uncertain',reason:'DELIVERY_RESPONSE_UNOBSERVED'};}
    if(validated.platform==='slack')return raw.trim()==='ok'?{status:'delivered',receipt_id:receipt(`slack:webhook:ok:${hash(idempotency_key)}`)}:{status:'failed',effect_state:'uncertain',reason:'DELIVERY_RECEIPT_INVALID'};
    let parsed:unknown;try{parsed=JSON.parse(raw);}catch{return {status:'failed',effect_state:'uncertain',reason:'DELIVERY_RECEIPT_INVALID'};}
    const object=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{};
    if(validated.platform==='telegram'){
      const message=object.result&&typeof object.result==='object'?object.result as Record<string,unknown>:{};
      const chat=message.chat&&typeof message.chat==='object'?message.chat as Record<string,unknown>:{};
      return object.ok===true&&Number.isInteger(message.message_id)&&Number.isSafeInteger(chat.id)&&(validated.telegram_chat_id?.startsWith('@')||String(chat.id)===validated.telegram_chat_id)?{status:'delivered',receipt_id:receipt(`telegram:${chat.id}:${message.message_id}`)}:{status:'failed',effect_state:'uncertain',reason:'DELIVERY_RECEIPT_INVALID'};
    }
    return typeof object.id==='string'&&/^\d{10,25}$/u.test(object.id)?{status:'delivered',receipt_id:receipt(`discord:${object.id}`)}:{status:'failed',effect_state:'uncertain',reason:'DELIVERY_RECEIPT_INVALID'};
  }};
}
