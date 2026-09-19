import { readFile } from "node:fs/promises";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { FixtureServer } from "../fixture/index.js";
import { startFixtureServer } from "../fixture/index.js";
import type { DecisionPolicy, RunRecord } from "./index.js";

export type BenchmarkTask = Readonly<{
  task_id: string;
  family: string;
  variant: number;
  goal: string;
}>;

export type BenchmarkRun = Readonly<{
  record: RunRecord;
  status: "PASS" | "FAIL" | "BLOCKED_ENV";
  evidenceLevel: "native_integration" | "contract_fake";
  error?: string;
}>;

export type PlaywrightBenchmarkResult = Readonly<{
  executor: "playwright";
  policy: DecisionPolicy;
  plannedRuns: number;
  runs: readonly BenchmarkRun[];
  fixtureBaseUrl: string;
}>;

type FixtureOracle = Readonly<{
  completed: boolean;
  effectCount: number;
}>;

async function verifyFixture(baseUrl: string, taskId: string): Promise<FixtureOracle> {
  const response = await fetch(`${baseUrl}/api/records/${encodeURIComponent(taskId)}`);
  if (!response.ok) throw new Error(`fixture oracle returned HTTP ${response.status}`);
  const body = await response.json() as Partial<FixtureOracle>;
  if (typeof body.completed !== "boolean" || typeof body.effectCount !== "number") throw new Error("fixture oracle response is incomplete");
  return { completed: body.completed, effectCount: body.effectCount };
}

async function performTask(page: Page, task: BenchmarkTask, taskId: string): Promise<void> {
  await page.goto(`${page.url().replace(/\/$/, "")}/task/${encodeURIComponent(taskId)}`, { waitUntil: "domcontentloaded" });
  if (task.family === "static_dom") {
    await page.locator("#value").fill(`value-${task.variant}`);
    await page.locator("#save").click();
  } else if (task.family === "dynamic_spa") {
    await page.locator("#open-modal").click();
    await page.locator("#modal-value").fill(`modal-${task.variant}`);
    await page.locator("#apply").click();
  } else if (task.family === "multi_tab") {
    await page.locator("#target-action").click();
  } else if (task.family === "authenticated") {
    await page.locator("#account").waitFor({ state: "visible" });
    await page.locator("#period").selectOption("2026-02");
    await page.locator("#load").click();
  } else if (task.family === "file_upload") {
    await page.locator("#file").setInputFiles({ name: `${taskId}.txt`, mimeType: "text/plain", buffer: Buffer.from(`fixture-file:${taskId}`) });
  } else if (task.family === "canvas") {
    await page.locator("#paint").click();
  } else if (task.family === "cross_app") {
    await page.locator("#export").click();
  } else if (task.family === "downloads") {
    const downloadPromise = page.waitForEvent("download");
    await page.locator("#download").click();
    const download = await downloadPromise;
    const path = await download.path();
    if (!path) throw new Error("download path was not available");
    const contents = await readFile(path, "utf8");
    if (!contents.includes(`fixture-download:${taskId}`)) throw new Error("download contents failed independent check");
  } else {
    throw new Error(`unsupported fixture family: ${task.family}`);
  }
  await page.locator("#state").waitFor({ state: "attached" });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await page.locator("#state").getAttribute("data-complete") === "true") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("page state did not reach complete");
}

async function runOne(browser: Browser, fixture: FixtureServer, task: BenchmarkTask, repeat: number, policy: DecisionPolicy): Promise<BenchmarkRun> {
  const taskId = `${task.task_id}-r${repeat}`;
  const runId = `playwright-${taskId}-${Date.now()}`;
  const started = performance.now();
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(fixture.baseUrl, { waitUntil: "domcontentloaded" });
    await performTask(page, task, taskId);
    const oracle = await verifyFixture(fixture.baseUrl, taskId);
    const durationMs = Math.round(performance.now() - started);
    const success = oracle.completed && oracle.effectCount === 1;
    const record: RunRecord = {
      runId,
      taskId,
      executor: "playwright",
      policy,
      outcome: success ? "clean_success" : "failure",
      recoveryCount: 0,
      durationMs,
      effectCount: oracle.effectCount,
    };
    return { record, status: success ? "PASS" : "FAIL", evidenceLevel: "native_integration" };
  } catch (error) {
    const record: RunRecord = {
      runId,
      taskId,
      executor: "playwright",
      policy,
      outcome: "failure",
      recoveryCount: 0,
      durationMs: Math.round(performance.now() - started),
      effectCount: 0,
    };
    return { record, status: "FAIL", evidenceLevel: "native_integration", error: error instanceof Error ? error.message : String(error) };
  } finally {
    await context?.close();
  }
}

export async function runPlaywrightBenchmark(tasks: readonly BenchmarkTask[], repeats = 3, policy: DecisionPolicy = "rules"): Promise<PlaywrightBenchmarkResult> {
  const fixture = await startFixtureServer();
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true });
    const runs: BenchmarkRun[] = [];
    for (const task of tasks) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) runs.push(await runOne(browser, fixture, task, repeat, policy));
    }
    return { executor: "playwright", policy, plannedRuns: tasks.length * repeats, runs, fixtureBaseUrl: fixture.baseUrl };
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
