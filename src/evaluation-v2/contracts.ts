export const SCENARIOS = ["S01", "S02", "S03", "S04", "S06", "S07"] as const;
export type Scenario = (typeof SCENARIOS)[number];
export type Condition = "normal" | "perturbed";
export type Fields = { name: string; note: string };
export type CsvRow = { account: string; period: string; item: string; amount: number };
export type CaseSpec = {
  runId: string; scenario: Scenario; condition: Condition; seed: number;
  account: string; fields: Fields; upload: { name: string; base64: string }; rows: CsvRow[];
  responseFault?: 'drop_before_save' | 'drop_after_save';
};
export type AppState = {
  records: Record<string, Fields>;
  uploads: Record<string, { name: string; base64: string }>;
  effects: { account: string; kind: "save" | "upload" | "download" }[];
  events: { account: string; kind: string; value: string }[];
};
export type Verification = { result: "VERIFIED" | "REFUTED" | "UNKNOWN"; errors: string[] };
export type Span = { name: string; operation: string; startedMs: number; endedMs: number; status: "PASS" | "FAIL"; error?: string };
export type Operation =
  | { kind: "fill"; selector: string; value: string }
  | { kind: "click"; selector: string }
  | { kind: "upload"; selector: string; path: string }
  | { kind: "download"; selector: string };

/** Only task data and UI operations cross this boundary; no hidden oracle state. */
export interface Hand {
  name: string;
  start(downloadDir: string): Promise<void>;
  open(url: string, scenario?: Scenario): Promise<void>;
  observe(): Promise<unknown>;
  act(operation: Operation): Promise<void>;
  perturb(scenario: Scenario): Promise<unknown>;
  settle(): Promise<void>;
  closeTask(): Promise<void>;
  close(): Promise<void>;
  version(): Promise<string>;
}

export class Trace {
  readonly origin = performance.now();
  readonly spans: Span[] = [];
  async measure<T>(name: string, operation: string, work: () => Promise<T>): Promise<T> {
    const startedMs = performance.now() - this.origin;
    try {
      const result = await work();
      this.spans.push({ name, operation, startedMs, endedMs: performance.now() - this.origin, status: "PASS" });
      return result;
    } catch (error) {
      this.spans.push({ name, operation, startedMs, endedMs: performance.now() - this.origin, status: "FAIL", error: String(error) });
      throw error;
    }
  }
}
