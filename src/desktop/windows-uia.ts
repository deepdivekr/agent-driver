import {requireCondition} from '../core/contracts.js';
import {type PersonalAgentComputer} from '../isolation/personal-agent-computer.js';
import {type WindowsPersonalVmSpec,windowsPersonalVmUiaEndpoint} from '../isolation/windows-personal-vm.js';

export const windowsUiaControlTypes=['button','edit','menu_item','list_item','tab_item','window','unknown'] as const;
export type WindowsUiaControlType=typeof windowsUiaControlTypes[number];
export interface WindowsUiaControl {
  automation_id:string;
  control_type:WindowsUiaControlType;
  name?:string;
  enabled:boolean;
  visible:boolean;
}
export interface WindowsUiaInventory {
  computer_id:string;
  task_id:string;
  application_id:string;
  window_automation_id:string;
  capture_id:string;
  controls:readonly WindowsUiaControl[];
}
export interface WindowsUiaInventoryRequest {
  computer_id:string;
  task_id:string;
  application_id:string;
  window_automation_id:string;
}
/** A code-reviewed plan may invoke one control from one previously observed window. */
export interface WindowsUiaReviewedAction {
  computer_id:string;
  task_id:string;
  application_id:string;
  window_automation_id:string;
  capture_id:string;
  control_automation_id:string;
  expected_control_type:Exclude<WindowsUiaControlType,'unknown'|'window'>;
  action:'invoke';
  review_id:string;
  reviewed:true;
}
export interface WindowsUiaActionReceipt {
  computer_id:string;
  task_id:string;
  capture_id:string;
  control_automation_id:string;
  outcome:'invoked'|'not_invoked';
}
/** The eventual guest service is injected. This module intentionally has no arbitrary HTTP, shell, or coordinate API. */
export interface WindowsUiaGuestTransport {
  observe(endpoint:string,request:WindowsUiaInventoryRequest):Promise<unknown>;
  invoke(endpoint:string,action:WindowsUiaReviewedAction):Promise<unknown>;
}

function object(value:unknown,code:string):Record<string,unknown>{requireCondition(typeof value==='object'&&value!==null&&!Array.isArray(value),code);return value as Record<string,unknown>;}
function safeRef(value:unknown,code:string):asserts value is string{requireCondition(typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value),code);}
function safeLabel(value:unknown){return typeof value==='string'&&value.length>0&&value.length<=160&&!/[\r\n]/u.test(value);}
function controlType(value:unknown):value is WindowsUiaControlType{return typeof value==='string'&&(windowsUiaControlTypes as readonly string[]).includes(value);}

function validateInventoryRequest(request:WindowsUiaInventoryRequest){
  safeRef(request.computer_id,'INVALID_WINDOWS_UIA_COMPUTER_ID');safeRef(request.task_id,'INVALID_WINDOWS_UIA_TASK_ID');safeRef(request.application_id,'INVALID_WINDOWS_UIA_APPLICATION_ID');safeRef(request.window_automation_id,'INVALID_WINDOWS_UIA_WINDOW_ID');
}
export function validateWindowsUiaReviewedAction(action:WindowsUiaReviewedAction){
  validateInventoryRequest(action);safeRef(action.capture_id,'INVALID_WINDOWS_UIA_CAPTURE_ID');safeRef(action.control_automation_id,'INVALID_WINDOWS_UIA_CONTROL_ID');safeRef(action.review_id,'INVALID_WINDOWS_UIA_REVIEW_ID');
  requireCondition(action.action==='invoke'&&action.reviewed===true,'WINDOWS_UIA_UNREVIEWED_ACTION');
  requireCondition(controlType(action.expected_control_type),'WINDOWS_UIA_INVALID_ACTION_CONTROL');
}

/** Reject secrets, editable values, raw trees, coordinates, and screenshots from this semantic control inventory. */
export function parseWindowsUiaInventory(value:unknown):WindowsUiaInventory{
  const parsed=object(value,'WINDOWS_UIA_INVALID_INVENTORY');
  requireCondition(!('raw_tree' in parsed)&&!('screenshot' in parsed)&&!('clipboard' in parsed),'WINDOWS_UIA_UNSAFE_INVENTORY_PAYLOAD');
  const request={computer_id:parsed.computer_id,task_id:parsed.task_id,application_id:parsed.application_id,window_automation_id:parsed.window_automation_id};validateInventoryRequest(request as WindowsUiaInventoryRequest);
  const typedRequest:WindowsUiaInventoryRequest={computer_id:parsed.computer_id as string,task_id:parsed.task_id as string,application_id:parsed.application_id as string,window_automation_id:parsed.window_automation_id as string};
  safeRef(parsed.capture_id,'INVALID_WINDOWS_UIA_CAPTURE_ID');requireCondition(Array.isArray(parsed.controls)&&parsed.controls.length<=500,'INVALID_WINDOWS_UIA_CONTROLS');
  const controls=parsed.controls.map((candidate,index)=>{
    const control=object(candidate,`INVALID_WINDOWS_UIA_CONTROL_${index}`);
    requireCondition(!('value' in control)&&!('password' in control)&&!('text' in control)&&!('bounds' in control),'WINDOWS_UIA_VALUE_DISCLOSURE');
    safeRef(control.automation_id,`INVALID_WINDOWS_UIA_CONTROL_ID_${index}`);requireCondition(controlType(control.control_type),`INVALID_WINDOWS_UIA_CONTROL_TYPE_${index}`);requireCondition(typeof control.enabled==='boolean'&&typeof control.visible==='boolean',`INVALID_WINDOWS_UIA_CONTROL_STATE_${index}`);
    if('name' in control)requireCondition(safeLabel(control.name),`INVALID_WINDOWS_UIA_CONTROL_NAME_${index}`);
    if('name' in control)return Object.freeze({automation_id:control.automation_id as string,control_type:control.control_type, name:control.name as string,enabled:control.enabled,visible:control.visible});
    return Object.freeze({automation_id:control.automation_id as string,control_type:control.control_type,enabled:control.enabled,visible:control.visible});
  });
  return Object.freeze({...typedRequest,capture_id:parsed.capture_id as string,controls:Object.freeze(controls)});
}

export function parseWindowsUiaActionReceipt(value:unknown):WindowsUiaActionReceipt{
  const parsed=object(value,'WINDOWS_UIA_INVALID_ACTION_RECEIPT');
  safeRef(parsed.computer_id,'INVALID_WINDOWS_UIA_COMPUTER_ID');safeRef(parsed.task_id,'INVALID_WINDOWS_UIA_TASK_ID');safeRef(parsed.capture_id,'INVALID_WINDOWS_UIA_CAPTURE_ID');safeRef(parsed.control_automation_id,'INVALID_WINDOWS_UIA_CONTROL_ID');
  requireCondition(parsed.outcome==='invoked'||parsed.outcome==='not_invoked','INVALID_WINDOWS_UIA_ACTION_OUTCOME');
  return Object.freeze({computer_id:parsed.computer_id as string,task_id:parsed.task_id as string,capture_id:parsed.capture_id as string,control_automation_id:parsed.control_automation_id as string,outcome:parsed.outcome as 'invoked'|'not_invoked'});
}

/**
 * Boundary for a future Windows guest agent. A caller can observe controls,
 * then invoke only a reviewed exact control from the resulting capture. It
 * cannot fall back to the owner desktop, mouse coordinates, typed secrets, or
 * an arbitrary app command.
 */
export class WindowsUiaGuestClient {
  readonly endpoint:string;
  constructor(readonly computer:PersonalAgentComputer,readonly vm:WindowsPersonalVmSpec,readonly transport:WindowsUiaGuestTransport){
    requireCondition(computer.guest_os==='windows','WINDOWS_UIA_REQUIRES_WINDOWS_GUEST');
    requireCondition(computer.available_surfaces.includes('desktop'),'AGENT_COMPUTER_SURFACE_UNAVAILABLE');
    requireCondition(computer.id===vm.id,'WINDOWS_UIA_VM_COMPUTER_MISMATCH');
    this.endpoint=windowsPersonalVmUiaEndpoint(vm);
  }
  async observe(request:WindowsUiaInventoryRequest){
    validateInventoryRequest(request);requireCondition(request.computer_id===this.computer.id,'WINDOWS_UIA_COMPUTER_MISMATCH');
    const inventory=parseWindowsUiaInventory(await this.transport.observe(this.endpoint,request));
    requireCondition(inventory.computer_id===request.computer_id&&inventory.task_id===request.task_id&&inventory.application_id===request.application_id&&inventory.window_automation_id===request.window_automation_id,'WINDOWS_UIA_INVENTORY_BINDING_MISMATCH');
    return inventory;
  }
  async invoke(action:WindowsUiaReviewedAction){
    validateWindowsUiaReviewedAction(action);requireCondition(action.computer_id===this.computer.id,'WINDOWS_UIA_COMPUTER_MISMATCH');
    const receipt=parseWindowsUiaActionReceipt(await this.transport.invoke(this.endpoint,action));
    requireCondition(receipt.computer_id===action.computer_id&&receipt.task_id===action.task_id&&receipt.capture_id===action.capture_id&&receipt.control_automation_id===action.control_automation_id,'WINDOWS_UIA_ACTION_BINDING_MISMATCH');
    return receipt;
  }
}
