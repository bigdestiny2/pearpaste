// Paste RPC contract.
//
// The single schema-validated boundary between any UI shell (desktop Pear /
// pear-electron, mobile React Native via bare-rpc) and the Pear-end. UI shells
// import COMMANDS and call through a Dispatcher; the Pear-end registers
// handlers. No vault keys ever cross this boundary; plaintext crosses only for
// the one item the user explicitly opened/copied/exported.
//
// Spec refs: §15 (API surface + renderer contract), §22 (schema-validated).

import { ERROR_CODES } from './shared-ops.js'

export const COMMANDS = Object.freeze({
  UNLOCK_VAULT: 'UNLOCK_VAULT',
  LOCK_VAULT: 'LOCK_VAULT',
  CREATE_VAULT: 'CREATE_VAULT',
  RESTORE_VAULT: 'RESTORE_VAULT',
  PAIR_CREATE_INVITE: 'PAIR_CREATE_INVITE',
  PAIR_LOOKUP_SHORTCODE: 'PAIR_LOOKUP_SHORTCODE',
  PAIR_ACCEPT: 'PAIR_ACCEPT',
  PAIR_APPROVE: 'PAIR_APPROVE',
  PAIR_REJECT: 'PAIR_REJECT',
  DEVICE_LIST: 'DEVICE_LIST',
  DEVICE_REVOKE: 'DEVICE_REVOKE',
  NOTE_LIST: 'NOTE_LIST',
  NOTE_OPEN: 'NOTE_OPEN',
  NOTE_CLOSE: 'NOTE_CLOSE',
  NOTE_UPSERT: 'NOTE_UPSERT',
  NOTE_DELETE: 'NOTE_DELETE',
  CLIP_LIST: 'CLIP_LIST',
  CLIP_OPEN: 'CLIP_OPEN',
  CLIP_CLOSE: 'CLIP_CLOSE',
  CLIP_CAPTURE: 'CLIP_CAPTURE',
  CLIP_COPY: 'CLIP_COPY',
  SEARCH: 'SEARCH',
  RELAY_STATUS: 'RELAY_STATUS',
  RELAY_SET_ENABLED: 'RELAY_SET_ENABLED',
  NETWORK_STATUS: 'NETWORK_STATUS',
  VERIFY_ENCRYPTION: 'VERIFY_ENCRYPTION',
  EXPORT_ENCRYPTED_BACKUP: 'EXPORT_ENCRYPTED_BACKUP',
  IMPORT_ENCRYPTED_BACKUP: 'IMPORT_ENCRYPTED_BACKUP'
})

// Commands allowed while the vault is locked. Everything else is rejected with
// VAULT_LOCKED until UNLOCK_VAULT succeeds.
export const UNLOCKED_NOT_REQUIRED = new Set([
  COMMANDS.UNLOCK_VAULT,
  COMMANDS.CREATE_VAULT,
  COMMANDS.RESTORE_VAULT,
  COMMANDS.PAIR_ACCEPT,
  COMMANDS.PAIR_LOOKUP_SHORTCODE,
  COMMANDS.LOCK_VAULT,
  COMMANDS.RELAY_STATUS,
  COMMANDS.NETWORK_STATUS,
  COMMANDS.VERIFY_ENCRYPTION
])

// Tiny dependency-free schema validator. Field spec:
//   { type: 'string'|'number'|'boolean'|'object'|'array', required, enum, of }
function validateField (name, value, spec) {
  if (value === undefined || value === null) {
    if (spec.required) throw schemaError(`missing required field: ${name}`)
    return
  }
  const t = Array.isArray(value) ? 'array' : typeof value
  if (spec.type && t !== spec.type) {
    throw schemaError(`field ${name} expected ${spec.type}, got ${t}`)
  }
  if (spec.enum && !spec.enum.includes(value)) {
    throw schemaError(`field ${name} not in [${spec.enum.join(', ')}]`)
  }
  if (spec.type === 'array' && spec.of) {
    for (const v of value) {
      const actual = typeof v
      if (actual !== spec.of) throw schemaError(`array ${name} expects ${spec.of} elements`)
    }
  }
}

function schemaError (msg) {
  const e = new Error(msg)
  e.code = ERROR_CODES.SCHEMA_INVALID
  return e
}

// Request schemas. Absent entry => params not constrained (still validated to
// be an object). Responses are not schema-bound but MUST obey the renderer
// contract below.
export const SCHEMAS = Object.freeze({
  [COMMANDS.UNLOCK_VAULT]: { secret: { type: 'string', required: true }, source: { type: 'string', enum: ['passphrase', 'keychain'] } },
  [COMMANDS.CREATE_VAULT]: { label: { type: 'string' }, platform: { type: 'string' }, passphrase: { type: 'string' } },
  [COMMANDS.RESTORE_VAULT]: { mnemonic: { type: 'string', required: true }, passphrase: { type: 'string' }, highSecurity: { type: 'boolean' } },
  [COMMANDS.PAIR_CREATE_INVITE]: { ttlMs: { type: 'number' } },
  [COMMANDS.PAIR_LOOKUP_SHORTCODE]: { shortCode: { type: 'string', required: true }, timeoutMs: { type: 'number' } },
  [COMMANDS.PAIR_ACCEPT]: { invite: { type: 'string', required: true }, label: { type: 'string' }, platform: { type: 'string' }, unlockSecret: { type: 'string' } },
  [COMMANDS.PAIR_APPROVE]: { requestId: { type: 'string', required: true } },
  [COMMANDS.PAIR_REJECT]: { requestId: { type: 'string', required: true } },
  [COMMANDS.DEVICE_REVOKE]: { deviceId: { type: 'string', required: true } },
  [COMMANDS.NOTE_LIST]: { query: { type: 'string' }, limit: { type: 'number' }, cursor: { type: 'string' } },
  [COMMANDS.NOTE_OPEN]: { noteId: { type: 'string', required: true } },
  [COMMANDS.NOTE_CLOSE]: { noteId: { type: 'string', required: true } },
  [COMMANDS.NOTE_UPSERT]: { note: { type: 'object', required: true } },
  [COMMANDS.NOTE_DELETE]: { noteId: { type: 'string', required: true }, hard: { type: 'boolean' } },
  [COMMANDS.CLIP_LIST]: { limit: { type: 'number' } },
  [COMMANDS.CLIP_OPEN]: { clipId: { type: 'string', required: true } },
  [COMMANDS.CLIP_CLOSE]: { clipId: { type: 'string', required: true } },
  [COMMANDS.CLIP_CAPTURE]: { kind: { type: 'string', enum: ['text', 'url', 'code'] }, body: { type: 'string', required: true } },
  [COMMANDS.CLIP_COPY]: { clipId: { type: 'string', required: true } },
  [COMMANDS.SEARCH]: { q: { type: 'string', required: true }, limit: { type: 'number' } },
  [COMMANDS.RELAY_SET_ENABLED]: { enabled: { type: 'boolean', required: true } },
  [COMMANDS.DEVICE_REVOKE]: { deviceId: { type: 'string', required: true } },
  [COMMANDS.EXPORT_ENCRYPTED_BACKUP]: { destPath: { type: 'string', required: true }, plaintext: { type: 'boolean' } },
  [COMMANDS.IMPORT_ENCRYPTED_BACKUP]: { srcPath: { type: 'string', required: true } }
})

export function validateRequest (command, params) {
  if (!Object.values(COMMANDS).includes(command)) {
    throw schemaError('unknown command: ' + command)
  }
  const p = params || {}
  if (typeof p !== 'object' || Array.isArray(p)) throw schemaError('params must be an object')
  const schema = SCHEMAS[command]
  if (schema) for (const [name, spec] of Object.entries(schema)) validateField(name, p[name], spec)
  return p
}

// Dispatcher: register Pear-end handlers, then `call()` from the UI bridge.
// Enforces lock state and schema before any handler runs, and never logs
// params for content commands.
export class RpcDispatcher {
  constructor ({ isUnlocked = () => false, logger = null } = {}) {
    this._handlers = new Map()
    this._isUnlocked = isUnlocked
    this._log = logger
  }

  register (command, handler) {
    if (!Object.values(COMMANDS).includes(command)) {
      throw new Error('cannot register unknown command: ' + command)
    }
    this._handlers.set(command, handler)
    return this
  }

  async call (command, params, ctx = {}) {
    const p = validateRequest(command, params)
    if (!UNLOCKED_NOT_REQUIRED.has(command) && !this._isUnlocked()) {
      const e = new Error('vault is locked')
      e.code = ERROR_CODES.LOCKED
      throw e
    }
    const handler = this._handlers.get(command)
    if (!handler) throw new Error('no handler registered for ' + command)
    if (this._log) this._log.debug('rpc', { command }) // never log params
    const result = await handler(p, ctx)
    return assertRendererSafe(command, result, { allowMnemonic: command === COMMANDS.CREATE_VAULT })
  }

  has (command) { return this._handlers.has(command) }
}

// Renderer contract assertions (spec §15). The Pear-end calls these before
// returning a response so a handler bug cannot leak keys/secrets to the UI.
//
// Secret KEY material may NEVER cross the boundary. The 24-word recovery
// phrase is a deliberate, one-time, user-facing exception at vault creation
// (spec §14 "show 24-word phrase once with confirmation") and is permitted
// ONLY when the caller explicitly opts in.
const SECRET_KEY_RE = /^(vaultKey|indexKey|itemKey|rootSeed|signingSecretKey|boxSecretKey|deviceSecretKey|signSeed|deviceAdminSeed)$/i

export function assertRendererSafe (command, response, { allowMnemonic = false } = {}) {
  const badKey = findUnsafeResponseKey(response, { allowMnemonic })
  if (badKey && SECRET_KEY_RE.test(badKey)) {
    throw new Error('renderer contract violation: secret key material in response to ' + command)
  }
  if (badKey && /^passphrase$/i.test(badKey)) {
    throw new Error('renderer contract violation: passphrase echoed in response to ' + command)
  }
  if (badKey && /^mnemonic$/i.test(badKey)) {
    throw new Error('renderer contract violation: recovery phrase in response to ' + command)
  }
  return response
}

function findUnsafeResponseKey (value, { allowMnemonic }, seen = new Set()) {
  if (value == null || typeof value !== 'object') return null
  if (seen.has(value)) return null
  seen.add(value)
  if (Array.isArray(value)) {
    for (const v of value) {
      const bad = findUnsafeResponseKey(v, { allowMnemonic }, seen)
      if (bad) return bad
    }
    return null
  }
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(k) || /^passphrase$/i.test(k) || (!allowMnemonic && /^mnemonic$/i.test(k))) return k
    const bad = findUnsafeResponseKey(v, { allowMnemonic }, seen)
    if (bad) return bad
  }
  return null
}

export default {
  COMMANDS,
  SCHEMAS,
  UNLOCKED_NOT_REQUIRED,
  validateRequest,
  RpcDispatcher,
  assertRendererSafe
}
