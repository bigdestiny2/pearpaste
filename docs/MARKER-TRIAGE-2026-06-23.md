# Pearpaste - Marker Triage (2026-06-23)

This note classifies the current task/debt marker surface for Pearpaste. It is
intended to keep future Level 2 loops focused on real implementation work rather
than release gates that require credentials, first CI execution, or external
hardware.

## Current Read

Pearpaste does not have an obvious loose implementation marker in maintained
runtime code. The visible markers are release and packaging gates:

- StartOS image and gallery proof.
- Native signing certificates and notarization.
- First real CI run verification for Pear asset fetching and optional AppImage
  tooling.
- Pear runtime release/OTA and docs/cutover phases.
- Generated mobile backend bundles, which should be excluded from marker
  scoring.

## Change In This Loop

The StartOS gate file was converted from a vague two-item list into a concrete
release-gate checklist. It now records:

- The current image reference is derived from `package.json` and
  `release/container-image.json`.
- The required final proof: immutable registry digest for the multi-arch image
  used by the submitted package.
- The package proof commands: `npm run container:check`, `npm ci`, `make x86`,
  and `make arm`.
- The gallery proof that must be captured on real StartOS hardware before
  marketplace submission.

## Classification

- **StartOS release gates:** source-backed and now routed into an actionable
  package proof checklist. Close only after the published image and hardware
  screenshots exist.
- **Signing/certificate gates:** intentionally open until Apple Developer ID,
  Authenticode, Linux signing convention, notarization, and release secrets are
  available. The scripts are documented as fail-closed rather than incomplete
  code.
- **First CI run verification markers:** valid operational reminders in the
  GitHub release workflow and release docs. Close after the first real
  `workflow_dispatch` or tag build proves Pear install/runtime fetch,
  platform-specific `pear build`, and optional AppImage tooling.
- **Pear runtime migration phases:** product/release-roadmap gates, not quick
  local fixes. Phase 4 requires updater worker and cross-version OTA proof;
  Phase 5 requires docs/cutover and legacy path retirement after Phase 4.
- **Generated mobile backend bundles:** not authoritative source. Exclude from
  marker scoring unless regenerating mobile bundles is the active task.

## Validation

Maintained-source marker inventory should be gathered with generated bundles
excluded:

```bash
rg -n "[T]ODO|[F]IXME" \
  -g '!node_modules/**' \
  -g '!mobile/backend/*.bundle.js' \
  -g '!mobile/backend/**/*.bundle.js' \
  -g '!dist/**' \
  -g '!build/**' \
  -g '!coverage/**' \
  -g '!*.map'
```

Docs-only validation for this loop:

```bash
npm run lint
npm run test:unit
```

Broader release validation remains in `docs/CURRENT_STATUS_AUDIT_2026-06-23.md`
and should not be claimed until run in the required environment.

## Recommended Next Level 1/2 Edge

Run a release-evidence cleanup pass:

1. Run local feasible gates: `npm run lint`, `npm run test:unit`, and any
   non-mutating dry-run package preflights that are safe on the current machine.
2. Record first-run CI markers only after a real GitHub Actions release workflow
   run.
3. Keep signing, notarization, StartOS hardware screenshots, and mobile/native
   device validation marked as environment-blocked until the required
   credentials or devices exist.
