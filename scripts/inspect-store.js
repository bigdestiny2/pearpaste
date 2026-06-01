#!/usr/bin/env node
// Paste store inspector CLI (debugging aid).
//
//   node scripts/inspect-store.js <storage-path> [--json] [--values]
//
// Dumps the structure of a Paste Corestore: namespaces, cores, lengths,
// and Hyperbee KEYS only. Keys are already blind (objectBlindId =
// HMAC(indexKey, id)) so they reveal no user content. With --values it prints
// only the envelope METADATA (v/alg/keyId/nonce length/aad) — NEVER the
// ciphertext bytes and NEVER any decrypted plaintext. Refuses to print
// anything that fails the envelope shape (so a leaked plaintext row is
// reported as a violation, not dumped).
//
// Spec refs: §8.3 (plaintext rules), §21 Agent 2, §22 (logs redacted).

import fs from 'fs'
import path from 'path'
import { isCryptoEnvelope } from '../backend/verifier.js'

function parseArgs (argv) {
  const a = { _: [], json: false, values: false }
  for (const x of argv) {
    if (x === '--json') a.json = true
    else if (x === '--values') a.values = true
    else if (x === '-h' || x === '--help') a.help = true
    else a._.push(x)
  }
  return a
}

const NAMESPACES = [
  'pearpaste:meta', 'pearpaste:autobase', 'pearpaste:views',
  'pearpaste:search', 'pearpaste:backup', 'seeding-registry'
]
const CORE_NAMES = [
  'vault-header', 'view', 'notes', 'clips', 'devices', 'index', 'autobase'
]

function safeEnvelopeMeta (value) {
  if (!isCryptoEnvelope(value)) return { sealed: false }
  return {
    sealed: true,
    v: value.v,
    alg: value.alg,
    keyId: value.keyId,
    nonceLen: typeof value.nonce === 'string' ? value.nonce.length / 2 : 0,
    aad: {
      vaultId: value.aad.vaultId,
      objectBlindId: value.aad.objectBlindId,
      opType: value.aad.opType,
      schema: value.aad.schema
    },
    ciphertextBytes: typeof value.ciphertext === 'string' ? value.ciphertext.length / 2 : 0
  }
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args._.length === 0) {
    process.stdout.write(
      'Usage: node scripts/inspect-store.js <storage-path> [--json] [--values]\n' +
      '  Prints store structure + blind keys. --values adds envelope METADATA\n' +
      '  only (never ciphertext, never plaintext).\n')
    process.exit(args.help ? 0 : 2)
  }
  const storagePath = path.resolve(args._[0])
  if (!fs.existsSync(storagePath)) {
    process.stderr.write('error: storage path not found: ' + storagePath + '\n')
    process.exit(2)
  }

  const Corestore = (await import('corestore')).default
  const Hyperbee = (await import('hyperbee')).default
  const store = new Corestore(storagePath)
  await store.ready()

  const report = { storagePath, namespaces: [], violations: [] }

  try {
    for (const ns of NAMESPACES) {
      const nsStore = store.namespace(ns)
      const nsRec = { namespace: ns, cores: [] }
      for (const name of CORE_NAMES) {
        let core
        try {
          core = nsStore.get({ name })
          await core.ready()
        } catch (_) { continue }
        if (!core.length && !core.writable) continue
        const coreRec = {
          name,
          length: core.length,
          keyHex: core.key ? core.key.toString('hex') : null, // public key = id, safe
          discoveryKeyHex: core.discoveryKey ? core.discoveryKey.toString('hex') : null,
          keys: []
        }
        let bee
        try {
          bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
          await bee.ready()
          for await (const node of bee.createReadStream()) {
            const entry = { key: node.key } // already blind
            if (args.values) {
              if (ns === 'pearpaste:meta' && node.key === 'header') {
                entry.headerMetadataOnly = true // content-free by spec §7.1
              } else {
                const meta = safeEnvelopeMeta(node.value)
                entry.envelope = meta
                if (!meta.sealed) {
                  report.violations.push({
                    namespace: ns,
                    core: name,
                    key: node.key,
                    reason: 'stored value is NOT a sealed CryptoEnvelope'
                  })
                }
              }
            }
            coreRec.keys.push(entry)
          }
        } catch (_) {
          // non-bee core; just report length
        } finally {
          try { if (bee) await bee.close() } catch (_) {}
        }
        nsRec.cores.push(coreRec)
      }
      if (nsRec.cores.length) report.namespaces.push(nsRec)
    }
  } finally {
    try { await store.close() } catch (_) {}
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
  } else {
    process.stdout.write('Paste store: ' + storagePath + '\n\n')
    for (const ns of report.namespaces) {
      process.stdout.write('namespace ' + ns.namespace + '\n')
      for (const c of ns.cores) {
        process.stdout.write('  core "' + c.name + '"  len=' + c.length +
          '  key=' + (c.keyHex ? c.keyHex.slice(0, 16) + '…' : 'n/a') + '\n')
        for (const k of c.keys) {
          let suffix = ''
          if (k.envelope) {
            suffix = k.envelope.sealed
              ? '  [sealed ' + k.envelope.alg + ' ct=' + k.envelope.ciphertextBytes + 'B]'
              : '  [!! NOT SEALED !!]'
          } else if (k.headerMetadataOnly) {
            suffix = '  [content-free header]'
          }
          process.stdout.write('    ' + k.key + suffix + '\n')
        }
      }
    }
    if (report.violations.length) {
      process.stdout.write('\nVIOLATIONS (' + report.violations.length + '):\n')
      for (const v of report.violations) {
        process.stdout.write('  ' + v.namespace + '/' + v.core + ' "' + v.key + '": ' + v.reason + '\n')
      }
    }
  }
  process.exit(report.violations.length ? 1 : 0)
}

main().catch((err) => {
  process.stderr.write('inspect-store crashed: ' + ((err && err.stack) || err) + '\n')
  process.exit(3)
})
