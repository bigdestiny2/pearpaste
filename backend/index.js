// Paste Pear-end bootstrap.
//
// One Bare/Node process that owns: the single Hyperswarm, the single Corestore
// (via VaultStore), the lifecycle root, the vault state machine, and the RPC
// dispatcher. UI shells (desktop pear-electron, mobile bare-rpc) only ever talk
// to the dispatcher.
//
// INTEGRATION CONTRACT (read before adding a subsystem):
//   Each subsystem module (notes-service, autobase-sync, materialized-view,
//   relay-service, verifier, clipboard) exports `attach(ctx)` where ctx is the
//   PearEndContext below. attach() registers RPC handlers and spawns loops
//   under ctx.scope. Subsystems MUST NOT create another Hyperswarm or Corestore
//   and MUST NOT edit this file — wave-1 agents only add their own modules.
//
// Spec refs: §5 (architecture), §10 (network engine), §15 (API), §22 (contracts).

import Hyperswarm from 'hyperswarm'
import goodbye from 'graceful-goodbye'
import b4a from 'b4a'
import LifecycleScope from './lifecycle-scope.js'
import VaultStore from './vault-store.js'
import { RpcDispatcher, COMMANDS, assertRendererSafe } from './rpc.js'
import * as crypto from './crypto-envelope.js'
import * as ops from './shared-ops.js'
import * as identity from './identity.js'
import * as pairing from './pairing.js'

// Subsystems are STATICALLY imported. The Pear runtime is Bare: dynamic
// import() of a relative `pear://dev/...` specifier is rejected by Bare's
// module/addon resolver (UNSUPPORTED_PROTOCOL). Static imports resolve
// identically on Node and Bare. Each module exports `attach(ctx)`.
import * as autobaseSync from './autobase-sync.js'
import * as materializedView from './materialized-view.js'
import * as notesService from './notes-service.js'
import * as relayService from './relay-service.js'
import * as verifier from './verifier.js'
import * as clipboard from './clipboard.js'

const SUBSYSTEMS = [
  ['./autobase-sync.js', autobaseSync],
  ['./materialized-view.js', materializedView],
  ['./notes-service.js', notesService],
  ['./relay-service.js', relayService],
  ['./verifier.js', verifier],
  ['./clipboard.js', clipboard]
]

function makeLogger () {
  // Structured + redacted (spec §22). Bodies/keys/secrets never logged.
  const redact = (o) => {
    try {
      return JSON.parse(JSON.stringify(o, (k, v) =>
        /secret|key|mnemonic|passphrase|body|plaintext|seed/i.test(k) ? '[redacted]' : v))
    } catch (_) { return {} }
  }
  const emit = (level, msg, meta) =>
    console[level === 'debug' ? 'log' : level](
      JSON.stringify({ t: Date.now(), level, msg, ...(meta ? redact(meta) : {}) }))
  return {
    debug: (m, x) => emit('debug', m, x),
    info: (m, x) => emit('info', m, x),
    warn: (m, x) => emit('warn', m, x),
    error: (m, x) => emit('error', m, x)
  }
}

export async function createPearEnd ({ storagePath, log = makeLogger(), relayClientFactory, swarm: injectedSwarm = null } = {}) {
  if (!storagePath) throw new Error('createPearEnd requires storagePath')

  const scope = new LifecycleScope('pearpaste')
  const vaultStore = new VaultStore(storagePath)
  await vaultStore.ready()

  const disableSwarm = typeof process !== 'undefined' && process.env && process.env.PEARPASTE_DISABLE_SWARM === '1'
  const swarm = injectedSwarm || (disableSwarm ? makeMemorySwarm() : new Hyperswarm())
  swarm.on('connection', (conn, info) => {
    if (isPairingConnection(info)) return
    try { vaultStore.store.replicate(conn) } catch (err) { log.warn('replicate-failed', { err: String(err) }) }
  })

  // In-memory vault state. Keys live here and ONLY here; never cross RPC.
  const state = {
    locked: true,
    vaultId: null,
    vaultKeys: null, // { vaultKey, indexKey, deviceAdminSeed }
    device: null, // local device identity (has secret material)
    lamport: new ops.Lamport(0),
    joinedTopic: null,
    openItems: new Map() // itemId -> { plaintext, timer } (tap-to-decrypt cache)
  }

  function topicMatches (topic, other) {
    return topic && other && b4a.equals(b4a.from(topic), b4a.from(other))
  }

  function isPairingConnection (info) {
    const pending = state._pendingInvite
    const accepting = state._acceptingPairTopic
    const topics = info && Array.isArray(info.topics) ? info.topics : []
    if (accepting && topics.some(t => topicMatches(t, accepting))) return true
    if (accepting && topics.length === 0) return true
    if (!pending) return false
    if (topics.some(t => topicMatches(t, pending.topic))) return true
    if (pending.rendezvousTopic && topics.some(t => topicMatches(t, pending.rendezvousTopic))) return true
    // Server-side Hyperswarm connections are not topic-tagged. While a fresh
    // one-time invite is pending, leave those streams to the pairing responder.
    return topics.length === 0 && Date.now() <= pending.expiresAt
  }

  const isUnlocked = () => !state.locked && !!state.vaultKeys
  const dispatcher = new RpcDispatcher({ isUnlocked, logger: log })

  async function joinVault () {
    if (!state.vaultKeys) return
    const topic = pairing.vaultDiscoveryTopic(state.vaultKeys.vaultKey)
    if (state.joinedTopic) return
    const discovery = swarm.join(topic, { server: true, client: true })
    state.joinedTopic = topic
    scope.spawn(async () => { await discovery.flushed() }, 'swarm-announce')
  }

  function leaveVault () {
    if (state.joinedTopic) {
      swarm.leave(state.joinedTopic).catch(() => {})
      state.joinedTopic = null
    }
  }

  function lock () {
    leaveVault()
    for (const [, v] of state.openItems) if (v.timer) clearTimeout(v.timer)
    state.openItems.clear()
    if (state.vaultKeys) {
      crypto.wipe(state.vaultKeys.vaultKey)
      crypto.wipe(state.vaultKeys.indexKey)
      crypto.wipe(state.vaultKeys.deviceAdminSeed)
    }
    state.vaultKeys = null
    state.device = null
    state.locked = true
    ctx.emit('locked')
  }

  // The context handed to every subsystem's attach().
  const listeners = new Map()
  const ctx = {
    scope,
    vaultStore,
    swarm,
    dispatcher,
    state,
    log,
    crypto,
    ops,
    identity,
    pairing,
    relayClientFactory: relayClientFactory === undefined && typeof process !== 'undefined' &&
      process.env && process.env.PEARPASTE_DISABLE_RELAYS === '1'
      ? false
      : relayClientFactory,
    isUnlocked,
    joinVault,
    lock,
    // tiny event bus so subsystems can react to lock/unlock/op-applied
    on (ev, fn) { (listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn) },
    emit (ev, payload) { for (const fn of listeners.get(ev) || []) { try { fn(payload) } catch (_) {} } }
  }

  // ---- Foundation handlers (vault lifecycle + pairing spine) --------------
  dispatcher.register(COMMANDS.CREATE_VAULT, async ({ label, platform, passphrase = '' }) => {
    const mnemonic = identity.generateMnemonic()
    const rootSeed = identity.deriveRootSeed(mnemonic, passphrase)
    state.vaultKeys = crypto.deriveVaultKeys(rootSeed)
    state.vaultId = identity.vaultIdFromRootSeed(rootSeed)
    state.device = identity.createDeviceIdentity({ label, platform })
    vaultStore.saveLocalDevice(state.device, passphrase || mnemonic, {
      vaultId: state.vaultId,
      vaultKey: state.vaultKeys.vaultKey,
      indexKey: state.vaultKeys.indexKey,
      deviceAdminSeed: state.vaultKeys.deviceAdminSeed
    })
    await vaultStore.putVaultHeader({
      version: 1,
      vaultId: state.vaultId,
      createdAt: Date.now(),
      rootPubkey: crypto.canonicalize ? undefined : undefined, // set by sync subsystem
      kdf: 'argon2id',
      crypto: 'xchacha20poly1305-ietf',
      sync: 'autobase-v1'
    })
    crypto.wipe(rootSeed)
    state.locked = false
    await joinVault()
    ctx.emit('unlocked')
    // mnemonic is shown once to the user then dropped (spec §14 first device).
    return assertRendererSafe(COMMANDS.CREATE_VAULT, {
      vaultId: state.vaultId,
      deviceId: state.device.deviceId,
      mnemonic // one-time display; UI must not persist
    }, { allowMnemonic: true })
  })

  dispatcher.register(COMMANDS.RESTORE_VAULT, async ({ mnemonic, passphrase = '', highSecurity = false }) => {
    if (!identity.validateMnemonic(mnemonic)) {
      const e = new Error('invalid recovery phrase'); e.code = 'BAD_MNEMONIC'; throw e
    }
    const rootSeed = identity.deriveRootSeed(mnemonic, passphrase)
    const vaultId = identity.vaultIdFromRootSeed(rootSeed)
    if (highSecurity) {
      crypto.wipe(rootSeed)
      return assertRendererSafe(COMMANDS.RESTORE_VAULT, {
        vaultId,
        restored: false,
        highSecurity: true,
        approvalRequired: true
      })
    }
    state.vaultKeys = crypto.deriveVaultKeys(rootSeed)
    state.vaultId = vaultId
    let restoredDev = null
    try { restoredDev = vaultStore.loadLocalDevice(passphrase || mnemonic) } catch (_) {}
    state.device = restoredDev
      ? { ...restoredDev, signingSecretKey: crypto.deviceKeyPairFromSeed(restoredDev.signSeed).secretKey }
      : identity.createDeviceIdentity({ platform: 'unknown' })
    // Always (re)persist wrapped vault secrets so routine passphrase/keychain
    // unlock works without re-entering the recovery phrase (spec §14/§23).
    vaultStore.saveLocalDevice(state.device, passphrase || mnemonic, {
      vaultId: state.vaultId,
      vaultKey: state.vaultKeys.vaultKey,
      indexKey: state.vaultKeys.indexKey,
      deviceAdminSeed: state.vaultKeys.deviceAdminSeed
    })
    crypto.wipe(rootSeed)
    state.locked = false
    await joinVault()
    ctx.emit('unlocked', { restored: true, highSecurity })
    return assertRendererSafe(COMMANDS.RESTORE_VAULT, { vaultId: state.vaultId, restored: true })
  })

  dispatcher.register(COMMANDS.UNLOCK_VAULT, async ({ secret }) => {
    const dev = vaultStore.loadLocalDevice(secret)
    if (!dev) { const e = new Error('no local vault; create or restore'); e.code = 'NO_VAULT'; throw e }
    if (!dev.vault) {
      const e = new Error('local device is missing wrapped vault keys; pair again')
      e.code = ops.ERROR_CODES.MISSING_VAULT_KEYS
      throw e
    }
    state.device = {
      ...dev,
      signingSecretKey: crypto.deviceKeyPairFromSeed(dev.signSeed).secretKey
    }
    // Restore the wrapped vault content keys (spec §14/§23 password unlock).
    state.vaultId = dev.vault.vaultId
    state.vaultKeys = {
      vaultKey: dev.vault.vaultKey,
      indexKey: dev.vault.indexKey,
      deviceAdminSeed: dev.vault.deviceAdminSeed
    }
    ctx.emit('device-unlocked', { deviceId: dev.deviceId })
    state.locked = false
    await joinVault()
    ctx.emit('unlocked')
    return assertRendererSafe(COMMANDS.UNLOCK_VAULT, { ok: true, deviceId: dev.deviceId })
  })

  dispatcher.register(COMMANDS.LOCK_VAULT, async () => { lock(); return { ok: true } })

  dispatcher.register(COMMANDS.PAIR_CREATE_INVITE, async ({ ttlMs }) => {
    if (ctx.sync && typeof ctx.sync.ready === 'function') {
      await ctx.sync.ready(15000)
      await ctx.sync.refresh()
    }
    const header = await vaultStore.getVaultHeader()
    if (!header || !header.autobaseKey) {
      const e = new Error('pairing is not ready yet; sync is still opening')
      e.code = ops.ERROR_CODES.PAIRING_NOT_READY
      throw e
    }
    if (state._pendingInvite && state._pendingInvite.topic) {
      swarm.leave(state._pendingInvite.topic).catch(() => {})
    }
    // Tear down any previous short-code rendezvous so the old code can't be
    // used to fetch the new invite (each PAIR_CREATE_INVITE supersedes prior).
    if (state._pendingInvite && typeof state._pendingInvite.rendezvousCleanup === 'function') {
      try { state._pendingInvite.rendezvousCleanup() } catch (_) {}
    }
    const topic = pairing.newPairingTopic()
    const eph = identity.createDeviceIdentity({ label: 'pair-ephemeral', platform: 'pairing' })
    // Embed swarm pubkey + connected-relay hints so the joining device can
    // fall back to a HiveRelay circuit-relay if DHT/UDX rendezvous fails
    // (CGNAT, UDP-blocked Wi-Fi). Both fields are optional in the invite
    // payload and accepters degrade to DHT-only when they're absent.
    const swarmPubkey = swarm.keyPair && swarm.keyPair.publicKey
      ? b4a.toString(swarm.keyPair.publicKey, 'hex')
      : null
    // Wait briefly for at least one HiveRelay to connect so the pair topic
    // can be announced/dialed via relay-circuit (Hyperswarm's relay-aware
    // transport routes through them automatically). Smoke test on a healthy
    // fleet showed first connection at t+5s, so 8s is conservative headroom.
    // Resolves with current count — never throws; degrades to DHT-only.
    if (ctx.relay && typeof ctx.relay.waitForFirstConnected === 'function') {
      const n = await ctx.relay.waitForFirstConnected({ timeoutMs: 8000 })
      log.info('pair-create-relay-ready', { connectedRelays: n })
    }
    // CRITICAL: reserve circuit-relay slots BEFORE publishing the invite. The
    // joiner's circuitConnect() will ask a relay to broker a connection to our
    // swarm pubkey, which only works if we've called reserveMsg first. Without
    // this the relay returns "no reservation" and the joiner falls back to
    // DHT-only (which is what we tried to fix). Returns hex of relays that
    // ACCEPTED the reservation — those are the only meaningful relayHints.
    const reservedRelays = (ctx.relay && typeof ctx.relay.reservePairingSlots === 'function')
      ? await ctx.relay.reservePairingSlots({ max: 6 })
      : []
    log.info('pair-create-circuit-reserved', { count: reservedRelays.length })
    // Fall back to relayPeerHints() if reservation produced nothing (e.g. a
    // relay set that doesn't support circuit-relay); the joiner will at least
    // try the same DHT path it did before this fix.
    const relayHints = reservedRelays.length
      ? reservedRelays
      : ((ctx.relay && typeof ctx.relay.relayPeerHints === 'function')
          ? ctx.relay.relayPeerHints(3)
          : [])
    const invite = pairing.createInvite({
      topic,
      invitePubkey: eph.boxPubkey,
      ttlMs,
      autobaseKey: header.autobaseKey,
      swarmPubkey,
      relayHints
    })
    // Set _pendingInvite BEFORE swarm.join so any incoming connection that
    // arrives BETWEEN discovery flush and the emit-event below is still
    // handled by the responder (autobase-sync.js's swarm.on('connection')
    // checks ctx.state._pendingInvite). Order subtle but important.
    state._pendingInvite = { topic, eph, autobaseKey: header.autobaseKey, ...invite }
    log.info('pair-create-joining-topic', { topicPrefix: b4a.toString(topic, 'hex').slice(0, 16) })
    const discovery = swarm.join(topic, { server: true, client: false })
    // Mirror the accept side: announce on the DHT, then drain pending connects.
    // Without this, the source's swarm has the topic *registered* but may not
    // have flushed the announce/socket setup before the accepter dials —
    // contributing to the 30 s pairing timeout we used to see on slow links.
    await discovery.flushed()
    log.info('pair-create-discovery-flushed')
    try { await swarm.flush() } catch (_) {}
    log.info('pair-create-swarm-flushed', { swarmConnCount: (swarm.connections && swarm.connections.size) || 0 })

    // Short-code rendezvous: announce on a SECOND DHT topic derived from the
    // displayed short code. Any peer that joins gets the full invite payload
    // sent over the raw connection as one JSON frame; the joiner then runs
    // normal PAIR_ACCEPT with the resolved invite. This is discovery only:
    // autobase-sync.js still requires source-side approval before admitting a
    // writer or releasing any sealed bootstrap keys.
    let rendezvousCleanup = null
    try {
      const rendezvousTopic = pairing.shortCodeRendezvousTopic(invite.shortCode)
      state._pendingInvite.rendezvousTopic = rendezvousTopic
      log.info('pair-create-shortcode-rendezvous', {
        topicPrefix: b4a.toString(rendezvousTopic, 'hex').slice(0, 16)
      })
      const rendezvousDiscovery = swarm.join(rendezvousTopic, { server: true, client: false })
      const onRendezvousConn = (conn, info) => {
        const topics = info && Array.isArray(info.topics) ? info.topics : []
        // Match only the short-code rendezvous, NOT the main pair topic.
        if (!topics.some(t => b4a.equals(b4a.from(t), rendezvousTopic))) return
        try {
          conn.write(b4a.from(JSON.stringify({ v: 1, invite: invite.invite })))
          // Half-close so the joiner sees end-of-stream; they don't reply.
          try { conn.end() } catch (_) {}
          log.info('pair-shortcode-served')
        } catch (_) { /* peer dropped — let TTL/cleanup handle it */ }
      }
      swarm.on('connection', onRendezvousConn)
      rendezvousDiscovery.flushed().catch(() => {})
      rendezvousCleanup = () => {
        try { swarm.removeListener('connection', onRendezvousConn) } catch (_) {}
        try { rendezvousDiscovery.destroy() } catch (_) {}
      }
      // Auto-cleanup when the invite expires.
      const expiryMs = Math.max(1000, (invite.expiresAt || Date.now() + 5 * 60 * 1000) - Date.now())
      const t = setTimeout(() => { if (state._pendingInvite && state._pendingInvite.rendezvousCleanup === rendezvousCleanup) rendezvousCleanup() }, expiryMs)
      if (t.unref) t.unref()
    } catch (err) {
      // Non-fatal: the long-invite path still works without rendezvous.
      log.warn('pair-shortcode-rendezvous-failed', { err: String((err && err.message) || err) })
    }
    state._pendingInvite.rendezvousCleanup = rendezvousCleanup

    ctx.emit('pair-invite-created', { expiresAt: invite.expiresAt })
    return assertRendererSafe(COMMANDS.PAIR_CREATE_INVITE, invite)
  })

  // PAIR_LOOKUP_SHORTCODE: the joiner side of the short-code rendezvous.
  // Resolves the 8-char code into the full invite payload over the DHT, so
  // the renderer can then call PAIR_ACCEPT with the resolved blob. Allowed
  // while locked because that's the only time it's useful.
  dispatcher.register(COMMANDS.PAIR_LOOKUP_SHORTCODE, async ({ shortCode, timeoutMs }) => {
    if (!pairing.isShortCodeShape(shortCode)) {
      const e = new Error('short code must be 8 hex chars (e.g. A1B2-C3D4)')
      e.code = 'BAD_SHORT_CODE'
      throw e
    }
    const topic = pairing.shortCodeRendezvousTopic(shortCode)
    // Best-effort relay warm-up so circuit-relay works under CGNAT.
    if (ctx.relay && typeof ctx.relay.waitForFirstConnected === 'function') {
      try { await ctx.relay.waitForFirstConnected({ timeoutMs: 5000 }) } catch (_) {}
    }
    const limit = Math.max(1000, Math.min(120000, Number(timeoutMs) || 30000))
    return await new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        const e = new Error('short code not found — check it matches the inviting device, then try again')
        e.code = 'SHORTCODE_NOT_FOUND'
        reject(e)
      }, limit)
      if (timer.unref) timer.unref()
      const onConn = (conn, info) => {
        const topics = info && Array.isArray(info.topics) ? info.topics : []
        if (!topics.some(t => b4a.equals(b4a.from(t), topic))) return
        let buf = b4a.alloc(0)
        const onData = (d) => {
          buf = b4a.concat([buf, d])
          let msg = null
          try { msg = JSON.parse(b4a.toString(buf)) } catch (_) { return }
          if (settled) return
          if (msg && msg.v === 1 && typeof msg.invite === 'string') {
            settled = true
            clearTimeout(timer)
            cleanup()
            try { conn.end() } catch (_) {}
            resolve(assertRendererSafe(COMMANDS.PAIR_LOOKUP_SHORTCODE, { invite: msg.invite }))
          }
        }
        conn.on('data', onData)
        conn.on('error', () => {})
      }
      swarm.on('connection', onConn)
      const discovery = swarm.join(topic, { server: false, client: true })
      function cleanup () {
        try { swarm.removeListener('connection', onConn) } catch (_) {}
        try { discovery.destroy() } catch (_) {}
      }
      // Best-effort flush so the lookup actively dials known peers.
      discovery.flushed().catch(() => {})
    })
  })

  // PAIR_ACCEPT, DEVICE_LIST/REVOKE, NOTE_*, CLIP_*, SEARCH, RELAY_*,
  // VERIFY_ENCRYPTION, *_BACKUP are registered by wave-1 subsystems via
  // attach(ctx). If a subsystem is not yet present the command returns a clear
  // "subsystem pending" error instead of crashing the Pear-end.
  for (const [mod, m] of SUBSYSTEMS) {
    try {
      if (typeof m.attach === 'function') {
        await m.attach(ctx)
        log.info('subsystem-attached', { mod })
      }
    } catch (err) {
      log.warn('subsystem-pending', { mod, err: String((err && err.message) || err) })
    }
  }

  scope.onClose(async () => { swarm.destroy().catch(() => {}) })
  scope.onClose(async () => { await vaultStore.close() })

  const unregisterGoodbye = goodbye(async () => {
    log.info('shutdown-begin')
    lock()
    await scope.close() // drains loops before Corestore/swarm close (spec §10)
    log.info('shutdown-done')
  })

  return {
    dispatcher,
    scope,
    swarm,
    vaultStore,
    state,
    ctx,
    log,
    call: (command, params, c) => dispatcher.call(command, params, c),
    async close () { unregisterGoodbye(); lock(); await scope.close() }
  }
}

function makeMemorySwarm () {
  const listeners = new Map()
  const swarm = {
    connections: new Set(),
    keyPair: null,
    on (ev, fn) {
      ;(listeners.get(ev) || listeners.set(ev, []).get(ev)).push(fn)
      return this
    },
    removeListener (ev, fn) {
      const list = listeners.get(ev) || []
      const i = list.indexOf(fn)
      if (i >= 0) list.splice(i, 1)
      return this
    },
    emit (ev, ...args) {
      for (const fn of listeners.get(ev) || []) {
        try { fn(...args) } catch (_) {}
      }
      return true
    },
    join () {
      return {
        flushed: async () => {},
        destroy () {}
      }
    },
    leave: async () => {},
    flush: async () => {},
    destroy: async () => {}
  }
  return swarm
}

export default createPearEnd
