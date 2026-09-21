# Agent Driver

**A local control plane that lets Hermes and other AI agents use a dedicated browser and coding tools without taking over your foreground desktop.**

Agent Driver sits between an orchestrating agent (Codex, Claude Code, Hermes, or any MCP client) and the computer it is allowed to use. A user starts with one natural-language request; the runtime turns a successful workflow into a reusable Task Pack, selects deterministic code, TypeSafe/Jev, or an LLM at each decision point, and keeps execution, approval, recovery, and evidence in one place.

> Status: experimental public alpha. The runtime, MCP surface, eight Pack families, durable recovery, owned-browser fixtures, and Linux CLI paths are implemented and tested. Arbitrary-site auto-adaptation, native Windows UIA execution, OS-level always-on service setup, and live-account coverage are not complete.

## Why

Browser agents are capable but brittle: UI state changes, popups appear, authentication pauses the flow, a response can disappear after an external effect, and the agent can steal the user's active screen. Agent Driver provides:

- an agent-owned browser or optional personal VM instead of the user's active desktop;
- durable SQLite state, leases, idempotency, restart recovery, and independent readback;
- task-bound single-use approval before external writes;
- fast typed judgments with TypeSafe/Jev and LLM fallback for ambiguous states;
- reusable Task Packs learned from a first successful run;
- one MCP command for every compatible client: `agent-driver mcp`.

## Quick start

Requirements: Node.js `22.22.0`, npm `11.11.0`, and a supported Linux/WSL environment. Windows desktop automation currently exposes contracts only; it is not a native Windows executor yet.

```bash
git clone https://github.com/deepdivekr/agent-driver.git
cd agent-driver
npm ci
npm run build
npm test
npm link
agent-driver connect
```

`agent-driver connect` opens a loopback-only page. Approve **Connect this computer** once, then register this stdio command in your MCP client:

```text
agent-driver mcp
```

Hermes is the default upper runtime: it owns Telegram conversation, planning, memory, and follow-up questions, while Agent Driver owns execution, approval, recovery, and verification. If Hermes is installed:

```bash
agent-driver hermes configure
agent-driver hermes doctor
hermes mcp test agent-driver
```

Connect Telegram only through the official `hermes gateway setup` flow. Agent Driver never stores the bot token. Configure an explicit Telegram user allowlist; do not enable allow-all. External writes use a snapshot-bound MCP elicitation that the human answers directly in Telegram or another Hermes approval surface. A Telegram message, Jev result, or model response is never approval authority.

Jev is optional at installation time. Connect it only when a workflow benefits from typed state, action, target, relevance, or recovery judgments.

## How it works

```text
one-line request
  -> plan against connected sources and targets
  -> observe the current state
  -> deterministic step / Jev judgment / LLM exploration
  -> execute in an owned browser, CLI, file, or delegated source
  -> verify independently
  -> save a reusable Pack after verified success
```

Models propose plans and judgments; they do not grant authority. The runtime revalidates connected sources, allowed origins, fields, effects, freshness, and approval before execution.

## Built-in Pack families

| Family | Typical work | Current effect boundary |
|---|---|---|
| `research.search` | search, compare, rank with evidence | read-only |
| `portal.collect` | query a signed-in portal and export results | read + verified local export |
| `form.draft-submit` | fill a form and stop at review/submit | draft; submit requires local approval |
| `record.update` | update an existing record | task-bound approval + readback |
| `choose.stage` | select and stage an item | no payment, booking, or final order |
| `inbox.triage` | classify messages and draft replies | no send or delete |
| `monitor.watch` | repeat a read and emit deduplicated changes | local events; no external push transport |
| `file.pipeline` | filter, transform, and merge JSON/CSV | new output file; source preserved |

See [Pack catalog](docs/pack-catalog.md), [runtime flow](docs/pack-family-runtime.md), [Hermes + Telegram runtime](docs/hermes-telegram-runtime.md), and [first-run UX](docs/first-run.md).

## TypeSafe/Jev in the architecture

Jev is not restricted to checking whether a page loaded. A Task Pack can use a single typed request to choose the current state, operation, target, and text/value from a fresh element table. The initial LLM-authored specification defines valid choices and completion conditions; the runtime rejects stale or missing candidates and escalates low-confidence or novel states to re-observation or an LLM.

Selectors, Playwright locators, and coordinates are execution references, not competitors to AI. A verified deterministic step can be fastest; Jev is useful for repeated variable judgments; an LLM handles first-run exploration, replanning, and free-form generation.

## Safety model

- The runtime only uses host-connected sources and reviewed browser targets.
- Unknown, stale, or low-confidence state is `unknown`, not success.
- External writes require a current snapshot and a local, task-bound, single-use approval.
- Credentials, browser profiles, runtime databases, evidence, and local artifacts are ignored by Git.
- Payment, booking confirmation, order placement, membership signup, email sending, and deletion are outside the current public effect boundary.

Read [control-plane design](docs/control-plane-design-v0.7.md), [state machine](docs/state-machine.md), and [evaluation summary](docs/evaluation-summary.md) for the evidence behind these choices.

## Development

```bash
npm ci
npm run build
npm run test:runtime
```

The test report records evidence level separately from pass/fail. Fixture and contract success must not be described as live-account or native-platform success.

## Repository and licensing

`main` is the current public source line. Historical phase branches are folded into `main` rather than kept as release branches.

No open-source license has been selected yet. Until one is added, the repository is source-visible for evaluation, but no broader reuse license is granted.
