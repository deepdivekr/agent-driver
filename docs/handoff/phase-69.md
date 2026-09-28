# Phase 69 — public common-feature release completed

Working branch: `release/v0.2.0`, based on public main
`a5762de448e7b3413bfc96e21b83675cf500b5f2`.

## Published result

- PR #28 merged: https://github.com/deepdivekr/agent-driver/pull/28
- Release: https://github.com/deepdivekr/agent-driver/releases/tag/v0.2.0
- Main and tag commit: `afd03710b3a1d50f2500cc6ca00065a9b78eaa05`.
- Candidate and main share tree `b2e334f4195ccb394059fd6d92a12294a6deca4c`.
- All seven RQs are complete. No release validation job remains running.

## Scope

Integrate only common Hermes migration/ACP, remote OpenClaw, coding settings,
continuity and the existing single Jev project-import recommendation. Preserve
private sources and installations. Exclude private workflow adapters and data.
The newly proposed Work Jev call/skip plan is excluded by the user. RQ-713 instead
keeps judgment ownership in Task Packs: new Work delegates to Pack settings; global
OFF, explicit Work opt-outs and imports without cost consent are preserved.

## Current evidence

- Node 22.22.0, npm 11.11.0, TypeScript 7.0.2 remain pinned.
- Dependency installation and build passed; installation reported zero vulnerabilities.
- Final PR and merged main each passed 625/625 checks (624 cases plus input stability)
  and all three installer scenarios on GitHub Actions. Earlier failures are retained.
- Main CI: https://github.com/deepdivekr/agent-driver/actions/runs/36144927951
- Main CI receipts are in its uploaded artifact:
  `tests/evidence/runtime-tests-2026-09-25T14-04-08-797Z.json` and
  `tests/evidence/release-install/2026-09-25T14-09-05.472Z.json`.
- Local focused Work/settings/UI checks: 56/56 including input stability.
- Local bootstrap checks after the slow-PC correction: 7/7 including input stability.
- Final tested candidate: `d69c8e64b09e8d257773b57ec81cf05b069b09a3`; its source tree
  is identical to released main. Final CI and public artifact verification passed.
- Initial local installer attempt failed its 15-second Chromium check. Same-environment
  diagnostic launch passed after 43.346 seconds; final installer uses a 60-second bound.
- Local real installer rerun passed fresh, v0.1.0 upgrade and v0.1.1 upgrade with model
  preferences. Receipt: `tests/evidence/release-install/2026-09-25T13-57-06.098Z.json`.
  Checks include real dependencies/build/Chromium/MCP, clean checkout, Work identity,
  prompt, connection and model settings. Model responses are injected fixtures.
- Public raw installer matches tested bytes. Downloaded public SHA256SUMS matches:
  archive `3b4afb7e2084768d71092673bf9d92e8d31b0ce3206a985f7444395bb3a6a8b2`,
  installer `979083ca3dfaf9ccf4f770b76b8006649e8283cc16074cd0cf372dc3ad733c17`.
- No production service restart, paid model call, private data publication or remote mutation.

## Next

Read `prompts/phase-69-public-common-release.md`, `docs/status.json`,
`docs/release-readiness-v0.2.0.md` and the candidate's test evidence.
There is no pending release gate. Post-release local status/handoff records do not
alter the immutable public tag. Do not restart or migrate private production services
without a separate request. Apache-2.0 remains unchanged. Certified environments are
Ubuntu 24.04 x86_64 and Windows 11 WSL2 Ubuntu 24.04, not native Windows/macOS.
No new paid-model, live Jev accuracy/latency, business-site or long-soak result is claimed.

## Completed jobs and preserved failures

- Final PR CI: https://github.com/deepdivekr/agent-driver/actions/runs/36143869652
- Final branch CI: https://github.com/deepdivekr/agent-driver/actions/runs/36143862879
- Local real install validation: session 39136 completed successfully at
  2026-09-25T14:15:55.343Z. Receipts and logs: `tests/evidence/release-install/`.
- Earlier local failures: `tests/evidence/release-baseline-interrupted.json`,
  `tests/evidence/release-install/2026-09-25T13-36-18.376Z.json`.
  Preserve them; do not overwrite failed receipts.
- Private runtime services and unrelated collectors remain untouched. Do not stop
  them when cleaning up test-owned processes.
