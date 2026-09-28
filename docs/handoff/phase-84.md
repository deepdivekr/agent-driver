# Phase 84 — Local Aside fallback

## Completed

- Read the official [Aside developer setup](https://docs.aside.com/help/developers)
  and [Codex MCP configuration guidance](https://developers.openai.com/learn/docs-mcp).
- The installed Aside browser and daemon were already running. Installed only
  the official Windows CLI after publisher, timestamp and Authenticode checks.
  The installer also verified archive/executable hashes.
- Registered `aside mcp --host local` with an absolute executable path in the
  Windows user's Codex configuration, preserving Neo and other existing entries.
- Added durable user-level instructions: Neo first, Aside on availability failure,
  fresh browser state on transfer, no authentication-store copying and no blind
  replay of uncertain external effects.
- Actual Codex config parsing and direct stdio MCP initialization/tools listing
  passed. REPL opened the public developer docs, read the accessibility snapshot
  and title, and closed only its own test tab: 5186ms. Existing tabs were preserved.
- No model-backed Aside exec call, private-site login or external message used.

## Scope and remaining limits

This configures the current PC's Codex agent; it does not add an Aside executor
to Agent Driver's internal Pack runtime, replace its installed runtime or release
a product version. Phase 83 release blockers remain unchanged.

The current conversation has no named Aside tools yet. Direct official CLI/MCP
access works now; a new Codex session may be needed to load the registered tools.
Neo itself was unavailable and was not restarted or reconfigured.

## Resume references

- User-level Codex config: `%USERPROFILE%/.codex/config.toml`, section
  `mcp_servers.aside`.
- Routing instructions: `%USERPROFILE%/.codex/AGENTS.md`.
- Private acceptance harness and receipt:
  `%USERPROFILE%/.codex/browser-setup/aside-check.mjs` and
  `aside-read-verification.json`.
- Public sanitized evidence: `tests/evidence/phase84-aside-local.json`.
- Read CLI `guide repl` and current tool schemas before browser actions.

## Versions

Aside CLI 1.26.916.1741; existing daemon 1.26.926.2148;
MCP protocol 2024-11-05. Product Node/package versions unchanged.
Only the probe-owned MCP child and browser tab were closed. Existing browser and
daemon processes remain running. No commit, push or publication.
