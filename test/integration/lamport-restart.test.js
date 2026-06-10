// Integration regression for AUDIT I-1 — "Restore the Lamport high-water mark
// on reopen (fixes silent edit loss)".
//
// THE BUG: ctx.state.lamport is constructed fresh as `new Lamport(0)` on every
// unlock (backend/index.js), and its only re-raise — `observe(h.lamport)` inside
// _apply (backend/autobase-sync.js) — does NOT fire on a fully-indexed reopen,
// because Autobase replays apply only over the un-indexed tail. So a vault
// opened at rest leaves the clock at 0. The FIRST edit of any existing note then
// mints a tiny lamport (e.g. 2) that LOSES last-writer-wins against the note's
// own stored lamport (which has climbed into the dozens) — Lamport.beats keeps
// the existing record and the edit is SILENTLY DROPPED. The durability
// reconciler does not rescue it (`_rowPresentFor` checks row presence, so the
// pending entry is retired).
//
// THE FIX: SyncEngine.open() re-seeds the clock after `base.update()` /
// genesis bootstrap via `ctx.state.lamport.observe(await _maxDurableLamport())`,
// which reads the max PUBLIC `header.lamport` across all active writer cores.
//
// This test builds a single-device vault, writes a note, edits it dozens of
// times (stored lamport climbs well past any value a fresh clock could mint on
// its first ticks), CLOSES the engine, REOPENS a brand-new engine over the SAME
// Corestore with a FRESH Lamport(0) (exactly as a real unlock does), edits the
// note once more, and asserts the reopened edit WINS — i.e. the new body is what
// the note read-path (the same view.getNoteSealed + openRecord that NOTE_OPEN /
// NOTE_LIST use) returns.
//
// RED before the fix (reopened edit dropped → stale body), GREEN after.
//
// Run (sandbox OFF — autobase/corestore on disk):
//   node test/integration/lamport-restart.test.js

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

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-lamport-' + tag + '-')) }

// One device's ctx over a given Corestore. A FRESH Lamport(0) each call mirrors
// index.js, which rebuilds state.lamport on every unlock — so a second ctx over
// the same store reproduces the post-restart clock reset precisely. The shared
// `headerCache` persists the autobaseKey across reopens (as putVaultHeader does
// in production), so the reopened engine boots onto the same base.
function makeCtx ({ store, vaultKey, indexKey, vaultId, headerCache, seedByte }) {
  const device = identity.createDeviceIdentity({
    label: 'A', platform: 'test', seed: b4a.alloc(32, seedByte)
  })
  return {
    crypto,
    ops,
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
}

// Read a note back exactly as NOTE_OPEN / NOTE_LIST do (notes-service.js):
// view.getNoteSealed(blindId) -> view.openRecord({ objectId, envelope }).
async function readNote (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  const env = await engine.view.getNoteSealed(obid)
  if (!env) return null
  try { return engine.view.openRecord({ objectId: objId, envelope: env }) } catch (_) { return null }
}

test('I-1: an edit after a close+reopen WINS against the note\'s own stored lamport', { timeout: 120000 }, async (t) => {
  const dir = tmp('restart')
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'lamport-restart'
  const headerCache = {}
  const objId = 'note:n1'

  // ---- Session 1: build the vault, write + edit the note many times --------
  let store = new Corestore(dir)
  await store.ready()
  let ctx = makeCtx({ store, vaultKey, indexKey, vaultId, headerCache, seedByte: 7 })
  let engine = new SyncEngine(ctx)
  await engine.open()
  t.teardown(async () => {
    try { await engine.close() } catch (_) {}
    try { await store.close() } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch (_) {}
  })

  await engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
    { noteId: 'n1', title: 't', body: 'body-v0', createdAt: 1, updatedAt: 1 })
  // Edit dozens of times so the stored lamport climbs well past the handful of
  // ticks a fresh Lamport(0) could mint before the reopened edit.
  const EDITS = 40
  for (let i = 1; i <= EDITS; i++) {
    await engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
      { noteId: 'n1', title: 't', body: 'body-v' + i, createdAt: 1, updatedAt: i + 1 })
  }
  await engine.refresh()

  const before = await readNote(engine, objId)
  t.is(before && before.body, 'body-v' + EDITS, 'session 1: latest edit is the live body')
  const storedLamport = before && before.__lww && Number(before.__lww.lamport)
  t.ok(storedLamport >= 12, 'session 1: stored lamport climbed into the dozens (' + storedLamport + ')')

  // Close (lock). state.lamport is discarded with this ctx; the next unlock
  // builds a fresh Lamport(0) — exactly the production restart condition.
  await engine.close()
  await store.close()

  // ---- Session 2: reopen the SAME store (fresh clock) and edit once more ----
  store = new Corestore(dir)
  await store.ready()
  ctx = makeCtx({ store, vaultKey, indexKey, vaultId, headerCache, seedByte: 7 })
  engine = new SyncEngine(ctx)
  await engine.open()

  // With the fix, open() restored the high-water mark from the writer cores;
  // assert it (this is the linchpin — without the fix this is ~1).
  t.ok(ctx.state.lamport.value >= storedLamport,
    'reopen restored the Lamport high-water mark (' + ctx.state.lamport.value + ' >= ' + storedLamport + ')')

  await engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
    { noteId: 'n1', title: 't', body: 'edit-after-restart', createdAt: 1, updatedAt: EDITS + 100 })
  await engine.refresh()

  const after = await readNote(engine, objId)
  t.is(after && after.body, 'edit-after-restart',
    'the post-reopen edit WINS — the new body is what the note read-path returns (no silent drop)')
})
