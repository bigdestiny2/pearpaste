// Paste — WorkletErrorBoundary — recoverable error UI for a dead Pear-end worklet.
//
// Satisfies spec §13 / §21 Agent-4 acceptance: "App handles worklet crash with
// recoverable error UI." When usePearPasteRpc reports status 'crashed', every
// screen is replaced by this panel which offers a retry that restarts the
// worklet (re-deriving nothing — local encrypted data is untouched on disk).

import React from 'react'
import { View, ScrollView, StyleSheet } from 'react-native'
import { COPY } from '../lib/copy'
import { theme } from '../lib/theme'
import { Eyebrow, H1, Lede, Button, TerminalPanel, Banner } from '../lib/ui'

export function WorkletErrorBoundary ({ crashed, crash, onRetry, children }) {
  if (!crashed) return children

  const traceLines = []
  if (crash && (crash.reason || crash.code || crash.message || crash.lastStage || crash.stack)) {
    if (crash.code) traceLines.push({ kind: 'warn', text: '[' + crash.code + ']' })
    if (crash.reason) traceLines.push({ kind: 'dim', text: 'reason: ' + crash.reason })
    if (crash.lastStage) traceLines.push({ kind: 'cmd', text: 'last stage: ' + String(crash.lastStage).slice(0, 200) })
    if (crash.message) {
      const msg = String(crash.message).slice(0, 800)
      msg.split(/\n/).forEach((l) => traceLines.push({ kind: 'text', text: l }))
    }
    if (crash.stack) {
      const stk = String(crash.stack).slice(0, 1200)
      stk.split(/\n/).forEach((l) => traceLines.push({ kind: 'dim', text: l }))
    }
  } else {
    traceLines.push({ kind: 'dim', text: 'The background engine exited.' })
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap} accessibilityRole="alert">
      <Eyebrow>Engine status</Eyebrow>
      <H1>Engine crashed</H1>
      <Lede>{COPY.errors.crashed}</Lede>

      <Banner kind="ok">Your notes and clips stay encrypted on this device. Nothing was lost.</Banner>

      <TerminalPanel filename="crash.trace" lines={traceLines} />

      <View style={{ height: theme.spacing.xl }} />
      <Button kind="primary" onPress={onRetry}>{COPY.errors.retry}</Button>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: {
    flexGrow: 1,
    padding: 24,
    paddingTop: 64,
    backgroundColor: theme.color.bg
  }
})

export default WorkletErrorBoundary
