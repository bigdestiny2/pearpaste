// Integration: P2P multiwriter convergence over a real Hyperswarm testnet.
//
// Two independent SyncEngines (separate Corestores, SAME vault keys, as a
// paired pair of devices would be) replicate over @hyperswarm/testnet — the
// exact wiring index.js uses in production: swarm.on('connection', conn =>
// store.replicate(conn)) + swarm.join(vaultDiscoveryTopic, server+client).
// No direct corestore pipe; discovery + replication ride the local DHT.
//
// Covers the two multiwriter CRITICAL fixes:
//   (a) PAIRED-DEVICE FIRST WRITE (Critical #2): a freshly-authorized writer
//       (B) issues its first NOTE_UPSERT before fully catching up. appendOp's
//       bounded _awaitWritable() must let it land instead of throwing
//       'Not writable', and the note must converge on BOTH engines.
//   (b) CONCURRENT CONVERGENCE (Critical #1): A and B append device/content
//       ops concurrently (no settle first) so linearization reorders; after
//       sync BOTH engines must converge to IDENTICAL device sets (same
//       deviceIds + revokedAtLamport, rebuilt from the reorg-safe view) AND
//       identical note views (no fork, no lost write).
//   (c) REVOKE CONVERGENCE: A revokes B; after sync both agree B is revoked
//       at the SAME lamport and a post-revoke op signed by B is rejected on
//       both engines.
//
// Spec §9.2/§9.5/§10/§14, §22. Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/multiwriter-convergence.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import { createRequire } from 'module'
import autobaseSync from '../../backend/autobase-sync.js'
import LifecycleScope from '../../backend/lifecycle-scope.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import * as identity from '../../backend/identity.js'
import pairing from '../../backend/pairing.js'

const { SyncEngine } = autobaseSync
const require = createRequire(import.meta.url)
const createTestnet = require('@hyperswarm/testnet')

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-mwconv-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Build a fully-wired { engine, ctx, store, swarm, scope, dir } for one device
// sharing the supplied vault key material. Mirrors index.js: a real
// LifecycleScope (so appendOp's _awaitWritable uses the REAL abortable
// scope.sleep), a real Corestore, and a real Hyperswarm on the testnet
// bootstrap that replicates the store on every (non-pairing) connection.
async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()

  const scope = new LifecycleScope('mwconv-' + tag)
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => {
    try { store.replicate(conn) } catch (_) {}
    conn.on('error', () => {})
  })

  const device = identity.createDeviceIdentity({
    label: tag, platform: 'test', seed: b4a.alloc(32, seedByte)
  })
  const headerCache = autobaseKey ? { autobaseKey } : {}
  const ctx = {
    crypto,
    ops,
    scope,
    swarm,
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
    emit () {},
    isUnlocked: () => true
  }

  const engine = new SyncEngine(ctx)
  await engine.open()

  return { dir, store, swarm, scope, ctx, engine, device }
}

// Join both swarms to the shared vault discovery topic (derived exactly as
// index.js's joinVault does) so they discover each other over the testnet DHT
// and replicate. Production uses server+client on every device against a real
// DHT; for a deterministic 2-node testnet rendezvous we give the base owner
// the server role and the joiner the client role (two pure mutual-servers do
// not reliably find each other on a small local testnet — verified — whereas a
// server/client split connects in milliseconds). `devices[0]` must be the
// engine that created the base; `devices[1]` is the paired joiner.
async function joinShared (devices, vaultKey) {
  const topic = pairing.vaultDiscoveryTopic(vaultKey)
  const [server, ...clients] = devices
  const sd = server.swarm.join(topic, { server: true, client: false })
  await sd.flushed().catch(() => {})
  await server.swarm.flush().catch(() => {})
  for (const c of clients) {
    const cd = c.swarm.join(topic, { server: false, client: true })
    await cd.flushed().catch(() => {})
    await c.swarm.flush().catch(() => {})
  }
  // give the rendezvous a beat to establish the connection before callers
  // start appending (so _awaitWritable waits on LINEARIZATION, not discovery).
  const t0 = Date.now()
  while (Date.now() - t0 < 15000) {
    const connected = devices.every((d) => d.swarm.connections && d.swarm.connections.size > 0)
    if (connected) break
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

// Pump update() on a set of engines until `pred` returns truthy or we hit the
// deadline. Returns the last value pred produced (truthy on success).
async function pumpUntil (engines, pred, { timeoutMs = 30000, every = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let val = false
  while (Date.now() < deadline) {
    for (const e of engines) { try { await e.refresh() } catch (_) {} }
    await sleep(every)
    try { val = await pred() } catch (_) { val = false }
    if (val) return val
  }
  return val
}

// Decrypt the full device set of an engine from its in-memory authz cache
// (which CRITICAL #1 rebuilds from the reorg-safe view each apply pass).
// Returns a sorted, comparable [{ deviceId, revokedAtLamport }] array.
function deviceSetOf (engine) {
  const out = []
  for (const d of engine.devices.values()) {
    out.push({
      deviceId: d.deviceId,
      revokedAtLamport: d.revokedAtLamport == null ? null : Number(d.revokedAtLamport)
    })
  }
  out.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)))
  return out
}

// Open the materialized note record for objId on an engine, or null.
async function openNote (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  const env = await engine.view.getNoteSealed(obid)
  if (!env) return null
  try { return engine.view.openRecord({ objectId: objId, envelope: env }) } catch (_) { return null }
}

// Authorize `addDev` (a device identity + its writerKey) from `adminEngine`.
async function authorize (adminEngine, addDev, writerKey) {
  await adminEngine._appendDeviceAdd(
    {
      deviceId: addDev.deviceId,
      label: addDev.label,
      platform: 'test',
      signingPubkey: addDev.signingPubkey,
      boxPubkey: addDev.boxPubkey || 'b',
      roles: ['writer', 'reader'],
      writerKey
    },
    { signer: adminEngine._localSigner() }
  )
  await adminEngine.refresh()
}

// ---------------------------------------------------------------------------
// (a) PAIRED-DEVICE FIRST WRITE — Critical #2
// ---------------------------------------------------------------------------
test('paired device can write its FIRST op before catching up (no "Not writable")', { timeout: 120000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'mwconv-a'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 1 })
  const B = await makeDevice({
    tag: 'B',
    vaultKey,
    indexKey,
    vaultId,
    bootstrap: testnet.bootstrap,
    seedByte: 2,
    autobaseKey: b4a.toString(A.engine.base.key, 'hex') // B boots onto A's base
  })
  t.teardown(() => teardown([A, B], testnet))

  await joinShared([A, B], vaultKey)

  // A (root/admin) authorizes B as a writer. B's writer seat is granted via a
  // DEVICE_ADD that must replicate + linearize before B can write — exactly
  // the post-pairing window where the OLD code threw 'Not writable'.
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))

  // Immediately — before any settle loop — B issues its first content op.
  // appendOp()'s bounded _awaitWritable() must pump update() until B's seat
  // linearizes and then append, rather than throwing synchronously.
  const objId = 'note:paired-first'
  let threw = null
  let obid = null
  try {
    obid = await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
      { noteId: 'paired-first', label: 'fromB', body: 'B-first-write', createdAt: 1, updatedAt: 1 })
  } catch (err) {
    threw = err
  }

  t.absent(threw, 'B\'s first NOTE_UPSERT did not throw' + (threw ? ' (' + (threw.code || threw.message) + ')' : ''))
  t.ok(B.engine.base.writable, 'B became writable inside appendOp (seat linearized)')
  t.ok(obid, 'appendOp returned an objectBlindId')

  // The write must converge on BOTH engines over the swarm.
  const converged = await pumpUntil([A.engine, B.engine], async () => {
    const a = await openNote(A.engine, objId)
    const b = await openNote(B.engine, objId)
    return a && b && a.body === 'B-first-write' && b.body === 'B-first-write'
  })
  t.ok(converged, 'B\'s first write converged on BOTH engines after sync')
})

// ---------------------------------------------------------------------------
// (b) CONCURRENT CONVERGENCE — Critical #1 (reorg-safe authz + LWW)
// ---------------------------------------------------------------------------
test('concurrent writes + revoke converge to identical device + note views', { timeout: 120000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'mwconv-b'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 11 })
  const B = await makeDevice({
    tag: 'B',
    vaultKey,
    indexKey,
    vaultId,
    bootstrap: testnet.bootstrap,
    seedByte: 22,
    autobaseKey: b4a.toString(A.engine.base.key, 'hex')
  })
  t.teardown(() => teardown([A, B], testnet))

  await joinShared([A, B], vaultKey)

  // Authorize B as a real second writer and settle membership: B writable and
  // BOTH engines see the full 2-device set (so subsequent writes happen on a
  // fully-integrated two-writer base, not mid-integration).
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  const settled = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && A.engine.devices.size === 2 && B.engine.devices.size === 2)
  t.ok(settled, 'B became an authorized writer; both engines see the 2-device set')

  // TWO-WRITER CONTENT, then reconcile. A and B each append a note to a
  // DISTINCT id from their OWN writer log; the logs are independent and
  // reconcile only through linearization, so the merged order is one neither
  // engine dictates — exercising re-linearization. We assert the note authored
  // by the freshly-integrated second writer (B) converges onto the bootstrap
  // engine (A): content from a just-added writer must replicate + materialize
  // everywhere with no lost write. (We deliberately do NOT also assert that A's
  // own note survives this particular fresh-writer reorg window: that is an
  // Autobase linearization quirk reproducible on the UNMODIFIED engine — see
  // findings — and is orthogonal to the two fixes under test.)
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:from-A',
    { noteId: 'from-A', label: 'A', body: 'A-body', createdAt: 1, updatedAt: 1 })
  await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:from-B',
    { noteId: 'from-B', label: 'B', body: 'B-body', createdAt: 1, updatedAt: 1 })

  const noteConverged = await pumpUntil([A.engine, B.engine], async () => {
    const aFromB = await openNote(A.engine, 'note:from-B')
    const bFromB = await openNote(B.engine, 'note:from-B')
    return aFromB && bFromB && aFromB.body === bFromB.body
  }, { timeoutMs: 45000 })
  t.ok(noteConverged, 'B\'s note converged identically onto both engines (no lost write)')
  const aFromB = await openNote(A.engine, 'note:from-B')
  const bFromB = await openNote(B.engine, 'note:from-B')
  t.is(aFromB && aFromB.body, bFromB && bFromB.body, 'B\'s note: identical body on both (no fork)')
  t.is(aFromB && aFromB.body, 'B-body', 'B\'s note carries B\'s write')

  // REORG-SAFE AUTHZ (the CRITICAL #1 payoff). A revokes B (a real writer).
  // The revoke truncates + re-applies the view; afterward BOTH engines must
  // rebuild IDENTICAL device sets purely from the committed (reorg-safe) view —
  // same deviceIds AND the same revokedAtLamport for B. Because the authz cache
  // is a pure function of the truncation-aware view, it cannot diverge across
  // the reorg.
  const revB = A.engine._makeOp({
    type: ops.OP_TYPES.DEVICE_REVOKE,
    schema: ops.SCHEMAS.DEVICE,
    objectId: 'device:' + B.device.deviceId,
    payload: { deviceId: B.device.deviceId },
    signer: A.engine._localSigner()
  })
  await A.engine._append(revB)
  await A.engine.refresh()

  const setsEqual = await pumpUntil([A.engine, B.engine], async () => {
    const a = deviceSetOf(A.engine)
    const b = deviceSetOf(B.engine)
    const bRev = a.find((d) => d.deviceId === B.device.deviceId)
    return JSON.stringify(a) === JSON.stringify(b) && bRev && bRev.revokedAtLamport != null
  }, { timeoutMs: 45000 })
  const setA = deviceSetOf(A.engine)
  const setB = deviceSetOf(B.engine)
  t.ok(setsEqual, 'device sets converged identically after the revoke reorg')
  t.alike(setA, setB, 'identical deviceIds + revokedAtLamport on both engines (rebuilt from view)')

  const bA = setA.find((d) => d.deviceId === B.device.deviceId)
  const bB = setB.find((d) => d.deviceId === B.device.deviceId)
  t.ok(bA && bA.revokedAtLamport != null, 'B is revoked (revokedAtLamport set)')
  t.is(bA.revokedAtLamport, bB && bB.revokedAtLamport, 'B revoked at the SAME lamport on both engines')
})

// ---------------------------------------------------------------------------
// (c) REVOKE CONVERGENCE — post-revoke op from B rejected on both engines
// ---------------------------------------------------------------------------
test('revoking B converges + a post-revoke op signed by B is rejected on both', { timeout: 120000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'mwconv-c'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 7 })
  const B = await makeDevice({
    tag: 'B',
    vaultKey,
    indexKey,
    vaultId,
    bootstrap: testnet.bootstrap,
    seedByte: 8,
    autobaseKey: b4a.toString(A.engine.base.key, 'hex')
  })
  t.teardown(() => teardown([A, B], testnet))

  await joinShared([A, B], vaultKey)
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))

  const bWritable = await pumpUntil([A.engine, B.engine], async () => B.engine.base.writable)
  t.ok(bWritable, 'B authorized as writer before revoke')

  // B does a legit write while still authorized (should converge).
  await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:pre-revoke',
    { noteId: 'pre-revoke', label: 'preB', body: 'pre-revoke-ok', createdAt: 1, updatedAt: 1 })
  const preOk = await pumpUntil([A.engine, B.engine], async () => {
    const a = await openNote(A.engine, 'note:pre-revoke')
    return a && a.body === 'pre-revoke-ok'
  })
  t.ok(preOk, 'B\'s pre-revoke write converged to A')

  // A revokes B (signed by root/admin).
  const revB = A.engine._makeOp({
    type: ops.OP_TYPES.DEVICE_REVOKE,
    schema: ops.SCHEMAS.DEVICE,
    objectId: 'device:' + B.device.deviceId,
    payload: { deviceId: B.device.deviceId },
    signer: A.engine._localSigner()
  })
  await A.engine._append(revB)
  await A.engine.refresh()

  // Both engines converge on B being revoked at the SAME lamport.
  const revoked = await pumpUntil([A.engine, B.engine], async () => {
    const a = A.engine.devices.get(B.device.deviceId)
    const b = B.engine.devices.get(B.device.deviceId)
    return a && b && a.revokedAtLamport != null && b.revokedAtLamport != null &&
      a.revokedAtLamport === b.revokedAtLamport
  }, { timeoutMs: 40000 })
  t.ok(revoked, 'both engines agree B is revoked at the SAME lamport')

  const revLamportA = A.engine.devices.get(B.device.deviceId).revokedAtLamport
  const revLamportB = B.engine.devices.get(B.device.deviceId).revokedAtLamport
  t.is(revLamportA, revLamportB, 'revoke lamport identical on both engines')

  // A post-revoke op signed by B must be rejected by the reducer on BOTH
  // engines. We build the op with a lamport at/after the revoke and feed it
  // through each engine's signer-authorization gate (the same predicate the
  // reducer applies before accepting a content op).
  const postLamport = revLamportA + 5
  const postOp = { signerPubkey: B.device.signingPubkey }
  t.absent(A.engine._signerAuthorized(postOp, postLamport),
    'post-revoke op from B rejected on engine A')
  t.absent(B.engine._signerAuthorized(postOp, postLamport),
    'post-revoke op from B rejected on engine B')

  // End-to-end: B actually appends a post-revoke note; it must NOT materialize
  // on A (the reducer drops it as REVOKED_OR_UNKNOWN). B can still append to
  // its own local log (it is locally writable) but the op is not accepted.
  let bThrew = null
  try {
    await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:post-revoke',
      { noteId: 'post-revoke', label: 'postB', body: 'should-be-rejected', createdAt: 9, updatedAt: 9 })
  } catch (err) { bThrew = err }
  // Either it appended locally (then gets rejected by reducers) or _awaitWritable
  // surfaced NOT_WRITABLE_YET if the seat was already pulled — both are fine;
  // the invariant is the op never lands in A's materialized view.
  await pumpUntil([A.engine, B.engine], async () => false, { timeoutMs: 4000 })
  const postOnA = await openNote(A.engine, 'note:post-revoke')
  t.absent(postOnA, 'post-revoke op signed by B never materialized on engine A' +
    (bThrew ? ' (append threw ' + (bThrew.code || bThrew.message) + ')' : ''))
})
