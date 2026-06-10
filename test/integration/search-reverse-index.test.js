// Integration: the [AUDIT I-14] reverse-pointer search index + [AUDIT I-8]
// marker value + the v2 rebuild migration, driven through a REAL single-device
// SyncEngine (genesis-writable, no swarm — the index work is purely local).
//
// Covers what the audit demands:
//   (1) RE-INDEX with a SHRUNK/CHANGED token set drops stale pointers — search
//       stops returning the note for dropped terms, still returns it for kept +
//       new terms (the whole point of the reverse-pointer clear).
//   (2) DELETE removes the note's token pointers AND its reverse row.
//   (3) The token-row VALUE is the 1-byte marker (I-8) while search() still
//       flags rows sealed:true; the reverse row is a sealed AEAD envelope.
//   (4) The v2 rebuild migration: an EMPTY v2 search bee over a vault that has
//       committed notes is repopulated by the explicit open() rebuild path
//       (apply does NOT re-run on a fully-indexed reopen).
//
// Run (sandbox OFF — Corestore/Hypercore touch UDX-backed storage):
//   node test/integration/search-reverse-index.test.js

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

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-srev-' + tag + '-')) }

// A single fully-wired, genesis-writable device. Re-openable on the same store
// (pass the same `dir`) to exercise reopen/migration.
async function makeDevice ({ dir, vaultKey, indexKey, vaultId, headerCache, log }) {
  const store = new Corestore(dir)
  await store.ready()
  const device = identity.createDeviceIdentity({ label: 'd', platform: 'test', seed: b4a.alloc(32, 7) })
  const ctx = {
    crypto,
    ops,
    identity,
    log: log || { debug () {}, info () {}, warn () {}, error () {} },
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
  return { store, ctx, engine, device }
}

async function upsert (engine, noteId, { body = '', tags = [], deletedAt = null } = {}) {
  const rec = { noteId, body: String(body), tags, label: '', createdAt: 1, updatedAt: Date.now() }
  if (deletedAt) rec.deletedAt = deletedAt
  await engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:' + noteId, rec)
  await engine.refresh()
}

async function searchIds (engine, q) {
  const hits = await engine.localSearch.search(q)
  const ids = []
  for (const { objectBlindId } of hits) {
    const meta = await engine.view.resolveObjMeta(objectBlindId)
    const oid = meta && meta.objectId
    ids.push(oid ? oid.slice(oid.indexOf(':') + 1) : null)
  }
  return ids.filter(Boolean).sort()
}

async function dumpKeys (bee, prefix) {
  const out = []
  for await (const { key, value } of bee.createReadStream({ gte: prefix, lt: prefix + '~' })) {
    out.push({ key, value })
  }
  return out
}

test('reverse-pointer re-index drops stale pointers; delete clears pointers + reverse row', async (t) => {
  const dir = tmp('reidx')
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'vault-srev'
  const headerCache = {}
  const D = await makeDevice({ dir, vaultKey, indexKey, vaultId, headerCache })
  t.teardown(async () => {
    try { await D.engine.close() } catch (_) {}
    try { await D.store.close() } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Three notes; tokens come from body + tags (the reducer indexes those).
  await upsert(D.engine, 'n1', { body: 'alpha bravo secretword', tags: ['tagx'] })
  await upsert(D.engine, 'n2', { body: 'alpha charlie' })
  await upsert(D.engine, 'n3', { body: 'alpha bravo charlie delta' })

  t.alike(await searchIds(D.engine, 'alpha'), ['n1', 'n2', 'n3'], 'common term hits all three')
  t.alike(await searchIds(D.engine, 'secretword'), ['n1'], 'unique term hits its note')
  t.alike(await searchIds(D.engine, 'bravo charlie'), ['n3'], 'AND-of-terms narrows correctly')

  // --- THE STALE-POINTER CASE: re-index n1 with a SHRUNK/CHANGED token set ---
  // n1: {alpha bravo secretword tagx} -> {alpha delta}. secretword/bravo/tagx
  // pointers MUST be gone; delta (new) MUST appear; alpha (kept) stays.
  await upsert(D.engine, 'n1', { body: 'alpha delta' })

  t.alike(await searchIds(D.engine, 'secretword'), [], 'dropped term no longer returns n1 (stale pointer cleared)')
  t.alike(await searchIds(D.engine, 'bravo'), ['n3'], 'dropped term: n1 gone, n3 (unchanged) remains')
  t.alike(await searchIds(D.engine, 'tagx'), [], 'dropped tag token cleared')
  t.alike(await searchIds(D.engine, 'delta'), ['n1', 'n3'], 'new term now returns n1 (n3 still has delta)')
  t.alike(await searchIds(D.engine, 'alpha'), ['n1', 'n2', 'n3'], 'kept term still returns n1')

  // The reverse row for n1 must now list exactly the 2 new token blind ids.
  const o1 = crypto.blindId(indexKey, 'note:n1')
  const revNode = await D.engine._searchBee.get('searchrev!' + o1)
  t.ok(revNode && revNode.value, 'n1 has a reverse row')
  const revPlain = crypto.openWithObjectId({ vaultKey, objectId: 'searchrev:' + o1, envelope: revNode.value })
  t.is(revPlain.tokenBlindIds.length, 2, 'reverse row lists exactly the 2 current token blind ids')
  const expectTbids = ['alpha', 'delta'].map(tk => crypto.blindId(indexKey, 'tok:' + tk)).sort()
  t.alike([...revPlain.tokenBlindIds].sort(), expectTbids, 'reverse row token ids match the new token set')

  // [I-8] token-row value is the 1-byte marker; reverse row is a sealed envelope.
  const tokenRows = await dumpKeys(D.engine._searchBee, 'search!')
  t.ok(tokenRows.length > 0, 'token rows exist')
  t.ok(tokenRows.every(r => r.value === 1), 'every token-row value is the 1-byte marker (I-8)')
  t.ok(tokenRows.every(r => !r.value || (typeof r.value !== 'object')), 'no per-token sealed envelope remains')

  // --- DELETE n3 (hard): its token pointers AND reverse row must vanish ---
  const o3 = crypto.blindId(indexKey, 'note:n3')
  await D.engine.appendOp(ops.OP_TYPES.NOTE_DELETE, ops.SCHEMAS.NOTE, 'note:n3', { noteId: 'n3', hard: true })
  await D.engine.refresh()

  t.alike(await searchIds(D.engine, 'delta'), ['n1'], 'after delete, n3 gone from results; n1 remains')
  t.alike(await searchIds(D.engine, 'charlie'), ['n2'], 'n3 gone; n2 (charlie) remains')
  const o3Token = await D.engine._searchBee.get('search!' + crypto.blindId(indexKey, 'tok:charlie') + '!' + o3)
  t.absent(o3Token, 'n3 token pointer is deleted')
  const o3Rev = await D.engine._searchBee.get('searchrev!' + o3)
  t.absent(o3Rev, 'n3 reverse row is deleted')

  // search() still flags rows sealed:true (consumer + unit test depend on flag)
  const sealedHits = await D.engine.localSearch.search('alpha')
  t.ok(sealedHits.length > 0 && sealedHits.every(r => r.sealed === true), 'search rows still flagged sealed:true')
  t.ok(sealedHits.every(r => !r.title && !r.body), 'search rows carry no decrypted title/body')
})

test('v2 migration: empty search bee over a vault with notes is rebuilt by open()', async (t) => {
  const dir = tmp('mig')
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'vault-mig'
  const headerCache = {}
  const D = await makeDevice({ dir, vaultKey, indexKey, vaultId, headerCache })
  t.teardown(async () => {
    try { await D.engine.close() } catch (_) {}
    try { await D.store.close() } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await upsert(D.engine, 'm1', { body: 'apple banana', tags: ['fruit'] })
  await upsert(D.engine, 'm2', { body: 'cherry banana' })
  await upsert(D.engine, 'm3', { body: 'durian', tags: ['spiky'] })
  // one soft-deleted note (texts:[] -> contributes NO tokens, leaves no rows)
  await upsert(D.engine, 'm4', { body: 'eggplant', deletedAt: Date.now() })

  t.alike(await searchIds(D.engine, 'banana'), ['m1', 'm2'], 'baseline: banana hits two notes')
  t.alike(await searchIds(D.engine, 'eggplant'), [], 'soft-deleted note contributes no tokens')

  // Snapshot the search-family in a re-seal-stable form: token rows keep their
  // (key, marker-value) verbatim; reverse rows compare their KEY + DECRYPTED
  // plaintext (the raw envelope bytes legitimately differ across re-seals — a
  // fresh random nonce/keyId per seal — so comparing ciphertext would be wrong).
  const snapshot = async () => {
    const rows = []
    for await (const { key, value } of D.engine._searchBee.createReadStream()) {
      if (key.startsWith('searchrev!')) {
        const obid = key.slice('searchrev!'.length)
        let plain = null
        try { plain = crypto.openWithObjectId({ vaultKey, objectId: 'searchrev:' + obid, envelope: value }) } catch (_) {}
        // normalize token-id order so set-equality isn't order-sensitive
        const norm = plain ? { ...plain, tokenBlindIds: [...(plain.tokenBlindIds || [])].sort() } : null
        rows.push([key, 'REV:' + JSON.stringify(norm)])
      } else {
        rows.push([key, JSON.stringify(value)])
      }
    }
    rows.sort((a, b) => a[0].localeCompare(b[0]))
    return rows
  }
  const before = await snapshot()
  t.ok(before.length > 0, 'search bee is populated pre-wipe')

  // Simulate the v1->v2 upgrade: a freshly-named v2 bee starts EMPTY. Wipe every
  // row so the bee is empty exactly as a brand-new v2 core would be.
  const wipe = D.engine._searchBee.batch()
  for await (const { key } of D.engine._searchBee.createReadStream()) await wipe.del(key)
  await wipe.flush()
  let remaining = 0
  for await (const _ of D.engine._searchBee.createReadStream()) remaining++ // eslint-disable-line no-unused-vars
  t.is(remaining, 0, 'search bee wiped to empty (simulates fresh v2 core)')
  t.alike(await searchIds(D.engine, 'banana'), [], 'search empty after wipe')

  // The explicit rebuild path (what open() calls) must repopulate from notes.
  // It processes every committed note ROW (4) — the soft-deleted m4 is indexed
  // with texts:[] (zero token rows), exactly as the reducer would on apply.
  const n = await D.engine._rebuildSearchIndexIfEmpty()
  t.is(n, 4, 'rebuild processed all 4 committed note rows (m4 soft-deleted -> 0 tokens)')

  t.alike(await searchIds(D.engine, 'banana'), ['m1', 'm2'], 'banana restored after rebuild')
  t.alike(await searchIds(D.engine, 'durian'), ['m3'], 'durian restored after rebuild')
  t.alike(await searchIds(D.engine, 'fruit'), ['m1'], 'tag token restored after rebuild')
  t.alike(await searchIds(D.engine, 'eggplant'), [], 'soft-deleted note still indexes no tokens')

  // The rebuilt index must reproduce the original: identical token-row keys +
  // marker values, and reverse rows decrypting to identical plaintext.
  const after = await snapshot()
  t.alike(after, before, 'rebuilt search bee reproduces the original (token keys+markers; reverse plaintext)')

  // Idempotency: a second call over a now-populated bee is a no-op.
  t.is(await D.engine._rebuildSearchIndexIfEmpty(), 0, 'rebuild is a no-op when the index already exists')
})
