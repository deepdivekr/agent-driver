# Phase 107 handoff — adaptive workers

## Scope and location

Implementation checkout: `office-wsl-loopback`. Preserve the pre-existing Phase 104–106 dirty changes. The personal Office installation was reset at the user's request before this phase; do not restore its archived services, Works, client registrations or browser profiles during verification.

Read first: `prompts/phase-107-adaptive-workers.md`, `docs/verification/phase-107-adaptive-workers.md`, `src/integrations/decision-sessions.ts`, `src/onboarding/model-settings.ts`, `src/work/swarm-executor.ts`.

## Implemented

- One/small-worker Standard graphs, optional reduction, retained scope/quality/readback gates and single-worker Office result capture.
- Work/run/actor/role-scoped Codex and Claude decision-session references; session isolation, locking, bounded lifetime, checkpoint recovery and persistence-failure fencing. No idle CLI process retained.
- Optional auth-only role models in localized settings, preserving API and API-to-auth model choices; native-session/checkpoint continuity appears in Work activity.
- Session recovery/isolation, handoff, supervised graph and desktop/mobile KO/EN settings regression coverage.

## Completed verification

RQ-870–873 are implemented. Targeted runs: 48/48 and 21/21 PASS. Full quick without soak: **1,567/1,567 PASS**. After the review fixes below, the final rebuilt affected suite passed **227/227**, covering role UI, coding settings, billing/auth/handoff, Work definition and supervision, actual fixture pause/edit/resume, MCP and Swarm. Each count includes the input-integrity case. Earlier failures are retained and explained in the verification document.

Completed processes (do not resume or relaunch):

- WSL cwd: `/home/deepdive/projects/agent-driver/office-wsl-loopback`
- command: `npm run build && node scripts/runtime/run-tests.mjs quick`
- persistent tool session: `96047`, exit 0
- log: `/tmp/phase107-quick-20260930.log`; evidence `tests/evidence/runtime-tests-2026-09-29T22-39-58-567Z.json`
- final affected suite: session `96774`, exit 0; log `/tmp/phase107-final-targeted-20260930.log`; evidence `tests/evidence/runtime-tests-2026-09-29T22-54-51-595Z.json`

Source/tests/dist were frozen during each run. The whole quick suite preceded the final small refinements; only the affected 227-case suite was rerun after them. Build, ledger, whitespace and public-boundary checks are separate from runtime evidence.

Review refinements completed:

1. A newly saved coding override can contain copied hidden global `role_models`. Explicit coding `client_models` now win even in this case; runtime and UI scope-switch/save cases passed.
2. Work proposal correction and user-direction replanning use purpose `correct` but now explicitly bind the planner role, preserving schemas, single-correction budget and effect boundaries.
3. Work/MCP guidance no longer orders every multi-source query into Swarm. It requests the smallest useful structure, permits one worker, and keeps an existing assignee context for follow-ups. Actual worker dispatch still requires a dedicated execution context and verified reports.

Next possible step: include this candidate in an explicitly authorized installation/release, or perform an authorized live-provider comparison. Neither was started. Do not reinstall the reset personal environment merely to show the settings UI; isolated screenshots are available in `tests/evidence/phase107/`.

## Versions and limits

Package 0.3.1; Node 22.22.0; npm 11.11.0. Inspected CLI option help for codex-cli 0.147.0 and Claude Code 2.1.284 without a model call. No dependency upgrade, personal install, live model-cost test, commit, push, merge or release performed.

Native decision sessions are supported for Codex and Claude only. Other providers and unbound calls keep the previous checkpoint/ephemeral path. Imported runtimes keep their own session lifecycle. Actual provider latency/token savings and Windows/macOS native session execution remain unverified.
