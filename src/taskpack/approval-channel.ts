import {requireCondition} from '../core/contracts.js';
import {type RuntimeStore} from '../store/runtime-store.js';

export interface ApprovalDelivery {task_id:string;proposal_hash:string;expires_at_ms:number;approval_token:string;capture_ref:string;}
export interface ApprovalChannel {
  readonly id:string;
  deliver(request:ApprovalDelivery):Promise<void>;
  verifyInbound(message:string,expected:ApprovalDelivery):Promise<{approved:boolean;receipt:unknown}>;
}

/**
 * Telegram/Hermes belong behind this boundary.  The core never treats a bare
 * "OK" as approval: the exact per-snapshot capability must be present.
 */
export async function acceptBoundApproval(store:RuntimeStore,channel:ApprovalChannel,delivery:ApprovalDelivery,message:string){
  const verdict=await channel.verifyInbound(message,delivery);
  requireCondition(verdict.approved,'APPROVAL_NOT_GRANTED');
  return store.acceptProposalApproval(delivery.task_id,delivery.approval_token,channel.id,verdict.receipt);
}

export class TokenMessageApprovalChannel implements ApprovalChannel {
  constructor(readonly id:string,private readonly send:(request:ApprovalDelivery)=>Promise<void>){requireCondition(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id),'INVALID_APPROVAL_CHANNEL');}
  deliver(request:ApprovalDelivery){return this.send(request);}
  async verifyInbound(message:string,expected:ApprovalDelivery){
    const approved=message.trim()===`OK ${expected.approval_token}`;
    return {approved,receipt:{format:'exact_bound_token',task_id:expected.task_id,proposal_hash:expected.proposal_hash,message_hash_only:true}};
  }
}
