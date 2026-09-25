<div align="center">

# Agent Office

**A local MCP runtime that gives your AI agents a dedicated browser, CLI, and file workspace, with durable run records, approvals, and crash recovery.**

**English** · [한국어](README.ko.md)

<sub>Repository and CLI name: <code>agent-driver</code></sub>

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-v0.1.0-informational)
![Platform](https://img.shields.io/badge/platform-Ubuntu%2024.04%20%7C%20WSL2-orange)
![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2)

</div>

Connect Agent Office to **Claude Code, Codex, Cursor, OpenCode, or Hermes** and let them research the web, fill forms, collect files, and drive coding work. Browser work runs in a separate browser, not the one you're using. Every step is written to local SQLite so an interrupted task can resume where it stopped. Nothing touches your own mouse or open tabs.

> **v0.1.0 support scope:** Ubuntu 24.04 x86_64, and Windows 11 with WSL2 Ubuntu 24.04. Per-feature evidence and the limits of experimental features are listed in the [release readiness record](docs/release-readiness-v0.1.0.md).

> **Release note:** The Agent Office screens shown below are from this branch. The one-line installer is pinned to the existing `v0.1.0` tag and does not yet include these UI changes. They need a separately validated release tag before the screenshots match a fresh stable install.

---

## Contents

- [Quick start](#quick-start)
- [Control Center walkthrough](#control-center-walkthrough)
- [What's included](#whats-included)
- [How is this different from Meta Muse and Grok Bot?](#how-is-this-different-from-meta-muse-and-grok-bot)
- [How it works](#how-it-works)
- [Scope and limits](#scope-and-limits)
- [Development](#development) · [License](#license)

---

## Quick start

### Option A: ask your agent

Paste this into Claude Code, Codex, or another agent:

> Install github.com/deepdivekr/agent-driver and connect it over MCP. From now on, use Agent Office for browser and file work.

### Option B: one command

Run this once in an Ubuntu or WSL2 Ubuntu terminal:

```bash
bash -o pipefail -c 'curl -fsSL https://raw.githubusercontent.com/deepdivekr/agent-driver/v0.1.0/install.sh | bash'
```

Here is a real run of that command on a clean Ubuntu 24.04 x86_64 machine. It finished in **16 seconds** with exit code 0:

![Terminal: running the one-line installer on Ubuntu 24.04, from Node.js setup to "control_center_ready"](docs/assets/readme/terminal-install.png)

<sub>Captured 2026-09-24. Two edits to the output: the 14-line git "detached HEAD" notice is collapsed, and the capability token in the Control Center URL is masked. The capture machine's network blocked the Playwright CDN, so it pointed `PLAYWRIGHT_BROWSERS_PATH` at a Chromium it already had. On a normal machine, the `전용 Chromium 준비` (prepare dedicated Chromium) step downloads Chromium, so it takes longer.</sub>

**What the installer does**

| Step | Details |
|---|---|
| Node.js **22.22.0** | Downloads the official build and verifies its SHA-256 checksum. Your system Node is left alone. |
| npm **11.11.0**, dependencies, build | Uses the pinned versions from `package-lock.json`. |
| Dedicated Playwright Chromium | Launches Chromium once to confirm it works. If Ubuntu/WSL system libraries are missing, the installer stops and prints the command to fix it. |
| `agent-driver` command | Installed to `~/.local/bin/agent-driver`. |
| Control Center | Starts on `127.0.0.1` with a one-time capability URL and opens in your browser when possible. |

The installer never runs `sudo` or installs system packages. It won't overwrite unmanaged folders, symlinks, or modified installs. To review the script before running it, download [install.sh](install.sh) first.

### Verify the connection

After you register the MCP server from the Control Center (step 1 below), your client sees it right away:

![Terminal: `claude mcp list` shows agent-driver as Connected; `agent-driver connection status` returns connected](docs/assets/readme/terminal-verify.png)

### Manual MCP registration

For clients that the Control Center can't register automatically:

```text
agent-driver mcp
```

```json
{
  "mcpServers": {
    "agent-driver": {
      "command": "agent-driver",
      "args": ["mcp"]
    }
  }
}
```

This config works when the client and the server run in the same Ubuntu/WSL environment. For a **Windows** app, use the `wsl.exe --distribution ... --exec ... mcp` command that the Control Center shows. The Windows app then starts the server inside WSL. This is not a native Windows install.

[First-run guide](docs/first-run.md) · [MCP setup and tools](docs/agent-interface.md) · [Hermes and Telegram](docs/hermes-telegram-runtime.md)

---

## Control Center walkthrough

> Screenshot note: the walkthrough captures predate the locally bundled Pretendard font and the switch from left-edge accents to full borders. Current source applies those styling updates; the setup flow is unchanged.

`agent-driver connect` opens the **Agent Office Control Center** (the installer runs it for you). It uses the same visual language as the agent-driver run trace: a dark ground, mono-first labels, and one color per decision path. **Amber** is Jev or the step running now, **lilac** is the LLM, **blue** is plain code, **rose** is a person, and **green** means verified. The UI is **English by default**. The flag button in the top-right switches to Korean, and each browser remembers its choice. The page uses one locally bundled Pretendard variable font, with no remote font CDN, UI framework, or screen previews. Selected controls use borders and background color instead of left-edge accent bars. Longer explanations sit behind a **?** button.

> These screenshots come from the **real Control Center** on this branch, captured in order on the Ubuntu 24.04 machine used for the terminal run above. The task shown was actually defined by the logged-in Claude Code subscription.

### Setup, step 1 of 4: agents

The flow diagram at the top shows where the Control Center sits: **mcp client → agent-office mcp → LOCAL**, with no cloud relay. Each client gets one row with a status badge:

- **green:** ready
- **rose:** needs you
- **dashed gray:** not installed

Each row offers one next action. A missing client gets its **official installer** and a link to the vendor's guide. On this machine Claude Code was already logged in, so a single click on **Register MCP in Claude Code** was enough.

| Before | After one click |
|---|---|
| ![Agents step: flow diagram, Claude Code "MCP not registered" with a highlighted "Register MCP in Claude Code" button; other clients "Not installed"](docs/assets/readme/cc-01-agents.png) | ![Agents step after registration: Claude Code "MCP registered", the Agents tab shows a check mark](docs/assets/readme/cc-02-agents-registered.png) |

Finished steps get a ✓ in the tab row. The collapsed **Setup log** at the bottom shows its latest line, for example `Claude Code MCP registered · 0.4s`. It stores no raw terminal output or credentials.

### Step 2 of 4: local runtime

You approve the dedicated work folder and local execution once. The runtime is **non-interfering**: it never takes over your mouse or your open Chrome tabs.

![Local runtime step: "Dedicated work environment" with an "Approval needed" badge and the "Approve local runtime" button](docs/assets/readme/cc-03-runtime.png)

### Step 3 of 4: AI

Pick a subscription you're already logged in to, or an API key. Client status shows as compact chips. Here Claude Code is **Connected**, and its live model list (Sonnet, Opus, Haiku) has loaded.

![AI step, subscription: Claude Code chip "Connected", Claude Code model Sonnet (latest), and the checked consent "Allow sending work content to the selected AI to define and plan it"](docs/assets/readme/cc-04-ai-subscription.png)

**Sending task text to an AI takes one explicit consent.** Saving the checkbox writes it to your local `~/.agent-driver/runtime-config.json`:

```json
{
  "schema_version": 1,
  "project_id": "agent-driver-local",
  "...": "other host settings stay unchanged",
  "work": { "model_data_approved": true, "approved_at": "2026-09-24T21:13:56.611Z" }
}
```

The value is re-read on every call, so a running MCP server picks up a change without a restart. It isn't part of the config fingerprint, so toggling it never invalidates a bound run. With it off, one-line tasks are still saved, but they stop at **AI connection needed** and show an **Allow AI and retry** button.

**API mode offers a small, fast model when one is available; it preserves your saved choice.** Switching providers reloads that provider's catalog.

| Provider | Initial suggestion (before live discovery) |
|---|---|
| OpenAI | `gpt-6-luna` |
| Anthropic | `claude-haiku-4-5` |
| OpenRouter | `openai/gpt-6-luna` |
| OpenAI-compatible | Choose a model from your server or enter its ID |

Refresh updates the catalog, not a deliberately selected model. If the built-in initial suggestion is unavailable, a listed fast-tier model can replace it. If no suitable suggestion is available, choose a model explicitly; the first arbitrary model is not selected. A key is saved only after a live connection check passes. Agent Office never switches a subscription to paid API use on its own. [Handoff scope](docs/client-handoff.md)

| API mode: Anthropic → `claude-haiku-4-5` | Explanations open in a modal |
|---|---|
| ![AI step, API mode: provider Anthropic, model claude-haiku-4-5, API key field, billing and fallback checkboxes](docs/assets/readme/cc-05-ai-api.png) | ![Help modal explaining what the AI consent sends and where it's stored](docs/assets/readme/cc-07-help-modal.png) |

### Step 4 of 4: Jev (optional)

Jev handles short, repeated decisions, such as which element to click or whether a result looks right. With no key, the LLM makes those decisions.

![Jev step with mode "Auto"; all four tabs show check marks](docs/assets/readme/cc-06-jev.png)

### ① Work: board and list

After **Done** you land on **Work**. It shows every task, grouped the way the run trace colors them:

- **Needs you** (rose)
- **Running** (amber)
- **Queued** (gray)
- **Closed work** (completed runs or deliberately stopped work; each item retains its own status)

The sidebar keeps a count for each group. Type a task in one line and press **Submit**. Tick **Guided** to answer the questions that change the result before anything runs. The board shows cards with the pack family and Work ID. **List** switches to compact rows, and search filters as you type. A completed run is not, by itself, verification that every Work completion condition was met.

| Board | List |
|---|---|
| ![Board: a research.search card "Weekly AI agent news roundup table", badge "Ready", in the Queued column](docs/assets/readme/cc-08-board.png) | ![List view: the same task as a compact row under Queued](docs/assets/readme/cc-09-list.png) |

### ② Work detail: the run trace

Opening a task shows the same layout as the run-trace storyboard:

- the state badge, Work ID, and (when one exists) the current Run ID
- the request line with a blinking cursor
- the selected pack pill with its effect scope (`research.search · read-only`)

In this example, Claude Code defined a one-line request into a titled task with four completion checks. The left column is the **Run trace**: one node per stage with its objective and owner. Verified stages turn amber, the running stage gets a halo, and a stage waiting on a person turns rose. The pictured stages are all queued; this capture demonstrates the layout, not completed execution or verification. It predates the correction that labels Work and Run IDs separately.

![Earlier Work detail preview: request line, research.search · read-only, four queued completion-check stages, and the Human control panel](docs/assets/readme/cc-10-work-detail.png)

### ③ Human control: pause or redirect a stage

The rose **Human control** panel is where a person steps in. From there you can:

- pause the next assignment
- click a stage that hasn't started and give it a new instruction (**Apply to next assignment**)
- answer the questions from a guided task
- retry a definition
- attach an existing Codex session and send it one instruction at a time
- turn Jev on for this task (with cost consent)
- see run history and client handoffs

Already-verified results are never rewritten. A read-only run path that can't be safely changed midway says so, rather than pretending to stop.

### Import existing work

**Import** moves automations you built elsewhere into Agent Office:

| Route | What it does |
|---|---|
| **Another AI's automation** | Paste the provided prompt into your current AI, then paste its JSON reply back. It's checked as an **unverified draft**: secrets are rejected and each claim links to evidence. Your existing automation is not changed. |
| **Workflow project** | Reads part of a local or WSL project path, read-only. No code runs. |
| **Improve an existing bot** | Starts from an existing bot and drafts improvements. |

![Import: route buttons, the copyable migration prompt and the JSON paste box](docs/assets/readme/cc-11-import.png)

### Site login, only when needed

Site logins aren't part of setup. When a task reaches a URL that needs a login, only that worker pauses, and the site appears here. The image below shows the empty state only; it does not demonstrate a login or handoff. Its initial loading notice was fixed after this capture.

![Earlier site-login empty state: no site needs a login; no login flow is shown](docs/assets/readme/cc-12-site-login.png)

<details>
<summary>Korean UI and mobile layout</summary>

| Korean (flag toggle) | Mobile, 390 px |
|---|---|
| ![The same board in Korean after pressing the flag button](docs/assets/readme/cc-14-korean.png) | ![Mobile: the sidebar becomes a top nav; intake and the task list stack](docs/assets/readme/cc-13-mobile.png) |

</details>

---

## What's included

### Task Packs

A Task Pack bundles a task's inputs, execution order, and how its result is verified. v0.1.0 ships nine pack families:

| Task | Example | Pack family |
|---|---|---|
| Search and compare | Research several sources and summarize them with evidence links | `research.search` |
| Look up and download | Collect date-ranged data from a logged-in portal | `portal.collect` |
| Fill forms | Draft an application and review it before submitting | `form.draft-submit` |
| Update records | Read a record and apply approved changes | `record.update` |
| Choose candidates | Compare products or options and add one to a cart | `choose.stage` |
| Triage an inbox | Classify messages and draft replies | `inbox.triage` |
| Watch for changes | Re-check prices or statuses and record changes | `monitor.watch` |
| Process files | Filter, convert, and merge CSV or JSON | `file.pipeline` |
| Coding work | Codex implements, Claude reviews, and docs are handed off in a local Git project. No GitHub required. | `coding.orchestrate` (experimental) |

Each site needs its own login and run settings. A verified workflow is reused on later runs. Automatic adaptation to new sites is experimental. [Pack catalog and support scope](docs/pack-catalog.md)

### MCP tools (74 exposed by `agent-driver mcp`)

Counted from a live `tools/list` call against the install above:

| Area | Tools | What your agent can do |
|---|---|---|
| **Work** | `runtime_work_*` (10) | Take a one-line task, define it, answer clarifying questions, pause it, and import work from other AIs or projects |
| **Packs** | `runtime_pack_*` (8) | Plan a task in natural language, run it, execute an approved snapshot once, run watches, and read events |
| **Swarm** | `runtime_swarm_*` (10) | Plan parallel workers, lease them, give each an assigned browser, report activity, and recover |
| **Coding** | `runtime_coding_*` (13) | Plan and run Codex/Claude stages in a registered Git project, attach to an existing Codex session, and reconcile after an interruption |
| **Terminal** | `runtime_terminal_*` (11) | Durable CLI sessions: start, submit, resume, interrupt, read output, hand off, verify, and reconcile files |
| **Tasks and recovery** | `runtime_task_*`, `runtime_recovery_*` (7) | Take in a task, start, cancel, resume, and prepare recovery with a generation check |
| **Ops** | health, storage, events, artifacts, capabilities, decision, channel, activity (13) | Check health and storage, prune, read and ack events, list artifacts, report activity, and check Decision Plane status |

`runtime_browser_session_open` and `runtime_browser_session_status` are placeholders in v0.1.0. They return a typed "not implemented" error.

### Coding work

Ask your connected agent something like *"Continue the last interrupted task in this project."* Agent Office uses only registered Git projects and logged-in CLIs, and it keeps a record of every stage. Writes and README-only local commits require per-project permission. It never pushes or deploys. [Setup and limits](docs/coding-orchestration.md)

### Recorded runs

- **Pack families, end to end over stdio MCP:** public news collection → local search and CSV → Jev classification → reattaching a watch → a real contact form drafted but **not** submitted. Six paths were verified, in 6.743 s on the source tree and 10.959 s on the public alpha.18 copy. These are separate runs, not a speed comparison. [Step-by-step results](docs/evaluation-live-alpha-18.md)
- **Swarm:** re-observed 6 sites, recovered from a timeout in the synthesis stage, and finished a research memo in 3 min 43.8 s. [Failures, recovery, per-worker time and tokens](docs/evaluation-swarm-alpha-18.md)

---

## How is this different from Meta Muse and Grok Bot?

All three give an AI agent "a computer." What differs is **who owns the computer** and **where you talk to the agent**.

- **[Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)** puts an agent and your data in a per-person *Muse Secure VM*. You assign work through the Muse app or WhatsApp, and it keeps running after you close the app. It remembers your preferences and asks for approval before emailing or buying. It also handles agent checkout with payment protection.
- **[Grok Bot](https://x.ai/news/introducing-grok-bot)** gives each bot its own cloud computer that works around the clock across the web, apps, and your inbox. You message it from desktop or phone. It supports teams of bots, with a lead bot coordinating and bots sharing thread context.
- **Agent Office** is the **execution layer only**, and it runs on **your** machine. It has no chat app of its own. You keep using Claude Code, Codex, Cursor, OpenCode, or Hermes/Telegram, and they all share the same runtime over MCP.

| | Meta Muse / Grok Bot | **Agent Office** |
|---|---|---|
| What it is | Finished product: provider app plus cloud computer | Local MCP runtime you install |
| Where you give tasks | The product's own chat, mobile app, or messenger | Any MCP client (Claude Code, Codex, Cursor, OpenCode, Hermes/Telegram) plus the local Control Center |
| The computer | Always-on cloud VM per person or per bot, run by the provider | Your Linux/WSL host with a dedicated browser; an Ubuntu VM is optional |
| Keeps running when your PC is off | Yes, in the provider's cloud | **No.** The host must be on. Cloud workers aren't included yet. |
| Memory and personalization | Built in: conversations, preferences, goals | Conversation memory belongs to your client. The runtime keeps tasks, evidence, and recovery state. |
| Multiple agents | Product-managed bot teams | Swarm handles worker leases, parallel dispatch, and activity. Your client spawns the sub-agents. |
| How it acts | Mostly screen control, which covers apps with no API | Playwright browser, CLI, and file executors. A Decision Plane picks LLM, Jev, or plain code for each decision. |
| Approvals | Product approval flow for email, purchases, and similar actions | Per-effect approval, leases, re-checks, and duplicate-effect prevention |
| Payments | Muse includes agent checkout | **Out of scope:** no payment, ordering, or booking confirmation |
| Data boundary | Depends on the provider's security and privacy model | Local storage with a dedicated profile or VM. You own the runtime and its data. |
| Switching clients | Locked to the product | Same tasks, packs, and history across every connected client |
| License | Proprietary service | Apache-2.0 open source |

**Choose Muse or Grok Bot** if you want an always-on assistant with its own chat, memory, and notifications that someone else runs.
**Choose Agent Office** if you already work in coding agents or CLIs and want them to share one **local, recoverable, auditable** execution layer that you own.

Sources and full notes: [product comparison (2026-09-23)](docs/product-comparison-2026-09-23.md)

---

## How it works

```
 Claude Code / Codex / Cursor / OpenCode / Hermes
                    │  MCP (stdio)
                    ▼
            agent-driver mcp  ──►  Control Center (127.0.0.1)
                    │
   ┌────────────────┼──────────────────┐
   ▼                ▼                  ▼
 Dedicated       CLI sessions      Allowed file
 Chromium /      (PTY)             paths
 optional VM
                    │
                    ▼
     Local SQLite: tasks · evidence · recovery
```

Your client starts `agent-driver mcp` as a local process and sends it work. Agent Office runs the work in the dedicated browser, CLI sessions, or allowed file paths. It then **reads the result back to check it**, and saves state to local SQLite for recovery.

| Role | Responsible for |
|---|---|
| **LLM** | Understanding the request, planning, and handling situations it hasn't seen before |
| **Jev** (optional) | Screen state, click targets, result quality, and the next step |
| **Code** | Clicking, typing, file processing, approval checks, and verifying results |

Jev takes the current state and its candidates, and returns a choice with a probability. A choice is used only if it passes that decision type's validation threshold. If Jev is unsure, the LLM reviews the decision. Observations sent to a model go to that provider's API.

**Swarm mode:** the LLM splits the work and your client runs several sub-agents in parallel. Agent Office handles assignment, progress, and validation. Your client must support sub-agents.

[Swarm mode](docs/swarm-mode.md) · [Jev decisions and validation](docs/decision-plane.md) · [Evaluation summary](docs/evaluation-summary.md) · [Control Center](docs/control-center.md)

---

## Scope and limits

- **Supported:** Ubuntu 24.04 x86_64, and Windows 11 with WSL2 Ubuntu 24.04. Native Windows, macOS, and desktop-app control aren't supported.
- **Browser:** Playwright Chromium. The optional Ubuntu VM needs KVM/QEMU, and you log in to sites separately inside the VM.
- **External changes:** form submissions and record updates need approval from a person who has reviewed the change.
- **Hard limits:** product tasks stop at the cart and messages stop at a draft. Payment, booking confirmation, ordering, membership sign-up, sending email, and deletion are out of scope.
- **Isolation:** the dedicated browser and VM keep work separate from your own browsing. They haven't been validated as a security sandbox for malicious code.
- **Personal accounts:** you can use a dedicated browser profile if you need to. You decide how each site is accessed and under which terms. Agent Office doesn't force any particular API.
- **Control Center:** English by default, Korean with the flag button. It shows only work that has been reported to Agent Office. It doesn't watch what your clients do on their own.

[Ubuntu VM setup](docs/owned-ubuntu-browser-vm.md) · [CLI support matrix](docs/cli-adapter-matrix.md) · [Recovery procedure](docs/supervisor-recovery.md)

---

## Development

Run from the repository root in an Ubuntu or WSL terminal:

```bash
npm ci
npm run test:runtime
```

`test:runtime` is the quick regression suite and doesn't include long soak tests. Run the optional suites explicitly:

```bash
# long soak only
npm run build && node scripts/runtime/run-tests.mjs soak
# full suite including soak
npm run build && node scripts/runtime/run-tests.mjs full
```

Test results record whether each check ran against a real environment or a test environment. For the design and detailed contracts, see the [developer docs](docs/control-plane-design-v0.7.md).

## License

[Apache License 2.0](LICENSE). You may modify, redistribute, and use it commercially under its terms. External dependencies keep their own licenses. [Licensing scope](docs/licensing.md) · [Third-party notices](THIRD_PARTY_NOTICES.md)
