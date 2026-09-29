# Phase 94 — Aligned and compact Control Center actions

Read first: prompts/phase-94-aligned-control-center.md,
src/observability/settings-ui.ts, src/observability/ui-shell.ts,
src/observability/browser-setup-ui.ts and tests/runtime-control-layout.test.mjs.
Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged.

## Changes

- Connections share aligned name, centered state and right-side action columns.
  AI rows have equal height; model fields and onboarding steps use equal columns.
- Buttons follow their localized text width, not the previous 112px fixed width.
  Common height, padding and 8px action gaps remain; `MCP 연결` visibly becomes
  `연결` / `Connect`. Client-specific accessible names retain MCP context.
- Browser check/download/connect actions sit in the header row at the right.
  Check, refresh, save and wizard actions share the right edge.
  Narrow screens wrap actions below without left-aligning them.
- Work/import, file approval, coding conversation, Hermes and remote controls
  reuse compact right-aligned action groups. Long instructions/logs remain left
  aligned. Blue underlined disclosures and keyboard controls remain intact.
- No authentication, permission, fallback, Task Pack or Work execution policy
  changed. No business Work or paid model call was made for this UI update.
- Subsequent user reference supersedes centered client names: lightweight inline
  icons and names are left aligned; state/action columns remain aligned. Client
  descriptions are removed from the agent-connection list. Button labels remain
  centered and compact. State/action clearance is at least 16px horizontally or
  12px vertically when narrow screens stack them.
- Connected clients expose Manage, which focuses their existing model setting
  or opens the existing connection panel. It never saves, replaces an unsaved
  choice, implicitly switches API/subscription mode or invokes a model.

## Verification and retained failures

- Build passed. Geometry covers 1280/768/375/320px, Korean/English and dark/light
  (16 combinations), with compact widths measured against text and padding,
  aligned centers/right edges, equal AI rows and no horizontal page overflow.
- Actual local Chromium Work UI exercised import routes and pause/resume without
  invoking a model. Connection install/login, browser check/registration and
  other auth flows are fixture-backed, not real login/task success evidence.
- Initial new Work test incorrectly used the non-pausable `defining` intake.
  Corrected the setup via the real definition-failure transition to `needs_model`;
  no product pause gate was relaxed. Original failure retained:
  tests/evidence/runtime-tests-2026-09-29T02-19-01-217Z.json.
- New geometry checks raced a cached ready badge and an in-flight browser check.
  They now wait for the existing enabled-control signal before measuring rows.
- The existing confirmation-label fixture overrode HTTP but left real SSE in
  `defining`, which intermittently replaced its simulated `needs_human` board.
  HTTP and SSE fixtures now agree; no production state label was changed.
  Retained receipts: runtime-tests-2026-09-29T02-21-29-445Z.json,
  runtime-tests-2026-09-29T02-23-58-111Z.json and
  runtime-tests-2026-09-29T02-25-00-523Z.json in tests/evidence/.

## Current boundary

Affected regressions: 70/70 cases plus input integrity passed. Exact receipt:
tests/evidence/runtime-tests-2026-09-29T02-26-32-225Z.json.
After the client-list/spacing refinement, 71/71 cases plus input integrity
passed (72/72). Exact receipt:
tests/evidence/runtime-tests-2026-09-29T02-46-46-612Z.json.
The geometry matrix now checks status/action clearance, all five local vector
icons and actual Manage focus/navigation while preserving unsaved choices.
Build, ledger verification and public boundary scan passed (562 files).
Desktop Korean/dark and mobile English/light AI/browser captures were visually
reviewed; all 16 geometry combinations include actual browser measurements.

Initial compact layout 19fdafb was applied to the managed installation with the
same URL. UI PID 820473 replaced only its identified predecessor; personal MCP
PID 447350 and private Work/config/global/coding settings were preserved.
Private receipt: tests/evidence/phase94-ui-upgrade.json. Subsequent reference
styling and spacing are verified locally but still need managed application and
actual Windows page inspection. Preserve the same state/process boundaries.
PR32/public merge and a new immutable release remain separate gates; do not
overwrite the existing v0.3.1 tag or assets.
