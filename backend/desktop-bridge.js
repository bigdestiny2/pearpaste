// Desktop renderer bridge for the Pear-end.
//
// Kept separate from the root launcher so Pear workers can import the bridge
// without accidentally importing index.js and starting another desktop launcher.

import { COMMANDS } from './rpc.js'

// A thin object the UI talks to. In Pear it is reached over the pear-bridge
// IPC pipe (JSON line protocol); in dev/test it is consumed in-process. Either
// way the ONLY surface is request({command, params}) -> response, plus an
// event stream the backend pushes (locked/unlocked/clip-captured/...).
//
// Renderer contract is enforced by the backend (assertRendererSafe): keys never
// cross. This bridge adds nothing that could leak; it forwards opaque params
// and returns the handler's already-renderer-safe result.
export function createBridge (pearEnd) {
  const listeners = new Set()

  // Forward backend events to any attached transport (and discard payloads
  // that are not renderer-safe; backend events carry no secrets, but we keep
  // the surface minimal: name + a tiny renderer-safe meta only).
  const RELAY_EVENTS = [
    'locked', 'unlocked', 'device-unlocked', 'pair-invite-created',
    'pair-approval-needed', 'pair-approval-cleared', 'pair-rejected',
    'pair-admitted', 'paired',
    'clip-captured', 'clip-written', 'verifier-ran', 'device-revoked',
    'relay-enabled-changed', 'clipboard-mode-changed', 'clipboard-pause-changed',
    'backgrounded', 'foregrounded',
    // [AUDIT I-9] payload-less live-refresh signal — sanitizeEvent strips its
    // opaque {seq} down to a scalar; carries no content (see autobase-sync.js).
    'view-changed'
  ]
  for (const ev of RELAY_EVENTS) {
    pearEnd.ctx.on(ev, (payload) => {
      const safe = sanitizeEvent(payload)
      for (const fn of listeners) {
        try { fn({ type: 'event', event: ev, payload: safe }) } catch (_) {}
      }
    })
  }

  async function request ({ id, command, params }) {
    try {
      if (command === '__clipboard') {
        const result = clipboardControl(pearEnd, params)
        return { id, ok: true, result }
      }
      const result = await pearEnd.call(command, params || {})
      return { id, ok: true, result }
    } catch (err) {
      return {
        id,
        ok: false,
        error: { message: String((err && err.message) || err), code: err && err.code }
      }
    }
  }

  return {
    request,
    onMessage (fn) { listeners.add(fn); return () => listeners.delete(fn) },
    commands: COMMANDS,
    setVisibility (visible) {
      // Spec section 9.4/15: backgrounding clears selected-item plaintext.
      pearEnd.ctx.emit(visible ? 'foregrounded' : 'backgrounded')
    },
    setVisibilityTimeoutMs (ms) {
      // Optional convenience timeout for an open note (spec section 9.4 default 60s,
      // never across lock/background). notes-service reads ctx.state.visibilityMs.
      const n = Number(ms)
      pearEnd.ctx.state.visibilityMs = (n > 0 && n <= 600000) ? n : 60000
    },
    close: () => pearEnd.close()
  }
}

// Backend clipboard control is exposed on ctx by backend/clipboard.js. We do
// NOT add an RPC command id for it (spec section 22: schema-validated RPC set is
// fixed); the bridge multiplexes it under a reserved local "__clipboard" verb.
function clipboardControl (pearEnd, params = {}) {
  const cb = pearEnd.ctx.clipboard
  if (!cb) return { available: false, reason: 'clipboard-subsystem-pending' }
  const { action, value } = params
  switch (action) {
    case 'status': return { available: true, settings: cb.settings, stats: cb.stats }
    case 'setMode': return { available: true, settings: cb.setMode(value) }
    case 'setPaused': return { available: true, settings: cb.setPaused(value) }
    case 'setPollMs': return { available: true, settings: cb.setPollMs(value) }
    case 'setDebounceMs': return { available: true, settings: cb.setDebounceMs(value) }
    case 'setExclusions': return { available: true, settings: cb.setExclusions(value) }
    case 'captureNow': return { available: true, ...(awaitable(cb.captureNow())) }
    case 'writeToOS': {
      const text = value && typeof value.text === 'string' ? value.text : ''
      const opts = value && value.opts && typeof value.opts === 'object' ? value.opts : {}
      return { available: true, ...(awaitable(cb.writeToOS(text, opts))) }
    }
    default: return { available: true, settings: cb.settings, stats: cb.stats }
  }
}

// captureNow/writeToOS return promises; the bridge request() is async so the
// in-process client or worker transport can resolve them before returning.
function awaitable (maybePromise) {
  return { _promise: maybePromise }
}

function sanitizeEvent (payload) {
  if (payload == null || typeof payload !== 'object') return payload ?? null
  // strip anything that smells secret even though backend events don't carry it
  const out = {}
  for (const [k, v] of Object.entries(payload)) {
    if (/secret|key|mnemonic|passphrase|body|plaintext|seed/i.test(k)) continue
    if (typeof v === 'object') continue
    out[k] = v
  }
  return out
}

export default createBridge
