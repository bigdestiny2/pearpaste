#!/usr/bin/env node

import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const startosRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(startosRoot, '..', '..')
const require = createRequire(import.meta.url)

process.noDeprecation = true

const rootPackage = readJson(path.join(repoRoot, 'package.json'))
const imageConfig = readJson(path.join(repoRoot, 'release', 'container-image.json'))
const bundlePath = path.join(startosRoot, 'javascript', 'index.js')

if (!fs.existsSync(bundlePath)) {
  fail('missing javascript/index.js; run npm run build first')
}

const { manifest } = require(bundlePath)
if (!manifest || typeof manifest !== 'object') fail('compiled StartOS bundle does not export manifest')

const version = rootPackage.version
const revision = Number(imageConfig.startOsPackageRevision)
const configuredImageRef = imageConfig.digest
  ? `${imageConfig.repository}:${version}@${imageConfig.digest}`
  : `${imageConfig.repository}:${version}`
const imageRef = process.env.PEARPASTE_IMAGE || configuredImageRef

assertEqual(manifest.id, 'pearpaste', 'manifest id')
assertEqual(manifest.title, 'Pear Paste', 'manifest title')
assertEqual(manifest.license, 'Apache-2.0', 'manifest license')
assertEqual(manifest.version, `${version}:${revision}`, 'manifest version')
assertEqual(manifest.packageRepo, 'https://github.com/bigdestiny2/pearpaste/tree/main/platforms/startos', 'manifest package repo')
assertEqual(manifest.upstreamRepo, 'https://github.com/bigdestiny2/pearpaste', 'manifest upstream repo')
assertArrayEqual(manifest.volumes, ['main'], 'manifest volumes')

const image = manifest.images && manifest.images.pearpaste
if (!image) fail('manifest images.pearpaste is missing')
assertEqual(image.source && image.source.dockerTag, imageRef, 'manifest image ref')
assertArrayEqual(image.arch, imageConfig.startOsArches, 'manifest image arches')

const webPort = Number(imageConfig.webPort || imageConfig.uiPort)
const startOsPort = Number(imageConfig.startOsPort || imageConfig.uiPort || webPort)
assertValidPort(webPort, 'webPort')
assertValidPort(startOsPort, 'startOsPort')
if (webPort === startOsPort) fail('StartOS preferred external port should not reuse the internal web port')

console.log(`StartOS package verification passed: ${manifest.id} ${manifest.version} ${imageRef}`)

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function assertEqual (actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function assertArrayEqual (actual, expected, label) {
  if (!Array.isArray(actual)) fail(`${label}: expected array, got ${typeof actual}`)
  if (!Array.isArray(expected)) fail(`${label}: expected comparison value must be an array`)
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

function assertValidPort (value, label) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    fail(`${label}: expected TCP port, got ${JSON.stringify(value)}`)
  }
}

function fail (message) {
  console.error(`[startos:verify] ${message}`)
  process.exit(1)
}
