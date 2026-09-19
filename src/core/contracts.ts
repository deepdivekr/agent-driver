export const TASK_STATES = ['queued','running','verifying','succeeded','waiting_auth','waiting_approval','waiting_orchestrator','rate_limited','paused_dependency','suspended_environment','recovering','ready_to_resume','reconciliation_required','failed','cancelled'] as const;
export type TaskStatus = typeof TASK_STATES[number];
export type Effect = 'read_only' | 'write_external';
export type EffectState = 'none' | 'unknown' | 'observed';
export interface ProjectBinding {
  id: string; callerRef: string; worktree: string; profileRef: string; accountRef: string;
  allowedOrigins: string[]; capabilities: string[];
}
export interface TaskRecord {
  id: string; project_id: string; capability: string; status: TaskStatus;
  effect_state: EffectState; next_action: string; selected_route: string | null;
  target_ref: string | null; cancel_requested: number;
}
export interface Lease {
  resource: string; projectId: string; taskId: string; generation: number; token: string;
}
export interface Observation {
  targetRef: string; targetExists: boolean | 'unknown'; ownerTaskId: string;
  projectId: string; profileRef: string; accountRef: string | 'unknown'; origin: string;
  generation: number; observedMonoMs: number; visibility: 'visible'|'hidden'|'unknown';
  environment: 'owned_headless'|'owned_hidden'|'user_desktop';
}
export interface Capability {
  id: string; effect: Effect; route: string; environments: Observation['environment'][];
  hiddenVerified: boolean; requiresForeground: boolean; requiresOsInput: boolean;
  usesUserTarget: boolean; requiresClipboard: boolean; requiresFileDialog: boolean;
  verification: 'independent_readback';
}
export interface Verification {
  result: 'MATCH'|'NOT_MATCH'|'UNKNOWN'; source: string; accountRef: string;
  targetRef: string; generation: number; observedMonoMs: number; detail: Record<string,unknown>;
}
export interface DispatchContext {
  taskId: string; callerRef: string; lease: Lease; capability: Capability;
  observation: Observation; maxObservationAgeMs: number;
}
export interface RuntimeAdapter {
  observe(): Promise<Observation>;
  execute(): Promise<void>;
  verify(): Promise<Verification>;
}
export class RuntimeError extends Error {
  constructor(readonly code: string) { super(code); this.name='RuntimeError'; }
}
export function requireCondition(value: unknown, code: string): asserts value {
  if (!value) throw new RuntimeError(code);
}
