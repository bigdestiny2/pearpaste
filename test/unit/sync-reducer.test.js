// Unit: sync reducer — deterministic LWW + Lamport tie-break, revoked-device
// append rejection, key-rotation epoch monotonicity. Spec §9.5/§8.4, §16,
// §21 Agent 1. Run: node test/unit/sync-reducer.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'
import { Lamport } from '../../backend/shared-ops.js'
import autobaseSync from '../../backend/autobase-sync.js'
import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
const { SyncEngine } = autobaseSync

function tmp () { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-reducer-')) }

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

test('DEVICE_REVOKE bumps key-rotation epoch (monotonic) and revokes the device', async (t) => {
  const dir = tmp()
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { await pe.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  await pe.call(COMMANDS.CREATE_VAULT, { label: 'admin', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)

  const startEpoch = pe.ctx.sync.keyEpoch
  const victim = 'deadbeef'.repeat(4)
  // seed a revocable device row directly via a signed DEVICE_ADD
  await pe.ctx.sync._appendDeviceAdd(
    { deviceId: victim, label: 'old', platform: 'x', signingPubkey: 'V'.repeat(64), boxPubkey: 'b', roles: ['writer'], writerKey: b4a.toString(b4a.alloc(32, 4), 'hex') },
    { signer: pe.ctx.sync._localSigner() }
  )
  await pe.ctx.sync.refresh()
  t.ok(pe.ctx.sync.devices.has(victim), 'victim device added to set')

  const res = await pe.call(COMMANDS.DEVICE_REVOKE, { deviceId: victim })
  t.ok(res.ok, 'revoke succeeded')
  t.is(res.epoch, startEpoch + 1, 'key epoch incremented by exactly 1')
  t.ok(pe.ctx.sync.keyEpoch > startEpoch, 'engine keyEpoch advanced (monotonic)')

  const v = pe.ctx.sync.devices.get(victim)
  t.ok(v && v.revokedAtLamport != null, 'victim marked revoked at a lamport')
  t.absent(pe.ctx.sync._signerAuthorized({ signerPubkey: 'V'.repeat(64) }, v.revokedAtLamport + 1),
    'a post-revoke op signed by the revoked device is rejected by the reducer')
})
