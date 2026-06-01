// Paste — ClipsScreen — recent clips (sealed) + honest mobile clipboard (spec §13).
//
// Mobile clipboard reality is explicit here: iOS/Android forbid silent
// background monitoring, so capture is (a) paste into the app, (b) copy from
// the app, (c) share-sheet (handled by the OS share extension -> CLIP_CAPTURE).
// We never claim invisible background sync; the per-OS note is shown inline.
//
// CLIP_LIST returns sealed rows. "Copy" calls CLIP_COPY which decrypts the one
// clip, returns it for the OS clipboard, and the backend clears app-held
// plaintext immediately after (spec §9.4).

import React, { useCallback, useEffect, useState } from 'react'
import {
  View, Text, FlatList, TextInput, StyleSheet, ActivityIndicator,
  Platform
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { theme } from '../lib/theme'
import { Eyebrow, H1, Lede, Banner, Button, SealedRow, Chip, Hint, inputStyle } from '../lib/ui'

// @react-native-clipboard/clipboard is the maintained module (installed).
// RN core's Clipboard was removed and is a no-op under the New Architecture,
// so we must NOT reference it (importing it also triggers a deprecation
// warning). Benign no-op fallback keeps the screen building if the native
// module is somehow absent.
let Clipboard = { getString: async () => '', setString: () => {} }
try { Clipboard = require('@react-native-clipboard/clipboard').default } catch (_) {}

export function ClipsScreen ({ rpc }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [note, setNote] = useState(null)
  const [pasteBuf, setPasteBuf] = useState('')

  const osNote = Platform.OS === 'ios' ? COPY.clips.osNoteIOS : COPY.clips.osNoteAndroid

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await rpc.clipList({ limit: 100 })
      setRows(res.clips || [])
    } catch (e) { setErr(errorText(e)) } finally { setLoading(false) }
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  // Capture: read the OS clipboard ONCE on explicit user tap (foreground,
  // user-initiated — not a poll loop). Or capture the in-app paste field.
  const captureFromClipboard = useCallback(async () => {
    try {
      const text = await Clipboard.getString()
      if (!text) { setNote('Clipboard is empty.'); return }
      await rpc.clipCapture({ kind: 'text', body: text })
      setNote('Captured from clipboard.')
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, refresh])

  const captureTyped = useCallback(async () => {
    if (!pasteBuf) return
    try {
      await rpc.clipCapture({ kind: 'text', body: pasteBuf })
      setPasteBuf(''); setNote('Captured.')
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, pasteBuf, refresh])

  const copyClip = useCallback(async (row) => {
    if (!row.id) return
    try {
      const res = await rpc.clipCopy({ clipId: row.id })
      Clipboard.setString(res.body) // OS clipboard write; backend already dropped its copy
      setNote(COPY.clips.copied)
    } catch (e) { setErr(errorText(e)) }
  }, [rpc])

  return (
    <View style={styles.wrap}>
      <Eyebrow>Clips</Eyebrow>
      <H1>{COPY.clips.title}</H1>
      <Banner kind="warn">{osNote}</Banner>

      <View style={styles.captureRow}>
        <TextInput
          style={[inputStyle, styles.captureInput]}
          placeholder={COPY.clips.pasteField}
          placeholderTextColor={theme.color.faint}
          value={pasteBuf}
          onChangeText={setPasteBuf}
        />
        <Button kind="primary" onPress={captureTyped} style={styles.captureBtn}>Save</Button>
      </View>
      <Button kind="ghost" onPress={captureFromClipboard}>{COPY.clips.paste}</Button>

      {note && <View style={{ marginTop: 12 }}><Banner kind="ok">{note}</Banner></View>}
      {err && <View style={{ marginTop: 12 }}><Banner kind="error">{err}</Banner></View>}

      {loading
        ? <ActivityIndicator color={theme.color.mint} style={{ marginTop: 24 }} />
        : (
          <FlatList
            style={{ marginTop: 14 }}
            data={rows}
            keyExtractor={(r) => r.objectBlindId}
            ListEmptyComponent={<Hint style={styles.empty}>{COPY.clips.empty}</Hint>}
            onRefresh={refresh}
            refreshing={loading}
            renderItem={({ item }) => (
              <SealedRow
                icon={'❒'}
                title={COPY.clips.sealedRow}
                meta={item.kind || 'text'}
                badge={null}
                onPress={null}
                right={
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <Chip tone="mint">sealed</Chip>
                    <Button kind="ghost" onPress={() => copyClip(item)} style={styles.copyBtn} textStyle={{ fontSize: 13 }}>
                      {COPY.clips.copy}
                    </Button>
                  </View>
                }
              />
            )}
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
  captureRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    marginTop: 4
  },
  captureInput: {
    flex: 1,
    marginRight: 10,
    marginBottom: 0
  },
  captureBtn: {
    paddingHorizontal: 18,
    minHeight: 50,
    marginTop: 0
  },
  copyBtn: {
    paddingVertical: 8,
    paddingHorizontal: 14,
    minHeight: 36
  },
  empty: {
    textAlign: 'center',
    marginTop: 60,
    color: theme.color.faint,
    fontSize: 14
  }
})

export default ClipsScreen
