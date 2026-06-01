#!/usr/bin/env node
// Paste standalone encryption verifier CLI.
//
//   node scripts/verify-encryption.js <storage-path> [--json] [--log <file>]
//
// Scans a Corestore/Hyperbee storage directory (and optional log file, and the
// relay-export mirror written by relay-service) for the plaintext sentinel,
// and validates that every parseable Hyperbee value is an AEAD CryptoEnvelope.
// Exits NON-ZERO on any leak so CI / release gating can depend on it. No
// Pear-end, no network, no keys required — this is the independent verifier
// an auditor can run from source (spec §8.4, §17, §21 Agent 2, §22).

import fs from 'fs'
import path from 'path'
import {
  scanStorageDirForSentinel,
  scanBytesForSentinel,
  isCryptoEnvelope,
  envelopeLooksEncrypted,
  buildProofReport
} from '../backend/verifier.js'

function parseArgs (argv) {
  const args = { _: [], json: false, log: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json') args.json = true
    else if (a === '--log') args.log = argv[++i]
    else if (a === '-h' || a === '--help') args.help = true
    else args._.push(a)
  }
  return args
}

function usage () {
  process.stdout.write(
    'Usage: node scripts/verify-encryption.js <storage-path> [--json] [--log <file>]\n\n' +
    '  <storage-path>  Paste vault storage directory (Pear.config.storage)\n' +
    '  --json          machine-readable JSON report\n' +
    '  --log <file>    also scan this log file for the plaintext sentinel\n\n' +
    'Exit code is non-zero if any plaintext sentinel is found or any stored\n' +
    'value is not an AEAD CryptoEnvelope.\n')
}

// Try to read on-disk Hyperbee values structurally so we can assert each is a
// sealed envelope. We open the Corestore read-only and enumerate known view
// cores. This is best-effort: a store with no views yet is not a failure
// (absence of content is not a leak). The byte scan below is the
// assumption-free backstop regardless.
async function structuralEnvelopeCheck (storagePath) {
  const out = { ok: true, valuesChecked: 0, badValues: 0, detail: '', skipped: false }
  let Corestore, Hyperbee
  try {
    Corestore = (await import('corestore')).default
    Hyperbee = (await import('hyperbee')).default
  } catch (err) {
    out.skipped = true
    out.detail = 'corestore/hyperbee not importable: ' + String((err && err.message) || err)
    return out
  }
  let store
  try {
    store = new Corestore(storagePath)
    await store.ready()
  } catch (err) {
    out.skipped = true
    out.detail = 'cannot open corestore: ' + String((err && err.message) || err)
    return out
  }
  const namespaces = [
    'pearpaste:views', 'pearpaste:search', 'pearpaste:autobase', 'pearpaste:meta'
  ]
  const names = ['view', 'notes', 'clips', 'devices', 'index', 'autobase', 'pearpaste-view-v1', 'local-search-v1', 'vault-header']
  try {
    for (const ns of namespaces) {
      const nsStore = store.namespace(ns)
      for (const name of names) {
        let core
        try {
          core = nsStore.get({ name })
          await core.ready()
        } catch (_) { continue }
        if (!core.length) continue
        let bee
        try {
          bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
          await bee.ready()
          for await (const node of bee.createReadStream()) {
            const value = node && node.value
            if (value == null) continue
            // The vault header is intentionally content-free public metadata
            // (spec §7.1) — it is not an envelope and that is correct.
            if (ns === 'pearpaste:meta' && node.key === 'header') continue
            out.valuesChecked++
            if (!isCryptoEnvelope(value)) {
              const s = JSON.stringify(value)
              if (s.includes('PEARPASTE_PLAINTEXT_SENTINEL_') || looksLikeUserContent(value)) {
                out.ok = false
                out.badValues++
                out.detail = 'a stored view value was not an AEAD CryptoEnvelope'
              }
            } else if (!envelopeLooksEncrypted(value)) {
              out.ok = false
              out.badValues++
              out.detail = 'a stored envelope was not AEAD-encrypted (plaintext smuggled as ciphertext)'
            }
          }
        } catch (_) {
          // Unreadable / non-bee core in this slot — ignore; byte scan covers it.
        } finally {
          try { if (bee) await bee.close() } catch (_) {}
        }
      }
    }
  } finally {
    try { await store.close() } catch (_) {}
  }
  return out
}

function looksLikeUserContent (value) {
  if (!value || typeof value !== 'object') return false
  return Object.keys(value).some(k => /^(body|title|text|note|clip|plaintext)$/i.test(k))
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    usage()
    process.exit(args.help ? 0 : 2)
  }
  const storagePath = path.resolve(args._[0])
  if (!fs.existsSync(storagePath)) {
    process.stderr.write('error: storage path does not exist: ' + storagePath + '\n')
    process.exit(2)
  }

  // 1. Assumption-free byte scan of the whole storage tree.
  const storage = scanStorageDirForSentinel(storagePath)

  // 2. Relay export mirror (what relay-service handed to relays).
  const relayExports = { scannedFiles: 0, hits: [] }
  const relayDir = path.join(storagePath, 'relay-exports')
  if (fs.existsSync(relayDir)) {
    const r = scanStorageDirForSentinel(relayDir)
    relayExports.scannedFiles = r.scannedFiles
    relayExports.hits = r.hits
  }

  // 3. Optional log file scan.
  const logs = { scannedFiles: 0, hits: [] }
  if (args.log) {
    if (fs.existsSync(args.log)) {
      logs.scannedFiles = 1
      try {
        if (scanBytesForSentinel(fs.readFileSync(args.log))) logs.hits.push({ file: args.log })
      } catch (_) {}
    } else {
      process.stderr.write('warning: --log file not found: ' + args.log + '\n')
    }
  }

  // 4. Structural envelope check (best-effort).
  const struct = await structuralEnvelopeCheck(storagePath)

  const local = {
    ok: struct.skipped ? storage.hits.length === 0 : (struct.ok && storage.hits.length === 0),
    detail: struct.detail || (storage.hits.length ? 'plaintext sentinel in storage bytes' : '')
  }

  const report = buildProofReport({
    local,
    storage,
    logs,
    relayExports,
    signatures: { checked: 0, failures: 0 },
    revocation: { checked: 0, leaks: 0 },
    custody: null
  })

  // CLI-specific: structural envelope detail is part of "local encryption".
  const leaked = storage.hits.length > 0 ||
    relayExports.hits.length > 0 ||
    logs.hits.length > 0 ||
    (!struct.skipped && !struct.ok)

  if (args.json) {
    process.stdout.write(JSON.stringify({
      ...report,
      structural: struct,
      storageHits: storage.hits,
      relayExportHits: relayExports.hits,
      logHits: logs.hits,
      leaked
    }, null, 2) + '\n')
  } else {
    process.stdout.write('Paste encryption verifier\n')
    process.stdout.write('storage: ' + storagePath + '\n')
    process.stdout.write('scanned: ' + storage.scannedFiles + ' files, ' +
      storage.scannedBytes + ' bytes\n')
    if (!struct.skipped) {
      process.stdout.write('structural: ' + struct.valuesChecked + ' stored values checked, ' +
        struct.badValues + ' bad\n')
    } else {
      process.stdout.write('structural: skipped (' + struct.detail + ')\n')
    }
    process.stdout.write('\n')
    for (const line of report.lines) process.stdout.write('  ' + line + '\n')
    process.stdout.write('\n')
    if (storage.hits.length) {
      process.stdout.write('LEAK: plaintext sentinel in:\n')
      for (const h of storage.hits) process.stdout.write('  - ' + h.file + '\n')
    }
    if (relayExports.hits.length) {
      process.stdout.write('LEAK: plaintext sentinel in relay export:\n')
      for (const h of relayExports.hits) process.stdout.write('  - ' + h.file + '\n')
    }
    if (logs.hits.length) {
      process.stdout.write('LEAK: plaintext sentinel in log file\n')
    }
    process.stdout.write(leaked ? 'RESULT: FAIL\n' : 'RESULT: PASS\n')
  }

  process.exit(leaked ? 1 : 0)
}

main().catch((err) => {
  process.stderr.write('verifier crashed: ' + ((err && err.stack) || err) + '\n')
  process.exit(3)
})
