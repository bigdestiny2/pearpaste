# PearPaste Technical Specification

Date: 2026-05-17

Status: design specification for a new application.

Working name: PearPaste.

Product thesis: a personal, fast, always-available, end-to-end encrypted note and clipboard sync app built on the Pear / Holepunch P2P stack. It lets a user install on macOS, Linux, Windows, Android, and iOS, pair or restore devices without a central account, and copy, paste, search, and manage private notes across their own devices.

## 1. Prior Art Reviewed

This specification treats the user's existing repos as prior art, not as code to fork blindly.

- Local prior-art pages:
  - `/Users/localllm/Downloads/p2p-sites/pearbrowser/index.html`
  - `/Users/localllm/Downloads/p2p-sites/p2phiverelay/index.html`
  - `/Users/localllm/Downloads/p2p-sites/p2pbuilders/index.html`
- Upstream prior-art repos:
  - [bigdestiny2/P2P-Hiverelay](https://github.com/bigdestiny2/P2P-Hiverelay)
  - [bigdestiny2/pearbrowser-desktop](https://github.com/bigdestiny2/pearbrowser-desktop)
- Platform docs:
  - [Pear docs](https://docs.pears.com/)
  - [Pear mobile / Bare mobile app guide](https://docs.pears.com/guide/making-a-bare-mobile-app/)
  - [Pear FAQ: storage, Pear-end, binary distribution](https://docs.pears.com/reference/faq/)
  - [Hyperswarm topic discovery guide](https://docs.pears.com/howto/connect-to-many-peers-by-topic-with-hyperswarm/)
  - [Corestore guide](https://docs.pears.com/howto/work-with-many-hypercores-using-corestore/)
  - [Hyperbee guide](https://docs.pears.com/howto/share-append-only-databases-with-hyperbee/)
  - [Hyperdrive guide](https://docs.pears.com/howto/create-a-full-peer-to-peer-filesystem-with-hyperdrive/)

Key takeaways from Pear docs:

- Pear is a native P2P runtime built on Bare for desktop and mobile use cases.
- Pear apps should put business logic and P2P code in a reusable "Pear-end" worker/worklet, with platform-specific UI shells talking to it over IPC.
- On mobile, the Pear API is not currently the same as desktop; the documented path is a React Native shell plus `react-native-bare-kit`, `bare-pack`, and `bare-rpc`.
- Pear app storage lives in `Pear.config.storage`, under OS-specific Pear application directories.
- Hyperswarm is the high-level topic discovery and connection layer; the docs recommend one Hyperswarm instance per application.
- Corestore is the recommended way to manage multiple Hypercores and replicate them over one stream per peer.
- Hyperbee is an append-only key/value database built on Hypercore.
- Hyperdrive is a P2P filesystem built from Hypercore/Hyperbee pieces.

Key takeaways from HiveRelay:

- The repo is currently a monorepo with `packages/core`, `packages/client`, `packages/services`, and `packages/verifier`; package metadata and release notes show `0.8.13`, while some README copy still references earlier `0.8.x` status.
- HiveRelay provides always-on availability, relay discovery, proof/verification primitives, circuit-relay patterns, and blind custody patterns.
- The current security docs distinguish what is mathematically enforced from what remains residual risk: relays can see encrypted bytes and metadata, can refuse service, but should not receive plaintext or data keys in blind mode.
- Atomic Blind Custody gives quorum receipts, source retirement, and witness tombstones for encrypted custody flows, while honestly not proving physical deletion.
- Release `0.8.13` adds a cancellation/lifecycle contract that prevents stale async references after relay restart, important for long-running availability.

Key takeaways from PearBrowser Desktop:

- The app architecture is reusable: Bare main process, one Hyperswarm, one Corestore, renderer/UI over a local RPC bridge.
- Existing modules worth emulating conceptually: `identity.js`, `user-data.js`, `profile.js`, `contacts.js`, `relay-client.js`, `swarm-bridge.js`, `swarm-grants.js`, `site-manager.js`.
- It already models BIP-39 recovery, per-app subkeys, Hyperbee-backed user data, consented capabilities, relay configuration, and native-app distribution paths.
- `docs/SWARM-V1.md` is a useful permission model for page-scoped direct Hyperswarm access, but PearPaste should expose less surface area because it is a personal app, not a browser runtime.

## 2. Product Definition

PearPaste is a personal encrypted notes and clipboard relay between a user's own devices.

Core experiences:

- Copy on one device, paste on another.
- Save snippets as private notes.
- Search recent clips and notes locally with instant results.
- Keep notes and clips sealed by default; decrypt a specific item only when the user taps it or explicitly copies it.
- Pin favorite notes for quick paste.
- Pair a new device by QR code, short code, or recovery phrase.
- Keep data available even if every personal device is asleep, using blind encrypted relay storage.
- Show a human-readable "Encryption Proof" screen explaining what is encrypted, where ciphertext is stored, which relays custody it, and which tests/verifiers passed.

Non-goals for v1:

- Team sharing.
- Public notes or publishing.
- Browser extension.
- Rich collaborative document editing.
- Cloud accounts, email/password login, or hosted SaaS APIs.
- Full anonymity. Hyperswarm peers and relays can learn network metadata unless the user opts into Tor/VPN-style transports.
- Proving physical deletion from remote disks. PearPaste can cryptographically delete by destroying keys and can request or verify non-serving state where HiveRelay supports it, but it cannot prove a remote operator did not snapshot ciphertext.

## 3. Hard Requirements

Functional:

- Desktop support: macOS, Linux, Windows through Pear Runtime and later signed native shells.
- Mobile support: iOS and Android through React Native plus `react-native-bare-kit`.
- First device creates a vault locally.
- New devices join by:
  - scan QR pairing invite from an existing unlocked device,
  - enter a short pairing code,
  - restore from a 24-word recovery phrase plus optional passphrase.
- Text clipboard sync in v1.
- Notes CRUD in v1.
- Local full-text search in v1.
- Optional image/file clipboard in v2.
- Offline-first operation: local notes remain usable with no network.
- Multi-device convergence: changes from any authorized device reach all other authorized devices.

Security:

- Note and clipboard plaintext must never be written to Hypercore, Hyperbee, Hyperdrive, HiveRelay, logs, crash reports, telemetry, or app package storage.
- All user content is encrypted locally before entering any replicated data structure.
- Unlocking the vault authorizes the device and makes keys available to the Pear-end, but it must not bulk-decrypt notes or clips.
- Individual note/clip plaintext is decrypted only after explicit user action: tap to view, tap to copy, paste from selected item, or intentional export.
- Decrypted item plaintext must be cleared from UI state and backend memory after close, copy completion, lock, timeout, or app backgrounding.
- Relays must receive ciphertext only.
- All replicated operations are signed by an authorized device key.
- Device add/remove operations are signed by the root identity or an already-authorized admin device.
- Removed devices cannot decrypt future content after key rotation.
- Logs must redact note bodies, clipboard bodies, vault keys, device private keys, pairing secrets, and recovery phrases.

Performance:

- Cold app launch target: under 1.5 seconds after runtime is warm on a current laptop.
- Idle network target: comparable to Pear/Hyperswarm baseline, with no polling loops faster than necessary.
- Local note query target: under 30 ms for 10,000 text notes on desktop.
- Clipboard-to-remote-device target:
  - direct peer online: under 300 ms after peer connection exists,
  - via relay/catch-up: under 2 seconds after the remote app wakes and connects.
- App package should be small enough to distribute as a Pear app and later native shell; avoid heavy frameworks in the Pear-end.

## 4. Security Promise

The product copy can say:

"Your notes are encrypted on your device before they enter the P2P network. Relays store ciphertext only. PearPaste ships with local and independent verifiers so you can inspect that plaintext never leaves the device."

The product copy must not say:

- "No metadata leakage."
- "Guaranteed anonymous."
- "Provable physical deletion."
- "No one can attack this."
- "Fully encrypted guaranteed" without qualifying the exact guarantee.

Precise guarantee:

- Confidentiality of content: note and clipboard bodies are encrypted with local-only symmetric keys before storage or replication.
- Authenticity: every operation is signed by an authorized device key; receivers reject unsigned or unauthorized operations.
- Integrity: Hypercore/Autobase verify append-only logs and Merkle-linked data; PearPaste verifies app-level signatures and AEAD tags.
- Relay blindness: HiveRelay blind mode and/or Atomic Blind Custody should receive only ciphertext, encrypted roots, commitments, and signed receipts, never note plaintext or data keys.
- Verifiability: users and auditors can run a verifier that scans local stores, exported relay blocks, operation logs, and app logs for known plaintext sentinels and validates that all accepted content is AEAD encrypted and signed.

## 5. Top-Level Architecture

Use one shared Pear-end across desktop and mobile:

```text
Desktop UI: Pear desktop / pear-electron shell
Mobile UI: React Native shell
             |
             | IPC / RPC
             v
PearPaste Pear-end: Bare runtime code
  - Identity manager
  - Crypto envelope manager
  - Device pairing manager
  - Clipboard manager adapter
  - Notes service
  - Sync engine: Corestore + Autobase + Hyperbee materialized views
  - Network engine: one Hyperswarm
  - Relay engine: HiveRelay client, custody receipts, durability status
  - Verifier hooks
             |
             v
P2P network: Hyperswarm + Hypercore replication + HiveRelay blind storage
```

Implementation rule:

- Exactly one Hyperswarm instance per Pear-end.
- Exactly one Corestore root per vault per install.
- Use Corestore namespaces for distinct subsystems.
- Use Autobase for multi-writer cross-device operations.
- Use Hyperbee for encrypted materialized views and local indexes.
- Avoid Hyperdrive for private notes unless a filesystem/export feature needs it; Hyperdrive is more useful for app bundles, public assets, and optional encrypted backup packages.

## 6. Repository Layout

Suggested repo:

```text
pearpaste/
  package.json
  pear.json
  index.html
  index.js
  ui/
    desktop/
    shared/
  backend/
    index.js
    rpc.js
    identity.js
    crypto-envelope.js
    pairing.js
    vault-store.js
    autobase-sync.js
    materialized-view.js
    clipboard.js
    notes-service.js
    relay-service.js
    verifier.js
    lifecycle-scope.js
  mobile/
    app/
    backend/
    rpc-commands.mjs
  scripts/
    verify-encryption.js
    inspect-store.js
    release-prod.sh
    pin-on-hiverelay.js
  docs/
    PEARPASTE_TECHNICAL_SPEC.md
    SECURITY.md
    THREAT_MODEL.md
    PAIRING.md
    RELAY_CUSTODY.md
  test/
    unit/
    integration/
    e2e/
```

## 7. Data Model

### 7.1 Vault

The vault is the user's encrypted personal dataset.

```ts
type VaultId = string // hex(HMAC(vaultPublicIdKey, "vault-id:v1"))

interface VaultHeader {
  version: 1
  vaultId: VaultId
  createdAt: number
  rootPubkey: string
  kdf: "argon2id" | "sodium-crypto-pwhash" | "platform-keystore"
  crypto: "xchacha20poly1305-ietf"
  sync: "autobase-v1"
}
```

The vault header is public-ish metadata. It must not contain names, emails, note titles, or user content.

### 7.2 Device

Each device has an Ed25519 signing key and an encryption recipient key.

```ts
interface DeviceRecordPlaintext {
  deviceId: string
  label: string
  platform: "macos" | "linux" | "windows" | "android" | "ios"
  signingPubkey: string
  boxPubkey: string
  roles: Array<"admin" | "writer" | "reader">
  createdAt: number
  revokedAt?: number
}
```

The replicated record is encrypted and signed:

```ts
interface DeviceRecordEnvelope {
  type: "DEVICE_RECORD"
  deviceIdBlind: string
  ciphertext: string
  nonce: string
  signature: string
  signer: string
}
```

### 7.3 Note

Note bodies and titles are always encrypted.

```ts
interface NotePlaintext {
  noteId: string
  title: string
  body: string
  bodyFormat: "plain" | "markdown" | "code"
  tags: string[]
  pinned: boolean
  createdAt: number
  updatedAt: number
  deletedAt?: number
}
```

### 7.4 Clipboard Item

Clipboard items are notes with short retention defaults.

```ts
interface ClipPlaintext {
  clipId: string
  kind: "text" | "url" | "code"
  body: string
  sourceDeviceId: string
  capturedAt: number
  expiresAt?: number
  promoteToNote?: boolean
}
```

### 7.5 Operation Log

All sync is operation based. Operation bodies are encrypted; headers contain minimal routing data.

```ts
interface OpHeader {
  version: 1
  opId: string
  vaultId: string
  deviceId: string
  type:
    | "NOTE_UPSERT"
    | "NOTE_DELETE"
    | "CLIP_ADD"
    | "CLIP_DELETE"
    | "DEVICE_ADD"
    | "DEVICE_REVOKE"
    | "KEY_ROTATE"
    | "ACK"
  objectBlindId: string
  lamport: string
  createdAtBucket: string // coarse bucket, not exact timestamp unless necessary
}

interface ReplicatedOp {
  header: OpHeader
  ciphertext: string
  nonce: string
  aadHash: string
  signerPubkey: string
  signature: string
}
```

`objectBlindId = HMAC(indexKey, objectId)`, not the raw note/clip ID.

## 8. Cryptography

### 8.1 Key Hierarchy

Use a root recovery secret plus per-device keys.

```text
recovery entropy: 256 bits from secure random
mnemonic: 24 words, plus optional user passphrase
rootSeed = KDF(mnemonic, passphrase, salt = "pearpaste-root-v1")
vaultKey = HKDF(rootSeed, "pearpaste-vault-key-v1")
indexKey = HKDF(rootSeed, "pearpaste-index-key-v1")
deviceAdminKey = HKDF(rootSeed, "pearpaste-device-admin-v1")
```

For each item:

```text
itemKey = HKDF(vaultKey, "item:" + itemId)
nonce = random 24 bytes
ciphertext = XChaCha20-Poly1305(itemKey, nonce, plaintextJson, aad)
```

For operation signatures:

```text
signature = Ed25519.sign(canonical(header || ciphertext || nonce || aadHash), deviceSigningSecret)
```

Root identity only authorizes devices and key rotations. Day-to-day note edits are signed by device keys.

### 8.2 Envelope Format

```ts
interface CryptoEnvelope {
  v: 1
  alg: "XCHACHA20-POLY1305"
  keyId: string
  nonce: string
  aad: {
    vaultId: string
    objectBlindId: string
    opType: string
    schema: string
  }
  ciphertext: string
}
```

### 8.3 Plaintext Rules

Plaintext may exist only:

- in memory while the app is unlocked,
- in OS clipboard APIs as required for copy/paste,
- in transient UI state,
- in user-approved explicit exports.

Plaintext must not be written to:

- Corestore,
- Hyperbee,
- Hypercore,
- Hyperdrive,
- HiveRelay,
- logs,
- crash reports,
- analytics,
- screenshots generated by tests unless the test is explicitly a UI plaintext test and stored only in ignored artifacts.

### 8.4 "Provably Encrypted" Implementation

Ship a verifier:

```sh
pear run pear://<pearpaste> --verify-encryption
node scripts/verify-encryption.js <storage-path>
```

Verifier checks:

- Every stored note/clip value is a `CryptoEnvelope`.
- Every envelope decrypts only with the local vault key.
- Random sentinel plaintext inserted during test never appears in storage bytes.
- Random sentinel plaintext never appears in relay payload exports.
- Logs do not contain sentinel plaintext.
- Operation signatures validate against the active device set.
- Revoked device signatures are rejected after revocation epoch.
- Relay custody receipts match ciphertext roots, not plaintext roots.

User-facing proof screen:

- "Local encryption: passed."
- "Storage scan: no plaintext found."
- "Relay custody: N relays accepted ciphertext root <hash>."
- "Independent verifier: last run <timestamp>."
- "Limit: this does not prove physical deletion from third-party disks."

## 9. Sync Engine

### 9.1 Corestore

Desktop:

```js
const store = new Corestore(Pear.config.storage)
```

Mobile:

- React Native UI launches a Bare worklet with `react-native-bare-kit`.
- The worklet receives the platform document directory path as an arg.
- The Pear-end creates `new Corestore(path.join(Bare.argv[0], "pearpaste-corestore"))`.

### 9.2 Autobase

Use Autobase for multi-writer operation logs.

Writers:

- one writer core per authorized device,
- writer core key is part of encrypted device records,
- adding a device appends `DEVICE_ADD`,
- revoking a device appends `DEVICE_REVOKE` and triggers key rotation.

Autobase view:

- validates op signatures,
- decrypts op body in memory,
- applies deterministic reducer,
- writes encrypted current-state records into Hyperbee materialized views.

### 9.3 Hyperbee Views

Suggested encrypted views:

```text
notes!<objectBlindId> -> encrypted NotePlaintext current state
clips!<bucket>!<objectBlindId> -> encrypted ClipPlaintext
pins!<sort>!<objectBlindId> -> encrypted pointer record
tags!<tagBlindId>!<objectBlindId> -> encrypted pointer record
devices!<deviceBlindId> -> encrypted DeviceRecordPlaintext
settings!<keyBlindId> -> encrypted setting
search!<tokenBlindId>!<objectBlindId> -> encrypted search pointer
```

Search tokens must be derived locally:

```text
tokenBlindId = HMAC(indexKey, normalizedToken)
```

This leaks equality of repeated tokens within the vault to anyone with raw store access, but not the token text. For stronger privacy, disable replicated search index and build per-device local indexes only.

Default v1:

- Local-only search index by default.
- Optional encrypted replicated search index behind "faster search on new devices" setting.
- Search should return sealed result rows by default. Titles, bodies, and clip text are decrypted only when the user taps a result.

### 9.4 Tap-to-Decrypt Item Lifecycle

Default item lifecycle:

```text
sealed list row -> user taps -> decrypt selected envelope in Pear-end
                -> return plaintext for that one item to UI
                -> start memory/visibility timer
                -> user closes item, app locks, app backgrounds, or timer expires
                -> UI clears plaintext
                -> Pear-end drops plaintext buffers and decrypted object cache
```

Rules:

- No bulk decrypt on app unlock.
- No decrypted title cache at rest.
- No decrypted note preview cache at rest.
- No decrypted clipboard history cache at rest.
- List rows may show non-sensitive local metadata only: type icon, coarse modified bucket, device label if user chooses, and sealed/pinned status.
- Pinned does not mean decrypted. Pinned only changes ordering.
- Copy action decrypts the selected item, writes it to the OS clipboard, then clears app-held plaintext immediately after the OS write completes.
- Optional convenience mode may keep a selected note visible for a user-configured timeout, default 60 seconds, never across lock/background.

### 9.5 Conflict Resolution

Use deterministic last-writer-wins per field with Lamport clock tie-breakers:

```text
winner = max(lamport, deviceId)
```

For text bodies, v1 uses whole-note update. v2 can add CRDT text if collaborative editing becomes a goal.

Deletes:

- Soft delete: append tombstone, hide from UI.
- Hard delete: delete local key material for item if item-level keys are enabled; append encrypted hard-delete tombstone.
- Relay data may retain old ciphertext in append-only history. This is acceptable if key destruction is the stated deletion model.

## 10. Network Engine

Use one Hyperswarm instance:

```text
swarm.join(vaultDiscoveryTopic, { server: true, client: true })
swarm.on("connection", conn => store.replicate(conn))
```

Topics:

- `vaultDiscoveryTopic = HMAC(vaultKey, "swarm-topic-v1")`, 32 bytes.
- Pairing topics are temporary, random, and expire quickly.
- Relay discovery uses HiveRelay client internals.

Connection policy:

- Direct peer replication preferred.
- Relay-assisted replication when direct peers are unavailable.
- Exponential reconnect with jitter.
- No duplicate swarm instances.
- Teardown drains async loops before closing Corestore, borrowing the HiveRelay `LifecycleScope` idea from release `0.8.13`.

## 11. HiveRelay Integration

HiveRelay is used for encrypted availability, not trust.

Use cases:

- Keep app package available.
- Keep encrypted vault operation logs available while all user devices are offline.
- Provide custody receipts for ciphertext roots.
- Provide live relay status for the app's "always online" indicator.

Privacy tier:

- PearPaste vaults are `p2p-only` / blind by default.
- HTTP gateway must not serve private vault content.
- Catalog entries must not include names, emails, note titles, tags, or user-provided metadata.

Persistent encrypted availability:

```js
await relay.seed(vaultDriveOrCoreKey, {
  durability: 1,
  privacyTier: "p2p-only",
  replicationFactor: 5,
  maxStorageBytes,
  revocable: true
})
```

Atomic Blind Custody for temporary clipboard items:

```js
await relay.publishCustodyIntent(relayUrl, {
  blindContentId,
  ciphertextRoot,
  requiredReplicas: 3,
  deadline: Date.now() + 60_000,
  retainUntil: Date.now() + ttlMs,
  privacyTier: "p2p-only",
  metadataVisibility: "redacted"
}, auth)
```

Relay status UX:

- "Direct peers: 2"
- "Relays holding ciphertext: 5"
- "Custody quorum: 3/3"
- "Last verifier run: passed"
- "Last key rotation: <date>"

Failure behavior:

- If no relays are reachable, app remains local-first and direct-P2P.
- If relay quorum is below target, UI shows "reduced availability" but does not block local use.
- If custody quorum fails for temporary clips, app keeps the clip local and retries or asks user to keep one device online.

## 12. Desktop Application

Runtime:

- Pear desktop app with `pear-electron`.
- Bare backend is the Pear-end.
- React/htm or lightweight React build for UI.
- No remote web assets.

Desktop UI:

- Menu bar/tray quick access.
- Global hotkey to show paste palette.
- Recent clips list with sealed rows.
- Notes list with sealed rows and a tap-to-decrypt editor.
- Search box.
- Device list.
- Pair device button.
- Encryption proof panel.
- Relay status panel.

Clipboard integration:

- macOS/Windows/Linux clipboard read/write through the desktop shell.
- User setting: manual capture only vs monitor clipboard.
- Never capture password-manager fields if OS can identify sensitive source; otherwise provide exclusion patterns and quick pause.
- Local debounce and dedup by HMAC of clipboard text.
- Recent clipboard rows are sealed. The actual clip text is decrypted only on tap/copy.

Desktop packaging:

- Developer path: `pear run --dev .`
- User path v1: `pear run pear://<production-key>`
- User path v1.5: native wrappers via Pear app binary distribution path for macOS, Windows, Linux.
- Signed native installers once packaging stabilizes.

## 13. Mobile Application

Runtime:

- React Native shell.
- Bare worklet via `react-native-bare-kit`.
- Pear-end bundled with `bare-pack --target ios --target android --linked`.
- UI communicates with Pear-end via `bare-rpc`.

Mobile clipboard reality:

- iOS and Android restrict background clipboard monitoring. v1 mobile should support:
  - paste into PearPaste to capture,
  - copy from PearPaste,
  - share sheet into PearPaste,
  - foreground polling only while app is open and user enables it.
- Android may support richer foreground clipboard workflows than iOS; do not promise invisible background sync on all mobile OSes.

Mobile screens:

- Unlock.
- Recent clips.
- Notes.
- Paste/share target.
- Pair device scanner.
- Recovery phrase restore.
- Relay/proof status.

Mobile packaging:

- TestFlight / internal APK first.
- Store builds later.
- Same Pear-end code as desktop wherever possible.

## 14. Pairing and Login

There is no central login. There is vault unlock, restore, and device pairing.

First device:

1. Generate recovery entropy.
2. Show 24-word phrase once with confirmation.
3. Create root identity.
4. Create first device key.
5. Create vault operation log.
6. Start direct P2P and optional relay availability.

Pair new device:

1. Existing unlocked device creates one-time pairing invite.
2. Invite encodes:
   - temporary topic,
   - invite public key,
   - expiry,
   - optional relay hints.
3. New device joins pairing topic.
4. Devices perform Noise/Secretstream handshake.
5. Existing device displays confirmation phrase or numeric code.
6. Existing device sends encrypted vault bootstrap:
   - vault header,
   - vaultKey wrapped for new device,
   - active device list,
   - Autobase writer info,
   - relay config.
7. Existing device appends signed `DEVICE_ADD`.
8. New device starts sync.

Recovery restore:

1. User enters 24-word phrase and optional passphrase.
2. Device derives root seed.
3. Device locates vault by deterministic topic.
4. If no peers/relays found, user can import an encrypted backup file.
5. Device creates a new device key and either:
   - self-authorizes if root key signs recovery add, or
   - requires existing device approval depending on security setting.

Security setting:

- Normal: recovery phrase can add a device.
- High security: recovery phrase decrypts local backup, but adding a network device requires an existing admin device.

## 15. API Surface

Backend RPC commands:

```ts
UNLOCK_VAULT
LOCK_VAULT
CREATE_VAULT
RESTORE_VAULT
PAIR_CREATE_INVITE
PAIR_ACCEPT
DEVICE_LIST
DEVICE_REVOKE
NOTE_LIST
NOTE_OPEN
NOTE_CLOSE
NOTE_UPSERT
NOTE_DELETE
CLIP_LIST
CLIP_OPEN
CLIP_CLOSE
CLIP_CAPTURE
CLIP_COPY
SEARCH
RELAY_STATUS
RELAY_SET_ENABLED
VERIFY_ENCRYPTION
EXPORT_ENCRYPTED_BACKUP
IMPORT_ENCRYPTED_BACKUP
```

Renderer contract:

- UI never receives vault keys.
- UI receives plaintext only for the one note or clip the user explicitly opens, copies, pastes, or exports.
- UI list views receive sealed metadata, not decrypted titles or bodies by default.
- UI must discard plaintext on lock.
- UI must discard selected-item plaintext when the item closes, the app backgrounds, or the visibility timer expires.
- Backend can refuse clipboard reads when locked.

## 16. Testing Strategy

Unit tests:

- mnemonic and KDF derivation,
- envelope encrypt/decrypt,
- wrong key rejection,
- signature verification,
- canonical encoding stability,
- device revoke and key rotation,
- note reducer deterministic output,
- search tokenization and HMAC index.

Integration tests:

- two desktop Pear-end instances sync via Hyperswarm testnet,
- three-device Autobase convergence,
- relay unavailable fallback,
- HiveRelay seed/custody happy path,
- relay custody quorum failure path,
- mobile Bare worklet RPC smoke test,
- lifecycle shutdown and restart with no stale Corestore references.

Security tests:

- sentinel plaintext storage scan,
- sentinel plaintext relay export scan,
- logs scan,
- unlock does not bulk-decrypt notes or clips,
- sealed list rendering does not receive plaintext titles, bodies, or clip text,
- selected item plaintext is cleared on close, background, timeout, and lock,
- revoked device cannot append,
- modified ciphertext fails AEAD,
- modified op header fails signature,
- replayed old op rejected after key rotation,
- pairing invite expiry enforced.

E2E tests:

- create vault on desktop A,
- pair desktop B,
- capture clipboard on A and paste from B,
- create note on B and search on A,
- pair mobile,
- revoke B,
- verify B cannot decrypt new clips,
- run encryption verifier.

## 17. Release and Distribution

Development:

```sh
npm install
pear run --dev .
```

Production Pear release:

- stage app,
- release production link,
- pin app package on HiveRelay,
- run verifier against staged app files,
- publish release notes.

Native desktop:

- use Pear binary wrapper path for macOS, Linux, Windows,
- sign macOS and Windows artifacts,
- keep Linux packages unsigned or distro-appropriate,
- preserve Pear P2P update path so wrapper rarely needs rebuild.

Mobile:

- `bare-pack` Pear-end bundle for iOS and Android,
- run platform-native CI,
- publish internal test builds,
- later app store builds.

Supply-chain requirements before public beta:

- lockfile committed,
- dependency audit,
- reproducible build notes,
- signed releases,
- public verifier CLI,
- at least one independent storage verifier implementation if feasible.

## 18. Observability Without Telemetry

No remote analytics.

Local diagnostics only:

- peer count,
- relay count,
- sync lag,
- last successful append,
- last relay custody receipt,
- storage size,
- verifier status,
- redacted error logs.

Export diagnostics:

- user-triggered,
- encrypted by default,
- plaintext export requires explicit confirmation,
- no note bodies unless user opts in.

## 19. UX Copy Rules

Use:

- "Pair a device"
- "Restore with recovery phrase"
- "Relays store encrypted blocks"
- "Run encryption verifier"
- "Reduced availability"

Avoid:

- "Sign in with account"
- "Cloud sync"
- "Guaranteed deletion"
- "Anonymous"
- "Trustless" unless a specific proof is shown.

## 20. Milestones

### M0: Specification and skeleton

- Repo skeleton.
- Backend process boots.
- Desktop UI shell.
- Mobile shell proof of life.
- Unit test harness.

### M1: Local encrypted notes

- Vault create/unlock.
- Encrypted Hyperbee storage.
- Note CRUD.
- Local search.
- Storage verifier.

### M2: Multi-device direct P2P

- Pairing QR/short code.
- Autobase multi-writer sync.
- Device list/revoke.
- Clipboard text capture.
- Direct Hyperswarm replication.

### M3: Always-online encrypted relay

- HiveRelay client integration.
- Blind relay seeding.
- Relay status and durability target.
- Custody receipts for clips/backups.
- Verifier includes relay exported ciphertext checks.

### M4: Desktop productization

- Tray/menu bar.
- Global hotkey.
- Signed desktop wrappers.
- Crash-safe lifecycle handling.
- Release process.

### M5: Mobile parity

- React Native UI.
- Bare worklet bundle.
- Pair/restore.
- Share sheet capture.
- Foreground clipboard workflows.

### M6: Public beta security pass

- Threat model finalized.
- Reproducible build notes.
- External review.
- Independent verifier or verifier spec.
- Documentation and support guides.

## 21. Work Split for Five Agents

### Agent 1: Pear-end Crypto and Sync Engine

Ownership:

- `backend/identity.js`
- `backend/crypto-envelope.js`
- `backend/vault-store.js`
- `backend/autobase-sync.js`
- `backend/materialized-view.js`
- `backend/notes-service.js`
- `backend/lifecycle-scope.js`
- unit tests under `test/unit/crypto-*`, `test/unit/sync-*`

Responsibilities:

- Implement vault creation, unlock, lock, and recovery derivation.
- Implement encrypted envelope format.
- Implement device signing and authorization.
- Implement Autobase operation log and deterministic reducer.
- Implement encrypted Hyperbee views.
- Implement local search index.
- Implement lifecycle shutdown pattern so Corestore closes only after async loops drain.

Interfaces delivered:

- `createVault(opts)`
- `unlockVault(secret)`
- `lockVault()`
- `appendOp(type, plaintextPayload)`
- `listNotes(query)`
- `openNote(id)`
- `closeNote(id)`
- `upsertNote(note)`
- `deleteNote(id)`
- `verifyLocalEncryption()`

Acceptance tests:

- Sentinel plaintext never appears in Corestore bytes.
- Two local Pear-end instances converge to same view.
- Modified ciphertext fails.
- Revoked device append is rejected.
- Shutdown/restart under active replication has no Corestore closed errors.

### Agent 2: HiveRelay Availability and Proof Layer

Ownership:

- `backend/relay-service.js`
- `backend/verifier.js`
- `scripts/pin-on-hiverelay.js`
- `scripts/verify-encryption.js`
- `docs/RELAY_CUSTODY.md`
- integration tests under `test/integration/relay-*`

Responsibilities:

- Integrate `p2p-hiverelay-client` `0.8.13` or later.
- Discover relays through HiveRelay client.
- Seed encrypted vault logs with p2p-only/blind settings.
- Implement custody intent path for temporary clips and encrypted backup capsules.
- Track relay capability docs, custody receipts, quorum status, and non-serving proofs where available.
- Build user-facing proof report.
- Build CLI verifier that validates local and relay ciphertext claims.

Interfaces delivered:

- `startRelayService(store, swarm)`
- `seedVault(vaultKeyOrDriveKey, opts)`
- `publishTemporaryCustody(ciphertextRoot, ttl)`
- `getRelayStatus()`
- `runProofReport()`

Acceptance tests:

- Relay receives no plaintext fields or data keys.
- Custody status reaches quorum in test network.
- Relay unavailable state does not block local usage.
- Verifier catches an intentionally plaintext-inserted bad record.
- Release notes document exactly what the proof does and does not prove.

### Agent 3: Desktop App, Clipboard, and Distribution

Ownership:

- `index.html`
- `index.js`
- `ui/desktop/*`
- `ui/shared/*`
- `backend/clipboard.js`
- desktop packaging scripts
- E2E tests under `test/e2e/desktop-*`

Responsibilities:

- Build Pear desktop shell.
- Implement tray/menu bar and global paste palette.
- Implement clipboard read/write adapter.
- Implement Notes, Clips, Devices, Relay Status, Encryption Proof, Settings screens.
- Implement lock state UX and plaintext clearing.
- Implement desktop release flow with Pear production link and native wrapper plan.

Interfaces consumed:

- RPC commands from backend.
- `CLIP_CAPTURE`, `CLIP_COPY`, `NOTE_*`, `PAIR_*`, `VERIFY_ENCRYPTION`.

Acceptance tests:

- Copy on desktop A appears in desktop B.
- Paste palette opens with global hotkey.
- Lock clears plaintext UI state.
- UI never logs note body.
- Desktop package runs from `pear run --dev .`.

### Agent 4: Mobile App and Pairing UX

Ownership:

- `mobile/app/*`
- `mobile/backend/*`
- `mobile/rpc-commands.mjs`
- pairing screens in shared UI where applicable
- mobile E2E smoke tests

Responsibilities:

- Build React Native shell.
- Bundle Pear-end with `bare-pack --target ios --target android --linked`.
- Run Bare worklet through `react-native-bare-kit`.
- Implement `bare-rpc` bridge to shared backend commands.
- Implement QR scanner and short-code pairing UX.
- Implement recovery phrase restore UX.
- Implement foreground clipboard/share sheet workflows.
- Document OS clipboard limits honestly.

Interfaces delivered:

- `MobilePearEnd.start(storagePath, pairingInvite?)`
- RN hooks for `usePearPasteRpc()`.
- Pairing QR and scanner components.

Acceptance tests:

- Worklet starts on iOS and Android test targets.
- Mobile can pair with desktop.
- Mobile can create a note and see desktop note.
- Mobile can copy a note to clipboard.
- App handles worklet crash with recoverable error UI.

### Agent 5: Security, QA, Release, and Documentation

Ownership:

- `docs/SECURITY.md`
- `docs/THREAT_MODEL.md`
- `docs/PAIRING.md`
- `docs/RELEASE.md`
- CI workflows
- verifier specs
- test plans

Responsibilities:

- Write final threat model.
- Define secure wording for product and UI.
- Maintain "what we prove / what we do not prove" section.
- Add CI for unit, integration, lint, storage sentinel scans.
- Add dependency audit and lockfile checks.
- Define reproducible build process.
- Prepare public beta checklist.
- Coordinate manual test matrix across macOS, Linux, Windows, iOS, Android.

Acceptance tests:

- CI fails on plaintext sentinel leak.
- CI fails on unsigned release artifact.
- Docs include recovery, revocation, relay, and deletion limits.
- Security review checklist completed before public beta.
- Release build can be independently verified from source.

## 22. Cross-Agent Contracts

All agents must honor these contracts:

- No plaintext at rest.
- No extra Hyperswarm instances.
- No second Corestore unless explicitly namespaced under test.
- Backend owns secrets; UI owns display only.
- All RPC commands are schema-validated.
- Every async background loop accepts cancellation.
- Logs are structured and redacted.
- Every new replicated field is classified as public metadata, encrypted content, or forbidden.

## 23. Open Decisions

- KDF implementation in Bare: use libsodium `crypto_pwhash` if available across desktop/mobile; otherwise pick a supported audited KDF package that works in Bare.
- Whether v1 replicated search index is disabled by default or shipped as opt-in.
- Whether key rotation occurs on every device removal or only removal of admin/writer devices. Recommendation: always rotate content keys for future writes.
- Whether to support password unlock in addition to OS keychain. Recommendation: support both; never require a cloud account.
- Whether to implement temporary clips as Atomic Blind Custody in v1 or start with persistent encrypted operation logs. Recommendation: persistent logs first, custody for expiring clips in M3.

## 24. First Implementation Slice

The smallest meaningful slice:

1. Desktop Pear app opens.
2. User creates local vault.
3. User writes one note.
4. Note is stored as encrypted envelope in Hyperbee.
5. User locks and unlocks.
6. Verifier proves sentinel plaintext is absent from storage.

Only after that should multi-device pairing begin. The encryption invariant is the foundation; everything else gets easier if that invariant is real from day one.
