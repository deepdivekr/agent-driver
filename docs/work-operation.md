# Work operation

Registering a Work stores its instructions. **Execute** starts its actual bounded execution loop; registration alone does not run a bot.

1. Enter the request. Office saves the Work before asking the configured model to define its outcome, checks and route.
2. Review the definition, acknowledge model usage and select **Execute**. The Work gets one durable execution ID.
3. Open its detail page for actual model/tool events, the current stage, waiting reason and result files.
4. **Pause** stops admission at a safe boundary. **Save instruction** pauses the Work and records stage guidance. **Resume** keeps completed receipts and applies the new direction.
5. Results are available in the app. Recorded files can be downloaded. A completed tool or Swarm is not automatically a completed Work: the requested checks need a separate evidence-backed verification.

MCP clients use the same contract: `runtime_work_start`, `runtime_work_execute`, `runtime_work_control`, `runtime_work_results` and `runtime_work_result`.

## Recovery and boundaries

- Work leases and checkpoints live in SQLite. Closing and reopening the control service does not create a new execution or replay completed writes.
- Typed input rejected **before dispatch** may be corrected by the model within its turn limit. Authentication, permission denial and uncertain writes are separate boundaries.
- Verified writes retain exact file/recipient receipts. An uncertain write requires reconciliation; switching a model or executor never authorizes sending it again.
- Configured provider/model settings are retained during handoff. Subscription limits do not trigger paid API fallback.
- Swarm has independent source workers and dependent reduction/synthesis steps. A stage edit invalidates only its affected dependency closure; verified upstream source results remain.
- Swarm quality gates check its workers. Work completion checks separately verify the final outcome and its actual Office-owned result file.
- Repeated Work creates non-overlapping scheduled runs only after execution is explicitly approved. Imported runtime schedules are never duplicated.

## Copied definitions

An accepted pasted migration becomes an Office Work: review the definition, acknowledge model usage and select **Execute** to start it. Import alone does not execute the workflow, activate an Office schedule or send a message. Office does not stop a copied workflow's original platform schedule, so review and adjust that schedule yourself before enabling repeated Office execution to avoid duplicate runs.

## Existing projects

Import analyzes and registers a project; it does not copy its running bot. Connect its supported **original runtime** in the Work detail page to refresh status, send an instruction, pause or resume. Its original sender and schedule remain authoritative. A readable NAS share is not a control connection: remote authentication and a supported runtime control interface are required.

Public installers and the current development checkout are separate artifacts. Applying a local generated build does not publish a release. Actual environment evidence, controlled fault tests and fixture tests must be reported separately.
