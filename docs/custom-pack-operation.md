# Specific recurring tasks with custom Packs

A custom Pack saves one demonstrated family recipe together with the original
Work request, completion checks, resolved answers and explicit user directions.
It reuses the procedure. Each new cycle produces and verifies new observations
and output. Existing family recipe caches remain unverified draft planning hints.

The current implementation uses existing executable Pack families. It does not
serialize an arbitrary multi-step agent session into a replayable workflow.
Publication rejects a Work completed through multiple distinct family recipes.
External APIs, libraries or CLIs can be dependencies of a particular Pack;
there is no universal integration marketplace requirement.

## Save a demonstrated procedure

Finish an ordinary Work and inspect its independently verified supervisor result.
Use the real Work, supervisor run and matching family run IDs:

```json
{
  "tool": "runtime_custom_pack_publish",
  "arguments": {
    "key": "daily_records",
    "title": "Current daily records",
    "work_id": "<verified Work UUID>",
    "supervisor_run_id": "<verified supervisor UUID>",
    "pack_run_id": "<matching Pack run UUID>"
  }
}
```

Publication reads host-owned verification and the exact saved execution receipt.
A family success, model assertion or cached recipe cannot publish a ready Pack.
A draft-only task can publish after its original draft goal is independently
verified; this never grants permission to submit it externally.

`runtime_custom_pack_list` lists ready names. `runtime_custom_pack_versions`
takes `{ "key": "daily_records" }` and returns immutable versions. A different
verified procedure or completion contract creates another version under that key.

## Run another cycle

```json
{
  "tool": "runtime_custom_pack_prepare_repeat",
  "arguments": {
    "key": "daily_records",
    "version": 1,
    "cycle_id": "2026-10-02"
  }
}
```

Preparation creates a fresh ordinary Work with no old receipts, artifact claims
or stage evidence. It returns the exact Work ID and revision. It starts no tool
and grants no model-cost or effect approval. Execute through the normal path:

```json
{
  "tool": "runtime_work_execute",
  "arguments": {
    "work_id": "<returned Work UUID>",
    "revision": 1,
    "cost_acknowledged": true,
    "current_run_only": true
  }
}
```

Use the returned revision, which can be greater than 1 when the demonstrated Work
had explicit user directions. Normal host scope, effect, approval, uncertainty,
pause/resume and original-goal verification still apply.

The same key/cycle/input combination retains the same Work and Pack request ID
across retries and restarts. A new cycle ID gets new execution and artifacts.
Repeating a completed cycle does not refresh its output. Prepare another cycle
for fresh input. A cycle cannot silently switch version or parameters.

Only source parameters already present in the demonstrated recipe may change.
An override never changes the original user goal or completion condition.
Ambiguous repeated source IDs are rejected. If a goal, fixed date, recipe, target
or host configuration changes, demonstrate and publish a new version.
For a sealed collection contract, changed parameters require an explicitly
redefined Work and newly verified version. An unchanged period may be repeated
with a fresh observation; an old fixed-date goal cannot silently become a new date.

Each prepared custom cycle requires `current_run_only: true`. To orchestrate a
schedule, prepare a new cycle for each occurrence or use the explicit schedule
API below. Built-in scheduling of the same custom-cycle Work is blocked to avoid
returning its old output. Existing ordinary Work schedules are unchanged.

## Enable automatic recurring cycles

After the user explicitly agrees to the interval/timezone and future model use,
configure a pinned version with the current revision of its verified source Work:

```json
{
  "tool": "runtime_custom_pack_schedule_configure",
  "arguments": {
    "key": "daily_records",
    "version": 1,
    "parent_revision": 1,
    "definition": {"kind": "daily", "timezone": "Asia/Seoul", "hour": 9, "minute": 0},
    "cost_acknowledged": true,
    "recurrence_acknowledged": true
  }
}
```

The existing Work scheduler claims a durable slot and creates a fresh child Work
for that occurrence. Every child has its own cycle, request, supervisor run and
output verification. The source Work remains the parent control surface; its
original business goal and verified completion contract are not rewritten.
The managed Control Center starts its supervisor again on restart. A bare MCP
process activates the Work supervisor through execution or schedule activation;
reading schedule status alone does not start the scheduler.
Missed slots use the existing coalescing policy and never generate a catch-up
burst. A restart or retry cannot duplicate a claimed occurrence.

Use `runtime_custom_pack_schedule_status` with `parent_work_id` to inspect the
schedule. `runtime_custom_pack_schedule_disable` takes `parent_work_id` and the
current `parent_revision` and disables future occurrences. Existing results are
retained. Parent pause/detachment, changed contract/configuration and an unresolved
child review or uncertain effect block further execution. Write approvals retain
their ordinary scope; schedule consent does not grant a new write permission.
A failed custom child keeps its slot occupied while the user recovers that
same execution. Verified success releases the slot for the next occurrence.
Missing parent or child metadata holds the affected schedule; it never falls
back to rerunning the original Work or stops healthy sibling schedules.
Pausing a child or its scheduled parent also stops timer observations and the
next source read or output write within a running Pack. An already admitted
read can finish and retain its checkpoint. Resuming keeps that same run and its
completed observations. Paused work does not occupy the timer's execution batch
ahead of healthy work.

## Completion and recovery

- `office_result_draft` accepts `format: "txt"`, `"json"` or `"csv"`; TXT remains
  the default. Structured content is validated before writing and independently
  read back. A request binds one format and byte sequence.
- `local_records.read_fields` delegates observation separately from editable
  `fields`. Original read-only values and non-target preservation can be checked
  without expanding write permission.
- Source `numeric_columns` converts only explicitly declared numeric values;
  original content hashes and normalization metadata remain distinct.
- Optional typed native checks verify technical artifact or watch contracts.
  Use `output_rows: "observed_source_rows"` when every original observed row is
  required and the number varies between cycles. Literal row counts remain
  available for exact cardinality requirements. Without a sealed collection
  contract, independent original user-goal verification remains mandatory.
- For `portal.collect` or `file.pipeline` against one registered file/HTTP source,
  the first model can provide a `collection_contract`. The host seals source,
  parameters, date/value filters, deduplication, columns, numeric conversion,
  sorting and storage format together with the original Work instructions.
  Code derives all matching rows from the complete saved input and compares the
  actual complete output. It does not guess a fixed correct row count or ask a
  second model to approve covered collection conditions. Remaining semantic or
  process conditions still require their own verification.
- The initial interpretation is still a model decision. Hashing that decision
  prevents later drift; it does not prove that arbitrary natural-language meaning
  was interpreted correctly. Remote coverage means the complete observed
  response, not unseen pages or all data on a website. Browser/multi-source or
  semantic extraction contracts are not supported by this code-only path.
- File/HTTP JSON/CSV collection and native exports have no arbitrary byte/row
  ceiling. Streaming preserves the entire response/output; model evidence pages
  remain bounded and marked incomplete until read in full. Existing row arrays
  and database checkpoints still need memory/storage proportional to the data.
- Watch checks verify actual baseline/current observations, declared elapsed
  time, comparison and a matching local event. Saved remote observations are
  never described as current remote freshness.
- A bounded completion repair can refresh a known no-effect read. Writes and
  uncertain effects retain reconciliation fences. Historical status/events and
  pausing a watch remain available when a changed contract blocks execution.
- If a custom Pack's known no-effect source failure has recovered in the same
  durable run, a repeated execution request observes its current status through
  a fresh read. The earlier failed receipt stays unchanged; the new status
  receipt has its own evidence ID. If recovery is still pending, the Work stays
  available for review and retry after its connection or source is restored.
  This path never replays a Pack write or reconciles an unknown external effect.

The authoritative scope and resumption procedure are in
[the refactoring plan](custom-pack-refactoring-plan.md) and [AGENTS.md](../AGENTS.md).
Measured test results and remaining real-user acceptance limits are in
[the progress record](custom-pack-refactoring-progress.md).
