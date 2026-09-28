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

Pending final candidate checks. Exact results and publication references are
recorded in [Phase89 handoff](handoff/phase-89.md).
