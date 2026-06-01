// Paste — RestoreScreen — recovery-phrase restore (spec §14 recovery restore).
//
// RESTORE_VAULT with the 24-word phrase + optional passphrase. The backend
// derives keys, locates the vault by deterministic topic, and (per §14) either
// self-authorizes or, in high-security mode, requires an existing device. The
// phrase never leaves this screen's transient state and is never persisted.

import React, { useState } from 'react'
import {
  View, Text, TextInput, ScrollView, StyleSheet, Switch
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { theme } from '../lib/theme'
import { Eyebrow, H1, Lede, Banner, Button, inputStyle } from '../lib/ui'

export function RestoreScreen ({ rpc, onRestored, onBack }) {
  const [phrase, setPhrase] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [highSec, setHighSec] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [info, setInfo] = useState(null)

  async function restore () {
    setBusy(true); setErr(null); setInfo(null)
    try {
      const res = await rpc.restoreVault({
        mnemonic: phrase.trim().replace(/\s+/g, ' '),
        passphrase,
        highSecurity: highSec
      })
      if (res && res.approvalRequired) {
        setInfo('Recovery phrase verified. Pair from an existing trusted device to join sync.')
        return
      }
      onRestored()
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Eyebrow>Restore</Eyebrow>
      <H1>{COPY.restore.title}</H1>
      <Lede>{COPY.restore.hint}</Lede>

      <TextInput
        style={[inputStyle, styles.phrase]}
        placeholder={COPY.restore.field}
        placeholderTextColor={theme.color.faint}
        value={phrase}
        onChangeText={setPhrase}
        autoCapitalize="none"
        autoCorrect={false}
        multiline
      />
      <TextInput
        style={inputStyle}
        placeholder={COPY.restore.passphraseField}
        placeholderTextColor={theme.color.faint}
        value={passphrase}
        onChangeText={setPassphrase}
        secureTextEntry
        autoCapitalize="none"
      />

      <View style={styles.switchRow}>
        <Text style={styles.switchLabel}>High security (require existing device)</Text>
        <Switch
          value={highSec}
          onValueChange={setHighSec}
          trackColor={{ false: theme.color.surface2, true: theme.color.mint }}
          thumbColor={highSec ? '#04130d' : '#e9eef3'}
        />
      </View>

      {err && <Banner kind="error">{err}</Banner>}
      {info && <Banner kind="ok">{info}</Banner>}

      <Button kind="primary" busy={busy} onPress={restore}>{COPY.restore.button}</Button>
      <View style={{ height: 12 }} />
      <Button kind="ghost" onPress={onBack}>Back</Button>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: {
    padding: 24,
    paddingTop: 56,
    backgroundColor: theme.color.bg,
    flexGrow: 1
  },
  phrase: {
    minHeight: 120,
    textAlignVertical: 'top'
  },
  switchRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18,
    backgroundColor: theme.color.surface,
    borderColor: theme.color.line,
    borderWidth: 1,
    borderRadius: theme.radius.md,
    paddingHorizontal: 14,
    paddingVertical: 12
  },
  switchLabel: {
    color: theme.color.text,
    fontSize: 14,
    flex: 1,
    marginRight: 12,
    fontWeight: '500'
  }
})

export default RestoreScreen
