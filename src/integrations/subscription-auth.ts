import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {constants as fsConstants,accessSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {delimiter,isAbsolute,join} from 'node:path';
import {hashJson,modelCallBudget,type ModelCall,type StructuredModel} from '../taskpack/adaptive-spec.js';
import {requireCondition} from '../core/contracts.js';
import {classifyClientFailure,handoffContext,isInvalidClientOutput,isNonRetryableClientFailure,recordClientRoute,type ClientRouteEvent,type HandoffClient,type HandoffReason} from './client-handoff.js';
import {decisionClientCapabilities,supportsStructuredJudgment} from './client-capabilities.js';
import {withDecisionSession,type DecisionSessionScope,type DecisionSessionTurn} from './decision-sessions.js';

export type SubscriptionClientId='codex'|'claude'|'opencode'|'cursor'|'hermes';
export interface SubscriptionClientStatus {
  id:SubscriptionClientId;status:'ready'|'signed_out'|'expired'|'unavailable'|'unknown';
  auth:'subscription'|'oauth'|'unknown';structured_bridge:boolean;reason:string;
}
export type SubscriptionAuthFlowKind='browser'|'device';
export type SubscriptionAuthFlowState='idle'|'starting'|'waiting'|'completed'|'failed'|'unavailable';
export interface SubscriptionAuthFlowView {
  client_id:SubscriptionClientId;flow:SubscriptionAuthFlowKind|null;state:SubscriptionAuthFlowState;
  device_url?:string;auth_url?:string;user_code?:string;reason:string;credentials_exposed:false;
}
export interface SubscriptionClientConnection extends SubscriptionClientStatus {
  supported_login_flows:SubscriptionAuthFlowKind[];connection:SubscriptionAuthFlowView;
}
export interface ProcessRequest {
  executable:string;args:string[];stdin?:string;cwd?:string;timeout_ms:number;signal?:AbortSignal;
  output_limit_bytes?:number;
  login_browser?:'ui';
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
    // Own process group: a CLI wrapper (npm `codex`) starts the real binary as its
    // child, and stopping only the wrapper left that binary running after a timeout.
    const group=process.platform!=='win32';
    const child=spawn(request.executable,request.args,{cwd:request.cwd,env:{...executableEnvironment(),...(request.login_browser==='ui'?{NO_OPEN_BROWSER:'1'}:{})},shell:false,windowsHide:true,detached:group,stdio:['pipe','pipe','pipe'],signal:request.signal});
    const stop=()=>{try{if(group&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL');}catch{child.kill('SIGKILL');}};
    request.signal?.addEventListener('abort',stop,{once:true});
    let stdout='',stderr='',settled=false;
    let timer:NodeJS.Timeout;
    const fail=(error:Error)=>{if(!settled){settled=true;clearTimeout(timer);stop();reject(error);}};
    const append=(current:string,chunk:string)=>{const next=current+chunk;if(Buffer.byteLength(next)>(request.output_limit_bytes??outputLimit)){stop();throw Error('CLIENT_OUTPUT_TOO_LARGE');}return next;};
    // Node's streaming decoder carries an incomplete UTF-8 code point across chunks.
    // Per-chunk Buffer#toString corrupts Korean and other multibyte CLI answers.
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{try{stdout=append(stdout,chunk);request.onStdout?.(chunk);}catch(error){fail(error as Error);}});
    child.stderr.on('data',(chunk:string)=>{try{stderr=append(stderr,chunk);request.onStderr?.(chunk);}catch(error){fail(error as Error);}});
    child.once('error',fail);
    child.once('close',code=>{if(!settled){settled=true;clearTimeout(timer);resolve({code,stdout,stderr});}});
    timer=setTimeout(()=>{stop();fail(Error('CLIENT_TIMEOUT'));},request.timeout_ms);
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
const probeSpec:Record<SubscriptionClientId,{args:string[]|null;parse:(text:string)=>Omit<SubscriptionClientStatus,'id'|'structured_bridge'>}>={
  codex:{args:['login','status'],parse:text=>/Logged in using ChatGPT/iu.test(text)?{status:'ready',auth:'subscription',reason:'client_reported_ready'}:expiredPattern.test(text)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:/not logged in|login required/iu.test(text)?{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'}},
  claude:{args:['auth','status'],parse:text=>{try{const value=JSON.parse(text) as {loggedIn?:unknown;authMethod?:unknown;apiProvider?:unknown;apiKeySource?:unknown;subscriptionType?:unknown;error?:unknown;status?:unknown};if(value.loggedIn===true){const subscription=value.apiProvider==='firstParty'&&(value.apiKeySource===undefined||value.apiKeySource===null||value.apiKeySource==='')&&(value.authMethod==='claude.ai'||value.authMethod==='oauth_token'||value.authMethod===undefined&&typeof value.subscriptionType==='string'&&['pro','max','team','enterprise'].includes(value.subscriptionType.toLowerCase()));return {status:subscription?'ready':'unknown',auth:subscription?'subscription':'unknown',reason:subscription?'client_reported_ready':'client_auth_not_subscription'};}if(value.loggedIn===false){const detail=[value.error,value.status].filter(item=>typeof item==='string').join(' ');return expiredPattern.test(detail)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'};}}catch{}return expiredPattern.test(text)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'};}},
  opencode:{args:['auth','list'],parse:text=>{
    const clean=text.replace(/\u001b\[[0-9;]*m/gu,''),count=clean.match(/\b(\d+) credentials?\b/iu);
    if(count&&/Credentials/u.test(clean))return Number(count[1])>0?{status:'ready',auth:'unknown',reason:'client_reported_ready'}:{status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'};
    return expiredPattern.test(clean)?{status:'expired',auth:'unknown',reason:'client_reported_expired'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'};
  }},
  cursor:{args:['status','--format','json'],parse:text=>{
    try{const value=JSON.parse(text) as {status?:unknown;isAuthenticated?:unknown;hasAccessToken?:unknown;usingApiKeyFromEnv?:unknown;usingAuthTokenFromEnv?:unknown};
      if(value.isAuthenticated===false&&value.status==='unauthenticated')return {status:'signed_out',auth:'unknown',reason:'client_reported_signed_out'};
      if(value.isAuthenticated===true&&value.status==='authenticated'&&value.hasAccessToken===true&&value.usingApiKeyFromEnv!==true&&value.usingAuthTokenFromEnv!==true)return {status:'ready',auth:'oauth',reason:'client_reported_ready'};
    }catch{}return {status:'unknown',auth:'unknown',reason:'unrecognized_status'};
  }},
  hermes:{args:['proxy','status'],parse:text=>/\[[^\]]+\][^\r\n]*logged in/iu.test(text)&&!/not logged in/iu.test(text)?{status:'ready',auth:'oauth',reason:'oauth_proxy_ready'}:/not logged in/iu.test(text)?{status:'signed_out',auth:'unknown',reason:'proxy_upstreams_signed_out'}:{status:'unknown',auth:'unknown',reason:'unrecognized_status'}},
};
const loginSpec:Record<SubscriptionClientId,Partial<Record<SubscriptionAuthFlowKind,string[]>>>= {
  codex:{browser:['login'],device:['login','--device-auth']},
  claude:{browser:['auth','login','--claudeai']},
  opencode:{device:['auth','login','--provider','openai','--method','ChatGPT Pro/Plus (headless)']},
  cursor:{browser:['login']},
  hermes:{browser:['portal','login']},
};
// Only read-only probes are joined. Model turns are deliberately never deduplicated.
const probePools=new WeakMap<SafeProcessRunner,{pending:Map<string,Promise<SubscriptionClientStatus>>;revisions:Map<SubscriptionClientId,number>}>();
function probePool(runner:SafeProcessRunner){
  let pool=probePools.get(runner);if(!pool){pool={pending:new Map(),revisions:new Map()};probePools.set(runner,pool);}return pool;
}
function invalidateClient(id:SubscriptionClientId,runner:SafeProcessRunner){
  const pool=probePool(runner);pool.revisions.set(id,(pool.revisions.get(id)??0)+1);
}
function clientBinding(id:SubscriptionClientId,environment:NodeJS.ProcessEnv,runner:SafeProcessRunner,includeRevision=true){
  let executable:string|null=null,binary:unknown=null;
  try{executable=clientExecutable(id,environment);if(isAbsolute(executable)){const stat=statSync(executable);binary={size:stat.size,mtime:stat.mtimeMs,ino:stat.ino};}}catch{}
  const keys=['PATH','HOME','USERPROFILE','CODEX_HOME','WSL_DISTRO_NAME','WSL_INTEROP',`AGENT_DRIVER_${id.toUpperCase()}_EXECUTABLE`];
  return hashJson({id,executable,binary,environment:Object.fromEntries(keys.map(key=>[key,environment[key]??null])),revision:includeRevision?probePool(runner).revisions.get(id)??0:0});
}
async function runSubscriptionProbe(id:SubscriptionClientId,environment:NodeJS.ProcessEnv,runner:SafeProcessRunner):Promise<SubscriptionClientStatus>{
  const spec=probeSpec[id]!,structured_bridge=supportsStructuredJudgment(id);
  if(spec.args===null)return {id,status:'unavailable',auth:'unknown',structured_bridge,reason:'status_contract_unavailable'};
  try{
    const result=await runner.run({executable:clientExecutable(id,environment),args:spec.args,timeout_ms:7_000});
    const parsed=spec.parse(result.stdout+'\n'+result.stderr);
    if(result.code!==0&&(parsed.status==='unknown'||parsed.status==='ready'))return {id,status:'unknown',auth:'unknown',structured_bridge,reason:'status_command_failed'};
    return {id,...parsed,structured_bridge};
  }catch(error){
    const reason=error instanceof Error&&error.message==='WSL_NATIVE_CLIENT_EXECUTABLE_NOT_FOUND'?'wsl_native_client_not_found':'client_not_available';
    return {id,status:'unavailable',auth:'unknown',structured_bridge,reason};
  }
}
export async function probeSubscriptionClient(id:SubscriptionClientId,environment:NodeJS.ProcessEnv=process.env,runner:SafeProcessRunner=nativeProcessRunner){
  const snapshot={...environment},pool=probePool(runner),binding=clientBinding(id,snapshot,runner);
  let pending=pool.pending.get(binding);
  if(!pending){
    pending=runSubscriptionProbe(id,snapshot,runner).finally(()=>{if(pool.pending.get(binding)===pending)pool.pending.delete(binding);});
    pool.pending.set(binding,pending);
  }
  // Callers must not be able to mutate another caller's connection observation.
  return {...await pending};
}
export async function probeSubscriptionClients(environment:NodeJS.ProcessEnv=process.env,runner:SafeProcessRunner=nativeProcessRunner){
  return Promise.all((Object.keys(probeSpec) as SubscriptionClientId[]).map(id=>probeSubscriptionClient(id,environment,runner)));
}

const idleFlow=(id:SubscriptionClientId):SubscriptionAuthFlowView=>({client_id:id,flow:null,state:loginFlows(id).length?'idle':'unavailable',reason:loginFlows(id).length?'not_started':'login_contract_unavailable',credentials_exposed:false});
export function loginFlows(id:SubscriptionClientId){return Object.keys(loginSpec[id]) as SubscriptionAuthFlowKind[];}
function safeLoginArtifacts(id:SubscriptionClientId,text:string){
  let device_url:string|undefined,auth_url:string|undefined,user_code:string|undefined;
  const clean=text.replace(/\u001b\[[0-9;]*m/gu,'');
  for(const match of clean.matchAll(/https:\/\/[^\s<>"']+/giu))try{
    const url=new URL(match[0]);if(url.username||url.password||url.href.length>4096||[...url.searchParams.keys()].some(key=>/token|secret|password/iu.test(key)))continue;
    if(['codex','opencode'].includes(id)&&url.origin==='https://auth.openai.com'&&url.pathname==='/codex/device'&&!url.search&&!url.hash)device_url=url.href;
    if(id==='cursor'&&url.origin==='https://cursor.com'&&url.pathname==='/loginDeepControl'&&url.searchParams.get('mode')==='login'&&url.searchParams.get('redirectTarget')==='cli')auth_url=url.href;
    if(id==='claude'&&url.origin==='https://claude.ai'&&url.pathname==='/oauth/authorize')auth_url=url.href;
  }catch{}
  const codeContext=text.match(/(?:one[- ]time|device|verification)?\s*code\s*(?:is|:)?\s*([A-Z0-9]{4,8}-[A-Z0-9]{4,8})/iu);
  if(codeContext)user_code=codeContext[1]!.toUpperCase();
  return {...(device_url?{device_url}:{}),...(auth_url?{auth_url}:{}),...(device_url&&user_code?{user_code}:{})};
}

/** Owns only official CLI processes. It never opens or reads a client's credential store. */
export class SubscriptionAuthFlowController {
  private readonly active=new Map<SubscriptionClientId,{view:SubscriptionAuthFlowView;abort:AbortController;output:string;binding:string}>();
  private readonly starts=new Map<SubscriptionClientId,Promise<SubscriptionAuthFlowView>>();
  private closed=false;
  constructor(readonly environment:NodeJS.ProcessEnv=process.env,readonly runner:SafeProcessRunner=nativeProcessRunner){}
  view(id:SubscriptionClientId){
    const entry=this.active.get(id);
    if(entry&&entry.view.reason!=='connection_changed'&&entry.binding!==clientBinding(id,this.environment,this.runner,false)){
      entry.abort.abort();invalidateClient(id,this.runner);
      entry.view={client_id:id,flow:entry.view.flow,state:'unavailable',reason:'connection_changed',credentials_exposed:false};
    }
    return structuredClone(entry?.view??idleFlow(id));
  }
  async connections(){
    const statuses=await probeSubscriptionClients(this.environment,this.runner);
    return statuses.map(status=>({...status,supported_login_flows:loginFlows(status.id),connection:this.view(status.id)} satisfies SubscriptionClientConnection));
  }
  start(id:SubscriptionClientId,flow:SubscriptionAuthFlowKind):Promise<SubscriptionAuthFlowView>{
    if(this.closed)return Promise.resolve({client_id:id,flow,state:'unavailable',reason:'connection_controller_closed',credentials_exposed:false});
    const pending=this.starts.get(id);if(pending)return pending.then(view=>structuredClone(view));
    const started=this.begin(id,flow).finally(()=>{if(this.starts.get(id)===started)this.starts.delete(id);});
    this.starts.set(id,started);return started;
  }
  private async begin(id:SubscriptionClientId,flow:SubscriptionAuthFlowKind):Promise<SubscriptionAuthFlowView>{
    const args=loginSpec[id][flow];
    if(!args)return {client_id:id,flow,state:'unavailable',reason:'login_contract_unavailable',credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    this.view(id);const current=this.active.get(id);
    if(current&&['starting','waiting'].includes(current.view.state))return this.view(id);
    const environment={...this.environment},binding=clientBinding(id,environment,this.runner);
    const status=await probeSubscriptionClient(id,environment,this.runner);
    if(this.closed)return {client_id:id,flow,state:'unavailable',reason:'connection_controller_closed',credentials_exposed:false};
    if(binding!==clientBinding(id,this.environment,this.runner))return {client_id:id,flow,state:'unavailable',reason:'connection_changed',credentials_exposed:false};
    if(status.status==='ready')return {client_id:id,flow,state:'completed',reason:'existing_session_reused',credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    if(status.status!=='signed_out'&&status.status!=='expired')return {client_id:id,flow,state:'unavailable',reason:status.reason,credentials_exposed:false} satisfies SubscriptionAuthFlowView;
    const abort=new AbortController(),entry={view:{client_id:id,flow,state:'starting',reason:'official_cli_starting',credentials_exposed:false} as SubscriptionAuthFlowView,abort,output:'',binding:clientBinding(id,environment,this.runner,false)};
    this.active.set(id,entry);
    const currentEntry=()=>{this.view(id);return !this.closed&&!abort.signal.aborted&&this.active.get(id)===entry;};
    const observe=(text:string)=>{
      if(!currentEntry())return;
      entry.output=(entry.output+text).slice(-16_384);const artifacts=safeLoginArtifacts(id,entry.output);
      entry.view={client_id:id,flow,state:'waiting',reason:flow==='device'?'waiting_for_device_confirmation':'waiting_for_browser_confirmation',...artifacts,credentials_exposed:false};
    };
    invalidateClient(id,this.runner);
    void Promise.resolve().then(()=>{requireCondition(currentEntry(),'CLIENT_LOGIN_CANCELLED');return this.runner.run({executable:clientExecutable(id,environment),args,timeout_ms:10*60_000,signal:abort.signal,...(id==='cursor'?{login_browser:'ui' as const}:{}),onStdout:observe,onStderr:observe});}).then(async result=>{
      if(!currentEntry())return;
      if(result.code!==0){entry.view={client_id:id,flow,state:'failed',reason:'official_cli_login_failed',credentials_exposed:false};return;}
      invalidateClient(id,this.runner);
      const verified=await probeSubscriptionClient(id,environment,this.runner);
      if(!currentEntry())return;
      entry.view={client_id:id,flow,state:verified.status==='ready'?'completed':'failed',reason:verified.status==='ready'?'client_reported_ready':'login_completed_but_status_not_ready',credentials_exposed:false};
    }).catch(()=>{if(currentEntry())entry.view={client_id:id,flow,state:'failed',reason:'official_cli_login_failed',credentials_exposed:false};});
    await Promise.resolve();return this.view(id);
  }
  close(){this.closed=true;for(const [id,entry] of this.active){entry.abort.abort();invalidateClient(id,this.runner);}this.active.clear();}
}

function parseJson(text:string):unknown{try{return JSON.parse(text);}catch{throw Error('CLIENT_STRUCTURED_OUTPUT_INVALID');}}
function parseStrictJson(text:string){
  const trimmed=text.trim();requireCondition(trimmed.startsWith('{')&&trimmed.endsWith('}'),'CLIENT_STRUCTURED_OUTPUT_INVALID');return parseJson(trimmed);
}
function codexOutput(stdout:string){
  const events=stdout.split(/\r?\n/u).filter(Boolean).map(line=>parseJson(line) as {type?:unknown;item?:{type?:unknown;text?:unknown}});
  requireCondition(events.every(event=>event!==null&&typeof event==='object'&&!Array.isArray(event)),'CLIENT_STRUCTURED_OUTPUT_INVALID');
  const messages=events.filter(event=>event.type==='item.completed'&&event.item?.type==='agent_message'&&typeof event.item.text==='string');
  requireCondition(messages.length>0,'CLIENT_STRUCTURED_OUTPUT_INVALID');return parseStrictJson(String(messages.at(-1)!.item!.text));
}
function claudeOutput(stdout:string){
  const envelope=parseJson(stdout) as {structured_output?:unknown;result?:unknown;is_error?:unknown}|null;
  requireCondition(envelope!==null&&typeof envelope==='object'&&!Array.isArray(envelope)&&envelope.is_error!==true,'CLIENT_STRUCTURED_OUTPUT_INVALID');
  if(envelope.structured_output!==undefined){requireCondition(envelope.structured_output!==null&&typeof envelope.structured_output==='object'&&!Array.isArray(envelope.structured_output),'CLIENT_STRUCTURED_OUTPUT_INVALID');return envelope.structured_output;}
  requireCondition(typeof envelope.result==='string','CLIENT_STRUCTURED_OUTPUT_INVALID');
  // Some CLI versions wrap the single JSON result in a Markdown fence. Strip
  // only an exact whole-message wrapper; never extract JSON from mixed prose.
  const text=envelope.result.trim(),fenced=/^```json\s*\n([\s\S]*?)\n```$/u.exec(text);
  return parseStrictJson(fenced?.[1]??text);
}
function cursorOutput(stdout:string){
  const envelope=parseJson(stdout) as {type?:unknown;result?:unknown};
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
const schemaObject=(value:unknown):Record<string,unknown>|null=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;
function localSchemaReference(root:Record<string,unknown>,reference:unknown){
  if(typeof reference!=='string'||!reference.startsWith('#/'))return null;
  let value:unknown=root;
  for(const key of reference.slice(2).split('/').map(part=>part.replace(/~1/gu,'/').replace(/~0/gu,'~'))){const node=schemaObject(value);if(!node||!Object.hasOwn(node,key))return null;value=node[key];}
  return value;
}
function sameJson(left:unknown,right:unknown):boolean{
  // JSON numbers do not distinguish -0 from 0 (both serialize as 0).
  if(left===right)return true;
  if(Array.isArray(left))return Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>sameJson(value,right[index]));
  const a=schemaObject(left),b=schemaObject(right);return a!==null&&b!==null&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>Object.hasOwn(b,key)&&sameJson(a[key],b[key]));
}
/** Structural branch selection only. The caller still applies its original domain validator. */
function schemaShapeMatches(value:unknown,schema:unknown,root:Record<string,unknown>,depth=0):boolean{
  if(depth>100)return false;
  if(typeof schema==='boolean')return schema;
  const node=schemaObject(schema);if(!node)return true;
  if(node.$ref!==undefined){const target=localSchemaReference(root,node.$ref);if(target===null||!schemaShapeMatches(value,target,root,depth+1))return false;}
  if(Object.hasOwn(node,'const')&&!sameJson(value,node.const))return false;
  if(Array.isArray(node.enum)&&!node.enum.some(item=>sameJson(value,item)))return false;
  const type=Array.isArray(node.type)?node.type:node.type===undefined?null:[node.type];
  if(type&&!type.some(kind=>kind==='null'?value===null:kind==='array'?Array.isArray(value):kind==='object'?schemaObject(value)!==null:kind==='integer'?typeof value==='number'&&Number.isInteger(value):kind==='number'?typeof value==='number'&&Number.isFinite(value):typeof value===kind))return false;
  if(Array.isArray(node.allOf)&&!node.allOf.every(child=>schemaShapeMatches(value,child,root,depth+1)))return false;
  if(Array.isArray(node.anyOf)&&!node.anyOf.some(child=>schemaShapeMatches(value,child,root,depth+1)))return false;
  if(Array.isArray(node.oneOf)&&node.oneOf.filter(child=>schemaShapeMatches(value,child,root,depth+1)).length!==1)return false;
  if(node.not!==undefined&&schemaShapeMatches(value,node.not,root,depth+1))return false;
  const object=schemaObject(value),properties=schemaObject(node.properties);
  if(object){
    if(Array.isArray(node.required)&&node.required.some(key=>typeof key==='string'&&!Object.hasOwn(object,key)))return false;
    for(const [key,item] of Object.entries(object)){
      if(properties&&Object.hasOwn(properties,key)){if(!schemaShapeMatches(item,properties[key],root,depth+1))return false;}
      else if(node.additionalProperties===false)return false;
      else if(schemaObject(node.additionalProperties)&&!schemaShapeMatches(item,node.additionalProperties,root,depth+1))return false;
    }
  }
  if(Array.isArray(value))for(let index=0;index<value.length;index++){
    const item=Array.isArray(node.prefixItems)&&index<node.prefixItems.length?node.prefixItems[index]:Array.isArray(node.items)?node.items[index]:node.items;
    if(item!==undefined&&!schemaShapeMatches(value[index],item,root,depth+1))return false;
  }
  return true;
}
/** Only a required discriminator with disjoint literal sets proves that oneOf
 * and anyOf accept the same objects. Never broaden overlapping unions. */
function disjointObjectBranches(branches:unknown[]):boolean{
  if(branches.length<2)return false;
  const objects=branches.map(schemaObject);
  if(objects.some(node=>!node||node.type!=='object'))return false;
  const literalSet=(node:Record<string,unknown>,key:string):unknown[]|null=>{
    if(!Array.isArray(node.required)||!node.required.includes(key))return null;
    const field=schemaObject(schemaObject(node.properties)?.[key]);if(!field)return null;
    return Object.hasOwn(field,'const')?[field.const]:Array.isArray(field.enum)&&field.enum.length?field.enum:null;
  };
  const first=objects[0]!;
  return Object.keys(schemaObject(first.properties)??{}).some(key=>{
    const sets=objects.map(node=>literalSet(node!,key));
    return sets.every(set=>set!==null)&&sets.every((set,index)=>sets.slice(index+1).every(other=>!set!.some(value=>other!.some(candidate=>sameJson(value,candidate)))));
  });
}
/** Codex requires every property; optional absence is represented only in transport by null. */
function codexTransportSchema(schema:Record<string,unknown>){
  const copy=structuredClone(schema);
  const visit=(value:unknown)=>{
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const node=value as Record<string,unknown>;
    if(Array.isArray(node.oneOf)){
      requireCondition(node.anyOf===undefined&&disjointObjectBranches(node.oneOf),'CLIENT_OUTPUT_SCHEMA_UNSUPPORTED');
      node.anyOf=node.oneOf;delete node.oneOf;
    }
    if(node.format==='uri'||node.format==='uri-reference')delete node.format;
    for(const key of ['$defs','definitions','properties','patternProperties','dependentSchemas','dependencies']){
      const map=node[key];if(map&&typeof map==='object'&&!Array.isArray(map))for(const child of Object.values(map))visit(child);
    }
    for(const key of ['items','additionalItems','additionalProperties','unevaluatedItems','unevaluatedProperties','contains','propertyNames','not','if','then','else','contentSchema']){
      const child=node[key];if(Array.isArray(child))child.forEach(visit);else visit(child);
    }
    for(const key of ['allOf','anyOf','oneOf','prefixItems'])if(Array.isArray(node[key]))(node[key] as unknown[]).forEach(visit);
    const properties=schemaObject(node.properties);
    if(properties){
      const required=Array.isArray(node.required)?node.required.filter((key):key is string=>typeof key==='string'):[];
      for(const [key,child] of Object.entries(properties))if(!required.includes(key)){
        // Wrap the entire child, not only its type: enum/const/ref constraints
        // must remain intact. Existing domain nullability is not a sentinel.
        if(!schemaShapeMatches(null,child,copy))properties[key]={anyOf:[child,{type:'null'}]};
      }
      node.required=[...required,...Object.keys(properties).filter(key=>!required.includes(key))];
    }
  };
  visit(copy);return copy;
}
function codexDomainOutput(value:unknown,schema:Record<string,unknown>){
  const retainedNulls=(item:unknown):number=>item===null?1:Array.isArray(item)?item.reduce<number>((count,child)=>count+retainedNulls(child),0):schemaObject(item)?Object.values(item as Record<string,unknown>).reduce<number>((count,child)=>count+retainedNulls(child),0):0;
  const decode=(input:unknown,definition:unknown,depth=0):unknown=>{
    requireCondition(depth<=100,'CLIENT_STRUCTURED_OUTPUT_INVALID');
    const node=schemaObject(definition);if(!node)return input;
    let output=input;
    if(node.$ref!==undefined){const target=localSchemaReference(schema,node.$ref);if(target!==null)output=decode(output,target,depth+1);}
    // Choose using the decoded original shapes, never by the transport's added
    // nullable arm. If branches overlap, retain legitimate domain nulls.
    for(const keyword of ['anyOf','oneOf'])if(Array.isArray(node[keyword])){
      const candidates=(node[keyword] as unknown[]).map(branch=>({branch,value:decode(output,branch,depth+1)})).filter(candidate=>schemaShapeMatches(candidate.value,candidate.branch,schema));
      if(candidates.length)output=candidates.toSorted((a,b)=>retainedNulls(b.value)-retainedNulls(a.value))[0]!.value;
    }
    if(Array.isArray(node.allOf))for(const branch of node.allOf)output=decode(output,branch,depth+1);
    if(Array.isArray(output))return output.map((item,index)=>decode(item,Array.isArray(node.prefixItems)&&index<node.prefixItems.length?node.prefixItems[index]:Array.isArray(node.items)?node.items[index]:node.items,depth+1));
    const object=schemaObject(output),properties=schemaObject(node.properties);if(!object)return output;
    const copy={...object},required=Array.isArray(node.required)?node.required:[];
    for(const [key,item] of Object.entries(object)){
      if(properties&&Object.hasOwn(properties,key)){
        const child=properties[key];
        if(item===null&&!required.includes(key)&&!schemaShapeMatches(null,child,schema))delete copy[key];
        else copy[key]=decode(item,child,depth+1);
      }else if(schemaObject(node.additionalProperties))copy[key]=decode(item,node.additionalProperties,depth+1);
      // Unknown keys are not optional sentinels. Preserve them so strict domain
      // validation rejects them, rather than silently weakening the allowlist.
    }
    return copy;
  };
  return decode(value,schema);
}
function nativeSessionId(id:'codex'|'claude',stdout:string):string|null{
  const records=id==='codex'?stdout.split(/\r?\n/u).filter(Boolean).map(line=>parseJson(line)): [parseJson(stdout)];
  const found=records.flatMap(value=>{if(!value||typeof value!=='object')return [];const event=value as Record<string,unknown>;return id==='codex'&&event.type==='thread.started'?[event.thread_id]:id==='claude'?[event.session_id]:[];}).filter(value=>value!==undefined);
  requireCondition(found.length<=1&&found.every(value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)),'CLIENT_STRUCTURED_OUTPUT_INVALID');
  return found[0] as string|undefined??null;
}
function cliFailure(result:ProcessResult,session?:DecisionSessionTurn){
  // The CLI can put a generic line on stderr and its typed provider error on
  // stdout. Inspect both, but persist and expose only our bounded reason code.
  const detail=result.stderr+'\n'+result.stdout;
  if(session?.session_id&&/(?:no (?:conversation|session|thread) found|(?:session|conversation|thread)[^\r\n]{0,100}(?:not found|does not exist))/iu.test(detail))throw Error('CLIENT_NATIVE_SESSION_MISSING');
  throw Error(`CLIENT_${classifyClientFailure(detail).toUpperCase()}`);
}
async function invokeCli(id:Exclude<SubscriptionClientId,'hermes'>,environment:NodeJS.ProcessEnv,runner:SafeProcessRunner,instructions:string,input:unknown,schema:Record<string,unknown>,purpose:ModelCall['purpose'],session?:DecisionSessionTurn,role?:string){
  const executable=clientExecutable(id,environment),text=prompt(instructions,input,schema),root=session?.directory??await mkdtemp(join(tmpdir(),'agent-driver-model-'));
  try{
    if(id==='codex'){
      const schemaPath=join(root,'schema.json');await writeFile(schemaPath,JSON.stringify(codexTransportSchema(schema)),{mode:0o600});
      const selected=environment.AGENT_DRIVER_CODEX_MODEL,effort=environment.AGENT_DRIVER_CODEX_REASONING_EFFORT;
      requireCondition(effort===undefined||/^(?:none|minimal|low|medium|high|xhigh|max|ultra)$/u.test(effort),'CLIENT_MODEL_REASONING_INVALID');
      const flags=['--json','--skip-git-repo-check',...(!session?['--ephemeral']:[]),'--ignore-user-config','--ignore-rules','--output-schema',schemaPath];
      const prefix=[...(selected?['--model',selected]:[]),'exec',...(effort?['-c',`model_reasoning_effort=${effort}`]:[])];
      const args=session?.session_id?[...prefix,'--sandbox','read-only','resume',...flags,session.session_id,'-']:[...prefix,...flags.slice(0,-2),'--sandbox','read-only',...flags.slice(-2),'-'];
      // A large evidence-bearing turn is not a fast decision even at low
      // effort. Extend only its deadline, never the selected model/effort or
      // tool permissions. All deadlines remain bounded; small workers retain
      // the fast path and verifier budgets remain authoritative.
      const timeout=purpose==='verify'?modelCallBudget(purpose).timeout_ms:
        purpose==='design'||role==='planner'?180_000:
        Buffer.byteLength(text,'utf8')>=32_768?180_000:
        effort&&['high','xhigh','max','ultra'].includes(effort)?180_000:60_000;
      const result=await runner.run({executable,args,stdin:text,cwd:root,timeout_ms:timeout});
      if(result.code!==0)cliFailure(result,session);return {value:codexDomainOutput(codexOutput(result.stdout),schema),model:selected??'client_default',...(session?{session_id:nativeSessionId('codex',result.stdout)}:{})};
    }
    if(id==='claude'){
      const selected=environment.AGENT_DRIVER_CLAUDE_MODEL,transportSchema=structuredClone(schema);delete transportSchema.$schema;
      const expectedSession=session?(session.session_id??randomUUID()):null;
      const result=await runner.run({executable,args:['-p',...(selected?['--model',selected]:[]),'--output-format','json','--json-schema',JSON.stringify(transportSchema),'--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--settings','{"disableAllHooks":true}','--disable-slash-commands','--no-chrome','--permission-mode','dontAsk',...(session?[session.session_id?'--resume':'--session-id',expectedSession!]:['--no-session-persistence'])],stdin:text,cwd:root,timeout_ms:purpose==='verify'?modelCallBudget(purpose).timeout_ms:120_000});
      if(result.code!==0)cliFailure(result,session);
      const sessionId=session?nativeSessionId('claude',result.stdout):null;requireCondition(!sessionId||sessionId===expectedSession,'CLIENT_STRUCTURED_OUTPUT_INVALID');
      return {value:claudeOutput(result.stdout),model:selected??'client_default',...(session?{session_id:sessionId}:{})};
    }
    if(id==='opencode'){
      await writeFile(join(root,'opencode.json'),JSON.stringify({permission:{'*':'deny'},share:'disabled'}),{mode:0o600});
      const model=environment.AGENT_DRIVER_OPENCODE_MODEL,args=['run','--format','json',...(model?['--model',model]:[]),text];
      const result=await runner.run({executable,args,cwd:root,timeout_ms:purpose==='verify'?modelCallBudget(purpose).timeout_ms:120_000});
      if(result.code!==0)throw Error(`CLIENT_${classifyClientFailure(result.stderr||result.stdout).toUpperCase()}`);return {value:opencodeOutput(result.stdout),model:model??'client_default'};
    }
    const result=await runner.run({executable,args:['-p','--output-format','json'],stdin:text,cwd:root,timeout_ms:purpose==='verify'?modelCallBudget(purpose).timeout_ms:60_000});
    if(result.code!==0)throw Error(`CLIENT_${classifyClientFailure(result.stderr||result.stdout).toUpperCase()}`);return {value:cursorOutput(result.stdout),model:'client_default'};
  }finally{if(!session)await rm(root,{recursive:true,force:true});}
}

export class McpSamplingStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];
  constructor(readonly client:McpSamplingClient){}
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    const started=performance.now(),input_sha256=hashJson({instructions,input,schema});let model='mcp-client',accepted=false,failureKind:ModelCall['failure_kind']='provider_unavailable';
    try{
      requireCondition(this.client.available(),'MCP_SAMPLING_UNAVAILABLE');
      const budget=modelCallBudget(purpose);
      const response=await this.client.createMessage({messages:[{role:'user',content:{type:'text',text:prompt(instructions,input,schema)}}],systemPrompt:'You are a bounded structured-decision provider. Return JSON only. You have no execution or approval authority.',includeContext:'none',maxTokens:budget.max_output_tokens,temperature:0},{timeout:budget.timeout_ms});
      requireCondition(response!==null&&typeof response==='object'&&typeof response.model==='string'&&/^[^\s\x00-\x1f]{1,200}$/u.test(response.model)&&!/^(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,})$/u.test(response.model),'MCP_SAMPLING_INVALID');
      model=response.model;const blocks=Array.isArray(response.content)?response.content:[response.content];
      requireCondition(blocks.length===1&&blocks[0]?.type==='text'&&typeof blocks[0].text==='string'&&response.stopReason!=='maxTokens','MCP_SAMPLING_INVALID');
      const value=parseStrictJson(blocks[0].text);accepted=true;return value;
    }catch(error){if(isInvalidClientOutput(error)){failureKind='invalid_output';throw Error('MCP_SAMPLING_INVALID');}if(error instanceof Error&&(error.message==='CLIENT_TIMEOUT'||['TimeoutError','AbortError'].includes(error.name))){failureKind='timeout';throw Error(purpose==='verify'?'STRUCTURED_MODEL_TIMEOUT':'MCP_SAMPLING_UNAVAILABLE');}throw Error('MCP_SAMPLING_UNAVAILABLE');}
    finally{this.calls.push({purpose,provider:'mcp_sampling',auth:'client_subscription',model,elapsed_ms:Math.round(performance.now()-started),input_sha256,status:accepted?'accepted':'failed',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved',...(accepted?{}:{failure_kind:failureKind})});}
  }
}

export interface SubscriptionAwareModelOptions {
  session?:DecisionSessionScope;
  environment?:NodeJS.ProcessEnv;runner?:SafeProcessRunner;sampling?:McpSamplingStructuredModel;fallbackModel?:StructuredModel;fallbackKind?:'api_key'|'configured';subscriptionOnly?:boolean;onHandoff?:(event:ClientRouteEvent)=>void;
}
export class SubscriptionAwareStructuredModel implements StructuredModel{
  readonly calls:ModelCall[]=[];private statuses=new Map<SubscriptionClientId,{value:SubscriptionClientStatus;observed_at:number;binding:string}>();
  constructor(readonly options:SubscriptionAwareModelOptions={}){}
  private async clientStatus(id:SubscriptionClientId,environment=this.options.environment??process.env){
    const runner=this.options.runner??nativeProcessRunner,binding=clientBinding(id,environment,runner),cached=this.statuses.get(id);
    if(cached&&cached.binding===binding&&Date.now()-cached.observed_at<30_000)return {...cached.value};
    const status=await probeSubscriptionClient(id,environment,runner);
    // Never cache failed probes. Login completion, an executable change or a
    // failed invocation invalidates even a positive observation across models.
    if(status.status==='ready'&&binding===clientBinding(id,environment,runner))this.statuses.set(id,{value:status,observed_at:Date.now(),binding});
    else this.statuses.delete(id);
    return status;
  }
  async status(){
    const clients=await Promise.all((Object.keys(probeSpec) as SubscriptionClientId[]).map(id=>this.clientStatus(id)));
    return {mcp_sampling:this.options.sampling?.client.available()?'ready':'unavailable',clients,capabilities:clients.map(client=>decisionClientCapabilities(client.id)),fallback:this.options.fallbackModel&&(this.options.environment??process.env).AGENT_DRIVER_LLM_CLIENT==='api'?(this.options.fallbackKind??'configured'):'not_configured',credentials_exposed:false};
  }
  async call(purpose:ModelCall['purpose'],instructions:string,input:unknown,schema:Record<string,unknown>){
    // A successor must receive the same task and constraints, not a caller's
    // mutated object after an awaited connection/model operation.
    input=structuredClone(input);schema=structuredClone(schema);
    const environment={...this.options.environment??process.env},runner=this.options.runner??nativeProcessRunner,preferred=[...new Set(environment.AGENT_DRIVER_LLM_CLIENT?.split(',').map(item=>item.trim()).filter(Boolean)??['mcp','codex','claude','opencode','cursor'])];
    // Legacy callers can select API explicitly, but no client chain may fall into it.
    const apiOnly=preferred.length===1&&preferred[0]==='api';
    type FailedClient={client:HandoffClient;model:string;reason:HandoffReason};
    let failed:FailedClient|null=null;
    let invokedFailure:FailedClient|null=null,otherInvokedFailure:FailedClient|null=null,invokedTimeout=false,invokedNonTimeout=false;
    const representative=()=>invokedFailure??failed;
    const transferred=(target:HandoffClient,targetModel:string)=>{const source=representative();if(source)recordClientRoute(this.options.onHandoff,{...handoffContext(input),source:source.client,target,source_model:source.model,target_model:targetModel,reason:source.reason,effect_state:'none',status:'transferred',input_sha256:hashJson({instructions,input,schema})});};
    for(const id of preferred){
        if(id==='mcp'&&this.options.sampling){
          // Keep per-turn evidence separate while concurrent sampling is in flight.
          const sampling=new McpSamplingStructuredModel(this.options.sampling.client);let value:unknown;
          try{requireCondition(supportsStructuredJudgment('mcp',sampling.client.available()),'MCP_SAMPLING_UNAVAILABLE');value=await sampling.call(purpose,instructions,input,schema);}
          catch(error){if(isNonRetryableClientFailure(error))throw error;const timeout=error instanceof Error&&error.message==='STRUCTURED_MODEL_TIMEOUT';invokedTimeout ||=timeout;invokedNonTimeout ||=!timeout;failed??={client:'mcp',model:'client_default',reason:classifyClientFailure(error)};continue;}
          finally{this.calls.push(...sampling.calls);this.options.sampling.calls.push(...sampling.calls);}
          transferred('mcp',sampling.calls.at(-1)!.model);return value;
        }
        if(['codex','claude','opencode','cursor'].includes(id)){
          const client=id as Exclude<SubscriptionClientId,'hermes'>,binding=clientBinding(client,environment,runner),state=await this.clientStatus(client,environment);
          if(state?.status!=='ready'||!state.structured_bridge||!supportsStructuredJudgment(client)){failed??={client,model:environment[`AGENT_DRIVER_${client.toUpperCase()}_MODEL`]??'client_default',reason:state?.status==='expired'||state?.status==='signed_out'?'auth_expired':'provider_unavailable'};continue;}
          // Unknown CLI credentials may be API-backed (e.g. OpenCode); never adopt
          // them as an automatic subscription successor. Explicit primary use is separate.
          if(state.auth==='unknown'&&(client!=='opencode'||failed||this.options.subscriptionOnly)){failed??={client,model:environment[`AGENT_DRIVER_${client.toUpperCase()}_MODEL`]??'client_default',reason:'provider_unavailable'};continue;}
          const started=performance.now(),input_sha256=hashJson({instructions,input,schema});let accepted=false,model=environment[`AGENT_DRIVER_${client.toUpperCase()}_MODEL`]??'client_default',value:unknown,failureKind:ModelCall['failure_kind']='invalid_output',continuity:Pick<ModelCall,'continuity'|'session_turn'>={continuity:'checkpoint_only'};
          try{
            requireCondition(binding===clientBinding(client,environment,runner),'CLIENT_CONNECTION_CHANGED');
            const scope=this.options.session;let result:Awaited<ReturnType<typeof invokeCli>>;
            if(scope&&['codex','claude'].includes(client)){
              const resumed=await withDecisionSession(scope,{provider:client,model,instructions,schema,connection:clientBinding(client,environment,runner,false),effort:client==='codex'?environment.AGENT_DRIVER_CODEX_REASONING_EFFORT??null:null},turn=>invokeCli(client,environment,runner,instructions,input,schema,purpose,turn,scope.role));
              result=resumed;continuity={continuity:resumed.continuity,session_turn:resumed.session_turn};
            }else result=await invokeCli(client,environment,runner,instructions,input,schema,purpose);
            model=result.model;value=result.value;accepted=true;
          }
          catch(error){const reason=classifyClientFailure(error);if(reason!=='schema_invalid'){this.statuses.delete(client);invalidateClient(client,runner);}const timeout=error instanceof Error&&error.message==='CLIENT_TIMEOUT';invokedTimeout ||=timeout;invokedNonTimeout ||=!timeout;failureKind=timeout?'timeout':reason==='schema_invalid'?'schema_invalid':reason==='invalid_output'?'invalid_output':reason==='auth_expired'?'auth_error':reason==='quota_exhausted'?'quota_exhausted':reason==='rate_limited'?'rate_limited':reason==='model_unsupported'?'model_unsupported':reason==='provider_unavailable'?'provider_unavailable':'incomplete';if(isNonRetryableClientFailure(error))throw error;failed??={client,model,reason};invokedFailure??={client,model,reason};if(reason!=='model_unsupported')otherInvokedFailure??={client,model,reason};continue;}
          finally{this.calls.push({purpose,provider:client,auth:state.auth==='subscription'?'subscription':'unknown',model,elapsed_ms:Math.round(performance.now()-started),input_sha256,status:accepted?'accepted':'failed',input_tokens:'unobserved',output_tokens:'unobserved',total_tokens:'unobserved',...(accepted?continuity:{failure_kind:failureKind})});}
          transferred(client,model);return value;
        }
        if(id==='api'&&apiOnly&&this.options.fallbackModel){const value=await this.options.fallbackModel.call(purpose,instructions,input,schema);const last=this.options.fallbackModel.calls.at(-1)!;this.calls.push(last);return value;}
    }
    // A mixed failure cannot be presented as solely an unsupported model.
    const source=otherInvokedFailure??representative();
    if(source)recordClientRoute(this.options.onHandoff,{...handoffContext(input),source:source.client,target:null,source_model:source.model,target_model:null,reason:source.reason,effect_state:'none',status:'no_candidate',input_sha256:hashJson({instructions,input,schema})});
    throw Error(invokedTimeout&&!invokedNonTimeout?'STRUCTURED_MODEL_TIMEOUT':invokedFailure?.reason==='model_unsupported'&&!otherInvokedFailure?'STRUCTURED_MODEL_UNSUPPORTED':'STRUCTURED_MODEL_UNAVAILABLE');
  }
}

export function subscriptionAwareModelFromHostEnvironment(options:Omit<SubscriptionAwareModelOptions,'environment'>={},environment:NodeJS.ProcessEnv=process.env){
  return new SubscriptionAwareStructuredModel({...options,environment});
}
