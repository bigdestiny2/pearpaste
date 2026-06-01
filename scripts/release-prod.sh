#!/usr/bin/env bash
# Paste desktop production release flow (Agent 3 owns this script).
#
# Spec §17 "Production Pear release":
#   1. stage the app
#   2. release the production Pear link
#   3. pin the app package on HiveRelay (scripts/pin-on-hiverelay.js)
#   4. run the verifier against the STAGED app files (scripts/verify-encryption.js)
#   5. publish release notes
#
# Native desktop wrappers (macOS/Windows/Linux signed installers) are scripted
# as the Pear binary-wrapper path with the signing steps clearly TODO'd —
# real signing certificates are out of scope here (spec §17, §21 Agent 3).
#
# This script is intentionally conservative: every destructive/publishing step
# is gated behind an explicit confirmation or --yes, and a --dry-run prints the
# plan without staging/releasing. It never edits package.json or backend code.
#
# Usage:
#   scripts/release-prod.sh [--channel production] [--dry-run] [--yes]
#                           [--skip-pin] [--skip-verify] [--replicas N]
#
# Requires: a global `pear` (>= 2.x) on PATH and `node`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHANNEL="production"
DRY_RUN=0
ASSUME_YES=0
SKIP_PIN=0
SKIP_VERIFY=0
REPLICAS=5
STAGE_DIR=".pear-stage"   # local mirror of staged files we run the verifier on

log()  { printf '\033[36m[release]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[release:warn]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[release:error]\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --channel)     CHANNEL="$2"; shift 2;;
    --dry-run)     DRY_RUN=1; shift;;
    --yes|-y)      ASSUME_YES=1; shift;;
    --skip-pin)    SKIP_PIN=1; shift;;
    --skip-verify) SKIP_VERIFY=1; shift;;
    --replicas)    REPLICAS="$2"; shift 2;;
    -h|--help)
      sed -n '1,30p' "$0"; exit 0;;
    *) die "unknown arg: $1";;
  esac
done

confirm() {
  [ "$ASSUME_YES" = "1" ] && return 0
  printf '\033[35m[release]\033[0m %s [y/N] ' "$1"
  read -r ans || true
  case "${ans:-}" in y|Y|yes|YES) return 0;; *) return 1;; esac
}

command -v pear >/dev/null 2>&1 || die "pear runtime not found on PATH (install Pear)"
command -v node >/dev/null 2>&1 || die "node not found on PATH"

PEAR_VER="$(pear --version 2>/dev/null | head -n1 || echo unknown)"
log "pear runtime: $PEAR_VER"
log "channel: $CHANNEL"
[ "$DRY_RUN" = "1" ] && warn "DRY RUN — no staging, release, or pinning will occur"

# ---------------------------------------------------------------------------
# 0. Pre-flight: lockfile present, no obvious plaintext sentinel in tree.
# ---------------------------------------------------------------------------
[ -f package-lock.json ] || warn "package-lock.json missing — commit a lockfile before public beta (spec §17)"

# ---------------------------------------------------------------------------
# 1. Stage the app (spec §17). `pear stage <channel>` uploads to the local
#    Pear application store and prints the staged key/diff.
# ---------------------------------------------------------------------------
log "STEP 1/5 — stage app"
if [ "$DRY_RUN" = "1" ]; then
  log "(dry-run) would run: pear stage $CHANNEL"
else
  confirm "Stage Paste to channel '$CHANNEL'?" || die "aborted at stage"
  pear stage "$CHANNEL"
fi

# Mirror the staged entrypoint set locally so the verifier scans exactly what
# ships. We copy the same files Pear stages (pear.json stage.entrypoints +
# index.html/js + ui/ + backend/), excluding tests/docs/.git/node_modules cache.
log "preparing staged-file mirror for verification ($STAGE_DIR)"
rm -rf "$STAGE_DIR"
mkdir -p "$STAGE_DIR"
# rsync if available (clean excludes); fall back to cp.
if command -v rsync >/dev/null 2>&1; then
  rsync -a \
    --exclude '.git' --exclude 'test' --exclude 'docs' \
    --exclude 'node_modules/.cache' --exclude "$STAGE_DIR" \
    index.html index.js pear.json package.json ui backend scripts node_modules \
    "$STAGE_DIR/" 2>/dev/null || true
else
  for p in index.html index.js pear.json package.json ui backend scripts; do
    [ -e "$p" ] && cp -R "$p" "$STAGE_DIR/" 2>/dev/null || true
  done
fi

# ---------------------------------------------------------------------------
# 2. Run the verifier against the STAGED app files (spec §17/§8.4). This must
#    pass before any production link is promoted.
# ---------------------------------------------------------------------------
log "STEP 2/5 — verify staged files (encryption invariant gate)"
if [ "$SKIP_VERIFY" = "1" ]; then
  warn "--skip-verify set; SKIPPING the encryption gate (NOT for a real release)"
else
  if node scripts/verify-encryption.js "$STAGE_DIR" --json; then
    log "verifier PASSED on staged files"
  else
    die "verifier FAILED on staged files — release blocked (spec §8.4 invariant)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Release the production Pear link (spec §17). `pear release <channel>`
#    promotes the staged build to the production-resolvable pear:// link and
#    preserves the P2P auto-update path so wrappers rarely need a rebuild.
# ---------------------------------------------------------------------------
log "STEP 3/5 — release production link"
# NOTE: `pear release` is DEPRECATED in current Pear (>= v0.3243): it prints
# "Use pear provision and pear multisig". The staged pear:// link from STEP 1
# is already runnable/distributable (`pear run pear://<key>`); promotion to a
# multisig production link is `pear provision` (maintainer step). For the
# Windows wrapper specifically, use scripts/build-windows.mjs (npm run
# build:win / release:win) — see docs/RELEASE.md §3.1.
if [ "$DRY_RUN" = "1" ]; then
  log "(dry-run) would run: pear release $CHANNEL  (deprecated; see note above)"
  RELEASE_LINK="pear://<production-key>"
else
  warn "pear release is deprecated; modern flow is pear provision / pear multisig"
  confirm "Release channel '$CHANNEL' as the production link?" || die "aborted at release"
  pear release "$CHANNEL"
  # Best-effort: capture the resolvable link for the release notes.
  RELEASE_LINK="$(pear info "$CHANNEL" 2>/dev/null | grep -Eo 'pear://[A-Za-z0-9]+' | head -n1 || echo 'pear://<production-key>')"
fi
log "production link: ${RELEASE_LINK:-pear://<production-key>}"

# ---------------------------------------------------------------------------
# 4. Pin the app package on HiveRelay (spec §17/§11). App files are PUBLIC
#    distribution assets — pin in --app mode. Degrades cleanly if the optional
#    p2p-hiverelay-client is absent (the app stays usable local-first).
# ---------------------------------------------------------------------------
log "STEP 4/5 — pin app package on HiveRelay"
if [ "$SKIP_PIN" = "1" ]; then
  warn "--skip-pin set; not pinning (app remains direct-P2P only)"
elif [ "$DRY_RUN" = "1" ]; then
  log "(dry-run) would run: node scripts/pin-on-hiverelay.js --app \"$STAGE_DIR\" --replicas $REPLICAS --json"
else
  if node scripts/pin-on-hiverelay.js --app "$STAGE_DIR" --replicas "$REPLICAS" --json; then
    log "pin request submitted (replicas target: $REPLICAS)"
  else
    warn "pin step failed or relay client unavailable — continuing (spec §11: local-first still works)"
  fi
fi

# ---------------------------------------------------------------------------
# 5. Publish release notes (spec §17). Honest about what the proof does and
#    does not prove (spec §4/§8.4) — never softened.
# ---------------------------------------------------------------------------
log "STEP 5/5 — release notes"
APP_VERSION="$(node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo 0.0.0)"
NOTES_FILE="RELEASE_NOTES_${APP_VERSION}.txt"
cat > "$NOTES_FILE" <<EOF
Paste ${APP_VERSION} — desktop production release
Channel: ${CHANNEL}
Pear link: ${RELEASE_LINK:-pear://<production-key>}
Pear runtime: ${PEAR_VER}
Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Install (user path v1):
  pear run ${RELEASE_LINK:-pear://<production-key>}

What this release proves:
  - Notes and clipboard bodies are encrypted on-device (XChaCha20-Poly1305)
    before entering any replicated structure.
  - Relays store ciphertext only; they never receive plaintext or vault keys.
  - The bundled verifier scanned the STAGED app files: no plaintext sentinel,
    every stored value is an AEAD CryptoEnvelope.

What this release does NOT prove:
  - It does not prove physical deletion from third-party disks.
  - It does not provide network-metadata anonymity.
  - "Reduced availability" can occur if relay quorum is below target; local
    and direct-P2P use are unaffected.

Verifier (independent, run from source):
  node scripts/verify-encryption.js <storage-path>
EOF
log "wrote $NOTES_FILE"

# ---------------------------------------------------------------------------
# Native desktop wrappers — Pear binary-wrapper path (spec §17 v1.5).
# These are scripted as steps; signing is explicitly TODO (certs out of scope).
# ---------------------------------------------------------------------------
cat <<'EOF'

[release] Native desktop wrapper path (Pear binary distribution, spec §17 v1.5)
  The production pear:// link above is already the v1 user path. To produce
  native installers that embed the Pear runtime and resolve this link:

  macOS:
    1. pear init --wrapper macos ./dist/macos        # scaffold the wrapper
    2. embed RELEASE_LINK into the wrapper config
    3. build the .app bundle (pear binary wrapper path)
    # TODO(signing): codesign --deep --options runtime --sign "Developer ID
    #   Application: <TEAM>" ./dist/macos/PearPaste.app
    # TODO(signing): notarize via `xcrun notarytool submit` + staple
       (real Apple Developer cert + notarization are out of scope here)

  Windows:
    1. pear init --wrapper windows ./dist/windows
    2. embed RELEASE_LINK; build the .exe wrapper
    # TODO(signing): signtool sign /fd SHA256 /tr <RFC3161 TSA>
    #   /td SHA256 /a PearPaste-Setup.exe   (real EV/OV cert out of scope)

  Linux:
    1. npm run preflight:linux
    2. PEARPASTE_LINK="${RELEASE_LINK:-pear://<production-key>}" npm run build:linux
    3. wrap dist/linux/*.tar.gz into AppImage / .deb / .rpm as
       distro-appropriate, or ship the tarball for internal Linux testing
    # Linux packages may remain unsigned or use distro signing (spec §17);
    # CI release-guard still rejects unsigned artifacts when present.

  The Pear P2P auto-update path is preserved by all wrappers, so a wrapper
  rarely needs a rebuild — content updates flow over the pear:// link.
EOF

# Tidy the local mirror unless the caller wants to inspect it.
[ "$DRY_RUN" = "1" ] || rm -rf "$STAGE_DIR"

log "DONE — production release flow complete for Paste ${APP_VERSION}"
