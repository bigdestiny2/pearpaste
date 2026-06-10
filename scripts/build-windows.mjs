// Paste — Windows build orchestrator.
//
// Spec refs: §12 (desktop packaging: Pear binary-wrapper path for Windows),
// §17 (release; sign Windows artifacts; preserve Pear P2P update path),
// §21 Agent 3 (desktop distribution). Companion: docs/RELEASE.md §3.
//
// Verified against Pear v0.3243 (`pear stage --help`, `pear build --help`):
//   - `pear stage <link> [dir]` syncs disk changes into a project link. It has
//     NO platform-app flags. (`pear init`/`pear release` were removed.)
//   - `pear build --win32-x64-app <app-dir> [--target <dir>]` packages an
//     ALREADY-BUILT win32 app dir into the deployment folder. Pear enforces
//     `basename(app) === (package.json productName ?? name)`; here we pin
//     `productName: "Paste"`, so the expected app dir basename is `Paste`.
//
// Paste is a Pear app. There are two Windows distribution tiers:
//
//   Tier 1 (v1, P2P link — produced from ANY OS incl. macOS):
//     `pear stage <link>` publishes the app to a pear:// link. A Windows user
//     runs `pear run pear://<key>`. Pear fetches the win32-x64 runtime + the
//     win32-x64 native prebuilds automatically (pear-electron/pre injects
//     `pear.assets.ui` with `/by-arch/%%HOST%%` + `/prebuilds/%%HOST%%`, and
//     sodium-native ships a win32-x64 prebuild). No cross-compile needed.
//
//   Tier 2 (v1.5, standalone signed installer):
//     `pear build --win32-x64-app <app-dir>` (package the platform app) +
//     Authenticode signtool over the produced .exe + an installer. This
//     REQUIRES a Windows host (or CI windows-latest) and a real code-signing
//     certificate — out of repo scope per spec §17. The steps are scripted and
//     gated here; they fail closed without a cert.
//
// This script is safe to run from macOS for preflight/dry-run. The signing
// and installer steps only execute on win32 with the cert env present.
//
// Usage:
//   node scripts/build-windows.mjs --preflight        # readiness report (any OS)
//   node scripts/build-windows.mjs --dry-run           # show the plan, no writes
//   node scripts/build-windows.mjs --stage --link pear://<key>
//   node scripts/build-windows.mjs --build --wrapper <dir>          # UNSIGNED .exe (dev/CI)
//   node scripts/build-windows.mjs --release --link pear://<key>   # build + sign
//
// --build (or --release --unsigned, which is REJECTED) is the dev/CI escape
// hatch: it runs `pear build --win32-x64-app` to package the app dir but SKIPS
// Authenticode signing, emitting a clearly-marked unsigned artifact. It does NOT
// weaken --release: a signed release still FAILS CLOSED without PEARPASTE_WIN_CERT.
//
// Env:
//   PEARPASTE_LINK            pear:// link (or channel) to stage to
//   PEARPASTE_WIN_CERT        path to the Authenticode .pfx (Tier 2 signing)
//   PEARPASTE_WIN_CERT_PASS   password for the .pfx
//   PEARPASTE_WIN_WRAPPER     path to a prebuilt win32-x64 pear-electron app dir
//                             (its basename must be the product name "Paste")
//   PEARPASTE_WIN_TSA         RFC3161 timestamp authority URL (optional override)

import { execFileSync } from 'child_process'
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
  : has('--build') ? 'build' : has('--stage') ? 'stage' : has('--dry-run') ? 'dry-run' : 'preflight'
// Explicit dev/CI escape hatch: package the platform app dir (the .exe) WITHOUT
// Authenticode signing, clearly marked. --build implies unsigned. --unsigned is
// accepted as an intent marker but MUST NOT combine with --release (a signed
// release must fail closed without a cert).
const UNSIGNED = has('--unsigned') || MODE === 'build'
const LINK = val('--link', 'PEARPASTE_LINK')
const PEAR_BIN = process.platform === 'win32' && process.env.APPDATA
  ? path.join(process.env.APPDATA, 'pear', 'current', 'by-arch', 'win32-x64', 'bin', 'pear-runtime.exe')
  : 'pear'
// Deliberate product/display name. `pear build` requires the platform app dir's
// basename to equal (package.json) productName ?? name; we pin productName to
// "Paste" so the win32 app dir + .exe path are predictable for signing.
const PRODUCT_NAME = 'Paste'
// RFC3161 timestamp authority used by signtool (`/tr`). Overridable via env so a
// maintainer can point at their CA's TSA without editing the script.
const TSA_URL = process.env.PEARPASTE_WIN_TSA || 'http://timestamp.digicert.com'
const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }
const log = (m) => console.log(`[win] ${m}`)
const ok = (m) => console.log(`${C.ok}[win:ok]${C.x} ${m}`)
const warn = (m) => console.log(`${C.warn}[win:warn]${C.x} ${m}`)
const die = (m) => { console.error(`${C.err}[win:error]${C.x} ${m}`); process.exit(1) }

if (has('--unsigned') && MODE === 'release') {
  die('--unsigned cannot be combined with --release (a signed release must fail closed without an Authenticode cert); use --build for an unsigned dev/CI .exe')
}

// ---- Preflight: everything verifiable from any OS --------------------------
function preflight () {
  log('Windows build preflight')
  let fatal = 0

  // 1. sodium-native is the only true native addon; needs a win32-x64 prebuild.
  const sodPre = path.join(ROOT, 'node_modules/sodium-native/prebuilds')
  const winPb = fs.existsSync(sodPre) && fs.readdirSync(sodPre).filter(d => d.startsWith('win32'))
  if (winPb && winPb.length) ok(`sodium-native win32 prebuilds: ${winPb.join(', ')}`)
  else { die('sodium-native has NO win32 prebuild — Windows runtime would fail'); fatal++ }

  // 2. Remaining deps must be pure-JS (no node-gyp on the Windows user box).
  const nativeOther = []
  for (const d of safeReaddir(path.join(ROOT, 'node_modules'))) {
    if (d === 'sodium-native' || d.startsWith('.')) continue
    const pj = path.join(ROOT, 'node_modules', d, 'binding.gyp')
    if (fs.existsSync(pj)) nativeOther.push(d)
  }
  if (nativeOther.length === 0) ok('no other native (node-gyp) deps — pure-JS + Bare')
  else warn(`native deps to verify win32 prebuilds for: ${nativeOther.join(', ')}`)

  // 3. pear-electron runtime asset (the win32 UI binary source, fetched P2P).
  let assets = null
  try {
    const pe = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/pear-electron/package.json'), 'utf8'))
    assets = pe.pear && pe.pear.assets && pe.pear.assets.ui
  } catch (_) {}
  if (assets && assets.link) {
    ok(`pear-electron UI asset link present (${assets.link.slice(0, 28)}…)`)
    if (String(assets.only || '').includes('%%HOST%%') || JSON.stringify(assets.only).includes('%%HOST%%')) {
      ok('asset `only` uses %%HOST%% → Pear fetches win32-x64 runtime on the Windows box')
    }
  } else { warn('pear-electron pear.assets.ui not found — Windows runtime fetch unverified'); fatal++ }

  // 4. pre step is configured (auto-injects the assets at stage time).
  let pre = null
  try { pre = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).pear?.pre } catch (_) {}
  if (pre === 'pear-electron/pre') ok('pear.pre = pear-electron/pre (injects win32 assets at stage)')
  else warn(`pear.pre is ${JSON.stringify(pre)} — expected "pear-electron/pre"`)

  // 5. Bare-safe code: no unguarded Node-only globals in worker-reachable code
  //    (process/AbortController/Buffer) — these break on the Bare runtime.
  const offenders = grepUnguarded()
  if (offenders.length === 0) ok('no unguarded Node-only globals in backend (Bare-safe)')
  else { warn(`unguarded Node-only globals (will fail on Bare/Windows):\n  ${offenders.join('\n  ')}`); fatal++ }

  // 6. `pear` runtime available (needed to stage; not to preflight).
  try {
    execFileSync(PEAR_BIN, ['--help'], { stdio: 'ignore' })
    ok('`pear` runtime on PATH')
  } catch (_) { warn('`pear` not on PATH — required for --stage/--release') }

  console.log('')
  if (fatal === 0) ok('PREFLIGHT PASS — app is Windows-capable; `pear stage` yields a win-runnable pear:// link')
  else die(`PREFLIGHT had ${fatal} blocking issue(s) — fix before a Windows build`)
  console.log(`${C.dim}Tier 1 (P2P): pear stage <link> → Windows users 'pear run pear://<key>'.`)
  console.log(`Tier 2 (.exe): needs Windows host + Authenticode cert (see docs/RELEASE.md §3).${C.x}`)
}

function safeReaddir (p) { try { return fs.readdirSync(p) } catch (_) { return [] } }

function grepUnguarded () {
  const files = [
    'backend/index.js', 'backend/desktop-worker.mjs', 'backend/verifier.js',
    'backend/relay-service.js', 'backend/notes-service.js', 'backend/autobase-sync.js',
    'backend/materialized-view.js', 'backend/vault-store.js', 'backend/lifecycle-scope.js',
    'backend/crypto-envelope.js', 'backend/identity.js', 'backend/pairing.js',
    'backend/shared-ops.js', 'backend/rpc.js', 'backend/clipboard.js'
  ]
  // Real Bare-incompatible USAGES only (not the bare word in a comment/string):
  //   process.x | new AbortController | AbortController( | Buffer. | new Buffer
  //   | Buffer( | setImmediate( | __dirname | __filename
  const re = /(?:[^.\w]process\.)|(?:\bnew\s+AbortController\b)|(?:\bAbortController\s*\()|(?:[^.\w]Buffer\.)|(?:\bnew\s+Buffer\b)|(?:[^.\w]Buffer\s*\()|(?:\bsetImmediate\s*\()|(?:\b__dirname\b)|(?:\b__filename\b)/
  const stripComments = (ln) => ln.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '')
  // A usage is GUARDED if a typeof/globalThis guard for the same global is in
  // scope. Guards frequently live on a preceding line of the same logical
  // expression (e.g. `typeof process !== 'undefined' &&\n  process.env && ...`),
  // so we test each code line joined with its guard context, not in isolation.
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
      // Build guard context: this line plus contiguous preceding lines that are
      // part of the same boolean expression (each ends with a `&&` / `||`).
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

// ---- Stage (Tier 1) -------------------------------------------------------
// `pear stage <link> [dir]` (verified: pear stage --help, v0.3243). It has NO
// platform-app flag — the Tier-1 deliverable is just the staged pear:// link.
function stage (dry) {
  // A real stage needs a link; a dry run only previews the plan, so fall back
  // to a placeholder so `build:win:dry` works with no PEARPASTE_LINK set.
  let link = LINK
  if (!link) {
    if (!dry) die('no link: pass --link pear://<key> or set PEARPASTE_LINK (run `pear stage <channel>` once to bootstrap it; `pear init`/`pear release` were removed)')
    link = 'pear://<production-key>'
    warn('no PEARPASTE_LINK set — dry run uses placeholder pear://<production-key>')
  }
  const args = ['stage']
  if (dry) args.push('--dry-run')
  args.push(link, '.')
  log('staging Tier 1 (P2P link). Windows users: `pear run pear://<key>` — Pear fetches the win32 runtime automatically.')
  log(`$ ${PEAR_BIN} ${args.join(' ')}`)
  if (dry) { ok('dry-run: not executed'); return }
  execFileSync(PEAR_BIN, args, { cwd: ROOT, stdio: 'inherit' })
  ok('staged')
}

// Locate the win32 .exe inside the prebuilt app dir. pear-electron lays the
// binary out as bin\<kebab>-app\<Cased>.exe; rather than hardcode a name we
// glob bin\*-app\*.exe and require exactly one match (fail closed otherwise).
function findWin32Exe (wrapper) {
  const binDir = path.join(wrapper, 'bin')
  if (!fs.existsSync(binDir)) {
    die(`no bin/ directory under the win32 app dir: ${wrapper} ` +
        '(expected pear-electron layout bin\\<App>-app\\<App>.exe)')
  }
  const candidates = []
  for (const appDir of fs.readdirSync(binDir)) {
    if (!appDir.endsWith('-app')) continue
    const full = path.join(binDir, appDir)
    if (!fs.statSync(full).isDirectory()) continue
    for (const f of fs.readdirSync(full)) {
      if (f.toLowerCase().endsWith('.exe')) candidates.push(path.join(full, f))
    }
  }
  if (candidates.length === 0) {
    die(`no bin\\*-app\\*.exe found under ${wrapper} — did 'pear build --win32-x64-app' produce the app dir?`)
  }
  if (candidates.length > 1) {
    die(`ambiguous win32 exe (${candidates.length} matches): ${candidates.join(', ')} — point PEARPASTE_WIN_WRAPPER at a single app dir`)
  }
  return candidates[0]
}

// ---- Build platform app dir + sign + installer (Tier 2 — Windows + cert) --
// Pear enforces basename(app) === productName ("Paste"), so the supplied
// wrapper dir must be named "Paste". `pear build --win32-x64-app <dir>` packages
// it into the deployment folder; then signtool signs the produced .exe.
function buildSignAndPack (dry) {
  const wrapper = val('--wrapper', 'PEARPASTE_WIN_WRAPPER')
  if (!wrapper) die(`${MODE} requires --wrapper / PEARPASTE_WIN_WRAPPER (the prebuilt win32-x64 app dir; its basename must be the product name "Paste")`)
  if (!fs.existsSync(wrapper)) die(`win32-x64 app dir not found: ${wrapper}`)
  if (path.basename(wrapper).replace(/\.[^.]*$/, '') !== PRODUCT_NAME) {
    die(`win32-x64 app dir basename must equal productName "${PRODUCT_NAME}" (pear build enforces this); got "${path.basename(wrapper)}"`)
  }
  const target = val('--target', 'PEARPASTE_WIN_TARGET') || path.join(ROOT, 'dist', 'win32')
  const buildArgs = ['build', '--win32-x64-app', wrapper, '--target', target]
  log(`$ ${PEAR_BIN} ${buildArgs.join(' ')}`)
  if (dry) {
    ok('dry-run: pear build not executed')
  } else {
    execFileSync(PEAR_BIN, buildArgs, { cwd: ROOT, stdio: 'inherit' })
    ok(`packaged win32 app dir into ${path.relative(ROOT, target)}/by-arch/win32-x64/app`)
  }

  // Unsigned dev/CI artifact (--build / --unsigned): package the app dir but
  // SKIP Authenticode signing entirely. Clearly marked; never treated as a
  // release (the CI release-guard still blocks it without a signature sidecar).
  if (UNSIGNED) {
    warn('UNSIGNED build: packaged the win32 app dir WITHOUT Authenticode signing — SmartScreen will warn ("unknown publisher"). Do NOT distribute as a release; use --release with PEARPASTE_WIN_CERT for a signed, fail-closed build.')
    if (process.platform !== 'win32') warn('(Note: on ' + process.platform + ' `pear build` packages the supplied win32 app dir; produce the .exe on a Windows host for a runnable artifact.)')
    log(`unsigned artifact dir: ${path.relative(ROOT, path.join(target, 'by-arch', 'win32-x64', 'app'))}`)
    return
  }

  // Signing must run on Windows with a real Authenticode cert — fail closed.
  if (process.platform !== 'win32') {
    warn('Authenticode signing + installer packaging must run on a Windows host (or CI windows-latest).')
    warn('Skipping sign/pack on ' + process.platform + '. Tier 1 link is the cross-platform deliverable.')
    return
  }
  const cert = process.env.PEARPASTE_WIN_CERT
  const pass = process.env.PEARPASTE_WIN_CERT_PASS
  if (!cert || !fs.existsSync(cert)) {
    die('release requires an Authenticode certificate. Set PEARPASTE_WIN_CERT (.pfx) + PEARPASTE_WIN_CERT_PASS. ' +
        'Real certs are out of repo scope (spec §17); CI release-guard blocks unsigned artifacts.')
  }
  // Sign the .exe inside the packaged app dir (glob, never hardcode the name).
  const packagedApp = path.join(target, 'by-arch', 'win32-x64', 'app')
  const exe = findWin32Exe(fs.existsSync(packagedApp) ? packagedApp : wrapper)
  log(`signtool sign /fd SHA256 /tr ${TSA_URL} /td SHA256 "${exe}"`)
  if (dry) { ok('dry-run: signtool not executed'); return }
  const signArgs = ['sign', '/f', cert]
  if (pass) signArgs.push('/p', pass)
  signArgs.push('/fd', 'SHA256', '/tr', TSA_URL, '/td', 'SHA256', exe)
  execFileSync('signtool', signArgs, { stdio: 'inherit' })
  ok(`Authenticode-signed ${path.basename(exe)}`)
  // Installer: package the signed app dir. NSIS/WiX is environment-specific;
  // documented in docs/RELEASE.md §3. Sign the installer too.
  warn('Installer packaging (NSIS/WiX) is documented in docs/RELEASE.md §3 — wire your packager here, then signtool the resulting Setup.exe with the same /fd SHA256 /tr ' + TSA_URL + ' /td SHA256 flags.')
}

// ---- main -----------------------------------------------------------------
log(`mode=${MODE} platform=${process.platform} arch=${process.arch}`)
if (MODE === 'preflight') {
  preflight()
} else if (MODE === 'dry-run') {
  preflight()
  console.log('')
  stage(true)
  // Only print the Tier-2 build/sign plan when a wrapper is supplied.
  if (val('--wrapper', 'PEARPASTE_WIN_WRAPPER')) { console.log(''); buildSignAndPack(true) }
} else if (MODE === 'stage') {
  preflight()
  stage(false)
} else if (MODE === 'build') {
  // Dev/CI: package the win32 app dir into an UNSIGNED .exe artifact. Does NOT
  // stage to the network (that's the P2P-link path); just the local Tier-2 pack.
  preflight()
  buildSignAndPack(false)
} else if (MODE === 'release') {
  preflight()
  stage(false)
  buildSignAndPack(false)
}
