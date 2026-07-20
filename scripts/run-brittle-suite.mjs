#!/usr/bin/env node
// Run Brittle test globs one file at a time.
//
// Brittle imports every matched file before it resumes the runner. That is fine
// for small unit suites, but Paste's integration/mobile suites spin up
// Hyperswarm/testnet/relay machinery and are intentionally written as isolated
// files. Spawning one Brittle process per file keeps those lifetimes isolated
// and makes hangs/failures point at a specific file.

import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { spawn } from 'child_process'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const brittleCmd = require.resolve('brittle/cmd.js')
const argv = process.argv.slice(2)
const REGEXP_SPECIAL = new Set(['\\', '^', '$', '.', '*', '+', '?', '(', ')', '[', ']', '{', '}', '|'])

const passthrough = []
const patterns = []
let successIdleMs = 0

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--') {
    patterns.push(...argv.slice(i + 1))
    break
  }
  if (arg === '--success-idle-ms') {
    successIdleMs = Number(argv[++i] || 0) || 0
    continue
  }
  if (arg.startsWith('-')) {
    passthrough.push(arg)
    if (
      (arg === '--timeout' || arg === '-t' || arg === '--cov-dir' || arg === '--runner' || arg === '--mine') &&
      argv[i + 1]
    ) {
      passthrough.push(argv[++i])
    }
    continue
  }
  patterns.push(arg)
}

if (patterns.length === 0) {
  console.error('Usage: node scripts/run-brittle-suite.mjs [brittle flags] <test globs...>')
  process.exit(1)
}

const files = []
const seen = new Set()

for (const pattern of patterns) {
  const matches = expandPattern(pattern)
  if (matches.length === 0) {
    console.error(`Error: no files found when resolving ${pattern}`)
    process.exit(1)
  }
  for (const match of matches) {
    const file = path.normalize(match)
    if (seen.has(file)) continue
    seen.add(file)
    files.push(file)
  }
}

let failed = 0

for (const file of files) {
  console.log(`\n[brittle-suite] ${file}`)
  const code = await runBrittle(file)
  if (code !== 0) {
    failed = code || 1
    break
  }
}

process.exitCode = failed

function runBrittle (file) {
  return new Promise((resolve) => {
    let outputTail = ''
    let sawOk = false
    let forcedSuccess = false
    let graceTimer = null
    let successIdleTimer = null
    let killTimer = null
    const child = spawn(process.execPath, [brittleCmd, ...passthrough, file], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    })

    const onOutput = (chunk, stream) => {
      const text = chunk.toString()
      stream.write(chunk)
      if (successIdleTimer) {
        clearTimeout(successIdleTimer)
        successIdleTimer = null
      }
      outputTail = (outputTail + text).slice(-4096)
      if (!sawOk && /(^|\n)# ok(?:\n|$)/.test(outputTail)) {
        sawOk = true
        graceTimer = setTimeout(() => {
          forcedSuccess = true
          console.warn(`[brittle-suite] ${file} printed # ok but did not exit; terminating after grace period`)
          child.kill('SIGTERM')
          killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
          if (killTimer.unref) killTimer.unref()
        }, 5000)
        if (graceTimer.unref) graceTimer.unref()
      }
      if (successIdleMs > 0 && /(^|\n)ok \d+ - .+ # time = .+(?:\n|$)/.test(outputTail)) {
        successIdleTimer = setTimeout(() => {
          forcedSuccess = true
          console.warn(`[brittle-suite] ${file} passed but stayed idle; terminating after ${successIdleMs}ms`)
          child.kill('SIGTERM')
          killTimer = setTimeout(() => child.kill('SIGKILL'), 2000)
          if (killTimer.unref) killTimer.unref()
        }, successIdleMs)
        if (successIdleTimer.unref) successIdleTimer.unref()
      }
    }

    child.stdout.on('data', (chunk) => onOutput(chunk, process.stdout))
    child.stderr.on('data', (chunk) => onOutput(chunk, process.stderr))
    child.on('error', (err) => {
      console.error(err && err.stack ? err.stack : String(err))
      resolve(1)
    })
    child.on('close', (code, signal) => {
      if (graceTimer) clearTimeout(graceTimer)
      if (successIdleTimer) clearTimeout(successIdleTimer)
      if (killTimer) clearTimeout(killTimer)
      if (forcedSuccess) return resolve(0)
      if (signal) {
        console.error(`[brittle-suite] ${file} exited with signal ${signal}`)
        resolve(1)
      } else {
        resolve(code || 0)
      }
    })
  })
}

function expandPattern (pattern) {
  if (!hasGlob(pattern)) return fs.existsSync(path.join(ROOT, pattern)) ? [pattern] : []

  const dir = path.dirname(pattern)
  const base = path.basename(pattern)
  if (hasGlob(dir)) {
    throw new Error('Nested glob directories are not supported by run-brittle-suite: ' + pattern)
  }

  const absDir = path.join(ROOT, dir)
  let entries = []
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true })
  } catch (_) {
    return []
  }

  const re = globBasenameToRegExp(base)
  return entries
    .filter((entry) => entry.isFile() && re.test(entry.name))
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

function hasGlob (value) {
  return value.includes('*') || value.includes('?') || value.includes('[')
}

function globBasenameToRegExp (glob) {
  let source = '^'
  for (const ch of glob) {
    if (ch === '*') source += '[^/]*'
    else if (ch === '?') source += '[^/]'
    else source += REGEXP_SPECIAL.has(ch) ? '\\' + ch : ch
  }
  source += '$'
  return new RegExp(source)
}
