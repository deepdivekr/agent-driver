# Phase 71 — Work-driven local file tools

## User decision

Do not make Desktop cleanup or a file manager a primary page. The user gives a normal Work prompt; the connected agent uses the file tools and reports precise results. The initial standalone UI was removed after this clarification. Only contextual access/approval/results appear inside the existing Work detail.

## Completed

- RQ-719: persisted narrow folder grants, incremental bounded scans and conservative protected paths/files.
- RQ-720: observed metadata and optional text excerpts; inference/evidence contract for the connected agent. No model upload/call initiated by these tools, no separate Jev planner.
- RQ-721: MCP move proposals require Work identity; review, pause fence, project/Work binding, exclusive copy/hash readback, durable claim and undo. Unknown interrupted copies never replay automatically.
- RQ-722: Work definition advertises tool workflow; existing file.pipeline may still use ordinary Pack planning for transformations. Access and move approvals live in Work detail; runtime_files_report reports actual moves, restored files, protected items and partial-scan limits. No standalone navigation or /files page.

## Verification and fixes

Pinned Node 22.22.0, TypeScript 7.0.2, package 0.2.0 unchanged. WSL execution failed with Wsl/Service/E_UNEXPECTED; do not restart all WSL services to hide this. A Windows build mirror was used with the pinned Node and native TypeScript compiler. Full strict build passed.

25 focused tests passed: 14 file core/boundary tests, Work-bound HTTP/MCP integration, fixture-model definition contract, existing Work and AI-data-consent regressions. Exact per-case evidence and earlier teardown failures: tests/evidence/phase71-work-file-tools.json and tests/report.json. Earlier fsync/read-only handle and template JavaScript errors remain in tests/evidence/phase71-first-regression.json. Windows test cleanup now closes all DB/server handles before removing owned temporary directories; assertions were not weakened.

Actual Control Center browser test used synthetic files outside the user's real Desktop: access grant → MCP scan/classify/propose → pause/disabled approval → resume/move → content/path check → undo → restart/read persisted result. Recent file preserved. Desktop and mobile tested; no preview streams or extra VMs. Planning definition was a fixture and this does not measure live LLM/Jev interpretation quality. TypeSafe guidance influenced the evidence/inference distinction; no synthetic probabilities or mandatory Jev calls.

## Remaining

- RQ-723 partial: rerun on Linux and validate the installed personal runtime when WSL execution recovers. This checkout is not deployed/published. Existing Phase 70 incomplete full quick regression remains unchanged.
- Existing connected-client dispatch is required. A Work definition alone does not start a hidden autonomous file worker.
- App database/history adapters, PDF/Office extraction, OCR and verified origin context are not implemented. Filesystem timestamps are not authorship evidence.
- File receipts appear in Work board/status/detail and compact handoff after the audit below. They are not a full autonomous Pack run or proof that every Work completion check passed.
- Permissions are narrow folder grants. Cross-host desktop control, malicious same-user races, ACL/alternate-stream preservation and atomic multi-file transactions are not promised.

## Read next

1. docs/local-file-explorer.md
2. src/files/explorer.ts
3. src/observability/work-file-ui.ts and files-http.ts
4. src/work/runtime.ts, src/interface/mcp.ts
5. tests/runtime-local-files.test.mjs and runtime-files-http.test.mjs

Preserve unrelated Phase 70 changes and install.sh. All created test services are owned temporary instances, not the user's WSL service. No real Desktop files were moved; no external messages, paid model calls, commits, deployment or release were performed.

Final ledger verification passed (17 RQ recorded), JSON evidence parsed and git diff --check passed. Owned preview servers and the test browser tab were closed after verification; the browser viewport override was reset. Earlier standalone-page screenshots are obsolete; the final validation used the Work detail.

The new core tests were separated into tests/runtime-local-files.test.mjs after a filename collision was found. The original tests/runtime-files.test.mjs was restored byte-for-byte (normalized line endings) to its pre-task HEAD contents. The separated file matches the previously verified bytes and passed an additional 14/14 rerun (30,710 ms); existing broker tests were not removed or replaced. Legacy broker MCP names use their existing path, not the new runtime_files_* dispatch.

## Follow-up purpose/correctness audit

User requested verification of the new feature against the app's purpose. Read docs/local-file-tools-audit.md and tests/evidence/phase71-purpose-audit.json first.

- Reproduced record loss after 101 unrelated access records and report contamination by another Work's newer scan. Fixed scope-before-limit SQL and persisted bounded Work observation summaries. Proposal summaries retain their scan identity; legacy unbound scans are not falsely attributed.
- File approval/result/uncertainty now projects into Work status/board/detail and next-client continuity receipts. An old uncertain plan still blocks blind replay even when it is outside the compact receipt window. No Work completion is fabricated from file moves.
- Restored human revocation in Work detail, with reusable scope explanation. No separate navigation, background watcher or model loop. Exact Work/plan approval lookup is independent of report pagination.
- Board polling uses a small projection and cached file-store wrappers; it does not load whole scan arrays. Windows migration test handles now close before temporary directory deletion; native junction coverage replaces only the Windows file-symlink setup (Linux retains its file-symlink case).
- Final strict compile passed. Focused suite: 47/47 PASS, 280635.1191 ms. Final HTTP/Work rerun after UI wording/MCP contract edits: 6/6 PASS, 50436.9306 ms. The initial incomplete run and four failures are preserved. No assertion was removed or marked green without rerun.
- Actual browser test with synthetic files: allow → scan/propose → pause/disabled approval → resume/move → verify bytes/paths and recent-file preservation → undo → revoke → historical receipt retained. Mobile 390px did not overflow (scrollWidth375). Final English header correctly says File operation records, not run not started; no standalone Files entry.
- Neo transport was unavailable; an owned Codex in-app browser tab was used. Temporary UI servers exited normally after tests, tabs closed and viewport reset. The first UI helper was interrupted by a tool-kernel reset before interaction; its journal/log was retained, and it was confirmed no longer running before another helper was started.
- A fresh WSL /bin/true probe stalled and was cancelled. Do not claim Linux or the installed personal runtime passed. No WSL service restart, paid model call, real Desktop mutation, commit, publish or deployment was performed.

Pinned Node/TypeScript/package versions unchanged. Preserve unrelated Phase 70 and install.sh changes. RQ-723 remains partial until Linux and installed-runtime checks can run; the existing full quick-suite release gate remains open.

Audit closure: npm run ledger:verify passed in the actual checkout (17 RQ), git diff --check passed, accumulated report/evidence JSON parsed, and the original broker test remains unchanged. The final presentation-only verification server also exited 0 and removed its owned synthetic fixture folder. No verification server remains running.
