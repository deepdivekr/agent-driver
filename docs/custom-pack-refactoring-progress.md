# 커스텀 Pack 리팩토링 진행 기록

Authority: custom-pack-refactoring-plan.md and ../AGENTS.md.
Baseline: 0b11f1850a2afa846f191ce356aa4f486284b41f.
Branch: refactor/custom-pack-reliability.

## Current checkpoint

- R0: plan and resumption instructions written; implementation authorized.
- R1: read/write contracts, numeric normalization and Work preflight implemented.
- R2: typed artifact/watch checks and mandatory original-goal gate implemented.
- R3: safe-read repair, receipt identity and proved Swarm transitions implemented;
  final focused execution/control checks 117/117 PASS.
- R4: immutable verified registry, fresh manual cycles and automatic fresh-child
  cycles integrated through the existing WorkSchedules.
- Final coordinated TypeScript build PASS. Integration7, registry8, custom
  schedule7, legacy schedule6, native output9, native watch5, scheduled guard9:
  all 51 focused tests passed on the final product build. One new CSV fixture
  assertion was corrected to use the existing parser before the final registry run.
- Final review fixes passed: stable-ID receipts, inferred ownership, timer scope,
  independent schedule marker, lost-child fences, isolated reconciliation,
  same-run failure recovery and single-recipe publication. All writers frozen.
- R5: first frozen quick suite completed with input integrity PASS:
  1832/1846 PASS, 13 FAIL, 1 NOT_RUN (totals include the integrity case).
  All 13 failures reproduced on baseline 0b11f18 in the same environment.
  Native resource11 require a systemd user manager and delegated cgroup;
  verifier-parent1 requires the absent kernel proc children interface;
  settings UI1 depends on the ambient Codex model catalog.
- R5 follow-up only changes test harness prerequisites and the UI fixture model
  catalog. Product code remains frozen. Missing actual host features will be
  reported BLOCKED_ENV, with all supported-host assertions retained. A new full
  receipt will follow; the first raw failed receipt is not relabeled as PASS.
- Test harness fixes focused: UI desktop/mobile1/1 PASS; native files/resources
  18 PASS, 0 FAIL, 12 explicit BLOCKED_ENV. All inputs frozen for the final
  quick suite. Product source/dist remained unchanged throughout this follow-up.
- Root owns Work result formats, preflight integration, plan/progress, final tests.
- Root output/preflight/results focused tests: 70/70 PASS.
- R1 final focused source/preflight/timer checks: 18/18 PASS.
- No real private Phase112 case was rerun. Full frozen suite not yet run.

## File ownership

- Pack contracts/sources/local records/runtime/native certificate: pack_contract_audit.
- Work contracts/completion/supervisor/native-check module: verification_audit.
- Work client executor and Swarm runtime: control_audit.
- Custom Pack registry module/tests: pack_version_audit, integration coordinated with root.
- Runtime API/catalog/MCP and new Work repeat binding: custom_pack_integration.
- Existing schedule.ts and custom schedule binding module: pack_version_audit.
- Supervisor due-cycle dispatch and native watch checks: verification_audit.
- Work execution-tools, docs/AGENTS, build/test coordination: root.

Build/dist is shared. Request the root to rebuild after source edits settle.
Run frozen full tests only after all writers have stopped.

## Next action after compaction

Read the complete plan and AGENTS.md, inspect git status, retrieve agent status,
and collect the final frozen quick receipt; harness changes and focused checks
are complete. All writers are stopped.
R0–R4 are implemented; first frozen inputs stayed unchanged and all failures
matched baseline. Do not weaken resource/process oracles or alter product gates
to make this environment appear capable of verification it cannot perform.
Record outcomes and remaining real-user limitations before commit/push.

## Evidence log

- Source inspection: latest public remote head 0b11f18 confirmed.
- Historical acceptance only: Phase112 handoff reports quick1776 PASS but
  real-user matrix PASS0/FAIL23/NOT_RUN1. These are not new results from this refactor.
- Environment: downloaded task-local Node22.22.0 and npm11.11.0; npm ci succeeded.
  Chromium153 installed and native launch passed. No package manifest change.
- Initial coordinated TypeScript builds passed. Dist is ignored/generated.
- Root review caught canonical-request mismatch in proposed cycle redirect;
  integration must preserve checkpoint invocation ID = persisted Pack request ID.
- Public HTTP smoke: USGS live hourly CSV fetched twice, six rows per observation,
  explicit magnitude normalization, exact JSON output/native proof and independent
  cycle IDs PASS. Same-cycle dedup PASS; model calls0/external writes0.
  This is technical live-source evidence, not private Work-goal acceptance.
- Latest live public rerun: 2026-09-30T21:13:03Z, USGS nine rows in each actual
  observation, distinct timestamps/run IDs/artifacts, exact numeric JSON/native
  proof and same-cycle dedup PASS. It remains independent of private acceptance.
- Final review identified and closed three metadata-loss paths: parent legacy
  fallback, skipped live parent fence and a damaged child interrupting the due scan.
  Recovery regression uses actual schema-failure → explicit same-run retry →
  independently verified success → next fresh cycle. Durable mapping-loss restart
  and held-model metadata loss tests prove no replacement dispatch/output.
- Registry latest focused6/6 PASS; latest R3 temporary isolated behavioral61/61
  PASS (not a replacement for final coordinated TypeScript build/frozen suite).
