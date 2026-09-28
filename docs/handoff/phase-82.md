# Phase 82 — Real installed application acceptance

Authoritative checkout: `/home/<user>/projects/agent-driver/release-v0.2.0`,
branch `release/v0.2.0`. Existing Phase 70–81 changes preserved. No commit,
publication, installed-host replacement, private-message send or user draft edit.

## Scope and current evidence

**Follow-up correction:** minimized is a recoverable state, not inherently
BLOCKED_ENV. The user explicitly authorized restoring KakaoTalk. The common
recovery implementation and new native evidence are documented at the end of
this file. The original failed/blocked records below remain historical evidence.

- A bounded, read-only probe of the existing KakaoTalk window found it minimized.
  CUA cannot obtain rendered content from that state. The window was not restored
  or focused automatically. The user was asked to restore it if they want that
  application checked; other test work continues independently.
- Test-owned instances of the installed Windows Character Map provide harmless
  native acceptance. They are real apps, not the Phase 81 controlled canvas.
  Only the newly launched PID/window can receive navigation input; launch and
  cleanup are scoped to the harness-owned process.
- Character Map UIA observation and supplementary local OCR both succeeded.
  Read-only OCR probes took 2,495–5,413 ms in these samples. Those probes do not
  establish successful screenshot-driven navigation.
- The native harness uses the ordinary RuntimeApi, configuration factory,
  configured Codex subscription/default model, and our owned CUA 0.30.2. It does
  not use Codex Computer Use. Jev is off in the selected native-test settings;
  fake-provider tests cover its routing, not live accuracy or latency.

## Defects found and repaired

1. Missing screenshot metadata surfaced as raw schema errors. Minimized and
   unavailable capture now produce bounded `waiting_observation` responses,
   without leaking native diagnostics, guessing pixels or changing foreground.
2. The native app exposes a UIA CheckBox with `selected: false`; our adapter
   previously omitted that role. Added the checkbox and nullable selected state
   through observation, planning and decision contracts. `control_selected`
   verifies a positive boolean state; missing state is never false.
3. The non-empty procedure schema encouraged a model to encode inability as an
   invented blocked step. A planning response may now use `steps: []` with an
   explanation. No executable procedure is persisted for that response.
4. A first target or precondition missing from the supplied observation is
   rejected. One bounded pre-input LLM correction may use the same capabilities;
   the replacement still passes the ordinary compiler and scope checks.
5. Verified UIA navigation targets now reuse exact current state, as visual
   targets already do. A runtime guard initially still allowed only visual
   navigation, and the new repeat regression caught it. That guard was repaired
   without removing fresh pre-input observation or independent readback.
6. A model invented an unobserved search-button label as an extra postcondition.
   The native input was not accepted as verified success and was not replayed.
   Planning instructions now distinguish known state transitions from guessed
   labels. The later round-trip experiment explicitly tests checkbox state,
   not that earlier additional search-control requirement.
7. A pure view-state round trip was classified `unknown`. Clarified generic
   read-only view/tab/disclosure navigation, while preserving the distinct scope
   needed for persistent settings, security choices and data changes.
8. Model candidate construction omitted observed UIA enabled/visible/source
   values and the step effect. These now remain in both Jev and LLM input,
   without including field values, pixels or coordinates. Unknown provenance
   stays `unobserved`. Catalog/question version 5 invalidates old calibration.

## Final validation

Focused tests passed **122/122** before final decision-state enrichment:
`tests/evidence/runtime-tests-2026-09-28T07-14-52-444Z.json`.
Earlier failures remain in `07-02-55-048Z` (117/118) and `07-09-26-467Z`
(121/122); the former was an old expectation for raw rejection instead of the
new bounded observation-wait response.

Full quick passed **900/900**, zero blocked/not-run, with stable input fingerprints:
`tests/evidence/runtime-tests-2026-09-28T07-17-11-467Z.json`. This ran before the
final decision-candidate enrichment. Its evidence levels are 281 unit, 335
contract_fake, 151 fixture_integration and 133 native_integration. Those Linux
native cases are not substituted for Windows app acceptance.

After the final candidate-state change, build and all affected Windows/CUA/Work
consumer suites passed **158/158**, zero blocked/not-run, stable input fingerprints:
`tests/evidence/runtime-tests-2026-09-28T07-24-50-898Z.json`. That contains 10 unit,
145 contract_fake, 2 fixture_integration, and the native input-integrity check.
Both Jev and LLM request-shape tests retain the actual selected/enabled/visible
state. The final Windows native tests below then ran against byte-identical
staged copies of the changed built modules and acceptance harness.

Long soak remains excluded. `npm run ledger:verify` passed with 64 recorded RQs;
`git diff --check` passed. Runner logs and metadata remain under
`/home/<user>/.local/state/agent-driver-audit/20260928-resume/`. No test process
from these completed runs needs resuming.

The retained failed attempt `agent-office-real-visual-ePO6vy` had a valid plan but
target judgment returned unknown and sent no input. Inspection found that the
judgment candidate retained checkbox selection but omitted the already-observed
enabled, visible and UIA-source values. A separate configured-model replay of
that saved public test state returned unknown with the original input and ready
with those observed fields plus the step effect. This is one diagnostic pair,
not a calibrated accuracy benchmark. The common request now retains that evidence
and subsequently passed the actual app test below. TypeSafe's state/candidate
skill guidance informed this correction; there is no new vision model or API.

## Final installed-app sample

`agent-office-real-visual-Odl5j5` passed with four real owned-CUA UIA clicks and
four independently verified checkbox transitions, all under one ready Work.
The LLM generated the procedure; no Character Map adapter or handcrafted target
coordinates were used. Current UIA supplied the checkbox so OCR was correctly
not used for these inputs.

| Stage | First run | Same-Work repeat |
|---|---:|---:|
| Work definition | 17,053 ms | Existing Work |
| Observation and procedure | 19,659 ms | 1,707 ms |
| Toggle and independent readback | 22,552 ms | 9,894 ms |
| Restore and independent readback | 15,973 ms | 8,438 ms |
| Design plus two inputs | **58,184 ms** | **20,039 ms** |
| New model calls | 4 including Work definition | **0** |

The repeat is about 66% shorter (2.9x), for this single pair only. Current UIA
still costs 18 native observations across both runs; repeated target reasoning
is skipped, not current-state checks. It is not yet instant all-app automation.
No live Jev latency/probability or unreported subscription token count is inferred.

A separate final-build read-only probe `agent-office-real-visual-tvoaer` passed:
7 UIA candidates in 1,356 ms, then supplementary OCR with 20 text candidates in
3,761 ms (1,906 ms local OCR work). Zero model/input calls. This is actual installed
application visual observation, **not OCR-only click/readback acceptance**.

Owned Character Map windows were closed. The final acceptance/probe Node PIDs
were absent on a subsequent read-only process check; no Character Map process
remained. An unrelated existing CUA process was left untouched. No capture
history was added to the product, and no existing user draft/message was changed.

Sanitized reports and failure history: `tests/evidence/phase82-real-visual.json`,
indexed in `tests/report.json`. RQ-768 and RQ-770 are done. RQ-769 remains partial:
real OCR-only app input/readback/repetition needs a rendered target window.
The minimized KakaoTalk case remains BLOCKED_ENV, never a PASS.

Raw native reports/journals remain under Windows temp `agent-office-real-visual-*`.
Only sanitized measurements belong in public evidence. Do not copy raw captures,
private app labels or model settings into the repository.

## Resume and boundaries

Read `prompts/phase-82-real-app-visual.md`, `src/desktop/cua-desktop-driver.ts`,
`src/desktop/windows-decision.ts`, `src/desktop/work-procedure.ts`,
`src/desktop/windows-runtime.ts`, `src/work/runtime.ts`,
`scripts/runtime/windows-real-visual.mjs`, `tests/runtime-visual-fallback.test.mjs`.
Native staging is `C:\Users\takko\projects\agent-driver-phase76-native`; use
explicit source paths when copying built modules from the authoritative WSL
checkout. Do not substitute staging results for an installed MCP update.

Pinned versions: package 0.2.0, Node 22.22.0, npm 11.11.0, TypeScript 7.0.2,
CUA 0.30.2, TypeSafe SDK 0.6.0, Windows decision catalog 5.
Next: use the common recovery path if the authorized window is minimized, then
validate harmless visual navigation/readback/repetition. Do not ask the user to
restore a window that the host has permission to restore. No message send or
draft editing. Icon-only targets and visual-only text input remain separate
missing capabilities, not app-specific product bans.

## Follow-up: automatic minimized-window recovery (RQ-771)

The user correctly challenged the missing restore step. Added
`windows_executor.grants[].windows[].allow_window_restore` (default false): an
explicit host/user foreground permission, not a model-authored procedure field.
The desktop CUA profile alone permits `bring_to_front`; the field/chat profiles
retain their existing tool limits. The reviewed manifest must also permit that
tool for the exact PID/HWND. Recovery grants are not write/send grants.

The common adapter catches a positively identified minimized-capture failure,
checks the current exact PID/HWND/app/title and the grant, restores once, checks
that the exact window is no longer minimized, and obtains a new capture. Old
capture tokens/approvals and verified-target fast paths are invalidated. A
restored-by-user race causes no focus call; healthy observations incur no extra
recovery inventory. No recursive restore loop, app-name branch or model call.
Failed/unverified recovery remains a bounded observation wait. Reconciliation
of a potentially completed content action stays read-only and never restores.

The runtime supplies pause/revision/model/config fences before restoration.
Planning observation shares the existing same-driver execution lock, so it
cannot steal a window from an active or unreconciled input. Dead observation
owners on the same host may be reclaimed only after process liveness fails
with ESRCH; real effect claims, live owners and other-host locks are preserved.
Cross-database host-wide foreground serialization is still the host adapter's
responsibility, not newly proven by this change.

Native evidence in `tests/evidence/phase82-window-restore.json`:

- `AwHiNm`: fresh KakaoTalk inventory was already non-minimized. Read-only OCR
  returned 39 candidates (6,531ms initial, 3,027ms supplementary); we did not
  claim to have restored it or minimize the user's window for a test.
- `bWJeTJ`: launched a separate installed Character Map, injected minimization
  into only that launcher-owned PID/HWND, and called the common driver.
  Actual CUA restoration: **1,492ms**. Detection, identity checks, restoration
  and fresh UIA/OCR: **12,135ms**. Second observation: **2,311ms**, no second
  restore. Verified non-minimized/visible and 8 UIA + 21 OCR candidates. No
  model or content input. Owned app closed afterwards.
- `JgDh73`: final build observed existing KakaoTalk with explicit recovery
  permission. It was already visible: **zero restore calls**. UIA 1/OCR 33,
  first 4,773ms and supplementary 1,800ms, zero models/content inputs. Existing
  user window remained open. Text count changes are current observations, not
  a claim of stable semantic targets.

Windows safety/runner guidance informed the narrow scope, owned-process fault
injection and preserved reports; all actual execution used our CUA, not Codex
Computer Use. No raw private labels/screenshots were put into public evidence.

Build and affected consumer regressions passed **218/218**, zero blocked/not-run,
stable input fingerprints (`runtime-tests-2026-09-28T07-49-27-267Z.json`). The
first new test run (212/215, `07-46-07-681Z`) is retained: its three failures were
fixture setup errors (mixed observation mode omitted on repeat, unchanged pause
used to simulate revision, and a recovery that succeeded when the test needed
a pre-reconciliation capture failure). The tests were corrected, not removed.
Full quick/long soak were not repeated for this scoped change; earlier quick
results above are not relabeled as proof for the newer source.

Final native staged modules/harness matched source-build SHA256 hashes.
Acceptance Node PIDs 53280/51168/46104 and owned Character Map had exited on a
read-only process check. Other CUA/user processes were not stopped. RQ-771 done;
RQ-769 remains partial for OCR-only navigation/readback, not for minimized-window
recovery. Source/staging validation only, no installed-MCP update or release.

Final follow-up closeout: `npm run ledger:verify` passed with **65 RQs**;
`git diff --check` passed. All three new native evidence cases are indexed in
`tests/report.json`; original failed/blocked cases remain unchanged. No running
acceptance/test session needs resuming.
