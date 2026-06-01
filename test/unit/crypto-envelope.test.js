// Unit: crypto-envelope — KDF derivation, AEAD seal/open, wrong-key
// rejection, signature verify, canonical-encoding stability.
// Spec §16 (test matrix) + §21 Agent 1 acceptance. Run: node <file>.test.js

import test from 'brittle'
import b4a from 'b4a'
import * as crypto from '../../backend/crypto-envelope.js'
import * as identity from '../../backend/identity.js'
import { OP_TYPES, SCHEMAS } from '../../backend/shared-ops.js'

const MNEMONIC = identity.generateMnemonic(b4a.alloc(32, 7))

test('mnemonic + KDF derivation is deterministic and passphrase-bound', (t) => {
  t.ok(identity.validateMnemonic(MNEMONIC), 'generated mnemonic is valid')
  t.is(MNEMONIC.split(' ').length, 24, '24 words')

  const seedA = identity.deriveRootSeed(MNEMONIC, 'pw')
  const seedB = identity.deriveRootSeed(MNEMONIC, 'pw')
  const seedC = identity.deriveRootSeed(MNEMONIC, 'different')
  t.is(b4a.toString(seedA, 'hex'), b4a.toString(seedB, 'hex'), 'same phrase+pw -> same seed')
  t.not(b4a.toString(seedA, 'hex'), b4a.toString(seedC, 'hex'), 'passphrase changes seed')

  const k1 = crypto.deriveVaultKeys(seedA)
  const k2 = crypto.deriveVaultKeys(seedB)
  t.is(k1.vaultKey.byteLength, crypto.KEY_BYTES, 'vaultKey is 32 bytes')
  t.is(b4a.toString(k1.vaultKey, 'hex'), b4a.toString(k2.vaultKey, 'hex'), 'vaultKey deterministic')
  t.is(b4a.toString(k1.indexKey, 'hex'), b4a.toString(k2.indexKey, 'hex'), 'indexKey deterministic')
  t.not(b4a.toString(k1.vaultKey, 'hex'), b4a.toString(k1.indexKey, 'hex'), 'domain-separated subkeys')

  const ik1 = crypto.itemKey(k1.vaultKey, 'note:1')
  const ik2 = crypto.itemKey(k1.vaultKey, 'note:2')
  t.not(b4a.toString(ik1, 'hex'), b4a.toString(ik2, 'hex'), 'per-item keys differ by objectId')
})

test('blindId is keyed, deterministic, and hides the raw id', (t) => {
  const ik = crypto.randomBytes(32)
  const ik2 = crypto.randomBytes(32)
  const a = crypto.blindId(ik, 'note:secret')
  const b = crypto.blindId(ik, 'note:secret')
  t.is(a, b, 'same key+id -> same blindId')
  t.not(a, crypto.blindId(ik2, 'note:secret'), 'different index key -> different blindId')
  t.absent(a.includes('secret'), 'raw id not present in blindId')
})

test('envelope encrypt/decrypt round-trips; wrong key rejected', (t) => {
  const seed = identity.deriveRootSeed(MNEMONIC, 'pw')
  const { vaultKey } = crypto.deriveVaultKeys(seed)
  const objectId = 'note:abc'
  const objectBlindId = crypto.blindId(crypto.randomBytes(32), objectId)
  const plaintext = { noteId: 'abc', title: 'hi', body: 'secret-body' }

  const env = crypto.seal({
    vaultKey,
    objectId,
    objectBlindId,
    opType: OP_TYPES.NOTE_UPSERT,
    schema: SCHEMAS.NOTE,
    vaultId: 'v1',
    plaintext
  })
  t.is(env.v, crypto.ENVELOPE_VERSION)
  t.is(env.alg, crypto.ALG)
  t.absent(env.ciphertext.includes('secret-body'), 'ciphertext hex carries no plaintext')

  const out = crypto.openWithObjectId({ vaultKey, objectId, envelope: env })
  t.alike(out, plaintext, 'round-trips under correct key')

  const wrongKey = crypto.randomBytes(crypto.KEY_BYTES)
  t.exception(() => crypto.openWithObjectId({ vaultKey: wrongKey, objectId, envelope: env }), /AEAD/, 'wrong vault key -> AEAD_FAIL')
  t.exception(() => crypto.openWithObjectId({ vaultKey, objectId: 'note:other', envelope: env }), /AEAD/, 'wrong objectId (item key) -> AEAD_FAIL')

  const tampered = { ...env, ciphertext: env.ciphertext.replace(/..$/, '00') }
  t.exception(() => crypto.openWithObjectId({ vaultKey, objectId, envelope: tampered }), /AEAD/, 'tampered ciphertext rejected')

  // AAD binding: re-route envelope to a different op type must fail.
  const splice = { ...env, aad: { ...env.aad, opType: 'CLIP_ADD' } }
  t.exception(() => crypto.openWithObjectId({ vaultKey, objectId, envelope: splice }), /AEAD/, 'AAD splice rejected')
})

test('signOp / verifyOp; bad signature & wrong signer rejected', (t) => {
  const dev = identity.createDeviceIdentity({ label: 'd', platform: 'test', seed: b4a.alloc(32, 3) })
  const other = identity.createDeviceIdentity({ label: 'o', platform: 'test', seed: b4a.alloc(32, 9) })
  const parts = {
    header: { type: 'NOTE_UPSERT', lamport: '1' },
    ciphertext: 'aa',
    nonce: 'bb',
    aadHash: 'cc'
  }
  const sig = crypto.signOp(dev.signingSecretKey, parts)
  t.ok(crypto.verifyOp(dev.signingPubkey, parts, sig), 'valid signature verifies')
  t.absent(crypto.verifyOp(other.signingPubkey, parts, sig), 'wrong signer rejected')
  t.absent(crypto.verifyOp(dev.signingPubkey, { ...parts, aadHash: 'zz' }, sig), 'mutated preimage rejected')
  t.absent(crypto.verifyOp(dev.signingPubkey, parts, 'de'.repeat(32)), 'garbage signature rejected')
})

test('canonical encoding is key-order stable', (t) => {
  const a = crypto.canonicalize({ b: 1, a: { d: 4, c: 3 }, arr: [1, { y: 2, x: 1 }] })
  const b = crypto.canonicalize({ a: { c: 3, d: 4 }, arr: [1, { x: 1, y: 2 }], b: 1 })
  t.is(b4a.toString(a), b4a.toString(b), 'reordered keys -> identical canonical bytes')
  t.is(crypto.aadHashOf({ x: 1, y: 2 }), crypto.aadHashOf({ y: 2, x: 1 }), 'aadHash stable under reorder')
  t.not(crypto.aadHashOf({ x: 1 }), crypto.aadHashOf({ x: 2 }), 'aadHash changes with value')
})
