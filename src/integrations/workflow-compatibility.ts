import {createHash} from 'node:crypto';
import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {pathToFileURL} from 'node:url';
import {z} from 'zod';
import {requireCondition} from '../core/contracts.js';
import {loadHostConfig,type HostConfig} from '../interface/config.js';

import {type WorkflowBridge} from './workflow-contracts.js';
export {legacyWorkflowPolicy,workflowBridgeSchema,type WorkflowBridge} from './workflow-contracts.js';
export const workflowPolicyHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)??'undefined').digest('hex');
export function workflowModuleHash(path:string){
  requireCondition(isAbsolute(path)&&/\.(?:m?js)$/u.test(path),'WORKFLOW_MODULE_PATH_REQUIRED');
  const stat=lstatSync(path);
  requireCondition(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1&&stat.size<=2*1024*1024&&realpathSync(path)===path,'WORKFLOW_MODULE_UNSAFE');
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function verifyWorkflowBridge(bridge:WorkflowBridge,policy:unknown){
  requireCondition(workflowPolicyHash(policy)===bridge.policy_sha256,'WORKFLOW_POLICY_CHANGED');
  for(const item of [bridge.runtime,bridge.contracts])requireCondition(workflowModuleHash(item.path)===item.sha256,'WORKFLOW_MODULE_CHANGED');
}
const id=z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u);
export const compatibilityWorkflowTools={
  runtime_workflow_catalog:{schema:z.object({}).strict(),implemented:true,readOnly:true},
  runtime_workflow_status:{schema:z.object({request_id:id}).strict(),implemented:true,readOnly:true},
  // Extra fields are validated by the explicitly registered local contract before dispatch.
  runtime_workflow_run:{schema:z.object({request_id:id,workflow_id:id}).catchall(z.unknown()),implemented:true,readOnly:false},
};
type ToolName=keyof typeof compatibilityWorkflowTools;
interface LocalContract {schema:{parse(input:unknown):unknown};implemented:boolean;readOnly:boolean;}
interface LocalModules {call:(config:unknown,name:string,args:unknown)=>Promise<unknown>;tools:Record<ToolName,LocalContract>;}
const loadedModulePins=new Map<string,string>();
/** A trusted local ABI bridge, NOT a sandbox or a marketplace plugin loader.
 * Only host configuration can register code. The existing adapter still owns
 * effect approval, deduplication, locking and reconciliation. Never retry calls. */
export class WorkflowCompatibility {
  private modules:Promise<LocalModules>|null=null;
  private stopped=false;
  private pending=new Set<Promise<unknown>>();
  constructor(private readonly config:HostConfig){}
  status(){return {policy_present:this.config.legacyWorkflows!==undefined&&this.config.legacyWorkflows!==null,
    connection:this.config.workflowBridge?'registered_unprobed':this.config.legacyWorkflows?'connection_required':'not_configured',
    automatic_execution:false,permissions_granted:false};}
  private verify(){
    requireCondition(this.config.legacyWorkflows&&this.config.workflowBridge,'WORKFLOW_COMPATIBILITY_CONNECTION_REQUIRED');
    // Live revocation/config edits fence an already open MCP before another call.
    const fresh=loadHostConfig(this.config.path);
    requireCondition(fresh.fingerprint===this.config.fingerprint,'WORKFLOW_CONFIGURATION_CHANGED');
    verifyWorkflowBridge(this.config.workflowBridge,this.config.legacyWorkflows);
  }
  private async load(){
    this.verify();const bridge=this.config.workflowBridge!;
    if(!this.modules)this.modules=(async()=>{
      for(const item of [bridge.runtime,bridge.contracts]){
        const loaded=loadedModulePins.get(item.path);
        requireCondition(!loaded||loaded===item.sha256,'WORKFLOW_MODULE_RESTART_REQUIRED');loadedModulePins.set(item.path,item.sha256);
      }
      const contract=await import(pathToFileURL(bridge.contracts.path).href),runtime=await import(pathToFileURL(bridge.runtime.path).href);
      requireCondition(typeof runtime.workflowCall==='function','WORKFLOW_BRIDGE_ABI_INVALID');
      requireCondition(typeof contract.workflowPolicy?.parse==='function','WORKFLOW_BRIDGE_ABI_INVALID');
      contract.workflowPolicy.parse(this.config.legacyWorkflows);
      for(const [name,expected] of Object.entries(compatibilityWorkflowTools)){
        const value=contract.workflowTools?.[name];
        requireCondition(value?.implemented===true&&value.readOnly===expected.readOnly&&typeof value.schema?.parse==='function','WORKFLOW_BRIDGE_ABI_INVALID');
      }
      return {call:runtime.workflowCall,tools:contract.workflowTools} as LocalModules;
    })();
    return this.modules;
  }
  async call(name:string,args:unknown):Promise<unknown>{
    requireCondition(!this.stopped,'WORKFLOW_COMPATIBILITY_CLOSED');
    requireCondition(Object.hasOwn(compatibilityWorkflowTools,name),'UNKNOWN_TOOL');
    const tool=name as ToolName;
    requireCondition(Buffer.byteLength(JSON.stringify(args)??'')<=65536,'WORKFLOW_REQUEST_TOO_LARGE');
    const input=compatibilityWorkflowTools[tool].schema.parse(args);
    if(!this.config.workflowBridge){
      if(tool==='runtime_workflow_catalog')return {...this.status(),workflows:[],reason:this.config.legacyWorkflows?'WORKFLOW_COMPATIBILITY_CONNECTION_REQUIRED':null};
      throw Error('WORKFLOW_COMPATIBILITY_CONNECTION_REQUIRED');
    }
    const operation=(async()=>{
      const module=await this.load();const parsed=module.tools[tool].schema.parse(input);
      this.verify(); // No cached verification can authorize a changed policy/module.
      const result=await module.call({...this.config,workflows:structuredClone(this.config.legacyWorkflows)},tool,parsed);
      requireCondition(Buffer.byteLength(JSON.stringify(result)??'')<=1024*1024,'WORKFLOW_RESULT_TOO_LARGE');
      return result;
    })();
    this.pending.add(operation);
    try{return await operation;}finally{this.pending.delete(operation);}
  }
  async drain(){this.stopped=true;await Promise.allSettled([...this.pending]);}
}
