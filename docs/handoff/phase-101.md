# Phase 101 — actual Work control and login recovery

## Completed

- RQ-838: lease-based Pack/Swarm/coding/intake observation; preserve stored history, mark stale execution unconfirmed. Native personal board: 12 Works preserved, 3 ghost running records now unconfirmed, zero live runs.
- RQ-839: local same-origin, revision-checked execution action. Read Packs use existing FamilyRuntime; an explicit Hermes choice binds the existing Work ID to ACP with model-usage acknowledgment. Project observation imports cannot be executed as duplicate bots. Legacy external-agent Swarm histories still require an orchestrator; do not claim an automatic worker loop.
- RQ-840: bounded/redacted Work event tail over dedicated SSE with timestamps/reconnect state, short board names, preserved instructions/drafts; tail sits in the control column.
- RQ-841: native file IO with fixture planner, fixture Hermes ACP and same-ID/tool/reply binding, dedup, lease expiry, project isolation, redaction, responsive Korean/English UI. Broader 76/76 and 37/37, final Work UI 26/26 including input integrity passed. Old Jev-fragment fixture needed the extracted body renderer; language fixture previously forced Korean on every reload. Earlier failures retained, not removed.
- RQ-842: login action prepares only the configured, already-provisioned VM and reuses its profile. No provisioning/reset, memory change, personal Chrome fallback, proxy change or credential copying. Native Ubuntu VM/CDP restored; Windows VNC viewer opened. Check is observation-only and refuses to create a blank tab. Failed open releases handoff. Temporary sign-in-limit text has its own state and does not release a worker retry.

## Native application

Applied a generated-build overlay to the existing local managed installation, preserving the same Control Center URL, all 12 Work IDs, host config and model settings. This is **not** a public release or a clean installed-source commit. Before another upgrade consult the private receipt `tests/evidence/phase101-local-apply.json`: it records UI PID, timestamp, backup and URL. The private script verifies process identity and no active Hermes turn before stopping only that UI. Original pre-change build/database backup: `~/.local/share/agent-office/local-backups/phase101-1790662597739` on the tested host. Later backups contain incremental candidates. No private bot was duplicated or message sent; no real model call occurred.

Existing login VM uses its saved 4096 MiB/2 CPU allocation; it was stopped before the explicit login repair and is now running. Profile retained. User showed X saying “temporarily limited your login”; this does not establish that VM use caused the limit. Official X lockout guidance describes temporary failed-attempt locks, often around an hour, not a guaranteed expiry for this incident. No further login submission, alternate-browser retry or bypass was attempted. During later observation no X tab remained; check now reports missing tab instead of opening a blank one. Do not claim X authentication passed.

## Remaining limits / next steps

- User account sign-in and live paid research are unverified. Wait for site restrictions to clear; do not keep trying credentials.
- NAS source import remains read-only until original-runtime authentication/control is established (Phase 99). No clone or schedule needed to adopt monitoring.
- Public merge/release and PR32 review concerns remain separate.
- Execution recovery uses Pack checkpoints; general Hermes execution depends on its installed model/tool configuration. No claim every family has been certified end-to-end.

## Read first / versions

`src/work/dispatch.ts`, `src/work/activity.ts`, `src/work/hermes.ts`, `src/swarm/login-vm.ts`, `src/swarm/browser-auth.ts`, `src/observability/work-ui.ts`, `tests/runtime-live-work-control.test.mjs`, Phase 99 handoff. Node 22.22.0 / npm 11.11.0 / package 0.3.1 unchanged. Preserve concurrent Phase 99 changes.
