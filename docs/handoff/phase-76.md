# Phase 76 — Windows native connection and interrupted acceptance

## Source and versions

- Authoritative source: `/home/<user>/projects/agent-driver/release-v0.2.0`, branch `release/v0.2.0`, HEAD `d69c8e64b09e8d257773b57ec81cf05b069b09a3` plus preserved dirty Phase 70–76 changes.
- Node 22.22.0, npm 11.11.0, TypeScript 7.0.2, package 0.2.0 unchanged. No commit/push/release.
- Current compiled dist staged at `C:/Users/<user>/projects/agent-driver-phase76-native`; Windows dependencies junction points to the preserved Phase 73 candidate's matching pinned node_modules. This is a local acceptance host, not the installed production MCP.
- Skills: Computer Use for all Windows UI actions; TypeSafe for bounded judgment/evidence separation; Runner for durable verification logs.

## RQ checklist (verbatim)

- [x] RQ-741: Connect a trusted window-bound native Computer Use adapter to WindowsWorkflowRuntime, with fresh observations, app/Work binding, explicit effect scope and no arbitrary shell or unbounded desktop fallback.
- [x] RQ-742: Verify bounded dispatch, target freshness, one-use approvals, independent result readback, uncertain-effect reconciliation and disconnect behavior with regression tests.
- [ ] RQ-743: Run a real harmless Windows input test through the product runtime, recording executor identity, stage timings, observed evidence and actual model participation; do not replace unavailable native observations with fixture facts.
- [ ] RQ-744: Inspect KakaoTalk self-chat readiness without affecting other recipients; require action-time confirmation before any real message send, and preserve unverified/blocked outcomes distinctly.
- [x] RQ-745: Update connection/acceptance documentation, status, report and handoff with exact supported scope and remaining limitations; keep personal observations and credentials out of public source.

## Completed

- Added host-injected `Window2FieldDriver`: exact returned window/app/title, exact editable label and automation ID, expiring Work scope, one-use local-draft review, independent value readback and durable uncertain-effect journal. Raw UI values/trees are not sent to the model. No arbitrary coordinate, shell or external-send support.
- Native catalog reports only `windows.form.draft` as supported and still reports app coverage unverified. Disconnect is visible in catalog. A disconnected driver's step currently holds with an observation failure; no input is issued.
- Strict build passed. Focused 70/70 checks passed: 69 cases and input integrity, including 18 new adapter cases. Evidence: `tests/evidence/runtime-tests-2026-09-28T01-26-17-525Z.json`.
- Initial focused run failed 10 cases because the canonical command hash included undefined keys. Fixed by omitting ephemeral keys rather than assigning undefined. Original failures preserved: `tests/evidence/runtime-tests-2026-09-28T01-25-28-789Z.json`.
- Real native connection and real subscription Work intake succeeded. Work `6e3f2129-db98-481e-8852-26bb5ff7947b`, request `phase76-character-map-native-001`, ready, family `form.draft-submit`. 17.494s total definition, 17.343s provider, one actual Codex subscription call, client_default model. Token counts unobserved. Jev disabled only for this isolated acceptance config; global settings were not changed.

## Interrupted / do not claim pass

- At the fresh Character Map observation, tool returned: `Computer Use was stopped by the user with the physical Escape key.` No further UI calls were made. No form input, file save, clipboard copy, message draft or message send occurred.
- Character Map exposes an actual editable value. Modern Notepad returned accessibility null. KakaoTalk showed only shallow window containers, not independently verified self-recipient or message controls. No fabricated evidence or fixture facts were substituted.
- `tests/evidence/phase76-native-acceptance.json` and `tests/report.json` distinguish real connection/intake PASS from input and Kakao send NOT_RUN.
- Full quick regression on this changed source and public deployment remain not run. Previous 766/766 quick baseline belongs to the earlier source fingerprint.

## Resume after explicit user request

1. Re-select fresh Windows windows through Computer Use; do not reuse old UIA indexes or screenshots. The prior empty test Notepad and Character Map may still be open; preserve the user's separate unsaved README Notepad.
2. Reuse the isolated host config `C:/Users/<user>/projects/agent-driver-phase76-native/host-native-acceptance.json`, Work and SQLite journal under `acceptance-data`. Work was already created: avoid another model intake. There is no Windows run or native input action yet.
3. Bind the reviewed non-sensitive local Character Map field from fresh evidence; create the Windows run using the same Work/request ID. Review the exact local draft, perform one input, independently read back, record stage timings and real model participation. No blind replay after uncertain effects.
4. Kakao needs an independently verified per-app self-recipient/readback adapter; any actual message requires exact action-time user confirmation. Current native field adapter explicitly excludes chat apps.
5. Run full quick (not long soak), update evidence/status and verify ledger. No publish without explicit release scope.

Read first: `prompts/phase-76-windows-native.md`, `src/desktop/window2-field-driver.ts`, `src/desktop/windows-runtime.ts`, `tests/runtime-window2-driver.test.mjs`, `docs/windows-task-pack.md`.
