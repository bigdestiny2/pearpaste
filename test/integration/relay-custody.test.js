// Integration: Atomic Blind Custody + the verifier's bad-record catch.
//
// Spec §16 (HiveRelay seed/custody happy path; relay custody quorum-failure
// path; sentinel storage/relay-export scans) and §21 Agent 2 acceptance:
//   - "Relay receives no plaintext fields or data keys."
//   - "Custody status reaches quorum in test network."
//   - "Relay unavailable / quorum-failure state does not block local usage."
//   - "Verifier catches an intentionally plaintext-inserted bad record."
//
// Hermetic: an in-process fake HiveRelayClient (makeFakeRelayClientFactory)
// proxies the custody surface to a real in-process startFakeRelay() HTTP
// server, so the full publishTemporaryCustody -> getCustodyStatus -> quorum
// path runs on real bytes against the genuine relay-service code.

import test from 'brittle'
import b4a from 'b4a'
import {
  makeCtx,
  startFakeRelay,
  makeFakeRelayClientFactory,
  readRelayExports,
  SENTINEL
} from './_relay-harness.js'
import {
  attach as attachRelay,
  assertCiphertextOnly,
  RelayBlindnessError
} from '../../backend/relay-service.js'
import {
  classifyOpRecord,
  envelopeLooksEncrypted,
  isCryptoEnvelope,
  scanStorageDirForSentinel,
  buildProofReport
} from '../../backend/verifier.js'
import {
  seal, deriveVaultKeys, randomBytes, deviceKeyPairFromSeed, signOp, aadHashOf
} from '../../backend/crypto-envelope.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'

// §16/§21: a relay only ever receives ciphertext, roots, commitments, and
// signed receipts. The blindness guard is the last line of defense and must
// reject plaintext / key material / the sentinel BEFORE anything leaves the
// process — even when the payload is otherwise well formed.
test('relay payloads carry ciphertext/roots only — blindness guard rejects the rest', (t) => {
  // A realistic custody-intent shape with only content-free fields passes.
  t.execution(() => assertCiphertextOnly({
    blindContentId: 'blind-1a2b',
    ciphertextRoot: 'deadbeef'.repeat(8),
    requiredReplicas: 3,
    deadline: Date.now() + 60_000,
    retainUntil: Date.now() + 60_000,
    privacyTier: 'p2p-only',
    metadataVisibility: 'redacted'
  }, 'custody-intent'), 'a clean custody intent passes the blindness guard')

  // Data keys / plaintext / sentinel anywhere are hard-rejected.
  t.exception(() => assertCiphertextOnly({ itemKey: 'x'.repeat(64) }),
    /relay blindness/, 'an item key is rejected')
  t.exception(() => assertCiphertextOnly({ ciphertextRoot: SENTINEL }),
    /relay blindness/, 'the plaintext sentinel inside a root is rejected')
  t.exception(() => assertCiphertextOnly({ intent: { clipBody: 'secret' } }),
    /relay blindness/, 'a nested clip body is rejected')
  try {
    assertCiphertextOnly({ rootSeed: 'abcd' })
    t.fail('should have thrown on rootSeed')
  } catch (e) {
    t.ok(e instanceof RelayBlindnessError, 'throws RelayBlindnessError')
    t.is(e.code, 'RELAY_BLINDNESS', 'with the RELAY_BLINDNESS code')
  }
})

// §16/§21: "Custody status reaches quorum in test network." The in-process
// fake relay accepts the intent and reports a committed quorum; relay-service
// must surface that and the relay-export mirror must be plaintext-free.
test('Atomic Blind Custody reaches quorum and mirrors only ciphertext roots', async (t) => {
  const relay = await startFakeRelay({ requireQuorum: 3 })
  t.teardown(() => relay.close())

  const h = await makeCtx({
    relayClientFactory: makeFakeRelayClientFactory({ relayUrl: relay.url, mode: 'quorum' })
  })
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  // §16 seed happy path: seed the (public) encrypted vault-log key first so
  // the relay-holding count is meaningful, then publish custody.
  const publicVaultLogKey = b4a.toString(randomBytes(32), 'hex')
  const seedRes = await h.ctx.relay.seedVault(publicVaultLogKey, { replicationFactor: 5 })
  t.is(seedRes.ok, true, 'vault log seeded')
  t.is(seedRes.acceptances, 5, 'seed accepted by the fake relay fleet')
  t.is(seedRes.privacyTier, 'p2p-only', 'seeded blind / p2p-only')

  // ciphertextRoot is a hash of CIPHERTEXT only — here, a hex digest stand-in.
  const ciphertextRoot = b4a.toString(randomBytes(32), 'hex')
  const pub = await h.ctx.relay.publishTemporaryCustody(ciphertextRoot, 60_000, {
    relayUrl: relay.url,
    requiredReplicas: 3
  })
  t.is(pub.ok, true, 'custody intent accepted by the relay')
  t.ok(pub.intentId, 'an intent id was returned')
  t.is(pub.ciphertextRoot, ciphertextRoot, 'intent bound to OUR ciphertext root')

  // The relay only ever saw the intent body — assert it byte-for-byte.
  t.is(relay.received.length, 1, 'exactly one request hit the relay')
  const seen = relay.received[0]
  t.is(seen.method, 'POST', 'a POST to the custody endpoint')
  t.is(seen.url, '/api/custody/intent', 'the custody intent endpoint')
  t.is(seen.body.ciphertextRoot, ciphertextRoot, 'relay received our ciphertext root')
  t.absent(/vaultKey|itemKey|indexKey|mnemonic|plaintext|clipBody|noteBody|signSeed/i
    .test(seen.raw), 'no key material or plaintext in the bytes the relay received')
  t.absent(seen.raw.includes(SENTINEL_PREFIX),
    'no plaintext sentinel in the bytes the relay received')

  // Quorum status: the relay echoes OUR root back (receipt binding).
  const status = await h.ctx.relay.getCustodyStatus(pub.intentId)
  t.ok(status, 'a custody status is returned')
  t.is(status.status.state, 'committed', 'relay reports committed')
  t.is(status.status.ciphertextRoot, ciphertextRoot, 'receipt references our root')
  t.not(status.receiptsMatchRoot, false, 'receipt root matches (no mismatch flagged)')

  // RELAY_STATUS aggregates a real quorum string and a bound root.
  const rs = await h.ctx.relay.getRelayStatus()
  t.is(rs.relaysHoldingCiphertext, 5, 'seeded/holding count surfaced')
  t.is(rs.custodyReceiptsMatchRoot, true, 'custody receipts bind the ciphertext root')
  t.ok(/^\d+\/\d+$/.test(rs.custodyQuorum), 'custody quorum is N/N, got ' + rs.custodyQuorum)
  const [have, need] = rs.custodyQuorum.split('/').map(Number)
  t.ok(need > 0 && have >= need, 'quorum reached: ' + rs.custodyQuorum)

  // Everything mirrored for the verifier is ciphertext-only.
  const exports = readRelayExports(h.dir)
  const custodyExport = exports.find((e) => e.file.startsWith('custody-intent-'))
  t.ok(custodyExport, 'the custody intent was mirrored for the verifier')
  t.absent(custodyExport.content.includes(SENTINEL_PREFIX),
    'relay-export mirror is sentinel-free')
  t.absent(/vaultKey|itemKey|mnemonic|plaintext|clipBody/i.test(custodyExport.content),
    'relay-export mirror has no key material or plaintext')
  const scan = scanStorageDirForSentinel(h.dir)
  t.is(scan.hits.length, 0, 'no plaintext sentinel anywhere in storage')
})

// §16/§21 + spec §11: "relay custody quorum failure path" — the clip stays
// local and local use is NOT blocked when custody cannot reach quorum.
test('custody quorum failure keeps the clip local and never blocks local use', async (t) => {
  const relay = await startFakeRelay()
  t.teardown(() => relay.close())

  const h = await makeCtx({
    relayClientFactory: makeFakeRelayClientFactory({ relayUrl: relay.url, mode: 'custody-fail' })
  })
  t.teardown(() => h.cleanup())
  await attachRelay(h.ctx)

  const ciphertextRoot = b4a.toString(randomBytes(32), 'hex')
  const pub = await h.ctx.relay.publishTemporaryCustody(ciphertextRoot, 60_000, {
    relayUrl: relay.url,
    requiredReplicas: 3
  })
  t.is(pub.ok, false, 'custody did not reach quorum (relay rejected the intent)')
  t.is(pub.local, true, 'the clip is kept LOCAL')
  t.ok(/503|custody endpoint failed/.test(pub.reason),
    'reason explains the quorum/endpoint failure, reason=' + pub.reason)

  // Crucial property: nothing threw and the relay subsystem stays usable —
  // local-first is unaffected (RELAY_STATUS still answers without throwing).
  const rs = await h.ctx.relay.getRelayStatus()
  t.ok(rs, 'RELAY_STATUS still answers after a custody failure')
  t.is(typeof rs.directPeers, 'number', 'status is well formed')

  // The blindness guard + mirror still ran (audit holds even on the failure
  // path) and the mirrored intent is ciphertext-only.
  const exports = readRelayExports(h.dir)
  const custodyExport = exports.find((e) => e.file.startsWith('custody-intent-'))
  t.ok(custodyExport, 'the attempted intent was still mirrored for audit')
  t.absent(custodyExport.content.includes(SENTINEL_PREFIX),
    'failed-path relay-export mirror is sentinel-free')
  t.pass('quorum failure degraded softly; local use not blocked')
})

// §16/§21: "Verifier catches an intentionally plaintext-inserted bad record."
// We build a REAL sealed envelope (must pass) and three tampered records that
// smuggle plaintext where ciphertext belongs (must each fail the verifier's
// pure classifiers — the exact logic the in-app proof + CLI both use).
test('verifier catches an intentionally plaintext-inserted bad record', (t) => {
  const vaultKeys = deriveVaultKeys(randomBytes(32))
  const objectId = 'note-' + b4a.toString(randomBytes(8), 'hex')

  const goodEnv = seal({
    vaultKey: vaultKeys.vaultKey,
    objectId,
    objectBlindId: 'blind-' + objectId,
    opType: 'NOTE_UPSERT',
    schema: 'note.v1',
    vaultId: 'vault-test',
    plaintext: { title: 'T', body: SENTINEL }
  })
  t.ok(isCryptoEnvelope(goodEnv), 'a real sealed value is a structural envelope')
  t.ok(envelopeLooksEncrypted(goodEnv),
    'a real sealed value passes the AEAD-looks-encrypted check')
  // The sentinel was in the plaintext but must NOT survive into ciphertext.
  t.absent(b4a.toString(b4a.from(goodEnv.ciphertext, 'hex'), 'utf8').includes(SENTINEL_PREFIX),
    'the sentinel does not appear in the real ciphertext bytes')

  // BAD #1: plaintext smuggled as "ciphertext" (hex-encoded sentinel blob).
  const smuggled = {
    ...goodEnv,
    ciphertext: b4a.toString(b4a.from(SENTINEL + ' leaked note body padding padding'), 'hex')
  }
  t.absent(envelopeLooksEncrypted(smuggled),
    'verifier rejects plaintext smuggled as ciphertext')

  // BAD #2: a plain readable JSON row that is not an envelope at all.
  const plainRow = { title: 'My Secret', body: SENTINEL }
  t.absent(isCryptoEnvelope(plainRow), 'a plain row is not a CryptoEnvelope')
  t.absent(envelopeLooksEncrypted(plainRow),
    'verifier rejects a non-envelope plaintext row')

  // BAD #3: ciphertext that decodes to JSON (stored in clear, not AEAD).
  const jsonClear = {
    ...goodEnv,
    ciphertext: b4a.toString(b4a.from(JSON.stringify({ body: 'readable' })), 'hex')
  }
  t.absent(envelopeLooksEncrypted(jsonClear),
    'verifier rejects clear JSON dressed up as ciphertext')

  // The op-record classifier: a valid signed op over a sealed body passes;
  // the same op with the smuggled (plaintext) body is rejected as not-AEAD.
  const dev = deviceKeyPairFromSeed(randomBytes(32))
  const signerHex = b4a.toString(dev.publicKey, 'hex')
  const header = {
    version: 1,
    opId: 'op1',
    vaultId: 'vault-test',
    deviceId: 'devA',
    type: 'NOTE_UPSERT',
    objectBlindId: 'blind-' + objectId,
    lamport: 1
  }
  const deviceSet = new Map([[signerHex, { signingPubkey: signerHex, revokedEpoch: null }]])

  const mkOp = (env) => {
    const parts = { header, ciphertext: env.ciphertext, nonce: env.nonce, aadHash: aadHashOf(env.aad) }
    return {
      header,
      envelope: env,
      aadHash: parts.aadHash,
      signerPubkey: signerHex,
      signature: signOp(dev.secretKey, parts)
    }
  }

  const goodOp = mkOp(goodEnv)
  t.is(classifyOpRecord(goodOp, deviceSet).ok, true,
    'a properly sealed, signed op validates')

  const badOp = { ...goodOp, envelope: smuggled }
  const badRes = classifyOpRecord(badOp, deviceSet)
  t.is(badRes.ok, false, 'an op carrying a plaintext-smuggled body is rejected')
  t.is(badRes.reason, 'op-body-not-aead', 'rejected specifically as not-AEAD')

  // And the assembled proof report fails when the local AEAD check fails.
  const failing = buildProofReport({
    local: { ok: false, detail: 'a stored envelope was not AEAD-encrypted' },
    storage: { scannedFiles: 1, scannedBytes: 10, hits: [] },
    logs: { scannedFiles: 0, hits: [] },
    relayExports: { scannedFiles: 0, hits: [] },
    signatures: { checked: 1, failures: 0 },
    revocation: { checked: 0, leaks: 0 },
    custody: null
  })
  t.is(failing.passed, false, 'the proof report FAILS on a bad local record')
  t.ok(failing.lines.some((l) => /Local encryption: FAILED/.test(l)),
    'the report states the local-encryption failure plainly')
  t.ok(failing.lines.some(
    (l) => l === 'Limit: this does not prove physical deletion from third-party disks.'),
  'the honest physical-deletion limit line is always present')
})
