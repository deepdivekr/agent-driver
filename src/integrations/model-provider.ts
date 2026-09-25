import {hashJson,type ModelCall,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {FAST_MODEL_DEFAULTS} from './fast-models.js';
import {requireCondition} from '../core/contracts.js';

export type ApiProvider='openai'|'anthropic'|'openrouter'|'openai_compatible';
export interface ApiProviderConfig {provider:ApiProvider;model:string;reasoning:'low'|'medium'|'high';apiKey:string;baseUrl?:string;}

const fixedEndpoints:Record<Exclude<ApiProvider,'openai_compatible'>,string>={
  openai:'https://api.openai.com/v1/responses',
  anthropic:'https://api.anthropic.com/v1/messages',
  openrouter:'https://openrouter.ai/api/v1/chat/completions',
};
const modelPattern=/^[^\s\x00-\x1f]{1,200}$/u;
function validLoopback(hostname:string){return hostname==='localhost'||hostname==='127.0.0.1'||hostname==='[::1]'||hostname==='::1';}
export function normalizeCompatibleBaseUrl(raw:string){
  requireCondition(raw.length>0&&raw.length<=2048,'MODEL_PROVIDER_BASE_URL_INVALID');
  let url:URL;try{url=new URL(raw);}catch{throw Error('MODEL_PROVIDER_BASE_URL_INVALID');}
  requireCondition(!url.username&&!url.password&&!url.search&&!url.hash,'MODEL_PROVIDER_BASE_URL_INVALID');
  requireCondition(url.protocol==='https:'||url.protocol==='http:'&&validLoopback(url.hostname),'MODEL_PROVIDER_BASE_URL_UNSAFE');
  requireCondition(url.pathname!=='/'&&!/\/\.\.?\//u.test(url.pathname+'/'),'MODEL_PROVIDER_BASE_URL_INVALID');
  const path=url.pathname.replace(/\/+$/u,'');
  requireCondition(!/\/(?:chat\/completions|responses)$/u.test(path),'MODEL_PROVIDER_BASE_URL_MUST_BE_ROOT');
  url.pathname=path+'/';return url.href;
}
export function apiProviderConfigFromEnvironment(environment:NodeJS.ProcessEnv=process.env):ApiProviderConfig{
  const provider=(environment.AGENT_DRIVER_API_PROVIDER??'openai') as ApiProvider;
  requireCondition(['openai','anthropic','openrouter','openai_compatible'].includes(provider),'MODEL_PROVIDER_INVALID');
  const apiKey=environment.AGENT_DRIVER_API_KEY??(provider==='openai'?environment.OPENAI_API_KEY:provider==='anthropic'?environment.ANTHROPIC_API_KEY:provider==='openrouter'?environment.OPENROUTER_API_KEY:undefined);
  requireCondition(typeof apiKey==='string'&&apiKey.trim().length>=16&&!/[\s\x00-\x1f]/u.test(apiKey),'MODEL_PROVIDER_CREDENTIAL_UNAVAILABLE');
  const model=environment.AGENT_DRIVER_API_MODEL??FAST_MODEL_DEFAULTS[provider];
  const reasoning=(environment.AGENT_DRIVER_API_REASONING??'low') as ApiProviderConfig['reasoning'];
  requireCondition(modelPattern.test(model)&&['low','medium','high'].includes(reasoning),'MODEL_PROVIDER_SELECTION_INVALID');
  const baseUrl=provider==='openai_compatible'?normalizeCompatibleBaseUrl(environment.AGENT_DRIVER_API_BASE_URL??''):undefined;
  return {provider,model,reasoning,apiKey,...(baseUrl?{baseUrl}:{})};
}
function endpoint(config:ApiProviderConfig){
  if(config.provider!=='openai_compatible')return fixedEndpoints[config.provider];
  return new URL('chat/completions',config.baseUrl!).href;
}
function request(config:ApiProviderConfig,instructions:string,input:unknown,schema:Record<string,unknown>,purpose:ModelCall['purpose']){
  if(config.provider==='openai')return {
    headers:{Authorization:`Bearer ${config.apiKey}`},
    body:{model:config.model,reasoning:{effort:config.reasoning},store:false,stream:false,tools:[],max_output_tokens:purpose==='correct'?1_500:5_000,instructions,input:JSON.stringify(input),text:{format:{type:'json_schema',name:'agent_driver_result',strict:true,schema}}},
  };
  if(config.provider==='anthropic')return {
    headers:{'x-api-key':config.apiKey,'anthropic-version':'2023-06-01'},
    body:{model:config.model,max_tokens:purpose==='correct'?1_500:5_000,system:instructions,messages:[{role:'user',content:JSON.stringify(input)}],output_config:{effort:config.reasoning,format:{type:'json_schema',schema}}},
  };
  return {
    headers:{Authorization:`Bearer ${config.apiKey}`},
    body:{model:config.model,messages:[{role:'system',content:instructions},{role:'user',content:JSON.stringify(input)}],stream:false,max_tokens:purpose==='correct'?1_500:5_000,response_format:{type:'json_schema',json_schema:{name:'agent_driver_result',strict:true,schema}},...(config.provider==='openrouter'?{provider:{require_parameters:true},reasoning:{effort:config.reasoning,exclude:true}}:{})},
  };
}
function decode(config:ApiProviderConfig,raw:unknown){
  requireCondition(raw!==null&&typeof raw==='object'&&!Array.isArray(raw),'MODEL_PROVIDER_RESPONSE_INVALID');
  if(config.provider==='openai'){
    const value=raw as {status?:unknown;output?:unknown;usage?:unknown};
    requireCondition(value.status==='completed'&&Array.isArray(value.output),'MODEL_PROVIDER_RESPONSE_INVALID');
    const messages=value.output.filter(item=>item&&typeof item==='object'&&!Array.isArray(item)&&(item as {type?:unknown}).type==='message') as Array<{phase?:unknown;content?:unknown}>;
    const finals=messages.filter(item=>item.phase==='final_answer'),selected=finals.length===1?finals:messages.length===1?messages:[];
    requireCondition(selected.length===1&&Array.isArray(selected[0]!.content),'MODEL_PROVIDER_RESPONSE_INVALID');
    const blocks=selected[0]!.content as Array<{type?:unknown;text?:unknown}>;
    requireCondition(blocks.length>0&&blocks.every(block=>block.type==='output_text'&&typeof block.text==='string'),'MODEL_PROVIDER_RESPONSE_INVALID');
    return {value:JSON.parse(blocks.map(block=>block.text).join('')),usage:value.usage};
  }
  if(config.provider==='anthropic'){
    const value=raw as {stop_reason?:unknown;content?:unknown;usage?:unknown};
    requireCondition(value.stop_reason!=='max_tokens'&&value.stop_reason!=='refusal'&&Array.isArray(value.content),'MODEL_PROVIDER_RESPONSE_INVALID');
    const blocks=(value.content as Array<{type?:unknown;text?:unknown}>).filter(block=>block.type==='text');
    requireCondition(blocks.length===1&&typeof blocks[0]!.text==='string','MODEL_PROVIDER_RESPONSE_INVALID');
    return {value:JSON.parse(blocks[0]!.text as string),usage:value.usage};
  }
  const value=raw as {choices?:unknown;usage?:unknown};
  requireCondition(Array.isArray(value.choices)&&value.choices.length===1,'MODEL_PROVIDER_RESPONSE_INVALID');
  const choice=value.choices[0] as {finish_reason?:unknown;message?:{content?:unknown}};
  requireCondition(choice.finish_reason!=='length'&&typeof choice.message?.content==='string','MODEL_PROVIDER_RESPONSE_INVALID');
  return {value:JSON.parse(choice.message.content),usage:value.usage};
}
function usage(raw:unknown){
  if(!raw||typeof raw!=='object'||Array.isArray(raw))return {input_tokens:'unobserved' as const,output_tokens:'unobserved' as const,total_tokens:'unobserved' as const};
  const value=raw as Record<string,unknown>,input=value.input_tokens??value.prompt_tokens,output=value.output_tokens??value.completion_tokens,total=value.total_tokens;
  return {input_tokens:typeof input==='number'?input:'unobserved' as const,output_tokens:typeof output==='number'?output:'unobserved' as const,total_tokens:typeof total==='number'?total:'unobserved' as const};
}
export function structuredModelFromEnvironment(environment:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch):StructuredModel{
  const config=apiProviderConfigFromEnvironment(environment),calls:ModelCall[]=[];
  return {calls,async call(purpose,instructions,input,schema){
    const started=performance.now(),input_sha256=hashJson({instructions,input,schema}),prepared=request(config,instructions,input,schema,purpose);let accepted=false,httpStatus:number|undefined,rawUsage:unknown,failureKind:ModelCall['failure_kind']='network';
    try{
      const response=await fetcher(endpoint(config),{method:'POST',redirect:'error',headers:{'content-type':'application/json',...prepared.headers},body:JSON.stringify(prepared.body),signal:AbortSignal.timeout(60_000)});
      httpStatus=response.status;if(!response.ok)failureKind='http_error';requireCondition(response.ok,'MODEL_PROVIDER_HTTP_FAILURE');const decoded=decode(config,await response.json());rawUsage=decoded.usage;accepted=true;return decoded.value;
    }catch(error){if(error instanceof Error&&error.message==='MODEL_PROVIDER_RESPONSE_INVALID'){failureKind='invalid_output';throw error;}throw Error('MODEL_PROVIDER_UNAVAILABLE');}
    finally{calls.push({purpose,provider:config.provider,auth:'api_key',model:config.model,elapsed_ms:Math.round(performance.now()-started),input_sha256,status:accepted?'accepted':'failed',...(httpStatus===undefined?{}:{http_status:httpStatus}),...usage(rawUsage),...(accepted?{}:{failure_kind:failureKind})});}
  }};
}
export async function probeStructuredModel(environment:NodeJS.ProcessEnv,fetcher:typeof fetch=fetch){
  const nonce='agent-driver-provider-probe',schema={type:'object',additionalProperties:false,required:['status','nonce'],properties:{status:{type:'string',const:'ok'},nonce:{type:'string',const:nonce}}};
  const model=structuredModelFromEnvironment(environment,fetcher),result=await model.call('correct','Return the supplied status and nonce exactly.',{status:'ok',nonce},schema) as {status?:unknown;nonce?:unknown};
  requireCondition(result.status==='ok'&&result.nonce===nonce,'MODEL_PROVIDER_PROBE_INVALID');
  const call=model.calls.at(-1)!;return {status:'ready' as const,provider:call.provider,model:call.model,elapsed_ms:call.elapsed_ms,credentials_exposed:false};
}
