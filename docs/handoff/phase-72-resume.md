# Phase 72–75 verification resume — 2026-09-28

Status: local WSL verification complete; native Windows executor acceptance remains incomplete. This is not a release or deployment.

## Recovery and source ownership

- Authoritative checkout: `/home/<user>/projects/agent-driver/release-v0.2.0`, branch `release/v0.2.0`, starting HEAD `d69c8e64b09e8d257773b57ec81cf05b069b09a3`.
- Windows preserved candidate: `C:/Users/<user>/projects/agent-driver-phase73`, baseline `b7f2f3e0b99ec291ab4b55a99765106dc1d67244` plus uncommitted Phase 73–75 work.
- Both non-ignored source trees were archived before changes. Recovery archives and merge plan are in `/home/<user>/.local/state/agent-driver-audit/20260928-resume/` (`wsl-before.tar.gz`: 414 paths; `windows-before.tar.gz`: 468 paths).
- 58 incoming paths transferred with three-way comparisons. Two overlapping hunks were explicitly resolved to retain both Work execution binding and Windows profile discovery. WSL-only dispatch, folder-path and UI edits remain present.
- Ubuntu and UNC access recovered. Observed 7.8 GiB WSL RAM, 6.8 GiB available, 2 GiB unused swap. The approved 8 GiB cap is effective. No unrelated services were stopped or restarted in this resume.
- Historical interrupted quick log remains `tests/evidence/phase72/baseline-quick-interrupted.log`. The previous outage cause is not proven.

## Exact resumed requirements / TODO

- [x] RQ-724: Audit the nine Pack families and the complete new-Work, Pack and executor selection path; fix missing or misleading dispatch behavior without widening authority.
- [x] RQ-725: Verify workflow/bot imports and optional LLM enhancement end to end, including consent, idempotency, source preservation and actionable next steps.
- [x] RQ-726: Diagnose WSL availability and recover only within the affected environment; preserve unrelated services and record any remaining recovery requirement.
- [x] RQ-727: Run the full quick regression without long soak, fix relevant failures, and validate installation, onboarding and the supported runtime paths.
- [x] RQ-728: Publish a local evidence-backed readiness assessment, update documentation/status/handoff, and distinguish fixture, native and user-environment checks.
- [x] RQ-729: Introduce versioned client capability contracts and use them for structured-judgment dispatch, preserving saved models, client-owned authentication and existing billing boundaries.
- [x] RQ-730: Join concurrent connection and authentication probes, invalidate changed or failed state, and prevent duplicate or orphaned login processes after cancellation.
- [x] RQ-731: Harden handoff receipts and failure classification so invalid output, stale binding or uncertain effects cannot be reported as a successful transfer or silently retried as a provider outage.
- [x] RQ-732: Verify connection, cancellation, recovery and persisted handoff behavior with isolated tests; document Atlas-derived invariants, source provenance, evidence levels and remaining environment limitations.
- [x] RQ-733: Define ten reusable Windows workflow profiles with inputs, ordered steps, completion evidence, Jev judgment points and explicit effect boundaries under existing Pack families.
- [ ] RQ-734: Implement a bounded Windows workflow runner with fresh target selection, optional Jev and LLM correction, Work/config binding, durable receipts, pause checks and no blind replay of uncertain effects.
- [x] RQ-735: Expose Windows workflow discovery and execution readiness through MCP, reuse existing model settings and Decision Plane telemetry, and never claim an unconnected native executor is ready.
- [ ] RQ-736: Verify all ten profiles and failure boundaries; attempt the authorized KakaoTalk self-chat flow when the Windows surface is available, and report native versus fixture evidence separately.
- [x] RQ-737: Audit the twelve Jev use cases against actual call sites and current official guidance; select useful gaps without duplicating existing memory, routing or calibration systems.
- [x] RQ-738: Add source-bound citation and extraction verification to collection Packs, with deterministic fast paths, bounded semantic batches, configured LLM correction and explicit unverified results.
- [x] RQ-739: Add optional relevance-based Work reference selection that retains source excerpts verbatim, preserves all mandatory continuity constraints and obeys existing Pack/model consent and opt-outs.
- [x] RQ-740: Verify semantic decision boundaries and end-to-end wiring using repeatable regression cases; preserve failures, document evidence levels and avoid claims of live accuracy, speed or deployment without measurements.

## Execution and evidence

- Pinned Node 22.22.0 / npm 11.11.0 / TypeScript 7.0.2; package remains 0.2.0. Initial merged build and `git diff --check` passed.
- Durable verification supervisor: recovery directory `run.mjs`; every process has its own PID, metadata JSON and log. Actual test work goes under `/home/<user>/agent-driver-verification/20260928-resume/tmp`, not auto-cleaned `/tmp`.
- Initial focused run: 133/153 checks passed, 20 failed. Raw report `tests/evidence/runtime-tests-2026-09-28T00-34-06-475Z.json` retained. TAP isolation identified `FILES_PROTECTED_FOLDER`: the initial supervisor TMPDIR was under `.local`, which is deliberately excluded from folder grants. Move the synthetic test folder, do not weaken production protection.
- Corrected focused rerun: **153/153 checks PASS**; evidence `tests/evidence/runtime-tests-2026-09-28T00-36-08-893Z.json`.
- Historical interrupted/failing groups (adaptive Pack, backup, installer and browser auth): **59/59 checks PASS**; evidence `tests/evidence/runtime-tests-2026-09-28T00-36-59-652Z.json`.
- First full quick: **759/765 checks PASS; 6 FAIL**; evidence `tests/evidence/runtime-tests-2026-09-28T00-37-46-838Z.json`.
- Fixed a real Work-detail regression: an unconditional file-report read enforced UUID-only command validation on legacy Swarm/coding IDs. File activity is now checked before the UUID-only report command. Added an HTTP regression for legacy Swarm IDs; file Work validation is unchanged.
- Updated two UI fragment tests to load the actual file panel/helper boundary. Existing assertions remain; no timeout or production safety guard was weakened.
- Focused fix acceptance: **32/32 checks PASS**; evidence `tests/evidence/runtime-tests-2026-09-28T00-45-55-548Z.json`.
- Final full quick: **766/766 checks PASS; 0 BLOCKED_ENV; 0 NOT_RUN**. This comprises 765 test cases plus source-input integrity. Evidence: `tests/evidence/runtime-tests-2026-09-28T00-46-23-400Z.json`. By evidence level: unit 277, contract_fake 207, fixture_integration 149, native_integration 133. These are independent classifications, not 766 live model/app calls.
- Final acceptance rehashed all **700 recorded source/build/test inputs** against the passing report. No changed test inputs were accepted after the run.
- Real installer: fresh candidate and upgrades from v0.1.0/v0.1.1 all PASS. Actual npm ci/build, Chromium, absolute wrapper from another directory, stdio MCP version/catalog, Work identity, model preferences and Pretendard loading verified. Evidence: `tests/evidence/release-install/2026-09-28T00-51-43.424Z.json`.
- Installer source was a disposable committed snapshot `c1c546db48fce81a5df6576622d79f7a48ea0020` of the current dirty tree. Original branch HEAD remains unchanged; no public tag or branch was pushed. Work models in install probes were fixtures; external model calls **0**.
- Real Neo Control Center / authoritative WSL runtime: narrowed access to a synthetic Windows folder, pause/resume, approved move, hash-checked undo and permission revocation all verified. Recent file remained untouched; original path/content restored. No personal Desktop data used. Evidence: `tests/evidence/phase72-resume/files-ui.json`.
- Desktop/mobile UI regressions passed. Manual Neo page readback at 847 × 726 had no horizontal overflow; action results matched the file report.
- Preserved Windows report history: **874 cases added** without replacing original results. Two same-name old screenshots were archived under `tests/evidence/windows-resume-20260928/`. Both source archives and all failure logs retained.
- Long soak excluded by user request. The successful quick total does not include the separately recorded unconnected native-Windows and unrun live-model cases.
- Final resource sample: 7,942 MiB WSL RAM, 6,487 MiB available; 2,048 MiB swap with zero used. Free filesystem space: 23 GiB. This sample does not prove the cause of the previous outage.
- Machine-readable acceptance: `tests/evidence/phase72-resume/summary.json`. Test and installer processes exited; the separately tracked synthetic UI server (PID 11638) received SIGTERM and exited cleanly with code 0. No verification server remains running.
- `npm run ledger:verify`: 34 RQs recorded; `git diff --check` passed. Publication-pattern scan passed for 442 non-ignored files with zero findings; this is not a complete secret/privacy guarantee. Desktop and mobile onboarding captures were visually reviewed.

## Limits

- No paid model calls, personal-file mutations, public release or unrelated service restart authorized by this resume alone.
- Windows workflow contract tests are not native app verification. A packaged native executor and live Kakao acceptance remain separate from these contracts.
- Historical Windows evidence was preserved alongside new Linux results. Historical RQ-707–713 release records remain unchanged.
- Read-only Computer Use now successfully lists the KakaoTalk window. This resolves the prior agent-tool startup error, but **does not connect that tool as Agent Driver's Windows executor**. No Kakao input or message was sent.
- RQ-734 / RQ-736 remain partial: implement and bind the native Windows executor, verify observation/dispatch/reconciliation on a synthetic app, then perform an explicitly confirmed self-chat test.
- Live Jev/LLM quality, latency and provider usage were not evaluated in this acceptance run. Passing typed fixtures is not calibration evidence.
- Existing runtime/other services were not redeployed. Latest changes are verified locally but remain uncommitted in the authoritative checkout.

Read first after interruption: this file, `docs/status.json`, the recovery directory's latest process JSON/log, then the corresponding Phase 72–75 prompts.
