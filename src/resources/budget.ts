import {execFile, spawn, type SpawnOptions} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, realpathSync, statSync, statfsSync, lstatSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {processIdentitySync} from '../supervisor/identity.js';

const exec = promisify(execFile);
export const resourceBudgetSchema = z.object({
  domain: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/),
  cpu_percent: z.number().int().min(1).max(200),
  memory_mb: z.number().int().min(64).max(8192),
  memory_high_mb: z.number().int().min(32).max(8192).optional(),
  tasks_max: z.number().int().min(16).max(2048),
}).strict().refine(b=>(b.memory_high_mb??Math.floor(b.memory_mb*0.8))<=b.memory_mb,'memory high exceeds maximum');
export type ResourceBudget = z.infer<typeof resourceBudgetSchema>;
export interface BudgetHandle {
  budget: ResourceBudget; unit: string; description: string; cgroup: string;
  device: number; inode: number;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function budgetIdentity(input: ResourceBudget) {
  const budget = resourceBudgetSchema.parse(input);
  requireCondition(process.platform === 'linux' && process.getuid, 'RESOURCE_PLATFORM_UNSUPPORTED');
  const uid = process.getuid();
  const unit = 'apdrt' + digest({uid, domain: budget.domain}).slice(0,32) + '.slice';
  return {budget, unit, description: 'agent-driver resource v1 ' + digest(budget),
    cgroup: `/user.slice/user-${uid}.slice/user@${uid}.service/${unit}`};
}
export function managerEnvironment() {
  requireCondition(process.platform === 'linux' && process.getuid, 'RESOURCE_PLATFORM_UNSUPPORTED');
  const uid = process.getuid(), runtime = `/run/user/${uid}`, bus = lstatSync(runtime + '/bus');
  requireCondition(bus.isSocket() && bus.uid === uid, 'RESOURCE_USER_BUS_UNAVAILABLE');
  return {PATH:'/usr/bin:/bin', LANG:'C.UTF-8', XDG_RUNTIME_DIR:runtime, DBUS_SESSION_BUS_ADDRESS:'unix:path=' + runtime + '/bus'};
}
async function command(executable: string, args: string[]) {
  try {return (await exec(executable,args,{env:managerEnvironment(),encoding:'utf8',timeout:5000,maxBuffer:65536,windowsHide:true})).stdout;}
  catch {throw Error('RESOURCE_MANAGER_UNAVAILABLE');}
}
export async function resourceUnit(unit: string) {
  requireCondition(/^apd(?:rt|exec)[a-f0-9]{32}\.(?:slice|service)$/.test(unit), 'RESOURCE_UNIT_NOT_OWNED');
  const output = await command('/usr/bin/systemctl',['--user','show',unit,'--property=LoadState,ActiveState,Transient,Description,ControlGroup,Slice,InvocationID,FragmentPath,SourcePath,DropInPaths,MainPID,KillMode,OOMPolicy,ExitType']);
  return Object.fromEntries(output.trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
}
const basePath = (handle: Pick<BudgetHandle,'cgroup'>) => '/sys/fs/cgroup' + handle.cgroup;
const value = (path: string) => readFileSync(path,'utf8').trim();
const number = (text: string) => {requireCondition(/^\d+$/.test(text) && Number.isSafeInteger(Number(text)), 'RESOURCE_COUNTER_INVALID');return Number(text);};
const counters = (path: string) => Object.fromEntries(value(path).split('\n').filter(Boolean).map(line=>{const [key,raw]=line.split(/\s+/);return [key!,number(raw!)];}));
export function readBudget(handle: BudgetHandle) {
  const path=basePath(handle),stat=statSync(path);
  requireCondition(realpathSync(path)===path && statfsSync(path).type===0x63677270 &&
    stat.dev===handle.device && stat.ino===handle.inode, 'RESOURCE_GROUP_IDENTITY_CHANGED');
  const expected=handle.budget;
  const limits={cpu_max:value(path+'/cpu.max'),memory_high:number(value(path+'/memory.high')),
    memory_max:number(value(path+'/memory.max')),swap_max:number(value(path+'/memory.swap.max')),
    tasks_max:number(value(path+'/pids.max')),cpu_weight:number(value(path+'/cpu.weight'))};
  requireCondition(limits.cpu_max===`${expected.cpu_percent*1000} 100000` &&
    limits.memory_max===expected.memory_mb*1048576 && limits.memory_high===(expected.memory_high_mb??Math.floor(expected.memory_mb*0.8))*1048576 &&
    limits.swap_max===0 && limits.tasks_max===expected.tasks_max && limits.cpu_weight===10,'RESOURCE_LIMIT_CHANGED_OR_UNENFORCED');
  let peak:number|'unobserved'='unobserved';try{peak=number(value(path+'/memory.peak'));}catch{}
  return {status:'enforced' as const,unit:handle.unit,cgroup:handle.cgroup,limits,
    observed_at:new Date().toISOString(),memory_current:number(value(path+'/memory.current')),memory_peak:peak,
    tasks_current:number(value(path+'/pids.current')),cpu:counters(path+'/cpu.stat'),
    memory_events:counters(path+'/memory.events'),pid_events:counters(path+'/pids.events'),events:counters(path+'/cgroup.events')};
}
export async function inspectBudget(input: ResourceBudget): Promise<BudgetHandle> {
  const identity=budgetIdentity(input),unit=await resourceUnit(identity.unit);
  requireCondition(unit.LoadState==='loaded' && unit.ActiveState==='active' && unit.Transient==='yes' &&
    unit.Description===identity.description && unit.ControlGroup===identity.cgroup, 'RESOURCE_GROUP_NOT_OWNED_OR_CHANGED');
  const path=basePath(identity),stat=statSync(path),handle={...identity,device:stat.dev,inode:stat.ino};
  readBudget(handle);return handle;
}
export async function ensureBudget(input: ResourceBudget): Promise<BudgetHandle> {
  const identity=budgetIdentity(input),existing=await resourceUnit(identity.unit);
  // systemd synthesizes an inactive .slice on lookup even when no definition exists.
  const implicit=existing.LoadState==='loaded'&&existing.ActiveState==='inactive'&&existing.Transient==='no'&&
    existing.ControlGroup===''&&existing.FragmentPath===''&&existing.SourcePath===''&&existing.DropInPaths===''&&
    existing.Description==='Slice /'+identity.unit.slice(0,-6);
  if(existing.LoadState!=='not-found'&&!implicit)return inspectBudget(input);
  const b=identity.budget;
  try {
    await command('/usr/bin/busctl',['--user','--timeout=5','call','org.freedesktop.systemd1','/org/freedesktop/systemd1',
      'org.freedesktop.systemd1.Manager','StartTransientUnit','ssa(sv)a(sa(sv))',identity.unit,'fail','8',
      'Description','s',identity.description,'CPUQuotaPerSecUSec','t',String(b.cpu_percent*10000),
      'CPUQuotaPeriodUSec','t','100000','CPUWeight','t','10','MemoryHigh','t',String((b.memory_high_mb??Math.floor(b.memory_mb*0.8))*1048576),
      'MemoryMax','t',String(b.memory_mb*1048576),'MemorySwapMax','t','0','TasksMax','t',String(b.tasks_max),'0']);
  } catch {
    // Another identical creator may have won. Never alter or adopt a mismatched unit.
    return inspectBudget(input);
  }
  return inspectBudget(input);
}
export function assertBudgetMembership(handle: BudgetHandle, pid=process.pid, scope?: string) {
  readBudget(handle);
  requireCondition(Number.isSafeInteger(pid)&&pid>0,'RESOURCE_PID_INVALID');
  const memberships=value(`/proc/${pid}/cgroup`).split('\n'),expected=scope?handle.cgroup+'/'+scope:handle.cgroup+'/';
  requireCondition(memberships.some(line=>line.startsWith('0::') &&
    (scope?(line.slice(3)===expected||line.slice(3).startsWith(expected+'/')):line.slice(3).startsWith(expected))),
    'RESOURCE_PROCESS_OUTSIDE_BOUNDARY');
}
export async function launchResourceUnit(input: ResourceBudget, executable: string, args: string[], options: SpawnOptions = {}, maxRuntimeMs?: number) {
  requireCondition(isAbsolute(executable)&&args.every(arg=>typeof arg==='string')&&!options.shell,'RESOURCE_COMMAND_INVALID');
  if(maxRuntimeMs!==undefined)requireCondition(Number.isSafeInteger(maxRuntimeMs)&&maxRuntimeMs>=100&&maxRuntimeMs<=600000,'RESOURCE_RUNTIME_INVALID');
  const handle=await ensureBudget(input),nonce=randomUUID().replaceAll('-',''),unit='apdexec'+nonce+'.service';
  const description='agent-driver execution v1 '+digest(handle.budget)+' '+nonce;
  const allowed=['PATH','HOME','USERPROFILE','SystemRoot','WINDIR','TEMP','TMP','TMPDIR','LANG','LC_ALL',
    'PLAYWRIGHT_BROWSERS_PATH','XDG_CACHE_HOME','DISABLE_AUTOUPDATER','ENABLE_TOOL_SEARCH'];
  const inputEnv=options.env??process.env,env=Object.fromEntries(allowed.flatMap(key=>inputEnv[key]===undefined?[]:[[key,inputEnv[key]]]));
  const owner=maxRuntimeMs===undefined?null:processIdentitySync(process.pid);
  requireCondition(owner===null||typeof owner!=='string','RESOURCE_OWNER_IDENTITY_UNAVAILABLE');
  const spec=Buffer.from(JSON.stringify({budget:handle.budget,unit,executable,args,env,owner})).toString('base64url');
  const parameters=['--user','--wait','--pipe','--service-type=exec','--quiet','--collect','--no-ask-password','--expand-environment=no',
    '--unit='+unit,'--slice='+handle.unit,'--description='+description,
    '--property=KillMode=control-group','--property=OOMPolicy=kill','--property=ExitType=main','--property=TimeoutStopSec=2s',
    ...(options.cwd===undefined?[]:['--working-directory='+String(options.cwd)]),
    ...(maxRuntimeMs===undefined?[]:['--property=RuntimeMaxSec='+Math.ceil(maxRuntimeMs/1000)]),
    '--',process.execPath,fileURLToPath(new URL('./scope-entry.js',import.meta.url)),spec];
  const child=spawn('/usr/bin/systemd-run',parameters,{...options,shell:false,windowsHide:true,
    env:managerEnvironment()});
  let invocation:string|null=null;
  async function observe() {
    const state=await resourceUnit(unit);
    if(state.LoadState==='not-found')return {status:'gone' as const};
    requireCondition(state.Transient==='yes'&&state.Description===description&&state.Slice===handle.unit&&
      state.ControlGroup===handle.cgroup+'/'+unit&&state.KillMode==='control-group'&&state.OOMPolicy==='kill'&&
      state.ExitType==='main','RESOURCE_SCOPE_NOT_OWNED');
    if(invocation!==null)requireCondition(state.InvocationID===invocation,'RESOURCE_SCOPE_IDENTITY_CHANGED');
    invocation=state.InvocationID??null;
    requireCondition(invocation&&/^[a-f0-9]{32}$/.test(invocation),'RESOURCE_SCOPE_IDENTITY_UNOBSERVED');
    const path='/sys/fs/cgroup'+state.ControlGroup;
    return {status:'observed' as const,state,budget:readBudget(handle),
      scope_metrics:{cpu:counters(path+'/cpu.stat'),memory_events:counters(path+'/memory.events'),
        pid_events:counters(path+'/pids.events'),tasks_current:number(value(path+'/pids.current'))}};
  }
  async function stop() {
    const state=await observe();
    if(state.status==='gone')return state;
    await command('/usr/bin/systemctl',['--user','stop',unit]);
    const after=await resourceUnit(unit);
    requireCondition(after.LoadState==='not-found'||after.ActiveState==='inactive'||after.ActiveState==='failed','RESOURCE_SCOPE_STOP_UNCONFIRMED');
    return {status:'stopped' as const};
  }
  return {child,handle,unit,observe,stop};
}
