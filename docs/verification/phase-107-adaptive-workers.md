# Phase 107 — Adaptive workers and auth-only role models

## Implemented scope

- **RQ-870:** Standard research accepts one source worker. Multiple workers require a final synthesis that covers the graph; reduction is optional. Planner instructions request the smallest useful graph, not a worker quota. Delegated capabilities, dependency cycles, read-only scope, budgets, independent readback and Work completion gates remain enforced. A one-worker result passes through the same Office artifact-saving and completion path.
- **RQ-871:** Work-bound Codex and Claude decisions resume an app-created native session. The binding covers Work, run, actor, role, provider, selected model, effort, connection paths/binary fingerprint, instructions and output schema. Active actor locks prevent concurrent reuse. Changed contracts, interrupted turns, a 24-hour inactivity limit or 32 accepted turns cause a fresh session with the current host checkpoint. A CLI's explicit missing-session rejection permits one fresh decision attempt; invalid output, quota and unknown failures do not use that retry. Persistence failures cannot trigger another provider call. Completed workers and verified effects are not replayed.
- **RQ-872:** Optional planning/worker/verifier/synthesis model settings use the existing model catalogs. Unspecified selections inherit. Overrides require both global default and effective scope to be subscription mode. Explicit coding choices win. API and API-to-subscription handoff retain existing choices; auth-to-paid fallback remains prohibited. The receiving provider uses its own selected model and session.
- **RQ-873:** Korean/English desktop/mobile settings, exact saved selections, catalog refresh, API-mode hiding, session isolation/recovery and supervised one/small-worker graphs are covered by isolated tests. The personal installation remains reset; no provider call, bot execution or release is part of this change.

## Evidence so far

| Verification | Evidence level | Status | Result |
|---|---|---|---|
| Initial affected regression | mixed unit/contract/fixture | FAIL | 62/63; old assertion required at least two workers. Replaced with one-worker acceptance while retaining cycle and capability refusal tests. |
| Adaptive/supervised Swarm regression | unit/contract_fake/fixture_integration | PASS | 48/48 including input integrity. Single-worker evidence and result file verified; reopening completed workers did not call a model or reread sources. |
| Expanded affected regression | mixed | FAIL | 80/81; UI fixture waited for AI catalog before opening the AI tab. No product runtime error was established by this timeout. |
| Corrected UI flow | fixture_integration | PASS | UI case and input integrity: 2/2. Actual settings HTTP save and browser controls; auth and catalog responses are fixtures. |
| Session edge cases, handoff and localized UI | unit/contract_fake/fixture_integration | PASS | 21/21 including input integrity. TTL, turn cap, interrupted state, stale lock, mismatched session ID and receipt persistence failure included. |
| TypeScript build | native_integration | PASS | Node 22.22.0, npm 11.11.0; no dependency upgrade. |
| CLI resume option inspection | user_environment | PASS | Installed codex-cli 0.147.0 and Claude Code 2.1.284 expose the used explicit resume/session options. Help output is not proof of a successful live model conversation. |
| Full quick regression, no soak | unit/contract_fake/fixture_integration/native_integration | PASS | 1,567/1,567, including input integrity. This preceded the final role-priority and instruction refinements below. |
| Final affected regression after review refinements | unit/contract_fake/fixture_integration/native_integration | PASS | 227/227, including input integrity. Rebuilt after fixing copied coding-role overrides, explicitly assigning planner correction/replanning, and removing mandatory research-to-Swarm wording. Covers settings/UI, billing, subscription, coding settings, Work definition/execution/replanning/evidence/live UI/MCP and Swarm. |

Private evidence is accumulated in `tests/report.json`. Individual runs:

- `tests/evidence/runtime-tests-2026-09-29T22-25-07-362Z.json` (retained failure)
- `tests/evidence/runtime-tests-2026-09-29T22-29-39-898Z.json`
- `tests/evidence/runtime-tests-2026-09-29T22-32-05-826Z.json` (retained failure)
- `tests/evidence/runtime-tests-2026-09-29T22-36-41-629Z.json`
- `tests/evidence/runtime-tests-2026-09-29T22-38-58-110Z.json`
- `tests/evidence/runtime-tests-2026-09-29T22-39-58-567Z.json` (full quick)
- `tests/evidence/runtime-tests-2026-09-29T22-54-51-595Z.json` (final affected regression)

Review found two extra model-precedence paths that the initial tests did not exercise. The coding settings UI can copy hidden global role fields when creating an override; runtime selection now prioritizes the explicit coding models regardless of those copied fields, and returning to inheritance re-enables the global role choices. Proposal correction and user-direction replanning use purpose `correct` but are planning work; they now bind the planner role explicitly. The UI save/reload path and actual fixture Work pause/edit/resume path cover these cases. Final source/tests/dist fingerprints remained stable during each test run.

Screenshots in `tests/evidence/phase107/role-models-{ko,en}-{1280,390}.png` use controlled catalogs and an empty disposable Office instance. Desktop and mobile images were visually inspected; English role controls contain no Korean text and no horizontal overflow was observed.

## Limits

Native session reuse is implemented for Codex and Claude **decision providers**, not a claim that every integration has a resumable native chat. OpenCode, Cursor, API and MCP sampling retain their previous checkpoint semantics. An unbound decision has no Work identity and stays ephemeral. Imported Hermes/OpenClaw runtimes and interactive coding sessions continue using their own existing session contracts.

The default models remain inherited until the user chooses role overrides. MCP sampling does not force a model on the client app. This is not an automatic benchmark-based model chooser.

An expired session's old native transcript is managed by its CLI; Office does not remove other conversations. Office does not persist raw prompts/answers or credentials in its session pointer files. Native CLIs retain their own transcripts. Session references are not idle worker processes.

No live paid/subscription model conversation or timing/token ablation was run. Do not claim a measured speed improvement, zero token overhead, macOS/Windows native resume certification, installation update, merge or public release from these fixture results.
