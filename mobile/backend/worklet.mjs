/* global Bare, BareKit */
// Paste mobile Bare worklet — structured to mirror the PROVEN PearBrowser
// worklet (the only integration verified running a heavy native-addon Pear-end
// on real iOS + Android):
//
//   1. Construct WorkletRPC over BareKit.IPC SYNCHRONOUSLY (IPC responsive
//      immediately — no bare-rpc handshake that silently hung us).
//   2. Register command handlers SYNCHRONOUSLY (they gate on a boot promise).
//   3. Defer ALL heavy init to an async boot(); emit 'boot' progress, then a
//      single 'ready' event when createPearEnd() has fully initialized.
//   4. boot().catch → emit 'error' (RN side surfaces a recoverable error).
//
// The full Paste Pear-end (createPearEnd: corestore + autobase + hyperbee +
// hyperswarm + relay + verifier + notes/clipboard, all 22 RPC commands) is
// driven unchanged via pearEnd.call(command, params).
//
// Spec refs: §5, §9.1, §10, §13, §15, §22.

import path from 'bare-path'
import RPC from './worklet-rpc.mjs'
import { createPearEnd } from '../../backend/index.js'

const ipc = (typeof BareKit !== 'undefined' && BareKit.IPC) ? BareKit.IPC : null
if (!ipc) {
  console.error(JSON.stringify({ t: Date.now(), level: 'error', msg: 'worklet-no-ipc' }))
  if (typeof Bare !== 'undefined') Bare.exit(0)
}

const rpc = new RPC(ipc)

const docDir = (typeof Bare !== 'undefined' && Bare.argv && Bare.argv[0]) || '.'
const storagePath = path.join(docDir, 'pearpaste-corestore')

let pearEnd = null
let bootErr = null

// Backend events forwarded to the RN side (renderer-safe; no secrets — backend
// assertRendererSafe already strips, and these carry only names/flags).
const FORWARD_EVENTS = [
  'locked', 'unlocked', 'device-unlocked', 'clip-captured', 'clip-written',
  'verifier-ran', 'device-revoked', 'relay-available', 'relay-enabled-changed',
  'relay-connected-changed',
  'pair-invite-created', 'pair-approval-needed', 'pair-approval-cleared',
  'pair-rejected', 'pair-admitted', 'paired', 'sync-ready',
  // [AUDIT I-9] payload-less live-refresh signal — sanitize() strips its opaque
  // {seq} to a scalar; carries no content. NotesScreen/ClipsScreen subscribe.
  'view-changed'
]

// Handlers registered SYNC so the RN side never hangs on a dead IPC; they gate
// on boot completion (mirrors PearBrowser's "still booting" guards).
rpc.handle('call', async ({ command, params } = {}) => {
  if (bootErr) { const e = new Error('worklet boot failed: ' + bootErr.message); e.code = 'WORKLET_BOOT_FAILED'; throw e }
  if (!pearEnd) { const e = new Error('worklet still booting'); e.code = 'WORKLET_BOOTING'; throw e }
  return pearEnd.call(command, params || {})
})

rpc.handle('ping', async () => ({ ok: true, ready: !!pearEnd, bootError: bootErr ? String(bootErr.message) : null }))

function sanitize (payload) {
  if (payload == null || typeof payload !== 'object') return payload ?? null
  const out = {}
  for (const [k, v] of Object.entries(payload)) {
    if (/secret|key|mnemonic|passphrase|body|plaintext|seed/i.test(k)) continue
    if (typeof v === 'object') continue
    out[k] = v
  }
  return out
}

// Forwarding logger: surfaces createPearEnd's own structured logs as 'boot'
// progress so the RN splash shows subsystem-by-subsystem advance and any hang
// is localized without a rebuild (the backend logger is already redacted).
function bootStage (stage, message, extra) {
  rpc.event('boot', { stage, message, ...(extra || {}) })
}
const fwdLog = {
  debug: (m, x) => bootStage('log:' + m, m, { level: 'debug', meta: sanitize(x) }),
  info: (m, x) => bootStage('log:' + m, m, { level: 'info', meta: sanitize(x) }),
  warn: (m, x) => bootStage('log:' + m, m, { level: 'warn', meta: sanitize(x) }),
  error: (m, x) => bootStage('log:' + m, m, { level: 'error', meta: sanitize(x) })
}

async function boot () {
  bootStage('createPearEnd', 'Starting the encrypted engine…')
  // Pass the forwarding logger so createPearEnd's 'subsystem-attached' /
  // warnings stream out as 'boot' progress events (redacted by the backend
  // logger). Cheap and useful for diagnosing future boot regressions.
  pearEnd = await createPearEnd({ storagePath, log: fwdLog })
  bootStage('pearEnd-created', 'Engine core initialized; wiring events…')
  try {
    for (const ev of FORWARD_EVENTS) {
      pearEnd.ctx.on(ev, (p) => rpc.event('backend', { event: ev, payload: sanitize(p) }))
    }
  } catch (_) {}
  rpc.event('ready', { storagePath })
}

// Bare lifecycle: background → drop decrypted item plaintext (spec §9.4/§15);
// teardown → drain LifecycleScope via pearEnd.close() (spec §10).
if (typeof Bare !== 'undefined' && Bare.on) {
  Bare.on('suspend', () => { try { pearEnd && pearEnd.ctx && pearEnd.ctx.emit('backgrounded') } catch (_) {} })
  Bare.on('teardown', () => { try { pearEnd && pearEnd.close() } catch (_) {} })
}

boot().catch((err) => {
  bootErr = err
  rpc.event('error', {
    message: String((err && err.message) || err),
    code: err && err.code,
    stack: err && err.stack
  })
})
