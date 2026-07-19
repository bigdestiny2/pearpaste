// Unit: identity BIP-39 seed derivation is standards-compliant (v2, 2026-07).
//
// After the v2 cutover, deriveRootSeed() no longer uses the pre-v2
// Argon2id(mnemonic+passphrase) shortcut. It is now the REAL BIP-39 seed:
//   rootSeed = PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic"+passphrase, 2048, 64)[:32]
// so a phrase minted in Paste restores in Keet, hardware wallets, and any BIP-39
// tool. This test pins that guarantee against an INDEPENDENT oracle: Node's own
// crypto.pbkdf2Sync — if bip39-mnemonic ever drifts from the spec, this fails.
//
// Run: node test/unit/identity-bip39-standard.test.js
import test from 'brittle'
import ncrypto from 'node:crypto'
import b4a from 'b4a'
import bip39 from 'bip39-mnemonic'
import * as identity from '../../backend/identity.js'

// Independent BIP-39 seed reference (BIP-39 "From mnemonic to seed"):
// PBKDF2-HMAC-SHA512(NFKD(mnemonic), "mnemonic"+passphrase, 2048, 64).
function referenceSeed (mnemonic, passphrase = '') {
  const norm = mnemonic.normalize('NFKD')
  return ncrypto.pbkdf2Sync(norm, 'mnemonic' + passphrase.normalize('NFKD'), 2048, 64, 'sha512')
}

// Portability at the BIP-39 layer that deriveRootSeed() routes through. NOTE:
// Paste's own validateMnemonic intentionally accepts only 24-word phrases (it
// never mints 12-word ones), so the canonical 12-word Trezor vector is checked
// against bip39-mnemonic directly + the Node PBKDF2 oracle. This proves the seed
// engine under deriveRootSeed is byte-for-byte the BIP-39 spec, so a 12-word
// phrase from a hardware wallet would derive the identical seed.
test('Trezor vector: bip39 seed engine matches the BIP-39 PBKDF2 spec', async (t) => {
  const vec = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
  t.ok(bip39.validateMnemonic(vec), 'canonical 12-word Trezor vector validates')
  t.is(b4a.toString(b4a.from(bip39.mnemonicToEntropy(vec)), 'hex'),
    '00000000000000000000000000000000', 'all-zero 128-bit entropy')
  const seed = b4a.from(await bip39.mnemonicToSeed(vec))
  t.is(b4a.toString(seed, 'hex'), referenceSeed(vec, '').toString('hex'),
    'full 64-byte seed matches Node crypto.pbkdf2Sync (portable)')
  // and the [:32] slice deriveRootSeed would take:
  t.is(b4a.toString(seed.subarray(0, 32), 'hex'),
    b4a.toString(referenceSeed(vec, '').subarray(0, 32), 'hex'),
    'rootSeed slice matches oracle[:32]')
})

test('random 24-word phrase: deriveRootSeed matches the PBKDF2 spec, passphrase-bound', async (t) => {
  const m = identity.generateMnemonic() // 256-bit -> 24 words (Keet/Paste standard)
  t.is(m.split(' ').length, 24, '24 words')

  const seed = await identity.deriveRootSeed(m, '')
  t.is(b4a.toString(seed, 'hex'), b4a.toString(referenceSeed(m, '').subarray(0, 32), 'hex'),
    'no-passphrase seed matches spec')

  const seedPw = await identity.deriveRootSeed(m, 'correct horse')
  t.is(b4a.toString(seedPw, 'hex'), b4a.toString(referenceSeed(m, 'correct horse').subarray(0, 32), 'hex'),
    'passphrase seed matches spec (BIP-39 passphrase = PBKDF2 salt suffix)')
  t.not(b4a.toString(seed, 'hex'), b4a.toString(seedPw, 'hex'),
    'passphrase changes the seed')
})

test('deterministic across calls and 32-byte vault key material', async (t) => {
  const m = identity.generateMnemonic(b4a.alloc(32, 9))
  const s1 = await identity.deriveRootSeed(m, 'pw')
  const s2 = await identity.deriveRootSeed(m, 'pw')
  t.is(b4a.toString(s1, 'hex'), b4a.toString(s2, 'hex'), 'deterministic')
  const v1 = identity.vaultIdFromRootSeed(s1)
  const v2 = identity.vaultIdFromRootSeed(s2)
  t.is(v1, v2, 'same phrase+pw -> same vaultId across devices')
})
