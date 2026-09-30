# Phase 108 handoff — task-auto role models

## Scope and checkout

Implementation checkout: `office-wsl-loopback`. Preserve all preceding Phase 104–107 edits. The personal Office installation remains reset at the user's request. No archived service, Work, MCP registration, provider login or browser profile should be restored merely to display this feature.

Read first: `prompts/phase-108-task-auto-models.md`, `docs/verification/phase-108-task-auto-models.md`, `src/work/task-models.ts`, `src/onboarding/task-models.ts`, `src/onboarding/configured-model.ts`, `src/observability/role-model-ui.ts`.

## Implemented

- Explicit inherit/manual/Auto policy, separate from default client and per-app model controls, with legacy manual compatibility.
- One bounded LLM allocation per changed task/settings, connected subscription candidates only, exact four-role validation and stored per-Work reuse.
- Visible default fallback for optional allocation failures; session, connection and receipt safety fences remain blocking.
- Per-Work propagation through Pack execution, independent completion verification and supervised Swarm, sharing the original Swarm runtime's locks.
- Localized allocation progress and saved-plan details, kept distinct from actual model receipts and task completion.
- Existing API/API-to-auth choices, dedicated coding settings, effort, authority and no-auth-to-paid boundaries remain intact.

## Completed verification

Expanded targeted suite passed 44/44 before the final safety-fence and saved-default refinements. Initial fingerprint failure and corrected runs are retained in the verification document.

Completed full quick process (no soak):

- WSL cwd: `/home/deepdive/projects/agent-driver/office-wsl-loopback`
- command: `npm run build && node scripts/runtime/run-tests.mjs quick`
- persistent tool session: `11269`
- log: `/tmp/phase108-quick-20260930.log`

Exit 1, evidence `tests/evidence/runtime-tests-2026-09-29T23-25-37-521Z.json`, 1,574/1,579 PASS. Five failures: designated browser-help placement, obsolete forced-Swarm wording, three unit DOM fragments missing the real task-model rendering helper. Fixes preserve the existing execution, permission, escaping and state assertions. Also corrected the generic error suffix on successful allocation events and actual model visibility without native-session metadata.

The rebuilt affected suite passed 110/110 as session `90494`, log `/tmp/phase108-final-targeted-20260930.log`. Visual review then exposed a collapsing allocation disclosure; its first preservation patch exposed a nullable loading-detail path (109/110, session `44124`). The corrected path explicitly guards missing detail/panel and is tested on same-Work refresh, other-Work identity and empty/loading transitions.

**Final rebuilt affected suite: 110/110 PASS**, session `59249`, exit 0, log `/tmp/phase108-final-targeted-r3-20260930.log`, evidence `tests/evidence/runtime-tests-2026-09-29T23-45-04-670Z.json`. All mentioned sessions have finished. The final suite covers every previously failed file, allocation/role UI, Swarm/session continuity, coding priority, Control Center actions/layout, native CLI/MCP and actual fixture Work I/O with its recorded model timeline. Input fingerprints remained stable; earlier failures remain in the cumulative report. The full quick run preceded these fixes and was not rerun afterward.

RQ-874–877 are complete within this implementation/isolated-verification scope. No running test needs continuation. Next possible step is an explicitly authorized installation/release or live-provider task, not automatic restoration of the user's reset personal environment. Build, ledger, whitespace and public-boundary checks are separate from model/task success.

Final build/whitespace checks passed; ledger verifies 171 requirements; public-boundary scan passed for 667 files with zero findings. Final screenshots were inspected with the allocation panel open and actual fixture execution/results visible.

## Versions and limits

Package 0.3.1; Node 22.22.0; npm 11.11.0; no dependency change. Auth/catalog/model responses in these new tests are controlled fixtures. Control Center rendering, saving, database persistence, local Pack I/O and runtime propagation are exercised in disposable environments. Desktop Korean and mobile English screenshots were inspected; four language/viewport combinations are checked automatically.

No live subscription or paid model call, model-quality/timing benchmark, Windows/macOS native-session certification, personal installation update, commit, push, merge or release. Auto currently targets Office-owned internal role decisions; imported runtimes and external interactive coding sessions keep their original model/session ownership.
