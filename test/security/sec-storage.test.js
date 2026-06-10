// Security: the encryption invariant at the byte level (spec §3 security,
// §4 security promise, §8.3 plaintext rules, §16 "Security tests").
//
// Covers these §16 items:
//   - sentinel plaintext storage scan
//   - sentinel plaintext relay export scan
//   - logs scan
//
// Strategy: drive the REAL Pear-end through createPearEnd(), write a note and
// a clip whose title/body embed `SENTINEL_PREFIX + random`, force the data all
// the way down to the single Corestore on disk, then assumption-free
// byte-scan the storage tree (and the relay-export mirror, and the captured
// log stream). The sentinel must be ABSENT everywhere. This is the strongest
// possible check — it does not parse Hypercore/Hyperbee internals, it greps
// the actual on-disk bytes, so any leak from any structure is caught.
//
// Run: node test/security/sec-storage.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'
import {
  scanStorageDirForSentinel,
  scanBytesForSentinel
} from '../../backend/verifier.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }

function rnd () {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// Capture everything the structured logger writes to stdout/stderr so we can
// scan it for the sentinel without an on-disk log file.
function captureConsole () {
  const buf = []
  const methods = ['log', 'info', 'warn', 'error', 'debug']
  const orig = {}
  for (const m of methods) {
    orig[m] = console[m]
    console[m] = (...args) => {
      try { buf.push(args.map(String).join(' ')) } catch (_) {}
      // keep brittle TAP output readable: do not echo backend logs
    }
  }
  return {
    text: () => buf.join('\n'),
    restore () { for (const m of methods) console[m] = orig[m] }
  }
}

async function call (pearEnd, command, params) {
  return pearEnd.call(command, params || {})
}

test('§16 storage + relay-export + log scan: sentinel never lands at rest', async (t) => {
  const dir = tmp('store')
  const cap = captureConsole()
  let pearEnd
  try {
    pearEnd = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  } finally {
    // restore briefly so a boot failure is visible, re-capture below
    if (!pearEnd) cap.restore()
  }
  t.teardown(async () => {
    cap.restore()
    try { await pearEnd.close() } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Unique sentinels so a hit cannot be a stale artifact from another run.
  const noteBodySentinel = SENTINEL_PREFIX + 'NOTE_BODY_' + rnd()
  const noteTitleSentinel = SENTINEL_PREFIX + 'NOTE_TITLE_' + rnd()
  const clipBodySentinel = SENTINEL_PREFIX + 'CLIP_BODY_' + rnd()
  const tagSentinel = SENTINEL_PREFIX + 'TAG_' + rnd()

  const created = await call(pearEnd, COMMANDS.CREATE_VAULT, {
    label: 'sec', platform: 'linux', passphrase: 'pw-' + rnd()
  })
  t.ok(created.vaultId, 'CREATE_VAULT ok')

  // Write a note whose title, body, and a tag all carry sentinels.
  const up = await call(pearEnd, COMMANDS.NOTE_UPSERT, {
    note: {
      title: noteTitleSentinel,
      body: noteBodySentinel + ' some surrounding text ' + noteBodySentinel,
      tags: [tagSentinel, 'plain-tag'],
      bodyFormat: 'plain'
    }
  })
  t.ok(up.noteId, 'NOTE_UPSERT ok')

  // Capture a clip with a sentinel body (exercises the clip view + objmeta).
  const cap1 = await call(pearEnd, COMMANDS.CLIP_CAPTURE, {
    kind: 'text', body: clipBodySentinel
  })
  t.ok(cap1.clipId, 'CLIP_CAPTURE ok')

  // Open then close so the tap-to-decrypt path also runs (in-memory only).
  const opened = await call(pearEnd, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(opened.note.body, noteBodySentinel + ' some surrounding text ' + noteBodySentinel,
    'NOTE_OPEN returns the real plaintext in memory (as designed)')
  await call(pearEnd, COMMANDS.NOTE_CLOSE, { noteId: up.noteId })

  // Run the in-app verifier (auto-records nothing new but exercises the path).
  const proof = await call(pearEnd, COMMANDS.VERIFY_ENCRYPTION, {})
  t.ok(proof && Array.isArray(proof.lines), 'VERIFY_ENCRYPTION returns a proof report')

  // Force the autobase view + search index to flush to the Corestore on disk,
  // then lock (lock wipes keys; data stays sealed on disk).
  if (pearEnd.ctx.sync && pearEnd.ctx.sync._opened) {
    try { await pearEnd.ctx.sync.refresh() } catch (_) {}
  }
  await call(pearEnd, COMMANDS.LOCK_VAULT, {})
  // Give Corestore a beat to settle file writes.
  await new Promise(resolve => setTimeout(resolve, 250))

  // ---- 1. STORAGE SCAN: assumption-free byte grep of the whole tree -------
  const storage = scanStorageDirForSentinel(dir)
  t.ok(storage.scannedFiles > 0, 'storage scan walked real on-disk files (' +
    storage.scannedFiles + ' files, ' + storage.scannedBytes + ' bytes)')
  t.is(storage.hits.length, 0,
    'NO plaintext sentinel anywhere in the Corestore storage bytes')
  if (storage.hits.length) {
    for (const h of storage.hits) t.comment('LEAK: ' + h.file)
  }

  // Independent manual grep (does not trust the verifier helper) over every
  // file, so the test is meaningful even if verifier.js had a bug.
  let manualHit = false
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      if (e.isDirectory()) { walk(full); continue }
      try {
        const s = fs.readFileSync(full, 'binary')
        if (s.includes(SENTINEL_PREFIX)) { manualHit = true; t.comment('manual LEAK: ' + full) }
      } catch (_) {}
    }
  }
  walk(dir)
  t.absent(manualHit, 'independent manual byte grep also finds no sentinel')

  // ---- 2. RELAY-EXPORT SCAN ---------------------------------------------
  // relay-service mirrors anything it would hand a relay under
  // <storage>/relay-exports. Whether or not a relay was reachable, the
  // mirrored payloads must be ciphertext-only (no sentinel).
  const relayDir = path.join(dir, 'relay-exports')
  if (fs.existsSync(relayDir)) {
    const r = scanStorageDirForSentinel(relayDir)
    t.is(r.hits.length, 0,
      'NO sentinel in the relay-export mirror (' + r.scannedFiles + ' export files)')
  } else {
    t.pass('no relay-export mirror written (relay degraded/local-first) — nothing to leak')
  }

  // ---- 3. LOG SCAN ------------------------------------------------------
  // The structured logger redacts body/title/keys; the captured stream must
  // not contain the sentinel even though we just wrote it through the app.
  const logText = cap.text()
  t.absent(scanBytesForSentinel(logText),
    'NO plaintext sentinel in the captured structured log stream')
  // Also assert via PEARPASTE_LOG_FILE path the verifier supports.
  const logFile = path.join(dir, 'app.log')
  fs.writeFileSync(logFile, logText)
  t.absent(scanBytesForSentinel(fs.readFileSync(logFile)),
    'NO sentinel when the same logs are written to a PEARPASTE_LOG_FILE')
})

test('§16 storage scan still passes for a clip-only vault (no notes)', async (t) => {
  const dir = tmp('clip')
  const pearEnd = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => {
    try { await pearEnd.close() } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const clipSentinel = SENTINEL_PREFIX + 'CLIP_ONLY_' + rnd()
  await call(pearEnd, COMMANDS.CREATE_VAULT, { label: 'c', platform: 'macos', passphrase: 'pw' })
  const c = await call(pearEnd, COMMANDS.CLIP_CAPTURE, { kind: 'url', body: clipSentinel })
  t.ok(c.clipId, 'clip captured')
  // round-trip the clip body for the OS clipboard then ensure nothing persists
  const copy = await call(pearEnd, COMMANDS.CLIP_COPY, { clipId: c.clipId })
  t.is(copy.body, clipSentinel, 'CLIP_COPY returns plaintext in memory only')
  t.is(pearEnd.ctx.state.openItems.size, 0, 'no app-held plaintext after CLIP_COPY')

  if (pearEnd.ctx.sync && pearEnd.ctx.sync._opened) {
    try { await pearEnd.ctx.sync.refresh() } catch (_) {}
  }
  await call(pearEnd, COMMANDS.LOCK_VAULT, {})
  await new Promise(resolve => setTimeout(resolve, 200))

  const storage = scanStorageDirForSentinel(dir)
  t.ok(storage.scannedFiles > 0, 'scanned ' + storage.scannedFiles + ' files')
  t.is(storage.hits.length, 0, 'clip body never appears in storage bytes')
})
