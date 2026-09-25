import {randomUUID} from 'node:crypto';
import {closeSync,constants,existsSync,fchmodSync,fstatSync,lstatSync,mkdirSync,openSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {z} from 'zod';
import {type HostConfig} from '../interface/config.js';
import {requireCondition} from '../core/contracts.js';
import {normalizeCompatibleBaseUrl,type ApiProvider} from '../integrations/model-provider.js';
import {hashJson} from '../taskpack/adaptive-spec.js';
import {FAST_MODEL_DEFAULTS} from '../integrations/fast-models.js';

const modelId=z.string().min(1).max(200).refine(value=>!/[\s\x00-\x1f]/u.test(value)&&!/^(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|apikey_[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})$/u.test(value));
const key=z.string().min(16).max(4096).refine(value=>!/[\s\x00-\x1f]/u.test(value));
const provider=z.enum(['openai','anthropic','openrouter','openai_compatible']);
const clientModels=z.object({codex:modelId.nullable().default(null),claude:modelId.nullable().default(null),opencode:modelId.nullable().default(null)}).strict();
const choice=z.object({mode:z.enum(['subscription','api']),client:z.enum(['auto','mcp','codex','claude','opencode']),client_models:clientModels.default({codex:null,claude:null,opencode:null}),api_to_subscription:z.boolean().default(false),api_provider:provider.default('openai'),api_model:modelId,api_base_url:z.string().max(2048).default(''),reasoning:z.enum(['low','medium','high']),jev:z.enum(['inherit','on','off'])}).strict();
const verification=z.object({fingerprint:z.string().length(64),provider:provider,model:modelId,verified_at:z.string().datetime()}).strict();
const savedSchema=z.object({format:z.literal(1),revision:z.number().int().positive(),selection:choice,onboarding_step:z.number().int().min(0).max(4),inherit_global:z.boolean().optional(),api_key:key.nullable().optional(),openai_key:key.nullable().optional(),jev_key:key.nullable().optional(),api_verification:verification.optional()}).strict();
export type ModelSettings=z.infer<typeof savedSchema>;
export type ApiVerification=z.infer<typeof verification>;
export const settingsUpdate=z.object({revision:z.number().int().nonnegative(),selection:choice,onboarding_step:z.number().int().min(0).max(4),inherit_global:z.boolean().optional(),api_action:z.enum(['keep','replace','remove']).default('keep'),api_key:key.optional(),openai_action:z.enum(['keep','replace','remove']).default('keep'),openai_key:key.optional(),jev_action:z.enum(['keep','replace','remove']).default('keep'),jev_key:key.optional()}).strict();
export const modelSettingsPath=(config:Pick<HostConfig,'dbPath'>)=>join(dirname(config.dbPath),'.connection','models.json');
export type ModelScope='global'|'coding';
export const scopedModelSettingsPath=(path:string,scope:ModelScope)=>scope==='coding'?join(dirname(path),'coding-models.json'):path;
/** Borrow a global key only for the exact same provider/endpoint. Never persist it twice. */
export function modelScopeBase(path:string,scope:ModelScope,selection:ModelSettings['selection']|undefined,base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  if(scope==='global')return base;
  const global=readModelSettings(path),globalEnv=effectiveModelEnvironment(global,base),source=publicModelSettings(global,base).selection;
  const target=selection??source,env={...base};
  const same=target.api_provider===source.api_provider&&(target.api_provider!=='openai_compatible'||normalizeCompatibleBaseUrl(target.api_base_url)===normalizeCompatibleBaseUrl(source.api_base_url));
  const keys=['AGENT_DRIVER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'];
  if(same){for(const name of keys){delete env[name];if(globalEnv[name]!==undefined)env[name]=globalEnv[name];}}
  else delete env.AGENT_DRIVER_API_KEY;
  delete env.TYPESAFE_API_KEY;if(globalEnv.TYPESAFE_API_KEY)env.TYPESAFE_API_KEY=globalEnv.TYPESAFE_API_KEY;
  return env;
}
/** Invocation snapshot. Existing attached coding dialogs keep their persisted CLI model. */
export function scopedModelConfiguration(path:string,scope:ModelScope='global',base:NodeJS.ProcessEnv=process.env){
  const own=scope==='coding'?readModelSettings(scopedModelSettingsPath(path,scope)):null;
  const overridden=Boolean(own&&!own.inherit_global),saved=overridden?own:readModelSettings(path);
  const environment=overridden?modelScopeBase(path,scope,saved!.selection,base):base;
  return {saved,base:environment,environment:effectiveModelEnvironment(saved,environment),source:overridden?'coding':'global'} as const;
}
function safeFile(path:string){
  const stat=lstatSync(path);requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1,'MODEL_SETTINGS_UNSAFE_FILE');
}
export function readModelSettings(path:string):ModelSettings|null{
  try{safeFile(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  requireCondition(!lstatSync(dirname(path)).isSymbolicLink(),'MODEL_SETTINGS_UNSAFE_DIRECTORY');
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0));
  try{requireCondition(fstatSync(fd).size<=20_000,'MODEL_SETTINGS_TOO_LARGE');return savedSchema.parse(JSON.parse(readFileSync(fd,'utf8')));}catch{throw Error('MODEL_SETTINGS_INVALID');}finally{closeSync(fd);}
}
export function effectiveModelEnvironment(saved:ModelSettings|null,base:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv{
  const env={...base};if(!saved)return env;
  const stored=saved.api_key!==undefined?saved.api_key:saved.openai_key;
  if(stored!==undefined){for(const name of ['AGENT_DRIVER_API_KEY','OPENAI_API_KEY','ANTHROPIC_API_KEY','OPENROUTER_API_KEY'])delete env[name];if(stored!==null)env.AGENT_DRIVER_API_KEY=stored;}
  if(saved.jev_key!==undefined){delete env.TYPESAFE_API_KEY;if(saved.jev_key!==null)env.TYPESAFE_API_KEY=saved.jev_key;}
  if(saved.selection.jev==='off')delete env.TYPESAFE_API_KEY;
  const connected=['mcp','codex','claude','opencode'];
  env.AGENT_DRIVER_LLM_CLIENT=saved.selection.mode==='api'?'api':saved.selection.client==='auto'?connected.join(','):[saved.selection.client,...connected.filter(client=>client!==saved.selection.client)].join(',');
  for(const client of ['codex','claude','opencode'] as const){const name=`AGENT_DRIVER_${client.toUpperCase()}_MODEL`;if(saved.selection.client_models[client])env[name]=saved.selection.client_models[client]!;else delete env[name];}
  env.AGENT_DRIVER_API_PROVIDER=saved.selection.api_provider;env.AGENT_DRIVER_API_MODEL=saved.selection.api_model;env.AGENT_DRIVER_API_REASONING=saved.selection.reasoning;
  if(saved.selection.api_provider==='openai_compatible')env.AGENT_DRIVER_API_BASE_URL=normalizeCompatibleBaseUrl(saved.selection.api_base_url);else delete env.AGENT_DRIVER_API_BASE_URL;
  return env;
}
export function modelSettingsFingerprint(saved:ModelSettings,base:NodeJS.ProcessEnv=process.env){
  const env=effectiveModelEnvironment(saved,base);
  return hashJson({provider:env.AGENT_DRIVER_API_PROVIDER,model:env.AGENT_DRIVER_API_MODEL,reasoning:env.AGENT_DRIVER_API_REASONING,base_url:env.AGENT_DRIVER_API_BASE_URL??'',credential:env.AGENT_DRIVER_API_KEY??env.OPENAI_API_KEY??env.ANTHROPIC_API_KEY??env.OPENROUTER_API_KEY??''});
}
export function publicModelSettings(saved:ModelSettings|null,base:NodeJS.ProcessEnv=process.env){
  const env=effectiveModelEnvironment(saved,base);
  const defaultProvider=(base.AGENT_DRIVER_API_PROVIDER??'openai') as ApiProvider;
  const selectedProvider=saved?.selection.api_provider??defaultProvider;
  const present=Boolean(env.AGENT_DRIVER_API_KEY||(selectedProvider==='openai'?env.OPENAI_API_KEY:selectedProvider==='anthropic'?env.ANTHROPIC_API_KEY:selectedProvider==='openrouter'?env.OPENROUTER_API_KEY:undefined));
  const verified=Boolean(saved?.api_verification&&saved.api_verification.fingerprint===modelSettingsFingerprint(saved,base));
  return {revision:saved?.revision??0,configured:saved!==null,selection:saved?.selection??{mode:base.AGENT_DRIVER_LLM_CLIENT==='api'?'api':'subscription',client:'auto',client_models:{codex:null,claude:null,opencode:null},api_to_subscription:false,api_provider:defaultProvider,api_model:base.AGENT_DRIVER_API_MODEL??FAST_MODEL_DEFAULTS[defaultProvider],api_base_url:base.AGENT_DRIVER_API_BASE_URL??'',reasoning:base.AGENT_DRIVER_API_REASONING??'low',jev:'inherit'},onboarding_step:saved?.onboarding_step??0,
    api_key_present:present,api_key_stored:Boolean(saved?.api_key??saved?.openai_key),openai_key_present:present,openai_key_stored:Boolean(saved?.api_key??saved?.openai_key),jev_key_present:Boolean(env.TYPESAFE_API_KEY),jev_key_stored:Boolean(saved?.jev_key),
    api_connection:verified?'ready':'unchecked',api_verified_at:verified?saved!.api_verification!.verified_at:null,
    applies_to:'next_model_call',in_flight_calls:'unchanged',external_worker_models:'client_managed',credentials_exposed:false,storage:'local_private_file'};
}
function nextSettings(prior:ModelSettings|null,raw:unknown,base:NodeJS.ProcessEnv){
  const update=settingsUpdate.parse(raw);requireCondition(update.revision===(prior?.revision??0),'MODEL_SETTINGS_CONFLICT');
  if(update.selection.api_provider==='openai_compatible')update.selection.api_base_url=normalizeCompatibleBaseUrl(update.selection.api_base_url);else update.selection.api_base_url='';
  const next:ModelSettings={format:1,revision:update.revision+1,selection:update.selection,onboarding_step:update.onboarding_step,...(update.inherit_global!==undefined?{inherit_global:update.inherit_global}:prior?.inherit_global!==undefined?{inherit_global:prior.inherit_global}:{}),...(prior?.api_key!==undefined?{api_key:prior.api_key}:prior?.openai_key!==undefined?{api_key:prior.openai_key}:{}),...(prior?.jev_key!==undefined?{jev_key:prior.jev_key}:{})};
  const apiAction=update.api_action!=='keep'||update.api_key!==undefined?update.api_action:update.openai_action,apiValue=update.api_key??update.openai_key;
  requireCondition(apiAction==='replace'?apiValue!==undefined:apiValue===undefined,'MODEL_KEY_ACTION_INVALID');if(apiAction==='replace')next.api_key=apiValue!;else if(apiAction==='remove')next.api_key=null;
  const jevAction=update.jev_action,jevValue=update.jev_key;requireCondition(jevAction==='replace'?jevValue!==undefined:jevValue===undefined,'MODEL_KEY_ACTION_INVALID');if(jevAction==='replace')next.jev_key=jevValue!;else if(jevAction==='remove')next.jev_key=null;
  const env=effectiveModelEnvironment(next,base);
  requireCondition(next.inherit_global||next.selection.mode!=='api'||Boolean(env.AGENT_DRIVER_API_KEY||env.OPENAI_API_KEY||env.ANTHROPIC_API_KEY||env.OPENROUTER_API_KEY),'MODEL_PROVIDER_CREDENTIAL_REQUIRED');
  requireCondition(next.inherit_global||next.selection.jev!=='on'||Boolean(env.TYPESAFE_API_KEY),'JEV_CREDENTIAL_REQUIRED');
  return next;
}
export function previewModelSettings(path:string,raw:unknown,base:NodeJS.ProcessEnv=process.env){return nextSettings(readModelSettings(path),raw,base);}
/** Atomic, revision-checked settings and secret transaction; only called by local human settings POSTs. */
export function saveModelSettings(path:string,raw:unknown,base:NodeJS.ProcessEnv=process.env,verified?:ApiVerification){
  const directory=dirname(path);mkdirSync(directory,{recursive:true,mode:0o700});
  requireCondition(lstatSync(directory).isDirectory()&&!lstatSync(directory).isSymbolicLink(),'MODEL_SETTINGS_UNSAFE_DIRECTORY');
  const lock=join(directory,'.settings.lock');let lockFd:number;
  try{lockFd=openSync(lock,'wx',0o600);}catch{throw Error('MODEL_SETTINGS_BUSY');}
  const temporary=join(directory,`.${randomUUID()}.tmp`);
  try{
    const prior=readModelSettings(path),next=nextSettings(prior,raw,base),fingerprint=modelSettingsFingerprint(next,base);
    if(verified?.fingerprint===fingerprint)next.api_verification=verification.parse(verified);
    else if(prior?.api_verification?.fingerprint===fingerprint)next.api_verification=prior.api_verification;
    const fd=openSync(temporary,'wx',0o600);try{fchmodSync(fd,0o600);writeFileSync(fd,JSON.stringify(savedSchema.parse(next))+'\n');}finally{closeSync(fd);}
    renameSync(temporary,path);return publicModelSettings(next,base);
  }finally{if(existsSync(temporary))unlinkSync(temporary);closeSync(lockFd);unlinkSync(lock);}
}
