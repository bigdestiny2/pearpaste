# Paste Relay Custody

How Paste uses HiveRelay for **encrypted availability**, what custody
receipts mean, and — stated plainly — what they do and do **not** prove.

Spec references: §4 (security promise), §8.4 (provably encrypted), §11
(HiveRelay integration), §2 (non-goals).

## 1. Why relays exist here

Paste is local-first and direct-P2P. Relays are an **availability**
mechanism, not a trust anchor:

- Keep the **app package** reachable for installs (release-time pin).
- Keep the **encrypted vault operation log** reachable while every personal
  device is asleep, so a phone that wakes up can catch up without another of
  the user's devices being online.
- Provide **custody receipts** for short-lived clipboard items and encrypted
  backup capsules.
- Drive the "always online" status indicator.

A relay is treated as an honest-but-curious, possibly-unavailable storage
volunteer. The security model never assumes a relay is trustworthy.

## 2. What a relay receives — and never receives

A relay receives **only**:

- ciphertext (XChaCha20-Poly1305 envelopes),
- public core/drive keys (identifiers, not key material),
- ciphertext roots / commitments,
- signed receipts and custody-protocol metadata,
- coarse, content-free routing fields.

A relay **never** receives:

- note or clipboard plaintext,
- titles, tags, or any user-provided text,
- vault keys, index keys, item keys, device secret keys, the recovery phrase,
  or any seed,
- a names/emails/titles catalog entry (vaults are `privacyTier: 'p2p-only'`,
  blind; the HTTP gateway does not serve private vault content).

This is enforced in three independent layers:

1. **Envelope discipline** — user content only ever leaves the crypto layer as
   a `CryptoEnvelope`; nothing else is replicated.
2. **`assertCiphertextOnly()`** in `backend/relay-service.js` deep-scans every
   payload before any relay call and throws `RelayBlindnessError` on a
   forbidden field or a plaintext sentinel.
3. **Export mirror + verifier** — every payload handed to a relay is mirrored
   to `<storage>/relay-exports/`, which the verifier and the standalone CLI
   scan for the plaintext sentinel. A leak fails the proof and CI.

## 3. Seeding the encrypted vault log

`ctx.relay.seedVault(publicVaultLogKey, opts)` issues a HiveRelay seed request
with blind / p2p-only settings (spec §11):

```js
relay.seed(vaultLogKey, {
  durability: 1,            // archive tier: diversity-enforced replica fleet
  privacyTier: 'p2p-only',  // blind; no public catalog entry
  replicationFactor: 5,
  maxStorageBytes,
  revocable: true           // publisher can later request removal
})
```

`revocable: true` lets the publisher request removal later. **Revocation is a
request, not a guarantee** — see §6.

## 4. Atomic Blind Custody for temporary clips

Short-lived clipboard items and encrypted backup capsules use Atomic Blind
Custody. The source publishes a signed **custody intent** over a ciphertext
root only:

```js
relay.publishCustodyIntent(relayUrl, {
  blindContentId,                 // content-free blind id
  ciphertextRoot,                 // hash of CIPHERTEXT, never plaintext
  requiredReplicas: 3,
  deadline: Date.now() + 60_000,
  retainUntil: Date.now() + ttlMs,
  privacyTier: 'p2p-only',
  metadataVisibility: 'redacted'
}, auth)
```

The pipeline (intent → replica receipts → commit → source-retired) yields:

- **Quorum receipts**: N relays signed that they hold the ciphertext root.
- **Source retirement**: the publisher relinquishes future authority so the
  handoff is durable.
- **Witness tombstones / non-serving proofs**: where supported, independent
  parties attest a relay has *stopped* serving after `retainUntil`.

`ctx.relay.getCustodyStatus(intentId)` reports quorum progress and verifies
that the relay's reported root **equals our ciphertext root**. A mismatch is
surfaced and fails the verifier's custody line — the client never silently
trusts a relay's claim.

## 5. What the receipts DO prove

- **Ciphertext-root binding**: a quorum of relays attested they accepted *this
  specific ciphertext root*. Receipts reference the ciphertext root, never a
  plaintext root.
- **Availability at receipt time**: at least the quorum size of distinct
  relays acknowledged custody.
- **Authenticity**: receipts and the intent are signed; a forged or mismatched
  receipt is rejected and fails verification.
- **Confidentiality preserved through the relay path**: combined with the
  storage/relay-export sentinel scans, that no plaintext entered relay
  storage.

## 6. What the receipts DO NOT prove

Stated plainly, and never softened in product copy (§4):

- **They do not prove physical deletion from third-party disks.** A quorum
  non-serving proof or witness tombstone shows a relay *stopped serving*; it
  cannot prove an operator did not snapshot ciphertext beforehand. Paste's
  deletion model is **cryptographic erasure** (destroy the keys; ciphertext
  becomes undecryptable), plus best-effort non-serving verification where the
  relay supports it.
- **They do not prove continued availability.** A receipt is point-in-time. A
  relay can later disappear; the durability fleet mitigates but does not
  guarantee permanence.
- **They do not provide anonymity.** Hyperswarm peers and relays can observe
  network metadata (IPs, timing, sizes) unless the user adds a Tor/VPN-style
  transport. Paste must not claim "no metadata leakage" or "anonymous."
- **They do not make a relay trusted.** Receipts constrain what a *correct*
  relay attests; a malicious relay can refuse service or withhold. It still
  cannot read content (it only ever held ciphertext).

## 7. Failure behavior (never blocks local use)

Per spec §11, relay problems degrade silently:

- Optional client dependency missing or failing to start → app stays
  local-first / direct-P2P; `RELAY_STATUS` reports `degradedReason`.
- No relays reachable → no seeding/custody; local notes and clips fully
  usable.
- Custody quorum below target → UI shows "reduced availability"; the clip is
  kept local and retried, or the user is asked to keep one device online.

Relay code runs under the lifecycle scope and drains on teardown; because the
client is constructed in advanced mode (it reuses the Pear-end's Hyperswarm
and Corestore), tearing the client down never closes the shared swarm/store.

## 8. Approved vs forbidden wording

Use: "Relays store encrypted blocks", "Reduced availability",
"Cryptographic deletion (keys destroyed)", "Non-serving verified where
supported".

Never: "Provable physical deletion", "Guaranteed deletion", "No metadata
leakage", "Anonymous", "Trustless" (unless a specific proof is shown).
