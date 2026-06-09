// Unit: sync reducer — deterministic LWW + Lamport tie-break, revoked-device
// append rejection, key-rotation epoch monotonicity, PLUS the Phase 1 epoch
// plumbing (epochTag-keyed epoch machinery, lazy migration to epoch 0). Spec
// §9.5/§8.4, §16, §21 Agent 1; REVOCATION_DESIGN §5.1/§5.2/§5.4/§5.6/§6.
// Run: node test/unit/sync-reducer.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import Corestore from 'corestore'
import { Lamport, SCHEMAS, OP_TYPES, assertHeaderPublicOnly } from '../../backend/shared-ops.js'
import autobaseSync from '../../backend/autobase-sync.js'
import { MaterializedView, beeFromCore } from '../../backend/materialized-view.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as identity from '../../backend/identity.js'
import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
const { SyncEngine } = autobaseSync

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-reducer-')) }

const ops = { SCHEMAS, OP_TYPES }

test('Lamport clock: monotonic tick + deterministic tie-break', (t) => {
  const c = new Lamport(0)
  t.is(c.tick(), 1)
  t.is(c.tick(), 2)
  c.observe('10')
  t.is(c.tick(), 11, 'observe advances the clock past a remote lamport')
  c.observe(3)
  t.is(c.value, 11, 'observe never moves the clock backwards')

  // winner = max(lamport) then max(deviceId) — total order, no ties.
  t.ok(Lamport.beats({ lamport: 5, deviceId: 'a' }, { lamport: 4, deviceId: 'z' }), 'higher lamport wins')
  t.absent(Lamport.beats({ lamport: 4, deviceId: 'z' }, { lamport: 5, deviceId: 'a' }), 'lower lamport loses')
  t.ok(Lamport.beats({ lamport: 7, deviceId: 'b' }, { lamport: 7, deviceId: 'a' }), 'equal lamport -> higher deviceId wins')
  t.absent(Lamport.beats({ lamport: 7, deviceId: 'a' }, { lamport: 7, deviceId: 'a' }), 'identical does not beat itself (idempotent)')
})

test('_signerAuthorized: revoked device rejected at/after its revoke lamport', (t) => {
  const eng = new SyncEngine({ state: {}, ops: { OP_TYPES: {} } })
  eng.rootPubkey = 'ROOTPUB'
  eng.devices.set('d1', { deviceId: 'd1', signingPubkey: 'PUB1', roles: ['admin', 'writer'], revokedAtLamport: null })
  eng.devices.set('d2', { deviceId: 'd2', signingPubkey: 'PUB2', roles: ['writer'], revokedAtLamport: 10 })

  t.ok(eng._signerAuthorized({ signerPubkey: 'ROOTPUB' }, 999), 'root always authorized')
  t.ok(eng._signerAuthorized({ signerPubkey: 'PUB1' }, 5), 'active device authorized')
  t.absent(eng._signerAuthorized({ signerPubkey: 'UNKNOWN' }, 1), 'unknown signer rejected')

  t.ok(eng._signerAuthorized({ signerPubkey: 'PUB2' }, 9), 'op BEFORE revoke lamport accepted')
  t.absent(eng._signerAuthorized({ signerPubkey: 'PUB2' }, 10), 'op AT revoke lamport rejected (replay protection)')
  t.absent(eng._signerAuthorized({ signerPubkey: 'PUB2' }, 11), 'op AFTER revoke lamport rejected')

  t.ok(eng._signerAuthorized({ signerPubkey: 'PUB1' }, 5, { adminOnly: true }), 'admin passes adminOnly gate')
  t.absent(eng._signerAuthorized({ signerPubkey: 'PUB2' }, 5, { adminOnly: true }), 'writer fails adminOnly gate')
})

test('note reducer is deterministic LWW (higher lamport wins, stable across replays)', async (t) => {
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'r', platform: 'test', passphrase: 'pw' })

  // Notes identify via `label` now — the old `title` field was dropped in
  // the label/title unification (see backend/notes-service.js NOTE_UPSERT).
  // LWW semantics still apply on every field of the encrypted envelope.
  const up1 = await pe.call(COMMANDS.NOTE_UPSERT, { note: { label: 'v1', body: 'first' } })
  const id = up1.noteId
  await pe.call(COMMANDS.NOTE_UPSERT, { note: { noteId: id, label: 'v2', body: 'second' } })
  await pe.call(COMMANDS.NOTE_UPSERT, { note: { noteId: id, label: 'v3', body: 'third' } })

  const a = await pe.call(COMMANDS.NOTE_OPEN, { noteId: id })
  await pe.call(COMMANDS.NOTE_CLOSE, { noteId: id })
  t.is(a.note.label, 'v3', 'latest write (highest lamport) wins')
  t.is(a.note.body, 'third')

  // Re-resolving the reducer view yields the same winner deterministically.
  await pe.ctx.sync.refresh()
  const b = await pe.call(COMMANDS.NOTE_OPEN, { noteId: id })
  await pe.call(COMMANDS.NOTE_CLOSE, { noteId: id })
  t.is(b.note.label, 'v3', 'reducer output is stable on re-linearization')
  t.is(b.note.createdAt, a.note.createdAt, 'createdAt preserved across upserts (whole-note LWW)')
})

test('DEVICE_REVOKE performs a REAL key rotation (activates a fresh epoch sealed to survivors)', async (t) => {
  // UPDATED for Phase 2 (was: "DEVICE_REVOKE bumps key-rotation epoch" — the
  // cosmetic counter). Revocation now ROTATES the content key to a fresh epoch
  // sealed ONLY to survivors: a new non-empty activeEpochTag activates, the
  // surviving admin obtains epochKey_1, activeEpoch advances to 1, and the
  // revoked device is excluded from both the wraps and the write set (B12).
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'admin', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)

  const startActiveEpoch = pe.ctx.sync.activeEpoch
  t.is(startActiveEpoch, 0, 'vault starts at epoch 0 (tag "")')
  t.is(pe.ctx.sync.activeEpochTag, '', 'active tag starts empty (legacy/epoch-0)')

  // A real revocable device with a REAL box keypair (so a survivor-style wrap
  // could target it) — here it is the REVOKED target, so it must get NO wrap.
  const victim = identity.createDeviceIdentity({ label: 'old', platform: 'x', seed: b4a.alloc(32, 0x5c) })
  await pe.ctx.sync._appendDeviceAdd(
    { deviceId: victim.deviceId, label: 'old', platform: 'x', signingPubkey: victim.signingPubkey, boxPubkey: victim.boxPubkey, roles: ['writer'], writerKey: b4a.toString(b4a.alloc(32, 4), 'hex') },
    { signer: pe.ctx.sync._localSigner() }
  )
  await pe.ctx.sync.refresh()
  t.ok(pe.ctx.sync.devices.has(victim.deviceId), 'victim device added to set')

  const res = await pe.call(COMMANDS.DEVICE_REVOKE, { deviceId: victim.deviceId })
  t.ok(res.ok, 'revoke succeeded')
  // The returned epoch is the NEW integer epoch (no longer the cosmetic keyEpoch).
  t.is(res.epoch, 1, 'revoke activated integer epoch 1')
  t.ok(res.epochTag && res.epochTag.length > 0, 'revoke returned a non-empty epochTag (real rotation, not a counter)')

  // REAL rotation took effect on the revoking admin: a fresh non-empty tag is
  // active, the admin (a survivor) holds epochKey_1, and activeEpoch advanced.
  t.is(pe.ctx.sync.activeEpoch, 1, 'engine activeEpoch advanced to 1')
  t.is(pe.ctx.sync.activeEpochTag, res.epochTag, 'engine active tag == the rotation tag')
  t.ok(pe.ctx.sync.epochKeys.has(res.epochTag), 'surviving admin obtained the epoch-1 key')
  t.is(b4a.isBuffer(pe.ctx.sync.epochKeys.get(res.epochTag)) && pe.ctx.sync.epochKeys.get(res.epochTag).byteLength, 32,
    'epoch-1 key is 32 fresh bytes')
  // epoch-0 anchor remains so legacy content still opens (no past-erasure).
  t.ok(pe.ctx.sync.epochKeys.has(''), 'epoch-0 vaultKey anchor still present (old content stays readable)')

  const v = pe.ctx.sync.devices.get(victim.deviceId)
  t.ok(v && v.revokedAtLamport != null, 'victim marked revoked at a lamport')
  // B12: a committed-revoked signer is rejected for ANY new op (not just >= revoke lamport).
  t.absent(pe.ctx.sync._signerAuthorized({ signerPubkey: victim.signingPubkey }, v.revokedAtLamport + 1),
    'a post-revoke op signed by the revoked device is rejected by the reducer (B12)')
  t.absent(pe.ctx.sync._signerAuthorized({ signerPubkey: victim.signingPubkey }, 1),
    'a BACKDATED-lamport op from the committed-revoked device is ALSO rejected (B12)')
})

// ---- Phase 1: epoch plumbing + lazy migration (epoch 0 only) ---------------
// REVOCATION_DESIGN Phase 1. Every existing vault is epoch 0 / epochTag "" /
// epochKey == vaultKey. These tests assert the machinery exists and rebuilds
// reorg-safely, WITHOUT any rotation (Phase 2). Byte-compat itself is proven by
// the unchanged unit/integration/security suites; here we assert the new state.

test('Phase 1: after open, engine carries the epoch-0 lazy-migration anchor', async (t) => {
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'a', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const eng = pe.ctx.sync

  // (b) epochKeys has the "" -> vaultKey entry; activeEpoch 0; activeEpochTag "".
  t.ok(eng.epochKeys.has(''), 'epochKeys carries the epoch-0 tag ""')
  t.is(b4a.toString(eng.epochKeys.get(''), 'hex'), b4a.toString(eng.vaultKey, 'hex'),
    'epochKey_0 == vaultKey (lazy-migration anchor, design §6)')
  t.is(eng.activeEpoch, 0, 'activeEpoch defaults to 0')
  t.is(eng.activeEpochTag, '', 'activeEpochTag defaults to ""')

  // _makeOp stamps epoch "0" / epochTag "" on every op and they pass the
  // public-field classifier (Phase 0 added them to HEADER_PUBLIC_FIELDS).
  const op = eng._makeOp({
    type: OP_TYPES.NOTE_UPSERT,
    schema: SCHEMAS.NOTE,
    objectId: 'note:p1',
    payload: { noteId: 'p1', label: 'x' },
    signer: eng._localSigner()
  })
  t.is(op.header.epoch, '0', 'header.epoch stamped "0"')
  t.is(op.header.epochTag, '', 'header.epochTag stamped ""')
  t.ok(assertHeaderPublicOnly(op.header), 'epoch-stamped header is public-field-clean')
  // epoch-0 envelope is byte-identical to the legacy path: no epochTag in AAD,
  // legacy keyId == hash("keyid:"+objectId) (16-byte hex).
  t.absent('epochTag' in op.envelope.aad, 'epoch-0 AAD omits epochTag (legacy bytes)')
  t.is(op.envelope.keyId, b4a.toString(crypto.hash('keyid:' + eng._opBodyObjectId(op.header.objectBlindId), 16), 'hex'),
    'epoch-0 keyId == legacy hash("keyid:"+objectId)')
  // _body round-trips the op it just sealed by selecting the "" key.
  t.alike(eng._body(op), { noteId: 'p1', label: 'x' }, '_body opens the epoch-0 op via the "" tag')
})

test('Phase 1: _rebuildAuthFromView projects boxPubkey per device (design §5.1)', async (t) => {
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'a', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const eng = pe.ctx.sync
  await eng.refresh()
  await eng._rebuildAuthFromView()

  // (e) the genesis device record now carries its boxPubkey into the cache so a
  // Phase-2 rotation can seal epoch keys to it straight from the rebuild.
  const me = eng.devices.get(ctxDeviceId(pe))
  t.ok(me, 'this device is in the rebuilt cache')
  t.is(me.boxPubkey, pe.ctx.state.device.boxPubkey, 'rebuilt device rec carries boxPubkey')
  t.ok(/^[0-9a-f]+$/.test(me.boxPubkey || ''), 'boxPubkey is hex, not undefined')
})

test('Phase 1: truncate/replay rebuilds epoch-0 state deterministically from the view', async (t) => {
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'a', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const eng = pe.ctx.sync
  const vaultKeyHex = b4a.toString(eng.vaultKey, 'hex')

  // (c) Simulate the post-reorg condition: Autobase truncates the view and
  // re-invokes _apply over the re-linearized tail with no reset signal, so any
  // incrementally-mutated in-memory state would be stale. Corrupt the epoch
  // state in memory, then re-run the SAME pure rebuild the reducer runs at the
  // top of every apply pass. It must deterministically restore epoch-0 state
  // from the committed view alone.
  eng.epochKeys.set('', crypto.randomBytes(32)) // wrong "" key
  eng.epochKeys.set('garbage-tag', crypto.randomBytes(32)) // phantom epoch
  eng.activeEpoch = 99
  eng.activeEpochTag = 'rolledback'

  await eng._rebuildAuthFromView()

  t.is(eng.epochKeys.size, 1, 'rebuild drops the phantom epoch (only "" survives)')
  t.is(b4a.toString(eng.epochKeys.get(''), 'hex'), vaultKeyHex, '"" key restored to vaultKey')
  // activeEpoch is a monotone max-merge, so a forward in-memory value is NOT
  // pulled backwards by the rebuild (reorg cannot silently revert an applied
  // rotation); the committed view holds 0, the prev in-memory was 99.
  t.is(eng.activeEpoch, 99, 'activeEpoch is monotone (max of view 0 and prev 99)')
  // the tag, by contrast, follows the committed view's recorded winner ("" here).
  t.is(eng.activeEpochTag, '', 'activeEpochTag follows the committed view ("")')

  // And from a clean engine field (the genuine fresh-unlock case: prev = 0), the
  // view's epoch 0 is exactly what is restored.
  eng.activeEpoch = 0
  await eng._rebuildAuthFromView()
  t.is(eng.activeEpoch, 0, 'fresh rebuild yields activeEpoch 0 from the committed view')
})

test('Phase 1: epochkeys! family + vault-state activeEpoch round-trip through the view', async (t) => {
  // Exercise the view layer in isolation over a plain (writable) Hyperbee — the
  // Autobase view core is read-only outside _apply, so this mirrors the reducer
  // contract on a standalone store: write a wrap row + a state record, reopen
  // the store, read them back. (design §5.6.)
  const dir = tmp()
  const vaultKey = crypto.randomBytes(32)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'vault-p1'
  // a device to seal an epoch key to (its box secret key opens the lockbox).
  const dev = identity.createDeviceIdentity({ label: 'd', platform: 'test' })
  const epochKey = crypto.randomBytes(32)
  const epochTag = b4a.toString(crypto.hash('rotate-op-1', 16), 'hex')
  const blindId = crypto.blindId(indexKey, 'epochwrap:' + epochTag + ':' + dev.deviceId)
  const sealed = identity.sealToDevice(dev.boxPubkey, epochKey)

  let store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  let core = store.get({ name: 'view' })
  await core.ready()
  let view = new MaterializedView({
    bee: beeFromCore(core), crypto, ops, vaultId, indexKey, getVaultKey: () => vaultKey
  })
  const batch = view.bee.batch()
  await view.putEpochKeyWrap(batch, { epochTag, epoch: 1, blindId, sealed })
  await view.putVaultState(batch, { rootPubkey: 'ROOT', keyEpoch: 1, activeEpoch: 1, activeEpochTag: epochTag })
  await batch.flush()
  await core.close(); await store.close()

  // reopen the same store from disk — proves durability, not just memory.
  store = new Corestore(path.join(dir, 'store'))
  await store.ready()
  core = store.get({ name: 'view' })
  await core.ready()
  view = new MaterializedView({
    bee: beeFromCore(core), crypto, ops, vaultId, indexKey, getVaultKey: () => vaultKey
  })
  t.teardown(async () => { await core.close(); await store.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  // (d) vault-state carries activeEpoch + activeEpochTag.
  const vs = await view.getVaultState()
  t.is(vs.activeEpoch, 1, 'vault-state round-trips activeEpoch')
  t.is(vs.activeEpochTag, epochTag, 'vault-state round-trips activeEpochTag')
  t.is(vs.keyEpoch, 1, 'vault-state still round-trips keyEpoch (additive change)')

  // the wrap row is addressed to dev and opens to the original epoch key.
  const mine = await view.listEpochKeyWrapsFor(dev.deviceId)
  t.is(mine.length, 1, 'listEpochKeyWrapsFor finds the device wrap')
  t.is(mine[0].epochTag, epochTag, 'wrap carries its epochTag')
  const opened = identity.openSealedToDevice(dev.boxPubkey, dev.boxSecretKey, mine[0].sealed)
  t.is(b4a.toString(opened, 'hex'), b4a.toString(epochKey, 'hex'), 'unwrapped lockbox == minted epoch key')

  // a different device id is NOT served this wrap (roster-blind addressing).
  const other = await view.listEpochKeyWrapsFor('cafe'.repeat(8))
  t.is(other.length, 0, 'a non-target device id matches no wrap row')
})

// Resolve this PearEnd's local deviceId for cache lookups.
function ctxDeviceId (pe) { return pe.ctx.state.device.deviceId }
