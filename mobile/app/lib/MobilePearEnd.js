// MobilePearEnd — React Native side of the PearPaste mobile bridge.
//
// Rewritten to mirror the PROVEN PearBrowser integration (verified running a
// heavy native-addon Pear-end worklet on real iOS + Android):
//   • transport: length-prefixed-JSON over worklet.IPC (NOT bare-rpc — bare-rpc
//     is what silently hung our worklet).
//   • readiness: stays 'starting' until the worklet emits a 'ready' event
//     (after createPearEnd fully initialized); 'error' event → recoverable
//     crash. Mirrors PearBrowser's READY/ERROR event gating.
//   • Android: pass the ~3.4MB bundle as Uint8Array (→ startBytes) to avoid the
//     JNI string-size limit that silently fails large bundles (PearBrowser fix).
//
// Public API preserved (usePearPasteRpc + screens): getMobilePearEnd(),
// start(), stop(), call(command, params, {timeoutMs}), on('state'|'crash'|
// 'event'), state, retry via stop()+start(). No secrets cross this boundary.

import { Platform } from 'react-native'
import { Worklet } from 'react-native-bare-kit'
import b4a from 'b4a'
// @dr.pogodin/react-native-fs v2 has NO default export — only named exports
// (DocumentDirectoryPath, writeFile, …). `import RNFS from …` yields undefined,
// so `RNFS.DocumentDirectoryPath` threw on the first line of start(); the
// usePearPasteRpc `.catch(()=>{})` swallowed it → infinite splash, worklet
// never started (root cause of the iOS+Android "hang"). Namespace import fixes.
import * as RNFS from '@dr.pogodin/react-native-fs'
// Per-platform bare-pack output (CJS module exporting the bundle string).
// Single platform-resolved import: Metro picks worklet-bundle.android.js on
// Android and worklet-bundle.ios.js on iOS, so ONLY the matching ~3.5 MB
// bare-pack bundle is included per platform. Previously BOTH app.ios.bundle
// and app.android.bundle were statically imported, bloating each platform's
// JS bundle by ~3.5 MB of dead cross-platform worklet bytes — a real problem
// on low-RAM devices and slow/tunnelled Metro transfers.
import bundle from '../../backend/worklet-bundle'

// Backend commands that need a longer client-side RPC timeout than the
// default 30 s — pairing waits up to 90 s for DHT/UDX rendezvous + the
// Noise handshake, and the argon2id KDF used by vault create/restore can
// take several seconds on a low-end phone. 120 s gives 30 s headroom over
// the worklet's own deadlines so server-side errors surface as the user-
// facing failure instead of a generic RPC_TIMEOUT.
const LONG_RUNNING_COMMANDS = new Set([
  'PAIR_ACCEPT', 'PAIR_CREATE_INVITE',
  'CREATE_VAULT', 'RESTORE_VAULT'
])

export class RpcError extends Error {
  constructor (code, message) {
    super(message || code)
    this.name = 'RpcError'
    this.code = code || 'RPC_ERROR'
  }
}

// Length-prefixed-JSON RPC client — matches mobile/backend/worklet-rpc.mjs
// (8 hex chars = JSON char length, then JSON). Mirrors PearBrowser app/lib/rpc.
class PearRPC {
  constructor (ipc) {
    this._ipc = ipc
    this._id = 1
    this._pending = new Map()
    this._buf = ''
    this._ev = new Map()
    ipc.on('data', (d) => this._onData(d))
    ipc.on('error', () => {})
  }

  on (evt, fn) {
    const a = this._ev.get(evt) || []
    a.push(fn)
    this._ev.set(evt, a)
    return () => { const x = this._ev.get(evt) || []; const i = x.indexOf(fn); if (i >= 0) x.splice(i, 1) }
  }

  _emit (evt, data) {
    for (const fn of this._ev.get(evt) || []) { try { fn(data) } catch (_) {} }
  }

  request (cmd, data, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const id = this._id++
      const timer = setTimeout(() => {
        if (this._pending.delete(id)) reject(new RpcError('RPC_TIMEOUT', cmd + ' timed out'))
      }, timeout)
      this._pending.set(id, { resolve, reject, timer })
      this._send({ id, cmd, data })
    })
  }

  _send (msg) {
    try {
      const json = JSON.stringify(msg)
      this._ipc.write(b4a.from(json.length.toString(16).padStart(8, '0') + json))
    } catch (_) {}
  }

  _onData (chunk) {
    this._buf += b4a.toString(b4a.from(chunk))
    while (this._buf.length >= 8) {
      const len = parseInt(this._buf.slice(0, 8), 16)
      if (!Number.isFinite(len) || len < 0 || len > 50_000_000) { this._buf = ''; return }
      if (this._buf.length < 8 + len) break
      const json = this._buf.slice(8, 8 + len)
      this._buf = this._buf.slice(8 + len)
      let m
      try { m = JSON.parse(json) } catch (_) { continue }
      this._process(m)
    }
  }

  _process (m) {
    if (m.id && (m.result !== undefined || m.error !== undefined)) {
      const p = this._pending.get(m.id)
      if (p) {
        this._pending.delete(m.id)
        clearTimeout(p.timer)
        if (m.error !== undefined && m.error !== null) p.reject(new RpcError(m.code || 'RPC_ERROR', m.error))
        else p.resolve(m.result)
      }
      return
    }
    if (m.event !== undefined) this._emit(m.event, m.data)
  }

  destroy (crashInfo = null) {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer)
      // Pass the upstream crash info (reason / exit code / last stage /
      // message / stack) through the rejected error so the banner the user
      // sees on screen can include the ACTUAL cause instead of the generic
      // "sync engine stopped" copy. Without this the pending PAIR_ACCEPT
      // call only ever rejects with 'closed' and the underlying worklet
      // failure mode is invisible to the UI.
      const info = crashInfo || {}
      const code = info.code || 'RPC_DISCONNECTED'
      const msg = info.message || info.reason || 'closed'
      const err = new RpcError(code, msg)
      err.crashInfo = info
      p.reject(err)
    }
    this._pending.clear()
  }
}

export class MobilePearEnd {
  constructor () {
    this.worklet = null
    this.rpc = null
    this._state = 'idle' // idle | starting | ready | crashed | stopped
    this._listeners = { state: [], crash: [], event: [] }
    this._bootTimer = null
  }

  on (ev, fn) {
    if (this._listeners[ev]) this._listeners[ev].push(fn)
    return () => {
      const a = this._listeners[ev]
      if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) }
    }
  }

  _emit (ev, payload) {
    for (const fn of this._listeners[ev] || []) { try { fn(payload) } catch (_) {} }
  }

  _setState (s, extra) {
    this._state = s
    this._emit('state', { state: s, ...(extra || {}) })
  }

  get state () { return this._state }

  async start (storagePath, pairingInvite, pairingUnlockSecret = '') {
    if (this._state === 'starting' || this._state === 'ready') return
    this._setState('starting')

    let docDir = storagePath || RNFS.DocumentDirectoryPath
    if (typeof docDir !== 'string' || !docDir) docDir = '/tmp/pearpaste'

    // Wait for the worklet's 'ready' event (createPearEnd fully booted). If it
    // never arrives, surface a recoverable crash instead of an infinite splash.
    if (this._bootTimer) clearTimeout(this._bootTimer)
    this._bootTimer = setTimeout(() => {
      if (this._state !== 'ready') {
        this._handleCrash({
          reason: 'WORKLET_BOOT_TIMEOUT',
          message: 'Pear-end did not become ready within 45s.'
        })
      }
    }, 45000)
    if (this._bootTimer && this._bootTimer.unref) this._bootTimer.unref()

    try {
      this.worklet = new Worklet()
      // Pass the bundle as BYTES on BOTH platforms. Worklet.start() routes a
      // string through NativeBareKit.startUTF8 and a Uint8Array through
      // startBytes. startUTF8 silently no-ops for our ~3.4MB bundle — Android
      // hits a JNI string-size limit; iOS empirically also fails to run the
      // worklet (start() resolves in ~50ms, IPC present, but worklet JS never
      // executes). startBytes has no size limit and works on both. (Verified
      // on the iOS Simulator: string path → worklet never runs; bytes path →
      // full Pear-end boot in ~240ms.)
      await this.worklet.start('/app.bundle', new TextEncoder().encode(bundle), [docDir])

      const ipc = this.worklet.IPC
      this.rpc = new PearRPC(ipc)

      this.rpc.on('ready', () => {
        if (this._state === 'ready') return
        if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null }
        this._setState('ready')
        if (pairingInvite && pairingUnlockSecret) {
          this.call('PAIR_ACCEPT', { invite: pairingInvite, unlockSecret: pairingUnlockSecret }).catch(() => {})
        }
      })
      this.rpc.on('boot', (d) => {
        // Remember the last 'boot' stage so a subsequent worklet-error tells
        // the user (and us) which subsystem was running when EINVAL fired.
        this._lastBoot = d || null
        // TEMP: forward all backend log/stage events to Metro so we can see
        // relay-connected / relay-degraded / etc. while diagnosing "not
        // currently connecting to relays". Remove once the relay observability
        // story is finalised.
        try {
          const stage = d && d.stage
          const msg = d && d.message
          if (stage && stage.startsWith('log:')) {
            const lvl = (d && d.level) || 'info'
            const meta = d && d.meta
            console.log('[backend]', lvl, msg, meta ? JSON.stringify(meta) : '')
          } else if (stage) {
            console.log('[backend stage]', stage, msg || '')
          }
        } catch (_) {}
        this._emit('state', { state: this._state, boot: d && d.message })
      })
      this.rpc.on('error', (e) => this._handleCrash({
        reason: 'worklet-error',
        message: (e && e.message) || 'worklet boot failed',
        code: e && e.code,
        stack: e && e.stack,
        lastStage: this._lastBoot && (this._lastBoot.stage || this._lastBoot.message)
      }))
      this.rpc.on('backend', (m) => this._emit('event', m || {}))

      const onDead = (info) => this._handleCrash(info)
      if (ipc && ipc.on) {
        ipc.on('close', () => onDead({ reason: 'ipc-closed' }))
      }
      if (this.worklet.on) {
        this.worklet.on('exit', (code) => onDead({ reason: 'worklet-exit', code }))
      }
    } catch (err) {
      this._handleCrash({ reason: 'start-failed', message: String((err && err.message) || err) })
      throw new RpcError('WORKLET_START_FAILED', String((err && err.message) || err))
    }
  }

  _handleCrash (info) {
    if (this._state === 'crashed' || this._state === 'stopped') return
    if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null }
    this._lastCrashInfo = info || {}
    try { console.log('[rn] _handleCrash', JSON.stringify(info || {})) } catch (_) {}
    this._setState('crashed', info)
    // Pass crash info into destroy() so in-flight RPC rejections (e.g. a
    // pending PAIR_ACCEPT) carry the underlying reason/exit-code/last-stage
    // instead of just the generic 'closed' message.
    if (this.rpc) { try { this.rpc.destroy(this._lastCrashInfo) } catch (_) {} }
    this._emit('crash', info || {})
  }

  call (command, params, opts = {}) {
    // TEMP diagnostic — surface every call attempt + current engine state so we
    // can tell "engine stopped" from "ready but RPC errored". Remove once the
    // status-vs-rejection question is settled.
    try { console.log('[rn] call', command, 'state=', this._state) } catch (_) {}
    if (this._state !== 'ready') {
      return Promise.reject(new RpcError('WORKLET_NOT_READY', 'worklet state: ' + this._state))
    }
    // Per-command timeouts. The default 30 s fires before the worklet finishes
    // pairing (90 s DHT/UDX rendezvous) or argon2id derivation in vault
    // create/restore. Give those commands a 120 s ceiling with 30 s of
    // headroom over the worklet's own deadlines so server-side errors
    // surface as the user-facing failure instead of generic RPC_TIMEOUT.
    const timeoutMs = (opts.timeoutMs != null)
      ? opts.timeoutMs
      : (LONG_RUNNING_COMMANDS.has(command) ? 120000 : 30000)
    return this.rpc.request('call', { command, params: params || {} }, timeoutMs)
  }

  async stop () {
    this._setState('stopped')
    if (this.rpc) { try { this.rpc.destroy() } catch (_) {} }
    try { if (this.worklet && this.worklet.terminate) await this.worklet.terminate() } catch (_) {}
    this.worklet = null
    this.rpc = null
  }
}

// Process-wide singleton — exactly one worklet => one Hyperswarm/Corestore.
let _singleton = null
export function getMobilePearEnd () {
  if (!_singleton) _singleton = new MobilePearEnd()
  return _singleton
}

export default MobilePearEnd
