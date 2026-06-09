// Paste — macOS build orchestrator.
//
// Spec refs: §12 (desktop packaging: Pear binary-wrapper path for macOS),
// §17 (release; sign + notarize macOS artifacts; preserve Pear P2P update path),
// §21 Agent 3 (desktop distribution). Companion: docs/RELEASE.md §3 +
// docs/SHIPPING.md §3. Sibling of scripts/build-windows.mjs.
//
// Verified against Pear v0.3243 (`pear --help`, `pear build --help`,
// `pear stage --help`):
//   - `pear stage <link> [dir]` syncs disk changes into a project link. It has
//     NO platform-app flags. (`pear init`/`pear release` were removed.)
//   - `pear build --darwin-arm64-app <app-dir> [--target <dir>]` packages an
//     ALREADY-BUILT darwin-arm64 app dir into the deployment folder. Pear
//     enforces `basename(app) === (package.json productName ?? name)`; here we
//     pin `productName: "Paste"`, so the expected app basename is `Paste.app`.
//     (`--darwin-x64-app` exists too; this script targets arm64 — the only Mac
//     hardware Apple still ships — and documents x64 as a one-flag change.)
//
// Paste is a Pear app. There are two macOS distribution tiers:
//
//   Tier 1 (v1, P2P link — produced from ANY OS):
//     `pear stage <link>` publishes the app to a pear:// link. A macOS user runs
//     `pear run pear://<key>`. Pear fetches the darwin-arm64 runtime + the
//     darwin-arm64 native prebuilds automatically (pear-electron/pre injects
//     `pear.assets.ui` with `/by-arch/%%HOST%%` + `/prebuilds/%%HOST%%`, and
//     sodium-native ships a darwin-arm64 prebuild). No cross-compile needed.
//
//   Tier 2 (v1.5, standalone signed + notarized .dmg):
//     `pear build --darwin-arm64-app <app-dir>` (package the platform app) +
//     `codesign` (Developer ID, hardened runtime) + `hdiutil` (the .dmg) +
//     `xcrun notarytool submit --wait` + `xcrun stapler staple`. This REQUIRES a
//     macOS host (or CI macos-latest) and a real Apple Developer ID identity +
//     notarization credentials — out of repo scope per spec §17. The steps are
//     scripted and gated here; signing FAILS CLOSED without the identity/auth.
//
// This script is safe to run from any OS for --preflight/--dry-run. The actual
// `pear build`, `hdiutil`, codesign, and notarization steps only execute on
// macOS (darwin). In --build mode it emits an UNSIGNED .dmg (clearly named, with
// a console warning) for dev/CI before a Developer ID cert is purchased; in
// --release mode it signs + notarizes and FAILS CLOSED without credentials.
//
// Usage:
//   node scripts/build-macos.mjs --preflight       # readiness report (any OS)
//   node scripts/build-macos.mjs --dry-run          # show the plan, no writes
//   node scripts/build-macos.mjs --build            # UNSIGNED .dmg (dev/CI)
//   node scripts/build-macos.mjs --release          # build + sign + notarize
//
// Env:
//   PEARPASTE_LINK            pear:// link (or channel) — recorded into the .dmg
//                             readme; the wrapper resolves it at runtime
//   PEARPASTE_MAC_APP         path to a prebuilt darwin-arm64 pear-electron app
//                             dir (its basename must be the product name
//                             "Paste"/"Paste.app"). If unset, --build/--release
//                             expect `pear build` to have produced it under the
//                             target dir.
//   PEARPASTE_MAC_IDENTITY    "Developer ID Application: <Name> (<TEAM>)"  (Tier 2)
//   notarytool auth — EITHER PEARPASTE_NOTARY_PROFILE (a stored
//     `xcrun notarytool store-credentials` keychain profile) OR
//     APPLE_ID + APPLE_TEAM_ID + APP_SPECIFIC_PASSWORD
//   PEARPASTE_MAC_TARGET      override the `pear build --target` dir
//                             (default dist/macos)
//   PEARPASTE_MAC_ARCH        darwin-arm64 (default) | darwin-x64

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
// Explicit dev/CI escape hatch. --build is already unsigned; --unsigned is
// accepted as an alias/intent marker but must NOT be combined with --release (a
// signed release cannot be "unsigned" — it must fail closed without creds).
const UNSIGNED = has('--unsigned')
const LINK = val('--link', 'PEARPASTE_LINK')
// Deliberate product/display name. `pear build` requires the platform app dir's
// basename to equal (package.json) productName ?? name; we pin productName to
// "Paste" so the darwin app dir + .app path are predictable for signing.
const PRODUCT_NAME = 'Paste'
// Target arch flag. arm64 is the default (only Mac hardware Apple ships); x64 is
// a single-flag change for older Intel Macs.
const ARCH = (val('--arch', 'PEARPASTE_MAC_ARCH') || 'darwin-arm64').replace(/^--/, '')
if (ARCH !== 'darwin-arm64' && ARCH !== 'darwin-x64') {
  console.error(`[mac:error] unsupported --arch "${ARCH}" (expected darwin-arm64 or darwin-x64)`)
  process.exit(1)
}
const BUILD_FLAG = `--${ARCH}-app`

const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }
const log = (m) => console.log(`[mac] ${m}`)
const ok = (m) => console.log(`${C.ok}[mac:ok]${C.x} ${m}`)
const warn = (m) => console.log(`${C.warn}[mac:warn]${C.x} ${m}`)
const die = (m) => { console.error(`${C.err}[mac:error]${C.x} ${m}`); process.exit(1) }

if (UNSIGNED && MODE === 'release') {
  die('--unsigned cannot be combined with --release (a signed release must fail closed without a Developer ID identity); use --build for an unsigned dev/CI .dmg')
}

function safeReaddir (p) { try { return fs.readdirSync(p) } catch (_) { return [] } }

function sha256 (absPath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(absPath))
  return hash.digest('hex')
}

function appVersion () {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0' } catch (_) { return '0.0.0' }
}

// ---- Preflight: everything verifiable from any OS --------------------------
function preflight () {
  log('macOS build preflight')
  let fatal = 0

  // 1. sodium-native is the only true native addon; needs a darwin prebuild.
  const sodPre = path.join(ROOT, 'node_modules/sodium-native/prebuilds')
  const arches = ARCH === 'darwin-x64' ? ['darwin-x64'] : ['darwin-arm64']
  const darPb = safeReaddir(sodPre).filter(d => arches.includes(d))
  if (darPb.length) ok(`sodium-native darwin prebuild(s): ${darPb.join(', ')}`)
  else { die(`sodium-native has NO ${arches.join('/')} prebuild — macOS runtime would fail`); fatal++ }

  // 2. Remaining deps must be pure-JS (no node-gyp on the user's Mac).
  const nativeOther = []
  for (const d of safeReaddir(path.join(ROOT, 'node_modules'))) {
    if (d === 'sodium-native' || d.startsWith('.')) continue
    if (fs.existsSync(path.join(ROOT, 'node_modules', d, 'binding.gyp'))) nativeOther.push(d)
  }
  if (nativeOther.length === 0) ok('no other native (node-gyp) deps — pure-JS + Bare')
  else warn(`native deps to verify darwin prebuilds for: ${nativeOther.join(', ')}`)

  // 3. pear-electron runtime asset (the darwin UI binary source, fetched P2P).
  let assets = null
  try {
    const pe = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/pear-electron/package.json'), 'utf8'))
    assets = pe.pear && pe.pear.assets && pe.pear.assets.ui
  } catch (_) {}
  if (assets && assets.link) {
    ok(`pear-electron UI asset link present (${assets.link.slice(0, 28)}…)`)
    if (String(assets.only || '').includes('%%HOST%%') || JSON.stringify(assets.only).includes('%%HOST%%')) {
      ok('asset `only` uses %%HOST%% → Pear fetches darwin runtime on the Mac')
    }
  } else { warn('pear-electron pear.assets.ui not found — macOS runtime fetch unverified'); fatal++ }

  // 4. pre step is configured (auto-injects the assets at stage time).
  let pre = null
  try { pre = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).pear?.pre } catch (_) {}
  if (pre === 'pear-electron/pre') ok('pear.pre = pear-electron/pre (injects darwin assets at stage)')
  else warn(`pear.pre is ${JSON.stringify(pre)} — expected "pear-electron/pre"`)

  // 5. macOS GUI icon present (.icns) — pear build embeds it into the .app.
  const icns = path.join(ROOT, 'assets', 'Paste.icns')
  if (fs.existsSync(icns)) ok('assets/Paste.icns present (macOS app icon)')
  else warn('assets/Paste.icns missing — the .app will use a default icon')

  // 6. Bare-safe code: no unguarded Node-only globals in worker-reachable code
  //    (process/AbortController/Buffer) — these break on the Bare runtime.
  const offenders = grepUnguarded()
  if (offenders.length === 0) ok('no unguarded Node-only globals in backend (Bare-safe)')
  else { warn(`unguarded Node-only globals (will fail on Bare):\n  ${offenders.join('\n  ')}`); fatal++ }

  // 7. `pear` runtime available (needed to build; not to preflight).
  try {
    execFileSync('pear', ['--help'], { stdio: 'ignore' })
    ok('`pear` runtime on PATH')
  } catch (_) { warn('`pear` not on PATH — required for --build/--release') }

  // 8. host tooling for the .dmg / signing (only matters on darwin).
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
  if (fatal === 0) ok('PREFLIGHT PASS — app is macOS-capable; `pear stage` yields a mac-runnable pear:// link')
  else die(`PREFLIGHT had ${fatal} blocking issue(s) — fix before a macOS build`)
  console.log(`${C.dim}Tier 1 (P2P): pear stage <link> → macOS users 'pear run pear://<key>'.`)
  console.log(`Tier 2 (.dmg): --build emits an UNSIGNED .dmg; --release needs Developer ID + notarytool auth (docs/RELEASE.md §3).${C.x}`)
}

function hasBin (cmd) {
  try { execFileSync('command', ['-v', cmd], { stdio: 'ignore', shell: '/bin/sh' }); return true } catch (_) {}
  try { execFileSync(cmd, ['-h'], { stdio: 'ignore' }); return true } catch (_) { return false }
}

// Shared with build-windows.mjs by intent (kept in sync): flag the few real
// Bare-incompatible global USAGES (not the bare word in a comment/string).
function grepUnguarded () {
  const files = [
    'backend/index.js', 'backend/desktop-worker.mjs', 'backend/verifier.js',
    'backend/relay-service.js', 'backend/notes-service.js', 'backend/autobase-sync.js',
    'backend/materialized-view.js', 'backend/vault-store.js', 'backend/lifecycle-scope.js',
    'backend/crypto-envelope.js', 'backend/identity.js', 'backend/pairing.js',
    'backend/shared-ops.js', 'backend/rpc.js', 'backend/clipboard.js'
  ]
  const re = /(?:[^.\w]process\.)|(?:\bnew\s+AbortController\b)|(?:\bAbortController\s*\()|(?:[^.\w]Buffer\.)|(?:\bnew\s+Buffer\b)|(?:[^.\w]Buffer\s*\()|(?:\bsetImmediate\s*\()|(?:\b__dirname\b)|(?:\b__filename\b)/
  const stripComments = (ln) => ln.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
  const guarded = (ctx) =>
    /typeof\s+(process|AbortController|Buffer)\s*!==?\s*['"]undefined['"]/.test(ctx) ||
    /globalThis\.(process|AbortController|Buffer)/.test(ctx)
  const out = []
  for (const rel of files) {
    const fp = path.join(ROOT, rel)
    if (!fs.existsSync(fp)) continue
    const lines = fs.readFileSync(fp, 'utf8').split('\n')
    const codeLines = lines.map(stripComments)
    lines.forEach((ln, i) => {
      const s = ln.trim()
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return
      const code = codeLines[i]
      if (!code.trim()) return
      let ctx = code
      for (let j = i - 1; j >= 0; j--) {
        const prev = codeLines[j].trimEnd()
        if (!prev.trim()) break
        ctx = prev + '\n' + ctx
        if (!/(\|\||&&)\s*$/.test(prev)) break
      }
      if (guarded(ctx)) return
      if (re.test(code)) out.push(`${rel}:${i + 1}: ${s.slice(0, 80)}`)
    })
  }
  return out
}

// Locate the produced .app. `pear build --darwin-arm64-app <dir> --target <t>`
// lays the packaged app out under <t>/by-arch/<arch>/app/<Product>.app (mirrors
// the win32 by-arch layout). We glob by-arch/<arch>/app/*.app and require
// exactly one match (fail closed otherwise). Falls back to the supplied wrapper.
function findApp (target, wrapper) {
  const packagedDir = path.join(target, 'by-arch', ARCH, 'app')
  const search = fs.existsSync(packagedDir) ? packagedDir : wrapper
  if (!search || !fs.existsSync(search)) {
    die(`no packaged app dir found (looked in ${path.relative(ROOT, packagedDir)} and the wrapper) — did 'pear build ${BUILD_FLAG}' run?`)
  }
  // If the search path is itself the .app, use it directly.
  if (search.endsWith('.app') && fs.existsSync(search)) return search
  const candidates = safeReaddir(search)
    .filter(f => f.endsWith('.app'))
    .map(f => path.join(search, f))
  if (candidates.length === 0) die(`no *.app found under ${search} — 'pear build ${BUILD_FLAG}' did not produce the app bundle`)
  if (candidates.length > 1) die(`ambiguous .app (${candidates.length} matches): ${candidates.join(', ')} — point PEARPASTE_MAC_APP at a single bundle`)
  return candidates[0]
}

// ---- Build the platform app dir via `pear build` --------------------------
// Verified flag: `pear build --darwin-arm64-app <app-dir> --target <dir>`.
// Pear enforces basename(app) === productName ("Paste"), so the supplied/produced
// app bundle must be named "Paste.app". Returns the target dir.
function pearBuild (dry) {
  const wrapper = val('--app', 'PEARPASTE_MAC_APP')
  const target = val('--target', 'PEARPASTE_MAC_TARGET') || path.join(ROOT, 'dist', 'macos')
  const buildArgs = ['build', BUILD_FLAG]
  if (wrapper) {
    // Validate the basename matches productName BEFORE invoking pear (it enforces
    // the same rule, but our message is friendlier and fails earlier).
    if (!fs.existsSync(wrapper)) die(`darwin app dir not found: ${wrapper}`)
    const base = path.basename(wrapper).replace(/\.app$/, '')
    if (base !== PRODUCT_NAME) {
      die(`darwin app dir basename must equal productName "${PRODUCT_NAME}" (pear build enforces this); got "${path.basename(wrapper)}"`)
    }
    buildArgs.push(wrapper)
  } else {
    // No prebuilt wrapper supplied. `pear build` still needs an app-dir path
    // argument; without one we cannot proceed in a real run.
    // TODO(verify pear): confirm whether `pear build --darwin-arm64-app` can
    // synthesize the .app from the staged project alone, or always requires a
    // pre-staged pear-electron app dir as the path argument. Until verified,
    // require PEARPASTE_MAC_APP so we never invent a flag/behaviour.
    if (!dry) die('set PEARPASTE_MAC_APP to the prebuilt darwin app dir (basename "Paste"); pear build requires the platform app-dir path argument')
    buildArgs.push(path.join('<path-to>', `${PRODUCT_NAME}.app`))
  }
  buildArgs.push('--target', target)
  log(`$ pear ${buildArgs.join(' ')}`)
  if (dry) { ok('dry-run: pear build not executed'); return target }
  execFileSync('pear', buildArgs, { cwd: ROOT, stdio: 'inherit' })
  ok(`packaged darwin app into ${path.relative(ROOT, target)}/by-arch/${ARCH}/app`)
  return target
}

// ---- Create the .dmg (hdiutil) --------------------------------------------
// Produces <dist>/<name>.dmg from the .app. In --build mode the name carries an
// explicit "-unsigned" marker; in --release mode it is signed + notarized.
function makeDmg (app, signed, dry) {
  const ver = appVersion()
  const distDir = path.dirname(path.dirname(path.dirname(path.dirname(app)))) // .../dist/macos (best-effort)
  const outDir = process.env.PEARPASTE_DIST_DIR
    ? path.join(ROOT, process.env.PEARPASTE_DIST_DIR)
    : (fs.existsSync(distDir) ? distDir : path.join(ROOT, 'dist', 'macos'))
  const dmgName = signed ? `${PRODUCT_NAME}-${ver}.dmg` : `${PRODUCT_NAME}-${ver}-unsigned.dmg`
  const dmg = path.join(outDir, dmgName)
  log(`hdiutil create -volname "${PRODUCT_NAME}" -srcfolder "${app}" -ov -format UDZO "${dmg}"`)
  if (dry) { ok('dry-run: hdiutil not executed'); return dmg }
  fs.mkdirSync(outDir, { recursive: true })
  fs.rmSync(dmg, { force: true })
  execFileSync('hdiutil', ['create', '-volname', PRODUCT_NAME, '-srcfolder', app, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' })
  const digest = sha256(dmg)
  fs.writeFileSync(`${dmg}.sha256`, `${digest}  ${path.basename(dmg)}\n`)
  // Record which pear:// link this wrapper resolves (the .app embeds the runtime
  // and resolves the link at launch; this is operator documentation only).
  const link = LINK || 'pear://<production-key>'
  fs.writeFileSync(path.join(outDir, `README-macos-${ver}.txt`), `Paste ${ver} macOS .dmg (${ARCH}${signed ? ', signed+notarized' : ', UNSIGNED dev/CI build'})

This .dmg wraps the Pear runtime and resolves the production link:
  ${link}

${signed ? 'Signed with a Developer ID identity and notarized + stapled.' : 'UNSIGNED: Gatekeeper will quarantine this build. Internal/dev use only.'}
The Pear P2P update path stays intact: app content updates flow over the
pear:// link, so this wrapper rarely needs to be rebuilt.
`)
  ok(`wrote ${path.relative(ROOT, dmg)}`)
  ok(`wrote ${path.relative(ROOT, `${dmg}.sha256`)}`)
  return dmg
}

// ---- Sign + notarize (Tier 2 — macOS + Developer ID) ----------------------
// codesign the .app (hardened runtime) → build the .dmg → codesign the .dmg →
// notarytool submit --wait → stapler staple. FAILS CLOSED without the identity
// and notarytool auth. Returns the stapled .dmg path.
function signNotarize (app, dry) {
  if (process.platform !== 'darwin') {
    warn('macOS signing/notarization must run on macOS; skipping on ' + process.platform + '. Tier 1 link is the cross-platform deliverable.')
    return null
  }
  // In --dry-run we only PREVIEW the plan, so missing creds must NOT exit the
  // process — they would in a real --release (fail closed). Surface what would
  // be required and continue printing the plan.
  const identity = process.env.PEARPASTE_MAC_IDENTITY
  if (!identity) {
    if (dry) { warn('(dry-run) --release would FAIL CLOSED here without PEARPASTE_MAC_IDENTITY ("Developer ID Application: <Name> (<TEAM>)").') } else { die('release requires PEARPASTE_MAC_IDENTITY ("Developer ID Application: <Name> (<TEAM>)") — fail closed (spec §17). Use --build for an unsigned dev/CI .dmg.') }
  }
  // notarytool auth: a stored keychain profile OR the Apple-ID triple. Fail closed.
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
  log(`codesign --deep --force --options runtime --timestamp --sign "$PEARPASTE_MAC_IDENTITY" "${app}"`)
  log('codesign --verify --deep --strict --verbose=2 <app>')
  if (dry) { ok('dry-run: codesign/notarytool/stapler not executed'); return makeDmg(app, true, true) }
  // 1. Sign the .app with hardened runtime + secure timestamp.
  execFileSync('codesign', ['--deep', '--force', '--options', 'runtime', '--timestamp', '--sign', identity, app], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' })
  // 2. Build the .dmg around the signed .app.
  const dmg = makeDmg(app, true, false)
  // 3. Sign the .dmg itself.
  execFileSync('codesign', ['--force', '--timestamp', '--sign', identity, dmg], { stdio: 'inherit' })
  // 4. Notarize + staple.
  log(`xcrun notarytool submit "${dmg}" <auth> --wait`)
  execFileSync('xcrun', ['notarytool', 'submit', dmg, ...notaryAuth, '--wait'], { stdio: 'inherit' })
  execFileSync('xcrun', ['stapler', 'staple', dmg], { stdio: 'inherit' })
  ok(`notarized + stapled ${path.relative(ROOT, dmg)}`)
  warn('A notarized+stapled .dmg is a release artifact — the CI release-guard still expects a detached signature sidecar (.sig/.asc/.minisig/.p7s) next to it; produce one in the release lane.')
  return dmg
}

// ---- main -----------------------------------------------------------------
log(`mode=${MODE} platform=${process.platform} arch=${process.arch} target-arch=${ARCH}`)
if (MODE === 'preflight') {
  preflight()
} else if (MODE === 'dry-run') {
  preflight()
  console.log('')
  const target = pearBuild(true)
  const app = path.join(target, 'by-arch', ARCH, 'app', `${PRODUCT_NAME}.app`)
  console.log('')
  // Show both the unsigned (--build) and signed (--release) tails of the plan.
  log('--build would then:')
  makeDmg(app, false, true)
  console.log('')
  log('--release would instead:')
  signNotarize(app, true)
} else if (MODE === 'build') {
  // Dev/CI: produce an UNSIGNED .dmg. No identity required.
  if (process.platform !== 'darwin') die('--build (the .dmg step) must run on macOS (or CI macos-latest)')
  warn('UNSIGNED build: emitting a dev/CI .dmg WITHOUT codesign/notarization — Gatekeeper will quarantine it. Do NOT distribute as a release; use --release for a signed, notarized, fail-closed build.')
  const target = pearBuild(false)
  const app = findApp(target, val('--app', 'PEARPASTE_MAC_APP'))
  makeDmg(app, false, false)
} else if (MODE === 'release') {
  if (process.platform !== 'darwin') die('--release (sign + notarize) must run on macOS (or CI macos-latest)')
  const target = pearBuild(false)
  const app = findApp(target, val('--app', 'PEARPASTE_MAC_APP'))
  signNotarize(app, false)
}
