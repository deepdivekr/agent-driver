import {randomUUID} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {chmod,mkdir,rename,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,resolve,sep} from 'node:path';
import {parse,parseDocument} from 'yaml';
import {requireCondition} from '../core/contracts.js';
import {type PackApprovalDispatcher} from '../packs/runtime.js';
import {type PackStore} from '../packs/store.js';
import {type PreparedApproval} from '../taskpack/protocol.js';

export const HERMES_AGENT_DRIVER_TOOLS=Object.freeze([
  'runtime_health','runtime_capabilities_list','runtime_capability_describe',
  'runtime_pack_catalog','runtime_pack_plan','runtime_pack_run','runtime_pack_status',
  'runtime_pack_execute_approved','runtime_pack_watch_tick','runtime_pack_watch_pause','runtime_pack_events',
  'runtime_channel_route','runtime_task_status','runtime_task_cancel','runtime_artifacts_list',
  'runtime_terminal_start','runtime_terminal_status','runtime_terminal_sessions_list','runtime_terminal_history',
  'runtime_terminal_output_read','runtime_terminal_handoff','runtime_terminal_verify','runtime_terminal_reconcile_files',
  'runtime_terminal_submit_prompt','runtime_terminal_resume','runtime_terminal_interrupt',
] as const);

interface HermesMcpEntry {command:string;args:string[];enabled:true;tools:{include:string[]};sampling:{enabled:false};elicitation:{enabled:true;timeout:number};}
export interface HermesIntegrationOptions {home?:string;command?:string;args?:string[];}

function safeHome(value:string){requireCondition(isAbsolute(value),'HERMES_HOME_ABSOLUTE_REQUIRED');const path=resolve(value);requireCondition(path!==sep,'HERMES_HOME_UNSAFE');return path;}
export function hermesHome(environment:NodeJS.ProcessEnv=process.env){return safeHome(environment.HERMES_HOME??join(homedir(),'.hermes'));}
export function hermesAgentDriverEntry(command:string,args:readonly string[]):HermesMcpEntry{
  requireCondition(isAbsolute(command),'AGENT_DRIVER_COMMAND_ABSOLUTE_REQUIRED');
  requireCondition(args.length>=1&&args.length<=8&&args.every(value=>typeof value==='string'&&value.length>0&&!/[\r\n\0]/u.test(value)),'AGENT_DRIVER_ARGS_INVALID');
  return {command:resolve(command),args:[...args],enabled:true,tools:{include:[...HERMES_AGENT_DRIVER_TOOLS]},sampling:{enabled:false},elicitation:{enabled:true,timeout:600}};
}
async function writePrivate(path:string,content:string){
  await mkdir(dirname(path),{recursive:true,mode:0o700});const temp=join(dirname(path),`.${randomUUID()}.partial`);
  await writeFile(temp,content,{mode:0o600});await chmod(temp,0o600);await rename(temp,path);await chmod(path,0o600);
}
/** Preserves all unrelated Hermes settings and never reads or writes .env. */
export async function configureHermes(options:HermesIntegrationOptions={}){
  const home=safeHome(options.home??hermesHome()),configPath=join(home,'config.yaml');
  const command=options.command??process.execPath,args=options.args??[resolve(process.argv[1]??''),'mcp'];
  const source=existsSync(configPath)?readFileSync(configPath,'utf8'):'';
  const current=source?parse(source):null;
  requireCondition(current===null||typeof current==='object'&&!Array.isArray(current),'HERMES_CONFIG_INVALID');
  const document=parseDocument(source||'{}\n');requireCondition(document.errors.length===0,'HERMES_CONFIG_INVALID');
  document.setIn(['mcp_servers','agent-driver'],hermesAgentDriverEntry(command,args));
  await writePrivate(configPath,document.toString({lineWidth:0}));
  return {status:'configured',config_path:configPath,server:'agent-driver',command,args,tools:HERMES_AGENT_DRIVER_TOOLS.length,sampling:false,elicitation:true,telegram_secret_touched:false,restart_required:true};
}

function envKeys(path:string){
  if(!existsSync(path))return new Set<string>();const keys=new Set<string>();
  for(const line of readFileSync(path,'utf8').split(/\r?\n/u)){const trimmed=line.trim();if(!trimmed||trimmed.startsWith('#')||!trimmed.includes('='))continue;keys.add(trimmed.slice(0,trimmed.indexOf('=')).trim());}
  return keys;
}
export function hermesDoctor(home=hermesHome()){
  const root=safeHome(home),configPath=join(root,'config.yaml'),secretPath=join(root,'.env'),keys=envKeys(secretPath);
  let entry:unknown=null;
  if(existsSync(configPath)){const doc=parse(readFileSync(configPath,'utf8')) as {mcp_servers?:Record<string,unknown>}|null;entry=doc?.mcp_servers?.['agent-driver']??null;}
  const valid=entry!==null&&typeof entry==='object'&&!Array.isArray(entry);
  const typed=valid?entry as Partial<HermesMcpEntry>:{};
  const configured=valid&&typed.enabled===true&&typed.sampling?.enabled===false&&typed.elicitation?.enabled===true&&HERMES_AGENT_DRIVER_TOOLS.every(tool=>typed.tools?.include?.includes(tool));
  return {hermes_home:root,agent_driver_mcp:configured?'ready':valid?'misconfigured':'not_configured',telegram:{token:keys.has('TELEGRAM_BOT_TOKEN')?'configured':'missing',allowed_users:keys.has('TELEGRAM_ALLOWED_USERS')?'configured':'missing',allow_all:keys.has('TELEGRAM_ALLOW_ALL_USERS')||keys.has('GATEWAY_ALLOW_ALL_USERS')?'unsafe':'disabled'},secrets_returned:false,restart_required:configured};
}

interface BooleanField {type:'boolean';title?:string;description?:string;default?:boolean;}
export interface McpElicitor {elicitInput(params:{mode:'form';message:string;requestedSchema:{type:'object';properties:Record<string,BooleanField>;required:string[]}},options?:{timeout?:number}):Promise<{action:'accept'|'decline'|'cancel';content?:Record<string,unknown>|undefined}>;}

/** Human click through the MCP client is trusted input; model text never calls acceptProposalApproval. */
export class HermesElicitationApprovalDispatcher implements PackApprovalDispatcher {
  constructor(readonly store:PackStore,readonly client:McpElicitor){}
  async deliver(delivery:PreparedApproval):Promise<{opened:boolean}>{
    const proposal=this.store.proposal(delivery.task_id);
    if(Date.now()>=delivery.expires_at_ms||proposal.snapshot_hash!==delivery.proposal_hash)return {opened:false};
    const summary=JSON.stringify(proposal.snapshot);const result=await this.client.elicitInput({mode:'form',message:`외부 변경 1회를 승인할까요?\n작업: ${delivery.task_id}\nSnapshot: ${delivery.proposal_hash}\n내용: ${summary.slice(0,3_000)}`,requestedSchema:{type:'object',properties:{approved:{type:'boolean',title:'검토한 내용 실행 승인',description:'현재 snapshot과 정확히 같은 외부 변경을 한 번만 실행합니다.'}},required:['approved']}},{timeout:Math.max(1,delivery.expires_at_ms-Date.now())});
    if(result.action==='accept'&&result.content?.approved===true){
      this.store.acceptProposalApproval(delivery.task_id,delivery.approval_token,'hermes-mcp-elicitation',{format:'reviewed_snapshot_hash',proposal_hash:delivery.proposal_hash,elicitation:true});return {opened:true};
    }
    if(result.action==='decline'){this.store.invalidateProposal(delivery.task_id,'human_declined');this.store.cancel(delivery.task_id);}
    return {opened:result.action!=='cancel'};
  }
}
