# v0.4.0 release verification

Status at the local release gate, September 30: local verification passed; protected GitHub CI and published-installer verification follow separately.

Required gates are tracked by Phase 110, RQ-884–886:

- Frozen full quick regression (long soak excluded).
- Fresh installation and upgrades, including the currently published v0.3.1.
- Actual Office Work completion with visible stages and independently checked result; separate evidence of intervention, handoff and resume.
- Public-boundary and ledger verification, protected-branch CI, versioned publication and published installer checks.

The frozen quick suite passed **1,660/1,660**, including input-integrity verification (652 contract-fake, 324 fixture-integration, 490 unit and 194 native-integration checks). Evidence: `tests/evidence/runtime-tests-2026-09-30T04-29-07-518Z.json`. No inputs changed during the run. Earlier failures and interrupted runs are retained in [Phase 111 verification](verification/phase-111-work-delivery.md).

Fresh installation and upgrades from v0.1.0, v0.1.1, v0.2.0, v0.3.0 and v0.3.1 passed **6/6** at runtime candidate `a37f84f`; the final test-only correction `e26a50c` does not change that production source. Evidence: `tests/evidence/release-install/2026-09-30T04-11-16.535Z.json`. These disposable installations exercise dependencies, Chromium, wrapper and MCP, but use fixture models. CI checks its exact checkout again before publication.

An actual one-click official-source Node Work completed with independently checked result and app delivery. A separate ASTS Work demonstrated handoff and same-run intervention/resume, but remains awaiting material evidence review, not successfully completed. Real messenger receipt is **unverified**; local provider-response substitutes are not live-account certification. The isolated test server was stopped, with no active Work or delivery remaining. Personal workflows, browser sessions and credentials are excluded from the release.

The [Runtime checks workflow](../.github/workflows/runtime.yml) is the protected publication gate. A release is published only after main CI passes; the versioned installer is checked against the published source afterwards. This record does not substitute local results for those remote gates.

Supported runtime: Ubuntu 24.04 x86_64, including Windows 11 WSL2. Native Windows desktop control remains experimental; macOS and additional guest transports are not certified. Login, CAPTCHA, external write approval and exhausted account quotas can still require user action.

## Retained reliability limits

[Acceptance backlog #6](https://github.com/deepdivekr/agent-office/issues/6) and [unattributed historical recovery failure #22](https://github.com/deepdivekr/agent-office/issues/22) remain open. In particular, later passing tests cannot identify the cause or final effect count of the original `prepare_only` failure. This release does not claim failure-free operation, universal desktop support, power-loss certification or successful live handoff for every executor pair.
