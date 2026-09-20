import {spawn} from 'node:child_process';
import {inspectBudget,assertBudgetMembership,resourceBudgetSchema,resourceUnit} from './budget.js';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {processIdentitySync,type ProcessIdentity} from '../supervisor/identity.js';

// Internal bootstrap, not an MCP/raw-command capability. The target cannot run
// until the actual kernel membership and aggregate limits have been read back.
try {
  const encoded=process.argv[2]??'';
  if(encoded.length>131072)throw Error('RESOURCE_SPEC_TOO_LARGE');
  const spec=JSON.parse(Buffer.from(encoded,'base64url').toString('utf8')) as {budget:unknown;unit:string;executable:string;args:string[];env:NodeJS.ProcessEnv;owner:ProcessIdentity|null};
  const handle=await inspectBudget(resourceBudgetSchema.parse(spec.budget));
  if(!/^apdexec[a-f0-9]{32}\.service$/.test(spec.unit))throw Error('RESOURCE_SCOPE_INVALID');
  assertBudgetMembership(handle,process.pid,spec.unit);
  const unit=await resourceUnit(spec.unit),hash=createHash('sha256').update(JSON.stringify(handle.budget)).digest('hex');
  if(unit.Transient!=='yes'||unit.Description!=='agent-driver execution v1 '+hash+' '+spec.unit.slice(7,-8)||
    unit.Slice!==handle.unit||unit.ControlGroup!==handle.cgroup+'/'+spec.unit||Number(unit.MainPID)!==process.pid||
    unit.KillMode!=='control-group'||unit.OOMPolicy!=='kill'||unit.ExitType!=='main'||
    readFileSync('/sys/fs/cgroup'+unit.ControlGroup+'/memory.oom.group','utf8').trim()!=='1')throw Error('RESOURCE_EXECUTION_POLICY_MISMATCH');
  const ownerAlive=()=>!spec.owner||JSON.stringify(processIdentitySync(spec.owner.pid))===JSON.stringify(spec.owner);
  if(!ownerAlive())throw Error('RESOURCE_OWNER_LOST');
  const monitor=setInterval(()=>{
    try{assertBudgetMembership(handle);if(!ownerAlive())process.exit(125);}catch{process.exit(125);}
  },100);
  const child=spawn(spec.executable,spec.args,{stdio:'inherit',shell:false,windowsHide:true,env:spec.env});
  child.once('error',()=>{clearInterval(monitor);process.exitCode=125;});
  child.once('exit',(code,signal)=>{clearInterval(monitor);process.exitCode=code??(signal?128:125);});
  for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{child.kill(signal);});
} catch {process.exitCode=125;} // No command, environment or upstream content in diagnostics.
