# v0.4.0 release verification

Status: candidate under verification; not a published or fully verified release yet.

Required gates are tracked by Phase 110, RQ-884–886:

- Frozen full quick regression (long soak excluded).
- Fresh installation and upgrades, including the currently published v0.3.1.
- Actual public-research Work through the Office runtime with visible stages, intervention, resume and independently checked result.
- Public-boundary and ledger verification, protected-branch CI, versioned publication and published installer checks.

Earlier-phase passes do not certify the current changed source. Final evidence references and exact status will replace this candidate notice after the gates run. Personal workflows, browser sessions and credentials are excluded from the release.

Supported runtime: Ubuntu 24.04 x86_64, including Windows 11 WSL2. Native Windows desktop control remains experimental; macOS and additional guest transports are not certified. Login, CAPTCHA, external write approval and exhausted account quotas can still require user action.

## Retained reliability limits

[Acceptance backlog #6](https://github.com/deepdivekr/agent-office/issues/6) and [unattributed historical recovery failure #22](https://github.com/deepdivekr/agent-office/issues/22) remain open. In particular, later passing tests cannot identify the cause or final effect count of the original `prepare_only` failure. This release does not claim failure-free operation, universal desktop support, power-loss certification or successful live handoff for every executor pair.
