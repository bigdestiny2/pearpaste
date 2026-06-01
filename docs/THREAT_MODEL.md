# Paste Threat Model

Status: threat model for Paste as implemented in `backend/`. Honest
framing, mirroring HiveRelay's "what is mathematically enforced vs residual
risk" style. Nothing here is softened for marketing.

Spec references: §2 (non-goals), §4 (security promise), §8 (crypto), §11
(relay). Companions: SECURITY.md, RELAY_CUSTODY.md, VERIFIER_SPEC.md.

---

## 1. Assets

What we are protecting, most to least sensitive:

| Asset | Where it lives | Sensitivity |
|---|---|---|
| Recovery phrase (24-word BIP-39) + passphrase | User's memory / out-of-band only; never stored by Paste | Catastrophic — root of all keys |
| Root seed, `vaultKey`, `indexKey`, `deviceAdminSeed` | Process memory while unlocked; wrapped at rest in the local-only device blob | Catastrophic — decrypts everything |
| Per-item keys (`itemKey`) | Derived on demand in memory; wiped after use | High — decrypts one item |
| Device signing/box secret keys | Local-only `local-device.json`, AEAD-wrapped under the unlock secret | High — can sign ops as that device |
| Note titles, bodies, tags, clipboard text | Encrypted envelopes in Hyperbee/Autobase; plaintext only transiently in memory/OS clipboard | High — the user's actual data |
| Selected-item plaintext | `ctx.state.openItems` transiently (tap-to-decrypt) | High — cleared on close/bg/timeout/lock |
| Vault metadata (vaultId, header, blind ids, op timing, sizes, peer set) | Replicated/observable by design | Low–medium — content-free but correlatable |

## 2. Adversaries and what is enforced vs residual

### 2.1 Curious / honest-but-curious relay

**Capability:** holds replicated ciphertext and custody payloads; sees public
core keys, ciphertext roots, sizes, timing; can refuse service.

- **Mathematically enforced:** never receives plaintext or key material —
  content only leaves the crypto layer as a `CryptoEnvelope`;
  `assertCiphertextOnly()` deep-scans every relay payload and throws before
  egress; payloads mirrored to `relay-exports/` and sentinel-scanned by the
  verifier; `privacyTier:'p2p-only'`, no catalog entry. Receipts must bind
  *our* ciphertext root or the verifier fails.
- **Residual risk:** learns metadata (that a vault exists, op cadence,
  ciphertext sizes, the public log key, peer IPs at connection); can refuse
  service or drop replicas; may snapshot ciphertext and keep it after a
  deletion request. Mitigation: cryptographic erasure (destroy keys → bytes
  undecryptable), durability fleet, honest non-goal disclosure.

### 2.2 Network / on-path observer

**Capability:** observes DHT participation and connection metadata; may MITM
transport.

- **Enforced:** Hyperswarm/Hypercore transport is authenticated and
  integrity-checked (Noise/Merkle); app-level AEAD + Ed25519 mean a MITM
  cannot read or forge accepted content; tampered bytes fail closed.
- **Residual risk:** sees IPs, timing, sizes, that the user runs a P2P app;
  can correlate. Paste is **not anonymous** — Tor/VPN-style transport is
  the user's responsibility (spec §2). Copy must not claim "no metadata
  leakage" / "anonymous".

### 2.3 Malicious paired (then revoked) device

**Capability:** was a legitimate writer; may try to keep writing or replay old
ops after the user revokes it.

- **Enforced:** `DEVICE_REVOKE` (signed by root/admin) + `KEY_ROTATE`. The
  reducer authorization gate drops every content op from the revoked device
  at/after the revoke Lamport; stale replays lose deterministic LWW; the
  revoked device cannot produce content under the post-rotation epoch.
- **Residual risk:** ops the device legitimately authored *before* revocation
  remain valid history (retroactive rejection would corrupt the log). It may
  retain plaintext it already decrypted while trusted — revocation is forward,
  not retroactive, secrecy. Autobase writer-core eviction is a documented
  no-op on the pinned Autobase version; the load-bearing control is the
  reducer gate (fully active, tested in `sec-auth.test.js`).

### 2.4 Lost / stolen device

**Capability:** physical possession of a device's storage.

- **Enforced:** secret material at rest is AEAD-wrapped under an Argon2id-hard
  key from the unlock secret (passphrase / OS keychain). Without the unlock
  secret the local device blob and content envelopes do not open. No
  plaintext, key, or recovery phrase is written in the clear; the verifier
  proves the storage tree is sentinel-free.
- **Residual risk:** if the device was **unlocked** when seized, keys are in
  memory and an attacker with that running process/RAM can read content
  (standard for any local-decryption app). A weak passphrase is brute-forceable
  offline (Argon2id moderate raises cost, not infinity). OS keychain security
  is delegated to the platform. Mitigation: lock on background/idle, strong
  passphrase, prompt revocation + key rotation from another device.

### 2.5 Supply-chain adversary

**Capability:** compromises a dependency, the build, or a distributed
artifact.

- **Enforced / mitigated:** committed lockfile (`npm ci`); `npm audit` of
  shipped deps fails CI on high/critical; the independent verifier validates a
  *built* vault is sentinel-free and AEAD-only; release is verifier-gated;
  unsigned release artifacts fail the `release-guard` CI job; the verifier is
  runnable from source so a third party can re-derive the encryption claim
  (VERIFIER_SPEC.md).
- **Residual risk:** real code-signing certificates and a published
  reproducible-build attestation are out of scope of this repo and are M6
  pre-beta items (RELEASE.md §17). A backdoored dependency that preserves the
  envelope shape but exfiltrates keys via a side channel is not caught by the
  sentinel scan alone — defense is audit + reproducible builds + review, not
  the verifier alone (explicitly stated in VERIFIER_SPEC.md §"does not prove").

### 2.6 Malicious local software / other apps

**Capability:** another process on the same machine; clipboard snoops.

- **Enforced (app side):** keys never cross the RPC boundary to the UI
  (`assertRendererSafe`); logs are redacted; selected-item plaintext is
  cleared on close/background/timeout/lock; clipboard capture supports
  manual-only mode, exclusion patterns, and pause.
- **Residual risk:** the OS clipboard is a shared, OS-controlled surface — any
  app can read it while content is there (unavoidable for copy/paste); a
  local keylogger/screen-scraper defeats any local app. Out of scope (spec
  §2); mitigation is OS hygiene and minimal clipboard retention.

## 3. Trust boundaries

```
[ user memory: recovery phrase ]   <-- never crosses into software at rest
            | derive (Argon2id), creation-time one-time display only
            v
[ Pear-end process: keys in RAM while unlocked ]   == TRUST CORE ==
   |  RPC (schema-validated, assertRendererSafe)        no keys cross →
   v
[ UI shell: display only, sealed rows + 1 opened item ]   untrusted w.r.t. keys
            |
            | only CryptoEnvelopes + public headers cross →
            v
[ Replicated layer: Hypercore/Autobase/Hyperbee ]   ciphertext only at rest
            |
            | assertCiphertextOnly + export mirror →
            v
[ HiveRelay / network ]   honest-but-curious; ciphertext + metadata only
```

Boundary invariants (each tested):

- recovery phrase → software: one-time creation display only; never persisted.
- Pear-end → UI: no key material ever (`assertRendererSafe`); sealed rows by
  default; exactly one explicitly-opened item's plaintext.
- Pear-end → replicated layer: `CryptoEnvelope` + public-only headers
  (`assertHeaderPublicOnly`).
- Pear-end → relay: `assertCiphertextOnly` + mirrored + verifier-scanned.

## 4. Out of scope (v1 non-goals — spec §2)

Paste explicitly does **not** defend against / provide:

- **Anonymity / metadata privacy.** Peers and relays learn network metadata
  unless the user adds Tor/VPN-style transport.
- **Provable physical deletion** from third-party disks. Deletion is
  cryptographic erasure (key destruction) + best-effort non-serving
  verification where the relay supports it.
- **Compromised endpoint while unlocked** (RAM scraping, local keylogger,
  malicious OS). Local-decryption apps cannot defend a hostile OS.
- **Team/multi-user sharing, public publishing, collaborative editing,
  browser extension, cloud accounts.** Not built in v1.
- **Guaranteed availability.** Relays are best-effort volunteers; the app is
  local-first and degrades, never blocks, on relay failure.
- **OS clipboard isolation.** The clipboard is a shared OS surface.
- **Coercion / rubber-hose** disclosure of the recovery phrase or passphrase.

## 5. Assumptions

The model holds only if: libsodium primitives (XChaCha20-Poly1305, Argon2id,
BLAKE2b) and hypercore-crypto Ed25519 are correctly implemented; the device's
CSPRNG is sound; the user keeps the recovery phrase secret and chooses a
strong passphrase; the OS keychain (if used) is not compromised; the
distributed build matches reviewed source (the supply-chain controls and
verifier exist precisely to reduce reliance on this last assumption).
