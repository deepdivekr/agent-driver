# Phase 103 — Action Layer and GitHub integration

## Source checkpoint

Read `prompts/phase-103-action-layer-merge.md`, `docs/task-ledger.md`, `docs/status.json`, `docs/verification/phase-103-integration.md` and the Phase 102 handoff first. This checkpoint records in-progress integration, not a completed merge or release.

Independent read-only audits found no additional release-blocking failure in the common admission/control/completion/result path. Root corrected MCP guidance that incorrectly treated every pasted migration as original-runtime-only. The safe PR #29 compatibility/i18n delta is integrated separately from the obsolete README/assets and its permissive missing-provider rule.

First candidate f774efb passed 62/62 affected checks, 1,288/1,288 local full quick and five exact-commit temporary installations/upgrades. Both current-head CI runs failed the same theme test because the normal settings initialization probe was counted as a theme action. The exact initialization request is now separately bound, while every other POST remains forbidden; repaired theme 5/5 passed. Product source/build code is unchanged by the correction. Continue with a freshly committed exact-head full quick/install/CI and guarded merge; retain both original CI failures. Do not infer publication from a local build, older CI or private installed overlay. Preserve the Phase 102 native receipts; no personal bot/sender/schedule is a verification target.

## GitHub scope

- Continue PR #32 with the reviewed Action Layer and accumulated common UI/import fixes; use exact-head merge protection and successful current checks.
- PR #29 can be closed as superseded only after its useful delta is included and verified in the integration; its unsafe missing-provider compatibility is not adopted.
- #2/#9/#18/#20 have their bounded implementation commits in main and are eligible for evidence-backed closure. #1/#3/#4/#5/#6/#14/#16/#22/#24 retain explicitly unfinished scope.
- Do not close NAS authentication, Windows boundaries, unknown-cause failures or unperformed long-run acceptance as completed. Long soak stays outside the normal quick loop.

## Fixed versions and private state

Node 22.22.0 / npm 11.11.0 / package 0.3.1. Existing v0.3.1 tag/assets and installer pin are unchanged. No new release is authorized by this merge-only request. The local installed application has twelve preserved private Works; its URL, configuration, models and original runtimes must remain unchanged. Managed replacement requires a fresh idle/process-identity preflight, including MCP client sessions.
