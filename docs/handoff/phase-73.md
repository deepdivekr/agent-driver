# Phase 73 — Atlas-derived client continuity

2026-09-28 resume: authoritative WSL integration, full quick (766/766) and fresh/upgrade installer checks now pass. The notes below preserve the earlier candidate evidence; current status is in [phase-72-resume.md](phase-72-resume.md). Live authenticated providers were not exercised.

## Location and authority

- Implementation candidate: `C:/Users/<user>/projects/agent-driver-phase73`, branch `phase73-atlas-continuity`.
- Local snapshot baseline: `b7f2f3e0b99ec291ab4b55a99765106dc1d67244`. This is NOT a public upstream commit.
- Candidate `node_modules` is a junction to the preserved temporary dependency mirror; source and evidence are durable here, but dependencies must be reinstalled if that mirror is removed.
- Authoritative checkout: `/home/<user>/projects/agent-driver/release-v0.2.0`, branch `release/v0.2.0`, last observed HEAD `d69c8e6`. WSL remained inaccessible; no authoritative files changed this turn.
- Snapshot source: preserved Windows build mirror `C:/Users/<user>/AppData/Local/Temp/driver-files-build-YPOJgT`. It includes Phase 70/71 but does NOT include all Phase 72 functional changes. Never replace the original checkout with this directory.
- Windows source-path recheck returned false. WSL service recovery still requires an administrative action outside the current medium-integrity process. No further distro/service restart, public push, release or personal Work execution was performed.

## Implemented

1. Version-1 bounded decision-adapter capabilities gate actual dispatch. Connection readiness and implemented capabilities are distinct.
2. Shared, environment/runner-bound single-flight status probes; no failed-state cache; positive observations invalidated by configuration/executable metadata, login and execution failures. Actual judgment calls are NOT deduplicated.
3. Controller-owned login preflight and launch lifetime. Duplicate starts join, shutdown cannot launch a late child, changed connections and late output cannot overwrite the correct state.
4. Claude subscription detection requires `apiProvider === 'firstParty'`. Missing provider, API-key/helper, Bedrock and Vertex responses do not authorize the subscription bridge. New fixtures explicitly provide the provider.
5. Model/input/schema snapshots for handoff; saved receiving model retained. Invalid JSON/envelopes are validation failures, not provider outages. Receipt-persistence failures cannot trigger a third model call.
6. Cross-field receipt invariants for target/model/input hash and uncertain effects. Coding read-only successor output is validated before clearing the prior session and recording transfer.
7. Documentation corrects the old subscription-to-API fallback description. Jev policy and cost boundaries unchanged.

These are adaptations of Atlas design principles, not an imported Atlas engine or an ACP implementation. See `docs/atlas-continuity.md` for pinned source links and limits.

## Validation evidence

- Native Windows compiler: TypeScript 7.0.2, Node v22.22.0; package/runtime versions unchanged (0.2.0).
- First run: 31/33 test cases passed. Two failed in teardown because SQLite was removed before closing; failure records preserved in `tests/evidence/phase73-initial.json` and `tests/report.json`.
- Expanded run: 60/61 checks (including source fingerprint check); the remaining existing coding-model fixture also closed its database after directory removal. Corrected teardown without deleting assertions. Evidence `tests/evidence/runtime-tests-2026-09-27T14-43-37-825Z.json`.
- Coding integration: 23/23 cases + input fingerprint check passed, with real Windows Git/SQLite/files and fixture Codex/Claude. Evidence `tests/evidence/runtime-tests-2026-09-27T14-43-47-513Z.json`.
- Broader connection/settings pass: 79/79 cases + input fingerprint check, including real loopback settings HTTP and desktop/mobile headless UI, with fake providers. Evidence `tests/evidence/runtime-tests-2026-09-27T14-57-37-367Z.json`.
- Final input-snapshot regression: 81/81 cases + input fingerprint check passed in `tests/evidence/runtime-tests-2026-09-27T15-02-54-348Z.json`. The targeted coding rerun is recorded separately in `tests/evidence/phase73-summary.json`. Do not infer a full release gate from these scoped runs.
- Final coding rerun: 4/4 cases + input fingerprint check passed in `tests/evidence/runtime-tests-2026-09-27T15-06-53-351Z.json` (expiry handoff, invalid successor, model override, uncertain-write no replay). Final code therefore has 85 scoped passing cases and 2 passing source-integrity checks; these are not a full release test count.
- `npm run ledger:verify --script-shell=powershell.exe` passed for 26 requirements. `git diff --check` passed. Candidate historical evidence limitations are explicit below.
- Three `runtime WSL` cases are excluded on Windows, not counted as passed. Linux/WSL, real authenticated CLI/model handoff, original-source merge, installation and full quick release regression remain unverified. No long soak or paid provider calls.

## Historical metadata in this candidate

Some older raw evidence exists only in the inaccessible original. Candidate `docs/status.json` marks those legacy entries partial rather than inventing the missing reports. This does not reverse the previously published release's recorded outcome. Do NOT carry these environment-only legacy status edits into the authoritative repository. Merge only new Phase 73 RQs and keep the original's historical evidence/status.

## Resume / integrate

1. Recover WSL and read the original `AGENTS.md`, `docs/task-ledger.md`, `docs/status.json`, `docs/handoff/phase-72.md` (if present), current Git diff and relevant sources. Confirm actual running installation separately.
2. Preserve unfinished Phase 72 Work execution binding, import/dispatch and folder-path fixes; the Windows baseline lacks them. Also compare the strict Claude first-party patch against original history before applying it.
3. Compare candidate source diffs against their baseline and merge per file. Do not bulk-copy this snapshot or automatically apply its status.json. The transfer manifest records base/new hashes and which files are new.
4. Rebuild using pinned dependencies, run the focused tests including Linux-only WSL cases, then the normal quick release gate (without soak). Retain all earlier failures and source fingerprints.
5. Update original ledger/status and handoff after verification. Only then consider release/deployment; neither is authorized by this implementation request.

Read first: `prompts/phase-73-client-continuity.md`, `docs/atlas-continuity.md`, `src/integrations/subscription-auth.ts`, `src/integrations/client-handoff.ts`, `src/onboarding/configured-model.ts`, `src/coding/runtime.ts`, `tests/runtime-client-continuity.test.mjs`.
