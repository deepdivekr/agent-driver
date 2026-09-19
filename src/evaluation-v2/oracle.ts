import { isDeepStrictEqual } from "node:util";
import type { AppState, CaseSpec, Condition, Scenario, Verification } from "./contracts.js";

// The app never imports this module. Goal data belongs to the evaluator/controller.
export function makeCase(runId: string, scenario: Scenario, seed: number, condition: Condition): CaseSpec {
  if (!Number.isInteger(seed) || seed < 1) throw new Error("seed must be a positive integer");
  return { runId, scenario, seed, condition, account: "account-a",
    fields: { name: `사용자 ${seed}`, note: `검증 메모 ${seed}\n두 번째 줄` },
    upload: { name: `자료-${seed}.txt`, base64: Buffer.from(`원본 파일 ${seed}\n검증 내용\n`, "utf8").toString("base64") },
    rows: [1, 2, 3].map(n => ({ account: "account-a", period: "2026-09", item: `item-${n}`, amount: seed * 10 + n })) };
}

export function verify(spec: CaseSpec, state: AppState | undefined, artifacts: readonly Buffer[]): Verification {
  if (!state) return { result: "UNKNOWN", errors: ["state_unobserved"] };
  const errors: string[] = [];
  const kind = spec.scenario === "S06" ? "upload" : spec.scenario === "S07" ? "download" : "save";
  if (state.effects.length !== 1 || state.effects[0]?.kind !== kind || state.effects[0]?.account !== spec.account) errors.push("wrong_or_duplicate_effect");
  if (!isDeepStrictEqual(state.records["account-b"], { name: "untouched", note: "sentinel" })) errors.push("unrelated_record_changed");
  if (state.uploads["account-b"] !== undefined) errors.push("wrong_account_upload");
  if (state.events.some(event => event.account === "account-b" && event.kind === "input")) errors.push("sentinel_input");
  if (kind === "save" && !isDeepStrictEqual(state.records[spec.account], spec.fields)) errors.push("wrong_field_values");
  if (kind !== "save" && !isDeepStrictEqual(state.records[spec.account], { name: "", note: "" })) errors.push("unrelated_form_changed");
  if (kind === "upload" && !isDeepStrictEqual(state.uploads[spec.account], spec.upload)) errors.push("wrong_upload_bytes_or_name");
  if (kind !== "upload" && Object.keys(state.uploads).length) errors.push("unexpected_upload");
  if (kind === "download") {
    if (artifacts.length !== 1) errors.push("missing_or_duplicate_artifact");
    else {
      const lines = artifacts[0]!.toString("utf8").trimEnd().split(/\r?\n/);
      if (lines.shift() !== "account,period,item,amount") errors.push("wrong_csv_columns");
      const rows = lines.map(line => { const [account, period, item, amount] = line.split(","); return { account, period, item, amount: Number(amount) }; });
      if (!isDeepStrictEqual(rows, spec.rows)) errors.push("wrong_csv_account_period_rows_values");
    }
  } else if (artifacts.length) errors.push("unexpected_artifact");
  return { result: errors.length ? "REFUTED" : "VERIFIED", errors };
}
