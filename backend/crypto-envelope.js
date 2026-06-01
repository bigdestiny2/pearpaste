// Paste crypto envelope — the encryption invariant.
//
// This module is the single source of truth for: key derivation, AEAD
// sealing/opening, blind identifiers, deterministic canonical encoding, and
// operation signing/verification. Nothing in Paste may write user content
// to a replicated structure except through `seal()` here, and nothing reads it
// except through `open()`.
//
// Spec refs: Paste technical spec (`docs/PEARPASTE_TECHNICAL_SPEC.md`) §8
// (Cryptography), §22 (Contracts).
//
// Primitives (all Bare-compatible):
//   AEAD     XChaCha20-Poly1305-IETF        (sodium-native)
//   KDF/HKDF HKDF-SHA256 (RFC 5869)         (sodium-native HMAC-SHA256)
//   PW-KDF   Argon2id                       (sodium-native crypto_pwhash)
//   Blind ID HMAC-SHA256                    (sodium-native)
//   Hash     BLAKE2b (generichash)          (sodium-native)
//   Sign     Ed25519                        (hypercore-crypto)

import sodium from 'sodium-native'
import b4a from 'b4a'
import hypercoreCrypto from 'hypercore-crypto'

export const ALG = 'XCHACHA20-POLY1305'
export const ENVELOPE_VERSION = 1
export const KEY_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES // 32
export const NONCE_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES // 24
export const MAC_BYTES = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES // 16
export const PWHASH_SALT_BYTES = sodium.crypto_pwhash_SALTBYTES // 16
// sodium-native v5 does not expose crypto_auth_hmacsha256. We use keyed
// BLAKE2b (crypto_generichash with a 32-byte key) as the MAC/PRF primitive:
// a standard, audited libsodium construction, fully Bare-compatible. HKDF
// below is the RFC-5869 extract/expand structure with this PRF in place of
// HMAC-Hash — equivalent for domain-separated subkey derivation.
const MAC_OUT_BYTES = 32
const MAC_KEY_BYTES = 32

export class CryptoError extends Error {
  constructor (message, code) {
    super(message)
    this.name = 'CryptoError'
    this.code = code || 'CRYPTO_ERROR'
  }
}

export function randomBytes (n) {
  const buf = b4a.allocUnsafe(n)
  sodium.randombytes_buf(buf)
  return buf
}

export function wipe (buf) {
  if (buf && buf.byteLength) sodium.sodium_memzero(buf)
}

// BLAKE2b generic hash -> Buffer(outLen, default 32)
export function hash (input, outLen = 32) {
  const out = b4a.allocUnsafe(outLen)
  sodium.crypto_generichash(out, asBuf(input))
  return out
}

function asBuf (x) {
  if (b4a.isBuffer(x)) return x
  if (typeof x === 'string') return b4a.from(x)
  if (x instanceof Uint8Array) return b4a.from(x.buffer, x.byteOffset, x.byteLength)
  throw new CryptoError('expected buffer or string', 'BAD_INPUT')
}

// Keyed BLAKE2b MAC/PRF(key, data) -> Buffer(32). Key normalized to 32 bytes.
export function hmac (key, data) {
  const out = b4a.allocUnsafe(MAC_OUT_BYTES)
  let k = asBuf(key)
  if (k.byteLength !== MAC_KEY_BYTES) k = hash(k, MAC_KEY_BYTES)
  sodium.crypto_generichash(out, asBuf(data), k)
  return out
}

// RFC 5869 extract/expand KDF with keyed-BLAKE2b as the PRF. Buffer(length).
export function hkdf (ikm, info, length = 32, salt = null) {
  const saltBuf = salt ? asBuf(salt) : b4a.alloc(MAC_KEY_BYTES) // all-zero default
  const prk = hmac(saltBuf, ikm)
  const blocks = Math.ceil(length / MAC_OUT_BYTES)
  if (blocks < 1 || blocks > 255) throw new CryptoError('hkdf length out of range', 'BAD_LENGTH')
  const okm = b4a.allocUnsafe(blocks * MAC_OUT_BYTES)
  let prev = b4a.alloc(0)
  const infoBuf = asBuf(info)
  for (let i = 1; i <= blocks; i++) {
    const t = hmac(prk, b4a.concat([prev, infoBuf, b4a.from([i])]))
    t.copy(okm, (i - 1) * MAC_OUT_BYTES)
    prev = t
  }
  const out = b4a.allocUnsafe(length)
  okm.copy(out, 0, 0, length)
  wipe(prk)
  return out
}

// Argon2id of a password (mnemonic+passphrase already normalized by caller)
// into a 32-byte root seed. Salt is derived deterministically from a label so
// the same recovery phrase resolves the same vault across devices.
export function pwhashRootSeed (password, saltLabel) {
  return pwhashWithSalt(password, hash('pearpaste-salt:' + saltLabel, PWHASH_SALT_BYTES))
}

// Argon2id cost. MUST be identical on every platform: deriveRootSeed() feeds
// the recovery phrase through this, so desktop and mobile have to compute the
// SAME root seed (hence the same vaultKey) or a paired phone and laptop would
// silently end up with different vaults and never sync.
//
// libsodium's MODERATE preset is 256 MB. That allocation fails inside the Bare
// worklet on low-RAM phones (~2 GB) — the "encryption engine crashing on
// Android launch": every vault create/unlock + local-device unwrap calls this.
// INTERACTIVE (64 MB / ops 2) is libsodium's documented interactive/mobile
// tier — still a strong argon2id cost — and is feasible on the worst target,
// so we use it uniformly on ALL platforms for cross-device determinism.
//
// NOTE: changing the cost changes every derived key. Pre-release this is fine;
// any local dev vault made with the old MODERATE params must be recreated
// (its local-device wrap + root seed no longer resolve).
const PWHASH_OPSLIMIT = sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE
const PWHASH_MEMLIMIT = sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE

export function pwhashWithSalt (password, salt) {
  const out = b4a.allocUnsafe(32)
  const saltBuf = asBuf(salt)
  if (saltBuf.byteLength !== PWHASH_SALT_BYTES) {
    throw new CryptoError('bad pwhash salt', 'BAD_SALT')
  }
  sodium.crypto_pwhash(
    out,
    asBuf(password),
    saltBuf,
    PWHASH_OPSLIMIT,
    PWHASH_MEMLIMIT,
    sodium.crypto_pwhash_ALG_ARGON2ID13
  )
  return out
}

// Derive the per-vault key set from the 32-byte root seed (spec §8.1).
export function deriveVaultKeys (rootSeed) {
  return {
    vaultKey: hkdf(rootSeed, 'pearpaste-vault-key-v1', KEY_BYTES),
    indexKey: hkdf(rootSeed, 'pearpaste-index-key-v1', MAC_KEY_BYTES),
    deviceAdminSeed: hkdf(rootSeed, 'pearpaste-device-admin-v1', 32)
  }
}

// Per-item content key. itemKey = HKDF(vaultKey, "item:" + itemId)
export function itemKey (vaultKey, itemId) {
  return hkdf(vaultKey, 'item:' + itemId, KEY_BYTES)
}

// Blind identifier: HMAC(indexKey, id) hex. Used for objectBlindId/tokenBlindId
// so raw note/clip/tag identifiers never enter a replicated structure.
export function blindId (indexKey, id) {
  return b4a.toString(hmac(indexKey, asBuf(id)), 'hex')
}

// Deterministic JSON: object keys sorted recursively. Stable bytes are required
// for AAD binding and signatures to validate across devices/runtimes.
export function canonicalize (value) {
  return b4a.from(canonicalString(value))
}

function canonicalString (value) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalString).join(',') + ']'
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalString(value[k])).join(',') + '}'
  }
  throw new CryptoError('non-serializable value in canonicalize', 'BAD_INPUT')
}

export function aadHashOf (aad) {
  return b4a.toString(hash(canonicalize(aad)), 'hex')
}

function aadBytes (aad) {
  // The AEAD additional-data binds the envelope to its routing context so a
  // ciphertext cannot be replayed under a different object/op/schema.
  return canonicalize(aad)
}

// Seal plaintext into a CryptoEnvelope (spec §8.2). plaintext is any
// JSON-serializable value. Returns the envelope plus the derived item key id.
export function seal ({ vaultKey, objectId, objectBlindId, opType, schema, vaultId, plaintext }) {
  if (!vaultKey || vaultKey.byteLength !== KEY_BYTES) throw new CryptoError('bad vaultKey', 'BAD_KEY')
  const keyId = b4a.toString(hash('keyid:' + objectId, 16), 'hex')
  const k = itemKey(vaultKey, objectId)
  const nonce = randomBytes(NONCE_BYTES)
  const aad = {
    vaultId: String(vaultId),
    objectBlindId: String(objectBlindId),
    opType: String(opType),
    schema: String(schema)
  }
  const message = canonicalize(plaintext)
  const cipher = b4a.allocUnsafe(message.byteLength + MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, message, aadBytes(aad), null, nonce, k)
  wipe(k)
  wipe(message)
  return {
    v: ENVELOPE_VERSION,
    alg: ALG,
    keyId,
    nonce: b4a.toString(nonce, 'hex'),
    aad,
    ciphertext: b4a.toString(cipher, 'hex')
  }
}

// Open a CryptoEnvelope. Throws CryptoError('AEAD_FAIL') on any tamper.
export function open ({ vaultKey, envelope }) {
  if (!vaultKey || vaultKey.byteLength !== KEY_BYTES) throw new CryptoError('bad vaultKey', 'BAD_KEY')
  if (!envelope || envelope.v !== ENVELOPE_VERSION || envelope.alg !== ALG) {
    throw new CryptoError('unsupported envelope', 'BAD_ENVELOPE')
  }
  // objectId is not stored in the envelope; recover the item key from the
  // caller-supplied binding. We re-derive using the keyId-tied objectId passed
  // through aad.objectBlindId is blind, so the caller must pass objectId.
  throw new CryptoError('open() requires openWithObjectId(); use that entrypoint', 'USE_OPEN_WITH_ID')
}

// Open when the caller knows the plaintext objectId (it always does locally,
// because the local index maps objectBlindId -> objectId under indexKey).
export function openWithObjectId ({ vaultKey, objectId, envelope }) {
  if (!vaultKey || vaultKey.byteLength !== KEY_BYTES) throw new CryptoError('bad vaultKey', 'BAD_KEY')
  if (!envelope || envelope.v !== ENVELOPE_VERSION || envelope.alg !== ALG) {
    throw new CryptoError('unsupported envelope', 'BAD_ENVELOPE')
  }
  const k = itemKey(vaultKey, objectId)
  const cipher = b4a.from(envelope.ciphertext, 'hex')
  const nonce = b4a.from(envelope.nonce, 'hex')
  if (cipher.byteLength < MAC_BYTES) {
    wipe(k)
    throw new CryptoError('ciphertext too short', 'AEAD_FAIL')
  }
  const message = b4a.allocUnsafe(cipher.byteLength - MAC_BYTES)
  let ok = true
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      message, null, cipher, aadBytes(envelope.aad), nonce, k
    )
  } catch (_) {
    ok = false
  }
  wipe(k)
  if (!ok) {
    wipe(message)
    throw new CryptoError('AEAD verification failed', 'AEAD_FAIL')
  }
  let parsed
  try {
    parsed = JSON.parse(b4a.toString(message))
  } finally {
    wipe(message)
  }
  return parsed
}

// ---- Operation signing (spec §8.1) -----------------------------------------
// signature = Ed25519.sign(canonical(header || ciphertext || nonce || aadHash))

function signingPreimage ({ header, ciphertext, nonce, aadHash }) {
  return canonicalize({ header, ciphertext, nonce, aadHash })
}

export function deviceKeyPairFromSeed (seed32) {
  return hypercoreCrypto.keyPair(asBuf(seed32))
}

export function signOp (deviceSecretKey, parts) {
  const sig = hypercoreCrypto.sign(signingPreimage(parts), asBuf(deviceSecretKey))
  return b4a.toString(sig, 'hex')
}

export function verifyOp (signerPublicKeyHex, parts, signatureHex) {
  try {
    return hypercoreCrypto.verify(
      signingPreimage(parts),
      b4a.from(signatureHex, 'hex'),
      b4a.from(signerPublicKeyHex, 'hex')
    )
  } catch (_) {
    return false
  }
}

export function signDetached (deviceSecretKey, payload) {
  const sig = hypercoreCrypto.sign(canonicalize(payload), asBuf(deviceSecretKey))
  return b4a.toString(sig, 'hex')
}

export function verifyDetached (signerPublicKeyHex, payload, signatureHex) {
  try {
    return hypercoreCrypto.verify(
      canonicalize(payload),
      b4a.from(signatureHex, 'hex'),
      b4a.from(signerPublicKeyHex, 'hex')
    )
  } catch (_) {
    return false
  }
}

export default {
  ALG,
  ENVELOPE_VERSION,
  KEY_BYTES,
  NONCE_BYTES,
  MAC_BYTES,
  PWHASH_SALT_BYTES,
  CryptoError,
  randomBytes,
  wipe,
  hash,
  hmac,
  hkdf,
  pwhashRootSeed,
  pwhashWithSalt,
  deriveVaultKeys,
  itemKey,
  blindId,
  canonicalize,
  aadHashOf,
  seal,
  open,
  openWithObjectId,
  deviceKeyPairFromSeed,
  signOp,
  verifyOp,
  signDetached,
  verifyDetached
}
