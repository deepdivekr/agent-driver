import {mkdtemp,rm,writeFile,chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {requireCondition} from '../core/contracts.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable,type SafeProcessRunner,type SubscriptionClientId} from '../integrations/subscription-auth.js';

export interface ClientBootstrapSpec {
  id:SubscriptionClientId;label:string;docs_url:string;installer_url:string;install_command:string;auth_guide_url:string;
}
export interface ClientBootstrapView extends ClientBootstrapSpec {
  installed:boolean;managed_install:boolean;reason:'installed'|'not_installed'|'managed_install_unavailable';credentials_exposed:false;
}
export type ClientInstallStage='downloading'|'downloaded'|'running'|'installer_exited'|'verifying';
export interface ClientInstallObservation {byte_count?:number;exit_code?:number|null;elapsed_ms?:number}

export const CLIENT_BOOTSTRAP_CATALOG:readonly ClientBootstrapSpec[]=[
  {id:'codex',label:'Codex',docs_url:'https://learn.chatgpt.com/docs/codex/cli',installer_url:'https://chatgpt.com/codex/install.sh',install_command:'curl -fsSL https://chatgpt.com/codex/install.sh | sh',auth_guide_url:'https://learn.chatgpt.com/docs/auth'},
  {id:'claude',label:'Claude Code',docs_url:'https://code.claude.com/docs/en/quickstart',installer_url:'https://claude.ai/install.sh',install_command:'curl -fsSL https://claude.ai/install.sh | bash',auth_guide_url:'https://code.claude.com/docs/en/quickstart'},
  {id:'opencode',label:'OpenCode',docs_url:'https://opencode.ai/docs/',installer_url:'https://opencode.ai/install',install_command:'curl -fsSL https://opencode.ai/install | bash',auth_guide_url:'https://opencode.ai/docs/providers/'},
  {id:'cursor',label:'Cursor CLI',docs_url:'https://cursor.com/docs/cli/installation',installer_url:'https://cursor.com/install',install_command:'curl https://cursor.com/install -fsS | bash',auth_guide_url:'https://cursor.com/docs/cli/overview'},
  {id:'hermes',label:'Hermes',docs_url:'https://github.com/NousResearch/hermes-agent',installer_url:'https://hermes-agent.nousresearch.com/install.sh',install_command:'curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash',auth_guide_url:'https://github.com/NousResearch/hermes-agent'},
] as const;

const catalog=(id:SubscriptionClientId)=>{const item=CLIENT_BOOTSTRAP_CATALOG.find(value=>value.id===id);requireCondition(item,'CLIENT_INSTALL_TARGET_INVALID');return item;};
const installed=(id:SubscriptionClientId,environment:NodeJS.ProcessEnv,resolver:typeof resolveSubscriptionClientExecutable)=>{try{resolver(id,environment);return true;}catch{return false;}};

/** Runs only an allowlisted official HTTPS installer after a local user click. The script and raw output are never returned to the browser. */
export class ClientBootstrapController {
  constructor(
    readonly environment:NodeJS.ProcessEnv=process.env,
    readonly runner:SafeProcessRunner=nativeProcessRunner,
    readonly fetcher:typeof fetch=fetch,
    readonly resolver:typeof resolveSubscriptionClientExecutable=resolveSubscriptionClientExecutable,
    readonly platform:NodeJS.Platform=process.platform,
  ){}
  view(){
    return {clients:CLIENT_BOOTSTRAP_CATALOG.map(spec=>{const present=installed(spec.id,this.environment,this.resolver),managed=this.platform==='linux';return {...spec,installed:present,managed_install:managed,reason:present?'installed':managed?'not_installed':'managed_install_unavailable',credentials_exposed:false} satisfies ClientBootstrapView;}),credentials_exposed:false};
  }
  async install(id:SubscriptionClientId,onStage:(stage:ClientInstallStage,observation?:ClientInstallObservation)=>void|Promise<void>=()=>{}){
    const spec=catalog(id);requireCondition(this.platform==='linux','CLIENT_INSTALL_PLATFORM_UNSUPPORTED');
    if(installed(id,this.environment,this.resolver))return this.view();
    await onStage('downloading');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30_000);
    let response:Response;
    try{response=await this.fetcher(spec.installer_url,{redirect:'error',signal:controller.signal,headers:{accept:'text/x-shellscript,text/plain;q=0.9'}});}finally{clearTimeout(timer);}
    requireCondition(response.ok&&!response.redirected&&(!response.url||response.url===spec.installer_url),'CLIENT_INSTALL_DOWNLOAD_REJECTED');
    const bytes=new Uint8Array(await response.arrayBuffer());requireCondition(bytes.length>0&&bytes.length<=2*1024*1024,'CLIENT_INSTALL_DOWNLOAD_REJECTED');
    const source=new TextDecoder('utf-8',{fatal:true}).decode(bytes);requireCondition(!source.includes('\0')&&/^#![^\r\n]*(?:sh|bash)\b/u.test(source.slice(0,256)),'CLIENT_INSTALL_SCRIPT_INVALID');
    await onStage('downloaded',{byte_count:bytes.length});
    const root=await mkdtemp(join(tmpdir(),'agent-driver-client-install-')),path=join(root,'installer.sh');
    try{
      await writeFile(path,source,{mode:0o700});await chmod(path,0o700);await onStage('running');
      const started=Date.now(),result=await this.runner.run({executable:'/bin/bash',args:[path],timeout_ms:10*60_000});
      await onStage('installer_exited',{exit_code:result.code,elapsed_ms:Date.now()-started});
      requireCondition(result.code===0,'CLIENT_INSTALL_FAILED');
      await onStage('verifying');requireCondition(installed(id,this.environment,this.resolver),'CLIENT_INSTALL_NOT_DETECTED');return this.view();
    }finally{await rm(root,{recursive:true,force:true});}
  }
}
