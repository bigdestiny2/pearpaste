// Paste — macOS build orchestrator (launcher model).
//
// Spec refs: §12 (desktop packaging), §17 (release; sign + notarize), §21
// Agent 3 (desktop distribution). Sibling of scripts/build-windows.mjs.
//
// WHY A LAUNCHER (the hard-won lesson, 2026-06-10):
//   pear-electron's shell is NOT a standalone app. Its boot entry does
//     const state = JSON.parse(process.argv.slice(-1)[0])
//   i.e. it REQUIRES the Pear runtime to spawn it with a boot-state JSON
//   (`<shell> run --rti {checkout,mount,bridge,startId,…}`). The Pear runtime
//   constructs that at launch (it even stands up a local bridge server). A
//   static wrapper that just exec()s the shell binary passes the executable
//   PATH as the last argv, so JSON.parse throws "Unexpected token '/'" — which
//   boot.js's try/catch masks as a misleading "Cannot find module boot.js".
//   Every embedded-runtime/dmg-tree/symlink layout hit this; none ever booted.
//
//   So macOS uses the SAME model as Windows (scripts/windows-launcher) and
//   Linux: a thin launcher that locates the installed Pear runtime and runs the
//   production pear:// link. `pear run pear://<key>` performs the full
//   bootstrap and is the verified-working path. The launcher requires the Pear
//   runtime (one-time `npm i -g pear`), and shows a friendly install dialog if
//   it is absent.
//
// Distribution tiers:
//   Tier 1 (P2P link, any OS): `pear stage <link>` → users `pear run pear://…`.
//   Tier 2 (.dmg): a double-clickable launcher .app wrapped in a .dmg. --build
//     emits an UNSIGNED .dmg (dev/CI); --release codesigns (Developer ID,
//     hardened runtime) + notarizes + staples, failing closed without creds.
//
// Usage:
//   node scripts/build-macos.mjs --preflight   # readiness report (any OS)
//   node scripts/build-macos.mjs --dry-run      # show the plan, no writes
//   node scripts/build-macos.mjs --build        # UNSIGNED launcher .dmg
//   node scripts/build-macos.mjs --release      # build + sign + notarize
//
// Env:
//   PEARPASTE_LINK         pear:// link the launcher runs (default: production)
//   PEARPASTE_MAC_IDENTITY "Developer ID Application: <Name> (<TEAM>)" (Tier 2)
//   notarytool auth — EITHER PEARPASTE_NOTARY_PROFILE (a stored keychain
//     profile) OR APPLE_ID + APPLE_TEAM_ID + APP_SPECIFIC_PASSWORD
//   PEARPASTE_DIST_DIR     override the output dir (default dist/macos)
//   PEARPASTE_MAC_ARCH     darwin-arm64 (default) | darwin-x64

import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const val = (f, env) => {
  const i = argv.indexOf(f)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return env ? process.env[env] : undefined
}

const MODE = has('--release')
  ? 'release'
  : has('--build') ? 'build' : has('--dry-run') ? 'dry-run' : 'preflight'
const UNSIGNED = has('--unsigned')

// The production app link the launcher runs. Overridable for staging/dev.
const PRODUCTION_LINK = 'pear://u6oyh38gcn3ouk6wnzpoetzpeg7gs1w5s9f5aw5quocr1eubsoiy'
const APP_LINK = val('--link', 'PEARPASTE_LINK') || PRODUCTION_LINK

const PRODUCT_NAME = 'Paste'
const BUNDLE_ID = 'global.paste.app'
const ARCH = (val('--arch', 'PEARPASTE_MAC_ARCH') || 'darwin-arm64').replace(/^--/, '')
if (ARCH !== 'darwin-arm64' && ARCH !== 'darwin-x64') {
  console.error(`[mac:error] unsupported --arch "${ARCH}" (expected darwin-arm64 or darwin-x64)`)
  process.exit(1)
}

const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }
const log = (m) => console.log(`[mac] ${m}`)
const ok = (m) => console.log(`${C.ok}[mac:ok]${C.x} ${m}`)
const warn = (m) => console.log(`${C.warn}[mac:warn]${C.x} ${m}`)
const die = (m) => { console.error(`${C.err}[mac:error]${C.x} ${m}`); process.exit(1) }

if (UNSIGNED && MODE === 'release') {
  die('--unsigned cannot be combined with --release (a signed release must fail closed without a Developer ID identity); use --build for an unsigned dev/CI .dmg')
}

function sha256 (absPath) {
  return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex')
}
function appVersion () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0' } catch (_) { return '0.0.0' }
}
function hasBin (cmd) {
  try { execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' }); return true } catch (_) { return false }
}
function distDir () {
  return process.env.PEARPASTE_DIST_DIR
    ? path.join(ROOT, process.env.PEARPASTE_DIST_DIR)
    : path.join(ROOT, 'dist', 'macos')
}

// ---- The launcher executable ----------------------------------------------
// A POSIX sh script (the .app's CFBundleExecutable). When double-clicked,
// LaunchServices runs it with a minimal environment (no user PATH), so the
// Pear runtime is located via explicit candidate paths + a PATH fallback.
// `exec`s `pear run <link>`, which performs the full Pear bootstrap (the only
// thing that boots the pear-electron shell correctly — see the header).
function launcherScript () {
  // `\\n` here writes a literal \n into the file → AppleScript renders it as a
  // newline in the install dialog.
  return `#!/bin/sh
# Paste launcher — locates the Pear runtime and runs the production app link.
LINK="${APP_LINK}"

find_pear() {
  for c in \\
    "$HOME/Library/Application Support/pear/bin/pear" \\
    "/opt/homebrew/bin/pear" \\
    "/usr/local/bin/pear" \\
    "$(command -v pear 2>/dev/null)"; do
    if [ -n "$c" ] && [ -x "$c" ]; then printf '%s' "$c"; return 0; fi
  done
  return 1
}

PEAR="$(find_pear)"
if [ -z "$PEAR" ]; then
  osascript -e 'display dialog "Paste needs the Pear runtime (one-time setup).\\n\\nInstall it:\\n   npm i -g pear\\n   pear run pear://runtime\\n\\nThen open Paste again." buttons {"Get Pear at pears.com", "OK"} default button "OK" with title "Paste" with icon caution' \\
    -e 'if button returned of result is "Get Pear at pears.com" then open location "https://pears.com"' >/dev/null 2>&1
  exit 1
fi

exec "$PEAR" run "$LINK"
`
}

// ---- Build the launcher .app ----------------------------------------------
function buildLauncherApp (dry) {
  const out = distDir()
  const bundle = path.join(out, `${PRODUCT_NAME}.app`)
  const ver = appVersion()
  log(`assemble launcher ${path.relative(ROOT, bundle)} → runs ${APP_LINK.slice(0, 32)}…`)
  if (dry) { ok('dry-run: launcher .app not written'); return bundle }

  fs.rmSync(bundle, { recursive: true, force: true })
  const macosDir = path.join(bundle, 'Contents', 'MacOS')
  const resources = path.join(bundle, 'Contents', 'Resources')
  fs.mkdirSync(macosDir, { recursive: true })
  fs.mkdirSync(resources, { recursive: true })

  const exe = path.join(macosDir, PRODUCT_NAME)
  fs.writeFileSync(exe, launcherScript(), { mode: 0o755 })

  const icns = path.join(ROOT, 'assets', `${PRODUCT_NAME}.icns`)
  if (fs.existsSync(icns)) fs.copyFileSync(icns, path.join(resources, `${PRODUCT_NAME}.icns`))
  else warn('assets/Paste.icns missing — launcher will use a default icon')

  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleDisplayName</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
  <key>CFBundleExecutable</key><string>${PRODUCT_NAME}</string>
  <key>CFBundleIconFile</key><string>${PRODUCT_NAME}.icns</string>
  <key>CFBundleVersion</key><string>${ver}</string>
  <key>CFBundleShortVersionString</key><string>${ver}</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSUIElement</key><false/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`)
  fs.writeFileSync(path.join(bundle, 'Contents', 'PkgInfo'), 'APPL????')

  // Ad-hoc sign so the bundle is structurally consistent (real Developer ID
  // signing is the --release lane). Best-effort; non-fatal on non-darwin.
  if (process.platform === 'darwin') {
    try { execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'ignore' }) } catch (_) {
      warn('ad-hoc codesign failed — Gatekeeper friction worse, app still runs via right-click → Open')
    }
  }
  ok(`built launcher ${path.relative(ROOT, bundle)}`)
  return bundle
}

// ---- Create the .dmg (hdiutil) --------------------------------------------
function makeDmg (app, signed, dry) {
  const ver = appVersion()
  const out = distDir()
  const dmgName = signed ? `${PRODUCT_NAME}-${ver}.dmg` : `${PRODUCT_NAME}-${ver}-unsigned.dmg`
  const dmg = path.join(path.dirname(out), dmgName) // dist/<name>.dmg
  log(`stage {${PRODUCT_NAME}.app, /Applications↗} → hdiutil → ${path.relative(ROOT, dmg)}`)
  if (dry) { ok('dry-run: hdiutil not executed'); return dmg }

  const stage = fs.mkdtempSync(path.join(distDir(), '.dmg-stage-'))
  try {
    fs.cpSync(app, path.join(stage, `${PRODUCT_NAME}.app`), { recursive: true, verbatimSymlinks: true })
    fs.symlinkSync('/Applications', path.join(stage, 'Applications'))
    fs.mkdirSync(path.dirname(dmg), { recursive: true })
    fs.rmSync(dmg, { force: true })
    execFileSync('hdiutil', ['create', '-volname', PRODUCT_NAME, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' })
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }

  const digest = sha256(dmg)
  fs.writeFileSync(`${dmg}.sha256`, `${digest}  ${path.basename(dmg)}\n`)
  fs.writeFileSync(path.join(path.dirname(dmg), `README-macos-${ver}.txt`), `Paste ${ver} macOS .dmg (${ARCH}${signed ? ', signed+notarized' : ', UNSIGNED dev/CI build'})

Install: open the .dmg and drag Paste to Applications.

Paste runs on the Pear runtime (by Holepunch). Install it once:
  npm i -g pear
  pear run pear://runtime

Then open Paste. The launcher resolves the production app link:
  ${APP_LINK}
${signed ? '' : '\nUNSIGNED build: right-click Paste → Open the first time (Gatekeeper).\n'}App updates flow peer-to-peer over the link — this launcher rarely changes.
`)
  ok(`wrote ${path.relative(ROOT, dmg)}`)
  ok(`wrote ${path.relative(ROOT, `${dmg}.sha256`)}`)
  return dmg
}

// ---- Sign + notarize (Tier 2 — Developer ID) ------------------------------
function signNotarize (app, dry) {
  if (process.platform !== 'darwin') {
    warn('macOS signing/notarization must run on macOS; skipping on ' + process.platform)
    return null
  }
  const identity = process.env.PEARPASTE_MAC_IDENTITY
  if (!identity) {
    if (dry) { warn('(dry-run) --release would FAIL CLOSED without PEARPASTE_MAC_IDENTITY.') } else { die('release requires PEARPASTE_MAC_IDENTITY ("Developer ID Application: <Name> (<TEAM>)") — fail closed (spec §17). Use --build for an unsigned dev/CI .dmg.') }
  }
  let notaryAuth = null
  if (process.env.PEARPASTE_NOTARY_PROFILE) {
    notaryAuth = ['--keychain-profile', process.env.PEARPASTE_NOTARY_PROFILE]
  } else if (process.env.APPLE_ID && process.env.APPLE_TEAM_ID && process.env.APP_SPECIFIC_PASSWORD) {
    notaryAuth = ['--apple-id', process.env.APPLE_ID, '--team-id', process.env.APPLE_TEAM_ID, '--password', process.env.APP_SPECIFIC_PASSWORD]
  } else if (dry) {
    warn('(dry-run) --release would also need notarytool auth: PEARPASTE_NOTARY_PROFILE or APPLE_ID+APPLE_TEAM_ID+APP_SPECIFIC_PASSWORD.')
  } else {
    die('macOS notarization requires PEARPASTE_NOTARY_PROFILE or APPLE_ID+APPLE_TEAM_ID+APP_SPECIFIC_PASSWORD — fail closed (spec §17).')
  }
  log(`codesign --force --options runtime --timestamp --sign "$PEARPASTE_MAC_IDENTITY" "${path.relative(ROOT, app)}"`)
  if (dry) { ok('dry-run: codesign/notarytool/stapler not executed'); return makeDmg(app, true, true) }
  execFileSync('codesign', ['--force', '--options', 'runtime', '--timestamp', '--sign', identity, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  const dmg = makeDmg(app, true, false)
  execFileSync('codesign', ['--force', '--timestamp', '--sign', identity, dmg], { stdio: 'inherit' })
  log(`xcrun notarytool submit "${path.basename(dmg)}" <auth> --wait`)
  execFileSync('xcrun', ['notarytool', 'submit', dmg, ...notaryAuth, '--wait'], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
  ok(`notarized + stapled ${path.relative(ROOT, dmg)}`)
  return dmg
}

// ---- Preflight -------------------------------------------------------------
function preflight () {
  log('macOS build preflight (launcher model)')
  let fatal = 0

  const icns = path.join(ROOT, 'assets', `${PRODUCT_NAME}.icns`)
  if (fs.existsSync(icns)) ok('assets/Paste.icns present (app icon)')
  else warn('assets/Paste.icns missing — launcher will use a default icon')

  if (/^pear:\/\/[a-z0-9]+$/i.test(APP_LINK)) ok(`app link well-formed (${APP_LINK.slice(0, 24)}…)`)
  else { warn(`app link looks malformed: ${APP_LINK}`); fatal++ }

  if (hasBin('pear')) ok('`pear` runtime on PATH (end users also need it installed)')
  else warn('`pear` not on PATH here — end users must `npm i -g pear`; the launcher shows an install dialog if absent')

  if (process.platform === 'darwin') {
    ok(`host platform darwin/${process.arch}`)
    if (hasBin('hdiutil')) ok('hdiutil present (for the .dmg)')
    else { warn('hdiutil missing — cannot create the .dmg'); fatal++ }
    if (hasBin('codesign')) ok('codesign present (Tier 2 signing)')
    else warn('codesign missing — release signing unavailable')
    if (hasBin('xcrun')) ok('xcrun present (notarytool/stapler)')
    else warn('xcrun missing — notarization unavailable')
  } else {
    warn(`running on ${process.platform}; the .dmg/sign/notarize steps must run on macOS (or CI macos-latest)`)
  }

  console.log('')
  if (fatal === 0) ok('PREFLIGHT PASS — launcher .dmg is buildable; users run it with the Pear runtime installed')
  else die(`PREFLIGHT had ${fatal} blocking issue(s)`)
}

// ---- main ------------------------------------------------------------------
log(`mode=${MODE} platform=${process.platform} arch=${process.arch} target-arch=${ARCH}`)
if (MODE === 'preflight') {
  preflight()
} else if (MODE === 'dry-run') {
  preflight()
  console.log('')
  const app = buildLauncherApp(true)
  log('--build would then:'); makeDmg(app, false, true)
  console.log('')
  log('--release would instead:'); signNotarize(app, true)
} else if (MODE === 'build') {
  if (process.platform !== 'darwin') die('--build (the .dmg step) must run on macOS (or CI macos-latest)')
  warn('UNSIGNED build: emitting a dev/CI .dmg WITHOUT codesign/notarization — Gatekeeper will quarantine it. Use --release for a signed, notarized build.')
  const app = buildLauncherApp(false)
  makeDmg(app, false, false)
} else if (MODE === 'release') {
  if (process.platform !== 'darwin') die('--release (sign + notarize) must run on macOS (or CI macos-latest)')
  const app = buildLauncherApp(false)
  signNotarize(app, false)
}
