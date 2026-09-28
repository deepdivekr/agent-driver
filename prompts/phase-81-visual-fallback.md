# Phase 81 — Common visual supplementation

Implement a common visual path for UIA gaps. Keep existing Work, Pack-owned
decision settings, authorized windows, action journal and postcondition checks.
Do not add application-name branches or use saved coordinates as current evidence.

## TODO / requirements

- [x] RQ-763 Define window-bound visual observations with honest provenance, current capture identity and bounded candidates; screenshots are not DOM or UIA.
- [x] RQ-764 Connect UIA-first visual supplementation to desktop planning and the existing Jev/LLM decision path without requiring application-specific adapters.
- [x] RQ-765 Execute only current, authorized visual targets and independently verify the typed postcondition; preserve approval, uncertain-effect and no-replay boundaries.
- [x] RQ-766 Reuse verified region and extraction hints to reduce repeated processing, invalidate changed state and bound memory without reusing stale action coordinates.
- [x] RQ-767 Verify contract, failure, repeat and harmless native paths; record actual timings and evidence levels, update documentation/status/handoff and run the quick regression without long soak.

## Scope

Owned CUA on Windows only for native input. No personal messages, external writes,
implicit foreground escalation, credential uploads, screenshot logs or public
private-screen artifacts. Native acceptance uses a separately launched controlled
window; this does not certify all applications or live Jev accuracy.
