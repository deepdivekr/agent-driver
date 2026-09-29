# Phase 96 — Grouped connection explanations

Read prompts/phase-96-grouped-connection-help.md, src/observability/browser-setup-ui.ts,
src/observability/settings-ui.ts and docs/handoff/phase-95.md first.

RQ-826 done. Browser explanations collected in one native disclosure, default
closed. Other settings prose uses context-specific Show explanation disclosures;
question-mark help removed from settings. Browser state/actions, concise profile
permission and inline errors retained. Windows JSON remains readable inside its
existing disclosure. The browser's completed action is no longer repeated in the
below-panel notice.

RQ-827 done. 28 existing affected cases plus input integrity PASS (29/29):
tests/evidence/runtime-tests-2026-09-29T03-46-33-318Z.json. Includes 16 layout
combinations and 8 browser state flows. Desktop Korean and mobile English closed
captures inspected. Initial 28/29 receipt at 03-44-28-380Z retained: a Work live-DOM
style observation failed; the same left/start alignment assertion now reads a
current connected node atomically. No Work production change. Build passed.
Actual Windows Aside checked Korean and English default-closed, blue-underlined
browser help, keyboard expansion/collapse, all three browser guides, and retained
open state on guide refresh. Agent, AI and Jev panel explanations are also closed.
Language, theme, current step, tail, disclosures and scroll restored afterward.
Private native receipts: tests/evidence/phase96-native.json and
tests/evidence/phase96-ui-upgrade.json; independently recorded in tests/report.json.
Provider installation/auth/registration remains fixture evidence, not live-provider
certification. No settings save, optional-browser registration or paid model call.

Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged. Managed product af50a34,
UI PID 865884, personal MCP PID 447350 unchanged. Same URL; private Work/model and
coding settings preserved. Rollback ref in managed checkout:
refs/agent-office/pre-grouped-help-update-20260929 points to 8aec224.
Branch fix/wsl-control-center-reachability / PR32; public merge and immutable
release are separate. Documentation-only completion does not require UI restart.
