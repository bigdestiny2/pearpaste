// Integration: PHASE 4 pairing controls over a real @hyperswarm/testnet
// (REVOCATION_DESIGN §3.8 / §5.8, RT-FIX B1).
//
// What Phase 4 adds (and what this file proves):
//   SELECTIVE-CHAIN BY DEFAULT: a pairing bootstrap delivers ONLY the active
//   epoch key. The B1 decisive property — a re-paired previously-revoked
//   device (fresh identity) cannot read content created DURING ITS REVOKED
//   INTERVAL — and the explicit grantHistory escape hatch that delivers the
//   full chain. Honest consequence (documented in _bootstrapEpochKeys):
//   vaultKey always ships (it is the system KEK every committed row is sealed
//   under), so EPOCH-0 content stays readable — costless against the real B1
//   adversary, which already holds vaultKey on disk.
//   ADMIT POLICY (N-of-M): under committed policy N=2, a DEVICE_ADD backed by
//   a single admin — including the ROOT, i.e. the lone-phrase-holder
//   self-admit — is rejected by every honest reducer; adding a second admin's
//   detached cosignature admits. Lowering the policy itself needs N sigs.
//   REVOKED-MATCH WARNING: a pairing hello whose key material matches a
//   previously-revoked device is flagged.
//
// Run (sandbox OFF — binds UDX/Hyperswarm):
//   node test/integration/revocation-pairing.test.js

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

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-revpair-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Same harness as the decisive test (index.js production wiring: unconditional
// replicate — the firewall is Phase 3's concern, exercised in
// revocation-network.test.js; here we isolate the PAIRING key-delivery and
// admit-policy semantics). `epochKeysLocal` simulates the selective bootstrap:
// the hex chain a freshly paired device received (state._epochKeysLocal is
// exactly where PAIR_ACCEPT puts it; _rebuildAuthFromView merges it).
async function makeDevice ({ tag, vaultKey, indexKey, vaultId, bootstrap, seedByte, autobaseKey, epochKeysLocal = null }) {
  const dir = tmp(tag)
  const store = new Corestore(dir)
  await store.ready()

  const scope = new LifecycleScope('revpair-' + tag)
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
      _vaultHeaderCache: headerCache,
      _epochKeysLocal: epochKeysLocal
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

async function noteEnvelope (engine, objId) {
  const obid = crypto.blindId(engine.indexKey, objId)
  return engine.view.getNoteSealed(obid)
}

async function authorize (adminEngine, addDev, writerKey, { roles = ['writer', 'reader'], cosigs = [] } = {}) {
  await adminEngine._appendDeviceAdd(
    {
      deviceId: addDev.deviceId,
      label: addDev.label,
      platform: 'test',
      signingPubkey: addDev.signingPubkey,
      boxPubkey: addDev.boxPubkey,
      roles,
      writerKey
    },
    { signer: adminEngine._localSigner(), cosigs }
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
// B1 DECISIVE: selective-chain-by-default — a re-paired previously-revoked
// device cannot read content from its revoked interval; grantHistory can.
// ---------------------------------------------------------------------------
test('B1: selective-chain bootstrap denies the revoked interval; grantHistory grants it', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revpair-b1'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 31 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 32, autobaseKey: baseKey })
  const C = await makeDevice({ tag: 'C', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 33, autobaseKey: baseKey })
  const all = [A, B, C]
  t.teardown(() => teardown(all, testnet))

  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'))
  await authorize(A.engine, C.device, b4a.toString(C.engine.base.local.key, 'hex'))
  await joinShared([A, B, C], vaultKey)
  const settled = await pumpUntil([A.engine, B.engine, C.engine], async () =>
    B.engine.base.writable && C.engine.base.writable &&
    [A.engine, B.engine, C.engine].every((e) => e.devices.size === 3),
  { timeoutMs: 120000 })
  t.ok(settled, 'A+B+C converged on the 3-device set')

  // Epoch-0 content, then C's exile: revoke C -> tag1, write n1 (the
  // revoked-interval secret), then revoke B -> tag2, write n2 (current).
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n0',
    { noteId: 'n0', label: 'n0', body: 'n0-epoch0', createdAt: 1, updatedAt: 1 })
  const rot1 = await revoke(A.engine, C.device.deviceId)
  await pumpUntil([A.engine, B.engine], async () =>
    A.engine.activeEpochTag === rot1.epochTag && B.engine.epochKeys.has(rot1.epochTag), { timeoutMs: 90000 })
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n1',
    { noteId: 'n1', label: 'n1', body: 'n1-during-C-exile', createdAt: 2, updatedAt: 2 })
  const rot2 = await revoke(A.engine, B.device.deviceId)
  await pumpUntil([A.engine], async () => A.engine.activeEpochTag === rot2.epochTag, { timeoutMs: 60000 })
  await A.engine.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, 'note:n2',
    { noteId: 'n2', label: 'n2', body: 'n2-current-epoch', createdAt: 3, updatedAt: 3 })
  await pumpUntil([A.engine], async () => !!(await openNote(A.engine, 'note:n2')), { timeoutMs: 60000 })

  // The bootstrap key chains the approver would seal (design §5.8):
  const selective = A.engine._bootstrapEpochKeys({ grantHistory: false })
  const full = A.engine._bootstrapEpochKeys({ grantHistory: true })
  t.alike(Object.keys(selective), [rot2.epochTag], 'selective bootstrap carries ONLY the active epoch key')
  t.ok(full[rot1.epochTag] && full[rot2.epochTag], 'grantHistory bootstrap carries the full rotated chain')

  // "C re-pairs": FRESH device identity (new deviceId/keys — the revoke gate
  // cannot see it, design §3.8), admitted with the SELECTIVE chain.
  const C2 = await makeDevice({
    tag: 'C2',
    vaultKey,
    indexKey,
    vaultId,
    bootstrap: testnet.bootstrap,
    seedByte: 34,
    autobaseKey: baseKey,
    epochKeysLocal: { ...selective }
  })
  all.push(C2)
  await authorize(A.engine, C2.device, b4a.toString(C2.engine.base.local.key, 'hex'))
  await joinShared([A, C2], vaultKey, { waitConnected: false })
  const c2Settled = await pumpUntil([A.engine, C2.engine], async () =>
    C2.engine.devices.size >= 3 && !!(await noteEnvelope(C2.engine, 'note:n1')) && !!(await openNote(C2.engine, 'note:n2')),
  { timeoutMs: 120000 })
  t.ok(c2Settled, 'C2 (re-paired fresh identity, selective chain) replicated the log and reads CURRENT content')

  // THE B1 DECISIVE ASSERTIONS:
  t.is((await openNote(C2.engine, 'note:n2')).body, 'n2-current-epoch', 'C2 reads content under the DELIVERED active key')
  t.absent(C2.engine.epochKeys.has(rot1.epochTag), 'C2 was never given the revoked-interval key (tag1)')
  t.absent(await openNote(C2.engine, 'note:n1'), 'B1: C2 CANNOT read content created during its revoked interval')
  t.ok(await noteEnvelope(C2.engine, 'note:n1'), '...though it replicated the (sealed) row — withheld key, not withheld bytes')
  t.is((await openNote(C2.engine, 'note:n0')).body, 'n0-epoch0',
    'HONEST: epoch-0 content stays readable (vaultKey is the system KEK and ships in every bootstrap; the B1 adversary already held it)')
  // C2 also sees the membership truth from epochs it was NOT given keys for —
  // lifecycle ops seal under epoch 0 exactly so selective-chain stays safe.
  const bOnC2 = C2.engine.devices.get(B.device.deviceId)
  t.ok(bOnC2 && bOnC2.revokedAtLamport != null,
    'C2 sees B revoked even though that revoke was minted under a withheld epoch (lifecycle ops are epoch-0-sealed)')

  // grantHistory variant: a second fresh device WITH the full chain reads n1.
  const H = await makeDevice({
    tag: 'H',
    vaultKey,
    indexKey,
    vaultId,
    bootstrap: testnet.bootstrap,
    seedByte: 35,
    autobaseKey: baseKey,
    epochKeysLocal: { ...full }
  })
  all.push(H)
  await authorize(A.engine, H.device, b4a.toString(H.engine.base.local.key, 'hex'))
  await joinShared([A, H], vaultKey, { waitConnected: false })
  const hSettled = await pumpUntil([A.engine, H.engine], async () =>
    !!(await openNote(H.engine, 'note:n1')) && !!(await openNote(H.engine, 'note:n2')), { timeoutMs: 120000 })
  t.ok(hSettled, 'grantHistory: a device given the FULL chain reads the historical epoch content too')
})

// ---------------------------------------------------------------------------
// Admit policy N-of-M: a lone admin (including ROOT — the phrase-holder
// self-admit) cannot admit under N=2; a cosigned add works; the policy itself
// cannot be lowered by a lone admin.
// ---------------------------------------------------------------------------
test('admit policy: lone self-admit rejected under N=2; cosigned add admits; lone downgrade rejected', { timeout: 360000 }, async (t) => {
  const vaultKey = crypto.randomBytes(crypto.KEY_BYTES)
  const indexKey = crypto.randomBytes(32)
  const vaultId = 'revpair-admit'
  const testnet = await createTestnet(3)

  const A = await makeDevice({ tag: 'A', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 41 })
  const baseKey = b4a.toString(A.engine.base.key, 'hex')
  const B = await makeDevice({ tag: 'B', vaultKey, indexKey, vaultId, bootstrap: testnet.bootstrap, seedByte: 42, autobaseKey: baseKey })
  t.teardown(() => teardown([A, B], testnet))

  // B is a SECOND ADMIN (the N=2 precondition).
  await authorize(A.engine, B.device, b4a.toString(B.engine.base.local.key, 'hex'), { roles: ['admin', 'writer', 'reader'] })
  await joinShared([A, B], vaultKey)
  const settled = await pumpUntil([A.engine, B.engine], async () =>
    B.engine.base.writable && A.engine.devices.size === 2 && B.engine.devices.size === 2, { timeoutMs: 120000 })
  t.ok(settled, 'A+B (both admins) converged')
  t.is(A.engine._effectiveAdmitN(), 1, 'default policy is N=1 (legacy single-approver)')

  // Raise the policy to N=2 — cosigned by B (gathered out-of-band).
  const policyCosig = B.engine.cosignAdmitPolicy(2)
  await A.engine.setAdmitPolicy(2, [policyCosig])
  const policySet = await pumpUntil([A.engine, B.engine], async () =>
    A.engine.admitPolicyN === 2 && B.engine.admitPolicyN === 2, { timeoutMs: 60000 })
  t.ok(policySet, 'admit policy N=2 committed on both admins')
  t.is(A.engine._effectiveAdmitN(), 2, 'effective N is 2 with two live admins')

  // LONE SELF-ADMIT (the B1/L3 hole): A — who is ROOT, the strongest single
  // authority — appends a DEVICE_ADD for a new device with NO cosig.
  const evil = identity.createDeviceIdentity({ label: 'evil', platform: 'test', seed: b4a.alloc(32, 43) })
  await authorize(A.engine, evil, b4a.toString(crypto.randomBytes(32), 'hex'))
  await pumpUntil([A.engine, B.engine], async () => false, { timeoutMs: 5000 }) // settle
  t.absent(A.engine.devices.get(evil.deviceId), 'lone (root) self-admit REJECTED by the reducer under N=2 — on A itself')
  t.absent(B.engine.devices.get(evil.deviceId), '...and on B')

  // The same add WITH B's cosignature over the exact identity tuple admits.
  const good = identity.createDeviceIdentity({ label: 'good', platform: 'test', seed: b4a.alloc(32, 44) })
  const goodRec = {
    deviceId: good.deviceId,
    label: good.label,
    platform: 'test',
    signingPubkey: good.signingPubkey,
    boxPubkey: good.boxPubkey,
    roles: ['writer', 'reader'],
    writerKey: b4a.toString(crypto.randomBytes(32), 'hex')
  }
  const cosig = B.engine.cosignDeviceAdd(goodRec)
  await authorize(A.engine, good, goodRec.writerKey, { cosigs: [cosig] })
  const admitted = await pumpUntil([A.engine, B.engine], async () =>
    A.engine.devices.get(good.deviceId) && B.engine.devices.get(good.deviceId), { timeoutMs: 60000 })
  t.ok(admitted, 'the SAME add WITH a second admin cosignature is admitted on both')

  // A cosignature gathered for one device cannot be replayed onto another.
  const evil2 = identity.createDeviceIdentity({ label: 'evil2', platform: 'test', seed: b4a.alloc(32, 45) })
  await authorize(A.engine, evil2, b4a.toString(crypto.randomBytes(32), 'hex'), { cosigs: [cosig] })
  await pumpUntil([A.engine, B.engine], async () => false, { timeoutMs: 5000 })
  t.absent(A.engine.devices.get(evil2.deviceId), 'a cosig for one device does NOT admit a different device (tuple-bound)')

  // A lone admin cannot LOWER the policy back to 1 (the trivial bypass).
  let threwOrIgnored = true
  try {
    await A.engine.setAdmitPolicy(1) // no cosigs
  } catch (_) { /* client-side may throw; reducer-side must reject regardless */ }
  await pumpUntil([A.engine, B.engine], async () => false, { timeoutMs: 5000 })
  threwOrIgnored = A.engine.admitPolicyN === 2 && B.engine.admitPolicyN === 2
  t.ok(threwOrIgnored, 'lone downgrade N=2→1 REJECTED — the policy change itself needs N signatures')

  // With B's cosig the downgrade goes through (legitimate two-admin decision).
  const downCosig = B.engine.cosignAdmitPolicy(1)
  await A.engine.setAdmitPolicy(1, [downCosig])
  const lowered = await pumpUntil([A.engine, B.engine], async () =>
    A.engine.admitPolicyN === 1 && B.engine.admitPolicyN === 1, { timeoutMs: 60000 })
  t.ok(lowered, 'cosigned downgrade commits on both admins')

  // Revoked-match warning heuristic (design §3.8 step 3): key material reuse
  // from a revoked device is flagged; fresh material is not.
  const rot = await revoke(A.engine, B.device.deviceId)
  await pumpUntil([A.engine], async () => A.engine.activeEpochTag === rot.epochTag, { timeoutMs: 60000 })
  const match = A.engine.matchesRevokedDevice({ boxPubkey: B.device.boxPubkey })
  t.ok(match && match.deviceId === B.device.deviceId, 'a hello reusing a revoked device\'s box pubkey is flagged')
  t.is(A.engine.matchesRevokedDevice({ boxPubkey: good.boxPubkey }), null, 'fresh key material is not flagged')
})
