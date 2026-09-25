# Control Center action audit — 2026-09-25

Scope: PR #26 (Agent Office UI), starting at `3ac249c`. The user authorized the final audit, fixes and merge to main. This is not a release-tag update.

## Corrections from the audit

- An unavailable per-Work Jev switch could become enabled after checking the cost box, while its handler silently returned. The checkbox and handler now share the same capability gate.
- A live Work refresh could discard the cost acknowledgement between checking it and clicking the switch. The acknowledgement now remains within that Work and resets when switching Work or saving the toggle.
- A delayed settings response could leave a Work missing the AI-consent/retry action. It now updates the waiting detail when the response arrives.
- Setup controls were actionable before initial settings loaded. Loading and in-flight actions now lock the relevant fields and buttons; failed startup offers an explicit reload action. Late provider-catalog responses cannot replace another provider's selection.
- Site-login buttons now react to persistent-browser availability changes even when the site list itself is unchanged.
- The unregistered-project message no longer points to a nonexistent project-registration settings screen. It describes the actual registered-project prerequisite.
- Both READMEs now describe model choice preservation and the absence of arbitrary first-model selection.

## Action inventory and evidence

Every authored button/action in the three current pages was traced to its handler. Disabled prerequisites and explanatory controls are distinguished from executable actions.

| Surface | Controls / result | Verification |
|---|---|---|
| Work board | Short titles, search, list/board, status filters, open/back, live updates | Browser interaction plus durable board/detail API tests |
| New Work | One-line submit, guided answers, definition retry, AI consent | Browser interaction and Work intake contract tests; fake model, real local HTTP/SQLite |
| Work control | Pause/resume, edit a future stage, reject stale revisions/in-flight effects | Browser interaction and persisted runtime/control tests |
| Work Jev | Cost acknowledgement, on/off, unavailable state, refresh preservation | New browser regression reads persisted Work state; **no Jev API call** |
| Import | Copy prompt, paste JSON, scan workflow, scan bot, review/save draft | All three paths clicked through real local HTTP; project code unchanged; no run activated |
| Coding conversation | Explicit project/session choice, user instruction, stop, reconciliation, separate reply/advice | Existing browser reply/reconciliation tests plus session catalog, stop, attach and recovery contract/native-fixture tests |
| Imported coding | Implementation plan, per-step start, prerequisite and revision gates | Existing import-coding HTTP/runtime tests; no real project mutation in this audit |
| Agent setup | Install, official login, MCP register, refresh, Windows command copy | Desktop/mobile browser -> real settings handler -> injected installer/auth/MCP; callback counts and visible state/logs checked |
| Local/AI settings | Local approval, subscription/API selection, catalogs, billing gate, model/key save, optional Jev, finish | Real local settings persistence; fixture provider; field masking and mobile overflow checked |
| Setup resilience | Loading lock, failed-load retry, explanation dialog, terminal expansion, language | New browser failure test and existing bilingual page tests |
| Site login | Open, check, retry, unavailable state, failed-action recovery, independent language switch | Real page with intercepted browser actions; same-origin API authorization tests |
| Navigation | Work filters, import, connections, settings | Shared anchors and browser route tests |

Relevant suites: `runtime-control-action-audit`, `runtime-settings-ui`, `runtime-office`, `runtime-office-merge-regressions`, `runtime-work`, `runtime-work-migration`, `runtime-coding-dialog-ui`, `runtime-coding-dialog`, `runtime-coding-dialog-recovery`, `runtime-work-import-coding`, `runtime-control-settings`, `runtime-browser-auth`, `runtime-control-center-i18n`.

## Verification record

- Targeted Control Center regression: **73/73 PASS**, including input fingerprint stability. Evidence: `tests/evidence/runtime-tests-2026-09-25T02-58-47-535Z.json`.
- TypeScript build and whitespace/diff validation passed.

Browser interactions exercise the real rendered UI; injected account/provider/browser behavior is **fixture evidence**, not real-account certification. The repository reporter keeps `evidence_level` and `status` separately in `tests/report.json` and the run evidence JSON. Full-suite and remote-CI results are recorded on PR #26 after execution.

Development probes preserved the following findings: the original Jev refresh race failed before its state-preservation fix. Two test-authoring assumptions were corrected (the unapproved Work does not call the model at all, and the short Work detail has no explanation button; dialog coverage belongs on settings). These are not represented as a successful original run.

## Remaining boundaries

- No paid model calls, real website logins, real client reinstall, external form submission or production deployment were performed.
- A Work being saved/defined is not automatic execution or verified completion. The connected orchestrator and configured executors must dispatch it. The UI explicitly reports this.
- Coding can select only registered projects; it does not yet provide a project-registration form.
- Real Windows native drivers, all provider accounts, and every third-party site are not certified by local UI/CI fixtures.
- Long-running soak remains outside the default regression suite, per the user's existing instruction.
- The installer remains pinned to v0.1.0 until a separate release is prepared.
