import { RuntimeStore } from '../store/runtime-store.js';
import {type CheckpointHook} from '../supervisor/contracts.js';
import { guard } from '../policy/dispatch-guard.js';
import { requireCondition, type Capability, type Lease, type RuntimeAdapter, type DispatchContext, type Verification } from './contracts.js';
export class Runtime {
  readonly #capabilities:ReadonlyMap<string,Capability>;
  constructor(readonly store:RuntimeStore,capabilities:readonly Capability[]) {
    this.#capabilities=new Map(capabilities.map(c=>[c.route,Object.freeze({...c,environments:[...c.environments]})]));
    requireCondition(this.#capabilities.size===capabilities.length,'DUPLICATE_ROUTE');
  }
  async execute(taskId:string,callerRef:string,lease:Lease,route:string,input:unknown,adapter:RuntimeAdapter,options:{releaseLeaseOnComplete?:boolean;checkpoint?:CheckpointHook}={}) {
    const capability=this.#capabilities.get(route);requireCondition(capability,'UNREGISTERED_ROUTE');
    const context:DispatchContext={taskId,callerRef,lease,capability,observation:await adapter.observe(),maxObservationAgeMs:3000};
    guard(this.store,context);
    const intentId=this.store.begin(lease,capability.id,capability.effect,input,route);
    // Production has no checkpoint; only trusted test harnesses can pause here.
    if(options.checkpoint)await options.checkpoint('intent_recorded');
    let responseOk=true;
    try {await adapter.execute();} catch {responseOk=false;}
    this.store.response(lease,intentId,responseOk);
    if(options.checkpoint)await options.checkpoint('response_recorded');
    let verification:Verification={result:'UNKNOWN',source:'unobserved',accountRef:context.observation.accountRef,targetRef:context.observation.targetRef,generation:lease.generation,observedMonoMs:performance.now(),detail:{response_ok:responseOk}};
    try {
      const fresh=await adapter.observe();guard(this.store,{...context,observation:fresh},performance.now(),true);
      const candidate=await adapter.verify(),now=performance.now();
      requireCondition(candidate.accountRef===fresh.accountRef&&candidate.targetRef===fresh.targetRef&&candidate.generation===lease.generation,'VERIFICATION_BINDING_MISMATCH');
      requireCondition(['MATCH','NOT_MATCH','UNKNOWN'].includes(candidate.result)&&candidate.source!=='unobserved'&&candidate.source.length>0&&Number.isFinite(candidate.observedMonoMs)&&candidate.observedMonoMs<=now&&now-candidate.observedMonoMs<=3000,'INVALID_VERIFICATION');
      verification=candidate;
    } catch { /* No replay: retain UNKNOWN, including when the target vanished. */ }
    const task=this.store.complete(lease,intentId,verification);
    if(options.checkpoint)await options.checkpoint('verified');
    if(options.releaseLeaseOnComplete!==false&&(task.status==='succeeded'||task.status==='cancelled'))this.store.release(lease);
    return {task_id:task.id,project_id:task.project_id,status:task.status,selected_route:task.selected_route,session_ref:task.target_ref,effect_state:task.effect_state,verification,artifacts:[],next_action:task.next_action,intent_id:intentId};
  }
}
