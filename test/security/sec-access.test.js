// Security: access discipline / tap-to-decrypt lifecycle (spec §3 security,
// §9.4 tap-to-decrypt, §15 renderer contract, §16 "Security tests").
//
// Covers these §16 items:
//   - unlock does not bulk-decrypt notes or clips
//   - sealed list rendering receives only note labels for navigation, never
//     plaintext bodies, tags, or clip text
//   - selected item plaintext is cleared on close, background, timeout, and
//     lock
//
// Driven through the real Pear-end. The decrypted-item cache is
// ctx.state.openItems (the single in-memory plaintext store); we assert it is
// empty after unlock, populated only by an explicit open, and emptied by every
// teardown trigger. We also scan every list/search RPC response for any
// sentinel to prove the renderer never sees sealed plaintext bodies/tags.
//
// Run: node test/security/sec-access.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { EventEmitter } from 'events'

import { createPearEnd } from '../../backend/index.js'
import { createBridge } from '../../backend/desktop-bridge.js'
import { attachDesktopWorkerPipe } from '../../backend/desktop-worker-protocol.js'
import { COMMANDS } from '../../backend/rpc.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }
function rnd () { return Math.random().toString(36).slice(2) }
const call = (pe, c, p) => pe.call(c, p || {})

// The single in-memory decrypted-item store. Tests assert on this directly —
// it is THE place plaintext is allowed to live transiently (spec §8.3).
const openCount = (pe) => pe.ctx.state.openItems.size

class MemoryWorkerWire extends EventEmitter {
  constructor () {
    super()
    this._out = ''
  }

  send (msg) {
    this.emit('data', Buffer.from(JSON.stringify(msg) + '\n'))
  }

  write (chunk) {
    this._out += chunk && typeof chunk.toString === 'function' ? chunk.toString() : String(chunk)
    let nl
    while ((nl = this._out.indexOf('\n')) >= 0) {
      const line = this._out.slice(0, nl).trim()
      this._out = this._out.slice(nl + 1)
      if (!line) continue
      try { this.emit('message', JSON.parse(line)) } catch (_) {}
    }
    return true
  }

  end () {
    this.emit('end')
  }
}

function waitForPipeMessage (wire, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('timed out waiting for worker pipe message'))
    }, timeoutMs)
    if (timer.unref) timer.unref()

    function cleanup () {
      clearTimeout(timer)
      wire.off('message', onMessage)
    }

    function onMessage (msg) {
      if (!predicate(msg)) return
      cleanup()
      resolve(msg)
    }

    wire.on('message', onMessage)
  })
}

let _pipeId = 0
async function pipeCall (wire, command, params) {
  const id = ++_pipeId
  const response = waitForPipeMessage(wire, (msg) => msg && msg.id === id)
  wire.send({ id, command, params })
  return response
}

test('§16 unlock does NOT bulk-decrypt; only an explicit open holds plaintext', async (t) => {
  const dir = tmp('bulk')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  const pw = 'pw-' + rnd()
  const created = await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: pw })
  const mnemonic = created.mnemonic

  // Populate several notes + clips so a "bulk decrypt on unlock" bug would be
  // observable as a non-empty openItems set right after unlock.
  const bodies = []
  for (let i = 0; i < 5; i++) {
    const b = SENTINEL_PREFIX + 'BODY' + i + '_' + rnd()
    bodies.push(b)
    await call(pe, COMMANDS.NOTE_UPSERT, { note: { label: 'bulk-' + i, body: b, tags: ['t' + i] } })
  }
  for (let i = 0; i < 3; i++) {
    await call(pe, COMMANDS.CLIP_CAPTURE, { kind: 'text', body: SENTINEL_PREFIX + 'CLIP' + i + '_' + rnd() })
  }

  t.is(openCount(pe), 0, 'no decrypted items cached after CREATE_VAULT + writes')

  // lock then unlock via passphrase — the documented routine unlock path.
  await call(pe, COMMANDS.LOCK_VAULT, {})
  t.is(openCount(pe), 0, 'openItems empty after lock')
  await call(pe, COMMANDS.RESTORE_VAULT, { mnemonic, passphrase: pw })
  const un = await call(pe, COMMANDS.UNLOCK_VAULT, { secret: pw })
  t.ok(un.ok, 'UNLOCK_VAULT ok')

  // THE assertion: unlock must not bulk-decrypt. Zero items held.
  t.is(openCount(pe), 0, 'UNLOCK_VAULT did NOT bulk-decrypt any note/clip')

  // Listing also must not populate the decrypted cache.
  const list = await call(pe, COMMANDS.NOTE_LIST, {})
  t.is(list.notes.length, 5, 'all 5 notes listed (sealed)')
  t.is(openCount(pe), 0, 'NOTE_LIST did not decrypt into the open-item cache')
  const clips = await call(pe, COMMANDS.CLIP_LIST, {})
  t.is(clips.clips.length, 3, 'all 3 clips listed (sealed)')
  t.is(openCount(pe), 0, 'CLIP_LIST did not decrypt into the open-item cache')

  // A single explicit open holds exactly ONE item.
  const noteId = list.notes[0].id
  await call(pe, COMMANDS.NOTE_OPEN, { noteId })
  t.is(openCount(pe), 1, 'exactly one item held after one explicit NOTE_OPEN')
})

test('§16 sealed list/search rendering carries labels but never bodies, tags, or clip text', async (t) => {
  const dir = tmp('seal')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })

  // The note NAME (`label`) is intentionally shown in the list for navigation
  // (decrypted in-memory only while unlocked; sealed at rest + hidden from
  // relays — spec §16). The BODY, tags, and clip text stay sealed
  // (tap-to-decrypt), so only those carry the leak sentinel.
  const label = 'note-name-' + rnd()
  const body = SENTINEL_PREFIX + 'SEALED_BODY_' + rnd()
  const tag = SENTINEL_PREFIX + 'SEALED_TAG_' + rnd()
  const clipText = SENTINEL_PREFIX + 'SEALED_CLIP_' + rnd()
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { label, body, tags: [tag] } })
  await call(pe, COMMANDS.CLIP_CAPTURE, { kind: 'text', body: clipText })

  const list = JSON.stringify(await call(pe, COMMANDS.NOTE_LIST, {}))
  t.absent(list.includes(body), 'NOTE_LIST response has no plaintext body')
  t.absent(list.includes(tag), 'NOTE_LIST response has no plaintext tags')
  t.absent(list.includes(SENTINEL_PREFIX), 'NOTE_LIST carries no sealed plaintext (body/tags/clip)')
  t.ok(list.includes(label), 'NOTE_LIST row shows the note label (name) for navigation')

  const clipList = JSON.stringify(await call(pe, COMMANDS.CLIP_LIST, {}))
  t.absent(clipList.includes(clipText), 'CLIP_LIST response has no plaintext clip text')
  t.absent(clipList.includes(SENTINEL_PREFIX), 'CLIP_LIST response has zero sentinels')

  // Search returns sealed pointer rows only — never the matched body/clip text.
  const search = JSON.stringify(await call(pe, COMMANDS.SEARCH, { q: 'sealed' }))
  t.absent(search.includes(body), 'SEARCH response carries no body')
  t.absent(search.includes(SENTINEL_PREFIX), 'SEARCH rows are sealed (no body/tag/clip plaintext)')

  // Inspect a row's shape: the body is sealed (absent); the label/name is the
  // only user-content field surfaced for the list.
  const rows = (await call(pe, COMMANDS.NOTE_LIST, {})).notes
  t.is(rows.length, 1, 'one row')
  t.is(rows[0].sealed, true, 'row marked sealed (body intentionally absent)')
  t.absent('body' in rows[0], 'no `body` key on a sealed row')
  t.is(rows[0].label, label, 'sealed row carries the visible label (name)')

  // Sanity: the body IS retrievable via the explicit open path (so we proved
  // sealing, not just an empty store), and the name round-trips.
  const opened = await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(opened.note.label, label, 'explicit NOTE_OPEN returns the real label (name)')
  t.is(opened.note.body, body, 'explicit NOTE_OPEN returns the real body')
})

test('§16 selected-item plaintext is cleared on CLOSE', async (t) => {
  const dir = tmp('close')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { label: 'close', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held after open')
  await call(pe, COMMANDS.NOTE_CLOSE, { noteId: up.noteId })
  t.is(openCount(pe), 0, 'NOTE_CLOSE cleared the decrypted plaintext')
})

test('§16 selected-item plaintext is cleared on BACKGROUND', async (t) => {
  const dir = tmp('bg')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })
  const bridge = createBridge(pe)
  const wire = new MemoryWorkerWire()
  bridge.onMessage((m) => {
    try { wire.write(JSON.stringify(m) + '\n') } catch (_) {}
  })
  attachDesktopWorkerPipe({ wire, bridge, log: () => {} })
  let backgrounded = 0
  let foregrounded = 0
  pe.ctx.on('backgrounded', () => { backgrounded++ })
  pe.ctx.on('foregrounded', () => { foregrounded++ })

  const created = await pipeCall(wire, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  t.ok(created.ok, 'CREATE_VAULT ok through worker pipe')
  const up = await pipeCall(wire, COMMANDS.NOTE_UPSERT, { note: { label: 'background', body: SENTINEL_PREFIX + rnd() } })
  t.ok(up.ok, 'NOTE_UPSERT ok through worker pipe')
  const opened = await pipeCall(wire, COMMANDS.NOTE_OPEN, { noteId: up.result.noteId })
  t.ok(opened.ok, 'NOTE_OPEN ok through worker pipe')
  t.is(openCount(pe), 1, 'item held after open')
  const bgEvent = waitForPipeMessage(wire, (msg) => msg && msg.type === 'event' && msg.event === 'backgrounded')
  wire.send({ type: 'visibility', visible: false })
  await bgEvent
  t.is(backgrounded, 1, 'worker pipe visibility message emitted backgrounded')
  t.is(openCount(pe), 0, 'app backgrounding cleared the decrypted plaintext')
  const fgEvent = waitForPipeMessage(wire, (msg) => msg && msg.type === 'event' && msg.event === 'foregrounded')
  wire.send({ type: 'visibility', visible: true })
  await fgEvent
  t.is(foregrounded, 1, 'worker pipe visibility message emitted foregrounded')
})

test('§16 selected-item plaintext is cleared on TIMEOUT', async (t) => {
  const dir = tmp('to')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  // very short visibility window (spec §9.4 configurable convenience timeout)
  pe.ctx.state.visibilityMs = 150
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { label: 'timeout', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held immediately after open')
  await new Promise(resolve => setTimeout(resolve, 400))
  t.is(openCount(pe), 0, 'visibility timer expiry cleared the decrypted plaintext')
})

test('§16 selected-item plaintext is cleared on LOCK', async (t) => {
  const dir = tmp('lock')
  const pe = await createPearEnd({ storagePath: dir, relayClientFactory: false })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { label: 'lock', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held after open')
  await call(pe, COMMANDS.LOCK_VAULT, {})
  t.is(openCount(pe), 0, 'LOCK_VAULT cleared the decrypted plaintext')
  t.absent(pe.ctx.isUnlocked(), 'vault is locked')
  // and the vault keys themselves are gone from memory after lock
  t.is(pe.ctx.state.vaultKeys, null, 'vault keys wiped from memory on lock')
})
