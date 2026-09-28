# Phase 79 — scoped native chat-room messaging

User request: extend the owned runtime to KakaoTalk, scroll the chat list to the
exact requested room and prepare the exact message. Use the product-owned CUA,
not Codex Computer Use. A send requires fresh recipient/draft evidence and
action-time confirmation. Never duplicate an uncertain send.

## TODO (exact requirements)

- RQ-754: Inspect the real KakaoTalk surface through owned CUA and implement a narrowly scoped chat-room adapter without weakening local-field or self-chat boundaries.
- RQ-755: Bind navigation, draft, confirmation and send to the exact Work, current room and message; preserve durable claims, fresh observation and no uncertain-effect replay.
- RQ-756: Verify new adapter safety contracts and exercise the authorized real-room flow, recording actual timings and separate draft, sent and unverified outcomes without publishing personal chat data.
- RQ-757: Update status, evidence, handoff and capability documentation with supported scope and any remaining human confirmation or environment requirements; pass ledger verification.
