#!/usr/bin/env node
// Paste Linux packaging helper.
//
// This script keeps Linux distribution honest without pretending this repo has
// distro signing infrastructure. Preflight is safe on any OS; package/release
// modes create a distro-neutral tarball on Linux that launches the production
// pear:// link through the local Pear runtime. A native Debian package (.deb)
// and an AppImage are produced ALONGSIDE the tarball when their tools are on
// PATH (dpkg-deb / appimagetool); both degrade gracefully to "tarball only"
// when the tool is absent — they are NEVER fatal. .rpm wrapping can still
// consume the generated payload later, with signing handled by the maintainer's
// distro or release process.
//
// Signing model (matches docs/RELEASE.md §3.2 + the CI release-guard gate):
//   - --release REQUIRES a detached signature sidecar (.sig/.asc/.minisig/.p7s)
//     next to EVERY distributable artifact (tarball, .deb, AppImage). Fails
//     closed when any is missing.
//   - --package emits artifacts WITHOUT requiring a signature (dev/CI lane).
//   - --unsigned is an explicit dev/CI flag: it produces the same artifacts but
//     clearly marks them unsigned (skips the signature requirement even if it
//     were otherwise on). It does NOT weaken --release: a real signed release
//     still fails closed without sidecars. Passing --unsigned WITH --release is
//     rejected (a signed release cannot be unsigned).
//
// Usage:
//   node scripts/package-linux.mjs --preflight            # readiness (any OS)
//   node scripts/package-linux.mjs --dry-run              # plan, no writes
//   node scripts/package-linux.mjs --package              # tarball + .deb + AppImage
//   node scripts/package-linux.mjs --package --unsigned   # same, marked unsigned
//   node scripts/package-linux.mjs --release              # requires signatures

import { execFileSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist', 'linux')
const argv = process.argv.slice(2)
const C = { ok: '\x1b[32m', warn: '\x1b[33m', err: '\x1b[31m', dim: '\x1b[2m', x: '\x1b[0m' }

const has = (flag) => argv.includes(flag)
const val = (flag, env) => {
  const i = argv.indexOf(flag)
  if (i >= 0 && argv[i + 1]) return argv[i + 1]
  return env ? process.env[env] : undefined
}

const MODE = has('--release')
  ? 'release'
  : has('--package') ? 'package' : has('--dry-run') ? 'dry-run' : 'preflight'
const LINK = val('--link', 'PEARPASTE_LINK')
// Explicit dev/CI escape hatch: build the artifacts but mark them unsigned and
// skip the signature requirement. It must NOT be combinable with --release —
// a signed release cannot be "unsigned" — so we reject that combination below.
const UNSIGNED = has('--unsigned')
if (UNSIGNED && MODE === 'release') {
  console.error('\x1b[31m[linux:error]\x1b[0m --unsigned cannot be combined with --release (a signed release must fail closed without signatures); use --package --unsigned for an unsigned dev/CI artifact')
  process.exit(1)
}
const REQUIRE_SIGNATURE = !UNSIGNED && (has('--require-signature') || MODE === 'release')
const PACKAGE_TYPE = val('--type', 'PEARPASTE_LINUX_PACKAGE_TYPE') || 'tar'

const log = (msg) => console.log(`[linux] ${msg}`)
const ok = (msg) => console.log(`${C.ok}[linux:ok]${C.x} ${msg}`)
const warn = (msg) => console.log(`${C.warn}[linux:warn]${C.x} ${msg}`)
const die = (msg) => {
  console.error(`${C.err}[linux:error]${C.x} ${msg}`)
  process.exit(1)
}

function readJson (rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'))
}

function exists (rel) {
  return fs.existsSync(path.join(ROOT, rel))
}

function safeReaddir (absPath) {
  try {
    return fs.readdirSync(absPath)
  } catch (_) {
    return []
  }
}

function hasCommand (cmd) {
  try {
    execFileSync(cmd, ['--version'], { stdio: 'ignore' })
    return true
  } catch (_) {
    try {
      execFileSync(cmd, ['--help'], { stdio: 'ignore' })
      return true
    } catch (_) {
      return false
    }
  }
}

function sha256 (absPath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(absPath))
  return hash.digest('hex')
}

function linuxArch () {
  if (process.arch === 'x64') return 'x64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

// Debian architecture names differ from Node's process.arch: x64 -> amd64,
// arm64 -> arm64 (same). dpkg uses these in both DEBIAN/control's Architecture
// field and the conventional <pkg>_<version>_<arch>.deb filename.
function debArch () {
  if (process.arch === 'x64') return 'amd64'
  if (process.arch === 'arm64') return 'arm64'
  return process.arch
}

function packageName (pkg) {
  return `${pkg.name}-${pkg.version}-linux-${linuxArch()}`
}

function pearLink () {
  if (!LINK) return 'pear://<production-key>'
  if (!LINK.startsWith('pear://')) die(`Linux package link must be pear://, got: ${LINK}`)
  return LINK
}

function checkEntrypoints (pkg) {
  let fatal = 0
  const entrypoints = pkg.pear?.stage?.entrypoints || []
  if (entrypoints.length === 0) {
    warn('package.json pear.stage.entrypoints is empty')
    fatal++
  }
  for (const rel of entrypoints) {
    if (exists(rel)) ok(`stage entrypoint present: ${rel}`)
    else {
      warn(`missing stage entrypoint: ${rel}`)
      fatal++
    }
  }
  return fatal
}

function preflight () {
  log(`Linux package preflight (mode=${MODE}, type=${PACKAGE_TYPE})`)
  const pkg = readJson('package.json')
  let fatal = 0

  if (exists('package-lock.json')) ok('root package-lock.json present')
  else {
    warn('package-lock.json missing; Linux packaging must use npm ci from lockfile')
    fatal++
  }

  fatal += checkEntrypoints(pkg)

  if (pkg.pear?.type === 'desktop') ok('pear.type = desktop')
  else warn(`pear.type is ${JSON.stringify(pkg.pear?.type)}; expected "desktop"`)

  if (pkg.pear?.pre === 'pear-electron/pre') ok('pear.pre = pear-electron/pre')
  else warn(`pear.pre is ${JSON.stringify(pkg.pear?.pre)}; expected "pear-electron/pre"`)

  const sodiumPrebuilds = safeReaddir(path.join(ROOT, 'node_modules', 'sodium-native', 'prebuilds'))
  const linuxPrebuilds = sodiumPrebuilds.filter((name) => name === 'linux-x64' || name === 'linux-arm64')
  if (linuxPrebuilds.length > 0) ok(`sodium-native Linux prebuilds: ${linuxPrebuilds.join(', ')}`)
  else {
    warn('sodium-native Linux prebuilds missing; Linux runtime would need a compiler')
    fatal++
  }

  if (hasCommand('pear')) ok('pear runtime on PATH')
  else warn('pear runtime not on PATH; required to run the packaged pear:// link')

  if (hasCommand('tar')) ok('tar available for distro-neutral package')
  else {
    warn('tar not available; cannot create the Linux tarball')
    fatal++
  }

  const optionalTools = [
    ['desktop-file-validate', 'desktop entry validation'],
    ['dpkg-deb', '.deb wrapping'],
    ['rpmbuild', '.rpm wrapping'],
    ['appimagetool', 'AppImage wrapping']
  ]
  for (const [cmd, purpose] of optionalTools) {
    if (hasCommand(cmd)) ok(`${cmd} available for ${purpose}`)
    else warn(`${cmd} unavailable; ${purpose} remains maintainer/manual`)
  }

  if (PACKAGE_TYPE !== 'tar') {
    warn(`--type ${PACKAGE_TYPE} requested; this helper currently emits tar and preflights native packager tools only`)
    fatal++
  }

  if (process.platform !== 'linux') {
    warn(`running on ${process.platform}; package mode should run on linux-latest or a Linux maintainer host`)
  } else {
    ok(`host platform linux/${process.arch}`)
  }

  if (fatal > 0) die(`PREFLIGHT had ${fatal} blocking issue(s)`)
  ok('PREFLIGHT PASS — Linux packaging inputs are present')
  return pkg
}

function writeFile (absPath, content, mode) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true })
  fs.writeFileSync(absPath, content)
  if (mode) fs.chmodSync(absPath, mode)
}

function buildPayload (pkg, dryRun) {
  const link = pearLink()
  const name = packageName(pkg)
  const payloadDir = path.join(DIST, name)
  const artifact = path.join(DIST, `${name}.tar.gz`)
  const commands = [
    `mkdir -p ${path.relative(ROOT, payloadDir)}`,
    `write ${path.relative(ROOT, path.join(payloadDir, 'bin', 'pearpaste'))}`,
    `write ${path.relative(ROOT, path.join(payloadDir, 'share', 'applications', 'pearpaste.desktop'))}`,
    `tar -czf ${path.relative(ROOT, artifact)} -C ${path.relative(ROOT, DIST)} ${name}`
  ]

  if (dryRun) {
    for (const command of commands) log(`(dry-run) ${command}`)
    return { artifact, payloadDir }
  }

  fs.rmSync(payloadDir, { recursive: true, force: true })
  fs.mkdirSync(DIST, { recursive: true })

  writeFile(path.join(payloadDir, 'bin', 'pearpaste'), `#!/usr/bin/env sh
set -eu
PEARPASTE_LINK="\${PEARPASTE_LINK:-${link}}"
exec pear run "$PEARPASTE_LINK" "$@"
`, 0o755)

  writeFile(path.join(payloadDir, 'share', 'applications', 'pearpaste.desktop'), `[Desktop Entry]
Type=Application
Name=Paste
Comment=End-to-end encrypted note and clipboard sync over Pear
Exec=pearpaste
Terminal=false
Categories=Utility;Office;
StartupNotify=true
`, 0o644)

  writeFile(path.join(payloadDir, 'README-linux.txt'), `Paste ${pkg.version} Linux package

This package is a distro-neutral launcher for the Paste production link:
  ${link}

Requirements:
  - Pear runtime installed and on PATH
  - Linux x64 or arm64 with the matching sodium-native prebuild

Install:
  1. Put bin/pearpaste on PATH.
  2. Optionally install share/applications/pearpaste.desktop.
  3. Run: pearpaste

The Pear P2P update path remains intact: app content updates flow through the
pear:// link, so this launcher rarely needs to be rebuilt.
`, 0o644)

  const manifest = {
    name: pkg.name,
    version: pkg.version,
    platform: 'linux',
    arch: linuxArch(),
    pearLink: link,
    packageType: 'tar',
    generatedAt: new Date().toISOString()
  }
  writeFile(path.join(payloadDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o644)

  execFileSync('tar', ['-czf', artifact, '-C', DIST, name], { stdio: 'inherit' })
  const digest = sha256(artifact)
  writeFile(`${artifact}.sha256`, `${digest}  ${path.basename(artifact)}\n`, 0o644)
  ok(`wrote ${path.relative(ROOT, artifact)}`)
  ok(`wrote ${path.relative(ROOT, `${artifact}.sha256`)}`)
  return { artifact, payloadDir }
}

function assertSignature (artifact) {
  const sidecars = ['.sig', '.asc', '.minisig', '.p7s'].map((suffix) => `${artifact}${suffix}`)
  if (sidecars.some((file) => fs.existsSync(file))) {
    ok(`signature sidecar present for ${path.basename(artifact)}`)
    return
  }
  die(`missing detached signature for ${path.relative(ROOT, artifact)}; expected .sig/.asc/.minisig/.p7s`)
}

// Optional AppImage wrapping. Only attempted on Linux when appimagetool is on
// PATH; skipped gracefully otherwise (the tarball remains the primary artifact).
// Builds a minimal AppDir around the same pear:// launcher and emits a
// <name>.AppImage plus its .sha256. Never fatal — a missing appimagetool or a
// build hiccup degrades to "tarball only".
function maybeBuildAppImage (pkg, payloadDir, dryRun) {
  if (process.platform !== 'linux') return null
  if (!hasCommand('appimagetool')) {
    warn('appimagetool unavailable; skipping AppImage (tarball is the primary artifact)')
    return null
  }
  const link = pearLink()
  const name = packageName(pkg)
  const appDir = path.join(DIST, `${name}.AppDir`)
  const appImage = path.join(DIST, `${name}.AppImage`)
  if (dryRun) {
    log(`(dry-run) mkdir -p ${path.relative(ROOT, appDir)} (AppDir)`)
    log(`(dry-run) appimagetool ${path.relative(ROOT, appDir)} ${path.relative(ROOT, appImage)}`)
    return { appImage, appDir }
  }
  try {
    fs.rmSync(appDir, { recursive: true, force: true })
    // AppRun launcher -> the pear:// link (same contract as the tarball bin).
    writeFile(path.join(appDir, 'AppRun'), `#!/usr/bin/env sh
set -eu
PEARPASTE_LINK="\${PEARPASTE_LINK:-${link}}"
exec pear run "$PEARPASTE_LINK" "$@"
`, 0o755)
    // Top-level .desktop + icon are required by appimagetool.
    writeFile(path.join(appDir, 'pearpaste.desktop'), `[Desktop Entry]
Type=Application
Name=Paste
Comment=End-to-end encrypted note and clipboard sync over Pear
Exec=AppRun
Icon=pearpaste
Terminal=false
Categories=Utility;Office;
`, 0o644)
    const icon = path.join(ROOT, 'assets', 'icon-256.png')
    if (fs.existsSync(icon)) fs.copyFileSync(icon, path.join(appDir, 'pearpaste.png'))
    // Reuse the staged payload's launcher tree inside the AppDir for parity.
    if (payloadDir && fs.existsSync(payloadDir)) {
      fs.cpSync(payloadDir, path.join(appDir, 'usr'), { recursive: true })
    }
    execFileSync('appimagetool', [appDir, appImage], { stdio: 'inherit', env: { ...process.env, ARCH: process.arch === 'arm64' ? 'aarch64' : 'x86_64' } })
    const digest = sha256(appImage)
    writeFile(`${appImage}.sha256`, `${digest}  ${path.basename(appImage)}\n`, 0o644)
    ok(`wrote ${path.relative(ROOT, appImage)}`)
    ok(`wrote ${path.relative(ROOT, `${appImage}.sha256`)}`)
    return { appImage, appDir }
  } catch (err) {
    warn(`AppImage wrapping failed (${err.message}); tarball remains the primary artifact`)
    return null
  }
}

// Optional Debian package (.deb) wrapping. Mirrors maybeBuildAppImage(): Linux-
// only, gated on dpkg-deb being on PATH, and NEVER fatal — a missing dpkg-deb
// or a build hiccup degrades to "tarball (+ AppImage) only". Lays out a minimal
// FHS install tree:
//   /usr/lib/pearpaste/pearpaste            launcher -> pear run <link>
//   /usr/bin/pearpaste                      symlink -> ../lib/pearpaste/pearpaste
//   /usr/share/applications/pearpaste.desktop
//   /usr/share/icons/hicolor/512x512/apps/pearpaste.png  (when the asset exists)
//   DEBIAN/control                          package metadata
// then runs `dpkg-deb --root-owner-group --build <root> <out.deb>` and emits the
// conventional dist/linux/paste_<version>_amd64.deb + its .sha256.
function maybeBuildDeb (pkg, dryRun) {
  if (process.platform !== 'linux') return null
  if (!hasCommand('dpkg-deb')) {
    warn('dpkg-deb unavailable; skipping .deb (tarball is the primary artifact)')
    return null
  }
  const link = pearLink()
  const arch = debArch()
  // Conventional Debian artifact name uses the package name ("pearpaste") — the
  // brief pins the product short-name "paste" for the FILE, so we honour that.
  const debName = `paste_${pkg.version}_${arch}`
  const buildRoot = path.join(DIST, `${debName}.deb-root`)
  const deb = path.join(DIST, `${debName}.deb`)
  // Sizes/paths for control + the on-disk layout.
  const launcherRel = 'usr/lib/pearpaste/pearpaste'
  const binSymlinkRel = 'usr/bin/pearpaste'
  const desktopRel = 'usr/share/applications/pearpaste.desktop'
  const iconRel = 'usr/share/icons/hicolor/512x512/apps/pearpaste.png'
  if (dryRun) {
    log(`(dry-run) mkdir -p ${path.relative(ROOT, buildRoot)} (.deb root)`)
    log(`(dry-run) write ${launcherRel} (pear run launcher)`)
    log(`(dry-run) ln -s ../lib/pearpaste/pearpaste ${binSymlinkRel}`)
    log(`(dry-run) write ${desktopRel} + DEBIAN/control`)
    log(`(dry-run) dpkg-deb --root-owner-group --build ${path.relative(ROOT, buildRoot)} ${path.relative(ROOT, deb)}`)
    return { deb, buildRoot }
  }
  try {
    fs.rmSync(buildRoot, { recursive: true, force: true })
    // Launcher: resolves the production pear:// link through the Pear runtime,
    // honouring an optional PEARPASTE_LINK override (same contract as tarball).
    writeFile(path.join(buildRoot, launcherRel), `#!/usr/bin/env sh
set -eu
PEARPASTE_LINK="\${PEARPASTE_LINK:-${link}}"
exec pear run "$PEARPASTE_LINK" "$@"
`, 0o755)
    // /usr/bin symlink -> the launcher (relative so it stays valid post-install).
    const binAbs = path.join(buildRoot, binSymlinkRel)
    fs.mkdirSync(path.dirname(binAbs), { recursive: true })
    fs.symlinkSync('../lib/pearpaste/pearpaste', binAbs)
    // Desktop entry + icon (icon optional — skip cleanly if the asset is gone).
    writeFile(path.join(buildRoot, desktopRel), `[Desktop Entry]
Type=Application
Name=Paste
Comment=End-to-end encrypted note and clipboard sync over Pear
Exec=pearpaste
Icon=pearpaste
Terminal=false
Categories=Utility;Office;
StartupNotify=true
`, 0o644)
    const icon = path.join(ROOT, 'assets', 'icon-512.png')
    if (fs.existsSync(icon)) {
      const iconAbs = path.join(buildRoot, iconRel)
      fs.mkdirSync(path.dirname(iconAbs), { recursive: true })
      fs.copyFileSync(icon, iconAbs)
    } else {
      warn('assets/icon-512.png missing; .deb ships without a hicolor icon')
    }
    // Installed-Size is in KiB (Debian policy 5.6.20): du -k of the data tree.
    let installedKib = 0
    try {
      installedKib = Math.max(1, Math.ceil(dirSizeBytes(buildRoot) / 1024))
    } catch (_) { installedKib = 0 }
    // DEBIAN/control — minimal but policy-valid. Depends is left light: the
    // launcher only needs the Pear runtime, which is NOT a distro package, so
    // we do not assert a hard Depends on it (documented in the long Description
    // + Recommends note). coreutils provides /usr/bin/env sh prerequisites.
    const control = [
      'Package: pearpaste',
      `Version: ${pkg.version}`,
      `Architecture: ${arch}`,
      'Maintainer: Paste Maintainers <defidon@protonmail.com>',
      'Priority: optional',
      'Section: utils',
      ...(installedKib ? [`Installed-Size: ${installedKib}`] : []),
      // The Pear runtime is fetched/installed out-of-band (pears.com), not from
      // apt, so it is a Recommends note rather than a hard Depends.
      'Recommends: pear',
      'Homepage: https://pears.com',
      'Description: End-to-end encrypted note and clipboard sync over Pear',
      ' Paste is a personal, end-to-end encrypted note and clipboard sync app',
      ' built on the Pear / Holepunch P2P stack. This package installs a thin',
      ' launcher that resolves the production pear:// link through the locally',
      ' installed Pear runtime; app content updates flow over P2P, so the',
      ' launcher rarely needs to be rebuilt.',
      ' .',
      ' Requires the Pear runtime on PATH (https://pears.com).',
      ''
    ].join('\n')
    writeFile(path.join(buildRoot, 'DEBIAN', 'control'), control, 0o644)
    // `--root-owner-group` makes the package contents owned by root:root without
    // needing fakeroot (dpkg >= 1.18.8); deterministic across CI hosts.
    execFileSync('dpkg-deb', ['--root-owner-group', '--build', buildRoot, deb], { stdio: 'inherit' })
    const digest = sha256(deb)
    writeFile(`${deb}.sha256`, `${digest}  ${path.basename(deb)}\n`, 0o644)
    ok(`wrote ${path.relative(ROOT, deb)}`)
    ok(`wrote ${path.relative(ROOT, `${deb}.sha256`)}`)
    return { deb, buildRoot }
  } catch (err) {
    warn(`.deb wrapping failed (${err.message}); tarball remains the primary artifact`)
    return null
  }
}

// Recursively sum regular-file sizes under a directory (for Installed-Size).
function dirSizeBytes (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) total += dirSizeBytes(full)
    else if (entry.isFile()) total += fs.statSync(full).size
  }
  return total
}

log(`mode=${MODE} platform=${process.platform} arch=${process.arch}`)
const pkg = preflight()

if (MODE === 'preflight') {
  console.log(`${C.dim}Use: PEARPASTE_LINK=pear://<key> npm run build:linux for the distro-neutral package.${C.x}`)
} else if (MODE === 'dry-run') {
  const { payloadDir } = buildPayload(pkg, true)
  maybeBuildDeb(pkg, true)
  maybeBuildAppImage(pkg, payloadDir, true)
} else {
  if (process.platform !== 'linux') die('Linux package mode must run on a Linux host')
  if (UNSIGNED) warn('UNSIGNED mode: emitting dev/CI artifacts WITHOUT a signature requirement — do NOT distribute as a release (use --release for a signed, fail-closed build)')
  const { artifact, payloadDir } = buildPayload(pkg, false)
  // Optional native .deb + AppImage alongside the tarball. Both skip gracefully
  // when their tool (dpkg-deb / appimagetool) is absent — tarball stays primary.
  const debResult = maybeBuildDeb(pkg, false)
  const appImageResult = maybeBuildAppImage(pkg, payloadDir, false)
  if (REQUIRE_SIGNATURE) {
    // Every distributable artifact must carry its own detached signature sidecar
    // (matches the CI release-guard gate). Fail closed if any is missing.
    assertSignature(artifact)
    if (debResult && debResult.deb && fs.existsSync(debResult.deb)) {
      assertSignature(debResult.deb)
    }
    if (appImageResult && appImageResult.appImage && fs.existsSync(appImageResult.appImage)) {
      assertSignature(appImageResult.appImage)
    }
  }
}
