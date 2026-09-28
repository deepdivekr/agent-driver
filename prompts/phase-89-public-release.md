# Phase 89 — Public v0.3.0 release

The user authorizes publication and asks for a shorter, current README. Release
the supported Ubuntu/WSL scope; do not advertise experimental Windows/macOS or
optional-browser capabilities as certified. Preserve private installations/data.

## Exact requirements / TODO

- [ ] RQ-799: Audit the current candidate, remote state, publication boundary and unresolved release gates; separate supported scope from experimental capabilities.
- [ ] RQ-800: Shorten both READMEs around installation, connection and first Work; align version, installer and concise release notes with actual behavior.
- [ ] RQ-801: Validate the frozen candidate with quick regressions without soak, dependency/publication checks and disposable fresh/upgrade installation including v0.2.0 preservation.
- [ ] RQ-802: Publish reviewed common changes through GitHub, verify the merged/tagged source and release assets, and do not overwrite existing immutable releases.
- [ ] RQ-803: Preserve failures and private data; record exact local/CI/release evidence and remaining limitations in status and handoff.
