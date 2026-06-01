// Paste — UnlockScreen — vault unlock / create / restore entry (spec §13, §14).
//
// Calls UNLOCK_VAULT with the passphrase. On NO_VAULT it routes to create or
// restore. CREATE_VAULT returns the 24-word phrase exactly once — it is shown
// on a confirm gate and never persisted by the UI (spec §14, renderer
// contract permits mnemonic only on this one response).

import React, { useState } from 'react'
import {
  View, Text, TextInput, ScrollView, StyleSheet
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { currentDevicePlatform } from '../lib/platform'
import { theme, hexA } from '../lib/theme'
import { Eyebrow, H1, Lede, Hint, Banner, Button, GradientBorder, GradientBrandMark, inputStyle } from '../lib/ui'

export function UnlockScreen ({ rpc, onUnlocked, onGoRestore, onGoPair }) {
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [needCreate, setNeedCreate] = useState(false)
  const [label, setLabel] = useState('My phone')
  const [phrase, setPhrase] = useState(null) // shown once after create

  async function unlock () {
    setBusy(true); setErr(null)
    try {
      await rpc.unlockVault({ secret, source: 'passphrase' })
      onUnlocked()
    } catch (e) {
      if (e.code === 'NO_VAULT') setNeedCreate(true)
      else setErr(errorText(e))
    } finally { setBusy(false) }
  }

  async function create () {
    setBusy(true); setErr(null)
    try {
      const res = await rpc.createVault({ label, platform: currentDevicePlatform(), passphrase: secret })
      setPhrase(res.mnemonic) // one-time display only
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }

  if (phrase) {
    const words = phrase.split(/\s+/)
    return (
      <ScrollView contentContainerStyle={styles.wrap}>
        <Eyebrow>One-time display</Eyebrow>
        <H1>{COPY.create.phraseTitle}</H1>
        <Banner kind="warn">{COPY.create.phraseWarn}</Banner>
        <View style={styles.phraseGrid}>
          {words.map((w, i) => (
            <View key={i} style={styles.wordCard}>
              <Text style={styles.wordIdx}>{String(i + 1).padStart(2, '0')}</Text>
              <Text style={styles.wordText}>{w}</Text>
            </View>
          ))}
        </View>
        <Button kind="primary" onPress={() => { setPhrase(null); onUnlocked() }}>
          {COPY.create.phraseConfirm}
        </Button>
      </ScrollView>
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      {/* Hero card — gradient-ringed brand mark sits inside a gradient border
          so the unlock screen opens with a strong brand statement. The form
          below stays as a plain card to preserve hierarchy. */}
      <GradientBorder radius={theme.radius.xl} thickness={1.5} style={styles.heroWrap} innerStyle={{ backgroundColor: theme.color.surface }}>
        <View style={styles.heroInner}>
          <GradientBrandMark iconSize={56} wordSize={32} tagline={COPY.tagline} />
        </View>
      </GradientBorder>

      <Eyebrow>{needCreate ? 'New vault' : 'Encrypted on this device'}</Eyebrow>
      <H1>{needCreate ? COPY.create.title : COPY.unlock.title}</H1>
      <Lede>{needCreate ? COPY.unlock.noVault : COPY.unlock.hint}</Lede>

      {needCreate && (
        <TextInput
          style={inputStyle}
          value={label}
          onChangeText={setLabel}
          placeholder={COPY.create.labelField}
          placeholderTextColor={theme.color.faint}
        />
      )}

      <TextInput
        style={inputStyle}
        value={secret}
        onChangeText={setSecret}
        placeholder={needCreate ? COPY.create.passphraseField : COPY.unlock.secretLabel}
        placeholderTextColor={theme.color.faint}
        secureTextEntry
        autoCapitalize="none"
      />

      {err && <Banner kind="error">{err}</Banner>}

      <Button kind="primary" busy={busy} onPress={needCreate ? create : unlock}>
        {needCreate ? COPY.create.button : COPY.unlock.button}
      </Button>

      {/* First-time-user affordance: Unlock previously hid the create-vault
          flow until you typed a wrong passphrase and triggered NO_VAULT.
          An explicit ghost button surfaces it. Hidden while in needCreate
          mode (the primary button IS the create action then). */}
      {!needCreate && (
        <>
          <View style={{ height: 10 }} />
          <Button kind="ghost" onPress={() => setNeedCreate(true)}>Create a new vault</Button>
        </>
      )}
      <View style={{ height: 10 }} />
      <Button kind="ghost" onPress={onGoRestore}>{COPY.unlock.restore}</Button>
      <View style={{ height: 10 }} />
      <Button kind="ghost" onPress={onGoPair}>{COPY.unlock.pair}</Button>
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
  // Hero card holds the GradientBrandMark behind a gradient border. Slightly
  // wider padding so the brand glyph and wordmark breathe inside the ring.
  heroWrap: {
    marginBottom: 28
  },
  heroInner: {
    paddingVertical: 26,
    paddingHorizontal: 20,
    alignItems: 'center'
  },
  phraseGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginBottom: 20,
    marginHorizontal: -4
  },
  wordCard: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '50%',
    paddingHorizontal: 4,
    paddingVertical: 4
  },
  wordIdx: {
    color: theme.color.accent,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: theme.font.family.mono,
    width: 28,
    backgroundColor: hexA(theme.color.mint, 0.08),
    borderRadius: 6,
    paddingVertical: 4,
    textAlign: 'center',
    marginRight: 8
  },
  wordText: {
    color: theme.color.text,
    fontSize: 14,
    fontWeight: '500',
    flex: 1
  }
})

export default UnlockScreen
