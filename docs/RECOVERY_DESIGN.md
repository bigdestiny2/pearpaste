# PearPaste Account Recovery — Design Note

**Status:** Draft. Blocked on upstream npm publish of `p2p-hiverelay-client@0.9.2`.
**Author/date:** 2026-06-01.
**Scope:** Add an optional, relay-assisted social-recovery path on top of the existing 24-word phrase. The phrase path stays primary and unchanged.

---

## 1. Goal

Today PearPaste's account is `rootSeed` (32 bytes), derived in `backend/identity.js` from a 24-word BIP-39 mnemonic via Argon2id (`pearpaste-root-v1` salt). Lose the phrase and every device → vault is unrecoverable.

We want a **second, optional** recovery path that:

1. Survives total device loss **and** phrase loss, as long as a quorum of pre-designated guardians is reachable.
2. Adds no trusted custodian. A relay must never see plaintext keys, in line with §11 (HiveRelay integration) and the "honest-but-curious relay" assumption in `docs/THREAT_MODEL.md`.
3. Composes with our existing pairing/restore flow (§14) — once `rootSeed` is reconstructed, the rest of the boot path is what's already specced.

---

## 2. Primitive: HiveRelay v0.9.0 Publicly-Verifiable Blind Custody (PVSS)

From the upstream CHANGELOG (verbatim, v0.9.0):

> **Publicly verifiable blind custody.** Relays hold an opaque, guardian-encrypted share of a secret that they can publicly verify but cannot read, and any t-of-n guardians can later reconstruct the secret entirely client-side.

Scheme: Schoenmakers PVSS over secp256k1 (`pvss-secp256k1-v1`). Feldman commitments, per-share DLEQ proofs, Lagrange-in-exponent reconstruction. The relay verifies the share it custodies against the published commitments **before** signing a `shareVerified` receipt — malformed/substituted shares are caught at custody time, not at recovery.

### 2.1 Public API (HiveRelayClient, v0.9.0+)

```
splitForCustody({
  secret?,        // 32-byte secret to split; omitted → client generates one
  guardians,      // array of guardian recipient pubkeys (PVSS pubkeys, secp256k1)
  threshold,      // t in t-of-n
  relays,         // relay pubkeys that will custody shares (n typically = relays.length)
  appKey,         // binding app key (the address the custody attaches to)
  opts?           // future
}) → { intentId, shareBundleKey, ... }

reconstructFromCustody({
  intentId,
  guardianSecretKeys,     // exactly t guardian secret keys
  relays?,                // optional explicit relay set
  shareBundleKey?,        // optional override; usually fetched via intent
  threshold?              // optional override
}) → { secret }
```

Bare-safe subpath modules ship with the client:

- `p2p-hiverelay-client/secret-sharing.js` — PVSS prover (`keygen`, `split`, `reconstruct`, `decryptShare`, `SCHEME`). Depends only on `sodium-universal`, `b4a`, `@noble/hashes`, `@noble/secp256k1`.
- `p2p-hiverelay-client/custody.js` — self-contained intent/commit/receipt signing.

### 2.2 Wire summary

- **Control plane** (intents, commits, receipts) — HTTP custody channel.
- **Data plane** (encrypted share bundle) — sibling Hypercore named `shareBundleKey` in the signed intent, replicated over the existing Hyperswarm.
- v2 custody intent fields: `shareScheme`, `shareThreshold`, `commitmentRoot`, `shareBundleKey`, `shareAssignments`. v1 is unchanged.

### 2.3 v0.9.1 / v0.9.2 — wire correctness

- **v0.9.1**: `splitForCustody` now actually triggers per-relay seed → receipt anchoring (the 0.9.0 release didn't wire the dealer→relay seed step). Public `GET /api/custody/{id}/status` exposes a redacted `receipts[]` so the dealer can poll for share-verified quorum. **0.9.1 is the minimum we'd consume.**
- **v0.9.2**: Custody expiry sweep correctness fix; custody linkage now visible on `catalog()` + `GET /api/anchors?detailed=1`.

---

## 3. Mapping onto PearPaste

### 3.1 The secret we split is `rootSeed` (32 bytes)

Everything else (`vaultKey`, `indexKey`, `deviceAdminSeed`, `vaultId`, root identity keypair) is deterministically derived from `rootSeed`. Splitting `rootSeed` means a quorum of guardians can fully restore the account on a clean device with no surviving old device and no phrase.

### 3.2 Guardian model

A **guardian** is anyone who can hold a PVSS secret key. Three reasonable sources, in order of UX simplicity:

1. **Another PearPaste device the user controls.** Trivial in-app pairing flow can also drop a guardian key into the new device's keystore.
2. **A trusted contact's PearPaste install.** Out-of-band invite → contact's app generates/stores the guardian key locally; user records the contact's PVSS pubkey at split time.
3. **A printable/exportable guardian key** stored offline (paper, password manager, hardware token).

Choosing N and t is a per-vault user setting. Reasonable defaults: **3-of-5** for power users, **2-of-3** for the lighter onboarding flow.

### 3.3 What gets published

For each vault that opts in to social recovery:

- `splitForCustody({ secret: rootSeed, guardians: [...pubkeys], threshold: t, relays: [...relayPubkeys], appKey: vaultIdAsAppKey })`
- The client publishes the signed v2 intent, seeds each relay, collects share-verified receipts, signs the quorum commit.
- The intent + commit live on the relay catalog (redacted view; no plaintext fields exist on the wire by construction).

### 3.4 Recovery flow

On a clean device:

1. User enters their **vault ID** (the only public, content-free handle — already specced in §7.1 / `vaultIdFromRootSeed`). Or scans a QR containing it.
2. Client resolves the active custody `intentId` for that vault from the relay catalog.
3. Client contacts t guardians (each contributing a PVSS secret-key decryption locally). UI shows progress: "2 of 3 guardians confirmed."
4. `reconstructFromCustody({ intentId, guardianSecretKeys: [...] })` → `rootSeed`.
5. From `rootSeed`, derive `vaultKey`/`indexKey` and run the normal §14 pairing-bootstrap path (or pure restore from the vault log on the relay).

The phrase recovery flow is **untouched** — it remains the primary, single-actor recovery path. Social recovery is opt-in per vault.

---

## 4. Threat-model implications

### 4.1 What stays safe

- **Relay never sees rootSeed.** It holds a guardian-encrypted PVSS share + public commitments; reconstruction is client-side. Honest-but-curious relay model preserved (`docs/THREAT_MODEL.md` rows for "HiveRelay / network" are unchanged).
- **No single guardian can recover.** Below-threshold guardians have only their own decrypted share; PVSS gives them no advantage over the relay in reconstructing.
- **Malformed/substituted share caught at custody time.** Relay verifies via DLEQ + commitments before signing a `shareVerified` receipt. A guardian who later tries to submit a different share fails verification client-side at reconstruction.

### 4.2 New attack surfaces

| Adversary | Capability | Mitigation |
|---|---|---|
| Compromised guardian device | Holds one PVSS secret key, can produce one share at recovery | Threshold > 1; user picks t high enough that a single-device compromise is below threshold |
| Coercion of t guardians | Can reconstruct rootSeed → full vault | Same as phrase coercion; the user opts into social recovery knowing this. Document explicitly. |
| Relay catalog enumeration | Sees that vault X opted into custody, with N relays, t threshold | Already public-by-design; intent + commit metadata is part of the model. No plaintext leak. |
| Guardian-set rotation | User wants to remove an ex-guardian | **Open question — see §6** |
| Dead-drop relay | Relay accepts split, refuses to surface receipt | Dealer poll timeout + multi-relay split → degrade gracefully; pick relays from ≥2 operators |

### 4.3 Document updates required

- `docs/THREAT_MODEL.md` — add a "Social recovery (optional)" row. Adversary classes: compromised guardian, coercion of quorum, relay enumeration of intent metadata.
- `docs/RELAY_CUSTODY.md` — add a "Publicly-Verifiable Blind Custody (v0.9.0)" section.
- `docs/PEARPASTE_TECHNICAL_SPEC.md` §8 (key hierarchy) and §14 (pairing/restore) — note the optional PVSS path; rootSeed is the secret.
- New: `docs/RECOVERY_SPEC.md` once this design lands (user flows, UI states, error handling).

---

## 5. Implementation plan (when 0.9.2 is on npm)

### 5.1 Dependency bump

`package.json`:

```json
"optionalDependencies": {
  "p2p-hiverelay-client": "^0.9.2"
}
```

Code comments in `backend/relay-service.js:3` and `backend/lifecycle-scope.js:3` referencing `0.8.13` get bumped to `0.9.2`.

### 5.2 New backend module: `backend/recovery.js`

Pure-function module (mirrors `identity.js` style):

- `enrollSocialRecovery({ relayClient, rootSeed, guardianPubkeys, threshold, relays, vaultId }) → { intentId, shareBundleKey }`
- `resolveCustodyForVault({ relayClient, vaultId }) → { intentId, threshold, guardians }`
- `recoverRootSeed({ relayClient, intentId, guardianSecretKeys }) → rootSeed`
- Pure helpers: `mintGuardianKeyPair()` (wraps `secret-sharing.js` keygen), `serializeGuardianInvite`, `parseGuardianInvite`.

### 5.3 Touch points

- `backend/index.js`: wire `recovery` into the Pear-end factory, behind a `socialRecovery: { enabled: false }` flag at first.
- `backend/desktop-bridge.js` + `backend/rpc.js`: add `recovery.enroll`, `recovery.status`, `recovery.recover`, `recovery.acceptGuardian` commands.
- `ui/desktop/app.js`: enrollment wizard (pick guardians, choose t/n), recovery wizard (enter vaultId, contact guardians, progress UI), guardian-acceptance flow.
- `mobile/`: same RPC commands, mobile UI later.

### 5.4 Tests

- `test/unit/recovery.test.js` — round-trip split → reconstruct in-process. No relay required (use `secret-sharing.js` directly).
- `test/integration/recovery-custody.test.js` — full split via `_relay-harness.js`, poll receipts, reconstruct.
- `test/security/sec-recovery.test.js` — below-threshold cannot reconstruct, malformed share rejected, wrong-vault intent rejected, replay of stale intent rejected.

### 5.5 Other 0.8.x → 0.9.2 changes we'd pick up

Free wins from the same upgrade — none require code changes on our side, but worth verifying:

- **v0.8.15** Blind-path audit hardening. We already pass `blind: true`; the operator-redaction tightening is automatic.
- **v0.8.20** `anchored=true` now requires every blob block present locally (not just metadata length). Strictly stronger durability claim.
- **v0.8.21** Cross-relay autonomous self-heal. Better availability.
- **v0.8.22** Defensive timeouts on `drive.ready()` / `_isDriveFullyReplicated`. Prevents one hung drive from deadlocking the reseed loop.
- **v0.8.24** Per-key mutation locks on custody/seed. Closes documented races.
- **v0.8.27** Claim-path erasure witness. Cryptographic proof of destruction available immediately on retirement, not after `retainUntil`.

---

## 6. Open questions

1. **Guardian rotation.** v0.9.0 has no documented rotation primitive. To remove an ex-guardian we presumably re-split with the new set and retire the old intent (`source-retired` → v0.8.27 erasure witness fires immediately). Need to validate this with the upstream.
2. **Guardian discovery on recovery.** How does the recovering device reach guardians? In-app push via Hyperswarm topic? QR-based one-shot session? Out-of-band signal? Probably reuse the existing pairing rendezvous (§14) parameterized by guardian pubkey.
3. **Guardian UX for non-PearPaste users.** Acceptable scope to require guardians be PearPaste users in v1? (Recommended yes — keeps the trust boundary clean. A standalone "guardian companion" app is a v2 conversation.)
4. **Relay selection.** Reuse the existing relay-warmup list, or let the user choose specific operators? Recommendation: warm-up list + minimum diversity rule (≥2 operators) baked in.
5. **`appKey` binding.** Should we bind custody to `vaultId` directly, or to a separate "recovery app key" derived from `vaultId`? Latter is cleaner — separates custody catalog noise from vault availability metadata.

---

## 7. Status / blockers

- **Blocker:** `p2p-hiverelay-client@0.9.2` is **not on npm**. Latest npm release: `0.8.14` (verified `npm view p2p-hiverelay-client versions`). Source for 0.9.2 lives at `packages/client/` in `bigdestiny2/P2P-Hiverelay@main` but has not been `npm publish`ed. CHANGELOG entries for 0.9.0/0.9.1/0.9.2 are dated 2026-05-30 → 2026-05-31.
- **Action queued:** Open a GitHub issue on `bigdestiny2/P2P-Hiverelay` requesting an npm publish of the 0.9.2 client. Draft text lives alongside this note.
- **No code changes to PearPaste yet.** Everything in §5 is a queued patch; nothing has been written or installed.

---

## 8. Decision log

- **2026-06-01.** Chose PVSS social recovery (HiveRelay v0.9.0+) over the three alternatives considered (phrase-only restore UI, passphrase-protected file backup, Shamir-without-relay). Rationale: HiveRelay v0.9.0 gives us the exact primitive natively, end-to-end blind, with public verifiability — and the threat model is already designed to assume HiveRelay's "honest-but-curious + cryptographic verifiability" stance.
- **2026-06-01.** Deferred install. Chose to wait on upstream npm publish rather than clone-and-link or vendor. Trade-off accepted: no progress on §5 today; design + nudge only.
