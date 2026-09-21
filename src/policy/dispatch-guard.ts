import { requireCondition, type DispatchContext, type ProjectBinding } from '../core/contracts.js';
import { RuntimeStore } from '../store/runtime-store.js';
export const browserResource=(project:ProjectBinding)=>JSON.stringify(['browser',project.profileRef,project.accountRef]);
/**
 * Most browser work leases the project profile/account pair. A Personal Agent
 * Computer supplies a stricter, persistent VM resource instead. The caller
 * must pass that resource explicitly; this is not an ambient host fallback.
 */
export function guard(store:RuntimeStore,context:DispatchContext,now=performance.now(),verificationOnly=false,expectedResource?:string) {
  const task=store.task(context.taskId),project=store.project(task.project_id),o=context.observation,c=context.capability;
  const resource=expectedResource??browserResource(project);
  requireCondition(context.callerRef===project.callerRef,'CALLER_NOT_DELEGATED');
  requireCondition(context.lease.taskId===task.id&&context.lease.projectId===project.id&&context.lease.resource===resource,'LEASE_SCOPE_MISMATCH');
  store.assertLease(context.lease);
  requireCondition(verificationOnly?['running','verifying','reconciliation_required'].includes(task.status):task.status==='running'&&!task.cancel_requested,'TASK_NOT_DISPATCHABLE');
  requireCondition(task.capability===c.id&&project.capabilities.includes(c.id),'CAPABILITY_NOT_DELEGATED');
  requireCondition(o.targetExists===true&&o.targetRef===task.target_ref&&o.ownerTaskId===task.id,'TARGET_NOT_OWNED');
  requireCondition(o.projectId===project.id&&o.profileRef===project.profileRef&&o.accountRef===project.accountRef,'ACCOUNT_OR_PROFILE_MISMATCH');
  requireCondition(o.generation===context.lease.generation,'STALE_OBSERVATION_GENERATION');
  requireCondition(Number.isFinite(now)&&Number.isFinite(o.observedMonoMs)&&Number.isFinite(context.maxObservationAgeMs)&&context.maxObservationAgeMs>0&&now>=o.observedMonoMs&&now-o.observedMonoMs<=context.maxObservationAgeMs,'STALE_OBSERVATION');
  requireCondition(project.allowedOrigins.includes(o.origin),'ORIGIN_NOT_ALLOWED');
  requireCondition(c.environments.includes(o.environment)&&o.environment!=='user_desktop','ENVIRONMENT_NOT_SUPPORTED');
  requireCondition(!c.requiresForeground&&!c.requiresOsInput&&!c.usesUserTarget&&!c.requiresClipboard&&!c.requiresFileDialog,'FOREGROUND_OR_USER_RESOURCE_FORBIDDEN');
  requireCondition(o.visibility!=='unknown'&&(o.visibility!=='hidden'||c.hiddenVerified),'HIDDEN_ROUTE_NOT_VERIFIED');
}
