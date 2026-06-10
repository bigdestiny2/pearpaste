// Paste vault store.
//
// Owns the single Corestore root for an install and hands out namespaced
// sub-stores to subsystems (autobase, views, search). Also holds the
// content-free vault header and the local-only device secret store (signing /
// box secret keys), which is encrypted at rest and NEVER placed in any
// replicated core. autobase-sync.js / materialized-view.js (Agent 1) build on
// the handles exposed here.
//
// Spec refs: §6, §7.1 (vault header), §9.1 (Corestore), §16 (one Corestore
// root per vault per install; namespaces per subsystem), §8.3 (plaintext rules).

import path from 'path'
import fs from 'fs'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import b4a from 'b4a'
import {
  PWHASH_SALT_BYTES,
  pwhashRootSeed,
  pwhashWithSalt,
  seal,
  openWithObjectId,
  randomBytes,
  CryptoError
} from './crypto-envelope.js'
import { SCHEMAS } from './shared-ops.js'

export const NAMESPACES = Object.freeze({
  META: 'pearpaste:meta',
  AUTOBASE: 'pearpaste:autobase',
  VIEWS: 'pearpaste:views',
  SEARCH: 'pearpaste:search',
  BACKUP: 'pearpaste:backup'
})

const LOCAL_SECRET_FILE = 'local-device.json' // local-only, never replicated

export class VaultStore {
  constructor (storagePath) {
    if (!storagePath) throw new CryptoError('storagePath required', 'BAD_ARG')
    this.storagePath = storagePath
    this.store = new Corestore(storagePath)
    this._meta = null
    this._opened = false
  }

  async ready () {
    if (this._opened) return
    await this.store.ready()
    const core = this.store.namespace(NAMESPACES.META).get({ name: 'vault-header' })
    await core.ready()
    this._meta = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this._meta.ready()
    this._opened = true
  }

  namespace (ns) {
    return this.store.namespace(ns)
  }

  // ---- Vault header (content-free public metadata, spec §7.1) --------------
  async getVaultHeader () {
    const node = await this._meta.get('header')
    return node ? node.value : null
  }

  async putVaultHeader (header) {
    // The header must never carry names, emails, titles, or user content.
    const banned = ['name', 'email', 'title', 'body', 'tags', 'note', 'clip']
    for (const k of Object.keys(header)) {
      if (banned.includes(k.toLowerCase())) {
        throw new CryptoError('vault header may not contain field: ' + k, 'HEADER_LEAK')
      }
    }
    await this._meta.put('header', header)
    return header
  }

  // ---- Local device secret store ------------------------------------------
  // Stores this device's signing/box secret keys, encrypted under a key
  // derived from the unlock secret (passphrase or OS-keychain-provided value).
  // This file is local-only: it lives under the install storage path, is
  // covered by .gitignore, is excluded from staging (pear.json `ignore`), and
  // is never appended to any Hypercore/Autobase/Hyperbee/Hyperdrive/relay.
  _secretPath () {
    return path.join(this.storagePath, LOCAL_SECRET_FILE)
  }

  hasLocalDevice () {
    try { return fs.existsSync(this._secretPath()) } catch (_) { return false }
  }

  // unlockSecret: the user's passphrase or keychain-provided unlock value.
  // vaultSecrets (optional): { vaultId, vaultKey, indexKey, deviceAdminSeed }
  // wrapped under the unlock secret so the device can re-unlock with a
  // passphrase/keychain value WITHOUT re-entering the 24-word phrase
  // (spec §14 password unlock, §23 "support both; never require a cloud
  // account"). This blob is local-only and never replicated.
  saveLocalDevice (device, unlockSecret, vaultSecrets = null) {
    const wrapSalt = randomBytes(PWHASH_SALT_BYTES)
    const wrapKey = pwhashWithSalt(b4a.from(String(unlockSecret)), wrapSalt)
    const objectId = 'local-device:' + device.deviceId
    const plaintext = {
      deviceId: device.deviceId,
      label: device.label,
      platform: device.platform,
      roles: device.roles,
      signingPubkey: device.signingPubkey,
      boxPubkey: device.boxPubkey,
      signSeed: b4a.toString(device.signSeed, 'hex'),
      boxSecretKey: b4a.toString(device.boxSecretKey, 'hex')
    }
    if (vaultSecrets) {
      plaintext.vault = {
        vaultId: vaultSecrets.vaultId,
        vaultKey: b4a.toString(vaultSecrets.vaultKey, 'hex'),
        indexKey: b4a.toString(vaultSecrets.indexKey, 'hex'),
        deviceAdminSeed: b4a.toString(vaultSecrets.deviceAdminSeed, 'hex')
      }
      // Optional epoch chain + follow seed (design §2.3/§5.9). Additive:
      // omitted for epoch-0-only vaults (the existing case), where epoch 0 is
      // the already-stored `vaultKey` (tag "") — no schema bump. `epochKeys` is
      // a hex map keyed by EPOCHTAG (never the integer — B5); Phase 2 persists a
      // newly-unwrapped key here at rotation, Phase 4 the pairing-delivered key.
      // `followSeed` (§4) is delivered at pairing and never rotated. Buffers are
      // hex-encoded; pre-encoded hex strings are accepted as-is.
      if (vaultSecrets.epochKeys && typeof vaultSecrets.epochKeys === 'object') {
        const ek = {}
        for (const [tag, key] of Object.entries(vaultSecrets.epochKeys)) {
          ek[tag] = b4a.isBuffer(key) ? b4a.toString(key, 'hex') : String(key)
        }
        plaintext.vault.epochKeys = ek
      }
      if (vaultSecrets.followSeed != null) {
        plaintext.vault.followSeed = b4a.isBuffer(vaultSecrets.followSeed)
          ? b4a.toString(vaultSecrets.followSeed, 'hex')
          : String(vaultSecrets.followSeed)
      }
    }
    const envelope = seal({
      vaultKey: wrapKey,
      objectId,
      objectBlindId: 'local',
      opType: 'LOCAL_DEVICE',
      schema: SCHEMAS.DEVICE,
      vaultId: 'local',
      plaintext
    })
    const tmp = this._secretPath() + '.tmp-' + b4a.toString(randomBytes(6), 'hex')
    fs.writeFileSync(tmp, JSON.stringify({
      v: 2,
      kdf: {
        alg: 'argon2id',
        salt: b4a.toString(wrapSalt, 'hex')
      },
      objectId,
      envelope
    }), { mode: 0o600 })
    fs.renameSync(tmp, this._secretPath())
  }

  loadLocalDevice (unlockSecret) {
    if (!this.hasLocalDevice()) return null
    const rec = JSON.parse(fs.readFileSync(this._secretPath(), 'utf8'))
    const { objectId, envelope } = rec
    const legacyWrap = !(rec && rec.kdf && rec.kdf.salt)
    const wrapKey = legacyWrap
      ? pwhashRootSeed(b4a.from(String(unlockSecret)), 'local-device-wrap-v1')
      : pwhashWithSalt(b4a.from(String(unlockSecret)), b4a.from(rec.kdf.salt, 'hex'))
    let pt
    try {
      pt = openWithObjectId({ vaultKey: wrapKey, objectId, envelope })
    } catch (_) {
      throw new CryptoError('bad unlock secret', 'BAD_UNLOCK')
    }
    const out = {
      ...pt,
      signSeed: b4a.from(pt.signSeed, 'hex'),
      boxSecretKey: b4a.from(pt.boxSecretKey, 'hex')
    }
    if (pt.vault) {
      out.vault = {
        vaultId: pt.vault.vaultId,
        vaultKey: b4a.from(pt.vault.vaultKey, 'hex'),
        indexKey: b4a.from(pt.vault.indexKey, 'hex'),
        deviceAdminSeed: b4a.from(pt.vault.deviceAdminSeed, 'hex')
      }
      // Parse the optional epoch chain + follow seed back to Buffers (design
      // §5.9). Absent for epoch-0-only vaults — epoch 0 (tag "") is the already
      // present `vaultKey`, so the engine rebuilds the "" -> vaultKey anchor on
      // its own. Keyed by epochTag, never the integer (B5).
      if (pt.vault.epochKeys && typeof pt.vault.epochKeys === 'object') {
        const ek = {}
        for (const [tag, hex] of Object.entries(pt.vault.epochKeys)) {
          try { ek[tag] = b4a.from(String(hex), 'hex') } catch (_) {}
        }
        out.vault.epochKeys = ek
      }
      if (pt.vault.followSeed != null) {
        try { out.vault.followSeed = b4a.from(String(pt.vault.followSeed), 'hex') } catch (_) {}
      }
    }
    if (legacyWrap) {
      try { this.saveLocalDevice(out, unlockSecret, out.vault || null) } catch (_) {}
    }
    return out
  }

  // Persist/refresh ONLY the wrapped vault secrets for an already-known device
  // (used when a paired device receives keys via sealed bootstrap later).
  saveVaultSecrets (device, unlockSecret, vaultSecrets) {
    this.saveLocalDevice(device, unlockSecret, vaultSecrets)
  }

  // Switch this install to a DIFFERENT vault: tear down and WIPE every
  // replicated core (the Autobase op log + view, the local search index, and
  // the vault header) so a prior vault's device records can never surface as
  // unresolvable `{ sealed: true }` rows in the new vault, and its cores never
  // linger on disk (DEVICE_HYGIENE Fix A2).
  //
  // Why a full close + reopen + storage.clear() rather than per-core deletion:
  // the namespaces that seed the derived writer keypair are LEFT UNCHANGED
  // (so a vault that is NOT being replaced keeps its committed `writerKey` —
  // the breaking-migration trap the obvious one-line namespace change falls
  // into). corestore (7.9.2) keeps cores cached in memory beyond session close,
  // so clearing the live store leaves stale heads; and hypercore (11.30.2)
  // `core.purge()` is non-functional. The robust path is therefore: fully close
  // the Corestore, reopen a fresh one on the same dir, and `storage.clear()`
  // BEFORE any core is opened — verified to drop every core from disk while the
  // store stays reusable.
  //
  // local-device.json (a sibling file, never part of the Corestore) is left
  // untouched; the caller re-persists it for the new vault. The Corestore
  // OBJECT is replaced here, so any long-lived holder of `vaultStore.store`
  // MUST re-read it: the replication firewall reads it lazily, and the relay
  // service drops its cached client on the 'vault-storage-reset' event.
  async resetReplicatedStorage () {
    try { if (this._meta) await this._meta.close() } catch (_) {}
    this._meta = null
    this._opened = false
    try { await this.store.close() } catch (_) {}
    this.store = new Corestore(this.storagePath)
    await this.store.ready()
    // Wipe every core from disk in place on the freshly reopened (cache-empty)
    // store. clear() lives on the underlying hypercore-storage instance.
    if (this.store.storage && typeof this.store.storage.clear === 'function') {
      await this.store.storage.clear()
    } else {
      throw new CryptoError('corestore storage.clear() unavailable; cannot wipe prior vault', 'NO_STORAGE_CLEAR')
    }
    await this.ready()
  }

  async close () {
    try { if (this._meta) await this._meta.close() } catch (_) {}
    try { await this.store.close() } catch (_) {}
    this._opened = false
  }
}

export default VaultStore
