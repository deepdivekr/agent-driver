# Phase89 — public v0.3.0

## Scope and candidate

Publish common functionality for Ubuntu 24.04 x86_64 / Windows 11 WSL2 Ubuntu.
Native Windows all-app control and macOS remain unverified/experimental.
Private installations, workflow implementations, credentials and schedules are
not publication or deployment targets.

English/Korean README shortened to installation, connection, first Work and
explicit limits. Default installer/package aligned at 0.3.0.

## Release fixes

- Added the v0.2.0 upgrade baseline beside v0.1.0, v0.1.1 and fresh installation.
- Installation probe accepts the three generic compatibility tools, not private
  workflow code, and stops only its disposable shared service.
- Shared-service reuse rejects different package versions and old receipts.
  Explicit stop refuses connected clients and preserves endpoint/token on restart.
- Historical private test receipts have public digest/count summaries in
  docs/validation/v0.3.0-history.json. Raw logs remain local and failures remain.
  The ledger references shipped evidence rather than missing ignored files.

## Verification so far

Build passed. Focused lifecycle/public-boundary suite: 10/10 checks passed
(9 cases and input integrity), including real protocol clients and owned
shared-process start/stop/restart. Evidence:
`tests/evidence/runtime-tests-2026-09-28T13-26-38-190Z.json`.

Final quick regression, four install/upgrade scenarios and remote CI/publication
were pending at the first commit. All four real install scenarios subsequently
passed on candidate 5a30c5c; receipt:
`tests/evidence/release-install/2026-09-28T13-31-44.468Z.json`.
Initial GitHub CI 36430504154/36430499776 failed before tests because three older
ledger entries still referenced ignored tests/report.json. Their shipped phase
records and digest summaries remain the public evidence; the local report is
not deleted or published. No tag/release/main update yet. The existing open PR29 is not
silently merged; its unreviewed README/UI/auth changes remain separate.

## Final-candidate follow-up

Local quick finished 999/1000 checks: only the release-metadata contract failed
because docs/first-run.md still linked to the previous installer. Input integrity
passed. Initial local receipt:
`tests/evidence/runtime-tests-2026-09-28T13-31-38-769Z.json`.
GitHub run 36431024929 caught the same documentation defect.
The link is corrected without weakening the test.

The final review also tightened Claude's subscription classifier: even a
firstParty/claude.ai status cannot override a reported API-key/helper source.
Unknown nonempty source types remain unverified; no CLI invocation follows.
This does not add support for unreviewed auth methods from PR29.

Final build and focused authentication/continuity/release checks: 64/64 PASS
(63 cases plus input integrity), zero BLOCKED_ENV/NOT_RUN.
`tests/evidence/runtime-tests-2026-09-28T13-56-45-827Z.json`.
Production dependency audit reports zero vulnerabilities.
The shipped-source ledger passes without local ignored files.
Final all-suite and four-scenario installation confirmation is required on
the final GitHub candidate and again on main before automatic release.

## Resume

## Catalog startup race

On candidate 70e1e76, push CI 36432550881 passed 1001/1001 quick checks and
all four installation scenarios. PR CI 36432556408 failed one coding-model UI
case: the Codex dropdown never acquired its model options. Both receipts remain.
The initial API catalog request could occupy the action lock and drop the
timer-based client discovery while prematurely marking it loaded.
Step initialization now awaits discovery inside the same action; loaded flags
are set only on success. Returning after a failed catalog request retries it.
Two explicit latency/retry regression cases were added. Both fail against the
prior production UI and pass against the correction. The affected settings
and control-action browser suite passed 12/12 cases locally, including desktop
and mobile; settings HTTP/contracts plus input integrity passed 26/26.
The frozen pre-fix local full run finished 1000/1001: its only failure was the
wizard test asserting an install button's count immediately after the heading
appeared, before asynchronous discovery finished. The test now waits for that
same required button (no removed assertions). Its original receipt is retained:
`tests/evidence/runtime-tests-2026-09-28T13-59-41-018Z.json`.
Final CI must pass again; a prior successful run is not substituted.

Read docs/release-readiness-v0.3.0.md, scripts/release/verify-install.mjs,
scripts/release/install-probe.mjs and src/interface/mcp-service-manager.ts.
Preserve candidate input while tests run; no soak or paid model calls.

Pinned: Node22.22.0, npm11.11.0, TypeScript7.0.2, Playwright1.63.0.
