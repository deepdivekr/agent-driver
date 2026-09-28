# Phase 80 — Work-driven desktop execution

The user rejected treating a self-chat test and handwritten application profiles as product limits. Profiles are optional examples/verified procedures, not an application allowlist. A connected agent must be able to plan from a Work and observed capabilities, execute through the shared runtime, and reuse independently verified procedures without installing a new adapter for each app.

## TODO / requirements

- RQ-758: Remove the unintended global self-chat restriction and profile-only dispatch instructions; preserve exact user-requested targets and effect/approval boundaries.
- RQ-759: Generate and persist typed desktop procedures from a ready Work and connected executor observations; bind them to Work revision and capabilities, and execute them through the existing Windows run journal.
- RQ-760: Add an application-neutral owned-CUA path using observed controls and independently checked postconditions, with no app-name branches or invented completion evidence.
- RQ-761: Reuse only verified procedures, invalidate changed state and expose reobservation/replanning instead of requiring a new application adapter; preserve uncertain-effect no-replay and pause/revision checks.
- RQ-762: Verify generic first-run, repeat, changed-state and failure cases plus harmless native execution where possible; report contract/native limits separately and update ledger/status/handoff.

No real message sending, remote publication, recurring schedule creation or service-wide restart is authorized by this correction. Do not label a typed planning fixture as native application success.
