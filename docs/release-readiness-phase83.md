# Phase 83 candidate — public installation assessment

Candidate source: `release/v0.2.0`, baseline `d69c8e6`, with the local Phase 70–83
changes. Package version remains 0.2.0. This document does not publish or update
the existing public v0.2.0 release.

## Decision

**NO-GO for advertising a stable, install-and-use general Windows desktop agent.**
Common recovery alone does not close the product's first-install and approval
gaps. Existing Ubuntu/WSL MCP/browser/file/coding support has a separate, narrower
public scope. Passing that install test must not be presented as native Windows
desktop installation or all-app certification.

## Remaining release blockers for the requested desktop experience

1. **Native host connection and grants.** The generic executor currently requires
   host configuration for an exact CUA binary/manifest, Work, PID/window and expiry.
   The shipped WSL installer does not set up a native Windows CUA host/bridge and
   the connection screen does not create these grants. Evidence:
   `src/interface/config.ts`, `src/desktop/cua-contracts.ts`, `src/onboarding/`.
2. **Real action approval path.** `RuntimeApi` constructs `CuaDesktopDriver` from
   configuration without the `confirmEffect` callback. Navigation/draft can run,
   but local-write/external-send returns `waiting_approval`; a visible generic
   action-time approval flow must be connected before claiming those workflows.
   Evidence: `src/interface/api.ts`, `src/desktop/cua-desktop-driver.ts`.
3. **Desktop operational coverage.** Current visual execution supports OCR-text
   navigation, not arbitrary icon-only controls or visual typing. Unscoped modal
   dismissal and crashed/hung private-app restart are not automatically executed.
   Add verified host capabilities and recovery contracts rather than app-name
   exceptions. Current evidence does not establish all-app message delivery.
4. **Host-wide foreground ownership.** The SQLite lock protects the executor
   within one configured host database. Multiple independently configured hosts
   need a shared native input lease before foreground concurrency is advertised.

macOS/native Windows installation is still outside the public support matrix.
Do not convert historical `partial` requirements to done because the regression
suite passes. A broad stable release should wait for the above user paths to be
implemented and verified from a clean PC, without development staging.

## Validation record

- Current-source disposable install snapshot: `edaebf9353e68419570cf2f958dfb65dbbd38400`.
  Original branch/HEAD and existing user edits were not committed or reset.
- Focused corrected regression: 161/161 PASS, fingerprint stable. Initial
  156/161 failure report preserved; one real auto-overwrite risk was fixed by
  limiting automatic drift correction to navigation.
- Native cover/minimize: PASS; exact measurements and boundaries in
  [desktop recovery](desktop-recovery.md).
- Production dependency audit: 0 reported vulnerabilities (not a security audit).
- Publication pattern scan: 482 non-ignored paths, 0 findings (not complete secret detection).
- Full quick **942/942 PASS** (941 cases plus source-input stability): unit 281,
  contract_fake 376, fixture_integration 151, native_integration 134. These are
  evidence classifications, not 942 live Windows/model tests.
- Fresh installation and upgrades from 0.1.0 and 0.1.1: **3/3 PASS**, actual npm
  install/build, Chromium, stdio MCP, saved Work/model preferences and wrapper
  from another directory. All installed SHA values match the disposable snapshot.
  Receipts: `tests/evidence/phase83-acceptance.json` and
  `tests/evidence/release-install/2026-09-28T08-19-09.097Z.json`.
- Long soak excluded as requested. No public push, release tag, private-business
  action, paid model call or installed-host replacement is part of this check.
