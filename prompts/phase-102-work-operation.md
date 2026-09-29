# Phase 102 — Common Work operation and real acceptance

## Requirements / TODO

- [ ] RQ-843: Connect explicitly started new Work to a durable bounded operating loop with actual execution, leases, checkpoints, restart recovery and progress observations.
- [ ] RQ-844: Carry pause, changed instructions and resume through the same Work contract; preserve completed steps and reconcile uncertain effects before any retry.
- [ ] RQ-845: Connect imported Work to supported original runtimes for actual observation and control without duplicating bots or changing existing schedules/delivery.
- [ ] RQ-846: Apply configured model continuity with Work-bound handoff receipts and saved model choices; retain the prohibition on subscription-to-paid-API fallback.
- [ ] RQ-847: Persist and show Work results, artifacts and delivery receipts; keep app delivery as the new-Work default and preserve imported delivery authority.
- [ ] RQ-848: Exercise native runtime execution through the Control Center and verify recovery, intervention and results; retain contract/native distinctions and unresolved environment failures.
- [ ] RQ-849: Run affected and required quick regressions without soak, apply the verified local candidate preserving personal Work/settings, and update status/handoff/capability documentation.

The user authorizes completion and real-use tests. Use a disposable read-only Work and existing connected subscription client for bounded actual model execution. Existing private bots, external sends, schedules and publication require their own authorization; do not transfer authority from another task. Preserve Phase 99 and 101 changes. Do not replay uncertain writes or bypass authentication. Node 22.22.0/npm 11.11.0 remain pinned.
