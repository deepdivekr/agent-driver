# Phase89 — public v0.3.0

## Scope and candidate

Publish common functionality for Ubuntu 24.04 x86_64 / Windows 11 WSL2 Ubuntu.
Native Windows all-app control and macOS remain unverified/experimental.
Private installations, workflow implementations, credentials and schedules are
not publication or deployment targets.

English/Korean README shortened to installation, connection, first Work and
explicit limits. Default installer/package aligned at 0.3.0.

## Release fixes

- Added the v0.2.0 upgrade baseline beside v0.1.0, v0.1.1 and fresh installation.
- Installation probe accepts the three generic compatibility tools, not private
  workflow code, and stops only its disposable shared service.
- Shared-service reuse rejects different package versions and old receipts.
  Explicit stop refuses connected clients and preserves endpoint/token on restart.
- Historical private test receipts have public digest/count summaries in
  docs/validation/v0.3.0-history.json. Raw logs remain local and failures remain.
  The ledger references shipped evidence rather than missing ignored files.

## Verification so far

Build passed. Focused lifecycle/public-boundary suite: 10/10 checks passed
(9 cases and input integrity), including real protocol clients and owned
shared-process start/stop/restart. Evidence:
`tests/evidence/runtime-tests-2026-09-28T13-26-38-190Z.json`.

Final quick regression, four install/upgrade scenarios and remote CI/publication
are pending. No tag/release/main update yet. The existing open PR29 is not
silently merged; its unreviewed README/UI/auth changes remain separate.

## Resume

Read docs/release-readiness-v0.3.0.md, scripts/release/verify-install.mjs,
scripts/release/install-probe.mjs and src/interface/mcp-service-manager.ts.
Preserve candidate input while tests run; no soak or paid model calls.

Pinned: Node22.22.0, npm11.11.0, TypeScript7.0.2, Playwright1.63.0.
