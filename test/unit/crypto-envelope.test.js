// Unit: crypto-envelope — KDF derivation, AEAD seal/open, wrong-key
// rejection, signature verify, canonical-encoding stability.
// Spec §16 (test matrix) + §21 Agent 1 acceptance. Run: node <file>.test.js

import test from 'brittle'
import b4a from 'b4a'
import * as crypto from '../../backend/crypto-envelope.js'
import * as identity from '../../backend/identity.js'
import { OP_TYPES, SCHEMAS, assertHeaderPublicOnly, ForbiddenFieldError } from '../../backend/shared-ops.js'

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

// ---- Phase 0: epoch content-key core (REVOCATION_DESIGN.md §Phase 0) --------
// Foundation for content-key rotation. The #1 constraint is byte-compatibility:
// epoch 0 (epochTag === "") must seal/open EXACTLY as before so existing vaults
// are untouched.

// (a) Legacy byte-compat: a no-epochTag seal under epochKey == vaultKey yields
// the SAME keyId, the SAME AAD, and the SAME round-trip as the historical path,
// AND the `epochKey` / `vaultKey` parameter names are interchangeable.
test('phase0: legacy epochTag="" seal is byte-identical to the historical seal (keyId + AAD + round-trip)', (t) => {
  const seed = identity.deriveRootSeed(MNEMONIC, 'pw')
  const { vaultKey } = crypto.deriveVaultKeys(seed)
  const objectId = 'note:legacy'
  const objectBlindId = crypto.blindId(crypto.randomBytes(32), objectId)
  const plaintext = { noteId: 'legacy', title: 't', body: 'b' }
  const sealArgs = {
    objectId,
    objectBlindId,
    opType: OP_TYPES.NOTE_UPSERT,
    schema: SCHEMAS.NOTE,
    vaultId: 'v1',
    plaintext
  }

  // The historical keyId formula was hash("keyid:" + objectId) (16 bytes hex).
  const historicalKeyId = b4a.toString(crypto.hash('keyid:' + objectId, 16), 'hex')
  // The historical AAD was exactly these four fields, no epoch.
  const historicalAad = {
    vaultId: 'v1',
    objectBlindId: String(objectBlindId),
    opType: String(OP_TYPES.NOTE_UPSERT),
    schema: String(SCHEMAS.NOTE)
  }

  // Default epochTag ("") via the new `epochKey` param.
  const env = crypto.seal({ epochKey: vaultKey, ...sealArgs })
  t.is(env.keyId, historicalKeyId, 'epochTag="" keyId == historical hash("keyid:"+objectId)')
  t.alike(env.aad, historicalAad, 'epochTag="" AAD == historical 4-field AAD (no epoch field)')
  t.absent('epochTag' in env.aad, 'no epochTag key leaks into the legacy AAD object')
  t.is(
    b4a.toString(crypto.canonicalize(env.aad)),
    b4a.toString(crypto.canonicalize(historicalAad)),
    'legacy AAD canonicalizes to the exact pre-change bytes'
  )

  // The legacy `vaultKey` param name still works and is equivalent to epochKey.
  const envAlias = crypto.seal({ vaultKey, ...sealArgs })
  t.is(envAlias.keyId, historicalKeyId, 'vaultKey alias yields the same legacy keyId')
  t.alike(envAlias.aad, historicalAad, 'vaultKey alias yields the same legacy AAD')

  // keyIdFor helper agrees with both the historical formula and the envelope.
  t.is(crypto.keyIdFor('', objectId), historicalKeyId, 'keyIdFor("",id) == historical keyId')

  // Round-trip under both param names; explicit epochTag:"" also round-trips.
  t.alike(crypto.openWithObjectId({ epochKey: vaultKey, objectId, envelope: env }), plaintext, 'round-trips under epochKey')
  t.alike(crypto.openWithObjectId({ vaultKey, objectId, envelope: env }), plaintext, 'round-trips under vaultKey alias')
})

// (d) AAD-compat: a hand-built *legacy* envelope (4-field AAD, historical keyId,
// no epochTag anywhere) — exactly what an existing vault has at rest — still
// opens after this change, confirming nothing in the read path regressed.
test('phase0: a pre-change (legacy) envelope still opens unchanged', async (t) => {
  const seed = identity.deriveRootSeed(MNEMONIC, 'pw')
  const { vaultKey } = crypto.deriveVaultKeys(seed)
  const objectId = 'note:atrest'
  const objectBlindId = crypto.blindId(crypto.randomBytes(32), objectId)
  const plaintext = { noteId: 'atrest', body: 'still-readable' }

  // Reconstruct a legacy envelope the way the old code would have: 4-field AAD,
  // keyId = hash("keyid:"+objectId), item key = HKDF(vaultKey,"item:"+objectId).
  const aad = {
    vaultId: 'v1',
    objectBlindId: String(objectBlindId),
    opType: String(OP_TYPES.NOTE_UPSERT),
    schema: String(SCHEMAS.NOTE)
  }
  const k = crypto.itemKey(vaultKey, objectId)
  const nonce = crypto.randomBytes(crypto.NONCE_BYTES)
  const sodium = (await import('sodium-native')).default
  const message = crypto.canonicalize(plaintext)
  const cipher = b4a.allocUnsafe(message.byteLength + crypto.MAC_BYTES)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(cipher, message, crypto.canonicalize(aad), null, nonce, k)
  const legacyEnv = {
    v: crypto.ENVELOPE_VERSION,
    alg: crypto.ALG,
    keyId: b4a.toString(crypto.hash('keyid:' + objectId, 16), 'hex'),
    nonce: b4a.toString(nonce, 'hex'),
    aad,
    ciphertext: b4a.toString(cipher, 'hex')
  }

  const out = crypto.openWithObjectId({ epochKey: vaultKey, objectId, envelope: legacyEnv })
  t.alike(out, plaintext, 'legacy at-rest envelope decrypts under epoch-0 key with no migration')
})

// (b) Cross-epoch open FAILS: a record sealed under epochTag "e1" cannot open
// with the epoch-0/"" key, and a legacy record cannot open under the "e1" key.
// The epochTag-bound AAD makes a wrong-epoch decrypt fail closed.
test('phase0: cross-epoch open fails AEAD_FAIL in both directions', (t) => {
  const objectId = 'note:rotated'
  const objectBlindId = crypto.blindId(crypto.randomBytes(32), objectId)
  const plaintext = { noteId: 'rotated', body: 'epoch-1-secret' }
  const epoch0Key = crypto.randomBytes(crypto.KEY_BYTES) // legacy vaultKey
  const epoch1Key = crypto.randomBytes(crypto.KEY_BYTES) // fresh-random epochKey_1
  const e1 = 'e1deadbeef'

  const base = { objectId, objectBlindId, opType: OP_TYPES.NOTE_UPSERT, schema: SCHEMAS.NOTE, vaultId: 'v1', plaintext }

  // Sealed under epoch 1 (non-empty epochTag).
  const envE1 = crypto.seal({ epochKey: epoch1Key, epochTag: e1, ...base })
  t.ok('epochTag' in envE1.aad, 'non-empty epochTag rides in the AAD')
  t.is(envE1.aad.epochTag, e1, 'AAD carries the exact epochTag')

  // Correct key + objectId opens.
  t.alike(crypto.openWithObjectId({ epochKey: epoch1Key, objectId, envelope: envE1 }), plaintext, 'epoch-1 record opens under epoch-1 key')

  // The epoch-0 key cannot open the epoch-1 record (different item key AND, were
  // keys equal, the epochTag-bound AAD would still fail).
  t.exception(() => crypto.openWithObjectId({ epochKey: epoch0Key, objectId, envelope: envE1 }), /AEAD/, 'epoch-0 key cannot open epoch-1 record')

  // And the reverse: a legacy (epochTag "") record cannot open under epoch-1 key.
  const envLegacy = crypto.seal({ epochKey: epoch0Key, ...base })
  t.exception(() => crypto.openWithObjectId({ epochKey: epoch1Key, objectId, envelope: envLegacy }), /AEAD/, 'epoch-1 key cannot open legacy record')

  // Splicing the epoch-1 AAD's epochTag to another value fails closed.
  const spliced = { ...envE1, aad: { ...envE1.aad, epochTag: 'e2feedface' } }
  t.exception(() => crypto.openWithObjectId({ epochKey: epoch1Key, objectId, envelope: spliced }), /AEAD/, 'epochTag AAD splice rejected')
})

// (c) B4 unlinkability: the SAME objectId sealed under two different epochTags
// yields DIFFERENT keyIds, and both differ from the legacy ("") keyId. This is
// what denies a revoked device the ability to link a re-materialized new-epoch
// ciphertext to old plaintext it already holds.
test('phase0: same objectId under different epochTags yields different keyIds (B4 unlinkability)', (t) => {
  const objectId = 'note:b4'
  const legacyKeyId = crypto.keyIdFor('', objectId)
  const e1KeyId = crypto.keyIdFor('e1deadbeef', objectId)
  const e2KeyId = crypto.keyIdFor('e2feedface', objectId)

  t.not(e1KeyId, e2KeyId, 'two different epochTags -> different keyIds for the same object')
  t.not(e1KeyId, legacyKeyId, 'epoch-1 keyId differs from the legacy/epoch-0 keyId')
  t.not(e2KeyId, legacyKeyId, 'epoch-2 keyId differs from the legacy/epoch-0 keyId')
  t.is(crypto.keyIdFor(null, objectId), legacyKeyId, 'null epochTag is treated as the legacy "" case')

  // Same property end-to-end through seal(): re-seal the object under e1 and
  // confirm its envelope keyId differs from the epoch-0 envelope keyId a revoked
  // device would hold.
  const objectBlindId = crypto.blindId(crypto.randomBytes(32), objectId)
  const base = { objectId, objectBlindId, opType: OP_TYPES.NOTE_UPSERT, schema: SCHEMAS.NOTE, vaultId: 'v1', plaintext: { x: 1 } }
  const env0 = crypto.seal({ epochKey: crypto.randomBytes(crypto.KEY_BYTES), ...base })
  const env1 = crypto.seal({ epochKey: crypto.randomBytes(crypto.KEY_BYTES), epochTag: 'e1deadbeef', ...base })
  t.is(env0.keyId, legacyKeyId, 'epoch-0 envelope keyId == legacy keyId')
  t.is(env1.keyId, e1KeyId, 'epoch-1 envelope keyId == epoch-bound keyId')
  t.not(env0.keyId, env1.keyId, 'epoch-0 and epoch-1 envelopes of the same object are keyId-unlinkable')
})

// topicSeedFromEpochKey is deterministic, domain-separated, and key-dependent —
// and (by contract) only ever computed locally, never serialized.
test('phase0: topicSeedFromEpochKey is local, deterministic, and key-bound', (t) => {
  const ka = crypto.randomBytes(crypto.KEY_BYTES)
  const kb = crypto.randomBytes(crypto.KEY_BYTES)
  const sa1 = crypto.topicSeedFromEpochKey(ka)
  const sa2 = crypto.topicSeedFromEpochKey(ka)
  const sb = crypto.topicSeedFromEpochKey(kb)
  t.is(sa1.byteLength, 32, 'topic seed is 32 bytes')
  t.is(b4a.toString(sa1, 'hex'), b4a.toString(sa2, 'hex'), 'deterministic for a given epoch key')
  t.not(b4a.toString(sa1, 'hex'), b4a.toString(sb, 'hex'), 'different epoch key -> different topic seed')
  // Domain separation: the topic seed is not just the item key of the epoch key.
  t.not(b4a.toString(sa1, 'hex'), b4a.toString(crypto.itemKey(ka, 'swarm-topic-seed-v1'), 'hex'), 'distinct from itemKey domain')
})

// HEADER_PUBLIC_FIELDS now admits epoch/epochTag; forbidden fields still throw.
test('phase0: epoch/epochTag are public header fields; forbidden fields still throw', (t) => {
  const okHeader = {
    version: 1,
    opId: 'op1',
    vaultId: 'v1',
    deviceId: 'd1',
    type: OP_TYPES.KEY_ROTATE,
    objectBlindId: 'bid',
    lamport: '5',
    createdAtBucket: '0',
    epoch: '1',
    epochTag: 'e1deadbeef'
  }
  t.ok(assertHeaderPublicOnly(okHeader), 'header carrying epoch + epochTag passes assertHeaderPublicOnly')

  t.exception(
    () => assertHeaderPublicOnly({ ...okHeader, vaultKey: 'leak' }),
    ForbiddenFieldError,
    'a forbidden field (vaultKey) in the header still throws'
  )
  t.exception(
    () => assertHeaderPublicOnly({ ...okHeader, plaintext: 'leak' }),
    ForbiddenFieldError,
    'a forbidden field (plaintext) in the header still throws'
  )
})
