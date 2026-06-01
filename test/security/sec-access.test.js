// Security: access discipline / tap-to-decrypt lifecycle (spec §3 security,
// §9.4 tap-to-decrypt, §15 renderer contract, §16 "Security tests").
//
// Covers these §16 items:
//   - unlock does not bulk-decrypt notes or clips
//   - sealed list rendering does not receive plaintext titles, bodies, or
//     clip text
//   - selected item plaintext is cleared on close, background, timeout, and
//     lock
//
// Driven through the real Pear-end. The decrypted-item cache is
// ctx.state.openItems (the single in-memory plaintext store); we assert it is
// empty after unlock, populated only by an explicit open, and emptied by every
// teardown trigger. We also scan every list/search RPC response for any
// sentinel to prove the renderer never sees plaintext titles/bodies.
//
// Run: node test/security/sec-access.test.js

import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs'

import { createPearEnd } from '../../backend/index.js'
import { COMMANDS } from '../../backend/rpc.js'
import { SENTINEL_PREFIX } from '../../backend/shared-ops.js'

function tmp (tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-sec-' + tag + '-')) }
function rnd () { return Math.random().toString(36).slice(2) }
const call = (pe, c, p) => pe.call(c, p || {})

// The single in-memory decrypted-item store. Tests assert on this directly —
// it is THE place plaintext is allowed to live transiently (spec §8.3).
const openCount = (pe) => pe.ctx.state.openItems.size

test('§16 unlock does NOT bulk-decrypt; only an explicit open holds plaintext', async (t) => {
  const dir = tmp('bulk')
  const pe = await createPearEnd({ storagePath: dir })
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
    await call(pe, COMMANDS.NOTE_UPSERT, { note: { title: SENTINEL_PREFIX + 'T' + i, body: b, tags: ['t' + i] } })
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

test('§16 sealed list/search rendering never carries titles, bodies, or clip text', async (t) => {
  const dir = tmp('seal')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })

  const title = SENTINEL_PREFIX + 'SEALED_TITLE_' + rnd()
  const body = SENTINEL_PREFIX + 'SEALED_BODY_' + rnd()
  const clipText = SENTINEL_PREFIX + 'SEALED_CLIP_' + rnd()
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { title, body, tags: ['secrettag'] } })
  await call(pe, COMMANDS.CLIP_CAPTURE, { kind: 'text', body: clipText })

  const list = JSON.stringify(await call(pe, COMMANDS.NOTE_LIST, {}))
  t.absent(list.includes(title), 'NOTE_LIST response has no plaintext title')
  t.absent(list.includes(body), 'NOTE_LIST response has no plaintext body')
  t.absent(list.includes(SENTINEL_PREFIX), 'NOTE_LIST response has zero sentinels (fully sealed)')

  const clipList = JSON.stringify(await call(pe, COMMANDS.CLIP_LIST, {}))
  t.absent(clipList.includes(clipText), 'CLIP_LIST response has no plaintext clip text')
  t.absent(clipList.includes(SENTINEL_PREFIX), 'CLIP_LIST response has zero sentinels')

  // Search returns sealed pointer rows only — never the matched title/body.
  const search = JSON.stringify(await call(pe, COMMANDS.SEARCH, { q: 'sealed' }))
  t.absent(search.includes(title), 'SEARCH response carries no title')
  t.absent(search.includes(body), 'SEARCH response carries no body')
  t.absent(search.includes(SENTINEL_PREFIX), 'SEARCH rows are sealed (no sentinel)')

  // Inspect a row's shape: a sealed row must NOT carry title/body keys.
  const rows = (await call(pe, COMMANDS.NOTE_LIST, {})).notes
  t.is(rows.length, 1, 'one row')
  t.is(rows[0].sealed, true, 'row marked sealed')
  t.absent('title' in rows[0], 'no `title` key on a sealed row')
  t.absent('body' in rows[0], 'no `body` key on a sealed row')

  // Sanity: the data IS retrievable via the explicit open path (so we proved
  // sealing, not just an empty store).
  const opened = await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(opened.note.title, title, 'explicit NOTE_OPEN returns the real title')
  t.is(opened.note.body, body, 'explicit NOTE_OPEN returns the real body')
})

test('§16 selected-item plaintext is cleared on CLOSE', async (t) => {
  const dir = tmp('close')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { title: 't', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held after open')
  await call(pe, COMMANDS.NOTE_CLOSE, { noteId: up.noteId })
  t.is(openCount(pe), 0, 'NOTE_CLOSE cleared the decrypted plaintext')
})

test('§16 selected-item plaintext is cleared on BACKGROUND', async (t) => {
  const dir = tmp('bg')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { title: 't', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held after open')
  // app backgrounding (the desktop/mobile shell emits this via the bridge).
  pe.ctx.emit('backgrounded')
  t.is(openCount(pe), 0, 'app backgrounding cleared the decrypted plaintext')
})

test('§16 selected-item plaintext is cleared on TIMEOUT', async (t) => {
  const dir = tmp('to')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  // very short visibility window (spec §9.4 configurable convenience timeout)
  pe.ctx.state.visibilityMs = 150
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { title: 't', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held immediately after open')
  await new Promise(resolve => setTimeout(resolve, 400))
  t.is(openCount(pe), 0, 'visibility timer expiry cleared the decrypted plaintext')
})

test('§16 selected-item plaintext is cleared on LOCK', async (t) => {
  const dir = tmp('lock')
  const pe = await createPearEnd({ storagePath: dir })
  t.teardown(async () => { try { await pe.close() } catch (_) {} ; fs.rmSync(dir, { recursive: true, force: true }) })

  await call(pe, COMMANDS.CREATE_VAULT, { label: 'd', platform: 'macos', passphrase: 'pw' })
  const up = await call(pe, COMMANDS.NOTE_UPSERT, { note: { title: 't', body: SENTINEL_PREFIX + rnd() } })
  await call(pe, COMMANDS.NOTE_OPEN, { noteId: up.noteId })
  t.is(openCount(pe), 1, 'item held after open')
  await call(pe, COMMANDS.LOCK_VAULT, {})
  t.is(openCount(pe), 0, 'LOCK_VAULT cleared the decrypted plaintext')
  t.absent(pe.ctx.isUnlocked(), 'vault is locked')
  // and the vault keys themselves are gone from memory after lock
  t.is(pe.ctx.state.vaultKeys, null, 'vault keys wiped from memory on lock')
})
