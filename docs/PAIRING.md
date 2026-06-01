# Paste Pairing & Recovery

How a user creates a vault, adds devices, restores from the recovery phrase,
and revokes a device — described to match the implemented behavior in
`backend/identity.js`, `backend/pairing.js`, and `backend/autobase-sync.js`.

There is no central account. There is **vault unlock**, **device pairing**,
and **recovery restore**. Spec references: §14 (pairing/login), §10 (topics),
§7.2 (device record), §8.1 (key hierarchy), §23 (security settings).

---

## 1. Key hierarchy (context)

```
recovery entropy   256 bits CSPRNG
mnemonic           24 BIP-39 words (+ optional passphrase)         [shown once]
rootSeed           = Argon2id(NFKD(mnemonic)+" "+NFKD(passphrase),
                              salt="pearpaste-root-v1")
vaultKey           = HKDF(rootSeed, "pearpaste-vault-key-v1")       content keys
indexKey           = HKDF(rootSeed, "pearpaste-index-key-v1")       blind ids
deviceAdminSeed    = HKDF(rootSeed, "pearpaste-device-admin-v1")    root identity
per device         Ed25519 signing keypair + Curve25519 box keypair
```

`vaultId` and the Hyperswarm discovery topic are deterministic functions of
the keys, so any device with the recovery phrase computes the same vault
identity while the values reveal nothing about the user.

---

## 2. First device (CREATE_VAULT)

1. Generate 256 bits of entropy → 24-word BIP-39 mnemonic
   (`identity.generateMnemonic`).
2. **Show the 24 words exactly once**, with confirmation. This is the only
   time Paste ever returns the phrase across the RPC boundary
   (`assertRendererSafe` `allowMnemonic`); it is never persisted or logged.
3. Derive `rootSeed` → `vaultKeys`; create the first device identity
   (`identity.createDeviceIdentity`).
4. Persist the **local-only** device blob (`vault-store.saveLocalDevice`):
   the device signing/box secret keys plus the wrapped vault secrets,
   AEAD-encrypted under an Argon2id key from the unlock secret (passphrase or
   OS-keychain value). This file lives under the install storage path, is
   `.gitignore`d and excluded from Pear staging, and is **never replicated**.
5. Write the content-free vault header; start direct P2P (join the vault
   discovery topic) and optional relay availability. The first device
   self-authorizes via a self-signed `DEVICE_ADD` (root authorizes its own
   first device — `autobase-sync` genesis bootstrap).

After this, routine use is **UNLOCK_VAULT** with the passphrase / keychain
value — the recovery phrase is *not* re-entered.

---

## 3. Pair a new device (PAIR_CREATE_INVITE → PAIR_ACCEPT)

### 3.1 Existing (unlocked) device creates a one-time invite

`PAIR_CREATE_INVITE { ttlMs }` →

- a fresh **random, temporary pairing topic** (32 bytes,
  `pairing.newPairingTopic`),
- an **ephemeral box keypair** for this pairing only,
- an invite blob (compact JSON) + a human **short code** (e.g. `1A2B-3C4D`) +
  an **expiry** (`expiresAt = now + ttlMs`, default 5 min),
- the content-free Autobase bootstrap key needed for the joining device to
  prepare its writer core before any vault keys are released.

The invite encodes
`{ v:1, t:topicHex, p:invitePubkeyHex, a:autobaseKeyHex, r:relayHints, s:swarmPubkeyHex, e:expiresAt }`.
The compact form fits the QR encoder's byte-mode v17 budget (~511 chars).
Distribute by QR scan, by reading the invite payload out of band, or by
**typing the 8-char short code** (see §3.1.1).

#### 3.1.1 Short-code rendezvous

The handler ALSO joins a second Hyperswarm topic derived from the short code
(`pairing.shortCodeRendezvousTopic(shortCode)` =
`HMAC("paste-shortcode-rendezvous-v1", normalized)` → 32 bytes). The inviter
keeps it announced for the same TTL as the invite. Any peer that connects on
that topic receives the full invite payload as one JSON frame
(`{ v:1, invite }`) and the connection is half-closed. This is what lets a
fresh device pair by typing just the 8-char code instead of pasting the long
invite text or scanning the QR.

**Security:** the short code carries no cryptographic material on its own —
all material lives in the invite payload it dereferences. The 32-bit code
space (~4B) and 5-min TTL make brute-forcing infeasible. Crucially, the
confirmation phrase exchanged in §3.2 step 4 below still protects against
MITM: an observer who fetches the invite from the rendezvous gets the topic
+ invite pubkey but not the inviter's ephemeral SECRET key, so they cannot
impersonate the inviter, and the victim's PAIR_ACCEPT will compute a
mismatching confirmation phrase against any fake.

A new `PAIR_CREATE_INVITE` supersedes the previous rendezvous so an old
short code can't be used to fetch a newer invite.

### 3.2 New device accepts

`PAIR_ACCEPT { invite, label, platform }` →

- The renderer can pass either the full invite blob OR the short code.
  When the input matches the short-code shape (`isShortCodeShape`), the
  renderer first calls **`PAIR_LOOKUP_SHORTCODE { shortCode, timeoutMs }`**,
  which joins the rendezvous topic in client mode, waits for the inviter to
  send the invite payload (`{ v:1, invite }`), and returns `{ invite }` for
  the regular accept flow. Errors surface as `BAD_SHORT_CODE` (malformed) or
  `SHORTCODE_NOT_FOUND` (timeout — expired invite or wrong code).

1. `pairing.decodeInvite(invite)` — **rejects an expired invite immediately**
   with `PAIRING_EXPIRED`, before any network work (see §6).
2. The new device generates its own identity (its box pubkey is the wrap
   target), opens its local Autobase writer core from the invite's content-free
   bootstrap key, and joins the temporary pairing topic on the **one**
   Hyperswarm.
3. The two devices connect; the new device sends a signed `pp-pair-hello`
   binding its device id, signing pubkey, box pubkey, writer key, invite
   pubkey, and expiry. The existing device validates the invite proof against
   its stashed ephemeral key, checks the invite is still live, and verifies the
   signature before doing anything with vault keys.
4. The existing device displays / both sides can compare a 6-digit
   **confirmation phrase** derived from the handshake
   (`pairing.confirmationPhrase`).
5. The existing device first appends a signed **`DEVICE_ADD`** authorizing the
   new device's writer core (`autobase-sync._appendDeviceAdd`, signed by an
   already-authorized admin/root device — spec §14 step 7). Only after this
   succeeds does it consume the one-time invite.
6. The existing device seals the **vault bootstrap** (vault id, wrapped
   `vaultKey`/`indexKey`/`deviceAdminSeed`, vault header, Autobase key) to the
   new device's box public key using a libsodium **sealed box**
   (`pairing.sealBootstrap` → `identity.sealToDevice`). Only the new device's
   box secret key can open it.
7. The new device opens the sealed bootstrap, persists its local-only device
   blob, joins the vault topic, and starts sync. Sealed rows resolve and
   tap-to-decrypt works because it now holds the vault keys.

The pairing topic is temporary and abandoned after the exchange (or after a
30s handshake timeout). The bootstrap is never sent in the clear and never
touches a relay or any replicated core.

---

## 4. Restore from recovery phrase (RESTORE_VAULT)

`RESTORE_VAULT { mnemonic, passphrase, highSecurity }` →

1. Validate the 24-word phrase (BIP-39 checksum). Invalid →
   `BAD_MNEMONIC`, nothing happens.
2. Derive `rootSeed` → `vaultKeys`; compute the deterministic `vaultId`.
3. If a local device blob exists, reuse that device identity; otherwise create
   a fresh device identity.
4. **(Re)persist** the wrapped vault secrets under the passphrase (or the
   mnemonic, if no passphrase) so subsequent routine unlocks use
   `UNLOCK_VAULT` without re-entering the phrase (spec §14/§23 "support both;
   never require a cloud account").
5. Locate the vault by its deterministic topic and sync from peers/relays. If
   no peers/relays are reachable, the user can import an encrypted backup file
   (`IMPORT_ENCRYPTED_BACKUP`).

### 4.1 Normal vs high-security mode (spec §23)

- **Normal:** the recovery phrase alone can add a network device — the
  restored device self-derives the keys and joins.
- **High security:** the recovery phrase verifies the vault id for local
  backup use only; it does **not** persist local vault keys, mark the app
  unlocked, or join the network topic. Adding a *network* device still requires
  approval from an existing admin device through the pairing flow. Choose this
  if the phrase might be exposed but you control an existing trusted device.

The phrase is never persisted, never logged, never returned over RPC by
restore. Lose the phrase **and** all devices → the vault is cryptographically
unrecoverable. This is by design (SECURITY.md §4.1, §4.4).

---

## 5. List & revoke devices (DEVICE_LIST / DEVICE_REVOKE)

- `DEVICE_LIST` returns the authorized devices the holder can resolve (id,
  label, platform, roles, revoked flag) from sealed device records; rows it
  cannot resolve are returned sealed.
- `DEVICE_REVOKE { deviceId }` must be signed by the **root identity or an
  admin device** (`NOT_AUTHORIZED` otherwise). It appends a signed
  `DEVICE_REVOKE` and then a `KEY_ROTATE` op that **bumps the content-key
  epoch by one** (spec §23 recommendation: always rotate for future writes).

After revocation:

- the reducer's authorization gate (`_signerAuthorized`) drops every content
  op from the revoked device whose Lamport is at/after the revoke epoch — it
  cannot land new operations;
- a replay of the revoked device's *old* ops loses deterministic
  last-writer-wins (stale Lamport);
- it cannot produce content under the post-rotation epoch.

Honest limits (SECURITY.md §4.2): ops legitimately authored *before*
revocation remain valid history; content the device already decrypted while
trusted is not retroactively protected; on the pinned Autobase version,
writer-core eviction is a documented no-op so the reducer authz gate is the
load-bearing control. Revoke promptly and from a still-trusted device.

---

## 6. Invite expiry is enforced

`pairing.decodeInvite()` is the single decode path for every accept flow. If
`Date.now() > expiresAt` it throws `CryptoError` with code `PAIRING_EXPIRED`
and returns **no** topic or key material. `PAIR_ACCEPT` calls it *before* any
DHT/handshake work, so a stale QR or short code fails fast and never opens a
pairing channel. The existing-device responder also checks its stashed pending
invite expiry before admitting a signed hello, then consumes the invite after a
successful `DEVICE_ADD`. Malformed, wrong-version, or legacy invites that lack
writer-admission metadata are likewise rejected. This is covered by
`test/security/sec-pairing.test.js`.

Operational guidance: keep invite TTLs short (the 5-minute default is a good
balance), pair over a trusted local network, and always compare the 6-digit
confirmation phrase on both screens before accepting.
