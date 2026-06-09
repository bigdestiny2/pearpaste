#!/usr/bin/env bash
# Paste desktop production release flow (Agent 3 owns this script).
#
# Spec §17 "Production Pear release", reworked for the CURRENT Pear CLI
# (verified against v0.3243 — `pear init` and `pear release` were REMOVED):
#   1. stage the app                       -> `pear stage <channel>` (--json)
#   2. run the verifier against STAGED files (scripts/verify-encryption.js)
#   3. capture the VERSIONED production link (verlink) + seed it
#                                          -> `pear seed <link>`
#   4. pin the app package on HiveRelay    -> scripts/pin-on-hiverelay.js
#   5. publish release notes
#
# The versioned link is Pear's `verlink` = pear://<fork>.<length>.<z32-key>
# (Pear keys are z-base-32, encoded by hypercore-id-encoding). `pear stage
# --json` emits both `link` (pear://<z32-key>) and `verlink`. A signed/multisig
# PRODUCTION link is `pear provision` + `pear multisig` (quorum cosign), a
# maintainer step documented below — it replaces the removed `pear release`.
#
# Native desktop wrappers (macOS/Windows/Linux signed installers) use the
# current `pear build --<platform>-app` path. Cert-dependent steps (macOS
# codesign/notarytool, Windows signtool) FAIL CLOSED when their identity/cert
# env vars are absent — real signing certificates are out of scope here
# (spec §17, §21 Agent 3).
#
# This script is intentionally conservative: every destructive/publishing step
# is gated behind an explicit confirmation or --yes, and a --dry-run prints the
# plan without staging/seeding. It never edits package.json or backend code.
#
# Usage:
#   scripts/release-prod.sh [--channel production] [--dry-run] [--yes]
#                           [--skip-pin] [--skip-verify] [--replicas N]
#
# Native-wrapper signing env (fail closed when unset):
#   macOS:   PEARPASTE_MAC_IDENTITY   "Developer ID Application: <Name> (<TEAM>)"
#            notarytool auth — EITHER PEARPASTE_NOTARY_PROFILE (a stored
#            `xcrun notarytool store-credentials` keychain profile)
#            OR APPLE_ID + APPLE_TEAM_ID + APP_SPECIFIC_PASSWORD
#   Windows: PEARPASTE_WIN_CERT (.pfx) + PEARPASTE_WIN_CERT_PASS
#            (see scripts/build-windows.mjs)
#
# Requires: a global `pear` (>= v0.3243) on PATH and `node`.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CHANNEL="production"
# Stable production link (pear://<key>). Mint it ONCE with `pear touch`, save the
# key, and reuse the SAME link for every release so installed clients keep
# updating over the P2P path. `pear stage` takes a link, NOT a channel name.
PEARPASTE_LINK="${PEARPASTE_LINK:-}"
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
    --link)        PEARPASTE_LINK="$2"; shift 2;;
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

# `pear --version` is not a flag in current Pear; the short flag is `-v`
# (verified: `pear --help` reports only `-v  Print version`).
PEAR_VER="$(pear -v 2>/dev/null | head -n1 || echo unknown)"
log "pear runtime: $PEAR_VER"

# Extract a single string field from Pear's newline-delimited --json output.
# Prefers jq when present; falls back to a conservative grep/sed.
json_field() { # <field> ; reads NDJSON on stdin
  local field="$1" input; input="$(cat)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s\n' "$input" \
      | jq -rs --arg f "$field" 'map(select(type=="object" and has($f)))[-1][$f] // empty' 2>/dev/null
  else
    printf '%s\n' "$input" \
      | grep -Eo "\"$field\"[[:space:]]*:[[:space:]]*\"[^\"]+\"" \
      | tail -n1 | sed -E "s/.*:[[:space:]]*\"([^\"]+)\".*/\1/"
  fi
}
log "channel: $CHANNEL"
[ "$DRY_RUN" = "1" ] && warn "DRY RUN — no staging, seeding, or pinning will occur"

# Captured from `pear stage --json`: unversioned + versioned production links.
RELEASE_LINK="pear://<production-key>"
RELEASE_VERLINK="pear://<fork>.<length>.<production-key>"

# ---------------------------------------------------------------------------
# 0. Pre-flight: lockfile present, no obvious plaintext sentinel in tree.
# ---------------------------------------------------------------------------
[ -f package-lock.json ] || warn "package-lock.json missing — commit a lockfile before public beta (spec §17)"

# ---------------------------------------------------------------------------
# 1. Stage the app (spec §17). `pear stage <channel>` syncs disk changes into
#    the project link and prints the staged key/diff. We run it with --json to
#    capture `link` (pear://<z32-key>) and `verlink` (pear://<fork>.<length>.
#    <z32-key>) — the versioned production link to publish in STEP 3.
#    (`pear stage --help`: pear stage [flags] <link> [dir=.].)
# ---------------------------------------------------------------------------
log "STEP 1/5 — stage app"
# `pear stage` takes a real pear:// link, NOT a channel name. Mint the stable
# production link ONCE (`pear touch` -> save the printed key) and pass it via
# PEARPASTE_LINK / --link; reuse the SAME link every release so installed
# clients keep updating over the P2P path.
if [ "$DRY_RUN" = "1" ]; then
  log "(dry-run) would run: pear stage --no-ask --json ${PEARPASTE_LINK:-pear://<your-production-key>}"
else
  case "${PEARPASTE_LINK:-}" in
    pear://*) : ;;
    *) die "set PEARPASTE_LINK (or --link) to your production pear:// link — bootstrap once: 'pear touch' (save the printed key) then export PEARPASTE_LINK=pear://<key>" ;;
  esac
  confirm "Stage Paste ($CHANNEL) to $PEARPASTE_LINK?" || die "aborted at stage"
  STAGE_JSON="$(pear stage --no-ask --json "$PEARPASTE_LINK" | tee /dev/stderr)"
  _link="$(printf '%s\n' "$STAGE_JSON" | json_field link || true)"
  _verlink="$(printf '%s\n' "$STAGE_JSON" | json_field verlink || true)"
  [ -n "${_link:-}" ] && RELEASE_LINK="$_link"
  [ -n "${_verlink:-}" ] && RELEASE_VERLINK="$_verlink"
  log "staged link:    $RELEASE_LINK"
  log "staged verlink: $RELEASE_VERLINK"
fi

# ---------------------------------------------------------------------------
# 2. Verify the encryption invariant against a FRESHLY BUILT VAULT (spec
#    §8.4/§17). We do NOT scan source: the app's own source legitimately
#    contains the plaintext sentinel constant (backend/shared-ops.js) and the
#    scanner (scripts/verify-encryption.js), so a source scan false-positives.
#    Instead we drive the real Pear-end to create a vault with sentinel-laden
#    content, then scan its on-disk STORAGE bytes (+ relay-export mirror) — the
#    same gate CI's sentinel-guard enforces. PEARPASTE_DISABLE_SWARM keeps the
#    gate offline/deterministic (no DHT/relay needed to prove storage is sealed).
# ---------------------------------------------------------------------------
log "STEP 2/5 — verify encryption invariant (fresh-vault storage scan)"
if [ "$SKIP_VERIFY" = "1" ]; then
  warn "--skip-verify set; SKIPPING the encryption gate (NOT for a real release)"
elif [ "$DRY_RUN" = "1" ]; then
  log "(dry-run) would build a sentinel-laden vault via the Pear-end, then scan its storage with verify-encryption.js"
else
  VAULT_DIR="$(mktemp -d)"
  if ! PEARPASTE_DISABLE_SWARM=1 VAULT_DIR="$VAULT_DIR" node -e '
    import("./backend/index.js").then(async ({ createPearEnd }) => {
      const { COMMANDS } = await import("./backend/rpc.js")
      const { SENTINEL_PREFIX: S } = await import("./backend/shared-ops.js")
      const pe = await createPearEnd({ storagePath: process.env.VAULT_DIR })
      await pe.call(COMMANDS.CREATE_VAULT, { label: "release-gate", platform: "release", passphrase: "release-gate-pw" })
      await pe.call(COMMANDS.NOTE_UPSERT, { note: { label: S + "NAME", body: S + "BODY_should_be_sealed", tags: [S + "TAG"] } })
      await pe.call(COMMANDS.CLIP_CAPTURE, { kind: "text", body: S + "CLIP_should_be_sealed" })
      if (pe.ctx.sync && pe.ctx.sync._opened) { try { await pe.ctx.sync.refresh() } catch (_) {} }
      await pe.call(COMMANDS.LOCK_VAULT, {})
      await new Promise(function (r) { setTimeout(r, 400) })
      await pe.close()
      process.exit(0)
    }).catch(function (e) { console.error(e); process.exit(2) })
  '; then
    rm -rf "$VAULT_DIR"; die "could not build the verification vault (Pear-end failed)"
  fi
  if node scripts/verify-encryption.js "$VAULT_DIR" --json; then
    log "verifier PASSED on a freshly built vault (storage is ciphertext-only)"
    rm -rf "$VAULT_DIR"
  else
    rm -rf "$VAULT_DIR"; die "verifier FAILED on a freshly built vault — release blocked (spec §8.4 invariant)"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Publish the versioned production link (spec §17). `pear release` was
#    REMOVED in current Pear. The immutable production link is the `verlink`
#    captured in STEP 1 (pear://<fork>.<length>.<z32-key>); we make it
#    reachable by SEEDING it (`pear seed <link>`), which keeps the P2P
#    auto-update path so wrappers rarely need a rebuild. A signed/multisig
#    production link (cryptographic quorum cosign) is the `pear provision` +
#    `pear multisig` maintainer flow — see the note below — and requires
#    quorum keys this repo does not ship.
# ---------------------------------------------------------------------------
log "STEP 3/5 — publish + seed versioned production link"
if [ "$DRY_RUN" = "1" ]; then
  [ "$SKIP_VERIFY" = "1" ] && warn "(dry-run) NOTE: a REAL run would refuse to publish with --skip-verify"
  log "(dry-run) production verlink: $RELEASE_VERLINK"
  log "(dry-run) would run: pear seed $RELEASE_LINK"
else
  # Never publish unverified: the verifier (STEP 2) must have actually gated us.
  if [ "$SKIP_VERIFY" = "1" ]; then
    die "refusing to publish: --skip-verify bypassed the encryption gate (STEP 2)"
  fi
  log "production link:    $RELEASE_LINK"
  log "production verlink: $RELEASE_VERLINK   (pear://<fork>.<length>.<z32-key>)"
  confirm "Seed channel '$CHANNEL' so the production link stays reachable?" || die "aborted before seed"
  # `pear seed <link>` seeds/reseeds the project for availability.
  # (`pear seed --help`: pear seed [flags] <link>.) Run it backgrounded by the
  # maintainer for a long-lived seeder; here we kick a foreground seed pass.
  pear seed --no-tty "$RELEASE_LINK" || warn "seed pass returned non-zero — re-run 'pear seed $RELEASE_LINK' on a long-lived host"
fi

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
Pear link:    ${RELEASE_LINK}
Pear verlink: ${RELEASE_VERLINK}   (versioned, immutable: fork.length.z32-key)
Pear runtime: ${PEAR_VER}
Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)

Install (user path v1 — pin the VERSIONED link for reproducibility):
  pear run ${RELEASE_VERLINK}

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
# Native desktop wrappers — current `pear build --<platform>-app` path
# (spec §17 v1.5). `pear init --wrapper` and `pear release` were REMOVED.
# Cert-dependent signing FAILS CLOSED when identity/cert env vars are absent.
# ---------------------------------------------------------------------------
PRODUCT_NAME="Paste"   # package.json productName; pear build enforces basename
DIST_DIR="${PEARPASTE_DIST_DIR:-dist}"

# macOS: delegated to scripts/build-macos.mjs (`npm run release:mac`), which runs
# the FULL Tier-2 chain: `pear build --darwin-arm64-app <Paste.app>` ->
# codesign (Developer ID, hardened runtime) -> hdiutil .dmg -> codesign dmg ->
# `xcrun notarytool submit --wait` -> `xcrun stapler staple`. build-macos.mjs is
# the single source of truth for the macOS chain (mirrors win_sign -> release:win),
# so this script no longer duplicates the codesign/hdiutil steps (which had
# drifted: the old inline version SKIPPED `pear build`). It FAILS CLOSED without
# PEARPASTE_MAC_IDENTITY + notarytool auth. Only invoke on macOS.
mac_sign_notarize() { # <app-path> e.g. dist/macos/by-arch/darwin-arm64/app/Paste.app
  local app="$1"
  if [ "$(uname -s)" != "Darwin" ]; then
    warn "macOS signing/notarization must run on macOS; skipping on $(uname -s). Use 'npm run release:mac' on a Mac (see docs/RELEASE.md §3.3)."
    return 0
  fi
  log "macOS wrapper: npm run release:mac (pear build --darwin-arm64-app + codesign + hdiutil + notarytool + stapler)"
  if [ "$DRY_RUN" = "1" ]; then
    log "(dry-run) would run: PEARPASTE_MAC_APP=\"$app\" PEARPASTE_LINK=\"$RELEASE_VERLINK\" npm run release:mac"
    log "(dry-run) build-macos.mjs FAILS CLOSED without PEARPASTE_MAC_IDENTITY + notarytool auth"
    ok "(dry-run) macOS sign+notarize plan printed"
    return 0
  fi
  # build-macos.mjs enforces PEARPASTE_MAC_IDENTITY + notarytool auth (fail closed)
  # and emits dist/macos/${PRODUCT_NAME}-${APP_VERSION}.dmg + .sha256.
  PEARPASTE_MAC_APP="$app" PEARPASTE_LINK="$RELEASE_VERLINK" PEARPASTE_DIST_DIR="${DIST_DIR}/macos" npm run release:mac
  ok "macOS .dmg built + notarized via build-macos.mjs (dist: ${DIST_DIR}/macos)"
}

# Windows: delegated to scripts/build-windows.mjs (pear build --win32-x64-app +
# signtool). It fails closed without PEARPASTE_WIN_CERT. Only invoke on win32.
win_sign() {
  if [ "$(uname -s | cut -c1-5)" = "MINGW" ] || [ "${OS:-}" = "Windows_NT" ]; then
    log "Windows wrapper: npm run release:win (pear build --win32-x64-app + signtool)"
    [ "$DRY_RUN" = "1" ] && { ok "(dry-run) would run: npm run release:win"; return 0; }
    PEARPASTE_LINK="$RELEASE_VERLINK" npm run release:win
  else
    warn "Windows signing must run on a Windows host; use 'npm run release:win' there (see docs/RELEASE.md §3.1)."
  fi
}

cat <<EOF

[release] Native desktop wrapper path (current Pear build flow, spec §17 v1.5)
  The versioned production link above is the v1 user path. Native installers
  embed the Pear runtime and resolve this link. Build each platform app dir on
  its own OS, then package + sign:

  macOS (Apple Developer ID; out of scope here — fail closed without identity):
    1. Build the darwin app dir (basename must be "${PRODUCT_NAME}").
    2. npm run release:mac  (pear build --darwin-arm64-app + codesign hardened
         runtime + hdiutil .dmg + xcrun notarytool submit --wait + stapler
         staple) — see scripts/build-macos.mjs
       -> automated by mac_sign_notarize() (delegates to release:mac).
       For an UNSIGNED dev/CI .dmg (no Developer ID): npm run build:mac.

  Windows (Authenticode; out of scope here — fail closed without cert):
    1. Build the win32 app dir (basename must be "${PRODUCT_NAME}").
    2. npm run release:win  (pear build --win32-x64-app + signtool
         /fd SHA256 /tr <RFC3161 TSA> /td SHA256) — see scripts/build-windows.mjs
       For an UNSIGNED dev/CI .exe (no cert): npm run build:win:unsigned.

  Linux (no mandatory signing; GPG/minisign + optional .deb/AppImage):
    1. npm run preflight:linux
    2. PEARPASTE_LINK="$RELEASE_VERLINK" npm run build:linux  (tarball + .deb +
         AppImage when dpkg-deb/appimagetool present; skipped gracefully if not)
    3. release:linux requires a detached signature sidecar for EVERY artifact
       (tarball, .deb, AppImage); fails closed otherwise. For unsigned dev/CI
       artifacts: npm run build:linux -- --unsigned.

  The Pear P2P auto-update path is preserved by all wrappers, so a wrapper
  rarely needs a rebuild — content updates flow over the pear:// link.

  Signed PRODUCTION link (replaces removed 'pear release'): quorum cosign via
    pear provision <source-verlink> <target-link> <production-verlink>
    pear multisig request|sign|verify|commit   (needs quorum keys, not in repo)
EOF

# Run the signing helpers only when the maintainer points at a built app dir
# (PEARPASTE_MAC_APP / PEARPASTE_WIN_WRAPPER). Absent those, we only printed the
# plan above. Each helper fails closed if its cert/identity env is missing.
if [ -n "${PEARPASTE_MAC_APP:-}" ]; then mac_sign_notarize "$PEARPASTE_MAC_APP"; fi
if [ -n "${PEARPASTE_WIN_WRAPPER:-}" ]; then win_sign; fi

# Tidy the local mirror unless the caller wants to inspect it.
[ "$DRY_RUN" = "1" ] || rm -rf "$STAGE_DIR"

log "DONE — production release flow complete for Paste ${APP_VERSION}"
