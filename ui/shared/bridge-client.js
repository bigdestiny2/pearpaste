// Renderer-side bridge client (spec §15). The UI NEVER imports the backend; it
// talks to the Pear-end only through this client, which speaks the same
// {id, command, params} -> {id, ok, result|error} protocol the root index.js
// bridge exposes.
//
// Four transports, auto-detected:
//   1. Pear desktop: a newline-JSON pipe surfaced by pear-electron. The
//      renderer receives it via window.__pearBridgePipe (wired by the shell)
//      or, in the simplest pear-electron setup, the renderer is same-process
//      with the entry and window.__pearpaste is the in-process bridge object.
//   2. Electron (pear-runtime + Forge path): the sandboxed preload exposes
//      window.bridge (worker IPC relay per the hello-pear-electron
//      boilerplate). Adapted below to the same pipe interface — the worker
//      (/workers/paste.js) speaks the identical newline-JSON protocol.
//   3. Dev / e2e harness: an in-process bridge object set on globalThis
//      (window.__pearpaste). Used so screens can be driven without a GUI.
//   4. Self-hosted web: a same-origin HTTP/SSE bridge exposed by
//      server/web.mjs for Umbrel, StartOS, and local browser smoke tests.
//
// The client adds NOTHING that could leak — it forwards opaque params and
// returns the backend's already-renderer-safe result. It also surfaces the
// backend event stream (locked/unlocked/clip-captured/...) so screens can
// clear plaintext on lock/background without polling.

let _seq = 0
const DEFAULT_WEB_TIMEOUT_MS = 60000
const PAIR_WEB_TIMEOUT_MS = 7 * 60 * 1000

export function createBridgeClient () {
  const inproc = (typeof globalThis !== 'undefined' && globalThis.__pearpaste) || null
  let pipe = (typeof globalThis !== 'undefined' && globalThis.__pearBridgePipe) || null
  const eventListeners = new Set()
  const pending = new Map()
  const chunkDecoder = (typeof TextDecoder !== 'undefined') ? new TextDecoder('utf-8') : null

  function onEvent (fn) { eventListeners.add(fn); return () => eventListeners.delete(fn) }
  function emitEvent (event, payload) {
    for (const fn of eventListeners) { try { fn(event, payload) } catch (_) {} }
  }

  function toText (chunk) {
    if (typeof chunk === 'string') return chunk
    if (chunkDecoder) {
      if (chunk instanceof Uint8Array) return chunkDecoder.decode(chunk)
      if (chunk && chunk.buffer) return chunkDecoder.decode(new Uint8Array(chunk.buffer, chunk.byteOffset || 0, chunk.byteLength))
      try { return chunkDecoder.decode(chunk) } catch (_) {}
    }
    return (chunk && typeof chunk.toString === 'function' && !(chunk instanceof Uint8Array)) ? chunk.toString() : String(chunk)
  }

  function unavailableUpdateMethod () {
    const e = new Error('updates are unavailable on this transport')
    e.code = 'UPDATES_UNAVAILABLE'
    throw e
  }

  let supportsUpdates = false
  let applyUpdate = async () => unavailableUpdateMethod()
  let appAfterUpdate = async () => unavailableUpdateMethod()

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

  // Electron (pear-runtime + Forge path, hello-pear-electron conventions):
  // electron/preload.cjs exposes window.bridge. Start the Paste Pear-end
  // worker plus the OTA updater worker, and adapt the preload relay to the
  // pipe interface so the newline-JSON branch below is reused verbatim.
  if (!inproc && !pipe &&
      typeof globalThis !== 'undefined' && globalThis.bridge &&
      typeof globalThis.bridge.startWorker === 'function') {
    const eb = globalThis.bridge
    const spec = '/workers/paste.js'
    const updaterSpec = '/workers/main.js'
    try {
      eb.startWorker(spec)
      eb.startWorker(updaterSpec) // OTA updater (no-op under --no-updates)
      const dataListeners = new Set()
      const crashListeners = new Set()
      eb.onWorkerIPC(spec, (data) => { for (const fn of dataListeners) { try { fn(data) } catch (_) {} } })
      eb.onWorkerExit(spec, (code) => { for (const fn of crashListeners) { try { fn({ exitCode: code }) } catch (_) {} } })
      if (typeof eb.onWorkerIPC === 'function') {
        eb.onWorkerIPC(updaterSpec, (data) => {
          const frames = toText(data).split(/\r?\n/)
          for (const raw of frames) {
            const message = raw.trim()
            if (!message) continue
            if (message === 'updating') emitEvent('ota-updating', {})
            else if (message === 'updated') emitEvent('ota-updated', {})
            else if (message.startsWith('pear:updateError:')) {
              emitEvent('ota-error', { message: message.slice('pear:updateError:'.length) || 'update failed' })
            } else {
              let parsed = null
              try { parsed = JSON.parse(message) } catch (_) {}
              if (parsed && parsed.type === 'pear:updateError') {
                emitEvent('ota-error', { message: parsed.message || 'update failed', code: parsed.code })
              }
            }
          }
        })
      }
      if (typeof eb.onWorkerExit === 'function') {
        eb.onWorkerExit(updaterSpec, (code) => emitEvent('ota-worker-exit', { exitCode: code }))
      }
      if (typeof eb.applyUpdate === 'function' && typeof eb.appAfterUpdate === 'function') {
        supportsUpdates = true
        applyUpdate = async () => {
          emitEvent('ota-applying', {})
          try {
            const result = await eb.applyUpdate()
            emitEvent('ota-applied', result || {})
            return result || { applied: true }
          } catch (err) {
            emitEvent('ota-error', { message: err && err.message ? err.message : 'update failed', code: err && err.code })
            throw err
          }
        }
        appAfterUpdate = async () => eb.appAfterUpdate()
      }
      // Surface worker logs in the renderer console (parity with `pear run`).
      if (chunkDecoder && typeof eb.onWorkerStderr === 'function') {
        eb.onWorkerStderr(spec, (d) => { try { console.error('[paste-worker]', toText(d)) } catch (_) {} })
      }
      pipe = {
        write (s) { eb.writeWorkerIPC(spec, s); return true },
        on (ev, fn) {
          if (ev === 'data') dataListeners.add(fn)
          else if (ev === 'crash') crashListeners.add(fn)
        }
      }
    } catch (_) {
      pipe = null
    }
  }

  let request
  let setVisibility = () => {}
  let closeTransport = () => {}

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
    if (typeof inproc.setVisibility === 'function') {
      setVisibility = (visible) => {
        try { inproc.setVisibility(!!visible) } catch (_) {}
      }
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
    const sendPipeMessage = (msg) => pipe.write(JSON.stringify(msg) + '\n')
    setVisibility = (visible) => {
      try { sendPipeMessage({ type: 'visibility', visible: !!visible }) } catch (_) {}
    }
    request = (command, params) => new Promise((resolve, reject) => {
      const id = ++_seq
      pending.set(id, (res) => {
        if (!res.ok) { const e = new Error(res.error?.message || 'rpc error'); e.code = res.error?.code; reject(e) } else resolve(res.result)
      })
      try {
        sendPipeMessage({ id, command, params })
      } catch (err) {
        pending.delete(id)
        reject(err)
      }
    })
  } else if (typeof fetch === 'function' &&
      typeof globalThis !== 'undefined' &&
      globalThis.location &&
      /^https?:$/.test(String(globalThis.location.protocol))) {
    // Same-origin web transport. Requests use POST /rpc, while backend events
    // stream over EventSource /events. This keeps the renderer contract exactly
    // the same as the desktop pipe transport without exposing backend modules.
    let webHadFailure = false
    const EventSourceCtor = typeof globalThis !== 'undefined' ? globalThis.EventSource : null
    if (typeof EventSourceCtor === 'function') {
      try {
        const events = new EventSourceCtor('/events')
        let closed = false
        const closeEvents = () => {
          if (closed) return
          closed = true
          try { events.close() } catch (_) {}
          if (typeof globalThis.removeEventListener === 'function') {
            try { globalThis.removeEventListener('pagehide', closeEvents) } catch (_) {}
            try { globalThis.removeEventListener('beforeunload', closeEvents) } catch (_) {}
          }
        }
        closeTransport = closeEvents
        if (typeof globalThis.addEventListener === 'function') {
          try { globalThis.addEventListener('pagehide', closeEvents, { once: true }) } catch (_) {}
          try { globalThis.addEventListener('beforeunload', closeEvents, { once: true }) } catch (_) {}
        }
        events.onopen = () => {
          if (closed) return
          webHadFailure = false
          emitEvent('backend-available', {})
        }
        events.onmessage = (ev) => {
          if (closed) return
          let msg
          try { msg = JSON.parse(ev.data) } catch (_) { return }
          if (msg && msg.type === 'event') emitEvent(msg.event, msg.payload)
        }
        events.onerror = () => {
          if (closed) return
          webHadFailure = true
          emitEvent('backend-unavailable', {})
        }
      } catch (_) {}
    }
    const postJson = async (path, body, timeoutMs = DEFAULT_WEB_TIMEOUT_MS) => {
      const ac = typeof AbortController !== 'undefined' && timeoutMs > 0 ? new AbortController() : null
      const timer = ac
        ? setTimeout(() => ac.abort(), timeoutMs)
        : null
      if (timer && timer.unref) timer.unref()
      let res
      try {
        res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: ac ? ac.signal : undefined
        })
      } catch (err) {
        const e = new Error(err && err.name === 'AbortError' ? 'backend request timed out' : 'backend unavailable')
        e.code = err && err.name === 'AbortError' ? 'RPC_TIMEOUT' : 'BACKEND_UNAVAILABLE'
        webHadFailure = true
        emitEvent('backend-unavailable', { code: e.code })
        throw e
      } finally {
        if (timer) clearTimeout(timer)
      }
      const text = await res.text()
      let msg = null
      try { msg = text ? JSON.parse(text) : null } catch (_) {}
      if (!res.ok) {
        const e = new Error((msg && msg.error && msg.error.message) || ('HTTP ' + res.status))
        e.code = (msg && msg.error && msg.error.code) || ('HTTP_' + res.status)
        if (res.status >= 500 || res.status === 0) {
          webHadFailure = true
          emitEvent('backend-unavailable', { code: e.code })
        }
        throw e
      }
      if (webHadFailure) {
        webHadFailure = false
        emitEvent('backend-available', {})
      }
      return msg
    }
    const timeoutFor = (command, params) => {
      if (command === 'PAIR_ACCEPT') return PAIR_WEB_TIMEOUT_MS
      if (command === 'PAIR_LOOKUP_SHORTCODE') return Math.max(DEFAULT_WEB_TIMEOUT_MS, Number(params && params.timeoutMs) + 10000 || DEFAULT_WEB_TIMEOUT_MS)
      if (command === 'PAIR_CREATE_INVITE') return 120000
      return DEFAULT_WEB_TIMEOUT_MS
    }
    setVisibility = (visible) => {
      postJson('/visibility', { visible: !!visible }, 10000).catch(() => {})
    }
    request = async (command, params) => {
      const id = ++_seq
      const msg = await postJson('/rpc', { id, command, params }, timeoutFor(command, params))
      if (!msg || !msg.ok) {
        const e = new Error(msg && msg.error ? msg.error.message : 'rpc error')
        e.code = msg && msg.error && msg.error.code
        throw e
      }
      return msg.result
    }
  } else {
    // No transport yet — fail loudly but recoverably so the UI can show a
    // "backend unavailable" state instead of a blank screen.
    request = async () => { const e = new Error('bridge transport unavailable'); e.code = 'NO_BRIDGE'; throw e }
  }

  const api = {
    onEvent,
    call: request,
    setVisibility,
    close: closeTransport,
    supportsUpdates,
    applyUpdate,
    appAfterUpdate,
    // typed helpers (thin — the contract is the backend's)
    vaultStatus: () => request('VAULT_STATUS', {}),
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
