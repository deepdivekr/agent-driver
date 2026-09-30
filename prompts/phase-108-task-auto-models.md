# Phase 108 — Task-level automatic role models

## TODO

- [x] RQ-874 | Separate default client/model selection from role policy with inherit, manual and task-auto modes; preserve legacy manual settings, coding priority and subscription-only billing boundaries.
- [x] RQ-875 | Let the LLM allocate task roles once from verified subscription client/model candidates, validate every assignment, persist a task/settings-bound receipt and reuse it; unavailable or invalid allocation must fall back visibly without authorizing paid API or arbitrary models.
- [x] RQ-876 | Apply allocations to Work execution, Swarm planning/workers and verification without cross-Work leakage; show allocation progress, chosen models, rationale and fallback in localized Work details.
- [x] RQ-877 | Verify settings, candidate validation, reuse/invalidation, runtime propagation and Korean/English desktop/mobile flows with isolated tests; document exact evidence and remaining live-model limits.

Do not restore the reset personal installation, run private Works, call paid models, publish or release. Preserve all preceding changes. Automatic allocation uses the existing LLM bridge, not an additional Jev policy.
