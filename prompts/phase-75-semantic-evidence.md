# Phase 75 — source-grounded semantic evidence

Implement the useful uncovered Jev use cases requested by the user. Reuse the common Decision Plane and saved providers; do not introduce another Work-level Jev planning policy, change models, or enable paid fallback.

## Exact TODO

- [x] RQ-737: Audit the twelve Jev use cases against actual call sites and current official guidance; select useful gaps without duplicating existing memory, routing or calibration systems.
- [x] RQ-738: Add source-bound citation and extraction verification to collection Packs, with deterministic fast paths, bounded semantic batches, configured LLM correction and explicit unverified results.
- [x] RQ-739: Add optional relevance-based Work reference selection that retains source excerpts verbatim, preserves all mandatory continuity constraints and obeys existing Pack/model consent and opt-outs.
- [x] RQ-740: Verify semantic decision boundaries and end-to-end wiring using repeatable regression cases; preserve failures, document evidence levels and avoid claims of live accuracy, speed or deployment without measurements.

## Boundaries

- Work happens in the preserved Windows candidate. Original WSL changes must survive a later merge; this is not an installed-runtime update.
- Jev remains optional. Pack-owned criteria, global OFF, explicit Work OFF and model-data consent stay authoritative. Unknown is not success.
- Exact matches, missing inputs and field validation are code decisions. Literal copying is not semantic verification. Model answers never grant execution, approval or independent readback authority.
- Batch only independent questions. Persist hashes and typed verdicts in the existing decision journal, not raw provider payloads or secrets.
- Context selection operates on recorded references only, not arbitrary filesystem paths or another client's credential stores. Never prune the continuity core, current user directions, approvals or uncertain-effect receipts.
- Regression fixtures check routing/contracts and known decisions, not measured live-model accuracy. No long soak or native UI/browser tests required for this change.
