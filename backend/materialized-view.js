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
  OBJMETA: 'objmeta!'
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
// returns SEALED pointer rows; the caller decrypts a body only on tap.
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

  // Index one item's searchable text. Old tokens for the same object are
  // cleared first so updates do not leave stale pointers.
  async indexObject ({ objectId, objectBlindId, type, texts }) {
    const tokens = new Set()
    for (const t of texts) for (const tok of LocalSearchIndex.tokenize(t)) tokens.add(tok)
    const batch = this.bee.batch()
    // clear previous pointers for this object
    for await (const { key } of this.bee.createReadStream({
      gte: 'search!', lt: 'search!~'
    })) {
      if (key.endsWith('!' + objectBlindId)) await batch.del(key)
    }
    for (const tok of tokens) {
      const tbid = this.tokenBlindId(tok)
      const envelope = this.crypto.seal({
        vaultKey: this._getVaultKey(),
        objectId: 'searchptr:' + objectBlindId,
        objectBlindId,
        opType: 'SEARCH_PTR',
        schema: this.ops.SCHEMAS.SEARCH_POINTER,
        vaultId: this.vaultId,
        plaintext: { objectId, type }
      })
      await batch.put(this._key(tbid, objectBlindId), envelope)
    }
    await batch.flush()
  }

  async removeObject (objectBlindId) {
    const batch = this.bee.batch()
    for await (const { key } of this.bee.createReadStream({
      gte: 'search!', lt: 'search!~'
    })) {
      if (key.endsWith('!' + objectBlindId)) await batch.del(key)
    }
    await batch.flush()
  }

  // AND-of-terms query. Returns sealed pointer rows (objectBlindId + envelope);
  // NO decrypted title/body (spec §9.3 "search returns sealed result rows").
  async search (query, { limit = 50 } = {}) {
    const terms = LocalSearchIndex.tokenize(query)
    if (terms.length === 0) return []
    let acc = null
    for (const term of terms) {
      const tbid = this.tokenBlindId(term)
      const hits = new Map()
      for await (const { key, value } of this.bee.createReadStream({
        gte: 'search!' + tbid + '!', lt: 'search!' + tbid + '!~'
      })) {
        const obid = key.slice(('search!' + tbid + '!').length)
        hits.set(obid, value)
      }
      if (acc === null) acc = hits
      else for (const k of [...acc.keys()]) if (!hits.has(k)) acc.delete(k)
      if (acc.size === 0) break
    }
    const rows = []
    for (const [objectBlindId, envelope] of (acc || new Map())) {
      rows.push({ objectBlindId, envelope, sealed: true })
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
