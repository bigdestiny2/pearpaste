// Paste HiveRelay availability layer.
//
// Integrates p2p-hiverelay-client@0.9.2 for ENCRYPTED AVAILABILITY, never
// trust. HiveRelay is used to (a) keep the encrypted vault operation log
// reachable while every personal device is asleep, (b) provide Atomic Blind
// Custody receipts for temporary clipboard items, and (c) surface a live
// "always online" status. Relays only ever receive ciphertext, encrypted
// roots, commitments, and signed receipts — never note/clip plaintext and
// never data keys (spec §4 relay blindness, §11, §22).
//
// FAILURE BEHAVIOR (spec §11): if the client package fails to import or the
// relay network is unreachable, the app stays local-first / direct-P2P. Relay
// problems must NEVER block local use, so every relay call is wrapped and
// degrades to a no-op with a recorded reason.
//
// CONTRACTS HONORED (§22): reuse ctx.swarm + ctx.vaultStore.store (advanced
// mode — the client does not own them, so its destroy() will not tear down
// our Hyperswarm/Corestore); background loops run under ctx.scope and drain on
// teardown; logs go through ctx.log (redacted).
//
// Spec refs: §4, §10 (teardown), §11 (HiveRelay integration + UX + failure),
// §17 (pin app package), §21 Agent 2, §22.

import fs from 'fs'
import path from 'path'
import b4a from 'b4a'
import { COMMANDS } from './rpc.js'
import { SENTINEL_PREFIX } from './shared-ops.js'
import bundledFleet from '../config/fleet-relays.js'

// Fields that may NEVER appear in anything handed to a relay. This is the
// last line of defense behind the envelope discipline: even if a caller
// constructs a bad payload, assertCiphertextOnly() throws before it leaves
// the process.
const RELAY_FORBIDDEN_KEY_RE =
  /(^|[^a-z])(plaintext|mnemonic|passphrase|recoveryphrase|rootseed|seed|secret|privatekey|secretkey|signingsecretkey|boxsecretkey|devicesecretkey|deviceadminseed|vaultkey|indexkey|itemkey|signseed|masterkey|password|passwd|notebody|clipbody|body|title|tag|tags|content)([^a-z]|$)/i

export class RelayBlindnessError extends Error {
  constructor (msg) {
    super('relay blindness violation: ' + msg)
    this.name = 'RelayBlindnessError'
    this.code = 'RELAY_BLINDNESS'
  }
}

// Deep-assert that `obj` carries only relay-safe data: no forbidden keys, no
// plaintext sentinel anywhere in the serialized form. Hex/base64 ciphertext,
// roots, ids, numbers, and booleans are fine.
export function assertCiphertextOnly (obj, where = 'relay-call') {
  let json
  try { json = JSON.stringify(obj) } catch (_) { json = String(obj) }
  if (json && json.includes(SENTINEL_PREFIX)) {
    throw new RelayBlindnessError(where + ': plaintext sentinel present')
  }
  const visit = (v) => {
    if (v == null) return
    if (Array.isArray(v)) { v.forEach(visit); return }
    if (typeof v === 'object') {
      for (const k of Object.keys(v)) {
        if (RELAY_FORBIDDEN_KEY_RE.test(k)) {
          throw new RelayBlindnessError(where + ': forbidden field "' + k + '"')
        }
        visit(v[k])
      }
    }
  }
  visit(obj)
  return true
}

// Mirror anything we hand to a relay into <storage>/relay-exports so the
// verifier's "relay payload scan" audits the exact bytes that left the
// process. (Belt-and-suspenders next to assertCiphertextOnly.)
function recordRelayExport (storagePath, label, payload) {
  try {
    const dir = path.join(storagePath, 'relay-exports')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, label + '-' + Date.now() + '.json')
    fs.writeFileSync(file, JSON.stringify(payload), { mode: 0o600 })
  } catch (_) {
    // Export mirroring is best-effort diagnostics; never block a relay op.
  }
}

const DEFAULTS = Object.freeze({
  durability: 1, // archive tier (spec §11 example)
  privacyTier: 'p2p-only', // blind by default (spec §11)
  replicationFactor: 5, // spec §11 example
  custodyReplicas: 3, // spec §11 publishCustodyIntent example
  maxStorageBytes: 256 * 1024 * 1024,
  seedTimeoutMs: 15_000
})

// Load fleet relay configuration.
//
// IMPORTANT: this whole loader exists ONLY for advanced deployments (private
// corporate fleets, browser/PWA WSS-bridge clients). The default for a
// Pear-native app is EMPTY across the board — p2p-hiverelay-client discovers
// every operator's relays over RELAY_DISCOVERY_TOPIC on the Hyperswarm DHT
// without any of these fields set. See config/fleet-relays.js for the why.
//
// Priority (later wins):
//   3. bundled default       `config/fleet-relays.js` (statically imported)
//   2. per-install override  `<storagePath>/fleet-relays.json`
//   1. env PEARPASTE_RELAYS  WSS-bridge URL=pubkey list (browser/mobile clients
//                            that don't have a DHT — Pear-native ignores this)
//
// Three independent fields, all optional:
//   foundationPubkeys[]  — operator-fleet pin (restricts trust to specific pks)
//   knownRelays{url:pk}  — WSS DHT-bridge pinning (browser/mobile only)
//   bootstrap[]          — extra DHT bootstrap pubkeys
//
// Pubkeys ARE NOT transports. Pear-native discovers everything via DHT.
function loadFleetConfig (storagePath, log) {
  const out = { foundationPubkeys: [], knownRelays: {}, bootstrap: [] }
  const seenFoundation = new Set()
  const addFoundation = (arr) => {
    if (!Array.isArray(arr)) return
    for (const pk of arr) {
      const h = String(pk).toLowerCase()
      if (/^[0-9a-f]{64}$/.test(h) && !seenFoundation.has(h)) {
        seenFoundation.add(h)
        out.foundationPubkeys.push(h)
      }
    }
  }

  // 3. bundled default — already imported statically.
  if (bundledFleet && typeof bundledFleet === 'object') {
    addFoundation(bundledFleet.foundationPubkeys)
    if (bundledFleet.knownRelays && typeof bundledFleet.knownRelays === 'object') {
      Object.assign(out.knownRelays, bundledFleet.knownRelays)
    }
    if (Array.isArray(bundledFleet.bootstrap)) out.bootstrap.push(...bundledFleet.bootstrap)
    if (out.foundationPubkeys.length || Object.keys(out.knownRelays).length || out.bootstrap.length) {
      log.info('fleet-config-bundled', {
        foundationPubkeys: out.foundationPubkeys.length,
        knownRelays: Object.keys(out.knownRelays).length,
        bootstrap: out.bootstrap.length
      })
    }
  }

  // 2. per-install JSON override.
  if (storagePath) {
    try {
      const overrideFile = path.join(storagePath, 'fleet-relays.json')
      if (fs.existsSync(overrideFile)) {
        const j = JSON.parse(fs.readFileSync(overrideFile, 'utf8'))
        addFoundation(j && j.foundationPubkeys)
        if (j && typeof j.knownRelays === 'object') Object.assign(out.knownRelays, j.knownRelays)
        if (Array.isArray(j && j.bootstrap)) out.bootstrap.push(...j.bootstrap)
        log.info('fleet-config-storage', {
          foundationPubkeys: (j && Array.isArray(j.foundationPubkeys)) ? j.foundationPubkeys.length : 0,
          knownRelays: Object.keys((j && j.knownRelays) || {}).length,
          bootstrap: ((j && j.bootstrap) || []).length
        })
      }
    } catch (err) {
      log.warn('fleet-config-storage-bad', { err: String((err && err.message) || err) })
    }
  }

  // 1. env override — WSS DHT-bridge pinning only (foundationPubkeys are
  // bundled/per-install, not a per-launch concept).
  try {
    const env = (globalThis.process && process.env && process.env.PEARPASTE_RELAYS) || ''
    if (env) {
      let added = 0
      for (const pair of env.split(',').map(s => s.trim()).filter(Boolean)) {
        const i = pair.indexOf('=')
        if (i < 0) continue
        const url = pair.slice(0, i).trim().replace(/\/+$/, '')
        const pubkey = pair.slice(i + 1).trim().toLowerCase()
        if (url && /^[0-9a-f]{64}$/.test(pubkey)) {
          out.knownRelays[url] = pubkey
          added++
        }
      }
      if (added > 0) log.info('fleet-config-env', { added })
    }
  } catch (_) {}

  return out
}

export async function attach (ctx) {
  const log = ctx.log
  const storagePath = ctx.vaultStore.storagePath
  const fleet = loadFleetConfig(storagePath, log)
  const knownRelayCount = Object.keys(fleet.knownRelays).length
  const foundationCount = fleet.foundationPubkeys.length
  if (foundationCount > 0 || knownRelayCount > 0 || fleet.bootstrap.length > 0) {
    log.info('relay-fleet-configured', {
      foundationPubkeys: foundationCount,
      knownRelays: knownRelayCount,
      bootstrap: fleet.bootstrap.length
    })
  } else {
    // This is the expected, supported, recommended default for a Pear-native
    // app. p2p-hiverelay-client discovers every operator's relays over its
    // hardcoded RELAY_DISCOVERY_TOPIC the moment client.start() resolves —
    // no operator-specific pubkeys, env vars, or pasted addresses needed.
    log.info('relay-fleet-default', { mode: 'dht-auto-discovery' })
  }

  // Observability only (no behavior change): bootstrap[] is honored by the
  // 0.9.2 client ONLY when it owns its swarm. We run in advanced mode and pass
  // ctx.swarm in (the client does NOT own it — §22 single-swarm contract), so
  // any configured bootstrap entries are a silent no-op. Surface that clearly
  // so an advanced operator isn't left wondering why their bootstrap[] had no
  // effect, instead of debugging a phantom config knob.
  if (fleet.bootstrap.length > 0) {
    log.warn('relay-fleet-bootstrap-ignored', {
      count: fleet.bootstrap.length,
      reason: 'advanced-mode: client does not own the swarm'
    })
  }

  // Mutable service state. `enabled` defaults true but the whole subsystem is
  // optional: nothing here can block local use.
  const rstate = {
    enabled: true,
    available: false, // a usable client started
    degradedReason: null,
    client: null,
    seeded: new Map(), // appKeyHex -> { acceptances, root, at }
    custody: new Map(), // intentId -> { relayUrl, root, status, at }
    lastKeyRotation: (ctx.state && ctx.state.lastKeyRotation) || null,
    // Live-tracked set of currently connected relay pubkeys (hex). Updated
    // via the client's 'relay-connected' / 'relay-disconnected' events so
    // we don't have to poll getRelays() — and so callers can wait for the
    // first connection before depending on a relay-circuit (smoke test
    // showed 0 relays immediately after start(), 10 by t+5s).
    connectedRelays: new Set(),
    _firstConnectedWaiters: [] // [{resolve, reject, timer}]
  }

  // Lazy, fault-tolerant client construction in ADVANCED mode so we reuse the
  // one Hyperswarm and the one Corestore (§10/§22). If the optional dependency
  // is absent or throws, we degrade — local-first per §11.
  //
  // Test seam (never set in production): `ctx.relayClientFactory` may be a
  // function returning a client that implements the relay surface we use
  // (start/seed/publishCustodyIntent/getCustodyStatus/getRelays/destroy/on),
  // or the literal `false` to force the absent-dependency degrade path. This
  // lets the integration suite be hermetic without a live relay network. When
  // unset, behavior is identical to before: import the real client.
  const clientFactory = ctx.relayClientFactory
  let HiveRelayClient = null
  if (clientFactory === false) {
    rstate.degradedReason = 'client-disabled: relay client not available'
    log.warn('relay-degraded', { reason: rstate.degradedReason })
  } else if (typeof clientFactory === 'function') {
    HiveRelayClient = null // factory path; constructed in ensureClient()
  } else {
    try {
      ;({ HiveRelayClient } = await import('p2p-hiverelay-client'))
    } catch (err) {
      rstate.degradedReason = 'client-import-failed: ' + String((err && err.message) || err)
      log.warn('relay-degraded', { reason: rstate.degradedReason })
    }
  }

  async function ensureClient () {
    if (!rstate.enabled) return null
    if (rstate.client) return rstate.client
    if (clientFactory === false) return null
    if (typeof clientFactory !== 'function' && !HiveRelayClient) return null
    try {
      const client = typeof clientFactory === 'function'
        ? await clientFactory({ swarm: ctx.swarm, store: ctx.vaultStore.store })
        : new HiveRelayClient({
          swarm: ctx.swarm, // REUSE — never create a second Hyperswarm
          store: ctx.vaultStore.store, // REUSE — single Corestore root
          autoDiscover: true,
          maxRelays: 10,
          // Fleet config:
          //   foundationPubkeys[] — trusted-floor identity allowlist; DHT
          //     auto-discovery picks them up over RELAY_DISCOVERY_TOPIC.
          //   knownRelays{url:pk} — WSS DHT-bridge pinning (browser/mobile).
          //   bootstrap[]         — extra DHT bootstrap pubkeys.
          // Empty fields are safe — client falls back to pure autoDiscover.
          ...(fleet.foundationPubkeys.length ? { foundationPubkeys: fleet.foundationPubkeys } : {}),
          ...(Object.keys(fleet.knownRelays).length ? { knownRelays: fleet.knownRelays } : {}),
          ...(fleet.bootstrap.length ? { bootstrap: fleet.bootstrap } : {})
        })
      if (!client) return null
      // Surface useful client events through the redacted logger only.
      client.on('relay-connected', (e) => {
        const pub = e && (e.pubkey || (e.relay && e.relay.pubkey))
        if (pub) rstate.connectedRelays.add(String(pub))
        log.debug('relay-connected', { pubkey: pub, total: rstate.connectedRelays.size })
        ctx.emit('relay-connected-changed', { count: rstate.connectedRelays.size })
        // Resolve any waitForFirstConnected() promises now that we have one.
        if (rstate.connectedRelays.size > 0 && rstate._firstConnectedWaiters.length) {
          const waiters = rstate._firstConnectedWaiters.splice(0)
          for (const w of waiters) { try { clearTimeout(w.timer) } catch (_) {}; try { w.resolve(rstate.connectedRelays.size) } catch (_) {} }
        }
      })
      client.on('relay-disconnected', (e) => {
        const pub = e && (e.pubkey || (e.relay && e.relay.pubkey))
        if (pub) rstate.connectedRelays.delete(String(pub))
        log.debug('relay-disconnected', { pubkey: pub, total: rstate.connectedRelays.size })
        ctx.emit('relay-connected-changed', { count: rstate.connectedRelays.size })
      })
      client.on('seeded', (e) => log.info('relay-seeded', { appKey: e && (e.appKey || e.key) }))
      client.on('seed-cap-warning', (e) => log.warn('relay-seed-cap', { appKey: e && e.appKey }))
      await client.start()
      rstate.client = client
      rstate.available = true
      rstate.degradedReason = null
      // Drain the client on scope teardown BEFORE Corestore/swarm close.
      // destroy() only tears down resources the client owns; ours are safe
      // because we passed swarm+store in (advanced mode).
      ctx.scope.onClose(async () => {
        try { await client.destroy() } catch (_) {}
        rstate.client = null
        rstate.available = false
      })
      ctx.emit('relay-available')
      log.info('relay-available')
      return client
    } catch (err) {
      rstate.degradedReason = 'client-start-failed: ' + String((err && err.message) || err)
      rstate.available = false
      log.warn('relay-degraded', { reason: rstate.degradedReason })
      return null
    }
  }

  // ---- ctx.relay surface --------------------------------------------------

  // Seed the encrypted vault operation log blind / p2p-only (spec §11
  // relay.seed shape). `keyOrDriveKey` is the PUBLIC core/drive key of the
  // already-encrypted vault log — it is an identifier, not key material.
  async function seedVault (keyOrDriveKey, opts = {}) {
    if (!keyOrDriveKey) return { ok: false, reason: 'no-vault-key' }

    const keyHex = typeof keyOrDriveKey === 'string'
      ? keyOrDriveKey
      : b4a.toString(keyOrDriveKey, 'hex')

    // The seed request carries ONLY the public app key + durability knobs.
    // privacyTier:'p2p-only' is enforced by never publishing a catalog/name
    // and by passing no plaintext; we assert the request shape regardless.
    const seedOpts = {
      durability: opts.durability != null ? opts.durability : DEFAULTS.durability,
      replicas: opts.replicationFactor || DEFAULTS.replicationFactor,
      maxStorage: opts.maxStorageBytes || DEFAULTS.maxStorageBytes,
      revocable: opts.revocable !== false,
      timeout: opts.timeoutMs || DEFAULTS.seedTimeoutMs
    }
    // Epoch-bound relay discovery key (REVOCATION_DESIGN §5.11): after a
    // rotation the survivors re-seed under HMAC(topicSeed_{N+1},'log-disco-v1')
    // — an opaque rendezvous id derived from the new epoch key, which a
    // revoked device cannot compute. Identifier-only, never key material.
    if (opts.discoveryKey) seedOpts.discoveryKey = String(opts.discoveryKey)
    const auditPayload = {
      appKey: keyHex,
      privacyTier: DEFAULTS.privacyTier,
      ...seedOpts
    }
    // Assert + mirror BEFORE the client check: the blindness guard is the last
    // line of defense and must run unconditionally, and the verifier's relay-
    // export audit must see exactly what WOULD be sent even when the relay is
    // unreachable (degraded path still proves the payload was ciphertext-only).
    assertCiphertextOnly(auditPayload, 'seedVault')
    recordRelayExport(storagePath, 'seed', auditPayload)

    const client = await ensureClient()
    if (!client) return { ok: false, reason: rstate.degradedReason || 'relay-disabled', local: true }

    try {
      const acceptances = await client.seed(keyHex, seedOpts)
      const root = computeCiphertextRoot(ctx, keyHex)
      rstate.seeded.set(keyHex, {
        acceptances: Array.isArray(acceptances) ? acceptances.length : 0,
        root,
        at: Date.now()
      })
      ctx.emit('relay-seeded', { appKey: keyHex })
      log.info('relay-seed-done', { appKey: keyHex })
      return {
        ok: true,
        appKey: keyHex,
        acceptances: Array.isArray(acceptances) ? acceptances.length : 0,
        ciphertextRoot: root,
        privacyTier: DEFAULTS.privacyTier
      }
    } catch (err) {
      log.warn('relay-seed-failed', { appKey: keyHex, err: String((err && err.message) || err) })
      return { ok: false, reason: String((err && err.message) || err), local: true }
    }
  }

  // Atomic Blind Custody for a temporary clip / encrypted backup capsule
  // (spec §11 publishCustodyIntent shape). `ciphertextRoot` is a hash of
  // ciphertext only; `ttlMs` sets retainUntil.
  async function publishTemporaryCustody (ciphertextRoot, ttlMs, opts = {}) {
    if (!ciphertextRoot) return { ok: false, reason: 'no-ciphertext-root' }

    const relayUrl = opts.relayUrl || pickRelayUrl(rstate, opts)

    const now = Date.now()
    const intent = {
      blindContentId: opts.blindContentId || hashRoot(ciphertextRoot),
      ciphertextRoot: String(ciphertextRoot),
      requiredReplicas: opts.requiredReplicas || DEFAULTS.custodyReplicas,
      deadline: now + (opts.deadlineMs || 60_000),
      retainUntil: now + (ttlMs || 60_000),
      privacyTier: DEFAULTS.privacyTier,
      metadataVisibility: 'redacted'
    }
    // Assert + mirror BEFORE the client check (see seedVault rationale): the
    // blindness guard always runs and the verifier audits the exact intent
    // that WOULD be published even on the degraded / no-relay path.
    assertCiphertextOnly(intent, 'publishTemporaryCustody')
    recordRelayExport(storagePath, 'custody-intent', { relayUrl: relayUrl || null, intent })

    const client = await ensureClient()
    if (!client) return { ok: false, reason: rstate.degradedReason || 'relay-disabled', local: true }

    if (!relayUrl) {
      // No reachable custody relay → keep the clip local and retry/ask user
      // to keep a device online (spec §11 failure behavior).
      return { ok: false, reason: 'no-custody-relay', local: true }
    }

    try {
      const signed = await client.publishCustodyIntent(relayUrl, intent,
        opts.apiKey ? { apiKey: opts.apiKey } : {})
      const intentId = signed && (signed.intentId || signed.id)
      if (intentId) {
        rstate.custody.set(intentId, {
          relayUrl, root: intent.ciphertextRoot, status: 'intent', at: now
        })
      }
      ctx.emit('relay-custody-intent', { intentId })
      log.info('relay-custody-intent', { intentId })
      return { ok: true, intentId, ciphertextRoot: intent.ciphertextRoot, relayUrl }
    } catch (err) {
      log.warn('relay-custody-failed', { err: String((err && err.message) || err) })
      return { ok: false, reason: String((err && err.message) || err), local: true }
    }
  }

  // Poll custody quorum for an intent (read-only, no auth) — used by the
  // status panel and the verifier's receipt-binding check.
  async function getCustodyStatus (intentId) {
    const rec = rstate.custody.get(intentId)
    if (!rec) return null
    const client = await ensureClient()
    if (!client) return { intentId, ...rec, reachable: false }
    try {
      const status = await client.getCustodyStatus(rec.relayUrl, intentId)
      rec.status = status && status.state ? status.state : rec.status
      // Receipt binding: the relay's status must reference OUR ciphertext
      // root. If it ever reports a different root, surface a mismatch so the
      // verifier fails the custody line (never silently trust).
      const reportedRoot = status && (status.ciphertextRoot || status.receiptRoot)
      rec.receiptsMatchRoot = reportedRoot ? (String(reportedRoot) === String(rec.root)) : true
      return { intentId, ...rec, status }
    } catch (err) {
      return { intentId, ...rec, reachable: false, error: String((err && err.message) || err) }
    }
  }

  // ---- Network exposure (Phase 1 of network-privacy work) ---------------
  // Pure additive disclosure: enumerates the *currently active* network
  // exposure surface so the user can see at a glance who can observe their
  // device's IP + sync activity. No security improvement on its own — the
  // value is honesty (the website's "Not anonymous" disclaimer becomes
  // actionable when the user can see exactly what's leaking). Costs nothing
  // at rest; only computed on the NETWORK_STATUS RPC.
  function getNetworkExposure () {
    const out = {
      peerCount: 0,
      relayCount: 0,
      relays: [],
      peers: [],
      // Coarse classification — honest about what the OS/swarm exposes.
      // 'dht' = peer found us via Hyperswarm DHT (direct hole-punch);
      // 'relay-circuit' = a HiveRelay brokered the connection (your peer
      // doesn't see your IP, the relay does);
      // 'unknown' = couldn't classify from the swarm connection metadata.
      vias: { dht: 0, relayCircuit: 0, unknown: 0 }
    }
    if (!ctx.swarm || !ctx.swarm.connections) return out
    // Truncate identifiers to 8 chars — enough to disambiguate locally but
    // not enough to fingerprint cross-session. We're showing the user their
    // own session's view; these are already on-wire data, not secrets.
    const trim = (s) => s ? String(s).slice(0, 8) : null
    // Relay set (we ALREADY track these for the seed UX). The Set holds
    // hex pubkeys of relays our HiveRelayClient has connected to.
    for (const pub of rstate.connectedRelays) {
      out.relays.push({
        id: trim(pub),
        connected: true
      })
    }
    out.relayCount = out.relays.length

    // Walk the hyperswarm connection set. Each entry is a stream-like
    // object; the swarm decorates it with `.remotePublicKey`, and the swarm
    // emits a 'connection' event with an `info` object carrying topics
    // etc. We don't have the info object here anymore, so classification
    // is best-effort: if the connection's remoteAddress matches one of the
    // relay client's connected peers, mark it 'relay-circuit'; otherwise
    // 'dht'. Falls back to 'unknown' if neither check is reachable.
    const relayConn = new Set()
    if (rstate.client && typeof rstate.client.getRelays === 'function') {
      try {
        const rs = rstate.client.getRelays() || []
        for (const r of rs) {
          const pk = r && (r.pubkey || (r.peer && r.peer.pubkey))
          if (pk) relayConn.add(String(pk))
        }
      } catch (_) { /* not fatal — we just get coarser classification */ }
    }
    for (const conn of ctx.swarm.connections) {
      const remotePub = conn.remotePublicKey
        ? (typeof conn.remotePublicKey === 'string' ? conn.remotePublicKey : conn.remotePublicKey.toString('hex'))
        : null
      let via = 'unknown'
      if (remotePub && relayConn.has(remotePub)) {
        via = 'relay-circuit'
        out.vias.relayCircuit++
      } else if (remotePub) {
        via = 'dht'
        out.vias.dht++
      } else {
        out.vias.unknown++
      }
      // A connection to a relay is NOT a "peer" for IP-exposure purposes —
      // we already counted relays above. Only enumerate peers that are NOT
      // themselves the relay set.
      if (via !== 'relay-circuit') {
        out.peers.push({ id: trim(remotePub), via })
      }
    }
    out.peerCount = out.peers.length
    return out
  }
  // Expose on ctx.relay so the dispatcher (registered below) can call it.
  // Also surface a one-line plain-text summary so the renderer doesn't have
  // to know the data shape to render a headline.
  // (Implementation note: rstate is closed over by reference.)

  // Aggregate status for the RELAY_STATUS RPC + "always online" UX (§11).
  async function getRelayStatus () {
    const client = rstate.client
    let directPeers = 0
    let relaysHoldingCiphertext = 0
    let custodyQuorum = '0/0'
    let ciphertextRoot = null
    let custodyReceiptsMatchRoot = true

    try {
      // Direct peers = swarm connections that are NOT relay channels. We can
      // only see the total here; relay channels are a subset.
      directPeers = ctx.swarm && ctx.swarm.connections ? ctx.swarm.connections.size : 0
    } catch (_) {}

    if (client) {
      try {
        const relays = client.getRelays() || []
        // Count relays that accepted at least one of our seed requests.
        let holding = 0
        for (const [, s] of rstate.seeded) holding = Math.max(holding, s.acceptances || 0)
        relaysHoldingCiphertext = holding
        directPeers = Math.max(0, directPeers - relays.length)
        const firstSeed = [...rstate.seeded.values()][0]
        if (firstSeed) ciphertextRoot = firstSeed.root
      } catch (_) {}

      // Custody quorum across tracked intents (best-effort).
      try {
        let need = 0
        let have = 0
        for (const [id] of rstate.custody) {
          const st = await getCustodyStatus(id)
          if (st && st.status && typeof st.status === 'object') {
            need += Number(st.status.requiredReplicas || DEFAULTS.custodyReplicas)
            have += Number(st.status.replicas || st.status.quorum || 0)
            if (st.receiptsMatchRoot === false) custodyReceiptsMatchRoot = false
          }
        }
        if (need > 0) custodyQuorum = have + '/' + need
      } catch (_) {}
    }

    const lastVerifierRun = (ctx.state && ctx.state.lastVerifierRun) || null

    return {
      enabled: rstate.enabled,
      available: rstate.available,
      degradedReason: rstate.degradedReason,
      directPeers,
      relaysHoldingCiphertext,
      custodyQuorum,
      ciphertextRoot,
      custodyReceiptsMatchRoot,
      lastVerifierRun: lastVerifierRun
        ? (lastVerifierRun.passed ? 'passed' : 'failed')
        : 'never',
      lastVerifierRunAt: lastVerifierRun ? lastVerifierRun.at : null,
      lastKeyRotation: (ctx.state && ctx.state.lastKeyRotation) || rstate.lastKeyRotation || null
    }
  }

  // Reserve circuit-relay slots on each currently-connected HiveRelay so this
  // peer is DIALABLE-VIA-RELAY by other peers. Without this, the inviter sits
  // on its DHT-announced topic and the joiner's circuitConnect() always fails
  // because no relay has a reservation matching the inviter's swarm pubkey
  // (HiveRelay protocol §circuit: reserveMsg before connectMsg can succeed).
  // Called by PAIR_CREATE_INVITE so the joiner's fallback circuit-dial works.
  // Returns the hex pubkeys of relays that accepted the reservation — those
  // are the only ones worth including in relayHints (broadcast in the invite).
  // Never throws; relay reservation failure degrades to DHT-only pairing.
  //
  // Reserve on a SMALL fixed number of relays. The QR encodes every reserved
  // relay's hex pubkey (64 chars each) and the QR scanner has a practical
  // capacity limit (~v17-19 byte-mode for reliable scan with cheap cameras);
  // beyond ~500 chars the QR becomes too dense for the joiner to decode. With
  // 3 reservations + the rest of the invite we stay comfortably inside that.
  //
  // One shared relay is enough to broker pair, but if the joiner's connected
  // set doesn't overlap with the reserved set, we still try ALL of the
  // joiner's circuit-capable relays in circuitConnect() (see below) — so
  // higher reservation counts don't help much and only inflate the QR.
  async function reservePairingSlots ({ max = 3, timeoutMs = 6000 } = {}) {
    const client = await ensureClient()
    if (!client) return []
    const list = (client.getRelays && client.getRelays()) || []
    const targets = list.filter(r => r.hasCircuitProtocol).slice(0, max)
    if (!targets.length) return []
    const results = await Promise.all(targets.map(async (r) => {
      try {
        const ok = await Promise.race([
          client.reserveRelay(r.pubkey),
          new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs))
        ])
        return ok ? r.pubkey : null
      } catch (_) { return null }
    }))
    const reserved = results.filter(Boolean)
    log.info('pair-reserved-circuit-slots', { reserved: reserved.length, attempted: targets.length })
    return reserved
  }

  // Pairing rendezvous fallback (spec §14 + §11). Asks a connected HiveRelay
  // to broker a circuit-relay connection to a target peer's swarm pubkey when
  // DHT/UDX can't hole-punch (CGNAT, UDP-blocked Wi-Fi). The circuit-relayed
  // connection appears on ctx.swarm like any other peer, so the pairing
  // responder loop in autobase-sync.js handles it unmodified.
  //
  // Returns { ok, relay?, reason? }. Never throws — local-first per §11.
  async function circuitConnect (targetSwarmPubkeyHex, opts = {}) {
    if (!targetSwarmPubkeyHex) return { ok: false, reason: 'no-target' }
    const client = await ensureClient()
    if (!client) return { ok: false, reason: rstate.degradedReason || 'relay-disabled' }
    const connected = (client.getRelays && client.getRelays()) || []
    if (!connected.length) return { ok: false, reason: 'no-relay-connected' }
    // Build candidate list: hinted relays we share with the inviter FIRST
    // (most likely to succeed — the inviter is reserved there), then ALL
    // other circuit-capable connected relays as fallback. Previously we
    // only tried the intersection OR only tried non-intersection — never
    // both — which meant a single shared relay failure would skip the rest.
    // One shared relay is enough to broker; trying every candidate maximises
    // success chance even when fleet membership churns.
    const circuitCapable = connected.filter(r => r.hasCircuitProtocol).map(r => r.pubkey)
    const hintsSet = new Set(Array.isArray(opts.relayHints) ? opts.relayHints : [])
    const sharedHints = circuitCapable.filter(p => hintsSet.has(p))
    const rest = circuitCapable.filter(p => !hintsSet.has(p))
    const candidates = [...sharedHints, ...rest]
    log.info('pair-circuit-try', {
      total: candidates.length, shared: sharedHints.length, fallback: rest.length
    })
    for (const relayPub of candidates) {
      try {
        const ok = await client.connectViaRelay(targetSwarmPubkeyHex, relayPub)
        if (ok) {
          log.info('pair-circuit-ok', { relay: relayPub.slice(0, 16) })
          return { ok: true, relay: relayPub }
        } else {
          log.info('pair-circuit-deny', { relay: relayPub.slice(0, 16) })
        }
      } catch (err) {
        log.info('pair-circuit-error', { relay: relayPub.slice(0, 16), err: String((err && err.message) || err) })
      }
    }
    return { ok: false, reason: 'all-circuits-failed' }
  }

  // Hex pubkeys of currently-connected relays — embed in PAIR_CREATE_INVITE so
  // the joining device can prefer relays the inviter is also on. Capped to
  // keep the invite payload (and the QR) small.
  function relayPeerHints (max = 3) {
    const client = rstate.client
    if (!client || !client.getRelays) return []
    return (client.getRelays() || []).slice(0, max).map(r => r.pubkey)
  }

  // Resolves with the current connected-relay count as soon as at least one
  // relay is connected. Resolves immediately if a relay is already connected,
  // otherwise waits for the next 'relay-connected' event (or the timeout —
  // smoke test on a healthy fleet showed t+5s for the first connection).
  // Never rejects; on timeout resolves with whatever count we have (often 0).
  // PAIR_* handlers call this so the swarm.join() that follows can route via
  // relay-circuit instead of relying on DHT/UDX alone.
  async function waitForFirstConnected ({ timeoutMs = 8000 } = {}) {
    // Kick the client into life if a relay operation hasn't already (e.g. for
    // PAIR_ACCEPT on a fresh device — vault is still locked so the auto-seed
    // hasn't fired and ensureClient() has never been called).
    let client = null
    try { client = await ensureClient() } catch (_) {}
    if (!client) return rstate.connectedRelays.size
    if (rstate.connectedRelays.size > 0) return rstate.connectedRelays.size
    return await new Promise((resolve) => {
      const waiter = { resolve, reject: resolve, timer: null }
      waiter.timer = setTimeout(() => {
        const i = rstate._firstConnectedWaiters.indexOf(waiter)
        if (i >= 0) rstate._firstConnectedWaiters.splice(i, 1)
        resolve(rstate.connectedRelays.size)
      }, timeoutMs)
      if (waiter.timer && waiter.timer.unref) waiter.timer.unref()
      rstate._firstConnectedWaiters.push(waiter)
    })
  }

  function getConnectedCount () { return rstate.connectedRelays.size }

  // Replication-firewall allowance predicate: is this swarm remotePublicKey
  // one of OUR relays? Relays never run the device handshake — they replicate
  // ciphertext only, which is the honestly-documented L2 channel (a relay
  // serves opaque bytes; decryption stays blocked by content-key rotation).
  function isRelayPeer (remotePubHex) {
    if (!remotePubHex) return false
    const hex = String(remotePubHex)
    if (rstate.connectedRelays.has(hex)) return true
    if (rstate.client && typeof rstate.client.getRelays === 'function') {
      try {
        for (const r of rstate.client.getRelays() || []) {
          const pk = r && (r.pubkey || (r.peer && r.peer.pubkey))
          if (pk && String(pk) === hex) return true
        }
      } catch (_) { /* coarser answer only */ }
    }
    return false
  }

  ctx.relay = {
    seedVault,
    isRelayPeer,
    publishTemporaryCustody,
    getCustodyStatus,
    getRelayStatus,
    getNetworkExposure,
    circuitConnect,
    relayPeerHints,
    waitForFirstConnected,
    reservePairingSlots,
    getConnectedCount,
    // expose for tests / scripts (no secrets)
    assertCiphertextOnly,
    _state: rstate
  }

  // Eagerly warm the HiveRelay client at boot so the UI's "Connecting to
  // relays…" hint can become "Relays: N connected" before the user actually
  // taps Pair. Pre-this, ensureClient() was lazy and only fired on the first
  // relay op (seedVault on unlock, or waitForFirstConnected on PAIR_*), which
  // meant the pre-pair screen sat at relayCount=0 for the whole 5–8 s warm-up.
  // Failures here are silent: ensureClient() already swallows + records a
  // degradedReason, and pair handlers still call waitForFirstConnected() so
  // they don't depend on this warm-up succeeding.
  if (rstate.enabled) {
    ctx.scope.spawn(async () => {
      try { await ensureClient() } catch (_) {}
    })
  }

  // ---- RPC handlers -------------------------------------------------------

  ctx.dispatcher.register(COMMANDS.RELAY_STATUS, async () => {
    // RELAY_STATUS is allowed while locked (rpc.js UNLOCKED_NOT_REQUIRED) and
    // must work even when relays are down — never throws, always a status.
    try {
      return await getRelayStatus()
    } catch (err) {
      return {
        enabled: rstate.enabled,
        available: false,
        degradedReason: 'status-error: ' + String((err && err.message) || err),
        directPeers: 0,
        relaysHoldingCiphertext: 0,
        custodyQuorum: '0/0',
        lastVerifierRun: 'never',
        lastKeyRotation: null
      }
    }
  })

  // NETWORK_STATUS — Phase 1 of the network-privacy work. Pure disclosure:
  // returns the live set of direct peers + relays that currently see this
  // device's IP, plus the connection-path classification (DHT direct vs
  // relay-circuit). Allowed while locked because nothing sensitive is in
  // the payload (truncated pubkey hashes only; no notes or keys). Never
  // throws — degrades to empty counts if the swarm/relay client is gone.
  ctx.dispatcher.register(COMMANDS.NETWORK_STATUS, async () => {
    try {
      return getNetworkExposure()
    } catch (err) {
      return {
        peerCount: 0,
        relayCount: 0,
        relays: [],
        peers: [],
        vias: { dht: 0, relayCircuit: 0, unknown: 0 },
        error: String((err && err.message) || err)
      }
    }
  })

  ctx.dispatcher.register(COMMANDS.RELAY_SET_ENABLED, async ({ enabled }) => {
    rstate.enabled = !!enabled
    if (!enabled && rstate.client) {
      try { await rstate.client.destroy() } catch (_) {}
      rstate.client = null
      rstate.available = false
      log.info('relay-disabled-by-user')
    } else if (enabled) {
      // Re-arm lazily; ensureClient() will start on next use.
      log.info('relay-enabled-by-user')
    }
    ctx.emit('relay-enabled-changed', { enabled: rstate.enabled })
    return { ok: true, enabled: rstate.enabled }
  })

  // ---- Auto-seed the encrypted vault log when the vault is unlocked -------
  // The sync subsystem owns the vault log core; if it publishes the public
  // key on ctx.state we seed it. This loop is cancellable via ctx.scope and
  // never blocks local use (§10/§11).
  ctx.on('unlocked', () => {
    if (!rstate.enabled) return
    ctx.scope.spawn(async (scope) => {
      try {
        // Give the sync subsystem a moment to create/announce the log key.
        await scope.sleep(1000)
        const vaultLogKey =
          (ctx.state && (ctx.state.vaultLogKey || ctx.state.autobaseKey)) || null
        if (vaultLogKey) {
          await seedVault(vaultLogKey, {})
        } else {
          log.debug('relay-autoseed-skip', { reason: 'no-vault-log-key-published' })
        }
      } catch (err) {
        if (scope.cancelled) return
        log.warn('relay-autoseed-error', { err: String((err && err.message) || err) })
      }
    }, 'relay-autoseed')
  })

  // Cross-agent wiring: the sync subsystem announces the encrypted vault-log
  // key via the 'sync-open' event ({ autobaseKey }), not on ctx.state. Capture
  // it here so the auto-seed actually fires once the log key is known (the
  // 'unlocked' loop above only reads ctx.state and would otherwise always skip
  // with 'no-vault-log-key-published'). No-op/safe when no relays are
  // reachable — seedVault degrades and never blocks local use (§11).
  ctx.on('sync-open', (e) => {
    const key = e && e.autobaseKey
    if (!key) return
    if (ctx.state) ctx.state.autobaseKey = key
    if (!rstate.enabled || rstate.seeded.has(key)) return
    ctx.scope.spawn(async (scope) => {
      try {
        await seedVault(key, {})
      } catch (err) {
        if (!scope.cancelled) log.warn('relay-autoseed-error', { err: String((err && err.message) || err) })
      }
    }, 'relay-autoseed-syncopen')
  })

  ctx.on('key-rotated', (e) => {
    rstate.lastKeyRotation = (e && e.at) || new Date().toISOString()
    if (ctx.state) ctx.state.lastKeyRotation = rstate.lastKeyRotation
  })

  // ---- Epoch-bound relay re-seed on rotation (design §5.11, RT-FIX B2) -----
  // [GATE SB2 — read before "improving" this] `unseed`/`revocable` is COSMETIC
  // against an already-connected peer: Hypercore replication streams persist
  // through swarm.leave, and p2p-hiverelay-client.unseed() only BROADCASTS a
  // message — it never closes a stream. The per-connection replication
  // firewall (replication-firewall.js) is the SOLE real control; this re-seed
  // only moves the relay-side rendezvous onto a discovery key derived from the
  // NEW epoch key (which the revoked device cannot compute), so relays that
  // honor unseed stop announcing the old one. HONEST RESIDUAL (L2): a
  // third-party / non-honoring relay keeps serving the OPAQUE post-revoke
  // ciphertext indefinitely — decryption stays blocked by content-key
  // rotation. Best-effort: degraded/unreachable relays never block the
  // rotation itself.
  ctx.on('epoch-rotated', (e) => {
    if (!rstate.enabled) return
    const epochTag = e && e.epochTag
    if (!epochTag) return
    ctx.scope.spawn(async (scope) => {
      try {
        const appKey = (ctx.state && (ctx.state.autobaseKey || ctx.state.vaultLogKey)) || null
        const engine = ctx.sync
        const epochKey = engine && engine.epochKeys ? engine.epochKeys.get(epochTag) : null
        if (!appKey || !epochKey) return // not seeded yet / key not unwrapped — nothing to move
        const topicSeed = ctx.crypto.topicSeedFromEpochKey(epochKey)
        const discoveryKey = b4a.toString(ctx.crypto.hmac(topicSeed, 'log-disco-v1'), 'hex')
        // Unseed the pre-rotation entry FIRST (broadcast-only, see SB2 above),
        // then re-seed under the epoch-bound discovery key.
        try {
          const client = await ensureClient()
          if (client && typeof client.unseed === 'function') await client.unseed(appKey)
        } catch (_) { /* best-effort — see SB2: cosmetic against connected peers */ }
        const res = await seedVault(appKey, { discoveryKey })
        log.info('relay-epoch-reseed', { epoch: (e && e.epoch) || null, ok: !!(res && res.ok) })
      } catch (err) {
        if (scope && scope.cancelled) return
        log.warn('relay-epoch-reseed-failed', { err: String((err && err.message) || err) })
      }
    }, 'relay-epoch-reseed')
  })

  log.info('relay-service-attached', { degraded: !!rstate.degradedReason })
}

// ---- helpers ---------------------------------------------------------------

function pickRelayUrl (rstate, opts) {
  if (opts && opts.relayUrl) return opts.relayUrl
  if (Array.isArray(opts && opts.relayHints) && opts.relayHints.length) return opts.relayHints[0]
  return null
}

// A short, content-free hash of the ciphertext root for blindContentId. We do
// not import crypto-envelope's hmac here (no indexKey at this layer); a plain
// structural digest of an already-ciphertext root is sufficient and leaks
// nothing (the input is itself opaque ciphertext-derived).
function hashRoot (root) {
  let h = 5381
  const s = String(root)
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return 'blind-' + h.toString(16)
}

// Best-effort ciphertext root for a seeded core: the public key itself is a
// commitment to the (encrypted) log content under Hypercore's Merkle tree, so
// we report it as the ciphertext root for the proof screen. If the sync
// subsystem later exposes a richer signed root we prefer that.
function computeCiphertextRoot (ctx, keyHex) {
  try {
    if (ctx.state && ctx.state.vaultLogRoot) return String(ctx.state.vaultLogRoot)
  } catch (_) {}
  return keyHex
}

export default { attach, assertCiphertextOnly, RelayBlindnessError }
