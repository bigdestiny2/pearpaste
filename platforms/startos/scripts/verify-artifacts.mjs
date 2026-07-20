#!/usr/bin/env node

import { spawnSync } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const STARTOS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = path.resolve(STARTOS_ROOT, '..', '..')
const PACKAGE_ID = 'pearpaste'
const args = process.argv.slice(2)

const C = {
  ok: '\x1b[32m',
  warn: '\x1b[33m',
  err: '\x1b[31m',
  x: '\x1b[0m'
}

const ok = (message) => console.log(`${C.ok}[startos:ok]${C.x} ${message}`)
const die = (message) => {
  console.error(`${C.err}[startos:error]${C.x} ${message}`)
  process.exit(1)
}

const val = (flag) => {
  const index = args.indexOf(flag)
  if (index === -1) return undefined
  return args[index + 1]
}

const rootPackage = readJson(path.join(ROOT, 'package.json'))
const imageConfig = readJson(path.join(ROOT, 'release', 'container-image.json'))
const expectedVersion = `${rootPackage.version}:${imageConfig.startOsPackageRevision}`
const expectedArches = imageConfig.startOsArches
const startCli = resolveStartCli()
const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pearpaste-startos-artifacts-'))
const expectedFiles = new Set(expectedArches.map((arch) => `${PACKAGE_ID}_${arch}.s9pk`))
const actualPackages = fs.readdirSync(STARTOS_ROOT)
  .filter((file) => file === `${PACKAGE_ID}.s9pk` || (file.startsWith(`${PACKAGE_ID}_`) && file.endsWith('.s9pk')))
  .sort()
let failures = 0

if (!Array.isArray(expectedArches) || expectedArches.length === 0) {
  die('release/container-image.json must define startOsArches')
}

for (const file of actualPackages) {
  if (!expectedFiles.has(file)) {
    fail(`unexpected StartOS artifact present: ${file}`)
  }
}

for (const arch of expectedArches) {
  const fileName = `${PACKAGE_ID}_${arch}.s9pk`
  const artifactPath = path.join(STARTOS_ROOT, fileName)
  if (!fs.existsSync(artifactPath)) {
    fail(`missing StartOS artifact: platforms/startos/${fileName}`)
    continue
  }

  const manifest = inspectManifest(artifactPath)
  assertEqual(manifest.id, PACKAGE_ID, `${fileName} manifest id`)
  assertEqual(manifest.version, expectedVersion, `${fileName} manifest version`)
  assertEqual(manifest.title, 'Pear Paste', `${fileName} manifest title`)
  assertEqual(manifest.license, rootPackage.license, `${fileName} manifest license`)
  assertIncludes(manifest.volumes, 'main', `${fileName} manifest volumes`)
  assertEqual(manifest.images?.pearpaste?.source, 'packed', `${fileName} packed image source`)
  assertIncludes(manifest.images?.pearpaste?.arch, arch, `${fileName} image arch`)
  assertIncludes(manifest.hardwareRequirements?.arch, arch, `${fileName} hardware arch`)

  const hash = sha256(artifactPath)
  const size = fs.statSync(artifactPath).size
  ok(`${fileName} ${arch} ${formatBytes(size)} sha256:${hash}`)
}

if (failures > 0) process.exit(1)

ok(`verified ${expectedArches.length} StartOS artifact(s) for ${expectedVersion}`)

function inspectManifest (artifactPath) {
  const result = spawnSync(startCli, ['s9pk', 'inspect', artifactPath, 'manifest'], {
    cwd: STARTOS_ROOT,
    env: {
      ...process.env,
      HOME: tempHome
    },
    encoding: 'utf8'
  })

  if (result.status !== 0) {
    die(`start-cli failed while inspecting ${path.basename(artifactPath)}\n${result.stderr || result.stdout}`)
  }

  try {
    return JSON.parse(result.stdout)
  } catch (err) {
    die(`start-cli did not return manifest JSON for ${path.basename(artifactPath)}: ${err.message}`)
  }
}

function resolveStartCli () {
  const explicit = val('--start-cli') || process.env.START_CLI
  if (explicit) return path.resolve(explicit)

  const paths = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  for (const dir of paths) {
    const candidate = path.join(dir, 'start-cli')
    if (fs.existsSync(candidate)) return candidate
  }

  die('start-cli not found; set START_CLI=/path/to/start-cli or put start-cli on PATH')
}

function readJson (absPath) {
  return JSON.parse(fs.readFileSync(absPath, 'utf8'))
}

function sha256 (absPath) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(absPath))
  return hash.digest('hex')
}

function assertEqual (actual, expected, label) {
  if (actual !== expected) fail(`${label} expected ${expected}, got ${actual}`)
}

function assertIncludes (actual, expected, label) {
  if (!Array.isArray(actual) || !actual.includes(expected)) {
    fail(`${label} must include ${expected}`)
  }
}

function fail (message) {
  failures++
  console.error(`${C.err}[startos:error]${C.x} ${message}`)
}

function formatBytes (bytes) {
  const mib = bytes / 1024 / 1024
  if (mib >= 1) return `${mib.toFixed(1)} MiB`
  return `${bytes} bytes`
}
