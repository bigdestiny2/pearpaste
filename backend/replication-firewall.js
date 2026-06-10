// Paste replication firewall — the load-bearing network control for device
// revocation (REVOCATION_DESIGN §3.7.2 / §5.10, RT-FIX B2; GATE finding SB2).
//
// WHY THIS EXISTS: the Autobase core key is immutable and relays/peers seed by
// it, so a revoked device can keep REPLICATING the (encrypted) vault log
// forever — topic rotation only moves the discovery rendezvous, and relay
// unseed/`revocable` is COSMETIC against an already-connected peer (Hypercore
// replication streams persist through swarm.leave; the relay client's unseed()
// only broadcasts a message, it never closes a stream — empirically proven,
// GATE SB2). This per-connection firewall is the SOLE real replication control:
//   (a) store.replicate(conn) runs ONLY after the peer authenticates as a
//       COMMITTED, NON-REVOKED device (signed pp-repl-auth handshake below);
//   (b) on DEVICE_REVOKE, destroyPeer() actively conn.destroy()s every live
//       stream authenticated to the revoked device — refusing NEW connections
//       alone is not enough (SB2: the existing stream would keep replicating).
//
// HONEST RESIDUAL (L2): where the survivors do NOT control a relay (a
// third-party relay still seeding the old core key, or any non-firewalled
// peer), the revoked device keeps replicating OPAQUE post-revoke ciphertext
// indefinitely — it simply cannot DECRYPT it. Confidentiality rests entirely
// on content-key rotation (Phase 2); this firewall governs replication only.
//
// IDENTITY NOTE (design deviation, forced by the code): committed device
// records carry signing/box/writer pubkeys but NOT swarm (Noise) pubkeys, so a
// connection cannot be authenticated by a remotePublicKey lookup against the
// committed set (the design's "onauthenticate keyed to the device set" assumed
// a binding that does not exist). Instead each side sends a credential signed
// with its device signing key, binding its deviceId to THIS Noise session
// (both session pubkeys), over a protomux channel that coexists with corestore
// replication on the same stream. Replaying a credential onto another session
// fails (the session pubkeys differ); forging one needs the device's signing
// secret key, which a revoked device cannot obtain for any survivor.

import b4a from 'b4a'
import Protomux from 'protomux'
import c from 'compact-encoding'
import * as crypto from './crypto-envelope.js'

const PROTOCOL = 'pearpaste/repl-auth/1'
const AUTH_CONTEXT = 'pp-repl-auth-v1'

// How long an un-authenticated, non-relay peer may hold a connection before it
// is destroyed. Generous: a slow peer only needs to push one tiny message.
const AUTH_TIMEOUT_MS = 12000
// A peer that authenticates as a device we do NOT (yet) have committed is kept
// pending and re-checked: a freshly-approved device dials the vault topic
// while its DEVICE_ADD may still be linearizing on our side. After the grace
// it is refused like any unknown peer.
const UNKNOWN_GRACE_MS = 15000
const UNKNOWN_RECHECK_MS = 1000

export function createReplicationFirewall ({
  store,
  // Optional lazy store resolver. The Corestore object is REPLACED when the
  // install switches to a different vault (DEVICE_HYGIENE Fix A2 wipes + reopens
  // it), so a captured `store` reference would go stale. When `getStore` is
  // wired we resolve the live store at replicate() time; `store` stays as a
  // back-compat fallback for lightweight test harnesses.
  getStore = null,
  log = { debug () {}, info () {}, warn () {}, error () {} },
  getDevice, // () => local device identity (deviceId/signingPubkey/signingSecretKey) or null when locked
  getEngine, // () => sync engine (devices map + isDeviceAllowed) or null before attach/open
  isRelayPeer = () => false, // (remotePubHex) => bool — relays replicate ciphertext-only (L2 channel)
  enforce = true, // kill-switch / permissive mode: still authenticate OUTBOUND, never gate inbound
  authTimeoutMs = AUTH_TIMEOUT_MS,
  unknownGraceMs = UNKNOWN_GRACE_MS,
  // Optional event hook: (fn) => unsubscribe, fired whenever the committed
  // device set was rebuilt (engine apply pass). When wired, pending 'unknown'
  // peers re-check on that event instead of a 1s poll; when absent (lightweight
  // test harnesses) the interval fallback below keeps the old behavior.
  subscribeAuthChanges = null
}) {
  // peer deviceId -> Set<conn> of live streams authenticated to that device,
  // so destroyPeer() can enumerate + destroy on DEVICE_REVOKE (SB2 part b).
  const byDevice = new Map()
  const stats = {
    allowed: 0,
    bootstrapAllowed: 0,
    relayAllowed: 0,
    refusedRevoked: 0,
    refusedUnknown: 0,
    refusedTimeout: 0,
    destroyedOnRevoke: 0
  }

  function remoteHex (conn) {
    try {
      return conn.remotePublicKey ? b4a.toString(b4a.from(conn.remotePublicKey), 'hex') : null
    } catch (_) { return null }
  }
  function localHex (conn) {
    try {
      return conn.publicKey ? b4a.toString(b4a.from(conn.publicKey), 'hex') : null
    } catch (_) { return null }
  }

  function track (deviceId, conn) {
    let set = byDevice.get(deviceId)
    if (!set) { set = new Set(); byDevice.set(deviceId, set) }
    set.add(conn)
    conn.on('close', () => {
      const s = byDevice.get(deviceId)
      if (s) { s.delete(conn); if (s.size === 0) byDevice.delete(deviceId) }
    })
  }

  const resolveStore = typeof getStore === 'function' ? getStore : () => store

  function replicate (conn, tag) {
    if (conn.__ppReplicating || conn.destroyed) return
    conn.__ppReplicating = true
    try { resolveStore().replicate(conn) } catch (err) {
      log.warn('replicate-failed', { err: String(err), via: tag })
    }
  }

  // Verdict against the COMMITTED device set: the engine's devices map is a
  // pure function of the committed view (reorg-safe), so this is the same
  // authority the reducer uses for write exclusion.
  function verdictFor (deviceId, signingPubkey) {
    const engine = typeof getEngine === 'function' ? getEngine() : null
    if (!engine || !engine.devices || engine.devices.size === 0 || typeof engine.isDeviceAllowed !== 'function') {
      // BOOTSTRAP ALLOWANCE: we hold no committed device set (fresh joiner
      // replicating its first view, or engine not open yet). There is nothing
      // of ours to protect and refusing here would deadlock pairing bootstrap
      // (the joiner must replicate the log to LEARN the device set). The far
      // side still enforces its own firewall against us.
      return 'bootstrap'
    }
    return engine.isDeviceAllowed(deviceId, signingPubkey)
  }

  function handleConnection (conn, info) {
    // Never crash the process on a stream we may destroy ourselves.
    conn.on('error', () => {})

    const peerHex = remoteHex(conn)

    // Relay allowance: relays never run the device handshake — they replicate
    // ciphertext only. This is the honestly-documented L2 channel; the
    // epoch-bound relay re-seed/unseed (relay-service.js) governs it, and a
    // revoked device served by a relay still cannot decrypt anything
    // post-revoke. Checked again at timeout (the relay set fills async).
    if (peerHex && isRelayPeer(peerHex)) {
      stats.relayAllowed++
      replicate(conn, 'relay')
      // fall through: still offer our credential so a relay that DOES speak
      // the protocol could one day enforce its own policy.
    }

    if (enforce === false) {
      // Permissive mode (kill-switch / explicit opt-out): legacy behavior —
      // replicate immediately. We STILL authenticate outbound below so
      // enforcing peers accept us.
      replicate(conn, 'permissive')
    }

    const mux = Protomux.from(conn)
    let authed = null // peer deviceId once verified
    let pendingTimer = null
    let graceTimer = null
    let unsubAuth = null

    const clearTimers = () => {
      if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null }
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null }
      if (unsubAuth) { try { unsubAuth() } catch (_) {} unsubAuth = null }
    }
    conn.on('close', clearTimers)

    const refuse = (reason, counter) => {
      clearTimers()
      stats[counter]++
      log.info('repl-firewall-refused', { reason, peer: peerHex && peerHex.slice(0, 16) })
      if (enforce !== false) { try { conn.destroy() } catch (_) {} }
    }

    const admit = (deviceId, via, counter) => {
      clearTimers()
      authed = deviceId
      stats[counter]++
      track(deviceId, conn)
      replicate(conn, via)
    }

    const decide = (cred) => {
      const v = verdictFor(cred.deviceId, cred.signingPubkey)
      if (v === 'allowed') return admit(cred.deviceId, 'authed', 'allowed')
      if (v === 'bootstrap') return admit(cred.deviceId, 'bootstrap', 'bootstrapAllowed')
      if (v === 'revoked') return refuse('revoked-device', 'refusedRevoked')
      // 'unknown': keep pending and re-check — the peer's DEVICE_ADD may still
      // be linearizing into our committed view. Refused after the grace.
      // Event-driven when subscribeAuthChanges is wired (re-check exactly when
      // an apply pass rebuilt the device set — the only time the verdict can
      // change); 1s-interval fallback otherwise. Grace timeout is unchanged.
      const pending = !!(pendingTimer || unsubAuth)
      if (!pending && !conn.destroyed && enforce !== false) {
        const recheck = () => {
          if (authed || conn.destroyed) return
          const v2 = verdictFor(cred.deviceId, cred.signingPubkey)
          if (v2 === 'allowed') return admit(cred.deviceId, 'authed', 'allowed')
          if (v2 === 'bootstrap') return admit(cred.deviceId, 'bootstrap', 'bootstrapAllowed')
          if (v2 === 'revoked') return refuse('revoked-device', 'refusedRevoked')
        }
        if (typeof subscribeAuthChanges === 'function') {
          try { unsubAuth = subscribeAuthChanges(recheck) } catch (_) { unsubAuth = null }
        }
        if (!unsubAuth) {
          pendingTimer = setInterval(recheck, UNKNOWN_RECHECK_MS)
          if (pendingTimer.unref) pendingTimer.unref()
        }
        graceTimer = setTimeout(() => refuse('unknown-device', 'refusedUnknown'), unknownGraceMs)
        if (graceTimer.unref) graceTimer.unref()
      } else if (enforce === false) {
        // permissive: already replicating; still track if it later verifies
      }
    }

    const channel = mux.createChannel({
      protocol: PROTOCOL,
      onopen () {
        // Send our credential as soon as both sides opened the channel. A
        // locked process has no device identity and sends nothing (the far
        // side times us out — correct: a locked device has no business
        // replicating a vault).
        const dev = typeof getDevice === 'function' ? getDevice() : null
        if (!dev || !dev.signingSecretKey) return
        const payload = {
          t: AUTH_CONTEXT,
          // Binds the credential to THIS Noise session: `from` is the
          // signer's own session pubkey (the verifier's remotePublicKey),
          // `to` is the signer's view of the verifier. Replay onto any other
          // session fails verification.
          from: localHex(conn),
          to: remoteHex(conn),
          deviceId: dev.deviceId,
          signingPubkey: dev.signingPubkey
        }
        try {
          credentialMsg.send({
            v: 1,
            deviceId: dev.deviceId,
            signingPubkey: dev.signingPubkey,
            sig: crypto.signDetached(dev.signingSecretKey, payload)
          })
        } catch (_) { /* stream raced shut — close handler cleans up */ }
      },
      onclose () { /* conn close handler does the cleanup */ }
    })
    if (!channel) return // duplicate channel on this stream — already handled

    const credentialMsg = channel.addMessage({
      encoding: c.json,
      onmessage (m) {
        if (authed || conn.destroyed) return
        if (!m || m.v !== 1 || typeof m.deviceId !== 'string' ||
            typeof m.signingPubkey !== 'string' || typeof m.sig !== 'string') {
          return refuse('malformed-credential', 'refusedUnknown')
        }
        const payload = {
          t: AUTH_CONTEXT,
          from: remoteHex(conn), // the signer's `from` is OUR remote
          to: localHex(conn),
          deviceId: m.deviceId,
          signingPubkey: m.signingPubkey
        }
        let ok = false
        try { ok = crypto.verifyDetached(m.signingPubkey, payload, m.sig) } catch (_) { ok = false }
        if (!ok) return refuse('bad-credential-signature', 'refusedUnknown')
        decide(m)
      }
    })

    channel.open()

    // No credential within the window: destroy unless the peer turned out to
    // be a relay (set fills async) or we are permissive.
    if (enforce !== false) {
      const t = setTimeout(() => {
        if (authed || conn.destroyed || conn.__ppReplicating) return
        const hex = remoteHex(conn)
        if (hex && isRelayPeer(hex)) {
          stats.relayAllowed++
          return replicate(conn, 'relay-late')
        }
        refuse('auth-timeout', 'refusedTimeout')
      }, authTimeoutMs)
      if (t.unref) t.unref()
      conn.on('close', () => clearTimeout(t))
    }
  }

  // SB2 part (b): on DEVICE_REVOKE, actively destroy every live stream
  // authenticated to the revoked device. Idempotent — safe to call from both
  // the revoking dispatcher and every survivor's reducer-applied event.
  function destroyPeer (deviceId) {
    const set = byDevice.get(deviceId)
    if (!set || set.size === 0) return 0
    let n = 0
    for (const conn of [...set]) {
      try { conn.destroy(new Error('device revoked')) } catch (_) {}
      n++
    }
    byDevice.delete(deviceId)
    stats.destroyedOnRevoke += n
    log.info('repl-firewall-destroyed-revoked-streams', { deviceId, streams: n })
    return n
  }

  function authenticatedPeers () {
    const out = {}
    for (const [id, set] of byDevice) out[id] = set.size
    return out
  }

  return { handleConnection, destroyPeer, authenticatedPeers, stats }
}

export default { createReplicationFirewall }
