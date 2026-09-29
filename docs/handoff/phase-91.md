# Phase 91 — WSL Control Center localhost collision

The installed v0.3.1 service answered HTTP 200 inside WSL. Windows reached an
unrelated certificate application's listener at the same randomly selected port
and received no HTTP response. The identified UI service was stopped, its private
record retained, and the official installed connect command started a fresh UI.
Windows HTTP 200 was verified. Work, settings, the existing MCP and unrelated
applications were not replaced.

Source fix: Windows-side capability URL/status validation on WSL. Newly started,
unpublished UI services close before choosing another port (three attempts).
An existing live service failing the host check is reported as unreachable; it is
not killed or duplicated automatically. Capability tokens remain local and are
never written to this receipt. Existing release tags/assets remain immutable.

Read first: prompts/phase-91-wsl-control-center.md, src/onboarding/control-service.ts,
src/onboarding/control-service-entry.ts. Node 22.22.0, npm 11.11.0 unchanged.

## Verification

- Final affected regressions: 22/22 PASS (21 cases plus input fingerprint integrity).
  Receipt: tests/evidence/runtime-tests-2026-09-29T00-30-27-004Z.json. Injected host
  probes are contract evidence, not real Windows. Redirect hardening included.
- Actual Windows/WSL collision: user_environment PASS. First real host request failed;
  the next selected port passed. Both unpublished test listeners and the temporary
  state root were cleaned up. Private receipt: tests/evidence/phase91-native.json.
- The unrelated Windows application was left running. The user's recovered installed
  v0.3.1 UI remains available; this source patch does not modify installed managed files.
- The recovered settings page was rendered and observed through Aside on Windows.
  No settings, authentication state or Work were changed by this browser check.
- Ledger: 106 RQ recorded. Public-boundary check: 552 files, no findings.

Pending: PR/CI publication. This is a source fix for a subsequent installation release;
the immutable v0.3.1 installer/tag is not rewritten.
