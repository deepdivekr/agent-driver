# Phase 80 — Work-driven generic desktop procedures

## Product correction

The user did not impose a self-chat-only product. The prior self-chat task was
an example and an evidence boundary, not an application/recipient allowlist.
Do not solve each new app by requiring a handwritten CUA adapter or asking the
user to register a Task Pack first.

The intended flow is natural-language Work -> outcome/connected-capability
selection -> typed executable procedure -> current observation, action and
independent verification -> verified reuse. Optional Pack Jev judgments and
LLM correction remain in the common Decision Plane. Deterministically known
current fields do not need another model call. Uncertain effects still require
reconciliation instead of blind retry. A plan is neither permission nor proof.

## Implemented

- RQ-758: Work, Pack and MCP instructions no longer turn the self-chat example
  into a global restriction. The explicitly named self-note template still
  preserves its own requested recipient. Generic procedures set no self-only
  requirement and retain the exact Work target.
- RQ-759: `runtime_windows_design` builds a closed, typed procedure from the
  current ready Work and observed executor capabilities using the configured
  model. The procedure is stored and bound to Work revision, input, config and
  capability identity, then uses the existing start/step/status journal.
  Concurrent planning is single-flight. Pauses and changed settings fence stale
  plans. There is no separate Work-level Jev policy.
- RQ-760 (partial): `kind: cua-desktop` uses a generic UIA executor and scoped
  window grants, not an app-name branch or per-app field index. Exact current
  controls, fresh native tokens and independent postconditions govern action.
  The production RuntimeApi/config factory can instantiate it. The remaining
  visual/UIA-less route and permission/approval UX are listed below.
- RQ-761: Only action-verified procedures can be reused. Cache eligibility is
  bound to the same Work/revision/current capabilities; changed state invalidates
  reuse and returns reobservation/replanning. Uncertain effects block redesign
  and replay. The already-planned unique local-draft field uses CODE without
  a second redundant target-selection LLM call. This is not a learned-cache hit.
- Observations hold raw values only inside the trusted host; models get labels
  and typed checks. Completed captures are released; abandoned captures expire
  and are bounded to 32. Approval records are not execution history.

## Verification and retained failures

Pinned package 0.2.0, Node 22.22.0, npm 11.11.0, TypeScript 7.0.2, CUA 0.30.2.
No dependency/version change in this phase.

- Build passed, including the final observation-retention change.
- Focused common-path regression: **137/137 PASS**, 0 BLOCKED_ENV/NOT_RUN,
  `tests/evidence/runtime-tests-2026-09-28T04-19-54-694Z.json`.
- Full quick before the final retention change: **869/869 PASS**,
  0 BLOCKED_ENV/NOT_RUN,
  `tests/evidence/runtime-tests-2026-09-28T04-22-41-692Z.json`.
- Final quick including retention: **870/870 PASS**, 0 BLOCKED_ENV/NOT_RUN,
  `tests/evidence/runtime-tests-2026-09-28T04-29-36-612Z.json`. The count includes
  input-integrity verification. No long soak was run.
- `ledger:verify` passed with **56 RQs**; `git diff --check` passed.
- Earlier fixture failures (missing model-settings revision/onboarding field)
  and the intermediate build failure are retained, not relabeled as passes.
- Public native evidence: `tests/evidence/phase80-native.json`.

Real Windows acceptance used a new test-owned Character Map window and our
RuntimeApi/config factory -> owned CUA. No Codex Computer Use, clipboard, file
save or real messaging was used. No app-specific control code or field index
was introduced. The Windows acceptance harness explicitly launches this owned
test app; that harness is not an application adapter.

1. First attempt: real Work was defined, but the procedure model call failed
   with STRUCTURED_MODEL_UNAVAILABLE. Exact provider error was not captured.
   The typed schema was made strict-provider compatible (closed input entries,
   anyOf checks). Do not infer a more specific provider cause from this record.
2. Second attempt: planning succeeded, but redundant target-selection model
   correction declined the already-exact field. No input occurred. This exposed
   the duplicated judgment and led to the exact-current-target CODE path.
3. Third attempt: **PASS**. Work definition 12,241 ms; generic plan 13,527 ms;
   actual local input + independent readback 8,876 ms; verified repeat **plan**
   lookup 1,530 ms. Total including setup/cleanup 38,451 ms. Two real Codex
   subscription model calls (`client_default`), Jev calls 0. Tokens unobserved.

The repeated native measurement is planning reuse, not another full native
input and not an end-to-end speedup claim. Repeated action and the optional Jev
path are covered with contract fixtures. The native acceptance preceded the
small final in-memory retention cleanup; that cleanup has regression coverage.
All three owned test windows/child sessions were closed. Failed attempts remain
in the cumulative report as FAIL alongside the later successful attempt.

## Remaining work / resume conditions

- **RQ-760 partial:** the generic path currently understands accessible UIA
  controls. Canvas/custom-drawn apps need a shared visual-observation/target
  route or another connected executor. Do not replace this with an app allowlist
  or quietly claim every application works.
- Window grants are supplied by host config and bound to exact Work/window
  identity. Automatic connection/permission onboarding has not been wired.
  The factory also has no action-time confirmation UI for local writes or
  external sends. Such effects remain waiting_approval without a trusted host
  callback; a model cannot supply that callback. These are common-runtime UX
  gaps, not a user-imposed self-chat restriction.
- Current verified reuse is same-Work scoped. Generalizing a learned recipe to
  similar new Works or daily cross-run scheduling is not proved by this test.
- Execution uses start/step calls from the connected agent. Automatic handoff
  to a visual fallback and an unattended multi-app daily pipeline are not
  established by the local-draft acceptance result.
- Installed MCP service is not redeployed. This is source/build and acceptance
  staging verification, not an installed/public release upgrade.
- Official TypeSafe live docs were unavailable through the configured Neo
  endpoint. Existing installed SDK/Decision Plane contracts were reused; no
  new TypeSafe API integration or live Jev quality claim is made.

## Files to read next

`prompts/phase-80-work-driven-desktop.md`, `src/desktop/work-procedure.ts`,
`src/desktop/cua-desktop-driver.ts`, `src/desktop/windows-runtime.ts`,
`src/desktop/cua-contracts.ts`, `src/desktop/cua-connection.ts`,
`src/work/runtime.ts`, `src/interface/api.ts`,
`tests/runtime-work-desktop.test.mjs`, `scripts/runtime/windows-work-native.mjs`,
`docs/owned-windows-executor.md`, `docs/windows-task-pack.md`.

The authoritative checkout is the release-v0.2.0 workspace; unrelated existing
Phase 70–79 edits were preserved. No commit, publication, service-wide restart
or real Kakao message send was performed in this phase. The existing private
Kakao draft is not a completion receipt or permission to send.
