// Paste — PairScreen — pair this device (spec §14, §13).
//
// Two roles in one screen:
//   - This unlocked device shows an invite: PAIR_CREATE_INVITE -> render the
//     base64 invite as a QR plus the human short code + expiry.
//   - A new device joins: scan the QR (or type the short code's full invite)
//     and call PAIR_ACCEPT, which runs the backend Noise handshake + sealed
//     bootstrap and starts sync.
//
// QR scanning uses react-native-camera-kit if present; if camera permission is
// denied or the module is absent we fall back to manual invite entry (the
// short code is discovery only — the unlocked device must approve the matching
// request before bootstrap keys are released).

import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, ScrollView
} from 'react-native'
import { CameraView, useCameraPermissions } from 'expo-camera'
import { COPY, errorText } from '../lib/copy'
import { currentDevicePlatform } from '../lib/platform'
import { theme, hexA } from '../lib/theme'
import { Eyebrow, H1, Lede, Hint, Banner, Button, Card, GradientBorder, inputStyle } from '../lib/ui'

// QR display: `react-native-qrcode-svg` is now a real dependency, but the
// `asComponent` guard stays — it's defense-in-depth against unexpected export
// shapes (cf. the original bug where Metro's empty-stub returned a truthy `{}`
// that crashed as a JSX element). Anything not a function/forwardRef → null →
// the screen falls back to a selectable mono base64 invite (spec §13).
function asComponent (x) {
  if (typeof x === 'function') return x
  if (x && typeof x === 'object' && x.$$typeof) return x
  return null
}
let QRCode = null
try { QRCode = asComponent(require('react-native-qrcode-svg').default) } catch (_) {}

// "M:SS" countdown for the invite expiry hint. Floors to 0:00 once past.
function fmtRemaining (ms) {
  if (ms <= 0) return '0:00'
  const total = Math.floor(ms / 1000)
  return Math.floor(total / 60) + ':' + (total % 60).toString().padStart(2, '0')
}

// Pair-mode toggle chip. Active state uses the brand gradient as a 1-px ring
// (via GradientBorder) wrapping the same tinted-mint pill — so the active
// toggle reads visually distinct from "muted" inactive without losing the
// pill silhouette.
function ModeChip ({ active, label, onPress }) {
  if (active) {
    return (
      <TouchableOpacity onPress={onPress} accessibilityRole="button" style={styles.tabBtn} accessibilityState={{ selected: true }}>
        <GradientBorder
          radius={theme.radius.pill}
          thickness={1}
          innerStyle={{ backgroundColor: hexA(theme.color.mint, 0.1) }}
        >
          <View style={styles.tabChipInner}>
            <Text style={[styles.tabChipText, styles.tabChipTextActive]}>{label}</Text>
          </View>
        </GradientBorder>
      </TouchableOpacity>
    )
  }
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" style={styles.tabBtn}>
      <View style={styles.tabChip}>
        <Text style={styles.tabChipText}>{label}</Text>
      </View>
    </TouchableOpacity>
  )
}

export function PairScreen ({ rpc, unlocked, relayCount = 0, pairRequest = null }) {
  const [mode, setMode] = useState(unlocked ? 'show' : 'accept')
  const [invite, setInvite] = useState(null) // created invite (this device)
  const [inviteInput, setInviteInput] = useState('') // pasted/scanned invite
  const [unlockSecret, setUnlockSecret] = useState('')
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [ok, setOk] = useState(null)
  // expo-camera handles BOTH iOS (Info.plist NSCameraUsageDescription, set via
  // the expo-camera config plugin in app.json) AND Android (CAMERA permission)
  // permission flows. The hook is null until the native side is ready.
  const [permission, requestPermission] = useCameraPermissions()
  // CameraView emits onBarcodeScanned continuously while a code is in view;
  // we only want to accept once per scan session (one-time pairing invite).
  const scannedRef = useRef(false)
  // 1-Hz ticker so the live countdown + isExpired transition re-render. We
  // stop the ticker once expired (no more useful change until a fresh invite).
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!invite) return
    const id = setInterval(() => {
      const n = Date.now()
      setNow(n)
      if (n >= invite.expiresAt) clearInterval(id)
    }, 1000)
    return () => clearInterval(id)
  }, [invite])
  const isExpired = !!(invite && now >= invite.expiresAt)

  const createInvite = useCallback(async () => {
    setBusy(true); setErr(null)
    try {
      const res = await rpc.pairCreateInvite({ ttlMs: 5 * 60 * 1000 })
      setInvite(res) // { invite, shortCode, expiresAt }
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }, [rpc])

  const beginScan = useCallback(async () => {
    setErr(null)
    if (!permission) return // hook still resolving — try again
    if (!permission.granted) {
      const res = await requestPermission()
      if (!res?.granted) { setErr(COPY.pair.cameraDenied); return }
    }
    scannedRef.current = false
    setScanning(true)
  }, [permission, requestPermission])

  const accept = useCallback(async (raw) => {
    const code = (raw || inviteInput || '').trim()
    if (!code) return
    setBusy(true); setErr(null)
    try {
      // Short-code shape: 4-12 hex+dash chars (covers "A1B2-C3D4" and the
      // raw 8-char form). Resolve to the full invite via DHT rendezvous
      // (PAIR_LOOKUP_SHORTCODE) before running the normal pair-accept.
      const stripped = code.replace(/\s/g, '')
      let blob = code
      if (/^[0-9A-Fa-f-]{4,12}$/.test(stripped)) {
        const r = await rpc.pairLookupShortcode({ shortCode: stripped, timeoutMs: 30000 })
        blob = r && r.invite
        if (!blob) throw Object.assign(new Error('short code lookup returned no invite'), { code: 'SHORTCODE_NOT_FOUND' })
      }
      if (!unlockSecret.trim()) throw Object.assign(new Error('Choose an unlock passphrase for this device first.'), { code: 'MISSING_UNLOCK_SECRET' })
      await rpc.pairAccept({ invite: blob, label: 'paired phone', platform: currentDevicePlatform(), unlockSecret })
      setOk(COPY.pair.paired)
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false); setScanning(false) }
  }, [rpc, inviteInput, unlockSecret])

  const approvePair = useCallback(async () => {
    if (!pairRequest) return
    setBusy(true); setErr(null)
    try {
      await rpc.pairApprove({ requestId: pairRequest.requestId })
      setOk('Device approved. Sync is starting.')
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }, [rpc, pairRequest])

  const rejectPair = useCallback(async () => {
    if (!pairRequest) return
    setBusy(true); setErr(null)
    try {
      await rpc.pairReject({ requestId: pairRequest.requestId })
      setOk('Pairing request rejected.')
    } catch (e) { setErr(errorText(e)) } finally { setBusy(false) }
  }, [rpc, pairRequest])

  if (scanning) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (scannedRef.current) return
            scannedRef.current = true
            // Dismiss the camera the instant a code is decoded so the user
            // gets immediate feedback (busy → paired or busy → error) instead
            // of staring at the live preview while accept() runs. Also
            // surfaces whether the scan fired at all when debugging.
            setScanning(false)
            accept(data)
          }}
        />
        {/* Soft alignment frame overlay (purely visual; expo-camera has no
            built-in laser/frame like camera-kit, so we draw our own). */}
        <View pointerEvents="none" style={styles.scanFrameWrap}>
          <View style={styles.scanFrame} />
          <Hint style={styles.scanHint}>Point at the QR shown on your other device</Hint>
        </View>
        <View style={styles.scanCancelWrap}>
          <Button kind="ghost" onPress={() => setScanning(false)}>Cancel</Button>
        </View>
      </View>
    )
  }

  return (
    <ScrollView contentContainerStyle={styles.wrap}>
      <Eyebrow>Pair</Eyebrow>
      <H1>{COPY.pair.title}</H1>
      <Lede>Connect a new device or accept an invite from an unlocked one.</Lede>

      {/* Relay-circuit readiness: pair-create/accept now await first relay
          connect (8s) before swarm.join, so pairing routes via HiveRelay
          instead of guessing at NAT punching. Surface the wait so the UI
          doesn't look frozen during the 5-8 s relay warm-up. */}
      {relayCount > 0
        ? <Hint>Relays: {relayCount} connected — pair via relay-circuit ready.</Hint>
        : <Hint>Connecting to relays…</Hint>}

      <View style={styles.tabsRow}>
        {unlocked && (
          <ModeChip active={mode === 'show'} label={COPY.pair.creating} onPress={() => setMode('show')} />
        )}
        <ModeChip active={mode === 'accept'} label={COPY.pair.accept} onPress={() => setMode('accept')} />
      </View>

      {mode === 'show' && (
        <View style={styles.center}>
          {pairRequest && (
            <Card style={styles.inviteCard}>
              <Banner kind="warn">Confirm this code on the new device before approving.</Banner>
              <Text style={styles.approvalCode}>{pairRequest.confirmation || '------'}</Text>
              <Hint style={{ textAlign: 'center' }}>
                {(pairRequest.label || 'paired')} · {(pairRequest.platform || 'unknown')}
              </Hint>
              <View style={styles.approvalActions}>
                <Button kind="primary" busy={busy} onPress={approvePair}>Approve</Button>
                <Button kind="ghost" busy={busy} onPress={rejectPair}>Reject</Button>
              </View>
            </Card>
          )}
          {!invite
            ? (
              <Button kind="primary" busy={busy} onPress={createInvite}>{COPY.pair.creating}</Button>
              )
            : isExpired
              ? (
                // Expired: hide the now-useless QR (an expired invite is rejected
                // by PAIR_ACCEPT — see backend/pairing.js:assertInviteOpen) and
                // offer a clean regenerate path. createInvite overwrites the
                // backend's _pendingInvite (index.js:273-281), so this is safe
                // to call multiple times.
                <Card style={styles.inviteCard}>
                  <Banner kind="warn">This pairing invite expired. Generate a fresh one to keep pairing.</Banner>
                  <View style={{ marginTop: 12 }}>
                    <Button kind="primary" busy={busy} onPress={createInvite}>Generate fresh invite</Button>
                  </View>
                </Card>
                )
              : (
                <Card style={styles.inviteCard}>
                  {QRCode
                    // Invite payloads are ~280 chars → QR version ~12 (~67
                    // modules per side). Display large enough that each module
                    // is ~4.5+ px so a hand-held camera resolves it reliably.
                    // quietZone gives the scanner a clean white border.
                    ? <View style={styles.qr}><QRCode value={invite.invite} size={320} quietZone={12} backgroundColor="#fff" /></View>
                    : (
                      <View style={styles.fallbackInvite}>
                        <Hint style={{ marginBottom: 6 }}>Copy this invite to the new device:</Hint>
                        <Text style={styles.mono} selectable>{invite.invite}</Text>
                      </View>
                      )}
                  <Text style={styles.shortCode}>{invite.shortCode}</Text>
                  <Hint style={{ textAlign: 'center' }}>
                    Scan this QR on the new device. Expires in {fmtRemaining(invite.expiresAt - now)}.
                  </Hint>
                  <Hint style={{ textAlign: 'center', marginTop: 6, fontSize: 11 }}>
                    The code above starts discovery only. This device must approve the matching request before keys are released.
                  </Hint>
                </Card>
                )}
        </View>
      )}

      {mode === 'accept' && (
        <View>
          <Lede>{COPY.pair.scanHint}</Lede>
          <Button kind="primary" onPress={beginScan}>{COPY.pair.scan}</Button>
          <Text style={styles.or}>{COPY.pair.enterCode}</Text>
          <Hint style={styles.inviteFieldHint}>{COPY.pair.inviteFieldHint}</Hint>
          <TextInput
            style={[inputStyle, styles.inviteInput]}
            placeholder={COPY.pair.codeField}
            placeholderTextColor={theme.color.faint}
            value={inviteInput}
            onChangeText={setInviteInput}
            autoCapitalize="none"
            multiline
          />
          <TextInput
            style={inputStyle}
            placeholder="Unlock passphrase for this device"
            placeholderTextColor={theme.color.faint}
            value={unlockSecret}
            onChangeText={setUnlockSecret}
            secureTextEntry
          />
          <Button kind="primary" busy={busy} onPress={() => accept()}>{COPY.pair.accept}</Button>
        </View>
      )}

      {ok && <View style={{ marginTop: 16 }}><Banner kind="ok">{ok}</Banner></View>}
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
  tabsRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 22
  },
  tabBtn: {
    marginRight: 8
  },
  // Inactive chip — flat 1-px line border (muted state).
  tabChip: {
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.line,
    backgroundColor: 'rgba(255,255,255,0.03)',
    paddingVertical: 7,
    paddingHorizontal: 14
  },
  // Active chip inner — slot inside the GradientBorder ring. Matches inactive
  // padding/radius so toggling feels physical (no jump).
  tabChipInner: {
    paddingVertical: 6,
    paddingHorizontal: 13
  },
  tabChipText: {
    color: theme.color.muted,
    fontSize: 13,
    fontWeight: '600'
  },
  tabChipTextActive: {
    // Was theme.color.mint → mint text on the 10%-mint inner bg, illegible.
    // The gradient ring already signals "active"; let the label read in plain
    // foreground text for maximum contrast.
    color: theme.color.text,
    fontWeight: '700'
  },
  center: {
    alignItems: 'center'
  },
  inviteCard: {
    alignItems: 'center',
    width: '100%'
  },
  qr: {
    backgroundColor: '#fff',
    padding: 16,
    borderRadius: theme.radius.md
  },
  fallbackInvite: {
    width: '100%',
    backgroundColor: theme.color.bg,
    borderRadius: theme.radius.md,
    padding: 12
  },
  shortCode: {
    color: theme.color.mint,
    fontSize: 28,
    fontWeight: '700',
    letterSpacing: 4,
    marginTop: 20,
    marginBottom: 12,
    fontVariant: ['tabular-nums'],
    fontFamily: theme.font.family.mono
  },
  approvalCode: {
    color: theme.color.mint,
    fontSize: 34,
    fontWeight: '800',
    letterSpacing: 2,
    marginTop: 18,
    marginBottom: 12,
    fontFamily: theme.font.family.mono
  },
  approvalActions: {
    width: '100%',
    marginTop: 14,
    gap: 10
  },
  mono: {
    color: theme.color.text,
    fontSize: 11,
    fontFamily: theme.font.family.mono,
    lineHeight: 16
  },
  or: {
    color: theme.color.faint,
    fontSize: 13,
    textAlign: 'center',
    marginVertical: 16
  },
  inviteFieldHint: {
    marginBottom: 8
  },
  inviteInput: {
    minHeight: 90,
    textAlignVertical: 'top',
    fontSize: 13,
    fontFamily: theme.font.family.mono
  },
  scanCancelWrap: {
    position: 'absolute',
    bottom: 40,
    left: 0,
    right: 0,
    paddingHorizontal: 40
  },
  scanFrameWrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  scanFrame: {
    width: 240,
    height: 240,
    borderWidth: 2,
    borderColor: hexA(theme.color.cyan, 0.85),
    borderRadius: theme.radius.lg,
    backgroundColor: 'transparent',
    // Subtle inner glow via shadow (iOS) — Android ignores cleanly.
    shadowColor: theme.color.cyan,
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 0 }
  },
  scanHint: {
    marginTop: 18,
    color: theme.color.muted,
    textAlign: 'center',
    paddingHorizontal: 32
  }
})

export default PairScreen
