# Phase 99 — Network import and original-runtime readiness

Read prompts/phase-99-network-import.md, src/work/network-project.ts,
src/work/project-scan.ts, src/work/import-runtime.ts and the Work UI/view.

Existing bot import silently selected augmentation and accepted unsupported empty
scans as generic ready Work. The selected local project was not the actual runtime.
The user's NAS UNC project was accessible from Windows but rejected by WSL paths.

Implemented bounded UNC scanning through Windows Node using the existing Windows
filesystem session. Paths go through stdin, never shell source. The helper imports
trusted Office scanner code only, uses no third-party dependencies, strips Node
preload variables, limits output/time and never executes project code. Generic
Linux receives a mount instruction. No credential copying, mounts or NAS writes.

Scanning includes Python entrypoints and files up to 192 KB within the existing
1 MB total. General contexts use at most 8,000 characters, reserving at least
24,000 of the 32,000-character budget for model/semantic decisions. Service-key
assignments are redacted. Source code is not proof of a live process.

The UI defaults to original-runtime observation preparation, not code enhancement.
Analysis fills goal/checks. New observation Work is atomically paused and does not
dispatch or create a schedule. Legacy unbound project Work displays missing runtime
connection without modifying its data. The source-correction action preserves scope.
Only real scan/model events produce busy indicators; incomplete/unapproved AI
analysis is not shown completed. Optional grounded LLM enhancements and the existing
single Jev efficiency proposal remain proposals, never automatic code insertion.

128 affected cases plus integrity: 129/129 PASS,
tests/evidence/runtime-tests-2026-09-29T05-02-32-401Z.json.
Fixture models do not prove real-model semantic accuracy. Actual NAS read-only scan
passed on WSL Node 22.22.0 with Windows reader Node 24.13.0: 58 files, 292,237 bytes,
approximately 3.4 seconds. The helper version is separate from pinned Office
Node 22.22.0/npm 11.11.0/package 0.3.1.

Failure receipts remain: nested SQLite transaction fixed by setting initial pause
inside the existing store transaction; UI expectations updated for explicit code
enhancement; oversized fixture increased to exceed the new bounded limit.

Pending final focused rerun, managed UI application and native readback.
NAS control is NOT complete. All explicitly selected SSH keys were rejected.
After authentication, original-runtime observation/control still needs connection
and verification. Do not start duplicate bots, alter schedules or send messages.
Private paths/key references and native receipts remain ignored local evidence.
No remote push or public release in this task.
