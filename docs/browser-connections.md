# Website connections

Agent Driver is a local execution tool, not a website-policy registry. It does not block a domain, require an official API, or decide whether a user's task is allowed by a third-party service.

## Flow

1. A task reaches a page that needs sign-in or human verification.
2. The worker pauses before consuming another lease.
3. Control Center shows **사이트 로그인 N개 필요** and opens the requested sites only.
4. The user completes sign-in, CAPTCHA, or device approval directly in that browser.
5. Agent Driver observes only whether the requested site is ready and resumes the task.

The runtime stores the domain, access state, handoff flag, and timestamp. It does not export passwords, cookies, session tokens, one-time codes, or account names to the model, journal, or handoff document.

## Browser profile

A separate agent profile is optional. It can keep automation sessions away from a daily browser profile and reduce repeated sign-ins, but it is not a permission or policy requirement. The user may choose an owned Ubuntu VM profile or a connected browser surface.

The current build implements the owned Ubuntu VM login handoff. BrowserOS Neo, Aside, and user-Chrome surface types exist in the routing contract, but native connectors for them are not yet shipped.

## Runtime boundaries

- Login and human-verification screens are not streamed to the actor wall.
- A worker cannot race a browser while the user owns the login handoff.
- A saved `ready` state permits another attempt; every navigation can still discover a fresh login gate.
- Posting, submitting, purchasing, deleting, trading, and other external effects retain their separate approval boundaries.
- Legacy `policy_blocked` rows from the earlier experimental gate are migrated to ordinary `unchecked` sign-in state.

VNC is only a private screen and input transport for the agent-owned VM. It neither grants nor removes permission to use a website.
