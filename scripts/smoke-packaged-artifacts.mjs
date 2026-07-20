#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const makeDir = path.resolve('out', 'make')
const platform = process.platform
// PEARPASTE_TARGET_ARCH lets a cross-built artifact (mac x64 made on an arm64
// runner via `electron-forge make --arch x64`) declare what it SHOULD contain;
// otherwise assume the artifact targets the machine that built it.
const runnerArch = normalizeArch(process.env.PEARPASTE_TARGET_ARCH || process.env.RUNNER_ARCH || process.arch)
const prebuildDir = expectedPrebuildDir(platform, runnerArch)

const artifacts = await findArtifacts(makeDir)
if (artifacts.length === 0) {
  throw new Error(`no native artifacts found under ${makeDir}`)
}

console.log(`smoking ${artifacts.length} native artifact(s) for ${platform}/${runnerArch}`)

if (platform === 'darwin') {
  await smokeDarwin(artifacts)
} else if (platform === 'win32') {
  await smokeWindows(artifacts)
} else if (platform === 'linux') {
  await smokeLinux(artifacts)
} else {
  throw new Error(`unsupported artifact smoke platform: ${platform}`)
}

await writeSha256Sidecars(artifacts)
console.log('packaged artifact smoke gate passed')

async function smokeDarwin (artifacts) {
  const dmgs = artifacts.filter((file) => file.endsWith('.dmg'))
  const zips = artifacts.filter((file) => file.endsWith('.zip'))

  requireAny(dmgs, 'macOS DMG')
  requireAny(zips, 'macOS ZIP')

  for (const dmg of dmgs) {
    console.log(`verifying DMG: ${relative(dmg)}`)
    await run('hdiutil', ['verify', dmg], { timeoutMs: 180000 })

    await withTempDir('pearpaste-dmg-', async (tmp) => {
      const mountpoint = path.join(tmp, 'mnt')
      await fs.mkdir(mountpoint)
      let attached = false

      try {
        await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountpoint, dmg], { timeoutMs: 180000 })
        attached = true
        const app = await findAppBundle(mountpoint)
        await assertMacApp(app, `DMG ${path.basename(dmg)}`)
      } finally {
        if (attached) {
          await run('hdiutil', ['detach', mountpoint, '-quiet'], { timeoutMs: 60000 }).catch(async () => {
            await run('hdiutil', ['detach', mountpoint, '-force', '-quiet'], { timeoutMs: 60000 })
          })
        }
      }
    })
  }

  for (const zip of zips) {
    console.log(`verifying ZIP: ${relative(zip)}`)
    await run('unzip', ['-tq', zip], { timeoutMs: 180000 })

    await withTempDir('pearpaste-zip-', async (tmp) => {
      await run('ditto', ['-x', '-k', zip, tmp], { timeoutMs: 240000 })
      const app = await findAppBundle(tmp)
      await assertMacApp(app, `ZIP ${path.basename(zip)}`)
    })
  }
}

async function smokeWindows (artifacts) {
  const msixes = artifacts.filter((file) => file.endsWith('.msix'))
  requireAny(msixes, 'Windows MSIX')

  const makeAppx = await findMakeAppx()
  for (const msix of msixes) {
    console.log(`unpacking MSIX: ${relative(msix)}`)
    await withTempDir('pearpaste-msix-', async (tmp) => {
      await run(makeAppx, ['unpack', '/p', msix, '/d', tmp, '/o'], { timeoutMs: 180000 })
      const entries = await listEntries(tmp)
      requireEntry(entries, 'AppxManifest.xml', path.basename(msix))
      requireEntry(entries, 'Paste.exe', path.basename(msix))
      requirePackagedAppEntries(entries, path.basename(msix))
    })
  }
}

async function smokeLinux (artifacts) {
  const appImages = artifacts.filter((file) => file.endsWith('.AppImage'))
  const flatpakTarballs = artifacts.filter((file) => file.endsWith('_flatpak.tar.gz'))
  const snaps = artifacts.filter((file) => file.endsWith('.snap'))

  requireAny(appImages, 'Linux AppImage')
  requireAny(flatpakTarballs, 'Linux Flatpak staging tarball')

  for (const appImage of appImages) {
    console.log(`extracting AppImage: ${relative(appImage)}`)
    await fs.chmod(appImage, 0o755)

    await withTempDir('pearpaste-appimage-', async (tmp) => {
      await run(appImage, ['--appimage-extract'], { cwd: tmp, timeoutMs: 240000 })
      const root = path.join(tmp, 'squashfs-root')
      await assertFile(path.join(root, 'AppRun'), `${path.basename(appImage)} AppRun`)
      const entries = await listEntries(root)
      requireEntry(entries, 'Paste.desktop', path.basename(appImage))
      requirePackagedAppEntries(entries, path.basename(appImage))
    })
  }

  for (const tarball of flatpakTarballs) {
    console.log(`listing Flatpak tarball: ${relative(tarball)}`)
    const { stdout } = await run('tar', ['-tzf', tarball], { timeoutMs: 180000 })
    const entries = stdout.split(/\r?\n/).filter(Boolean).map(toPosix)
    requirePackagedAppEntries(entries, path.basename(tarball))
  }

  for (const snap of snaps) {
    console.log(`listing Snap: ${relative(snap)}`)
    if (!(await commandExists('unsquashfs'))) {
      throw new Error(`cannot smoke ${path.basename(snap)} because unsquashfs is unavailable`)
    }

    const { stdout } = await run('unsquashfs', ['-l', snap], { timeoutMs: 180000 })
    const entries = stdout
      .split(/\r?\n/)
      .map((line) => line.replace(/^squashfs-root\/?/, ''))
      .filter(Boolean)
      .map(toPosix)
    requirePackagedAppEntries(entries, path.basename(snap))
  }
}

async function assertMacApp (app, label) {
  await assertFile(path.join(app, 'Contents', 'Info.plist'), `${label} Info.plist`)

  const { stdout } = await run('plutil', ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', path.join(app, 'Contents', 'Info.plist')])
  const executableName = stdout.trim() || 'Paste'
  const executable = path.join(app, 'Contents', 'MacOS', executableName)
  await assertFile(executable, `${label} executable`)
  await fs.access(executable, constants.X_OK)

  const { stdout: archs } = await run('lipo', ['-archs', executable])
  const expectedMachArch = runnerArch === 'x64' ? 'x86_64' : runnerArch
  if (!archs.trim().split(/\s+/).includes(expectedMachArch)) {
    throw new Error(`${label} executable arch mismatch: expected ${expectedMachArch}, got ${archs.trim()}`)
  }

  const appRoot = path.join(app, 'Contents', 'Resources', 'app')
  await assertFile(path.join(appRoot, 'package.json'), `${label} packaged package.json`)
  await assertFile(path.join(appRoot, 'workers', 'main.js'), `${label} updater worker`)
  await assertFile(path.join(appRoot, 'workers', 'paste.js'), `${label} vault worker`)
  await assertFile(path.join(appRoot, 'electron', 'main.js'), `${label} Electron main`)
  await assertFile(path.join(appRoot, 'electron', 'preload.cjs'), `${label} preload`)
  await assertFile(
    path.join(appRoot, 'node_modules', 'sodium-native', 'prebuilds', prebuildDir, 'sodium-native.bare'),
    `${label} sodium-native ${prebuildDir} Bare prebuild`
  )
}

function requirePackagedAppEntries (entries, label) {
  for (const suffix of [
    'resources/app/package.json',
    'resources/app/workers/main.js',
    'resources/app/workers/paste.js',
    'resources/app/electron/main.js',
    'resources/app/electron/preload.cjs',
    `resources/app/node_modules/sodium-native/prebuilds/${prebuildDir}/sodium-native.bare`
  ]) {
    requireEntry(entries, suffix, label)
  }
}

function requireEntry (entries, suffix, label) {
  if (!entries.some((entry) => entry === suffix || entry.endsWith(`/${suffix}`))) {
    throw new Error(`${label} is missing ${suffix}`)
  }
}

function requireAny (files, label) {
  if (files.length === 0) throw new Error(`missing required artifact: ${label}`)
}

async function findArtifacts (root) {
  const files = await listFiles(root)
  return files
    .filter((file) => !file.endsWith('.sha256'))
    .filter((file) => {
      const base = path.basename(file)
      return (
        base.endsWith('.dmg') ||
        base.endsWith('.zip') ||
        base.endsWith('.msix') ||
        base.endsWith('.AppImage') ||
        base.endsWith('_flatpak.tar.gz') ||
        base.endsWith('.snap')
      )
    })
    .sort()
}

async function writeSha256Sidecars (files) {
  for (const file of files) {
    const digest = await sha256(file)
    const sidecar = `${file}.sha256`
    await fs.writeFile(sidecar, `${digest}  ${path.basename(file)}\n`)
    console.log(`wrote ${relative(sidecar)}`)
  }
}

function sha256 (file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function listFiles (root) {
  const out = []

  async function walk (dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        out.push(full)
      }
    }
  }

  await walk(root)
  return out
}

async function listEntries (root) {
  const files = await listFiles(root)
  return files.map((file) => toPosix(path.relative(root, file)))
}

async function findAppBundle (root) {
  async function walk (dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (!entry.isDirectory()) continue
      if (entry.name.endsWith('.app')) return full
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const found = await walk(path.join(dir, entry.name))
      if (found) return found
    }
  }

  const app = await walk(root)
  if (!app) throw new Error(`no .app bundle found under ${root}`)
  return app
}

async function findMakeAppx () {
  const fromPath = await commandPath('makeappx.exe')
  if (fromPath) return fromPath

  const programFilesX86 = getEnv('ProgramFiles(x86)') || getEnv('PROGRAMFILES(X86)')
  if (!programFilesX86) throw new Error('makeappx.exe not found and ProgramFiles(x86) is unavailable')

  const bin = path.join(programFilesX86, 'Windows Kits', '10', 'bin')
  const kits = await fs.readdir(bin).catch(() => [])
  const versions = kits.filter((name) => /^\d+\.\d+\.\d+\.\d+$/.test(name)).sort().reverse()

  for (const version of versions) {
    const candidate = path.join(bin, version, 'x64', 'makeappx.exe')
    if (await pathExists(candidate)) return candidate
  }

  throw new Error('makeappx.exe not found in Windows Kits')
}

async function assertFile (file, label) {
  const stat = await fs.stat(file).catch(() => null)
  if (!stat?.isFile()) throw new Error(`missing ${label}: ${file}`)
}

async function withTempDir (prefix, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  try {
    return await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

function run (command, args, options = {}) {
  const { cwd = process.cwd(), timeoutMs = 120000 } = options

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      windowsHide: true
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, timeoutMs)

    child.stdout.on('data', (chunk) => {
      stdout.push(chunk)
      stdoutBytes += chunk.length
    })

    child.stderr.on('data', (chunk) => {
      stderr.push(chunk)
      stderrBytes += chunk.length
    })

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const result = {
        stdout: Buffer.concat(stdout, stdoutBytes).toString(),
        stderr: Buffer.concat(stderr, stderrBytes).toString()
      }

      if (timedOut) {
        reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`))
      } else if (code !== 0) {
        reject(new Error(`${command} ${args.join(' ')} failed with code ${code ?? signal}\n${result.stdout}${result.stderr}`))
      } else {
        resolve(result)
      }
    })
  })
}

async function commandExists (command) {
  return Boolean(await commandPath(command))
}

async function commandPath (command) {
  const lookup = platform === 'win32' ? 'where.exe' : 'which'
  const args = [command]
  const result = await run(lookup, args, { timeoutMs: 15000 }).catch(() => null)
  if (!result) return null
  return result.stdout.split(/\r?\n/).find(Boolean) || null
}

async function pathExists (file) {
  return Boolean(await fs.stat(file).catch(() => null))
}

function expectedPrebuildDir (platform, arch) {
  if (platform === 'darwin') return 'darwin-universal'
  if (platform === 'win32') return `win32-${arch}`
  if (platform === 'linux') return `linux-${arch}`
  throw new Error(`unsupported platform: ${platform}`)
}

function normalizeArch (arch) {
  const value = String(arch).toLowerCase()
  if (value === 'x64' || value === 'amd64') return 'x64'
  if (value === 'arm64' || value === 'aarch64') return 'arm64'
  return value
}

function getEnv (name) {
  const match = Object.entries(process.env).find(([key]) => key.toLowerCase() === name.toLowerCase())
  return match?.[1]
}

function relative (file) {
  return path.relative(process.cwd(), file)
}

function toPosix (value) {
  return value.split(path.sep).join('/').replace(/\\/g, '/')
}
