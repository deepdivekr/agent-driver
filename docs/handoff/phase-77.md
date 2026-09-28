# Phase 77 — owned CUA native executor

## Request and scope

Use Agent Office's own runtime instead of Codex Computer Use. No Codex UI action
was used in this phase. Preserve the existing global CUA 0.8.1 installation.
Authoritative checkout remains release-v0.2.0 with pre-existing dirty changes.

## Implemented

- Independent, pinned CUA 0.30.2 Windows stdio child, lazy first observation,
  bounded reviewed manifest, safe child environment, resource limits and cleanup.
- Host config automatically wires the driver into the real RuntimeApi/MCP path.
  No injected fake native adapter in user-environment acceptance.
- Extracted backend-neutral NativeFieldDriver; legacy window2 is only a
  compatibility wrapper. CUA uses native structured elements and snapshot tokens.
- Exact approved-field code fast path; optional Jev/LLM semantic path unchanged.
- Durable one-use grants, fresh input-time field checks, independent readback,
  expiry/revision fences, uncertain-effect holds and product reconciliation.
- Explicit TextPattern paragraph-CR profile; exact comparison is default.
- Reduced repeated native window enumeration and redundant observations around
  code-only target selection. Preserved final pre-input and post-input checks.

## Evidence

- Build: pinned Node 22.22.0, npm 11.11.0, TypeScript 7.0.2.
- First focused run: 89/90; preserved
  `tests/evidence/runtime-tests-2026-09-28T01-48-16-296Z.json`.
  The new restart test reused a stale command after changing the observed value;
  corrected it to test the persisted grant with a newly bound command.
- Focused: 90/90 at `tests/evidence/runtime-tests-2026-09-28T01-49-08-070Z.json`.
- After readback profile and observation changes: 92/92 at
  `tests/evidence/runtime-tests-2026-09-28T02-00-16-591Z.json`.
- Final full quick: **807/807 PASS** (806 cases plus input fingerprint integrity),
  zero BLOCKED_ENV / NOT_RUN, at
  `tests/evidence/runtime-tests-2026-09-28T02-02-15-882Z.json`.
  Long soak excluded as requested. Ledger: 43 RQs. `git diff --check` passed.
- Real native: existing LLM-created Work, Windows Character Map, product MCP,
  actual set_value and independent fresh UIA readback. Passed twice: 10,477 ms
  and 9,004 ms. New Jev/LLM calls: zero. CUA and MCP children exited.
- Preserved pre-input timeout, authoritative not-performed reconciliation,
  closed-window refusal, and paragraph-CR readback failure separately.
- Sanitized native record: `tests/evidence/phase77-owned-cua-native.json`.
  Initial acceptance-setup typo (`terminate_app` instead of documented
  `kill_app`) failed before a product run and is also retained.

## Private local artifacts

`C:/Users/<user>/projects/agent-driver-phase76-native/` contains the Windows
staging runtime, local reviewed grants and live JSON reports. Do not publish
private host configuration, raw UI observations, local paths or credentials.
Portable CUA is under `%LOCALAPPDATA%/AgentDriver/tools/cua-driver/0.30.2/`.
Archive SHA-256:
`bbf9909b92cf57e6faf0edc3542cff2accd52096e34d56baadcf1a2340c8ec2d`.
Main executable SHA-256:
`444fc69ea42ea27a0ca2c87edc93c6d1223de9b01cef64f992f0adef08233d5e`.

## Remaining limits and first files to read

Only reviewed local draft fields are connected. KakaoTalk and other Windows
profiles, user-facing native-scope UX, WSL-to-Windows broker, live semantic
calibration, all-app control and installation/distribution remain separate work.
The 9-second measured step is not a sub-second speed claim. A completed Windows
step is not automatically a completed Work.

Read `src/desktop/cua-field-driver.ts`, `cua-connection.ts`,
`native-field-driver.ts`, `windows-runtime.ts`, and
`docs/owned-windows-executor.md` first. No external publish/commit/deployment.
