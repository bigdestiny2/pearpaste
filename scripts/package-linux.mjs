#!/usr/bin/env node
// Paste Linux packaging helper.
//
// This script keeps Linux distribution honest without pretending this repo has
// distro signing infrastructure. Preflight is safe on any OS; package/release
// modes create a distro-neutral tarball on Linux that launches the production
// pear:// link through the local Pear runtime. .deb/.rpm/AppImage wrapping can
// consume the generated payload later, with signing handled by the maintainer's
// distro or release process.

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
const REQUIRE_SIGNATURE = has('--require-signature') || MODE === 'release'
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

log(`mode=${MODE} platform=${process.platform} arch=${process.arch}`)
const pkg = preflight()

if (MODE === 'preflight') {
  console.log(`${C.dim}Use: PEARPASTE_LINK=pear://<key> npm run build:linux for the distro-neutral package.${C.x}`)
} else if (MODE === 'dry-run') {
  buildPayload(pkg, true)
} else {
  if (process.platform !== 'linux') die('Linux package mode must run on a Linux host')
  const { artifact } = buildPayload(pkg, false)
  if (REQUIRE_SIGNATURE) assertSignature(artifact)
}
