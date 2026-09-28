# Browser prerequisites in the Control Center

Source candidate, Phase 88. This is not an announcement of a published installer update.

## Default path

Install Agent Driver → connect an agent → **Connections & settings → Local runtime**.
Playwright is the default. **Check Playwright connection** starts and closes a
dedicated headless Chromium, without attaching to user tabs. If it is unavailable,
**Download dedicated browser** invokes the bundled, pinned Playwright installer.
Missing OS libraries may still require the administrator steps in the official
[Playwright browser guide](https://playwright.dev/docs/browsers).
The normal Agent Driver installer also performs a Chromium launch smoke check.

Aside and Neo are optional. Neither is required to start MCP or to run a default
Playwright background task. Visiting settings does not launch an optional browser,
install software, request login, call a model, or change executor policy.

## Optional Aside / Neo

1. Open **Other browsers · optional**. Follow the official installation link on
   the computer where the browser will run.
2. For Aside, finish the browser's own first-run/account flow and install its CLI
   in **Settings → Developers**. The official developer guide also documents a
   signed Windows CLI installer. For Neo, start the browser and its local MCP
   endpoint. Existing configured endpoints are preserved.
3. Click **Check connection**. The adapter connects to the actual browser and
   lists its tabs without returning titles, URLs, cookies or account details.
   A CLI executable or a responding MCP process alone is not enough.
4. After a successful check, approve use of that browser's screen/profile and
   click **Register connection**. Registration preserves unrelated host policy,
   keeps a private exact configuration backup, retains existing VM targets and
   supplies default owned-headless Playwright if absent. Stale page revisions
   cannot overwrite another settings change. A check expires after five minutes.
5. Reconnect MCP before using the new executor. The shared service loads the
   current host policy for each new protocol session; direct stdio clients must
   reconnect/restart their server. Existing runtimes retain their immutable
   configuration and may stop at `CONFIG_CHANGED`. This is not hot migration of
   active work. Reopen the Control Center process to load its new host policy too.

The current adapter uses **`aside mcp --host local`**, not Aside's agent `exec`
command. Agent Office's model selection is separate from Aside's built-in model
subscription. We do not promise that a particular Aside plan grants free or
unlimited access. Credentials and subscriptions remain under Aside's control.

The installed CLI's guide also supports remote hosts after `aside login` and
enabling remote control on the destination. **Agent Office's current Aside adapter
does not expose that remote transport.** Under WSL, a discovered Windows Aside
CLI controls the Windows foreground browser, not a Linux/VM browser.

## Fallback and login boundaries

- Background work uses its default Playwright target without Aside/Neo.
- A connection failure can select another registered executor **in the same
  requested environment**. A foreground browser is never silently replaced by
  a background VM (or the reverse).
- Registering Aside does not give Playwright its logged-in sessions. If a task
  specifically needs a browser profile and no eligible executor remains, request
  that connection instead of pretending the task ran elsewhere.
- Site login is requested when a Work needs it. Browser-account sign-in, API/model
  authentication, site login and execution permission are different steps.
- Neo/Aside currently support bounded browser reads, not approval-bound form
  writes or guest transports. Connection readiness is not task certification.

AI CLI install/login/MCP registration already live in the **Agents** step; model
API setup and optional Jev live in their existing steps. Specialized environments
have additional prerequisites: [Ubuntu VM setup](owned-ubuntu-browser-vm.md),
[Windows executor](owned-windows-executor.md), and
[browser target contracts](browser-executor-routing.md). Their full first-install
desktop/guest setup is not completed by this browser panel.

## Official sources checked 2026-09-28

- [Aside getting started](https://docs.aside.com/help/get-started): Aside account,
  installed browser components and first-run sign-in. This page mentions macOS;
  the developer page separately documents Windows CLI setup.
- [Aside CLI/MCP/REPL](https://docs.aside.com/help/developers): installation,
  account sign-in, Settings → Developers and deterministic browser control.
- Installed Aside CLI `1.26.916.1741`, `guide` / `guide repl`: explicit local and
  remote host modes. No remote connection or paid agent invocation was attempted.

Checks and downloads record observed start/result/duration in the existing setup
tail. Raw process output, secrets and site account content are not displayed.
