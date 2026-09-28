# v0.3.0 release validation

## Supported scope

Ubuntu 24.04 x86_64 and Windows 11 / WSL2 Ubuntu 24.04: local MCP,
Control Center, owned Playwright browser, configured CLI/model connections,
file work, durable Work records and supported handoff.

## Excluded claims

- No universal native-Windows or macOS installation certification.
- Desktop CUA/UIA/visual adapters require reviewed host configuration and grants.
  Interactive setup and mutation approval coverage remain incomplete.
- Aside/Neo are optional read-only adapters. Registration is not a successful
  real-task certification; a stopped or unsigned-in application may block use.
- No automatic Neo/Aside installation into Ubuntu or Windows guests.
- No guarantee that authentication challenges, uncertain external effects or
  unavailable accounts can recover without a person.
- No long soak or all-model latency claims in this release.

Historical failures and environment-blocked evidence remain in their original
phase records. Phase83/85 broad desktop release objections are not reclassified
as passing by narrowing this release's advertised scope.

## Required gates

Before publication: quick regression (no soak), production dependency audit,
public-file/secret checks, build, ledger and clean installation.
Upgrade scenarios cover v0.1.0, v0.1.1 and v0.2.0 with byte-preserved settings,
the same Work ID and model preferences.

Installation probes launch real Chromium and MCP. Work generation in those probes
uses an injected test model, not a billed API or a real-site task.
Only owned temporary services are stopped. Existing personal runtimes, schedules,
credentials and databases are not deployment targets.

## Candidate evidence

- Build, dependency audit (zero vulnerabilities), public boundary (534 files),
  and clean-source ledger (97 requirements) passed.
- Owned shared-service lifecycle/publication checks: 10/10 PASS.
- Real installation and upgrades: four of four scenarios passed. Original Work
  IDs, model settings and configuration bytes were preserved.
- Initial local quick: 999/1000; only the stale first-run installer link failed.
  The failed receipt is retained. The link is corrected.
- Final affected auth/continuity/release tests: 64/64 PASS, including the added
  API-billing-source rejection and input integrity.

These local counts are not a substitute for final all-suite validation.
Candidate 70e1e76 passed 1001/1001 checks and all four installs in push CI,
but concurrent PR CI caught a client-model catalog startup race. That race is
fixed with explicit delayed-response and failed-request/re-entry regression
coverage; the affected settings/control browser suite passed 12/12 locally.
Final CI must pass on the corrected candidate, not only the earlier run.
The public release workflow runs the full quick suite and all four installation
scenarios before it can publish from main. See [GitHub Actions](https://github.com/deepdivekr/agent-driver/actions/workflows/runtime.yml)
for the exact tagged commit, and [Phase89 handoff](handoff/phase-89.md) for retained
failures and evidence scope. Long soak is excluded.
