# Paste Security

Status: security reference for the Paste Pear-end as implemented in
`backend/`. This document states the precise guarantee, the exact wording
product/UI copy may and must not use, how to run the verifier, and the limits
of what Paste can prove.

Spec references: the Paste technical spec (`docs/PEARPASTE_TECHNICAL_SPEC.md`) §4 (security promise), §8
(cryptography), §8.4 (provably encrypted), §11 (relay), §16 (security tests),
§19 (UX copy rules). Companion docs: THREAT_MODEL.md, PAIRING.md,
RELAY_CUSTODY.md, VERIFIER_SPEC.md.

---

## 1. The precise guarantee

Paste makes five concrete, testable promises. Each maps to enforcement
code and to a security test in `test/security/`.

### 1.1 Confidentiality of content

Note titles, note bodies, tags, and clipboard text are encrypted with
local-only symmetric keys **before** they enter any replicated structure
(Hypercore / Autobase / Hyperbee / Hyperdrive) or any relay.

- Cipher: XChaCha20-Poly1305-IETF AEAD, 24-byte random nonce per item
  (`backend/crypto-envelope.js` `seal()`).
- Per-item keys: `itemKey = HKDF(vaultKey, "item:" + itemId)`. `vaultKey`
  itself derives from a 24-word BIP-39 recovery phrase (+ optional passphrase)
  through Argon2id (`identity.js`, `crypto-envelope.js`).
- The materialized views store **only** `CryptoEnvelope` values
  (`materialized-view.js`); the local search index stores only blinded token
  pointers, never token text (`LocalSearchIndex`).
- Object identifiers in replicated headers are blinded:
  `objectBlindId = keyed-BLAKE2b(indexKey, objectId)` — the raw note/clip id
  never travels.

Enforced by: `crypto-envelope.seal/open`, `shared-ops.assertHeaderPublicOnly`,
`vault-store.putVaultHeader` (header field ban list).
Tested by: `test/security/sec-storage.test.js`,
`test/security/sec-access.test.js`.

### 1.2 Authenticity

Every replicated operation is signed by an authorized device key
(Ed25519 over `canonical(header || ciphertext || nonce || aadHash)`).
Receivers reject unsigned, mis-signed, or unauthorized operations in the
Autobase reducer before applying them. Device add/remove and key rotation are
signed by the root identity or an already-authorized admin device.

Enforced by: `crypto-envelope.signOp/verifyOp`, `autobase-sync._apply`
(signature gate), `autobase-sync._signerAuthorized`.
Tested by: `test/security/sec-auth.test.js`.

### 1.3 Integrity

- Transport/log integrity: Hypercore/Autobase verify append-only logs and
  Merkle-linked data.
- Application integrity: Paste verifies the Ed25519 op signature and the
  AEAD tag. The AEAD additional-data binds each envelope to its
  `{vaultId, objectBlindId, opType, schema}` so a ciphertext cannot be
  replayed under a different object/op/schema (AAD splice fails closed).
- Any flipped, truncated, or spliced ciphertext fails AEAD and is dropped.

Tested by: `test/security/sec-auth.test.js` (modified ciphertext / modified
header / AAD splice).

### 1.4 Relay blindness

HiveRelay receives only ciphertext, encrypted/public core keys, content-free
commitments/roots, and signed receipts — never note/clip plaintext and never
key material. A defense-in-depth guard (`relay-service.assertCiphertextOnly`)
deep-scans every relay payload and throws `RelayBlindnessError` if a forbidden
field or the plaintext sentinel is present, before anything leaves the
process. Everything handed to a relay is also mirrored to
`<storage>/relay-exports` so the verifier can audit the exact bytes.

This is *blindness*, not anonymity. Relays and network observers still learn
metadata (connection timing, sizes, that *a* vault exists). See §4 and
THREAT_MODEL.md.

Enforced by: `relay-service.assertCiphertextOnly`, `privacyTier: "p2p-only"`,
no catalog/name publication.
Tested by: `test/integration/relay-*.test.js` (Agent 2),
`test/security/sec-storage.test.js` (relay-export sentinel scan).

### 1.5 Verifiability

Users and auditors can run an independent verifier that scans local stores,
the relay-export mirror, and (optionally) the app log for the plaintext
sentinel, and asserts every stored value is an AEAD `CryptoEnvelope`. See §3.

---

## 2. Product / UI copy rules (normative — §4, §19)

These rules are enforced in code by `ui/shared/copy.js` `assertCopyClean()`
and asserted by Agent 3's e2e test. Do not weaken them.

### 2.1 Copy MAY say

- "Your notes are encrypted on your device before they enter the P2P
  network."
- "Relays store ciphertext only." / "Relays store encrypted blocks."
- "Paste ships with local and independent verifiers so you can inspect
  that plaintext never leaves the device."
- "Pair a device" · "Restore with recovery phrase" · "Run encryption
  verifier" · "Reduced availability".
- Confidentiality/authenticity/integrity claims **with** the exact qualifier
  from §1.

### 2.2 Copy MUST NOT say

- "No metadata leakage."
- "Guaranteed anonymous." / "Anonymous."
- "Provable physical deletion." / "Guaranteed deletion."
- "No one can attack this."
- "Fully encrypted guaranteed" without stating the exact guarantee.
- "Sign in with account" · "Cloud sync".
- "Trustless" — unless a specific proof is shown in-context.

---

## 3. Running the verifier (§8.4)

### 3.1 In-app proof screen

`VERIFY_ENCRYPTION` RPC → `backend/verifier.js runProofReport()`. The proof
screen shows the canonical lines, e.g.:

```
Local encryption: passed.
Storage scan: no plaintext found.
Log scan: no plaintext found.
Relay payload scan: no plaintext found.
Operation signatures: N checked, all valid against the active device set.
Revoked-device check: revoked signatures rejected after revocation epoch.
Relay custody: M relay(s) accepted ciphertext root <hash> | no relay receipts.
Independent verifier: last run <timestamp>.
Limit: this does not prove physical deletion from third-party disks.
```

The last line is required wording and is never softened.

### 3.2 Independent CLI verifier (run from source, no keys, no network)

```sh
node scripts/verify-encryption.js <storage-path> [--json] [--log <file>]
```

- `<storage-path>` is the Pear vault storage dir (`Pear.config.storage`, or
  the dev path under `~/.pearpaste-dev/store`).
- Exit code is **non-zero** if any plaintext sentinel is found in storage
  bytes / relay-export mirror / the given log file, or if any stored value is
  not an AEAD `CryptoEnvelope`. CI depends on this exit code.

Under Pear: `pear run pear://<pearpaste> --verify-encryption`.

What it checks and explicitly does **not** prove: see VERIFIER_SPEC.md.

---

## 4. Recovery, revocation + key rotation, relay custody, deletion limits

### 4.1 Recovery

The vault is recoverable only from the 24-word BIP-39 recovery phrase (+
optional passphrase). `rootSeed = Argon2id(NFKD(mnemonic) + " " +
NFKD(passphrase), salt="pearpaste-root-v1")`; from it: `vaultKey`,
`indexKey`, `deviceAdminSeed`. The phrase is shown exactly once at vault
creation and is never persisted by Paste, never logged, never sent to the
UI except that single deliberate creation-time display (`assertRendererSafe`
`allowMnemonic`). Lose the phrase (and all devices) → the data is
cryptographically unrecoverable by design. Routine unlock uses a
passphrase/OS-keychain-wrapped local blob so the phrase is not re-entered
each time (`vault-store.js`); that blob is local-only and never replicated.
Full flow: PAIRING.md §"Restore".

### 4.2 Revocation + key rotation

**The promise, in one line:** *"Revoke a device" means that device can no
longer DECRYPT anything you create AFTER you revoke it, and can no longer
write to the vault. It does NOT make the device forget what it already had,
does NOT by itself stop it from replicating the (unreadable) future log, and
does NOT help if your recovery phrase is compromised — that needs a new
vault.*

`DEVICE_REVOKE` (signed by root/admin) appends a `DEVICE_REVOKE` op and then
a `KEY_ROTATE` op that performs a **real content-key rotation**: a fresh
random epoch key (`randomBytes(32)`, never derived — an ex-admin can
re-derive anything deterministic) is sealed individually, via libsodium
sealed boxes, to each **surviving** device's box public key. The revoked
device gets no lockbox and provably cannot reconstruct the new key from any
material it retains (proven end-to-end in
`test/integration/revocation-rotation.test.js` — the decisive test attacks
the post-revoke ciphertext with every key the revoked device ever held).

What is enforced after revocation, and by which mechanism:

- **Reads of NEW content are stopped by cryptography.** Post-revoke content
  seals under the new epoch key; the revoked device cannot decrypt it even if
  it obtains the bytes (forward secrecy of content).
- **Writes are stopped by the reducer.** Any newly-arriving op from a
  committed-revoked signer is rejected outright — regardless of its claimed
  Lamport, which closes the backdated-timestamp window. Writer-core eviction
  (`removeWriter` — real on Autobase 7.28.1, NOT a no-op) is performed
  host-side as best-effort defense-in-depth, gated on the target being live
  and deferred when it is offline (evicting an offline indexer would freeze
  the base's committed checkpoint — proven empirically).
- **Replication is stopped only where you control the network edge.** The
  per-connection replication firewall refuses `store.replicate` to any peer
  that does not authenticate as a committed non-revoked device, and actively
  destroys existing streams to a device the moment its revoke applies.
  Discovery-topic rotation and the epoch-bound relay re-seed are
  conveniences, not barriers — the Autobase core key is immutable, and relay
  `unseed` is cosmetic against an already-connected peer.
- **Re-admission is gated.** A pairing bootstrap delivers only the CURRENT
  epoch key by default (full history is an explicit `grantHistory`), so a
  re-paired previously-revoked device cannot read content created during its
  revoked interval; an N-of-M admit policy stops a lone key-holder from
  quietly self-admitting once a second admin exists.

Honest limits (full residual list: THREAT_MODEL.md §2.3, REVOCATION_DESIGN.md
§7.2):

- **No past-erasure.** Everything the device already replicated or decrypted
  while trusted stays on its disk, along with `vaultKey` and every epoch key
  it was entitled to. Epoch-0 content (everything before the first rotation)
  rides with `vaultKey` and remains readable to it. Unavoidable: the bytes
  and keys are physically on its hardware.
- **Replication of opaque ciphertext continues where relays are not yours.**
  A third-party relay still seeding the old core key — or any peer that does
  not run the firewall — keeps serving the encrypted post-revoke log to the
  revoked device indefinitely. It can traffic-analyze (op cadence, sizes,
  timing); it cannot decrypt.
- **Pre-revoke ops remain valid history** (retroactive rejection would
  corrupt the log); their replay is defeated by deterministic LWW.
- **Phrase compromise is out of scope for revocation.** Anyone holding the
  24 words re-derives the root material. A hostile phrase-holder requires a
  NEW vault (cryptographic-erasure path), not device revocation.

Tested by: `test/security/sec-auth.test.js`, `test/unit/sync-reducer.test.js`,
`test/integration/revocation-rotation.test.js` (decisive forward-secrecy +
SB1), `revocation-network.test.js` (firewall/SB2 + honest L2),
`revocation-pairing.test.js` (selective-chain/B1 + admit policy),
`revocation-durability.test.js` (epoch-faithful re-append + tombstones).

### 4.3 Relay custody

Relays provide encrypted availability, not trust. p2p-only/blind by default;
HTTP gateway must not serve private vault content; catalog entries carry no
names/emails/titles/tags. Custody receipts must reference *our* ciphertext
root; a mismatch surfaces a verifier failure and is never silently trusted.
Full model and what receipts do/don't prove: RELAY_CUSTODY.md.

### 4.4 Deletion limits

Paste deletes **cryptographically, by destroying key material**:

- Soft delete appends an encrypted tombstone; the item is hidden.
- Hard delete removes the local key/record so the content can no longer be
  decrypted on this device.

Paste **cannot prove physical deletion from third-party disks.**
Append-only history and relay replicas may retain old ciphertext; a relay
operator could have snapshotted bytes. The stated deletion model is key
destruction — once keys are gone the ciphertext is unreadable, but Paste
does not and must not claim "guaranteed"/"provable physical deletion". This
is a v1 non-goal (spec §2) and is restated on the proof screen.

---

## 5. Security review checklist

This checklist is the §21 Agent 5 "security review completed before public
beta" gate. Each item names its enforcement and its automated check.

- [x] No plaintext at rest — sentinel storage scan (real vault, byte-grep).
      `sec-storage.test.js`; CI `sentinel-guard`.
- [x] No plaintext in relay exports — relay-export mirror sentinel scan.
      `sec-storage.test.js`; `relay-*` integration.
- [x] No plaintext in logs — structured logger redacts; log scan.
      `sec-storage.test.js`.
- [x] Unlock does not bulk-decrypt — `openItems` empty after unlock.
      `sec-access.test.js`.
- [x] Sealed list/search rows carry no note body, tags, or clip text. The
      short note name (`label`) is shown for navigation, decrypted in-memory
      only while unlocked (encrypted at rest, never seen by relays).
      `sec-access.test.js`.
- [x] Selected-item plaintext cleared on close/background/timeout/lock.
      `sec-access.test.js`.
- [x] Modified ciphertext fails AEAD (flip/truncate/AAD-splice).
      `sec-auth.test.js`.
- [x] Modified op header fails signature (lamport/type/deviceId/signer).
      `sec-auth.test.js`.
- [x] Revoked device cannot append (reducer authz gate).
      `sec-auth.test.js`, `sync-reducer.test.js`.
- [x] Replayed old op rejected after key rotation (LWW + epoch + authz).
      `sec-auth.test.js`.
- [x] Pairing invite expiry enforced (decode + RPC, fast-fail).
      `sec-pairing.test.js`.
- [x] Keys never cross the RPC boundary — `assertRendererSafe`.
      `desktop-vault.test.js` (Agent 3).
- [x] CI fails on plaintext sentinel leak — `sentinel-guard` job.
- [x] CI fails on unsigned release artifact — `release-guard` job.
- [x] Lockfile committed + dependency audit — `supply-chain` job.
- [x] UX copy obeys §4/§19 — `assertCopyClean` + e2e.
- [ ] External independent review (engage before public beta — M6).
- [ ] Reproducible-build attestation published (see RELEASE.md §17).

The two unchecked items require actions outside this repository (a third
party and a published build attestation) and are tracked for the M6 public
beta security pass.

---

## 6. Reporting a vulnerability

Paste is a personal app with no hosted service. Report suspected
cryptographic or isolation issues privately to the maintainer with: affected
file/commit, a reproducing test (prefer a `test/security/*` style harness),
and the impact. Do not include real recovery phrases or vault data in a
report. Crypto-impacting fixes should ship with a regression test in
`test/security/` and a CHANGELOG note.
