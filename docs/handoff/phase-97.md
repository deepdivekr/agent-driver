# Phase 97 — English setup feedback and Windows bridge purpose

Read prompts/phase-97-english-setup-feedback.md, src/observability/i18n.ts,
src/observability/control-settings.ts and src/observability/settings-ui.ts.

RQ-828 and RQ-829 done. Setup history and live tail summaries translate
synchronously. Added missing browser events, durations, startup text, saved model
and default model-count fragments. Korean stored events stay unchanged; Windows
configuration paths bypass UI translation. No provider raw output enters the log.
Windows bridge is explicitly optional, with task flow, skip condition and
destination-app MCP configuration instructions. Its registration cannot be
automatically verified by this page.

RQ-830 partial. Check now emits immediate pending feedback, server-side start,
per-client installation/auth/registration results, and sanitized failure records.
Successful browser reachability remains separate from profile-use permission.
New mcp/check is a local-origin guarded POST; GET discovery remains non-recording.

Build passed. Affected suite 30/30 (29 cases + input integrity):
tests/evidence/runtime-tests-2026-09-29T04-08-42-178Z.json.
Includes 16 layout combinations and 8 browser state flows, a held check proving
start-before-result, failed checks, bilingual history/live tail, all four settings
panels, preserved Korean paths and model/config preservation. Mobile English
capture inspected. Earlier 27/30 receipt at 04-04-10-171Z preserved; two stale copy
assertions updated, new test exposed missing model-catalog translations, then its
collapsed/permission-state navigation corrected. Intermediate build failures from
duplicate translations/escaping fixed before the passing build.

Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged. Current managed UI af50a34,
PID 865884; personal MCP PID 447350 must stay untouched. Next: apply the exact
verified commit locally, check real English Check start/result and Windows help,
restore browser preferences, then record user-environment evidence. No public
release, provider auth/registration or paid model call in this phase.
