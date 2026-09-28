# Common desktop recovery

Phase 83 adds recovery to the owned Windows executor, not a KakaoTalk adapter.
The normal path remains UIA first, window-bound OCR only when needed. Healthy
observations do not add a window inventory request or an extra model call.

| Observed condition | Runtime response | Boundary |
|---|---|---|
| Window is covered but readable | Read the scoped window in the background | No unnecessary activation |
| Minimized, capture fails | Verify exact identity, restore once, obtain fresh evidence | `allow_window_restore` host grant required |
| Restored window cannot be captured | Verify exact identity, activate once, obtain fresh evidence | Separate `allow_window_activation` host grant required; failure alone does not prove obscuration |
| Navigation state changes while a model is deciding | Reobserve and ask the existing Pack decision path again | One correction per call, at most two per persisted step |
| Draft, write or send state changes | Preserve the content and require review | Never overwrite a human edit through automatic retry |
| Modal blocks the intended action | Existing Jev/LLM may return blocked; keep progress and request remaining-work redesign | No generic blind Close/Escape action, and no new authority |
| Window identity changes or a permitted recovery inventory has no target | Return a specific reconnect/reconfirm action | Do not bind another window by title alone |
| Native inventory explicitly reports not responding | Return application-responsiveness inspection | Missing responsiveness metadata stays unknown; not every CUA backend reports it |
| Click response or result is uncertain | Durable reconciliation; read-only inspection | No recovery focus changes or replay after dispatch |

The activation receipt is not proof of successful recovery. A subsequent exact
window inventory and usable fresh observation must both pass. Work pause,
revision, model settings and grant expiry are checked across asynchronous calls.
Native errors and private labels are not copied into recovery diagnostics.

## Persistence and cost

Visibility attempts are claimed in SQLite before activation. An unresolved
attempt is not repeated on a later caller retry. Verified recovery has a
30-second cooldown. Verified diagnostic rows are capped at 128; 512 unresolved
claims stop admitting new recoveries rather than growing without bound. A new
host-reviewed window grant is required to retry an unresolved visibility change;
ordinary reads can still succeed if the user has restored the window manually.

Navigation correction receipts stay in the same run, preserving completed steps
and the original Work binding. Each corrected decision uses a fresh observation,
not saved coordinates or an old approval. User pause always takes precedence.

The TypeSafe skill informed the split: exact visibility rules remain code;
semantic state and target judgments continue through the Pack-owned optional
Jev/LLM path. No new Work-level Jev switch or competing policy was introduced.
See [state](https://docs.typesafe.ai/concepts/state) and
[confidence](https://docs.typesafe.ai/confidence). These integration tests do not
measure real Jev accuracy, calibration, or a native Jev speedup.

## Native evidence, 2026-09-28

Test-owned Windows Character Map windows, CUA 0.30.2, Node 22.22.0. No Codex
Computer Use, user drafts, external send, clipboard modification or model call.

- Full cover by another owned window: UIA observation 2,317 ms; supplemental
  OCR observation 3,971 ms; no activation. Native previous-window traversal and
  independent bounds checks established cover. Both owned windows were closed.
- Minimized: native restore operation 2,595 ms; full failed-read / inspection /
  restore / fresh UIA+OCR path 15,670 ms. Next observation 3,220 ms, no second
  restore and no second OCR extraction. Owned app was closed.
- First cover test failed to establish the fault: PID-filtered CUA `z_index`
  values are not global ordering, and the test helper initially lacked DPI
  awareness. The failed receipt is retained; corrected fault verification uses
  DPI-aware positioning and native order traversal. This was a test fault setup
  failure, not a successful recovery relabeled afterward.

These are individual timings, not latency percentiles. Covered-window observation
and minimized restoration are native evidence; decision drift, modal refusal,
missing/unresponsive metadata, approval races and no-replay are contract tests.
Autonomous modal dismissal, app relaunch, icon-only perception and visual typing
remain outside the verified capability. See the stable-candidate assessment.
