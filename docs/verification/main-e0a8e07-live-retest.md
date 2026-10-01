# Latest main real-use retest — October 1, 2026

## Follow-up implementation on `fix/main-work-reliability`

The user authorized finishing the fixes and the sealed collection policy after
the initial read-only main retest below. Its failures remain historical evidence.
The remote main was checked again and still points to `e0a8e07`.
Implementation revision: `98768b951a60574a4dd57640dfcc11b60774818c`.

- Codex transport changes disjoint discriminated `oneOf` into equivalent `anyOf`;
  ambiguous unions fail explicitly. The host still validates the original schema.
  Claude receives its original schema. New model-facing source parameter pairs
  avoid Codex's unsupported `propertyNames`; durable recipes retain their maps.
- Schema errors are not mistaken for expired login, quota or provider outage.
  They do not trigger another client or paid API fallback.
- First Work definition/explicit replan atomically seals the collection recipe
  with the original request and source configuration. Pre-dispatch guards reject
  substitution, including direct MCP calls. Completion checks actual complete
  saved output against all matching source rows; covered collection conditions
  make no verification-model call. Remaining semantic/process conditions share
  one evidence pass. Legacy uncontracted Works retain independent goal checking.
- Historical receipt verification may ignore only descriptive recipe prose.
  Actual source/filters/format, original run binding and certificate hashes remain
  exact. New dispatch still requires the full sealed recipe, including prose.
- File inputs are entirely re-parsed and compared with saved source rows, not
  merely trusted from a checkpoint. HTTP uses the whole original observed
  response; it is not fetched again or described as currently fresh.
- Explicit HTML login/error responses and CSV missing required header fields
  cannot acquire collection completion proof. Valid header-only zero-match data
  is distinct from an error page. Requested fields and actual output still matter.
- Old 8 MiB / 10,000-row source/output ceilings are removed. Streaming, complete
  transfer/UTF-8/hash checks, exact export bytes and lossless evidence paging are
  covered together. In-memory rows/checkpoints remain proportional to data size.
- A rejected custom collection repeat now rolls back its reserved cycle as well
  as the Work, so a corrected preparation can reuse that cycle ID.

Build passed. Final focused run: **90/90 PASS**, including input stability
(`runtime-tests-2026-10-01T03-05-47-266Z.json`; 89 tests plus one integrity check).
The previous focused56/56 receipt is retained and overlaps these tests.
Separate schema/auth/retry/watch checks passed 65/65 before the final source-read
and repeat changes. A new loopback fixture initially failed the production HTTPS
and fixture-account path gates; its configuration was corrected, not those gates.
The final frozen quick passed **1911/1911**, with zero FAIL/BLOCKED_ENV/NOT_RUN:
1910 tests plus one input-integrity check, all1043 input hashes unchanged.
Receipt: `runtime-tests-2026-10-01T03-06-36-160Z.json`.
Input manifest SHA256:
`2fad5a089c562999e78b933fabd1f64a01d3a90b443e66de818ef6ab4febbf71`.
Evidence levels: unit652, contract_fake670, fixture_integration391,
native_integration198; these are not1911 actual-user Works.
The first whole run recorded1887/1893 PASS with six retained failures
(`runtime-tests-2026-10-01T02-43-24-459Z.json`):
the collection resolver wrongly forced closed-trace checks onto uncontracted
legacy Works; a new runtime import cycle broke two independent module entrypoints.
Both production defects were corrected. Recovery fixtures were also updated to
handle the real bounded evidence-batch protocol, without dropping original-goal,
source-row or complete-readback assertions. Interim focused87/90 is retained.
The interrupted earlier quick run is not reported as a completed suite.

The original file-USGS runtime reached verified completion at02:50:06Z without
rerunning its transformation. Independent acceptance initially rejected two
identical4748-byte readbacks solely because their display titles differed.
The checker now validates every page against actual artifact bytes and bindings,
then requires complete byte-range coverage. It still rejects wrong bytes,
identities, metadata and gaps. The original unchanged audit now passes all four
checks: bound run, whole readback, source provenance and exact transformed rows.
The initial rejected audit verdict is preserved. This is **one of the original
24 Works**; the other23 remain unaccepted, not newly verified failures.

### Actual new sealed-collection Work

At 02:48:38Z, a new Work submitted through normal `/work/start` completed with
the actual Codex 0.159.2 subscription client, `gpt-6.1-sol / low`. The request was
to read the registered USGS CSV, select every row with numeric `mag >= 2.5`, keep
`id,time,mag,place`, retain duplicates, sort magnitude descending and save JSON
without changing the original. No exact answer row count was supplied.

An independent parser, without importing Pack parsing/filtering helpers, found
36 source rows and dynamically derived 35 matching rows. The 35 saved rows
matched every expected value, duplicate multiplicity, requested column and sort
position. Full artifact SHA-256 and unchanged original SHA-256 also matched.
The normal runtime reported `succeeded` and `completion_verified=true`, with
one Pack execution and **zero additional completion-verifier model calls**.
Initial LLM definition and four worker model decisions still occurred; this is
not a claim of a model-free first run.

Private receipts: `tests/evidence/live-sealed-collection-probe.json` and
`tests/evidence/live-sealed-collection-probe-status.json`. This is a separate
acceptance probe, not a replacement or a new PASS for any original matrix case.

The final compiled verifier at98768b9 rechecked both saved Work outputs and their
sealed contracts successfully. This was a fresh native proof/readback, not a
repeat model execution or new upstream observation. This final native check ran
after the quick suite and revalidated its1043 input digests. Two separate
`user_environment` rows were appended to the existing `tests/report.json`;
prior rows and failed receipts were preserved. A credential-free public summary
is [collection validation](main-e0a8e07-collection-validation.json).
The isolated matrix service
(owned PID2609608/session27270) received SIGTERM and exited0 after both Works
finished. Private state, output files and failed receipts remain available.

Limits: the first model interpretation may still be incorrect; sealing prevents
drift but does not prove natural-language meaning. Code-only collection currently
covers one registered file/HTTP source and JSON/CSV transformations, not arbitrary
browser pagination, all website data, PDF/EXE parsing or semantic extraction.
Real Claude is signed out; provider fixtures are not actual Claude certification.
No personal install replacement, release or external message/submission occurred.
Ledger verification passed for196 requirements; publication boundary passed
for768 non-ignored files with no pattern findings, and `git diff --check` passed.
These are scoped local results, not acceptance of the other23 original Works.

## Original main retest (before these fixes)

Source: `e0a8e0790b64ff663fa87f5d894b415a1d6f1843` (PR #35 merge).
Checkout: `/home/deepdive/projects/agent-driver/office-main-live-e0a8e07`.
No product source modification, push, merge, release or personal installation replacement.

## Results

- TypeScript build and ledger: PASS (196 requirements recorded).
- Focused custom Pack/source/native-completion suite: 68/68 PASS.
- Frozen quick: 1860 PASS / 1 FAIL / 0 BLOCKED_ENV / 0 NOT_RUN; exit 1.
- All input hashes remained unchanged (`changed_inputs=[]`).
- Failed watch test: `minimum-decrease proof computes both no-drop and drop from real numeric source rows`, assertion `true !== false`. The same six-test file subsequently passed 6/6 unchanged; the full-suite failure is retained and its intermittent cause is not established.
- Original 24 real Works were resumed with their identities, output files, conditions and historical failures preserved. No new completion was independently accepted.
- One separate new public Node-release Work exercised actual intake, definition and admission, rather than a fixture. The Work was saved but admission failed (`needs_model`, `MODEL_OR_DEFINITION_UNAVAILABLE`) before any Pack execution.

## Confirmed blocker

The actual configured Codex 0.159.2 subscription client with `gpt-6.1-sol / low` rejects the production Work proposal JSON schema with HTTP 400:

`completion_checks/items/native_check/anyOf/0: oneOf is not permitted`.

The same schema is used for new Work definition and replanning. A real call through `SubscriptionAwareStructuredModel` and `nativeProcessRunner` reproduces the error. Login succeeds; this is not account expiry or quota exhaustion. The runtime currently reports it generically as `STRUCTURED_MODEL_UNAVAILABLE`/`provider_unavailable`, which obscures the schema incompatibility.

Before stopping at this confirmed blocker, original matrix states were 12 failed, 1 awaiting_review, 1 configuration-wait pause, 2 running and 8 queued. The additional fresh intake had no supervisor run. Pending cases are NOT completed execution failures. Native outputs already produced by historical runs do not certify this latest Work acceptance.

File-USGS reached independent verification but remained unknown because the complete normalized input/output correspondence was absent from the semantic evidence projection. Its artifact, original hashes and failed proof were retained; a missing source readback was not invented.

## Environment and cleanup

The original test SQLite database was backed up using the actual host configuration before migration. A temporary addition of local-record readable fields correctly caused `CONFIG_CHANGED` for previously bound runs; the original configuration was restored and all 24 stored fingerprints matched before the code-only retest. This intentional scope change is not counted as a product regression.

The first test launcher used a non-login PATH that selected the Windows npm Codex shim. That failed attempt was retained. The restarted owned service used the user's Linux login-shell PATH and native WSL Codex. Existing business evidence was not replayed or rewritten.

At the confirmed definition blocker, pending test Works were paused through normal Control Center controls and SIGTERM was sent only to the identified owned service PID 2532687 (persistent execution session 88821). No personal bot, browser, VM or unrelated process was stopped. Do not restart a duplicate while that owned service is draining; verify receipt state and `/proc/2532687` first.

## Private evidence references

- `tests/evidence/runtime-tests-2026-10-01T00-23-12-141Z.json` — focused 68/68.
- `tests/evidence/runtime-tests-2026-10-01T00-24-25-778Z.json` — frozen quick 1860/1861.
- `tests/evidence/runtime-tests-2026-10-01T00-35-24-375Z.json` — watch retry 6/6.
- `tests/evidence/main-e0a8e07-live-retest.json` — sanitized source-bound live snapshot.
- `tests/evidence/phase112-matrix-session.json` — PRIVATE capability receipt; never publish its contents.

Next: fix provider-compatible transport schema without weakening host native checks, add an actual-shape transport regression, then repeat fresh intake and resume the same retained matrix. Release readiness is not established.
