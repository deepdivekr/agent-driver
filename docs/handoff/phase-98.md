# Phase 98 — Scoped project import

Read prompts/phase-98-import-scope.md, src/work/import-runtime.ts,
src/work/plan.ts, src/work/context.ts and src/observability/work-ui.ts.

RQ-831/832 done. Workflow and bot project import accept an optional 2,000-character
scope prompt. It identifies features to include/exclude, not a filesystem sandbox.
The bounded read-only scan is unchanged and the UI explains this distinction.
Approved analysis receives redacted user_scope separately from repository evidence;
instructions prohibit substituting the whole project when evidence is missing.
The scope is shown in preview and Work detail, stored in the import and plan, and
included in coding prompts and protected continuity instructions. Source freshness,
activation/approval, Jev policy and empty-input behavior remain unchanged.
Changed input invalidates previous preview and an in-flight stale response.
Scoped bot goals use the analyzed goal instead of a generic whole-project suggestion.

Build passed. Affected suite 90 cases + input integrity: 91/91 PASS,
tests/evidence/runtime-tests-2026-09-29T04-32-31-453Z.json.
Includes HTTP/MCP, model unavailable/unapproved, long and invalid input, redaction,
mixed project, separate draft identity, SQLite reopen, source drift, handoff,
English/Korean desktop/mobile, escaped preview and input edited during analysis.
Fixture models only; this does not measure real-model semantic scoping accuracy.
Screenshots in tests/evidence/phase98 inspected at 1280px Korean and 390px English.
First run 50/51 retained at 04-30-56-413Z; the invalid request expectation was 400
but the existing import API contract is 409. No failed case was removed.

RQ-833 pending managed local update and actual Windows UI check.
Keep personal MCP, private Work, model settings and the existing URL unchanged.
Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged. No paid calls, source project
writes, auth changes, external push or release.
