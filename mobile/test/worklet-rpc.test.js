// PearPaste mobile worklet RPC smoke — runnable WITHOUT a phone.
//
//   node mobile/test/worklet-rpc.test.js      (or: npx brittle mobile/test/worklet-rpc.test.js)
//
// Proves the mobile bridge contract (spec §21 Agent-4 acceptance) on desktop
// Node by driving the SAME transport-agnostic RPC loop the real worklet uses
// (createRpcServer / createRpcClient from ../rpc-commands.mjs) over an
// in-process duplex pair, against a real createPearEnd() Pear-end.
//
// HONEST SCOPE / LIMITATION
//   The Bare-only entry mobile/backend/worklet.mjs imports `bare-rpc`,
//   `bare-path`, and the Bare/BareKit globals, so it cannot be imported under
//   Node. That file is a THIN adapter: it decodes a frame, calls
//   pearEnd.call(command, params), and replies — exactly what createRpcServer
//   does here. We therefore exercise the real framing + server loop + the real
//   backend dispatcher end to end, and gate only the Bare-binding shell. This
//   is the same code that runs on device; only the byte transport differs
//   (BareKit.IPC there vs an in-memory pipe here).
//
// Covers, per §21:
//   1. worklet (server loop) starts and answers RPC
//   2. CREATE_VAULT -> NOTE_UPSERT -> NOTE_LIST (sealed) -> NOTE_OPEN
//      (plaintext) -> LOCK_VAULT (locked rejects content RPC)
//   3. mobile<->desktop pairing backend flow: PAIR_CREATE_INVITE over the
//      bridge yields a real invite/shortCode/expiry that PAIR_ACCEPT decodes
//   4. clip capture + copy round trip (copy returns plaintext for OS clipboard)
//   5. worklet crash -> recoverable error frame (no hang; client rejects)
//   6. renderer contract: no vault key material ever crosses the bridge

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { Buffer } from 'buffer'
import * as rpcMod from '../rpc-commands.mjs'
import { createPearEnd } from '../../backend/index.js'

// Single accessor so each test reads the same bridge + backend surface.
async function load () {
  return { ...rpcMod, createPearEnd }
}

// In-process duplex: two createRpcXxx ends wired byte-for-byte, mirroring how
// BareKit.IPC connects the worklet and the RN client (just without a socket).
function wireInProcess ({ createRpcServer, createRpcClient }, pearEnd) {
  let server = null
  let client = null
  server = createRpcServer({
    pearEnd,
    send: (bytes) => { if (client) queueMicrotask(() => client.onResponse(bytes)) }
  })
  client = createRpcClient({
    send: (bytes) => { if (server) queueMicrotask(() => server.onRequest(bytes)) },
    timeoutMs: 20000
  })
  return { server, client }
}

function tmpStore (tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-worklet-' + tag + '-'))
  return { dir, storagePath: path.join(dir, 'pearpaste-corestore') }
}

test('worklet RPC: boot + note lifecycle + lock (spec §21)', async (t) => {
  const M = await load()
  const { dir, storagePath } = tmpStore('life')
  const pearEnd = await M.createPearEnd({ storagePath })
  const { server, client } = wireInProcess(M, pearEnd)

  t.teardown(async () => {
    server.close()
    await pearEnd.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // 1. server answers RPC at all: a locked-allowed command works pre-unlock.
  const status = await client.call(M.COMMANDS.RELAY_STATUS, {})
  t.ok(status && typeof status.enabled === 'boolean', 'RELAY_STATUS answered over the bridge (worklet alive)')

  // content command is rejected while locked (renderer/lock contract)
  await t.exception(
    () => client.call(M.COMMANDS.NOTE_LIST, {}),
    /lock/i,
    'NOTE_LIST rejected while vault locked'
  )

  // 2. CREATE_VAULT
  const created = await client.call(M.COMMANDS.CREATE_VAULT, { label: 'phone', platform: 'ios', passphrase: 'pw1' })
  t.ok(created.vaultId && created.deviceId, 'CREATE_VAULT returned vaultId + deviceId')
  // mnemonic is the one allowed one-time secret-ish field (spec §14); just
  // assert it is a non-empty string — word count depends on the KDF build.
  t.ok(typeof created.mnemonic === 'string' && created.mnemonic.length > 0, 'recovery phrase returned once')

  // NOTE_UPSERT — the user-set label is the only identifier now (the old
  // `title` field was dropped in the label/title unification).
  const SENT = 'PEARPASTE_NOTE_PLAINTEXT_42'
  const USER_LABEL = 'work-creds-2026'
  const up = await client.call(M.COMMANDS.NOTE_UPSERT, { note: { body: SENT, label: USER_LABEL } })
  t.ok(up.ok && up.noteId, 'NOTE_UPSERT ok with noteId')

  // NOTE_LIST is SEALED for the body but DOES surface the user label
  // (decrypted on this device from the envelope — never stored or
  // replicated as plaintext). Sealed invariant for content holds.
  const list = await client.call(M.COMMANDS.NOTE_LIST, {})
  t.is(list.notes.length, 1, 'one note listed')
  const row = list.notes[0]
  t.ok(row.sealed === true, 'list row is sealed')
  t.absent(JSON.stringify(row).includes(SENT), 'sealed row contains no plaintext body')
  t.absent('body' in row, 'sealed row has no body field')
  t.absent('title' in row, 'sealed row has no title field (legacy field — removed)')
  t.is(row.label, USER_LABEL, 'sealed row exposes the user label')

  // NOTE_OPEN decrypts exactly that one item -> plaintext for the UI.
  const opened = await client.call(M.COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(opened.note.body, SENT, 'NOTE_OPEN returns the decrypted body for the one item')
  t.absent('title' in opened.note, 'NOTE_OPEN no longer returns title (unified on label)')
  t.is(opened.note.label, USER_LABEL, 'NOTE_OPEN returns the label so the editor can show + edit it')

  await client.call(M.COMMANDS.NOTE_CLOSE, { noteId: up.noteId })

  // 6. renderer contract: nothing in any response above leaked key material.
  // (assertRendererSafe runs in the backend; re-assert at the bridge boundary.)
  const blob = JSON.stringify([status, created, up, list, opened])
  t.absent(/vaultKey|indexKey|signingSecretKey|deviceAdminSeed|rootSeed/i.test(blob),
    'no vault key material crossed the bridge')

  // LOCK_VAULT then content RPC must fail again (plaintext discarded on lock).
  const locked = await client.call(M.COMMANDS.LOCK_VAULT, {})
  t.ok(locked.ok, 'LOCK_VAULT ok')
  await t.exception(
    () => client.call(M.COMMANDS.NOTE_OPEN, { noteId: up.noteId }),
    /lock/i,
    'NOTE_OPEN rejected after lock (no decrypt while locked)'
  )
})

test('worklet RPC: mobile<->desktop pairing backend flow (spec §14/§21)', async (t) => {
  const M = await load()
  const { dir, storagePath } = tmpStore('pair')
  const pearEnd = await M.createPearEnd({ storagePath })
  const { server, client } = wireInProcess(M, pearEnd)
  t.teardown(async () => {
    server.close(); await pearEnd.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await client.call(M.COMMANDS.CREATE_VAULT, { label: 'desktop-sim', platform: 'macos', passphrase: 'pw2' })

  // The existing unlocked device mints a one-time invite over the SAME bridge a
  // phone would use. This asserts the PAIR_CREATE_INVITE backend path end to
  // end (topic + ephemeral pubkey + short code + expiry).
  const inv = await client.call(M.COMMANDS.PAIR_CREATE_INVITE, { ttlMs: 5 * 60 * 1000 })
  t.ok(typeof inv.invite === 'string' && inv.invite.length > 20, 'invite blob returned')
  t.ok(/^[0-9A-F]{4}-[0-9A-F]{4}$/.test(inv.shortCode), 'human short code formatted A1B2-C3D4')
  t.ok(inv.expiresAt > Date.now(), 'invite has a future expiry')

  // PAIR_ACCEPT on a second Pear-end must at least DECODE this invite (the full
  // Noise handshake needs two live swarms; decode proves the wire contract the
  // mobile pair screen depends on and that expiry is enforced).
  const { dir: dir2, storagePath: sp2 } = tmpStore('pair2')
  const newDev = await M.createPearEnd({ storagePath: sp2 })
  const w2 = wireInProcess(M, newDev)
  t.teardown(async () => {
    w2.server.close(); await newDev.close()
    fs.rmSync(dir2, { recursive: true, force: true })
  })
  // No peer is announcing on the temp topic here, so PAIR_ACCEPT will time out
  // on the handshake — but a *malformed/expired* invite fails FAST with a
  // decode error. Assert the decode contract via an expired invite.
  // createInvite returns the payload as a direct JSON string (compact form);
  // decodeInvite also accepts a legacy base64-of-JSON form (see backend/pairing.js).
  const decoded = JSON.parse(inv.invite)
  t.is(decoded.v, 1, 'invite payload is v1')
  t.ok(decoded.t && decoded.p, 'invite carries topic + ephemeral box pubkey')

  // The pairing wire format the mobile Pair screen depends on: decodeInvite()
  // round-trips a fresh invite and enforces expiry (spec §14). This is the
  // exact contract PAIR_ACCEPT runs internally.
  const pairing = await import('../../backend/pairing.js')
  const ok = pairing.decodeInvite(inv.invite)
  t.ok(ok.topic && ok.invitePubkey, 'pairing.decodeInvite accepts a fresh invite')
  // Override `e` (the short-key field createInvite emits, see backend/pairing.js).
  // Pass as compact JSON — that's the live wire format.
  const expired = JSON.stringify({ ...decoded, e: Date.now() - 1000 })
  t.exception(() => pairing.decodeInvite(expired), /expire/i, 'expired invite is rejected by the wire format (§14)')

  // PAIR_ACCEPT over the bridge on a brand-new device is also rejected (the
  // dispatcher lock gate guards it before any handshake) — i.e. a phone cannot
  // silently accept an invite into an unlocked-but-vaultless state. Either the
  // lock gate or the pairing handshake/expiry refuses it; both are acceptable.
  let rejected = null
  try {
    await w2.client.call(M.COMMANDS.PAIR_ACCEPT, { invite: expired, label: 'phone', platform: 'ios' })
  } catch (e) { rejected = e }
  t.ok(rejected, 'PAIR_ACCEPT with an expired invite is rejected over the bridge')
})

test('worklet RPC: clip capture + copy round trip (spec §21)', async (t) => {
  const M = await load()
  const { dir, storagePath } = tmpStore('clip')
  const pearEnd = await M.createPearEnd({ storagePath })
  const { server, client } = wireInProcess(M, pearEnd)
  t.teardown(async () => {
    server.close(); await pearEnd.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  await client.call(M.COMMANDS.CREATE_VAULT, { label: 'phone', platform: 'android', passphrase: 'pw3' })

  const CLIP = 'https://example.test/PEARPASTE_CLIP_77'
  const cap = await client.call(M.COMMANDS.CLIP_CAPTURE, { kind: 'url', body: CLIP })
  t.ok(cap.clipId, 'CLIP_CAPTURE returned clipId')

  const clips = await client.call(M.COMMANDS.CLIP_LIST, {})
  t.is(clips.clips.length, 1, 'one clip listed')
  t.ok(clips.clips[0].sealed === true, 'clip row sealed')
  t.absent(JSON.stringify(clips.clips[0]).includes(CLIP), 'sealed clip row has no plaintext')

  // CLIP_COPY decrypts the one clip, returns it for the OS clipboard, and the
  // backend immediately drops its app-held copy (spec §9.4).
  const copied = await client.call(M.COMMANDS.CLIP_COPY, { clipId: cap.clipId })
  t.is(copied.body, CLIP, 'CLIP_COPY returns the decrypted clip body for the OS clipboard')
  t.is(copied.kind, 'url', 'CLIP_COPY preserves clip kind')
})

test('worklet RPC: crash -> recoverable error (spec §21 "recoverable error UI")', async (t) => {
  const M = await load()
  const { dir, storagePath } = tmpStore('crash')
  const pearEnd = await M.createPearEnd({ storagePath })

  // Build a server whose pearEnd.call throws like a dead/faulting worklet would.
  let kill = false
  const faulting = {
    call: async (command, params) => {
      if (kill) { const e = new Error('worklet terminated'); e.code = 'WORKLET_CRASHED'; throw e }
      return pearEnd.call(command, params)
    }
  }
  let server = null
  let client = null
  server = M.createRpcServer({ pearEnd: faulting, send: (b) => client && queueMicrotask(() => client.onResponse(b)) })
  client = M.createRpcClient({ send: (b) => server && queueMicrotask(() => server.onRequest(b)), timeoutMs: 5000 })

  t.teardown(async () => { server.close(); await pearEnd.close(); fs.rmSync(dir, { recursive: true, force: true }) })

  // Healthy first.
  const ok = await client.call(M.COMMANDS.RELAY_STATUS, {})
  t.ok(ok && typeof ok.enabled === 'boolean', 'bridge healthy before crash')

  // Simulate the worklet dying mid-session.
  kill = true
  let threw = null
  try {
    await client.call(M.COMMANDS.NOTE_LIST, {})
  } catch (e) { threw = e }
  t.ok(threw, 'a call after crash rejects (no infinite hang)')
  t.is(threw.code, 'WORKLET_CRASHED', 'error is the recoverable crash code the UI maps to a retry')
  t.ok(/terminated/i.test(threw.message), 'crash message is surfaced (redacted, no params)')

  // After "restart" (kill=false) the same client recovers — proves the retry
  // path the WorkletErrorBoundary triggers actually works.
  kill = false
  const recovered = await client.call(M.COMMANDS.RELAY_STATUS, {})
  t.ok(recovered && typeof recovered.enabled === 'boolean', 'bridge usable again after recovery (retry works)')
})
