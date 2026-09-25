# v0.2.0 release validation

This release integrates selected common features from a private compatibility tree
onto public main `a5762de448e7b3413bfc96e21b83675cf500b5f2`. Personal business adapters,
data, deployment scripts and credentials are excluded. The new-Work Jev call/skip
planning proposal is explicitly outside this release.

## Required gates

- Version, lockfile, installer and installation instructions agree on v0.2.0.
- Quick regression (without long soak), production dependency audit and publication
  boundaries pass. Tests retain failure receipts; fixture results are not live model results.
- Actual fresh installation and upgrades from v0.1.0 and v0.1.1 preserve connection
  approval, configuration, saved model preferences, Work ID and prompt.
- The installed wrapper works outside its repository, MCP reports the correct version
  and new common tools, and Chromium serves Office with the bundled Pretendard font.
- Only a successful push-to-main workflow can publish the release. Existing tags and
  release assets are never overwritten.

The workflow's JSON receipts, tested commit SHA and installation logs are the evidence;
this checklist itself is not a test result. See the exact commit's
[Runtime checks](https://github.com/deepdivekr/agent-driver/actions/workflows/runtime.yml).

## Feature boundaries

| Feature | Automated evidence | Not established by these tests |
|---|---|---|
| Hermes import and ACP work | Synthetic source DB, duplicate/fault/source-change cases, ACP fixture and browser UI | Every Hermes version or live business completion |
| Remote OpenClaw | Bounded SSH command contract, synthetic Gateway responses, send uncertainty/cancel scope and UI | Every server, real cancellation, or Synology hardware |
| Coding settings | Model argument selection, saved preference inheritance, key/endpoint boundaries and desktop/mobile UI | Every paid provider/model combination |
| Continuity | Context hashes, source binding, revision/size/secrets and no-replay regressions | Truth of agent-generated claims or universal message coverage |
| Jev import recommendation | Evidence validation, single-or-none, no-consent path and browser UI | Real recommendation optimality, measured speed/cost gains or automatic code injection |
| Pack-owned Jev settings | New Work delegates to Pack decisions; global OFF, explicit opt-out, imports and legacy values are preserved; Pack/Swarm and desktop/mobile UI checks | A new Work-level LLM decision policy, or measured live Jev accuracy |
| Installation | Actual npm/build/browser/MCP/SQLite in isolated homes | First-time CDN speed, active-task hot upgrades or native Windows/macOS |

Installed runtimes remain optional. Remote OpenClaw requires an existing SSH key and
trusted host in the environment running Office. Hermes requires a compatible local
installation and profile. No test uses a user's production configuration or paid keys.

## Public boundary

Only product source, synthetic tests, documentation and the public release workflow
are included. Private raw evidence is not uploaded. `tests/report.json`,
`tests/evidence`, databases, logs, profiles and environment files remain ignored.
Historical evaluation documents keep their original scope; they are not new v0.2.0 claims.

## Failure history retained

- The first PR snapshot had one obsolete UI expectation: 624/625 checks passed.
  The test was updated for the requested Pack-owned default, retaining disabled-state,
  explicit opt-out and cost-consent checks. The next snapshot passed 625/625 checks
  and all three real installer scenarios in GitHub Actions.
- A separate local WSL probe stopped while preparing v0.1.0 because the installer's
  15-second browser startup check failed. An isolated launch in the same environment
  succeeded after 43.346 seconds. The installer now allows 60 seconds and distinguishes
  timeout from startup failure. The final snapshot must pass the same release gates.
- Local focused Work/Pack/Swarm/settings/UI checks passed 56/56 including input stability.
  These fixtures do not establish live Jev accuracy or performance.
