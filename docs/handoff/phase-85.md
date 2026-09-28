# Phase 85 — Browser engine routing

## User request

Implement internal Neo/Aside adapters, Work-driven engine/environment selection,
handoff, and available VM/native verification. Source tree:
`/home/<user>/projects/agent-driver/release-v0.2.0`, branch `release/v0.2.0`.
This is an unreleased working tree with earlier unrelated changes preserved.
The installed personal MCP runtime has not been replaced and nothing was pushed.

## Implemented

- Shared read-only browser contract, target registration, engine/environment split.
- Actual Neo HTTP MCP and Aside official stdio MCP clients, bounded generated
  observation scripts, session forwarding and owned-tab lifecycle.
- Playwright persistent contexts, pooled independent Swarm contexts, and the
  existing attested Ubuntu VM CDP bridge.
- Work/Pack/Swarm selection, optional Pack-owned Jev/LLM decisions, environment-
  separated calibration heads, existing OFF/consent/model-selection semantics.
- Successful binding memory, SQLite handoff events/checkpoints, restart recovery,
  no replay of uncertain external effects, no authentication-gate fallback.
- Read-only MCP connection catalogue/probe: `runtime_browser_executors`.
- Clean guest bootstrap fixes: ownership of snap parent directories, bounded
  explicit shutdown with a referenced child, report preservation on cleanup error.

## Real acceptance

Sanitized evidence: `tests/evidence/phase85-browser-routing.json`.

| Environment / path | Result | Observed time |
| --- | --- | --- |
| Windows Aside / owned fixture collection | PASS | 16.456 s total on first run; 0.616 s extraction |
| WSL -> Windows Aside / owned fixture collection | PASS | 21.612 s total; 0.117 s extraction |
| Windows Neo unavailable -> Aside initial connection fallback | PASS | 9.336 s open + reads + navigation |
| Windows Aside / actual example.com | PASS | 8.650 s connection/open; repeat reads 0.123 / 0.024 / 0.032 s |
| Clean Ubuntu VM / actual example.com | PASS after bootstrap fix | 469.688 s first installation; 1.888 s connection + read |
| Native Neo | BLOCKED_ENV | Endpoint refused; installed browser fails SideBySide activation |
| Windows VM | BLOCKED_ENV | No licensed/configured guest or verified browser bridge |
| Windows foreground Playwright | FAIL / installation blocked | SideBySide event 33; Chromium 153.0.8010.12 cannot start |
| Final Windows Playwright launch failure -> Aside | PASS | 11.349 s open + reads + navigation; 43 ms failed launch, 10.000 s Aside open |

These are acceptance timings, not controlled engine rankings. Some native fixture
runs overlapped and include different setup costs. No new production calibration
or Jev-vs-LLM speed/quality comparison is claimed. Real engine-selection model calls
were not needed in these single-candidate/fallback runs.

The Ubuntu acceptance used a separate clean, uncredentialed guest with 1 GiB RAM,
1 vCPU, a 16 GiB overlay and separate ports. Product defaults were not reduced.
Both owned QEMU processes are stopped; existing personal VMs were untouched.
The first failure and its serial log remain preserved. Test overlays remain for
inspection, not running in the background.

Neo diagnosis: Windows Application SideBySide event 33 at
2026-09-28 18:05:18 KST reports unresolved win32 assembly 151.0.8160.137. The
installed binary signature is valid. Its profile was not removed, modified or
copied. The live Neo tool and configured MCP port both failed at transport level.
Neo's MCP contract tests use a fake server and are **not** native Neo acceptance.

An additional Windows foreground Playwright acceptance found the same type of
activation error for Chromium 153.0.8010.12 at 18:40:44 KST. This is separate from
the successful Linux/Ubuntu Playwright tests. Its native failure receipt is retained;
no Windows Playwright success is inferred from Ubuntu results.

## Regression evidence

- Initial targeted failure exposed an incorrectly invoked Playwright evaluation
  string; fixed and retested, previous FAIL retained.
- Expanded tests cover checkpoint restart/binding, effect fences, live pruning,
  work pause, real parallel storage isolation and real detached-child cleanup.
- Focused suite: `tests/evidence/runtime-tests-2026-09-28T09-26-31-261Z.json`:
  25 cases plus input-integrity check, 26/26 PASS.
- First full quick: `tests/evidence/runtime-tests-2026-09-28T09-26-49-080Z.json`,
  957/958. The failure was the expected decision-catalog list omitting the newly
  registered `browser.executor`; the exact CLI test was updated, not skipped.
- Focused correction suite: `tests/evidence/runtime-tests-2026-09-28T09-38-16-375Z.json`,
  39 cases plus integrity, 40/40 PASS, including the previously failing CLI case.
  LLM-corrected executor choices are explicitly labeled LLM with no borrowed Jev
  confidence; unapproved Swarm model-data paths do not construct routing providers.
- Full quick rerun (excluding `runtime-soak.test.mjs`):
  `tests/evidence/runtime-tests-2026-09-28T09-40-22-587Z.json`, **959/959 PASS**
  (958 cases plus unchanged-input fingerprint).
- After that full snapshot, a narrow follow-up classifies Windows pre-navigation
  `spawn UNKNOWN` / missing-browser failures as availability failures and gives
  the clean guest's `.config` parents the same explicit ownership as snap parents.
  Final focused suite: `tests/evidence/runtime-tests-2026-09-28T09-49-57-328Z.json`,
  **28/28 PASS** (27 cases plus unchanged-input fingerprint). The full suite was
  not rerun after this final narrow patch; VM website acceptance predates the
  `.config`-parent extension, whose generated bootstrap is regression-tested.
- Final native Windows receipt `phase85-windows-pw-aside-final.json` confirms
  startup failure is classified as unavailable and the runtime continues through
  Aside with fresh evidence. Standalone broken Playwright remains FAIL; it was
  not relabeled PASS because another executor succeeded. Aside fixture collection
  passed in 15.183 s, including 0.792 s extraction and 2.413 s owned cleanup.
- `npm run ledger:verify` passed (77 RQ); `git diff --check` passed.

## Remaining limits / resume

1. Neo/Aside route currently exposes reads/navigation/extraction/scroll, not the
   approved form-write protocol. Keep this limitation in user-facing capability
   descriptions; add approval-bound mutation adapters before calling them complete
   replacements for all Playwright actions.
2. Repair/reinstall Neo using its official distribution while preserving its
   existing profile, then repeat the native acceptance. Do not turn a refused
   endpoint or fake MCP test into a production pass.
3. Neo/Aside inside guests and Windows guest browser execution are explicitly
   unsupported until verified transport/ownership bindings exist. Do not attach a
   host browser under a VM label.
4. Gather matched-task outcomes before promoting executor-choice calibration.
5. Personal runtime upgrade, public merge and release were not requested here.

## Resume references and pinned versions

Read `docs/browser-executor-routing.md`, `prompts/phase-85-browser-executor-routing.md`,
`src/browser/executor-routing.ts`, `src/browser/mcp-executor.ts`,
`src/swarm/routed-browser.ts`, and both `tests/runtime-browser-*.test.mjs` files.

Node 22.22.0; npm 11.11.0; TypeScript 7.0.2; Playwright 1.63.0;
MCP SDK 1.30.0; TypeSafe SDK 0.6.0; package 0.2.0 unchanged.
Aside CLI 1.26.916.1741, daemon 1.26.926.2148.

Private raw receipts (not required for public installation): audit directory
`/home/<user>/.local/state/agent-driver-audit/20260928-resume/`, native artifacts
`C:/Users/<user>/projects/agent-driver-phase76-native/artifacts/phase85-*.json`, and
the two `agent-driver-phase85-vm-*` roots below
`/home/<user>/agent-driver-verification/20260928-resume/tmp/`.

## Follow-up: Neo-optional deployment audit

See `docs/release-readiness-phase85.md`. Fresh focused contracts passed 143/143
in `tests/evidence/runtime-tests-2026-09-28T10-17-43-075Z.json`. No implementation
was changed. The existing registered/running installation is still
`runtime-personal` (package 0.1.1), without the new browser routing or generic
desktop driver. The same actual host config loads in that installation but
fails in the candidate on the legacy top-level `workflows` field. Preserve and
migrate it; do not drop personal workflows to make validation pass.

Native approval wiring and host-wide input ownership gaps from Phase 83 remain.
53 installed stdio MCP processes were observed (RSS 5.49 GiB, PSS 3.52 GiB);
this is not yet attributed to a leak. No existing process was stopped.
The audit job finished with exit 0; its identity/log is
`phase85-release-contract-audit-2026-09-28T10-17-42-956Z` in the audit directory.
Neo is optional, but omitting it does not close the other release gates.
No installed-runtime replacement or publication occurred.
