export interface SupervisorRecord {project_id:string;nonce:string;identity_json:string;config_hash:string;active:number;stop_requested:number;started_at:string}
export interface SubmissionRecord {
  project_id:string;request_id:string;task_id:string;payload_json:string;config_hash:string;accepted_at:string;
  worker_nonce:string|null;worker_pid:number|null;worker_started_at:string|null;worker_identity_json:string|null;
  launch_nonce:string|null;launch_owner:string|null;dispatch_generation:number;attempt_count:number;
  recovery_state:'pending'|'reserved'|'running'|'prepared'|'reconcile'|'blocked'|'done'|'legacy_unknown';
  recovery_generation:number;retry_after_ms:number;last_error:string|null;accepted_boot_id:string|null;accepted_uptime_ms:number|null;
}
export type Checkpoint='claimed'|'browser_ready'|'before_intent'|'intent_recorded'|'before_save'|'after_save'|'response_recorded'|'verified';
export type CheckpointHook=(point:Checkpoint)=>Promise<void>;
