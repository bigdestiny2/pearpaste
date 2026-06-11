// Integration: live-refresh on sync (audit I-9). PROOF that the backend emits a
// debounced, PAYLOAD-LESS `view-changed` ctx event on the RECEIVER when a remote
// op materializes into its view — the signal the desktop/mobile UI subscribes to
// so a multi-device sync becomes user-visible WITHOUT a manual Refresh.
//
// THE GAP (pre-I-9): the engine materialized a remote note/clip into the view in
// ~25ms but emitted no UI-consumable content event — `_apply` emitted only
// `auth-cache-rebuilt` (a firewall-internal signal). So `ui/desktop/app.js`
// onEvent and the mobile NotesScreen/ClipsScreen only refreshed on tab-switch or
// manual Refresh. (`clip-captured` fires only from the LOCAL OS-clipboard
// monitor, so remote clip arrival shared the gap.)
//
// THE FIX asserted here: an apply pass that materializes content sets an engine
// dirty flag; the background convergence loop emits one debounced `view-changed`
// per burst carrying only an opaque monotonic {seq} — no plaintext.
//
// WHAT THIS TEST ASSERTS (over a REAL DHT pairing, no manual reconnect):
//   1. After a note is written on the inviter, the JOINER's ctx emits
//      `view-changed` once the note materializes into the joiner's view.
//   2. The emitted event payload carries NO plaintext — no note label/body, no
//      objectId/blindId/title; at most an opaque numeric seq. (relay-blindness.)
//
// Run: npx brittle test/integration/view-changed-live-refresh.test.js

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import { createPearEnd } from '../../backend/index.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-vchg-' + tag + '-')) }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Poll `pred()` (pumping the joiner's engine each tick) until it holds or we
// time out. Returns ms-since-start when it held, else null.
async function waitFor (engine, pred, { timeoutMs = 30000, every = 250 } = {}) {
  const deadline = Date.now() + timeoutMs
  const t0 = Date.now()
  while (Date.now() < deadline) {
    try { await engine.refresh() } catch (_) {}
    let v = false
    try { v = await pred() } catch (_) { v = false }
    if (v) return Date.now() - t0
    await sleep(every)
  }
  return null
}

// Does this captured payload leak ANY plaintext / content-identifying field?
// view-changed must be opaque: at most a numeric seq, never a string/object
// carrying a label, body, objectId, blindId, title, or text.
function leaksContent (payload, secrets) {
  if (payload == null) return false
  if (typeof payload !== 'object') {
    // a scalar event payload may only be a number (the opaque seq); a string
    // could carry content, so reject anything non-numeric.
    return typeof payload !== 'number'
  }
  const json = JSON.stringify(payload)
  for (const s of secrets) {
    if (s && json.includes(s)) return true
  }
  // No content-shaped keys may appear (objectId/blindId/title/body/label/text).
  for (const k of Object.keys(payload)) {
    if (/object|blind|title|body|label|text|note|clip|plain|content/i.test(k)) return true
    const v = payload[k]
    // The only allowed value shape is a number (seq). Strings/objects are content risk.
    if (typeof v !== 'number') return true
  }
  return false
}

test('receiver ctx emits a payload-less `view-changed` when a remote note materializes (I-9)', { timeout: 180000 }, async (t) => {
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

  // --- Capture EVERY view-changed event the JOINER emits, with its payload. ---
  const joinerViewChanged = []
  B.ctx.on('view-changed', (payload) => { joinerViewChanged.push(payload) })

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
  t.ok(paired && paired.ok, 'PAIR_ACCEPT resolved (joiner brought up its engine)')

  // Pairing itself may emit a view-changed on the joiner (the fresh-joiner
  // pairing-window note re-materialization). Snapshot the count AFTER pairing so
  // our assertion targets the POST-PAIR note specifically.
  const beforeCount = joinerViewChanged.length

  // --- Write a SECRET note on the inviter. Its label+body are unique tokens we
  // assert never appear in any view-changed payload. ---
  const SECRET_LABEL = 'vchg-secret-label-9f3a2b'
  const SECRET_BODY = 'vchg-secret-body-do-not-leak-7c1e8d'
  const note = await A.call('NOTE_UPSERT', { note: { label: SECRET_LABEL, body: SECRET_BODY } })
  t.ok(note && note.noteId, 'inviter wrote a secret note')
  const aLenWithNote = A.ctx.sync.base.length

  // --- The note op must replicate + materialize into the JOINER's view. We poll
  // NOTE_LIST (the convergence/reconcile loop runs on its own cadence). ---
  const noteId = note.noteId
  const listedT = await waitFor(B.ctx.sync, async () => {
    const notes = (await B.call('NOTE_LIST', {})).notes || []
    return notes.some((n) => n.id === noteId)
  }, { timeoutMs: 90000 })
  t.ok(listedT != null, 'the remote note MATERIALIZED into the joiner view (precondition for view-changed)')
  t.ok(B.ctx.sync.base.length >= aLenWithNote, 'joiner base converged to include the note op')

  // --- (1) THE I-9 ASSERTION: the joiner emitted at least one view-changed
  // AFTER the note materialized. Give the debounce (≤250ms) a moment to fire. ---
  const sawT = await waitFor(B.ctx.sync, async () => joinerViewChanged.length > beforeCount, { timeoutMs: 10000 })
  t.ok(sawT != null, 'I-9: joiner ctx emitted `view-changed` after the remote note landed in its view')
  t.ok(joinerViewChanged.length > beforeCount,
    `joiner emitted ${joinerViewChanged.length - beforeCount} view-changed event(s) for the post-pair note`)

  // --- (2) RELAY-BLINDNESS: NO view-changed payload may carry plaintext. Check
  // EVERY captured payload (pairing-window ones too) against the secret tokens
  // and content-shaped keys. ---
  const secrets = [SECRET_LABEL, SECRET_BODY, noteId, 'note:' + noteId]
  let leaked = null
  for (const p of joinerViewChanged) {
    if (leaksContent(p, secrets)) { leaked = p; break }
  }
  t.absent(leaked, 'NO view-changed payload leaks the note label/body/objectId or any content-shaped field')

  // Belt-and-braces: the payload is exactly the opaque {seq:<number>} contract.
  const last = joinerViewChanged[joinerViewChanged.length - 1]
  t.ok(last && typeof last === 'object' && typeof last.seq === 'number',
    'view-changed payload is the opaque { seq:<number> } monotonic counter (no content)')
  t.is(Object.keys(last).length, 1, 'view-changed payload has EXACTLY one key (seq) — nothing else rides along')
})
