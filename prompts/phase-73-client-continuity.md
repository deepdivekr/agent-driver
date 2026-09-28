# Phase 73 — Capability-aware connections and truthful handoffs

Adopt the useful connection/lifecycle invariants from Atlas without replacing the existing Work runtime or widening execution/billing authority. No vendor engine fork, automatic public release, paid model calls or personal-file mutations. The Windows candidate is based on the preserved source snapshot; merge into the authoritative WSL checkout only after recovery and content comparison.

## TODO (exact requirements)

- RQ-729: Introduce versioned client capability contracts and use them for structured-judgment dispatch, preserving saved models, client-owned authentication and existing billing boundaries.
- RQ-730: Join concurrent connection and authentication probes, invalidate changed or failed state, and prevent duplicate or orphaned login processes after cancellation.
- RQ-731: Harden handoff receipts and failure classification so invalid output, stale binding or uncertain effects cannot be reported as a successful transfer or silently retried as a provider outage.
- RQ-732: Verify connection, cancellation, recovery and persisted handoff behavior with isolated tests; document Atlas-derived invariants, source provenance, evidence levels and remaining environment limitations.
