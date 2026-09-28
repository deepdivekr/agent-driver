# Phase 84 — Local agent browser fallback

Scope: the user's installed Windows Aside browser and Codex connection settings.
This is not a new Agent Driver product executor or an installed-runtime upgrade.

## Exact requirements / TODO

- [x] RQ-776: Configure the installed local Aside browser as the Codex fallback when Neo is unavailable, preserving the primary connection, local-host scope and uncertain-effect boundaries.
- [x] RQ-777: Verify the official Aside MCP handshake and a real public-page observation, preserve existing browser tabs, and record configuration scope, versions and remaining limitations.

Use the official signed Windows CLI, direct REPL observation and no model delegation.
Do not copy authentication stores, publish private browser state or replay submissions.
