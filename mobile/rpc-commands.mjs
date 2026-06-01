// Paste mobile RPC bridge contract.
//
// ONE place, imported by BOTH ends of the mobile bridge:
//   - the Bare worklet (server) in mobile/backend/worklet.mjs
//   - the React Native app (client) in mobile/app/lib/usePearPasteRpc (file
//     identifier preserved — see Paste mobile pairing module)
//
// `bare-rpc` addresses commands by a small integer id, not a string, so this
// module assigns one stable numeric id per backend COMMANDS entry and exposes a
// transport-agnostic request/response framing that works over:
//   - a real `bare-rpc` RPC instance (phone), and
//   - any duplex stream pair (the desktop/Node smoke test) — same wire format.
//
// The framing payload is JSON: `{ id, ok, result }` or `{ id, ok:false, error
// }`. No vault keys ever cross this bridge — that invariant is enforced by the
// backend's assertRendererSafe() before a result is ever handed back here
// (spec §15 renderer contract, §22 schema-validated boundary).
//
// Spec refs: §13 (mobile runtime), §15 (API surface), §22 (contracts).

import { COMMANDS } from '../backend/rpc.js'

export { COMMANDS }

// Stable numeric ids. bare-rpc requires a positive integer command id; the
// table is frozen and append-only — never renumber an existing command or a
// shipped app talking to a newer worklet (or vice-versa) would misroute calls.
export const COMMAND_IDS = Object.freeze({
  [COMMANDS.UNLOCK_VAULT]: 1,
  [COMMANDS.LOCK_VAULT]: 2,
  [COMMANDS.CREATE_VAULT]: 3,
  [COMMANDS.RESTORE_VAULT]: 4,
  [COMMANDS.PAIR_CREATE_INVITE]: 5,
  [COMMANDS.PAIR_ACCEPT]: 6,
  [COMMANDS.DEVICE_LIST]: 7,
  [COMMANDS.DEVICE_REVOKE]: 8,
  [COMMANDS.NOTE_LIST]: 9,
  [COMMANDS.NOTE_OPEN]: 10,
  [COMMANDS.NOTE_CLOSE]: 11,
  [COMMANDS.NOTE_UPSERT]: 12,
  [COMMANDS.NOTE_DELETE]: 13,
  [COMMANDS.CLIP_LIST]: 14,
  [COMMANDS.CLIP_OPEN]: 15,
  [COMMANDS.CLIP_CLOSE]: 16,
  [COMMANDS.CLIP_CAPTURE]: 17,
  [COMMANDS.CLIP_COPY]: 18,
  [COMMANDS.SEARCH]: 19,
  [COMMANDS.RELAY_STATUS]: 20,
  [COMMANDS.RELAY_SET_ENABLED]: 21,
  [COMMANDS.VERIFY_ENCRYPTION]: 22,
  [COMMANDS.EXPORT_ENCRYPTED_BACKUP]: 23,
  [COMMANDS.IMPORT_ENCRYPTED_BACKUP]: 24,
  // Append-only — never renumber existing ids (see comment above).
  [COMMANDS.PAIR_LOOKUP_SHORTCODE]: 25,
  [COMMANDS.PAIR_APPROVE]: 26,
  [COMMANDS.PAIR_REJECT]: 27,
  [COMMANDS.NETWORK_STATUS]: 28
})

// A single channel id reused by every command (the command name is carried in
// the JSON frame). bare-rpc multiplexes by this id on the shared stream.
export const RPC_CHANNEL = 1

export const ID_TO_COMMAND = Object.freeze(
  Object.fromEntries(Object.entries(COMMAND_IDS).map(([k, v]) => [v, k]))
)

// ---- framing helpers (transport agnostic) ---------------------------------
const enc = new TextEncoder()
const dec = new TextDecoder()

export function encodeRequest (seq, command, params) {
  return enc.encode(JSON.stringify({ seq, command, params: params || {} }))
}

export function decodeRequest (bytes) {
  return JSON.parse(typeof bytes === 'string' ? bytes : dec.decode(bytes))
}

export function encodeResponse (seq, ok, payload) {
  return enc.encode(JSON.stringify(
    ok ? { seq, ok: true, result: payload } : { seq, ok: false, error: payload }
  ))
}

export function decodeResponse (bytes) {
  return JSON.parse(typeof bytes === 'string' ? bytes : dec.decode(bytes))
}

// Normalize a thrown error into a wire-safe, redacted shape. We deliberately
// drop the stack and never echo params so a worklet error path cannot leak a
// note body / secret into the RN layer or a crash report (spec §8.3, §22).
export function errorToWire (err) {
  return {
    code: (err && err.code) || 'ERR',
    message: String((err && err.message) || err || 'unknown error')
  }
}

export class RpcError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'RpcError'
    this.code = code
  }
}

// ============================================================================
// Server loop — transport agnostic.
//
// `send(bytes)` writes one response frame; the caller pumps inbound request
// frames into `onRequest(bytes)`. The real worklet wires this to bare-rpc; the
// smoke test wires it to an in-process duplex. Either way every request is
// funnelled through the backend dispatcher, which enforces lock state, schema,
// and the renderer contract before any handler runs.
// ============================================================================
export function createRpcServer ({ pearEnd, send, log = null }) {
  let closed = false
  async function onRequest (bytes) {
    if (closed) return
    let req
    try {
      req = decodeRequest(bytes)
    } catch (err) {
      // Unframeable input: cannot correlate a seq, so drop (defensive).
      if (log) log.warn && log.warn('rpc-bad-frame', { err: String(err) })
      return
    }
    const { seq, command, params } = req
    try {
      if (!command || !(command in COMMAND_IDS)) {
        throw new RpcError('UNKNOWN_COMMAND', 'unknown command: ' + command)
      }
      const result = await pearEnd.call(command, params)
      send(encodeResponse(seq, true, result))
    } catch (err) {
      // Backend errors (VAULT_LOCKED, NOT_FOUND, BAD_MNEMONIC, schema, …) and
      // unexpected worklet faults are reported as a recoverable error frame.
      send(encodeResponse(seq, false, errorToWire(err)))
    }
  }
  return {
    onRequest,
    close () { closed = true }
  }
}

// ============================================================================
// Client — transport agnostic.
//
// `send(bytes)` writes one request frame; the caller pumps inbound response
// frames into `onResponse(bytes)`. Returns a typed wrapper with one method per
// backend command plus a generic `call()`.
// ============================================================================
export function createRpcClient ({ send, timeoutMs = 30000 }) {
  let seq = 0
  const pending = new Map() // seq -> { resolve, reject, timer }

  function onResponse (bytes) {
    let msg
    try {
      msg = decodeResponse(bytes)
    } catch (_) {
      return
    }
    const p = pending.get(msg.seq)
    if (!p) return
    pending.delete(msg.seq)
    clearTimeout(p.timer)
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new RpcError(msg.error && msg.error.code, msg.error && msg.error.message))
  }

  function call (command, params) {
    if (!(command in COMMAND_IDS)) {
      return Promise.reject(new RpcError('UNKNOWN_COMMAND', 'unknown command: ' + command))
    }
    const s = ++seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.delete(s)) {
          reject(new RpcError('RPC_TIMEOUT', command + ' timed out after ' + timeoutMs + 'ms'))
        }
      }, timeoutMs)
      if (timer.unref) timer.unref()
      pending.set(s, { resolve, reject, timer })
      try {
        send(encodeRequest(s, command, params))
      } catch (err) {
        pending.delete(s)
        clearTimeout(timer)
        reject(new RpcError('RPC_SEND_FAILED', String(err && err.message || err)))
      }
    })
  }

  function rejectAll (reason) {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(new RpcError('RPC_DISCONNECTED', reason || 'worklet disconnected'))
    }
    pending.clear()
  }

  // typed surface — one method per command, named camelCase off the command
  const api = { call, onResponse, rejectAll }
  for (const command of Object.keys(COMMAND_IDS)) {
    const method = command.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    api[method] = (params) => call(command, params)
  }
  return api
}

export default {
  COMMANDS,
  COMMAND_IDS,
  ID_TO_COMMAND,
  RPC_CHANNEL,
  encodeRequest,
  decodeRequest,
  encodeResponse,
  decodeResponse,
  errorToWire,
  RpcError,
  createRpcServer,
  createRpcClient
}
