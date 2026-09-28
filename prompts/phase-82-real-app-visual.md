# Phase 82 — Real application visual acceptance

Continue Phase 81 on an installed application using our owned CUA, not Codex
Computer Use. No private messages, existing draft edits, external submissions,
security/authentication changes, install replacement or release.

## TODO / requirements

- [x] RQ-768 Inspect a real installed application through a bounded owned CUA connection; establish current window identity, available UIA/visual candidates and harmless verification scope without changing existing drafts or sending messages.
- [ ] RQ-769 Exercise common Work-driven visual planning, native navigation, independent readback and verified repetition on a real application; record actual executor/model participation, timings and failures without an application-specific adapter.
- [x] RQ-770 Repair relevant common-path defects and run proportionate regressions; preserve native versus fixture and success versus blocked outcomes, update evidence/status/handoff and verify the ledger.
- [x] RQ-771 Recover an explicitly foreground-authorized minimized window through owned CUA, reacquire current evidence, preserve background-only and paused Work boundaries, and verify bounded recovery on a real installed app.

RQ-769 is partial: real UIA navigation/repetition and real OCR observation passed,
but OCR-only input remains unverified. The user's follow-up explicitly authorizes
restoring and observing KakaoTalk. Minimized state is recoverable, not a missing
environment: implement common permitted recovery rather than asking the user
to restore it. No message send or draft edit is authorized by this follow-up.

Use current observed labels and positive independent postconditions. Do not
force screenshot coordinates, weaken DPI guards or introduce an app-name branch
to obtain a passing test. Safe local test-owned app windows may be launched and
closed; existing user apps may only receive the explicitly requested restoration
and observation. Preserve earlier failures and distinguish already-restored
windows from windows restored by this test.
