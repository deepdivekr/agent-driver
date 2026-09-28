# Phase 83 — Common desktop recovery and release assessment

Implement application-neutral recovery. Preserve the user's Work, completed effects,
Pack-owned optional Jev policy, configured models and foreground permissions.
Do not publish, send messages or restart private applications during acceptance.

## Exact requirements / TODO

- [x] RQ-772: Introduce bounded common screen recovery for capture failure, minimization and obscuration, with current identity, foreground grants, independent reobservation and durable diagnostics.
- [x] RQ-773: Recover pre-dispatch state drift through bounded reobservation and existing Pack judgments, preserving completed work, approval boundaries and uncertain-effect no-replay.
- [x] RQ-774: Verify common recovery on contract cases and owned native windows; classify modal, missing-app, unresponsive and unsupported states truthfully without app-specific exceptions.
- [x] RQ-775: Audit stable-release readiness, run quick regression and fresh/upgrade installation of the current candidate, and document remaining public-user blockers with evidence.

No long soak. Native faults target only separately launched test-owned windows.
Fresh/upgrade tests must use a disposable committed snapshot of the current tree,
not the older HEAD of the dirty development checkout.
