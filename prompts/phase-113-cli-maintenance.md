# Phase 113 — Current local CLI clients and explicit model defaults

Update the user's installed clients in their actual Windows and WSL environments through their supported installation manager. Preserve login credentials, project files, active sessions and paused Phase 112 Works. A CLI version, a discovered model and an actual model response are separate observations. Never silently replace the requested models or turn subscription exhaustion into paid API usage.

## TODO

- [x] RQ-899 | Identify and update installed Codex, Claude and other supported local CLI clients through official bounded update paths, preserving credentials and active sessions; record actual before/after versions and unsupported installation ownership.
- [x] RQ-900 | Default new subscription settings to Codex GPT-6.1 Sol with low reasoning and Claude Sonnet 5.5; apply the user's requested defaults locally, refresh actual catalogs, and preserve unrelated API, coding, role and session overrides.
- [x] RQ-901 | Add durable periodic CLI maintenance to the existing runtime with an enabled/off setting, duplicate and active-session fences, bounded official update commands, cooldown, model refresh and visible localized progress; never install missing clients automatically.
- [x] RQ-902 | Verify update failures, busy deferral, restart/deduplication, configuration preservation and exact model defaults with focused regressions and native observations; update status, tests and handoff without claiming unfinished Phase 112 E2E or publication.
