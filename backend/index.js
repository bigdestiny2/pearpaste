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
import { createReplicationFirewall } from './replication-firewall.js'

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

async function flushSwarmBestEffort (swarm, log, label, timeoutMs = 2500) {
  if (!swarm || typeof swarm.flush !== 'function') return { ok: false, timedOut: false }
  let timer = null
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs)
    if (timer.unref) timer.unref()
  })
  const flush = Promise.resolve()
    .then(() => swarm.flush())
    .then(
      () => ({ ok: true, timedOut: false }),
      (err) => ({ ok: false, timedOut: false, err })
    )
  const result = await Promise.race([flush, timeout])
  if (timer) clearTimeout(timer)
  if (result.timedOut) log.warn(label + '-timeout', { timeoutMs })
  else if (result.err) log.warn(label + '-failed', { err: String((result.err && result.err.message) || result.err) })
  return result
}

export async function createPearEnd ({ storagePath, log = makeLogger(), relayClientFactory, swarm: injectedSwarm = null } = {}) {
  if (!storagePath) throw new Error('createPearEnd requires storagePath')

  const scope = new LifecycleScope('pearpaste')
  const vaultStore = new VaultStore(storagePath)
  await vaultStore.ready()

  const disableSwarm = typeof process !== 'undefined' && process.env && process.env.PEARPASTE_DISABLE_SWARM === '1'
  const swarm = injectedSwarm || (disableSwarm ? makeMemorySwarm() : new Hyperswarm())

  // REPLICATION FIREWALL (REVOCATION_DESIGN §3.7.2 / GATE SB2) — the
  // load-bearing replication control. store.replicate(conn) now runs only for
  // peers that authenticate as a committed NON-REVOKED device; on DEVICE_REVOKE
  // every live stream to the revoked device is actively destroyed (refusing
  // new connections alone is not enough — replication streams survive
  // swarm.leave and relay unseed is cosmetic). Topic rotation below is a
  // discovery convenience only. PEARPASTE_REPL_FIREWALL=off is the field
  // kill-switch: legacy unconditional replication, still authenticating
  // outbound so enforcing peers accept us.
  const firewall = createReplicationFirewall({
    // Resolved lazily: resetReplicatedStorage() (vault switch, Fix A2) replaces
    // the Corestore object, so the firewall must always replicate the live one.
    getStore: () => vaultStore.store,
    log,
    getDevice: () => state.device,
    getEngine: () => ctx.sync,
    // Event-driven pending-peer recheck: the engine emits 'auth-cache-rebuilt'
    // after every apply pass rebuilds the committed device set — the only time
    // an 'unknown' verdict can change. Returns an unsubscribe.
    subscribeAuthChanges: (fn) => {
      ctx.on('auth-cache-rebuilt', fn)
      return () => ctx.off('auth-cache-rebuilt', fn)
    },
    isRelayPeer: (hex) => !!(ctx.relay && typeof ctx.relay.isRelayPeer === 'function' && ctx.relay.isRelayPeer(hex)),
    enforce: !(typeof process !== 'undefined' && process.env && process.env.PEARPASTE_REPL_FIREWALL === 'off')
  })
  swarm.on('connection', (conn, info) => {
    if (isPairingConnection(info)) return // pairing keeps its dedicated raw-frame path
    firewall.handleConnection(conn, info)
  })

  // In-memory vault state. Keys live here and ONLY here; never cross RPC.
  const state = {
    locked: true,
    vaultId: null,
    vaultKeys: null, // { vaultKey, indexKey, deviceAdminSeed }
    device: null, // local device identity (has secret material)
    lamport: new ops.Lamport(0),
    joinedTopic: null, // mirror of the ACTIVE vault topic (legacy observers/tests)
    // The reconciled topic SET (design §5.10): topicHex -> { topic, kind }.
    // Kinds: 'vault' (active-epoch discovery topic), 'follow-self' (this
    // device's own catch-up topic, always joined), 'follow-peer' (a surviving
    // peer's catch-up topic, announced for a window after a rotation).
    joinedTopics: new Map(),
    _followAnnounceUntil: 0,
    openItems: new Map() // itemId -> { plaintext, timer } (tap-to-decrypt cache)
  }

  function topicMatches (topic, other) {
    return topic && other && b4a.equals(b4a.from(topic), b4a.from(other))
  }

  function isPairingConnection (info) {
    const pending = state._pendingInvite
    const accepting = state._acceptingPairTopic
    const lookup = state._lookupRendezvousTopic // joiner-side short-code lookup window
    const topics = info && Array.isArray(info.topics) ? info.topics : []
    if (accepting && topics.some(t => topicMatches(t, accepting))) return true
    if (accepting && topics.length === 0) return true
    // While PAIR_LOOKUP_SHORTCODE is in flight, its rendezvous conns must stay
    // RAW: if the firewall protomuxes them, its credential frames poison the
    // inviter's JSON accumulator and the plaintext invite reply never parses.
    // Mirrors the `accepting` posture above (incl. the topic-less skip —
    // server-side Hyperswarm conns carry no topics).
    if (lookup && topics.some(t => topicMatches(t, lookup))) return true
    if (lookup && topics.length === 0) return true
    if (!pending) return false
    if (topics.some(t => topicMatches(t, pending.topic))) return true
    if (pending.rendezvousTopic && topics.some(t => topicMatches(t, pending.rendezvousTopic))) return true
    // Server-side Hyperswarm connections are not topic-tagged. While a fresh
    // one-time invite is pending, leave those streams to the pairing responder.
    return topics.length === 0 && Date.now() <= pending.expiresAt
  }

  const isUnlocked = () => !state.locked && !!state.vaultKeys
  const dispatcher = new RpcDispatcher({ isUnlocked, logger: log })

  // How long survivors announce each other's follow topics after a rotation
  // (design §4): long enough for a typical offline device to come back, cheap
  // either way (N-1 extra announced topics for 2-6 devices).
  const FOLLOW_ANNOUNCE_MS = 24 * 60 * 60 * 1000

  // The follow seed (design §4). Phase 4 delivers a dedicated random
  // followSeed at pairing (state._followSeed, persisted in the local blob);
  // until one was delivered, fall back to a vaultKey-derived seed. Metadata
  // posture of the fallback is identical to the epoch-0 topic (also
  // vaultKey-derived), and follow topics are DISCOVERY ONLY — knowing one buys
  // a connection, and the replication firewall still refuses a revoked or
  // unknown peer on it (GATE SB2: topics never were the exclusion control).
  function followSeedCurrent () {
    if (state._followSeed) {
      return b4a.isBuffer(state._followSeed) ? state._followSeed : b4a.from(String(state._followSeed), 'hex')
    }
    if (state.vaultKeys && state.vaultKeys.vaultKey) {
      return crypto.hkdf(state.vaultKeys.vaultKey, 'follow-seed-v1', 32)
    }
    return null
  }

  // Epoch-aware vault discovery topic (design §3.7.1). Epoch 0 keeps the
  // legacy vaultKey-derived topic byte-identical (no flag-day, design §6).
  // After a rotation the topic derives from the ACTIVE epoch key — the seed is
  // computed locally and never transmitted (B3), so a revoked device cannot
  // compute it. If the engine knows the active tag but this device has not
  // unwrapped that key yet (transiently behind), stay on the newest topic we
  // CAN derive — the follow-topic channel carries us forward.
  function activeVaultTopic () {
    if (!state.vaultKeys) return null
    const engine = ctx.sync
    if (engine && engine.activeEpochTag && engine.epochKeys) {
      const ek = engine.epochKeys.get(engine.activeEpochTag)
      if (ek) return pairing.vaultDiscoveryTopic(crypto.topicSeedFromEpochKey(ek))
    }
    return pairing.vaultDiscoveryTopic(state.vaultKeys.vaultKey)
  }

  // Reconcile the joined topic SET from committed state (design §5.10):
  // join what should be joined, leave what should not. Grace on the old epoch
  // topic is ZERO (stolen-device default, design §4/B13): the follow-topic
  // channel carries offline survivors, and lingering on topic_N only leaks
  // metadata — the revoked device never needed the topic to replicate (SB2).
  function reconcileTopics () {
    if (!state.vaultKeys || state.locked) return
    const desired = new Map()
    const vt = activeVaultTopic()
    if (vt) desired.set(b4a.toString(vt, 'hex'), { topic: vt, kind: 'vault', opts: { server: true, client: true } })
    const fseed = followSeedCurrent()
    if (fseed && state.device) {
      const own = pairing.followTopic(fseed, state.device.deviceId)
      desired.set(b4a.toString(own, 'hex'), { topic: own, kind: 'follow-self', opts: { server: true, client: true } })
    }
    if (fseed && state._followAnnounceUntil > Date.now()) {
      const engine = ctx.sync
      if (engine && engine.devices) {
        for (const d of engine.devices.values()) {
          if (d.revokedAtLamport != null) continue // NEVER announce a revoked device's follow topic
          if (state.device && d.deviceId === state.device.deviceId) continue
          const ft = pairing.followTopic(fseed, d.deviceId)
          desired.set(b4a.toString(ft, 'hex'), { topic: ft, kind: 'follow-peer', opts: { server: true, client: true } })
        }
      }
    }
    for (const [hex, want] of desired) {
      if (state.joinedTopics.has(hex)) continue
      try {
        const discovery = swarm.join(want.topic, want.opts)
        state.joinedTopics.set(hex, { topic: want.topic, kind: want.kind })
        scope.spawn(async () => {
          await discovery.flushed()
          try { await swarm.flush() } catch (_) {}
        }, 'swarm-announce-' + want.kind)
      } catch (err) {
        log.warn('topic-join-failed', { kind: want.kind, err: String((err && err.message) || err) })
      }
    }
    for (const [hex, have] of state.joinedTopics) {
      if (desired.has(hex)) continue
      swarm.leave(have.topic).catch(() => {})
      state.joinedTopics.delete(hex)
    }
    const v = [...state.joinedTopics.values()].find((t) => t.kind === 'vault')
    state.joinedTopic = v ? v.topic : null
  }

  async function joinVault () {
    if (!state.vaultKeys) return
    reconcileTopics()
  }

  function leaveVault () {
    for (const [, { topic }] of state.joinedTopics) {
      swarm.leave(topic).catch(() => {})
    }
    state.joinedTopics.clear()
    state.joinedTopic = null
    state._followAnnounceUntil = 0
  }

  // Project the epoch chain a loaded local-device blob carries into a hex map
  // keyed by epochTag (design §5.9). loadLocalDevice already parsed it to Buffers
  // under dev.vault.epochKeys; re-encode to hex for state._epochKeysLocal (the
  // shape the sync engine re-wraps at rotation). Absent for epoch-0-only blobs.
  function epochKeysHexFrom (dev) {
    const ek = dev && dev.vault && dev.vault.epochKeys
    if (!ek || typeof ek !== 'object') return {}
    const out = {}
    for (const [tag, key] of Object.entries(ek)) {
      out[tag] = b4a.isBuffer(key) ? b4a.toString(key, 'hex') : String(key)
    }
    return out
  }

  // DEVICE_HYGIENE Fix A2 — vault-scoped storage hygiene on replacement.
  // When CREATE_VAULT / RESTORE_VAULT targets a vaultId that DIFFERS from the
  // one this install last stored, the prior vault's replicated cores (shared
  // under the fixed autobase/search namespaces) would otherwise stay on disk
  // and its device records would surface as unresolvable `{ sealed: true }`
  // rows in the new vault's DEVICE_LIST. So we tear the prior vault down and
  // wipe its cores BEFORE the new base is opened. A same-vault restore (prior
  // === new) is a no-op, so an existing paired vault keeps its cores and its
  // committed writerKey — the breaking-migration trap is avoided by never
  // touching the namespace. Returns true iff a reset was performed.
  async function maybeSwitchVaultStorage (newVaultId) {
    let priorVaultId = null
    try {
      const h = await vaultStore.getVaultHeader()
      priorVaultId = h && h.vaultId
    } catch (_) { priorVaultId = null }
    if (!priorVaultId || priorVaultId === newVaultId) return false
    log.info('vault-switch-reset', { reason: 'different vaultId on this install' })
    // Cleanly tear down the outgoing vault: lock() wipes its keys + leaves the
    // swarm and re-arms the sync readiness gate (via the 'locked' event) so a
    // handler racing the new open() waits for the NEW engine, not the old one.
    if (isUnlocked()) lock()
    // lock() spawns engine.close(); await it directly so no core session is
    // open when we wipe storage (close() is idempotent).
    if (ctx.sync && typeof ctx.sync.close === 'function') {
      try { await ctx.sync.close() } catch (_) {}
    }
    // Let the relay service drop its cached client (it captured the old store).
    ctx.emit('vault-storage-reset')
    await vaultStore.resetReplicatedStorage()
    state._vaultHeaderCache = null
    return true
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
    // Drop the epoch-chain working state so no key material / unlock secret
    // survives lock (the engine wipes engine.epochKeys separately on close).
    state._unlockSecret = null
    state._epochKeysLocal = null
    state._followSeed = null
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
    off (ev, fn) {
      const arr = listeners.get(ev)
      if (!arr) return
      const i = arr.indexOf(fn)
      if (i !== -1) arr.splice(i, 1)
    },
    emit (ev, payload) { for (const fn of listeners.get(ev) || []) { try { fn(payload) } catch (_) {} } }
  }
  ctx.replicationFirewall = firewall // observability for tests/status panels

  // Topic-set + firewall reactions to committed sync state (design §3.4 step 6:
  // the reducer only SIGNALS; the host reconciles from committed state here).
  // 'sync-ready' re-reconciles after the engine rebuilt activeEpochTag from the
  // committed view (a reopen of an already-rotated vault emits no
  // 'epoch-rotated', so this is what moves a returning device onto its newest
  // derivable topic).
  ctx.on('sync-ready', () => reconcileTopics())
  ctx.on('epoch-rotated', () => {
    state._followAnnounceUntil = Date.now() + FOLLOW_ANNOUNCE_MS
    reconcileTopics()
    // Drop the follow-peer announcements once the window lapses.
    const t = setTimeout(() => reconcileTopics(), FOLLOW_ANNOUNCE_MS + 1000)
    if (t.unref) t.unref()
  })
  ctx.on('device-revoked', (e) => {
    // [GATE SB2 part b] Actively destroy every live replication stream
    // authenticated to the revoked device — on EVERY device that applies the
    // revoke, not just the revoking admin. Then re-reconcile topics so the
    // revoked device's follow topic is no longer announced.
    if (e && e.deviceId) firewall.destroyPeer(e.deviceId)
    reconcileTopics()
  })

  // ---- Foundation handlers (vault lifecycle + pairing spine) --------------
  dispatcher.register(COMMANDS.CREATE_VAULT, async ({ label, platform, passphrase = '' }) => {
    const mnemonic = identity.generateMnemonic()
    const rootSeed = identity.deriveRootSeed(mnemonic, passphrase)
    const newVaultId = identity.vaultIdFromRootSeed(rootSeed)
    // Wipe a prior, different vault's replicated cores before opening this one
    // (Fix A2). Done while state still reflects the outgoing vault so lock()
    // can tear it down cleanly.
    await maybeSwitchVaultStorage(newVaultId)
    state.vaultKeys = crypto.deriveVaultKeys(rootSeed)
    state.vaultId = newVaultId
    state.device = identity.createDeviceIdentity({ label, platform })
    // Remember the unlock secret + epoch chain so the sync engine can re-wrap a
    // newly-unwrapped epoch key into the local blob at rotation (design §5.9).
    // Best-effort: a fresh vault is epoch 0 only, so the map starts empty.
    state._unlockSecret = passphrase || mnemonic
    state._epochKeysLocal = {}
    state._followSeed = null
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
    // Wipe a prior, different vault's replicated cores before restoring onto
    // this install (Fix A2). A same-vault restore (recovery / re-pair) is a
    // no-op so the existing base + its committed writerKeys are preserved.
    const didReset = await maybeSwitchVaultStorage(vaultId)
    state.vaultKeys = crypto.deriveVaultKeys(rootSeed)
    state.vaultId = vaultId
    let restoredDev = null
    try { restoredDev = vaultStore.loadLocalDevice(passphrase || mnemonic) } catch (_) {}
    state.device = restoredDev
      ? { ...restoredDev, signingSecretKey: crypto.deviceKeyPairFromSeed(restoredDev.signSeed).secretKey }
      : identity.createDeviceIdentity({ platform: 'unknown' })
    // Carry forward any epoch chain + follow seed the local blob already held so
    // a restored device keeps its post-rotation keys (design §5.9).
    state._unlockSecret = passphrase || mnemonic
    state._epochKeysLocal = epochKeysHexFrom(restoredDev)
    state._followSeed = restoredDev && restoredDev.vault && restoredDev.vault.followSeed
      ? restoredDev.vault.followSeed
      : null
    // Always (re)persist wrapped vault secrets so routine passphrase/keychain
    // unlock works without re-entering the recovery phrase (spec §14/§23).
    vaultStore.saveLocalDevice(state.device, passphrase || mnemonic, {
      vaultId: state.vaultId,
      vaultKey: state.vaultKeys.vaultKey,
      indexKey: state.vaultKeys.indexKey,
      deviceAdminSeed: state.vaultKeys.deviceAdminSeed,
      epochKeys: state._epochKeysLocal,
      followSeed: state._followSeed
    })
    // If we wiped a prior vault's storage, the meta bee is empty — re-record
    // this vault's id so a future CREATE/RESTORE can detect the next switch.
    // (The autobaseKey is intentionally omitted; sync.open() writes it as this
    // device bootstraps/joins the base.) Skipped on a same-vault restore so an
    // existing header's autobaseKey is never clobbered into a fork.
    if (didReset) {
      await vaultStore.putVaultHeader({
        version: 1,
        vaultId: state.vaultId,
        createdAt: Date.now(),
        kdf: 'argon2id',
        crypto: 'xchacha20poly1305-ietf',
        sync: 'autobase-v1'
      })
    }
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
    // Restore the epoch chain + follow seed the blob carried (design §5.9) so a
    // password unlock recovers post-rotation keys without re-reading wrap rows.
    state._unlockSecret = secret
    state._epochKeysLocal = epochKeysHexFrom(dev)
    state._followSeed = dev.vault.followSeed || null
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
    const flushed = await flushSwarmBestEffort(swarm, log, 'pair-create-swarm-flush')
    log.info('pair-create-swarm-flushed', {
      swarmConnCount: (swarm.connections && swarm.connections.size) || 0,
      timedOut: flushed.timedOut
    })

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
      const rendezvousTopicHex = b4a.toString(rendezvousTopic, 'hex')
      const serveInvite = (conn) => {
        try {
          conn.write(b4a.from(JSON.stringify({ v: 1, invite: invite.invite })))
          // Half-close so the joiner sees end-of-stream; they don't reply.
          try { conn.end() } catch (_) {}
          log.info('pair-shortcode-served')
        } catch (_) { /* peer dropped — let TTL/cleanup handle it */ }
      }
      const onRendezvousConn = (conn, info) => {
        const topics = info && Array.isArray(info.topics) ? info.topics : []
        // Topic-tagged conns (client-side dials and the in-memory test swarm)
        // identify themselves — serve immediately, as before.
        if (topics.some(t => b4a.equals(b4a.from(t), rendezvousTopic))) return serveInvite(conn)
        // REAL server-side Hyperswarm connections are NEVER topic-tagged
        // (PeerInfo.topics is only populated by the dialer's own lookups), so
        // a joiner that found us via the short-code topic arrives here with
        // topics=[]. Serve on an explicit request frame naming the full
        // 32-byte rendezvous topic: deriving it requires the short code
        // (app-namespaced HMAC), the same bar as dialing the topic. Invites
        // are discovery-only — admission still requires source-side approval
        // + the matching confirmation phrase (autobase-sync).
        if (topics.length !== 0) return
        let buf = b4a.alloc(0)
        const onData = (d) => {
          buf = b4a.concat([buf, d])
          if (buf.byteLength > 4096) { conn.removeListener('data', onData); return }
          let msg = null
          try { msg = JSON.parse(b4a.toString(buf)) } catch (_) { return }
          conn.removeListener('data', onData)
          if (msg && msg.v === 1 && msg.want === 'pp-shortcode-invite' && msg.topic === rendezvousTopicHex) {
            serveInvite(conn)
          }
        }
        conn.on('data', onData)
        conn.on('error', () => {})
      }
      swarm.on('connection', onRendezvousConn)
      // Wait (bounded) for the announce to actually land on the DHT before
      // returning the code to the renderer — the user reads the code to the
      // other device IMMEDIATELY, and an unflushed announce is invisible to
      // the joiner's lookup.
      await Promise.race([
        rendezvousDiscovery.flushed().catch(() => {}),
        new Promise((resolve) => { const t = setTimeout(resolve, 10000); if (t.unref) t.unref() })
      ])
      log.info('pair-create-shortcode-rendezvous-flushed')
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
    const topicHex = b4a.toString(topic, 'hex')
    // Open the joiner-side pairing window: isPairingConnection() keeps these
    // rendezvous conns RAW (no firewall protomux) for the lookup's duration —
    // otherwise the firewall's credential frames poison the inviter's JSON
    // accumulator and the invite reply never arrives.
    state._lookupRendezvousTopic = topic
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
        // Ask for the invite explicitly: the inviter's server-side view of
        // this conn carries NO topic tags (real Hyperswarm never tags them),
        // so it cannot know this conn is a short-code lookup until we say so.
        try {
          conn.write(b4a.from(JSON.stringify({ v: 1, want: 'pp-shortcode-invite', topic: topicHex })))
        } catch (_) { /* conn raced shut — timeout covers it */ }
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
        if (state._lookupRendezvousTopic === topic) state._lookupRendezvousTopic = null
        try { swarm.removeListener('connection', onConn) } catch (_) {}
        try { discovery.destroy() } catch (_) {}
      }
      // ACTIVE lookup driver: a single flushed() query races the inviter's
      // announce propagation (seconds on a healthy DHT, longer across NATs) —
      // if the one-shot query ran first, a passive joiner would sit blind
      // until Hyperswarm's own (multi-minute) refresh and time out. Re-run
      // the lookup every few seconds for the whole window instead.
      ;(async () => {
        try { await discovery.flushed() } catch (_) {}
        while (true) {
          if (settled) return
          await new Promise((resolve) => { const t = setTimeout(resolve, 3000); if (t.unref) t.unref() })
          if (settled) return
          try { await discovery.refresh() } catch (_) {}
          try { await swarm.flush() } catch (_) {}
        }
      })().catch(() => {})
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
