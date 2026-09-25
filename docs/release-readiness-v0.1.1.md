# v0.1.1 release validation

This release carries the changes reviewed in [PR #26](https://github.com/deepdivekr/agent-driver/pull/26). That feature tree passed **560/560** quick checks in [run 36092533249](https://github.com/deepdivekr/agent-driver/actions/runs/36092533249). This prior result does not replace checks on the release commit.

## Required release gates

- Package, lockfile, installer default and installation documentation agree on v0.1.1.
- Quick regression suite and production dependency audit pass on the release commit.
- `scripts/release/verify-install.mjs` installs real packages in two isolated homes: a fresh v0.1.1 install and v0.1.0 upgraded to v0.1.1.
- Upgrade keeps connection approval, runtime configuration, Work ID and prompt. The installed wrapper runs from an unrelated directory, MCP reports the exact version, Chromium launches, and the Control Center serves the bundled Pretendard font.
- CI preserves JSON results and logs for both passing and failed checks. Publication runs only after all gates pass on a push to main; PRs cannot publish.
- Release assets include the source archive, standalone installer and SHA256SUMS. Tags are not overwritten.

Find the exact commit's results under [Runtime checks](https://github.com/deepdivekr/agent-driver/actions/workflows/runtime.yml). A file describing a gate is not a PASS result. The JSON installation receipts identify the tested SHA, durations and whether the source came from the public tag or a local candidate.

## Evidence boundaries

The installer runs actual npm/build/browser/MCP code. Test homes and the Work planning response are synthetic, with no real accounts or paid model calls. Chromium cache reuse is recorded; this does not measure first-time CDN download speed. Installation is tested with dormant Work data, not by replacing a process in the middle of a task. Restart existing MCP and Control Center processes after updating.

The scope and experimental capabilities from [v0.1.0](release-readiness-v0.1.0.md) remain. Native Windows/macOS, every third-party client/site, and long soak are not part of this patch-release claim. Earlier failures remain recorded in [the Control Center audit](control-center-action-audit-2026-09-25.md).
