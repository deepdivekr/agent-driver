# Agent Office working instructions

## Product source of truth

Read docs/custom-pack-refactoring-plan.md before planning or changing this repository.
It is the authoritative scope for the custom Pack reliability refactor requested by
the user. Read docs/custom-pack-refactoring-progress.md for the current checkpoint.

After EVERY context compaction or session resumption:
1. Read this file, the complete plan, and the latest progress checkpoint.
2. Inspect git status and recent commits; reconcile the checkpoint with actual code.
3. Restate the next implementation unit against the plan before editing.
4. Continue the authorized refactor through meaningful checks and commit/push.

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
  Preserve independent verification of the original user goal.
- Verification retries must not repeat completed effects. Unknown writes require
  reconciliation. Known safe reads can refresh missing evidence within bounds.
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
