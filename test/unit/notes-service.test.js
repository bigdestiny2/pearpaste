// Unit: notes-service + sync convergence.
//   - sealed NOTE_LIST never carries plaintext title/body
//   - SENTINEL_PREFIX plaintext absent from raw Corestore bytes after save
//   - lock -> unlock cycle re-opens the engine (sync-ready race regression)
//   - two local Pear-end sync engines converge to identical reducer state
// Spec §9.4/§9.5/§10, §16, §21 Agent 1. Run: node test/unit/notes-service.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'
import autobaseSync from '../../backend/autobase-sync.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as ops from '../../backend/shared-ops.js'
import * as identity from '../../backend/identity.js'

const { SyncEngine } = autobaseSync

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-notes-' + tag + '-')) }

function scanForSentinel (dir) {
  const needle = Buffer.from(SENTINEL_PREFIX)
  let hit = null
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { try { if (fs.readFileSync(p).includes(needle)) hit = p } catch (_) {} }
    }
  }
  walk(dir)
  return hit
}

test('NOTE_LIST is sealed; NOTE_OPEN returns plaintext; sentinel never at rest', async (t) => {
  const dir = tmp('seal')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 's', platform: 'test', passphrase: 'pw' })
  const secret = SENTINEL_PREFIX + 'TOPSECRET_BODY'

  // CREATE_VAULT -> NOTE_UPSERT immediately (the exact sync-ready race path)
  const up = await pe.call(COMMANDS.NOTE_UPSERT, { note: { title: 'Title', body: secret, tags: ['t'] } })
  t.ok(up.ok && up.noteId, 'NOTE_UPSERT succeeded with no NOT_READY')

  const list = await pe.call(COMMANDS.NOTE_LIST, {})
  const listJson = JSON.stringify(list)
  t.absent(listJson.includes(secret), 'NOTE_LIST contains no plaintext body')
  t.absent(listJson.includes(SENTINEL_PREFIX), 'NOTE_LIST contains no sentinel at all')
  t.ok(list.notes.length === 1 && list.notes[0].sealed === true, 'list row is sealed')

  const opened = await pe.call(COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(opened.note.body, secret, 'NOTE_OPEN returns plaintext for the one item')
  await pe.call(COMMANDS.NOTE_CLOSE, { noteId: up.noteId })

  // raw Corestore bytes must not contain the sentinel plaintext
  await pe.ctx.sync.refresh()
  await pe.close()
  const leak = scanForSentinel(dir)
  t.absent(leak, 'no SENTINEL_PREFIX plaintext in raw Corestore bytes' + (leak ? ' (' + leak + ')' : ''))
})

test('lock -> unlock re-opens the sync engine (sync-ready race regression)', async (t) => {
  const dir = tmp('lock')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  const created = await pe.call(COMMANDS.CREATE_VAULT, { label: 'lk', platform: 'test', passphrase: 'pw' })
  const mnemonic = created.mnemonic
  const secret = SENTINEL_PREFIX + 'CYCLE'
  const up = await pe.call(COMMANDS.NOTE_UPSERT, { note: { title: 'A', body: secret } })
  t.ok(up.ok, 'pre-lock NOTE_UPSERT ok')

  await pe.call(COMMANDS.LOCK_VAULT, {})
  t.absent(pe.ctx.isUnlocked(), 'vault locked (engine torn down, ready gate re-armed)')

  // NOTE: the frozen foundation splits a root-device re-unlock across two
  // RPCs — RESTORE_VAULT repopulates vault keys (device stays null), then
  // UNLOCK_VAULT reloads the local device signer. Both emit 'unlocked', so the
  // locked -> unlocked re-open + ready re-arm path is exercised twice here.
  const rv = await pe.call(COMMANDS.RESTORE_VAULT, { mnemonic, passphrase: 'pw' })
  t.ok(rv.restored, 'RESTORE_VAULT restored vault keys')
  const un = await pe.call(COMMANDS.UNLOCK_VAULT, { secret: 'pw' })
  t.ok(un.ok, 'UNLOCK_VAULT reloaded the device signer')
  t.ok(pe.ctx.isUnlocked(), 'vault fully unlocked again (keys + device)')

  // The engine was torn down on lock and re-armed; these must AWAIT re-open
  // rather than throw NOT_READY.
  const up2 = await pe.call(COMMANDS.NOTE_UPSERT, { note: { title: 'B', body: secret + '2' } })
  t.ok(up2.ok && up2.noteId, 'post-unlock NOTE_UPSERT ok (engine re-opened)')

  const list = await pe.call(COMMANDS.NOTE_LIST, {})
  t.absent(JSON.stringify(list).includes(SENTINEL_PREFIX), 'post-unlock NOTE_LIST still sealed')
  t.is(list.notes.length, 2, 'both notes present after lock/unlock cycle')

  const o2 = await pe.call(COMMANDS.NOTE_OPEN, { noteId: up2.noteId })
  t.is(o2.note.body, secret + '2', 'post-unlock NOTE_OPEN returns plaintext')
  await pe.call(COMMANDS.NOTE_CLOSE, { noteId: up2.noteId })
})

// Two independent sync engines, same vault keys, replicated Corestores. Proves
// the deterministic reducer converges (spec §9.5) without depending on DHT
// timing. Uses the real SyncEngine + Autobase over an in-memory replication
// pipe (corestore.replicate), which is exactly what index.js wires from the
// swarm 'connection' event.
test('two local sync engines converge to identical reducer state', async (t) => {
  const dirA = tmp('convA')
  const dirB = tmp('convB')
  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)
  await storeA.ready()
  await storeB.ready()

  // shared vault key material (as if the same recovery phrase / paired)
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'conv-vault'

  function mkCtx (store) {
    const headerCache = {}
    const devA = (store === storeA)
    // full device identity (boxPubkey etc. present so DEVICE_ADD canonicalizes)
    const device = identity.createDeviceIdentity({
      label: devA ? 'A' : 'B', platform: 'test', seed: b4a.alloc(32, devA ? 1 : 2)
    })
    return {
      crypto,
      ops,
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

  const ctxA = mkCtx(storeA)
  const engA = new SyncEngine(ctxA)
  await engA.open() // A creates the autobase + self-root DEVICE_ADD

  // B bootstraps onto the SAME autobase key (as a paired device would).
  const abKey = b4a.toString(engA.base.key, 'hex')
  const ctxB = mkCtx(storeB)
  ctxB.state._vaultHeaderCache.autobaseKey = abKey
  const engB = new SyncEngine(ctxB)
  await engB.open()

  // wire bidirectional replication (what index.js does on swarm 'connection')
  const s1 = storeA.replicate(true)
  const s2 = storeB.replicate(false)
  s1.pipe(s2).pipe(s1)
  s1.on('error', () => {})
  s2.on('error', () => {})

  t.teardown(async () => {
    try { s1.destroy() } catch (_) {}
    try { s2.destroy() } catch (_) {}
    try { await engA.close() } catch (_) {}
    try { await engB.close() } catch (_) {}
    try { await storeA.close() } catch (_) {}
    try { await storeB.close() } catch (_) {}
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  // Authorize B as a writer from A (admin signs DEVICE_ADD for B).
  await engA._appendDeviceAdd(
    {
      deviceId: ctxB.state.device.deviceId,
      label: 'B',
      platform: 'test',
      signingPubkey: ctxB.state.device.signingPubkey,
      boxPubkey: 'b',
      roles: ['writer', 'reader'],
      writerKey: b4a.toString(engB.base.local.key, 'hex')
    },
    { signer: engA._localSigner() }
  )
  await engA.refresh()

  // Converge membership, then each device writes its own note.
  const objId = 'note:shared'
  const deadline = Date.now() + 20000
  async function settle () {
    while (Date.now() < deadline) {
      await engA.refresh(); await engB.refresh()
      await new Promise(resolve => setTimeout(resolve, 120))
      if (engB.base.writable) return
    }
  }
  await settle()
  t.ok(engB.base.writable, 'B became an authorized writer (membership converged)')

  await engA.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
    { noteId: 'shared', title: 'fromA', body: 'A-body', createdAt: 1, updatedAt: 1 })
  await engB.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objId,
    { noteId: 'shared', title: 'fromB', body: 'B-body', createdAt: 1, updatedAt: 1 })

  // let both linearize the two-writer log
  const obid = crypto.blindId(indexKey, objId)
  let a = null
  let b = null
  const conv = Date.now() + 20000
  while (Date.now() < conv) {
    await engA.refresh(); await engB.refresh()
    await new Promise(resolve => setTimeout(resolve, 150))
    const ea = await engA.view.getNoteSealed(obid)
    const eb = await engB.view.getNoteSealed(obid)
    if (ea && eb) {
      a = engA.view.openRecord({ objectId: objId, envelope: ea })
      b = engB.view.openRecord({ objectId: objId, envelope: eb })
      if (a.title === b.title) break
    }
  }

  t.ok(a && b, 'both engines materialized the shared note')
  t.is(a.title, b.title, 'engines converged to the SAME LWW winner (deterministic)')
  t.ok(a.title === 'fromA' || a.title === 'fromB', 'winner is one of the two concurrent writes')
  t.is(a.__lww.lamport != null, true, 'winner carries its Lamport stamp')
})

test('NOTE_DELETE hard=true: verifiable erasure via public surface + on-disk scan', async (t) => {
  // The "cryptographic erasure" guarantee on the website / spec means a
  // deleted note's encrypted envelope is gone from local storage and
  // unreachable via every RPC: NOTE_OPEN throws NOT_FOUND, the row drops
  // from NOTE_LIST, and the sentinel-marker plaintext we put into the body
  // does not appear anywhere on disk after the delete completes. The
  // backend's _applyNoteDelete batch.del's the envelope entry (see
  // backend/autobase-sync.js); these assertions cover the user-observable
  // side of that contract.
  const dir = tmp('hard-del')
  const pearEnd = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pearEnd.call(COMMANDS.CREATE_VAULT, { label: 'test', platform: 'macos', passphrase: 'pw' })
  // Sentinel plaintext inside the body — the storage scanner must not find
  // it before OR after delete (encryption is on at all times; hard delete
  // additionally drops the envelope entirely from the materialized view).
  const SENT = SENTINEL_PREFIX + '-hard-del-test'
  const up = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: 'doomed', body: SENT, label: 'goner' } })
  const noteId = up.noteId

  const listBefore = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(listBefore.notes.length, 1, 'note in list before delete')
  const openedBefore = await pearEnd.call(COMMANDS.NOTE_OPEN, { noteId })
  t.is(openedBefore.note.body, SENT, 'NOTE_OPEN returns the plaintext body before delete')
  await pearEnd.call(COMMANDS.NOTE_CLOSE, { noteId })

  await pearEnd.call(COMMANDS.NOTE_DELETE, { noteId, hard: true })

  await t.exception(
    () => pearEnd.call(COMMANDS.NOTE_OPEN, { noteId }),
    /not found/i,
    'NOTE_OPEN on hard-deleted note throws NOT_FOUND'
  )
  const listAfter = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(listAfter.notes.length, 0, 'list is empty after hard delete')
  const leak = scanForSentinel(dir)
  t.absent(leak, 'sentinel does not appear in any on-disk file after hard delete')
})

test('NOTE_DELETE hard=false: tombstone hides the note but keeps CRDT marker', async (t) => {
  // Soft delete is the CRDT-friendly tombstone used internally for sync
  // convergence. Both paths satisfy the user-facing contract (open/list
  // refuse the deleted note); only hard delete removes the envelope.
  const dir = tmp('soft-del')
  const pearEnd = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pearEnd.call(COMMANDS.CREATE_VAULT, { label: 'test', platform: 'macos', passphrase: 'pw' })
  const up = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: 'tombstone-me', body: 'keep envelope' } })
  const noteId = up.noteId

  await pearEnd.call(COMMANDS.NOTE_DELETE, { noteId, hard: false })

  await t.exception(
    () => pearEnd.call(COMMANDS.NOTE_OPEN, { noteId }),
    /(not found|deleted)/i,
    'NOTE_OPEN refuses to decrypt soft-deleted note'
  )
  const listAfter = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(listAfter.notes.length, 0, 'list filters out soft-deleted rows')
})

test('NOTE_UPSERT with expiresAt: temporary note round-trips + list/open filter expiry', async (t) => {
  // Temporary-note feature contract:
  //   - upsert accepts expiresAt; the timestamp persists inside the
  //     encrypted envelope (NOTE_OPEN returns it on the decrypted note)
  //   - while expiresAt is in the future, the note behaves normally
  //   - the instant expiresAt is in the past, NOTE_LIST drops the row and
  //     NOTE_OPEN throws NOT_FOUND (even if the sweeper hasn't fired yet)
  const dir = tmp('temp-note')
  const pearEnd = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pearEnd.call(COMMANDS.CREATE_VAULT, { label: 'test', platform: 'macos', passphrase: 'pw' })

  const futureExpiry = Date.now() + 60 * 1000
  const up = await pearEnd.call(COMMANDS.NOTE_UPSERT, {
    note: { title: 'ephemeral', body: 'temp content', expiresAt: futureExpiry }
  })
  const noteId = up.noteId

  // While expiry is in the future: list includes the row with expiresAt set,
  // open returns the full note including expiresAt for the editor to display.
  const listLive = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(listLive.notes.length, 1, 'temporary note appears in list while live')
  t.is(listLive.notes[0].expiresAt, futureExpiry, 'list row carries expiresAt for the countdown chip')
  const openedLive = await pearEnd.call(COMMANDS.NOTE_OPEN, { noteId })
  t.is(openedLive.note.expiresAt, futureExpiry, 'NOTE_OPEN returns expiresAt so the editor can show + adjust the TTL')
  await pearEnd.call(COMMANDS.NOTE_CLOSE, { noteId })

  // Re-upsert with a past expiry. Same noteId, so the LWW reducer keeps the
  // record but expiresAt is now historical — list/open must treat it gone.
  await pearEnd.call(COMMANDS.NOTE_UPSERT, {
    note: { noteId, title: 'ephemeral', body: 'temp content', expiresAt: Date.now() - 1000 }
  })

  const listAfter = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(listAfter.notes.length, 0, 'expired temporary note is filtered out of NOTE_LIST')
  await t.exception(
    () => pearEnd.call(COMMANDS.NOTE_OPEN, { noteId }),
    /not found/i,
    'NOTE_OPEN on expired temporary note throws NOT_FOUND'
  )
})

test('NOTE_UPSERT expiresAt=0: persistent note (default)', async (t) => {
  // A note created without expiresAt — or with expiresAt=0 — must behave
  // exactly like the pre-feature persistent default. No TTL, no chip, no
  // sweeper concern.
  const dir = tmp('persistent-note')
  const pearEnd = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pearEnd.call(COMMANDS.CREATE_VAULT, { label: 'test', platform: 'macos', passphrase: 'pw' })
  const up = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: 'forever', body: 'kept' } })
  const list = await pearEnd.call(COMMANDS.NOTE_LIST, {})
  t.is(list.notes.length, 1, 'persistent note in list')
  t.absent(list.notes[0].expiresAt, 'persistent note row has no expiresAt (null/undefined)')
  const opened = await pearEnd.call(COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.absent(opened.note.expiresAt, 'persistent note decrypts with no expiresAt set')
})

test('SEARCH filters expired temporary notes + surfaces expiresAt on live ones', async (t) => {
  // Closes the parity gap with NOTE_LIST: search results must not return a
  // row whose underlying note is past expiry. Otherwise a user could
  // tap an "expired" result and hit NOT_FOUND, or worse, the UI would show
  // ghost rows for notes the user expects to be erased.
  const dir = tmp('search-expiry')
  const pearEnd = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pearEnd.call(COMMANDS.CREATE_VAULT, { label: 't', platform: 'macos', passphrase: 'pw' })
  // Two notes that both match a unique keyword: one live (future expiry),
  // one already expired. Persistent control too, to be thorough.
  const KW = 'searchablekeyword42'
  const liveExpiry = Date.now() + 60 * 1000
  const live = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: KW + '-live', body: KW + ' content', expiresAt: liveExpiry } })
  const gone = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: KW + '-gone', body: KW + ' content', expiresAt: Date.now() - 1000 } })
  const persistent = await pearEnd.call(COMMANDS.NOTE_UPSERT, { note: { title: KW + '-keep', body: KW + ' content' } })

  const res = await pearEnd.call(COMMANDS.SEARCH, { q: KW })
  const ids = res.results.map(r => r.id).filter(Boolean)
  t.ok(ids.includes(live.noteId), 'live temporary note appears in search results')
  t.absent(ids.includes(gone.noteId), 'expired temporary note is filtered out of search results')
  t.ok(ids.includes(persistent.noteId), 'persistent note appears in search results')
  const liveRow = res.results.find(r => r.id === live.noteId)
  t.is(liveRow.expiresAt, liveExpiry, 'search row carries expiresAt for the countdown chip')
  const persistentRow = res.results.find(r => r.id === persistent.noteId)
  t.absent(persistentRow.expiresAt, 'persistent note search row has no expiresAt')
})
