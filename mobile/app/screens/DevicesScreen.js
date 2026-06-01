// Paste — DevicesScreen — list paired devices + revoke + open the pair flow.
//
// Mirrors desktop's devicesScreen (ui/desktop/app.js). DEVICE_LIST returns one
// row per device (label, platform, roles, revoked flag, optionally sealed
// before sync resolves). Revoke routes through a Modal confirmation that
// explains key rotation, then issues DEVICE_REVOKE; on success the row
// re-renders as revoked and the backend rotates content keys so the revoked
// device can't read future writes (spec §14 step 8 / §22).
//
// The PairScreen flow is mounted INSIDE this screen when the user taps "Pair
// a new device" so the tab is one coherent device-management surface (matches
// desktop, which puts both list and pair on the same screen).

import React, { useCallback, useEffect, useState } from 'react'
import {
  View, Text, FlatList, StyleSheet, ActivityIndicator, Modal, TouchableOpacity
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { theme, hexA } from '../lib/theme'
import { Eyebrow, H1, Lede, Hint, Banner, Button, Card, SealedRow } from '../lib/ui'
import { PairScreen } from './PairScreen'
import { getMobilePearEnd } from '../lib/MobilePearEnd'

export function DevicesScreen ({ rpc, unlocked, relayCount = 0, pairRequest = null }) {
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [okMsg, setOkMsg] = useState(null)
  // 'list' = device list (default). 'pair' = embedded PairScreen for adding
  // a new device. A back button on the pair view returns to the list.
  const [mode, setMode] = useState('list')
  // Staged revoke confirmation. Same shape pattern as NotesScreen's delete.
  const [revokeConfirm, setRevokeConfirm] = useState(null) // { deviceId, label } | null

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res = await rpc.deviceList({})
      setDevices(res.devices || [])
    } catch (e) { setErr(errorText(e)) } finally { setLoading(false) }
  }, [rpc])

  useEffect(() => { if (unlocked) refresh() }, [unlocked, refresh])

  // Backend emits 'sync-ready' once the autobase materialized view resolves,
  // and 'paired' after a new device joins. Both are signals that the list
  // we showed (possibly all "Sealed device record" placeholders) is now stale.
  // Re-fetch so the rows flip from sealed → real entries, and the Revoke
  // button can actually render for the non-sealed devices.
  useEffect(() => {
    if (!unlocked) return
    const engine = getMobilePearEnd()
    const off = engine.on('event', (msg) => {
      const ev = msg && msg.event
      if (ev === 'sync-ready' || ev === 'paired' || ev === 'device-revoked') refresh()
    })
    return off
  }, [unlocked, refresh])

  // Auto-clear the success banner after a few seconds so it doesn't linger.
  useEffect(() => {
    if (!okMsg) return
    const t = setTimeout(() => setOkMsg(null), 4500)
    return () => clearTimeout(t)
  }, [okMsg])

  const requestRevoke = useCallback((deviceId, label) => {
    if (!deviceId) return
    setRevokeConfirm({ deviceId, label: label || null })
  }, [])

  const performRevoke = useCallback(async () => {
    const c = revokeConfirm
    if (!c) return
    setRevokeConfirm(null)
    try {
      // DEVICE_REVOKE in the backend appends a signed DEVICE_REVOKE op and
      // rotates content keys (spec §14 step 8). The revoked device's
      // signing pubkey is dropped from the authorized set; any further ops
      // it tries to publish are rejected by every paired device's reducer.
      await rpc.deviceRevoke({ deviceId: c.deviceId })
      setOkMsg(COPY.devices.revokeSucceeded)
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, revokeConfirm, refresh])

  // Modal overlay — mounted on every branch so a revoke request from
  // anywhere in this screen shows the same confirmation card.
  const confirmOverlay = (
    <Modal
      visible={!!revokeConfirm}
      transparent
      animationType="fade"
      onRequestClose={() => setRevokeConfirm(null)}
    >
      <View style={styles.modalBg}>
        <View style={styles.modalCard}>
          <H1 style={{ fontSize: 22, marginBottom: 8 }}>{COPY.devices.revokeConfirmTitle}</H1>
          {revokeConfirm && revokeConfirm.label
            ? <Lede style={{ marginBottom: 6 }}>Revoke "{revokeConfirm.label}"?</Lede>
            : <Lede style={{ marginBottom: 6 }}>Revoke this device?</Lede>}
          <Hint style={{ marginBottom: 16 }}>{COPY.devices.revokeConfirmBody}</Hint>
          <Button kind="danger" onPress={performRevoke}>{COPY.devices.revokeConfirmAction}</Button>
          <View style={{ height: 12 }} />
          <Button kind="ghost" onPress={() => setRevokeConfirm(null)}>Cancel</Button>
        </View>
      </View>
    </Modal>
  )

  // Embedded pair flow. Re-uses PairScreen as-is; back button returns to
  // the device list so the user lands somewhere coherent after pairing.
  if (mode === 'pair') {
    return (
      <View style={styles.wrap}>
        {confirmOverlay}
        <TouchableOpacity onPress={() => { setMode('list'); refresh() }} accessibilityRole="button">
          <Text style={styles.backLink}>‹ Back to devices</Text>
        </TouchableOpacity>
        <PairScreen rpc={rpc} unlocked={unlocked} relayCount={relayCount} pairRequest={pairRequest} />
      </View>
    )
  }

  return (
    <View style={styles.wrap}>
      {confirmOverlay}
      <View style={styles.headerBlock}>
        <Eyebrow>Vault</Eyebrow>
        <H1 style={{ marginBottom: 4 }}>{COPY.devices.title}</H1>
        <Lede>{COPY.devices.blurb}</Lede>
      </View>
      {okMsg && <Banner kind="ok">{okMsg}</Banner>}
      {err && <Banner kind="error">{err}</Banner>}
      {loading
        ? <ActivityIndicator color={theme.color.mint} style={{ marginTop: 32 }} />
        : (
          <FlatList
            data={devices}
            keyExtractor={(d, i) => d.deviceId || d.objectBlindId || String(i)}
            ListEmptyComponent={<Hint style={styles.empty}>{COPY.devices.empty}</Hint>}
            onRefresh={refresh}
            refreshing={loading}
            renderItem={({ item: d }) => {
              const title = d.sealed ? COPY.devices.sealedRow : (d.label || d.deviceId || 'unknown')
              const meta = d.sealed
                ? null
                : [d.platform, (d.roles || []).join(','), d.revoked ? COPY.devices.revokedSuffix : null]
                    .filter(Boolean).join(' · ')
              const canRevoke = !d.sealed && !d.revoked
              return (
                <View style={styles.deviceRow}>
                  <SealedRow
                    icon={d.revoked ? '⌀' : '▣'}
                    title={title}
                    meta={meta}
                    badge={d.sealed ? 'sealed' : (d.revoked ? COPY.devices.revokedSuffix : 'active')}
                    badgeTone={d.sealed ? 'gradient' : (d.revoked ? 'muted' : 'mint')}
                  />
                  {canRevoke && (
                    <View style={styles.revokeRow}>
                      <Button kind="danger" onPress={() => requestRevoke(d.deviceId, d.label || d.platform || null)}>
                        {COPY.devices.revoke}
                      </Button>
                    </View>
                  )}
                </View>
              )
            }}
          />
          )}
      {/* Permanent pair affordance — desktop has it at the top of the
          devices screen too. Sticky-bottom feels more natural on mobile. */}
      <View style={styles.pairCtaWrap}>
        <Button kind="primary" onPress={() => setMode('pair')}>{COPY.devices.pairAction}</Button>
      </View>
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
    marginBottom: 16
  },
  empty: {
    textAlign: 'center',
    marginTop: 60,
    color: theme.color.faint,
    fontSize: 14
  },
  deviceRow: {
    marginBottom: 6
  },
  revokeRow: {
    marginTop: -4,
    marginBottom: 14,
    paddingLeft: 12,
    paddingRight: 12
  },
  pairCtaWrap: {
    marginTop: 12,
    paddingTop: 16,
    borderTopColor: theme.color.line,
    borderTopWidth: 1
  },
  backLink: {
    color: theme.color.mint,
    fontSize: 14,
    fontWeight: '600',
    marginBottom: 12
  },
  // Modal styles mirror NotesScreen's so the two confirmation modals look
  // visually identical (one consistent destructive-action pattern).
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

export default DevicesScreen
