# Phase 75 — Semantic evidence and bounded reference selection

2026-09-28 resume: authoritative WSL source, all 22 semantic cases, full quick (766/766), and real fresh/upgrade installer checks pass. See [phase-72-resume.md](phase-72-resume.md). Historical Windows results below remain evidence of that environment; no new live-model calibration claim is made.

## Workspace and versions

- Work performed in `C:/Users/<user>/projects/agent-driver-phase73`, branch `phase73-atlas-continuity`, baseline `b7f2f3e0b99ec291ab4b55a99765106dc1d67244`.
- Original WSL checkout remains unavailable. This candidate is not a deployment. Preserve original Phase 72 dirty changes and compare per file after recovery; never replace that checkout with this mirror.
- Node 22.22.0, TypeScript 7.0.2, npm 11.11.0, package 0.2.0 unchanged. No install, dependency bump, public commit or release.
- Existing Phase 73/74 changes and transfer patch preserved.

## Completed

- RQ-737: audited the twelve requested Jev patterns against live official TypeSafe docs, Beacon documentation and actual call sites. See `docs/jev-use-case-coverage.md` for existing, partial, added and deferred capabilities. Main agent used the TypeSafe skill. BrowserOS Neo was unavailable; official docs were read with web fallback.
- RQ-738: added common `pack.semantic` catalog (`citation.support`, `extraction.support`, `context.relevance`), provisional per-head profile, exact-first evidence checks and optional recipe wiring for `research.search`, `portal.collect`, `file.pipeline`. No changes to read/write permissions or original records. Uncertain output is explicit `needs_review`. Source snapshots are not independently fetched truth.
- RQ-739: `runtime_work_context.selection` offers bounded optional selection of recorded excerpts. Explicit reference IDs remain model-free. All mandatory constraints, directions and uncertain receipts remain intact. Only compact selection telemetry enters handoff; full reference judgments are not appended to the context payload. Current coding handoff continues its existing mandatory contract.
- RQ-740: explicit labeled semantic replay helper and ten synthetic labels, 22 new tests, real stdio schema/status discovery and relevant regression tests. These validate contracts, not live model quality. No profile promotion, memory mutation or background paid calls.
- During verification, found and fixed an existing graceful-drain admission race: Windows drain was awaited before Pack admission was fenced. Both now start before the first await. Recovery test ownership now closes/drains temporary runtimes before deleting SQLite files, including reopened runtimes.

## Behavior and safety

- Code handles absent source/value, exact quote presence and explicit literal copying. An exact quote alone cannot pass semantic checks.
- Jev batches independent questions with explicit state item paths (question IDs alone are not model-visible). Invalid distributions, foreign labels, no-match and shadow disagreement do not become verified answers.
- At most one Jev call and one configured LLM correction per semantic batch of 12. Strict correction validation rejects duplicates, non-offered labels and fabricated evidence quotes before applying any answer.
- Detected secret-like fields are withheld from model requests. This uses the existing continuity redactor, not a complete PII classifier. Journal stores hashes/typed metadata; existing raw source checkpoints remain within existing local Pack behavior.
- Same saved model/provider, Pack policy, `model_data_approved`, global Jev OFF and explicit Work OFF rules. No second Work-definition Jev policy. Subscription exhaustion never becomes paid API fallback.
- Optional verification checks Work revision and config before/after model calls; stale Work results cannot export and require a newly reviewed recipe/request. The candidate's existing public Work pause control still rejects active collection Packs; this change does not claim a new mid-run pause UI. A defensive paused-state fence is present for host/state changes.
- Reference selection only reads recorded import/project evidence. Lexical shortlist is bounded to 24 of at most 100 refs; KEEP/SKIP/UNKNOWN is not a complete relevance ranker. Original bounded/redacted excerpt text is retained, not regenerated. No arbitrary file reads, credential-store scanning or protected-core pruning.
- `replaySemanticCases` does not enable itself or change calibration. Synthetic response tests cannot establish Jev precision, 250ms latency or token savings.

## Validation and preserved failures

Reports are cumulative in `tests/report.json`; no failed report was deleted.

1. `tests/evidence/runtime-tests-2026-09-27T23-52-25-380Z.json`: 13/18 cases passed, plus input integrity. Five fixture errors (configuration consent rejection, invalid imported draft fields, model-settings schema) were corrected without weakening runtime gates.
2. `tests/evidence/runtime-tests-2026-09-27T23-54-09-518Z.json`: 16/18 cases passed, plus integrity. Remaining import fixtures lacked valid evidence/trigger/delivery references.
3. `tests/evidence/runtime-tests-2026-09-27T23-55-28-442Z.json`: 18/18 cases plus integrity passed.
4. `tests/evidence/runtime-tests-2026-09-28T00-02-05-570Z.json`: 21/22 cases plus integrity passed. The added pause test assumed an active Pack could use public Work pause; existing code intentionally rejects that. Replaced that incorrect scenario with a legal Work-setting revision during judgment, proving stale output is held and same-request replay remains blocked. No pause guard was removed.
5. `tests/evidence/runtime-tests-2026-09-28T00-04-29-923Z.json`: 85 cases passed, one file-symlink capability blocked, plus integrity. All 22 new cases passed.
6. First filtered recovery command had a Windows quoting/regular-expression parse error before any tests ran; not counted as a test result. Corrected the command.
7. `tests/evidence/runtime-tests-2026-09-28T00-05-48-096Z.json`: 6/18 cases plus integrity passed. Eleven recovery cases failed teardown (`EBUSY` deleting open SQLite); one exposed the drain admission race. An isolated raw reporter confirmed the exact EBUSY path in an owned temporary test folder. Fixed resource ownership and admission ordering, without increasing timeouts or deleting assertions.
8. Final strict build passed, then `tests/evidence/runtime-tests-2026-09-28T00-08-49-440Z.json`: **158/159 cases PASS, 1 BLOCKED_ENV**, plus **input integrity PASS** (159/160 checks). All 22 new cases passed. Includes existing browser collection/auth/write fixtures and process-kill recovery that did execute in this run; do not describe them as excluded. No long soak ran.

Final reporter evidence levels: 76 `contract_fake` PASS, 18 `fixture_integration` PASS, 5 `native_integration` PASS, 59 `unit` PASS, one `native_integration` BLOCKED_ENV. Historical tests use name-based classification; these counts do not imply 158 real-site/model operations. The symlink fixture requires a Windows permission unavailable here; independent hard-link/directory-redirect checks passed. Previous browser shutdown delays remain in Phase 74 reports even though the final related fixtures passed this run.

`npm run ledger:verify` passed (34 candidate RQs recorded), and `git diff --check` passed. Compact evidence: `tests/evidence/phase75-summary.json`. The previous Phase 73 transfer patch still has SHA-256 `93b81949a8369a846f3a495d0a6fa49ce105cfbf1117e1bc37aaaf7c59eb83af`.

## Remaining / resume

- Live Jev/LLM acceptance, source-domain calibration, latency and tokens: **not run**. Candidate lacks the original WSL provider connection; do not copy exposed keys from chat or silently enable paid fallback. Use saved approved providers once the authoritative environment is restored, with independent labeled source evidence.
- Original-source merge, installed MCP deployment and full release gate: **not run**. Read `docs/handoff/phase-72-candidate-limitations.md`, `docs/handoff/phase-73.md`, `docs/handoff/phase-74.md` before merging. Phase 72 readiness and native Windows executor limitations remain unchanged.
- Whole-trace compaction, full external skill loader, repository-wide Jevgrep, embedding retrieval and semantic entity merging: **not implemented**. No automatic free-form memory/skill rewriting introduced.
- Do not repeat passed tests without another code change or new concern. Do not restart/kill user processes as part of source integration without the required scope.

Read next: `docs/jev-use-case-coverage.md`, `src/decision-plane/semantic.ts`, `src/packs/evidence.ts`, `src/work/reference-selection.ts`, `src/decision-plane/regression.ts`, `tests/runtime-semantic-evidence.test.mjs`.
