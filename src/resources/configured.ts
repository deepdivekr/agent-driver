import {spawn,type SpawnOptions} from 'node:child_process';
import {type HostConfig} from '../interface/config.js';
import {assertBudgetMembership,inspectBudget,launchResourceUnit,type BudgetHandle,readBudget} from './budget.js';

export async function configuredBoundary(config:HostConfig,pid=process.pid):Promise<BudgetHandle|null> {
  if(!config.resources)return null;
  const handle=await inspectBudget(config.resources);assertBudgetMembership(handle,pid);return handle;
}
export function resourceFence(handle:BudgetHandle|null,pid=process.pid){if(handle)assertBudgetMembership(handle,pid);}
export async function launchConfigured(config:HostConfig,executable:string,args:string[],options:SpawnOptions){
  if(!config.resources)return spawn(executable,args,options);
  return (await launchResourceUnit(config.resources,executable,args,options)).child;
}
export async function resourceHealth(config:HostConfig){
  if(!config.resources)return {status:'unconfigured',verified:false,usage:'unobserved'};
  try{return {...readBudget(await inspectBudget(config.resources)),verified:true,
    scope:'configured_workload_services_gateway_not_included',security_boundary:'same_uid_not_adversarial'};}
  catch{return {status:'unavailable_or_changed',verified:false,usage:'unobserved',reason:'RESOURCE_BOUNDARY_UNAVAILABLE'};}
}
