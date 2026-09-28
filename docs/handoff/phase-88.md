# Phase 88 — Browser prerequisites and optional connections

## Completed

- RQ-795: Checked official Aside getting-started/developer pages and installed
  CLI 1.26.916.1741 guides. Aside requires installed browser components and its
  own account/first-run flow; CLI/MCP connects that browser. Current adapter is
  local, not remote Aside Cloud or agent `exec`.
- RQ-796: Local runtime onboarding now provides a default Playwright smoke
  check/download and optional Aside/Neo setup/auth links, bounded connection
  checks and consent-gated registration. GET is inert. Setup tail records actual
  observed outcomes/durations, not unfiltered CLI output.
- RQ-797: Registration checks configuration revision, saves a private backup,
  retains unrelated fields/VM targets and adds default headless Playwright.
  Existing sessions keep immutable policy; UI explicitly requires MCP reconnect.
  No cookie/profile copy, foreground/VM boundary change or auth-wall bypass.
- RQ-798: Build passed. Targeted 52/52 checks including fingerprint stability:
  missing/disconnected/ready, consent/conflict/symlink/origin guards, default
  real Chromium, desktop/mobile wizard and existing model/MCP/routing tests.
  Desktop and mobile screenshots visually inspected, no horizontal overflow.

## Evidence and preserved failures

- Initial affected run: 38/41, `tests/evidence/runtime-tests-2026-09-28T12-48-28-884Z.json`.
  Fixed WSL classification of a native Linux CLI, non-exported Playwright CLI
  package path, and a test HTTP server that did not finish unrelated requests.
- Final affected run: `tests/evidence/runtime-tests-2026-09-28T12-54-10-412Z.json`.
- Shared Control Center/i18n/onboarding follow-up: 11/11,
  `tests/evidence/runtime-tests-2026-09-28T12-57-18-987Z.json`.
  Combined runs contain 61 test cases and two input-integrity checks, all passing.
- Screenshots: `tests/evidence/phase88/browser-setup-1440.png` and `-390.png`.
  Optional browser/model/install responses are fixtures; these images are not
  proof that the user's Aside currently runs. Dedicated Chromium checks are native.
- `npm run ledger:verify`: 92 RQs. `git diff --check`: passed using WSL git.
- Long soak and paid model tests were not run. Previous Phase 87 full quick
  990/990 predates this change; do not reuse that result as a full Phase 88 run.

## Actual environment / remaining scope

- Neo MCP at port 9010 did not connect. Aside `listBrowserTabs()` returned an empty
  list, but subsequent official-doc navigation failed with "Aside isn't running
  on this machine" / connection closed. No stable live Aside task is claimed.
- Official documentation was therefore read with read-only web access after the
  allowed Neo → Aside attempt. No user browser process was stopped, account
  changed, model called or site authenticated by this work.
- Source/build only; no commit, push, public release or live executor policy edit.
  The existing personal MCP/control-center processes were not restarted.
- Aside/Neo form writes and VM transports remain unsupported. Windows desktop
  and VM first-install UX still has separate documented prerequisites; this is
  not a universal automated executor installer.
- Reconnect MCP after registration; restart/reopen the Control Center process to
  load changed host policy. Active work may pause at CONFIG_CHANGED and needs
  explicit reconciliation/replanning rather than silently changing its binding.

## Resume here

Read `docs/browser-executor-setup.md`,
`src/onboarding/browser-setup.ts`, `src/observability/browser-setup-ui.ts`,
`src/observability/control-settings.ts`, `tests/runtime-browser-setup.test.mjs`.
Keep Node 22.22.0 / npm 11.11.0 / TypeScript 7.0.2 / Playwright 1.63.0 / MCP SDK
1.30.0. Worktree: `release-v0.2.0`, branch `release/v0.2.0`; preserve prior dirty edits.
