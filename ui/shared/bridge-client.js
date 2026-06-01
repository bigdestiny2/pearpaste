// Renderer-side bridge client (spec §15). The UI NEVER imports the backend; it
// talks to the Pear-end only through this client, which speaks the same
// {id, command, params} -> {id, ok, result|error} protocol the root index.js
// bridge exposes.
//
// Two transports, auto-detected:
//   1. Pear desktop: a newline-JSON pipe surfaced by pear-electron. The
//      renderer receives it via window.__pearBridgePipe (wired by the shell)
//      or, in the simplest pear-electron setup, the renderer is same-process
//      with the entry and window.__pearpaste is the in-process bridge object.
//   2. Dev / e2e harness: an in-process bridge object set on globalThis
//      (window.__pearpaste). Used so screens can be driven without a GUI.
//
// The client adds NOTHING that could leak — it forwards opaque params and
// returns the backend's already-renderer-safe result. It also surfaces the
// backend event stream (locked/unlocked/clip-captured/...) so screens can
// clear plaintext on lock/background without polling.

let _seq = 0

export function createBridgeClient () {
  const inproc = (typeof globalThis !== 'undefined' && globalThis.__pearpaste) || null
  let pipe = (typeof globalThis !== 'undefined' && globalThis.__pearBridgePipe) || null

  // Pear desktop: the renderer spawns the Bare Pear-end as a worker
  // (pear-run) and talks to it over the returned pipe (pear-pipe on the
  // worker side). This is the real transport — there is no injected global.
  if (!inproc && !pipe &&
      typeof globalThis !== 'undefined' && globalThis.Pear &&
      globalThis.Pear.worker && typeof globalThis.Pear.worker.run === 'function') {
    // Resolve the worker against the APP, not the renderer's cwd.
    //  - dev (`pear run --dev .`): a bare relative path works (app root == cwd).
    //  - staged: a bare path resolves against cwd -> ERR_INVALID_PROJECT_DIR,
    //    and an UNVERSIONED pear://<key> link has no manifest unless the app
    //    was `pear release`d (removed in current Pear). Pear.config exposes
    //    `length`+`fork`, so build the VERSIONED link
    //    pear://<fork>.<length>.<key>/backend/desktop-worker.mjs which always
    //    has a resolvable manifest (the running staged version).
    let workerLink = 'backend/desktop-worker.mjs'
    try {
      const cfg = (globalThis.Pear && globalThis.Pear.config) || {}
      const base = String(cfg.applink || cfg.link || '')
      // authority = "<key>" or "<fork>.<length>.<key>"; the bare key is the
      // last dot-segment. Do NOT assume a base32 charset (Pear keys are
      // z-base-32, which includes 0/1/8/9).
      const auth = base.startsWith('pear://') ? base.slice(7).split('/')[0] : ''
      const z32 = auth ? auth.split('.').pop() : ''
      if (!cfg.dev && z32 && cfg.length != null) {
        const ver = (cfg.fork != null ? cfg.fork : 0) + '.' + cfg.length + '.' + z32
        workerLink = 'pear://' + ver + '/backend/desktop-worker.mjs'
      } else if (!cfg.dev && z32) {
        workerLink = 'pear://' + z32 + '/backend/desktop-worker.mjs'
      }
    } catch (_) {}
    try {
      pipe = globalThis.Pear.worker.run(workerLink)
    } catch (_) {
      pipe = null
    }
  }

  const eventListeners = new Set()
  const pending = new Map()

  function onEvent (fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) }
  function emitEvent (event, payload) {
    for (const fn of eventListeners) { try { fn(event, payload) } catch (_) {} }
  }

  let request

  if (inproc && typeof inproc.request === 'function') {
    // In-process bridge (dev/e2e and the default pear-electron same-proc UI).
    if (typeof inproc.onMessage === 'function') {
      inproc.onMessage((m) => {
        if (m && m.type === 'event') emitEvent(m.event, m.payload)
      })
    }
    request = async (command, params) => {
      const id = ++_seq
      const res = await inproc.request({ id, command, params })
      if (res.result && res.result._promise) res.result = await res.result._promise
      if (!res.ok) { const e = new Error(res.error?.message || 'rpc error'); e.code = res.error?.code; throw e }
      return res.result
    }
  } else if (pipe && typeof pipe.write === 'function') {
    // Newline-JSON pipe transport.
    // pear-run pipes emit 'crash' { exitCode } if the worker dies — surface it
    // so the UI shows a recoverable error instead of hanging on pending calls.
    if (typeof pipe.on === 'function') {
      pipe.on('crash', (info) => {
        emitEvent('backend-crash', { exitCode: info && info.exitCode })
        for (const [, p] of pending) {
          try { p({ ok: false, error: { message: 'backend worker crashed', code: 'BACKEND_CRASH' } }) } catch (_) {}
        }
        pending.clear()
      })
    }
    // The worker pipe delivers bytes. In the Chromium renderer a chunk is a
    // Uint8Array, and Uint8Array.prototype.toString() yields "104,101,..."
    // (comma-joined byte values), NOT UTF-8 text — which makes every response
    // unparseable and silently drops all replies. Decode explicitly.
    const _dec = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null
    const toText = (chunk) => {
      if (typeof chunk === 'string') return chunk
      if (_dec) {
        if (chunk instanceof Uint8Array) return _dec.decode(chunk)
        if (chunk && chunk.buffer) return _dec.decode(new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength))
        try { return _dec.decode(chunk) } catch (_) {}
      }
      return (chunk && typeof chunk.toString === 'function' && !(chunk instanceof Uint8Array)) ? chunk.toString() : String(chunk)
    }
    let buf = ''
    pipe.on('data', (chunk) => {
      buf += toText(chunk)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg
        try { msg = JSON.parse(line) } catch (_) { continue }
        if (msg.type === 'event') { emitEvent(msg.event, msg.payload); continue }
        const p = pending.get(msg.id)
        if (p) { pending.delete(msg.id); p(msg) }
      }
    })
    request = (command, params) => new Promise((resolve, reject) => {
      const id = ++_seq
      pending.set(id, (res) => {
        if (!res.ok) { const e = new Error(res.error?.message || 'rpc error'); e.code = res.error?.code; reject(e) } else resolve(res.result)
      })
      pipe.write(JSON.stringify({ id, command, params }) + '\n')
    })
  } else {
    // No transport yet — fail loudly but recoverably so the UI can show a
    // "backend unavailable" state instead of a blank screen.
    request = async () => { const e = new Error('bridge transport unavailable'); e.code = 'NO_BRIDGE'; throw e }
  }

  const api = {
    onEvent,
    call: request,
    // typed helpers (thin — the contract is the backend's)
    createVault: (p) => request('CREATE_VAULT', p),
    restoreVault: (p) => request('RESTORE_VAULT', p),
    unlock: (secret, source = 'passphrase') => request('UNLOCK_VAULT', { secret, source }),
    lock: () => request('LOCK_VAULT', {}),
    noteList: (p = {}) => request('NOTE_LIST', p),
    noteOpen: (noteId) => request('NOTE_OPEN', { noteId }),
    noteClose: (noteId) => request('NOTE_CLOSE', { noteId }),
    noteUpsert: (note) => request('NOTE_UPSERT', { note }),
    noteDelete: (noteId, hard = false) => request('NOTE_DELETE', { noteId, hard }),
    clipList: (p = {}) => request('CLIP_LIST', p),
    clipOpen: (clipId) => request('CLIP_OPEN', { clipId }),
    clipClose: (clipId) => request('CLIP_CLOSE', { clipId }),
    clipCapture: (kind, body) => request('CLIP_CAPTURE', { kind, body }),
    clipCopy: (clipId) => request('CLIP_COPY', { clipId }),
    search: (q, limit = 50) => request('SEARCH', { q, limit }),
    deviceList: () => request('DEVICE_LIST', {}),
    deviceRevoke: (deviceId) => request('DEVICE_REVOKE', { deviceId }),
    pairCreateInvite: (ttlMs) => request('PAIR_CREATE_INVITE', { ttlMs }),
    pairLookupShortCode: (shortCode, timeoutMs) => request('PAIR_LOOKUP_SHORTCODE', { shortCode, timeoutMs }),
    pairAccept: (invite, label, platform, unlockSecret) => request('PAIR_ACCEPT', { invite, label, platform, unlockSecret }),
    pairApprove: (requestId) => request('PAIR_APPROVE', { requestId }),
    pairReject: (requestId) => request('PAIR_REJECT', { requestId }),
    relayStatus: () => request('RELAY_STATUS', {}),
    relaySetEnabled: (enabled) => request('RELAY_SET_ENABLED', { enabled }),
    networkStatus: () => request('NETWORK_STATUS', {}),
    verifyEncryption: () => request('VERIFY_ENCRYPTION', {}),
    // backend clipboard control (reserved local verb, not an RPC command)
    clipboard: (action, value) => request('__clipboard', { action, value })
  }
  return api
}

export default createBridgeClient
