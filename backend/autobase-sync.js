// Paste Autobase multi-writer operation log + deterministic reducer.
//
// One writer core per authorized device (spec §9.2). Every replicated op has a
// PUBLIC header (assertHeaderPublicOnly before append) and an ENCRYPTED body
// (crypto.seal). The reducer:
//   1. validates the op signature (verifyOp) against the signer pubkey,
//   2. rejects appends from a device after its revocation epoch,
//   3. decrypts the op body in memory,
//   4. applies LWW-per-field with Lamport tie-break (spec §9.5),
//   5. writes ENCRYPTED current-state records into the Hyperbee view.
//
// Device lifecycle ops (DEVICE_ADD / DEVICE_REVOKE / KEY_ROTATE) are signed by
// the root identity or an already-authorized admin device and gate Autobase
// writer membership via host.addWriter / host.removeWriter.
//
// Replication uses the ONE Hyperswarm + ONE Corestore from ctx (index.js wired
// swarm 'connection' -> vaultStore.store.replicate). We only join the vault
// topic (ctx.joinVault already does) and let Autobase ride the corestore.
//
// Spec refs: §7.5, §8, §9.2, §9.5, §10, §14, §21 (Agent 1), §22.

import Autobase from 'autobase'
import b4a from 'b4a'
import { NAMESPACES } from './vault-store.js'
import { MaterializedView, LocalSearchIndex, beeFromCore } from './materialized-view.js'

const VIEW_NAME = 'pearpaste-view-v1'

// The autobase instance + reducer state for an unlocked vault. Rebuilt on every
// unlock, torn down on lock so no decrypted material survives.
class SyncEngine {
  constructor (ctx) {
    this.ctx = ctx
    this.base = null
    this.view = null // MaterializedView
    this.localSearch = null // LocalSearchIndex
    this._searchBee = null
    this._opened = false
    // Authorized device set rebuilt deterministically by the reducer.
    //   deviceId -> { signingPubkey, writerKey(hex), roles, revokedAtLamport|null,
    //                 addedAtLamport, isRoot }
    this.devices = new Map()
    // writerKeyHex -> deviceId, for fast signer attribution.
    this.writerToDevice = new Map()
    this.rootPubkey = null
    this.keyEpoch = 0 // bumped by KEY_ROTATE; ops below current epoch from a
    // revoked signer are rejected (spec §8.4 "replayed old op rejected").
    // ---- epoch content-key machinery (design §5.2, RT-FIX B5) -------------
    // epochKeys maps epochTag -> 32-byte content key. The reserved entry
    // "" -> vaultKey is the EPOCH-0 LAZY-MIGRATION ANCHOR (design §6): every
    // existing vault is epoch 0 / epochTag "" / epochKey == vaultKey, so
    // sealing+opening under it is byte-identical to the pre-epoch code. Higher
    // epochTags hold fresh-random keys unwrapped from this device's committed
    // `epochkeys!` lockboxes (added in Phase 2). activeEpoch is the monotone
    // integer (ordering hint); activeEpochTag is the content-addressing winner
    // new writes seal under. Phase 1 ships ONLY epoch 0: there is no rotation,
    // so these stay 0 / "" for every vault and new content seals under vaultKey.
    // ALL THREE are a PURE FUNCTION of the committed view — rebuilt in
    // _rebuildAuthFromView each apply pass (reorg-safe), exactly like the device
    // cache — never held only in volatile memory.
    this.epochKeys = new Map()
    this.activeEpoch = 0
    this.activeEpochTag = ''
    // Per-vault admit policy (design §3.8 step 2, B1): how many DISTINCT
    // non-revoked admin signatures a DEVICE_ADD needs. Rebuilt from committed
    // vault-state each apply pass; 1 = legacy single-approver behavior.
    this.admitPolicyN = 1
    this._appliedOps = new Map() // opId -> op snapshot for verifier coverage.
    // Per-engine append SERIALIZATION chain (CONCURRENT APPEND DROP fix).
    // Autobase's append layer keeps shared mutable bookkeeping (this._appending
    // / this._appended / this._optimistic and the bump-until-target loop in
    // node_modules/autobase/index.js _appendBatch); two base.append() calls
    // started in the same tick (e.g. Promise.all([appendOp(a), appendOp(b)]))
    // interleave on that shared state and one write is silently dropped — proven
    // on a live two-writer base where ACKs (which themselves call base.append())
    // race user appends. The contract Autobase assumes is one append fully
    // settled before the next, so we funnel EVERY base.append() through a single
    // promise chain: each enqueued append runs only after the previous settles.
    this._appendChain = Promise.resolve()
    // Wall-clock of the last fresh-writer integration (host.addWriter). Gates
    // the durability-reconciliation window (FRESH-WRITER ORPHAN fix).
    this._lastWriterAddedAt = 0
    // Pending durability set (FRESH-WRITER ORPHAN / SILENT NOTE-LOSS fix). Maps
    // objectBlindId -> { type, schema, objectId, payload, tries } for every
    // additive content op THIS device appended whose row must stay materialized
    // in the committed view. Adding a paired device as an indexer makes Autobase
    // migrate/reboot the apply state (re-checkout the view at indexedLength),
    // which ASYNCHRONOUSLY — possibly seconds after appendOp returned — rolls a
    // not-yet-indexed content row out of the view (proven over a real testnet:
    // the op is in the log + re-applied, but its view row vanishes on ALL
    // devices). A point-in-time confirm at append time can't catch a rollback
    // that lands later, so the background convergence loop reconciles this set:
    // any pending op whose row is missing is re-appended (idempotent upsert with
    // a fresh Lamport) until it sticks. Non-indexer paired writers (which would
    // avoid the migration) crash this Autobase version, so this app-layer
    // reconciliation is the correct closure. Cleared on lock/close.
    this._pendingDurable = new Map()
  }

  get vaultKey () { return this.ctx.state.vaultKeys && this.ctx.state.vaultKeys.vaultKey }
  get indexKey () { return this.ctx.state.vaultKeys && this.ctx.state.vaultKeys.indexKey }
  // This device's identity material, used to unwrap its own committed
  // `epochkeys!` lockboxes during the reorg-safe rebuild (Phase 2 writes the
  // wraps; Phase 1 only reads — for epoch 0 there are none, so these are unused
  // until a real rotation). boxSecretKey is local-only secret material that
  // lives in state.device, never replicated.
  get myDeviceId () { return this.ctx.state.device && this.ctx.state.device.deviceId }
  get myBoxPubkey () { return this.ctx.state.device && this.ctx.state.device.boxPubkey }
  get myBoxSecretKey () { return this.ctx.state.device && this.ctx.state.device.boxSecretKey }

  // --- open / close --------------------------------------------------------
  async open () {
    if (this._opened) return
    this._closing = false
    this._appendChain = Promise.resolve() // fresh chain per open (lock->unlock)
    this._pendingDurable.clear()
    const { ctx } = this
    const crypto = ctx.crypto
    const ops = ctx.ops

    const store = ctx.vaultStore.namespace(NAMESPACES.AUTOBASE)

    const self = this
    const open = (s) => beeFromCore(s.get(VIEW_NAME))
    const apply = async (nodes, view, host) => {
      await self._apply(nodes, view, host)
    }

    this.base = new Autobase(store, this._bootstrapKey(), {
      open,
      apply,
      valueEncoding: 'json',
      ackInterval: 1000
    })
    await this.base.ready()

    // Persist the autobase key so paired devices bootstrap onto the same base.
    if (!this._bootstrapKey()) {
      await ctx.vaultStore.putVaultHeader({
        ...(await ctx.vaultStore.getVaultHeader()),
        autobaseKey: b4a.toString(this.base.key, 'hex')
      })
    }

    // local-only (un-topic'd) search index
    const searchStore = ctx.vaultStore.namespace(NAMESPACES.SEARCH)
    const searchCore = searchStore.get({ name: 'local-search-v1' })
    await searchCore.ready()
    this._searchBee = beeFromCore(searchCore)
    await this._searchBee.ready()

    const viewArgs = {
      crypto,
      ops,
      vaultId: ctx.state.vaultId,
      indexKey: this.indexKey,
      getVaultKey: () => this.vaultKey
    }
    this.view = new MaterializedView({ bee: this.base.view, ...viewArgs })
    this.localSearch = new LocalSearchIndex({ bee: this._searchBee, ...viewArgs })

    // Bootstrap: if this device is the first writer and not yet in the device
    // set, append a self-signed DEVICE_ADD (root authorizes its own first
    // device — spec §14 first device steps 3-5).
    await this.base.update()
    if (this.base.writable && this.devices.size === 0 && ctx.state.device) {
      await this._appendDeviceAdd(ctx.state.device, { selfRoot: true })
      await this.base.update()
    }

    this._opened = true
    ctx.emit('sync-open', { autobaseKey: b4a.toString(this.base.key, 'hex') })
  }

  _bootstrapKey () {
    const h = this.ctx.state._vaultHeaderCache
    const k = h && h.autobaseKey
    return k ? b4a.from(k, 'hex') : null
  }

  async close () {
    if (!this._opened) return
    this._opened = false
    // Signal queued appends + the durability-confirm loop to abort promptly so
    // a closing engine never blocks shutdown waiting on the append chain.
    this._closing = true
    try { if (this.base) await this.base.close() } catch (_) {}
    try { if (this._searchBee) await this._searchBee.close() } catch (_) {}
    this.base = null
    this.view = null
    this.localSearch = null
    this._searchBee = null
    this.devices.clear()
    this.writerToDevice.clear()
    this._appliedOps.clear()
    this._pendingDurable.clear()
    // Drop epoch content-key state so no buffer reference survives teardown.
    // index.js wipes state.vaultKeys.vaultKey IN PLACE on lock; the epoch-0
    // anchor (epochKeys.set("", vaultKey)) aliases that very buffer, so a stale
    // entry kept across lock would point at zeroed bytes and fail AEAD on the
    // next unlock. Cleared here; _rebuildAuthFromView re-establishes the
    // "" -> vaultKey anchor from the fresh state.vaultKeys on reopen.
    this.epochKeys.clear()
    this.activeEpoch = 0
    this.activeEpochTag = ''
    this.admitPolicyN = 1
  }

  // --- op construction -----------------------------------------------------
  // Build a signed ReplicatedOp (spec §7.5). Header is PUBLIC-only; body is a
  // CryptoEnvelope. Signature = Ed25519(canonical(header||ct||nonce||aadHash)).
  _makeOp ({ type, schema, objectId, payload, signer, epochTag: forcedEpochTag = null, epoch: forcedEpoch = null }) {
    const ctx = this.ctx
    const crypto = ctx.crypto
    const ops = ctx.ops
    const objectBlindId = crypto.blindId(this.indexKey, objectId)
    const lamport = ctx.state.lamport.tick()
    // Active epoch stamping (design §5.4). Phase 1: activeEpoch is 0 and
    // activeEpochTag is "" for every vault, so `epoch:"0"`/`epochTag:""` and the
    // seal below resolve to vaultKey + the legacy keyId/AAD bytes — byte-identical
    // to the pre-epoch op. (Re-append by _reconcileDurability also flows through
    // here; for Phase 1 the active tag == the only tag "", so re-seal is faithful.
    // Phase 5 will thread the pending entry's ORIGINAL epochTag for cross-epoch
    // re-append per §3.9.)
    // DEVICE LIFECYCLE ops seal under EPOCH 0 (vaultKey, tag ""), NOT the
    // active epoch (Phase 4, enables design §5.8 selective-chain): membership
    // and admit-policy state is the AUTHORITY every member's reducer and the
    // replication firewall consult, so it must be applyable by EVERY member —
    // including a selectively-chained joiner that was deliberately NOT given
    // the intermediate epoch keys (a revoke minted under a withheld epoch
    // would otherwise be invisible to it, leaving the revoked device alive in
    // its auth view). Bodies carry roster metadata (deviceIds/pubkeys/labels),
    // never user content; KEY_ROTATE is NOT in this set — its body stays
    // sealed under the NEW epoch key (B3/B10, the roster-blind requirement).
    const opsK = ctx.ops.OP_TYPES
    const lifecycle = type === opsK.DEVICE_ADD || type === opsK.DEVICE_REVOKE || type === opsK.ADMIT_POLICY_SET
    // EPOCH-FAITHFUL override (design §3.9, RT-FIX B4 — Phase 5): the
    // durability reconciler re-appends a rolled-back row under the row's
    // ORIGINAL epochTag, never the active one — re-sealing pre-rotation
    // content under the new key would pull it forward into the new epoch
    // (survivors gain nothing: they hold every key) and, combined with any
    // keyId linkage, manufacture a known-plaintext correlate for a revoked
    // device still replicating via the L2 channel. Lifecycle ops remain
    // pinned to epoch 0 regardless (Phase 4 — membership must be universally
    // applyable). A forced tag whose key this device does not hold is a hard
    // error, not a silent fallback to the wrong key.
    const epochTag = lifecycle ? '' : (forcedEpochTag != null ? String(forcedEpochTag) : (this.activeEpochTag || ''))
    if (!lifecycle && forcedEpochTag != null && forcedEpochTag !== '' && !this.epochKeys.has(epochTag)) {
      const e = new Error('cannot seal under epoch ' + epochTag + ': key not held')
      e.code = 'NO_EPOCH_KEY'
      throw e
    }
    const epochKey = this.epochKeys.get(epochTag) || this.vaultKey
    const header = {
      version: 1,
      opId: b4a.toString(crypto.randomBytes(16), 'hex'),
      vaultId: String(ctx.state.vaultId),
      deviceId: String(signer.deviceId),
      type,
      objectBlindId,
      lamport: String(lamport),
      createdAtBucket: ops.timeBucket(),
      // The integer mirrors the tag: lifecycle ops are epoch-0 by construction
      // (see above), a forced (re-append) tag carries its original integer,
      // and everything else stamps the active epoch (strict binding, §5.5).
      epoch: lifecycle
        ? '0'
        : (forcedEpochTag != null ? String(Number(forcedEpoch) || 0) : String(this.activeEpoch || 0)),
      epochTag
    }
    ops.assertHeaderPublicOnly(header) // §22: classify every replicated field

    const envelope = crypto.seal({
      epochKey,
      epochTag,
      objectId: this._opBodyObjectId(objectBlindId),
      objectBlindId,
      opType: type,
      schema,
      vaultId: ctx.state.vaultId,
      plaintext: payload
    })
    const aadHash = crypto.aadHashOf(envelope.aad)
    const signature = crypto.signOp(signer.signingSecretKey, {
      header,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      aadHash
    })
    return {
      header,
      envelope,
      aadHash,
      signerPubkey: signer.signingPubkey,
      signature
    }
  }

  _opBodyObjectId (objectBlindId) {
    return 'opbody:' + String(objectBlindId || '')
  }

  // The surviving entitled set for a rotation that revokes `revokedDeviceId`
  // (design §3.1 step 3): every committed device that is NOT revoked and is NOT
  // the target, read STRAIGHT from the reorg-safe auth cache (which Phase 1
  // taught to carry boxPubkey, §5.1). The local device is included implicitly
  // (it is in the committed device set). Returns [{ deviceId, boxPubkey }].
  _survivingDevices (revokedDeviceId) {
    const out = []
    for (const d of this.devices.values()) {
      if (d.deviceId === revokedDeviceId) continue
      if (d.revokedAtLamport != null) continue
      if (!d.boxPubkey) continue
      out.push({ deviceId: d.deviceId, boxPubkey: d.boxPubkey })
    }
    return out
  }

  // Replication-firewall predicate (design §3.7.2 / GATE SB2): is `deviceId` a
  // COMMITTED, NON-REVOKED device whose committed signing pubkey matches the
  // one the peer authenticated with? Read from the reorg-safe auth cache — the
  // same committed authority the reducer uses for write exclusion, so a reorg
  // can never leave the firewall trusting a rolled-back device set.
  // Returns 'allowed' | 'revoked' | 'unknown'.
  isDeviceAllowed (deviceId, signingPubkey) {
    const d = this.devices.get(deviceId)
    if (!d) return 'unknown'
    if (signingPubkey && d.signingPubkey !== signingPubkey) return 'unknown'
    return d.revokedAtLamport == null ? 'allowed' : 'revoked'
  }

  // ---- admit policy (design §3.8 step 2, RT-FIX B1) ------------------------
  _nonRevokedAdminCount () {
    let n = 0
    for (const d of this.devices.values()) {
      if (d.revokedAtLamport == null && (d.roles || []).includes('admin')) n++
    }
    return n
  }

  // Effective N clamps the committed policy to the live admin count so a
  // revocation can never deadlock admission (2 admins at N=2, one revoked →
  // the survivor admits alone). Residual, stated honestly: a root willing to
  // LOUDLY revoke the other admins first gets back to N=1 — the policy stops
  // QUIET re-admission, not a phrase-holder demolishing the vault (L3).
  _effectiveAdmitN () {
    return Math.max(1, Math.min(this.admitPolicyN || 1, Math.max(1, this._nonRevokedAdminCount())))
  }

  // Canonical detached-signature payloads. Cosigs bind the EXACT identity
  // tuple being admitted (or the exact policy value), so a gathered signature
  // cannot be replayed onto a different device or a different N.
  _admitCosigPayload (dev) {
    return {
      t: 'pp-admit-v1',
      vaultId: String(this.ctx.state.vaultId || ''),
      deviceId: String(dev.deviceId || ''),
      signingPubkey: String(dev.signingPubkey || ''),
      boxPubkey: String(dev.boxPubkey || ''),
      writerKey: String(dev.writerKey || ''),
      roles: Array.isArray(dev.roles) ? dev.roles.map(String).sort() : []
    }
  }

  _policyCosigPayload (n) {
    return { t: 'pp-admit-policy-v1', vaultId: String(this.ctx.state.vaultId || ''), n: Number(n) }
  }

  // Distinct admin signers backing an op: the op's own signer plus every valid
  // detached cosig, keyed by signingPubkey, counted only for COMMITTED,
  // NON-REVOKED admin devices (or the root pubkey). Pure function of the
  // reorg-safe auth cache — deterministic across devices.
  _distinctAdminSigners (op, cosigs, payload) {
    const out = new Set()
    const adminFor = (pubkey) => {
      if (pubkey === this.rootPubkey) return true
      for (const d of this.devices.values()) {
        if (d.signingPubkey === pubkey) {
          return d.revokedAtLamport == null && (d.roles || []).includes('admin')
        }
      }
      return false
    }
    if (op && op.signerPubkey && adminFor(op.signerPubkey)) out.add(op.signerPubkey)
    for (const c of Array.isArray(cosigs) ? cosigs : []) {
      if (!c || typeof c.signingPubkey !== 'string' || typeof c.sig !== 'string') continue
      if (out.has(c.signingPubkey)) continue
      if (!adminFor(c.signingPubkey)) continue
      let ok = false
      try { ok = this.ctx.crypto.verifyDetached(c.signingPubkey, payload, c.sig) } catch (_) { ok = false }
      if (ok) out.add(c.signingPubkey)
    }
    return out
  }

  // Another admin device calls these to produce the out-of-band cosignatures
  // the approver attaches to DEVICE_ADD / ADMIT_POLICY_SET.
  cosignDeviceAdd (dev) {
    const s = this._localSigner()
    return {
      signingPubkey: s.signingPubkey,
      sig: this.ctx.crypto.signDetached(s.signingSecretKey, this._admitCosigPayload(dev))
    }
  }

  cosignAdmitPolicy (n) {
    const s = this._localSigner()
    return {
      signingPubkey: s.signingPubkey,
      sig: this.ctx.crypto.signDetached(s.signingSecretKey, this._policyCosigPayload(n))
    }
  }

  // Raise/lower the per-vault admit policy. The CHANGE itself needs the
  // CURRENT effective N distinct admin signatures (otherwise a lone
  // phrase-holder would just lower N=2→1 and self-admit).
  async setAdmitPolicy (n, cosigs = []) {
    const v = Math.floor(Number(n))
    if (!Number.isFinite(v) || v < 1 || v > 4) {
      const e = new Error('admit policy N must be 1..4'); e.code = 'SCHEMA_INVALID'; throw e
    }
    const op = this._makeOp({
      type: this.ctx.ops.OP_TYPES.ADMIT_POLICY_SET,
      schema: this.ctx.ops.SCHEMAS.ADMIT_POLICY,
      objectId: 'admit-policy:v1',
      payload: { n: v, cosigs },
      signer: this._localSigner()
    })
    await this._append(op)
    await this.refresh()
    return { ok: true, admitPolicyN: this.admitPolicyN }
  }

  // "Looks like a previously-revoked device" heuristic (design §3.8 step 3):
  // a re-imaged revoked laptop presents a FRESH deviceId, but a careless
  // attacker may reuse key material. Surfaced as a LOUD warning at admit time;
  // never a cryptographic gate (a careful attacker always presents fresh keys).
  matchesRevokedDevice ({ signingPubkey, boxPubkey } = {}) {
    for (const d of this.devices.values()) {
      if (d.revokedAtLamport == null) continue
      if (signingPubkey && d.signingPubkey === signingPubkey) return { deviceId: d.deviceId, via: 'signingPubkey' }
      if (boxPubkey && d.boxPubkey === boxPubkey) return { deviceId: d.deviceId, via: 'boxPubkey' }
    }
    return null
  }

  // The epoch-key chain a pairing bootstrap delivers (design §5.8, B1 —
  // SELECTIVE-CHAIN BY DEFAULT): only the ACTIVE epoch key unless the approver
  // explicitly grants history, in which case the full chain rides along.
  // HONEST DEVIATION from §5.8: vaultKey itself always ships in the bootstrap
  // — every committed system row (device records, vault-state, objmeta, epoch
  // wraps) is sealed under it, so a joiner without it cannot even read the
  // device set; it is the system KEK, not just the epoch-0 content key. The
  // consequence: epoch-0 content stays readable to any paired device. Against
  // the actual B1 adversary this costs nothing — a previously-revoked device
  // already holds vaultKey on disk and it is phrase-derivable anyway (L1/L3).
  // What selective-chain DOES withhold is every ROTATED epoch key except the
  // current one — exactly the keys minted during a revoked device's exile.
  _bootstrapEpochKeys ({ grantHistory = false } = {}) {
    const out = {}
    if (grantHistory) {
      for (const [tag, key] of this.epochKeys) {
        if (tag) out[tag] = b4a.toString(key, 'hex')
      }
    } else if (this.activeEpochTag && this.epochKeys.has(this.activeEpochTag)) {
      out[this.activeEpochTag] = b4a.toString(this.epochKeys.get(this.activeEpochTag), 'hex')
    }
    return out
  }

  // ADMIT_POLICY_SET reducer branch: admin-signed, and the change itself must
  // carry the CURRENT effective N distinct admin signatures over the new value.
  async _applyAdmitPolicySet (op, opLamport, batch) {
    if (!this._signerAuthorized(op, opLamport, { adminOnly: true })) {
      this.ctx.log.warn('op-rejected', { reason: 'ADMIT_POLICY_NOT_ADMIN' })
      return
    }
    const body = this._bodyOrNull(op) // { n, cosigs }
    if (body === null) return
    const n = Math.floor(Number(body.n))
    if (!Number.isFinite(n) || n < 1 || n > 4) {
      this.ctx.log.warn('op-rejected', { reason: 'ADMIT_POLICY_BAD_N' })
      return
    }
    const needed = this._effectiveAdmitN()
    if (needed > 1) {
      const signers = this._distinctAdminSigners(op, body.cosigs, this._policyCosigPayload(n))
      if (signers.size < needed) {
        this.ctx.log.warn('op-rejected', { reason: 'ADMIT_POLICY_UNDERSIGNED', have: signers.size, need: needed })
        return
      }
    }
    let vs = null
    try { vs = await this.view.getVaultState() } catch (_) { vs = null }
    await this.view.putVaultState(batch, { ...(vs || {}), admitPolicyN: n })
    this.admitPolicyN = n
  }

  // Build a KEY_ROTATE op carrying real content-key rotation (design §3.2/§3.3,
  // RT-FIX B3/B10/B11). Mints epochKey_{N+1}=randomBytes(32) (NEVER derived —
  // an ex-admin re-derives anything deterministic, §1.2), computes
  // epochTag_{N+1}=hash(opId || prevEpochTag), seals the key INDIVIDUALLY to each
  // surviving boxPubkey via crypto_box_seal (omitting the revoked device), and
  // seals the body under the NEW key (B3 — so the revoked device, which holds
  // only epochKey_N, cannot read the roster/prev-chain). Returns { op,
  // epochKey, epochTag } so the caller can persist the new key locally. The
  // topicSeed is NEVER transmitted (B3): survivors derive it locally from the key.
  _makeKeyRotateOp ({ revokedDeviceId, survivors, signer }) {
    const ctx = this.ctx
    const crypto = ctx.crypto
    const ops = ctx.ops
    const prevEpochTag = this.activeEpochTag || ''
    const newEpochInt = (Number(this.activeEpoch) || 0) + 1
    const epochKey = crypto.randomBytes(crypto.KEY_BYTES)
    const opId = b4a.toString(crypto.randomBytes(16), 'hex')
    // Collision-safe identity (design §2.1/§3.5): two concurrent rotations are
    // both integer N+1 but carry distinct opIds -> distinct tags, so addressing
    // by the tag never collides (B5).
    const epochTag = b4a.toString(crypto.hash('epochtag:' + opId + ':' + prevEpochTag, 16), 'hex')

    // (B10) per-survivor PUBLIC wraps keyed by a BLINDED id (not the plaintext
    // deviceId) so even a reader of the op cannot enumerate the roster. Each
    // `sealed` is an opaque crypto_box_seal only the target's box secret opens.
    const wraps = []
    for (const d of survivors) {
      if (!d.boxPubkey) continue
      wraps.push({
        blindId: crypto.blindId(this.indexKey, 'epochwrap:' + epochTag + ':' + d.deviceId),
        sealed: ctx.identity.sealToDevice(d.boxPubkey, epochKey)
      })
    }

    const objectBlindId = crypto.blindId(this.indexKey, 'key-rotate:' + epochTag)
    const lamport = ctx.state.lamport.tick()
    const header = {
      version: 1,
      opId,
      vaultId: String(ctx.state.vaultId),
      deviceId: String(signer.deviceId),
      type: ops.OP_TYPES.KEY_ROTATE,
      objectBlindId,
      lamport: String(lamport),
      createdAtBucket: ops.timeBucket(),
      epoch: String(newEpochInt), // ◄── the NEW epoch (ordering hint)
      epochTag // ◄── the NEW content-addressing tag
    }
    ops.assertHeaderPublicOnly(header)

    // (B3) body sealed under the NEW key, openable ONLY by a survivor that first
    // unwrapped its lockbox above. No topicSeed (survivors derive it locally).
    const envelope = crypto.seal({
      epochKey,
      epochTag,
      objectId: this._opBodyObjectId(objectBlindId),
      objectBlindId,
      opType: ops.OP_TYPES.KEY_ROTATE,
      schema: ops.SCHEMAS.SETTING,
      vaultId: ctx.state.vaultId,
      plaintext: {
        epoch: newEpochInt,
        epochTag,
        prevEpoch: Number(this.activeEpoch) || 0,
        prevEpochTag,
        revokedDeviceId: String(revokedDeviceId || ''),
        reason: 'device-revoke'
      }
    })
    const aadHash = crypto.aadHashOf(envelope.aad)
    const signature = crypto.signOp(signer.signingSecretKey, {
      header,
      ciphertext: envelope.ciphertext,
      nonce: envelope.nonce,
      aadHash
    })
    // `wraps` rides as a PUBLIC top-level op field (B11): self-contained, opened
    // from the op alone with only the box secret key, robust to reorg/batch
    // splits. Not in the signed preimage (see _applyKeyRotate note); integrity
    // rests on the crypto_box_seal construction + the durable epochkeys! rows.
    return {
      op: { header, envelope, wraps, aadHash, signerPubkey: signer.signingPubkey, signature },
      epochKey,
      epochTag,
      epochInt: newEpochInt
    }
  }

  _rememberOp (op, accepted = false) {
    const opId = op && op.header && op.header.opId
    if (!opId) return
    this._appliedOps.set(opId, { ...op, __accepted: !!accepted })
  }

  // Serialized append. Every base.append() (content ops, DEVICE_ADD/REVOKE,
  // KEY_ROTATE) goes through the per-engine promise chain so no two appends are
  // ever in flight at once (CONCURRENT APPEND DROP fix — see constructor). The
  // chain link is installed synchronously so same-tick callers queue in call
  // order; a rejected predecessor must not poison the chain, so the tail is
  // swallowed for chaining while the caller still sees its own result/error.
  async _append (op) {
    const run = this._appendChain.then(
      () => this._appendNow(op),
      () => this._appendNow(op) // predecessor failed/teardown — still run ours
    )
    // advance the chain on a swallowed copy so a future link never rejects on
    // an earlier caller's error.
    this._appendChain = run.then(() => {}, () => {})
    return run
  }

  async _appendNow (op) {
    if (!this.base || this._closing) {
      const e = new Error('sync engine closing'); e.code = 'ENGINE_CLOSING'; throw e
    }
    await this.base.append(op)
  }

  // [GATE SB1] Is the writer core `writerKeyHex` currently LIVE (connected)?
  // The determining factor for whether removeWriter is safe is whether the
  // REMOVED device is online to ack the indexer-set migration: with it OFFLINE,
  // removeWriter deterministically FREEZES the base's indexedLength (proven on a
  // real @hyperswarm/testnet, Autobase 7.28.1) and REVOKE+ROTATE never commit
  // vault-wide. We therefore gate host-side eviction on this and skip+defer when
  // it returns false. Conservative by construction: we look up the writer in the
  // base's activeWriters and require ≥1 connected peer on its underlying core; a
  // writer we cannot resolve, or one with no peers, is treated as OFFLINE so we
  // NEVER attempt an eviction that could freeze the base. Forward secrecy does
  // not depend on this — the reducer B12 gate excludes the writes regardless.
  _isWriterLive (writerKeyHex) {
    try {
      const base = this.base
      if (!base || !base.activeWriters) return false
      const key = b4a.from(writerKeyHex, 'hex')
      const w = base.activeWriters.get(key)
      if (!w || !w.core) return false
      const peers = w.core.peers
      return Array.isArray(peers) && peers.length > 0
    } catch (_) { return false }
  }

  // Bounded wait until this device's Autobase writer seat has linearized so
  // base.append() won't throw "Not writable". A freshly paired device
  // (post-PAIR_ACCEPT / DEVICE_ADD) gets its writer key authorized by the
  // admin in a DEVICE_ADD op that must replicate + linearize before the new
  // device can write its own content ops; until then base.writable is false
  // and the first NOTE_UPSERT/CLIP_CAPTURE would throw and be silently lost.
  // We poll base.writable, pump base.update() to pull in the authorizing op,
  // and sleep cooperatively between tries. The sleep is abortable on teardown
  // (ctx.scope.sleep) so a closing engine never blocks shutdown; when no scope
  // is wired (lightweight test ctx) we fall back to a plain unref'd timer.
  // Reads / local-first behavior are untouched — only content-op appends wait.
  async _awaitWritable (timeoutMs = 8000) {
    if (this.base && this.base.writable) return
    const scope = this.ctx && this.ctx.scope
    const sleep = (ms) => (scope && typeof scope.sleep === 'function')
      ? scope.sleep(ms)
      : new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t.unref) t.unref() })
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0)
    while (true) {
      if (!this.base) break
      if (this.base.writable) return
      try { await this.base.update() } catch (_) { /* closing / transient */ }
      if (this.base && this.base.writable) return
      if (Date.now() >= deadline) break
      // cooperative backoff; rejects with AbortError on scope teardown, which
      // we let propagate so a closing engine aborts the append promptly.
      await sleep(150)
    }
    const e = new Error('autobase writer seat not yet linearized — retry once membership converges')
    e.code = 'NOT_WRITABLE_YET'
    e.retryable = true
    throw e
  }

  // Rebuild the in-memory authorization cache (devices / writerToDevice /
  // rootPubkey / keyEpoch) as a PURE FUNCTION of the committed materialized
  // view (CRITICAL #1). Autobase truncates the view core on a fork/reorg and
  // re-invokes _apply over only the re-linearized TAIL — it does NOT replay
  // the whole log and gives no reset signal, so any cache mutated incrementally
  // would retain rolled-back state (union of old+new). By clearing and
  // repopulating from this.view (which wraps this.base.view, the committed
  // post-truncation Hyperbee) at the start of every apply pass, the cache
  // always reflects exactly the committed authz state. Safe on an empty view
  // (genesis / lock->unlock reopen): no devices, no vault-state -> cache stays
  // empty and the genesis DEVICE_ADD later in the SAME batch sets rootPubkey
  // incrementally; the next apply pass reads the flushed vault-state row back.
  async _rebuildAuthFromView () {
    if (!this.view) return
    const prevRoot = this.rootPubkey
    const prevEpoch = this.keyEpoch
    let rows = []
    try { rows = await this.view.listDevicesSealed() } catch (_) { rows = [] }

    this.devices.clear()
    this.writerToDevice.clear()
    let derivedRoot = null

    for (const { key, value } of rows) {
      const deviceBlindId = key.slice('devices!'.length)
      // The device record is sealed with objectId 'device:'+deviceId, and
      // crypto.openWithObjectId derives the item key from that objectId — but
      // the row is keyed by the blinded deviceBlindId, a one-way hash, so we
      // cannot recover deviceId from the key. The reducer therefore also writes
      // a self-describing sealed objmeta row (keyed by the public blindId) that
      // maps deviceBlindId -> { objectId:'device:'+deviceId }. Resolve it, then
      // open the device record. Any record we can't resolve/open is skipped
      // (treated as unknown) rather than corrupting the authz set.
      let objectId = null
      try {
        const meta = await this.view.resolveObjMeta(deviceBlindId)
        if (meta && meta.objectId) objectId = meta.objectId
      } catch (_) { objectId = null }
      if (!objectId) continue
      let plain = null
      try { plain = this.view.openRecord({ objectId, envelope: value }) } catch (_) { plain = null }
      if (!plain || !plain.deviceId) continue

      const rec = {
        deviceId: plain.deviceId,
        signingPubkey: plain.signingPubkey,
        // boxPubkey is ALREADY sealed in the device record at putDevice — only
        // the in-memory projection dropped it. Carry it through so a later
        // rotation (Phase 2) can seal epoch keys to each surviving device's box
        // pubkey straight from the reorg-safe cache (design §5.1, gap fix).
        boxPubkey: plain.boxPubkey,
        writerKey: plain.writerKey,
        roles: plain.roles || ['writer'],
        revokedAtLamport: (plain.revokedAtLamport == null ? null : Number(plain.revokedAtLamport)),
        addedAtLamport: (plain.addedAtLamport == null ? null : Number(plain.addedAtLamport)),
        isRoot: !!plain.isRoot,
        // [RT-FIX B12] `committedRevoked` is true when this device's revocation
        // is ALREADY DURABLE in the committed view at the start of this apply
        // pass. It distinguishes "newly-arriving op from a committed-revoked
        // signer" (reject outright — closes the backdated-lamport window) from a
        // genuine pre-revoke op replayed in the SAME first-linearization batch
        // where the revoke is set incrementally below (judged by the lamport
        // rule, so legitimately-authored history is not corrupted). Because it
        // is read from the truncation-aware view, it is reorg-deterministic.
        committedRevoked: plain.revokedAtLamport != null
      }
      this.devices.set(rec.deviceId, rec)
      if (rec.writerKey) this.writerToDevice.set(rec.writerKey, rec.deviceId)
      if (rec.isRoot && rec.signingPubkey) derivedRoot = rec.signingPubkey
    }

    // rootPubkey: prefer persisted vault-state, then the isRoot device record,
    // then whatever we already had (legacy vaults / pre-flush bootstrap) so we
    // never clobber a known root to null mid-session.
    let vs = null
    try { vs = await this.view.getVaultState() } catch (_) { vs = null }
    this.rootPubkey = (vs && vs.rootPubkey) || derivedRoot || prevRoot || null
    // keyEpoch is monotonic and only persisted in vault-state / KEY_ROTATE.
    const viewEpoch = vs && Number.isFinite(Number(vs.keyEpoch)) ? Number(vs.keyEpoch) : 0
    this.keyEpoch = Math.max(viewEpoch, prevEpoch || 0)

    // ---- epoch content-key state, a PURE FUNCTION of the committed view ----
    // (design §5.2, RT-FIX B5). Rebuilt here alongside the device cache so a
    // fork/reorg that truncates+replays a rotation recomputes IDENTICAL epoch
    // state from the post-truncation `vault-state` + `epochkeys!` rows, never
    // retaining rolled-back keys. Phase 1: the view holds no non-zero epoch and
    // no wrap rows, so this deterministically yields activeEpoch 0 /
    // activeEpochTag "" / epochKeys{ "" -> vaultKey } for every existing vault.
    const prevActiveEpoch = this.activeEpoch || 0
    // activeEpoch is monotone (a max-merge, like keyEpoch) so a transient reorg
    // cannot move it backwards mid-session; activeEpochTag follows the winner
    // the committed view recorded (defaults to "" when no rotation has landed).
    this.activeEpoch = Math.max(Number((vs && vs.activeEpoch) || 0), prevActiveEpoch)
    this.activeEpochTag = (vs && vs.activeEpochTag) || ''
    // Winner-selection state (design §3.5) is ALSO a pure function of the
    // committed view: persisting the winning rotation's lamport+deviceId in
    // vault-state lets a SECOND concurrent rotation arriving in a later pass be
    // compared deterministically by Lamport.beats, regardless of stream order —
    // a clean reopen (volatile fields 0) recovers the recorded winner here so
    // the comparison never silently flips the active tag (B5).
    this._activeWinnerLamport = Number((vs && vs.activeEpochLamport) || 0)
    this._activeWinnerDevice = (vs && vs.activeEpochDevice) || ''
    this._activeEpochProvisional = !!(vs && vs.activeEpochProvisional)
    // Admit policy is a pure function of committed vault-state too (B1).
    const vn = Number(vs && vs.admitPolicyN)
    this.admitPolicyN = Number.isFinite(vn) && vn >= 1 ? Math.floor(vn) : 1
    // Rebuild epochKeys from scratch so a truncation never leaves a stale key.
    this.epochKeys.clear()
    // Epoch-0 lazy-migration anchor: epochKey_0 == vaultKey (design §6). Always
    // present (even on an empty/genesis view) so epoch-0 seal/open is the
    // byte-identical pre-epoch path.
    if (this.vaultKey) this.epochKeys.set('', this.vaultKey)
    // Layer in every committed epoch-key lockbox addressed to THIS device,
    // keyed by epochTag (NEVER the integer — B5). For epoch 0 there are none.
    // A wrap we cannot open (not entitled / different device) is skipped, not
    // fatal — Phase 5/§3.10 turns that into a pending-gap; here it is simply
    // absent. Box material may be missing in a lightweight test ctx; guard it.
    if (this.view && this.myDeviceId && this.myBoxPubkey && this.myBoxSecretKey && this.ctx.identity) {
      let wraps = []
      try { wraps = await this.view.listEpochKeyWrapsFor(this.myDeviceId) } catch (_) { wraps = [] }
      for (const { epochTag, sealed } of wraps) {
        if (!epochTag) continue // tag "" is the vaultKey anchor, set above
        try {
          const k = this.ctx.identity.openSealedToDevice(this.myBoxPubkey, this.myBoxSecretKey, sealed)
          this.epochKeys.set(epochTag, k)
        } catch (_) { /* not our wrap / not entitled — pending-gap (§3.10, P5) */ }
      }
    }
    // Layer in the LOCAL epoch chain (design §5.9: blob-persisted keys; design
    // §5.8/Phase 4: keys DELIVERED IN THE PAIRING BOOTSTRAP). A freshly paired
    // device has NO committed wraps — its lockboxes were sealed to the
    // then-survivors at each rotation, before it existed — so the bootstrap
    // chain in state._epochKeysLocal is its ONLY source for the active key
    // until the next rotation seals one to it. Local-only material, exactly
    // like the vaultKey anchor above; committed wraps win on tag collision.
    const localChain = this.ctx.state && this.ctx.state._epochKeysLocal
    if (localChain && typeof localChain === 'object') {
      for (const [tag, hex] of Object.entries(localChain)) {
        if (!tag || this.epochKeys.has(tag)) continue
        try { this.epochKeys.set(tag, b4a.from(String(hex), 'hex')) } catch (_) {}
      }
    }
  }

  // --- reducer (deterministic; spec §9.5) ----------------------------------
  // IMPORTANT: This reducer NEVER mutates external state. It writes only into
  // `view` (the autobase-managed Hyperbee, via `batch`). The in-memory authz
  // cache (devices / writerToDevice / rootPubkey / keyEpoch) is a derived
  // index: _rebuildAuthFromView() rebuilds it from the committed view at the
  // start of EVERY apply pass so a fork/reorg (which truncates the view and
  // re-applies only the re-linearized tail) can never leave stale/rolled-back
  // authorization data behind. The incremental updates inside the node loop
  // below exist only so ops later in a batch observe device ops earlier in the
  // SAME batch; the authoritative state is the rebuild from the flushed view.
  async _apply (nodes, view, host) {
    const ctx = this.ctx
    const crypto = ctx.crypto
    const ops = ctx.ops
    // Reorg-safe: re-derive the authz cache from the committed view before
    // processing this (possibly post-truncation) tail. See _rebuildAuthFromView.
    await this._rebuildAuthFromView()
    const batch = view.batch()
    try {
      for (const node of nodes) {
        const op = node.value
        if (!op || !op.header) continue
        const h = op.header
        this._rememberOp(op, false)

        // observe lamport for our local clock monotonicity
        ctx.state.lamport.observe(h.lamport)

        // ---- signature verification (spec §8.1, §16) -------------------
        const sigOk = crypto.verifyOp(op.signerPubkey, {
          header: h,
          ciphertext: op.envelope.ciphertext,
          nonce: op.envelope.nonce,
          aadHash: op.aadHash
        }, op.signature)
        if (!sigOk) {
          ctx.log.warn('op-rejected', { reason: 'BAD_SIGNATURE', type: h.type })
          continue
        }
        // aadHash must match the envelope it claims to bind (anti-splice)
        if (crypto.aadHashOf(op.envelope.aad) !== op.aadHash) {
          ctx.log.warn('op-rejected', { reason: 'AAD_MISMATCH', type: h.type })
          continue
        }

        const opLamport = Number(h.lamport)

        // ---- device lifecycle ops -------------------------------------
        if (h.type === ops.OP_TYPES.DEVICE_ADD) {
          await this._applyDeviceAdd(op, host, batch)
          this._rememberOp(op, true)
          continue
        }
        if (h.type === ops.OP_TYPES.DEVICE_REVOKE) {
          await this._applyDeviceRevoke(op, host, batch)
          this._rememberOp(op, true)
          continue
        }
        if (h.type === ops.OP_TYPES.KEY_ROTATE) {
          if (this._signerAuthorized(op, opLamport, { adminOnly: true })) {
            await this._applyKeyRotate(op, batch)
            this._rememberOp(op, true)
          }
          continue
        }
        if (h.type === ops.OP_TYPES.ADMIT_POLICY_SET) {
          await this._applyAdmitPolicySet(op, opLamport, batch)
          this._rememberOp(op, true)
          continue
        }

        // ---- content ops: signer must be authorized & not revoked -----
        if (!this._signerAuthorized(op, opLamport)) {
          ctx.log.warn('op-rejected', { reason: 'REVOKED_OR_UNKNOWN', type: h.type })
          continue
        }

        if (h.type === ops.OP_TYPES.NOTE_UPSERT) {
          await this._applyNoteUpsert(op, batch)
          this._rememberOp(op, true)
        } else if (h.type === ops.OP_TYPES.NOTE_DELETE) {
          await this._applyNoteDelete(op, batch)
          this._rememberOp(op, true)
        } else if (h.type === ops.OP_TYPES.CLIP_ADD) {
          await this._applyClipAdd(op, batch)
          this._rememberOp(op, true)
        } else if (h.type === ops.OP_TYPES.CLIP_DELETE) {
          await this._applyClipDelete(op, batch)
          this._rememberOp(op, true)
        }
        // ACK and unknown types are intentionally ignored.
      }
      await batch.flush()
      // Wake pending-peer verdicts in the replication firewall: an apply pass
      // is the ONLY place the committed device set changes, so this event (not
      // a poll) drives the 'unknown device' recheck. Emitted AFTER the flush so
      // a recheck observes this batch's DEVICE_ADD/REVOKE rows. Never throws.
      try { ctx.emit('auth-cache-rebuilt') } catch (_) {}
    } catch (err) {
      try { await batch.close() } catch (_) {}
      // Surface but never crash the linearizer; ctx.log is redacted.
      ctx.log.error('reducer-error', { err: String((err && err.message) || err) })
      throw err
    }
  }

  _body (op) {
    // decrypt op body in memory (spec §9.2). Caller must already trust signer.
    // Select the content key by the op's own header.epochTag (design §5.4): a
    // missing/empty tag (every pre-epoch row, and all of Phase 1) falls back to
    // vaultKey == epochKey_0, so legacy ops open byte-identically. A later-epoch
    // row opens only on a device that holds that tag's key in epochKeys; the AAD
    // is taken verbatim from the stored envelope, so cross-epoch decrypt fails
    // closed under XChaCha20-Poly1305.
    const tag = String((op.header && op.header.epochTag) || '')
    return this.ctx.crypto.openWithObjectId({
      epochKey: this.epochKeys.get(tag) || this.vaultKey,
      epochTag: tag,
      objectId: this._opBodyObjectId(op.header && op.header.objectBlindId),
      envelope: op.envelope
    })
  }

  // Reducer-safe body decrypt. _body THROWS AEAD_FAIL when this device lacks the
  // op's epoch key — which is LEGITIMATE after a rotation (the revoked device
  // permanently; a non-revoked device transiently, until it unwraps the new
  // epoch key). Because the content _apply* handlers run INSIDE the Autobase
  // reducer (_apply), an uncaught throw there crashes the whole drain/process.
  // So every reducer caller decrypts through THIS wrapper: it returns null on a
  // decrypt failure (the caller then stores the sealed op verbatim and skips the
  // local plaintext index) and never throws out of _apply. The READ path
  // (NOTE_OPEN / explicit user reads) keeps calling crypto.openWithObjectId /
  // view.openRecord directly so AEAD_FAIL still surfaces to its own caller.
  _bodyOrNull (op) {
    try {
      return this._body(op)
    } catch (err) {
      if (err && (err.code === 'AEAD_FAIL' || err.code === 'BAD_KEY' || err.code === 'BAD_ENVELOPE')) {
        this.ctx.log.debug('content-op-undecryptable', {
          type: op.header && op.header.type,
          epochTag: String((op.header && op.header.epochTag) || ''),
          reason: 'content op undecryptable under current epoch keys — stored sealed, skipped local index'
        })
        return null
      }
      throw err // a non-decrypt error is a real bug — let the reducer surface it
    }
  }

  // signer is authorized iff: known device, not revoked at/before this op's
  // lamport, OR the root identity. Root may always sign lifecycle ops.
  //
  // [RT-FIX B12] reject-committed-revoked-signer (LOAD-BEARING — primary
  // write-exclusion now that removeWriter is decoupled per GATE SB1). The legacy
  // gate was `opLamport >= revokedAtLamport`; because lamport is the device's
  // OWN monotonic counter, a malicious revoked device can BACKDATE a content op
  // to `revokedAtLamport - 1` to slip under that threshold (its signature is
  // valid — its key still works). The fix (design §3.11): once a DEVICE_REVOKE
  // for a signer is committed in the view, reject EVERY content/rotation op from
  // it for NEWLY-ARRIVING ops — gate on "revoked at all," not the lamport
  // inequality. `committed=true` (the live reducer path) takes the strict gate;
  // `committed=false` (verifier / historical re-check of already-linearized
  // ops) keeps the `>=` lamport rule so genuine pre-revoke ops that were already
  // accepted stay valid (retroactively rejecting them would corrupt history).
  // Because _rebuildAuthFromView makes `revokedAtLamport` a pure function of the
  // committed (truncation-aware) view, this is reorg-safe: a device revoked in
  // the committed view has ALL its new ops dropped regardless of claimed lamport.
  _signerAuthorized (op, opLamport, { adminOnly = false } = {}) {
    const pub = op.signerPubkey
    if (pub === this.rootPubkey) return true
    let dev = null
    for (const d of this.devices.values()) if (d.signingPubkey === pub) { dev = d; break }
    if (!dev) return false
    if (adminOnly && !(dev.roles || []).includes('admin')) return false
    if (dev.revokedAtLamport != null) {
      // B12 strict gate: a signer whose revocation is already DURABLE in the
      // committed view is rejected for EVERY newly-arriving op, regardless of its
      // claimed lamport — this is what closes the backdated-lamport window and is
      // the primary write-exclusion now that removeWriter is decoupled (GATE SB1,
      // design §3.11). A device revoked only incrementally within THIS apply pass
      // (committedRevoked still false) falls through to the legacy lamport floor
      // so a genuine pre-revoke op re-linearized alongside the revoke is kept.
      if (dev.committedRevoked) return false
      if (opLamport >= dev.revokedAtLamport) return false
    }
    return true
  }

  async _applyDeviceAdd (op, host, batch) {
    const h = op.header
    const opLamport = Number(h.lamport)
    // Lifecycle ops normally seal under epoch 0 (vaultKey), readable by every
    // device. Guard anyway: if a DEVICE_ADD was minted under a later epoch this
    // device has not unwrapped, _body would AEAD_FAIL and crash the reducer.
    // Skip cleanly — the membership change re-materializes once the key arrives.
    const body = this._bodyOrNull(op) // { device:{...}, selfRoot? , rootPubkey? }
    if (body === null || !body.device) return
    const dev = body.device

    // First DEVICE_ADD establishes the root pubkey (self-root bootstrap) and
    // is trusted as the genesis of the device set. Subsequent adds must be
    // signed by root or an existing admin (spec §7.2, §14 step 7).
    const isGenesis = this.devices.size === 0 && body.selfRoot === true
    if (isGenesis) {
      this.rootPubkey = body.rootPubkey || op.signerPubkey
    } else if (!this._signerAuthorized(op, opLamport, { adminOnly: true })) {
      this.ctx.log.warn('op-rejected', { reason: 'DEVICE_ADD_NOT_ADMIN' })
      return
    }

    // [RT-FIX B1] ADMIT POLICY: under N≥2, a DEVICE_ADD needs N DISTINCT
    // non-revoked admin signatures — the op signer plus detached cosigs over
    // the new device's identity tuple. Enforced for ROOT-signed adds too
    // (_signerAuthorized's root bypass is exactly the lone-phrase-holder
    // self-admit hole this closes): a lone key-holder cannot quietly re-admit
    // a device once a second admin exists and the policy is raised. Effective
    // N is clamped to the live admin count so revocations cannot deadlock
    // admission — the honest residual being that a root willing to LOUDLY
    // revoke other admins first can still get back to N=1 (documented L3).
    if (!isGenesis) {
      const needed = this._effectiveAdmitN()
      if (needed > 1) {
        const signers = this._distinctAdminSigners(op, body.cosigs, this._admitCosigPayload(dev))
        if (signers.size < needed) {
          this.ctx.log.warn('op-rejected', {
            reason: 'DEVICE_ADD_POLICY',
            have: signers.size,
            need: needed
          })
          return
        }
      }
    }

    const rec = {
      deviceId: dev.deviceId,
      signingPubkey: dev.signingPubkey,
      writerKey: dev.writerKey, // hex of the device's autobase writer core
      roles: dev.roles || ['writer'],
      revokedAtLamport: null,
      addedAtLamport: opLamport,
      isRoot: !!isGenesis
    }
    const prev = this.devices.get(dev.deviceId)
    if (!prev || prev.revokedAtLamport == null) {
      this.devices.set(dev.deviceId, rec)
      if (rec.writerKey) this.writerToDevice.set(rec.writerKey, dev.deviceId)
    }

    // grant the new device an Autobase writer seat (idempotent)
    if (rec.writerKey && host && typeof host.addWriter === 'function') {
      try {
        await host.addWriter(b4a.from(rec.writerKey, 'hex'), { indexer: true })
        // Mark the fresh-writer integration window open. Adding an indexer makes
        // Autobase migrate/reboot the apply state, which can roll an un-indexed
        // content row out of the view (the SILENT NOTE-LOSS). appendOp's
        // durability-confirm engages its bounded wait+retry only inside this
        // window so steady-state writes keep baseline latency. See appendOp.
        this._lastWriterAddedAt = Date.now()
      } catch (_) { /* already a writer / fork in progress */ }
    }

    // Sealed device record into the view + sealed objmeta for resolution.
    // The auth-critical fields (writerKey / revokedAtLamport / addedAtLamport
    // / isRoot) are persisted ALONGSIDE the display fields so _rebuildAuthFromView
    // can reconstruct the full in-memory `rec` shape purely from the committed
    // (reorg-safe) view — see CRITICAL #1. They live inside the crypto.seal
    // envelope so relay-blindness / at-rest secrecy is preserved.
    const deviceBlindId = this.ctx.crypto.blindId(this.indexKey, 'device:' + dev.deviceId)
    await this.view.putDevice(batch, {
      objectId: 'device:' + dev.deviceId,
      deviceBlindId,
      device: {
        deviceId: dev.deviceId,
        label: dev.label,
        platform: dev.platform,
        signingPubkey: dev.signingPubkey,
        boxPubkey: dev.boxPubkey,
        roles: rec.roles,
        createdAt: dev.createdAt || Date.now(),
        // auth-critical, reorg-safe fields (sealed):
        writerKey: rec.writerKey,
        revokedAtLamport: null,
        addedAtLamport: rec.addedAtLamport,
        isRoot: rec.isRoot
      }
    })
    // Self-describing sealed mapping deviceBlindId -> objectId so
    // _rebuildAuthFromView can resolve+open this device record from the view
    // alone (the row key is the one-way blindId). Same encoding notes/clips use.
    await this.view.putObjMeta(batch, {
      objectId: 'device:' + dev.deviceId,
      objectBlindId: deviceBlindId,
      type: 'device'
    })

    // Persist vault-level authz state on genesis so rootPubkey + keyEpoch are
    // recoverable from the view after a truncation/reopen even before any
    // device record is re-read. rootPubkey is ALSO derivable from the isRoot
    // device record (belt-and-suspenders); keyEpoch only lives here / on
    // KEY_ROTATE, so persisting it is required.
    if (isGenesis) {
      await this.view.putVaultState(batch, { rootPubkey: this.rootPubkey, keyEpoch: 0 })
    }
  }

  async _applyDeviceRevoke (op, host, batch) {
    const h = op.header
    const opLamport = Number(h.lamport)
    if (!this._signerAuthorized(op, opLamport, { adminOnly: true })) {
      this.ctx.log.warn('op-rejected', { reason: 'REVOKE_NOT_ADMIN' })
      return
    }
    const body = this._bodyOrNull(op) // { deviceId }
    if (body === null) return // lacks the epoch key to read the revoke target — skip, never throw
    const target = this.devices.get(body.deviceId)
    if (!target) return
    target.revokedAtLamport = opLamport
    // [GATE SB2] Signal the replication firewall on EVERY device that applies
    // this revoke (the dispatcher's host-side emit only fires on the revoking
    // admin). The firewall must actively conn.destroy() existing streams
    // authenticated to the revoked device — refusing new connections alone is
    // not enough (Hypercore replication streams persist through swarm.leave).
    // Same signal-only pattern as 'epoch-rotated': handlers do the side
    // effects; the reducer stays pure. Idempotent on re-apply after a reorg.
    try { this.ctx.emit('device-revoked', { deviceId: body.deviceId, applied: true }) } catch (_) {}
    // [GATE SB1] removeWriter is DECOUPLED from the reducer. Calling
    // host.removeWriter inside apply on a target that is OFFLINE deterministically
    // FREEZES the base's indexedLength (empirically proven on a real
    // @hyperswarm/testnet, Autobase 7.28.1): the indexer-set migration is itself
    // an indexed op needing the REMOVED device's ack, so with it offline the
    // committed checkpoint never advances — REVOKE+ROTATE never commit vault-wide.
    // The reducer must stay pure and MUST NOT evict here. Forward secrecy does not
    // depend on it: the B12 reject-committed-revoked-signer gate (above) is the
    // primary, load-bearing write-exclusion. Best-effort writer-seat eviction is
    // performed HOST-SIDE in the DEVICE_REVOKE dispatcher, gated on the target
    // being currently live/connected, and skipped+deferred when it is offline.
    // Mark the sealed device record revoked. revokedAtLamport is the
    // reorg-safe field _rebuildAuthFromView reads back (the wall-clock
    // revokedAt is kept only as human-facing metadata for DEVICE_LIST).
    const deviceBlindId = this.ctx.crypto.blindId(this.indexKey, 'device:' + body.deviceId)
    const existing = await this.view.getSealedRaw(this.view.devicesKey(deviceBlindId))
    if (existing) {
      let plain
      try { plain = this.view.openRecord({ objectId: 'device:' + body.deviceId, envelope: existing }) } catch (_) { plain = null }
      if (plain) {
        plain.revokedAt = Date.now()
        plain.revokedAtLamport = opLamport
        await this.view.putDevice(batch, {
          objectId: 'device:' + body.deviceId, deviceBlindId, device: plain
        })
      }
    }
  }

  // KEY_ROTATE reducer (design §3.4/§3.5/§3.5.1, RT-FIX B3/B5/B6/B10/B11). The
  // caller already checked the signer is an authorized admin. Self-contained per
  // op: this device opens ITS OWN lockbox from the PUBLIC `wraps` using only its
  // box secret key (no dependency on any prior epoch key — B11), then decrypts
  // the body sealed under the NEW key (B3/B10). Every wrap is persisted as an
  // `epochkeys!` row keyed by `epochTag` (B5) so offline survivors and reboots
  // reconstruct the chain and concurrent rotations never collide. The active
  // epoch advances monotonically (max); the active TAG follows the Lamport
  // winner, re-validated against committed revocations (B6).
  async _applyKeyRotate (op, batch) {
    const ctx = this.ctx
    const h = op.header
    const epochTag = String(h.epochTag || '')
    const epochInt = Number(h.epoch || 0)
    // A legacy/cosmetic KEY_ROTATE (no epochTag/wraps) is a Phase-1-shaped op:
    // keep the monotone keyEpoch bump + vault-state persist so a mixed-version
    // log still linearizes, but it activates no real epoch (no key to unwrap).
    //
    // `wraps` is a PUBLIC, top-level op field (NOT in the encrypted body — B11):
    // an array of { blindId, sealed } where each `sealed` is a crypto_box_seal of
    // epochKey_{N+1} to one survivor's box pubkey. Public is safe: an attacker
    // cannot forge a wrap that hands the revoked device the key (that needs
    // epochKey_{N+1}, which only survivors+admin hold), and the revoked device's
    // box pubkey simply has no wrap. Carried outside the signed preimage by
    // design — the durable `epochkeys!` rows the reducer writes from it are the
    // reorg-safe channel; integrity rests on the sealed-box construction itself.
    const wraps = Array.isArray(op.wraps) ? op.wraps : []
    this.keyEpoch = Math.max(this.keyEpoch, epochInt)

    if (epochTag && wraps.length && this.myDeviceId && this.indexKey) {
      // (B11) Find + open THIS device's lockbox from the public wraps using ONLY
      // the box secret key. The wrap is addressed by a blinded id so the roster
      // is not enumerable from the op (B10).
      const wantBlind = ctx.crypto.blindId(this.indexKey, 'epochwrap:' + epochTag + ':' + this.myDeviceId)
      const mine = wraps.find((w) => w && w.blindId === wantBlind)
      if (mine && this.myBoxPubkey && this.myBoxSecretKey && ctx.identity) {
        try {
          const key = ctx.identity.openSealedToDevice(this.myBoxPubkey, this.myBoxSecretKey, mine.sealed)
          // In-batch incremental set so a later op in THIS batch can seal/open
          // under the new tag; the authoritative map is rebuilt from the view.
          this.epochKeys.set(epochTag, key)
          // Persist the freshly-unwrapped key to the local-only blob (design
          // §5.9) so a fresh unlock recovers it even before re-reading the wrap
          // rows. Best-effort: a lightweight test ctx has no vaultStore.
          this._persistEpochKeyLocal(epochTag, key, epochInt)
        } catch (_) { /* not our wrap / not entitled — pending-gap (§3.10) */ }
      }
      // else: this device is the revoked target or not entitled — record nothing
      // (no key written), so it never obtains epochKey_{N+1} (forward secrecy).

      // (B5) Persist EVERY wrap as an `epochkeys!` row keyed by epochTag so the
      // committed view is the reorg-safe source of truth: offline survivors get
      // their lockbox on return, reboots rebuild the chain, and two concurrent
      // rotations coexist without one overwriting the other.
      for (const w of wraps) {
        if (!w || !w.blindId || !w.sealed) continue
        await this.view.putEpochKeyWrap(batch, {
          epochTag, epoch: epochInt, blindId: String(w.blindId), sealed: String(w.sealed)
        })
      }
    }

    // ---- winner selection by epochTag (design §3.5) -----------------------
    // The integer is a monotone ordering hint only; the ACTIVE TAG content-
    // addresses the key new writes seal under. Pick the winner deterministically
    // by Lamport.beats (lamport, then deviceId), comparing this rotation against
    // the currently-recorded winner so the choice is order-insensitive across
    // concurrent rotations applied in either order.
    const prevActiveEpoch = this.activeEpoch || 0
    const prevActiveTag = this.activeEpochTag || ''
    let winnerTag = prevActiveTag
    let winnerLamport = this._activeWinnerLamport || 0
    let winnerDevice = this._activeWinnerDevice || ''
    const incoming = { lamport: Number(h.lamport), deviceId: String(h.deviceId || '') }
    // A real (tagged) rotation can win the active tag; a cosmetic one never does.
    if (epochTag && epochInt >= prevActiveEpoch) {
      if (epochInt > prevActiveEpoch ||
          ctx.ops.Lamport.beats(incoming, { lamport: winnerLamport, deviceId: winnerDevice })) {
        winnerTag = epochTag
        winnerLamport = incoming.lamport
        winnerDevice = incoming.deviceId
      }
    }
    this.activeEpoch = Math.max(prevActiveEpoch, epochInt)
    this.activeEpochTag = winnerTag
    this._activeWinnerLamport = winnerLamport
    this._activeWinnerDevice = winnerDevice

    // (B6) Re-validate the WINNING rotation's wrap set against EVERY device
    // revoked in the committed view. If the winner sealed the active key to a
    // now-committed-revoked device (e.g. a concurrent revoke of a different
    // device the winner's admin had not yet seen), forward secrecy against that
    // device is defeated: mark the active tag PROVISIONAL and flag that a fresh
    // rotation must be chained (consumed host-side, §3.5.1). New content still
    // seals under the provisional winner until the chained rotation lands.
    let provisional = false
    if (winnerTag) {
      try {
        const wrapBlinds = await this.view.listEpochKeyWrapBlindIds(winnerTag)
        for (const d of this.devices.values()) {
          if (d.revokedAtLamport == null) continue
          const b = ctx.crypto.blindId(this.indexKey, 'epochwrap:' + winnerTag + ':' + d.deviceId)
          if (wrapBlinds.has(b)) { provisional = true; break }
        }
      } catch (_) { provisional = false }
    }
    this._activeEpochProvisional = provisional

    // Persist reorg-safely. rootPubkey is carried from the rebuild so the
    // vault-state row is never clobbered to a missing root. keyEpoch stays the
    // legacy monotone counter; activeEpoch/activeEpochTag are the real winner.
    // The winner's lamport/deviceId + the provisional flag persist too so the
    // selection is recomputed deterministically from the committed view (B5/B6).
    await this.view.putVaultState(batch, {
      rootPubkey: this.rootPubkey,
      keyEpoch: this.keyEpoch,
      activeEpoch: this.activeEpoch,
      activeEpochTag: this.activeEpochTag,
      activeEpochLamport: winnerLamport,
      activeEpochDevice: winnerDevice,
      activeEpochProvisional: provisional
    })

    // Signal the topic-swap / relay-reseed / chained-rotation schedulers
    // (reconciled from committed state, NEVER fired imperatively from inside the
    // pure reducer — design §3.4 step 6 / §3.5.1).
    try {
      ctx.emit('epoch-rotated', {
        epoch: this.activeEpoch,
        epochTag: this.activeEpochTag,
        provisional
      })
    } catch (_) {}
  }

  // Persist a newly-unwrapped epoch key into the local-only device blob so a
  // fresh unlock recovers it without re-reading the committed wrap rows (design
  // §5.9). Keyed by epochTag (never the integer — B5). Best-effort and additive:
  // a lightweight test ctx (no vaultStore.saveVaultSecrets / no unlock secret)
  // simply skips — the engine still rebuilds epochKeys from the committed view.
  _persistEpochKeyLocal (epochTag, key, epochInt) {
    const ctx = this.ctx
    const vs = ctx.vaultStore
    const dev = ctx.state && ctx.state.device
    const unlock = ctx.state && ctx.state._unlockSecret
    if (!vs || typeof vs.saveVaultSecrets !== 'function' || !dev || !unlock) return
    if (!ctx.state.vaultKeys || !ctx.state.vaultKeys.vaultKey) return
    try {
      const existing = (ctx.state._epochKeysLocal && typeof ctx.state._epochKeysLocal === 'object')
        ? ctx.state._epochKeysLocal
        : {}
      existing[epochTag] = b4a.toString(key, 'hex')
      ctx.state._epochKeysLocal = existing
      vs.saveVaultSecrets(dev, unlock, {
        vaultId: ctx.state.vaultId,
        vaultKey: ctx.state.vaultKeys.vaultKey,
        indexKey: ctx.state.vaultKeys.indexKey,
        deviceAdminSeed: ctx.state.vaultKeys.deviceAdminSeed,
        epochKeys: existing,
        followSeed: ctx.state._followSeed
      })
    } catch (_) { /* best-effort; view rebuild is the durable source */ }
  }

  async _applyNoteUpsert (op, batch) {
    const ops = this.ctx.ops
    const h = op.header
    const obid = h.objectBlindId
    const body = this._bodyOrNull(op) // NotePlaintext (full note, whole-note LWW)
    if (body === null) {
      // This device lacks the op's epoch key (revoked, or transiently behind).
      // Store the op's OWN sealed envelope verbatim so the op linearizes,
      // replicates, and persists sealed (a key-holder reads it later); we cannot
      // build the plaintext row or local search entry, so skip both. Never throw.
      await this.view.putNoteSealedRaw(batch, { objectBlindId: obid, envelope: op.envelope })
      return
    }
    const objectId = 'note:' + body.noteId
    const incoming = { lamport: Number(h.lamport), deviceId: h.deviceId }

    // [RT-FIX B9] Durable tombstone gate: an upsert that does not BEAT the
    // committed delete marker by Lamport is a stale replay (or a remote
    // reconciler's re-append of a row another device deleted) — drop it. A
    // genuinely NEWER upsert (the user re-created the object) wins and
    // SUPERSEDES the tombstone, which is removed so the object lives again.
    const tomb = await this.view.getTombstone(obid)
    if (tomb) {
      const tombLww = { lamport: Number(tomb.lamport) || 0, deviceId: tomb.deviceId || '' }
      if (!ops.Lamport.beats(incoming, tombLww)) return
      await batch.del(this.view.tombstoneKey(obid))
    }

    const existingEnv = await this.view.getNoteSealed(obid)
    if (existingEnv) {
      let cur
      try { cur = this.view.openRecord({ objectId, envelope: existingEnv }) } catch (_) { cur = null }
      if (cur && cur.__lww) {
        const winner = ops.Lamport.beats(incoming, cur.__lww)
        if (!winner) return // existing record wins (spec §9.5)
      }
    }
    const stored = { ...body, __lww: incoming }
    await this.view.putNote(batch, { objectId, objectBlindId: obid, note: stored })
    await this.view.putObjMeta(batch, { objectId, objectBlindId: obid, type: 'note' })
    // local-only search index (titles/body tokens never leave device)
    await this.localSearch.indexObject({
      objectId,
      objectBlindId: obid,
      type: 'note',
      texts: body.deletedAt ? [] : [body.title, body.body, ...(body.tags || [])]
    })
  }

  async _applyNoteDelete (op, batch) {
    const h = op.header
    const obid = h.objectBlindId
    const body = this._bodyOrNull(op) // { noteId, hard?:bool }
    if (body === null) return // cannot read the delete (no epoch key) — skip local mutation, never throw
    const objectId = 'note:' + body.noteId
    // [RT-FIX B9] Durable tombstone — written UNCONDITIONALLY (even when this
    // device holds no row yet, so an out-of-order upsert arriving later still
    // meets the marker). Carries the delete's Lamport identity for the
    // supersede comparison in _applyNoteUpsert; consulted by _rowPresentFor so
    // no reconciler ever re-appends a deleted row.
    await this.view.putTombstone(batch, { objectBlindId: obid, lamport: Number(h.lamport), deviceId: h.deviceId })
    const existingEnv = await this.view.getNoteSealed(obid)
    if (!existingEnv) return
    if (body.hard) {
      await batch.del(this.view.notesKey(obid))
      await this.localSearch.removeObject(obid)
      return
    }
    let cur
    try { cur = this.view.openRecord({ objectId, envelope: existingEnv }) } catch (_) { cur = null }
    if (!cur) return
    cur.deletedAt = Date.now()
    cur.__lww = { lamport: Number(h.lamport), deviceId: h.deviceId }
    await this.view.putNote(batch, { objectId, objectBlindId: obid, note: cur })
    await this.localSearch.removeObject(obid)
  }

  async _applyClipAdd (op, batch) {
    const h = op.header
    const obid = h.objectBlindId
    const body = this._bodyOrNull(op) // ClipPlaintext
    if (body === null) {
      // No epoch key for this clip: persist the op's sealed envelope verbatim
      // keyed by (createdAtBucket, blindId) so it linearizes + replicates, and
      // skip the unreadable plaintext row / objmeta. Never throw out of _apply.
      await this.view.putClipSealedRaw(batch, { bucket: h.createdAtBucket, objectBlindId: obid, envelope: op.envelope })
      return
    }
    const objectId = 'clip:' + body.clipId
    const incoming = { lamport: Number(h.lamport), deviceId: h.deviceId }
    // [RT-FIX B9] Same durable-tombstone gate as notes: a clip add that does
    // not beat a committed delete marker is dropped; a newer one supersedes.
    const tomb = await this.view.getTombstone(obid)
    if (tomb) {
      const tombLww = { lamport: Number(tomb.lamport) || 0, deviceId: tomb.deviceId || '' }
      if (!this.ctx.ops.Lamport.beats(incoming, tombLww)) return
      await batch.del(this.view.tombstoneKey(obid))
    }
    await this.view.putClip(batch, {
      objectId,
      objectBlindId: obid,
      bucket: h.createdAtBucket,
      clip: { ...body, __lww: incoming }
    })
    await this.view.putObjMeta(batch, { objectId, objectBlindId: obid, type: 'clip' })
  }

  async _applyClipDelete (op, batch) {
    const h = op.header
    const body = this._bodyOrNull(op) // { clipId, bucket }
    if (body === null) return // cannot read the delete (no epoch key) — skip local mutation, never throw
    const obid = h.objectBlindId
    // [RT-FIX B9] Durable tombstone, mirroring _applyNoteDelete.
    await this.view.putTombstone(batch, { objectBlindId: obid, lamport: Number(h.lamport), deviceId: h.deviceId })
    if (body && body.bucket) await batch.del(this.view.clipsKey(body.bucket, obid))
  }

  // --- high-level append helpers (used by notes-service via ctx) -----------
  async _appendDeviceAdd (device, { selfRoot = false, signer, cosigs = [] } = {}) {
    const s = signer || this._localSigner()
    const rootPub = selfRoot ? s.signingPubkey : (this.rootPubkey || s.signingPubkey)
    const op = this._makeOp({
      type: this.ctx.ops.OP_TYPES.DEVICE_ADD,
      schema: this.ctx.ops.SCHEMAS.DEVICE,
      objectId: 'device:' + device.deviceId,
      payload: {
        selfRoot,
        rootPubkey: rootPub,
        // N-of-M admit cosignatures (design §3.8 step 2, B1): detached admin
        // signatures over the new device's identity tuple, verified by the
        // reducer against the committed admin set when policy N ≥ 2.
        cosigs,
        device: {
          deviceId: device.deviceId,
          label: device.label,
          platform: device.platform,
          signingPubkey: device.signingPubkey,
          boxPubkey: device.boxPubkey,
          roles: device.roles || ['admin', 'writer', 'reader'],
          writerKey: device.writerKey || b4a.toString(this.base.local.key, 'hex'),
          createdAt: Date.now()
        }
      },
      signer: s
    })
    await this._append(op)
  }

  _localSigner () {
    const d = this.ctx.state.device
    if (!d || !d.signingSecretKey) {
      const e = new Error('vault locked / no device signer'); e.code = 'VAULT_LOCKED'; throw e
    }
    return d
  }

  // public op append used by notes-service
  async appendOp (type, schema, objectId, payload) {
    // Block briefly until our writer seat has linearized so a freshly paired
    // device's first content op doesn't throw "Not writable" and get lost
    // (CRITICAL #2). Done BEFORE _makeOp so a not-yet-writable append never
    // burns a Lamport tick / leaves a clock gap. Throws NOT_WRITABLE_YET
    // (retryable) if the seat never converges within the bound.
    await this._awaitWritable()
    const op = this._makeOp({ type, schema, objectId, payload, signer: this._localSigner() })
    // Track additive content BEFORE the append so the durability reconciler
    // (FRESH-WRITER ORPHAN fix) owns it even if a migration rolls its view row
    // back milliseconds later. Re-keyed by objectBlindId so a same-object
    // re-upsert just refreshes the pending payload (no duplicate tracking).
    if (this._isAdditiveContentOp(type)) {
      this._pendingDurable.set(op.header.objectBlindId, {
        type,
        schema,
        objectId,
        payload,
        bucket: op.header.createdAtBucket,
        // The op's ORIGINAL epoch identity (design §3.9, B4): a later
        // durability re-append re-seals under THIS tag, not the active one.
        epochTag: op.header.epochTag || '',
        epoch: op.header.epoch || '0',
        tries: 0
      })
    } else if (this._isDeleteContentOp(type)) {
      // A delete supersedes any pending durability re-append for this object —
      // otherwise the reconciler could re-materialize a row the user just
      // (hard-)deleted within the fresh-writer window. The delete op is itself
      // serialized + durable in the log; the tombstone reducer re-applies it on
      // any reorg, so the delete needs no durability tracking of its own.
      this._pendingDurable.delete(op.header.objectBlindId)
    }
    await this._append(op)
    await this.base.update()
    // NB: we do NOT retire the pending entry here even if the row looks present
    // now. The indexer-migration rollback is ASYNCHRONOUS — the row can be
    // present immediately after update() and then vanish seconds later when a
    // remote indexer's ack finalizes the migration. Retirement is owned solely
    // by _reconcileDurability, which only drops an entry once the row is present
    // AND stable (past the fresh-writer window, or observed present across
    // several passes), so a transient post-append presence can never strand a
    // write that a later reorg rolls back.
    return op.header.objectBlindId
  }

  // True iff this op type writes an additive row whose post-state is PRESENCE
  // of a materialized view row (so absence later == a rolled-back loss we should
  // re-append). Deletes intentionally remove rows, so they are excluded.
  _isAdditiveContentOp (type) {
    const T = this.ctx.ops.OP_TYPES
    return type === T.NOTE_UPSERT || type === T.CLIP_ADD
  }

  // Delete ops cancel any pending durability re-append for their object (see
  // appendOp) so the reconciler never resurrects a just-deleted row.
  _isDeleteContentOp (type) {
    const T = this.ctx.ops.OP_TYPES
    return type === T.NOTE_DELETE || type === T.CLIP_DELETE
  }

  // Read back the committed-view row for an additive op by (type, blindId,
  // bucket). Presence here is the post-state the reconciler watches: a NOTE_UPSERT
  // / CLIP_ADD row that is absent after its op was applied has been rolled back.
  async _rowPresentFor (type, objectBlindId, bucket) {
    if (!this.view) return false
    const T = this.ctx.ops.OP_TYPES
    try {
      // [RT-FIX B9] A TOMBSTONED object counts as present/settled: its absence
      // from the live rows is the result of a durable cross-device DELETE, not
      // a migration rollback. Without this check a remote device's reconciler
      // would re-append (with a fresh, winning Lamport) a row some other
      // device deleted — resurrecting it vault-wide.
      if (await this.view.isTombstoned(objectBlindId)) return true
      if (type === T.NOTE_UPSERT) {
        return !!(await this.view.getNoteSealed(objectBlindId))
      }
      if (type === T.CLIP_ADD) {
        return !!(await this.view.getSealedRaw(this.view.clipsKey(bucket, objectBlindId)))
      }
    } catch (_) { return false }
    return false
  }

  // True while a fresh-writer integration could still be migrating the apply
  // state (and thus rolling content rows out of the view). Adding an indexer
  // bumps _lastWriterAddedAt; the window is generous because the remote device's
  // ack — which finalizes the migration — arrives on ITS schedule (its periodic
  // update loop), not ours, so the rollback can land seconds after our append.
  _inFreshWriterWindow () {
    return (Date.now() - (this._lastWriterAddedAt || 0)) < 30000
  }

  // Durability reconciler (FRESH-WRITER ORPHAN / SILENT NOTE-LOSS fix). Called
  // from the background convergence loop. For each additive content op this
  // device appended whose view row is currently MISSING from the committed
  // view, re-append it (idempotent upsert with a fresh Lamport so it
  // deterministically re-materializes over the rolled-back state). Rows that are
  // present are retired from the pending set. This runs continuously, so it
  // closes the gap even when the indexer-migration rollback lands asynchronously
  // — long after appendOp returned — which a point-in-time confirm cannot catch.
  // Bounded re-appends per op (so a genuinely un-converging base can't churn
  // unbounded) but the cap only advances when we ACT, and is generous; once the
  // migration settles the very next pass observes the row and retires it.
  async _reconcileDurability () {
    if (!this.base || this._closing || !this.view) return
    if (this._pendingDurable.size === 0) return
    const stable = !this._inFreshWriterWindow()
    for (const [obid, rec] of [...this._pendingDurable]) {
      if (!this.base || this._closing) return
      let present = false
      try { present = await this._rowPresentFor(rec.type, obid, rec.bucket) } catch (_) { present = false }
      if (present) {
        // Retire ONLY once the row has been CONTINUOUSLY present long enough to
        // outlast an in-flight indexer migration (the rollback is asynchronous —
        // a row can show present then vanish when a remote ack finalizes the
        // migration). A sustained present-streak is the reliable signal; a single
        // transient presence must not retire the entry. ~10 passes at the
        // tightened 300ms cadence (~3s) comfortably exceeds observed migration
        // settle time, and we additionally require being past the fresh-writer
        // window so no further migration is imminent.
        rec.presentStreak = (rec.presentStreak || 0) + 1
        if (stable && rec.presentStreak >= 6) this._pendingDurable.delete(obid)
        continue
      }
      // Missing -> rolled back (or not yet flushed). Reset the streak and
      // re-append (idempotent upsert, fresh Lamport) while writable. The attempt
      // cap is generous and only advances when we actually re-append, so a
      // long-running migration can't exhaust it before settling; once the
      // migration finishes the very next pass sees the row and retires it.
      rec.presentStreak = 0
      if (!this.base.writable) continue
      if ((rec.tries || 0) >= 12) continue
      // [design §3.9 step 4] Belt-and-suspenders: while a fresh-writer
      // migration may still be in flight, do NOT re-append rows from an epoch
      // OLDER than the active one — the rotation that superseded their epoch
      // may itself still be settling, and pulling old-epoch rows through the
      // churn is exactly the B4-shaped surface. Once the window passes they
      // re-append normally (epoch-faithfully, below).
      if (!stable && (rec.epochTag || '') !== (this.activeEpochTag || '')) continue
      rec.tries = (rec.tries || 0) + 1
      try {
        const reop = this._makeOp({
          type: rec.type,
          schema: rec.schema,
          objectId: rec.objectId,
          payload: rec.payload,
          signer: this._localSigner(),
          // EPOCH-FAITHFUL re-append (B4): re-seal under the row's ORIGINAL
          // epoch, never the active one (see _makeOp).
          epochTag: rec.epochTag != null ? rec.epochTag : '',
          epoch: rec.epoch != null ? rec.epoch : '0'
        })
        // Re-append through the serialized chain but do NOT await base.update()
        // here: update() can block for the full duration of an in-flight
        // migration, which would stall the whole reconcile pass after a single
        // entry. The background loop pumps update()/refresh() between passes, so
        // the next pass observes the re-materialized row. Race a short timeout so
        // a base wedged mid-migration (base.append can block until it resolves)
        // can never freeze the convergence loop — we just retry on the next pass.
        await Promise.race([
          this._append(reop),
          new Promise((resolve) => { const t = setTimeout(resolve, 1500); if (t.unref) t.unref() })
        ])
      } catch (_) { /* not writable mid-migration / closing — next pass re-checks */ }
    }
  }

  // Coalesced: a burst of concurrent callers (RPC handlers + the convergence
  // loop) costs at most TWO base.update() passes instead of N. A caller that
  // arrives mid-flight is NOT handed the in-flight promise — that update may
  // predate ops the caller expects to observe (e.g. "freshest device/epoch
  // state before minting"). Instead every mid-flight caller shares ONE queued
  // follow-up pass that starts after the current one finishes, so each caller
  // always observes an update that began at-or-after its call.
  async refresh () {
    if (!this.base) return
    if (this._refreshPending) return this._refreshPending
    if (this._refreshing) {
      this._refreshPending = this._refreshing.catch(() => {}).then(() => {
        this._refreshPending = null
        return this.refresh()
      })
      return this._refreshPending
    }
    this._refreshing = Promise.resolve(this.base.update()).finally(() => {
      this._refreshing = null
    })
    return this._refreshing
  }

  verifierDeviceSet () {
    const out = new Map()
    if (this.rootPubkey) {
      out.set(this.rootPubkey, {
        signingPubkey: this.rootPubkey,
        revokedEpoch: null,
        roles: ['admin']
      })
    }
    for (const d of this.devices.values()) {
      if (!d.signingPubkey) continue
      out.set(d.signingPubkey, {
        signingPubkey: d.signingPubkey,
        revokedEpoch: d.revokedAtLamport,
        roles: d.roles || []
      })
    }
    return out
  }

  async listReplicatedOps () {
    return Array.from(this._appliedOps.values())
  }

  // Resolve when the Autobase engine + Hyperbee views are open and usable.
  // Re-armed on every 'locked' so a lock->unlock cycle waits for the *new*
  // open() rather than resolving against the torn-down engine. Throws
  // NOT_READY only if readiness does not arrive within `timeoutMs` (e.g. the
  // vault is locked and never re-opens) so handlers degrade instead of hang.
  ready (timeoutMs = 15000) {
    if (this._opened) return Promise.resolve()
    const gate = this._readyPromise || Promise.reject(Object.assign(new Error('sync engine not ready'), { code: 'NOT_READY' }))
    if (timeoutMs == null || timeoutMs === Infinity) return gate
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        const e = new Error('sync engine not ready (timeout)'); e.code = 'NOT_READY'
        reject(e)
      }, timeoutMs)
      if (timer.unref) timer.unref()
      gate.then(() => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }, (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}

// ---- attach -----------------------------------------------------------------
export async function attach (ctx) {
  const { COMMANDS } = await import('./rpc.js')
  const engine = new SyncEngine(ctx)
  const pairing = ctx.pairing
  ctx.sync = engine // notes-service consumes ctx.sync

  // cache vault header (autobaseKey) for bootstrap key resolution
  async function cacheHeader () {
    try { ctx.state._vaultHeaderCache = await ctx.vaultStore.getVaultHeader() } catch (_) {}
  }

  // Readiness gate. index.js (frozen) emits 'unlocked' synchronously and
  // returns BEFORE engine.open() (async) finishes, so NOTE_*/CLIP_*/SEARCH/
  // DEVICE_* handlers can arrive while engine._opened is still false. Instead
  // of throwing NOT_READY, handlers `await engine.ready()` on this promise.
  // It is re-armed on 'locked' so a lock->unlock cycle blocks on the *next*
  // open() rather than resolving against the torn-down engine.
  function armReady () {
    // If a previous gate is still unsettled, reject it so nothing waits on an
    // abandoned promise; a re-issued handler call grabs the fresh gate.
    if (engine._rejectReady) {
      const e = new Error('sync engine re-arming'); e.code = 'NOT_READY'
      try { engine._rejectReady(e) } catch (_) {}
    }
    engine._readyPromise = new Promise((resolve, reject) => {
      engine._resolveReady = resolve
      engine._rejectReady = reject
    })
    // never an unhandled rejection if nothing awaits before a re-arm/resolve
    engine._readyPromise.catch(() => {})
  }
  armReady()

  let _opening = false
  async function openEngine () {
    if (!ctx.isUnlocked()) return
    if (engine._opened) { // already open (redundant unlock) — just satisfy gate
      if (engine._resolveReady) engine._resolveReady()
      return
    }
    if (_opening) return // coalesce concurrent unlock spawns
    _opening = true
    await cacheHeader()
    try {
      await engine.open()
      if (engine._resolveReady) engine._resolveReady()
      ctx.emit('sync-ready')
    } catch (err) {
      ctx.log.error('sync-open-failed', { err: String((err && err.message) || err) })
      // reject the current gate then re-arm so a later unlock can retry.
      if (engine._rejectReady) {
        const e = new Error('sync engine failed to open'); e.code = 'NOT_READY'
        engine._rejectReady(e)
      }
      armReady()
    } finally {
      _opening = false
    }
  }

  // open on unlock, tear down on lock (no decrypted material survives lock)
  ctx.on('unlocked', () => { ctx.scope.spawn(() => openEngine(), 'sync-open') })
  ctx.on('locked', () => {
    armReady() // re-arm BEFORE close so an in-flight handler waits for re-open
    ctx.scope.spawn(() => engine.close(), 'sync-close')
  })
  if (ctx.isUnlocked()) await openEngine()

  // background convergence loop: EVENT-DRIVEN with a slow heartbeat fallback.
  // Autobase subscribes to every writer core's 'append' and auto-bumps, then
  // emits 'update' when linearized state changed — so remote data wakes this
  // loop within one debounce window instead of waiting out a poll interval.
  // The pass itself runs refresh() PLUS durability reconciliation (FRESH-
  // WRITER ORPHAN fix): re-materialize any of this device's additive content
  // rows that an asynchronous indexer-migration rolled out of the view.
  // Cadence: 300ms while durability work is pending; a 250ms debounce after
  // an 'update' wake (coalesces bursts and prevents self-wake spin from our
  // own refresh()); and a 10s idle heartbeat as the safety net for any path
  // that delivers blocks without surfacing 'update' (e.g. sparse wakeups).
  // Cancellable via scope.signal (spec §22).
  ctx.scope.spawn(async (scope) => {
    const IDLE_HEARTBEAT_MS = 10000
    const WAKE_DEBOUNCE_MS = 250
    const PENDING_MS = 300
    let dirty = false
    let wakeResolve = null
    const wake = () => {
      dirty = true
      if (wakeResolve) { const r = wakeResolve; wakeResolve = null; r() }
    }
    let attachedBase = null
    const detach = () => {
      if (attachedBase) {
        try { attachedBase.off('update', wake) } catch (_) {}
        attachedBase = null
      }
    }
    while (!scope.cancelled) {
      let pending = 0
      try {
        if (engine._opened) {
          // (Re)attach the wake listener whenever a lock/unlock cycle gave the
          // engine a fresh base instance.
          if (engine.base && engine.base !== attachedBase) {
            detach()
            attachedBase = engine.base
            attachedBase.on('update', wake)
          }
          dirty = false // events during OUR pass re-mark it
          await engine.refresh()
          await engine._reconcileDurability()
          pending = engine._pendingDurable ? engine._pendingDurable.size : 0
        }
      } catch (_) {}
      try {
        if (pending > 0) {
          await scope.sleep(PENDING_MS)
        } else if (dirty) {
          await scope.sleep(WAKE_DEBOUNCE_MS)
        } else {
          const woken = new Promise((resolve) => { wakeResolve = resolve })
          await Promise.race([scope.sleep(IDLE_HEARTBEAT_MS), woken])
          wakeResolve = null
          if (dirty && !scope.cancelled) await scope.sleep(WAKE_DEBOUNCE_MS)
        }
      } catch (_) { break }
    }
    detach()
  }, 'sync-converge')

  ctx.scope.onClose(async () => { await engine.close() })

  // ---- PAIR_ACCEPT (spec §14 steps 3-8) ----------------------------------
  // New device side: decode invite, join the temporary pairing topic on the
  // ONE swarm, run a Noise/Secretstream channel over the raw connection,
  // exchange the confirmation phrase, receive the sealed bootstrap, persist
  // vault keys, then start sync. The existing device's PAIR_CREATE_INVITE
  // handler (foundation) stashed the ephemeral box keypair; here the *new*
  // device generates its own box keypair and the existing device seals to it.
  ctx.dispatcher.register(COMMANDS.PAIR_ACCEPT, async ({ invite, label, platform, unlockSecret = '' }) => {
    const pairing = ctx.pairing
    const identity = ctx.identity
    const decoded = pairing.decodeInvite(invite) // throws if expired (§14)
    if (ctx.isUnlocked()) {
      const e = new Error('lock this device before joining another vault')
      e.code = ctx.ops.ERROR_CODES.ALREADY_UNLOCKED
      throw e
    }
    if (!decoded.autobaseKey) {
      const e = new Error('pairing invite is missing sync bootstrap metadata')
      e.code = 'BAD_INVITE'
      throw e
    }
    if (!String(unlockSecret || '').trim()) {
      const e = new Error('choose an unlock passphrase for this device before pairing')
      e.code = ctx.ops.ERROR_CODES.SCHEMA_INVALID
      throw e
    }

    // new device identity (its box pubkey is what the existing device seals to)
    const newDevice = identity.createDeviceIdentity({
      label: label || 'paired',
      platform: platform || 'unknown',
      roles: ['writer', 'reader']
    })
    const writerKey = b4a.toString(
      await Autobase.getLocalKey(ctx.vaultStore.namespace(NAMESPACES.AUTOBASE)),
      'hex'
    )
    const hello = {
      t: 'pp-pair-hello',
      v: 1,
      invitePubkey: decoded.invitePubkey,
      expiresAt: decoded.expiresAt,
      deviceId: newDevice.deviceId,
      label: newDevice.label,
      platform: newDevice.platform,
      roles: newDevice.roles,
      signingPubkey: newDevice.signingPubkey,
      boxPubkey: newDevice.boxPubkey,
      writerKey
    }
    hello.signature = ctx.crypto.signDetached(
      newDevice.signingSecretKey,
      pairing.helloProofPayload(hello)
    )
    const expectedConfirmation = pairing.confirmationPhraseForHello(hello)

    const topic = decoded.topic
    ctx.state._acceptingPairTopic = topic

    // Warm up at least one HiveRelay before announcing the pair topic — with
    // a relay connected, Hyperswarm's relay-circuit transport can broker the
    // rendezvous when DHT/UDX can't hole-punch (the smoke test on a healthy
    // fleet showed t+5s for the first relay; 8 s gives headroom). Never
    // throws — degrades to DHT-only when no relay connects in time.
    ctx.log.info('pair-accept-start', {
      topicPrefix: b4a.toString(topic, 'hex').slice(0, 16),
      swarmPubkey: decoded.swarmPubkey ? decoded.swarmPubkey.slice(0, 16) : null,
      relayHintsCount: (decoded.relayHints || []).length
    })
    if (ctx.relay && typeof ctx.relay.waitForFirstConnected === 'function') {
      const n = await ctx.relay.waitForFirstConnected({ timeoutMs: 8000 })
      ctx.log.info('pair-accept-relay-ready', { connectedRelays: n })
    }

    const bootstrap = await new Promise((resolve, reject) => {
      // 90 s — first-time DHT rendezvous + UDX hole-punching across asymmetric
      // networks (Wi-Fi ↔ carrier-grade NAT on cellular) can take well over the
      // 30 s the original timeout allowed, and a backgrounded source app pauses
      // its sockets until it foregrounds. Users perceive "pairing failed" long
      // before the spec's recovery kicks in if we bail too early.
      const timer = setTimeout(() => { cleanup(); reject(new Error('pairing timed out — keep both devices unlocked and foregrounded, then retry')) }, 90000)
      // Track which connections we've already greeted so we don't double-hello
      // (the connection event can sometimes fire twice as topics get associated).
      const greeted = new WeakSet()
      const onConn = async (conn, info) => {
        const topics = info && Array.isArray(info.topics) ? info.topics : []
        const matchesTopic = topics.length === 0 || topics.some(t => b4a.equals(b4a.from(t), topic))
        ctx.log.info('pair-accept-conn', {
          topicCount: topics.length,
          matchesTopic,
          remotePub: info && info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : null
        })
        // Previously we only wrote hello if matchesTopic. But Hyperswarm's
        // info.topics surfaces only the topic via which the peer was DISCOVERED;
        // if the inviter happened to be discovered via the shared relay-
        // discovery topic (both peers auto-discover relays) before the pair-
        // topic association propagated, the connection arrives with non-pair
        // topics and we'd skip writing hello. The cure was worse than the
        // disease: pair just hangs silently.
        //
        // The inviter side gates on ctx.state._pendingInvite, not topic match,
        // and rejects anything that isn't a valid `pp-pair-hello`. Misdirected
        // hellos just get ignored. So during the pair window, write hello to
        // EVERY new connection — at most a few extra small writes per pair.
        if (greeted.has(conn)) return
        greeted.add(conn)
        try {
          // send our signed pairing hello (identity + writer key + invite proof)
          conn.write(b4a.from(JSON.stringify(hello)))
          ctx.log.info('pair-accept-hello-sent', { matchesTopic, topicCount: topics.length })
          let buf = b4a.alloc(0)
          conn.on('data', (d) => {
            buf = b4a.concat([buf, d])
            let msg
            try { msg = JSON.parse(b4a.toString(buf)) } catch (_) { return }
            if (msg.t === 'pp-pair-error') {
              clearTimeout(timer)
              cleanup()
              const e = new Error(msg.message || 'pairing rejected')
              e.code = msg.code || 'PAIRING_REJECTED'
              reject(e)
              return
            }
            if (msg.t === 'pp-pair-bootstrap') {
              clearTimeout(timer)
              cleanup()
              try {
                if (msg.deviceId !== newDevice.deviceId) {
                  const e = new Error('pairing admitted a different device')
                  e.code = ctx.ops.ERROR_CODES.BAD_PAIRING_PROOF
                  throw e
                }
                if (msg.confirmation !== expectedConfirmation) {
                  const e = new Error('pairing confirmation mismatch')
                  e.code = ctx.ops.ERROR_CODES.BAD_PAIRING_PROOF
                  throw e
                }
                const bs = pairing.openBootstrap({
                  boxPubkey: newDevice.boxPubkey,
                  boxSecretKey: newDevice.boxSecretKey,
                  sealed: msg.sealed
                })
                resolve({ bs, conn })
              } catch (e) { reject(e) }
            }
          })
          conn.on('error', () => {})
        } catch (e) { cleanup(); reject(e) }
      }
      // Relay-rendezvous fallback (spec §11). 8 s gives DHT/UDX a clean first
      // try; if it hasn't surfaced a connection by then we ask each HiveRelay
      // the inviter named (decoded.relayHints) to broker a circuit-relay to
      // the inviter's swarm pubkey (decoded.swarmPubkey). The brokered
      // connection appears on ctx.swarm and the onConn handler above runs
      // the normal hello/bootstrap exchange — no separate code path needed.
      // Idempotent / racy with DHT — whichever connects first wins.
      let fallbackTimer = null
      function cleanup () {
        ctx.swarm.removeListener('connection', onConn)
        ctx.swarm.leave(topic).catch(() => {})
        if (ctx.state._acceptingPairTopic === topic) ctx.state._acceptingPairTopic = null
        if (fallbackTimer) { clearTimeout(fallbackTimer); fallbackTimer = null }
      }
      // Wrap onConn so we log EVERY incoming connection (even ones we ignore
      // for topic mismatch) to help diagnose "DHT found peers but pair hung".
      const onConnLogged = (conn, info) => {
        const topics = info && Array.isArray(info.topics) ? info.topics : []
        const matchesTopic = topics.length === 0 || topics.some(t => b4a.equals(b4a.from(t), topic))
        ctx.log.info('pair-accept-conn', {
          topicCount: topics.length,
          matchesTopic,
          remotePub: info && info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : null
        })
        return onConn(conn, info)
      }
      ctx.swarm.on('connection', onConnLogged)
      const discovery = ctx.swarm.join(topic, { server: false, client: true })
      ctx.log.info('pair-accept-joined', { topicPrefix: b4a.toString(topic, 'hex').slice(0, 16) })
      discovery.flushed()
        .then(() => {
          ctx.log.info('pair-accept-flushed')
          return ctx.swarm.flush()
        })
        .then(() => ctx.log.info('pair-accept-swarm-flushed'))
        .catch((e) => { cleanup(); reject(e) })

      // Also patch cleanup() so it removes the LOGGED listener.
      const origCleanup = cleanup
      // eslint-disable-next-line no-func-assign
      cleanup = function () {
        ctx.swarm.removeListener('connection', onConnLogged)
        return origCleanup()
      }

      fallbackTimer = setTimeout(() => {
        ctx.log.info('pair-circuit-fallback-fire', {
          haveSwarmPub: !!decoded.swarmPubkey,
          haveCircuitConnect: !!(ctx.relay && typeof ctx.relay.circuitConnect === 'function')
        })
        if (!decoded.swarmPubkey) return // older invites without rendezvous data
        if (!ctx.relay || typeof ctx.relay.circuitConnect !== 'function') return
        ctx.relay.circuitConnect(decoded.swarmPubkey, { relayHints: decoded.relayHints || [] })
          .then((res) => {
            if (res && res.ok) ctx.log.info('pair-circuit-fallback-ok', { relay: res.relay && res.relay.slice(0, 16) })
            else ctx.log.info('pair-circuit-fallback-skip', { reason: res && res.reason })
          })
          .catch((err) => ctx.log.info('pair-circuit-fallback-error', { err: String((err && err.message) || err) }))
      }, 8000)
      if (fallbackTimer.unref) fallbackTimer.unref()
    })

    // persist vault keys delivered in the sealed bootstrap
    const bs = bootstrap.bs
    ctx.state.vaultId = bs.vaultId
    ctx.state.vaultKeys = {
      vaultKey: b4a.from(bs.vaultKey, 'hex'),
      indexKey: b4a.from(bs.indexKey, 'hex'),
      deviceAdminSeed: b4a.from(bs.deviceAdminSeed, 'hex')
    }
    ctx.state.device = {
      ...newDevice,
      signingSecretKey: newDevice.signingSecretKey
    }
    // Epoch chain delivered by the bootstrap (design §5.8 selective-chain,
    // Phase 4): a freshly paired device has NO committed wraps (lockboxes were
    // sealed to the then-survivors before it existed), so this delivered
    // chain — merged into engine.epochKeys by _rebuildAuthFromView — is its
    // only source for the active content key. followSeed makes the device
    // reachable on its follow topic from day one (design §4).
    ctx.state._unlockSecret = unlockSecret
    ctx.state._epochKeysLocal = (bs.epochKeys && typeof bs.epochKeys === 'object') ? { ...bs.epochKeys } : {}
    ctx.state._followSeed = bs.followSeed || null
    ctx.vaultStore.saveLocalDevice(newDevice, unlockSecret, {
      vaultId: ctx.state.vaultId,
      vaultKey: ctx.state.vaultKeys.vaultKey,
      indexKey: ctx.state.vaultKeys.indexKey,
      deviceAdminSeed: ctx.state.vaultKeys.deviceAdminSeed,
      epochKeys: ctx.state._epochKeysLocal,
      followSeed: ctx.state._followSeed
    })
    await ctx.vaultStore.putVaultHeader({
      ...(bs.vaultHeader || {}),
      autobaseKey: bs.autobaseKey
    })
    ctx.state.locked = false
    // The handshake itself succeeded by this point — vault keys, device
    // identity, and vault header are persisted. If the post-handshake bring-up
    // (joinVault / openEngine) throws on a platform-specific path (e.g. an
    // iOS Bare native-addon failure inside Autobase), surface it as a typed
    // RPC error with breadcrumbs instead of letting it bubble as an unhandled
    // rejection that could exit the worker and present the user with a
    // generic "sync engine stopped" with no diagnostic detail.
    let lastStage = 'paired-pre-bringup'
    ctx.state._lastStage = lastStage
    try {
      lastStage = 'joinVault'; ctx.state._lastStage = lastStage
      await ctx.joinVault()
      lastStage = 'openEngine'; ctx.state._lastStage = lastStage
      await openEngine()
    } catch (err) {
      const e = new Error('pairing succeeded but engine bring-up failed at ' + lastStage + ': ' + String((err && err.message) || err))
      e.code = 'PAIR_POST_HANDSHAKE_FAILED'
      e.lastStage = lastStage
      e.cause = err && (err.code || err.message)
      ctx.log.error('pair-post-handshake-failed', { lastStage, err: String((err && err.message) || err), stack: String((err && err.stack) || '').slice(0, 800) })
      throw e
    }
    ctx.emit('paired', { deviceId: newDevice.deviceId })

    return { ok: true, deviceId: newDevice.deviceId, vaultId: ctx.state.vaultId, confirmation: expectedConfirmation }
  })

  function pendingPairRequests () {
    if (!ctx.state._pendingPairRequests) ctx.state._pendingPairRequests = new Map()
    return ctx.state._pendingPairRequests
  }

  function clearPairRequest (requestId, event = 'pair-approval-cleared') {
    const pending = pendingPairRequests()
    const req = pending.get(requestId)
    if (!req) return null
    pending.delete(requestId)
    if (req.timer) clearTimeout(req.timer)
    ctx.emit(event, { requestId, deviceId: req.newDev && req.newDev.deviceId })
    return req
  }

  function clearPairRequestForConn (conn) {
    for (const [requestId, req] of pendingPairRequests()) {
      if (req.conn === conn) clearPairRequest(requestId)
    }
  }

  async function approvePairRequest (req, { grantHistory = false, cosigs = [] } = {}) {
    pairing.assertInviteOpen(req.inv)
    await engine.ready(15000)
    await engine.refresh()
    await engine._appendDeviceAdd(req.newDev, { signer: engine._localSigner(), cosigs })
    await engine.refresh()
    if (ctx.state._pendingInvite === req.inv) {
      if (typeof req.inv.rendezvousCleanup === 'function') {
        try { req.inv.rendezvousCleanup() } catch (_) {}
      }
      ctx.state._pendingInvite = null
    }
    ctx.swarm.leave(req.inv.topic).catch(() => {})

    const header = await ctx.vaultStore.getVaultHeader()
    // SELECTIVE-CHAIN BY DEFAULT (design §5.8, RT-FIX B1): the bootstrap
    // carries ONLY the active epoch key; the full rotated-key chain rides only
    // behind an explicit grantHistory. vaultKey/indexKey/deviceAdminSeed still
    // ship — they are the system KEK / blind-id / admin material every member
    // needs to operate (see engine._bootstrapEpochKeys for the honest
    // epoch-0 consequence). followSeed lets the new device be reached on its
    // follow topic from day one (design §4; today derived, delivered
    // explicitly for forward-compat with a future random seed).
    const bootstrap = {
      vaultId: ctx.state.vaultId,
      vaultKey: b4a.toString(ctx.state.vaultKeys.vaultKey, 'hex'),
      indexKey: b4a.toString(ctx.state.vaultKeys.indexKey, 'hex'),
      deviceAdminSeed: b4a.toString(ctx.state.vaultKeys.deviceAdminSeed, 'hex'),
      activeEpoch: engine.activeEpoch,
      activeEpochTag: engine.activeEpochTag,
      epochKeys: engine._bootstrapEpochKeys({ grantHistory }),
      grantHistory: !!grantHistory,
      followSeed: b4a.toString(ctx.crypto.hkdf(ctx.state.vaultKeys.vaultKey, 'follow-seed-v1', 32), 'hex'),
      vaultHeader: header,
      autobaseKey: header && header.autobaseKey
    }
    const sealed = ctx.pairing.sealBootstrap({
      recipientBoxPubkey: req.msg.boxPubkey,
      bootstrap
    })
    req.conn.write(b4a.from(JSON.stringify({
      t: 'pp-pair-bootstrap',
      sealed,
      deviceId: req.newDev.deviceId,
      confirmation: req.confirmation
    })))
    ctx.emit('pair-admitted', { deviceId: req.newDev.deviceId })
    return { ok: true, deviceId: req.newDev.deviceId }
  }

  ctx.dispatcher.register(COMMANDS.PAIR_APPROVE, async ({ requestId, grantHistory = false, cosigs = [] }) => {
    const req = clearPairRequest(requestId)
    if (!req) {
      const e = new Error('pairing request not found or expired')
      e.code = 'PAIR_REQUEST_NOT_FOUND'
      throw e
    }
    try {
      return await approvePairRequest(req, { grantHistory, cosigs })
    } catch (err) {
      if (err && err.code === ctx.ops.ERROR_CODES.PAIRING_EXPIRED && ctx.state._pendingInvite === req.inv) {
        ctx.state._pendingInvite = null
        ctx.swarm.leave(req.inv.topic).catch(() => {})
      }
      throw err
    }
  })

  ctx.dispatcher.register(COMMANDS.PAIR_REJECT, async ({ requestId }) => {
    const req = clearPairRequest(requestId, 'pair-rejected')
    if (!req) return { ok: true, rejected: false }
    try {
      req.conn.write(b4a.from(JSON.stringify({
        t: 'pp-pair-error',
        code: 'PAIRING_REJECTED',
        message: 'pairing rejected'
      })))
    } catch (_) {}
    return { ok: true, rejected: true, deviceId: req.newDev.deviceId }
  })

  // Existing-device side responder: when an unlocked device has a pending
  // invite and a peer connects on the pairing topic, verify the signed hello
  // and ask the local user to approve before admitting a writer or releasing
  // the sealed vault bootstrap (spec §14 steps 4-8).
  ctx.swarm.on('connection', (conn, info) => {
    const inv = ctx.state._pendingInvite
    const topics = info && Array.isArray(info.topics) ? info.topics : []
    ctx.log.info('pair-source-conn', {
      havePending: !!inv,
      unlocked: !!ctx.isUnlocked(),
      topicCount: topics.length,
      remotePub: info && info.publicKey ? b4a.toString(info.publicKey, 'hex').slice(0, 16) : null
    })
    if (!inv || !ctx.isUnlocked()) return
    let buf = b4a.alloc(0)
    conn.on('data', async (d) => {
      buf = b4a.concat([buf, d])
      let msg
      try { msg = JSON.parse(b4a.toString(buf)) } catch (_) { return }
      ctx.log.info('pair-source-msg', { t: msg && msg.t })
      if (msg.t !== 'pp-pair-hello') return
      try {
        pairing.assertInviteOpen(inv)
        if (msg.invitePubkey !== inv.eph.boxPubkey) throw pairingError('invite proof mismatch')
        if (Number(msg.expiresAt) !== Number(inv.expiresAt)) throw pairingError('invite expiry mismatch')
        if (!msg.writerKey || !/^[0-9a-f]{64}$/i.test(msg.writerKey)) throw pairingError('missing writer key')
        if (!msg.signingPubkey || !/^[0-9a-f]+$/i.test(msg.signingPubkey)) throw pairingError('missing signing key')
        if (!msg.boxPubkey || !/^[0-9a-f]+$/i.test(msg.boxPubkey)) throw pairingError('missing box key')
        const expectedDeviceId = b4a.toString(ctx.crypto.hash('device:' + msg.signingPubkey, 16), 'hex')
        if (msg.deviceId !== expectedDeviceId) throw pairingError('device id proof mismatch')
        const proofOk = ctx.crypto.verifyDetached(
          msg.signingPubkey,
          pairing.helloProofPayload(msg),
          msg.signature
        )
        if (!proofOk) throw pairingError('bad pairing proof')

        const newDev = {
          deviceId: msg.deviceId,
          label: typeof msg.label === 'string' && msg.label ? msg.label.slice(0, 80) : 'paired',
          platform: typeof msg.platform === 'string' && msg.platform ? msg.platform.slice(0, 40) : 'unknown',
          signingPubkey: msg.signingPubkey,
          boxPubkey: msg.boxPubkey,
          roles: ['writer', 'reader'],
          writerKey: msg.writerKey
        }
        const pending = pendingPairRequests()
        if (pending.size >= 1) throw pairingError('another pairing approval is already pending')
        const requestId = b4a.toString(ctx.crypto.randomBytes(16), 'hex')
        const confirmation = pairing.confirmationPhraseForHello(msg)
        const ttl = Math.max(1000, Number(inv.expiresAt) - Date.now())
        const timer = setTimeout(() => {
          const req = clearPairRequest(requestId)
          if (req) {
            try {
              req.conn.write(b4a.from(JSON.stringify({
                t: 'pp-pair-error',
                code: ctx.ops.ERROR_CODES.PAIRING_EXPIRED,
                message: 'pairing request expired'
              })))
            } catch (_) {}
          }
        }, ttl)
        if (timer.unref) timer.unref()
        // [RT-FIX B1 step 3] LOUD warning when the joiner's key material
        // matches a previously-revoked device (a re-imaged revoked laptop has
        // a fresh deviceId, so the revoke gate alone cannot see it). Heuristic
        // only — surfaced for an explicit human decision, never a silent gate.
        const previouslyRevokedMatch = engine.matchesRevokedDevice({
          signingPubkey: newDev.signingPubkey,
          boxPubkey: newDev.boxPubkey
        })
        if (previouslyRevokedMatch) {
          ctx.log.warn('pair-request-matches-revoked-device', {
            matchedDeviceId: previouslyRevokedMatch.deviceId,
            via: previouslyRevokedMatch.via
          })
        }
        pending.set(requestId, { requestId, inv, conn, msg, newDev, confirmation, timer, previouslyRevokedMatch })
        ctx.emit('pair-approval-needed', {
          requestId,
          deviceId: newDev.deviceId,
          label: newDev.label,
          platform: newDev.platform,
          confirmation,
          expiresAt: inv.expiresAt,
          previouslyRevokedMatch
        })
      } catch (err) {
        if (err && err.code === ctx.ops.ERROR_CODES.PAIRING_EXPIRED && ctx.state._pendingInvite === inv) {
          ctx.state._pendingInvite = null
          ctx.swarm.leave(inv.topic).catch(() => {})
        }
        try {
          conn.write(b4a.from(JSON.stringify({
            t: 'pp-pair-error',
            code: (err && err.code) || ctx.ops.ERROR_CODES.BAD_PAIRING_PROOF,
            message: 'pairing rejected'
          })))
        } catch (_) {}
        ctx.log.warn('pair-respond-failed', { err: String((err && err.message) || err) })
      }
    })
    conn.on('error', () => clearPairRequestForConn(conn))
    conn.on('close', () => clearPairRequestForConn(conn))
  })

  function pairingError (message) {
    const e = new Error(message)
    e.code = ctx.ops.ERROR_CODES.BAD_PAIRING_PROOF
    return e
  }

  // ---- DEVICE_LIST --------------------------------------------------------
  ctx.dispatcher.register(COMMANDS.DEVICE_LIST, async () => {
    // await engine readiness instead of returning a misleading empty list on
    // the unlock race; only fall back to [] if it genuinely never opens.
    try { await engine.ready(15000) } catch (_) { return { devices: [] } }
    await engine.refresh()
    const rows = await engine.view.listDevicesSealed()
    const devices = []
    for (const { key, value } of rows) {
      const blindId = key.slice('devices!'.length)
      // we hold indexKey so we can resolve+open our own device records
      let plain = null
      // find objectId by scanning known device ids in memory set
      for (const d of engine.devices.values()) {
        const dbid = ctx.crypto.blindId(engine.indexKey, 'device:' + d.deviceId)
        if (dbid === blindId) {
          try {
            plain = engine.view.openRecord({ objectId: 'device:' + d.deviceId, envelope: value })
          } catch (_) {}
          break
        }
      }
      devices.push(plain
        ? {
            deviceId: plain.deviceId,
            label: plain.label,
            platform: plain.platform,
            roles: plain.roles,
            revoked: plain.revokedAt != null,
            createdAt: plain.createdAt
          }
        : { blindId, sealed: true })
    }
    return { devices }
  })

  // ---- DEVICE_REVOKE (signed by root/admin; triggers REAL KEY_ROTATE) -----
  // Phase 2 makes revocation REAL (design §3.1–§3.3): a DEVICE_REVOKE rotates the
  // content key to a fresh epoch sealed ONLY to surviving devices, so the revoked
  // device provably cannot decrypt content created after revoke (forward
  // secrecy). Eviction is DECOUPLED from rotation per GATE SB1 — rotation/forward
  // secrecy is the deliverable and does NOT depend on removeWriter.
  ctx.dispatcher.register(COMMANDS.DEVICE_REVOKE, async ({ deviceId }) => {
    await engine.ready(15000) // await open instead of hard NOT_READY on the race
    const signer = engine._localSigner()
    await engine.refresh() // freshest committed device/epoch state before minting
    const me = engine.devices.get(ctx.state.device.deviceId)
    const amAdmin = (signer.signingPubkey === engine.rootPubkey) || (me && (me.roles || []).includes('admin'))
    if (!amAdmin) { const e = new Error('not authorized to revoke'); e.code = ctx.ops.ERROR_CODES.NOT_AUTHORIZED; throw e }

    // 1. DEVICE_REVOKE marks the target revoked (reducer sets revokedAtLamport +
    //    the B12 committed-revoked gate; removeWriter is NOT called in apply).
    const revOp = engine._makeOp({
      type: ctx.ops.OP_TYPES.DEVICE_REVOKE,
      schema: ctx.ops.SCHEMAS.DEVICE,
      objectId: 'device:' + deviceId,
      payload: { deviceId },
      signer
    })

    // 2. Mint epochKey_{N+1}, seal INDIVIDUALLY to each SURVIVING boxPubkey from
    //    the reorg-safe cache (omitting the revoked device), body under the NEW
    //    key, wraps blinded (design §3.2/§3.3, B3/B10/B11). topicSeed is NEVER
    //    transmitted — survivors derive it locally from epochKey_{N+1} (B3).
    const survivors = engine._survivingDevices(deviceId)
    const rot = engine._makeKeyRotateOp({ revokedDeviceId: deviceId, survivors, signer })

    // 3. Append REVOKE then ROTATE through the serialized chain so the pair never
    //    interleaves with another append (design §3.3). The revoking admin also
    //    holds the new key locally immediately (it is in `survivors` via its own
    //    committed device record, but persist it directly so a same-session write
    //    can seal under the new tag before the reducer pass re-reads the rows).
    await engine._append(revOp)
    await engine._append(rot.op)
    engine.epochKeys.set(rot.epochTag, rot.epochKey)
    engine._persistEpochKeyLocal(rot.epochTag, rot.epochKey, rot.epochInt)
    await engine.refresh()

    // 4. [GATE SB1] Best-effort, HOST-SIDE writer-seat eviction — gated on the
    //    target being currently LIVE/connected; skipped + DEFERRED when offline.
    //    Calling removeWriter on an OFFLINE indexer deterministically FREEZES the
    //    base's indexedLength (the indexer-set migration needs the removed
    //    device's ack), so we MUST NOT attempt it for an offline target. Write
    //    exclusion is already guaranteed by the reducer's reject-committed-revoked
    //    gate (B12); eviction is pure defense-in-depth here.
    let evicted = false
    let evictionDeferred = false
    try {
      const target = engine.devices.get(deviceId)
      const host = engine.base // base exposes removeWriter on this Autobase
      if (target && target.writerKey && host && typeof host.removeWriter === 'function') {
        if (engine._isWriterLive(target.writerKey)) {
          try {
            await host.removeWriter(b4a.from(target.writerKey, 'hex'))
            evicted = true
          } catch (_) { evictionDeferred = true }
        } else {
          // OFFLINE target — defer; the B12 gate keeps it write-excluded.
          evictionDeferred = true
        }
      }
    } catch (_) { evictionDeferred = true }

    ctx.emit('device-revoked', {
      deviceId,
      epoch: rot.epochInt,
      epochTag: rot.epochTag,
      evicted,
      evictionDeferred
    })
    // `epoch` is the NEW integer epoch (was the cosmetic keyEpoch+1 before);
    // include epochTag so callers see the real activated content key.
    return { ok: true, revoked: deviceId, epoch: rot.epochInt, epochTag: rot.epochTag, evicted, evictionDeferred }
  })

  ctx.log.info('autobase-sync attached')
}

export default { attach, SyncEngine }
