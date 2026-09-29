# Phase 102 — Work operation verification

Observed on 2026-09-29 in Ubuntu 24.04 / WSL on Windows, using Node 22.22.0 and the current development checkout. This is an implementation verification record, not a public release or certification of every provider, executor or operating system.

## Actual Work acceptance

Three disposable Works ran through the product's supervisor, configured subscription model path and actual tools. Completion was checked separately against recorded tool evidence. Each finished with `state=succeeded` and `completion_verified=true`. A subsequent accepted-pasted migration also completed through the same runtime with a separate live-browser acceptance check.

| Work | Evidence level | Completion checks | Generated report | App download |
| --- | --- | --- | --- | --- |
| Public web observation and Korean report | `user_environment` | 6/6 supported | UTF-8 TXT, 874 bytes | Byte count and SHA-256 match |
| Registered local JSON source and summary | `user_environment` | 6/6 supported | UTF-8 TXT, 85 bytes | Byte count and SHA-256 match |
| Parallel public-source research | `user_environment` | 6/6 supported | UTF-8 TXT, 3,183 bytes | Byte count and SHA-256 match |
| Accepted pasted workflow, live public-page observation | `user_environment` | 1/1 supported | Saved title and source-URL report | Persisted app result verified; no file download |

The web Work reused its saved observation instead of reading the page again on resume. The file Work used the actual Pack executor, preserved the registered source's before/after hash, and re-read the generated report. Earlier quality-rejected Pack results remain distinguishable from the independently verified final Work result.

All three verified results have `channel=app`, `authority=office`, `status=available`. Actual files were retrieved through the Control Center's artifact download endpoint and checked against their recorded hashes. This proves local app delivery and download, not email or messenger delivery.

### Downloaded report digests

| Report | SHA-256 |
| --- | --- |
| Web TXT | `42e3b7294e83e06759f62cc94b58c5fdcb2b86873aa0263b52642603941fd290` |
| File TXT | `dbd72986816f8c090c97b992a4e2a755f265011aa7567d8cc32d13ce1c03d05e` |
| Swarm TXT | `aa6ee23844f5b986ca9e838bf88427594e7afc2ed3eecda582b513e41ac9a73c` |

The file acceptance also downloaded two 55-byte JSON artifacts with matching recorded digests. They are preserved execution outputs, not two additional successful Work acceptance tests.

## Parallel execution and timing

The successful Swarm used **8 logical workers**: 6 independent source workers, 1 evidence reducer and 1 Korean synthesis worker. All eight succeeded on their first attempt. Both the durable checkpoint and the actual worker lease intervals show a maximum of **3 concurrent workers**.

| Measurement | Observed time | Meaning |
| --- | --- | --- |
| New Swarm: UI execution start to final Work verification | about 298.5 seconds | Includes planning, worker execution, result creation and final completion verification |
| Swarm worker run | 167.875 seconds | From Swarm run start through the last worker completion; excludes earlier planning and later Work verification |
| Web: final resume to verified completion | 58.968 seconds | Saved observation and result reused; this is not a fresh complete execution |
| File: final resume to verified completion | 82.886 seconds | Retained earlier source receipts; this is not a fresh complete execution |

The web and file `verified` receipt values of 38 ms and 78 ms measure only the final status query and artifact-download verification. They **must not be presented as end-to-end execution times**. Earlier wall-clock durations include implementation repairs, service reloads and manual waiting; they are not a repeat-run speed benchmark. No equivalent sequential-vs-parallel or first-vs-second-run performance comparison is claimed.

The synthesis worker's conservative wording about facts it could not establish from source cards remains in the report. The host subsequently checked worker structure, output readback and effect boundaries using execution evidence. These are separate evidence layers. Observed page links in the result source list are not additional pages proven to have been researched.

## Subscription model continuity

A separate `native_integration` check injected **one Codex quota failure**, then obtained **one real subscribed Claude structured response**. This was a controlled fault test, **not actual account quota exhaustion**.

- The handoff retained the same Work, run, stage, input digest and saved model choices (`client_default` for both clients).
- The Claude response passed the requested typed output contract.
- Paid API factory calls: **0**. Host and saved selection settings remained unchanged.
- Total test time: 9.701 seconds; the real Claude model call took 6.977 seconds.
- All task tools were disabled for this decision-only check; no external effect occurred.

The actual Work session uses the saved subscription-client route. A recorded Swarm definition call identifies Codex with `client_default`; it does not establish a complete per-worker provider history.

Token totals remain **unobserved**. Work context metrics record `observed_input_tokens=null` and `token_observation=unobserved`; continuity receipts likewise mark token counts `unobserved`. Empty client-call snapshots must not be interpreted as zero calls or zero cost. This run does not establish a Jev-vs-LLM speed, cost or accuracy comparison.

## Pasted Work migration follow-up

The final import audit found an over-broad guard: a validated workflow definition copied into the app was treated as an attached original bot. It could be accepted but could not enter the Office execution loop, and its results inherited an original sender that was not connected.

Execution, scheduling and result publication now share one ownership check. A validated pasted definition without an original-runtime binding can run through Office after explicit execution consent. Its default result destination is the app. This also covers valid older accepted drafts without an `import_mode` field. This ownership check does not independently verify the reported original workflow, authorize a model call or send, or certify the workflow's future results.

Actual project imports, observation/enhancement modes, adoption records and direct remote or non-intake Hermes bindings retain their original-runtime authority. Invalid or unclassified legacy drafts do not gain Office execution authority. Copied delivery settings do not connect a messenger automatically: external delivery still requires an available connector and explicit consent. Creating a delivery request does not send a message.

| Follow-up check | Current evidence | Status |
| --- | --- | --- |
| Import ownership, execution/control, scheduling, result publication and UI regressions | 109/109 PASS, including stable-input check | PASS for the recorded focused source/build snapshot; primarily contract and fixture evidence |
| Accepted pasted Work through an actual subscription client and tools | One live `office_browser_read`, three actual model-process invocations, independent check supported | PASS, `user_environment`; verified completion, not a messenger or private-bot test |
| Full quick after the ownership fix | 1,282/1,282 PASS, including unchanged input fingerprints | PASS; the earlier 1,260/1,260 receipt remains a historical checkpoint |
| Installed Control Center overlay after the ownership fix | Actual timestamped local application receipt; 12 Works, configuration and URL preserved | PASS; initial overlay PASS is preserved separately; not a public release |
| Managed MCP replacement and current tool catalog | Fresh zero-session preflight; actual SDK initialization and four required tools confirmed after replacement | PASS; verification session closed; user's disabled client connection has not been reconnected |

The actual follow-up imported a pasted definition with `mode=migrate`, read a public page through Playwright's live DOM and reported its observed title and source URL. The bounded acceptance run took 24.949 seconds. It counted three real configured model-process invocations: two action decisions and one independent completion verifier. The stored verification audit accepted its single evidence-backed condition; the Work ended `succeeded` with `completion_verified=true`. This is not an artifact-download or performance-comparison test.

An additional readback used the production `runtime_work_results` API branch and `WorkResults.list/get` with an enforced read-only SQLite adapter. It returned exactly one persisted result for that Work/run, with `app/office/available`, verified completion, exact summary/text, observed source URL and matching stored-body digest. SQLite changes, model calls, tool executions and scheduler ticks were all zero; result capture was not invoked. This verifies the production persisted-result read path, not an HTTP connection or a full detail-page refresh.

The scoped client's exported `model_calls` snapshot is empty, but the process count and verification audit establish the three actual calls. Token usage remains **unobserved**, not zero. The existing private workflow's fingerprint was unchanged; no private bot was executed, no new schedule was created and no external message was sent. The focused run likewise does not establish a messenger-send result.

The installed Windows UI also passed read-only observation: root/settings returned HTTP 200 without exposed credentials, and Neo showed the Run action disabled until model-usage consent, a Work log region and the English original-schedule notice. The valid pasted migration no longer showed an original-runtime picker. No private Work was executed, no model was called and no schedule was enabled during that UI readback.

The managed MCP was upgraded separately after a fresh preflight observed zero client sessions. Actual SDK initialization and `listTools` confirmed `runtime_work_execute`, `runtime_work_control`, `runtime_work_results` and `runtime_work_result`. The check preserved the 12 Work rows, settings, server URL and token without logging the token, closed its own verification session, and made no model call or job replay. The user's disabled MCP connection was not re-enabled by this test; reconnect it to refresh the client catalog. This was a local managed-server upgrade to package 0.3.1, not a public release.

## Failure history and remaining scope

- The earlier Swarm remains failed with `SWARM_RECOVERY_UNSAFE_OR_EXHAUSTED` and its expired-lease review. Its result was not relabeled successful when a separate new Swarm passed.
- Earlier web/file failure and awaiting-review results remain in the Work history. Checkpoint reuse does not erase those records.
- Earlier full quick runs retain their input-fingerprint failures: source/build inputs changed during those runs. Targeted green tests do not turn those runs into stable full-suite passes.
- Two private evidence-finalization checks initially failed by comparing different digest representations: raw versus canonical-JSON quote hashes, and code-only versus full-tree build manifests. The evidence helper was corrected without changing product source, formal tests or generated build. Both original `unit/FAIL` receipts remain preserved; these were evidence-validation errors, not failed Work executions or invalidated native results.
- **Frozen-input full quick: PASS, 1,260/1,260 checks.** This includes the input-fingerprint check, which found no changed inputs. The result applies to that recorded source/build snapshot. Further fixes discovered after it require their own verification; they do not rewrite this receipt.
- **Final post-fix full quick: PASS, 1,282/1,282 checks.** All cases passed and the input-fingerprint check again found no changed inputs. This separately verifies the frozen pasted-ownership follow-up snapshot.
- **NAS authenticated runtime control: BLOCKED_ENV.** A readable share/import analysis is not proof of authenticated status, pause, instruction delivery or resume against the original NAS runtime.
- **Actual external messenger send: NOT_RUN.** No private bot was duplicated and no external message was sent. Preserving an imported runtime's sender/schedule is distinct from verifying a live send.
- **Initial local installed-build overlay: PASS.** The scoped Control Center process was replaced, all 12 existing Works and their contents were retained, and the connection URL and host/model settings were preserved. No database restoration or external-job replay occurred. This historical snapshot precedes the pasted-ownership follow-up. It was a local generated-build overlay, **not public deployment or a release**.
- **Follow-up local installed-build overlay: PASS.** The ownership fix was applied locally with the same 12 Works, preserved configuration and Control Center URL, no database restoration and no external-job replay. This is another generated-build overlay, **not public deployment or a release**.
- **Managed MCP replacement: PASS.** The initial one-session preflight refusal remains as a historical safety check. A later zero-session preflight permitted replacement, followed by actual SDK initialization/tool-catalog verification and verification-session cleanup. The user's client reconnect remains unobserved.

Final evidence accumulation preserves the original 11 Phase 102 report rows and appends nine follow-up records: seven PASS and the two historical unit FAIL checks above. These report records summarize and bind existing receipts; they are not additional task executions. Historical failures are not removed to make the report uniformly green.

## Evidence index

Local receipts inspected for this record:

- `tests/evidence/phase102-native-browser-verified.json`
- `tests/evidence/phase102-native-file-verified.json`
- `tests/evidence/phase102-native-swarm-verified.json`
- `tests/evidence/phase102-native-final-state.json`
- `tests/evidence/phase102-native-model-failover.json`
- `tests/evidence/runtime-tests-2026-09-29T09-42-32-468Z.json`
- `tests/evidence/phase102-local-apply-initial.json` — immutable initial application receipt; `phase102-local-apply.json` is a latest-receipt alias and may change after a follow-up application.
- `tests/evidence/runtime-tests-2026-09-29T10-14-34-173Z.json` — focused pasted-ownership regressions, 109/109 PASS with stable inputs.
- `tests/evidence/runtime-tests-2026-09-29T10-16-38-596Z.json` — final post-fix full quick, 1,282/1,282 PASS with stable inputs.
- `tests/evidence/phase102-local-apply-1790677575774-f03cedd2-78bc-42d6-a673-05ed9432d1dc.json` — immutable follow-up local generated-build application receipt.
- `tests/evidence/phase102-native-pasted-verified.json` — actual pasted migration with live DOM evidence and independent completion verification.
- `tests/evidence/phase102-native-pasted-app-readback.json` — production read-only result API with exact persisted content and app-delivery provenance.
- `tests/evidence/phase102-installed-ui-2026-09-29T10-28-56Z.json` — read-only Windows HTTP and actual installed Neo UI observation; no private Work execution.
- `tests/evidence/phase102-upgrade-mcp-preflight-initial.json` — preserved initial one-session replacement refusal.
- `tests/evidence/phase102-upgrade-mcp-preflight.json` — later zero-session preflight PASS, observed at 10:31:40 UTC; a latest-receipt alias.
- `tests/evidence/phase102-upgrade-mcp-apply.json` — actual managed MCP upgrade, SDK initialization/tool catalog and owned-session cleanup PASS at 10:31:41 UTC.
- `tests/evidence/phase102-followup-summary-5157b51108672293.json` — append-only follow-up evidence bundle, preserving the original 11 rows and adding seven PASS/two historical unit FAIL records.
- `tests/evidence/phase102-followup-finalizer-failure-2026-09-29T10-32-42Z.json` and `tests/evidence/phase102-followup-build-manifest-failure-2026-09-29T10-34-10Z.json` — preserved evidence-helper validation failures, not product Work failures.
- Earlier failure receipts: `phase102-native-swarm-result.json` and `runtime-tests-2026-09-29T07-33-06-220Z.json`, `runtime-tests-2026-09-29T08-12-51-342Z.json`, `runtime-tests-2026-09-29T08-25-49-447Z.json` under `tests/evidence/`.

Raw local receipts can contain host-specific details and are not publication artifacts. This summary intentionally excludes private paths, source-record contents, connection-token URLs, account identifiers and credentials.
