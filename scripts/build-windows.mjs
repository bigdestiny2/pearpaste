// Paste — Windows build orchestrator.
//
// Spec refs: §12 (desktop packaging: Pear binary-wrapper path for Windows),
// §17 (release; sign Windows artifacts; preserve Pear P2P update path),
// §21 Agent 3 (desktop distribution). Companion: docs/RELEASE.md §3.
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
//   Tier 2 (v1.5, standalone signed PearPaste-Setup.exe):
//     `pear stage <link> --win32-x64-app <wrapper>` + Authenticode signtool +
//     an installer. This REQUIRES a Windows host (or CI windows-latest) and a
//     real code-signing certificate — out of repo scope per spec §17. The
//     steps are scripted and gated here; they fail closed without a cert.
//
// This script is safe to run from macOS for preflight/dry-run. The signing
// and installer steps only execute on win32 with the cert env present.
//
// Usage:
//   node scripts/build-windows.mjs --preflight        # readiness report (any OS)
//   node scripts/build-windows.mjs --dry-run           # show the plan, no writes
//   node scripts/build-windows.mjs --stage --link pear://<key>
//   node scripts/build-windows.mjs --release --link pear://<key>   # win32 + sign
//
// Env:
//   PEARPASTE_LINK            pear:// link (or channel) to stage to
//   PEARPASTE_WIN_CERT        path to the Authenticode .pfx (Tier 2 signing)
//   PEARPASTE_WIN_CERT_PASS   password for the .pfx
//   PEARPASTE_WIN_WRAPPER     path to a prebuilt win32-x64 pear-electron app

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
  : has('--stage') ? 'stage' : has('--dry-run') ? 'dry-run' : 'preflight'
const LINK = val('--link', 'PEARPASTE_LINK')
const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }
const log = (m) => console.log(`[win] ${m}`)
const ok = (m) => console.log(`${C.ok}[win:ok]${C.x} ${m}`)
const warn = (m) => console.log(`${C.warn}[win:warn]${C.x} ${m}`)
const die = (m) => { console.error(`${C.err}[win:error]${C.x} ${m}`); process.exit(1) }

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
    execFileSync('pear', ['--help'], { stdio: 'ignore' })
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
  const out = []
  for (const rel of files) {
    const fp = path.join(ROOT, rel)
    if (!fs.existsSync(fp)) continue
    const lines = fs.readFileSync(fp, 'utf8').split('\n')
    lines.forEach((ln, i) => {
      const s = ln.trim()
      if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return
      const code = stripComments(ln)
      if (!code.trim()) return
      if (/typeof\s+(process|AbortController|Buffer)\s*!==?\s*['"]undefined['"]/.test(code)) return
      if (/globalThis\.(process|AbortController|Buffer)/.test(code)) return
      if (re.test(code)) out.push(`${rel}:${i + 1}: ${s.slice(0, 80)}`)
    })
  }
  return out
}

// ---- Stage (Tier 1) -------------------------------------------------------
function stage (dry) {
  if (!LINK) die('no link: pass --link pear://<key> or set PEARPASTE_LINK (run `pear stage <channel>` once to bootstrap it; `pear init` was removed)')
  const wrapper = val('--wrapper', 'PEARPASTE_WIN_WRAPPER')
  const args = ['stage']
  if (dry) args.push('--dry-run')
  args.push(LINK, '.')
  if (wrapper) {
    if (!fs.existsSync(wrapper)) die(`--win32-x64-app path not found: ${wrapper}`)
    args.push('--win32-x64-app', wrapper)
    log(`staging WITH standalone win32 wrapper: ${wrapper}`)
  } else {
    log('staging Tier 1 (P2P link). Windows users: `pear run pear://<key>` — Pear fetches the win32 runtime automatically.')
  }
  log(`$ pear ${args.join(' ')}`)
  if (dry) { ok('dry-run: not executed'); return }
  execFileSync('pear', args, { cwd: ROOT, stdio: 'inherit' })
  ok('staged')
}

// ---- Sign + installer (Tier 2 — Windows host + cert) ----------------------
function signAndPack () {
  if (process.platform !== 'win32') {
    warn('Authenticode signing + installer packaging must run on a Windows host (or CI windows-latest).')
    warn('Skipping sign/pack on ' + process.platform + '. Tier 1 link is the cross-platform deliverable.')
    return
  }
  const cert = process.env.PEARPASTE_WIN_CERT
  const pass = process.env.PEARPASTE_WIN_CERT_PASS
  const wrapper = val('--wrapper', 'PEARPASTE_WIN_WRAPPER')
  if (!cert || !fs.existsSync(cert)) {
    die('release requires an Authenticode certificate. Set PEARPASTE_WIN_CERT (.pfx) + PEARPASTE_WIN_CERT_PASS. ' +
        'Real certs are out of repo scope (spec §17); CI release-guard blocks unsigned artifacts.')
  }
  if (!wrapper) die('release requires --wrapper / PEARPASTE_WIN_WRAPPER (the staged win32-x64 app dir)')
  const exe = path.join(wrapper, 'PearPaste.exe')
  log(`signtool sign /f ${cert} /fd SHA256 /tr <timestamp> /td SHA256 "${exe}"`)
  execFileSync('signtool', ['sign', '/f', cert, '/p', pass || '', '/fd', 'SHA256',
    '/tr', 'http://timestamp.digicert.com', '/td', 'SHA256', exe], { stdio: 'inherit' })
  ok('Authenticode-signed PearPaste.exe')
  // Installer: package the signed app dir. NSIS/WiX is environment-specific;
  // documented in docs/RELEASE.md §3. Sign the installer too.
  warn('Installer packaging (NSIS/WiX) is documented in docs/RELEASE.md §3 — wire your packager here, then signtool the resulting Setup.exe.')
}

// ---- main -----------------------------------------------------------------
log(`mode=${MODE} platform=${process.platform} arch=${process.arch}`)
if (MODE === 'preflight') { preflight() } else if (MODE === 'dry-run') { preflight(); console.log(''); stage(true) } else if (MODE === 'stage') { preflight(); stage(false) } else if (MODE === 'release') { preflight(); stage(false); signAndPack() }
