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

Candidate 110ddaa published to the existing PR32 branch and applied using the
official managed installer with an explicit branch ref. Source checkout remains
clean; rollback ref retained. UI PID 782288, same URL, private config/model settings,
Work IDs and personal MCP process independently verified unchanged. Initial
preflight refused an exact recorded reuse URL argument before changing anything;
the helper was corrected to accept only that exact optional argument and rerun.
Private receipt: tests/evidence/phase92-ui-upgrade.json.

Actual Windows Aside check: five native disclosures blue (rgb 111,168,220) and
underlined; eight connection buttons 112x36px; Windows bridge expands on click,
dark theme retained and no horizontal overflow. No settings saved or Work executed.
Per-case axes plus the preflight failure retained in tests/report.json and
tests/evidence/phase92-native.json. Full-page Aside screenshot stitching repeated
a viewport, so that screenshot was not published as a README capture.

Public CI 36508806660 and 36508801398 was still running at last check. The prior
ac34a66 CI 36505132716 failed npm test; it is not treated as a pass. Current-head
CI and merge are required before a new immutable public release. Existing v0.3.1
tag and installer assets are not rewritten by this local candidate application.

User authentication still belongs to the official client. Cursor connection does
not add a structured judgment bridge. OpenCode credential-provider type remains
unknown unless separately established, so it is not an automatic subscription
fallback. Existing commented JSONC is preserved with a review message rather
than rewritten. Native Windows managed CLI installation remains unsupported;
the WSL install/Windows MCP bridge and official optional browser downloads remain
distinct paths.
