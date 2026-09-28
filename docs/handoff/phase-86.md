# Phase 86 — Local workflow upgrade compatibility

## Scope

Resolve the Phase 85 failure to load the current installation's `workflows`
configuration while preserving private adapters outside the public repository.
Source: `/home/<user>/projects/agent-driver/release-v0.2.0`, branch
`release/v0.2.0`, existing unrelated edits preserved. No live installation,
client registration, profile or schedule is changed; no release is published.

## Implementation

- Strict host schema preserves bounded opaque `workflows` and an optional,
  explicitly host-registered `workflow_bridge`.
- Shared RuntimeApi/stdio MCP expose retained catalog/run/status, use the local
  adapter's own request/policy schema, verify code/policy pins, and never retry
  uncertain operations. Unregistered workflows are clearly connection-required.
- CLI compatibility plan/apply/rollback: exact-byte private backup, plan digest,
  configuration drift/redirect checks, exclusive lock, durable atomic replacement,
  idempotent apply/rollback. Only bridge metadata is added; no data or scheduling
  action occurs. The bridge remains trusted local code, not a security sandbox.
- New module versions require a new MCP process instead of reusing ESM cache.
- Documentation: `docs/local-workflow-compatibility.md` and both READMEs distinguish
  candidate source from installed/public code and describe boundaries.

## Verification

- Build PASS, Node 22.22.0, npm 11.11.0, TypeScript 7.0.2; package stays 0.2.0.
- Initial affected suite 49/49 PASS:
  `tests/evidence/runtime-tests-2026-09-28T10-43-07-778Z.json`.
- Real retained adapter through new stdio MCP on disposable config/SQLite backup:
  catalog and historical receipt readback PASS; repeat apply and exact rollback
  PASS; old installed MCP reconnect after rollback PASS. Four cases in
  `tests/evidence/phase86-workflow-compatibility.json`. Zero workflow executions,
  external sends, model calls or schedule changes. Copy relocation changed only
  the disposable project's profile binding; the source binding already matched.
- Initial acceptance FAIL preserved in
  `tests/evidence/phase86-workflow-compatibility-initial-failure.json`: the test
  moved data but not its copied profile binding, correctly triggering
  `PROJECT_BINDING_IMMUTABLE`. Product binding checks were not weakened.

- Quick suite without soak completed **971/972 PASS**, exit 1:
  `tests/evidence/runtime-tests-2026-09-28T10-47-40-454Z.json`. Its input fingerprint
  remained unchanged. The single failure was an older publication guard banning
  the generic `runtime_workflow_` prefix rather than private implementations.
- The guard now still bans the private implementation directory/static imports
  and private domain fields, while allowing the explicitly connected generic ABI.
  A final review also strengthened live connection checks to compare the whole
  host fingerprint, covering account/caller/data-directory changes, and clarified
  MCP descriptions so normal new Work does not select the legacy entry point.
- Final affected suite **56/56 PASS**, exit 0, unchanged inputs:
  `tests/evidence/runtime-tests-2026-09-28T11-01-46-114Z.json`. Includes the corrected
  publication check and three new host-scope drift checks. The full suite was not
  rerun after these final narrow changes; this is not a new full-green release gate.
- Final actual-copy acceptance repeated on the final build with four PASS cases.
  Selected Work/run/approval/Swarm rows were compared by count and content hash,
  not counts alone. Runtime and config remained unchanged in production.

All owned verification jobs completed. Supervisor logs/metadata, including
`phase86-quick-2026-09-28T10-47-36-134Z`,
`phase86-final-targeted-2026-09-28T11-01-45-619Z`, and
`phase86-native-final-2026-09-28T11-02-15-143Z`, are in
`/home/<user>/.local/state/agent-driver-audit/20260928-resume/`.

## Remaining boundaries

The live registration still runs `runtime-personal` (0.1.1 metadata). Compatibility
has been exercised on copies, not applied to production. Retained private runtime
scripts/dependencies must remain available. Only entry modules are pinned; this
is not a dependency audit. A changed host fingerprint must not mint new approval
authority. The CLI rolls back configuration, not arbitrary database migrations.

Windows native grant/approval UX and cross-host input ownership, plus the observed
53-instance MCP resource/lifecycle issue, remain separate release gates. Neo is
optional. Their status must not be changed to done by this compatibility work.

## Resume references

Read `src/integrations/workflow-compatibility.ts`,
`src/integrations/workflow-upgrade.ts`, `tests/runtime-workflow-compatibility.test.mjs`,
`docs/local-workflow-compatibility.md`. Private acceptance helper and logs reside
in the audit directory; no private policy or workflow implementation was copied
into public code. Owned acceptance clients were closed; disposable copies remain
for inspection, without a running service.
