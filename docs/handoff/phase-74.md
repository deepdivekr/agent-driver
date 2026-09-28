# Phase 74 — Windows Task Pack candidate

2026-09-28 resume: merged into authoritative WSL source; 51 Windows contracts and Linux link-boundary checks pass. Agent-tool window enumeration works again, but the product-native executor is still not connected and no Kakao message was sent. See [phase-72-resume.md](phase-72-resume.md); retain the historical failures below.

## Scope and location

- User requested about ten reusable Jev-assisted Windows workflows, including a harmless KakaoTalk message to their own self-chat via their own profile. Other contacts are out of scope.
- Candidate: `C:/Users/<user>/projects/agent-driver-phase73`, on the preserved Phase 73 working tree. Baseline `b7f2f3e0b99ec291ab4b55a99765106dc1d67244`.
- Authoritative WSL checkout `/home/<user>/projects/agent-driver/release-v0.2.0` remains unavailable. This candidate does not contain all unfinished Phase 72 changes. Never overwrite the original with this tree or copy its environment-only historical status downgrades.
- No commit, push, release, installation replacement, user application restart, paid model call or KakaoTalk message was performed.
- Phase 73 transfer patch was left unchanged: SHA256 `93b81949a8369a846f3a495d0a6fa49ce105cfbf1117e1bc37aaaf7c59eb83af`.

## Implemented

1. Ten profiles under the existing nine families: KakaoTalk self-note, mail draft, calendar draft, Notepad note, find/open document, file-organization preview, Excel filter/export, PDF export, presentation edit draft, desktop form draft. These are workflow definitions, not ten verified native app integrations.
2. Required inputs, precise stage goals, effect boundaries and independent completion evidence. Selection intent (file query, column, slide, field) is explicitly supplied; payload text is excluded from model judgment state.
3. One batched typed Jev request for stage readiness and target selection. Common Decision Plane registry/journal/shadow settings; existing global/Work opt-outs and data consent. LLM correction requires ready state and an exact observed-label quote. Provisional thresholds are not Korean desktop calibration evidence.
4. Work/request/input/config/profile/model-settings binding, fresh observation before selection and after approval, trusted-host-only authorization and execution, durable pre-effect claim, independent action-bound readback, no blind replay after uncertain effects, same-database foreground exclusion.
5. Six MCP tools for catalog/plan/start/step/status/reconcile, Work detail receipts, Pack planning hints and common decision status integration. No driver, observation, success assertion or approval can be supplied over MCP. Unconnected execution reports `waiting_connection`.
6. Runtime shutdown now waits for active Windows and Pack operations before closing SQLite. Existing Pack fixtures close runtime/stdio children before deleting their temporary databases.
7. Decision registry retains file flush and atomic rename on Windows without unsupported directory fsync. Linux directory fsync remains. Windows directory-entry crash durability is not certified.
8. Persist the exact pending command before input. Optional trusted-host reconciliation requires the same action/binding, a quiescent (fenced) host, and fresh action-bound readback before recording success. Verified non-dispatch reopens the step but does not bypass a new approval. Recovery and lock release commit together. Paused Works can inspect results without acting; concurrent inspections advance only once. Legacy rows without a stored command remain blocked. Native host implementation is still absent.
9. Decision append files now check the leaf and the opened file identity, not just `O_NOFOLLOW` (not portable to Windows). Hard-link and directory-redirect tests run independently of file-symlink privilege. Runtime evidence reporting marks skipped environment checks `BLOCKED_ENV`, never PASS. The earlier raw failed reports remain unchanged.

## Verified and preserved failures

- Pinned Node `22.22.0`, TypeScript `7.0.2`, package `0.2.0`; no dependency version changes. Windows compiler passed.
- First report `tests/evidence/runtime-tests-2026-09-27T21-21-55-191Z.json`: 34/35 cases passed, plus source integrity. Consent case expected execution instead of the existing configuration admission rejection; corrected without weakening consent.
- Expanded report `tests/evidence/runtime-tests-2026-09-27T21-25-45-797Z.json`: 51/62 cases passed, plus source integrity. Windows directory fsync failed; fixture cleanup attempted SQLite deletion before runtime closure; one browser fixture timed out. All failures remain in `tests/report.json`.
- The hung owned Pack test process was verified by exact command and parent before stopping only that process tree. No user browser or service was stopped.
- Final expanded report `tests/evidence/runtime-tests-2026-09-27T21-43-25-501Z.json`: **63/65 cases passed, plus source integrity (64/66 checks)**. All **37 Windows profile/runner contract cases** passed. All ten synthetic workflows completed; fake Jev/LLM responses are not provider certification.
- Remaining failures: file-symlink test fixture cannot be created (`EPERM`, Windows privilege); existing browser collection fixture exceeded its unchanged 60-second deadline (reported duration 97.77 seconds). The browser fixture passed an earlier isolated diagnostic in 38.09 seconds, but the final isolated rerun also timed out (62.54 seconds), recorded in `tests/evidence/runtime-tests-2026-09-27T21-49-17-394Z.json`. Neither failure is erased. Resource pressure was observed but is not a proven root cause; no deadline was raised and no assertion was removed.
- Follow-up `tests/evidence/runtime-tests-2026-09-27T22-29-22-673Z.json`: **62/63 executed-or-blocked cases passed, plus input integrity (63/64 checks)**; one file-symlink capability check is `BLOCKED_ENV`, not PASS. All **51 Windows contract cases** passed, including 14 recovery regressions. Hard-link and directory-redirect native filesystem checks passed. Actual app/Jev calls remain untested.
- Browser instrumentation (`scripts/runtime/trace-owned-browser.mjs`) localized the fixture delay to persistent-context shutdown: open 1.8–4.5 seconds, capture 0.14–0.32 seconds, close 22–35 seconds in one failed run. Playwright debug logs in another run show normal process exit (code 0), not a stuck cleanup: close 15.4 and 1.75 seconds; that fixture passed in 26.04 seconds. This does not establish consistent reliability or prove resource pressure is the cause. No fixture deadline changed.
- The optional page-first shutdown probe also failed: page close 232ms, total close 54.014 seconds, fixture 68.84 seconds against the unchanged 60-second deadline. It is diagnostic-only and was not added to production behavior. Raw trace: `tests/evidence/owned-browser-trace-42864.jsonl`.
- Six-tool stdio MCP catalog follow-up passed: `tests/evidence/runtime-tests-2026-09-27T22-37-08-111Z.json` (one test plus input integrity). No real desktop or provider call was made.
- A Windows build initially caught a `number | bigint` helper type; corrected to the actual non-bigint `Stats` returned by these calls, then compilation passed before the follow-up tests.
- `git diff --check` and final ledger results are recorded in `tests/evidence/phase74-summary.json`.

## Actual environment limitations

- The product currently has a host-injected Windows driver **contract**, not a packaged native UIA/visual executor. Host reconciliation and MCP inspection exist in the candidate, but no native implementation or user-facing connection/recovery UI was added. Unverified effects retain the lock; host-wide serialization and input fencing across separate databases remain the adapter's responsibility.
- The Computer Use skill requires `@oai/sky` through the managed Node tool for Windows interaction. Initial startup and one reset/retry failed with `failed to start Node runtime` / invalid directory / `os error 267` at the unavailable UNC task directory. No app list, profile, chat, screenshot or send could be observed. Do not bypass this with a custom UI automation helper.
- BrowserOS Neo was also unavailable at its configured local endpoint; official TypeSafe docs were read with web fallback. No private browser session was controlled.
- The candidate process had no configured `TYPESAFE_API_KEY`; original WSL model settings are inaccessible. This is not a claim that the user has no key elsewhere. No keys were copied from chat history or placed in source.
- Live KakaoTalk, Jev latency/accuracy, Korean UIA coverage and app-specific completion evidence remain unverified. A developer Computer Use success would still need explicit product integration before being called an Agent Driver runtime success.
- WSL recovery diagnosis: `WslService` says Running, but the owned `wsl --list --verbose` query hung. Its exact parent/command was verified before stopping only that query tree; other projects/services were untouched. This process is non-administrator. An asynchronous request to open the administrator approval for service recovery was sent; no answer had arrived at this checkpoint. Do not automate UAC or change security settings. The saved WSL 8GB cap was retained.

## Resume

Read-only follow-up on the origin of WSL overload: see `docs/wsl-diagnosis-2026-09-28.md`.
At 08:03 KST Windows had 0.94GiB available of 31.51GiB; the largest observed consumer was
the Codex UI renderer (about 13GiB working set, running since September 22), while
vmmemWSL showed about 369MiB working set. This is not proof of the initial failure's cause.
The recovered Phase 72 checkpoint confirms one successful Ubuntu restart followed by
a hanging WSL shutdown; the 8GB cap's effective application remains unverified. No
process, service or setting was changed during that diagnosis.

1. Restore a valid managed Windows interaction workspace and access to the authoritative WSL checkout. Compare and preserve its dirty changes before merging per file.
2. Implement/connect a product-owned native executor honoring `WindowsWorkflowDriver`, human-approved scope, host-wide input fencing and independent readback. Implement the new `reconcile` host method against actual effects, not fixture facts.
3. Inspect actual KakaoTalk accessibility. Run only the authorized own-profile/self-chat flow; choose a harmless clearly labeled test note, bind exact recipient/content, verify one new message, and never retry an uncertain send.
4. Reuse the user's locally configured Jev connection after permission/config validation. Collect labeled desktop evidence before claiming calibrated automatic target selection or real latency.
5. Recheck the unchanged browser fixture under measured resource availability and run the symlink boundary test in an environment that supports creating the fixture. Keep prior failures.

Read first: `prompts/phase-74-windows-workflows.md`, `docs/windows-task-pack.md`, `src/desktop/windows-workflows.ts`, `src/desktop/windows-decision.ts`, `src/desktop/windows-runtime.ts`, `tests/runtime-windows-workflows.test.mjs`, `docs/handoff/phase-73.md`.
