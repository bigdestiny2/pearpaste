// usePearPasteRpc — React hook over MobilePearEnd.
//
// Boots (once) the shared singleton worklet and exposes:
//   - rpc:    typed call surface (one method per backend command)
//   - status: 'starting' | 'ready' | 'crashed' | 'stopped'
//   - crash:  last crash info (null until a worklet death)
//   - retry(): restart the worklet after a crash (spec §13 recoverable UI)
//
// Plaintext discipline: this hook only ferries RPC. Screens are responsible for
// dropping any opened note/clip plaintext on blur/lock (they call NOTE_CLOSE /
// CLIP_CLOSE and clear local React state). The hook also wires AppState so a
// background transition asks the worklet to drop decrypted items (spec §9.4,
// §15) without tearing the worklet down.

import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { AppState } from 'react-native'
import { getMobilePearEnd } from './MobilePearEnd'
import { COMMANDS } from '../../rpc-commands.mjs'

export function usePearPasteRpc (opts = {}) {
  const engine = useMemo(() => getMobilePearEnd(), [])
  const [status, setStatus] = useState(engine.state)
  const [crash, setCrash] = useState(null)
  // Live count of HiveRelays connected — surfaced from the worklet via the
  // 'relay-connected-changed' backend event so screens (PairScreen) can show
  // "Connecting to relays… (N live)" instead of looking frozen during the
  // 5-8 s autoDiscover warm-up.
  const [relayCount, setRelayCount] = useState(0)
  const [pairRequest, setPairRequest] = useState(null)
  const startedRef = useRef(false)

  useEffect(() => {
    const offState = engine.on('state', ({ state }) => setStatus(state))
    const offCrash = engine.on('crash', (info) => setCrash(info))
    const offEvent = engine.on('event', (msg) => {
      if (msg && msg.event === 'relay-connected-changed') {
        const c = (msg.payload && Number(msg.payload.count)) || 0
        setRelayCount(c)
      } else if (msg && msg.event === 'pair-approval-needed') {
        setPairRequest(msg.payload || null)
      } else if (msg && (msg.event === 'pair-approval-cleared' || msg.event === 'pair-rejected' || msg.event === 'pair-admitted')) {
        setPairRequest(null)
      }
    })
    if (!startedRef.current) {
      startedRef.current = true
      // Do NOT swallow start() failures. A silently-caught rejection here was
      // the documented root of the infinite-splash hang (iOS AND Android): the
      // worklet never starts and the UI shows the splash forever with no error.
      // Surface it as a crash so WorkletErrorBoundary renders the message.
      engine.start(opts.storagePath, opts.pairingInvite, opts.pairingUnlockSecret).catch((err) => {
        setCrash({
          reason: 'START_FAILED',
          message: String((err && err.message) || err),
          code: err && err.code
        })
        setStatus('crashed')
      })
    }
    return () => { offState(); offCrash(); offEvent() }
  }, [engine, opts.storagePath, opts.pairingInvite, opts.pairingUnlockSecret])

  // Background plaintext-drop is enforced INSIDE the worklet: react-native-
  // bare-kit suspends the Bare runtime when the app backgrounds, and
  // worklet.mjs's Bare 'suspend' hook emits 'backgrounded' which clears
  // ctx.state.openItems (spec §9.4/§15). The JS side has nothing to send — we
  // only surface the transition so a screen can optionally LOCK_VAULT if the
  // user enabled "lock on background".
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s !== 'active' && status === 'ready' && opts.lockOnBackground) {
        engine.call(COMMANDS.LOCK_VAULT, {}).catch(() => {})
      }
    })
    return () => sub.remove()
  }, [status, engine, opts.lockOnBackground])

  const retry = useCallback(async () => {
    setCrash(null)
    await engine.stop()
    startedRef.current = true
    await engine.start(opts.storagePath, opts.pairingInvite, opts.pairingUnlockSecret)
  }, [engine, opts.storagePath, opts.pairingInvite, opts.pairingUnlockSecret])

  // Typed surface: rpc.createVault({...}), rpc.noteList({...}), etc. Plus a
  // raw rpc.call(COMMANDS.X, params) escape hatch.
  const rpc = useMemo(() => {
    const api = {
      call: (command, params, o) => engine.call(command, params, o),
      COMMANDS
    }
    for (const command of Object.values(COMMANDS)) {
      const method = command.toLowerCase().replace(/_([a-z])/g, (_, c) => c.toUpperCase())
      api[method] = (params, o) => engine.call(command, params, o)
    }
    return api
  }, [engine])

  return {
    rpc,
    status,
    ready: status === 'ready',
    crashed: status === 'crashed',
    crash,
    relayCount,
    pairRequest,
    retry
  }
}

export default usePearPasteRpc
