// Paste notes + clips service.
//
// CRUD on top of autobase-sync (ctx.sync) + the encrypted Hyperbee views.
// Hard rules (spec §9.4, §15 renderer contract, §22):
//   - List handlers return SEALED rows only: type, coarse modified bucket,
//     pinned, sealed flag. NEVER a decrypted title/body.
//   - Open handlers decrypt exactly ONE item in the Pear-end, return its
//     plaintext to the caller, and start a visibility timer in
//     ctx.state.openItems. Close/lock/timeout drops the plaintext.
//   - No bulk decrypt on unlock. No decrypted cache at rest.
//   - CLIP_COPY decrypts the one clip, returns it for the OS clipboard, then
//     immediately clears the app-held plaintext.
//
// Spec refs: §7.3/§7.4 (note/clip model), §9.4 (tap-to-decrypt lifecycle),
// §15 (API surface + renderer contract), §22 (contracts).

const DEFAULT_VISIBILITY_MS = 60_000 // spec §9.4 default 60s, never across lock
const CLIP_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000 // §7.4 short retention default

function newId (crypto, prefix) {
  return prefix + '-' + b4aHex(crypto.randomBytes(16))
}
function b4aHex (buf) {
  let s = ''
  for (const x of buf) s += x.toString(16).padStart(2, '0')
  return s
}

export async function attach (ctx) {
  const { COMMANDS } = await import('./rpc.js')
  const crypto = ctx.crypto
  const ops = ctx.ops

  // Engine readiness gate (spec §10 lifecycle). index.js emits 'unlocked'
  // synchronously and returns before autobase-sync's engine.open() finishes,
  // so a CREATE_VAULT immediately followed by NOTE_UPSERT would otherwise hit
  // a not-yet-open engine. Instead of throwing NOT_READY we AWAIT readiness
  // (bounded) so the documented sequence works and a still-locked vault still
  // fails fast after the timeout. autobase-sync re-arms this promise on
  // 'locked' so a lock->unlock cycle waits for the *next* open().
  const SYNC_WAIT_MS = 15000
  async function awaitSync () {
    const s = ctx.sync
    if (!s) { const e = new Error('sync engine not ready'); e.code = 'NOT_READY'; throw e }
    if (!s._opened) {
      if (typeof s.ready !== 'function') { const e = new Error('sync engine not ready'); e.code = 'NOT_READY'; throw e }
      await s.ready(SYNC_WAIT_MS) // resolves on open, rejects NOT_READY on timeout/failure
    }
    return s
  }

  // ---- open-item lifecycle helpers (spec §9.4) ---------------------------
  function openItem (itemId, plaintext, visibilityMs) {
    const prev = ctx.state.openItems.get(itemId)
    if (prev && prev.timer) clearTimeout(prev.timer)
    const ttl = Number(visibilityMs) > 0 ? Number(visibilityMs) : DEFAULT_VISIBILITY_MS
    const timer = setTimeout(() => closeItem(itemId), ttl)
    if (timer.unref) timer.unref()
    ctx.state.openItems.set(itemId, { plaintext, timer, openedAt: Date.now() })
  }
  function closeItem (itemId) {
    const ent = ctx.state.openItems.get(itemId)
    if (!ent) return
    if (ent.timer) clearTimeout(ent.timer)
    // best-effort wipe of any string-held plaintext reference
    ent.plaintext = null
    ctx.state.openItems.delete(itemId)
  }
  function clearAllOpen () {
    for (const [id] of ctx.state.openItems) closeItem(id)
  }
  // lock/background clears all decrypted plaintext (spec §9.4, §15)
  ctx.on('locked', clearAllOpen)
  ctx.on('backgrounded', clearAllOpen)

  // resolve objectId for a blindId (paired devices use sealed objmeta).
  // Swallow AEAD/decrypt errors on the mapping record itself so an orphan
  // record (e.g. left over from a prior CREATE_VAULT cycle whose vaultKey
  // is no longer in local-device.json) renders as a sealed/unknown row
  // instead of throwing AEAD_FAIL out of the whole NOTE_LIST/CLIP_LIST/SEARCH.
  async function resolveObjectId (s, objectBlindId) {
    try {
      const meta = await s.view.resolveObjMeta(objectBlindId)
      if (meta && meta.objectId) return meta.objectId
    } catch (_) {}
    return null
  }

  // ---- NOTE_LIST (sealed rows only) -------------------------------------
  ctx.dispatcher.register(COMMANDS.NOTE_LIST, async ({ limit = 200 }) => {
    const s = await awaitSync()
    await s.refresh()
    const sealed = await s.view.scanNotes()
    const now = Date.now()
    const rows = []
    for (const { objectBlindId, envelope } of sealed) {
      // We DO hold the vault key here, but the list view must not leak
      // titles/bodies. We decrypt only to derive non-sensitive metadata
      // (type, coarse bucket, pinned, deleted, optional user label,
      // expiresAt for temporary notes) — the row sent to the UI carries
      // no title/body. label is an OPT-IN field the user explicitly sets
      // to identify a note in the list; expiresAt drives the temporary-
      // note feature (UI shows a countdown; sweeper hard-deletes past it).
      // Both live inside the encrypted envelope (no plaintext at rest, no
      // relay leakage) and are surfaced here at the same decrypt cost we
      // already pay for sort metadata.
      let meta = { sealed: true }
      const objectId = await resolveObjectId(s, objectBlindId)
      if (objectId) {
        try {
          const note = s.view.openRecord({ objectId, envelope })
          if (note.deletedAt) continue
          // Lazy filter: a temporary note past its expiresAt is treated as
          // deleted from the moment expiry passes, even if the sweeper
          // hasn't yet emitted the hard-delete op. Keeps the user-visible
          // contract honest while delete replication catches up.
          if (note.expiresAt && note.expiresAt <= now) continue
          meta = {
            id: note.noteId,
            type: 'note',
            bodyFormat: note.bodyFormat || 'plain',
            pinned: !!note.pinned,
            updatedBucket: ops.timeBucket(note.updatedAt || note.createdAt || Date.now()),
            // Notes are now identified by `label` only. For legacy records
            // that still carry a `title` (written before the title field
            // was dropped), fall back to title so they don't appear as
            // "Sealed" placeholders. Saving a legacy note re-writes
            // without the title field.
            label: String(note.label || note.title || ''),
            // expiresAt > 0 = temporary; UI renders a countdown chip.
            // Absolute timestamp so paired devices agree on expiry even
            // without clock-skew correction (within reasonable bounds).
            expiresAt: note.expiresAt || null,
            sealed: true // body intentionally absent
          }
        } catch (_) { /* keep sealed */ }
      }
      rows.push({ objectBlindId, ...meta })
    }
    rows.sort((a, b) => (b.pinned === a.pinned ? 0 : b.pinned ? 1 : -1) ||
      String(b.updatedBucket || '').localeCompare(String(a.updatedBucket || '')))
    return { notes: rows.slice(0, limit) }
  })

  // ---- NOTE_OPEN (decrypt ONE item) -------------------------------------
  ctx.dispatcher.register(COMMANDS.NOTE_OPEN, async ({ noteId }) => {
    const s = await awaitSync()
    const objectId = 'note:' + noteId
    const obid = crypto.blindId(s.indexKey, objectId)
    const env = await s.view.getNoteSealed(obid)
    if (!env) { const e = new Error('note not found'); e.code = 'NOT_FOUND'; throw e }
    const note = s.view.openRecord({ objectId, envelope: env })
    if (note.deletedAt) { const e = new Error('note deleted'); e.code = 'NOT_FOUND'; throw e }
    // Same lazy-expiry treatment as the list. Refusing to open an expired
    // note is the user-facing half of the temporary-note guarantee — the
    // sweeper handles the storage-level erasure. Message wording matches
    // the !env / deletedAt branches so callers can pattern-match on "not
    // found" without caring whether the row was hard-deleted, soft-deleted,
    // or expired.
    if (note.expiresAt && note.expiresAt <= Date.now()) {
      const e = new Error('note not found'); e.code = 'NOT_FOUND'; throw e
    }
    const { __lww, title, ...clean } = note
    // Legacy migration: if a stored note still carries the old `title`
    // field but no `label`, surface title as the label so the renderer
    // (which now has no title input) can still identify the note. Saving
    // through NOTE_UPSERT below drops title from the record entirely.
    if (!clean.label && title) clean.label = String(title)
    openItem(objectId, clean, ctx.state.visibilityMs)
    return { note: clean }
  })

  ctx.dispatcher.register(COMMANDS.NOTE_CLOSE, async ({ noteId }) => {
    closeItem('note:' + noteId)
    return { ok: true }
  })

  // ---- NOTE_UPSERT ------------------------------------------------------
  ctx.dispatcher.register(COMMANDS.NOTE_UPSERT, async ({ note }) => {
    const s = await awaitSync()
    const now = Date.now()
    const noteId = note.noteId || newId(crypto, 'note')
    const objectId = 'note:' + noteId
    const obid = crypto.blindId(s.indexKey, objectId)

    let createdAt = now
    const existing = await s.view.getNoteSealed(obid)
    if (existing) {
      try { createdAt = s.view.openRecord({ objectId, envelope: existing }).createdAt || now } catch (_) {}
    }
    const full = {
      noteId,
      body: String(note.body || ''),
      bodyFormat: note.bodyFormat || 'plain',
      tags: Array.isArray(note.tags) ? note.tags.map(String) : [],
      pinned: !!note.pinned,
      // User-set identifier for the note, shown in the list and as the
      // header in the viewer/editor. Lives inside the encrypted envelope
      // (decrypted on this device while unlocked; relays never see it).
      // Trimmed + capped at 80 chars so it stays an identifier rather than
      // a substitute body. Replaces the previous separate `title` field —
      // the dual title/label was redundant. Legacy notes that still carry
      // `title` get migrated to `label` on read (NOTE_LIST + NOTE_OPEN).
      label: String(note.label || '').trim().slice(0, 80),
      createdAt,
      updatedAt: now
    }
    // Optional expiry timestamp (temporary note). When set + in the past,
    // NOTE_LIST/OPEN filter the note out and the background sweeper emits
    // a hard NOTE_DELETE so the encrypted envelope is erased on every
    // paired device. Default UI offers 1h/12h/24h/72h/7d/30d; backend
    // accepts any positive millisecond timestamp. Stored INSIDE the
    // envelope so relays don't learn which notes are temporary.
    if (Number.isFinite(note.expiresAt) && note.expiresAt > 0) {
      full.expiresAt = Math.floor(note.expiresAt)
    }
    // canonicalize() rejects `undefined`; only set deletedAt when truthy.
    if (note.deletedAt) full.deletedAt = note.deletedAt
    await s.appendOp(ops.OP_TYPES.NOTE_UPSERT, ops.SCHEMAS.NOTE, objectId, full)
    return { ok: true, noteId, objectBlindId: obid }
  })

  // ---- NOTE_DELETE (soft tombstone default; hard destroys key material) --
  ctx.dispatcher.register(COMMANDS.NOTE_DELETE, async ({ noteId, hard = false }) => {
    const s = await awaitSync()
    const objectId = 'note:' + noteId
    closeItem(objectId)
    await s.appendOp(ops.OP_TYPES.NOTE_DELETE, ops.SCHEMAS.NOTE, objectId, { noteId, hard: !!hard })
    return { ok: true, noteId, hard: !!hard }
  })

  // ---- CLIP_LIST (sealed rows only) -------------------------------------
  ctx.dispatcher.register(COMMANDS.CLIP_LIST, async ({ limit = 100 }) => {
    const s = await awaitSync()
    await s.refresh()
    const sealed = await s.view.scanClips()
    const rows = []
    const now = Date.now()
    for (const { bucket, objectBlindId, envelope } of sealed) {
      let meta = { sealed: true, bucket }
      const objectId = await resolveObjectId(s, objectBlindId)
      if (objectId) {
        try {
          const clip = s.view.openRecord({ objectId, envelope })
          if (clip.expiresAt && clip.expiresAt < now) continue // expired
          meta = {
            id: clip.clipId,
            type: 'clip',
            kind: clip.kind || 'text',
            bucket,
            sealed: true // body intentionally absent
          }
        } catch (_) {}
      }
      rows.push({ objectBlindId, ...meta })
    }
    rows.sort((a, b) => String(b.bucket || '').localeCompare(String(a.bucket || '')))
    return { clips: rows.slice(0, limit) }
  })

  ctx.dispatcher.register(COMMANDS.CLIP_OPEN, async ({ clipId }) => {
    const s = await awaitSync()
    const objectId = 'clip:' + clipId
    const obid = crypto.blindId(s.indexKey, objectId)
    const sealed = await s.view.scanClips()
    const hit = sealed.find(r => r.objectBlindId === obid)
    if (!hit) { const e = new Error('clip not found'); e.code = 'NOT_FOUND'; throw e }
    const clip = s.view.openRecord({ objectId, envelope: hit.envelope })
    const { __lww, ...clean } = clip
    openItem(objectId, clean, ctx.state.visibilityMs)
    return { clip: clean }
  })

  ctx.dispatcher.register(COMMANDS.CLIP_CLOSE, async ({ clipId }) => {
    closeItem('clip:' + clipId)
    return { ok: true }
  })

  // shared capture path (CLIP_CAPTURE rpc + ctx.clipboardSink for Agent 3)
  async function captureClip ({ kind = 'text', body }) {
    const s = await awaitSync()
    const clipId = newId(crypto, 'clip')
    const objectId = 'clip:' + clipId
    const now = Date.now()
    const clip = {
      clipId,
      kind: kind || 'text',
      body: String(body),
      sourceDeviceId: ctx.state.device ? ctx.state.device.deviceId : 'unknown',
      capturedAt: now,
      expiresAt: now + CLIP_DEFAULT_TTL_MS
    }
    const obid = await s.appendOp(ops.OP_TYPES.CLIP_ADD, ops.SCHEMAS.CLIP, objectId, clip)
    return { clipId, objectBlindId: obid }
  }

  ctx.dispatcher.register(COMMANDS.CLIP_CAPTURE, async ({ kind, body }) => {
    return captureClip({ kind, body })
  })

  // Internal sink so the desktop OS clipboard monitor (Agent 3) feeds captures
  // without re-registering RPC — same code path as CLIP_CAPTURE.
  ctx.clipboardSink = async ({ kind, body }) => {
    const { clipId } = await captureClip({ kind, body })
    return clipId
  }

  // ---- CLIP_COPY (decrypt one, return plaintext, clear immediately) ------
  ctx.dispatcher.register(COMMANDS.CLIP_COPY, async ({ clipId }) => {
    const s = await awaitSync()
    const objectId = 'clip:' + clipId
    const obid = crypto.blindId(s.indexKey, objectId)
    const sealed = await s.view.scanClips()
    const hit = sealed.find(r => r.objectBlindId === obid)
    if (!hit) { const e = new Error('clip not found'); e.code = 'NOT_FOUND'; throw e }
    const clip = s.view.openRecord({ objectId, envelope: hit.envelope })
    const body = String(clip.body)
    // app-held plaintext is NOT cached — return for OS clipboard then drop.
    closeItem(objectId)
    return { kind: clip.kind || 'text', body }
  })

  // ---- SEARCH (local-only index; sealed rows) ---------------------------
  // Rows stay sealed (no title/body), but we include the resolved `id`
  // (noteId / clipId) so the renderer can route a tap to NOTE_OPEN /
  // CLIP_OPEN. Spec §9.3 forbids leaking plaintext in lists — the noteId is
  // a random opaque identifier (not derived from title) and is already
  // surfaced in NOTE_LIST/CLIP_LIST, so emitting it here is consistent.
  // When objmeta can't be resolved (paired device, orphan record) the row
  // stays sealed/unknown and the UI just won't make it clickable.
  ctx.dispatcher.register(COMMANDS.SEARCH, async ({ q, limit = 50 }) => {
    const s = await awaitSync()
    const hits = await s.localSearch.search(q, { limit })
    const results = []
    const now = Date.now()
    for (const { objectBlindId } of hits) {
      const meta = await s.view.resolveObjMeta(objectBlindId)
      const objectId = meta && meta.objectId // e.g. "note:abc" / "clip:xyz"
      let id = null
      let type = meta ? meta.type : 'unknown'
      if (objectId) {
        const colon = objectId.indexOf(':')
        if (colon > 0) {
          type = objectId.slice(0, colon) // 'note' | 'clip'
          id = objectId.slice(colon + 1)
        }
      }
      // Filter expired/deleted notes from the result set, and surface
      // expiresAt on live temp notes so the UI can render the same
      // countdown chip as NOTE_LIST. Mirrors the lazy-filter pattern in
      // NOTE_LIST so a search-then-click can't land on a "not found"
      // result for a note that just expired.
      let expiresAt = null
      if (type === 'note' && objectId) {
        try {
          const env = await s.view.getNoteSealed(objectBlindId)
          if (env) {
            const note = s.view.openRecord({ objectId, envelope: env })
            if (note.deletedAt) continue
            if (note.expiresAt && note.expiresAt <= now) continue
            expiresAt = note.expiresAt || null
          }
        } catch (_) { /* keep sealed if decrypt fails */ }
      }
      results.push({
        objectBlindId,
        id, // null when sealed/unresolved; UI then skips the click handler
        type,
        expiresAt,
        sealed: true
      })
    }
    return { results }
  })

  // ---- Temporary-note sweeper (spec: cryptographic erasure on expiry) ----
  // Background loop that scans the materialized view for notes whose
  // expiresAt is in the past and emits a hard NOTE_DELETE for each. Runs
  // every 5 minutes and immediately on 'unlocked'. The delete op replicates
  // to all paired devices' reducers, which then batch.del the encrypted
  // envelope (see backend/autobase-sync.js _applyNoteDelete with hard=true).
  // Failures are logged but never crash the loop; the next tick retries.
  const SWEEP_INTERVAL_MS = 5 * 60 * 1000
  async function sweepExpiredNotes () {
    let s
    try { s = ctx.sync; if (!s || !s._opened) return } catch (_) { return }
    let scanned = 0
    let swept = 0
    try {
      const sealed = await s.view.scanNotes()
      const now = Date.now()
      for (const { objectBlindId, envelope } of sealed) {
        scanned++
        try {
          const objectId = await resolveObjectId(s, objectBlindId)
          if (!objectId) continue
          const note = s.view.openRecord({ objectId, envelope })
          if (note.deletedAt) continue
          if (!note.expiresAt || note.expiresAt > now) continue
          // Past expiry — emit a hard delete. This is idempotent on the
          // reducer side (already-deleted envelopes are a no-op) so a
          // double-sweep across devices is harmless.
          closeItem(objectId)
          await s.appendOp(ops.OP_TYPES.NOTE_DELETE, ops.SCHEMAS.NOTE, objectId, { noteId: note.noteId, hard: true })
          swept++
        } catch (err) {
          ctx.log.warn('sweep-note-failed', { err: String((err && err.message) || err) })
        }
      }
      if (swept > 0) ctx.log.info('temp-note-sweep', { scanned, swept })
    } catch (err) {
      ctx.log.warn('sweep-failed', { err: String((err && err.message) || err) })
    }
  }
  // Run once on unlock (catches anything that expired while the vault was
  // locked) and then on a 5-min cadence. Both paths are coalesced — there's
  // no harm in concurrent sweeps but the loop already serialises.
  ctx.on('unlocked', () => { ctx.scope.spawn(() => sweepExpiredNotes(), 'sweep-on-unlock') })
  ctx.scope.spawn(async (scope) => {
    while (!scope.cancelled) {
      try { await sweepExpiredNotes() } catch (_) {}
      try { await scope.sleep(SWEEP_INTERVAL_MS) } catch (_) { break }
    }
  }, 'sweep-temp-notes')

  ctx.log.info('notes-service attached')
}

export default { attach }
