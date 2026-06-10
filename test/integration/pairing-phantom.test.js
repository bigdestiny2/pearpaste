// Integration: pairing-phantom cleanup (DEVICE_HYGIENE_FIXES Fix B).
//
// approvePairRequest authorizes the joiner's writer THE INSTANT the user clicks
// Approve (responsive UX). If the joiner never finishes joining (disconnect,
// abandon, crash) it would linger forever as a permanently-authorized phantom
// in DEVICE_LIST. Fix B spawns a scoped confirm task that waits a generous,
// CONFIGURABLE window for a join confirmation — EITHER the pp-pair-joined ack on
// the pairing conn OR the joiner's writer producing a node in the base — and
// only if NEITHER appears appends a compensating DEVICE_REVOKE.
//
// The non-trivial constraint: un-authorizing rotates the epoch key, so a
// wrongful revoke of a slow-but-legitimate joiner is STRICTLY WORSE than a
// phantom. These two cases prove the bias is correct:
//   (a) joiner KILLED before joining  -> device revoked after the window
//   (b) joiner merely SLOW (late ack) -> device NEVER revoked
//
// Both drive the REAL Pear-end (createPearEnd) PAIR_APPROVE handler over a
// FakeConn with a deliberately short window, exactly like sec-pairing.test.js.
//
// Run: node test/integration/pairing-phantom.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'
import b4a from 'b4a'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import * as pairing from '../../backend/pairing.js'
import * as identity from '../../backend/identity.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-phantom-' + tag + '-')) }
const call = (pe, c, p) => pe.call(c, p || {})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeConn extends EventEmitter {
  constructor () { super(); this.writes = [] }
  write (buf) { this.writes.push(b4a.toString(buf)); return true }
  end () {}
}

// Drive the inviter up to (and including) a local approval for a freshly-built
// joiner hello, returning everything the test needs to assert on the aftermath.
async function approveFreshJoiner (t, pe, { pairJoinConfirmMs }) {
  await call(pe, COMMANDS.CREATE_VAULT, { label: 'source', platform: 'macos', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  // Short, configurable cleanup window (the whole point of Fix B's testability).
  pe.ctx.sync.pairJoinConfirmMs = pairJoinConfirmMs

  const inv = await call(pe, COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 120000 })
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
  hello.signature = pe.ctx.crypto.signDetached(joiner.signingSecretKey, pairing.helloProofPayload(hello))
  const confirmation = pairing.confirmationPhraseForHello(hello)

  const conn = new FakeConn()
  const approval = new Promise(resolve => pe.ctx.on('pair-approval-needed', resolve))
  pe.swarm.emit('connection', conn, { topics: [decoded.topic] })
  conn.emit('data', b4a.from(JSON.stringify(hello)))
  const req = await approval
  t.ok(req && req.requestId, 'signed hello created a pending approval request')

  await call(pe, COMMANDS.PAIR_APPROVE, { requestId: req.requestId })
  t.ok(pe.ctx.sync.devices.has(joiner.deviceId), 'joiner is authorized IMMEDIATELY on approve (responsive UX)')

  return { joiner, conn, confirmation }
}

// Poll the committed device set (pumping the engine) until `pred` holds or we
// time out. Returns the final boolean.
async function pumpUntil (engine, pred, { timeoutMs = 8000, every = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { await engine.refresh() } catch (_) {}
    let v = false
    try { v = await pred() } catch (_) { v = false }
    if (v) return true
    await sleep(every)
  }
  return false
}

const isRevoked = (engine, deviceId) => {
  const d = engine.devices.get(deviceId)
  return !!(d && d.revokedAtLamport != null)
}

// ---------------------------------------------------------------------------
// (a) Joiner killed before joining -> phantom is revoked after the window.
// ---------------------------------------------------------------------------
test('Fix B: a joiner that never confirms joining is revoked after the window', { timeout: 60000 }, async (t) => {
  const dir = tmp('killed')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  let phantomEvent = null
  const phantomFired = new Promise(resolve => pe.ctx.on('pair-phantom-revoked', (e) => { phantomEvent = e; resolve(e) }))

  const { joiner } = await approveFreshJoiner(t, pe, { pairJoinConfirmMs: 800 })

  // The joiner is "killed": it sends NO pp-pair-joined ack and its writer never
  // produces a node (FakeConn carries no replication). After the window the
  // inviter must roll back the phantom.
  t.absent(isRevoked(pe.ctx.sync, joiner.deviceId), 'device is NOT revoked while still within the window')

  // Wait for the compensating-revoke signal itself (not just the committed
  // state, which a concurrent poll could observe before the handler emits).
  const ev = await Promise.race([phantomFired, sleep(15000).then(() => null)])
  t.ok(ev && ev.deviceId === joiner.deviceId, 'pair-phantom-revoked event names the phantom device once the window elapses')
  t.ok(phantomEvent && phantomEvent.deviceId === joiner.deviceId, 'phantom-revoked carried the phantom deviceId')

  const revoked = await pumpUntil(pe.ctx.sync, () => isRevoked(pe.ctx.sync, joiner.deviceId), { timeoutMs: 5000 })
  t.ok(revoked, 'phantom device is committed-revoked after the window')
  t.not(pe.ctx.sync.isDeviceAllowed(joiner.deviceId), 'allowed', 'the revoked phantom is no longer an allowed device')
})

// ---------------------------------------------------------------------------
// (b) Joiner is merely slow (late but valid ack) -> NEVER revoked.
// ---------------------------------------------------------------------------
test('Fix B: a slow-but-legitimate joiner is NEVER revoked', { timeout: 60000 }, async (t) => {
  const dir = tmp('slow')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  let phantomEvent = null
  let confirmedEvent = null
  pe.ctx.on('pair-phantom-revoked', (e) => { phantomEvent = e })
  pe.ctx.on('pair-join-confirmed', (e) => { confirmedEvent = e })

  const windowMs = 1500
  const { joiner, conn, confirmation } = await approveFreshJoiner(t, pe, { pairJoinConfirmMs: windowMs })

  // The joiner is SLOW: its pp-pair-joined ack arrives well into the window
  // (here ~40% through). A naive ack-timeout would have already fired; Fix B
  // must accept this signal and never revoke.
  await sleep(Math.floor(windowMs * 0.4))
  conn.emit('data', b4a.from(JSON.stringify({
    t: 'pp-pair-joined',
    deviceId: joiner.deviceId,
    confirmation
  })))

  // Wait comfortably PAST the window so a wrongful revoke would have happened.
  await sleep(windowMs + 1500)
  // Pump a bit more in case a stray revoke was queued.
  await pumpUntil(pe.ctx.sync, () => false, { timeoutMs: 600 })

  t.absent(isRevoked(pe.ctx.sync, joiner.deviceId), 'B1 guarantee: a slow-but-legit joiner is NEVER revoked (no wrongful key rotation)')
  t.ok(pe.ctx.sync.devices.has(joiner.deviceId), 'the legitimate joiner remains an authorized member')
  t.is(phantomEvent, null, 'no pair-phantom-revoked event ever fired for the slow joiner')
  t.ok(confirmedEvent && confirmedEvent.deviceId === joiner.deviceId, 'the late pp-pair-joined ack confirmed the join')
})
