// Integration: PHASE 3 network-layer revocation controls over a real
// @hyperswarm/testnet (REVOCATION_DESIGN Phase 3, §3.7, §4; GATE finding SB2).
//
// What Phase 3 adds (and what this file proves):
//   FIREWALL (the load-bearing control, SB2): store.replicate(conn) is gated
//   on the peer authenticating as a COMMITTED NON-REVOKED device, and on
//   DEVICE_REVOKE every EXISTING stream authenticated to the revoked device is
//   actively conn.destroy()ed — refusing new connections alone is not enough
//   (replication streams survive swarm.leave; relay unseed is cosmetic).
//   TOPIC ROTATION (discovery convenience): the post-rotation topic derives
//   from epochKey_{N+1}, which the revoked device provably cannot compute.
//   FOLLOW-TOPIC (chicken/egg): an OFFLINE survivor that missed the rotation
//   rejoins via its own follow topic, replicates the KEY_ROTATE, unwraps its
//   lockbox, and walks forward onto the new topic.
//   HONEST L2: a NON-firewalled source still serves the revoked device the
//   opaque post-revoke ciphertext — it just cannot DECRYPT it (confidentiality
//   rests entirely on the Phase 2 content-key rotation).
//
// Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/revocation-network.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { createRequire } from 'module'
import autobaseSync from '../../backend/autobase-sync.js'
import { createReplicationFirewall } from '../../backend/replication-firewall.js'
import LifecycleScope from '../../backend/lifecycle-scope.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import * as identity from '../../backend/identity.js'
import pairing from '../../backend/pairing.js'

const { SyncEngine } = autobaseSync
const require = createRequire(import.meta.url)
const createTestnet = require('@hyperswarm/testnet')

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-revnet-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// A fully-wired device EXACTLY as index.js wires production post-Phase-3: the
// swarm 'connection' handler routes through the REPLICATION FIREWALL (no more
// unconditional store.replicate), and the reducer's 'device-revoked' signal
// destroys live streams to the revoked peer. `enforce:false` models a
// NON-firewalled node (legacy peer / third-party relay stand-in) for the
// honest-L2 assertion: it replicates with anyone, but still authenticates
// outbound so enforcing peers accept it.
async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey, enforce = true, destroyOnRevoke = true }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()

  const scope = new LifecycleScope('revnet-' + tag)
  const swarm = new Hyperswarm({ bootstrap })

  const device = identity.createDeviceIdentity({
    label: tag, platform: 'test', seed: b4a.alloc(32, seedByte)
  })
  const headerCache = autobaseKey ? { autobaseKey } : {}
  const listeners = new Map()
  const ref = {}
  const ctx = {
    crypto,
    ops,
    scope,
    swarm,
    identity,
    log: { debug () {}, info () {}, warn () {}, error () {} },
    state: {
      vaultId,
      vaultKeys: { vaultKey, indexKey },
      device,
      lamport: new ops.Lamport(0),
      _vaultHeaderCache: headerCache
    },
    vaultStore: {
      store,
      namespace: (ns) => store.namespace(ns),
      getVaultHeader: async () => headerCache,
      putVaultHeader: async (h) => { Object.assign(headerCache, h); return h }
    },
    on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
    emit (ev, payload) { for (const fn of listeners.get(ev) || []) { try { fn(payload) } catch (_) {} } },
    isUnlocked: () => true
  }

  const firewall = createReplicationFirewall({
    store,
    getDevice: () => device,
    getEngine: () => ref.engine,
    enforce
  })
  swarm.on('connection', (conn) => firewall.handleConnection(conn, null))
  if (destroyOnRevoke) {
    ctx.on('device-revoked', (e) => { if (e && e.deviceId) firewall.destroyPeer(e.deviceId) })
  }

  const engine = new SyncEngine(ctx)
  ref.engine = engine
  await engine.open()
  return { dir, store, swarm, scope, ctx, engine, device, tag, firewall }
}

async function joinShared (devices, vaultKey, { waitConnected = true } = {}) {
  const topic = pairing.vaultDiscoveryTopic(vaultKey)
  for (const d of devices) {
    const disc = d.swarm.join(topic, { server: true, client: true })
    await disc.flushed().catch(() => {})
    await d.swarm.flush().catch(() => {})
  }
  if (!waitConnected) return topic
  const want = devices.length - 1
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    const ok = devices.every((d) => d.swarm.connections && d.swarm.connections.size >= want)
    if (ok) break
    await sleep(150)
  }
  return topic
}

async function teardown (devices, testnet) {
  for (const d of devices) {
    try { await d.scope.close() } catch (_) {}
    try { await d.engine.close() } catch (_) {}
    try { await d.swarm.destroy() } catch (_) {}
    try { await d.store.close() } catch (_) {}
    try { fs.rmSync(d.dir, { recursive: true, force: true }) } catch (_) {}
  }
  try { if (testnet) await testnet.destroy() } catch (_) {}
}

async function convergeStep (engines) {
  for (const e of engines) {
    try { await e.refresh() } catch (_) {}
    try { await e._reconcileDurability() } catch (_) {}
  }
}

async function pumpUntil (engines, pred, { timeoutMs = 45000, every = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let val = false
  while (Date.now() < deadline) {
    await convergeStep(engines)
    await sleep(every)
    try { val = await pred() } catch (_) { val = false }
    if (val) return val
  }
  return val
}

// Bounded poll for a plain (non-engine) condition — e.g. a swarm connection
// going away. Used instead of a fixed sleep so a slow CI runner that takes
// longer than a hard-coded wait to notice a close doesn't flake the assertion.
async function waitFor (pred, { timeoutMs = 30000, every = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let val = false
  while (Date.now() < deadline) {
    try { val = await pred() } catch (_) { val = false }
    if (val) return val
    await sleep(every)
  }
  return val
}

// Like pumpUntil, but ALSO re-issues a swarm-reconnect `nudge` on a widening
// backoff (immediately, then ~every 4s growing toward ~every 15s) while it pumps
// the engines toward `pred`. CI's shared runners can silently drop a one-shot
// @hyperswarm/testnet announce right as a peer (re)joins a topic; a passive
// convergeStep loop can never recover a lost announce or a dropped stream, so we
// actively re-announce/re-query/re-dial the known peers until the engines
// converge or the (CI-generous) deadline expires.
async function pumpReconnect ({ engines, pred, nudge, timeoutMs = 150000, every = 250 }) {
  const deadline = Date.now() + timeoutMs
  let val = false
  let nextNudge = 0
  let backoff = 4000
  while (Date.now() < deadline) {
    if (nudge && Date.now() >= nextNudge) {
      try { await nudge() } catch (_) {}
      nextNudge = Date.now() + backoff
      backoff = Math.min(Math.floor(backoff * 1.5), 15000)
    }
    await convergeStep(engines)
    await sleep(every)
    try { val = await pred() } catch (_) { val = false }
    if (val) return val
  }
  return val
}

async function openNote (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  const env = await engine.view.getNoteSealed(obid)
  if (!env) return null
  try { return engine.view.openRecord({ objectId: objId, envelope: env }) } catch (_) { return null }
}

async function noteEnvelope (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  return engine.view.getNoteSealed(obid)
}

async function authorize (adminEngine, addDev, writerKey) {
  await adminEngine._appendDeviceAdd(
    {
      deviceId: addDev.deviceId,
      label: addDev.label,
      platform: 'test',
      signingPubkey: addDev.signingPubkey,
      boxPubkey: addDev.boxPubkey,
      roles: ['writer', 'reader'],
      writerKey
    },
    { signer: adminEngine._localSigner() }
  )
  await adminEngine.refresh()
}

async function revoke (adminEngine, targetDeviceId) {
  const survivors = adminEngine._survivingDevices(targetDeviceId)
  const revOp = adminEngine._makeOp({
    type: ops.OP_TYPES.DEVICE_REVOKE,
    schema: ops.SCHEMAS.DEVICE,
    objectId: 'device:' + targetDeviceId,
    payload: { deviceId: targetDeviceId },
    signer: adminEngine._localSigner()
  })
  const rot = adminEngine._makeKeyRotateOp({ revokedDeviceId: targetDeviceId, survivors, signer: adminEngine._localSigner() })
  await adminEngine._append(revOp)
  await adminEngine._append(rot.op)
  adminEngine.epochKeys.set(rot.epochTag, rot.epochKey)
  await adminEngine.refresh()
  return rot
}

function swarmPubHex (dev) { return b4a.toString(dev.swarm.keyPair.publicKey, 'hex') }

function connsTo (dev, pubHex) {
  const out = []
  for (const c of dev.swarm.connections) {
    const h = c.remotePublicKey ? b4a.toString(b4a.from(c.remotePublicKey), 'hex') : null
    if (h === pubHex) out.push(c)
  }
  return out
}

// ---------------------------------------------------------------------------
// SB2: the firewall destroys EXISTING streams to a peer that becomes revoked,
// refuses its NEW connections, the revoked device cannot derive the
// post-rotation topic — and (honest L2) a non-firewalled source still serves
// it OPAQUE ciphertext it cannot decrypt.
// ---------------------------------------------------------------------------
test('SB2 firewall: destroys existing + refuses new revoked-peer streams; topic_1 underivable; honest L2', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revnet-firewall'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 11 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 12, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 13, autobaseKey: baseKey })
  // D = committed device that does NOT enforce the firewall (legacy peer /
  // user-uncontrolled relay stand-in) — the honest-L2 ciphertext channel.
  const D = await makeDevice({ tag: 'D', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 14, autobaseKey: baseKey, enforce: false, destroyOnRevoke: false })
  t.teardown(() => teardown([A, B, C, D], testnet))

  // Authorize BEFORE joining — matching the real pairing flow, where the
  // inviter commits DEVICE_ADD at approval before the joiner ever dials the
  // vault topic, so connecting peers authenticate against a complete set.
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  await authorize(A.engine, D.device, b4a.toString(D.engine.base.local.key, 'hex'))
  await joinShared([A, B, C, D], vaultKey)
  const engines = [A.engine, B.engine, C.engine, D.engine]

  await pumpUntil(engines, async () =>
    B.engine.base.writable && C.engine.base.writable && D.engine.base.writable &&
    engines.every((e) => e.devices.size === 4),
  { timeoutMs: 180000 })

  // Pre-revoke content converges everywhere — including to C via firewalled
  // peers, because C is still a committed non-revoked device.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-pre-revoke', createdAt: 1, updatedAt: 1 })
  const n0Converged = await pumpUntil(engines, async () => {
    const notes = await Promise.all(engines.map((e) => openNote(e, 'note:n0')))
    return notes.every(Boolean)
  })
  t.ok(n0Converged, 'n0 converged to every committed device while C was still trusted')

  // B must hold a LIVE stream AUTHENTICATED to C BEFORE the revoke, so the
  // destroy-existing assertion below is real. Pumped: swarm churn can recycle
  // the underlying conn, and a fresh one re-runs the handshake (~1s).
  const cPub = swarmPubHex(C)
  const preStream = await pumpUntil(engines, async () =>
    connsTo(B, cPub).some((c) => !c.destroyed) &&
    (B.firewall.authenticatedPeers()[C.device.deviceId] || 0) >= 1,
  { timeoutMs: 30000 })
  t.ok(preStream, 'B holds a live stream AUTHENTICATED to C\'s device identity before the revoke')

  // ---- A revokes C → rotation to epoch 1 ----------------------------------
  const rot = await revoke(A.engine, C.device.deviceId)
  const epochTag1 = rot.epochTag

  const applied = await pumpUntil(engines, async () =>
    A.engine.activeEpochTag === epochTag1 && B.engine.activeEpochTag === epochTag1 &&
    B.engine.devices.get(C.device.deviceId) && B.engine.devices.get(C.device.deviceId).revokedAtLamport != null,
  { timeoutMs: 90000 })
  t.ok(applied, 'survivors applied the revoke + rotation')

  // (c-existing) The reducer's 'device-revoked' signal made B's firewall
  // actively destroy its EXISTING stream(s) to C (SB2 part b).
  const bDestroyed = await pumpUntil(engines, async () =>
    B.firewall.stats.destroyedOnRevoke >= 1 && connsTo(B, cPub).every((c) => c.destroyed),
  { timeoutMs: 30000 })
  t.ok(bDestroyed, '(c) B DESTROYED its existing replication stream to C on applying DEVICE_REVOKE')
  t.absent(B.firewall.authenticatedPeers()[C.device.deviceId], '(c) C is no longer an authenticated peer on B')

  // (c-new) A NEW connection from C is REFUSED: C re-dials B directly; B's
  // firewall authenticates it to the committed-REVOKED device and destroys.
  try { C.swarm.joinPeer(b4a.from(swarmPubHex(B), 'hex')) } catch (_) {}
  const refused = await pumpUntil(engines, async () => B.firewall.stats.refusedRevoked >= 1, { timeoutMs: 60000 })
  t.ok(refused, '(c) B REFUSED a fresh connection from the revoked C (authenticated → revoked → destroyed)')

  // (a) C cannot DERIVE the post-rotation topic from anything it holds. The
  // topic seed is never on the wire (B3); it derives only from epochKey_1,
  // which was sealed to A/B/D and never to C.
  const epochKey1 = A.engine.epochKeys.get(epochTag1)
  t.ok(epochKey1, 'survivor A holds epochKey_1')
  const topic1 = pairing.vaultDiscoveryTopic(crypto.topicSeedFromEpochKey(epochKey1))
  const topic0 = pairing.vaultDiscoveryTopic(vaultKey)
  t.absent(C.engine.epochKeys.has(epochTag1), '(a) C never obtained epochKey_1')
  const cDerivableTopics = []
  for (const [, key] of C.engine.epochKeys) {
    cDerivableTopics.push(pairing.vaultDiscoveryTopic(crypto.topicSeedFromEpochKey(key)))
    cDerivableTopics.push(pairing.vaultDiscoveryTopic(key))
  }
  t.ok(cDerivableTopics.some((x) => b4a.equals(x, topic0)), '(a) C can still derive the OLD epoch-0 topic (discovery only — harmless)')
  t.absent(cDerivableTopics.some((x) => b4a.equals(x, topic1)), '(a) NO seed C holds derives the post-rotation topic_1')

  // (d) HONEST L2: A creates n1 post-rotation; the NON-firewalled D serves the
  // opaque ciphertext to C — C gets the BYTES but cannot DECRYPT them.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'n1-post-revoke-secret', createdAt: 2, updatedAt: 2 })
  const n1Survivors = await pumpUntil(engines, async () =>
    (await openNote(B.engine, 'note:n1')) && (await openNote(D.engine, 'note:n1')),
  { timeoutMs: 90000 })
  t.ok(n1Survivors, 'n1 converged onto survivors B and D (D permissive but committed — still entitled)')
  const l2 = await pumpUntil(engines, async () => !!(await noteEnvelope(C.engine, 'note:n1')), { timeoutMs: 90000 })
  t.ok(l2, '(d) L2: the NON-firewalled D still replicated the post-revoke ciphertext to revoked C')
  t.absent(await openNote(C.engine, 'note:n1'), '(d) ...but C cannot READ n1 (no epochKey_1)')
  const cEnv = await noteEnvelope(C.engine, 'note:n1')
  let anyOpened = false
  for (const [, key] of C.engine.epochKeys) {
    try {
      crypto.openWithObjectId({ epochKey: key, objectId: 'opbody:' + crypto.blindId(indexKey, 'note:n1'), envelope: cEnv })
      anyOpened = true
    } catch (_) {}
  }
  t.absent(anyOpened, '(d) every key C holds fails to decrypt the L2-replicated n1 (AEAD fails closed)')
})

// ---------------------------------------------------------------------------
// Follow-topic catch-up: an OFFLINE survivor that missed the rotation rejoins
// via its OWN follow topic, replicates the KEY_ROTATE through the firewall,
// unwraps epochKey_1, and derives the new topic — while the revoked device's
// follow topic is never announced again.
// ---------------------------------------------------------------------------
test('follow-topic: an OFFLINE survivor catches up after a rotation it missed', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revnet-follow'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 21 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 22, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 23, autobaseKey: baseKey })
  t.teardown(() => teardown([A, B, C], testnet))

  const topic0 = await joinShared([A, B, C], vaultKey)
  const engines = [A.engine, B.engine, C.engine]

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  await pumpUntil(engines, async () =>
    B.engine.base.writable && C.engine.base.writable && engines.every((e) => e.devices.size === 3),
  { timeoutMs: 90000 })

  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-pre-offline', createdAt: 1, updatedAt: 1 })
  const preRotationConverged = await pumpUntil(engines, async () =>
    (await openNote(B.engine, 'note:n0')) && (await openNote(C.engine, 'note:n0')),
  { timeoutMs: 90000 })
  t.ok(preRotationConverged, 'A+B+C replicated pre-rotation content before B goes offline')

  // The Phase-3 fallback follow seed both sides derive independently
  // (index.js followSeedCurrent: hkdf(vaultKey, 'follow-seed-v1') until a
  // pairing-delivered followSeed exists — Phase 4).
  const fseed = crypto.hkdf(vaultKey, 'follow-seed-v1', 32)

  // ---- B goes OFFLINE (misses the rotation) --------------------------------
  await B.swarm.leave(topic0).catch(() => {})
  for (const c of [...B.swarm.connections]) { try { c.destroy() } catch (_) {} }
  let bOffline = true
  const offlineGuard = setInterval(() => {
    if (!bOffline) return
    for (const c of [...B.swarm.connections]) { try { c.destroy() } catch (_) {} }
  }, 200)
  if (offlineGuard.unref) offlineGuard.unref()
  t.teardown(() => clearInterval(offlineGuard))
  // Bounded poll (not a fixed sleep): a loaded CI runner can take longer than a
  // hard-coded wait to notice the close, and the offlineGuard keeps tearing B's
  // side down in the meantime, so converge to zero live conns rather than
  // sampling once after an arbitrary delay.
  const bWentOffline = await waitFor(async () =>
    connsTo(A, swarmPubHex(B)).filter((c) => !c.destroyed).length === 0,
  { timeoutMs: 30000 })
  t.ok(bWentOffline, 'A holds no live connection to the offline B')

  // ---- A revokes C → epoch 1 while B is offline ----------------------------
  const rot = await revoke(A.engine, C.device.deviceId)
  const epochTag1 = rot.epochTag
  const applied = await pumpUntil([A.engine], async () =>
    A.engine.activeEpochTag === epochTag1 && A.engine.epochKeys.has(epochTag1), { timeoutMs: 60000 })
  t.ok(applied, 'A activated epoch 1 with B offline')

  // A reconciles its topic set exactly as index.js does post-rotation:
  // leave topic_0 (grace 0, stolen-device default), join topic_1, and ANNOUNCE
  // every SURVIVING peer's follow topic — never the revoked C's.
  const topic1 = pairing.vaultDiscoveryTopic(crypto.topicSeedFromEpochKey(A.engine.epochKeys.get(epochTag1)))
  const survivorsOfA = [...A.engine.devices.values()].filter((d) =>
    d.revokedAtLamport == null && d.deviceId !== A.device.deviceId)
  t.alike(survivorsOfA.map((d) => d.deviceId), [B.device.deviceId],
    'A\'s follow-topic announce set contains ONLY the surviving B — never the revoked C')
  await A.swarm.leave(topic0).catch(() => {})
  const discT1 = A.swarm.join(topic1, { server: true, client: true })
  await discT1.flushed().catch(() => {})
  const discFollowB = A.swarm.join(pairing.followTopic(fseed, B.device.deviceId), { server: true, client: true })
  await discFollowB.flushed().catch(() => {})
  await A.swarm.flush().catch(() => {})

  // Post-rotation content created while B is offline.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'n1-while-B-offline', createdAt: 2, updatedAt: 2 })
  await pumpUntil([A.engine], async () => !!(await openNote(A.engine, 'note:n1')), { timeoutMs: 30000 })

  // The revoked C is stranded: survivors left topic_0, its connections are
  // destroyed/refused by A's firewall, and nobody announces its follow topic.
  await sleep(6000)
  await convergeStep([C.engine])
  t.absent(await noteEnvelope(C.engine, 'note:n1'),
    'revoked C (topic_0 only, firewalled by A) never received the post-rotation ciphertext')

  // ---- B comes back: joins its OWN follow topic and catches up -------------
  bOffline = false
  clearInterval(offlineGuard)
  const discOwn = B.swarm.join(pairing.followTopic(fseed, B.device.deviceId), { server: true, client: true })
  await discOwn.flushed().catch(() => {})

  // The full integration suite can starve @hyperswarm/testnet discovery right as
  // both peers (re)join the follow topic. Re-announce/re-query the given
  // discovery handles and re-dial the already-known peer keys; pumpReconnect
  // re-issues this on a bounded backoff (a single one-shot announce can be
  // silently dropped on a loaded CI runner), keeping the assertion on the
  // firewall + epoch catch-up path rather than DHT scheduler timing.
  const nudgeReconnect = async (discs) => {
    for (const d of discs) { try { await d.refresh().catch(() => {}) } catch (_) {} }
    try { B.swarm.joinPeer(A.swarm.keyPair.publicKey) } catch (_) {}
    try { A.swarm.joinPeer(B.swarm.keyPair.publicKey) } catch (_) {}
    await Promise.all([A.swarm.flush().catch(() => {}), B.swarm.flush().catch(() => {})])
  }

  const caughtKey = await pumpReconnect({
    engines: [A.engine, B.engine],
    pred: async () => B.engine.epochKeys.has(epochTag1) && B.engine.activeEpochTag === epochTag1,
    nudge: () => nudgeReconnect([discOwn, discFollowB]),
    timeoutMs: 150000
  })
  if (!caughtKey) {
    // Flake forensics (from the windows-launcher CI hardening): dump the live
    // connection/auth/epoch state so a CI failure here is diagnosable.
    t.comment('follow-catchup-diag ' + JSON.stringify({
      AtoB: connsTo(A, swarmPubHex(B)).filter((c) => !c.destroyed).length,
      BtoA: connsTo(B, swarmPubHex(A)).filter((c) => !c.destroyed).length,
      AAuth: A.firewall.authenticatedPeers(),
      BAuth: B.firewall.authenticatedPeers(),
      AStats: A.firewall.stats,
      BStats: B.firewall.stats,
      AActiveEpoch: A.engine.activeEpochTag,
      BActiveEpoch: B.engine.activeEpochTag,
      epochTag1,
      BHasEpoch1: B.engine.epochKeys.has(epochTag1),
      BDeviceCount: B.engine.devices.size,
      BDevices: [...B.engine.devices.values()].map((d) => ({ deviceId: d.deviceId, revokedAtLamport: d.revokedAtLamport }))
    }))
  }
  t.ok(caughtKey, 'B caught up VIA ITS FOLLOW TOPIC: replicated the rotation through the firewall and unwrapped epochKey_1')
  if (!caughtKey) return // remaining assertions all depend on epochKey_1
  t.is(B.engine.activeEpochTag, epochTag1, 'B activated the rotation epoch it missed')

  // B now derives the SAME post-rotation topic locally (never transmitted).
  const topic1OnB = pairing.vaultDiscoveryTopic(crypto.topicSeedFromEpochKey(B.engine.epochKeys.get(epochTag1)))
  t.ok(b4a.equals(topic1OnB, topic1), 'B locally derives the identical topic_1 from its unwrapped epochKey_1')

  // Production reconcileTopics() joins the active epoch topic as soon as the
  // offline survivor applies KEY_ROTATE. The lightweight harness models that
  // explicit step here: the follow topic carries B to the new key, then topic_1
  // carries normal post-rotation content.
  const discTopic1B = B.swarm.join(topic1OnB, { server: true, client: true })
  await discTopic1B.flushed().catch(() => {})
  await B.swarm.flush().catch(() => {})

  // n2 = NORMAL post-rotation content, created AFTER B rejoined and unwrapped
  // epochKey_1. B reduces it with the key already in its map, so the reducer
  // re-seals it under the vault key (view.openRecord-readable) deterministically
  // — exactly the "topic_1 carries normal post-rotation content" path the
  // comment above describes, and now genuinely exercised OVER topic_1 (A is on
  // topic_1, B walked onto the identical topic_1OnB). Same reconnect hardening
  // as the key leg: the stream can churn before n2's blocks land, so keep
  // re-announcing/re-dialing while we pump rather than trusting one flush.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n2',
    { noteId: 'n2', label: 'n2', body: 'n2-post-rejoin', createdAt: 3, updatedAt: 3 })
  const caughtContent = await pumpReconnect({
    engines: [A.engine, B.engine],
    pred: async () => await openNote(B.engine, 'note:n2'),
    nudge: () => nudgeReconnect([discOwn, discFollowB, discTopic1B]),
    timeoutMs: 120000
  })
  t.ok(caughtContent, 'B caught post-rotation content (n2, created after B rejoined) over topic_1')

  // The note created DURING B's offline window (n1) is reduced bundled with
  // the KEY_ROTATE on catch-up, and the terminal apply can land in a pass
  // whose (truncated-view) rebuild has not recovered epochKey_1 — persisting
  // n1 epoch-sealed verbatim (putNoteSealedRaw), unreadable by the vault-key
  // read path. The raw-op RE-MATERIALIZER (autobase-sync) records that op
  // pending and re-dispatches it once the key is held, so the offline-window
  // note MUST become readable in-session — gated here end-to-end over the
  // real network (deterministic-harness coverage: revocation-remat.test.js).
  const offlineNoteHealed = await pumpReconnect({
    engines: [A.engine, B.engine],
    pred: async () => {
      const n1 = await openNote(B.engine, 'note:n1')
      return n1 && n1.body === 'n1-while-B-offline'
    },
    nudge: () => nudgeReconnect([discOwn, discFollowB, discTopic1B]),
    timeoutMs: 90000
  })
  t.ok(offlineNoteHealed, 'offline-window note n1 readable on B IN-SESSION (raw-op re-materialization)')
})
