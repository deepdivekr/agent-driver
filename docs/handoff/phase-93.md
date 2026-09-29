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

Managed local UI application and actual Windows browser confirmation remain to
be recorded. Private settings, Work IDs and the separate personal MCP must be
preserved. The existing public release is not replaced by this candidate.
