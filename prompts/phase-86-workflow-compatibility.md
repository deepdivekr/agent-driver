# Phase 86 — Preserve local workflow extensions during upgrade

Resolve the existing installation's legacy `workflows` incompatibility without
publishing private domain code, dropping configuration, replaying work, sending
messages or replacing the live installation during verification.

## Exact requirements / TODO

- [x] RQ-784: Preserve bounded legacy workflow policy in strict host configuration and expose an explicit trusted local compatibility bridge, without executing unregistered code or silently ignoring unavailable workflows.
- [x] RQ-785: Implement reviewable, fingerprint-bound configuration migration and rollback with durable private backups, drift checks and idempotent retry, preserving unrelated settings and original workflow authority.
- [x] RQ-786: Verify bridge dispatch, schema validation, policy/code drift, uncertain/no-retry boundaries, migration/restart/rollback and existing configuration on disposable copies; preserve live schedules, data and connections.
- [x] RQ-787: Run affected and quick regressions without soak; document current installation versus candidate, compatibility scope, exact evidence and remaining release gates.
