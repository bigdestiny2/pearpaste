import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('packaging dependency overrides keep Electron Forge build tools on patched tar/tmp lines', (t) => {
  const pkg = readJson('package.json')
  t.is(pkg.overrides?.tar, '^7.5.16')
  t.is(pkg.overrides?.tmp, '^0.2.7')

  const lock = readJson('package-lock.json')
  const tarEntries = lockEntries(lock, 'tar')
  const tmpEntries = lockEntries(lock, 'tmp')

  t.ok(tarEntries.length > 0, 'lockfile records tar build-tool dependencies')
  t.ok(tmpEntries.length > 0, 'lockfile records tmp build-tool dependencies')

  for (const entry of tarEntries) {
    t.ok(atLeast(entry.version, [7, 5, 16]), `${entry.path} uses patched tar ${entry.version}`)
  }

  for (const entry of tmpEntries) {
    t.ok(atLeast(entry.version, [0, 2, 7]), `${entry.path} uses patched tmp ${entry.version}`)
  }
})

function lockEntries (lock, name) {
  return Object.entries(lock.packages || {})
    .filter(([pkgPath, meta]) => pkgPath === `node_modules/${name}` || (pkgPath.endsWith(`/node_modules/${name}`) && meta?.version))
    .map(([pkgPath, meta]) => ({ path: pkgPath, version: meta.version }))
}

function atLeast (version, min) {
  const parts = String(version).split('.').map(Number)
  for (let i = 0; i < min.length; i++) {
    const actual = Number.isFinite(parts[i]) ? parts[i] : 0
    if (actual > min[i]) return true
    if (actual < min[i]) return false
  }
  return true
}

function readJson (rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}
