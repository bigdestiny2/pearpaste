// Integration: RAW-OP RE-MATERIALIZATION (OFFLINE-WINDOW INVISIBLE-CONTENT
// fix). A device that applies post-rotation content ops BEFORE holding the
// rotation's epoch key persists them raw (sealed op envelope) — and autobase
// never re-applies them once indexed, so without the re-materializer the
// content stays invisible on that device FOREVER (verified: a cold reopen that
// fully recovers the epoch key from the committed wraps still cannot read the
// row). These tests pin the heal paths:
//
//   (1) IN-SESSION: raw note + clip + pending delete all become
//       readable/applied once the key arrives, and the local search index is
//       back-filled.
//   (2) COLD REOPEN: pending raw ops recorded in a previous session heal on
//       reopen with NO peer online (the open()-time nudge forces the pass).
//   (3) DOWNGRADE GUARD: a key-less re-apply of an op must NOT clobber a row
//       an earlier key-holding pass already sealed readable; the pending op
//       still upgrades the row once the key returns (LWW-correct).
//
// Determinism: instead of racing real catch-up timing, B's box SECRET key is
// withheld (ctx.state.device.boxSecretKey = null) so the KEY_ROTATE lockbox
// unwrap fails exactly like a not-yet-caught-up device, then restored to model
// "the key arrives". Replication is direct Corestore streams — no swarm/DHT.
//
// Run (sandbox OFF — Corestore binds): node test/integration/revocation-remat.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import autobaseSync from '../../backend/autobase-sync.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import * as identity from '../../backend/identity.js'

const { SyncEngine } = autobaseSync

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-remat-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// PP_TEST_DIAG=1 surfaces engine warn/debug lines (normally swallowed) — the
// re-materializer logs dispatch failures there.
const DIAG = !!process.env.PP_TEST_DIAG
const dlog = (tag) => (msg, meta) => { if (DIAG) process.stderr.write('[' + tag + '] ' + msg + ' ' + JSON.stringify(meta || {}) + '\n') }

function makeCtx ({ store, device, vaultKey, indexKey, vaultId, headerCache }) {
  return {
    crypto,
    ops,
    identity,
    log: { debug: dlog('dbg:' + device.label), info () {}, warn: dlog('WARN:' + device.label), error: dlog('ERR:' + device.label) },
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
    on () {},
    emit () {},
    isUnlocked: () => true
  }
}

async function makeDevice ({ tag, vaultKey, indexKey, vaultId, seedByte, autobaseKey }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()
  const device = identity.createDeviceIdentity({
    label: tag, platform: 'test', seed: b4a.alloc(32, seedByte)
  })
  const headerCache = autobaseKey ? { autobaseKey } : {}
  const ctx = makeCtx({ store, device, vaultKey, indexKey, vaultId, headerCache })
  const engine = new SyncEngine(ctx)
  await engine.open()
  return { dir, store, ctx, engine, device, tag, seedByte }
}

// Direct two-way Corestore replication (what the swarm 'connection' handler
// does, minus the network). Returns a stop() that tears the pipes down.
function replicate (a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.on('error', () => {})
  s2.on('error', () => {})
  s1.pipe(s2).pipe(s1)
  return () => { try { s1.destroy() } catch (_) {} try { s2.destroy() } catch (_) {} }
}

async function pumpUntil (engines, pred, { timeoutMs = 60000, every = 150 } = {}) {
  const deadline = Date.now() + timeoutMs
  let val = false
  while (Date.now() < deadline) {
    for (const e of engines) {
      try { await e.refresh() } catch (_) {}
      try { await e._reconcileDurability() } catch (_) {}
    }
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

async function openClipAnyBucket (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  for (const row of await engine.view.scanClips()) {
    if (row.objectBlindId !== obid) continue
    try { return engine.view.openRecord({ objectId: objId, envelope: row.envelope }) } catch (_) { return null }
  }
  return null
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

async function teardown (devices, stops = []) {
  for (const stop of stops) { try { stop() } catch (_) {} }
  for (const d of devices) {
    try { await d.engine.close() } catch (_) {}
    try { await d.store.close() } catch (_) {}
    try { fs.rmSync(d.dir, { recursive: true, force: true }) } catch (_) {}
  }
}

// Shared arrangement for tests 1+2: A (admin) + B (survivor whose box secret
// is WITHHELD so it cannot unwrap the rotation) + C (revocation target, never
// replicated). A revokes C, then writes a post-rotation note n1 + clip c1 and
// DELETES the pre-rotation note n0 — all of which B applies key-less (raw).
async function arrangeRawWindow (t) {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revnet-remat'

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, seedByte: 31 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, seedByte: 32, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, seedByte: 33, autobaseKey: baseKey })

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  const stopAB = replicate(A, B)

  const joined = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && B.engine.devices.size === 3 && A.engine.devices.size === 3)
  t.ok(joined, 'A+B converged on the 3-device set (C authorized but offline)')

  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-pre-rotation', createdAt: 1, updatedAt: 1 })
  const n0OnB = await pumpUntil([A.engine, B.engine], async () => openNote(B.engine, 'note:n0'))
  t.ok(n0OnB, 'pre-rotation n0 readable on B')

  // WITHHOLD B's box secret: every KEY_ROTATE lockbox unwrap on B now fails,
  // exactly like a device that has not yet caught the wrap rows up.
  const bBoxSecret = B.ctx.state.device.boxSecretKey
  B.ctx.state.device.boxSecretKey = null

  const rot = await revoke(A.engine, C.device.deviceId)
  const epochTag1 = rot.epochTag

  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'remat needle body', createdAt: 2, updatedAt: 2 })
  await A.engine.appendOp(ops.OP_TYPES.CLIP_ADD, ops.SCHEMAS.CLIP, 'clip:c1',
    { clipId: 'c1', kind: 'text', body: 'clip needle secret' })
  await A.engine.appendOp(ops.OP_TYPES.NOTE_DELETE, ops.SCHEMAS.NOTE, 'note:n0', { noteId: 'n0' })

  // B applies everything KEY-LESS: n1/c1 land raw, the n0 delete stays pending.
  const rawOnB = await pumpUntil([A.engine, B.engine], async () =>
    (await noteEnvelope(B.engine, 'note:n1')) &&
    !(await openNote(B.engine, 'note:n1')) &&
    !B.engine.epochKeys.has(epochTag1) &&
    (await B.engine._listRawPendingOps()).length >= 3)
  t.ok(rawOnB, 'B holds n1 RAW (sealed envelope present, unreadable), no epochKey_1, >=3 pending raw ops')
  t.ok(await openNote(B.engine, 'note:n0'), 'the n0 DELETE could not apply key-less — n0 still visible on B')
  t.absent(await openClipAnyBucket(B.engine, 'clip:c1'), 'clip c1 unreadable on B while key-less')
  t.is((await B.engine.localSearch.search('needle')).length, 0, 'raw n1 absent from local search while key-less')

  return { vaultKey, indexKey, vaultId, A, B, C, baseKey, epochTag1, bBoxSecret, stopAB }
}

test('re-materialize: raw note/clip/delete heal IN-SESSION once the epoch key arrives', { timeout: 240000 }, async (t) => {
  const s = await arrangeRawWindow(t)
  const { A, B, C, epochTag1, bBoxSecret, stopAB } = s
  t.teardown(() => teardown([A, B, C], [stopAB]))

  // ---- the key "arrives": restore the box secret ---------------------------
  B.ctx.state.device.boxSecretKey = bBoxSecret
  // Generate one organic op so a normal apply pass (rebuild -> unwrap -> remat
  // sweep) runs on B without waiting for the idle nudge.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n2',
    { noteId: 'n2', label: 'n2', body: 'n2-post-restore', createdAt: 3, updatedAt: 3 })

  const healed = await pumpUntil([A.engine, B.engine], async () => {
    const n1 = await openNote(B.engine, 'note:n1')
    return n1 && n1.body === 'remat needle body'
  })
  t.ok(healed, 'raw n1 re-materialized READABLE on B once epochKey_1 was unwrapped')
  t.ok(B.engine.epochKeys.has(epochTag1), 'B recovered epochKey_1 from the committed wraps')

  const clip = await pumpUntil([A.engine, B.engine], async () => openClipAnyBucket(B.engine, 'clip:c1'))
  t.ok(clip && clip.body === 'clip needle secret', 'raw clip c1 re-materialized readable on B')

  // Soft-delete semantics: the row survives with `deletedAt` set; the durable
  // tombstone row is the cross-device marker.
  const n0Gone = await pumpUntil([A.engine, B.engine], async () => {
    const n0 = await openNote(B.engine, 'note:n0')
    return (n0 == null || n0.deletedAt != null) &&
      (await B.engine.view.isTombstoned(crypto.blindId(B.engine.indexKey, 'note:n0')))
  })
  t.ok(n0Gone, 'the pending n0 DELETE applied: soft-deleted + durable tombstone on B')

  const hits = await B.engine.localSearch.search('needle')
  t.ok(hits.some((r) => r.objectBlindId === crypto.blindId(B.engine.indexKey, 'note:n1')),
    'local search back-filled for the re-materialized n1')

  const drained = await pumpUntil([A.engine, B.engine], async () =>
    (await B.engine._listRawPendingOps()).length === 0)
  t.ok(drained, 'pending raw-op records drained after re-materialization')
})

test('re-materialize: raw rows heal across a COLD REOPEN with no peer online', { timeout: 240000 }, async (t) => {
  const s = await arrangeRawWindow(t)
  const { vaultKey, indexKey, vaultId, A, B, C, baseKey, epochTag1, stopAB } = s

  // Close B mid-window (still key-less, rows raw) — model an app shutdown.
  stopAB()
  await B.engine.close()
  await B.store.close()

  // Cold reopen from the SAME on-disk store, with FULL key material (the
  // device identity is seed-derived, so its box secret is back). No
  // replication is wired: the heal must come purely from local state.
  const store2 = new Corestore(B.dir)
  await store2.ready()
  const device2 = identity.createDeviceIdentity({ label: 'B', platform: 'test', seed: b4a.alloc(32, B.seedByte) })
  const ctx2 = makeCtx({
    store: store2, device: device2, vaultKey, indexKey, vaultId, headerCache: { autobaseKey: baseKey }
  })
  const B2 = { dir: B.dir, store: store2, ctx: ctx2, engine: new SyncEngine(ctx2), device: device2, tag: 'B2' }
  t.teardown(() => teardown([A, B2, C], []))
  await B2.engine.open()

  const healed = await pumpUntil([B2.engine], async () => {
    const n1 = await openNote(B2.engine, 'note:n1')
    return n1 && n1.body === 'remat needle body'
  }, { timeoutMs: 30000 })
  t.ok(healed, 'raw n1 readable after cold reopen — no peer needed (open-time nudge + committed wraps)')
  t.ok(B2.engine.epochKeys.has(epochTag1), 'reopened B recovered epochKey_1')
  const clip = await openClipAnyBucket(B2.engine, 'clip:c1')
  t.ok(clip && clip.body === 'clip needle secret', 'raw clip readable after cold reopen')
  const n0Gone = await pumpUntil([B2.engine], async () => {
    const n0 = await openNote(B2.engine, 'note:n0')
    return (n0 == null || n0.deletedAt != null) &&
      (await B2.engine.view.isTombstoned(crypto.blindId(B2.engine.indexKey, 'note:n0')))
  }, { timeoutMs: 30000 })
  t.ok(n0Gone, 'pending n0 DELETE applied after cold reopen (soft-deleted + tombstone)')
  const hits = await B2.engine.localSearch.search('needle')
  t.ok(hits.some((r) => r.objectBlindId === crypto.blindId(B2.engine.indexKey, 'note:n1')),
    'local search back-filled after cold reopen')
})

test('downgrade guard: a key-less re-apply never clobbers a readable row; the pending newer op still wins', { timeout: 240000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revnet-remat-guard'

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, seedByte: 41 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, seedByte: 42, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, seedByte: 43, autobaseKey: baseKey })

  // Authorize BEFORE replicating (matching the real pairing flow and the
  // arrange above) — replicating first stalls B's writer-seat convergence.
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  const stopAB = replicate(A, B)
  t.teardown(() => teardown([A, B, C], [stopAB]))
  const joined = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && B.engine.devices.size === 3 && A.engine.devices.size === 3)
  t.ok(joined, 'A+B converged on the 3-device set')

  // B keeps FULL key material this time: it applies the rotation + n1 normally.
  const rot = await revoke(A.engine, C.device.deviceId)
  const epochTag1 = rot.epochTag
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'v1-readable', createdAt: 2, updatedAt: 2 })
  const v1 = await pumpUntil([A.engine, B.engine], async () => {
    const n = await openNote(B.engine, 'note:n1')
    return n && n.body === 'v1-readable' && B.engine.epochKeys.has(epochTag1)
  })
  t.ok(v1, 'baseline: B holds epochKey_1 and reads n1 (v1)')

  // Mint a NEWER epoch-1 upsert of n1 on A (not appended to the log) and feed
  // it to B's reducer in a simulated KEY-ABSENT pass (the truncated-snapshot
  // rebuild the testnet runs exposed). The fake batch records what the
  // reducer WOULD have written to the view.
  const opX = A.engine._makeOp({
    type: ops.OP_TYPES.NOTE_UPSERT,
    schema: ops.SCHEMAS.NOTE,
    objectId: 'note:n1',
    payload: { noteId: 'n1', label: 'n1', body: 'v2-newer', createdAt: 2, updatedAt: 9 },
    signer: A.engine._localSigner()
  })
  B.engine.epochKeys.delete(epochTag1) // simulate the key-absent rebuild snapshot
  const fakeBatch = { puts: [], put (k, v) { this.puts.push(k) }, del () {} }
  await B.engine._applyNoteUpsert(opX, fakeBatch)
  const n1Key = B.engine.view.notesKey(crypto.blindId(B.engine.indexKey, 'note:n1'))
  t.absent(fakeBatch.puts.includes(n1Key),
    'GUARD: the key-less re-apply did NOT write the raw envelope over the readable row')
  const still = await openNote(B.engine, 'note:n1')
  t.is(still && still.body, 'v1-readable', 'the readable v1 row is untouched')

  // The op was recorded pending; once the key is back (the very next rebuild
  // recovers it from committed wraps), the re-materializer dispatches it and
  // v2 wins LWW over v1.
  t.ok((await B.engine._listRawPendingOps()).length >= 1, 'the newer op is pending re-materialization')
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n2',
    { noteId: 'n2', label: 'n2', body: 'n2-traffic', createdAt: 3, updatedAt: 3 })
  const v2 = await pumpUntil([A.engine, B.engine], async () => {
    const n = await openNote(B.engine, 'note:n1')
    return n && n.body === 'v2-newer'
  })
  if (!v2) {
    const pend = await B.engine._listRawPendingOps()
    t.comment('v2-diag ' + JSON.stringify({
      pending: pend.map((r) => ({ type: r.value && r.value.header && r.value.header.type, tag: r.value && r.value.header && String(r.value.header.epochTag || '').slice(0, 6) })),
      hasKey: B.engine.epochKeys.has(epochTag1),
      flag: B.engine._rawOpsMaybePending,
      note: await openNote(B.engine, 'note:n1')
    }))
  }
  t.ok(v2, 'pending NEWER op re-materialized and superseded v1 (LWW preserved)')
})
