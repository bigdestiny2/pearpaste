// Paste — RelayProofScreen — relay status + encryption proof (spec §11, §8.4, §19).
//
// RELAY_STATUS works while locked and never throws (backend guarantees a
// status object even when relays are down). VERIFY_ENCRYPTION runs the local
// verifier and returns a pass/fail report. Copy obeys §19: "Relays store
// encrypted blocks", "Reduced availability", "Run encryption verifier", plus
// the honest deletion-limit caveat (§8.4).

import React, { useCallback, useEffect, useState } from 'react'
import {
  View, Text, StyleSheet, ActivityIndicator, Switch, ScrollView
} from 'react-native'
import { COPY, errorText } from '../lib/copy'
import { theme } from '../lib/theme'
import { Eyebrow, H1, Lede, Banner, Button, Card, Chip, Hint, TerminalPanel } from '../lib/ui'

function Stat ({ label, value, last }) {
  return (
    <View style={[styles.stat, last && styles.statLast]}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  )
}

function buildProofLines (proof) {
  if (!proof) return []
  // Backend (verifier.js buildProofReport) returns: { passed, lines:string[],
  // summary, counts, lastRun, proofVersion }. The previous read of proof.ok
  // and proof.checks was a field-name mismatch — both were always undefined,
  // which is why every run rendered "FAIL local encryption check failed"
  // regardless of the actual result. Render the backend's per-line text
  // directly; classify each line for terminal kind by content.
  const out = []
  const passed = !!proof.passed
  out.push({ kind: 'cmd', text: '$ paste verify --local' })
  out.push({
    kind: passed ? 'ok' : 'warn',
    text: (passed ? 'PASS  ' : 'FAIL  ') + 'verifier ' + (passed ? 'passed' : 'reported a failure')
  })
  const arr = Array.isArray(proof.lines) ? proof.lines : []
  for (const ln of arr) {
    const s = String(ln || '')
    let kind = 'text'
    if (/FAILED/.test(s)) kind = 'warn'
    else if (/^Limit:/.test(s)) kind = 'dim'
    else if (/passed|valid|rejected|no plaintext|accepted|verifier: last run/i.test(s)) kind = 'ok'
    out.push({ kind, text: s })
  }
  if (!arr.length) {
    // Defensive: if backend omitted `lines`, fall back to the static limit
    // disclosure so the panel still carries the §4 deletion-limit wording.
    out.push({ kind: 'dim', text: 'Limit: ' + COPY.relay.deletionLimit })
  }
  return out
}

export function RelayProofScreen ({ rpc, relayCount = 0 }) {
  const [status, setStatus] = useState(null)
  const [network, setNetwork] = useState(null) // Phase 1 exposure data
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)
  const [proof, setProof] = useState(null)
  const [verifying, setVerifying] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      setStatus(await rpc.relayStatus())
      // Parallel-fetch the exposure surface (Phase 1 of network-privacy).
      // Never throws on the backend — never blocks the relay status fetch.
      try { setNetwork(await rpc.networkStatus({})) } catch (_) { setNetwork({ peerCount: 0, relayCount: 0, peers: [], relays: [], vias: { dht: 0, relayCircuit: 0, unknown: 0 } }) }
    } catch (e) { setErr(errorText(e)) } finally { setLoading(false) }
  }, [rpc])

  useEffect(() => { refresh() }, [refresh])

  const toggle = useCallback(async (enabled) => {
    try {
      await rpc.relaySetEnabled({ enabled })
      refresh()
    } catch (e) { setErr(errorText(e)) }
  }, [rpc, refresh])

  const runVerifier = useCallback(async () => {
    setVerifying(true); setErr(null)
    try {
      setProof(await rpc.verifyEncryption({}))
    } catch (e) { setErr(errorText(e)) } finally { setVerifying(false) }
  }, [rpc])

  if (loading) {
    return (
      <View style={styles.loadingWrap}>
        <ActivityIndicator color={theme.color.mint} />
      </View>
    )
  }

  const s = status || {}
  const reduced = s.available === false || (s.degradedReason)

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Eyebrow>Relay &amp; proof</Eyebrow>
      <H1>{COPY.relay.title}</H1>
      <Lede>{COPY.relay.blurb}</Lede>

      {reduced && (
        <Banner kind="warn">
          {COPY.relay.reduced}{s.degradedReason ? ' — ' + s.degradedReason : ''}
        </Banner>
      )}

      <Card style={styles.statusCard}>
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>{COPY.relay.enabledToggle}</Text>
            <Hint>Direct peers first; relays only when devices are asleep.</Hint>
          </View>
          <Switch
            value={!!s.enabled}
            onValueChange={toggle}
            trackColor={{ false: theme.color.surface2, true: theme.color.mint }}
            thumbColor={s.enabled ? '#04130d' : '#e9eef3'}
          />
        </View>

        <View style={styles.statsBlock}>
          {/* Live count of currently-connected HiveRelays from the
              relay-connected-changed event stream. Distinct from
              relaysHoldingCiphertext (which only counts relays that accepted
              a seedVault call — 0 until the user has unlocked + something
              has been seeded). Surfacing it makes "connected to N relays"
              visible even before any seeding has happened. */}
          <Stat label="Relays connected" value={String(relayCount ?? 0)} />
          <Stat label={COPY.relay.directPeers} value={String(s.directPeers ?? 0)} />
          <Stat label={COPY.relay.relaysHolding} value={String(s.relaysHoldingCiphertext ?? 0)} />
          <Stat label={COPY.relay.custodyQuorum} value={String(s.custodyQuorum ?? '0/0')} />
          <Stat label={COPY.relay.lastVerifier} value={String(s.lastVerifierRun ?? 'never')} />
          <Stat
            label={COPY.relay.lastRotation}
            value={s.lastKeyRotation ? new Date(s.lastKeyRotation).toLocaleString() : '—'}
            last
          />
        </View>
      </Card>

      <View style={styles.chipRow}>
        <Chip tone="mint">no accounts</Chip>
        <Chip tone="mint">encrypted on-device</Chip>
        <Chip tone="muted">open verifier</Chip>
      </View>

      {/* Network exposure panel (Phase 1). Honest disclosure of who can
          see this device's IP right now. Pairs with the website's "Not
          anonymous" disclaimer — makes the metadata gap visible instead
          of buried in marketing copy. */}
      <Card style={styles.exposeCard}>
        <Text style={styles.exposeTitle}>{COPY.relay.networkTitle}</Text>
        <Hint style={{ marginBottom: 8 }}>{COPY.relay.networkBlurb}</Hint>
        <Text style={styles.exposeSummary}>
          Your IP is visible to {(network && network.peerCount) || 0} {(network && network.peerCount === 1) ? 'paired device' : 'paired devices'} and {(network && network.relayCount) || 0} {(network && network.relayCount === 1) ? 'relay' : 'relays'}.
        </Text>
        <View style={{ height: 12 }} />
        <Text style={styles.exposeSectionLabel}>{COPY.relay.networkPeersHeader}</Text>
        {(network && network.peers && network.peers.length)
          ? network.peers.map((p, i) => (
            <View key={(p.id || 'peer') + i} style={styles.exposeRow}>
              <Text style={styles.exposeId}>{p.id || '—'}</Text>
              <Text style={styles.exposeVia}>
                {p.via === 'dht' ? COPY.relay.networkViaDht : p.via === 'relay-circuit' ? COPY.relay.networkViaRelayCircuit : COPY.relay.networkViaUnknown}
              </Text>
            </View>
          ))
          : <Hint>{COPY.relay.networkPeersEmpty}</Hint>}
        <View style={{ height: 12 }} />
        <Text style={styles.exposeSectionLabel}>{COPY.relay.networkRelaysHeader}</Text>
        {(network && network.relays && network.relays.length)
          ? network.relays.map((rr, i) => (
            <View key={(rr.id || 'relay') + i} style={styles.exposeRow}>
              <Text style={styles.exposeId}>{rr.id || '—'}</Text>
              <Text style={styles.exposeVia}>fleet relay</Text>
            </View>
          ))
          : <Hint>{COPY.relay.networkRelaysEmpty}</Hint>}
        <Hint style={{ marginTop: 12 }}>{COPY.relay.networkHonestyHint}</Hint>
      </Card>

      <Button kind="primary" busy={verifying} onPress={runVerifier}>{COPY.relay.runVerifier}</Button>

      {proof && (
        <View style={{ marginTop: 18 }}>
          <TerminalPanel filename="paste-verifier" lines={buildProofLines(proof)} />
        </View>
      )}

      {err && <View style={{ marginTop: 16 }}><Banner kind="error">{err}</Banner></View>}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  wrap: {
    padding: 20,
    paddingTop: 56,
    backgroundColor: theme.color.bg,
    flexGrow: 1
  },
  loadingWrap: {
    flex: 1,
    backgroundColor: theme.color.bg,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statusCard: {
    marginBottom: 16
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 14,
    borderBottomColor: theme.color.line,
    borderBottomWidth: 1,
    marginBottom: 4
  },
  switchTitle: {
    color: theme.color.text,
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 2
  },
  statsBlock: {
    paddingTop: 4
  },
  stat: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomColor: theme.color.line,
    borderBottomWidth: 1
  },
  // Network exposure card — Phase 1. Visual feel matches statusCard.
  exposeCard: {
    marginTop: 16,
    marginBottom: 16
  },
  exposeTitle: {
    color: theme.color.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 6
  },
  exposeSummary: {
    color: theme.color.text,
    fontSize: 14,
    lineHeight: 20,
    marginTop: 4
  },
  exposeSectionLabel: {
    color: theme.color.muted,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1,
    textTransform: 'uppercase',
    marginBottom: 8
  },
  exposeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
    paddingHorizontal: 10,
    marginBottom: 6,
    borderColor: theme.color.line,
    borderWidth: 1,
    borderRadius: theme.radius.sm,
    backgroundColor: 'rgba(255,255,255,0.02)'
  },
  exposeId: {
    color: theme.color.text,
    fontFamily: theme.font.family.mono,
    fontSize: 12.5,
    fontWeight: '600',
    minWidth: 78
  },
  exposeVia: {
    color: theme.color.muted,
    fontSize: 12,
    marginLeft: 12,
    flex: 1
  },
  statLast: {
    borderBottomWidth: 0
  },
  statLabel: {
    color: theme.color.muted,
    fontSize: 14
  },
  statValue: {
    color: theme.color.text,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: theme.font.family.mono
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginBottom: 16
  }
})

export default RelayProofScreen
