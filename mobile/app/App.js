// Paste — mobile App shell.
//
// Dependency-light navigation (no react-navigation) to keep the RN bundle
// small (spec §3 performance / §13 "avoid heavy frameworks"). Flow:
//
//   worklet starting -> splash
//   worklet crashed  -> WorkletErrorBoundary (retry)
//   locked           -> Unlock | Restore | Pair(accept)
//   unlocked         -> tabs: Notes | Clips | Pair | Relay&Proof
//
// The lock gate is derived from RPC: any unlock/create/restore/pair-accept
// success flips `unlocked`. LOCK on background is left to the worklet's Bare
// 'suspend' hook (drops decrypted items) per spec §9.4.

import React, { useCallback, useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native'
// SafeAreaView was removed from react-native core; use the dedicated package
// (installed). SafeAreaProvider must wrap the tree for insets to resolve.
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { LinearGradient } from 'expo-linear-gradient'
import { usePearPasteRpc } from './lib/usePearPasteRpc'
import { COPY } from './lib/copy'
import { theme, hexA, gradientProps } from './lib/theme'
import { GradientBrandMark, Hint } from './lib/ui'
import { WorkletErrorBoundary } from './screens/WorkletErrorBoundary'
import { UnlockScreen } from './screens/UnlockScreen'
import { RestoreScreen } from './screens/RestoreScreen'
import { PairScreen } from './screens/PairScreen'
import { NotesScreen } from './screens/NotesScreen'
import { ClipsScreen } from './screens/ClipsScreen'
import { DevicesScreen } from './screens/DevicesScreen'
import { RelayProofScreen } from './screens/RelayProofScreen'

// Splash: dark base, brand-tinted diagonal gradient wash, and a soft centered
// halo so the brand mark pops. The gradient palette comes from theme.gradient
// (mint → cyan → blue). Two stacked LinearGradients (no true radial in
// expo-linear-gradient, so the centered halo is two vertical/horizontal soft
// gradients composited). Visible whenever the worklet is in 'starting' / 'idle'.
function Splash () {
  return (
    <View style={styles.splash}>
      {/* Diagonal brand-tinted wash, fades to transparent in the bottom-right */}
      <LinearGradient
        colors={[
          hexA(theme.color.mint, 0.22),
          hexA(theme.color.cyan, 0.16),
          hexA(theme.color.violet, 0.14),
          hexA(theme.color.bg, 0)
        ]}
        locations={[0, 0.4, 0.7, 1]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Soft vertical halo through the center for a "glow behind the mark" */}
      <LinearGradient
        colors={[hexA(theme.color.bg, 0), hexA(theme.color.mint, 0.18), hexA(theme.color.bg, 0)]}
        locations={[0, 0.5, 1]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 1 }}
        style={styles.splashHalo}
        pointerEvents="none"
      />
      {/* Faint top-right cyan accent, like a soft sunrise */}
      <LinearGradient
        colors={[hexA(theme.color.cyan, 0.18), hexA(theme.color.bg, 0)]}
        start={{ x: 1, y: 0 }}
        end={{ x: 0.3, y: 0.6 }}
        style={styles.splashCorner}
        pointerEvents="none"
      />
      <SafeAreaView style={styles.splashCenter}>
        {/* Hero brand mark: gradient-ring icon + wordmark + gradient accent bar */}
        <GradientBrandMark iconSize={76} wordSize={40} tagline={COPY.tagline} />
        <Hint style={styles.splashHint}>{COPY.splashHint}</Hint>
        <ActivityIndicator color={theme.color.mint} style={{ marginTop: 22 }} />
      </SafeAreaView>
    </View>
  )
}

// Tab structure mirrors desktop's sidebar: Notes / Clips / Devices (list +
// revoke + pair) / Proof. The Devices tab subsumes what used to be a
// pair-only tab — pairing IS device management, and there was no surface
// to list/revoke paired devices on mobile until this tab was unified.
const TABS = [
  { key: 'notes', label: 'Notes', C: NotesScreen },
  { key: 'clips', label: 'Clips', C: ClipsScreen },
  { key: 'devices', label: 'Devices', C: DevicesScreen },
  { key: 'relay', label: 'Proof', C: RelayProofScreen }
]

function AppInner () {
  const { rpc, status, crashed, crash, relayCount, pairRequest, retry } = usePearPasteRpc()
  const [unlocked, setUnlocked] = useState(false)
  const [lockView, setLockView] = useState('unlock') // unlock | restore | pair
  const [tab, setTab] = useState('notes')

  const onUnlocked = useCallback(() => setUnlocked(true), [])

  if (status === 'starting' || status === 'idle') {
    return <Splash />
  }

  return (
    <SafeAreaView style={styles.root}>
      <WorkletErrorBoundary crashed={crashed} crash={crash} onRetry={retry}>
        {!unlocked
          ? (
            <>
              {lockView === 'unlock' && (
                <UnlockScreen
                  rpc={rpc}
                  onUnlocked={onUnlocked}
                  onGoRestore={() => setLockView('restore')}
                  onGoPair={() => setLockView('pair')}
                />
              )}
              {lockView === 'restore' && (
                <RestoreScreen rpc={rpc} onRestored={onUnlocked} onBack={() => setLockView('unlock')} />
              )}
              {lockView === 'pair' && (
                <View style={{ flex: 1 }}>
                  <PairScreen rpc={rpc} unlocked={false} relayCount={relayCount} pairRequest={pairRequest} />
                  <TouchableOpacity onPress={() => setLockView('unlock')} accessibilityRole="button">
                    <Text style={styles.back}>Back to unlock</Text>
                  </TouchableOpacity>
                </View>
              )}
            </>
            )
          : (
            <View style={{ flex: 1 }}>
              <View style={{ flex: 1 }}>
                {TABS.map(({ key, C }) =>
                  key === tab ? <C key={key} rpc={rpc} unlocked relayCount={relayCount} pairRequest={pairRequest} /> : null
                )}
              </View>
              <View style={styles.tabBar}>
                {TABS.map(({ key, label }) => {
                  const active = tab === key
                  return (
                    <TouchableOpacity
                      key={key}
                      style={styles.tabItem}
                      onPress={() => setTab(key)}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      {active
                        ? <LinearGradient {...gradientProps()} style={styles.tabMarker} />
                        : <View style={styles.tabMarkerSpacer} />}
                      <Text style={[styles.tabText, active && styles.tabTextActive]}>{label}</Text>
                    </TouchableOpacity>
                  )
                })}
              </View>
            </View>
            )}
      </WorkletErrorBoundary>
    </SafeAreaView>
  )
}

// SafeAreaProvider must be an ancestor of every SafeAreaView so insets resolve
// (react-native-safe-area-context). Root wrapper keeps AppInner unchanged.
export default function App () {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  splash: { flex: 1, backgroundColor: theme.color.bg, overflow: 'hidden' },
  splashHalo: {
    position: 'absolute',
    left: '-25%',
    right: '-25%',
    top: '20%',
    height: '60%'
  },
  splashCorner: {
    position: 'absolute',
    right: 0,
    top: 0,
    width: '70%',
    height: '55%'
  },
  splashCenter: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  splashHint: {
    color: theme.color.faint,
    fontSize: 13,
    marginTop: 24,
    textAlign: 'center'
  },
  back: {
    color: theme.color.muted,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 16
  },
  tabBar: {
    flexDirection: 'row',
    borderTopColor: theme.color.line,
    borderTopWidth: 1,
    backgroundColor: theme.color.bg2,
    paddingTop: 8,
    paddingBottom: 6
  },
  tabItem: {
    flex: 1,
    paddingVertical: 8,
    alignItems: 'center',
    justifyContent: 'flex-start'
  },
  // Active tab marker — a 3-px wide gradient bar centered above the label, so
  // the brand mint→cyan→blue gradient signals selection (not just mint text).
  tabMarker: {
    width: 28,
    height: 3,
    borderRadius: 2,
    marginBottom: 6
  },
  tabMarkerSpacer: {
    width: 28,
    height: 3,
    backgroundColor: 'transparent',
    marginBottom: 6
  },
  tabText: {
    color: theme.color.muted,
    fontSize: 13,
    fontWeight: '600'
  },
  tabTextActive: {
    color: theme.color.mint
  }
})
