# Adaptive browser Pack — Phase 33

## Implemented flow

Natural-language goal + first observation → Luna/low designs semantic conditions → validated draft specification → fresh browser observation → one Jev request for state, operation and conditional targets/values → the selected branch executes → independent result verification.

Only an independently verified specification becomes reusable. New element IDs are obtained every step; the initial LLM observation is never reused for execution. An uncertain choice, false completion, lack of progress or suspected mandatory-login gate can receive bounded Luna correction. A confirmed human-authentication/challenge gate stops; models do not acquire permission to book, pay or solve challenges.

This is a standalone read-only pilot, **not yet the default MCP natural-language router**. The demo seeds destination/date search URLs. Google Flights verification covers selection of the Cheapest tab and semantic readback of route/date/passenger/cabin parameters plus rendered fares, not autonomous planning from a blank browser. Booking may discard seeded dates and requires visible calendar/form interaction. A model-provided typed answer is not a guarantee of correctness.

## Responsibilities

| Component | Responsibility |
|---|---|
| Luna initial designer | State definitions, action priorities, target questions, input candidates grounded in the request, completion and recovery conditions |
| Jev | Current state, next operation, matching observed target and applicable input/option in one request |
| Browser adapter | Execute selectors on fresh observed elements, check identity, reacquire after navigation |
| Independent verifier | Compare actual search conditions and price units; reject a false DONE |
| Runtime | Bounded loops, evidence, timings, correction limits, validated-spec reuse |

Native text entry uses source-grounded candidates. Free-form copywriting, uploads, OS applications and external writes are not introduced by this pilot. Existing approved-submit Task Packs retain their separate approval protocol.

## Local credentials and execution

Secrets are server-side only. `.secrets/` is Git-ignored, with directory mode 700 and credential JSON mode 600 on Linux. The JSON uses `TYPESAFE_API_KEY` and may optionally contain `OPENAI_API_KEY`. A caller can instead name an existing dotenv file and its `OPENAI_API_KEY` or `PROMPT_API_KEY` variable. Only that value is read; unrelated settings and the source file are not changed. No actual keys appear in examples, command-line arguments, receipts or model inputs.

In the repository directory on Ubuntu/WSL:

```sh
npm run build
node scripts/run-adaptive-travel.mjs --source both --repeat 2 \
  --credential-file .secrets/model-credentials.json \
  --openai-env-file /absolute/path/to/.env.local \
  --openai-env-key PROMPT_API_KEY
```

`--probe-only` opens sources without model calls or actions and is recorded as NOT_RUN, never task success. `--connect-models` optionally exposes a transient loopback-only one-use connection form; the tested runs used private files instead. `--headed` requires an agent-owned display and must not be used to interrupt the user's desktop.

Luna is pinned to `gpt-5.6-luna`, reasoning `low`. The TypeSafe request uses `jev-latest`; the actual returned model version is recorded. Current observations are compacted to bounded text and element data: execution retains full local bindings, while models see shortened labels/URLs and an explicit truncation flag. Unknown omitted evidence must not be invented.

## Evidence and limitations

Outputs live in `artifacts/demos/adaptive-travel/<run>/`: per-source receipts, action journal, final capture, video and sanitized final observation. `scripts/summarize-adaptive-travel.mjs <run>` reports timings. `scripts/runtime/record-adaptive-travel.mjs <run>` appends per-source cases to `tests/report.json`; model-only gate claims are not environment-block proof.

Initial real runs and failed cases are retained. The first corrected Google pair (`2026-09-21T12-41-20-119Z`) passed both independent readbacks:

| Metric | First run | Reuse |
|---|---:|---:|
| Browser startup/capture/close included | 47.527 s | 36.498 s |
| Decision/execution/verification loop | 22.596 s | 11.252 s |
| Initial specification lookup/design | 15.256 s | 0.016 s |
| Luna calls | 1 | 0 |
| Jev calls | 2 | 2 |
| Observed lowest rendered fare | KRW 244,500 | KRW 244,500 |

This is a two-run demonstration, not a statistical speed comparison. The reused run had one 7.587 s Jev call; low median API times from older evaluations cannot be substituted for this run. Prices apply only to the rendered results at capture time, not a guaranteed market-wide minimum or purchasable fare.

Booking targets Tokyo, 2026-12-28 through 2027-01-02, two adults, one room, five-star hotel classification, KRW, lowest full five-night total. Review scores are not star ratings. Taxes-included and taxes-excluded totals are separate comparison pools; unknown tax basis is excluded. Successful API connection or a filled calendar is not a successful hotel search.

Known boundaries: the pilot confidence gate is uncalibrated for these travel pages; no zero-error claim, continuous monitoring, external notification, booking/payment, production release or broad cross-site reliability claim. Retry loops have step/time/correction caps. Future improvement must measure model time separately from navigation, screenshots, videos and browser startup.

## Final validation checkpoint (2026-09-21)

Latest code: `2026-09-21T13-05-19-418Z`. Google passed with a verified cached design, zero Luna calls, two Jev calls (2.846 s combined), a 5.385 s loop and 22.811 s total. Initial optional screenshot timed out (5.012 s); that failure was recorded and is not browser/task success evidence.

Booking remains **PARTIAL**. Jev selected December 28, January 2, Search and five-star controls; Luna assisted calendar navigation. After the five-star navigation, requested search conditions were no longer preserved. The final attempt also encountered Jev APIConnectionError and Luna network failure. Total 106.646 s; nine Jev requests, five Luna requests including initial design; no comparable price cards at final readback. A blank/condition-reset results page is not proof of CAPTCHA or an environment block. No hotel minimum has been established.

Corrected implementation failures: full URL equality mistaken for route equality; missing selected-tab state; navigation destroying observation context; oversized Booking input (`max_tokens_exceeded`); joining multiple separate Luna JSON messages. The adapter now accepts a single response message or one explicitly identified final-answer message, never concatenates multiple actions. Unphased ambiguous multi-message output is rejected. The travel demo permits at most eight correction actions, 35 steps and a 240-second loop; no automatic API retries.

Latest regression evidence: `tests/evidence/runtime-tests-2026-09-21T13-06-30-655Z.json`, 36 tests plus one input-integrity check, 37/37 PASS. This mixes contract, fixture and native evidence exactly as labeled in the report. Earlier failures remain in the accumulated report. No new deployment/publication or complete runtime soak is claimed.

## Design sources

The TypeSafe skill's function-calling and speculative fan-out patterns guided the one-request conditional questions and selected-branch decoding. Exact execution and checks stay in code; semantic action selection is not restricted to popup classification.

- https://docs.typesafe.ai/cookbooks/function_calling
- https://docs.typesafe.ai/patterns/fan-out
- https://docs.typesafe.ai/confidence
- https://github.com/browser-use/jev-ultrafast/blob/main/jev_ultrafast/questions.py
