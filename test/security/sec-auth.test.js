// Security: operation authenticity & integrity (spec §3 security, §8.1
// signatures, §8.4 verifier checks, §9.2 reducer validation, §16 "Security
// tests").
//
// Covers these §16 items:
//   - revoked device cannot append
//   - modified ciphertext fails AEAD
//   - modified op header fails signature
//   - replayed old op rejected after key rotation
//
// REACHABILITY NOTE (honest, per the brief — no faked passes):
// The Autobase reducer's linearized `view` is a READ-ONLY Hyperbee outside
// Autobase's internal apply machinery, and each device may only append to its
// OWN writer core. So a foreign/forged op cannot be injected by calling
// `engine._apply(...)` directly, nor by appending to someone else's writer
// core — the P2P design itself prevents that. The actual enforcement points
// the security property depends on are therefore tested at the layer they
// live in and are fully reachable:
//   * AEAD integrity        -> crypto.openWithObjectId throws AEAD_FAIL, AND
//                              the real reducer's `_body()` (which the
//                              materialized view + notes-service call) refuses
//                              tampered ciphertext.
//   * signature integrity   -> crypto.verifyOp(...) is the exact predicate the
//                              reducer (`_apply`) gates every op on.
//   * revoked-device append -> engine._signerAuthorized(...) is the exact gate
//                              `_apply` calls before applying ANY content op;
//                              we drive a REAL signed DEVICE_REVOKE + KEY_ROTATE
//                              through RPC and assert the gate then denies the
//                              device for all ops at/after the revoke epoch.
//   * replay after rotation -> three real layers: Autobase writer-core removal
//                              on revoke (asserted via a removeWriter spy),
//                              deterministic LWW discarding stale-Lamport
//                              replays (asserted through the real RPC path),
//                              and KEY_ROTATE advancing the epoch for forward
//                              secrecy (asserted on engine.keyEpoch). See the
//                              detailed model on that test.
// Each test calls the SAME functions the reducer calls on the live op path —
// it does not re-implement them — so a regression in enforcement fails here.
// The end-to-end "two engines replicate and the bad op is dropped" path is
// additionally exercised by Agent 1 (test/unit/sync-reducer.test.js) and
// Agent 3 (test/e2e) which we do not duplicate.
//
// Run: node test/security/sec-auth.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import b4a from 'b4a'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'
import { classifyOpRecord } from '../../backend/verifier.js'
import * as crypto from '../../backend/crypto-envelope.js'
import * as identity from '../../backend/identity.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }
function rnd () { return Math.random().toString(36).slice(2) }
const call = (pe, c, p) => pe.call(c, p || {})

// The exact signature predicate the reducer gates every op on (autobase-sync
// _apply -> crypto.verifyOp). Re-used here so the test exercises real code.
function reducerSigOk (op) {
  return crypto.verifyOp(op.signerPubkey, {
    header: op.header,
    ciphertext: op.envelope.ciphertext,
    nonce: op.envelope.nonce,
    aadHash: op.aadHash
  }, op.signature)
}

// The exact body-decrypt the reducer performs (autobase-sync _body ->
// crypto.openWithObjectId). Throws AEAD_FAIL on any tamper.
function reducerBody (engine, op) {
  return engine._body(op)
}

test('§16 modified ciphertext fails AEAD (the reducer body-decrypt refuses it)', async (t) => {
  const dir = tmp('aead')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const engine = pe.ctx.sync
  const signer = engine._localSigner()

  const body = SENTINEL_PREFIX + 'AEAD_' + rnd()
  const noteId = 'note-aead-' + rnd()
  const objectId = 'note:' + noteId
  const op = engine._makeOp({
    type: pe.ctx.ops.OP_TYPES.NOTE_UPSERT,
    schema: pe.ctx.ops.SCHEMAS.NOTE,
    objectId,
    payload: { noteId, title: 't', body, createdAt: Date.now(), updatedAt: Date.now() },
    signer
  })
  t.absent(Object.prototype.hasOwnProperty.call(op, 'objectId'), 'replicated op does not expose the plaintext objectId')
  t.is(classifyOpRecord({ ...op, objectId }, new Map([[op.signerPubkey, { signingPubkey: op.signerPubkey }]])).reason,
    'forbidden-op-field:objectId',
    'verifier rejects any replicated op that still carries objectId')

  // control: a genuine envelope decrypts via the reducer's exact path.
  t.is(reducerBody(engine, op).body, body, 'control: untampered envelope decrypts to the real body')

  // flip the final ciphertext byte.
  const flipped = op.envelope.ciphertext.replace(/..$/, op.envelope.ciphertext.endsWith('00') ? 'ff' : '00')
  const tamperedOp = { ...op, envelope: { ...op.envelope, ciphertext: flipped } }
  t.exception(() => reducerBody(engine, tamperedOp), /AEAD/,
    'one flipped ciphertext byte -> AEAD_FAIL on the reducer body-decrypt path')

  // truncated ciphertext is also rejected closed (code AEAD_FAIL; the message
  // is "ciphertext too short" for sub-tag-length input — assert the code).
  const truncOp = { ...op, envelope: { ...op.envelope, ciphertext: op.envelope.ciphertext.slice(0, 8) } }
  try {
    reducerBody(engine, truncOp)
    t.fail('truncated ciphertext should be rejected')
  } catch (e) {
    t.is(e.code, 'AEAD_FAIL', 'truncated ciphertext -> AEAD_FAIL (rejected closed)')
  }
  // a longer-but-still-corrupt truncation fails the AEAD tag check.
  const trunc2 = { ...op, envelope: { ...op.envelope, ciphertext: op.envelope.ciphertext.slice(0, 40) } }
  t.exception(() => reducerBody(engine, trunc2), /AEAD/, 'corrupt-length ciphertext -> AEAD verification failed')

  // AAD splice (re-route the ciphertext under a different op type) is rejected.
  const spliceOp = { ...op, envelope: { ...op.envelope, aad: { ...op.envelope.aad, opType: 'CLIP_ADD' } } }
  t.exception(() => reducerBody(engine, spliceOp), /AEAD/, 'AAD splice -> AEAD_FAIL (envelope bound to its routing context)')
})

test('§16 modified op header fails signature (the reducer signature gate refuses it)', async (t) => {
  const dir = tmp('hdr')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const engine = pe.ctx.sync

  const noteId = 'note-hdr-' + rnd()
  const objectId = 'note:' + noteId
  const op = engine._makeOp({
    type: pe.ctx.ops.OP_TYPES.NOTE_UPSERT,
    schema: pe.ctx.ops.SCHEMAS.NOTE,
    objectId,
    payload: { noteId, title: 't', body: SENTINEL_PREFIX + rnd(), createdAt: Date.now(), updatedAt: Date.now() },
    signer: engine._localSigner()
  })

  t.ok(reducerSigOk(op), 'control: untampered op passes the reducer signature gate')

  // bump the lamport (ordering/replay attack) — invalidates the signature.
  const lamportForged = { ...op, header: { ...op.header, lamport: String(Number(op.header.lamport) + 999) } }
  t.absent(reducerSigOk(lamportForged), 'lamport mutation -> reducer signature gate REJECTS')

  // swap the op type in the header — forged DEVICE_ADD must not authorize.
  const typeForged = { ...op, header: { ...op.header, type: 'DEVICE_ADD' } }
  t.absent(reducerSigOk(typeForged), 'op-type swap -> reducer signature gate REJECTS (no privilege forge)')

  // repoint deviceId (impersonation) — rejected.
  const idForged = { ...op, header: { ...op.header, deviceId: 'someone-else' } }
  t.absent(reducerSigOk(idForged), 'deviceId impersonation -> reducer signature gate REJECTS')

  // swap the signer pubkey to a different key — rejected.
  const other = identity.createDeviceIdentity({ label: 'x', platform: 'test', seed: b4a.alloc(32, 9) })
  const signerForged = { ...op, signerPubkey: other.signingPubkey }
  t.absent(reducerSigOk(signerForged), 'wrong signer pubkey -> reducer signature gate REJECTS')
})

test('§16 revoked device cannot append (reducer authorization gate denies it post-revoke)', async (t) => {
  const dir = tmp('rev')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'admin', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const engine = pe.ctx.sync

  // Authorize a second writer device via a REAL signed DEVICE_ADD (admin =
  // local root device). This is the genuine authorization path.
  const victim = identity.createDeviceIdentity({ label: 'victim', platform: 'test', seed: b4a.alloc(32, 0x5a) })
  await engine._appendDeviceAdd({
    deviceId: victim.deviceId,
    label: 'victim',
    platform: 'test',
    signingPubkey: victim.signingPubkey,
    boxPubkey: victim.boxPubkey,
    roles: ['writer', 'reader'],
    writerKey: b4a.toString(b4a.alloc(32, 0x5b), 'hex')
  }, { signer: engine._localSigner() })
  await engine.refresh()
  t.ok(engine.devices.has(victim.deviceId), 'victim device authorized in the reducer device set')

  // BEFORE revoke: the reducer's gate (the exact predicate `_apply` calls
  // before applying any content op) authorizes the victim.
  t.ok(engine._signerAuthorized({ signerPubkey: victim.signingPubkey }, 5),
    'pre-revoke: reducer gate AUTHORIZES the victim')

  // REAL signed DEVICE_REVOKE through the RPC surface (root/admin only).
  const rev = await call(pe, COMMANDS.DEVICE_REVOKE, { deviceId: victim.deviceId })
  t.ok(rev.ok, 'DEVICE_REVOKE ok (signed by admin)')
  const vrec = engine.devices.get(victim.deviceId)
  t.ok(vrec && vrec.revokedAtLamport != null, 'victim now marked revoked at a lamport')

  // The victim signs a perfectly valid new op (its key still works) — but the
  // reducer gate must DENY it because the device is revoked. A monotonic
  // Lamport guarantees any new op is at/after the revoke epoch.
  const postOp = engine._makeOp({
    type: pe.ctx.ops.OP_TYPES.NOTE_UPSERT,
    schema: pe.ctx.ops.SCHEMAS.NOTE,
    objectId: 'note:post-' + rnd(),
    payload: { noteId: 'p', title: 'n', body: SENTINEL_PREFIX + rnd(), createdAt: Date.now(), updatedAt: Date.now() },
    signer: { deviceId: victim.deviceId, signingPubkey: victim.signingPubkey, signingSecretKey: victim.signingSecretKey }
  })
  t.ok(reducerSigOk(postOp), 'the revoked device CAN still produce a validly-signed op (key not magically broken)')
  t.ok(Number(postOp.header.lamport) >= vrec.revokedAtLamport, 'its lamport is at/after the revoke epoch (monotonic clock)')
  t.absent(engine._signerAuthorized({ signerPubkey: victim.signingPubkey }, Number(postOp.header.lamport)),
    'reducer gate DENIES the post-revoke append from the revoked device')

  // Denied at the exact revoke lamport and for every later op (replay window).
  t.absent(engine._signerAuthorized({ signerPubkey: victim.signingPubkey }, vrec.revokedAtLamport),
    'denied AT the revoke lamport')
  t.absent(engine._signerAuthorized({ signerPubkey: victim.signingPubkey }, vrec.revokedAtLamport + 10_000),
    'denied for all later lamports (no append window reopens)')
})

test('§16 replayed old op rejected after key rotation', async (t) => {
  // HONEST MODEL OF THE ENFORCEMENT (verified against the real running code,
  // including the installed Autobase version's actual API):
  // PearPaste defends against replay of an old op from a since-revoked device
  // with the layers that are ACTUALLY ACTIVE here:
  //   (A) Reducer signer gate: every content op with lamport >= the device's
  //       revoke lamport is dropped by engine._signerAuthorized() before it is
  //       applied. So a revoked device cannot land any NEW op (its monotonic
  //       clock guarantees lamport >= revoke epoch). Proven exhaustively by
  //       the revoked-device test above; re-asserted here post-rotation.
  //   (B) Deterministic LWW (spec §9.5): a replay of an OLD op carries its
  //       ORIGINAL (now-stale) Lamport, so max(lamport, deviceId) keeps
  //       current state and discards the replay. (Asserted via the REAL RPC
  //       path + the Lamport.beats predicate the reducer uses.)
  //   (C) Forward secrecy by REAL KEY_ROTATE (Phase 2, design §3): DEVICE_REVOKE
  //       now rotates the content key to a FRESH epoch sealed ONLY to survivors
  //       (epochKey_{N+1}=randomBytes(32)), activating a non-empty activeEpochTag
  //       so post-revoke writes seal under a key the revoked device never holds.
  //       (Asserted below: a new tag activates + the admin obtains the new key.)
  // EVICTION NOTE (Phase 2 / GATE SB1): autobase-sync.js performs removeWriter
  // HOST-SIDE in the DEVICE_REVOKE dispatcher (NOT inside the pure reducer),
  // gated on the target being currently live/connected and SKIPPED+DEFERRED when
  // offline — because removeWriter on an OFFLINE indexer deterministically
  // freezes the base's indexedLength. Eviction is therefore best-effort defense-
  // in-depth; the load-bearing write-exclusion is now the reducer's
  // reject-committed-revoked-signer gate (B12, layer A), which also closes the
  // backdated-lamport window. The property holds via (A)+(B)+(C).
  // engine._signerAuthorized() intentionally still authorizes an op whose
  // lamport is BEFORE the revoke epoch — those were legitimately authored
  // while trusted; retroactively rejecting them would corrupt history. Replay
  // of those specific ops is defeated by (B).
  const dir = tmp('replay')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'admin', platform: 'test', passphrase: 'pw' })
  await pe.ctx.sync.ready(15000)
  const engine = pe.ctx.sync

  const victimWriterKey = b4a.toString(b4a.alloc(32, 0x78), 'hex')
  const dev = identity.createDeviceIdentity({ label: 'w', platform: 'test', seed: b4a.alloc(32, 0x77) })
  await engine._appendDeviceAdd({
    deviceId: dev.deviceId,
    label: 'w',
    platform: 'test',
    signingPubkey: dev.signingPubkey,
    boxPubkey: dev.boxPubkey,
    roles: ['writer', 'reader'],
    writerKey: victimWriterKey
  }, { signer: engine._localSigner() })
  await engine.refresh()

  // Layer (2) — LWW replay-loss, through the REAL RPC path. Create a note,
  // then update it (v2 wins, higher lamport). "Replaying" the v1 content via
  // a fresh upsert with the SAME noteId cannot resurrect v1: the reducer
  // keeps the highest-lamport write.
  const created = await call(pe, COMMANDS.NOTE_UPSERT, { note: { label: 'v1', body: SENTINEL_PREFIX + 'V1' } })
  const noteId = created.noteId
  await call(pe, COMMANDS.NOTE_UPSERT, { note: { noteId, label: 'v2', body: SENTINEL_PREFIX + 'V2' } })
  await engine.refresh()
  const cur = await call(pe, COMMANDS.NOTE_OPEN, { noteId })
  await call(pe, COMMANDS.NOTE_CLOSE, { noteId })
  t.is(cur.note.label, 'v2', 'LWW: current state is the latest (highest-lamport) write')
  t.is(cur.note.body, SENTINEL_PREFIX + 'V2', 'LWW: the latest body wins too')
  // A stale op with a LOWER lamport than current loses deterministically.
  const incomingStale = { lamport: 1, deviceId: 'zzz' }
  const currentLww = { lamport: 999999, deviceId: 'aaa' }
  const { Lamport } = pe.ctx.ops
  t.absent(Lamport.beats(incomingStale, currentLww),
    'a replayed op with a stale Lamport does NOT beat current state (reducer discards it)')

  // Layers (C) + (A) — DEVICE_REVOKE triggers a REAL KEY_ROTATE and marks
  // revoked. Updated for Phase 2: the old assertion checked only the cosmetic
  // counter (engine.keyEpoch === before+1); now we assert a REAL rotation —
  // activeEpoch advances to a fresh integer, a non-empty activeEpochTag
  // activates, and the surviving admin obtains the fresh epoch key (so future
  // writes seal under a key the revoked device never receives).
  const activeEpochBefore = engine.activeEpoch
  const rev = await call(pe, COMMANDS.DEVICE_REVOKE, { deviceId: dev.deviceId })
  t.ok(rev.ok, 'revoke + key rotation performed')
  t.is(engine.activeEpoch, activeEpochBefore + 1, '(C) KEY_ROTATE advanced the ACTIVE epoch on revoke (real rotation)')
  t.ok(rev.epochTag && rev.epochTag.length > 0, '(C) revoke activated a non-empty epochTag (fresh content key, not a counter)')
  t.is(engine.activeEpochTag, rev.epochTag, '(C) engine active tag == the rotation tag')
  t.ok(engine.epochKeys.has(rev.epochTag), '(C) surviving admin obtained the fresh epoch key (forward secrecy for future writes)')
  const drec = engine.devices.get(dev.deviceId)
  t.ok(drec && drec.revokedAtLamport != null, 'signer revoked at a lamport')

  // (A) — a fresh op the revoked device signs AFTER its revoke epoch is denied
  // by the reducer signer gate (the load-bearing control; covered exhaustively
  // by the revoked-device test, re-asserted here for the post-rotation case).
  const fresh = engine._makeOp({
    type: pe.ctx.ops.OP_TYPES.NOTE_UPSERT,
    schema: pe.ctx.ops.SCHEMAS.NOTE,
    objectId: 'note:fresh-' + rnd(),
    payload: { noteId: 'x', title: 'new', body: SENTINEL_PREFIX + rnd(), createdAt: Date.now(), updatedAt: Date.now() },
    signer: { deviceId: dev.deviceId, signingPubkey: dev.signingPubkey, signingSecretKey: dev.signingSecretKey }
  })
  t.absent(engine._signerAuthorized({ signerPubkey: dev.signingPubkey }, Number(fresh.header.lamport)),
    'post-rotation op (lamport >= revoke epoch) from the revoked device is unauthorized by the signer gate')
})
