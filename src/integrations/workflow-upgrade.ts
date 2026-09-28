import {createHash,randomUUID} from 'node:crypto';
import {constants,openSync,closeSync,fstatSync,lstatSync,realpathSync,readFileSync,writeFileSync,fsyncSync,renameSync,unlinkSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {HostConfigSchema,loadHostConfig} from '../interface/config.js';
import {workflowBridgeSchema,workflowModuleHash,workflowPolicyHash,verifyWorkflowBridge} from './workflow-compatibility.js';

const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
const planSchema=z.object({format:z.literal(1),kind:z.literal('local-workflow-compatibility'),id:z.string().uuid(),
  config_path:z.string(),original_base64:z.string().max(24000),original_sha256:z.string().regex(/^[a-f0-9]{64}$/u),
  proposed_sha256:z.string().regex(/^[a-f0-9]{64}$/u),bridge:workflowBridgeSchema,
  automatic_execution:z.literal(false),created_at:z.string().datetime(),
}).strict();
type UpgradePlan=z.infer<typeof planSchema>;
function safePath(path:string){
  const resolved=resolve(path);requireCondition(realpathSync(dirname(resolved))===dirname(resolved),'WORKFLOW_UPGRADE_REDIRECTED');return resolved;
}
function boundedRead(path:string,max:number){
  const actual=safePath(path),fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=fstatSync(fd);requireCondition(s.isFile()&&s.nlink===1&&s.size<=max,'WORKFLOW_UPGRADE_UNSAFE_FILE');
    const data=readFileSync(fd);requireCondition(data.length<=max,'WORKFLOW_UPGRADE_TOO_LARGE');return data;
  }finally{closeSync(fd);}
}
function syncDirectory(path:string){const fd=openSync(path,constants.O_RDONLY|constants.O_DIRECTORY);try{fsyncSync(fd);}finally{closeSync(fd);}}
function writeExclusive(path:string,bytes:Buffer|string){
  const fd=openSync(safePath(path),constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{writeFileSync(fd,bytes);fsyncSync(fd);}finally{closeSync(fd);}syncDirectory(dirname(path));
}
function proposed(original:Buffer,bridge:z.infer<typeof workflowBridgeSchema>){
  const raw=JSON.parse(original.toString('utf8')) as Record<string,unknown>;
  requireCondition(raw.workflows!==undefined&&!raw.workflow_bridge,'WORKFLOW_UPGRADE_LEGACY_POLICY_REQUIRED');
  const next={...raw,workflow_bridge:bridge};HostConfigSchema.parse(next);
  const bytes=Buffer.from(JSON.stringify(next,null,2)+'\n');requireCondition(bytes.length<=16384,'CONFIG_TOO_LARGE');return bytes;
}
/** Preparation fingerprints but never imports/runs legacy code. The private
 * plan doubles as an exact-byte pre-upgrade backup. No DB or schedule is opened. */
export function prepareWorkflowUpgrade(configPath:string,runtimeRoot:string,planPath:string){
  requireCondition(process.platform==='linux','WORKFLOW_UPGRADE_PLATFORM_UNVERIFIED');
  const path=safePath(configPath),original=boundedRead(path,16384),raw=JSON.parse(original.toString('utf8')) as Record<string,unknown>;
  loadHostConfig(path); // Validate all unrelated host settings before writing a plan.
  const root=realpathSync(runtimeRoot),runtime=join(root,'dist/workflows/runtime.js'),contracts=join(root,'dist/workflows/contracts.js');
  const bridge=workflowBridgeSchema.parse({protocol:'local-workflow-v1',
    runtime:{path:runtime,sha256:workflowModuleHash(runtime)},contracts:{path:contracts,sha256:workflowModuleHash(contracts)},policy_sha256:workflowPolicyHash(raw.workflows)});
  const next=proposed(original,bridge),plan=planSchema.parse({format:1,kind:'local-workflow-compatibility',id:randomUUID(),config_path:path,
    original_base64:original.toString('base64'),original_sha256:digest(original),proposed_sha256:digest(next),bridge,automatic_execution:false,created_at:new Date().toISOString()});
  const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');writeExclusive(resolve(planPath),bytes);
  return {plan_path:resolve(planPath),plan_sha256:digest(bytes),original_sha256:plan.original_sha256,proposed_sha256:plan.proposed_sha256,
    automatic_execution:false,changes:['workflow_bridge'],preserves:['workflows','all_other_host_settings','data_dir','worktree','external_schedules']};
}
function readPlan(path:string,expected:string){
  const bytes=boundedRead(path,65536);requireCondition(digest(bytes)===expected,'WORKFLOW_UPGRADE_PLAN_CHANGED');
  const plan=planSchema.parse(JSON.parse(bytes.toString('utf8'))),original=Buffer.from(plan.original_base64,'base64');
  requireCondition(original.length<=16384&&digest(original)===plan.original_sha256,'WORKFLOW_UPGRADE_BACKUP_INVALID');
  const next=proposed(original,plan.bridge);requireCondition(digest(next)===plan.proposed_sha256,'WORKFLOW_UPGRADE_BACKUP_INVALID');return {plan,original,next};
}
function replaceConfig(plan:UpgradePlan,expected:string,target:Buffer){
  const path=safePath(plan.config_path),lockPath=path+'.workflow-compatibility.lock';
  let lock:number;try{lock=openSync(lockPath,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}catch(error){
    if((error as NodeJS.ErrnoException).code==='EEXIST')throw Error('WORKFLOW_UPGRADE_BUSY');throw error;
  }
  const temporary=path+'.'+randomUUID()+'.partial';let temporaryCreated=false;
  try{
    writeFileSync(lock,JSON.stringify({pid:process.pid,plan_id:plan.id}));fsyncSync(lock);
    const before=boundedRead(path,16384),targetHash=digest(target);
    if(digest(before)===targetHash)return {status:'already_applied' as const,config_sha256:targetHash};
    requireCondition(digest(before)===expected,'WORKFLOW_UPGRADE_CONFIG_CHANGED');
    const stat=lstatSync(path);writeExclusive(temporary,target);temporaryCreated=true;
    const fresh=lstatSync(path);
    requireCondition(fresh.dev===stat.dev&&fresh.ino===stat.ino&&digest(boundedRead(path,16384))===expected,'WORKFLOW_UPGRADE_CONFIG_CHANGED');
    renameSync(temporary,path);temporaryCreated=false;syncDirectory(dirname(path));
    return {status:'applied' as const,config_sha256:targetHash};
  }finally{
    if(temporaryCreated)unlinkSync(temporary);closeSync(lock);unlinkSync(lockPath);syncDirectory(dirname(path));
  }
}
export function applyWorkflowUpgrade(planPath:string,expectedPlanHash:string){
  requireCondition(process.platform==='linux','WORKFLOW_UPGRADE_PLATFORM_UNVERIFIED');
  const {plan,original,next}=readPlan(planPath,expectedPlanHash);
  verifyWorkflowBridge(plan.bridge,(JSON.parse(original.toString('utf8')) as Record<string,unknown>).workflows);
  return {...replaceConfig(plan,plan.original_sha256,next),automatic_execution:false,restart_required:true};
}
export function rollbackWorkflowUpgrade(planPath:string,expectedPlanHash:string){
  requireCondition(process.platform==='linux','WORKFLOW_UPGRADE_PLATFORM_UNVERIFIED');
  const {plan,original}=readPlan(planPath,expectedPlanHash);
  // Rollback remains possible after removal or damage of the legacy module.
  return {...replaceConfig(plan,plan.proposed_sha256,original),automatic_execution:false,restart_required:true};
}
export const workflowCompatibilityHelp=`\n  compatibility plan --config PATH --runtime-root PATH --plan NEW_PRIVATE_FILE
  compatibility apply|rollback --plan PRIVATE_FILE --sha256 PLAN_SHA256
  (Linux/WSL local workflow ABI; preserves settings, never installs or executes a workflow)\n`;
export function runWorkflowCompatibilityCli(args:string[]){
  if(args[0]!=='compatibility')return false;
  const command=args[1];requireCondition(['plan','apply','rollback'].includes(command??''),'UNKNOWN_COMMAND');
  const options=new Map<string,string>();for(let i=2;i<args.length;i+=2){const key=args[i],value=args[i+1];
    requireCondition(key&&value&&!options.has(key)&&key.startsWith('--')&&!value.startsWith('--'),'INVALID_OPTIONS');options.set(key,value);}
  const allowed=command==='plan'?['--config','--runtime-root','--plan']:['--plan','--sha256'];
  requireCondition(options.size===allowed.length&&allowed.every(k=>options.has(k)),'INVALID_OPTIONS');
  const result=command==='plan'?prepareWorkflowUpgrade(options.get('--config')!,options.get('--runtime-root')!,options.get('--plan')!):
    command==='apply'?applyWorkflowUpgrade(options.get('--plan')!,options.get('--sha256')!):rollbackWorkflowUpgrade(options.get('--plan')!,options.get('--sha256')!);
  console.log(JSON.stringify(result));return true;
}
