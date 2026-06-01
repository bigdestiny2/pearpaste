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

  async close () {
    try { if (this._meta) await this._meta.close() } catch (_) {}
    try { await this.store.close() } catch (_) {}
    this._opened = false
  }
}

export default VaultStore
