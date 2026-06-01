// Security: pairing invite expiry (spec §3 security, §10 "pairing topics
// temporary, random, expire quickly", §14 pairing, §16 "Security tests").
//
// Covers this §16 item:
//   - pairing invite expiry enforced
//
// An expired one-time invite must be unusable. We assert at two layers, both
// reachable:
//   1. backend/pairing.js decodeInvite() — the single point every accept path
//      decodes through — throws PAIRING_EXPIRED for an invite past its
//      expiresAt, and never returns usable topic/key material for it.
//   2. the REAL Pear-end PAIR_ACCEPT RPC handler (autobase-sync.js) rejects an
//      expired invite before doing any network work (it calls decodeInvite
//      first), so a stale QR / short code cannot bootstrap a device.
// We also assert positive controls (a fresh invite decodes; an invite expires
// exactly at its boundary) so the test proves enforcement, not just failure.
//
// Run: node test/security/sec-pairing.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import b4a from 'b4a'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import { ERROR_CODES } from '../../backend/shared-ops.js'
import * as pairing from '../../backend/pairing.js'
import * as identity from '../../backend/identity.js'
import * as crypto from '../../backend/crypto-envelope.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }
const call = (pe, c, p) => pe.call(c, p || {})

// Build an invite string with an explicit (possibly past) expiry by going
// through the real createInvite() path with a chosen ttl.
function inviteWithTtl (ttlMs) {
  const topic = pairing.newPairingTopic()
  return pairing.createInvite({ topic, invitePubkey: b4a.toString(b4a.alloc(32, 1), 'hex'), ttlMs })
}

test('§16 pairing: a fresh invite decodes (positive control)', (t) => {
  const inv = inviteWithTtl(60_000)
  t.ok(inv.invite && inv.shortCode, 'createInvite returns an invite blob + short code')
  t.ok(inv.expiresAt > Date.now(), 'a fresh invite expiry is in the future')
  const decoded = pairing.decodeInvite(inv.invite)
  t.ok(b4a.isBuffer(decoded.topic) && decoded.topic.byteLength === 32, 'fresh invite yields a 32-byte pairing topic')
  t.is(typeof decoded.invitePubkey, 'string', 'fresh invite yields the invite pubkey')
})

test('§14 short-code rendezvous: deterministic 32-byte DHT topic', (t) => {
  // The inviter and joiner each derive the same Hyperswarm topic from the
  // displayed short code, so the joiner can fetch the full invite from the
  // inviter without scanning the QR or pasting the long blob.
  const inv = inviteWithTtl(60_000)
  t.ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(inv.shortCode), 'short code shaped A1B2-C3D4')
  t.ok(pairing.isShortCodeShape(inv.shortCode), 'isShortCodeShape accepts the displayed form')
  t.ok(pairing.isShortCodeShape(inv.shortCode.replace('-', '')), 'isShortCodeShape accepts the dash-stripped form')
  t.ok(pairing.isShortCodeShape(inv.shortCode.toLowerCase()), 'isShortCodeShape is case-insensitive')
  t.absent(pairing.isShortCodeShape('NOTHEX!!'), 'isShortCodeShape rejects non-hex')
  t.absent(pairing.isShortCodeShape('TOOSHORT'), 'isShortCodeShape rejects sub-8-char input that contains non-hex')
  t.absent(pairing.isShortCodeShape(''), 'isShortCodeShape rejects empty')

  const topicA = pairing.shortCodeRendezvousTopic(inv.shortCode)
  const topicB = pairing.shortCodeRendezvousTopic(inv.shortCode.replace('-', '').toLowerCase())
  t.is(topicA.length, 32, 'rendezvous topic is 32 bytes (hyperswarm topic size)')
  t.alike(topicA, topicB, 'rendezvous topic is normalisation-stable (dash + case)')

  const otherTopic = pairing.shortCodeRendezvousTopic('00000000')
  t.absent(b4a.equals(topicA, otherTopic), 'different short codes derive different topics')

  // Reject malformed input at the crypto layer too (defense in depth: not
  // only the dispatcher's BAD_SHORT_CODE check).
  t.exception(() => pairing.shortCodeRendezvousTopic('NOPE'), /short code/, 'malformed short code throws CryptoError')
})

test('§16 pairing: decodeInvite REJECTS an expired invite (PAIRING_EXPIRED)', (t) => {
  // ttl in the past => already expired the instant it is created.
  const expired = inviteWithTtl(-1000)
  t.ok(expired.expiresAt < Date.now(), 'invite is already past its expiry')

  let threw = null
  try {
    pairing.decodeInvite(expired.invite)
  } catch (e) {
    threw = e
  }
  t.ok(threw, 'decodeInvite threw for an expired invite')
  t.is(threw.code, ERROR_CODES.PAIRING_EXPIRED, 'error code is PAIRING_EXPIRED')
  t.ok(/expired/i.test(threw.message), 'error message says the invite expired')

  // Crucially: no usable topic/key material is returned for an expired invite.
  t.exception(() => pairing.decodeInvite(expired.invite), /expired/i,
    'an expired invite never yields a topic/pubkey to join on')
})

test('§16 pairing: expiry is enforced at the boundary, not just far in the past', async (t) => {
  // Very short ttl; after it elapses the SAME invite must stop decoding.
  const inv = inviteWithTtl(120)
  // immediately valid
  t.execution(() => pairing.decodeInvite(inv.invite), 'invite valid before expiry')
  await new Promise(resolve => setTimeout(resolve, 200))
  // now expired
  let code = null
  try { pairing.decodeInvite(inv.invite) } catch (e) { code = e.code }
  t.is(code, ERROR_CODES.PAIRING_EXPIRED, 'the same invite is rejected once its expiry passes (one-time + time-boxed)')
})

test('§16 pairing: a malformed / unsupported invite is rejected (no bypass)', (t) => {
  t.exception(() => pairing.decodeInvite('not-base64-$$$'), /malformed|invite/i, 'garbage invite rejected')
  // a structurally wrong but base64 payload (wrong version) is rejected too.
  const badVersion = b4a.toString(b4a.from(JSON.stringify({ v: 99, topic: '00', invitePubkey: 'x', expiresAt: Date.now() + 1000 })), 'base64')
  t.exception(() => pairing.decodeInvite(badVersion), /unsupported|invite/i, 'unsupported invite version rejected')
})

test('§16 pairing: real PAIR_ACCEPT RPC rejects an expired invite before any network work', async (t) => {
  const dir = tmp('pair')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  // A vault must exist + be unlocked so PAIR_ACCEPT is reachable (it is not in
  // UNLOCKED_NOT_REQUIRED). Create one, then attempt to accept an expired
  // invite — the handler calls pairing.decodeInvite() first, so it must fail
  // fast with PAIRING_EXPIRED and NOT hang on swarm.join / handshake.
  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const expired = inviteWithTtl(-5000)

  const started = Date.now()
  let err = null
  try {
    await call(pe, COMMANDS.PAIR_ACCEPT, { invite: expired.invite, label: 'new', platform: 'ios' })
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - started
  t.ok(err, 'PAIR_ACCEPT rejected the expired invite')
  t.is(err.code, ERROR_CODES.PAIRING_EXPIRED, 'rejection is PAIRING_EXPIRED (decoded-before-network)')
  // The 30s pairing handshake timeout must NOT have been reached — proving the
  // expiry check short-circuits before any DHT/handshake work.
  t.ok(elapsed < 5000, 'rejected fast (' + elapsed + 'ms) — no network work for an expired invite')

  // And a freshly created invite from the SAME unlocked device is well-formed
  // (positive control that the path itself works).
  const freshInv = await call(pe, COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 60_000 })
  t.ok(freshInv.invite && freshInv.shortCode, 'PAIR_CREATE_INVITE issues a usable fresh invite')
  t.ok(freshInv.expiresAt > Date.now(), 'fresh invite has a future expiry')
  t.execution(() => pairing.decodeInvite(freshInv.invite), 'the freshly issued invite decodes cleanly')
})

test('§16 pairing: backend invite carries sync metadata required for revocable admission', async (t) => {
  const dir = tmp('pair-meta')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const inv = await call(pe, COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 60_000 })
  const decoded = pairing.decodeInvite(inv.invite)
  t.ok(decoded.autobaseKey, 'invite carries the content-free Autobase bootstrap key')

  const oldShape = inviteWithTtl(60_000)
  let err = null
  try {
    await call(pe, COMMANDS.LOCK_VAULT, {})
    await call(pe, COMMANDS.PAIR_ACCEPT, { invite: oldShape.invite, label: 'new', platform: 'ios' })
  } catch (e) {
    err = e
  }
  t.ok(err, 'PAIR_ACCEPT rejects an invite that cannot support writer admission')
  t.is(err.code, 'BAD_INVITE', 'old invite shape is rejected before key bootstrap')
})

test('§16 pairing: signed hello binds the writer key and device identity', (t) => {
  const dev = identity.createDeviceIdentity({ label: 'phone', platform: 'ios', roles: ['writer', 'reader'] })
  const hello = {
    t: 'pp-pair-hello',
    v: 1,
    invitePubkey: b4a.toString(b4a.alloc(32, 1), 'hex'),
    expiresAt: Date.now() + 60_000,
    deviceId: dev.deviceId,
    label: dev.label,
    platform: dev.platform,
    roles: dev.roles,
    signingPubkey: dev.signingPubkey,
    boxPubkey: dev.boxPubkey,
    writerKey: b4a.toString(b4a.alloc(32, 2), 'hex')
  }
  const sig = crypto.signDetached(dev.signingSecretKey, pairing.helloProofPayload(hello))
  t.ok(crypto.verifyDetached(dev.signingPubkey, pairing.helloProofPayload(hello), sig), 'valid hello proof verifies')
  const tampered = { ...hello, writerKey: b4a.toString(b4a.alloc(32, 3), 'hex') }
  t.absent(crypto.verifyDetached(dev.signingPubkey, pairing.helloProofPayload(tampered), sig), 'writer key cannot be swapped after signing')
  const expectedDeviceId = b4a.toString(crypto.hash('device:' + hello.signingPubkey, 16), 'hex')
  t.is(hello.deviceId, expectedDeviceId, 'device id is derived from the signing pubkey')
})

test('§14 pairing: source-side approval gates device add and bootstrap keys', async (t) => {
  const dir = tmp('pair-approval')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'source', platform: 'macos', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const inv = await call(pe, COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 60_000 })
  const decoded = pairing.decodeInvite(inv.invite)
  const joiner = identity.createDeviceIdentity({ label: 'phone', platform: 'ios', roles: ['writer', 'reader'] })
  const hello = {
    t: 'pp-pair-hello',
    v: 1,
    invitePubkey: decoded.invitePubkey,
    expiresAt: decoded.expiresAt,
    deviceId: joiner.deviceId,
    label: joiner.label,
    platform: joiner.platform,
    roles: joiner.roles,
    signingPubkey: joiner.signingPubkey,
    boxPubkey: joiner.boxPubkey,
    writerKey: b4a.toString(b4a.alloc(32, 7), 'hex')
  }
  hello.signature = crypto.signDetached(joiner.signingSecretKey, pairing.helloProofPayload(hello))

  class FakeConn extends EventEmitter {
    constructor () {
      super()
      this.writes = []
    }

    write (buf) {
      this.writes.push(b4a.toString(buf))
      return true
    }

    end () {}
  }
  const conn = new FakeConn()
  const approval = new Promise(resolve => pe.ctx.on('pair-approval-needed', resolve))
  pe.swarm.emit('connection', conn, { topics: [decoded.topic] })
  conn.emit('data', b4a.from(JSON.stringify(hello)))
  const req = await approval

  t.ok(req && req.requestId, 'signed hello creates a pending approval request')
  t.is(req.confirmation, pairing.confirmationPhraseForHello(hello), 'approval event exposes the confirmation code')
  t.absent(pe.ctx.sync.devices.has(joiner.deviceId), 'joiner is not admitted before local approval')
  t.absent(conn.writes.some(s => s.includes('pp-pair-bootstrap')), 'bootstrap is not released before local approval')

  await call(pe, COMMANDS.PAIR_APPROVE, { requestId: req.requestId })
  t.ok(pe.ctx.sync.devices.has(joiner.deviceId), 'joiner is admitted after approval')
  const wire = conn.writes.map(s => {
    try { return JSON.parse(s) } catch (_) { return null }
  }).find(m => m && m.t === 'pp-pair-bootstrap')
  t.ok(wire && wire.sealed, 'approval sends the sealed bootstrap')
  const bs = pairing.openBootstrap({
    boxPubkey: joiner.boxPubkey,
    boxSecretKey: joiner.boxSecretKey,
    sealed: wire.sealed
  })
  t.absent(Object.prototype.hasOwnProperty.call(bs, 'unlockSecret'), 'bootstrap never carries a local unlock secret')
})
