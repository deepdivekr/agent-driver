# Jev-first one-line decision layer

## Production boundary

The browser adapter is deterministic. It performs reviewed selector checks,
navigation, a known-policy dialog action, pre-submit capture, the bounded
approval token check, one dispatch, and independent readback. It does not ask
Jev where to click and it never gives a model execution authority.

For a one-line task request, code creates a small JSON state object with the
request, pack-owned routes, pack-owned fields/candidates, and non-secret
observed state. `TypeSafeJevDecisionLayer` sends one System One batch:

1. **Choice** selects a route from the supplied routes plus `UNSUPPORTED` and
   `CLARIFY`.
2. **Choice** selects each field’s supplied candidate, `NOT_STATED`, or
   `NOT_IN_CANDIDATES`.
3. **Noul** independently decides whether the request actually contains a
   concrete field value. This prevents a candidate miss from being confused
   with an omitted value.

Code then enforces the conservative, pack-calibratable 0.80 route, candidate,
and supplied-value thresholds. High-confidence code-owned candidates become a
draft only; they still cannot cross the existing durable approval boundary.
Low confidence and missing required values hold for clarification. Unsupported
routes hold without a draft.

## Narrow LLM complement

Only `NEEDS_EXTRACTION` may use `targetedLlmExtractorFromStructuredModel`; it receives the same bounded structured model selected for the runtime.
It receives the selected route, missing field descriptions, and the original
one line—not page DOM, screenshots, browser secrets, cookies, or credentials.
It has no tools, no retry, `store:false`, a strict JSON schema, and low
reasoning. Each returned value must equal the exact source substring at its
zero-based `[start, end)` range. A mismatch, extra field, provider failure, or
non-completed response produces a hold and creates no task, proposal, browser
effect, or submission.

This is intentionally not “an LLM that controls the browser.” Jev supplies a
fast typed semantic judgment; Luna supplies a rare, provenance-checked literal
extraction; deterministic code owns all effects.

## Observability and credentials

The durable stages record only provider/model, SHA-256 input fingerprint,
selected route, candidate field IDs, status, and elapsed time. Raw task text,
LLM output text, browser text, cookies, and credentials are excluded.

`typeSafeTransportFromHostEnvironment` requires `TYPESAFE_API_KEY` and
`targetedLlmExtractorFromStructuredModel` uses the same configured client/API model as the Pack and Swarm runtime. The legacy `openAiTargetedLlmExtractorFromHostEnvironment` remains for compatibility and requires `OPENAI_API_KEY`.
Both read the secret at construction; neither accepts it in a task request,
stores it, or returns provider error bodies. Configure those host secrets
outside chat. First real use must be a no-write preflight with a benign pack;
calibration must then set per-pack thresholds against a locked holdout rather
than assuming the default 0.80 values are production quality.

## Current evidence and limits

- `tests/runtime-typesafe-jev.test.mjs`: bounded request construction,
  one-shot Jev behavior, credential rejection, strict extraction schema, and
  no raw secret in request body.
- `tests/runtime-taskpack.test.mjs`: Jev/LLM outputs reach only the durable
  approval boundary; invalid or unavailable correction produces zero task and
  zero browser effect.
- Scoped implementation tests: 17/17 PASS (2026-09-21;
  `tests/evidence/runtime-tests-2026-09-21T01-04-33-460Z.json`).

No actual provider call, provider latency measurement, task-pack calibration,
authentication, or live browser write has been claimed on this host.
