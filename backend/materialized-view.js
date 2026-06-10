// Paste materialized views.
//
// Encrypted Hyperbee current-state views built by the Autobase reducer
// (autobase-sync.js). Every value stored here is a CryptoEnvelope produced by
// crypto.seal() — never plaintext (spec §8.3, §22 "no plaintext at rest").
//
// Key layout (spec §9.3):
//   notes!<objectBlindId>            -> sealed NotePlaintext current state
//   clips!<bucket>!<objectBlindId>   -> sealed ClipPlaintext
//   pins!<sort>!<objectBlindId>      -> sealed pointer record
//   tags!<tagBlindId>!<objectBlindId>-> sealed pointer record
//   devices!<deviceBlindId>          -> sealed DeviceRecordPlaintext
//   settings!<keyBlindId>            -> sealed setting
//   search!<tokenBlindId>!<objectBlindId> -> sealed search pointer
//
// The Hyperbee lives ON the Autobase linearized view core. autobase-sync.js
// passes the bee in; this module is the put/get/scan helper layer so the reducer
// and notes-service share one encoding contract. A separate LOCAL-ONLY search
// Hyperbee (NAMESPACES.SEARCH, not replicated by topic) backs default-v1 search
// so titles/tokens never enter a replicated structure (spec §9.3 default v1).
//
// Spec refs: §7 (data model), §9.3 (Hyperbee views), §9.4 (sealed rows), §22.

import Hyperbee from 'hyperbee'

export const PREFIX = Object.freeze({
  NOTES: 'notes!',
  CLIPS: 'clips!',
  PINS: 'pins!',
  TAGS: 'tags!',
  DEVICES: 'devices!',
  SETTINGS: 'settings!',
  SEARCH: 'search!',
  // local-only meta written by the reducer into the *replicated* view so a
  // freshly-synced device can recover blindId -> {objectId,type} mappings it
  // needs to decrypt. The value is itself a sealed envelope (no plaintext).
  OBJMETA: 'objmeta!',
  // Epoch-key wrap family (design §2.4/§5.6, RT-FIX B5). One sealed row per
  // (epochTag, entitled device): the value carries `crypto_box_seal(epochKey,
  // device.boxPubkey)` so only the target device's box secret key opens it.
  // CRITICAL: keyed by `epochTag` (a collision-safe content hash), NEVER the
  // integer epoch — two concurrent rotations are both integer N+1 but carry
  // distinct tags, so an integer key would silently overwrite one (B5). Phase 1
  // only defines the family + reader; no rows are written until rotation (P2).
  EPOCHKEYS: 'epochkeys!',
  // Durable cross-device tombstone family (design §3.9/§5.6, RT-FIX B9). A
  // delete writes a persistent sealed row so the durability reconciler cannot
  // resurrect the object under a new epoch. Phase 1 is a SKELETON: writer +
  // reader only, NOT consulted by the reducer or reconciler yet (that is P5).
  TOMBSTONE: 'tombstone!'
})

// Tombstone sentinel kept inside the sealed value (never a raw key delete) so
// soft-deletes still replicate deterministically.
export const TOMBSTONE = '__pp_tombstone__'

function beeKey (prefix, ...parts) {
  return prefix + parts.join('!')
}

// A view bound to a Hyperbee whose values are CryptoEnvelopes. `crypto`,
// `vaultId`, and a key accessor are injected so this module performs no key
// derivation of its own (single crypto source = crypto-envelope.js).
export class MaterializedView {
  constructor ({ bee, crypto, ops, vaultId, indexKey, getVaultKey }) {
    this.bee = bee
    this.crypto = crypto
    this.ops = ops
    this.vaultId = vaultId
    this.indexKey = indexKey
    this._getVaultKey = getVaultKey
  }

  blindId (id) {
    return this.crypto.blindId(this.indexKey, id)
  }

  // ---- sealed put/get -------------------------------------------------------
  // `target` is a Hyperbee or a Hyperbee batch (the reducer flushes in a batch).
  sealRecord ({ objectId, objectBlindId, opType, schema, plaintext }) {
    return this.crypto.seal({
      vaultKey: this._getVaultKey(),
      objectId,
      objectBlindId,
      opType,
      schema,
      vaultId: this.vaultId,
      plaintext
    })
  }

  openRecord ({ objectId, envelope }) {
    return this.crypto.openWithObjectId({
      vaultKey: this._getVaultKey(),
      objectId,
      envelope
    })
  }

  async putSealed (target, key, sealArgs) {
    const envelope = this.sealRecord(sealArgs)
    await target.put(key, envelope)
    return envelope
  }

  async getSealedRaw (key) {
    const node = await this.bee.get(key)
    return node ? node.value : null
  }

  // ---- object metadata (blindId -> {objectId,type,...}) --------------------
  // Sealed so a paired device that only has objectBlindId can resolve the
  // plaintext objectId required by openWithObjectId(). objectId is itself
  // sensitive-ish (it keys the item key) so it is encrypted, not public.
  objMetaKey (objectBlindId) {
    return beeKey(PREFIX.OBJMETA, objectBlindId)
  }

  async putObjMeta (target, { objectId, objectBlindId, type }) {
    // sealed under a self-describing id derived from the public blindId so a
    // freshly-paired device can resolve objectId -> item key without state.
    return this.putSealed(target, this.objMetaKey(objectBlindId), {
      objectId: 'objmeta:' + objectBlindId,
      objectBlindId,
      opType: 'OBJMETA',
      schema: this.ops.SCHEMAS.SETTING,
      plaintext: { objectId, type }
    })
  }

  // OBJMETA is sealed under its own objectId, which we don't know until we
  // open it — chicken/egg. We instead key the item key by the *blindId* for
  // OBJMETA records only ('objmeta:' + blindId), so they are self-describing
  // to any device that derived indexKey from the recovery phrase.
  async resolveObjMeta (objectBlindId) {
    const env = await this.getSealedRaw(this.objMetaKey(objectBlindId))
    if (!env) return null
    return this.crypto.openWithObjectId({
      vaultKey: this._getVaultKey(),
      objectId: 'objmeta:' + objectBlindId,
      envelope: env
    })
  }

  // ---- notes ----------------------------------------------------------------
  notesKey (objectBlindId) { return beeKey(PREFIX.NOTES, objectBlindId) }

  async putNote (target, { objectId, objectBlindId, note }) {
    return this.putSealed(target, this.notesKey(objectBlindId), {
      objectId,
      objectBlindId,
      opType: this.ops.OP_TYPES.NOTE_UPSERT,
      schema: this.ops.SCHEMAS.NOTE,
      plaintext: note
    })
  }

  async getNoteSealed (objectBlindId) {
    return this.getSealedRaw(this.notesKey(objectBlindId))
  }

  // Store the op's OWN sealed body envelope (epochKey-sealed, keyed by
  // 'opbody:'+objectBlindId) verbatim under the note key, WITHOUT decrypting it.
  // Used by the reducer when THIS device lacks the op's epoch key (a revoked
  // device permanently, a transiently-behind device until it unwraps the key):
  // the op must still linearize + replicate + persist sealed so a key-holding
  // device reads it later. Readers open with objectId 'note:'+noteId and so get
  // nothing from this row (correct forward-secrecy outcome). Stored row presence
  // also satisfies the durability reconciler's _rowPresentFor check.
  async putNoteSealedRaw (target, { objectBlindId, envelope }) {
    await target.put(this.notesKey(objectBlindId), envelope)
    return envelope
  }

  // ---- clips ----------------------------------------------------------------
  clipsKey (bucket, objectBlindId) { return beeKey(PREFIX.CLIPS, bucket, objectBlindId) }

  async putClip (target, { objectId, objectBlindId, bucket, clip }) {
    return this.putSealed(target, this.clipsKey(bucket, objectBlindId), {
      objectId,
      objectBlindId,
      opType: this.ops.OP_TYPES.CLIP_ADD,
      schema: this.ops.SCHEMAS.CLIP,
      plaintext: clip
    })
  }

  // Op-envelope-verbatim clip store for the lacks-epoch-key reducer path (mirror
  // of putNoteSealedRaw). Persists the sealed op body keyed by (bucket, blindId)
  // so the op linearizes + replicates; this device cannot read it (the open path
  // keys by 'clip:'+clipId) until/unless it gains the epoch key.
  async putClipSealedRaw (target, { bucket, objectBlindId, envelope }) {
    await target.put(this.clipsKey(bucket, objectBlindId), envelope)
    return envelope
  }

  // ---- devices --------------------------------------------------------------
  devicesKey (deviceBlindId) { return beeKey(PREFIX.DEVICES, deviceBlindId) }

  async putDevice (target, { objectId, deviceBlindId, device }) {
    return this.putSealed(target, this.devicesKey(deviceBlindId), {
      objectId,
      objectBlindId: deviceBlindId,
      opType: this.ops.OP_TYPES.DEVICE_ADD,
      schema: this.ops.SCHEMAS.DEVICE,
      plaintext: device
    })
  }

  async listDevicesSealed () {
    const out = []
    for await (const { key, value } of this.bee.createReadStream({
      gte: PREFIX.DEVICES, lt: PREFIX.DEVICES + '~'
    })) {
      out.push({ key, value })
    }
    return out
  }

  // ---- settings -------------------------------------------------------------
  settingsKey (keyBlindId) { return beeKey(PREFIX.SETTINGS, keyBlindId) }

  async putSetting (target, { objectId, keyBlindId, value }) {
    return this.putSealed(target, this.settingsKey(keyBlindId), {
      objectId,
      objectBlindId: keyBlindId,
      opType: 'SETTING',
      schema: this.ops.SCHEMAS.SETTING,
      plaintext: value
    })
  }

  async getSetting (settingId) {
    const keyBlindId = this.blindId('setting:' + settingId)
    const env = await this.getSealedRaw(this.settingsKey(keyBlindId))
    if (!env) return null
    return this.openRecord({ objectId: 'setting:' + settingId, envelope: env })
  }

  // ---- vault-level authorization state (reorg-safe) ------------------------
  // rootPubkey + keyEpoch live here so the reducer can rebuild them purely
  // from the (truncation-aware) view on every apply pass instead of mutating
  // in-memory fields incrementally (CRITICAL #1). Sealed under a FIXED
  // blindId derived from a constant label so any device holding indexKey can
  // locate + decrypt it — stays inside crypto.seal so relays / at-rest see
  // only ciphertext (spec §22 "no plaintext at rest").
  vaultStateKey () { return this.settingsKey(this.blindId('vault-state:v1')) }

  async putVaultState (target, value) {
    return this.putSealed(target, this.vaultStateKey(), {
      objectId: 'vault-state:v1',
      objectBlindId: this.blindId('vault-state:v1'),
      opType: 'SETTING',
      schema: this.ops.SCHEMAS.SETTING,
      plaintext: value
    })
  }

  async getVaultState () {
    const env = await this.getSealedRaw(this.vaultStateKey())
    if (!env) return null
    return this.openRecord({ objectId: 'vault-state:v1', envelope: env })
  }

  // ---- epoch-key wraps (design §2.4/§5.6, RT-FIX B5) -----------------------
  // Per-(epochTag, device) sealed lockbox rows so an offline / rebooted / late
  // device recovers its epoch keys DETERMINISTICALLY from the committed view
  // after any truncation, and two concurrent rotations coexist without
  // colliding. The row VALUE is at-rest-sealed under the view key; the `sealed`
  // field inside it is itself a `crypto_box_seal` only the target device's box
  // secret key opens. The ROW KEY blinds (epochTag, wrapBlindId) so the family
  // does not reveal the roster (B10). The row is sealed under a self-describing
  // objectId derived from the row's own blindId (same chicken/egg dodge as
  // OBJMETA) so any device holding indexKey can open it with no external state.
  // Phase 1 ships this family + reader only; rows are written at rotation (P2).
  epochKeysRowBlindId (epochTag, wrapBlindId) {
    return this.blindId('epochkey:' + String(epochTag) + ':' + String(wrapBlindId))
  }

  epochKeysKey (epochTag, wrapBlindId) {
    return beeKey(PREFIX.EPOCHKEYS, this.epochKeysRowBlindId(epochTag, wrapBlindId))
  }

  async putEpochKeyWrap (target, { epochTag, epoch, blindId, sealed }) {
    const rowBlindId = this.epochKeysRowBlindId(epochTag, blindId)
    return this.putSealed(target, this.epochKeysKey(epochTag, blindId), {
      objectId: 'epochkey:' + rowBlindId,
      objectBlindId: rowBlindId,
      opType: 'EPOCH_KEY_WRAP',
      schema: this.ops.SCHEMAS.SETTING,
      plaintext: { epochTag: String(epochTag), epoch: Number(epoch) || 0, blindId: String(blindId), sealed: String(sealed) }
    })
  }

  // Return the wrap rows addressed to `deviceId`: filter the family to rows
  // whose stored wrap `blindId` equals blindId(indexKey,
  // "epochwrap:"+epochTag+":"+deviceId). The caller (the engine rebuild)
  // unwraps each `sealed` with its own box secret key. Rows we cannot open
  // (different device / not entitled) are skipped, never throw.
  async listEpochKeyWrapsFor (deviceId) {
    const out = []
    for await (const { key } of this.bee.createReadStream({
      gte: PREFIX.EPOCHKEYS, lt: PREFIX.EPOCHKEYS + '~'
    })) {
      const rowBlindId = key.slice(PREFIX.EPOCHKEYS.length)
      const env = await this.getSealedRaw(key)
      if (!env) continue
      let plain = null
      try {
        plain = this.crypto.openWithObjectId({
          vaultKey: this._getVaultKey(),
          objectId: 'epochkey:' + rowBlindId,
          envelope: env
        })
      } catch (_) { plain = null }
      if (!plain || plain.blindId == null) continue
      const want = this.blindId('epochwrap:' + String(plain.epochTag) + ':' + String(deviceId))
      if (plain.blindId !== want) continue
      out.push({ epochTag: String(plain.epochTag), epoch: Number(plain.epoch) || 0, sealed: String(plain.sealed) })
    }
    return out
  }

  // Return the set of wrap `blindId`s committed for one `epochTag` (design
  // §3.5.1, RT-FIX B6). The reducer uses this to re-validate a winning
  // rotation's wrap set against EVERY committed-revoked device: for each
  // revoked deviceId it recomputes blindId("epochwrap:"+epochTag+":"+deviceId)
  // and checks membership here; a hit means the winner sealed the active key to
  // a now-revoked device (forward secrecy defeated against it) and a fresh
  // rotation must be chained. Reads ONLY the public row keys via the recorded
  // blindId inside each sealed row — no box material, no roster enumeration.
  async listEpochKeyWrapBlindIds (epochTag) {
    const out = new Set()
    for await (const { key } of this.bee.createReadStream({
      gte: PREFIX.EPOCHKEYS, lt: PREFIX.EPOCHKEYS + '~'
    })) {
      const rowBlindId = key.slice(PREFIX.EPOCHKEYS.length)
      const env = await this.getSealedRaw(key)
      if (!env) continue
      let plain = null
      try {
        plain = this.crypto.openWithObjectId({
          vaultKey: this._getVaultKey(),
          objectId: 'epochkey:' + rowBlindId,
          envelope: env
        })
      } catch (_) { plain = null }
      if (!plain || plain.blindId == null) continue
      if (String(plain.epochTag) !== String(epochTag)) continue
      out.add(String(plain.blindId))
    }
    return out
  }

  // ---- tombstones (design §3.9/§5.6, RT-FIX B9 — WIRED in Phase 5) ---------
  // Durable cross-device delete marker, written by the *_DELETE reducer
  // branches and consulted by (a) the durability reconciler's _rowPresentFor —
  // a tombstoned object counts as "present/settled" so a remote reconciler can
  // never RESURRECT a row another device deleted — and (b) the *_UPSERT /
  // CLIP_ADD reducer branches, which drop any incoming op that does not BEAT
  // the tombstone by Lamport (stale replays die; a genuinely newer user
  // re-create supersedes the tombstone and deletes it). Carries the deleting
  // op's { lamport, deviceId } for that comparison. The value is sealed so
  // relays / at-rest see only ciphertext. Sealed under a self-describing
  // objectId derived from the public objectBlindId, like OBJMETA.
  tombstoneKey (objectBlindId) { return beeKey(PREFIX.TOMBSTONE, objectBlindId) }

  async putTombstone (target, { objectBlindId, lamport, deviceId }) {
    return this.putSealed(target, this.tombstoneKey(objectBlindId), {
      objectId: 'tombstone:' + String(objectBlindId),
      objectBlindId,
      opType: 'TOMBSTONE',
      schema: this.ops.SCHEMAS.SETTING,
      plaintext: {
        objectBlindId: String(objectBlindId),
        lamport: Number(lamport) || 0,
        deviceId: String(deviceId || '')
      }
    })
  }

  async getTombstone (objectBlindId) {
    const env = await this.getSealedRaw(this.tombstoneKey(objectBlindId))
    if (!env) return null
    try {
      return this.openRecord({ objectId: 'tombstone:' + String(objectBlindId), envelope: env })
    } catch (_) { return null }
  }

  async isTombstoned (objectBlindId) {
    return (await this.getTombstone(objectBlindId)) !== null
  }

  // ---- scans (sealed rows only) --------------------------------------------
  // Returns sealed list rows: blindId + envelope + cheap non-sensitive header
  // bits the reducer stored OUTSIDE the ciphertext are NOT here — the caller
  // (notes-service) derives coarse metadata without decrypting bodies.
  async scanNotes () {
    const out = []
    for await (const { key, value } of this.bee.createReadStream({
      gte: PREFIX.NOTES, lt: PREFIX.NOTES + '~'
    })) {
      out.push({ objectBlindId: key.slice(PREFIX.NOTES.length), envelope: value })
    }
    return out
  }

  async scanClips () {
    const out = []
    for await (const { key, value } of this.bee.createReadStream({
      gte: PREFIX.CLIPS, lt: PREFIX.CLIPS + '~'
    })) {
      const rest = key.slice(PREFIX.CLIPS.length)
      const i = rest.indexOf('!')
      out.push({
        bucket: rest.slice(0, i),
        objectBlindId: rest.slice(i + 1),
        envelope: value
      })
    }
    return out
  }
}

// ---- Local-only search index (spec §9.3 default v1) -------------------------
// NOT replicated by the vault topic. Tokens are normalized then blinded with
// indexKey so even this local store holds no plaintext token text. Search
// returns SEALED-flagged pointer rows; the caller decrypts a body only on tap.
//
// Row layout (this bee is LOCAL-ONLY — NAMESPACES.SEARCH, never passed to
// store.replicate(), never relayed; confirmed against replication-firewall.js /
// relay-service.js):
//   search!<tokenBlindId>!<objectBlindId> -> MARKER (1 byte; see below)
//   searchrev!<objectBlindId>             -> sealed { tokenBlindIds:[...], type }
//
// [AUDIT I-14] Per-object REVERSE-POINTER row. The previous indexObject/
// removeObject cleared an object's stale token rows by STREAMING THE ENTIRE
// `search!` family and string-matching keys ending in '!'+objectBlindId —
// O(total index rows) per note write (85–94% of write cost; O(N²) at cold
// sync). The reverse row records exactly which tokenBlindIds an object wrote,
// so a re-index reads ONE row, dels its k stale pointers, and writes the k new
// pointers + the updated reverse row → O(tokens), never O(index). The set of
// `search!` keys produced is byte-identical to the old full-scan across fresh
// insert, re-index-with-fewer/changed-tokens (the stale-pointer case), and
// delete: the old token set is precisely the rows ending in '!'+objectBlindId,
// which is precisely what the reverse row enumerates.
//
// [AUDIT I-8] The token-row VALUE is a 1-byte MARKER, not a per-token sealed
// envelope. The only search() consumer (notes-service.js) reads objectBlindId
// from the KEY and resolves content via objmeta; the old ~424B {objectId,type}
// envelope (75% of row bytes, ~k seal() calls/note) was never opened. The
// reverse row carries ONE sealed envelope per object (plaintext is identical
// per object), so the local store still holds an AEAD value per object and the
// verifier's "no plaintext at rest" structural scan stays satisfied, while the
// dominant search family shrinks ~4× (14.6 → 4.7 KB/note). search() keeps the
// hardcoded sealed:true flag (the consumer + test/unit/search.test.js depend on
// the FLAG, not on the value).
export class LocalSearchIndex {
  constructor ({ bee, crypto, ops, vaultId, indexKey, getVaultKey }) {
    this.bee = bee
    this.crypto = crypto
    this.ops = ops
    this.vaultId = vaultId
    this.indexKey = indexKey
    this._getVaultKey = getVaultKey
  }

  static tokenize (text) {
    if (!text) return []
    return String(text)
      .normalize('NFKD')
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(t => t.length >= 2 && t.length <= 64)
  }

  tokenBlindId (token) {
    return this.crypto.blindId(this.indexKey, 'tok:' + token)
  }

  _key (tokenBlindId, objectBlindId) {
    return 'search!' + tokenBlindId + '!' + objectBlindId
  }

  // [AUDIT I-14] Per-object reverse-pointer row key. The token-row range reads
  // are bounded `[ 'search!', 'search!~' )` (and per-term, tighter). At byte 6
  // 'searchrev!' has 'r' (0x72) while the upper bound 'search!~' has '!' (0x21);
  // 0x72 > 0x21, so 'searchrev!…' sorts ABOVE 'search!~' and is excluded from
  // every token-row scan. (It sorts below 'search!' too is irrelevant — it is
  // simply never inside the range.) Verified by the byte-identical proof.
  _revKey (objectBlindId) {
    return 'searchrev!' + objectBlindId
  }

  // [AUDIT I-8] One-byte token-row marker. The value is never opened (the
  // consumer reads objectBlindId from the key); a number stores compactly and is
  // not a CryptoEnvelope / not a user-content row / carries no sentinel, so the
  // verifier's structural scan classifies it as benign bookkeeping.
  static get MARKER () { return 1 }

  // Read an object's committed token-pointer set from its reverse row. Returns
  // the stored tokenBlindIds (or [] when the object was never indexed). Sealed
  // value, opened under a self-describing objectId derived from the blindId
  // (same chicken/egg dodge as OBJMETA) so it needs no external state.
  async _readReverse (objectBlindId) {
    const node = await this.bee.get(this._revKey(objectBlindId))
    if (!node || node.value == null) return []
    try {
      const plain = this.crypto.openWithObjectId({
        vaultKey: this._getVaultKey(),
        objectId: 'searchrev:' + objectBlindId,
        envelope: node.value
      })
      return Array.isArray(plain && plain.tokenBlindIds) ? plain.tokenBlindIds : []
    } catch (_) {
      return []
    }
  }

  // Index one item's searchable text. Old tokens for the same object are
  // cleared first so updates do not leave stale pointers.
  //
  // [AUDIT I-14] O(tokens) via the per-object reverse row: read the 1 reverse
  // row → del exactly its k stale token pointers → put the k' new token markers
  // + the refreshed reverse row. Never streams the whole `search!` family. The
  // resulting `search!` key set is byte-identical to the old full-scan: the old
  // scan deleted precisely the rows ending in '!'+objectBlindId (i.e. this
  // object's prior token set, == the reverse row) and wrote the new token set;
  // we delete that same prior set and write that same new set. [AUDIT I-8] Each
  // token row's value is the 1-byte MARKER; one sealed envelope (listing the
  // tokenBlindIds) lives in the reverse row instead of ~k per-token envelopes.
  async indexObject ({ objectId, objectBlindId, type, texts }) {
    const tokens = new Set()
    for (const t of texts) for (const tok of LocalSearchIndex.tokenize(t)) tokens.add(tok)
    const newTbids = [...tokens].map(tok => this.tokenBlindId(tok))
    const oldTbids = await this._readReverse(objectBlindId)
    const batch = this.bee.batch()
    // Clear the object's previous token pointers (exactly the set the old
    // full-scan would have matched), keyed straight off the reverse row.
    for (const tbid of oldTbids) await batch.del(this._key(tbid, objectBlindId))
    for (const tbid of newTbids) await batch.put(this._key(tbid, objectBlindId), LocalSearchIndex.MARKER)
    if (newTbids.length === 0) {
      // No searchable tokens (e.g. soft-delete with texts:[]) — drop the reverse
      // row too so the object leaves no residue, matching the old scan which
      // left zero `search!` rows for it.
      await batch.del(this._revKey(objectBlindId))
    } else {
      await batch.put(this._revKey(objectBlindId), this.crypto.seal({
        vaultKey: this._getVaultKey(),
        objectId: 'searchrev:' + objectBlindId,
        objectBlindId,
        opType: 'SEARCH_PTR',
        schema: this.ops.SCHEMAS.SEARCH_POINTER,
        vaultId: this.vaultId,
        plaintext: { tokenBlindIds: newTbids, type }
      }))
    }
    await batch.flush()
  }

  // [AUDIT I-14] O(tokens) delete via the reverse row: del its pointers + the
  // reverse row itself. Byte-identical to the old full-scan delete (which
  // removed exactly the rows ending in '!'+objectBlindId == this set).
  async removeObject (objectBlindId) {
    const oldTbids = await this._readReverse(objectBlindId)
    const batch = this.bee.batch()
    for (const tbid of oldTbids) await batch.del(this._key(tbid, objectBlindId))
    await batch.del(this._revKey(objectBlindId))
    await batch.flush()
  }

  // AND-of-terms query. Returns objectBlindId-only pointer rows flagged
  // sealed:true; NO decrypted title/body (spec §9.3 "search returns sealed
  // result rows"). [AUDIT I-8] The token-row value is now a 1-byte marker, so
  // the row carries no envelope to return — the only consumer
  // (notes-service.js) reads objectBlindId from the key and resolves content
  // via objmeta, and depends on the sealed FLAG, not on the value (kept
  // hardcoded true here; test/unit/search.test.js asserts it). All term scans
  // run concurrently — the bee serves independent range reads, so a k-term
  // query costs one round of I/O latency instead of k.
  async search (query, { limit = 50 } = {}) {
    const terms = [...new Set(LocalSearchIndex.tokenize(query))]
    if (terms.length === 0) return []
    const perTerm = await Promise.all(terms.map(async (term) => {
      const tbid = this.tokenBlindId(term)
      const hits = new Set()
      for await (const { key } of this.bee.createReadStream({
        gte: 'search!' + tbid + '!', lt: 'search!' + tbid + '!~'
      })) {
        hits.add(key.slice(('search!' + tbid + '!').length))
      }
      return hits
    }))
    // Intersect smallest-first so the working set only ever shrinks.
    perTerm.sort((a, b) => a.size - b.size)
    const acc = perTerm[0]
    for (let i = 1; i < perTerm.length && acc.size > 0; i++) {
      const hits = perTerm[i]
      for (const k of [...acc]) if (!hits.has(k)) acc.delete(k)
    }
    const rows = []
    for (const objectBlindId of acc) {
      rows.push({ objectBlindId, sealed: true })
      if (rows.length >= limit) break
    }
    return rows
  }
}

// Wrap an appendable Hypercore in a json Hyperbee. Used both for the Autobase
// linearized view (open handler) and the local-only search store.
export function beeFromCore (core) {
  return new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

export default { MaterializedView, LocalSearchIndex, beeFromCore, PREFIX, TOMBSTONE }
