# Phase 102 — common Work operation and acceptance

This handoff is a development checkpoint on 2026-09-29. Actual pasted-Work acceptance, the final frozen full quick, follow-up local installed-build overlay and managed MCP replacement passed. The user's disabled MCP client connection has not been re-enabled by the verification and must be reconnected to refresh its catalog. Public merge, publication and immutable release were not performed.

## Completed implementation and observed behavior

- **RQ-843:** UI and public MCP explicitly start the same bounded Work supervisor. Durable leases, checkpoints, tool receipts, retry state and independent completion verification survive continuation. Actual web, registered local-file and parallel public-research Works reached verified completion.
- **RQ-844:** Pause, instruction changes and resume keep the Work identity, fence stale revisions and preserve observed results. A paused or interrupted call cannot commit against an old revision. Uncertain writes require reconciliation rather than automatic replay. Actual web/file continuation reused saved source evidence and read back its report.
- **RQ-845:** Supported original-runtime adoption remains separate from execution of a copied definition. The follow-up common ownership check permits validated, unbound pasted migration after explicit consent, including older valid accepted drafts without `import_mode`; original projects, observe/augment modes and adoption/direct remote/non-intake Hermes bindings retain original authority. Invalid legacy drafts remain passive. Focused verification and a separate actual pasted acceptance passed: one live browser read, three real model processes, one independently supported completion condition. This does not establish authenticated NAS control or private-bot execution.
- **RQ-846:** Configured client continuity retains the Work/run/stage/input digest and saved model choice. One injected Codex quota failure continued through one real subscribed Claude typed response, with zero paid API factory calls. This is not actual quota exhaustion. Codex transport normalization preserves caller-schema optional/null semantics and still applies the original domain validator.
- **RQ-847:** Durable Work results expose summaries, observed sources, artifact downloads and delivery receipts. Three actual report downloads matched their byte counts and SHA-256 values. A separate production read-only API check returned one verified pasted-Work result with exact content/source/body hash and `app/office/available`; it did not invoke capture, models, tools or scheduling and made zero SQLite changes. This is not an HTTP/full-detail-refresh check. New and Office-owned pasted Works default to app delivery. Original-runtime senders remain authoritative; external delivery requires a connector and explicit consent. A delivery retry does not rerun the Work and uncertain sends are not replayed.
- **RQ-848:** Three disposable actual Works passed all six independently checked completion conditions. The successful Swarm used eight logical workers, including six source workers, with observed peak concurrency three. UI start to verified Work completion was about 298.5 seconds. This does not certify every Pack family, executor, provider or OS.
- **RQ-849:** The earlier frozen full quick passed 1,260/1,260 checks including unchanged input fingerprints. The initial local generated-build overlay preserved all 12 personal Works, their contents, the Control Center URL and host/model settings. The pasted-ownership follow-up passed 109/109 focused checks and the final frozen full quick passed 1,282/1,282, both including unchanged inputs. Its separate timestamped local overlay also preserved the same 12 Works, configuration and URL without database restoration or external-job replay. After a fresh zero-session preflight, the managed MCP upgrade passed actual SDK initialization and required-tool catalog verification while retaining Work/settings/URL/token state and closing its verification session. The user's disabled client was not reconnected; no public publication occurred.

The UI shows actual Work state and bounded/redacted event tails, not historical run labels as liveness. A supervisor-owned Work displays its actual supervisor run identity even without a legacy `office_run` row, and does not show obsolete “waiting for agent dispatch” controls. Saved results do not themselves imply verified completion.

Recurring Office Works use once-normalized typed daily/weekly/interval schedules, a validated IANA timezone, durable slot claims and coalesced missed runs. Pause/stop prevents further admission. Unsupported recurrence remains a visible configuration wait. Original-runtime imports do not gain a duplicate Office schedule. These schedule guarantees have contract/fixture evidence; no private recurring job was enabled as an acceptance test.

## Verification checkpoints

| Checkpoint | Evidence | Interpretation |
| --- | --- | --- |
| Actual web/file/Swarm acceptance | `phase102-native-{browser,file,swarm}-verified.json` and `phase102-native-final-state.json` | `user_environment`: 6/6 completion checks for each Work; verified app TXT downloads |
| Client quota handoff | `phase102-native-model-failover.json` | `native_integration`: one injected Codex failure, one real Claude response; no paid API fallback |
| Initial frozen full quick | `runtime-tests-2026-09-29T09-42-32-468Z.json` | 1,260/1,260 PASS for that source/build snapshot, including input integrity |
| Initial installed overlay | `phase102-local-apply-initial.json` | `user_environment` PASS, private state preserved; historical pre-follow-up snapshot |
| Pasted-ownership focused regression | `runtime-tests-2026-09-29T10-14-34-173Z.json` | 109/109 PASS, including input integrity; not native model or messenger acceptance |
| Actual pasted migration | `phase102-native-pasted-verified.json` | `user_environment` PASS: live DOM, one independently supported check, three real model processes, 24.949 seconds; no private bot/send/schedule |
| Pasted result app readback | `phase102-native-pasted-app-readback.json` | `user_environment` PASS: one exact persisted app result through the production read-only API branch; zero SQLite changes/calls/tool executions/ticks, no capture |
| Post-fix full quick | `runtime-tests-2026-09-29T10-16-38-596Z.json` | 1,282/1,282 PASS for the post-fix frozen snapshot, including unchanged input fingerprints |
| Post-fix local overlay | `phase102-local-apply-1790677575774-f03cedd2-78bc-42d6-a673-05ed9432d1dc.json` | `user_environment` PASS: 12 Works, settings and URL preserved; no DB restoration or external-job replay |
| Installed UI readback | `phase102-installed-ui-2026-09-29T10-28-56Z.json` | `user_environment` PASS: Windows HTTP 200 and actual Neo action/log/consent/recurrence notice; no private execution or model call |
| Initial MCP preflight | `phase102-upgrade-mcp-preflight-initial.json` | Historical `BLOCKED_ENV`: one client session prevented replacement; no stop or model call occurred |
| Fresh MCP preflight | `phase102-upgrade-mcp-preflight.json` | `user_environment` PASS: zero sessions, current candidate catalog and dependencies ready |
| Managed MCP upgrade | `phase102-upgrade-mcp-apply.json` | `user_environment` PASS: actual SDK initialization and four required tools; Work/settings/URL/token preserved, owned session closed, no model/job replay; user client not reconnected |
| Final evidence accumulation | `phase102-followup-summary-5157b51108672293.json` | Original 11 Phase 102 rows preserved; nine appended follow-up records, seven PASS and two historical evidence-helper `unit/FAIL` records; no additional task execution |

All receipt filenames above are under local `tests/evidence/`. Raw records may contain host-specific details and must not be copied into public material. Prefer immutable timestamped receipts for follow-up records. `phase102-local-apply.json` is a latest-receipt alias, not an immutable historical reference.

## Preserved failures and limits

- The original Swarm failure and lease-review history remain failed. A distinct new Swarm succeeding does not repair or relabel the old run.
- Earlier web/file quality failures and awaiting-review checkpoints remain in the history. Shape-only bounded correction does not reinterpret missing evidence as support.
- Earlier quick receipts retain input-fingerprint failures from changes made during those runs. No test was removed or downgraded to make the suite green.
- Two private evidence-finalizer assertions mixed raw/canonical-JSON quote hashes and code-only/full-tree build-manifest hashes. Only that evidence helper was corrected; product source, formal tests and generated build stayed unchanged. Both initial `unit/FAIL` receipts remain in the report as evidence-validation history, not product execution failures: `phase102-followup-finalizer-failure-2026-09-29T10-32-42Z.json` and `phase102-followup-build-manifest-failure-2026-09-29T10-34-10Z.json`.
- **NAS authenticated control: BLOCKED_ENV.** Reading and analyzing a share is not authenticated runtime status, pause, instruction delivery or resume. Resume only with accepted authentication and a supported control bridge to the original runtime.
- **Private bot duplication and actual external sends: NOT_RUN.** Original personal workloads, senders and schedules were not replayed or changed. No messenger-send success is claimed.
- **Actual account quota depletion: NOT_RUN.** The failover test injected a single quota error; the downstream subscribed Claude call was real.
- Token counts remain `unobserved`; null or empty snapshots do not mean zero model calls, tokens or cost. The pasted client's empty exported call snapshot does not negate its three observed process invocations, including the separately persisted verifier. No Jev/LLM or sequential/parallel speed/cost comparison is established.
- Web/file final receipt query/download milliseconds are not end-to-end task timings. Their final-resume times exclude earlier failures, repairs and waiting.

## Resume sequence

Final ledger state: RQ-843/844/846/847/848/849 are `done`; RQ-845 remains `blocked_env` only for authenticated NAS original-runtime control. Earlier RQ-833 is `done` and RQ-837 remains `blocked_env` for the same NAS authentication/control boundary. Final quick, local overlay and managed MCP upgrade are completed checkpoints, not running work.

1. Read this handoff, `docs/verification/phase-102-work-operation.md`, `docs/task-ledger.md`, `prompts/phase-102-work-operation.md` and `docs/status.json`.
2. Consult the final 1,282/1,282 frozen quick, actual pasted acceptance and timestamped follow-up overlay before the next change. Preserve original failures and historical checkpoints; those receipts do not certify later changes. NAS authenticated control remains blocked separately.
3. If the user's MCP connection remains disabled, have it re-enabled in the client and confirm the refreshed catalog; the completed SDK verification does not prove that reconnection happened. Any future server replacement still needs a fresh scoped preflight, refusing live supervisor/Hermes/admission activity and unknown process ownership. Preserve private state and do not replay jobs to check an upgrade.
4. Final report accumulation is complete and preserves the original 11 Phase 102 records. Append only genuinely new reconnect/application evidence without deleting earlier rows; run `npm run ledger:verify` after any later ledger change. Public release remains a separate action.

## Read first / fixed versions

- Runtime and control: `src/work/supervisor.ts`, `src/work/client-executor.ts`, `src/work/execution-tools.ts`, `src/work/completion.ts`, `src/work/runtime.ts` and `src/interface/api.ts`.
- Migration and recurrence: `src/work/import-authority.ts`, `src/work/import-runtime.ts`, `src/work/adoption.ts`, `src/work/schedule.ts`.
- Results and UI: `src/work/results.ts`, `src/observability/work-view.ts`, `src/observability/work-ui.ts`, `src/observability/work-results-ui.ts`, `src/observability/i18n.ts`.
- Targeted regressions: `tests/runtime-pasted-work-execution.test.mjs`, `tests/runtime-work-supervisor.test.mjs`, `tests/runtime-work-client-executor.test.mjs`, `tests/runtime-work-execution-tools.test.mjs`, `tests/runtime-work-results.test.mjs`, `tests/runtime-work-schedules.test.mjs` and `tests/runtime-subscription-auth.test.mjs`.
- Local application guards: `tests/evidence/phase102-apply-local.mjs`, `tests/evidence/phase102-upgrade-mcp.mjs` and their preflight tests. Scripts are preparation, not evidence of successful execution.

Node **22.22.0**, npm **11.11.0**, package **0.3.1** remain unchanged. The locally overlaid generated build is not a new tagged release or clean source commit. Preserve concurrent Phase 99/101 work and all personal settings.
