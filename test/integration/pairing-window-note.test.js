// Integration: the WHOLE pairing-window data-loss saga, end to end (audit
// I-15 + I-16). This is the proof that I-15 (pairing-conn teardown so first
// sync isn't starved) and I-16 (fresh-joiner view materialization) TOGETHER
// close the pairing-window note loss.
//
// THE SAGA: a note written on the inviter immediately after pairing was
// permanently missing on the freshly-paired joiner. Two distinct bugs stacked:
//   I-15 — the stale `pairing` connection short-circuited BEFORE the replication
//          firewall, so store.replicate never ran on it; Hyperswarm's per-pubkey
//          dedup then blocked any REPLICATING redial for the life of that conn.
//          The note op never even reached the joiner's base. (Fixed: tear the
//          pairing conn down after bootstrap so the vault-topic redial replicates.)
//   I-16 — once replication was unblocked the note op DID replicate into the
//          joiner's base (base.length converged, op within indexedLength), and
//          the joiner's reducer even decrypted + materialized it — but adding the
//          fresh joiner as an Autobase indexer re-checks-out the view at the new
//          indexedLength and ASYNCHRONOUSLY rolls that just-materialized row back
//          out. Because the op is now below indexedLength, _apply never revisits
//          it, so the row stayed gone forever and NOTE_LIST read 0. The existing
//          durability reconciler (_pendingDurable) healed this for the LOCAL
//          writer's own rows but was populated only in appendOp — a receiver that
//          never appended had nothing to re-materialize. (Fixed: register
//          RECEIVED additive content ops into the same reconciler, gated so it
//          never resurrects a deleted row or re-admits a committed-revoked signer.)
//
// WHAT THIS TEST ASSERTS — the user-visible end state I-15 + I-16 must deliver:
// after a REAL DHT pairing (no manual reconnect) and a note written on the
// inviter right after pairing, that note appears in the JOINER's NOTE_LIST,
// DECRYPTED and READABLE (its label), not merely present as a base op or a
// "Sealed" placeholder. RED on current main (I-15 lands the op in the base but
// I-16 leaves NOTE_LIST at 0); GREEN once the receiver-side materialization heals
// the rolled-back row.
//
// Run: npx brittle test/integration/pairing-window-note.test.js

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import { createPearEnd } from '../../backend/index.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-pairwin-' + tag + '-')) }
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

test('a note written right after pairing is READABLE in the joiner NOTE_LIST (I-15 + I-16)', { timeout: 180000 }, async (t) => {
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
  const note = await A.call('NOTE_UPSERT', { note: { label: 'pairing-window', body: 'written-right-after-pairing' } })
  t.ok(note && note.noteId, 'inviter wrote a note right after pairing')
  const aLenWithNote = A.ctx.sync.base.length
  t.ok(aLenWithNote > 0, 'inviter base advanced to include the post-pair note op')

  // --- I-15 territory: replication starts + base converges (the note op
  // reaches the joiner's base). Asserted here only as the PRECONDITION for the
  // I-16 check below; pairing-first-sync.test.js owns these in detail.
  const convergedT = await waitFor(B.ctx.sync, () => {
    const bl = B.ctx.sync.base ? B.ctx.sync.base.length : 0
    return bl >= aLenWithNote
  }, { timeoutMs: 40000 })
  t.ok(convergedT != null, 'joiner base converged to include the post-pair note op (I-15: replication unblocked)')
  t.ok(B.ctx.sync.devices.size >= 2, 'joiner committed-device set converged to include both devices')

  // --- THE I-16 ASSERTION (load-bearing): the note must MATERIALIZE into the
  // joiner's queryable view and be READABLE. Pre-fix, base.length converged
  // (above) but the fresh-joiner indexer migration rolled the row back out and
  // it never returned, so NOTE_LIST stayed 0. Post-fix, the receiver-side
  // durability reconciler re-materializes the rolled-back row. Poll NOTE_LIST
  // (the convergence/reconcile loop runs on its own cadence; the re-append +
  // settle can take a few seconds) until the inviter's note appears, decrypted.
  const noteId = note.noteId
  const listedT = await waitFor(B.ctx.sync, async () => {
    const notes = (await B.call('NOTE_LIST', {})).notes || []
    return notes.some((n) => n.id === noteId)
  }, { timeoutMs: 60000 })
  t.ok(listedT != null, 'I-16: the post-pair note MATERIALIZED into the joiner NOTE_LIST (receiver-side heal recovered the migration-rolled-back row)')

  const joinerNotes = (await B.call('NOTE_LIST', {})).notes || []
  const row = joinerNotes.find((n) => n.id === noteId)
  t.ok(row, 'joiner NOTE_LIST contains the post-pair note by id')
  t.is(row && row.label, 'pairing-window', 'the joiner reads the note label DECRYPTED (not a sealed placeholder)')

  // And NOTE_OPEN must decrypt the full body — the end-to-end readability proof.
  const opened = await B.call('NOTE_OPEN', { noteId })
  t.is(opened && opened.note && opened.note.body, 'written-right-after-pairing',
    'joiner NOTE_OPEN decrypts the full note body written during the pairing window')
})
