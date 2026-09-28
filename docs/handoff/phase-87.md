# Phase 87 — bounded shared MCP

Source: /home/<user>/projects/agent-driver/release-v0.2.0, existing dirty
release/v0.2.0 tree preserved. Node 22.22.0, npm 11.11.0, TypeScript 7.0.2,
MCP SDK 1.30.0. Package stays 0.2.0; no commit, push or public release.

## Completed RQ-788–794

- Old installation: 52 open-pipe MCPs, ~3.45 GiB aggregate PSS. Age was not proof
  of orphanhood. Explicit user authorization: 52 stopped initially (one forced),
  two later old connections stopped during settings change (one forced).
- Lazy command/Control Center/Playwright imports reduce direct MCP mean health PSS
  from 142.0 to 86.9 MiB. No startup-speed improvement claimed.
- Per-connection lifetime fences all tools/ticks, drains, disposes, cleans presence.
- One reusable loopback HTTP server; default stdio is a protocol-only bridge.
  Session sampling/elicitation remain distinct, with real reverse-RPC tests.
- Atomic nonce locks handle concurrent startup/reuse, conservative dead-owner
  recovery and a proven lock-release race. Three full processes per OS user max.
- Bounded 32 sessions, 30-minute idle expiry, busy-call protection; no effect replay.
- Fixed real config/catalog/workflow TDZ cycle through schema-only
  integrations/workflow-contracts.ts; kept the triggering import test.

## Evidence

- Initial affected 26/26: runtime-tests-2026-09-28T11-39-18-260Z.json.
- Earlier full quick 975/976 exposed TDZ; fixed, failure preserved.
- First shared targeted 28/30: stdin remained referenced after oversized input;
  bad-Host fetch test did not send the requested Host. Fixed stdin disposal and
  tested with a real HTTP Host request.
- Second targeted 30/31 exposed concurrent lock release race; fixed.
- Third targeted 31/31: runtime-tests-2026-09-28T12-14-14-143Z.json.
- Final full quick 990/990, exit 0, input fingerprints unchanged:
  tests/evidence/runtime-tests-2026-09-28T12-16-11-253Z.json.
  402 contract_fake, 155 fixture_integration, 152 native_integration (includes
  input integrity), 281 unit. Long soak excluded.
- 32 concurrent/repeated launcher attempts reused one PID; 12 native protocol
  clients shared it. Auth/Host/Origin/body/session bounds, separate reverse RPC,
  DELETE/reconnect, stable dead-owner restart and fourth-direct refusal passed.
- Twelve-client shared service: 102.9 MiB PSS / 146.9 MiB RSS, read-only workload.
- One owned daemon left by the failed second targeted test was identified and
  stopped in final inventory. Final suite left no additional shared service.

## Local application and private evidence

Shared WSL service initial PID 447350, URL http://127.0.0.1:45621/mcp.
Use its private receipt for current identity; do not blindly signal this old PID.
Windows and WSL Codex use that HTTP endpoint. Their old settings are retained as
config.toml.pre-phase87-shared-mcp.bak; unrelated sections are unchanged.

Windows Codex CLI 0.141.0 accepted HTTP but did not expose header-helper support.
A private static bearer header was added as compatibility fallback, without
printing credentials. Supported newer helpers can start/reuse the service.
An older direct HTTP client still needs service start after a full WSL shutdown.
No OS-wide autostart task was installed. Already-open conversations may need
Codex reopening; successful Windows HTTP validation is not proof that every
existing conversation reloaded its registration.

Real Windows protocol validation: initialize, 102 tools, runtime health and
preserved workflow catalog. Actual workflow execution/model calls: zero.
The live config gained only reviewed workflow_bridge, pinned to private modules
in runtime-personal. Keep that directory. Existing settings and old values in
65 tables are preserved. Only known office_intake.jev_override migration occurred,
copying prior jev_enabled. A first comparison that included the new column failed;
the failure was preserved before verifying existing columns and new-column meaning.

Private audit root:
 /home/<user>/.local/state/agent-driver-audit/20260928-resume/
Contains exact config plan/rollback, SQLite online backup, registration checks,
stop receipts, Windows HTTP evidence, installed verification and job logs.
Generic maintenance backup rejected legacy schema; online backup passed integrity
and data comparison instead. Never publish private backups, keys or workflow data.

## Read next / limits

Read docs/mcp-resource-lifecycle.md; src/interface/mcp-service.ts,
mcp-service-manager.ts, mcp-process.ts, mcp-proxy.ts, mcp.ts;
tests/runtime-mcp-service.test.mjs and runtime-mcp-lifecycle.test.mjs.

No public release. Browser/model/VM memory is not capped by this process limit.
Windows-native/macOS/VM daemon performance is not established by WSL tests.
Unrelated Phase85 desktop/VM approval gates remain.
Next: reopen Codex once and use a normal Work through the shared connection;
never replay old uncertain external actions just because MCP restarted.
