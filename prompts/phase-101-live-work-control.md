# Phase 101 — Live Work execution and observation

## Requirements / TODO

- [x] RQ-838: Derive visible execution state from per-run leases and runtime observations, retaining stored historical state without presenting abandoned runs as live.
- [x] RQ-839: Add explicit, revision-fenced execution actions through existing runtime contracts; prevent duplicate dispatch, unauthorized effects and false starts; explain missing execution connections.
- [x] RQ-840: Stream bounded, redacted Work-scoped activity on detail pages; show last observed activity and connection state, shorten board titles without losing original instructions, and preserve drafts during updates.
- [x] RQ-841: Verify real local execution, lease expiry, idempotency, isolation, localization and responsive UI; apply the local candidate preserving private Work/settings and report unsupported paths honestly.

- [x] RQ-842: Explicit login opens the existing owned VM when stopped, preserves its profile, fences duplicate starts, releases failed handoffs and reports preparation/errors truthfully.

No private bot execution, messages, paid model calls, schedules, remote publication or merge as part of verification. Preserve Phase 99 changes. No synthetic progress or fabricated terminal output. Node 22.22.0/npm 11.11.0 remain pinned.
