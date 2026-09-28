# Phase 90 — repository rename and current UI

Candidate: v0.3.1, based on public v0.3.0 main (9da5600), not personal runtime state.
Primary CLI/package/install paths now use agent-office. Legacy data is reused in place;
existing binaries, protocol IDs and MCP registration keys are not deleted.
Screenshots use isolated sample Work records and do not prove live model or executor success.

Read first: prompts/phase-90-office-readme.md, README.md, README.ko.md.
Toolchain unchanged: Node 22.22.0, npm 11.11.0.

## Evidence so far

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

## Remaining release gates

Quick suite and five disposable real installation scenarios must pass in CI before merge.
After merging, verify v0.3.1 tag/assets and actual published installation.
No old tag/assets or private running services are replaced.
