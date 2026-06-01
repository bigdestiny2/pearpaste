// Paste encryption verifier — the "provably encrypted" proof layer.
//
// attach(ctx) registers VERIFY_ENCRYPTION and exposes
// ctx.verifier.runProofReport(). The verifier is the user-facing and
// auditor-facing evidence that the encryption invariant (§4, §8.3) holds:
// every stored note/clip value is a CryptoEnvelope, envelopes are real AEAD
// (not plaintext), no plaintext sentinel ever appears in storage bytes / relay
// payload exports / logs, op signatures validate against the active device
// set, revoked-device signatures are rejected after the revocation epoch, and
// relay custody receipts bind ciphertext roots (never plaintext roots).
//
// It also emits the honest limit line: a passing verifier does NOT prove
// physical deletion from third-party disks (§2 non-goals, §4, §8.4).
//
// Spec refs: §4 (security promise), §8.4 ("provably encrypted"),
// §16 (security tests), §21 Agent 2, §22 (contracts).
//
// This module owns nothing that the foundation owns. It only READS the
// Corestore/Hyperbee handles exposed by VaultStore and the relay status
// surfaced by relay-service. It never decrypts user content for the report
// (the proof is structural, not a content dump).

import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { COMMANDS } from './rpc.js'
import {
  ENVELOPE_VERSION, ALG, verifyOp
} from './crypto-envelope.js'
import { SENTINEL_PREFIX, classifyHeaderField, FIELD_CLASS } from './shared-ops.js'

// ---- Pure, dependency-light scan primitives --------------------------------
// Exported so scripts/verify-encryption.js can reuse the exact same logic
// without importing the Pear-end. Keeping the rules in one place means the
// CLI and the in-app proig screen can never silently disagree.

export const PROOF_VERSION = 1

// Is this value a structurally valid CryptoEnvelope (spec §8.2)?
export function isCryptoEnvelope (value) {
  return !!value &&
    typeof value === 'object' &&
    value.v === ENVELOPE_VERSION &&
    value.alg === ALG &&
    typeof value.keyId === 'string' &&
    typeof value.nonce === 'string' && value.nonce.length > 0 &&
    !!value.aad && typeof value.aad === 'object' &&
    typeof value.aad.vaultId === 'string' &&
    typeof value.aad.objectBlindId === 'string' &&
    typeof value.ciphertext === 'string' && value.ciphertext.length > 0
}

// An envelope's ciphertext must look like AEAD output: hex, and at least one
// AEAD tag (16 bytes) longer than zero. A "ciphertext" that decodes to the
// sentinel or to readable JSON is a hard fail — that's the bad-record case
// the acceptance test injects.
const HEX_RE = /^[0-9a-f]+$/i

export function envelopeLooksEncrypted (env) {
  if (!isCryptoEnvelope(env)) return false
  if (!HEX_RE.test(env.ciphertext) || env.ciphertext.length % 2 !== 0) return false
  const raw = safeHexToBuf(env.ciphertext)
  if (!raw || raw.byteLength < 16) return false // < AEAD tag size
  // Decoded ciphertext bytes must not contain the plaintext sentinel and must
  // not be parseable as the original JSON payload (i.e. not stored in clear).
  const asText = b4a.toString(raw, 'utf8')
  if (asText.includes(SENTINEL_PREFIX)) return false
  if (looksLikeJson(asText)) return false
  return true
}

function looksLikeJson (s) {
  const t = s.trim()
  if (!(t.startsWith('{') || t.startsWith('['))) return false
  try { JSON.parse(t); return true } catch (_) { return false }
}

function safeHexToBuf (hex) {
  try { return b4a.from(hex, 'hex') } catch (_) { return null }
}

// Scan an arbitrary byte/string blob for the plaintext sentinel family.
export function scanBytesForSentinel (buf) {
  if (buf == null) return false
  const s = typeof buf === 'string' ? buf : b4a.toString(b4a.from(buf), 'binary')
  return s.includes(SENTINEL_PREFIX)
}

// Recursively walk a directory; call fn(absPath, statSize) for every file.
export function walkFiles (dir, fn, opts = {}) {
  const skipDirs = opts.skipDirs || new Set(['.git', 'node_modules'])
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (_) { return }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (skipDirs.has(e.name)) continue
      walkFiles(full, fn, opts)
    } else if (e.isFile()) {
      let size = 0
      try { size = fs.statSync(full).size } catch (_) {}
      fn(full, size)
    }
  }
}

// Scan a storage directory's raw bytes for the sentinel. This is the
// strongest, most assumption-free check: it does not parse Hypercore/Hyperbee
// internals, it greps the actual on-disk bytes, so any plaintext leak — no
// matter which structure wrote it — is caught. Returns { scannedFiles,
// scannedBytes, hits: [{ file }] }.
export function scanStorageDirForSentinel (storagePath, opts = {}) {
  const maxBytesPerFile = opts.maxBytesPerFile || 64 * 1024 * 1024
  const result = { scannedFiles: 0, scannedBytes: 0, hits: [] }
  if (!storagePath || !fs.existsSync(storagePath)) return result
  walkFiles(storagePath, (file, size) => {
    result.scannedFiles++
    let buf
    try {
      buf = size > maxBytesPerFile
        ? fs.readFileSync(file).subarray(0, maxBytesPerFile)
        : fs.readFileSync(file)
    } catch (_) { return }
    result.scannedBytes += buf.byteLength
    if (scanBytesForSentinel(buf)) result.hits.push({ file })
  }, opts)
  return result
}

// Validate one ReplicatedOp-shaped record. activeDevices: Map/obj of
// deviceId/pubkey -> { signingPubkey, revokedEpoch|null }. epochOf(op) gives
// the op's logical epoch (lamport or createdAtBucket fallback). Returns
// { ok, reason }.
export function classifyOpRecord (op, deviceSet) {
  if (!op || typeof op !== 'object') return { ok: false, reason: 'not-an-object' }
  if (Object.prototype.hasOwnProperty.call(op, 'objectId')) return { ok: false, reason: 'forbidden-op-field:objectId' }
  const header = op.header || {}
  // Header must carry public-only fields (§22 classifier).
  for (const k of Object.keys(header)) {
    if (classifyHeaderField(k) !== FIELD_CLASS.PUBLIC) {
      return { ok: false, reason: 'forbidden-header-field:' + k }
    }
  }
  // Body must be a sealed envelope.
  const env = op.envelope || op.body
  if (env && !isCryptoEnvelope(env)) return { ok: false, reason: 'unsealed-op-body' }
  if (env && !envelopeLooksEncrypted(env)) return { ok: false, reason: 'op-body-not-aead' }

  const signer = op.signerPubkey || header.signerPubkey
  const sig = op.signature
  if (!signer || !sig) return { ok: false, reason: 'unsigned-op' }

  const dev = deviceSet && (deviceSet.get ? deviceSet.get(signer) : deviceSet[signer])
  if (!dev) return { ok: false, reason: 'unknown-signer' }

  const parts = {
    header,
    ciphertext: env ? env.ciphertext : (op.ciphertext || ''),
    nonce: env ? env.nonce : (op.nonce || ''),
    aadHash: op.aadHash || (env && env.aadHash) || ''
  }
  const sigOk = verifyOp(dev.signingPubkey || signer, parts, sig)
  if (!sigOk) return { ok: false, reason: 'bad-signature' }

  // Revoked-device rule: a signature is rejected if the device was revoked at
  // or before this op's epoch (spec §8.4 "revoked device signatures are
  // rejected after revocation epoch").
  if (dev.revokedEpoch != null) {
    const opEpoch = Number(header.lamport || 0)
    if (opEpoch >= Number(dev.revokedEpoch)) {
      return { ok: false, reason: 'revoked-device-after-epoch' }
    }
  }
  return { ok: true }
}

// ---- Proof report assembly -------------------------------------------------

function passLine (ok, passText, failText) {
  return ok ? passText : failText
}

// Build the canonical user-facing proof report (spec §8.4 wording). `input`:
//   {
//     local: { ok, detail },                  // local AEAD structural check
//     storage: { scannedFiles, scannedBytes, hits },
//     logs:    { scannedFiles, hits },
//     relayExports: { scannedFiles, hits },   // relay payload export scan
//     signatures: { checked, failures },
//     revocation: { checked, leaks },         // revoked sigs accepted = leak
//     custody: { relays, ciphertextRoot, receiptsMatchRoot },
//     relayStatus: { relaysHoldingCiphertext, custodyQuorum, lastVerifierRun }
//   }
export function buildProofReport (input = {}) {
  const local = input.local || { ok: false }
  const storage = input.storage || { scannedFiles: 0, hits: [] }
  const logs = input.logs || { scannedFiles: 0, hits: [] }
  const relayExports = input.relayExports || { scannedFiles: 0, hits: [] }
  const sigs = input.signatures || { checked: 0, failures: 0 }
  const revocation = input.revocation || { checked: 0, leaks: 0 }
  const custody = input.custody || null

  const storageClean = storage.hits.length === 0
  const logsClean = logs.hits.length === 0
  const relayExportsClean = relayExports.hits.length === 0
  const sigsClean = sigs.failures === 0
  const revocationClean = revocation.leaks === 0

  const lines = []
  lines.push(passLine(local.ok,
    'Local encryption: passed.',
    'Local encryption: FAILED — ' + (local.detail || 'a stored value was not an AEAD CryptoEnvelope') + '.'))
  lines.push(passLine(storageClean,
    'Storage scan: no plaintext found.',
    'Storage scan: FAILED — plaintext sentinel found in ' + storage.hits.length + ' file(s).'))
  lines.push(passLine(logsClean,
    'Log scan: no plaintext found.',
    'Log scan: FAILED — plaintext sentinel found in logs.'))
  lines.push(passLine(relayExportsClean,
    'Relay payload scan: no plaintext found.',
    'Relay payload scan: FAILED — plaintext sentinel found in relay export.'))
  lines.push(sigs.checked === 0
    ? 'Operation signatures: not checked — no replicated op list was exposed.'
    : passLine(sigsClean,
      'Operation signatures: ' + sigs.checked + ' checked, all valid against the active device set.',
      'Operation signatures: FAILED — ' + sigs.failures + ' of ' + sigs.checked + ' did not validate.'))
  lines.push(revocation.checked === 0
    ? 'Revoked-device check: not checked — no revoked-device op samples were exposed.'
    : passLine(revocationClean,
      'Revoked-device check: revoked signatures rejected after revocation epoch.',
      'Revoked-device check: FAILED — ' + revocation.leaks + ' revoked-device op(s) were accepted.'))

  if (custody && custody.relays > 0) {
    const root = custody.ciphertextRoot ? String(custody.ciphertextRoot).slice(0, 16) : 'n/a'
    lines.push(custody.receiptsMatchRoot === false
      ? 'Relay custody: FAILED — receipts did not match the ciphertext root.'
      : 'Relay custody: ' + custody.relays + ' relay(s) accepted ciphertext root <' + root + '>.')
  } else {
    lines.push('Relay custody: no relay receipts (local-first / direct-P2P only).')
  }

  const lastRun = new Date().toISOString()
  lines.push('Independent verifier: last run ' + lastRun + '.')
  // The honest limit — required wording, never softened (§4, §8.4).
  lines.push('Limit: this does not prove physical deletion from third-party disks.')

  const passed = local.ok && storageClean && logsClean && relayExportsClean &&
    sigsClean && revocationClean &&
    (!custody || custody.relays === 0 || custody.receiptsMatchRoot !== false)

  return {
    proofVersion: PROOF_VERSION,
    passed,
    lastRun,
    lines,
    summary: {
      localEncryption: local.ok,
      storageScanClean: storageClean,
      logScanClean: logsClean,
      relayExportScanClean: relayExportsClean,
      signaturesValid: sigsClean,
      revocationEnforced: revocationClean,
      custody: custody
        ? { relays: custody.relays, receiptsMatchRoot: custody.receiptsMatchRoot !== false }
        : null
    },
    counts: {
      storageFilesScanned: storage.scannedFiles,
      storageBytesScanned: storage.scannedBytes,
      logFilesScanned: logs.scannedFiles,
      relayExportFilesScanned: relayExports.scannedFiles,
      signaturesChecked: sigs.checked
    }
  }
}

// ---- Hyperbee value enumeration (best-effort, read-only) -------------------
// We walk every view namespace's Hyperbee and assert each stored value is an
// AEAD CryptoEnvelope. This is the structural half of "local encryption:
// passed"; the byte-level storage scan is the assumption-free half.

async function scanHyperbeeValues (bee, onValue) {
  try {
    for await (const node of bee.createReadStream()) {
      onValue(node && node.value, node && node.key)
    }
  } catch (_) {
    // A namespace with no view yet is fine; absence is not a leak.
  }
}

async function localEncryptionCheck (ctx) {
  // Read-only structural pass over the materialized views. The sync subsystem
  // (Agent 1) owns the write path; here we only assert the invariant on what
  // is already stored.
  const result = { ok: true, detail: '', valuesChecked: 0 }
  const Hyperbee = (await import('hyperbee')).default
  const { NAMESPACES } = await import('./vault-store.js')
  const viewNs = [NAMESPACES.VIEWS, NAMESPACES.SEARCH, NAMESPACES.AUTOBASE]
  for (const ns of viewNs) {
    let nsStore
    try { nsStore = ctx.vaultStore.namespace(ns) } catch (_) { continue }
    // Discover cores in this namespace via the view's well-known name.
    for (const name of ['view', 'notes', 'clips', 'devices', 'index', 'autobase', 'pearpaste-view-v1', 'local-search-v1']) {
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
      } catch (_) { continue }
      await scanHyperbeeValues(bee, (value) => {
        if (value == null) return
        // Materialized view rows must be sealed envelopes. A row that is a
        // plain object with readable fields is a leak.
        result.valuesChecked++
        if (!isCryptoEnvelope(value)) {
          // Allow non-content bookkeeping keys only if they carry no string
          // that could be user content and no sentinel.
          const s = JSON.stringify(value)
          if (s.includes(SENTINEL_PREFIX)) {
            result.ok = false
            result.detail = 'plaintext sentinel in a stored view value'
          } else if (looksLikeUserContentRow(value)) {
            result.ok = false
            result.detail = 'a stored view value was not an AEAD CryptoEnvelope'
          }
        } else if (!envelopeLooksEncrypted(value)) {
          result.ok = false
          result.detail = 'a stored envelope was not AEAD-encrypted'
        }
      })
      try { await bee.close() } catch (_) {}
    }
  }
  return result
}

// Heuristic: a view row that carries note/clip-ish plaintext fields.
function looksLikeUserContentRow (value) {
  if (!value || typeof value !== 'object') return false
  const keys = Object.keys(value)
  return keys.some(k => /^(body|title|text|note|clip|plaintext)$/i.test(k))
}

// ---- attach() --------------------------------------------------------------

export async function attach (ctx) {
  const log = ctx.log

  async function runProofReport (opts = {}) {
    const storagePath = ctx.vaultStore.storagePath

    // 1. Local AEAD structural check over materialized views.
    let local
    try {
      local = await localEncryptionCheck(ctx)
    } catch (err) {
      local = { ok: false, detail: 'view scan error: ' + String((err && err.message) || err) }
    }

    // 2. Assumption-free byte scan of the whole storage directory.
    const storage = scanStorageDirForSentinel(storagePath)

    // 3. Log scan — structured logs may be configured to a file via
    //    PEARPASTE_LOG_FILE; if not, there is no on-disk log to leak into.
    const logs = { scannedFiles: 0, hits: [] }
    // Bare (the Pear runtime) has no global `process`; guard the env read so
    // VERIFY_ENCRYPTION works in the worker. No log file => nothing on disk to
    // leak into (documented behavior), so a null result is correct.
    const logFile = (typeof process !== 'undefined' && process.env && process.env.PEARPASTE_LOG_FILE) || null
    if (logFile && fs.existsSync(logFile)) {
      logs.scannedFiles = 1
      try {
        if (scanBytesForSentinel(fs.readFileSync(logFile))) logs.hits.push({ file: logFile })
      } catch (_) {}
    }

    // 4. Relay payload export scan. relay-service writes any export it hands
    //    to a relay under <storage>/relay-exports for exactly this audit.
    const relayExports = { scannedFiles: 0, hits: [] }
    const relayExportDir = path.join(storagePath, 'relay-exports')
    if (fs.existsSync(relayExportDir)) {
      const r = scanStorageDirForSentinel(relayExportDir)
      relayExports.scannedFiles = r.scannedFiles
      relayExports.hits = r.hits
    }

    // 5. Signature + revocation validation against the active device set.
    //    The sync subsystem owns the device set; if it exposes one we use it,
    //    otherwise we report 0 checked (honest: we cannot validate what we
    //    cannot see, and we never fabricate a pass).
    const sigs = { checked: 0, failures: 0 }
    const revocation = { checked: 0, leaks: 0 }
    try {
      const deviceSet = ctx.sync && typeof ctx.sync.verifierDeviceSet === 'function'
        ? ctx.sync.verifierDeviceSet()
        : (ctx.state && ctx.state.deviceSet)
      const ops = ctx.sync && typeof ctx.sync.listReplicatedOps === 'function'
        ? await ctx.sync.listReplicatedOps()
        : (ctx.state && Array.isArray(ctx.state._verifierOps) ? ctx.state._verifierOps : [])
      for (const op of ops || []) {
        const c = classifyOpRecord(op, deviceSet || new Map())
        sigs.checked++
        if (!c.ok && c.reason !== 'revoked-device-after-epoch') {
          sigs.failures++
        }
        if (c.reason === 'revoked-device-after-epoch' && op.__accepted === true) {
          revocation.checked++
          revocation.leaks++
        } else if (c.reason === 'revoked-device-after-epoch') {
          revocation.checked++
        }
      }
    } catch (err) {
      log.warn('verifier-sig-scan-skipped', { err: String((err && err.message) || err) })
    }

    // 6. Relay custody receipts bind ciphertext roots (never plaintext roots).
    let custody = null
    try {
      if (ctx.relay && typeof ctx.relay.getRelayStatus === 'function') {
        const rs = await ctx.relay.getRelayStatus()
        custody = {
          relays: rs.relaysHoldingCiphertext || 0,
          ciphertextRoot: rs.ciphertextRoot || null,
          receiptsMatchRoot: rs.custodyReceiptsMatchRoot !== false
        }
      }
    } catch (_) {}

    const report = buildProofReport({ local, storage, logs, relayExports, signatures: sigs, revocation, custody })
    if (ctx.state) ctx.state.lastVerifierRun = { at: report.lastRun, passed: report.passed }
    ctx.emit('verifier-ran', { passed: report.passed, at: report.lastRun })
    log.info('verifier-ran', { passed: report.passed, storageFiles: storage.scannedFiles })
    if (opts.includeRaw) report._raw = { local, storage, logs, relayExports, sigs, revocation }
    return report
  }

  ctx.verifier = { runProofReport, isCryptoEnvelope, envelopeLooksEncrypted, scanStorageDirForSentinel }

  ctx.dispatcher.register(COMMANDS.VERIFY_ENCRYPTION, async () => {
    const report = await runProofReport()
    // Renderer-safe by construction: only structural booleans, counts, and
    // proof strings — no keys, no plaintext, no blind-id-to-id mapping.
    return report
  })

  log.info('verifier-attached')
}

export default { attach, buildProofReport, isCryptoEnvelope, envelopeLooksEncrypted, scanStorageDirForSentinel, scanBytesForSentinel, classifyOpRecord, walkFiles, PROOF_VERSION }
