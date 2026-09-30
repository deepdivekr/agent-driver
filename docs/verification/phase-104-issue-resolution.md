# Open issue acceptance audit — Phase 104

Base: `96df3107eb46b91f593042427fe83b0e91b823f3`. This is issue reconciliation, not a new release or certification of every operating system.

## Current evidence

The actual merged-main [runtime CI](https://github.com/deepdivekr/agent-office/actions/runs/36565091910) completed successfully. Job `109394955560` reports 1,288/1,288 quick checks, zero BLOCKED_ENV and zero NOT_RUN. The real installation step also succeeded; its aggregate step result alone is not a newly counted per-scenario observation. Earlier exact-source five-scenario receipts remain in the [Phase 103 record](phase-103-integration.md).

No application source, runtime limits or existing test assertion has changed in this audit. No paid model call, private-bot replay, external message, personal profile reset or disabled-client reconnection is required. Long soak remains outside the normal loop.

## Implementation versus remaining acceptance

| Issue | Implemented and evidenced | Still not established |
|---|---|---|
| [#1](https://github.com/deepdivekr/agent-office/issues/1) | Durable control plane, natural-language Work, MCP, execution/control/logs/results, bounded routing and coding handoff | The original umbrella also includes the remaining domain, cross-executor, native-OS and reliability gates below |
| [#3](https://github.com/deepdivekr/agent-office/issues/3) | Native web, file, parallel research and pasted-definition Work; SDK MCP, configured models, typed intake and durable deduplication | Generic legacy browser-session open/status, independently labelled domain holdout and every external-runtime deployment |
| [#4](https://github.com/deepdivekr/agent-office/issues/4) | Playwright/Neo/Aside read adapters, live capability selection, bounded checkpoint handoff and fresh destination observation | Native mid-task cross-executor takeover, approved Neo/Aside writes and guest transport |
| [#5](https://github.com/deepdivekr/agent-office/issues/5) | Owned coding host, exact session resume, scoped file broker, independent verification, Codex/Claude handoff | Native ConPTY/Job Objects/ACL, full interactive-state and operating-system acceptance |
| [#6](https://github.com/deepdivekr/agent-office/issues/6) | Apache-2.0, Ubuntu/WSL installation/upgrade, actual supported Work and fault/recovery checks | Independent domain holdout, continuous Windows non-interference, reboot/power-loss and broader security/OS certification |
| [#14](https://github.com/deepdivekr/agent-office/issues/14) | Real Linux cgroup CPU/memory/PID budgets, owned cleanup and coding/verifier/resume under budget | Whole-installation gateway/cache/I/O/handle/tab bounds and native Windows integration |
| [#16](https://github.com/deepdivekr/agent-office/issues/16) | Storage admission/reservations, log rotation, owned pruning, real ENOSPC, consistent backup and quarantined restore | Filesystem hard quota/I/O, all caches, snapshot/staging recovery and normal operational/Windows restore |
| [#22](https://github.com/deepdivekr/agent-office/issues/22) | Generation-bound diagnostics, repeated resume evidence and failure-safe browser cleanup | Original failure cause and original final effect count remain unknown/unobserved; later PASS is not causal attribution |
| [#24](https://github.com/deepdivekr/agent-office/issues/24) | Browser-free metadata imports and a finite startup window bounded by the original task deadline | The old unchanged-five-second acceptance was superseded by a fifteen-second design; current-head two-hour soak is NOT_RUN |

The original issue bodies and comments are retained in an ignored before-state receipt. Issue closure must distinguish completed implementation from withdrawn scope. Closing an item as `not_planned` does not turn its missing evidence into PASS, cure an unknown cause or certify the wider release gates. NAS authenticated control and personal messaging remain separate limitations.

## Audit corrections

The inherited backup guide incorrectly described schema 6/7 being copied to schema 7. The current implementation accepts source schema 6/7/8 and upgrades only the quarantined copy to schema 8. The guide is corrected; runtime migration and source databases are unchanged.

The existing strict fresh-import test passed again with its original assertions: 2/2 native checks including unchanged input fingerprints. Capability catalog, supervisor and terminal imports load no Playwright; the subsequent actual driver import does. This does not establish a five-second pressured startup or a live browser handoff.

The private Phase 24 original receipt is still available: 259/260, with one native FAIL (`ready_to_resume` instead of `succeeded`, 9,332.340 ms). Its recorded assertion has no causal diagnostics or final effect oracle. The historical FAIL remains intact; it cannot be attributed retrospectively from later successful repetitions.

The private Phase 26 handoff and status record a past synthetic two-hour completed/PASS run: 1,056 cycles, 2,178 cases, no recorded failed cases, after the fifteen-second startup and dead-owner-storage fixes. The original final `/tmp` manifest/report/journal are no longer available for independent revalidation in this audit. Therefore the earlier blanket “two hours never run” wording is corrected to “historical handoff reports completion; raw final receipt cannot be revalidated here; no current-head two-hour rerun.” This is not a new raw-verified PASS, actual-site/model/Windows certification or attribution of #22.

## Disposition

Issues #1/#3/#4/#5/#14/#16/#24 are now closed with the actual GitHub state reason `duplicate`, not `completed`. All unfinished conditions were consolidated into the still-open [#6](https://github.com/deepdivekr/agent-office/issues/6); an independent coverage check confirmed the intake/browser/CLI requirements remain represented. The separate unknown-cause defect [#22](https://github.com/deepdivekr/agent-office/issues/22) stays open. Fresh API readback confirms seven duplicate closures and exactly these two active issues. No requirement was withdrawn.

Every original issue body remains readable in a historical disclosure and its comments remain intact. Completed feature points, old failures and outstanding acceptance are not conflated. The [sanitized receipt](../validation/phase104-issues.json) records state reasons and verification separately. Withdrawing the two remaining scopes or calling them fixed needs a separate actual resolution or explicit user decision.

The source-schema backup regression also passed unchanged (2/2 including input-integrity): source schema 6 remains 6, the quarantined copy is schema 8. These two targeted recorded runs append four native PASS rows. Four earlier isolated TAP observations are now preserved separately and appended exactly once: the first fresh-import check and three prepare-only/browser-diagnostic checks. Their commands, exit status and actual durations are retained; their input fingerprints and original stdout-byte digest are unobserved. The printed effect counter belongs only to the owned synthetic fixture. This transcription neither reruns a test nor attributes the original #22 failure. The pre-existing 13,906 report-row prefix reconstructs byte-for-byte to its prior SHA256; no historical result was removed or changed.

Three separate audit/readback PASS rows were appended. The recorder's first strict document comparison failed solely because it removed the local terminal newline but retained the API terminal newline. That unit FAIL is retained. The correction normalizes only trailing LF on both strings and still compares every internal character exactly; it changes no runtime assertion or GitHub issue state. The cumulative Phase 104 snapshot now has 13,918 rows: all 13,906 prior rows plus eight native PASS, three audit PASS and this one recorder FAIL. The isolated follow-up preserves the complete 13,914-row intermediate report (`05356759c0e75fea53d782457cd6ca8d1547ac981f62fe964e9f5be1df6441b4`) before its four-row append. Final report SHA256 is `fcd654c8696bd5ebf1e499ac25a33c19376a4e80b3d6840f2762f25053dd790b`; the append receipt retains the source digest and original-prefix backup privately.
