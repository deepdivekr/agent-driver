# Phase 78 — verified procedures and focused Windows observation

## Scope and implementation

Use the product-owned Windows CUA runtime, not Codex Computer Use. The user's
priority was saved procedures, relevant-region observation and fewer duplicate
reads. The authoritative checkout remains `release-v0.2.0`, with pre-existing
uncommitted Phase 70–77 changes preserved. No commit, publish or deployment.

- RQ-750: typed, bounded SQLite locator/judgment metadata; seven-day expiry,
  hash/schema/version checks, 512-row cap. Successful independent action readback
  is the promotion gate. No saved permission or live input token.
- RQ-751: read-only native UIA helper, lazy hidden runtime-owned process. Exact
  HWND/PID/title/process start/field identity checks. CUA remains the input owner;
  each action needs a fresh CUA snapshot. Relevant field reads remain before and
  after input. One read-only rediscovery is allowed on initial locator mismatch,
  not after approval or an uncertain effect. Completed-turn tokens are discarded.
- RQ-752: semantic steps use the existing Pack-owned model policy. Optional LLM
  condition design is saved only after independent success; verified repeats
  skip design while Jev judges current bounded state/target. Uncertain judgment
  goes to LLM correction; repaired conditions are untrusted until verified.
  Exact reviewed native fields still use zero models. No new Work on/off policy.
- CUA 0.30.2 `query` is a returned projection after the tree walk. Native focused
  reading uses an independent read-only UIA provider query, not a claimed cheap
  CUA tree API. Internal provider traversal cost is unmeasured.
- Question/catalog version increased to 2. This is not an accuracy calibration
  result: the current probability thresholds remain provisional.

## Verification and retained failures

- Pinned Node 22.22.0 (Windows and WSL), npm 11.11.0, TypeScript 7.0.2,
  CUA 0.30.2, TypeSafe SDK 0.6.0. Windows default Node 24 was not used for acceptance.
  Portable Node 22.22.0 was installed in the app's tool directory after checking
  its archive against the official SHA-256 manifest.
- Initial TypeScript build failed on an exact-optional-property assignment;
  corrected the declared union, retained the audit log. Subsequent build passed.
- Initial focused suite: 104/104 PASS.
- Expanded suite: 110/111. The settings-change fixture omitted its synthetic
  Jev credential and failed `JEV_CREDENTIAL_REQUIRED` before testing cache logic.
  Retained `tests/evidence/runtime-tests-2026-09-28T02-50-17-609Z.json`.
- Corrected fixture: **111/111 PASS**, at
  `tests/evidence/runtime-tests-2026-09-28T02-52-06-696Z.json`.
- Added a further regression proving a completed turn cannot lend its live CUA
  token to the next turn, even within one still-running driver.
- Final full quick: **826/826 PASS** (825 cases plus input integrity), zero
  BLOCKED_ENV/NOT_RUN, at
  `tests/evidence/runtime-tests-2026-09-28T02-52-53-765Z.json`.
  The audit process `phase78-quick-2026-09-28T02-52-52-189Z` exited 0.
  Long soak remains excluded. Tests were not changed during the run.
- Native exact-field comparison: full 7,059 ms, first focused 3,105 ms, persisted
  repeat 3,014 ms. All independently read back the requested value and exited
  their owned processes. Each used zero new LLM/Jev calls. Individual samples,
  not a latency distribution or proof of universal second-run speed.
- Final same-build native comparison: full **6,191 ms**, persisted focused repeat
  **3,070 ms** (about 50% shorter). Including test app/MCP startup and cleanup:
  12,491 ms versus 6,415 ms. Final input-time focused probe 17 ms, independent
  readback 37 ms. Each native action still obtains one fresh CUA snapshot/token.
- Actual closed-target injection was refused before input in 687 ms,
  `needs_review / WINDOWS_FOCUSED_WINDOW_CHANGED`. CUA was not even started;
  the hidden read-only helper exited. A new, explicitly granted test window then
  completed in 2,697 ms with a cache miss, demonstrating invalidation/rebinding,
  not blind replay of the refused action.
- Seven native cases: six verified draft executions and one expected refusal.
  All launched MCP/CUA/helper/test-window processes exited. No model calls,
  clipboard copy, file save, authentication, screenshot or external message.
  Sanitized record: `tests/evidence/phase78-windows-repeat-native.json`.
- `tests/report.json` preserves the earlier failed cases and includes native
  evidence separately. Ledger verifies **47 RQs**; `git diff --check` passed.

## Limits and next files

The real actuator remains reviewed `windows.form.draft`, not all Windows apps,
Kakao self-chat, authentication, messages, or all ten Windows workflow profiles.
Other apps need separate verified adapters. Semantic design/reuse/correction
was verified with fixture providers; live Jev latency/accuracy is not claimed.
The existing ready Work was reused for native execution. No new natural-language
intake latency is included in the step measurements. A completed Windows step
does not certify all Work-level completion checks.

Read `src/desktop/windows-procedure.ts`, `windows-focused-reader.ts`,
`windows-focused-script.ts`, `cua-field-driver.ts`, `native-field-driver.ts`,
`windows-runtime.ts`, and `docs/owned-windows-executor.md` first. Private Windows
host grants, test-window IDs and raw reports stay outside the public checkout.
