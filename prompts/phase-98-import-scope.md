# Phase 98 — Scoped project import

## Requirements / TODO

- [x] RQ-831: Add an optional natural-language import scope field to workflow/bot project import, with concise Korean/English guidance, preview and stale-preview protection.
- [x] RQ-832: Carry the user's scope through HTTP/MCP scan, approved project analysis, saved import and Work/hand-off instructions; preserve legacy empty-input behavior, source freshness, approvals and Jev policy.
- [ ] RQ-833: Verify mixed-project scope propagation, invalid/empty input, model-unavailable behavior, repeated import, and desktop/mobile UI; apply the verified local Control Center preserving personal Work/settings/MCP and document exact evidence.

Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged. No paid model calls or business execution. The prompt constrains the requested import, not filesystem permissions; bounded read-only scanning remains unchanged.
