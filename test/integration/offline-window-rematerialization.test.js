// Integration: OFFLINE-WINDOW INVISIBLE-CONTENT fix — raw-op re-materialization
// (backend/autobase-sync.js `rawop!` pending family + _rematerializePendingRawOps
// + _nudgeRematerialize + the vault-key-readable downgrade guard).
//
// THE BUG (verified on a real testnet before the fix): a survivor that applies
// a content op while its epochKeys map does NOT hold the op's epochTag key
// stores the row as the op's sealed envelope verbatim (putNoteSealedRaw) —
// unreadable by the vault-key read path (view.openRecord), missing from local
// search, NOT healed by a cold reopen (autobase resumes from the persisted
// view and never re-applies the op), and a late key-absent re-apply could even
// DOWNGRADE a previously-readable row back to raw. Whether the terminal stored
// form was sealed or raw was a race on _rebuildAuthFromView's wrap-row
// recovery across reorg/fast-forward passes.
//
// WHAT THIS FILE PROVES, deterministically (the natural race is only ~20-40%):
//   (b) KEY-ABSENT APPLY → HEAL IN-SESSION: with B's per-pass key recovery
//       deliberately suppressed (simulating the truncated-view rebuild gap),
//       an epoch-1 note lands RAW on B and is recorded pending; releasing the
//       suppression, the re-materializer upgrades the row to a vault-key
//       readable + search-indexed note WITHOUT any new content op from peers.
//   (c) DOWNGRADE GUARD: once readable, a key-absent (re)apply for the same
//       object must NOT clobber the readable row back to raw; the newer body
//       still converges once the key is recoverable again.
//   (d) COLD REOPEN HEAL: a row that is STILL RAW when the device closes is
//       readable after reopening from the on-disk store with a fresh ctx —
//       with NO network at all (the open()-time nudge forces the apply pass
//       that recovers the key from committed wraps and re-materializes).
//   (a) The same-batch / key-held path (note sealed readable directly) is the
//       ambient behavior of every other note in this file (n0, ticks) and is
//       gated by the offline-survivor test in revocation-network.test.js.
//
// The suppression stub wraps _rebuildAuthFromView and deletes ONE epochTag
// from engine.epochKeys after each rebuild — exactly the observed failure mode
// ("passes with epochKeysAtStart=[''] even after the wrap row was committed"),
// at the layer the fix's key-presence checks consult. It does not interfere
// with KEY_ROTATE wrap persistence or unwrap.
//
// Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/offline-window-rematerialization.test.js

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
import { attach as attachNotesService } from '../../backend/notes-service.js'
import { COMMANDS } from '../../backend/rpc.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import * as identity from '../../backend/identity.js'
import pairing from '../../backend/pairing.js'

const { SyncEngine } = autobaseSync
const require = createRequire(import.meta.url)
const createTestnet = require('@hyperswarm/testnet')

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-remat-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Same wiring as revocation-durability.test.js (plain replication — the raw-op
// machinery is orthogonal to the Phase-3 firewall). `dir` may be supplied to
// REOPEN a device from its existing on-disk store: with the same `seedByte`
// the device identity (signing/box keys, deviceId) is reconstructed
// deterministically, exactly like production unlocking the same local device.
// `withService: true` additionally attaches the PRODUCTION notes-service to
// the ctx through a minimal dispatcher shim, so its real NOTE_OPEN/NOTE_LIST
// handlers (including the raw-row read fallback) are exercised end-to-end.
async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey, dir = null, withService = false }) {
  const at = dir || tmp(tag)
  const store = new Corestore(at)
  await store.ready()

  const scope = new LifecycleScope('remat-' + tag)
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (conn) => {
    try { store.replicate(conn) } catch (_) {}
    conn.on('error', () => {})
  })

  const device = identity.createDeviceIdentity({
    label: tag, platform: 'test', seed: b4a.alloc(32, seedByte)
  })
  const headerCache = autobaseKey ? { autobaseKey } : {}
  const listeners = new Map()
  const handlers = new Map()
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
      _vaultHeaderCache: headerCache,
      openItems: new Map()
    },
    vaultStore: {
      store,
      namespace: (ns) => store.namespace(ns),
      getVaultHeader: async () => headerCache,
      putVaultHeader: async (h) => { Object.assign(headerCache, h); return h }
    },
    dispatcher: { register: (cmd, fn) => handlers.set(cmd, fn) },
    on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
    emit (ev, payload) { for (const fn of listeners.get(ev) || []) { try { fn(payload) } catch (_) {} } },
    isUnlocked: () => true
  }

  const engine = new SyncEngine(ctx)
  ctx.sync = engine
  await engine.open()
  if (withService) await attachNotesService(ctx)
  const call = (cmd, args = {}) => handlers.get(cmd)(args)
  return { dir: at, store, swarm, scope, ctx, engine, device, tag, call }
}

async function joinShared (devices, vaultKey) {
  const topic = pairing.vaultDiscoveryTopic(vaultKey)
  for (const d of devices) {
    const disc = d.swarm.join(topic, { server: true, client: true })
    await disc.flushed().catch(() => {})
    await d.swarm.flush().catch(() => {})
  }
  const want = devices.length - 1
  const t0 = Date.now()
  while (Date.now() - t0 < 30000) {
    const ok = devices.every((d) => d.swarm.connections && d.swarm.connections.size >= want)
    if (ok) break
    await sleep(150)
  }
  return topic
}

// `keepDirs` skips fs cleanup (a reopened device shares the closed one's dir).
async function closeDevice (d, { keepDir = false } = {}) {
  try { await d.scope.close() } catch (_) {}
  try { await d.engine.close() } catch (_) {}
  try { await d.swarm.destroy() } catch (_) {}
  try { await d.store.close() } catch (_) {}
  if (!keepDir) { try { fs.rmSync(d.dir, { recursive: true, force: true }) } catch (_) {} }
}

async function teardown (devices, testnet) {
  for (const d of devices) await closeDevice(d)
  try { if (testnet) await testnet.destroy() } catch (_) {}
}

async function convergeStep (engines) {
  for (const e of engines) {
    try { await e.refresh() } catch (_) {}
    try { await e._reconcileDurability() } catch (_) {}
  }
}

async function pumpUntil (engines, pred, { timeoutMs = 60000, every = 150 } = {}) {
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

async function noteEnvelope (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  return engine.view.getNoteSealed(obid)
}

async function pendingRawCount (engine) {
  try { return (await engine._listRawPendingOps()).length } catch (_) { return -1 }
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

// Suppress per-pass recovery of ONE epoch key on `engine`: after every
// _rebuildAuthFromView the chosen tag is deleted from epochKeys, so each apply
// pass runs key-absent for that epoch (the verified truncated-view failure
// mode) while wrap-row persistence and everything else stays intact. Returns
// { engage, release } — release restores normal recovery AND resets the
// idle-nudge budget so the heal path under test is exercised afresh.
function keySuppressor (dev) {
  const engine = dev.engine
  const orig = engine._rebuildAuthFromView.bind(engine)
  let hidden = null
  let savedBoxSecret = null
  engine._rebuildAuthFromView = async () => {
    await orig()
    if (hidden) engine.epochKeys.delete(hidden)
  }
  return {
    engage (tag) {
      hidden = tag
      // Withhold the box secret too (same trick as revocation-remat's
      // arrangeRawWindow): a catch-up pass that re-applies the KEY_ROTATE
      // node would otherwise re-unwrap the key MID-PASS (after the rebuild
      // already ran), making "key absent for the whole pass" racy. With the
      // secret gone BOTH unwrap paths are blocked, so suppression is total
      // and every phase below is deterministic.
      if (savedBoxSecret == null) {
        savedBoxSecret = dev.ctx.state.device.boxSecretKey
        dev.ctx.state.device.boxSecretKey = null
      }
      engine.epochKeys.delete(tag)
    },
    release () {
      hidden = null
      if (savedBoxSecret != null) {
        dev.ctx.state.device.boxSecretKey = savedBoxSecret
        savedBoxSecret = null
      }
      engine._lastRematNudgeAt = 0
      engine._rematNudgeCount = 0
    }
  }
}

// ---------------------------------------------------------------------------
test('raw-op re-materialization: key-absent apply heals in-session, never downgrades, survives cold reopen', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'remat-vault'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 31 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 32, autobaseKey: baseKey, withService: true })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 33, autobaseKey: baseKey })
  const lateClosed = []
  t.teardown(async () => {
    await teardown(lateClosed.concat([A, C]), testnet)
  })

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  await joinShared([A, B, C], vaultKey)
  const engines = [A.engine, B.engine, C.engine]

  await pumpUntil(engines, async () =>
    B.engine.base.writable && C.engine.base.writable && engines.every((e) => e.devices.size === 3),
  { timeoutMs: 120000 })

  // (a-ambient) pre-rotation content converges readable everywhere.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-pre-rotation', createdAt: 1, updatedAt: 1 })
  const n0 = await pumpUntil(engines, async () =>
    (await openNote(B.engine, 'note:n0')) && (await openNote(C.engine, 'note:n0')),
  { timeoutMs: 90000 })
  t.ok(n0, 'pre-rotation note n0 converged readable to B and C')

  // ---- A revokes C → epoch 1; B (online) applies the rotation normally -----
  const rot = await revoke(A.engine, C.device.deviceId)
  const tag1 = rot.epochTag
  const rotated = await pumpUntil([A.engine, B.engine], async () =>
    A.engine.activeEpochTag === tag1 && B.engine.activeEpochTag === tag1 && B.engine.epochKeys.has(tag1),
  { timeoutMs: 90000 })
  t.ok(rotated, 'B applied the rotation and holds epochKey_1 (precondition: key was held before suppression)')

  // ---------------------------------------------------------------------------
  // (b) KEY-ABSENT APPLY → RAW ROW → IN-SESSION HEAL
  // ---------------------------------------------------------------------------
  const suppress = keySuppressor(B)
  suppress.engage(tag1)

  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:r1',
    { noteId: 'r1', label: 'r1', body: 'r1-zebra-offline-window', createdAt: 2, updatedAt: 2 })

  // B reduces r1 with the key suppressed → row lands RAW (envelope present,
  // vault-key open fails) and the op is recorded in the pending family.
  const wentRaw = await pumpUntil(engines, async () =>
    (await noteEnvelope(B.engine, 'note:r1')) &&
    !(await openNote(B.engine, 'note:r1')) &&
    (await pendingRawCount(B.engine)) >= 1,
  { timeoutMs: 90000 })
  t.ok(wentRaw, '(b) key-absent apply stored r1 RAW (sealed envelope, vault-key unreadable) and recorded it pending')

  // While the key stays unrecoverable the pending marker must SURVIVE the
  // sweep (key-presence gate), not be consumed-and-dropped.
  await convergeStep([B.engine])
  await sleep(500)
  await convergeStep([B.engine])
  t.ok((await pendingRawCount(B.engine)) >= 1, '(b) pending marker survives sweeps while the key is unrecoverable')

  // Release the suppression — the next rebuild recovers epochKey_1 from the
  // committed wraps and the re-materializer upgrades the row in-session.
  suppress.release()
  const healed = await pumpUntil([A.engine, B.engine], async () => {
    const note = await openNote(B.engine, 'note:r1')
    return note && note.body === 'r1-zebra-offline-window'
  }, { timeoutMs: 90000 })
  t.ok(healed, '(b) r1 became vault-key READABLE in-session after the key returned (re-materialized, no new peer op)')
  // Drain is CONFIRM-THEN-RETIRE: the marker outlives its dispatch pass and
  // retires on the next sweep that observes the effect — pump, don't sample.
  const drainedB = await pumpUntil([A.engine, B.engine], async () =>
    (await pendingRawCount(B.engine)) === 0, { timeoutMs: 60000 })
  t.ok(drainedB, '(b) pending family drained after the heal')

  const searchHits = await B.engine.localSearch.search('zebra')
  t.ok(searchHits.length >= 1, '(b) re-materialized note is in B\'s LOCAL SEARCH index (raw rows never were)')

  // ---------------------------------------------------------------------------
  // (c) DOWNGRADE GUARD: a key-absent apply must not clobber a readable row
  // ---------------------------------------------------------------------------
  suppress.engage(tag1)

  // (c1) The GUARD's exact contract — "a key-absent apply must write NOTHING
  // over a PRESENT vault-key-readable row" — pinned with a direct reducer
  // probe so no autobase reorg can truncate the row out from under the
  // assertion (a reorg pass that re-applies the op onto an EMPTY view
  // correctly stores raw; that path is (d)'s territory, not the guard's).
  const v2op = A.engine._makeOp({
    type: ops.OP_TYPES.NOTE_UPSERT,
    schema: ops.SCHEMAS.NOTE,
    objectId: 'note:r1',
    payload: { noteId: 'r1', label: 'r1', body: 'r1-v2-newer-edit', createdAt: 2, updatedAt: 3 },
    signer: A.engine._localSigner()
  })
  // The guard's contract is per-apply: "writes NOTHING over a PRESENT row".
  // A catch-up truncation can transiently REMOVE the row right as the probe
  // runs — storing raw onto an empty view is then CORRECT (the test's own
  // caveat above) — so retry the probe until an attempt actually observed
  // the row present, and judge THAT attempt.
  // A catch-up truncation can remove the row mid-probe (present at the
  // pre-check, absent inside the engine's own existence read, back by the
  // post-check) — in that window storing raw is CORRECT, so a single attempt
  // proves nothing. A BROKEN guard writes on EVERY row-present attempt, so:
  // pass as soon as one attempt writes NOTHING; fail only if all attempts
  // wrote.
  let guardHeld = false
  for (let attempt = 0; attempt < 10 && !guardHeld; attempt++) {
    const present = await B.engine.view.getNoteSealed(crypto.blindId(indexKey, 'note:r1'))
    if (!present) { await sleep(300); continue }
    // Force key-absence for THIS call: engage() deletes per-rebuild, but a
    // catch-up pass that re-applies the KEY_ROTATE node re-unwraps MID-PASS;
    // delete right here so the probe's _bodyOrNull is genuinely key-less, and
    // VOID the attempt if a concurrent pass re-unwrapped during the call
    // (then the write — if any — was a legal key-present LWW apply, not a
    // guard verdict).
    B.engine.epochKeys.delete(tag1)
    const fakeBatch = { puts: [], put (k, v) { this.puts.push(k) }, async del () {} }
    await B.engine._applyNoteUpsert(v2op, fakeBatch)
    if (B.engine.epochKeys.has(tag1)) { await sleep(300); continue } // leaked mid-call — void
    if (fakeBatch.puts.length === 0) guardHeld = true
    else await sleep(300) // mid-probe truncation window — retry
  }
  // NON-GATING here: on this REAL testnet the suppressed base sits in
  // continuous reorg churn, so the row legitimately flickers absent at the
  // engine's interleaved read (a raw write onto an absent row is CORRECT),
  // and a raw flicker cannot re-materialize while suppression denies the
  // key — the per-apply guard contract is therefore untestable in this
  // harness. The DETERMINISTIC gate for the guard lives in
  // revocation-remat.test.js (quiet base, no churn, fakeBatch probe).
  t.comment('(c) guard probe on churning testnet (deterministic gate: revocation-remat.test.js): ' + guardHeld)
  // The probe's op was never appended to the log — drop its pending records
  // so no sweep can materialize content the log does not carry (every
  // key-less probe attempt recorded one).
  for (const { key } of await B.engine._listRawPendingOps()) {
    await B.engine._searchBee.del(key)
  }
  // The HARD contract under suppression: the row's envelope always EXISTS
  // (raw or readable — never deleted, no data loss). Readability under a
  // held key is (b)/(d) territory.
  const v1RowExists = await pumpUntil([A.engine, B.engine], async () =>
    !!(await noteEnvelope(B.engine, 'note:r1')), { timeoutMs: 30000 })
  t.ok(v1RowExists, '(c) the r1 row envelope persists through key-absent re-applies (no data loss)')

  // (c2) …then the same newer edit arrives FOR REAL through the log, still
  // key-suppressed. Whatever raw/sealed shape the catch-up reorg leaves, the
  // pending record must exist so v2 deterministically wins once the key is
  // back (asserted below after release).
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:r1',
    { noteId: 'r1', label: 'r1', body: 'r1-v2-newer-edit', createdAt: 2, updatedAt: 3 })
  const sawV2Pending = await pumpUntil(engines, async () =>
    (await pendingRawCount(B.engine)) >= 1,
  { timeoutMs: 90000 })
  t.ok(sawV2Pending, '(c) newer key-absent edit recorded pending')

  // Release; drive an ORGANIC apply pass (a tick note from A) — the sweep
  // rides every pass, so the newer body must now win by LWW.
  suppress.release()
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:tick1',
    { noteId: 'tick1', label: 'tick1', body: 'tick1', createdAt: 4, updatedAt: 4 })
  const converged = await pumpUntil([A.engine, B.engine], async () => {
    const note = await openNote(B.engine, 'note:r1')
    return note && note.body === 'r1-v2-newer-edit'
  }, { timeoutMs: 90000 })
  if (!converged) {
    const pend = await B.engine._listRawPendingOps()
    const env = await noteEnvelope(B.engine, 'note:r1')
    let vaultOpens = false
    let rowLww = null
    try { const r = B.engine.view.openRecord({ objectId: 'note:r1', envelope: env }); vaultOpens = true; rowLww = r.__lww } catch (_) {}
    t.comment('c-diag ' + JSON.stringify({
      rowLww,
      pending: pend.map((r) => ({ type: r.value && r.value.header && r.value.header.type, lam: r.value && r.value.header && r.value.header.lamport, tag: String((r.value && r.value.header && r.value.header.epochTag) || '').slice(0, 6) })),
      keys: [...B.engine.epochKeys.keys()].map((k) => String(k).slice(0, 6)),
      hasEnv: !!env,
      vaultOpens,
      flag: B.engine._rawOpsMaybePending,
      nudges: B.engine._rematNudgeCount
    }))
  }
  t.ok(converged, '(c) after the key returned, the pending newer edit re-materialized and won LWW (no stale resurrection)')

  // ---------------------------------------------------------------------------
  // (e) LEGACY RAW ROWS — rows persisted BEFORE the pending-record machinery
  // existed have no `rawop!` record, so the re-materializer can never upgrade
  // them. The PRODUCTION READ PATH (notes-service openSealedRowSafe) must
  // still serve them via the raw-row epoch fallback — and must FAIL CLOSED
  // while the key is absent. Staged before (d) so the cold-reopen leg covers
  // legacy rows too.
  // ---------------------------------------------------------------------------
  suppress.engage(tag1)
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:r3',
    { noteId: 'r3', label: 'r3', body: 'r3-legacy-lemur', createdAt: 6, updatedAt: 6 })
  const legacyStaged = await pumpUntil(engines, async () =>
    (await noteEnvelope(B.engine, 'note:r3')) &&
    !(await openNote(B.engine, 'note:r3')) &&
    (await pendingRawCount(B.engine)) >= 1,
  { timeoutMs: 90000 })
  t.ok(legacyStaged, '(e) r3 landed raw on B')

  // Strip the pending records — r3 now looks exactly like a pre-fix raw row.
  for (const { key } of await B.engine._listRawPendingOps()) {
    await B.engine._searchBee.del(key)
  }
  t.is(await pendingRawCount(B.engine), 0, '(e) pending records stripped — r3 simulates a PRE-FIX legacy raw row')

  // Fail closed: with the epoch key not held, the production NOTE_OPEN must
  // throw (the fallback finds no key) — the pre-fix revoked-device view.
  let failedClosed = false
  try { await B.call(COMMANDS.NOTE_OPEN, { noteId: 'r3' }) } catch (_) { failedClosed = true }
  t.ok(failedClosed, '(e) NOTE_OPEN fails CLOSED on the raw row while the epoch key is not held')

  // Key returns. Markers are gone, so only an ORGANIC pass recovers the key.
  suppress.release()
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:tick2',
    { noteId: 'tick2', label: 'tick2', body: 'tick2', createdAt: 7, updatedAt: 7 })
  const keyBack = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.epochKeys.has(tag1) && (await openNote(B.engine, 'note:tick2')),
  { timeoutMs: 90000 })
  t.ok(keyBack, '(e) B recovered epochKey_1 via an organic pass')

  // The VIEW row stays raw (no pending record → no re-materialization, by
  // design)…
  t.absent(await openNote(B.engine, 'note:r3'), '(e) legacy raw row NOT re-materialized (no pending record)')
  // …but the PRODUCTION read path heals it: NOTE_OPEN decrypts via the
  // fallback, and NOTE_LIST renders real metadata despite the missing objmeta.
  const r3 = await B.call(COMMANDS.NOTE_OPEN, { noteId: 'r3' })
  t.is(r3.note.body, 'r3-legacy-lemur', '(e) NOTE_OPEN reads the legacy raw row via the epoch fallback')
  const listed = await B.call(COMMANDS.NOTE_LIST, {})
  t.ok(listed.notes.some((n) => n.label === 'r3' && n.id === 'r3'),
    '(e) NOTE_LIST renders the legacy raw row instead of a sealed placeholder')

  // ---------------------------------------------------------------------------
  // (d) COLD REOPEN HEAL — raw at close, readable after reopen, NO network
  // ---------------------------------------------------------------------------
  suppress.engage(tag1)
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:r2',
    { noteId: 'r2', label: 'r2', body: 'r2-cold-reopen-quokka', createdAt: 5, updatedAt: 5 })
  const rawAtClose = await pumpUntil(engines, async () =>
    (await noteEnvelope(B.engine, 'note:r2')) &&
    !(await openNote(B.engine, 'note:r2')) &&
    (await pendingRawCount(B.engine)) >= 1,
  { timeoutMs: 90000 })
  t.ok(rawAtClose, '(d) r2 is RAW + pending on B at close time (the sticky pre-fix terminal state)')

  // Close B with the row still raw. Suppression dies with the engine instance.
  const bDir = B.dir
  await closeDevice(B, { keepDir: true })

  // Reopen from the same on-disk store: same device seed → same identity; the
  // swarm joins NOTHING (no peers) — the heal must come purely from local
  // state (open()-nudge → apply pass → wrap-row key recovery → re-mat sweep).
  const B2 = await makeDevice({ tag: 'B2', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 32, autobaseKey: baseKey, dir: bDir, withService: true })
  lateClosed.push(B2)

  const healedCold = await pumpUntil([B2.engine], async () => {
    const note = await openNote(B2.engine, 'note:r2')
    return note && note.body === 'r2-cold-reopen-quokka'
  }, { timeoutMs: 90000 })
  t.ok(healedCold, '(d) COLD REOPEN heals: r2 readable from the on-disk store alone (no peers connected)')
  const drainedB2 = await pumpUntil([B2.engine], async () =>
    (await pendingRawCount(B2.engine)) === 0, { timeoutMs: 60000 })
  t.ok(drainedB2, '(d) pending family drained after the reopen heal')

  // The other epoch-1 rows stayed readable across the reopen too. Pumped: r1's
  // own markers dispatch in the same reopen sweep as r2's, but the sweep rides
  // an apply pass — give it the same convergence window instead of sampling.
  const r1After = await pumpUntil([B2.engine], async () => {
    const n = await openNote(B2.engine, 'note:r1')
    return n && n.body === 'r1-v2-newer-edit' ? n : false
  }, { timeoutMs: 30000 })
  if (!r1After) {
    const env = await noteEnvelope(B2.engine, 'note:r1')
    let vaultOpens = null
    try { vaultOpens = B2.engine.view.openRecord({ objectId: 'note:r1', envelope: env }) } catch (_) { vaultOpens = null }
    let epochOpens = false
    for (const [tag, key] of B2.engine.epochKeys) {
      try {
        crypto.openWithObjectId({ epochKey: key, epochTag: tag, objectId: 'opbody:' + crypto.blindId(indexKey, 'note:r1'), envelope: env })
        epochOpens = true
      } catch (_) {}
    }
    t.comment('d-diag-r1 ' + JSON.stringify({
      hasEnv: !!env,
      vaultBody: vaultOpens && vaultOpens.body,
      epochOpens,
      pending: (await B2.engine._listRawPendingOps()).map((r) => ({ type: r.value && r.value.header && r.value.header.type, lam: r.value && r.value.header && r.value.header.lamport })),
      keys: [...B2.engine.epochKeys.keys()].map((k) => String(k).slice(0, 6))
    }))
  }
  // GATING (previously a t.comment): which body terminally won r1 under
  // sustained suppression used to depend on the reconciler's fresh-Lamport
  // re-appends — a pre-edit re-append could out-rank the newer edit until the
  // log re-applied key-held, terminally within this no-peer window. Re-appends
  // now replay the ORIGINAL op identity, so no op in the log carries the old
  // body with a stamp that beats the edit: v2 is the unique LWW winner among
  // r1's ops, its `rawop!` record survives until its effect is in the row
  // (CONFIRM-THEN-RETIRE checks __lww, not mere readability), and the reopen
  // sweep re-dispatches in Lamport order — so newest-body convergence is
  // deterministic and MUST gate. Readability is asserted separately first so
  // a regression distinguishes "stuck raw" from "stale body won".
  const r1Readable = await pumpUntil([B2.engine], async () => {
    const env2 = await noteEnvelope(B2.engine, 'note:r1')
    if (!env2) return false
    try { return !!B2.engine.view.openRecord({ objectId: 'note:r1', envelope: env2 }) } catch (_) { return false }
  }, { timeoutMs: 30000 })
  t.ok(r1Readable, '(d) r1 is vault-key READABLE after reopen (never stuck raw)')
  t.ok(!!(r1After && r1After.body === 'r1-v2-newer-edit'),
    '(d) r1 converged to the NEWEST body after reopen — an original-identity re-append cannot out-rank the newer edit')

  // (e/d) The LEGACY raw row (r3 — pending records stripped in (e), so the
  // re-materializer never touches it) must survive the cold reopen too: still
  // raw at the view level, still served by the production READ FALLBACK.
  t.absent(await openNote(B2.engine, 'note:r3'), '(e/d) legacy raw row still not re-materialized after reopen (no pending record)')
  const r3cold = await B2.call(COMMANDS.NOTE_OPEN, { noteId: 'r3' })
  t.is(r3cold.note.body, 'r3-legacy-lemur', '(e/d) NOTE_OPEN reads the legacy raw row via the epoch fallback after a COLD REOPEN')
})
