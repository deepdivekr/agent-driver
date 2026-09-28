# Phase 87 — MCP resource cost and connection lifecycle

Resolve idle MCP overhead and deterministic disconnection cleanup without
sharing client authority or automatically retrying uncertain effects. The later
explicit user scope below authorizes stopping old MCP processes and switching
the normal local connection with backups; unrelated services remain untouched.

## Exact requirements / TODO

- [ ] RQ-788: Measure installed MCP process ownership and memory safely, distinguish open client connections from proven orphaned processes, and retain a reproducible isolated baseline.
- [ ] RQ-789: Reduce unnecessary MCP startup imports and resource ownership without removing tools, weakening configuration checks or merging client-specific sampling and approval authority.
- [ ] RQ-790: Fence new dispatch on transport loss or shutdown, drain admitted operations, clean up owned resources and presence, and verify EOF, signals, errors and concurrent-client isolation.
- [ ] RQ-791: Compare owned native MCP memory and lifecycle before and after, run affected and quick regressions without soak, and document measured limits, installation state and remaining release gates.

## User scope extension

The user explicitly authorized stopping all old Agent Driver MCP processes and
requested bounded runtime instances rather than accepting accumulating stdio
servers as normal. Only the exact old Agent Driver MCP entry was stopped:
52 processes, 51 exited after SIGTERM and one required SIGKILL; zero remained.

- [ ] RQ-792: Provide a loopback-only shared MCP service with singleton startup/reuse, bounded sessions and per-client sampling/approval isolation, while retaining compatible stdio access without another full runtime.
- [ ] RQ-793: Connect the normal local client path to the shared service, preserve unrelated client configuration and private workflows with backups, and distinguish shared runtime processes from lightweight transport connections.
- [ ] RQ-794: Verify concurrent startup, multiple real protocol clients, disconnect/reconnect, authorization, stopped-service recovery and bounded process/memory behavior; retain failures and report the actual deployed connection state.
