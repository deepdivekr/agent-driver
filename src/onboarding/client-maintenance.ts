import {randomUUID} from 'node:crypto';
import {existsSync,lstatSync,readFileSync,realpathSync,readdirSync,statSync} from 'node:fs';
import {chmod,open,readFile,rename,unlink,mkdir} from 'node:fs/promises';
import {hostname} from 'node:os';
import {basename,dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {CLIENT_BOOTSTRAP_CATALOG} from './client-bootstrap.js';
import {nativeProcessRunner,resolveSubscriptionClientExecutable,type SafeProcessRunner,type SubscriptionClientId} from '../integrations/subscription-auth.js';

const DAY_MS=24*60*60_000,FAILURE_COOLDOWN_MS=6*60*60_000,BUSY_RECHECK_MS=15*60_000;
const CLIENT_TIMEOUT_MS=10*60_000;
type MaintenanceState='disabled'|'due'|'idle'|'running'|'deferred_busy'|'cooldown';
type UpdateMethod='npm'|'native'|'cursor'|'opencode';
type SafeReason='eligible'|'not_installed'|'unmanaged_install'|'unsupported_platform'|'unsupported_update_method'|'busy'|'locked'|'disabled'|'not_due'|'fixture_environment'|'update_failed'|'updated'|'deferred_busy'|'cooldown';
interface StoredClient {last_attempt_at?:string;last_success_at?:string;last_failure_at?:string;reason?:SafeReason;}
interface StoredState {version:1;revision:number;enabled:boolean;next_due_at:string|null;last_state:MaintenanceState;clients:Partial<Record<SubscriptionClientId,StoredClient>>;}
export interface ClientMaintenanceView {
  enabled:boolean;preference_saved:boolean;revision:number;interval_hours:24;next_due_at:string|null;state:MaintenanceState;
  clients:Array<{id:SubscriptionClientId;label:string;installed:boolean;managed_update:boolean;reason:SafeReason;eligibility_reason:SafeReason;last_attempt_at?:string;last_success_at?:string}>;
}
export interface ClientMaintenanceReport {state:MaintenanceState;attempted_ids:SubscriptionClientId[];updated_ids:SubscriptionClientId[];skipped:Array<{id:SubscriptionClientId;reason:SafeReason}>;next_due_at:string|null;}
export interface ClientMaintenanceOptions {
  statePath:string;env?:NodeJS.ProcessEnv;environment?:NodeJS.ProcessEnv;runner?:SafeProcessRunner;resolver?:typeof resolveSubscriptionClientExecutable;
  platform?:NodeJS.Platform;now?:()=>number;isBusy?:()=>boolean|Promise<boolean>;externalClientActive?:()=>boolean;fixture?:boolean;
  onEvent?:(event:{id:SubscriptionClientId;stage:'started'|'succeeded'|'failed'|'skipped';reason?:SafeReason})=>void|Promise<void>;
}
const defaultState=():StoredState=>({version:1,revision:0,enabled:true,next_due_at:null,last_state:'due',clients:{}});
const within=(path:string,root:string)=>{const rel=relative(root,path);return rel===''||rel!==''&&!rel.startsWith('..')&&!isAbsolute(rel);};
function safeIso(value:unknown){return typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value)&&Number.isFinite(Date.parse(value))?value:undefined;}
function parseState(value:unknown):StoredState{
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('CLIENT_MAINTENANCE_STATE_INVALID');
  const item=value as Record<string,unknown>;
  if(item.version!==1||!Number.isSafeInteger(item.revision)||Number(item.revision)<0||typeof item.enabled!=='boolean'||!(item.next_due_at===null||safeIso(item.next_due_at)))throw Error('CLIENT_MAINTENANCE_STATE_INVALID');
  if(!item.clients||typeof item.clients!=='object'||Array.isArray(item.clients))throw Error('CLIENT_MAINTENANCE_STATE_INVALID');
  const clients:StoredState['clients']={};
  for(const spec of CLIENT_BOOTSTRAP_CATALOG){
    const raw=(item.clients as Record<string,unknown>)[spec.id];
    if(raw===undefined)continue;
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('CLIENT_MAINTENANCE_STATE_INVALID');
    const info=raw as Record<string,unknown>;
    clients[spec.id]={...(safeIso(info.last_attempt_at)?{last_attempt_at:info.last_attempt_at as string}:{}),...(safeIso(info.last_success_at)?{last_success_at:info.last_success_at as string}:{}),...(safeIso(info.last_failure_at)?{last_failure_at:info.last_failure_at as string}:{}),...(typeof info.reason==='string'&&safeReasons.has(info.reason as SafeReason)?{reason:info.reason as SafeReason}:{})};
  }
  const allowedStates=new Set<MaintenanceState>(['disabled','due','idle','running','deferred_busy','cooldown']);
  return {version:1,revision:Number(item.revision),enabled:item.enabled,next_due_at:item.next_due_at as string|null,last_state:allowedStates.has(item.last_state as MaintenanceState)?item.last_state as MaintenanceState:'idle',clients};
}
const safeReasons=new Set<SafeReason>(['eligible','not_installed','unmanaged_install','unsupported_platform','unsupported_update_method','busy','locked','disabled','not_due','fixture_environment','update_failed','updated','deferred_busy','cooldown']);
const clientProcessNames=new Set(['codex','claude','opencode','cursor-agent','agent','hermes']);
export function isClientCliProcess(comm:string,argv:string[]){
  const first=argv[0]?basename(argv[0]).toLowerCase():'',second=argv[1]?basename(argv[1]).toLowerCase():'';
  const processName=comm.trim().toLowerCase();
  if(clientProcessNames.has(processName)||clientProcessNames.has(first))return true;
  const interpreter=/^(?:node|python(?:3(?:\.\d+)?)?|bash|sh)$/u.test(first);
  if(!interpreter)return false;
  return [...clientProcessNames].some(name=>second===name||second.startsWith(name+'.'))||
    /^python(?:3(?:\.\d+)?)?$/u.test(first)&&argv[1]==='-m'&&['hermes_cli','opencode'].includes(argv[2]??'');
}
function activeCliOnLinux(){
  if(process.platform!=='linux')return true;
  let processes:string[];
  try{processes=readdirSync('/proc').filter(value=>/^\d+$/u.test(value));}catch{return true;}
  for(const pid of processes){
    if(Number(pid)===process.pid)continue;
    let argv:string[],comm:string;
    try{argv=readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);comm=readFileSync(`/proc/${pid}/comm`,'utf8');}catch{continue;}
    if(!argv.length)continue;
    if(isClientCliProcess(comm,argv))return true;
  }
  return false;
}
function ownedExecutable(id:SubscriptionClientId,path:string,home:string,platform:NodeJS.Platform):{method:UpdateMethod;executable:string;args:string[]}|null{
  if(platform!=='linux'||!isAbsolute(path))return null;
  let actual:string,stat:ReturnType<typeof statSync>,launcher:ReturnType<typeof lstatSync>;
  try{actual=realpathSync(path);stat=statSync(actual);launcher=lstatSync(path);}catch{return null;}
  if(!stat.isFile()||!within(actual,home)||!within(path,home)||process.getuid?.()!==stat.uid||process.getuid?.()!==launcher.uid)return null;
  const nvmRoot=join(home,'.nvm','versions','node'),npmRoot=join(home,'.npm-global');
  if(id==='codex'){
    const marker='/lib/node_modules/@openai/codex/';
    const index=actual.indexOf(marker);
    if(index<0)return null;
    const prefix=actual.slice(0,index),bin=join(prefix,'bin');
    if(!within(prefix,nvmRoot)&&prefix!==npmRoot)return null;
    if(path!==join(bin,'codex'))return null;
    const npm=join(bin,'npm');
    try{if(!statSync(npm).isFile()&&!statSync(npm).isSymbolicLink())return null;}catch{return null;}
    return {method:'npm',executable:npm,args:['install','-g','--prefix',prefix,'@openai/codex@latest']};
  }
  if(id==='claude'){
    const nativeBin=join(home,'.local','bin','claude'),nativeVersions=join(home,'.local','share','claude','versions');
    if(path===nativeBin&&within(actual,nativeVersions))return {method:'native',executable:path,args:['update']};
    const marker='/lib/node_modules/@anthropic-ai/claude-code/';
    const index=actual.indexOf(marker);
    if(index>=0){const prefix=actual.slice(0,index),npm=join(prefix,'bin','npm');if((within(prefix,nvmRoot)||prefix===npmRoot)&&path===join(prefix,'bin','claude'))try{if(statSync(npm).isFile())return {method:'npm',executable:npm,args:['install','-g','--prefix',prefix,'@anthropic-ai/claude-code@latest']};}catch{}}
    return null;
  }
  if(id==='cursor'){
    if((path===join(home,'.cursor','bin','agent')||path===join(home,'.cursor','bin','cursor-agent'))&&within(actual,join(home,'.cursor')))return {method:'cursor',executable:path,args:['update']};
    if((path===join(home,'.local','bin','agent')||path===join(home,'.local','bin','cursor-agent'))&&within(actual,join(home,'.local','share','cursor-agent','versions')))return {method:'cursor',executable:path,args:['update']};
    return null;
  }
  if(id==='opencode'){
    if(path===join(home,'.opencode','bin','opencode')&&within(actual,join(home,'.opencode')))return {method:'opencode',executable:path,args:['upgrade']};
    return null;
  }
  return null;
}
function pidAlive(pid:number){try{process.kill(pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}}

/** User-scoped, conservative updater. Never reads client credentials or returns CLI output. */
export class ClientMaintenanceController {
  readonly statePath:string;readonly environment:NodeJS.ProcessEnv;readonly runner:SafeProcessRunner;readonly resolver:typeof resolveSubscriptionClientExecutable;
  readonly platform:NodeJS.Platform;readonly now:()=>number;readonly isBusy:()=>boolean|Promise<boolean>;readonly externalClientActive:()=>boolean;
  readonly onEvent:(event:{id:SubscriptionClientId;stage:'started'|'succeeded'|'failed'|'skipped';reason?:SafeReason})=>void|Promise<void>;
  readonly fixture:boolean;
  private pending:Promise<ClientMaintenanceReport>|null=null;
  private closed=false;
  constructor(options:ClientMaintenanceOptions){
    if(!isAbsolute(options.statePath)||basename(options.statePath)!=='cli-maintenance.json')throw Error('CLIENT_MAINTENANCE_STATE_PATH_INVALID');
    this.statePath=resolve(options.statePath);this.environment=options.env??options.environment??process.env;this.runner=options.runner??nativeProcessRunner;this.resolver=options.resolver??resolveSubscriptionClientExecutable;
    this.platform=options.platform??process.platform;this.now=options.now??Date.now;this.isBusy=options.isBusy??(()=>true);this.externalClientActive=options.externalClientActive??activeCliOnLinux;
    this.onEvent=options.onEvent??(()=>{});this.fixture=options.fixture??false;
  }
  private state(){
    try{return parseState(JSON.parse(readFileSync(this.statePath,'utf8')));}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return defaultState();throw error instanceof Error&&error.message==='CLIENT_MAINTENANCE_STATE_INVALID'?error:Error('CLIENT_MAINTENANCE_STATE_INVALID');}
  }
  private async write(state:StoredState){
    const directory=dirname(this.statePath);await mkdir(directory,{recursive:true,mode:0o700});
    const temporary=join(directory,`.cli-maintenance-${randomUUID()}.tmp`);
    try{const handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(state)+'\n','utf8');await handle.sync();}finally{await handle.close();}await chmod(temporary,0o600);await rename(temporary,this.statePath);await chmod(this.statePath,0o600);}finally{await unlink(temporary).catch(()=>{});}
  }
  private lockPath(){const home=this.environment.HOME??(this.platform==='win32'?this.environment.USERPROFILE:undefined);if(!home||!isAbsolute(home))throw Error('CLIENT_MAINTENANCE_HOME_UNAVAILABLE');return join(home,'.cache','agent-office','cli-maintenance.lock');}
  private async lock(){
    const path=this.lockPath();await mkdir(dirname(path),{recursive:true,mode:0o700});
    const token=randomUUID(),body=JSON.stringify({pid:process.pid,host:hostname(),token,created_at:this.now()});
    const take=async()=>{const handle=await open(path,'wx',0o600);try{await handle.writeFile(body);await handle.sync();}finally{await handle.close();}return async()=>{try{const current=JSON.parse(await readFile(path,'utf8')) as {token?:string};if(current.token===token)await unlink(path);}catch{}};};
    try{return await take();}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    // Serialize stale-owner reclamation. Reaping a stale lock without an auxiliary
    // exclusive lock has an ABA race: another process can replace it before unlink.
    const reapPath=path+'.reap';let reap:Awaited<ReturnType<typeof open>>;
    try{reap=await open(reapPath,'wx',0o600);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return null;throw error;}
    try{
      await reap.writeFile(JSON.stringify({pid:process.pid,host:hostname(),token,created_at:this.now()}));await reap.sync();
      let prior:{pid?:unknown;host?:unknown;token?:unknown};
      try{prior=JSON.parse(await readFile(path,'utf8')) as typeof prior;}catch{return null;}
      if(prior.host!==hostname()||!Number.isSafeInteger(prior.pid)||Number(prior.pid)<=0||pidAlive(Number(prior.pid)))return null;
      // No other reaper may unlink this exact owner while .reap is held.
      const again=JSON.parse(await readFile(path,'utf8')) as typeof prior;
      if(again.token!==prior.token||again.pid!==prior.pid||again.host!==prior.host)return null;
      await unlink(path);
      try{return await take();}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')return null;throw error;}
    }finally{await reap.close();try{const owner=JSON.parse(await readFile(reapPath,'utf8')) as {token?:string};if(owner.token===token)await unlink(reapPath);}catch{}}
  }
  private eligibility(id:SubscriptionClientId):{installed:boolean;plan:ReturnType<typeof ownedExecutable>;reason:SafeReason}{
    let executable:string;
    try{executable=this.resolver(id,this.environment);}catch{return {installed:false,plan:null,reason:'not_installed'};}
    if(!isAbsolute(executable)||!existsSync(executable))return {installed:false,plan:null,reason:'not_installed'};
    if(this.platform!=='linux')return {installed:true,plan:null,reason:'unsupported_platform'};
    const home=this.environment.HOME;
    if(!home||!isAbsolute(home))return {installed:true,plan:null,reason:'unmanaged_install'};
    const plan=ownedExecutable(id,executable,resolve(home),this.platform);
    return {installed:true,plan,reason:plan?'eligible':id==='hermes'?'unsupported_update_method':'unmanaged_install'};
  }
  private async emit(event:{id:SubscriptionClientId;stage:'started'|'succeeded'|'failed'|'skipped';reason?:SafeReason}){
    // Observability must never determine whether a CLI update succeeds.
    await Promise.resolve().then(()=>this.onEvent(event)).catch(()=>{});
  }
  view():ClientMaintenanceView{
    const state=this.state();const now=this.now();
    const current:MaintenanceState=!state.enabled?'disabled':this.pending?'running':state.next_due_at===null||Date.parse(state.next_due_at)<=now?'due':state.last_state==='deferred_busy'?'deferred_busy':state.last_state==='cooldown'?'cooldown':'idle';
    return {enabled:state.enabled,preference_saved:existsSync(this.statePath),revision:state.revision,interval_hours:24,next_due_at:state.next_due_at,state:current,clients:CLIENT_BOOTSTRAP_CATALOG.map(spec=>{const item=this.eligibility(spec.id),history=state.clients[spec.id];return {id:spec.id,label:spec.label,installed:item.installed,managed_update:!!item.plan,eligibility_reason:item.reason,reason:item.plan&&history?.reason?history.reason:item.reason,...(history?.last_attempt_at?{last_attempt_at:history.last_attempt_at}:{}),...(history?.last_success_at?{last_success_at:history.last_success_at}:{})};})};
  }
  async save(input:{revision:number;enabled:boolean}):Promise<ClientMaintenanceView>{
    if(!Number.isSafeInteger(input.revision)||typeof input.enabled!=='boolean')throw Error('CLIENT_MAINTENANCE_SETTINGS_INVALID');
    const release=await this.lock();if(!release)throw Error('CLIENT_MAINTENANCE_LOCKED');
    try{const state=this.state();if(state.revision!==input.revision)throw Error('CLIENT_MAINTENANCE_REVISION_CONFLICT');const wasEnabled=state.enabled;state.revision++;state.enabled=input.enabled;if(!input.enabled)state.last_state='disabled';else if(!wasEnabled){state.last_state='due';state.next_due_at=null;}await this.write(state);return this.view();}finally{await release();}
  }
  runDue(_trigger:'startup'|'tick'='tick'){return this.run(false);}
  runNow(){return this.run(true);}
  get running(){return this.pending!==null;}
  async close(){this.closed=true;await this.pending?.catch(()=>{});}
  private run(forced:boolean){
    if(this.pending)return this.pending;
    if(this.closed)return Promise.resolve({state:'deferred_busy' as const,attempted_ids:[],updated_ids:[],skipped:CLIENT_BOOTSTRAP_CATALOG.map(spec=>({id:spec.id,reason:'busy' as const})),next_due_at:this.state().next_due_at});
    const pending=this.perform(forced).finally(()=>{if(this.pending===pending)this.pending=null;});this.pending=pending;return pending;
  }
  private async perform(forced:boolean):Promise<ClientMaintenanceReport>{
    const skipped:ClientMaintenanceReport['skipped']=[],attempted_ids:SubscriptionClientId[]=[],updated_ids:SubscriptionClientId[]=[];
    const report=(state:MaintenanceState,next_due_at:string|null):ClientMaintenanceReport=>({state,attempted_ids,updated_ids,skipped,next_due_at});
    const release=await this.lock();if(!release){for(const spec of CLIENT_BOOTSTRAP_CATALOG)skipped.push({id:spec.id,reason:'locked'});return report('deferred_busy',this.state().next_due_at);}
    try{
      const state=this.state(),now=this.now();
      if(!forced&&!state.enabled){for(const spec of CLIENT_BOOTSTRAP_CATALOG)skipped.push({id:spec.id,reason:'disabled'});return report('disabled',state.next_due_at);}
      if(!forced&&state.next_due_at!==null&&Date.parse(state.next_due_at)>now){for(const spec of CLIENT_BOOTSTRAP_CATALOG)skipped.push({id:spec.id,reason:'not_due'});return report('idle',state.next_due_at);}
      const fixture=this.fixture;
      if(fixture||await this.isBusy()||this.externalClientActive()){
        const reason:SafeReason=fixture?'fixture_environment':'busy';for(const spec of CLIENT_BOOTSTRAP_CATALOG)skipped.push({id:spec.id,reason});
        state.last_state='deferred_busy';state.next_due_at=new Date(now+BUSY_RECHECK_MS).toISOString();await this.write(state);return report('deferred_busy',state.next_due_at);
      }
      let failed=false;
      for(const spec of CLIENT_BOOTSTRAP_CATALOG){
        const item=this.eligibility(spec.id);
        if(!item.plan){skipped.push({id:spec.id,reason:item.reason});await this.emit({id:spec.id,stage:'skipped',reason:item.reason});continue;}
        const history=state.clients[spec.id]??{};
        if(!forced){
          const successAt=history.last_success_at?Date.parse(history.last_success_at):0, failureAt=history.last_failure_at?Date.parse(history.last_failure_at):0;
          if(successAt>=failureAt&&successAt+DAY_MS>this.now()){skipped.push({id:spec.id,reason:'not_due'});continue;}
          if(failureAt>successAt&&failureAt+FAILURE_COOLDOWN_MS>this.now()){skipped.push({id:spec.id,reason:'cooldown'});continue;}
        }
        if(this.closed){skipped.push({id:spec.id,reason:'busy'});state.last_state='deferred_busy';state.next_due_at=new Date(this.now()+BUSY_RECHECK_MS).toISOString();await this.write(state);return report('deferred_busy',state.next_due_at);}
        if(await this.isBusy()||this.externalClientActive()){
          skipped.push({id:spec.id,reason:'busy'});for(const later of CLIENT_BOOTSTRAP_CATALOG.slice(CLIENT_BOOTSTRAP_CATALOG.indexOf(spec)+1))skipped.push({id:later.id,reason:'busy'});
          state.last_state='deferred_busy';state.next_due_at=new Date(this.now()+BUSY_RECHECK_MS).toISOString();await this.write(state);return report('deferred_busy',state.next_due_at);
        }
        attempted_ids.push(spec.id);const attempt=new Date(this.now()).toISOString();
        await this.emit({id:spec.id,stage:'started'});
        history.last_attempt_at=attempt;
        try{
          const result=await this.runner.run({executable:item.plan.executable,args:item.plan.args,timeout_ms:CLIENT_TIMEOUT_MS,output_limit_bytes:16_384});
          if(result.code!==0)throw Error('CLIENT_MAINTENANCE_UPDATE_FAILED');
          if(!this.eligibility(spec.id).plan)throw Error('CLIENT_MAINTENANCE_VERIFY_FAILED');
          history.last_success_at=new Date(this.now()).toISOString();history.reason='updated';updated_ids.push(spec.id);
          await this.emit({id:spec.id,stage:'succeeded',reason:'updated'});
        }catch{history.last_failure_at=new Date(this.now()).toISOString();history.reason='update_failed';failed=true;skipped.push({id:spec.id,reason:'update_failed'});await this.emit({id:spec.id,stage:'failed',reason:'update_failed'});}
        state.clients[spec.id]=history;await this.write(state);
      }
      const dueTimes=CLIENT_BOOTSTRAP_CATALOG.flatMap(spec=>{if(!this.eligibility(spec.id).plan)return [];const history=state.clients[spec.id];if(!history)return [];const successAt=history.last_success_at?Date.parse(history.last_success_at):0,failureAt=history.last_failure_at?Date.parse(history.last_failure_at):0;return [successAt>=failureAt?successAt+DAY_MS:failureAt+FAILURE_COOLDOWN_MS];});
      state.last_state=failed?'cooldown':'idle';state.next_due_at=new Date(Math.max(this.now()+1000,dueTimes.length?Math.min(...dueTimes):this.now()+DAY_MS)).toISOString();await this.write(state);return report(state.last_state,state.next_due_at);
    }finally{await release();}
  }
}
