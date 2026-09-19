export type Executor = "playwright" | "opencli" | "cua" | "browser-use" | "stagehand";
export type DecisionPolicy = "standard" | "rules" | "jev-ultrafast";
export type VerificationResult = "VERIFIED" | "REFUTED" | "UNKNOWN";
export type RecoveryAction = "continue" | "verify_before_retry" | "switch_executor" | "wait" | "stop";

export type ObservableEvidence = Readonly<{
  postcondition?: boolean;
  mutationCommitted?: boolean;
  targetPresent?: boolean;
  authValid?: boolean;
}>;

export type RunRecord = Readonly<{
  runId: string;
  taskId: string;
  executor: Executor;
  policy: DecisionPolicy;
  outcome: "clean_success" | "recovered_success" | "failure" | "unknown";
  recoveryCount: number;
  durationMs: number;
  effectCount: number;
}>;

export type RunSummary = Readonly<{
  total: number;
  rawSuccessRate: number;
  cleanSuccessRate: number;
  recoveredSuccessRate: number;
  duplicateEffectRate: number;
  unsafeRetryRate: number;
}>;

export function verifyPostcondition(evidence: ObservableEvidence): VerificationResult {
  if (evidence.postcondition === true) return "VERIFIED";
  if (evidence.postcondition === false) return "REFUTED";
  return "UNKNOWN";
}

/** Unknown side effects must be reconciled before any retry or executor switch. */
export function recoveryAction(evidence: ObservableEvidence, executorCanContinue: boolean): RecoveryAction {
  if (evidence.mutationCommitted === undefined) return "verify_before_retry";
  if (evidence.mutationCommitted === true && verifyPostcondition(evidence) === "VERIFIED") return "continue";
  if (evidence.authValid === false) return "wait";
  if (evidence.targetPresent === false) return executorCanContinue ? "switch_executor" : "stop";
  if (verifyPostcondition(evidence) === "REFUTED") return executorCanContinue ? "continue" : "stop";
  return "verify_before_retry";
}

export function summarizeRuns(records: readonly RunRecord[]): RunSummary {
  const total = records.length;
  if (total === 0) {
    return {
      total: 0,
      rawSuccessRate: 0,
      cleanSuccessRate: 0,
      recoveredSuccessRate: 0,
      duplicateEffectRate: 0,
      unsafeRetryRate: 0,
    };
  }
  const successful = records.filter((record) => record.outcome === "clean_success" || record.outcome === "recovered_success").length;
  const clean = records.filter((record) => record.outcome === "clean_success").length;
  const recovered = records.filter((record) => record.outcome === "recovered_success").length;
  const duplicateEffects = records.filter((record) => record.effectCount > 1).length;
  const unsafeRetries = records.filter((record) => record.effectCount > 1 && record.recoveryCount > 0).length;
  return {
    total,
    rawSuccessRate: successful / total,
    cleanSuccessRate: clean / total,
    recoveredSuccessRate: recovered / total,
    duplicateEffectRate: duplicateEffects / total,
    unsafeRetryRate: unsafeRetries / total,
  };
}

export * from "./playwright-benchmark.js";
