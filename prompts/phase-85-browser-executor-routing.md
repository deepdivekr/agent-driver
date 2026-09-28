# Phase 85 — First-class browser executors

Implement the user-requested Work-driven selection of Playwright, BrowserOS Neo
and Aside. Separate host foreground from guest/background execution.
Reuse Pack-owned optional Jev, saved model selection and existing billing fences.
No external submissions, credential copying, public release or unrelated-process shutdown.

## Exact requirements / TODO

- [x] RQ-778: Define a shared browser executor contract and host configuration that separates engine, environment, profile and verified capabilities without silently widening foreground or guest access.
- [ ] RQ-779: Implement real Playwright, Neo MCP and Aside MCP adapters with owned-tab lifecycle, bounded operations, fresh observations and explicit unsupported capabilities.
- [x] RQ-780: Connect Work and Pack browser selection to eligible live executors and the existing optional Jev/LLM Decision Plane, retaining calibration evidence and verified repeat paths.
- [x] RQ-781: Persist browser checkpoints and bounded executor handoff with fresh destination evidence, completed-step preservation and no replay of uncertain external effects.
- [ ] RQ-782: Run and record real available Windows and isolated-browser acceptance plus environment-specific timings; assess Ubuntu and Windows VM routes without presenting unavailable environments as passing.
- [x] RQ-783: Verify new and affected runtime paths, run the quick regression without long soak, and update user guidance, evidence, status and handoff with exact remaining limits.

Native acceptance may create/close only its own tabs and harmless drafts.
Record unavailable guest environments honestly and continue independent implementation.
