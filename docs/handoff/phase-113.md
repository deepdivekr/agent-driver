# Phase 113 — client updates and exact model defaults

Local implementation and validation only. These uncommitted changes are not included in the immutable public v0.4.0 release.

## Actual local changes

- WSL npm Codex 0.147.0 → 0.159.2; npm Claude 2.1.284 → 2.1.285, through official npm global updates.
- Windows npm Codex 0.141.0 → 0.159.2; native Claude 2.1.283 → 2.1.285, through their existing installation managers.
- WSL Cursor CLI 2026.09.28-64d2043 and OpenCode 1.18.33 were already current according to their official update commands.
- Native user defaults in both environments: `gpt-6.1-sol` / `low` and `claude-sonnet-5-5`. Existing Claude effort choices, credentials, other project settings and CLI sessions were preserved.
- Current WSL app-server catalog lists GPT-6.1 Sol and supports low effort. One actual subscription-only typed GPT-6.1 Sol / low response succeeded in 7.084 seconds. No tools, external effects, Jev or paid API were invoked by that probe.
- Both Windows and WSL Claude report signed out. Sonnet 5.5 is configured, but its actual account/model response is **BLOCKED_ENV** pending official login. Do not reinterpret an API provider or missing auth as subscription readiness.
- Windows desktop-bundled Codex 0.159.0 was not overwritten. Active WSL Hermes and the modified Windows Hermes Git checkout were not updated; Windows OpenCode/Cursor CLI were not newly installed.

## Common implementation

New subscription settings default to exact requested models, while saved API, coding, role and native-session choices retain their meaning. A failed catalog refresh or missing exact model never silently substitutes another model or activates paid API use.

The existing Control Center owns CLI maintenance. Saving the UI preference authorizes automatic checks while the runtime is open: every 24 hours, 6-hour failure cooldown, 15-minute busy deferral. Status GETs do not authorize writes. Manual update also works with automatic mode off or initially unsaved settings. Supported user-owned Linux/WSL clients use their official updater; missing or unmanaged clients, Hermes and Windows automatic updates are skipped.

The same user's hosts share an exclusive lock. Stale owner recovery is serialized and verifies the original owner token; live locks are not stolen. A crashed `.reap` recovery lock fails closed until an operator checks that exact lock. Work admission, internal scheduled ticks, model discovery, auth and reload are fenced while maintenance runs. Shutdown drains an updater even after an I/O failure. Only bounded fixed progress messages enter the Korean/English setup stream; raw process output and credentials do not. UI refreshes actual model catalogs after live completion events while preserving selections.

## Verification

- Build and strict TypeScript check passed.
- Maintenance-specific fixture integration: 9/9 PASS, including Windows USERPROFILE-only preference saving and unsupported-updater/no-HOME guards. Temporary homes and fake updater processes are not actual provider certification.
- New-model and settings desktop/mobile suite: 13/13 PASS. Real local Chromium at 1440/390px and sixteen localized theme/viewport combinations, with fixture auth/catalog/update services.
- HTTP maintenance, supervisor/scheduler fence and related Work/control tests: 22/22 PASS. The queued Work resumes the same run after the fence clears.
- Actual readback `tests/evidence/phase113-native-snapshot.json`: all four WSL client versions, exact model defaults, persisted auto preference, supported installation eligibility and busy deferral; no updater/model/API call in the snapshot.
- First whole quick after this change:1765/1769 PASS with stable inputs; four catalog/default/active-client save regressions were repaired without loosening unsupported active-Codex rejection. The earlier1756/1757 result and UI enabled-state race are retained.
- Next quick `runtime-tests-2026-09-30T15-07-46-805Z.json` reports1770/1770 PASS (unit541, contract_fake660, fixture_integration372, native_integration197), stable inputs, but needed SIGTERM to its own layout-test process2263414 and Chromium2264307 to release a shutdown hang. This is **assisted, not unattended completion**. No personal process was targeted.
- Ten fixture files now await the async settings close at13 call sites and close their own HTTP connections before server shutdown. All original assertions remain. Related real Chromium/HTTP fixture suites52/52 passed and all their children exited naturally.
- Final frozen **standard concurrency1 quick1770/1770 PASS**: `tests/evidence/runtime-tests-2026-09-30T15-25-31-683Z.json`; unit541, contract_fake660, fixture_integration372, native_integration197. All1001 input fingerprints remain identical to current source/dist/tests. Session59001 and runner2288641/2288648 exited naturally with code0; no signal or browser intervention was used. Long soak remains excluded.
- Native observations in `tests/report.json` are3 user_environment PASS (WSL versions/defaults/deferral, Windows versions/defaults, exact Codex response) and1 user_environment BLOCKED_ENV (actual Claude response needs login). The previous assisted shutdown is additionally retained as its own native_integration FAIL, not erased by fresh passing tests. Ledger196 and `git diff --check` pass.

## Preserved Phase 112 work

The 24 registered matrix Work IDs and their failed/partial receipts remain intact. The isolated matrix was changed to GPT-6.1 Sol / low through the normal settings loader, with prior model history retained. Its service is the only owned live matrix worker; use the explicit `OFFICE_MATRIX_RECEIPT=tests/evidence/phase112-matrix-session.json` for all actions. The harness's printed receipt label is hard-coded and is not authoritative.

During resumption, the earlier one-Work weather test was inadvertently started through the harness's default receipt, remained `waiting_connection / CONFIG_CHANGED`, and was stopped cleanly before use. The actual matrix services PID2231562/session68431 and later PID2265312/session71367 were paused normally and stopped cleanly. No matrix service is left running. No personal process, VM or browser was stopped.

Two existing forms resumed but paused because the final validator still rejects no-external-effect proof. Support requires independent no-effect proof for the earlier RESOURCE_BUSY invocation; Evaluation requires its closed host-controlled trace and draft-only evidence in the bounded final verifier. File-311's undefined-property serialization error was repaired and3/3 focused regressions passed; its actual same-Work retry now reaches `awaiting_review`, not `INVALID_TASKPACK_VALUE`. Complete-source proof and the spent correction budget remain unresolved. Independent E2E completion is **0/24**. No release readiness is claimed.

Subsequent read-only file311 diagnosis: the preserved12-row source contains6 Closed rows; its6-row CSV matches the entire Closed identifier set and all six requested columns, ascending created_date, artifact SHA and original bytes. Applying the current host-native certificate independently confirms source12/filter6/output6 and exact bytes. The old status receipts were created before this build and lack `executed_contract`/`native_output_certificate`; the failure is missing current proof in the verifier input, not demonstrated missing data coverage. Do not backfill old receipts. A normal explicit direction/replan or host-authorized verification episode must obtain a fresh status for the same Pack run through `execution-tools.ts:728-737`, then verify the certificate/contract against the original user conditions. `user_goal_verified:not_asserted` remains intentional; this read-only diagnosis is not Work completion and does not bypass the spent repair budget.

## Read next

`prompts/phase-113-cli-maintenance.md`, `src/onboarding/client-maintenance.ts`, `src/onboarding/model-settings.ts`, `src/observability/control-settings.ts`, `src/observability/settings-ui.ts`, `tests/runtime-client-maintenance.test.mjs`, `tests/runtime-cli-maintenance-settings.test.mjs`, then Phase 112's handoff and private matrix receipt.

Next: official Claude sign-in can unblock the exact Sonnet5.5 response check; resume Phase112's existing matrix proof/coverage repairs without resubmitting Works or weakening acceptance. A new public release is not authorized by this CLI-maintenance verification result alone and the actual24-case acceptance is unfinished.
