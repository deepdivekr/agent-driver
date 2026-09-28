# Browser executor routing — Phase 85 (unreleased)

Work specifies the execution environment; the runtime selects an eligible browser
within it. Playwright, BrowserOS Neo and Aside are separate engines. A Windows
browser reached from WSL is still **Windows foreground**, not an Ubuntu VM.

## Implemented scope

- Shared `probe / open / navigate / observe / extract / scroll / close` contract.
- Real Playwright persistent-context/CDP, Neo HTTP MCP and Aside stdio MCP adapters.
- `research.search`, `portal.collect` and browser-backed research workers use the
  shared router when the host registers `browser_executors`. Existing installations
  without that section retain their current execution path.
- `runtime_browser_executors` lists registered engines. `probe: true` checks their
  connections without opening a task page. Ready is not a task-success certificate.
- Work's explicit environment takes precedence over a Pack or worker proposal.
  Conflicting environments are rejected; an LLM cannot grant foreground access.
- Each worker gets its own owned tab. Headless workers share a Chromium process
  but have separate browser contexts/storage. Neo/Aside tabs use the connected
  browser's profile, so **their login storage is not isolated per worker**.
- No previews, screenshots or video streams are introduced.

This route is **read-only**. It does not yet replace the approved Playwright form
write protocol. Neo/Aside form filling, approval-bound submission and arbitrary
browser-chrome interactions are not advertised as supported. A Work requesting
an unsupported writer gets an explicit error, not a silent Playwright substitution.

## Selection and Jev

1. Code filters registered host, platform, environment and supported operations.
2. One eligible engine, an explicit engine preference or a previously successful
   exact binding uses the code path. A remembered choice is still probed and the
   destination is observed afresh.
3. For an ambiguous choice, available candidates are probed before model selection.
   Existing Pack/global approval settings and individual Work OFF remain effective.
4. Optional Jev selects an offered candidate or `unknown`; the existing LLM can
   review a low-confidence/no-match result. If neither supplies a useful preference,
   registered host priority remains the deterministic fallback.
5. The shared Decision Plane records its answer, probabilities, timing and model
   usage when reported. Calibration heads are separated by execution environment.

The new selection profiles are **provisional**. No measured Neo/Aside performance
calibration has been promoted. Connection tests are not labeled model-quality
evaluations. Shadow calls honor the existing explicit shadow setting.

## Handoff and restart

Connection/session failure can switch to another registered engine in the **same
environment**. There are at most two mid-run switches. Authentication, CAPTCHA,
account mismatch, unknown dialogs, ordinary action errors and user pause are not
reasons to try a different account or bypass a gate.

SQLite stores the approved entry/current URL, configuration/request binding,
completed step names, observation digest and external-effect uncertainty flag.
After process restart or transfer, the destination navigates and observes again.
Old DOM references, cookies, passwords and browser session handles are never
transferred. Completed Pack source outputs retain their existing checkpoints.
Scroll offsets and an open form's full UI state are **not** reconstructed by this
read-only contract. An uncertain external effect requires reconciliation and
cannot be replayed automatically.

The event journal records selected engine, environment, failure/handoff reason,
decision event reference and elapsed time. It does not store raw page text or login
secrets. Remembered successful route bindings expire after 24 hours and failures
invalidate them.

## Host configuration

This is an optional fragment of the existing host JSON, not a complete config:

```json
{
  "browser_executors": {
    "targets": [
      {"id":"headless","engine":"playwright","environment":"owned_headless","platform":"linux","profile_ref":"research","priority":50},
      {"id":"neo","engine":"neo","environment":"host_foreground","platform":"win32","profile_ref":"connected-desktop","endpoint":"http://127.0.0.1:9010/mcp","priority":80},
      {"id":"aside","engine":"aside","environment":"host_foreground","platform":"win32","profile_ref":"connected-desktop","executable":"/mnt/c/Users/YOUR_USER/AppData/Local/Aside/CLI/current/aside.exe","priority":70}
    ]
  }
}
```

The example is for WSL with explicitly registered Windows browsers. Replace paths
and the Neo port with the actual installation. Native Windows uses an absolute
Windows executable path. `profile_ref` names a connection; it does not switch a
Neo/Aside profile or import another browser's login. Host registration authorizes
eligibility; it does not certify readiness or grant every Work foreground access.

For an Ubuntu VM use a Playwright target with `environment: "ubuntu_vm"` and the
existing `swarm.visual.owned_vm` configuration. The existing owned-VM manifest and
loopback-forward checks remain mandatory. A missing VM never falls back to the
host browser. Neo/Aside guest transports and Windows guest browser control remain
unverified and are refused rather than treated as host connections.

An agent can propose `browser: {"environment":"host_foreground"}` on a Work/Pack
or a research worker after the user's request calls for that environment. An
optional `preferred_engine` selects its initial preference, not an environment
override. The connection catalogue is included in Work definition and Pack design.

## Validation

- Contract tests cover optional decision selection, live-candidate pruning,
  checkpoint binding, uncertain effects, no authentication fallback and Neo MCP
  session/owned-tab behavior using a fake MCP server.
- Native tests use actual Chromium for Pack collection and parallel Swarm storage
  isolation; the planner/model responses in those tests are fixtures.
- Acceptance scripts `scripts/browser-executor-acceptance.mjs` and
  `scripts/browser-vm-acceptance.mjs` exercise real available connections and a
  separate clean Ubuntu VM. They never submit a form or use private-site data.
- Exact local environment results and limits are recorded in
  [Phase 85 handoff](handoff/phase-85.md). No public release or personal-runtime
  upgrade is implied by these source-tree tests.
