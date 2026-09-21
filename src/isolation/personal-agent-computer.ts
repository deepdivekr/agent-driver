import {requireCondition} from '../core/contracts.js';
import {type UbuntuBrowserVmSpec} from './ubuntu-browser-vm.js';

/** An execution surface that has an implemented adapter, not merely an installed application. */
export const personalAgentComputerSurfaces=['browser','terminal','desktop'] as const;
export type PersonalAgentComputerSurface=typeof personalAgentComputerSurfaces[number];
export type PersonalAgentComputerOs='linux'|'windows';

/**
 * A user's durable agent workspace. It is deliberately broader than one task,
 * but it is never the user's foreground desktop or a host-app attachment.
 */
export interface PersonalAgentComputerSpec {
  id:string;
  guest_os:PersonalAgentComputerOs;
  available_surfaces:readonly PersonalAgentComputerSurface[];
  owner_scope:'single_user';
  lifecycle:'persistent';
  guest_state:'shared_across_owner_tasks';
  host_desktop_access:'none';
  host_file_bridge:'explicit_transfer_only';
}

export interface PersonalAgentComputer extends PersonalAgentComputerSpec {
  readonly lease_resource:string;
  readonly interactive_control:'one_task_at_a_time';
}

export interface PersonalAgentComputerTaskLease {
  computer_id:string;
  task_id:string;
  resource:string;
  requested_surfaces:readonly PersonalAgentComputerSurface[];
  shared_guest_state:true;
  exclusive_interactive_control:true;
}

function safeId(value:string){return /^[a-z][a-z0-9-]{0,62}$/u.test(value);}
function safeTaskId(value:string){return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);}
function isSurface(value:string):value is PersonalAgentComputerSurface{return (personalAgentComputerSurfaces as readonly string[]).includes(value);}
function normalizedSurfaces(surfaces:readonly PersonalAgentComputerSurface[]){
  requireCondition(surfaces.length>0&&surfaces.length<=personalAgentComputerSurfaces.length,'INVALID_AGENT_COMPUTER_SURFACES');
  const normalized:PersonalAgentComputerSurface[]=[];
  for(const surface of surfaces){requireCondition(isSurface(surface),'INVALID_AGENT_COMPUTER_SURFACE');requireCondition(!normalized.includes(surface),'DUPLICATE_AGENT_COMPUTER_SURFACE');normalized.push(surface);}
  return Object.freeze(normalized.sort()) as readonly PersonalAgentComputerSurface[];
}

/** The resource key is intentionally stable across tasks: the VM is personal and persistent; control is not concurrent. */
export function personalAgentComputerLeaseResource(id:string){
  requireCondition(safeId(id),'INVALID_AGENT_COMPUTER_ID');
  return JSON.stringify(['personal-agent-computer',id]);
}

export function createPersonalAgentComputer(spec:PersonalAgentComputerSpec):PersonalAgentComputer {
  requireCondition(safeId(spec.id),'INVALID_AGENT_COMPUTER_ID');
  requireCondition(spec.guest_os==='linux'||spec.guest_os==='windows','INVALID_AGENT_COMPUTER_OS');
  requireCondition(spec.owner_scope==='single_user','INVALID_AGENT_COMPUTER_OWNER_SCOPE');
  requireCondition(spec.lifecycle==='persistent','INVALID_AGENT_COMPUTER_LIFECYCLE');
  requireCondition(spec.guest_state==='shared_across_owner_tasks','INVALID_AGENT_COMPUTER_GUEST_STATE');
  requireCondition(spec.host_desktop_access==='none','HOST_DESKTOP_SHARING_FORBIDDEN');
  requireCondition(spec.host_file_bridge==='explicit_transfer_only','IMPLICIT_HOST_FILE_BRIDGE_FORBIDDEN');
  return Object.freeze({...spec,available_surfaces:normalizedSurfaces(spec.available_surfaces),lease_resource:personalAgentComputerLeaseResource(spec.id),interactive_control:'one_task_at_a_time' as const});
}

/**
 * Produces a lease binding suitable for RuntimeStore.acquire(taskId, resource,
 * targetRef). The existing durable lease table serializes the shared display
 * and profile across tasks; this function does not create a VM per task.
 */
export function bindTaskToPersonalAgentComputer(computer:PersonalAgentComputer,taskId:string,requestedSurfaces:readonly PersonalAgentComputerSurface[]):PersonalAgentComputerTaskLease {
  requireCondition(safeTaskId(taskId),'INVALID_AGENT_COMPUTER_TASK_ID');
  const requested=normalizedSurfaces(requestedSurfaces);
  for(const surface of requested)requireCondition(computer.available_surfaces.includes(surface),'AGENT_COMPUTER_SURFACE_UNAVAILABLE');
  return Object.freeze({computer_id:computer.id,task_id:taskId,resource:computer.lease_resource,requested_surfaces:requested,shared_guest_state:true as const,exclusive_interactive_control:true as const});
}

/**
 * Current Ubuntu guest integration. The guest is persistent, but its current
 * shipped executor is browser-only: do not advertise a terminal or desktop
 * executor merely because the guest OS could install such an application.
 */
export function personalAgentComputerFromUbuntuBrowserVm(vm:Pick<UbuntuBrowserVmSpec,'id'>):PersonalAgentComputer {
  return createPersonalAgentComputer({id:vm.id,guest_os:'linux',available_surfaces:['browser'],owner_scope:'single_user',lifecycle:'persistent',guest_state:'shared_across_owner_tasks',host_desktop_access:'none',host_file_bridge:'explicit_transfer_only'});
}
