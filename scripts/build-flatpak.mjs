#!/usr/bin/env node
// PearPaste Flatpak builder — SPIKE.
//
// WHY: a pear-electron desktop app embeds Electron/Chromium (glibc >= 2.32), so
// the .deb / AppImage / `pear run` launcher all fail on Ubuntu 20.04 (glibc 2.31)
// and older. A Flatpak builds against the Freedesktop runtime, which carries its
// OWN glibc inside the sandbox — so the same artifact runs on those old hosts.
// This is the one packaging model that widens Linux reach below the glibc floor.
//
// FLOW (mode=--build, on a Linux host with flatpak + flatpak-builder):
//   1. Materialize a self-contained linux-x64 pear-electron app  -> dist/flatpak/payload
//        (pear dump the pear-electron runtime, then pear build --linux-x64-app)
//      OR skip that by pointing PEARPASTE_PAYLOAD_DIR at a pre-materialized app dir.
//   2. Assemble a build context (manifest + support files + payload) -> dist/flatpak/context
//   3. flatpak-builder -> a local OSTree repo -> `flatpak build-bundle` -> Paste.flatpak
//
// Usage:
//   node scripts/build-flatpak.mjs --preflight                 # readiness (any OS)
//   node scripts/build-flatpak.mjs --dry-run                   # plan, no writes
//   PEARPASTE_LINK=pear://<key> node scripts/build-flatpak.mjs --build
//   PEARPASTE_PAYLOAD_DIR=/path/to/app node scripts/build-flatpak.mjs --build   # skip materialize
//
// STATUS: spike. The Flatpak shape (Freedesktop runtime + Electron base app +
// zypak) is standard; the `pear build --linux-x64-app` arg is the same first-build
// unknown flagged for the .exe/.dmg (docs/handover/BUILD_FLATPAK.md). When that
// step is shaky, materialize the app by hand and pass PEARPASTE_PAYLOAD_DIR.

import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FLATPAK_SRC = path.join(ROOT, 'flatpak')
const DIST = path.join(ROOT, 'dist', 'flatpak')
const APP_ID = 'global.paste.Paste'
const RUNTIME_VERSION = '24.08'
const argv = process.argv.slice(2)
const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }

const has = (flag) => argv.includes(flag)
const MODE = has('--build') ? 'build' : has('--dry-run') ? 'dry-run' : 'preflight'
const LINK = process.env.PEARPASTE_LINK
const PAYLOAD_OVERRIDE = process.env.PEARPASTE_PAYLOAD_DIR

const log = (m) => console.log(`[flatpak] ${m}`)
const ok = (m) => console.log(`${C.ok}[flatpak:ok]${C.x} ${m}`)
const warn = (m) => console.log(`${C.warn}[flatpak:warn]${C.x} ${m}`)
const die = (m) => { console.error(`${C.err}[flatpak:error]${C.x} ${m}`); process.exit(1) }

function hasCommand (cmd) {
  try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return true } catch (_) { return false }
}
function flatpakHas (ref) {
  try { execFileSync('flatpak', ['info', ref], { stdio: 'ignore' }); return true } catch (_) { return false }
}
function run (cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
}
function sha256 (p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') }

function pearElectronRuntimeLink () {
  // The pear-electron runtime is a fetched Pear app, not in node_modules; its
  // link lives in pear-electron/package.json -> pear.ui.link.
  const pe = path.join(ROOT, 'node_modules', 'pear-electron', 'package.json')
  if (!fs.existsSync(pe)) return null
  try { return JSON.parse(fs.readFileSync(pe, 'utf8'))?.pear?.ui?.link || null } catch (_) { return null }
}

function preflight () {
  log(`Flatpak preflight (mode=${MODE})`)
  let fatal = 0
  // Manifest + support files
  for (const f of [`${APP_ID}.yml`, `${APP_ID}.desktop`, `${APP_ID}.metainfo.xml`, 'paste-launcher.sh']) {
    if (fs.existsSync(path.join(FLATPAK_SRC, f))) ok(`flatpak/${f} present`)
    else { warn(`missing flatpak/${f}`); fatal++ }
  }
  // Icon (reused from the native packager's asset set)
  if (fs.existsSync(path.join(ROOT, 'assets', 'icon-512.png'))) ok('assets/icon-512.png present')
  else { warn('assets/icon-512.png missing — Flatpak will ship without a hicolor icon'); }
  // Tooling
  for (const cmd of ['flatpak', 'flatpak-builder']) {
    if (hasCommand(cmd)) ok(`${cmd} on PATH`)
    else { warn(`${cmd} not on PATH (apt install ${cmd})`); fatal++ }
  }
  // Runtime + SDK + Electron base app (host-glibc-independent; install from Flathub)
  const refs = [
    `runtime/org.freedesktop.Platform/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}/${RUNTIME_VERSION}`,
    `runtime/org.freedesktop.Sdk/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}/${RUNTIME_VERSION}`,
    `runtime/org.electronjs.Electron2.BaseApp/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}/${RUNTIME_VERSION}`
  ]
  for (const ref of refs) {
    if (flatpakHas(ref)) ok(`installed: ${ref}`)
    else warn(`not installed: ${ref} — flatpak install flathub ${ref.split('/').slice(1).join('/').replace(`/${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`, '')}//${RUNTIME_VERSION}`)
  }
  // Materialization inputs
  if (PAYLOAD_OVERRIDE) {
    if (fs.existsSync(PAYLOAD_OVERRIDE)) ok(`PEARPASTE_PAYLOAD_DIR set -> ${PAYLOAD_OVERRIDE} (materialize step skipped)`)
    else { warn(`PEARPASTE_PAYLOAD_DIR points at a missing dir: ${PAYLOAD_OVERRIDE}`); fatal++ }
  } else {
    if (hasCommand('pear')) ok('pear runtime on PATH (for materialize)')
    else warn('pear not on PATH — needed to materialize the payload (or set PEARPASTE_PAYLOAD_DIR)')
    const link = pearElectronRuntimeLink()
    if (link) ok(`pear-electron runtime link: ${link}`)
    else warn('could not read pear-electron runtime link (npm ci first?)')
    if (!LINK) warn('PEARPASTE_LINK unset — required to bake the production app link into the build')
  }
  if (process.platform !== 'linux') warn(`running on ${process.platform}; --build must run on a Linux host`)
  if (fatal > 0 && MODE === 'build') die(`PREFLIGHT had ${fatal} blocking issue(s)`)
  ok('preflight complete')
}

function materializePayload (dryRun) {
  const payload = path.join(DIST, 'payload')
  if (PAYLOAD_OVERRIDE) {
    if (dryRun) { log(`(dry-run) use PEARPASTE_PAYLOAD_DIR -> ${payload}`); return payload }
    fs.rmSync(payload, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(payload), { recursive: true })
    fs.cpSync(PAYLOAD_OVERRIDE, payload, { recursive: true })
    ok(`payload from PEARPASTE_PAYLOAD_DIR (${PAYLOAD_OVERRIDE})`)
    return payload
  }
  if (!LINK || !LINK.startsWith('pear://')) die('PEARPASTE_LINK=pear://<key> required to materialize (or set PEARPASTE_PAYLOAD_DIR)')
  const runtimeLink = pearElectronRuntimeLink() || die('cannot resolve pear-electron runtime link')
  const runtimeDir = path.join(DIST, 'pear-runtime')
  const slice = path.join(runtimeDir, 'by-arch', process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64')
  if (dryRun) {
    log(`(dry-run) pear dump --force ${runtimeLink} ${path.relative(ROOT, runtimeDir)}`)
    log(`(dry-run) pear build --linux-x64-app ${path.relative(ROOT, slice)} --target ${path.relative(ROOT, payload)}`)
    return payload
  }
  // 1. Fetch the pear-electron runtime (carries the by-arch linux slice).
  run('pear', ['dump', '--force', runtimeLink, runtimeDir])
  if (!fs.existsSync(slice)) die(`expected runtime slice not found: ${slice}`)
  // 2. Build the standalone app. NOTE: the precise `pear build --linux-x64-app`
  //    arg form is the first-build unknown (it printed usage in earlier testing).
  //    If this throws/usage-prints, materialize by hand and re-run with
  //    PEARPASTE_PAYLOAD_DIR. See docs/handover/BUILD_FLATPAK.md.
  fs.rmSync(payload, { recursive: true, force: true })
  fs.mkdirSync(payload, { recursive: true })
  try {
    run('pear', ['build', '--linux-x64-app', slice, '--target', payload])
  } catch (err) {
    die(`pear build failed (${err.message}). This is the known first-build arg unknown — materialize the linux-x64 app by hand and re-run with PEARPASTE_PAYLOAD_DIR=/path/to/app. See docs/handover/BUILD_FLATPAK.md`)
  }
  // 3. Make sure the launcher's /app/paste/Paste target exists; if pear named the
  //    Electron binary differently, symlink the largest ELF executable to `Paste`.
  if (!fs.existsSync(path.join(payload, 'Paste'))) {
    const bin = findElectronBinary(payload)
    if (bin) { fs.symlinkSync(path.relative(payload, bin), path.join(payload, 'Paste')); ok(`symlinked payload/Paste -> ${path.relative(payload, bin)}`) }
    else warn('no obvious Electron binary in payload; verify paste-launcher.sh target')
  }
  ok(`materialized payload -> ${path.relative(ROOT, payload)}`)
  return payload
}

function findElectronBinary (dir) {
  // Heuristic: the executable file with no extension that is largest is usually
  // the Electron binary. Spike-grade — verify on first real build.
  let best = null; let bestSize = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.isFile() && !path.extname(e.name)) {
        const st = fs.statSync(full)
        if ((st.mode & 0o111) && st.size > bestSize) { best = full; bestSize = st.size }
      }
    }
  }
  try { walk(dir) } catch (_) {}
  return best
}

function assembleContext (payload, dryRun) {
  const ctx = path.join(DIST, 'context')
  const files = [
    [path.join(FLATPAK_SRC, `${APP_ID}.yml`), `${APP_ID}.yml`],
    [path.join(FLATPAK_SRC, `${APP_ID}.desktop`), `${APP_ID}.desktop`],
    [path.join(FLATPAK_SRC, `${APP_ID}.metainfo.xml`), `${APP_ID}.metainfo.xml`],
    [path.join(FLATPAK_SRC, 'paste-launcher.sh'), 'paste-launcher.sh'],
    [path.join(ROOT, 'assets', 'icon-512.png'), 'icon-512.png']
  ]
  if (dryRun) { log(`(dry-run) assemble context -> ${path.relative(ROOT, ctx)} (manifest + support files + payload/)`); return ctx }
  fs.rmSync(ctx, { recursive: true, force: true })
  fs.mkdirSync(ctx, { recursive: true })
  for (const [src, dst] of files) {
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(ctx, dst))
    else if (dst === 'icon-512.png') warn('assets/icon-512.png missing — context ships without it (manifest install of the icon will fail; drop the icon line or add the asset)')
    else die(`context source missing: ${src}`)
  }
  fs.cpSync(payload, path.join(ctx, 'payload'), { recursive: true })
  ok(`assembled context -> ${path.relative(ROOT, ctx)}`)
  return ctx
}

function buildFlatpak (ctx, dryRun) {
  const repo = path.join(DIST, 'repo')
  const buildDir = path.join(DIST, 'build')
  const bundle = path.join(DIST, 'Paste.flatpak')
  const manifest = path.join(ctx, `${APP_ID}.yml`)
  if (dryRun) {
    log(`(dry-run) flatpak-builder --force-clean --repo=${path.relative(ROOT, repo)} ${path.relative(ROOT, buildDir)} ${path.relative(ROOT, manifest)}`)
    log(`(dry-run) flatpak build-bundle ${path.relative(ROOT, repo)} ${path.relative(ROOT, bundle)} ${APP_ID}`)
    return bundle
  }
  run('flatpak-builder', ['--force-clean', `--repo=${repo}`, buildDir, manifest])
  run('flatpak', ['build-bundle', repo, bundle, APP_ID])
  const digest = sha256(bundle)
  fs.writeFileSync(`${bundle}.sha256`, `${digest}  ${path.basename(bundle)}\n`)
  ok(`wrote ${path.relative(ROOT, bundle)} (+ .sha256)`)
  ok('Install + test:  flatpak install --user ./dist/flatpak/Paste.flatpak && flatpak run global.paste.Paste')
  return bundle
}

log(`mode=${MODE} platform=${process.platform} arch=${process.arch}`)
preflight()
if (MODE === 'preflight') {
  console.log(`${C.dim}Next: PEARPASTE_LINK=pear://<key> node scripts/build-flatpak.mjs --build  (on a Linux host)${C.x}`)
} else {
  const dryRun = MODE === 'dry-run'
  if (!dryRun && process.platform !== 'linux') die('--build must run on a Linux host')
  fs.mkdirSync(DIST, { recursive: true })
  const payload = materializePayload(dryRun)
  const ctx = assembleContext(payload, dryRun)
  buildFlatpak(ctx, dryRun)
}
