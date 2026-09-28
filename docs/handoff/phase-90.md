# Phase 90 — repository rename and current UI

Released: v0.3.1, based on public v0.3.0 main (9da5600), not personal runtime state.
Primary CLI/package/install paths now use agent-office. Legacy data is reused in place;
existing binaries, protocol IDs and MCP registration keys are not deleted.
Screenshots use isolated sample Work records and do not prove live model or executor success.

Read first: prompts/phase-90-office-readme.md, README.md, README.ko.md.
Toolchain unchanged: Node 22.22.0, npm 11.11.0.

## Evidence

- Related runtime suite: 33/33 PASS (32 cases plus input-fingerprint integrity).
  Private evidence: tests/evidence/runtime-tests-2026-09-28T21-21-23-406Z.json.
- Before expanded CLI scope: documentation contract suite 3/3 PASS.
- Real Chromium rendered all three screenshots. Sample Work pause/resume verified;
  API setup remained unsaved with a blank key; no page errors or paid model calls.
- Neo transport was unavailable; Aside could list tabs but opening an owned tab timed out.
  Captures used the repository's isolated Playwright path; no user tab/profile was changed.
- Initial capture seed used an invalid form family ID. Schema rejected it; corrected to
  form.draft-submit before capture. This was a capture fixture error, not a live task result.
- First boundary check hit EISDIR on the worktree's reused node_modules symlink.
  Ignore rule now covers both dependency directories and symlinks; no dependencies are published.

## Publication result

- PR31 merged as 49b8ef323bbfa1b08a7fc952b2602c24d7e525bf. Source tree
  c20b5f2545b59f8e0dfb8aab08c02ac785964714 matches local candidate 99d52f1.
- PR CI 36486829465 and main CI 36487711309: 1006/1006 quick checks each.
  Both also passed the five native installation scenarios.
- Local five-scenario evidence: tests/evidence/release-install/2026-09-28T21-27-24.831Z.json.
- Actual public asset/fresh-install evidence: tests/evidence/release-v0.3.1-public.json.
  Finished 2026-09-28T21:48:36.272Z; default state/launcher, MCP, browser and font passed.
- Public summary: docs/validation/v0.3.1-publication.json. CI artifacts retain per-case evidence.
- Raw receipts are private/ignored. Sample Work uses an injected model, not a paid provider.
- Both capture servers, owned screenshot browser and late-created Aside capture tab were closed.
  Existing user tabs, private services, old launchers, old tags and release assets were preserved.

No Phase 90 release blocker remains. Private production runtime upgrade is separate;
no automatic replacement of the user's personal installation was performed.
This documentation receipt follows publication; immutable v0.3.1 source/assets are not rewritten.

## RQ-809 — localized dark board screenshots

- English README now uses docs/images/en/; Korean screenshots stay in docs/images/.
  Both show the real dark UI, board overview, Work detail and AI connection.
  Sample Work content is localized as well as application labels. No work was executed.
- Captures explicitly assert dark media/rendered background, selected board layout, blank API
  key, no page errors and no visible Hangul in English. Pause/resume is exercised on sample Work.
- Initial English capture failed because two UI plan labels were untranslated. Added
  Planned stage / Work plan translations and a dynamic-text browser regression; failure retained.
- Affected suite: 4/4 PASS (three cases + input integrity), no blocked/not-run.
  Evidence: tests/evidence/runtime-tests-2026-09-28T22-00-27-515Z.json.
- All six PNGs visually inspected; each under 143 KB. Read manifests for exact language,
  viewport, dark theme, board layout and timestamps.
- Neo transport unavailable. Aside verified the English board, but its REPL lacks viewport
  and color-scheme emulation; the reproducible local Playwright capture path rendered PNGs.
  Owned Aside tab and both capture servers were closed. User tabs and private services untouched.
- This follow-up changes documentation assets and two UI translations on main.
  Existing v0.3.1 release tag/install assets remain immutable.
