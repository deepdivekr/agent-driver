# Phase 83 — common desktop recovery / stable-readiness assessment

## Result

RQ-772, RQ-773, RQ-774, RQ-775 complete for their recorded scope. **NO-GO for a
general Windows desktop stable release.** Existing historical partial Windows
requirements remain partial; see `docs/release-readiness-phase83.md`.

Implemented common capture/minimize/activation recovery with separate host
permissions, fresh identity/readback, SQLite attempt claims and cooldowns. Healthy
covered windows do not incur extra probes or focus changes. Navigation drift
uses bounded reobservation with existing Pack-owned Jev/LLM decisions and retains
the same run/progress. Draft/write/send drift never overwrites user edits.
Readback after dispatch cannot activate a window or replay the effect.

## Validation

- Focused first run 156/161 PASS, 5 FAIL: preserved in
  `tests/evidence/runtime-tests-2026-09-28T08-12-40-803Z.json`.
  Fixed a real potential overwrite of a human edit; no weakening of that test.
  Unknown foreground state expectations and no-grant observation behavior were
  made consistent. Corrected focused 161/161 PASS.
- Final quick **942/942 PASS**, no long soak; source/build/test fingerprint stable:
  `tests/evidence/runtime-tests-2026-09-28T08-18-02-081Z.json`.
- Native cover setup initially failed due to DPI/uncomparable per-PID z-index;
  retained, corrected using native ordering and overlap evidence. Final native
  covered UIA 2317ms / additional OCR 3971ms, zero activation; minimized restore
  2595ms, whole path 15670ms, repeat 3220ms. Both test-owned apps cleaned up.
  `tests/evidence/phase83-native.json`. No personal draft/input/send or live model.
- Real fresh and upgrades 0.1.0 / 0.1.1 all PASS. Disposable committed snapshot
  `edaebf9353e68419570cf2f958dfb65dbbd38400`, original dirty source HEAD remains
  `d69c8e64b09e8d257773b57ec81cf05b069b09a3`. Source code was frozen for quick and
  installer tests; afterward only documentation/status/evidence changed.
- Production npm audit zero reported vulnerabilities. Publication patterns passed;
  neither check establishes complete security/privacy.
- Consolidated evidence: `tests/evidence/phase83-acceptance.json`; native/install
  cases appended to `tests/report.json` without removing historical failures.

## Resume first

1. `docs/release-readiness-phase83.md`: native Windows setup/grants, effect approval,
   icon-only/visual-editable capability, modal/relaunch and host-wide input lease.
2. `src/interface/api.ts`: config-created CuaDesktopDriver currently lacks a
   confirmEffect integration; do not advertise automatic external sends.
3. `src/desktop/window-recovery.ts`, `cua-desktop-driver.ts`, `windows-runtime.ts`.
4. `docs/desktop-recovery.md`, `tests/runtime-visual-fallback.test.mjs`.

App-specific adapters are not the solution. Add generic capabilities/host UX,
then rerun clean native installation and end-to-end effect approval acceptance.
Do not kill/restart user apps without a separately established launch/recovery
grant. Missing native responding metadata must remain unknown.

## Versions / ownership

Node 22.22.0, npm 11.11.0, TypeScript 7.0.2, owned CUA 0.30.2, package 0.2.0.
Authoritative checkout `/home/<user>/projects/agent-driver/release-v0.2.0`.
Windows development staging `C:/Users/<user>/projects/agent-driver-phase76-native`.
No public branch/tag push, release, installed-host replacement or unrelated
service restart. Installer homes, reports, failure logs and candidate snapshot
are retained. Original Phase70–82 dirty changes remain untouched.

Supervisor logs and collector:
`/home/<user>/.local/state/agent-driver-audit/20260928-resume/phase83-*`.
The temporary native windows and all acceptance child processes exited.
