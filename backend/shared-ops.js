// Paste shared operation contract.
//
// Every agent (crypto/sync, relay, desktop, mobile, security) imports the
// constants and the field classifier here so replicated data stays consistent
// and §22 ("every replicated field classified as public / encrypted /
// forbidden") is enforceable in one place.
//
// Spec refs: §7.5 (operation log), §9.5 (conflict resolution), §22 (contracts).

export const OP_TYPES = Object.freeze({
  NOTE_UPSERT: 'NOTE_UPSERT',
  NOTE_DELETE: 'NOTE_DELETE',
  CLIP_ADD: 'CLIP_ADD',
  CLIP_DELETE: 'CLIP_DELETE',
  DEVICE_ADD: 'DEVICE_ADD',
  DEVICE_REVOKE: 'DEVICE_REVOKE',
  KEY_ROTATE: 'KEY_ROTATE',
  ACK: 'ACK'
})

export const SCHEMAS = Object.freeze({
  NOTE: 'note.v1',
  CLIP: 'clip.v1',
  DEVICE: 'device.v1',
  SETTING: 'setting.v1',
  SEARCH_POINTER: 'search-pointer.v1',
  PAIR_BOOTSTRAP: 'pair-bootstrap.v1'
})

export const ENVELOPE_VERSION = 1

// Field classification. The replicated op header may carry ONLY `public`
// fields. Everything user-derived is `encrypted` (must travel inside a
// CryptoEnvelope) or `forbidden` (must never be serialized anywhere).
export const FIELD_CLASS = Object.freeze({
  PUBLIC: 'public',
  ENCRYPTED: 'encrypted',
  FORBIDDEN: 'forbidden'
})

const HEADER_PUBLIC_FIELDS = new Set([
  'version', 'opId', 'vaultId', 'deviceId', 'type',
  'objectBlindId', 'lamport', 'createdAtBucket',
  // Epoch ride-along (design §5.5, RT-FIX B5): `epoch` is a small monotone
  // ordering counter and `epochTag` an opaque content-addressing hash. Both are
  // public-only — they leak that a rotation count exists, never content,
  // identity, or roster — so KEY_ROTATE / post-rotation content ops carrying
  // them pass assertHeaderPublicOnly. Legacy/epoch-0 ops omit them entirely.
  'epoch', 'epochTag'
])

const FORBIDDEN_FIELDS = new Set([
  'mnemonic', 'recoveryPhrase', 'passphrase', 'rootSeed',
  'vaultKey', 'indexKey', 'itemKey', 'deviceSecretKey', 'signingSecretKey',
  'boxSecretKey', 'pairingSecret', 'plaintext', 'noteBody', 'clipBody'
])

// Classify a single op-header field name.
export function classifyHeaderField (name) {
  if (FORBIDDEN_FIELDS.has(name)) return FIELD_CLASS.FORBIDDEN
  if (HEADER_PUBLIC_FIELDS.has(name)) return FIELD_CLASS.PUBLIC
  return FIELD_CLASS.ENCRYPTED
}

// Throw if an object intended for the replicated header carries any field that
// is not explicitly public. Used by autobase-sync before append and by the
// verifier when scanning stored ops.
export function assertHeaderPublicOnly (header) {
  for (const k of Object.keys(header)) {
    if (classifyHeaderField(k) !== FIELD_CLASS.PUBLIC) {
      throw new ForbiddenFieldError(k)
    }
  }
  return true
}

export class ForbiddenFieldError extends Error {
  constructor (field) {
    super('forbidden/non-public field in replicated header: ' + field)
    this.name = 'ForbiddenFieldError'
    this.code = 'FORBIDDEN_FIELD'
    this.field = field
  }
}

// Coarse time bucket (hour granularity) — headers must not carry exact
// timestamps unless necessary (spec §7.5 createdAtBucket).
export function timeBucket (ms = Date.now(), windowMs = 3600_000) {
  return String(Math.floor(ms / windowMs) * windowMs)
}

// Lamport clock with deterministic tie-break by deviceId (spec §9.5):
// winner = max(lamport, deviceId)
export class Lamport {
  constructor (start = 0) { this.value = start }
  tick () { return ++this.value }
  observe (other) {
    const n = typeof other === 'string' ? parseInt(other, 10) : other
    if (Number.isFinite(n)) this.value = Math.max(this.value, n)
    return this.value
  }

  static beats (a, b) {
    // a, b: { lamport, deviceId }
    const la = Number(a.lamport); const lb = Number(b.lamport)
    if (la !== lb) return la > lb
    return String(a.deviceId) > String(b.deviceId)
  }
}

export const ERROR_CODES = Object.freeze({
  LOCKED: 'VAULT_LOCKED',
  BAD_SIGNATURE: 'BAD_SIGNATURE',
  REVOKED_DEVICE: 'REVOKED_DEVICE',
  AEAD_FAIL: 'AEAD_FAIL',
  FORBIDDEN_FIELD: 'FORBIDDEN_FIELD',
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  PAIRING_EXPIRED: 'PAIRING_EXPIRED',
  BAD_PAIRING_PROOF: 'BAD_PAIRING_PROOF',
  PAIRING_NOT_READY: 'PAIRING_NOT_READY',
  MISSING_VAULT_KEYS: 'MISSING_VAULT_KEYS',
  ALREADY_UNLOCKED: 'ALREADY_UNLOCKED',
  NOT_AUTHORIZED: 'NOT_AUTHORIZED'
})

// Sentinel marker family used by security tests / verifier. Any occurrence of
// the prefix in stored bytes, relay exports, or logs is a hard failure.
export const SENTINEL_PREFIX = 'PEARPASTE_PLAINTEXT_SENTINEL_'

export default {
  OP_TYPES,
  SCHEMAS,
  ENVELOPE_VERSION,
  FIELD_CLASS,
  classifyHeaderField,
  assertHeaderPublicOnly,
  ForbiddenFieldError,
  timeBucket,
  Lamport,
  ERROR_CODES,
  SENTINEL_PREFIX
}
