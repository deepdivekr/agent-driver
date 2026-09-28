# Phase 79 — real KakaoTalk room draft through owned CUA

## Actual scope

The user requested finding a named room and sending an exact test message. The
room was already visible, so no artificial scroll was added. Product-owned CUA
opened it by background double-click; native window inventory confirmed the
exact title. No Codex Computer Use, foreground escalation or authentication.

`CuaChatSession` is a **host-integrated prototype**, not a registered public
Windows Pack adapter. It shares `OwnedCuaConnection`, has an explicit reviewed-
chat profile and a SQLite one-use effect journal. Default local-field tools and
the self-chat-only workflow remain unchanged. The catalogue still has ten
Windows profiles. This does not claim automatic search, complete Work execution
or delivery of a message.

A real Work was defined through the installed MCP and configured Codex
subscription path (24.6 seconds including tool overhead). The private Windows
scope references that Work. Native operations are **not** attached as a Pack
Run in the Control Center. The current agent visually selected the list row;
there was no Jev API request. No secrets/private chat data enter public evidence.

## Native results and retained failures

- Main list UIA exposed zero actionable rows; visual selection was required.
  The opened room exposed one RichEdit Document and its exact native title.
- Background double-click: 1,083 ms; exact window inventory: 1,129 ms.
- Initial `type_text`: 956 ms. It appended the placeholder to the test message.
  Independent readback found the mismatch. **FAIL retained; no send followed.**
  The adapter now uses exact `set_value`, not append.
- Correction of that owned failed draft: 1,296 ms. Screenshot/native readback:
  1,873 ms, exact requested draft matched. **PASS**.
- Final build screenshot-free read: 1,489 ms including a new connection;
  comparison: 2 ms. This is read-only validation, not a repeated send/run.
- Actual sends: **0**. Action-time confirmation was requested and is pending.
- Last screenshot's send control appeared gray. Enabled readiness and remote
  delivery are **unverified**. A matching RichEdit value does not prove send
  readiness; inspect fresh state and, if needed, establish composer focus with
  owned CUA before any approved send.
- Initial manifest without an exact window grant was refused; the observed
  window grant fixed reading. Screenshot-file export was later refused (precise
  native reason unavailable); bounded inline PNG delivery succeeded.
- Intermediate build failed on unknown MCP content typing; runtime guards fixed
  it. Private audit logs retain the failed build.

The final adapter independently rereads exact room/composer/bounds before input,
uses a fresh native token, blocks stale approval and preserves existing drafts.
Claims precede dispatch. Unknown sends never replay across restart. A dispatch
is not delivery; only independent readback verifies a local draft. Public MCP
does not expose the trusted host's confirmation method.

## Verification

Pinned Node 22.22.0, npm 11.11.0, TypeScript 7.0.2, CUA 0.30.2.
Focused **117/117 PASS**, zero BLOCKED_ENV/NOT_RUN, including 23 new chat
contracts and input-fingerprint stability. Evidence:
`tests/evidence/runtime-tests-2026-09-28T03-36-46-133Z.json`.
Full quick **849/849 PASS**, zero BLOCKED_ENV/NOT_RUN, including input-fingerprint
stability: `tests/evidence/runtime-tests-2026-09-28T03-37-22-384Z.json`.
Long soak is excluded. This regression result is separate from the native send
case, which is NOT_RUN, and the retained initial native draft FAIL.
`ledger:verify` passed with **51 RQs**; `git diff --check` passed. All test
supervisors exited 0; no test-owned native process is intentionally left active.

## Resume

Read `src/desktop/cua-chat-session.ts`, `cua-connection.ts`,
`tests/runtime-cua-chat.test.mjs`, `docs/owned-windows-executor.md`.
Private staging: `C:/Users/<user>/projects/agent-driver-phase76-native`.
Exact Work/room scope, journal, SQLite claims and screenshots are in
`phase79-chat-*.private.*` / `phase79-chat.png`; do not publish them.
`phase79-chat.mjs` currently exposes observe/draft/verify, **no send command**.
Owned native processes exited normally; the user's chat and draft remain open.

After explicit confirmation: reopen the same scope/journal using pinned Node,
check for an existing send claim, observe exact current room/draft and actual
send-control readiness, then use a single trusted confirmed dispatch. No blind
retry or replacement request ID to defeat claims. Do not automatically mark
the Work complete. Remote receipt verification is not implemented; inspect a
genuinely new outgoing message and disclose evidence limits. If the user
declines, leave the draft; do not send or erase it.

No commit, release, installed MCP replacement or unrelated process termination.
