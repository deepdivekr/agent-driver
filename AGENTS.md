# Agent Office working instructions

## Product source of truth

Read docs/work-completion-and-autonomy-plan.md before planning or changing this
repository. Part A (restore a path for Work to reach completion) and Part B
(autonomy) are both authorized by the owner (2026-10-01); B1–B6 have first implementations and B7 is partial
(see the progress checkpoint for what was deliberately not built and why).
docs/custom-pack-refactoring-plan.md remains the background for custom Pack
contracts; where the two conflict, section 3.4 of the newer plan decides.
Read docs/work-completion-progress.md for the current checkpoint;
docs/custom-pack-refactoring-progress.md keeps the earlier history.

After EVERY context compaction or session resumption:
1. Read this file, the complete plan, and the latest progress checkpoint.
2. Inspect git status and recent commits; reconcile the checkpoint with actual code.
3. Restate the next implementation unit against the plan before editing.
4. Continue the authorized refactor through meaningful checks and commit/push.

Owner decision (2026-10-03), which decides where it conflicts with the rules below:
Agent Office is a control center, not a second agent runtime. A Work runs on the
client's own agent (Codex `exec --json` or Claude Code `-p` stream-json) with the
owner's own settings, skills, plugins and MCP servers, in an Office-owned Work
folder (src/work/client-run.ts). The owner chooses the client, model and
reasoning effort for each Work at intake (onboarding only sets the defaults).
One client per Work for its whole life, Office's own judgments for the Work
included: no routing or session handoff between clients (a client calling
another CLI by itself is its own behaviour). Permissions default to everything allowed, as in
the client app; Office does not approve actions one by one. Office records the
events, pauses between turns, hands a new direction to the same client session
as it is (no Office replanning, owner 2026-10-04), schedules and delivers. A client run is complete when its client reports each
completion condition met (COMPLETION.json, owner 2026-10-04); Office verifies
independently only a Work that sends or submits outside. The host-tool
executor is a fallback only. API keys are for Jev only. Execution-tool routing
(Playwright to Aside) stays.

Do not substitute a universal tool marketplace or SaaS integration platform for
the product. Specific, user-owned recurring work is the center; a custom Pack
contains its executable procedure, observable completion contract, and recovery.
External libraries, APIs, or CLIs are optional implementation dependencies of a
particular Pack. They are not a new product workstream.

## Reliability constraints

- Preserve original user requirements and explicit later directions.
- Keep existing Work/run identities, artifacts, and failed receipts. Never backfill
  new proof into an old receipt or relabel incomplete live work as successful.
- Model output is a proposal. Host scope, effect, approval, and identity gates own
  execution authority.
- Technical/native checks may establish only their explicit typed contract.
  For collection, seal the first interpretation of the user's source, period,
  filters, complete input scope and output format; independently compare actual
  sources/results to that contract in code. Use model verification for remaining
  semantic conditions or legacy Works without a sealed contract, not a mandatory
  second model approval of every deterministic collection result.
- Recovery is conditional, not forbidden. Reads may always be refreshed.
  Office-owned local outputs may be rewritten under a new request ID or treated as
  idempotent when target and content match; user-folder writes are retried only
  after rereading the target state. External writes are retried only after
  confirming whether the earlier attempt took effect; when that cannot be
  confirmed, reconciliation is required. Never repeat a completed external effect.
- A false rejection of a correct result is a defect, just like a false success.
  Do not add a gate that stops Work without a reproducible test showing the
  failure it prevents, and prefer code checks over model approval.
- Verify in proportion to risk, decided from the host-closed execution trace:
  read/draft/Office-output Work gets code checks plus one semantic check;
  external writes keep the strict path.
- Enforce prohibitions in host code, not by repeating them in model instructions.
  Remove an instruction sentence only when a test proves the host rejects it.
- Authority is the owner's standing delegation (`work.autonomy`, plan B1), not a
  click per run. Under `delegated`, a Work the owner asked for runs to its result
  and keeps its own schedule; reads, Office outputs, drafts and public pages need
  no further approval. Submissions, payments and messages to third parties keep
  their gates. Questions the plan needs answered go to the owner (ask-first is
  the default intake); the host never answers them on the owner's behalf.
- What the host learns is state, not authority. A saved procedure guides or replays reads; a remembered public
  source is a public GET the host already made. Neither is evidence for a new Work, neither changes the run
  fingerprint or the owner's host file, and only the owner switches one off.
- When a means is blocked, switch to the next one the delegation allows before
  asking a person: another search provider, a directly opened official page, the
  registered foreground browser, an HTTPS text read. A stop that needs a person
  must name what only that person can do.
- Reuse verification procedures and valid bound results; inspect each new run's
  actual outputs. Historical observations are not fresh remote observations.
- Preserve legacy saved Works, Pack recipes, MCP names, and checkpoint readers.

## Workflow and evidence

- Update the progress checkpoint after each completed implementation unit and
  before handing work to another agent/session.
- Record exact source revision, tests run, outcome, limitations, and next step.
- Agents share one checkout: reserve file ownership and coordinate builds/tests
  that mutate dist. Never run a frozen full suite while source/tests are changing.
- Use Node/npm versions compatible with package.json. Run a build and focused
  behavioral tests for changes, then the frozen quick suite and ledger checks.
- Keep fixture/native tests distinct from real-user acceptance. The private
  Phase112 matrix is not available in a clean clone; do not invent its results.
- Do not publish private credentials, capability URLs, browser profiles, or matrix
  receipt contents. Public handoffs may describe outcomes and remaining limits.
- Commit and push the authorized refactor branch. Publishing a release or
  modifying the user's running personal installation is a separate operation.
