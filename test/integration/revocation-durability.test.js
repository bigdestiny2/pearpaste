// Integration: PHASE 5 durability controls over a real @hyperswarm/testnet
// (REVOCATION_DESIGN §3.9 / §5.12, RT-FIX B4, B9).
//
// What Phase 5 adds (and what this file proves):
//   EPOCH-FAITHFUL RE-APPEND (B4): the durability reconciler re-appends a
//   rolled-back row under the row's ORIGINAL epochTag — never the active one —
//   so pre-rotation content is never pulled forward into the new epoch and the
//   re-appended row's keyId stays the original (no cross-epoch linkage).
//   DURABLE TOMBSTONES (B9): a cross-device delete writes a sealed tombstone
//   that (a) makes the reconciler treat the object as settled — a remote
//   device's reconciler can no longer RESURRECT a row another device deleted —
//   and (b) gates the *_UPSERT reducer by Lamport, so stale replays die while
//   a genuinely newer user re-create supersedes the marker.
//   REOPEN REBUILD: epoch state (activeEpochTag + unwrapped keys) is recomputed
//   from the committed view across a full engine close/open cycle.
//
// Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/revocation-durability.test.js

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

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-revdur-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()

  const scope = new LifecycleScope('revdur-' + tag)
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
    emit () {},
    isUnlocked: () => true
  }

  const engine = new SyncEngine(ctx)
  await engine.open()
  return { dir, store, swarm, scope, ctx, engine, device, tag }
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

async function openNote (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  const env = await engine.view.getNoteSealed(obid)
  if (!env) return null
  try { return engine.view.openRecord({ objectId: objId, envelope: env }) } catch (_) { return null }
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

// ---------------------------------------------------------------------------
// B4: the reconciler re-appends under the ORIGINAL epoch, not the active one.
// ---------------------------------------------------------------------------
test('B4: durability re-append is EPOCH-FAITHFUL (original tag + original keyId, never the active epoch)', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revdur-b4'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 61 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 62, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 63, autobaseKey: baseKey })
  t.teardown(() => teardown([A, B, C], testnet))

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  await joinShared([A, B, C], vaultKey)
  const settled = await pumpUntil([A.engine, B.engine, C.engine], async () =>
    B.engine.base.writable && [A.engine, B.engine].every((e) => e.devices.size === 3), { timeoutMs: 120000 })
  t.ok(settled, 'A+B+C converged')

  // n0 authored at EPOCH 0; then rotate (revoke C); then n1 at epoch 1.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-epoch0', createdAt: 1, updatedAt: 1 })
  const rot = await revoke(A.engine, C.device.deviceId)
  const tag1 = rot.epochTag
  await pumpUntil([A.engine, B.engine], async () =>
    A.engine.activeEpochTag === tag1 && B.engine.epochKeys.has(tag1), { timeoutMs: 90000 })
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'n1-epoch1', createdAt: 2, updatedAt: 2 })
  await pumpUntil([A.engine, B.engine], async () =>
    (await openNote(B.engine, 'note:n0')) && (await openNote(B.engine, 'note:n1')), { timeoutMs: 90000 })

  // The pending-durable entries recorded each op's ORIGINAL epoch identity.
  const obid0 = crypto.blindId(indexKey, 'note:n0')
  const obid1 = crypto.blindId(indexKey, 'note:n1')
  const rec0 = A.engine._pendingDurable.get(obid0)
  const rec1 = A.engine._pendingDurable.get(obid1)
  t.ok(rec0 && rec0.epochTag === '', 'n0\'s pending entry carries its ORIGINAL epoch identity (epoch 0)')
  t.ok(rec1 && rec1.epochTag === tag1, 'n1\'s pending entry carries its ORIGINAL epoch identity (epoch 1)')

  // Force a re-append: pretend both rows were rolled back by a migration.
  // (Stubbed presence — restored below; _lastWriterAddedAt cleared so the
  // §3.9-step-4 suppression window does not defer the old-epoch entry.)
  const captured = []
  const origAppend = A.engine._append.bind(A.engine)
  const origPresent = A.engine._rowPresentFor.bind(A.engine)
  A.engine._append = (op) => { captured.push(op); return origAppend(op) }
  A.engine._rowPresentFor = async () => false
  A.engine._lastWriterAddedAt = 0
  await A.engine._reconcileDurability()
  A.engine._append = origAppend
  A.engine._rowPresentFor = origPresent

  const re0 = captured.find((op) => op.header.objectBlindId === obid0 && op.header.type === ops.OP_TYPES.NOTE_UPSERT)
  const re1 = captured.find((op) => op.header.objectBlindId === obid1 && op.header.type === ops.OP_TYPES.NOTE_UPSERT)
  t.ok(re0, 'reconciler re-appended the rolled-back epoch-0 row')
  t.ok(re1, 'reconciler re-appended the rolled-back epoch-1 row')

  // THE B4 ASSERTIONS: original epoch, original keyId — never the active tag.
  t.is(re0.header.epochTag, '', 'B4: epoch-0 row re-sealed under its ORIGINAL epoch (tag ""), not the active epoch')
  t.is(re0.header.epoch, '0', 'B4: ...with the original integer epoch in the header')
  t.is(re0.envelope.keyId, crypto.keyIdFor('', 'opbody:' + obid0),
    'B4: re-appended epoch-0 row keeps the ORIGINAL keyId (no cross-epoch linkage manufactured)')
  t.not(re0.envelope.keyId, crypto.keyIdFor(tag1, 'opbody:' + obid0), 'B4: ...and NOT the active-epoch keyId')
  t.is(re1.header.epochTag, tag1, 'an epoch-1 row re-seals under epoch 1 (faithful, not blanket epoch-0)')

  // The faithfully re-sealed rows still open on the survivor (it holds every
  // key), proving faithful re-append loses nothing.
  const reconverged = await pumpUntil([A.engine, B.engine], async () => {
    const a = await openNote(B.engine, 'note:n0')
    const b = await openNote(B.engine, 'note:n1')
    return a && a.body === 'n0-epoch0' && b && b.body === 'n1-epoch1'
  }, { timeoutMs: 60000 })
  t.ok(reconverged, 'survivor still reads both rows after the epoch-faithful re-appends')
})

// ---------------------------------------------------------------------------
// B9: a cross-device delete is durable — no reconciler resurrection, stale
// replays die, a genuinely newer re-create supersedes.
// ---------------------------------------------------------------------------
test('B9: durable tombstones — cross-device delete is not resurrected; newer re-create supersedes', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revdur-b9'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 71 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 72, autobaseKey: baseKey })
  t.teardown(() => teardown([A, B], testnet))

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await joinShared([A, B], vaultKey)
  const settled = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && A.engine.devices.size === 2 && B.engine.devices.size === 2, { timeoutMs: 120000 })
  t.ok(settled, 'A+B converged')

  // B AUTHORS the note (so B's reconciler owns its durability entry), then A
  // hard-deletes it — the exact cross-device resurrection shape of B9.
  await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:doomed',
    { noteId: 'doomed', label: 'd', body: 'delete-me', createdAt: 1, updatedAt: 1 })
  const obid = crypto.blindId(indexKey, 'note:doomed')
  const present = await pumpUntil([A.engine, B.engine], async () =>
    (await openNote(A.engine, 'note:doomed')) && (await openNote(B.engine, 'note:doomed')))
  t.ok(present, 'B\'s note converged onto A')
  t.ok(B.engine._pendingDurable.has(obid), 'B\'s reconciler owns the durability entry for its note')

  await A.engine.appendOp(ops.OP_TYPES.NOTE_DELETE, ops.SCHEMAS.NOTE, 'note:doomed',
    { noteId: 'doomed', hard: true })
  const deleted = await pumpUntil([A.engine, B.engine], async () =>
    !(await openNote(A.engine, 'note:doomed')) && !(await openNote(B.engine, 'note:doomed')) &&
    (await B.engine.view.getTombstone(obid)) !== null)
  t.ok(deleted, 'A\'s hard delete converged: row gone on both, sealed tombstone committed on B')
  t.ok(await A.engine.view.isTombstoned(obid), 'tombstone committed on A too')

  // THE B9 ASSERTION: B's reconciler — whose row is now MISSING — must NOT
  // re-append it. Drive many reconcile passes with the suppression window
  // cleared; capture every append.
  const captured = []
  const origAppend = B.engine._append.bind(B.engine)
  B.engine._append = (op) => { captured.push(op); return origAppend(op) }
  B.engine._lastWriterAddedAt = 0
  for (let i = 0; i < 8; i++) {
    await B.engine._reconcileDurability()
    await convergeStep([A.engine, B.engine])
    await sleep(150)
  }
  B.engine._append = origAppend
  t.absent(captured.some((op) => op.header.objectBlindId === obid),
    'B9: B\'s reconciler never re-appended the row A deleted (tombstone = settled)')
  t.absent(await openNote(A.engine, 'note:doomed'), 'the deleted note stayed deleted on A')
  t.absent(await openNote(B.engine, 'note:doomed'), '...and on B')

  // A genuinely NEWER user re-create (fresh Lamport beats the tombstone) wins
  // and supersedes the marker — deletes stay durable, re-creates stay possible.
  await B.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:doomed',
    { noteId: 'doomed', label: 'd2', body: 'recreated', createdAt: 2, updatedAt: 2 })
  const recreated = await pumpUntil([A.engine, B.engine], async () => {
    const a = await openNote(A.engine, 'note:doomed')
    return a && a.body === 'recreated' && !(await A.engine.view.isTombstoned(obid))
  }, { timeoutMs: 60000 })
  t.ok(recreated, 'a NEWER re-create beats + supersedes the tombstone (marker removed, row lives)')
})

// ---------------------------------------------------------------------------
// Reopen rebuild: epoch state is a pure function of the committed view across
// a full engine close/open cycle (B11-adjacent regression).
// ---------------------------------------------------------------------------
test('reopen: rotation epoch state rebuilds identically from the committed view', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revdur-reopen'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 81 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 82, autobaseKey: baseKey })
  t.teardown(() => teardown([A, B], testnet))

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await joinShared([A, B], vaultKey)
  await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && A.engine.devices.size === 2, { timeoutMs: 120000 })

  const rot = await revoke(A.engine, B.device.deviceId)
  const tag1 = rot.epochTag
  await pumpUntil([A.engine], async () => A.engine.activeEpochTag === tag1, { timeoutMs: 60000 })
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'post-rotation', createdAt: 1, updatedAt: 1 })
  await pumpUntil([A.engine], async () => !!(await openNote(A.engine, 'note:n1')), { timeoutMs: 60000 })

  // Full close + reopen (a lock/unlock cycle): all epoch state must rebuild
  // from the committed view (vault-state + this device's epochkeys! wraps).
  await A.engine.close()
  t.is(A.engine.activeEpochTag, '', 'close() wiped the in-memory epoch state')
  await A.engine.open()
  const rebuilt = await pumpUntil([A.engine], async () =>
    A.engine.activeEpochTag === tag1 && A.engine.epochKeys.has(tag1), { timeoutMs: 60000 })
  t.ok(rebuilt, 'reopen rebuilt activeEpochTag + unwrapped epochKey_1 from the committed view')
  const n1 = await openNote(A.engine, 'note:n1')
  t.is(n1 && n1.body, 'post-rotation', 'post-rotation content still opens after the rebuild')
  t.ok(A.engine.epochKeys.has(''), 'the epoch-0 vaultKey anchor is re-established')
})
