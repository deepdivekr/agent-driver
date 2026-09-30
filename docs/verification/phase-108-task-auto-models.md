# Phase 108 — Task-level automatic role models

## Implemented scope

- **RQ-874:** Default client, per-app default models and role policy are separate controls. Role policy offers inherit, manual and task-auto. Legacy manual maps retain their semantics. Switching policies preserves manual choices. API/coding overrides hide and bypass global role controls.
- **RQ-875:** Auto uses one existing structured LLM call before Work execution to select all four roles from a bounded, observed subscription catalog or `INHERIT`. Exact role coverage, candidate membership and strict output fields are checked by code. Task text cannot add a provider, endpoint, tool or permission. The allocator receives saved defaults and effort; it cannot change them globally. A Work/task/settings-bound SQLite receipt reuses unchanged assignments. Optional allocation failures retain defaults visibly; connection/session/receipt safety fences still propagate.
- **RQ-876:** Work tools, completion verification and supervised Swarm planning/worker/synthesis/quality decisions receive the Work-bound allocation. Swarm provider views share the original execution locks instead of mutating global providers. Allocation progress and short reasons appear in localized details. Saved preferences are explicitly distinguished from actual execution. No unused role creates another agent.
- **RQ-877:** Candidate validation, settings precedence, cache invalidation, isolation, default fallback, session fences, actual local Pack I/O and supervised fixture Swarm are covered. Desktop/mobile KO/EN settings and Work detail use a disposable Control Center. The personal installation remains reset; no live model conversation or private bot is started.

The bounded candidate/typed answer design follows TypeSafe's [state](https://docs.typesafe.ai/concepts/state) and [function-calling](https://docs.typesafe.ai/cookbooks/function_calling) guidance. Allocation uses the existing LLM bridge, not another Jev policy or API requirement.

## Verification record

| Run | Evidence level | Status | Result |
|---|---|---|---|
| Initial new regression | unit/contract_fake/fixture_integration | FAIL | 4/9 passed. Settings fingerprint included absent environment fields as `undefined`, which the canonical hash rejects. Absent fields now normalize to `null`. |
| Corrected new regression | unit/contract_fake/fixture_integration | PASS | 9/9, including input integrity. |
| Expanded settings/Swarm/continuity suite | unit/contract_fake/fixture_integration | PASS | 44/44, including input integrity. |
| Full quick, no soak | unit/contract_fake/fixture_integration/native_integration | FAIL | 1,574/1,579, including input integrity. One browser-help placement regression, one obsolete mandatory-Swarm assertion and three unit DOM fragments missing the new task-model helper. All new allocation paths passed. |
| Rebuilt affected suite | unit/contract_fake/fixture_integration/native_integration | PASS | 110/110, including input integrity. All five full-suite failure cases passed after the documented corrections. |
| First disclosure-state follow-up | mixed | FAIL | 109/110. Native Work detail never mounted during an empty/loading transition; the nullable previous-panel check needed an explicit guard. Failure retained. |
| Final disclosure-state follow-up | unit/contract_fake/fixture_integration/native_integration | PASS | 110/110, including input integrity. Same-Work refresh, different-Work isolation, empty/loading detail, actual Pack execution and all earlier failed cases passed. |

Private evidence files:

- `tests/evidence/runtime-tests-2026-09-29T23-17-31-321Z.json` — retained initial failure.
- `tests/evidence/runtime-tests-2026-09-29T23-18-15-297Z.json` — corrected new cases.
- `tests/evidence/runtime-tests-2026-09-29T23-20-41-819Z.json` — expanded suite.
- `tests/evidence/runtime-tests-2026-09-29T23-25-37-521Z.json` — full quick, with all five failures retained.
- `tests/evidence/runtime-tests-2026-09-29T23-39-56-054Z.json` — rebuilt 110-case affected suite.
- `tests/evidence/runtime-tests-2026-09-29T23-42-58-156Z.json` — retained disclosure-transition failure.
- `tests/evidence/runtime-tests-2026-09-29T23-45-04-670Z.json` — final rebuilt affected suite.

The full quick suite was not rerun after these local UI/test-harness corrections. The final affected suite includes every failing file plus model settings, billing precedence, native CLI/MCP, continuity, supervision, Swarm and responsive UI. No earlier failure was removed from the cumulative report.

Final separate checks: TypeScript build PASS; `npm run ledger:verify` PASS (171 requirements); `git diff --check` PASS; public-boundary scan PASS (667 tracked/new non-ignored files, zero findings). These checks do not certify live provider performance or constitute publication.

Final review corrections:

1. General browser introductions use an explicitly designated section-help disclosure. They no longer split into an unexpected second disclosure, while generic AI explanations cannot fall into the hidden manual-role panel.
2. The CLI/MCP integration test now verifies the agreed smallest-useful-graph policy and assignee reuse; existing independent execution, concurrent dispatch and permission checks remain. No product behavior was changed to satisfy the obsolete forced-Swarm wording.
3. Three string-only DOM unit harnesses now import the real task-model rendering helper. The complete page already included it; no stub or disabled assertion replaces it.
4. A successful `allocated` reason no longer produces the generic failure-detail suffix. Actual accepted model names remain visible even without native-session continuity metadata.
5. The final Work screenshot case executes real isolated Pack file I/O and independent fixture verification before capture, so the timeline can be checked against actual recorded model calls rather than an allocation plan alone.
6. Visual review exposed an expanded allocation panel closing on a live detail refresh. Its open state is now scoped to the displayed Work rather than lost during rerender or inherited by another Work.
7. Disclosure preservation explicitly handles an empty/loading detail with no previous panel. The new browser regression renders that transition as well as same/different Work identities; it does not rely only on the happy-path screenshot.

Screenshots: `tests/evidence/phase108/auto-models-{ko,en}-{1280,390}.png` and `task-allocation-{ko,en}-{1280,390}.png`. Settings images in all four combinations, plus final desktop Korean and mobile English Work images, were visually inspected. Automated checks cover all four combinations, no horizontal overflow, escaped model rationale, untranslated application text and retained same-Work disclosure state. The malicious-looking `<img>` text in the Work screenshot is an intentional escaping fixture, not injected HTML. Model labels, task content, authentication and catalog responses are fixtures; browser controls, HTTP saves, SQLite state and local Pack file I/O are real within the disposable environment.

## Limits

- This is a local implementation candidate, not an installed or published release. No private Work, prior Office registration, provider login or archived installation was restored.
- Actual model-selection quality, provider-specific model entitlement, latency and token savings have not been measured. One successful allocation adds a model call; subsequent unchanged runs reuse it. Candidate names are not measured performance data.
- Codex uses its installed model catalog; Claude uses its existing latest-model aliases. A saved assignment is not refreshed every turn. Provider authentication and normal handoff are still checked when the model runs; new task/settings invalidate the allocation.
- Unknown-auth clients do not qualify for Auto. API and API-to-auth keep existing choices; auth-to-paid remains forbidden. Imported runtimes and external interactive sessions are not reconfigured.
- Role models are preferences, not execution permission or worker counts. Actual Work completion still requires independent evidence.
