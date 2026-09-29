# Phase 93 — User confirmation labels

Read first: prompts/phase-93-user-confirmation-label.md,
src/observability/work-ui.ts, src/observability/i18n.ts and
tests/runtime-user-confirmation-label.test.mjs.
Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged.

## Changes

- Work board/list/detail and Hermes/remote/legacy Work states show
  `사용자 확인 필요` for `needs_human`.
- Connection challenge tags and their wait explanation use the same wording.
- English display is `User confirmation needed`.
- Internal statuses, authentication detection, approvals and execution authority
  are unchanged. This is a display-only change.

## Evidence

- Build, ledger verification and public boundary scan passed.
- Affected paths: 38/39 checks passed initially. The added UI assertion searched
  descendants of a text-only badge, causing a selector timeout. Corrected the
  test locator without changing product code; original failed receipt retained:
  tests/evidence/runtime-tests-2026-09-29T01-49-04-553Z.json.
- Corrected label regression: 3/3 checks passed, including input integrity.
  Receipt: tests/evidence/runtime-tests-2026-09-29T01-50-39-722Z.json.
  Actual Chromium rendering of fixture states covered board, list, detail,
  site login, English/Korean and 1280px/375px viewports, with no mutation request
  or horizontal overflow. Fixtures are not real task completion evidence.

## Application

Managed product source 1f72ed69674cca3e17c094a0f7217f17aa2c5266 was applied
using the official installer. UI PID 792295, same URL, clean installed checkout,
private configuration/model settings/Work IDs and personal MCP PID 447350 were
independently verified unchanged. Only the identified UI process was restarted.
Private receipt: tests/evidence/phase93-ui-upgrade.json.

Actual Windows Aside displayed two existing Work badges with the new Korean
phrase, then two with the English translation; no obsolete tags observed.
Connection/Hermes/remote label maps were checked in the installed browser.
Original English language, dark theme and expanded Windows disclosure restored;
the owned verification tab was closed. No Work executed or settings saved.
Per-case evidence is retained in tests/evidence/phase93-native.json and
tests/report.json. Neo transport unavailable, existing authorized Aside fallback
used. The existing public release is not replaced by this candidate; PR32
contains the source patch, while public merge/release gates remain separate.
