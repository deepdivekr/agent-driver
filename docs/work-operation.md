# Work operation

**Start work** in the Control Center saves the request, defines it with the configured AI, and starts its current execution when the definition is ready. The adjacent usage notice explains the model allowance. MCP registration and project import remain registration-only unless execution is explicitly requested.

1. Enter instructions, an optional explicit completion condition and result destinations, then select **Start work**. Blank conditions are derived by AI; material missing details become clarification questions. Office persists the supplied requirements separately from the generated plan; the detail page opens during definition.
2. Quick mode continues into the current run when ready. Guided mode waits for the requested choices. Existing registered Works have an explicit **Run** action with a usage notice; imported projects retain their original runtime control.
3. The detail page shows actual analysis and route outputs, observed sources, the current stage, waiting reason and result files. The right-hand **Execution activity** panel summarizes real analysis, starts, failures, executor changes and source-worker events in readable language. Planned sites are not labeled as visited; active worker counts come from live execution leases. A blocked admission is a failure to start, not an active run.
4. Select a stage to open its control dialog. **Pause** stops admission at a safe boundary; it does not cancel a model request or external send already in flight. **Save instruction** pauses supported running Work and records stage guidance. **Resume** keeps confirmed receipts and applies the new direction. Unsupported actions explain their limits. Closing the dialog does not discard its draft or silently change the Work.
5. Results are available in the app. Recorded files can be downloaded. A completed tool or Swarm is not automatically a completed Work: the requested checks need a separate evidence-backed verification. Verified new Work output is sent to selected saved destinations. The final delivery stage shows each actual receipt and lets you change unsent and future delivery choices. [Delivery contract](work-delivery.md)

MCP clients use the same contract: `runtime_work_start`, `runtime_work_execute`, `runtime_work_control`, `runtime_work_results` and `runtime_work_result`. New execution defaults to the current cycle only, including when `current_run_only` is omitted. Set `current_run_only:false` only after separate user agreement to future recurring execution and its model usage; a timezone is not schedule consent. Existing approved schedules retain their saved policy.

## Recovery and boundaries

- Work leases and checkpoints live in SQLite. Closing and reopening the control service does not create a new execution or replay completed writes.
- Read-only collection scopes browser checkpoints to the exact delegated entry URL, while reusing one live page per origin. Resume validates the original configuration/effect binding before freshly observing the requested URL; it never opens an old saved challenge cursor first. Legacy records are retained, not rebound. Only rendered links become observation candidates.
- A navigation-context race may retry the same page's DOM read at most three times within a three-second readiness budget. It never reopens the URL, changes browser or grants a redirect origin. Other errors and unready DOMs are not successful observations.
- Observed links are paged using a stable snapshot ID and an explicit next offset. Exact URLs are not shortened to fit the model's metadata limit. A received read-only result that exceeds that limit leaves a failed observation, not fabricated evidence or a completed stage.
- Typed input rejected **before dispatch** may be corrected by the model within its turn limit. Authentication, permission denial and uncertain writes are separate boundaries.
- Public read-only browsing starts in the lightweight headless browser. A technical transport failure can advance to the configured Ubuntu guest and then the registered Windows Aside. An observed Google unusual-traffic page is different: the same Google search goes directly to Aside once, without trying the guest, Bing or DuckDuckGo. The saved recovery resumes in that exact profile without asking a model to choose again. If Aside is unavailable, connection is required; if it also shows a restriction, user confirmation is required. No CAPTCHA solving, cookie copying or profile cycling is performed. An explicit engine selection retains its boundary.
- Social and personal-account browsing defaults to the registered Aside profile. A past login status is only a candidate: the runtime checks the current page's authentication marker. Separate host/guest profiles do not share credentials. An unconfigured or unsupported Windows guest is displayed as unavailable rather than as a working login route.

- Verified writes retain exact file/recipient receipts. An uncertain write requires reconciliation; switching a model or executor never authorizes sending it again.
- Configured provider/model settings are retained during handoff. Subscription limits do not trigger paid API fallback.
- Swarm uses the smallest useful graph: one source worker is valid, and larger graphs can synthesize directly without an intermediate reducer. A stage edit invalidates only its affected dependency closure; verified upstream source results remain.
- Swarm quality gates check its workers. Work completion checks separately verify the final outcome and its actual Office-owned result file.
- **Start work** authorizes the current run, not an automatic schedule. The existing explicit execution/MCP scheduling path requires separate schedule acknowledgement and creates non-overlapping runs. The new current-run flow does not yet offer later schedule activation in its UI. Imported runtime schedules are never duplicated.

### Assignees and role models

**Connections & settings → AI** separates three choices:

| Setting | Purpose |
|---|---|
| Default client | The app that first interprets the request, such as Codex or Claude Code. Connected alternatives may take over if it becomes unavailable. |
| Per-app default models | The model used inside each app. These remain the defaults for interpretation and handoff. |
| Role models | Use those defaults, assign planning/execution/verification/synthesis models manually, or select **Auto · allocate per task**. |

Manual role choices inherit the app's default when empty. Existing manual settings retain their meaning. Auto is opt-in: before execution, one bounded LLM call selects from the connected subscription clients' model catalogs, with **inherit default** available for every role. The allocator sees the task and the saved model/effort preferences. Its short reasons and selected models appear in Work details; actual execution and handoff records remain separate from this saved plan. An unused role does not create another agent.

The allocation is stored with the Work, task instructions and model-settings fingerprint. Unchanged runs reuse it, rather than allocating again every turn. Changed task guidance or model settings cause fresh allocation. Missing candidates or an invalid/unavailable answer visibly retain the default models; that fallback is reused within the current run and may be checked again on a later run. Connection, session-lock and receipt-storage safety failures still stop admission. Auto is not a performance benchmark and does not promise the fastest or cheapest model.

Role overrides apply only when both the application's default connection and the effective scope use subscription authentication. Explicit coding settings take priority; API mode, including an explicitly enabled API-to-subscription handoff, keeps its saved models. Subscription exhaustion never enables paid API. Model allocation cannot change reasoning effort, task permissions, tools, approvals or billing mode. Unknown subscription authentication excludes a client from automatic candidates, including OpenCode until its provider authentication is verifiable. For MCP sampling, the connected app chooses its model; this setting does not reconfigure imported Hermes/OpenClaw runtimes or external interactive coding sessions.

Work-bound Codex and Claude decisions reuse their native CLI session for the same run, assignee and role. The latest host checkpoint and instructions remain authoritative. Different Works, runs, providers, models and instruction/output contracts do not share a session. Unsupported clients continue with checkpoint-based context; imported runtimes retain their own session management.

Office retains only an opaque session reference and bounded metadata in its private state directory; the official CLI owns its native transcript. No process stays alive between turns. Missing, interrupted, expired or over-budget sessions start from the current checkpoint. This improves continuity, but does not promise lower token usage or a measured speedup. Execution activity distinguishes native session reuse from checkpoint-only continuity.

### Saved browser sessions

Site login can be prepared before a Work. Choose the environment and site in **Site login**. A connected Windows browser keeps its own profile; the managed Ubuntu guest retains its profile on the guest disk. An owned Linux/WSL browser can opt into a dedicated saved profile for reuse by Work, Swarm and Pack reads. Its login window needs a graphical display (for example WSLg); an unavailable display or guest transport is shown explicitly.

Saved profiles retain browser storage on disk while idle browser processes are closed. They are scoped to the configured project and target, not copied from the user's Chrome folder or between operating systems. Login and automation do not concurrently own the same profile. Turning saved-session use off keeps the disk data but stops using it for new reads; it is not a logout or deletion action.

Profile persistence is not permanent authentication. Sites can expire or revoke sessions and require sign-in or human verification again. Current login is only reported when its live marker is observed; an arbitrary site's saved profile remains unverified without such evidence. Persistence also does not guarantee removal of Google's network traffic restriction. [Google's explanation](https://support.google.com/websearch/answer/86640?hl=en), [Playwright persistent profiles](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context), and [Chrome's Windows cookie encryption](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html) describe these distinct boundaries.

## Copied definitions

An accepted pasted migration becomes an Office Work: review the definition, acknowledge model usage and select **Execute** to start it. Import alone does not execute the workflow, activate an Office schedule or send a message. Office does not stop a copied workflow's original platform schedule, so review and adjust that schedule yourself before enabling repeated Office execution to avoid duplicate runs.

## Existing projects

Import analyzes and registers a project; it does not copy its running bot. Connect its supported **original runtime** in the Work detail page to refresh status, send an instruction, pause or resume. Its original sender and schedule remain authoritative. A readable NAS share is not a control connection: remote authentication and a supported runtime control interface are required.

Public installers and the current development checkout are separate artifacts. Applying a local generated build does not publish a release. Actual environment evidence, controlled fault tests and fixture tests must be reported separately.
