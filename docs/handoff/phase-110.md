# Phase 110 — Work stages and release

Read `prompts/phase-110-work-stages-release.md`, `docs/task-ledger.md`, `docs/status.json`, and Phase 108–109 verification records first. Base is `9099dd0` in `office-wsl-loopback`; the original planning directory is not the implementation checkout.

The user authorizes finishing and public release, with GPT-6 Sol/high sub-agents for final tests. Personal Office installation and thirteen Works remain archived; use isolated validation rather than restoring them. Preserve official provider auth and unrelated services. Use current subscription configuration, no silent paid API fallback. No external messaging or transactions in the real test.

Initial inspection confirmed: new Work definition schema omits business steps and falls back to a single goal; general Work stages render tool receipts while Swarm stages render workers. Real source logs exist but lack a consistent business-stage binding. Implement the common stage contract using existing Work plans, checkpoints, activity and UI, not a second execution engine.

Node 22.22.0/npm 11.11.0 from the WSL login shell; package is initially 0.3.1. No background validation job has been started yet. Coordinate source freeze before final quick tests; retain earlier failures and exact evidence levels.

## In progress — 2026-09-30

Candidate version is now 0.4.0. Business stage plan/contracts, receipt-bound execution claims, dependency invalidation, stage-scoped activity, semantic UI, Swarm worker/session separation and output resume fences are implemented pending final verification. New source and test files are uncommitted. The actual live test has not started; its isolated harness is ignored under tests/evidence.

Targeted regression session `11154` finished with exit 1: **455/460 PASS**, five FAIL, no BLOCKED_ENV/NOT_RUN; input fingerprints were stable. Command: `npm run build && node --test --test-concurrency=1 --test-reporter=./scripts/runtime/test-reporter.mjs tests/runtime-work-*.test.mjs tests/runtime-supervised-swarm.test.mjs tests/runtime-adaptive-workers.test.mjs`. Evidence: `tests/evidence/runtime-tests-2026-09-30T01-01-56-566Z.json`. Failures: two minimal-DOM language reads, a literal UI route-label assertion, two worker-liveness unit stores missing the newly used intakeWork read. These are being corrected without dropping assertions; semantic Swarm end-to-end and closed-stage redispatch regressions are also being added before the next freeze. No test process remains from this session.

Public GitHub main is still 96df310, v0.3.1 is immutable. Windows Git Credential Manager authenticated a dry-run branch push successfully; no push/PR/release performed yet. Use Windows Git for publication (WSL has no helper). Protected main requires PR and runtime CI. Existing issues #6 and #22 retain unresolved acceptance and unknown historical recovery-cause limits; do not close them or claim universal/failure-free stability from later passing tests.
