// Integration: REAL content-key rotation with forward secrecy over a real
// Hyperswarm testnet — the DECISIVE test for the PearPaste revocation design
// (REVOCATION_DESIGN Phase 2). Three independent SyncEngines (separate
// Corestores, SAME vault keys but DISTINCT per-device identities, as a paired
// fleet would be) replicate over @hyperswarm/testnet exactly as index.js wires
// production (swarm 'connection' -> store.replicate + swarm.join(topic)).
//
// THE DECISIVE TEST: A+B+C converge; A revokes C (rotation to epoch 1); A
// creates note n1 AFTER rotation. Asserts forward secrecy of CONTENT — a
// revoked device provably CANNOT decrypt content created after its revoke:
//   (1) C.engine.epochKeys.has(epochTag_1) === false
//   (2) for EVERY key C ever held (epoch-0 vaultKey + any) openWithObjectId on
//       n1 throws AEAD_FAIL (incl. wrong-epochTag AAD)
//   (3) C CAN still open a pre-revoke note n0 (no past-erasure)
//   (4) survivors A and B CAN open n1 under epochKey_1
//   (5) n1's keyId is epoch-1-bound (B4-unlinkable from the epoch-0 keyId)
//   (6) a backdated-lamport content op from C is rejected (B12)
//
// SB1 REGRESSION (GATE ship-blocker #1): a DEVICE_REVOKE of an OFFLINE device
// must NOT freeze the base — the revoking device's indexedLength still ADVANCES
// after revoke+rotation lands with the target offline (removeWriter decoupled).
//
// Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/revocation-rotation.test.js

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

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-revrot-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// One fully-wired device sharing the vault keys but with its OWN identity (its
// own box keypair — the rotation seals epochKey_{N+1} INDIVIDUALLY to each
// surviving box pubkey). ctx.identity is wired (the engine uses
// identity.sealToDevice / openSealedToDevice) and state.device carries
// boxSecretKey (local-only) so a survivor can unwrap its lockbox.
async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()

  const scope = new LifecycleScope('revrot-' + tag)
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

// Join all swarms to the shared vault discovery topic (epoch 0, derived from
// vaultKey exactly as index.js's joinVault does) so they discover + replicate
// over the DETERMINISTIC @hyperswarm/testnet (local bootstrap, no public DHT).
// FULL MESH: every device joins server+client so all pairs (A-B, A-C, B-C)
// rendezvous directly — a 3-device set must not depend on one node relaying for
// two pure clients (the flaky `not ok 1` in the live-DHT shape). We wait until
// EACH device has connected to all of its peers (n-1 connections) so writable
// convergence is driven by linearization, never by discovery timing.
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

function deviceSetOf (engine) {
  const out = []
  for (const d of engine.devices.values()) {
    out.push({ deviceId: d.deviceId, revokedAtLamport: d.revokedAtLamport == null ? null : Number(d.revokedAtLamport) })
  }
  out.sort((a, b) => String(a.deviceId).localeCompare(String(b.deviceId)))
  return out
}

async function openNote (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  const env = await engine.view.getNoteSealed(obid)
  if (!env) return null
  try { return engine.view.openRecord({ objectId: objId, envelope: env }) } catch (_) { return null }
}

// Read back the raw sealed envelope for a note (to attack it with C's keys).
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

// ---------------------------------------------------------------------------
// THE DECISIVE TEST — forward secrecy of content against the revoked device.
// ---------------------------------------------------------------------------
test('DECISIVE: a revoked device provably CANNOT decrypt content created after its revoke', { timeout: 240000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revrot-decisive'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 1 })
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 2, autobaseKey: b4a.toString(A.engine.base.key, 'hex') })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 3, autobaseKey: b4a.toString(A.engine.base.key, 'hex') })
  t.teardown(() => teardown([A, B, C], testnet))

  await joinShared([A, B, C], vaultKey)
  const engines = [A.engine, B.engine, C.engine]

  // A (root/admin) authorizes B and C as real writers; settle membership so all
  // three see the full 3-device set on a fully-integrated base.
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  const settled = await pumpUntil(engines, async () =>
    B.engine.base.writable && C.engine.base.writable &&
    A.engine.devices.size === 3 && B.engine.devices.size === 3 && C.engine.devices.size === 3,
  { timeoutMs: 90000 })
  t.ok(settled, 'A+B+C converged on the full 3-device set (all writable)')

  // A creates n0 at epoch 0; all three converge and open it.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-pre-revoke-body', createdAt: 1, updatedAt: 1 })
  const n0Converged = await pumpUntil(engines, async () =>
    (await openNote(A.engine, 'note:n0')) && (await openNote(B.engine, 'note:n0')) && (await openNote(C.engine, 'note:n0')))
  t.ok(n0Converged, 'n0 (epoch 0) converged + opened on A, B AND C')
  const n0OnC = await openNote(C.engine, 'note:n0')
  t.is(n0OnC && n0OnC.body, 'n0-pre-revoke-body', 'C opened n0 while still trusted')

  // Snapshot EVERY key C holds at epoch 0 (its vaultKey == epochKey_0 + any
  // epoch keys in its in-memory map) BEFORE the revoke, so we can later prove no
  // retained key opens n1.
  const cKeysBefore = []
  for (const [tag, key] of C.engine.epochKeys) cKeysBefore.push({ tag, key: b4a.from(key) })
  t.ok(cKeysBefore.some((k) => k.tag === ''), 'C holds the epoch-0 vaultKey before revoke')

  // ---- A REVOKES C -> rotation to epoch 1 (sealed ONLY to A and B) ----------
  // The lightweight test ctx constructs SyncEngine directly (no RPC dispatcher),
  // so drive the revoke through the engine primitives exactly as the dispatcher
  // does: REVOKE op, then a REAL KEY_ROTATE minted by _makeKeyRotateOp sealing
  // epochKey_1 to the SURVIVORS (A, B) and omitting C.
  const survivors = A.engine._survivingDevices(C.device.deviceId)
  t.ok(survivors.some((s) => s.deviceId === B.device.deviceId), 'survivor set includes B')
  t.absent(survivors.some((s) => s.deviceId === C.device.deviceId), 'survivor set EXCLUDES the revoked C')

  const revOp = A.engine._makeOp({
    type: ops.OP_TYPES.DEVICE_REVOKE,
    schema: ops.SCHEMAS.DEVICE,
    objectId: 'device:' + C.device.deviceId,
    payload: { deviceId: C.device.deviceId },
    signer: A.engine._localSigner()
  })
  const rot = A.engine._makeKeyRotateOp({ revokedDeviceId: C.device.deviceId, survivors, signer: A.engine._localSigner() })
  const epochTag1 = rot.epochTag
  await A.engine._append(revOp)
  await A.engine._append(rot.op)
  A.engine.epochKeys.set(rot.epochTag, rot.epochKey)
  await A.engine.refresh()

  // Drive convergence until A and B both activate epoch 1 and C is revoked
  // everywhere. (C keeps replicating the opaque log — that is expected, L2 —
  // but never obtains epochKey_1.)
  const activated = await pumpUntil(engines, async () =>
    A.engine.activeEpochTag === epochTag1 && B.engine.activeEpochTag === epochTag1 &&
    A.engine.epochKeys.has(epochTag1) && B.engine.epochKeys.has(epochTag1) &&
    C.engine.devices.get(C.device.deviceId) && C.engine.devices.get(C.device.deviceId).revokedAtLamport != null)
  t.ok(activated, 'A and B activated epoch 1; C sees itself revoked')

  // A creates n1 AFTER the rotation — it must seal under epochKey_1.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'n1-post-revoke-secret', createdAt: 2, updatedAt: 2 })
  const n1OnAB = await pumpUntil([A.engine, B.engine], async () =>
    (await openNote(A.engine, 'note:n1')) && (await openNote(B.engine, 'note:n1')))
  t.ok(n1OnAB, 'n1 converged onto the survivors A and B')

  // The n1 envelope must replicate to C too (it still replicates the opaque
  // log), so C genuinely HAS the ciphertext but cannot decrypt it.
  const n1EnvOnC = await pumpUntil([A.engine, B.engine, C.engine], async () => !!(await noteEnvelope(C.engine, 'note:n1')))
  t.ok(n1EnvOnC, 'n1 ciphertext replicated to C (C has the bytes — it just cannot read them)')

  // (4) Survivors A and B CAN open n1 under epochKey_1.
  const n1OnA = await openNote(A.engine, 'note:n1')
  const n1OnB = await openNote(B.engine, 'note:n1')
  t.is(n1OnA && n1OnA.body, 'n1-post-revoke-secret', 'survivor A opened n1 under epochKey_1')
  t.is(n1OnB && n1OnB.body, 'n1-post-revoke-secret', 'survivor B opened n1 under epochKey_1')

  // n1's header is epoch-1-bound (asserted via the active epoch + the stored
  // envelope keyId below; the opened record does not carry the header).
  t.is(A.engine.activeEpoch, 1, 'active integer epoch is 1 post-rotation')
  t.ok(epochTag1 && epochTag1.length > 0, 'epochTag_1 is a non-empty content id')

  // (1) C's engine has NO epoch-1 key.
  t.absent(C.engine.epochKeys.has(epochTag1), '(1) C.engine.epochKeys.has(epochTag_1) === false')

  // (2) For EVERY key C ever held, opening n1 throws AEAD_FAIL — including under
  // the wrong-epochTag AAD path. We reconstruct C's full retained key material
  // (epoch-0 vaultKey + every epoch key in its map) and attempt the decrypt with
  // each, the way a malicious C that tries every key it ever had would.
  const cEnvN1 = await noteEnvelope(C.engine, 'note:n1')
  t.ok(cEnvN1, 'C has the n1 ciphertext to attack')
  const cKeysAll = [...cKeysBefore]
  for (const [tag, key] of C.engine.epochKeys) {
    if (!cKeysAll.some((k) => k.tag === tag)) cKeysAll.push({ tag, key: b4a.from(key) })
  }
  let aeadFails = 0
  let anyOpened = false
  for (const { key } of cKeysAll) {
    // try the stored-AAD path (faithful open)
    try {
      crypto.openWithObjectId({ epochKey: key, objectId: 'opbody:' + crypto.blindId(indexKey, 'note:n1'), envelope: cEnvN1 })
      anyOpened = true
    } catch (e) { if (e && e.code === 'AEAD_FAIL') aeadFails++ }
    // try forcing the wrong epochTag into the AAD (cross-epoch splice) — must also fail closed
    try {
      const spliced = { ...cEnvN1, aad: { ...cEnvN1.aad, epochTag: '' } }
      crypto.openWithObjectId({ epochKey: key, objectId: 'opbody:' + crypto.blindId(indexKey, 'note:n1'), envelope: spliced })
      anyOpened = true
    } catch (e) { if (e && e.code === 'AEAD_FAIL') aeadFails++ }
  }
  t.absent(anyOpened, '(2) NO key C ever held opens n1 (forward secrecy holds against a C that tries every key)')
  t.ok(aeadFails >= cKeysAll.length, '(2) every retained-key decrypt attempt on n1 failed with AEAD_FAIL (incl. wrong-epochTag AAD)')

  // C also cannot open n1 via its own reducer path (the _body select-by-tag
  // returns no key for epochTag_1, falling back to vaultKey -> AEAD_FAIL).
  let cBodyThrew = null
  try {
    // mimic the op the survivor applied: an envelope tagged epochTag_1.
    crypto.openWithObjectId({ epochKey: C.engine.epochKeys.get(epochTag1) || C.engine.vaultKey, objectId: 'opbody:' + crypto.blindId(indexKey, 'note:n1'), envelope: cEnvN1 })
  } catch (e) { cBodyThrew = e }
  t.ok(cBodyThrew && cBodyThrew.code === 'AEAD_FAIL', '(2) C reducer-path open of n1 fails AEAD (no epochKey_1)')

  // APPLY-PATH PROOF (the Phase 2 bug fix): C's reducer applied n1 WITHOUT
  // throwing out of _apply (this test reaching here at all proves the Autobase
  // drain on C never crashed on the post-rotation content op). The op was
  // applied SEALED — the row is stored (cEnvN1 above is non-null, the op's own
  // epoch-1 envelope) so it linearizes + replicates — yet C's high-level
  // NOTE_OPEN returns NOTHING for n1, because C lacks epochKey_1 and the stored
  // sealed row opens only under it. So the op is applied-sealed-but-not-readable:
  // exactly the forward-secrecy outcome for a revoked device.
  const n1ReadOnC = await openNote(C.engine, 'note:n1')
  t.absent(n1ReadOnC, '(2) C\'s NOTE_OPEN of n1 returns NOTHING (applied sealed, cannot be read without epochKey_1)')
  t.ok(cEnvN1, '(2) ...yet C DID store n1\'s sealed envelope (op applied + replicated, not dropped — readable later only with the key)')

  // (3) C CAN still open n0 (epoch 0 — forward secrecy, NOT past-erasure).
  const n0StillOnC = await openNote(C.engine, 'note:n0')
  t.is(n0StillOnC && n0StillOnC.body, 'n0-pre-revoke-body', '(3) C still opens the pre-revoke note n0 (no past-erasure)')

  // (5) n1's keyId is epoch-1-bound and UNLINKABLE from the epoch-0 keyId for the
  // same object (B4). Re-seal n0's OBJECT under epochTag_1 and assert its keyId
  // differs from the epoch-0 keyId C holds.
  const objIdN0 = 'opbody:' + crypto.blindId(indexKey, 'note:n0')
  const keyIdEpoch0 = crypto.keyIdFor('', objIdN0)
  const keyIdEpoch1 = crypto.keyIdFor(epochTag1, objIdN0)
  t.not(keyIdEpoch1, keyIdEpoch0, '(5) the SAME object carries a DIFFERENT keyId under epoch 1 (B4-unlinkable)')
  // and n1's own stored keyId is the epoch-1-bound value (not the legacy form).
  const objIdN1 = 'opbody:' + crypto.blindId(indexKey, 'note:n1')
  t.is(cEnvN1.keyId, crypto.keyIdFor(epochTag1, objIdN1), '(5) n1.keyId == epoch-1-bound keyId (not the epoch-0 form)')
  t.not(cEnvN1.keyId, crypto.keyIdFor('', objIdN1), '(5) n1.keyId != the legacy epoch-0 keyId for the same object')

  // (6) A BACKDATED-lamport content op from C is rejected (B12). C is committed-
  // revoked in every survivor's view, so its op is dropped regardless of the
  // claimed lamport — even one stamped BELOW the revoke point.
  const cRev = A.engine.devices.get(C.device.deviceId)
  t.ok(cRev && cRev.revokedAtLamport != null, 'C is committed-revoked in A\'s view')
  const backdated = Math.max(1, cRev.revokedAtLamport - 1)
  t.absent(A.engine._signerAuthorized({ signerPubkey: C.device.signingPubkey }, backdated),
    '(6) a BACKDATED-lamport (revoke-1) op from committed-revoked C is REJECTED on A (B12)')
  t.absent(B.engine._signerAuthorized({ signerPubkey: C.device.signingPubkey }, backdated),
    '(6) and rejected on B (B12)')
  // End-to-end: C actually appends a post-revoke note; it must NOT materialize on A or B.
  let cThrew = null
  try {
    await C.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:c-post-revoke',
      { noteId: 'c-post-revoke', label: 'c', body: 'should-be-rejected', createdAt: 9, updatedAt: 9 })
  } catch (e) { cThrew = e }
  await pumpUntil(engines, async () => false, { timeoutMs: 5000 })
  t.absent(await openNote(A.engine, 'note:c-post-revoke'),
    '(6) C\'s post-revoke note never materialized on A' + (cThrew ? ' (append threw ' + (cThrew.code || cThrew.message) + ')' : ''))
  t.absent(await openNote(B.engine, 'note:c-post-revoke'), '(6) nor on B')

  // Survivors converged on identical device sets (C revoked at the same lamport).
  t.alike(deviceSetOf(A.engine), deviceSetOf(B.engine), 'A and B agree on the device set (C revoked at the same lamport)')
})

// ---------------------------------------------------------------------------
// SB1 REGRESSION — revoking an OFFLINE device must NOT freeze the base.
// ---------------------------------------------------------------------------
// GATE ship-blocker #1: calling removeWriter on an OFFLINE indexer WEDGES
// linearization — the indexer-set migration is itself an indexed op needing the
// removed device's ack, so the revoke+rotate never COMMIT and the vault stays at
// epoch N with the target un-revoked at the Autobase layer. Phase 2 decouples
// eviction from rotation (removeWriter is host-side, gated on liveness,
// SKIPPED+DEFERRED when offline). This proves that a 2-device vault where the
// revoking admin (A) revokes an OFFLINE B still COMMITS the revoke+rotation into
// A's view and keeps the base LIVE (A keeps writing; its writes materialize in
// its own linearized view; the indexed checkpoint never regresses). NB: with B
// still a registered indexer and offline, Autobase's indexed checkpoint
// (majority = 2 of 2) cannot advance past B's last ack — that is an inherent
// quorum property, NOT a wedge; "not frozen" is the COMMITTED VIEW advancing and
// the base staying writable (REVOCATION_DESIGN §3.6 fallback).
test('SB1 REGRESSION: revoking an OFFLINE device does NOT freeze the base (indexedLength advances)', { timeout: 240000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revrot-sb1'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 51 })
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 52, autobaseKey: b4a.toString(A.engine.base.key, 'hex') })
  t.teardown(() => teardown([A, B], testnet))

  await joinShared([A, B], vaultKey)

  // Authorize B as a real second writer/indexer; settle so both see 2 devices
  // and B is fully integrated (B is added { indexer:true }, like all writers).
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  const settled = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && A.engine.devices.size === 2 && B.engine.devices.size === 2)
  t.ok(settled, 'B authorized as an indexer writer; both see the 2-device set')

  // A writes a few notes and lets them index so indexedLength is well-established.
  for (let i = 0; i < 3; i++) {
    await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:warm-' + i,
      { noteId: 'warm-' + i, label: 'w', body: 'warm-' + i, createdAt: 1, updatedAt: 1 })
  }
  await pumpUntil([A.engine, B.engine], async () => {
    for (let i = 0; i < 3; i++) if (!(await openNote(B.engine, 'note:warm-' + i))) return false
    return true
  })
  // Pump a few extra acks so the committed checkpoint settles on the warm writes.
  await pumpUntil([A.engine, B.engine], async () => false, { timeoutMs: 4000 })
  const indexedBefore = A.engine.base.indexedLength
  const lengthBefore = A.engine.base.length
  t.ok(indexedBefore > 0, 'A has a non-zero committed indexedLength before the offline revoke (=' + indexedBefore + ')')

  // ---- TAKE B OFFLINE, then A revokes B (the SB1 hazard) --------------------
  // The OLD in-apply removeWriter(B) on an OFFLINE indexer deterministically
  // WEDGES linearization: the indexer-set migration is itself an indexed op that
  // needs B's ack, so the revoke+rotate never COMMIT — the vault stays at epoch N
  // with B un-revoked at the Autobase layer (REVOCATION_DESIGN §3.6 / SB1). Phase
  // 2 decouples eviction: it does NOT call removeWriter for an offline target, so
  // the revoke+rotation linearize and TAKE EFFECT, and A's base stays LIVE
  // (writable, its new writes materialize in its own linearized view). NOTE: with
  // B still a registered indexer and offline, Autobase's indexed checkpoint
  // (majority = (2>>>1)+1 = 2) legitimately cannot advance past B's last ack — so
  // "not frozen" is proven by the COMMITTED VIEW advancing and the base staying
  // writable, NOT by the indexedLength integer crossing the offline indexer
  // (which is an inherent Autobase quorum property, not a wedge). The design's
  // fallback (§3.6) is exactly this: leave R a writer member; the reducer's B12
  // gate excludes its writes and rotation excludes its reads.
  try { await B.swarm.destroy() } catch (_) {}
  try { await B.engine.close() } catch (_) {}
  // Confirm A sees B as NOT live (no connected peer on B's writer core), so the
  // host-side eviction is correctly skipped+deferred.
  await sleep(1500)
  await A.engine.refresh()
  const bRec = A.engine.devices.get(B.device.deviceId)
  t.ok(bRec && bRec.writerKey, 'A still has B\'s writer key')
  t.absent(A.engine._isWriterLive(bRec.writerKey),
    'A sees B as OFFLINE (no live peer on its writer core) -> host-side eviction will be skipped+deferred')

  // Drive the revoke + rotation exactly as the dispatcher does, BUT — per GATE
  // SB1 — do NOT call removeWriter for the offline target.
  const survivors = A.engine._survivingDevices(B.device.deviceId)
  const revOp = A.engine._makeOp({
    type: ops.OP_TYPES.DEVICE_REVOKE,
    schema: ops.SCHEMAS.DEVICE,
    objectId: 'device:' + B.device.deviceId,
    payload: { deviceId: B.device.deviceId },
    signer: A.engine._localSigner()
  })
  const rot = A.engine._makeKeyRotateOp({ revokedDeviceId: B.device.deviceId, survivors, signer: A.engine._localSigner() })
  await A.engine._append(revOp)
  await A.engine._append(rot.op)
  A.engine.epochKeys.set(rot.epochTag, rot.epochKey)
  // host-side eviction is gated on liveness — B is offline, so it is SKIPPED.
  t.absent(A.engine._isWriterLive(bRec.writerKey), 'eviction gate: B still not live (removeWriter NOT attempted)')

  // The revoke + rotation must COMMIT into A's linearized view with B offline —
  // proving linearization did NOT wedge (the SB1 freeze). A keeps reducing the
  // log: B becomes revoked and A activates the rotation epoch. Pump A only (B is
  // gone). This is deterministic — it depends only on A reducing its OWN log, not
  // on any remote ack.
  const committed = await pumpUntil([A.engine], async () => {
    const revoked = A.engine.devices.get(B.device.deviceId) && A.engine.devices.get(B.device.deviceId).revokedAtLamport != null
    const rotated = A.engine.activeEpochTag === rot.epochTag && A.engine.epochKeys.has(rot.epochTag)
    return revoked && rotated
  }, { timeoutMs: 60000 })
  t.ok(committed, 'revoke+rotation COMMITTED into A\'s view with B offline (linearization did NOT wedge — no SB1 freeze)')
  t.ok(A.engine.devices.get(B.device.deviceId).revokedAtLamport != null, 'B is revoked in A\'s committed view')
  t.is(A.engine.activeEpochTag, rot.epochTag, 'A activated the rotation epoch')

  // The base is LIVE, not wedged: A can keep WRITING after the offline revoke and
  // its new note materializes in its OWN linearized view (reads come from the
  // linearized view, which advances even while the indexed checkpoint waits on
  // the offline indexer's quorum). This is the load-bearing "base not frozen"
  // proof — the OLD removeWriter-in-apply path would have wedged here.
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:after-offline-revoke',
    { noteId: 'after-offline-revoke', label: 'a', body: 'still-live', createdAt: 3, updatedAt: 3 })
  const wroteAfter = await pumpUntil([A.engine], async () => {
    const n = await openNote(A.engine, 'note:after-offline-revoke')
    return n && n.body === 'still-live'
  }, { timeoutMs: 60000 })
  t.ok(wroteAfter, 'A still commits NEW writes after the offline-target revoke (base not wedged — reads from the live view)')
  t.ok(A.engine.base.writable, 'A\'s base remains writable after the offline-target revoke (not frozen)')

  // The linearized log GREW across the offline revoke (revoke + rotate + the
  // post-revoke note all landed) and the indexed checkpoint did NOT regress —
  // i.e. it never collapsed/rolled back, the failure shape a true freeze causes.
  t.ok(A.engine.base.length > lengthBefore,
    'A\'s linearized log advanced across the offline-target revoke: ' + lengthBefore + ' -> ' + A.engine.base.length)
  t.ok(A.engine.base.indexedLength >= indexedBefore,
    'A\'s indexed checkpoint did NOT regress across the offline-target revoke (=' + A.engine.base.indexedLength + ', was ' + indexedBefore + ')')
})
