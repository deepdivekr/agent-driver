# v0.3.1 validation

Published as [v0.3.1](https://github.com/deepdivekr/agent-office/releases/tag/v0.3.1).
This post-publication receipt supplements the immutable tag's pre-publication snapshot.

Scope: repository/package/CLI name, default install/state paths, compatible legacy state discovery,
current README captures and actual installation/upgrade checks. No new desktop or browser support claim.

Screenshots use isolated sample Work records, not private data or successful model runs.
No paid model call or long soak is needed for this release.

Verified:

- Affected runtime contracts: 33/33 checks.
- PR and merged release CI: 1006/1006 quick checks each; 0 blocked, 0 not run.
- Local candidate, PR CI and merged release CI: all five real installation scenarios passed
  (fresh and original v0.1.0/v0.1.1/v0.2.0/v0.3.0 installers), preserving Work IDs,
  settings and existing launchers. Work/model responses are injected fixtures.
- Actual public installer: fresh installation, agent-office launcher, default state discovery,
  real MCP, Chromium and local font passed. Owned browser/service stopped afterward.
- Tag commit 49b8ef323bbfa1b08a7fc952b2602c24d7e525bf and source tree match the tested candidate.
  Archive, installer and SHA256SUMS were downloaded and their digests matched.
- Dependency audit, ledger and publication boundary passed; v0.3.0 remains unchanged.

See [publication evidence](validation/v0.3.1-publication.json) and
[Phase 90 handoff](handoff/phase-90.md) for exact results.
Per-case evidence levels remain in CI artifacts; the aggregate is not certification of
macOS, native Windows desktop control, optional VM browsers or all live providers.
