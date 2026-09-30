# Phase 104 — Finish open issue resolution

## Requirements / TODO

- [x] RQ-854: Re-audit every remaining GitHub issue against current main, original acceptance, later implementation and preserved failure evidence; identify completed, superseded and genuinely unresolved scope separately.
- [x] RQ-855: Repair reproducible in-scope defects and run bounded relevant verification, preserving historical failures, effect oracles, ownership and existing runtime/model constraints; no long soak or private bot replay.
- [ ] RQ-856: Resolve GitHub issues with explicit evidence and truthful state reasons; do not claim missing native acceptance or unknown historical causes as completed, and obtain direction where closure would abandon unresolved scope.
- [ ] RQ-857: Record issue dispositions, verification and remaining limits in ledger/status/handoff and publish necessary reviewed changes under the existing protected-main workflow.

The user requests closing the remaining issues after common Action Layer integration. This authorizes issue comments/state changes and related reviewed fixes, not invented acceptance, paid model calls, private-bot duplication, messenger sends, new release tags or bypass of branch protection. Reuse valid exact-source evidence. Preserve NAS authentication limitations and the user-disabled MCP connection. Long soak remains excluded from the normal verification loop. Node 22.22.0/npm 11.11.0/package 0.3.1 remain fixed.
