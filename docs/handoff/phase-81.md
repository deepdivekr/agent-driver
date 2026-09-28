# Phase 81 — Common visual supplementation

Authoritative checkout: `/home/<user>/projects/agent-driver/release-v0.2.0`,
branch `release/v0.2.0`. Existing Phase 70–80 edits preserved. No publication,
commit, installed-host replacement or private-message send in this phase.

## Implemented

- RQ-763: Typed `visual` candidate, local OCR provenance, nullable enabled state
  and unavailable OCR confidence. Current window/capture/bounds and source image
  hashes remain host-only; no pixels, coordinates or raw UI tree sent to models.
- RQ-764: Owned CUA automatically supplements absent/truncated content UIA with
  local Windows OCR. Native titlebar controls do not falsely imply application
  accessibility. Mixed views can explicitly request `observation: visual` through
  the same design MCP tool. No application-name branches or new Pack family.
  New-Work classification now separates a fitting Pack from missing connections.
- RQ-765: Current capture-bound background navigation, positive independent
  postconditions, duplicate rejection, pause/model revision recheck after slow
  observation, durable non-performance and uncertain-effect no replay. A scaled
  DPI-unaware window is rejected before input instead of guessing coordinates.
- RQ-766: Fresh frames guard bounded OCR reuse. Identical frames skip OCR;
  changed regions use tiled pixel hashes and full-frame fallback. A verified,
  unchanged step can skip model selection. Window movement/state changes lose
  that shortcut. Four transient OCR caches, 30s child idle exit, 60s cache expiry;
  no screenshot history. Verified target metadata capped at 512 / seven days.

## Evidence and iterations

First focused run: **153/154 PASS**. Its only failure expected `needs_human`
instead of the actual, correct `waiting_auth`; corrected the assertion, not the
authentication gate. Failure retained in
`tests/evidence/runtime-tests-2026-09-28T05-50-44-267Z.json`.
Visual-only 17/17 passed; subsequent focused **156/156 PASS**, 0 blocked/not-run,
in `tests/evidence/runtime-tests-2026-09-28T06-10-48-002Z.json`.

Native controlled canvas iterations found and addressed:

1. A missing executor incorrectly caused an otherwise fitting Work to be
   classified `unknown`; clarified outcome vs connection readiness.
2. Native titlebar Close/Minimize controls prevented auto-OCR. Excluded only UIA
   TitleBar descendants; no app/title/locale hardcoding. A live model timeout
   from the prior observation was preserved, not counted as native success.
3. Unknown visual interactivity was treated as guaranteed inability. Judgment
   instructions now distinguish a bounded navigation attempt from enabled-state
   evidence, permission or successful completion.
4. CUA 0.30.2 captured a DPI-unaware test window at logical size inside a larger
   physical buffer. A posted click missed, and independent verification correctly
   refused success. Added exact-window DPI checks and a pre-input refusal.
   A DPI-aware test window then clicked/read back correctly.
5. Local OCR read `to` as `tO`. Added only case/width/spacing normalization for
   visual navigation labels, retaining duplicate ambiguity and exact UIA/value
   matching. No fuzzy names, coordinate guesses or forced model success.

The native test window is custom drawn and intentionally has no UIA content
controls. This is native executor acceptance, not real Kakao/Office coverage.
`--owned-canvas-contract` uses explicit fixture model choices; its native clicks
and OCR are real, but the model is not. `--owned-canvas-probe` is read-only and
must not be presented as execution success. The DPI refusal test asserts refusal,
not successful navigation; its first harness failure was an Error/RuntimeError
name comparison, also retained.

## Live subscription sample

Real configured Codex subscription/default model, Jev off, no Codex Computer Use:

| Stage | First | Repeat |
|---|---:|---:|
| Work definition | 15,434 ms | Existing Work |
| Current observation + procedure design | 24,512 ms | 6,887 ms |
| Open details + independent readback | 15,982 ms | 13,552 ms |
| Return + independent readback | 20,440 ms | 11,419 ms |
| Design plus two inputs | 60,934 ms | 31,858 ms |
| New model calls | 4 including Work definition | 0 |

The repeat is ~48% shorter including procedure design, ~31% shorter for the two
inputs alone. These are single observed samples, not p50/p95 or a guarantee that
every repetition is faster. Native CUA observation/input latency remains material.
Jev routing/probability/correction is covered by fixtures, **not** a live Jev
accuracy/speed evaluation. Unreported subscription tokens remain `unobserved`.

Raw local reports and journals remain in the `agent-office-visual-native-*`
directories beneath the Windows user's temp directory. Only sanitized measurements
go into public evidence. Temporary owned processes are closed, user apps untouched.

## Final validation

Final build passed. Full quick **890/890 PASS**, 0 BLOCKED_ENV / NOT_RUN, with
unchanged test input fingerprints:
`tests/evidence/runtime-tests-2026-09-28T06-15-54-000Z.json`.
The recorded levels are 281 unit, 325 contract_fake, 151 fixture_integration and
133 native_integration. Those Linux native cases do not replace Windows acceptance.

Final-build controlled Windows canvas acceptance also passed: four actual CUA
clicks, independent OCR readback, two verified-target hits and zero repeat model
calls. Its model answers were explicit fixtures. The live subscription sample
above ran before the final acquisition-timestamp hardening; final-build native
and quick tests cover that hardening without claiming a second live model sample.
Expected scaled DPI-unaware refusal passed before any input.

Sanitized native evidence and all retained failures:
`tests/evidence/phase81-visual-native.json`, also indexed in `tests/report.json`.
Final native cleanup reported closed; subsequent read-only Windows process checks
found no owned test canvas or recorded live/final test child PIDs. Historical
cleanup fields marked unverified remain unchanged in their original reports.
Native CUA observation in the live sample averaged 2,628 ms (20 calls); OCR took
3,379 ms total across 18 captures, of which 13 reused extraction. The bottleneck
is still native capture/input, not just model selection.

Long soak is excluded. `npm run ledger:verify` passed with 61 recorded RQs.
`git diff --check` passed. All Phase 81 RQs have status and evidence recorded.

## Limits / next useful work

- Visual-only navigation currently needs text. Icon-only recognition, arbitrary
  canvas typing, visual-only file writes/sends are not implemented. UIA remains
  available for the editable part of mixed procedures.
- Scaled DPI-unaware CUA captures require a corrected/verified executor capture
  mapping or another connected executor; do not bypass the refusal or auto-focus.
- UIA gaps in otherwise populated views may need the connected agent to request
  `observation: visual`. No per-app adapter or human-written profile is required.
- Native capture remains whole-window; only OCR extraction is region-based.
- Same-Work procedure reuse only; no unverified cross-user/new-Work promotion.
- Host window-grant and external-effect approval frontend remains separate work.
  Source/build acceptance is not an installed MCP or public release upgrade.

## Resume files / versions

Read `prompts/phase-81-visual-fallback.md`, `src/desktop/cua-desktop-driver.ts`,
`windows-visual.ts`, `windows-visual-script.ts`, `windows-decision.ts`,
`windows-runtime.ts`, `work-procedure.ts`, `tests/runtime-visual-fallback.test.mjs`,
`scripts/runtime/windows-visual-native.mjs`, `docs/owned-windows-executor.md`.

Pinned: package 0.2.0, Node 22.22.0, npm 11.11.0, TypeScript 7.0.2,
owned CUA 0.30.2, TypeSafe SDK 0.6.0. Windows judgment catalog version 3;
older question calibration is not silently reused. TypeSafe state/Choice and
pre-parsed-candidate docs were read live; Neo was unavailable, so primary public
docs were used. Runtime skills influenced candidate separation and owned-process
cleanup; there is no additional vision API or mandatory Jev setup.
