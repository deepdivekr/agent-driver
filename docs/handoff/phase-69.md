# Phase 69 — public common-feature release (in progress)

Working branch: `release/v0.2.0`, based on public main
`a5762de448e7b3413bfc96e21b83675cf500b5f2`.

## Scope

Integrate only common Hermes migration/ACP, remote OpenClaw, coding settings,
continuity and the existing single Jev project-import recommendation. Preserve
private sources and installations. Exclude private workflow adapters and data.
The newly proposed Work Jev call/skip plan is excluded pending an explicit scope change.

## Current evidence

- Node 22.22.0, npm 11.11.0, TypeScript 7.0.2 remain pinned.
- Dependency installation and build passed; installation reported zero vulnerabilities.
- Full quick regression started, excluding long soak. Not yet a PASS claim.
- Installer probes cover fresh, v0.1.0 upgrade and v0.1.1 upgrade with model preferences.
- No production service restart, paid model call, private data publication or remote mutation.

## Next

Read `prompts/phase-69-public-common-release.md`, `docs/status.json`,
`docs/release-readiness-v0.2.0.md` and the candidate's test evidence.
Finish quick regression and installer probes, then PR/CI/merge/public artifact verification.
