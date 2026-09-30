# Phase 106 — Work controls and retained browser sessions

## Scope

This development candidate adds Office-only Work disconnection, environment-aware read-only recovery, and explicit saved browser sessions. It is not a new public release. Original bots, schedules, browser profiles and external messages are outside the cleanup scope.

## Browser findings

- The observed Google unusual-traffic failure was in the WSL owned headless browser, not a Windows VM. Its previous contexts were ephemeral.
- A connected desktop Aside retains its own profile. The owned Ubuntu guest retains its guest profile on disk. An unavailable Windows guest transport is not a working login option.
- A dedicated owned profile can now be explicitly retained and reused by the common Playwright executor across Work, Swarm and Pack reads. Last-use close releases the browser process while retaining browser-managed disk storage.
- Login holds, profile ownership, capacity bounds and Chromium's own cross-process lock prevent simultaneous human/automated use. Recovery does not delete locks or copy browser credentials.
- Profile configuration is not evidence of authentication. Arbitrary sites remain unverified without a supported live marker. Authentication expiry and site restrictions still require user action.
- Retained cookies do not establish that Google's network traffic restriction has been removed. No real Google login or PC reboot is claimed by the local restart tests.

## Recovery boundaries

Technical read-only browser failures can use the next registered environment. The specifically observed Google unusual-traffic response instead preserves the original Google query and requests one direct connected-Aside attempt. It does not substitute Bing/DuckDuckGo or rotate profiles. A further restriction requires the user.

Host platform and execution environment are separate: an Aside running on Windows is `host_foreground` with platform `win32`, not a Windows guest. Both initial planning and replanning receive the actual executor inventory. A Work that saves a local report can still recover its read-only search; this does not expand write authority.

## Evidence and outstanding work

Native saved-session tests use a local fixture, a real headed WSL Chromium window, and a new headless Node process. They verify retained cookies/local storage and isolated-profile separation, not a real site's authentication policy. UI tests use controlled responses and include Korean/English desktop/mobile flows.

The first frozen quick run passed 1545/1548, with three obsolete login-UI assertions. Corrected scoped regression passed 33/33, and the additional held-profile UI suite passed 13/13. The installed local UI now reveals an existing guest login hold rather than hiding it behind the default Aside selection. Its settings and thirteen registrations were preserved. Original engine-pinned browser checkpoints are validated against their exact prior binding; uncertainty and configuration/request fences remain enforced. A final frozen quick run also covers the retained challenge retry guard.

Final frozen quick regression and installed-runtime observations are recorded in `docs/status.json` and `tests/report.json`. Earlier failed runs are retained. No soak test is required for this change. Actual ASTS article collection, the requested thirteen-registration cleanup and eight prepared examples remain separately tracked; a passing fixture must not be reported as their completion.

Final quick: 1550/1551 PASS. The remaining assertion expected retry enabled during a challenge; the corrected affected suite passed48/48, including both languages and viewport sizes. No product source changed after the full run. The final candidate is applied locally, not released. Actual Office execution successfully searched Google through the registered Aside, read two nonempty source pages, recorded a third empty response as a limitation, and saved/read back a report whose disk hash was independently checked. The Work is awaiting review, not automatically verified complete. Personal registration cleanup and example registration are still pending.
