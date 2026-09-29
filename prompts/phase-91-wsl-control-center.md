# Phase 91 — Windows access to the WSL Control Center

## Requirements / TODO

- [ ] RQ-810: Diagnose the installed v0.3.1 page failure and restore Windows browser access without changing unrelated services or saved Work/settings.
- [ ] RQ-811: Verify Windows-side Control Center identity before publishing or reusing a WSL URL, retry unpublished UI ports within a bounded limit, and preserve loopback/authentication boundaries.
- [ ] RQ-812: Verify collision, timeout, cleanup and reuse paths; record real Windows/WSL evidence separately from injected probes, and publish the fix through PR/CI.
- [ ] RQ-813: Provide a visible light/dark toggle across Control Center pages, remember explicit browser choices, preserve unsent input and keep localized controls usable on mobile.
- [ ] RQ-814: Verify system and explicit themes, reload/navigation, storage denial and cross-tab changes; apply the verified UI locally while preserving private Work, settings, MCP and upgrade compatibility.

Toolchain: Node 22.22.0, npm 11.11.0. Existing tags and release assets remain immutable.
