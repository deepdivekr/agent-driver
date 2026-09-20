// Closed, payload-free diagnostics. Absence means unobserved, not success.
export const workerStages=['resource_setup','claim','claimed','browser_launch','navigation','browser_ready','observation','before_intent','intent_recorded','execute','before_save','after_save','response_recorded','verified','context_close'] as const;
export type WorkerStage=typeof workerStages[number];
export const failureCodes=['CONFIG_CHANGED','TASK_SCOPE_MISMATCH','PROCESS_IDENTITY_UNSUPPORTED','STALE_LAUNCH','STALE_SUPERVISOR','TASK_NOT_DISPATCHABLE','DEADLINE_EXCEEDED','TARGET_URL_CHANGED','ACCOUNT_OR_PROFILE_MISMATCH','BROWSER_DEPENDENCY_FAILED','RESOURCE_BUSY','SAVE_RESPONSE_UNKNOWN','READBACK_FAILED','TIMEOUT','UNKNOWN'] as const;
export type FailureCode=typeof failureCodes[number];
export function failureCode(error:unknown):FailureCode{
  if(error instanceof Error){
    if((failureCodes as readonly string[]).includes(error.message))return error.message as FailureCode;
    if(error.name==='TimeoutError')return 'TIMEOUT';
  }
  return 'UNKNOWN';
}
export type WorkerDiagnostic={kind:'progress';stage:WorkerStage}|{kind:'failure';stage:WorkerStage;code:FailureCode};
export type DiagnosticHook=(diagnostic:WorkerDiagnostic)=>void;
export const recoveryTriggers=['worker_dead','startup_timeout','supervisor_replaced','launch_failed','launch_dead','cancelled_pending','unobserved'] as const;
export type RecoveryTrigger=typeof recoveryTriggers[number];
