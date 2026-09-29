# Phase 95 — State-aware connection setup

Read first: prompts/phase-95-state-aware-connection-actions.md,
src/observability/browser-setup-ui.ts, src/onboarding/browser-setup.ts,
src/observability/settings-ui.ts and tests/runtime-browser-setup.test.mjs.

Node 22.22.0, npm 11.11.0, package 0.3.1 unchanged.

RQ-823 diagnosis: successful connectivity check is not runtime authorization.
The UI exposed download/check/register together, then reported missing consent
only in the below-panel notice. CLI absence is not proof of GUI absence; Neo
endpoint failure is not proof that the app is uninstalled. Preserve unknowns.

RQ-824 done. Browser actions now follow unchecked -> missing CLI or disconnected
-> reachable/permission -> connected, without claiming a missing GUI from a
missing CLI. The explicit Allow & connect action carries profile-use consent;
checks alone do not register. Completed actions remain disabled after the shared
action lock releases. Errors and stale revision/freshness instructions are beside
the relevant row. Login-needed clients no longer show MCP connection alongside
login; install continues to login and completed AI login refreshes into Manage.
Windows JSON instructions are visible and expressly not terminal commands.

RQ-825 done: 75 affected cases plus input integrity passed (76/76), receipt
tests/evidence/runtime-tests-2026-09-29T03-13-09-576Z.json. Includes 16 localized
layout combinations and eight browser state/action flows. Build passed; fixture
auth/registration is not real provider certification. Initial 17/19 run at
03-07-10-346Z retained: generic feedback hid CLI guidance (production fixed), and
shared layout fixture kept a ready browser between combinations (fixture isolated).
Managed product 8aec224 is applied and PR branch pushed. Upgrade receipt:
tests/evidence/phase95-ui-upgrade.json; Windows UI/probe receipt:
tests/evidence/phase95-native.json. Both recorded as independent user_environment
PASS cases in the private report. Actual Korean/English instructions are visible,
describe Windows app/IDE MCP configuration and explicitly exclude terminal use.
The real Aside check succeeded and showed only Allow & connect / 허용하고 연결.
No permission/registration, login completion or paid model call was performed in
the personal config. Native browser preferences restored to English/dark/Agents,
Windows disclosure open and tail closed. Registration completion/missing CLI/auth
completion are fixture evidence only. Public main merge/release is separate.

Current managed product: 8aec224; UI PID 853116; same private Control Center URL.
Previous UI 830711 stopped only after exact process identity validation, with
rollback ref refs/agent-office/pre-state-actions-update-20260929 at bf8cfec.
Personal MCP PID 447350, private Work and model settings are preserved. Phase 94
passed 71 cases plus integrity and native Windows layout/Manage checks; do not
reinterpret fixture logins or registrational writes as real browser success.
No paid model or business operation is authorized by these UX requests.
