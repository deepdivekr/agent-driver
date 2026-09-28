# Agent Office-owned Windows executor

## Current Work-driven route (Phases 80–83)

Common visibility recovery and bounded navigation reobservation are documented
in [desktop recovery](desktop-recovery.md). This remains a configured native
executor capability, not a completed first-install Windows desktop experience;
see the [candidate release assessment](release-readiness-phase83.md).

Use `runtime_work_start → runtime_windows_design → runtime_windows_start/step`.
The configured LLM designs a typed procedure from connected capabilities.
No application profile registration or app-specific adapter is required for
observed editable/clickable UIA controls. An exact current planned draft field
does not need a second model to rediscover it; other bounded target judgments
still use the selected Pack's Jev/LLM policy. Jev is optional, not a second
Work-design policy.

`windows_executor.kind: cua-desktop` selects the common adapter. The host grants
the Work current windows and effect scope. Those grants are permissions, not
learned app scripts: no field index, self-chat restriction or workflow ID is
configured. It uses the same owned CUA process, run journal, pause/revision
checks, pre-input freshness and independent readback. External sends/local
writes require a host confirmation callback and cannot gain authority from
model output. The default config factory does not yet supply that UI callback.

Generated procedures remain tied to Work revision, capability/configuration,
model settings and exact inputs. A verified full run can promote a procedure;
merely producing a plan cannot. A repeat reads current capabilities, then reuses
the procedure and verified exact targets. Changed state requests reobservation
and replanning; uncertain effects require reconciliation before a new plan.
Current procedure reuse is within the same Work, not unverified transfer to
another user or an unrelated request. A recurring schedule is not created by
this design tool.

The generic route prefers UIA and supplements missing controls with local
Windows OCR. This is not universal visual automation: icon-only targets,
canvas-only text editing, new-window authorization UX and a generic human
confirmation frontend remain integration work. They are missing capabilities,
not product bans on an app or recipient. Earlier sections below describe
narrower historical paths.

Phase 80 native acceptance on 2026-09-28 used real Character Map and the production
RuntimeApi/config factory: Work definition 12,241 ms; generated procedure
13,527 ms; input with readback 8,876 ms; repeat planning 1,530 ms with no new
model call. The two model calls used the existing Codex subscription/default
model. Jev was off in this native case. This is one sample, not a universal
speed claim or a complete second execution benchmark. Synthetic tests separately
exercise optional Jev and repeat input. No clipboard action or message send.
See `tests/evidence/phase80-native.json` for preserved failed attempts as well.

### Common visual supplementation (Phase 81)

- Normal UIA fields and controls use no screenshots. A titlebar's Close/Minimize
  controls do not count as accessible application content. Missing content or
  a truncated tree triggers visual observation. For a mixed UIA/canvas screen,
  the connected agent can request `runtime_windows_design` with
  `observation: "visual"`; this adds visual candidates without an app adapter.
- Owned CUA obtains a **fresh whole-window image** tied to the authorized
  Work/PID/window/title/bounds. Windows OCR runs locally in one lazy read-only
  child. No pixels are sent to Jev/LLM or retained in logs. CUA's optional
  perception extension is not required. The local OCR language pack must exist.
- The candidate table marks OCR text as `role: visual`, `source: windows_ocr`,
  `enabled: null`, `confidence: null`. OCR provides neither UIA/DOM semantics nor
  proof of interactivity. Jev/LLM receives bounded labels/provenance, not coordinates.
  Existing Pack settings, Work opt-out, calibration and correction still apply.
  Phase 81 used Windows judgment catalog version **3**. Phase 82 advances it to
  **5** for the checkbox and expanded observed-candidate state; old calibration
  is not silently reused.
- Code derives the point from the selected current text box and dispatches a
  background CUA click with that capture's one-use token. Visual-only actions
  currently support navigation, not guessed text replacement, file writes or
  sends. UIA can continue an editable part of a hybrid procedure. Background
  refusal never silently becomes foreground input.
- The read-only helper checks the exact window's PID and DPI awareness. On a
  scaled monitor, DPI-unaware windows are refused with `CUA_VISUAL_DPI_UNVERIFIED`:
  CUA 0.30.2 was observed placing logical pixels in a physical-size capture. No
  guessed scale transform or automatic foreground workaround is attempted.
  OCR case/width/spacing are normalized for visual navigation only; fuzzy text,
  UIA identities and typed values are never normalized into a different target.
- Fresh image/tile hashes guard all extraction reuse. Identical images need no
  new OCR. Changed pixels produce a bounded crop; large changes or text touching
  its boundary trigger full OCR. Changes outside the target are included, so a
  new modal is not hidden by a target-only crop. Native capture is still the
  whole window: savings are in OCR/model work, not an invented region-capture API.
- Independent positive postconditions, rather than changed pixels or a successful
  click response, determine completion. A verified repeat with the exact same
  current state can skip target-model selection. A moved control/changed frame
  loses that shortcut; cached coordinates and model probabilities grant nothing.
- Only four short-lived OCR region/tile caches are retained, expiring after 60s.
  The OCR child exits after 30s idle and is closed with its owning runtime.
  No screenshot history is stored. Verified target metadata expires after seven
  days and is capped at 512 entries. A process restart discards OCR caches.

The native acceptance source is `scripts/runtime/windows-visual-native.mjs`.
It uses a separately compiled controlled Windows canvas and existing subscription
model, not a personal app. The read-only `--owned-canvas-probe` path has a fixture
Work identity and is only an observation diagnostic, never input acceptance.
See `docs/handoff/phase-81.md` for actual outcomes and preserved failures.

### Real application hardening (Phase 82)

`scripts/runtime/windows-real-visual.mjs` can inspect an explicitly identified
existing window read-only, or launch a separate installed app and run a bounded
navigation Work. It neither changes the installed host nor uses Codex Computer
Use. Existing-window reports redact all labels except an explicit caller list;
owned-app debug reports remain local, and only sanitized measurements are kept
as repository evidence.

- Native UIA checkboxes retain `selected: true/false/null`. A checkbox transition
  requires explicit opposite `control_selected` checks. An unavailable state is
  not unchecked. The decision candidate retains observed visibility, enabled
  state, provenance and the step effect, without adding screenshots or values.
- A minimized capture is recoverable. A host window grant with
  `allow_window_restore: true`, plus a reviewed CUA manifest allowing
  `bring_to_front`, restores the exact PID/HWND once and reacquires evidence.
  This is a user/host foreground permission, not a model option. It defaults
  to false for background-only grants. Already-visible windows gain no extra
  inventory/focus calls. Failed or forbidden restoration returns a bounded
  `waiting_observation`, never a fabricated empty screen or an input replay.
  Pause/revision/model/config/scope are checked before restoration. Planning
  also respects the same-driver execution lock; reconciliation stays read-only.
- Missing evidence can produce an empty planning response and a clear observation
  request. It is not persisted as an executable plan or a fake blocked step.
  Unobserved first targets/preconditions receive at most one LLM correction,
  recompiled under unchanged Work/capability/permission bounds.
- Verified UIA navigation may reuse a target only with the same current state,
  just as visual navigation does. Fresh pre-input checks and action-bound,
  independent readback still apply; model reuse is not a permission cache.

The native Character Map experiment correctly uses UIA for its checkbox, while
the separate real-app visual probes confirm local OCR supplementation. Do not
describe those probes as real OCR-only clicks. KakaoTalk was minimized during
the first check, but subsequent native observation succeeded after it was
already restored. A separate test-owned installed app verified actual common
restoration (1,492ms; 12,135ms including detection and new UIA/OCR). KakaoTalk
OCR-only input remains unverified, not blocked by an inability to restore.
See `docs/handoff/phase-82.md` for failures, repair sequence and measured scope.

The opt-in native harness flags `--allow-restore --minimize-owned --inspect`
test recovery on a separately launched app; fault minimization is prohibited
for existing user windows. `--inspect-existing ... --allow-restore` permits
only necessary restoration and observation, not clicks, drafts or messages.

TypeSafe's [state contract](https://docs.typesafe.ai/concepts/state) is text-only.
This follows the [pre-parsed candidate pattern](https://docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook):
code extracts candidates, the decision model chooses, and code validates/actions.

## Historical single-field route (Phase 77)

Phase 77 adds an independent Windows connection:

`MCP client → Agent Office Windows runtime → private CUA stdio child → Windows UIA`

The client does not need Codex Computer Use. The runtime starts CUA on first
observation and closes its own child on shutdown. It does not connect to, update
or stop an existing CUA daemon. Linux/WSL does not silently launch a Windows
foreground bridge: this native adapter currently requires the Windows host.

## Historical single-field supported scope (Phase 77)

The earlier `kind: cua` adapter supports **one reviewed local draft field per
Work**, under `windows.form.draft`. It is not generic all-app automation.
KakaoTalk, mail, browser credentials, terminals, message sending, saving and
automatic submission are deliberately not exposed through this field adapter.
The ten Windows workflow definitions remain separate from native app support.

The host registers an exact process, window, label, role and element index, with
an expiring grant. CUA returns structured elements and per-snapshot native tokens.
Missing values remain unknown. Truncated trees, ambiguous labels, mismatched
windows, stale tokens, changed Work/configuration and consumed grants cannot
authorize input.

The exact field/intent fast path uses code, with no Jev or LLM call. It preserves
host authorization, input-time re-observation, durable effect claims and separate
post-input readback. Other Windows semantic choices retain the existing
optional Jev and configured LLM path. No global model setting is changed.

## Host setup

Install the verified CUA 0.30.2 Windows binary in a dedicated directory. Review
the whole bounded manifest and pin the executable and manifest SHA-256 values.
The official SDK handles hidden child-process startup; no shell or arbitrary
MCP tool pass-through is exposed.

The local host configuration accepts `windows_executor`:

| Field | Meaning |
|---|---|
| `kind`, `version` | `cua`, `0.30.2` |
| `executable`, `executable_sha256` | Absolute Windows executable path and digest |
| `manifest`, `manifest_sha256`, `manifest_reviewed` | Exact bounded manifest reviewed by the host/user |
| `fields[].work_id`, `grant_id` | Existing ready Work and unique one-use local grant |
| `pid`, `window_id`, `app_name`, `window_title` | Exact live application/window binding |
| `element_index`, `label`, `request_field` | Reviewed Edit control and matching task intent |
| `expires_at_ms` | At most 30 minutes when binding; never silently renewed |
| `local_draft_only`, `auto_submits`, `sensitive` | Must be `true`, `false`, `false` |
| `approved_value` | Optional exact one-use replacement value; absent means wait for host approval |
| `value_encoding` | Default `exact`; optional reviewed `uia_single_line_document` |
| `observation_strategy` | Default `focused`; `full` retains the original CUA observation path for compatibility/comparison |

There is no public MCP tool that grants these permissions. A general-purpose
user-facing app/field connection screen is still not implemented. Do not present
this developer/host configuration as one-click all-desktop onboarding.

Use the installed driver's documented bounded-manifest syntax. An exact
process/window grant can use `resources.desktop.applications` and
`resources.desktop.windows`, with `display: false`; allow only
`list_windows`, `get_window_state`, and `set_value`.
The runtime does not request screenshots, coordinate input, clipboard access,
foreground escalation, telemetry, automatic update or an unrestricted mode.

## Value verification and recovery

Some Windows RichEdit TextPattern document ranges include a terminal paragraph
CR. Only an explicitly reviewed `uia_single_line_document` field may remove
one terminal CR. It never trims spaces, LF, CRLF, repeated CR or internal line
breaks. Default exact comparison remains unchanged.

Before dispatch the runtime records a pending command and the adapter records
an action claim. Any uncertain outcome stops with `reconciliation_required`.
No fallback executor retries a possibly performed write. An authoritative
pre-dispatch failure can be reconciled as `not_performed`; matching text alone
cannot clear an unknown dispatch. Grants remain consumed after attempted
dispatch and are not reset by process restart.

## Phase 77 measured acceptance, 2026-09-28

Real Windows Character Map, product MCP stdio, existing ready Work, fresh test
window, exact Korean/English draft, no clipboard copy/file save/message:

| Measurement | Final sample |
|---|---:|
| Agent Office MCP startup | 817 ms |
| Work-bound Windows run creation | 7 ms |
| Observe → authorize → input → independent readback | 9,004 ms |
| CUA child connect within that step | 195 ms |
| Input operation within that step | 1,837 ms |
| End to end, including test-window setup and cleanup | 12,215 ms |
| New LLM / Jev calls during execution | 0 / 0 |

Two native samples passed (10,477 ms and 9,004 ms for the execution step).
The final path performs one inventory read and three fresh field observations.
These are individual samples, not a benchmark distribution or a claim of
sub-second interaction. Native observation remains the dominant cost.
The earlier existing Work was created by a real Codex subscription in Phase 76;
that separate 17.494-second intake is not hidden inside these execution numbers.
Token counts for that earlier call were unobserved.

Earlier failures are retained: pre-input observation timeout, closed target
window, and exact readback mismatch caused by the paragraph CR. The timeout
case was reconciled through the product as known not performed. The CR case
was not relabeled successful; new native runs used an explicitly reviewed
field encoding.

Both successful runs closed the product-owned CUA process and Agent Office MCP
process. The controlled test window was also closed. Other applications and the
pre-existing CUA installation were not stopped.

This is a successful native workflow-step test, not full completion of every
Work check, all ten profiles, Kakao self-chat, installer distribution, or a
production deployment. See `docs/handoff/phase-77.md` for regression evidence.

Sources: [CUA release](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.30.2),
[Windows MCP tools](https://cua.ai/docs/reference/cua-driver/mcp-tools-windows),
[bounded manifests](https://cua.ai/docs/how-to-guides/driver/write-a-bounded-manifest).

## Phase 78: verified procedures and focused observation

Repeated execution reuses **where to look and how to judge**, not a previous
answer or old screenshot. Two typed specifications are stored in local SQLite:

- The native field locator: label, AutomationId, class, role and exact readback
  encoding. Its key includes Work, workflow version, application/window identity,
  field intent and pinned executor version/digest.
- The semantic judgment specification: `ready_when`, `target_when` and
  `reobserve_when`. Its key also binds the Work revision, current control labels
  and roles, task intent and configured model-settings revision. Replacement
  text, live element IDs and coordinates are not passed to the design model.

Only a separately verified, action-bound result promotes a specification. Cached
entries expire after seven days, have schema/hash checks and are capped at 512
rows. An old specification never grants input permission: the host still needs
a current window scope, exact intent/value approval and a fresh one-use grant.
CUA action tokens are never persisted and are discarded after a completed turn.

On Windows, a lazy, hidden, read-only UIA helper reads the one approved Edit field.
It verifies the exact HWND/PID/title/application, window availability, unique
label, class/AutomationId, process start and live UIA identity. It exposes no
input, shell proxy, clipboard, screenshot or network operation. CUA retains
ownership of discovery, native snapshot tokens and **all writes**. The helper
exits with its owning runtime; it is not another always-running service.

| Path | First observation | Before input | After input |
|---|---|---|---|
| Original `full` | CUA window inventory + tree | New CUA tree | New CUA tree |
| Focused, first verified run | Exact UIA probe + CUA tree | Exact UIA probe | Independent exact UIA probe |
| Focused, saved procedure | Exact UIA probe | Exact probe + fresh CUA token/projection | Independent exact UIA probe |

CUA 0.30.2's `query` projects returned rows **after its native tree walk**; this
option is not advertised as eliminating that walk. The UIA helper avoids
serializing the rest of the window and reading unrelated control values, but
its provider may internally search descendants. Native tree-walk cost is not
assumed to be zero. Each write still requires one current CUA snapshot.

An initial locator mismatch may trigger one read-only rediscovery. A field
change after approval or an unverified post-input value stops execution instead
of silently choosing another target. Possibly performed effects remain behind
the existing reconciliation fence; there is no automatic input replay.

### Model participation

The Pack's existing Jev policy, data consent, saved models and Work opt-out remain
authoritative. There is no additional Work-design on/off decision.

- Exact host-reviewed local fields use the existing code-only path: zero model
  calls, including on the first run.
- A semantic step with Jev enabled may use the configured LLM once to design
  its three bounded conditions. Jev evaluates current state and target together.
- Verified repeats load the conditions and skip that LLM design call, not the
  fresh observation. An unknown/failed judgment goes to the configured LLM;
  repaired conditions require a new independently verified effect to be saved.
- With Jev off/unavailable, the configured LLM path remains usable. If design is
  unavailable, the original Pack conditions remain the fallback; a cache hit is
  not invented. Permissions and completion are checked by code in all paths.

Phase 78 used question/catalog version `2`; version-1 calibration was not silently
reused. The current version is documented above. Thresholds remain provisional. Fixture
tests verify call routing and cache invalidation, not real Jev accuracy or a
measured native Jev speedup.

### Native measurements

Same test-owned Windows Character Map, same product MCP path, Node 22.22.0 and
CUA 0.30.2. Each sample launches a fresh app and MCP; the repeat uses the persisted
locator across both restarts. No Codex Computer Use, screenshot, clipboard copy,
file save, external send, or model call was used.

| Sample | Observe through independent readback | Including test setup/startup/cleanup |
|---|---:|---:|
| Original full observation | 7,059 ms | 13,733 ms |
| Focused first run, cache miss | 3,105 ms | 8,492 ms |
| Focused repeat, cache hit | 3,014 ms | 6,493 ms |

The repeat is about 57% shorter than the full-observation sample. Its input-time
exact probe was 20 ms and post-input probe 29 ms; CUA snapshot/token acquisition
and input still took about one second each. These are individual observed
samples, not p50/p95 or a guarantee that every second run is faster. The savings
here come from executor observation changes, not Jev. All test-owned processes
exited. See `tests/evidence/phase78-windows-repeat-native.json` for final acceptance
and failure-boundary checks. Reviewed `windows.form.draft` is the native scope;
other Windows workflow profiles and all-app support are not implied.

The final build (including completed-turn token invalidation) was retested after
the full quick suite: **6,191 ms full versus 3,070 ms focused repeat**, about 50%
shorter; total test lifecycle 12,491 ms versus 6,415 ms. Closing the owned target
before observation was refused without any input in 687 ms. A fresh, explicitly
granted window then completed in 2,697 ms after the stale locator was invalidated.
Full quick passed 826/826, including input-fingerprint integrity; long soak was
excluded. Historical failures remain in the cumulative report.

## Native chat-room prototype (Phase 79)

`CuaChatSession` adds a scoped host adapter for one reviewed KakaoTalk room and
exact message. A separate reviewed-chat profile permits observation, click,
scroll and exact value replacement; default local-field tools and the self-chat
workflow remain unchanged. It is not a public MCP chat tool or an automatically
routed Windows Pack Run.

The real chat list exposed no actionable UIA rows. The connected agent selected
the requested row from a private screenshot, then checked the opened room's
native title and RichEdit composer. Later observations may omit screenshots,
but this is not the Phase 78 saved-locator cache. Direct `set_value` matters:
the initial native `type_text` appended placeholder text, caught by readback
before sending. Exact replacement corrected the owned failed draft.

Host scope binds request, Work reference, PID/window, room, text and expiry.
Current room/composer/bounds are checked before input. SQLite claims precede
dispatch and survive restart; uncertain sends never replay or become delivered
automatically. Sending additionally requires current visual grounding and a
trusted action-time human confirmation. Private chat data is not published.

Native validation reached a verified local draft, **not a sent message**.
Send-button readiness and remote receipt remain unverified. The catalogue still
has ten Windows profiles; this does not imply all-app support. See
`docs/handoff/phase-79.md` for measurements, failures and resume instructions.
