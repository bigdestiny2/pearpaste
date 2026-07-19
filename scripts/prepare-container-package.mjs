#!/usr/bin/env node
// Build-time helper for Docker images.
//
// PearPaste uses local HiveRelay workspace packages during ecosystem
// development. The container build context intentionally does not include
// ../../00-core, so remove only those optional file: links from the copied
// package files before npm ci. Runtime import paths already degrade when the
// optional relay client is absent.

import fs from 'fs'
import path from 'path'

const root = process.cwd()
const packagePath = path.join(root, 'package.json')
const lockPath = path.join(root, 'package-lock.json')
const relayPackages = new Set(['p2p-hiverelay', 'p2p-hiverelay-client'])

const pkg = readJson(packagePath)
const removed = new Set()

for (const name of relayPackages) {
  const spec = pkg.optionalDependencies && pkg.optionalDependencies[name]
  if (typeof spec === 'string' && spec.startsWith('file:')) {
    delete pkg.optionalDependencies[name]
    removed.add(name)
  }
}

if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length === 0) {
  delete pkg.optionalDependencies
}

if (removed.size === 0) {
  console.log('[container-package] no local optional relay packages to prune')
  process.exit(0)
}

writeJson(packagePath, pkg)

const lock = readJson(lockPath)
const rootPackage = lock.packages && lock.packages['']
if (rootPackage && rootPackage.optionalDependencies) {
  for (const name of removed) delete rootPackage.optionalDependencies[name]
  if (Object.keys(rootPackage.optionalDependencies).length === 0) {
    delete rootPackage.optionalDependencies
  }
}

if (lock.packages) {
  for (const [pkgPath, meta] of Object.entries(lock.packages)) {
    const name = meta && meta.name
    const packageName = name || (pkgPath.startsWith('node_modules/') ? pkgPath.slice('node_modules/'.length) : '')
    const resolved = meta && typeof meta.resolved === 'string' ? meta.resolved : ''
    if (removed.has(packageName) && (pkgPath.startsWith('node_modules/') || pkgPath.startsWith('..') || resolved.startsWith('..'))) {
      delete lock.packages[pkgPath]
    }
  }
}

if (lock.dependencies) {
  for (const name of removed) delete lock.dependencies[name]
}

writeJson(lockPath, lock)
console.log(`[container-package] pruned optional local packages: ${[...removed].join(', ')}`)

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson (file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}
