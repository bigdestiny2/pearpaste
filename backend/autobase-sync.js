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
  }

  // --- op construction -----------------------------------------------------
  // Build a signed ReplicatedOp (spec §7.5). Header is PUBLIC-only; body is a
  // CryptoEnvelope. Signature = Ed25519(canonical(header||ct||nonce||aadHash)).
  _makeOp ({ type, schema, objectId, payload, signer }) {
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
    const epochTag = this.activeEpochTag || ''
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
      epoch: String(this.activeEpoch || 0),
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
        isRoot: !!plain.isRoot
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
            this.keyEpoch = Math.max(this.keyEpoch, Number(this._body(op).epoch || 0))
            // Persist the (monotonic) epoch reorg-safely. rootPubkey is carried
            // forward from the rebuild at the top of this apply pass so the
            // vault-state row is never clobbered to a missing root.
            await this.view.putVaultState(batch, { rootPubkey: this.rootPubkey, keyEpoch: this.keyEpoch })
            this._rememberOp(op, true)
          }
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

  // signer is authorized iff: known device, not revoked at/before this op's
  // lamport, OR the root identity. Root may always sign lifecycle ops.
  _signerAuthorized (op, opLamport, { adminOnly = false } = {}) {
    const pub = op.signerPubkey
    if (pub === this.rootPubkey) return true
    let dev = null
    for (const d of this.devices.values()) if (d.signingPubkey === pub) { dev = d; break }
    if (!dev) return false
    if (adminOnly && !(dev.roles || []).includes('admin')) return false
    if (dev.revokedAtLamport != null && opLamport >= dev.revokedAtLamport) return false
    return true
  }

  async _applyDeviceAdd (op, host, batch) {
    const h = op.header
    const opLamport = Number(h.lamport)
    const body = this._body(op) // { device:{...}, selfRoot? , rootPubkey? }
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
    const body = this._body(op) // { deviceId }
    const target = this.devices.get(body.deviceId)
    if (!target) return
    target.revokedAtLamport = opLamport
    if (target.writerKey && host && typeof host.removeWriter === 'function') {
      try { await host.removeWriter(b4a.from(target.writerKey, 'hex')) } catch (_) {}
    }
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

  async _applyNoteUpsert (op, batch) {
    const ops = this.ctx.ops
    const h = op.header
    const body = this._body(op) // NotePlaintext (full note, whole-note LWW)
    const objectId = 'note:' + body.noteId
    const obid = h.objectBlindId
    const incoming = { lamport: Number(h.lamport), deviceId: h.deviceId }

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
    const body = this._body(op) // { noteId, hard?:bool }
    const objectId = 'note:' + body.noteId
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
    const body = this._body(op) // ClipPlaintext
    const objectId = 'clip:' + body.clipId
    const obid = h.objectBlindId
    await this.view.putClip(batch, {
      objectId,
      objectBlindId: obid,
      bucket: h.createdAtBucket,
      clip: { ...body, __lww: { lamport: Number(h.lamport), deviceId: h.deviceId } }
    })
    await this.view.putObjMeta(batch, { objectId, objectBlindId: obid, type: 'clip' })
  }

  async _applyClipDelete (op, batch) {
    const h = op.header
    const body = this._body(op) // { clipId, bucket }
    const obid = h.objectBlindId
    if (body && body.bucket) await batch.del(this.view.clipsKey(body.bucket, obid))
  }

  // --- high-level append helpers (used by notes-service via ctx) -----------
  async _appendDeviceAdd (device, { selfRoot = false, signer } = {}) {
    const s = signer || this._localSigner()
    const rootPub = selfRoot ? s.signingPubkey : (this.rootPubkey || s.signingPubkey)
    const op = this._makeOp({
      type: this.ctx.ops.OP_TYPES.DEVICE_ADD,
      schema: this.ctx.ops.SCHEMAS.DEVICE,
      objectId: 'device:' + device.deviceId,
      payload: {
        selfRoot,
        rootPubkey: rootPub,
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
        type, schema, objectId, payload, bucket: op.header.createdAtBucket, tries: 0
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
      rec.tries = (rec.tries || 0) + 1
      try {
        const reop = this._makeOp({
          type: rec.type, schema: rec.schema, objectId: rec.objectId, payload: rec.payload, signer: this._localSigner()
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

  async refresh () {
    if (this.base) await this.base.update()
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

  // background convergence loop: periodic update() so a device that comes
  // online catches up, PLUS durability reconciliation (FRESH-WRITER ORPHAN fix):
  // re-materialize any of this device's additive content rows that an
  // asynchronous indexer-migration rolled out of the view. Cancellable via
  // scope.signal (spec §22). Tightens to a short interval while there is pending
  // durability work (so a rolled-back note re-materializes within ~hundreds of
  // ms of the migration settling) and relaxes back to the idle cadence
  // otherwise (no steady-state overhead).
  ctx.scope.spawn(async (scope) => {
    while (!scope.cancelled) {
      let pending = 0
      try {
        if (engine._opened) {
          await engine.refresh()
          await engine._reconcileDurability()
          pending = engine._pendingDurable ? engine._pendingDurable.size : 0
        }
      } catch (_) {}
      try { await scope.sleep(pending > 0 ? 300 : 2000) } catch (_) { break }
    }
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
    ctx.vaultStore.saveLocalDevice(newDevice, unlockSecret, {
      vaultId: ctx.state.vaultId,
      vaultKey: ctx.state.vaultKeys.vaultKey,
      indexKey: ctx.state.vaultKeys.indexKey,
      deviceAdminSeed: ctx.state.vaultKeys.deviceAdminSeed
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

  async function approvePairRequest (req) {
    pairing.assertInviteOpen(req.inv)
    await engine.ready(15000)
    await engine.refresh()
    await engine._appendDeviceAdd(req.newDev, { signer: engine._localSigner() })
    await engine.refresh()
    if (ctx.state._pendingInvite === req.inv) {
      if (typeof req.inv.rendezvousCleanup === 'function') {
        try { req.inv.rendezvousCleanup() } catch (_) {}
      }
      ctx.state._pendingInvite = null
    }
    ctx.swarm.leave(req.inv.topic).catch(() => {})

    const header = await ctx.vaultStore.getVaultHeader()
    const bootstrap = {
      vaultId: ctx.state.vaultId,
      vaultKey: b4a.toString(ctx.state.vaultKeys.vaultKey, 'hex'),
      indexKey: b4a.toString(ctx.state.vaultKeys.indexKey, 'hex'),
      deviceAdminSeed: b4a.toString(ctx.state.vaultKeys.deviceAdminSeed, 'hex'),
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

  ctx.dispatcher.register(COMMANDS.PAIR_APPROVE, async ({ requestId }) => {
    const req = clearPairRequest(requestId)
    if (!req) {
      const e = new Error('pairing request not found or expired')
      e.code = 'PAIR_REQUEST_NOT_FOUND'
      throw e
    }
    try {
      return await approvePairRequest(req)
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
        pending.set(requestId, { requestId, inv, conn, msg, newDev, confirmation, timer })
        ctx.emit('pair-approval-needed', {
          requestId,
          deviceId: newDev.deviceId,
          label: newDev.label,
          platform: newDev.platform,
          confirmation,
          expiresAt: inv.expiresAt
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

  // ---- DEVICE_REVOKE (signed by root/admin; triggers KEY_ROTATE) ---------
  ctx.dispatcher.register(COMMANDS.DEVICE_REVOKE, async ({ deviceId }) => {
    await engine.ready(15000) // await open instead of hard NOT_READY on the race
    const signer = engine._localSigner()
    const me = engine.devices.get(ctx.state.device.deviceId)
    const amAdmin = (signer.signingPubkey === engine.rootPubkey) || (me && (me.roles || []).includes('admin'))
    if (!amAdmin) { const e = new Error('not authorized to revoke'); e.code = ctx.ops.ERROR_CODES.NOT_AUTHORIZED; throw e }

    const revOp = engine._makeOp({
      type: ctx.ops.OP_TYPES.DEVICE_REVOKE,
      schema: ctx.ops.SCHEMAS.DEVICE,
      objectId: 'device:' + deviceId,
      payload: { deviceId },
      signer
    })
    await engine._append(revOp)

    // trigger key rotation for future writes (spec §9.5, §23 recommendation)
    const newEpoch = engine.keyEpoch + 1
    const rotOp = engine._makeOp({
      type: ctx.ops.OP_TYPES.KEY_ROTATE,
      schema: ctx.ops.SCHEMAS.SETTING,
      objectId: 'key-rotate:' + newEpoch,
      payload: { epoch: newEpoch, reason: 'device-revoke' },
      signer
    })
    await engine._append(rotOp)
    await engine.refresh()
    ctx.emit('device-revoked', { deviceId, epoch: newEpoch })
    return { ok: true, revoked: deviceId, epoch: newEpoch }
  })

  ctx.log.info('autobase-sync attached')
}

export default { attach, SyncEngine }
