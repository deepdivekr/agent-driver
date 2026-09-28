# Phase 85 — Neo-optional release audit

Audit date: 2026-09-28. This is a local readiness assessment, not a published
release, installed-runtime upgrade, or certification of all desktop actions.

Follow-up: [Phase 86](handoff/phase-86.md) implements the local workflow
compatibility path and verifies it on disposable copies. The installed instance
is still unchanged. The original failure below is retained as historical evidence;
the other release gates are not resolved by that compatibility patch.

## Decision

Neo can remain optional. The current release candidate does not require its MCP
endpoint: the original Playwright path works without `browser_executors`, and
registered read-only routes filter eligible engines by environment before using
an available replacement. A host foreground browser cannot replace a background
VM under the same permission label. Aside is not yet a complete form-write
replacement for Playwright. Existing approval-bound Playwright writers remain
separate from this new read route.

**Do not replace the current installation or advertise a general Windows desktop
stable release yet.** The blockers below are independent of Neo availability.
An Ubuntu/WSL browser/CLI/file release is a narrower scope, not evidence that the
Windows desktop installation and approval paths are complete.

## Verified contracts

Fresh focused regression:
`tests/evidence/runtime-tests-2026-09-28T10-17-43-075Z.json`, **143/143 PASS**,
including unchanged-input validation. Breakdown: 34 unit, 98 contract_fake,
2 fixture_integration, 9 native_integration. Native here means the named local
test, not 143 real website, Windows or production model operations.

- Work/Pack binding, pause/revision fences and deterministic repeat reuse.
- Optional Pack-owned Jev/LLM decisions and host consent boundaries.
- Client handoff with saved model settings; API exhaustion can fall back to
  approved subscription auth; subscription exhaustion cannot open paid API use.
- Browser environment/URL/ownership gates, fresh observations after bounded
  handoff, completed-step preservation, uncertainty and authentication fences.
- Persistent recovery after process termination; consumed write approval is not
  replayed. A generated desktop plan cannot grant its own effect approval.

The prior full quick suite passed 959/959 before the final narrow launch-error
and guest-directory patches. The latest focused audit covers the browser and
affected common contracts, but is not a new full-suite or clean-install run.
Long soak was excluded. No paid model calls or real external writes were made.

## Installed instance is not the candidate

The client registration and running processes still point to the older local
installation (`runtime-personal`, package metadata 0.1.1). The candidate is
`release-v0.2.0` (0.2.0 plus uncommitted changes). The installed tree lacks both
`dist/browser/executor-routing.js` and `dist/desktop/cua-desktop-driver.js`.
Version labels alone were not used as proof: the files and config loaders were
also compared.

“Personal MCP” is an imprecise name for that existing local installation and its
personal configuration/data, not a separate MCP protocol or product edition.
It includes legacy workflow integration that the public candidate does not
currently accept. Prefer “current installation” in user-facing explanations.

Read-only loading of the same approved host configuration succeeds using the
installed loader and **fails using the candidate loader** with a top-level
`workflows` unrecognized-key error. No database was opened by the candidate and
no configuration was rewritten. Migration must preserve the existing workflows,
approvals and schedules; deleting the field is not a valid compatibility fix.

## Remaining release gates

1. Preserve and migrate the existing `workflows` configuration before replacing
   this user's installation. Validate upgrade and rollback on a disposable copy.
2. Finish the native Windows connection/grant UX and action-time confirmation.
   `RuntimeApi` still constructs `CuaDesktopDriver` without `confirmEffect`;
   its local-write/external-send gate therefore cannot approve these effects.
   This is fail-closed, not a working human approval path.
3. Verify host-wide foreground ownership. The current SQLite lock is scoped to
   a host database, not to all independently configured hosts on one desktop.
4. Diagnose connection lifetime/resource use before claiming lightweight
   long-running operation. The installed instance had 53 live stdio MCP
   processes: aggregate RSS about 5.49 GiB; proportional set size about 3.52 GiB.
   Each had a pipe and a distinct parent. This is a measured snapshot, not proof
   of a leak or 53 active Work jobs. Existing sessions were not terminated.
5. Use a final frozen release snapshot for installation/upgrade and required
   regressions. Phase 83's clean-install results do not cover later source edits.

Windows VM has no verified guest/bridge. Local Windows Playwright and Neo have
installation activation failures, distinct from the successful Ubuntu Playwright
and Windows Aside acceptance. They remain unverified/failed, not silently fixed
by passing fallback tests. See `docs/handoff/phase-85.md` for those receipts.

## Resume

First resolve the installed workflow compatibility contract, then the native
approval/connection path if broad Windows desktop support is part of this
release. Do not launch a second runtime on the production database as a probe.
No processes, models, browser profiles, schedules or installed settings were
changed by this audit; no commit, push, tag or release was created.
