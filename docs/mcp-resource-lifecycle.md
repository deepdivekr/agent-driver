# Shared MCP runtime and memory

The normal `agent-driver mcp` command is a lightweight stdio bridge to one local
Streamable HTTP MCP service. It does not construct RuntimeApi, open a DB, or
load browser/model executors. Direct HTTP clients need no per-conversation process.

## Ownership and limits

- Concurrent starts lock ownership and reuse the existing service receipt.
  A live but unreachable owner is an error, never permission to start another.
- Loopback-only bind, private bearer token, exact Host check, browser Origin
  rejection, 64 KiB request limit and 32 protocol sessions per service.
- Each session has its own sampling/elicitation peer and RuntimeApi. A shared
  process does not merge human approvals.
- Inactive sessions expire after 30 minutes; admitted operations are excluded.
  Reconnect after expiry. Uncertain operations are never automatically replayed.
- `mcp --config PATH` remains direct stdio for compatibility/diagnostics.
  Direct servers and shared services together are capped at three full MCP
  processes per OS user. The fourth fails with
  `MCP_PROCESS_LIMIT_USE_SHARED_SERVER`. This is not a global cross-machine cap.
- Default stdio still has one lightweight bridge process per client. Direct HTTP
  avoids that overhead. Windows, Linux and VM are execution environments, not
  reasons to start a new full server for every conversation.

Queued Work is data, not one VM per Work. Browser, model CLI, desktop and detached
worker memory are separate costs; the MCP cap does not cap total VM/browser RAM.

## Cleanup and loading

CLI/Control Center/VM/soak/Playwright imports load on actual use. All tools and
ticks participate in connection lifetime fencing and draining. EOF, broken
input/output, signals and transport closure stop timers, mark presence stopped
and dispose owned resources. Closing one session leaves other clients connected.
SIGKILL and machine loss cannot run graceful cleanup; durable reconciliation
still applies. Browser modules remain cached after actual use.

## Measurements — 2026-09-28, Linux/WSL Node 22.22.0

Initialization, 102-tool listing and read-only health; no browser, paid model or
actual Work execution. PSS apportions shared pages.

| Measurement | PSS |
|---|---:|
| Direct stdio before lazy imports, mean of three owned clients | 142.0 MiB each |
| Direct stdio after lazy imports, mean of three owned clients | 86.9 MiB each |
| Shared service, one client | 95.0 MiB total |
| Shared service, three clients | 98.9 MiB total |
| Shared service, twelve clients | 102.9 MiB total |

The first comparison is the same candidate before/after, not the old installation.
Its elapsed time increased from 6.6s to 9.7s: no startup-speed win is claimed.
Shared-server RSS with twelve clients was 146.9 MiB. Sessions returned to zero
after disconnect but the allocator retained about 102.5 MiB PSS.
This is not a long-duration leak test or application-workload benchmark.

Reproduce from the repository in Linux/WSL:

```sh
npm run build
node scripts/runtime/mcp-memory.mjs
node scripts/runtime/mcp-shared-memory.mjs
```

Both probes close only their owned clients/services and temporary data.

## Local operation

From the installed Agent Driver directory, use the existing host configuration:

```sh
agent-driver mcp-service start --config /absolute/path/runtime-config.json
agent-driver mcp-service status --config /absolute/path/runtime-config.json
agent-driver mcp-service stop --config /absolute/path/runtime-config.json
```

Private `.mcp-service.json` beside the configuration records exact process identity,
stable loopback port and bearer token. Never publish it. A confirmed-dead service
can restart at the same endpoint/token without replaying work. A changed install
path or package version requires intentional restart. Old receipts without a
version require restart too. Disconnect clients first; `stop` refuses active
sessions, verifies the service identity and waits for graceful shutdown.
It does not force-kill a hung process. The endpoint and token remain available
for restart.

`mcp-service headers --config ...` is private HTTP auth-helper output, containing
credentials. Never print it in logs/support reports. Older Codex versions may not
implement header helpers; use supported private headers instead. Direct HTTP alone
cannot launch stopped WSL. A supported helper or normal service-start flow is
needed after full host shutdown. No new OS-wide autostart task was installed.

## This PC: applied local candidate, not public release

The user requested terminating duplicate MCPs: 52 old processes initially, then
two later old connections during registration change. No unrelated service, VM
or user browser was terminated. Windows and WSL Codex now reference the same
shared HTTP service. Already-open conversations may cache old registration:
reopening Codex ensures the new configuration is used.

Client settings and the SQLite DB were backed up first. Generic maintenance backup
rejected this legacy schema; a separate SQLite online backup passed integrity and
row-value comparison for 65 tables. The reviewed Phase86 bridge retains private
workflow adapters. The known added `jev_override` column copies the prior Jev
choice; all existing data values and other host settings were preserved.
No workflow, message, schedule or model call was executed by validation.

Evidence: `tests/evidence/phase87-shared-mcp.json`.
Final quick regression: 989 tests plus input integrity, 990/990 PASS, no long soak.
Unrelated Windows-native/VM release gates from Phase85 remain separate.
