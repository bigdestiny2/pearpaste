// Integration: HiveRelay seed path receives ciphertext only.
//
// Spec §16 (relay seed happy path), §21 Agent 2 acceptance:
//   - relay receives no plaintext fields or data keys
//   - blindness assertion blocks a bad payload before it leaves the process
//   - the relay-export mirror (what the verifier audits) is sentinel-free

import test from 'brittle'
import { makeCtx, readRelayExports, SENTINEL } from './_relay-harness.js'
import {
  attach as attachRelay,
  assertCiphertextOnly,
  RelayBlindnessError
} from '../../backend/relay-service.js'

test('assertCiphertextOnly blocks plaintext / key material / sentinel', (t) => {
  // Safe: only ciphertext-ish identifiers and numbers.
  t.execution(() => assertCiphertextOnly({
    appKey: 'a'.repeat(64),
    ciphertextRoot: 'deadbeef',
    replicationFactor: 5,
    privacyTier: 'p2p-only'
  }), 'a clean seed payload passes')

  t.exception(() => assertCiphertextOnly({ vaultKey: 'x' }),
    /relay blindness/, 'vaultKey is rejected')
  t.exception(() => assertCiphertextOnly({ note: { body: 'hi' } }),
    /relay blindness/, 'a nested note body is rejected')
  t.exception(() => assertCiphertextOnly({ mnemonic: 'word word' }),
    /relay blindness/, 'mnemonic is rejected')
  t.exception(() => assertCiphertextOnly({ root: SENTINEL }),
    /relay blindness/, 'the plaintext sentinel anywhere is rejected')

  // Generic secret-ish field names are also rejected (hardened guard): even if
  // a future refactor introduces a generically-named secret/credential or
  // leaks user content, the last-line guard stops it before it reaches a relay.
  t.exception(() => assertCiphertextOnly({ secretKey: 'x' }),
    /relay blindness/, 'a generic secretKey is rejected')
  t.exception(() => assertCiphertextOnly({ secret: 'x' }),
    /relay blindness/, 'a generic secret field is rejected')
  t.exception(() => assertCiphertextOnly({ password: 'x' }),
    /relay blindness/, 'a password field is rejected')
  t.exception(() => assertCiphertextOnly({ note: { tags: ['a'] } }),
    /relay blindness/, 'user-content tags are rejected')
  t.exception(() => assertCiphertextOnly({ content: 'hello' }),
    /relay blindness/, 'user-content body is rejected')

  // ...while the existing safe relay identifiers still pass unchanged (the
  // [^a-z] boundaries keep compound keys like appKey/discoveryKey/keyHex safe).
  t.execution(() => assertCiphertextOnly({
    appKey: 'a'.repeat(64),
    discoveryKey: 'b'.repeat(64),
    keyHex: 'c'.repeat(64),
    ciphertextRoot: 'deadbeef',
    privacyTier: 'p2p-only',
    retainUntil: Date.now() + 60_000,
    replicas: 5
  }), 'safe relay identifiers (appKey/discoveryKey/keyHex/…) still pass')

  try {
    assertCiphertextOnly({ plaintext: 'x' })
    t.fail('should have thrown')
  } catch (e) {
    t.is(e.code, 'RELAY_BLINDNESS', 'throws RelayBlindnessError code')
    t.ok(e instanceof RelayBlindnessError)
  }
})

test('seedVault sends only ciphertext + knobs; export mirror is clean', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  // No client dependency wired in this harness path → graceful degrade, but
  // the payload is still constructed, asserted, and mirrored for audit.
  const publicVaultLogKey = 'b'.repeat(64) // a PUBLIC core key (an identifier)
  const res = await h.ctx.relay.seedVault(publicVaultLogKey, {
    replicationFactor: 5,
    durability: 1,
    maxStorageBytes: 256 * 1024 * 1024
  })

  // Degrades cleanly (no real relay) but never throws and never blocks.
  t.is(res.ok, false, 'no relay reachable in unit harness → ok:false')
  t.is(res.local, true, 'reports local-first fallback')

  const exports = readRelayExports(h.dir)
  t.ok(exports.length >= 1, 'seed payload was mirrored for the verifier')
  const seedExport = exports.find((e) => e.file.startsWith('seed-'))
  t.ok(seedExport, 'a seed export exists')
  const payload = JSON.parse(seedExport.content)
  t.is(payload.appKey, publicVaultLogKey, 'only the PUBLIC key is sent')
  t.is(payload.privacyTier, 'p2p-only', 'blind / p2p-only tier')
  t.is(payload.replicas, 5, 'replication factor forwarded')
  t.absent(/vaultKey|mnemonic|plaintext|body/i.test(seedExport.content),
    'no key material or plaintext in the relay payload')
  t.absent(seedExport.content.includes(SENTINEL),
    'no plaintext sentinel in the relay payload')
})

test('RELAY_STATUS works while locked and never throws', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  const status = await h.ctx.dispatcher.call('RELAY_STATUS', {})
  t.ok(status, 'returns a status object')
  t.is(typeof status.directPeers, 'number')
  t.is(typeof status.relaysHoldingCiphertext, 'number')
  t.ok('custodyQuorum' in status, 'has custodyQuorum')
  t.ok('lastVerifierRun' in status, 'has lastVerifierRun')
  t.ok('lastKeyRotation' in status, 'has lastKeyRotation')
})

test('RELAY_SET_ENABLED toggles the subsystem without crashing', async (t) => {
  const h = await makeCtx()
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  let r = await h.ctx.dispatcher.call('RELAY_SET_ENABLED', { enabled: false })
  t.is(r.enabled, false, 'disabled')
  const seedWhileDisabled = await h.ctx.relay.seedVault('c'.repeat(64), {})
  t.is(seedWhileDisabled.ok, false, 'seeding is a no-op while disabled')

  r = await h.ctx.dispatcher.call('RELAY_SET_ENABLED', { enabled: true })
  t.is(r.enabled, true, 're-enabled')
})
