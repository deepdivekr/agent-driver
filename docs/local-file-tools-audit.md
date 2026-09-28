# Phase 71 implementation audit

## Product fit

The feature belongs to a normal prompt-driven Work, not a dedicated Desktop-cleanup product. The existing file.pipeline family advertises reusable inspection, evidence-backed classification and move-proposal tools. A connected agent chooses and calls them. The runtime executes approved file changes, verifies content, records uncertainty and supplies receipts to the next agent. There are no extra VMs, browser streams, continuous filesystem watchers or paid-model calls in this feature.

Defining a Work still does not start an autonomous file worker. That is the existing connected-client dispatch contract, not a tested claim that an arbitrary model will independently choose the correct tools.

## Findings corrected

1. **History was limited before Work/root filtering.** In a direct reproduction, 101 unrelated records made an earlier Work's access request disappear. Queries now apply Work/root scope first. Approval resolves the exact Work/plan binding rather than relying on a paginated report.
2. **Reports borrowed the folder's newest scan.** A later scan changed the earlier Work's observed file count from one to two. Work-bound scans now save compact observation summaries. Another Work's scan and rolling scan eviction cannot replace those summaries.
3. **File effects were missing from Work routing and handoff.** Board/status/detail now distinguish approval, uncertain interruption and execution results awaiting outcome verification. Compact continuity context includes recent file-plan receipts and checks uncertainty across all plans. Finished moves are not implicitly replayed, and a file receipt does not certify the entire Work.
4. **Removing the standalone page removed accessible revocation.** Work detail now offers folder permission revocation. Reusable scope is explained; move/undo controls become unavailable when permission changes. Historical receipts remain visible.

Additional fixes: board timestamps reflect file events; polling uses compact projections rather than scan contents; final file labels use the existing English/Korean translation mechanism. Windows regression teardown closes reopened databases and HTTP servers before deleting fixtures. Windows tests use a real directory junction; Linux retains its original file-symlink case. Assertions were not removed to obtain a pass.

## Verified scope

- Strict build with pinned Node 22.22.0 and TypeScript 7.0.2.
- 47 focused regression cases: local file boundaries, real synthetic-file move/undo, Work HTTP/API, intake, consent and migration/continuity. A final six-case HTTP/Work rerun covers the last presentation/contract edits.
- Real Windows Control Center browser flow with synthetic files and a fixture Work planner: grant → observe/propose → pause → approval disabled → resume → move → byte/path readback → undo → revoke → retain receipt. Korean names/content and a recent protected file remain intact. Mobile width 390 has no horizontal overflow.
- No real Desktop files, authenticated sites, external messages or paid AI calls were used. The installed personal runtime was not replaced.

Exact case results, preceding failures and environment limits are recorded in `tests/evidence/phase71-purpose-audit.json` and accumulated in `tests/report.json`.

## Remaining limits

- WSL execution is unavailable for this audit; a fresh `/bin/true` probe did not return and was cancelled. Linux and the installed personal runtime still need their own validation. The earlier full quick-suite release gate remains open.
- Live LLM/Jev interpretation quality was not measured. File evidence and an agent's inference remain separate; no confidence value or verified authorship is invented.
- This increment covers bounded local file inspection and reviewed organization, not arbitrary app launching, application history databases, Office/PDF parsing or a full semantic index.
- Interrupted multi-file operations remain journaled for reconciliation, not blindly replayed. Hostile same-user filesystem races, ACL/alternate-stream preservation and atomic multi-file transactions are not promised.
- Work reports return at most 100 recent plans and mark truncation; compact handoff returns up to 30 recent receipts. These limits do not remove older persisted history or exclude old uncertainty from the Work state.

Conclusion: this implements reusable execution tools and durable Work evidence in line with the app's purpose. It is not evidence that every desktop task or the entire release is production-verified.
