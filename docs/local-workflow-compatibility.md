# Retaining local workflow extensions during upgrade

Some existing installations contain privately maintained workflow adapters. Their
host file has a `workflows` policy and their local runtime exports
`workflowCall` / `workflowTools`. These adapters are not shipped in the public
repository. Removing their policy during upgrade would disconnect existing work.

The candidate now preserves that policy, and can connect a **host-reviewed local
adapter** through a narrow compatibility ABI. This is not a separate personal
edition, a plugin marketplace, an arbitrary MCP proxy, or a security sandbox.

## What changes

- `workflows` remains bounded by the host configuration size limit. Other unknown
  top-level fields are still rejected. Keeping this field does not run anything.
- Without a registered bridge, `runtime_workflow_catalog` reports
  `WORKFLOW_COMPATIBILITY_CONNECTION_REQUIRED`. Run/status fail explicitly; no
  existing workflow is silently converted to a new Pack or marked ready.
- A trusted operator can register two absolute local modules, their SHA-256 pins
  and the exact policy hash. Only the three existing workflow operations are
  exposed: catalog, run, status. The retained module validates its policy and
  request schema before invocation. The model cannot register a module.
- Connection/configuration changes and modified entry modules fence subsequent
  calls. Replacing a loaded module requires restarting its MCP process; the ESM
  cache cannot silently masquerade as a new version.
- No automatic retry is added. The existing adapter keeps its own request IDs,
  locking, receipts, approvals and uncertain-effect reconciliation. The bridge
  does not add general Work pause/approval semantics to an older adapter that
  never supported them. Review that adapter before enabling it.

Registered modules and their dependencies execute as trusted local software.
Pinning the two entry modules does not audit all transitive dependencies or
provide process isolation. Keep the retained installation in place, including
its scripts and dependencies; do not delete it during installer cleanup.

## Migration and rollback

Linux/WSL operator CLI (run from the candidate checkout):

```sh
node dist/cli.js compatibility plan --config /absolute/host/runtime-config.json \
  --runtime-root /absolute/retained-installation \
  --plan /absolute/private-backups/workflow-upgrade.json

node dist/cli.js compatibility apply \
  --plan /absolute/private-backups/workflow-upgrade.json --sha256 PLAN_SHA256

node dist/cli.js compatibility rollback \
  --plan /absolute/private-backups/workflow-upgrade.json --sha256 PLAN_SHA256
```

Use the `plan_sha256` returned by preparation, after reviewing the retained
adapter. Preparation never imports or invokes it. The private 0600 plan contains
the exact original configuration as a rollback backup: do not commit or share
the plan. CLI output contains hashes and status, not policy values.

Apply changes only `workflow_bridge`; all original settings remain. It checks
plan/config/module/policy hashes, locks the configuration, writes durably and
atomically, and refuses to overwrite intervening edits. Retrying apply or
rollback is idempotent. Rollback restores the original bytes even if the module
has since become unavailable. A stale lock after a process crash requires the
operator to verify that its recorded owner is gone; it is not stolen silently.

This tool does **not** install a release, rewrite client registration, migrate or
restore a database, start a schedule, reissue an approval, or run a workflow.
Coordinate MCP shutdown/restart before applying to a live installation; an old
process cannot be assumed to understand a newly added configuration field.
For testing under a different directory, relocate only the disposable copy's
project profile binding. Never loosen `PROJECT_BINDING_IMMUTABLE` in production.

Changing the host configuration changes its normal fingerprint. Keep existing
approval records, but do not silently grant them fresh authority for a changed
execution binding. General data/release rollback is a separate operation.

## Verification

`tests/runtime-workflow-compatibility.test.mjs` covers strict policy preservation,
missing bridge, request validation, repeat dispatch, uncertainty, live revocation,
changed modules, private backups, exact rollback, drift, locks, symlinks, module
cache invalidation, CLI and the shared RuntimeApi path.

Actual-user acceptance uses a disposable SQLite backup and private configuration
copy. It connects the real retained adapter through the latest stdio MCP, reads
its catalog and a historical receipt, and reconnects the old MCP after rollback.
No private domain code or policy values enter the public source/evidence.
No actual workflow, notification, browser or paid model is executed in that test.
See `tests/evidence/phase86-workflow-compatibility.json` and
`docs/handoff/phase-86.md` for outcomes and remaining release limits.
