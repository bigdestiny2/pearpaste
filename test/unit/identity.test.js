// Unit: identity — mnemonic checksum, deterministic device keys, vaultId
// stability, sealed-box pairing wrap. Spec §8.1/§7.2/§14, §16.
// Run: node test/unit/identity.test.js

import test from 'brittle'
import b4a from 'b4a'
import * as identity from '../../backend/identity.js'

test('mnemonic generate/validate + checksum enforcement', (t) => {
  const m = identity.generateMnemonic(b4a.alloc(32, 1))
  t.is(m.split(' ').length, 24)
  t.ok(identity.validateMnemonic(m), 'valid mnemonic accepted')

  const words = m.split(' ')
  words[0] = words[0] === 'abandon' ? 'ability' : 'abandon' // flip one word -> checksum break
  t.absent(identity.validateMnemonic(words.join(' ')), 'corrupted checksum rejected')
  t.absent(identity.validateMnemonic('not a real phrase'), 'junk rejected')
  t.absent(identity.validateMnemonic(words.slice(0, 23).join(' ')), 'wrong length rejected')

  const ent = identity.mnemonicToEntropy(m)
  t.is(ent.byteLength, 32, 'entropy round-trips to 32 bytes')
  t.is(identity.generateMnemonic(ent), m, 'entropy -> same mnemonic')
})

test('rootSeed + vaultId derive deterministically from the phrase', (t) => {
  const m = identity.generateMnemonic(b4a.alloc(32, 2))
  const s1 = identity.deriveRootSeed(m, 'pw')
  const s2 = identity.deriveRootSeed(m, 'pw')
  t.is(b4a.toString(s1, 'hex'), b4a.toString(s2, 'hex'), 'deterministic root seed')

  const v1 = identity.vaultIdFromRootSeed(s1)
  const v2 = identity.vaultIdFromRootSeed(s2)
  t.is(v1, v2, 'same phrase -> same vaultId across devices')
  t.absent(v1.includes(m.split(' ')[0]), 'vaultId reveals nothing about the phrase')

  const other = identity.vaultIdFromRootSeed(identity.deriveRootSeed(m, 'other-pw'))
  t.not(v1, other, 'different passphrase -> different vault')
})

test('createDeviceIdentity: deterministic from seed, distinct keypairs', (t) => {
  const a = identity.createDeviceIdentity({ label: 'a', platform: 'macos', seed: b4a.alloc(32, 5) })
  const a2 = identity.createDeviceIdentity({ label: 'a', platform: 'macos', seed: b4a.alloc(32, 5) })
  const b = identity.createDeviceIdentity({ label: 'b', platform: 'ios', seed: b4a.alloc(32, 6) })

  t.is(a.deviceId, a2.deviceId, 'same seed -> same deviceId')
  t.is(a.signingPubkey, a2.signingPubkey, 'same seed -> same signing key')
  t.not(a.deviceId, b.deviceId, 'different seed -> different device')
  t.not(a.signingPubkey, a.boxPubkey, 'signing and box keys are distinct')
  t.ok(b4a.isBuffer(a.signingSecretKey), 'signing secret is a buffer')
  t.ok(/^[0-9a-f]{32}$/.test(a.deviceId), 'deviceId is a hex hash')
  t.not(a.deviceId, a.label, 'deviceId is not the label')
})

test('sealToDevice / openSealedToDevice round-trips to recipient only', (t) => {
  const recip = identity.createDeviceIdentity({ seed: b4a.alloc(32, 11) })
  const stranger = identity.createDeviceIdentity({ seed: b4a.alloc(32, 12) })
  const msg = b4a.from('bootstrap-secret-payload')

  const sealed = identity.sealToDevice(recip.boxPubkey, msg)
  t.absent(sealed.includes('bootstrap-secret'), 'sealed blob carries no plaintext')

  const out = identity.openSealedToDevice(recip.boxPubkey, recip.boxSecretKey, sealed)
  t.is(b4a.toString(out), 'bootstrap-secret-payload', 'recipient decrypts')

  t.exception(
    () => identity.openSealedToDevice(stranger.boxPubkey, stranger.boxSecretKey, sealed),
    /sealed box open failed/, 'non-recipient cannot open'
  )
})
