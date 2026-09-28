# Local file tools — Phase 71 (unreleased)

These are execution tools for an ordinary Work, not a Desktop-cleanup product page or a separate file manager. A user starts with a prompt such as “내 바탕화면을 업무별로 정리해줘”. The connected agent interprets it, uses the existing file.pipeline family and calls local tools. Only contextual permission, approval and result cards appear inside that Work.

## Workflow

1. The Work definition exposes the file tool contract to the connected planner. The connected agent requests a narrow folder through runtime_files_request with work_id. If the actual path is unknown it leaves the path unset; the human supplies it in the Work's permission card.
2. The human grants metadata access, optionally small text excerpts, and separately permission for reviewed moves. A Windows runtime uses Windows paths; WSL uses its mounted Linux paths. This does not authorize another host.
3. The agent scans with work_id and inspects files, then optionally attaches semantic classifications through runtime_files_classify. Each Work retains its own bounded observation summary; another Work scanning the same folder cannot replace it. All categories remain inferred and require file-local evidence IDs. The agent can use its existing LLM; these tools themselves make no paid-model calls.
4. The agent proposes exact source/destination pairs bound to the same work_id. Folder permission is not approval to move; the human reviews and approves the plan inside that Work.
5. The runtime checks permissions, Work pause state, identity and hashes; it journals the move and verifies the result. The connected agent uses runtime_files_report to report exact moved/restored/preserved items and uncertainty. A receipt does not automatically mark all Work completion conditions satisfied.
6. Undo is offered inside that Work for completed plans. Stale targets and interrupted plans are not blindly replayed.
7. The Work board, status and compact handoff expose pending file approval, uncertain effects and results awaiting final verification. The receiving agent reads runtime_files_report before continuing. Hash readback verifies a file operation at execution time, not all Work completion conditions.

There is no standalone /files UI or navigation entry. CLI/MCP agents cannot grant their own folders or approve moves. The local human endpoints require the Work identity, origin/header checks and exact plan binding. A different Work cannot approve the plan.

The existing product's client-driven dispatch remains: defining a Work alone is not an autonomous file worker. A connected agent must execute the advertised tool sequence. No hidden background LLM loop or hard-coded “Desktop cleanup” bot was introduced.

## Supported evidence and limits

Observed: relative path, size, modification time, filesystem birth time when available, and optional initial lines of TXT/MD/CSV/TSV up to 8 KiB. Filesystem timestamps do not prove who created a file or why.

Inferred: extension category, local profile keyword matches, and unverified agent classifications with evidence references and plain explanations. No synthetic confidence values.

Not implemented: Office/PDF content extraction, OCR, browser download history, application database adapters, verified authorship or original creation context, full semantic indexing, app launching, or a native Explorer replacement. The agent may interpret the evidence it receives; unavailable context must remain unknown.

Text consent permits excerpts to reach the connected MCP client, which may use an external model. Local scanning does not guarantee those clients keep all received text on-device. Jev is optional; this feature adds no independent on/off planner and does not override Pack-level policy.

## Resource and mutation boundaries

Scans use an incremental directory iterator, at most 1,000 inspected entries, depth 4, roughly three seconds (individual OS I/O can exceed this), 256 KiB content total and five saved scans per folder. Partial scans are reported. There are no VMs, watchers, screen streams or continuous indexing. Plans and audit records remain local.

Hidden/system/credential-looking names, links and multiply-linked files are excluded. Known code projects, app databases/config formats, recent files (24 hours), shortcuts and files above 16 MiB are protected from moves. These guards are conservative, not a complete detector of app dependencies.

Plans are bounded to 30 files and 64 MiB. A durable SQLite claim prevents duplicate application. Files are copied exclusively without overwrite, synced and hash-checked, source identity rechecked, then the original path is removed. Undo repeats exclusive copy and verification in reverse. This is not an atomic multi-file transaction or a sandbox against a hostile same-user process racing path checks. Uncertain copies remain for reconciliation. Empty destination directories may remain. ACLs, alternate streams and creation time are not guaranteed preserved; modification time is preserved.

Folder permission can be revoked inside the Work detail. It is a reusable project permission, so revocation also stops other Work using that folder. It blocks cached scan reads and new mutations, but the Work's historical move receipts and bounded observation summaries remain visible. Regranting does not restore old plans automatically. Work results record hash verification at execution time, not a perpetual assertion that files never change afterwards.

History is filtered by Work before applying result limits. Reports show at most the latest 100 plans, explicitly flag truncation and do not present partial counts as lifetime totals. The compact handoff includes up to 30 recent file-plan receipts; its uncertainty check covers the whole Work history. Board polling loads only a small state projection, not file contents, previews or complete scan arrays.

## MCP contract

runtime_files_request → runtime_files_roots → runtime_files_scan (work_id) / runtime_files_inspect → optional runtime_files_classify → runtime_files_propose (work_id) → human approval → runtime_files_report.

runtime_files_plan reports exact durable per-plan state. File text is untrusted data. A cited evidence ID establishes provenance, not correctness of an interpretation. No runtime_files_apply or runtime_files_grant tool is exposed.
