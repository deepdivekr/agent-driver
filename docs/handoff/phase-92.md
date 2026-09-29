# Phase 92 — Clear actions and working client setup

Read first: prompts/phase-92-connection-actions.md, src/onboarding/client-bootstrap.ts,
src/integrations/subscription-auth.ts, src/observability/settings-ui.ts and
tests/runtime-connection-actions.test.mjs. Node 22.22.0, npm 11.11.0 unchanged.

## Changes

- Official installer redirects are verified exact destinations, bounded to three
  attempts and a 30-second/2-MiB download. Invalid scripts, HTTP/network failures
  and execution failures return useful typed errors, never raw installer output.
- Installation in the MCP runtime environment proceeds to official login. Cursor
  uses its installed `agent login` and JSON status; UI opens its validated browser
  URL. OpenCode uses the documented ChatGPT headless device method and read-only
  `auth list`, without the unsupported `--format json` or `mcp add --global`.
- OpenCode MCP configuration is merged into its documented global `mcp` object;
  unrelated entries are preserved, edits/conflicts and unparseable JSONC refused.
- Connection buttons use concise labels and matching 112px widths on desktop and
  mobile. Docs-only install links removed; optional app downloads open official
  download pages. Import actions and text have consistent spacing.
- Every shared native disclosure is blue and underlined before hover, including
  Windows bridge, stored keys, optional browsers, Work/Hermes plans, remote setup,
  import evidence and setup logs. Existing per-page gray overrides removed.

## Evidence

- Affected suite: 70/70 PASS, including input fingerprint integrity.
  Receipt: tests/evidence/runtime-tests-2026-09-29T01-25-36-904Z.json.
- Full quick, without soak: 1021/1022 PASS. The sole failure used a regular Work
  `.runlist` selector on a Hermes Work. The test now independently covers both
  real local UI routes; source code was unchanged by this test correction.
  Failed receipt retained: tests/evidence/runtime-tests-2026-09-29T01-27-40-466Z.json.
- Expanded UI/theme/import/Hermes rerun: 16/16 PASS; desktop/mobile, light/dark,
  Korean/English, popup navigation, keyboard expansion and overflow assertions.
  Receipt: tests/evidence/runtime-tests-2026-09-29T01-35-07-700Z.json.
- Earlier installer/auth fixture failures and font-request fixture timeout are
  retained in the 01-14-36 and 01-18-30 receipts; they are not relabeled as passes.
- Actual WSL OpenCode installation: official installer 13,690 bytes, exit 0,
  installer execution 7,756ms; binary version 1.18.33 independently confirmed.
- Actual Cursor login emitted its official cursor.com browser URL; actual
  OpenCode login emitted auth.openai.com device URL plus code. Owned probes were
  canceled after initiation; user sign-in was not completed or fabricated.
- Model calls: none. Typed fixtures do not establish external provider quality.

## Deployment and remaining limits

Pending: publish candidate branch and upgrade the managed UI only, retaining its
URL, private configuration, model settings, Work and existing personal MCP.
Actual Windows page check and new CI status must be recorded after application.
Immutable v0.3.1 tag and installer assets are not rewritten.

User authentication still belongs to the official client. Cursor connection does
not add a structured judgment bridge. OpenCode credential-provider type remains
unknown unless separately established, so it is not an automatic subscription
fallback. Existing commented JSONC is preserved with a review message rather
than rewritten. Native Windows managed CLI installation remains unsupported;
the WSL install/Windows MCP bridge and official optional browser downloads remain
distinct paths.
