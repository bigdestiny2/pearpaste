// Paste — NotesScreen — sealed list + tap-to-decrypt editor (spec §9.4, §15).
//
// NOTE_LIST returns SEALED rows (no titles/bodies). Tapping a row issues
// NOTE_OPEN for that one item, holds its plaintext in transient React state,
// and NOTE_CLOSE drops it on back/blur. We never cache decrypted text.
//
// Editor is shared between 'compose' (new note) and 'edit' (existing note).
// In edit mode we carry the open note's `noteId` so NOTE_UPSERT updates it
// in place; the desktop editor (ui/desktop/app.js noteEditor) drives the
// same contract — same fields (label/title/body/bodyFormat/pinned) and the
// same delete affordance.

import React, { useCallback, useEffect, useState } from 'react'
import {
  View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, ActivityIndicator, Switch, Modal, Alert
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { theme } from '../lib/theme'
import { Eyebrow, H1, Lede, Hint, Banner, Button, SealedRow, Card, inputStyle } from '../lib/ui'
import { getMobilePearEnd } from '../lib/MobilePearEnd'

// `title` was removed — notes now identify themselves via `label` alone.
// Legacy stored notes that still carry a title get migrated to label on read
// (see backend/notes-service.js NOTE_LIST + NOTE_OPEN).
const EMPTY_DRAFT = { noteId: null, body: '', bodyFormat: 'plain', pinned: false, label: '', isTemporary: false, ttlMs: 72 * 60 * 60 * 1000 }

// TTL presets for the temporary-note picker. Same set as desktop; anchored
// at save (Date.now() + ttlMs) so editing a temp note extends its life.
const TTL_OPTIONS = [
  { ms: 60 * 60 * 1000, label: '1 hour' },
  { ms: 12 * 60 * 60 * 1000, label: '12 hours' },
  { ms: 24 * 60 * 60 * 1000, label: '24 hours' },
  { ms: 72 * 60 * 60 * 1000, label: '72 hours' },
  { ms: 7 * 24 * 60 * 60 * 1000, label: '7 days' },
  { ms: 30 * 24 * 60 * 60 * 1000, label: '30 days' }
]
const TTL_DEFAULT_MS = 72 * 60 * 60 * 1000

function formatRemaining (ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return sec + 's'
  const min = Math.floor(sec / 60)
  if (min < 60) return min + 'm'
  const hr = Math.floor(min / 60)
  if (hr < 48) return hr + 'h'
  const d = Math.floor(hr / 24)
  return d + 'd'
}

export function NotesScreen ({ rpc }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null) // { noteId, title, body, bodyFormat, pinned, label } | null
  // 'list' | 'compose' | 'edit' — drives both the editor visibility and the
  // header/eyebrow. We stay in 'list' until the user opens a row (sets `open`)
  // or taps the + New note button.
  const [mode, setMode] = useState('list')
  // `label` is an OPT-IN identifier shown in the sealed list so users can
  // disambiguate notes without opening each one. Lives inside the encrypted
  // envelope — empty by default; user sets it deliberately per note.
  const [draft, setDraft] = useState(EMPTY_DRAFT)

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await rpc.noteList({ limit: 200 })
      setRows(res.notes || [])
    } catch (e) { setErr(errorText(e)) } finally { setLoading(false) }
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  // [AUDIT I-9] Live-refresh on sync. The backend emits a debounced, payload-less
  // 'view-changed' whenever a remote NOTE_UPSERT/NOTE_DELETE materializes into the
  // view (mirrors DevicesScreen's 'sync-ready' subscription). Re-fetch the sealed
  // list so a note synced from another device appears without a manual Refresh.
  // This screen mounts only while unlocked, so no `unlocked` gate is needed.
  useEffect(() => {
    const engine = getMobilePearEnd()
    const off = engine.on('event', (msg) => {
      if (msg && msg.event === 'view-changed') refresh()
    })
    return off
  }, [refresh])

  const openNote = useCallback(async (row) => {
    if (!row.id) return // still sealed/unresolved
    try {
      const res = await rpc.noteOpen({ noteId: row.id })
      setOpen(res.note) // transient plaintext — cleared on close
    } catch (e) { setErr(errorText(e)) }
  }, [rpc])

  // Tell the backend to drop the open item, then clear our local plaintext
  // copy. Used both when the user closes the view and when they leave edit
  // mode without saving (spec §9.4).
  const closeNote = useCallback(async () => {
    if (open && open.noteId) {
      try { await rpc.noteClose({ noteId: open.noteId }) } catch (_) {}
    }
    setOpen(null) // drop plaintext from UI state (spec §15)
  }, [rpc, open])

  const startCompose = useCallback(() => {
    setDraft(EMPTY_DRAFT)
    setMode('compose')
  }, [])

  const startEdit = useCallback(() => {
    if (!open) return
    // Derive temp state from the open note's expiresAt. Pick the smallest
    // preset >= the remaining life so the picker "rounds up" rather than
    // shrinking the note's life when the user just saves without touching it.
    const isTemp = !!(open.expiresAt && open.expiresAt > Date.now())
    let ttlMs = TTL_DEFAULT_MS
    if (isTemp) {
      const remainingMs = Math.max(0, open.expiresAt - Date.now())
      const matched = TTL_OPTIONS.find(o => o.ms >= remainingMs)
      ttlMs = matched ? matched.ms : TTL_OPTIONS[TTL_OPTIONS.length - 1].ms
    }
    setDraft({
      noteId: open.noteId,
      body: open.body || '',
      bodyFormat: open.bodyFormat || 'plain',
      pinned: !!open.pinned,
      // Pre-fill identifier from label OR legacy title so editing a
      // pre-unification note doesn't lose its name.
      label: open.label || open.title || '',
      isTemporary: isTemp,
      ttlMs
    })
    setMode('edit')
  }, [open])

  // Cancelling out of compose/edit. In edit mode we also drop the still-open
  // backend item so a paired device can't keep its decrypted plaintext alive.
  const cancelEdit = useCallback(async () => {
    if (mode === 'edit') await closeNote()
    setMode('list')
    setDraft(EMPTY_DRAFT)
  }, [mode, closeNote])

  const saveDraft = useCallback(async () => {
    try {
      // NOTE_UPSERT contract (backend/notes-service.js): pass `noteId` for an
      // update, omit for a new note. bodyFormat + pinned + label + expiresAt
      // all live inside the encrypted envelope — pass them every time so an
      // existing note's pinned flag isn't silently reset to false on edit,
      // and a temporary note's life can be extended by saving.
      const note = {
        body: draft.body,
        bodyFormat: draft.bodyFormat || 'plain',
        pinned: !!draft.pinned,
        label: draft.label,
        // expiresAt = 0 → persistent; any positive ms timestamp → temporary.
        // Anchor at save time so editing a temp note resets its window.
        expiresAt: draft.isTemporary ? (Date.now() + (draft.ttlMs || TTL_DEFAULT_MS)) : 0
      }
      if (draft.noteId) note.noteId = draft.noteId
      await rpc.noteUpsert({ note })
      // In edit mode the backend still has the previously-decrypted item open
      // until we explicitly close it. Drop it before leaving the editor.
      if (mode === 'edit') await closeNote()
      setMode('list')
      setDraft(EMPTY_DRAFT)
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, draft, mode, closeNote, refresh])

  // `deleteConfirm` carries the noteId + label being staged for hard-delete.
  // Set by either the row's long-press menu OR the editor's Delete button.
  // The confirmation Modal renders below; only on confirm do we actually
  // call NOTE_DELETE with hard=true (cryptographic erasure).
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { noteId, label } | null
  const [okMsg, setOkMsg] = useState(null)

  const requestDelete = useCallback((noteId, label) => {
    if (!noteId) return
    setDeleteConfirm({ noteId, label: label || null })
  }, [])

  const performDelete = useCallback(async () => {
    const c = deleteConfirm
    if (!c) return
    setDeleteConfirm(null)
    try {
      // hard=true → backend's _applyNoteDelete batch.del's the encrypted
      // envelope from the materialized view + removes the search index entry.
      // The signed NOTE_DELETE op replicates so paired devices apply the same
      // erase. Relay-held ciphertext is unreadable (vault key never reached
      // the relay) and the local store no longer carries the envelope at all.
      await rpc.noteDelete({ noteId: c.noteId, hard: true })
      // If this was the open item, drop the plaintext shell state too.
      if (open && open.noteId === c.noteId) setOpen(null)
      // If we were editing it, exit the editor.
      if (draft.noteId === c.noteId) {
        setMode('list'); setDraft(EMPTY_DRAFT)
      }
      setOkMsg(COPY.notes.deleteSucceeded)
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, deleteConfirm, open, draft, refresh])

  // Editor's Delete button now stages the confirmation modal rather than
  // erasing directly. Keeps the gesture consistent with row-level delete.
  const deleteNote = useCallback(() => {
    if (!draft.noteId) return
    requestDelete(draft.noteId, draft.label || null)
  }, [draft, requestDelete])

  // Shared overlay: the hard-delete confirmation Modal. Mounted on every
  // screen branch (list, viewer, editor) so a delete request from anywhere
  // shows the same modal.
  const confirmOverlay = (
    <Modal
      visible={!!deleteConfirm}
      transparent
      animationType="fade"
      onRequestClose={() => setDeleteConfirm(null)}
    >
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <H1 style={{ fontSize: 22, marginBottom: 8 }}>{COPY.notes.deleteConfirmTitle}</H1>
          {deleteConfirm && deleteConfirm.label
            ? <Lede style={{ marginBottom: 6 }}>Erase "{deleteConfirm.label}"?</Lede>
            : <Lede style={{ marginBottom: 6 }}>Erase this note?</Lede>}
          <Hint style={{ marginBottom: 16 }}>{COPY.notes.deleteConfirmBody}</Hint>
          <Button kind="danger" onPress={performDelete}>{COPY.notes.deleteConfirmAction}</Button>
          <View style={{ height: 12 }} />
          <Button kind="ghost" onPress={() => setDeleteConfirm(null)}>Cancel</Button>
        </View>
      </View>
    </Modal>
  )

  // Auto-clear the "Note erased" banner after a few seconds so it doesn't
  // hang around forever. Mirrors desktop's setBanner autohide behaviour.
  useEffect(() => {
    if (!okMsg) return
    const t = setTimeout(() => setOkMsg(null), 4500)
    return () => clearTimeout(t)
  }, [okMsg])

  if (mode === 'compose' || mode === 'edit') {
    const isEdit = mode === 'edit'
    return (
      <View style={styles.wrap}>
        {confirmOverlay}
        <Eyebrow>{isEdit ? 'Edit' : 'Compose'}</Eyebrow>
        <H1>{isEdit ? (draft.label || '(unlabeled)') : COPY.notes.new}</H1>
        <TextInput
          style={inputStyle}
          placeholder={COPY.notes.labelPlaceholder}
          placeholderTextColor={theme.color.faint}
          value={draft.label}
          maxLength={80}
          onChangeText={(t) => setDraft((d) => ({ ...d, label: t }))}
        />
        <Hint style={styles.fieldHint}>{COPY.notes.labelHint}</Hint>
        <TextInput
          style={[inputStyle, styles.body]}
          placeholder={COPY.notes.bodyField}
          placeholderTextColor={theme.color.faint}
          value={draft.body}
          onChangeText={(t) => setDraft((d) => ({ ...d, body: t }))}
          multiline
        />
        {/* Body-format chips — mirror desktop's <select> options (plain /
            markdown / code). Stored in the envelope; surfaced in the sealed
            list as the row meta. */}
        <Text style={styles.fieldLabel}>Format</Text>
        <View style={styles.fmtRow}>
          {['plain', 'markdown', 'code'].map((f) => {
            const active = draft.bodyFormat === f
            return (
              <TouchableOpacity
                key={f}
                onPress={() => setDraft((d) => ({ ...d, bodyFormat: f }))}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.fmtChip, active && styles.fmtChipActive]}
              >
                <Text style={[styles.fmtChipText, active && styles.fmtChipTextActive]}>{f}</Text>
              </TouchableOpacity>
            )
          })}
        </View>
        {/* Pinned toggle — ordering hint only. Lives inside the envelope so
            it's not leaked to relays. Hint copy matches the desktop editor. */}
        <View style={styles.pinRow}>
          <Switch
            value={!!draft.pinned}
            onValueChange={(v) => setDraft((d) => ({ ...d, pinned: v }))}
            trackColor={{ false: theme.color.line, true: theme.color.mint }}
            thumbColor={draft.pinned ? '#04130d' : '#888'}
            accessibilityLabel="Pinned"
          />
          <Text style={styles.pinLabel}>{COPY.notes.pinned} (ordering only — not decrypted)</Text>
        </View>
        {/* Temporary-note toggle. When on, picks a TTL preset; backend
            stores the absolute expiresAt + sweeper hard-deletes (envelope
            erasure) when the time passes. */}
        <View style={styles.pinRow}>
          <Switch
            value={!!draft.isTemporary}
            onValueChange={(v) => setDraft((d) => ({ ...d, isTemporary: v }))}
            trackColor={{ false: theme.color.line, true: theme.color.cyan }}
            thumbColor={draft.isTemporary ? '#031318' : '#888'}
            accessibilityLabel="Make this note temporary"
          />
          <Text style={styles.pinLabel}>{COPY.notes.temporaryToggle}</Text>
        </View>
        <Hint style={styles.fieldHint}>{COPY.notes.temporaryHint}</Hint>
        {draft.isTemporary && (
          <>
            <Text style={styles.fieldLabel}>{COPY.notes.temporaryTtlLabel}</Text>
            <View style={styles.fmtRow}>
              {TTL_OPTIONS.map((o) => {
                const active = draft.ttlMs === o.ms
                return (
                  <TouchableOpacity
                    key={o.ms}
                    onPress={() => setDraft((d) => ({ ...d, ttlMs: o.ms }))}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[styles.fmtChip, active && styles.fmtChipActive]}
                  >
                    <Text style={[styles.fmtChipText, active && styles.fmtChipTextActive]}>{o.label}</Text>
                  </TouchableOpacity>
                )
              })}
            </View>
          </>
        )}
        {err && <Banner kind="error">{err}</Banner>}
        <Button kind="primary" onPress={saveDraft}>{COPY.notes.save}</Button>
        <View style={{ height: 12 }} />
        <Button kind="ghost" onPress={cancelEdit}>Cancel</Button>
        {isEdit && (
          <>
            <View style={{ height: 12 }} />
            <Button kind="danger" onPress={deleteNote}>{COPY.notes.delete}</Button>
          </>
        )}
      </View>
    )
  }

  if (open) {
    // Surface the temporary-note expiry to the reader (desktop equivalent
    // shows a warn chip above the body). Otherwise a user opening a temp
    // note via search wouldn't know it's about to be erased.
    const openExpiresIn = open.expiresAt && open.expiresAt > Date.now()
      ? formatRemaining(open.expiresAt - Date.now())
      : null
    return (
      <View style={styles.wrap}>
        {confirmOverlay}
        <Eyebrow>Open</Eyebrow>
        <H1>{open.label || open.title || '(unlabeled)'}</H1>
        {openExpiresIn && (
          <View style={styles.viewerTempBanner}>
            <Text style={styles.viewerTempText}>
              ⏱ {COPY.notes.temporaryExpiresPrefix} {openExpiresIn}
            </Text>
          </View>
        )}
        <Card style={styles.noteCard}>
          <Text style={styles.noteBody}>{open.body}</Text>
        </Card>
        <Hint style={styles.closeHint}>{COPY.notes.closeHint}</Hint>
        <Button kind="primary" onPress={closeNote}>Close</Button>
        <View style={{ height: 12 }} />
        <Button kind="ghost" onPress={startEdit}>Edit</Button>
        <View style={{ height: 12 }} />
        <Button kind="danger" onPress={() => requestDelete(open.noteId, open.label || open.title || null)}>{COPY.notes.delete}</Button>
      </View>
    )
  }

  return (
    <View style={styles.wrap}>
      {confirmOverlay}
      <View style={styles.headerBlock}>
        <Eyebrow>Vault</Eyebrow>
        <View style={styles.headerRow}>
          <H1 style={{ marginBottom: 0 }}>{COPY.notes.title}</H1>
          <Button kind="primary" onPress={startCompose} accessibilityLabel="New note">+ {COPY.notes.new}</Button>
        </View>
        <Lede>Tap a sealed row to decrypt it. Long-press a row to erase. Closing the note drops the plaintext from memory.</Lede>
      </View>
      {okMsg && <Banner kind="ok">{okMsg}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {loading
        ? <ActivityIndicator color={theme.color.mint} style={{ marginTop: 32 }} />
        : (
          <FlatList
            data={rows}
            keyExtractor={(r) => r.objectBlindId}
            ListEmptyComponent={<Hint style={styles.empty}>{COPY.notes.empty}</Hint>}
            onRefresh={refresh}
            refreshing={loading}
            renderItem={({ item }) => {
              const isPinned = !!item.pinned
              const labelled = item.label && item.label.length > 0
              // Temporary-note remaining-time chip — surfaced into the meta
              // line so the user sees at a glance which notes are about to
              // be erased. Backend list handler already filters past-expiry.
              const tempRemaining = item.expiresAt
                ? (formatRemaining(item.expiresAt - Date.now()) || COPY.notes.temporaryExpiredLabel)
                : null
              // Compose the meta line piecewise so unused chips don't leave
              // dangling separators.
              const metaParts = []
              if (isPinned) metaParts.push(COPY.notes.pinned)
              metaParts.push(item.bodyFormat || 'plain')
              if (tempRemaining) metaParts.push('⏱ ' + COPY.notes.temporaryExpiresPrefix + ' ' + tempRemaining)
              // Only orphan rows from prior CREATE_VAULT cycles arrive here
              // without an `item.id` (only objectBlindId). NOTE_DELETE schema
              // requires a string noteId, so triggering delete without one
              // throws "missing required field: noteId" — desktop had the
              // identical bug and we hide the affordance there. Suppress the
              // long-press handler on orphan rows.
              const canDelete = !!item.id
              return (
                <TouchableOpacity
                  onPress={() => openNote(item)}
                  onLongPress={canDelete ? () => requestDelete(item.id, labelled ? item.label : null) : undefined}
                  delayLongPress={450}
                  accessibilityRole="button"
                  accessibilityHint={canDelete ? 'Press to open. Long-press to delete.' : 'Sealed orphan row — open or pair to restore access.'}
                >
                  <SealedRow
                    icon={isPinned ? '✪' : (item.expiresAt ? '⏱' : '◮')}
                    title={labelled ? item.label : COPY.notes.sealedRow}
                    meta={metaParts.join(' · ')}
                    badge={isPinned ? COPY.notes.pinned.toLowerCase() : (item.expiresAt ? 'temp' : 'sealed')}
                    badgeTone="mint"
                  />
                </TouchableOpacity>
              )
            }}
          />
          )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    padding: 20,
    paddingTop: 56,
    backgroundColor: theme.color.bg
  },
  headerBlock: {
    marginBottom: 12
  },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  body: {
    minHeight: 200,
    textAlignVertical: 'top'
  },
  noteCard: {
    marginBottom: 14
  },
  noteBody: {
    color: theme.color.text,
    fontSize: 15,
    lineHeight: 23
  },
  closeHint: {
    marginBottom: 16
  },
  fieldHint: {
    marginTop: -8,
    marginBottom: 12
  },
  fieldLabel: {
    color: theme.color.muted,
    fontSize: 12,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8
  },
  fmtRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 16
  },
  fmtChip: {
    borderWidth: 1,
    borderColor: theme.color.line,
    borderRadius: theme.radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 14,
    marginRight: 8,
    backgroundColor: 'rgba(255,255,255,0.03)'
  },
  fmtChipActive: {
    borderColor: theme.color.mint,
    backgroundColor: 'rgba(74,222,128,0.12)'
  },
  fmtChipText: {
    color: theme.color.muted,
    fontSize: 13,
    fontWeight: '600'
  },
  fmtChipTextActive: {
    color: theme.color.mint
  },
  pinRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 16
  },
  pinLabel: {
    color: theme.color.muted,
    fontSize: 14,
    flexShrink: 1,
    marginLeft: 12
  },
  empty: {
    textAlign: 'center',
    marginTop: 60,
    color: theme.color.faint,
    fontSize: 14
  },
  // Cyan-tinted banner shown above the body when reading a temporary note.
  // Visual companion to the cyan ⏱ chip in the list row.
  viewerTempBanner: {
    borderWidth: 1,
    borderColor: 'rgba(34,211,238,0.35)',
    backgroundColor: 'rgba(34,211,238,0.08)',
    borderRadius: theme.radius.md,
    paddingVertical: 10,
    paddingHorizontal: 14,
    marginBottom: 12
  },
  viewerTempText: {
    color: theme.color.cyan,
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums']
  },
  // Modal styles — dim full-screen backdrop centred on a hero card with the
  // confirmation copy + danger / cancel buttons. Mirrors the desktop modal.
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    padding: 20,
    justifyContent: 'center'
  },
  modalCard: {
    backgroundColor: theme.color.surface,
    borderColor: theme.color.line,
    borderWidth: 1,
    borderRadius: theme.radius.xl,
    padding: 22
  }
})

export default NotesScreen
