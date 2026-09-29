# Phase 95 — State-aware connection setup

Read first: prompts/phase-95-state-aware-connection-actions.md,
src/observability/browser-setup-ui.ts, src/onboarding/browser-setup.ts,
src/observability/settings-ui.ts and tests/runtime-browser-setup.test.mjs.

Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged.

RQ-823 diagnosis: successful connectivity check is not runtime authorization.
The UI exposed download/check/register together, then reported missing consent
only in the below-panel notice. CLI absence is not proof of GUI absence; Neo
endpoint failure is not proof that the app is uninstalled. Preserve unknowns.

RQ-824/RQ-825 pending. State-specific actions and nearby feedback must retain
freshness, revision, explicit profile permission and default Playwright. Show
the Windows bridge JSON as MCP configuration, not an executable shell command.

Current managed product: bf8cfec; UI PID 830711; same private Control Center URL.
Personal MCP PID 447350, private Work and model settings are preserved. Phase 94
passed 71 cases plus integrity and native Windows layout/Manage checks; do not
reinterpret fixture logins or registrational writes as real browser success.
No paid model or business operation is authorized by these UX requests.
