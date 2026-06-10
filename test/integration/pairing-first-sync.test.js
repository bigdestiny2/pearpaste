// Integration: post-pairing FIRST SYNC over REAL Hyperswarm (audit I-15).
//
// THE BUG (I-15, "pairing-window first-sync starvation"): the pairing
// connection is classified `pairing` for its whole life — index.js
// short-circuits it BEFORE the replication firewall, so store.replicate(conn)
// never runs on it. Hyperswarm dedups on remotePublicKey, so while that raw
// pairing conn lives the vault-topic join can NEVER produce a second,
// REPLICATING connection. Net effect on the freshly-paired joiner: writable
// stays false and store.replicate stays 0/0 for the lifetime of the stale conn
// (30s+), so a note written on the inviter right after pairing never syncs.
//
// THE FIX (this branch): once the bootstrap exchange flushes, BOTH ends end the
// pairing conn (joiner after openBootstrap + saveLocalDevice + engine bring-up +
// fast-path ack; approver once the join confirms / on peer close). Hyperswarm
// then redials via the vault topic, the firewall admits the fresh joiner
// (verdict `bootstrap` — no committed device set yet, so the redial
// re-authenticates; security model unchanged), and replication begins in ~ms.
//
// WHAT THIS TEST ASSERTS — the level I-15 controls: with NO manual reconnect,
// after a real pairing the joiner's replication starts (firewall admits it),
// the joiner becomes writable, and its autobase base converges to the inviter's
// length INCLUDING the op for a note written right after pairing.
//
// SCOPE BOUNDARY (deliberately NOT asserted here): the verifier observed — and
// this branch confirms — that once replication is unblocked the base + device
// set fully converge, yet a freshly-paired joiner's NOTE_LIST can still read 0:
// a SEPARATE fresh-joiner view/epoch-key materialization gap (audit I-16). That
// is out of I-15's scope; I-15 governs replication / writability / base
// convergence, and this test asserts exactly those. The note op IS present in
// the joiner's replicated base (proven via base-length convergence) — what I-16
// must still fix is materializing it into the joiner's queryable view.
//
// Run: npx brittle test/integration/pairing-first-sync.test.js

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import { createPearEnd } from '../../backend/index.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-firstsync-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Poll `pred()` (pumping the joiner's engine each tick) until it holds or we
// time out. Returns ms-since-start when it held, else null.
async function waitFor (engine, pred, { timeoutMs = 30000, every = 250 } = {}) {
  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  while (Date.now() < deadline) {
    try { await engine.refresh() } catch (_) {}
    let v = false
    try { v = await pred() } catch (_) { v = false }
    if (v) return Date.now() - t0
    await sleep(every)
  }
  return null
}

test('a note written right after pairing replicates to the new device with NO manual reconnect (I-15)', { timeout: 180000 }, async (t) => {
  const testnet = await createTestnet(3)
  const dirA = tmp('inviter')
  const dirB = tmp('joiner')

  const A = await createPearEnd({
    storagePath: dirA,
    relayClientFactory: false,
    swarm: new Hyperswarm({ bootstrap: testnet.bootstrap })
  })
  const B = await createPearEnd({
    storagePath: dirB,
    relayClientFactory: false,
    swarm: new Hyperswarm({ bootstrap: testnet.bootstrap })
  })
  t.teardown(async () => {
    try { await A.close() } catch (_) {}
    try { await B.close() } catch (_) {}
    try { fs.rmSync(dirA, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(dirB, { recursive: true, force: true }) } catch (_) {}
    try { await testnet.destroy() } catch (_) {}
  })

  // --- Inviter: real vault, ready engine, pending invite ---
  await A.call('CREATE_VAULT', { label: 'inviter', platform: 'test', passphrase: 'pw' })
  await A.ctx.sync.ready(15000)

  let approvalReq = null
  const gotApproval = new Promise((resolve) => A.ctx.on('pair-approval-needed', (r) => { approvalReq = r; resolve(r) }))

  const inv = await A.call('PAIR_CREATE_INVITE', { ttlMs: 150000 })
  t.ok(inv && typeof inv.invite === 'string', 'inviter produced an invite payload')

  // --- Joiner: PAIR_ACCEPT in flight; inviter approves on the prompt ---
  const acceptP = B.call('PAIR_ACCEPT', {
    invite: inv.invite,
    label: 'joiner',
    platform: 'test',
    unlockSecret: 'pw-joiner'
  })
  await Promise.race([
    gotApproval,
    sleep(90000).then(() => { throw new Error('inviter never saw a pairing approval request — DHT connect failed') })
  ])
  await A.call('PAIR_APPROVE', { requestId: approvalReq.requestId })
  const paired = await acceptP
  t.ok(paired && paired.ok, 'PAIR_ACCEPT resolved (joiner persisted vault keys + brought up the engine)')

  // --- Write a note on the inviter IMMEDIATELY after pairing. No reconnect. ---
  const note = await A.call('NOTE_UPSERT', { note: { label: 'i15-first-sync', body: 'written-right-after-pairing' } })
  t.ok(note && note.noteId, 'inviter wrote a note right after pairing')
  // The inviter's own base advances to include the note op.
  const aLenWithNote = A.ctx.sync.base.length
  t.ok(aLenWithNote > 0, 'inviter base advanced to include the post-pair note op')

  // --- I-15 assertion 1: replication actually STARTS on the joiner (the
  // firewall admits the redialed peer — verdict `bootstrap`). Pre-fix this
  // counter stayed 0 forever because the stale pairing conn never reached the
  // firewall and Hyperswarm's dedup blocked any replicating redial.
  const repdT = await waitFor(B.ctx.sync, () => {
    const s = B.ctx.replicationFirewall.stats
    return (s.bootstrapAllowed + s.allowed) > 0
  }, { timeoutMs: 30000 })
  t.ok(repdT != null, 'joiner replication began without a manual reconnect (firewall admitted the vault-topic redial)')
  t.is(B.ctx.replicationFirewall.stats.refusedRevoked, 0, 'the redial was NOT refused as revoked (security posture unchanged — fresh joiner admitted via bootstrap)')

  // --- I-15 assertion 2: the joiner becomes a writer (its seat linearizes only
  // once the authorizing DEVICE_ADD replicates back — impossible while starved).
  const writableT = await waitFor(B.ctx.sync, () => !!(B.ctx.sync.base && B.ctx.sync.base.writable), { timeoutMs: 30000 })
  t.ok(writableT != null, 'joiner became writable without a manual reconnect (writer seat linearized)')

  // --- I-15 assertion 3: the joiner's base CONVERGES to the inviter's length,
  // INCLUDING the post-pair note op. This is the load-bearing check: it proves
  // the note that was written right after pairing actually replicated into the
  // joiner's autobase log over the auto-redialed stream.
  const convergedT = await waitFor(B.ctx.sync, () => {
    const bl = B.ctx.sync.base ? B.ctx.sync.base.length : 0
    return bl >= aLenWithNote
  }, { timeoutMs: 30000 })
  t.ok(convergedT != null, 'joiner base converged to >= the inviter base length that contains the post-pair note (the note op replicated, no manual reconnect)')

  // Device set converged too (committed membership reached the joiner).
  t.ok(B.ctx.sync.devices.size >= 2, 'joiner committed-device set converged to include both devices')

  // --- SCOPE BOUNDARY (I-16, not asserted as pass/fail) -------------------
  // At this point replication + writability + base convergence are all healthy
  // (everything I-15 controls). A freshly-paired joiner's NOTE_LIST may STILL
  // read 0 here due to the separate view/epoch-key materialization gap (I-16):
  // the note op is in the joiner's base (asserted above via length convergence)
  // but may not yet materialize into the queryable view. We record it as a
  // diagnostic, NOT a gate, so this test stays scoped to I-15 and does not go
  // red on the I-16 boundary the verifier flagged.
  let joinerNoteCount = -1
  try { joinerNoteCount = ((await B.call('NOTE_LIST', {})).notes || []).length } catch (_) {}
  t.comment('I-16 boundary (diagnostic, not gated): joiner NOTE_LIST count = ' + joinerNoteCount +
    ' (base converged to ' + (B.ctx.sync.base ? B.ctx.sync.base.length : -1) + '/' + aLenWithNote +
    '; a 0 here is the fresh-joiner view-materialization gap I-16 must close).')
})
