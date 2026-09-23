import {spawn} from 'node:child_process';
import {constants as fsConstants,accessSync,readFileSync,readdirSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,isAbsolute,join} from 'node:path';
import {hashJson,type ModelCall,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {requireCondition} from '../core/contracts.js';

export type SubscriptionClientId='codex'|'claude'|'opencode'|'cursor'|'hermes';
export interface SubscriptionClientStatus {
  id:SubscriptionClientId;status:'ready'|'signed_out'|'expired'|'unavailable'|'unknown';
  auth:'subscription'|'oauth'|'unknown';structured_bridge:boolean;reason:string;
}
export type SubscriptionAuthFlowKind='browser'|'device';
export type SubscriptionAuthFlowState='idle'|'starting'|'waiting'|'completed'|'failed'|'unavailable';
export interface SubscriptionAuthFlowView {
  client_id:SubscriptionClientId;flow:SubscriptionAuthFlowKind|null;state:SubscriptionAuthFlowState;
  device_url?:string;user_code?:string;reason:string;credentials_exposed:false;
}
export interface SubscriptionClientConnection extends SubscriptionClientStatus {
  supported_login_flows:SubscriptionAuthFlowKind[];connection:SubscriptionAuthFlowView;
}
export interface ProcessRequest {
  executable:string;args:string[];stdin?:string;cwd?:string;timeout_ms:number;signal?:AbortSignal;
  onStdout?:(text:string)=>void;onStderr?:(text:string)=>void;
}
export interface ProcessResult {code:number|null;stdout:string;stderr:string;}
export interface SafeProcessRunner {run(request:ProcessRequest):Promise<ProcessResult>;}
export interface McpSamplingResult {model:string;stopReason?:string;content:{type:string;text?:string}|Array<{type:string;text?:string}>;}
export interface McpSamplingClient {
  available():boolean;
  createMessage(params:{messages:Array<{role:'user';content:{type:'text';text:string}}> ;systemPrompt:string;includeContext:'none';maxTokens:number;temperature:number},options:{timeout:number}):Promise<McpSamplingResult>;
}

const outputLimit=1024*1024;
const executableEnvironment=()=>{
  const environment:NodeJS.ProcessEnv={};
  for(const key of ['PATH','HOME','USERPROFILE','CODEX_HOME','LANG','LC_ALL','TMPDIR','TEMP','TMP','SystemRoot'])if(process.env[key])environment[key]=process.env[key];
  return environment;
};
export const nativeProcessRunner:SafeProcessRunner={run(request){
  return new Promise((resolve,reject)=>{
    const child=spawn(request.executable,request.args,{cwd:request.cwd,env:executableEnvironment(),shell:false,windowsHide:true,stdio:['pipe','pipe','pipe'],signal:request.signal});
    let stdout='',stderr='',settled=false;
    let timer:NodeJS.Timeout;
    const fail=(error:Error)=>{if(!settled){settled=true;clearTimeout(timer);reject(error);}};
    const append=(current:string,chunk:Buffer)=>{const next=current+chunk.toString('utf8');if(Buffer.byteLength(next)>outputLimit){child.kill('SIGKILL');throw Error('CLIENT_OUTPUT_TOO_LARGE');}return next;};
    child.stdout.on('data',(chunk:Buffer)=>{try{stdout=append(stdout,chunk);request.onStdout?.(chunk.toString('utf8'));}catch(error){fail(error as Error);}});
    child.stderr.on('data',(chunk:Buffer)=>{try{stderr=append(stderr,chunk);request.onStderr?.(chunk.toString('utf8'));}catch(error){fail(error as Error);}});
    child.once('error',fail);
    child.once('close',code=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,stdout,stderr});}});
    timer=setTimeout(()=>{child.kill('SIGKILL');fail(Error('CLIENT_TIMEOUT'));},request.timeout_ms);
    child.stdin.end(request.stdin);
  });
}};

const isWslRuntime=(environment:NodeJS.ProcessEnv)=>{
  if(process.platform!=='linux')return false;
  if(environment.WSL_DISTRO_NAME||environment.WSL_INTEROP)return true;
  if(environment!==process.env)return false;
  try{return /microsoft/iu.test(readFileSync('/proc/sys/kernel/osrelease','utf8'));}catch{return false;}
};
const isWslHostMount=(path:string)=>/^\/mnt\/[a-z](?:\/|$)/iu.test(path);
const canExecute=(path:string)=>{try{accessSync(path,fsConstants.X_OK);return true;}catch{return false;}};
function nvmBinDirectories(home:string){
  const root=join(home,'.nvm','versions','node');
  try{return readdirSync(root,{withFileTypes:true}).filter(item=>item.isDirectory()).map(item=>join(root,item.name,'bin')).reverse();}catch{return [];}
}
function wslNativeExecutable(names:string[],environment:NodeJS.ProcessEnv){
  const home=environment.HOME,fromPath=(environment.PATH??'').split(delimiter).filter(path=>isAbsolute(path)&&!isWslHostMount(path));
  const homeBins=home?[join(home,'.local','bin'),join(home,'.npm-global','bin'),join(home,'.opencode','bin'),join(home,'.hermes','bin'),join(home,'.cursor','bin'),...nvmBinDirectories(home)]:[];
  for(const directory of [...new Set([...fromPath,...homeBins])]){
    for(const name of names){const candidate=join(directory,name);if(canExecute(candidate))return candidate;}
  }
  return null;
}
export const resolveSubscriptionClientExecutable=(id:SubscriptionClientId,environment:NodeJS.ProcessEnv=process.env)=>{
  const key='AGENT_DRIVER_'+id.toUpperCase()+'_EXECUTABLE',configured=environment[key];
  if(configured!==undefined){requireCondition(isAbsolute(configured)&&configured.length<=4096&&!/[\r\n\0]/u.test(configured),'INVALID_CLIENT_EXECUTABLE');return configured;}
  const names=id==='cursor'?['agent','cursor-agent']:[id];
  if(process.platform!=='linux')return names[0]!;
  const resolved=wslNativeExecutable(names,environment);
  requireCondition(resolved!==null,isWslRuntime(environment)?'WSL_NATIVE_CLIENT_EXECUTABLE_NOT_FOUND':'NATIVE_CLIENT_EXECUTABLE_NOT_FOUND');
  return resolved;
};
const clientExecutable=resolveSubscriptionClientExecutable;
const expiredPattern=/\b(?:expired|expiration|refresh token (?:is )?invalid|session (?:is )?no longer valid)\b/iu;
const probeSpec:Record<SubscriptionClientId,{args:string[]|null;parse:(text:string)=>Omit<SubscriptionClientStatus,'id'|'structured_bridge'>;structured:boolean}>={
  codex:{args:['login','status'],structured:true,parse:text=>/Logged in using ChatGPT/iu.test(text)?{status:'ready',auth:'subscription',reason:'client_reported_ready'}:expiredPattern.test(text)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:/not logged in|login required/iu.test(text)?{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'}},
  claude:{args:['auth','status'],structured:true,parse:text=>{try{const value=JSON.parse(text) as {loggedIn?:unknown;authMethod?:unknown;subscriptionType?:unknown;error?:unknown;status?:unknown};if(value.loggedIn===true)return {status:'ready',auth:value.authMethod==='claude.ai'||typeof value.subscriptionType==='string'?'subscription':'oauth',reason:'client_reported_ready'};if(value.loggedIn===false){const detail=[value.error,value.status].filter(item=>typeof item==='string').join(' ');return expiredPattern.test(detail)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'};}}catch{}return expiredPattern.test(text)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'};}},
  opencode:{args:['auth','list','--format','json'],structured:true,parse:text=>{try{const value=JSON.parse(text) as unknown;const count=Array.isArray(value)?value.length:value&&typeof value==='object'?Object.keys(value).length:0;return count>0?{status:'ready',auth:'unknown',reason:'client_reported_ready'}:{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'};}catch{return expiredPattern.test(text)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'};}}},
  cursor:{args:null,structured:false,parse:()=>({status:'unavailable',auth:'unknown',reason:'status_contract_unavailable'})},
  hermes:{args:['proxy','status'],structured:false,parse:text=>/\[[^\]]+\][^\r\n]*logged in/iu.test(text)&&!/not logged in/iu.test(text)?{status:'ready',auth:'oauth',reason:'oauth_proxy_ready'}:/not logged in/iu.test(text)?{status:'signed_out',auth:'unknown',reason:'proxy_upstreams_signed_out'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'}},
};
const loginSpec:Record<SubscriptionClientId,Partial<Record<SubscriptionAuthFlowKind,string[]>>>= {
  codex:{browser:['login'],device:['login','--device-auth']},
  claude:{browser:['auth','login','--claudeai']},
  opencode:{},
  cursor:{},
  hermes:{browser:['portal','login']},
};
export async function probeSubscriptionClient(id:SubscriptionClientId,environment:NodeJS.ProcessEnv=process.env,runner:SafeProcessRunner=nativeProcessRunner){
  const spec=probeSpec[id]!;
  if(spec.args===null)return {id,status:'unavailable',auth:'unknown',structured_bridge:spec.structured,reason:'status_contract_unavailable'} satisfies SubscriptionClientStatus;
  try{
    const result=await runner.run({executable:clientExecutable(id,environment),args:spec.args,timeout_ms:7_000});
    const parsed=spec.parse(result.stdout+'\n'+result.stderr);
    if(result.code!==0&&parsed.status==='unknown')return {id,status:'unknown',auth:'unknown',structured_bridge:spec.structured,reason:'status_command_failed'} satisfies SubscriptionClientStatus;
    return {id,...parsed,structured_bridge:spec.structured} satisfies SubscriptionClientStatus;
  }catch(error){
    const reason=error instanceof Error&&error.message==='WSL_NATIVE_CLIENT_EXECUTABLE_NOT_FOUND'?'wsl_native_client_not_found':'client_not_available';
    return {id,status:'unavailable',auth:'unknown',structured_bridge:spec.structured,reason} satisfies SubscriptionClientStatus;
  }
}
export async function probeSubscriptionClients(environment:NodeJS.ProcessEnv=process.env,runner:SafeProcessRunner=nativeProcessRunner){
  return Promise.all((Object.keys(probeSpec) as SubscriptionClientId[]).map(id=>probeSubscriptionClient(id,environment,runner)));
}

const idleFlow=(id:SubscriptionClientId):SubscriptionAuthFlowView=>({client_id:id,flow:null,state:loginFlows(id).length?'idle':'unavailable',reason:loginFlows(id).length?'not_started':'login_contract_unavailable',credentials_exposed:false});
export function loginFlows(id:SubscriptionClientId){return Object.keys(loginSpec[id]) as SubscriptionAuthFlowKind[];}
function safeLoginArtifacts(text:string){
  let device_url:string|undefined,user_code:string|undefined;
  for(const match of text.matchAll(/https:\/\/[^\s<>"']+/giu))try{const url=new URL(match[0]);if(url.origin==='https://auth.openai.com'&&url.pathname==='/codex/device')device_url=url.href;}catch{}
  const codeContext=text.match(/(?:one[- ]time|device|verification)?\s*code\s*(?:is|:)?\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/iu);
  if(codeContext)user_code=codeContext[1]!.toUpperCase();
  return {...(device_url?{device_url}:{}),...(user_code?{user_code}:{})};
}

/** Owns only official CLI processes. It never opens or reads a client's credential store. */
export class SubscriptionAuthFlowController {
  private readonly active=new Map<SubscriptionClientId,{view:SubscriptionAuthFlowView;abort:AbortController;output:string}>();
  constructor(readonly environment:NodeJS.ProcessEnv=process.env,readonly runner:SafeProcessRunner=nativeProcessRunner){}
  view(id:SubscriptionClientId){return structuredClone(this.active.get(id)?.view??idleFlow(id));}
  async connections(){
    const statuses=await probeSubscriptionClients(this.environment,this.runner);
    return statuses.map(status=>({...status,supported_login_flows:loginFlows(status.id),connection:this.view(status.id)} satisfies SubscriptionClientConnection));
  }
  async start(id:SubscriptionClientId,flow:SubscriptionAuthFlowKind){
    const args=loginSpec[id][flow];
    if(!args)return {client_id:id,flow,state:'unavailable',reason:'login_contract_unavailable',credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    const current=this.active.get(id);
    if(current&&['starting','waiting'].includes(current.view.state))return this.view(id);
    const status=await probeSubscriptionClient(id,this.environment,this.runner);
    if(status.status==='ready')return {client_id:id,flow,state:'completed',reason:'existing_session_reused',credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    if(status.status!=='signed_out'&&status.status!=='expired')return {client_id:id,flow,state:'unavailable',reason:status.reason,credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    const abort=new AbortController(),entry:{view:SubscriptionAuthFlowView;abort:AbortController;output:string}={view:{client_id:id,flow,state:'starting',reason:'official_cli_starting',credentials_exposed:false},abort,output:''};
    this.active.set(id,entry);
    const observe=(text:string)=>{
      entry.output=(entry.output+text).slice(-16_384);const artifacts=safeLoginArtifacts(entry.output);
      entry.view={client_id:id,flow,state:'waiting',reason:flow==='device'?'waiting_for_device_confirmation':'waiting_for_browser_confirmation',...artifacts,credentials_exposed:false};
    };
    void this.runner.run({executable:clientExecutable(id,this.environment),args,timeout_ms:10*60_000,signal:abort.signal,onStdout:observe,onStderr:observe}).then(async result=>{
      if(result.code!==0){entry.view={client_id:id,flow,state:'failed',reason:'official_cli_login_failed',credentials_exposed:false};return;}
      const verified=await probeSubscriptionClient(id,this.environment,this.runner);
      entry.view={client_id:id,flow,state:verified.status==='ready'?'completed':'failed',reason:verified.status==='ready'?'client_reported_ready':'login_completed_but_status_not_ready',credentials_exposed:false};
    }).catch(()=>{if(!abort.signal.aborted)entry.view={client_id:id,flow,state:'failed',reason:'official_cli_login_failed',credentials_exposed:false};});
    await Promise.resolve();return this.view(id);
  }
  close(){for(const entry of this.active.values())entry.abort.abort();this.active.clear();}
}

function parseStrictJson(text:string){
  const trimmed=text.trim();requireCondition(trimmed.startsWith('{')&&trimmed.endsWith('}'),'CLIENT_STRUCTURED_OUTPUT_INVALID');return JSON.parse(trimmed) as unknown;
}
function codexOutput(stdout:string){
  const events=stdout.split(/\r?\n/u).filter(Boolean).map(line=>JSON.parse(line) as {type?:unknown;item?:{type?:unknown;text?:unknown}});
  const messages=events.filter(event=>event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string');
  requireCondition(messages.length>0,'CLIENT_STRUCTURED_OUTPUT_INVALID');return parseStrictJson(String(messages.at(-1)!.item!.text));
}
function claudeOutput(stdout:string){
  const envelope=JSON.parse(stdout) as {structured_output?:unknown;result?:unknown;is_error?:unknown};
  requireCondition(envelope.is_error!==true,'CLIENT_STRUCTURED_OUTPUT_INVALID');
  if(envelope.structured_output!==undefined)return envelope.structured_output;
  requireCondition(typeof envelope.result==='string','CLIENT_STRUCTURED_OUTPUT_INVALID');return parseStrictJson(envelope.result);
}
function cursorOutput(stdout:string){
  const envelope=JSON.parse(stdout) as {type?:unknown;result?:unknown};
  requireCondition(envelope.type==='result'&&typeof envelope.result==='string','CLIENT_STRUCTURED_OUTPUT_INVALID');return parseStrictJson(envelope.result);
}
function opencodeOutput(stdout:string){
  const texts:string[]=[];
  for(const line of stdout.split(/\r?\n/u).filter(Boolean)){
    let event:unknown;try{event=JSON.parse(line);}catch{continue;}
    const visit=(value:unknown)=>{
      if(!value||typeof value!=='object')return;
      if(Array.isArray(value)){value.forEach(visit);return;}
      const record=value as Record<string,unknown>;
      if(record.type==='text'&&typeof record.text==='string')texts.push(record.text);
      if(record.type==='text'&&record.part&&typeof record.part==='object'&&typeof (record.part as Record<string,unknown>).text==='string')texts.push(String((record.part as Record<string,unknown>).text));
      if(record.part&&typeof record.part==='object')visit(record.part);
      if(record.message&&typeof record.message==='object')visit(record.message);
      if(record.result&&typeof record.result==='object')visit(record.result);
    };
    visit(event);
  }
  for(const text of texts.toReversed())try{return parseStrictJson(text);}catch{}
  const combined=texts.join('').trim();requireCondition(combined.length>0,'CLIENT_STRUCTURED_OUTPUT_INVALID');return parseStrictJson(combined);
}
function prompt(instructions:string,input:unknown,schema:Record<string,unknown>){
  return instructions+'\n\nReturn only one JSON object matching this JSON Schema. Never call tools, read files, execute commands, or perform side effects.\nSCHEMA:\n'+JSON.stringify(schema)+'\nINPUT:\n'+JSON.stringify(input);
}
/** Codex structured output does not accept URI format annotations. Domain validation remains with the caller. */
function codexTransportSchema(schema:Record<string,unknown>){
  const copy=structuredClone(schema);
  const visit=(value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const node=value as Record<string,unknown>;
    if(node.format==='uri'||node.format==='uri-reference')delete node.format;
    for(const key of ['$defs','definitions','properties','patternProperties','dependentSchemas','dependencies']){
      const map=node[key];if(map&&typeof map==='object'&&!Array.isArray(map))for(const child of Object.values(map))visit(child);
    }
    for(const key of ['items','additionalItems','additionalProperties','unevaluatedItems','unevaluatedProperties','contains','propertyNames','not','if','then','else','contentSchema']){
      const child=node[key];if(Array.isArray(child))child.forEach(visit);else visit(child);
    }
    for(const key of ['allOf','anyOf','oneOf','prefixItems'])if(Array.isArray(node[key]))(node[key] as unknown[]).forEach(visit);
  };
  visit(copy);return copy;
}
async function invokeCli(id:Exclude<SubscriptionClientId,'hermes'>,environment:NodeJS.ProcessEnv,runner:SafeProcessRunner,instructions:string,input:unknown,schema:Record<string,unknown>){
  const executable=clientExecutable(id,environment),text=prompt(instructions,input,schema),root=await mkdtemp(join(tmpdir(),'agent-driver-model-'));
  try{
    if(id==='codex'){
      const schemaPath=join(root,'schema.json');await writeFile(schemaPath,JSON.stringify(codexTransportSchema(schema)),{mode:0o600});
      const result=await runner.run({executable,args:['exec','--json','--skip-git-repo-check','--ephemeral','--ignore-user-config','--ignore-rules','--sandbox','read-only','--output-schema',schemaPath,'-'],stdin:text,cwd:root,timeout_ms:60_000});
      requireCondition(result.code===0,'CLIENT_MODEL_UNAVAILABLE');return {value:codexOutput(result.stdout),model:'codex-subscription'};
    }
    if(id==='claude'){
      const result=await runner.run({executable,args:['-p','--output-format','json','--json-schema',JSON.stringify(schema),'--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--disable-slash-commands','--no-chrome','--permission-mode','dontAsk','--no-session-persistence'],stdin:text,cwd:root,timeout_ms:120_000});
      requireCondition(result.code===0,'CLIENT_MODEL_UNAVAILABLE');return {value:claudeOutput(result.stdout),model:'claude-subscription'};
    }
    if(id==='opencode'){
      await writeFile(join(root,'opencode.json'),JSON.stringify({permission:{'*':'deny'},share:'disabled'}),{mode:0o600});
      const model=environment.AGENT_DRIVER_OPENCODE_MODEL,args=['run','--format','json',...(model?['--model',model]:[]),text];
      const result=await runner.run({executable,args,cwd:root,timeout_ms:120_000});
      requireCondition(result.code===0,'CLIENT_MODEL_UNAVAILABLE');return {value:opencodeOutput(result.stdout),model:model??'opencode-configured'};
    }
    const result=await runner.run({executable,args:['-p','--output-format','json'],stdin:text,cwd:root,timeout_ms:60_000});
    requireCondition(result.code===0,'CLIENT_MODEL_UNAVAILABLE');return {value:cursorOutput(result.stdout),model:'cursor-subscription'};
  }finally{await rm(root,{recursive:true,force:true});}
}

export class McpSamplingStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];
  constructor(readonly client:McpSamplingClient){}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    const started=performance.now(),input_sha256=hashJson({instructions,input,schema});let model='mcp-client',accepted=false;
    try{
      requireCondition(this.client.available(),'MCP_SAMPLING_UNAVAILABLE');
      const response=await this.client.createMessage({messages:[{role:'user',content:{type:'text',text:prompt(instructions,input,schema)}}],systemPrompt:'You are a bounded structured-decision provider. Return JSON only. You have no execution or approval authority.',includeContext:'none',maxTokens:purpose==='correct'?1_500:5_000,temperature:0},{timeout:60_000});
      model=response.model;const blocks=Array.isArray(response.content)?response.content:[response.content];
      requireCondition(blocks.length===1&&blocks[0]?.type==='text'&&typeof blocks[0].text==='string'&&response.stopReason!=='maxTokens','MCP_SAMPLING_INVALID');
      const value=parseStrictJson(blocks[0].text);accepted=true;return value;
    }catch{throw Error('MCP_SAMPLING_UNAVAILABLE');}
    finally{this.calls.push({purpose,provider:'mcp_sampling',auth:'client_subscription',model,elapsed_ms:Math.round(performance.now()-started),input_sha256,status:accepted?'accepted':'failed',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved',...(accepted?{}:{failure_kind:'invalid_output'})});}
  }
}

export interface SubscriptionAwareModelOptions {
  environment?:NodeJS.ProcessEnv;runner?:SafeProcessRunner;sampling?:McpSamplingStructuredModel;fallbackModel?:StructuredModel;fallbackKind?:'api_key'|'configured';
}
export class SubscriptionAwareStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];private statuses=new Map<SubscriptionClientId,{value:SubscriptionClientStatus;observed_at:number}>();
  constructor(readonly options:SubscriptionAwareModelOptions={}){}
  private async clientStatus(id:SubscriptionClientId){
    const cached=this.statuses.get(id);
    if(cached&&Date.now()-cached.observed_at<30_000)return cached.value;
    const status=await probeSubscriptionClient(id,this.options.environment??process.env,this.options.runner??nativeProcessRunner);
    this.statuses.set(id,{value:status,observed_at:Date.now()});return status;
  }
  async status(){
    const clients=await Promise.all((Object.keys(probeSpec) as SubscriptionClientId[]).map(id=>this.clientStatus(id)));
    return {mcp_sampling:this.options.sampling?.client.available()?'ready':'unavailable',clients,fallback:this.options.fallbackModel?(this.options.fallbackKind??'configured'):'not_configured',credentials_exposed:false};
  }
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    const environment=this.options.environment??process.env,preferred=environment.AGENT_DRIVER_LLM_CLIENT?.split(',').map(item=>item.trim()).filter(Boolean)??['mcp','codex','claude','opencode','cursor','api'];
    for(const id of preferred){
      try{
        if(id==='mcp'&&this.options.sampling){const value=await this.options.sampling.call(purpose,instructions,input,schema);this.calls.push(this.options.sampling.calls.at(-1)!);return value;}
        if(['codex','claude','opencode','cursor'].includes(id)){
          const client=id as Exclude<SubscriptionClientId,'hermes'>,state=await this.clientStatus(client);
          if(state?.status!=='ready'||!state.structured_bridge)continue;
          const started=performance.now(),input_sha256=hashJson({instructions,input,schema});let accepted=false,model=client+'-subscription';
          try{const result=await invokeCli(client,environment,this.options.runner??nativeProcessRunner,instructions,input,schema);model=result.model;accepted=true;return result.value;}
          catch(error){this.statuses.delete(client);throw error;}
          finally{this.calls.push({purpose,provider:client,auth:'subscription',model,elapsed_ms:Math.round(performance.now()-started),input_sha256,status:accepted?'accepted':'failed',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved',...(accepted?{}:{failure_kind:'invalid_output'})});}
        }
        if(id==='api'&&this.options.fallbackModel){const value=await this.options.fallbackModel.call(purpose,instructions,input,schema);this.calls.push(this.options.fallbackModel.calls.at(-1)!);return value;}
      }catch{continue;}
    }
    throw Error('STRUCTURED_MODEL_UNAVAILABLE');
  }
}

export function subscriptionAwareModelFromHostEnvironment(options:Omit<SubscriptionAwareModelOptions,'environment'>={},environment:NodeJS.ProcessEnv=process.env){
  return new SubscriptionAwareStructuredModel({...options,environment});
}
