# PearPaste Device Revocation — Real Content-Key Rotation with Forward Secrecy

Status: **LOCKED (post-red-team).** Author: Lead Architect. Date: 2026-06-09.
Supersedes the "epoch bump is cosmetic" behavior described in SECURITY.md §4.2,
THREAT_MODEL.md §2.3, PAIRING.md §5.

This revision folds in the findings of three red-team lenses (CRYPTO,
SWARM/TOPIC, PROTOCOL/RACE). Every **confirmed break** below is either mitigated
in the locked protocol or documented as an honest **residual** that cannot be
closed at the app layer. The header of each affected section carries an
`[RT-FIX]` or `[RT-RESIDUAL]` marker so the change is auditable against the
red-team report.

---

## 0. The defect this design fixes (one paragraph)

Today `DEVICE_REVOKE` -> `KEY_ROTATE` is cryptographically inert. The entire
content path is keyed by a single static `vaultKey` derived only from the
recovery phrase: `itemKey(vaultKey, objectId) = HKDF(vaultKey, "item:"+objectId)`
(`crypto-envelope.js:151-153`), `seal()`/`openWithObjectId()` take only
`vaultKey`+`objectId` and no epoch (`crypto-envelope.js:192,232`), the
`KEY_ROTATE` reducer branch only does `keyEpoch = max(keyEpoch, body.epoch)` and
persists that integer, and the discovery topic is
`HMAC(vaultKey, "swarm-topic-v1")` which never changes (`pairing.js:22-24`). A
revoked device retains `vaultKey` (in its local `local-device.json`,
`vault-store.js`, AND re-derivable from the 24 words), retains the full
replicated Corestore, and can recompute the discovery topic to rejoin the swarm.
`revokedAtLamport` only blocks its *writes* from honest reducers
(`autobase-sync.js:471`, `verifier.js:168-172`); its *reads* of all past and all
future content are unaffected. This design makes revocation produce **forward
secrecy of content**: a revoked device provably cannot **decrypt** content
created after its revocation. It does **not** stop that device from replicating
the (opaque) post-revoke log, and it does **not** survive recovery-phrase
compromise — both stated plainly as residuals (§7.2).

---

## 0.5 Red-team verdict and the load-bearing correction (read first)

All three lenses returned **PARTIAL**: the **cryptographic core holds** — a
revoked device cannot derive or unwrap `epochKey_{N+1}` from any material it
retains (old epoch keys, full history, its own box secret key, its signing
keys). `epochKey_{N+1}` is `randomBytes(32)` (`crypto-envelope.js:46`)
distributed only by `crypto_box_seal` to survivor box pubkeys
(`identity.js:132-137`); the revoked device's box pubkey is omitted;
`crypto_box_seal` is opaque without the recipient box secret key; the box
keypair being derived from `signSeed` (`identity.js:113`) only reconstructs the
device's *own* key, never a survivor's. **That property survives every attack
tried and is the deliverable guarantee.**

What the red-team **broke** were the design's *broader* claims around that core.
The single most important correction, confirmed in code, is:

> **THE TRANSPORT LAYER DOES NOT EXCLUDE A REVOKED DEVICE.** Relays seed by the
> **immutable Autobase core key**, not by the rotating topic
> (`relay-service.js:827-853` -> `p2p-hiverelay-client/index.js:622-636`
> `hypercoreCrypto.discoveryKey(autobaseKey)`), and the swarm `connection`
> handler calls `store.replicate(conn)` **unconditionally** for any peer
> (`backend/index.js:78`). The core key never rotates
> (`autobase-sync.js` mints it once). A revoked device keeps the core key
> forever, so it can keep **replicating the entire post-revoke encrypted log and
> all its metadata indefinitely**. Topic rotation is therefore demoted from a
> security control to a **discovery convenience**. Confidentiality rests
> **100% on the content key**, which is sound.

Every prior sentence in this doc of the form "R cannot rejoin the rendezvous" /
"R cannot obtain the bytes" / "exposure is bounded to a 14-day window" was
**false** and has been rewritten to "R obtains ciphertext it cannot decrypt, and
can traffic-analyze it indefinitely." See §3.7, §4, §7.

### 0.5.1 Confirmed breaks and disposition (index)

| # | Sev | Break (verified in code) | Disposition |
|---|-----|--------------------------|-------------|
| B1 | HIGH | Re-pair / phrase re-admission hands the full epoch chain back to the revoked party; fresh `deviceId` (`identity.js:116`) hides the link; full-chain is the default | **FIX** §3.8 (selective-chain-by-default, admit-policy) + **RESIDUAL** §7.2 (phrase is un-revocable) |
| B2 | HIGH | Relay seeds by immutable core key; `store.replicate` unconditional → revoked device replicates all post-revoke ciphertext forever | **FIX** §3.7.2 (epoch-bound relay seed + replication firewall) + **RESIDUAL** §7.2 (no firewall ⇒ replication continues) |
| B3 | MED | `topicSeed_{N+1}` carried inside the `epochKey_N`-readable `KEY_ROTATE` body → device revoked *at* that rotation can compute `topic_{N+1}` forever | **FIX** §3.3 (derive topic seed locally from `epochKey_{N+1}`; never transmit it) |
| B4 | MED | Durability reconciler re-seals old plaintext under `epochKey_{N+1}`; `keyId=hash('keyid:'+objectId)` is epoch-independent (`crypto-envelope.js:194`) → manufactures a known-plaintext correlate for R | **FIX** §3.9 (epoch-bind `keyId`; reconcile epoch-faithfully) |
| B5 | CRIT | Epoch-key wrap rows keyed by **integer** epoch collide under concurrent same-epoch rotations → non-deterministic key divergence / silent content loss | **FIX** §3.5 + §5.6 (key everything by `epochTag`, never integer) |
| B6 | HIGH | Concurrent revoke of a *different* device: the winning rotation may seal the active key **to a device the other admin revoked** → forward secrecy defeated against that device | **FIX** §3.5.1 (post-selection wrap-set re-validation + chained rotation) |
| B7 | HIGH | Offline survivor missing one rotation's wrap (transient reorg dropped it from S) is **permanently dead-ended** with a silent skip | **FIX** §3.10 (catch-up re-wrap op; monotonic membership) |
| B8 | HIGH | Last-indexer `removeWriter` can **wedge** rotation linearization; the "promote another indexer first" precondition was documented but unimplemented | **FIX** §3.6 (implement precondition; rotation independent of eviction) + **SHIP-BLOCKER** open-q #1 |
| B9 | HIGH | Cross-device delete + reconciler re-append can **resurrect** a deleted row under the new epoch (delete-supersede is device-local) | **FIX** §3.9 (durable tombstone honored by reconciler + reducer) |
| B10 | MED | KEY_ROTATE body sealed under `epochKey_N` (which R holds) → R reads the survivor **roster** + wrap counts on every revoke | **FIX** §3.3 (seal body under `epochKey_{N+1}`; blind wrap deviceIds) |
| B11 | MED | Replay/reorg that splits the rotation chain across batch boundaries → a single rotation op is not self-contained, device wedges at the prior epoch | **FIX** §3.4 (open lockbox from committed row using only box secret key; do not gate body-decrypt on the previous epoch key) |
| B12 | LOW | `opLamport >= revokedAtLamport` gate lets a revoked device **backdate** content ops below the revoke point (`autobase-sync.js:471`) | **FIX** §3.11 (reject any op from a committed-revoked signer for newly-arriving ops; bound skew) + eviction is load-bearing |
| B13 | MED | Stolen-device default 14-day grace window over-exposes metadata; combined with B2, ciphertext leaks regardless | **FIX** §4 (follow-topic default-on; grace=0 for stolen-device flow) |

Items marked **FIX** are folded into the locked protocol below. Items also
carrying **RESIDUAL** retain an unavoidable honest limit documented in §7.2.

---

## 1. Chosen approach + rationale vs. the alternatives surveyed

### 1.1 Chosen: Epoch content keys with lazy migration, distributed by libsodium sealed-box lockboxes, content-addressed by `epochTag`, plus epoch-bound discovery topic + relay seed and a replication firewall

Keep `vaultKey` as a long-lived per-vault **key-encryption key (KEK)** and a
backstop for *legacy* content. Introduce a per-**epoch content key**
`epochKey_e` (32 fresh random bytes minted by the revoking admin at each
rotation). New content is sealed under the current epoch key. On revoke, the
admin generates `epochKey_{N+1}`, **seals it individually to each remaining
device's `boxPubkey`** with `crypto_box_seal` (the exact mechanism already used
for pairing bootstrap, `identity.sealToDevice`, `identity.js:132-137`), and
omits the revoked device. Discovery topic, relay seed key, and per-device
follow-topics re-derive from the new epoch key. Because the revoked device never
receives `epochKey_{N+1}`, it can never decrypt epoch-(N+1) content.

**Three corrections the red-team forced into the core design:**

1. **`epochTag`, not the integer epoch, is the identity of a key everywhere it
   matters** (storage rows, the in-memory map, the content header). Two
   concurrent rotations are both "epoch N+1" as integers but carry distinct
   `epochTag`s; addressing by the integer collides and silently loses a key
   (B5). All wrap-row keys, the `epochKeys` map, and the `header.epochTag`
   content binding use `epochTag`. The integer remains only as a monotone
   ordering hint.

2. **The transport must be excluded explicitly; topic rotation cannot do it.**
   We add (a) an **epoch-bound relay seed discovery key** so survivors re-seed
   the log under a key the revoked device cannot compute, *unseeding the old
   one*, and (b) a **per-connection replication firewall** so `store.replicate`
   runs only for peers that authenticate as a committed, non-revoked device
   (B2). Where these cannot be guaranteed (e.g. a stale third-party relay), we
   say plainly that replication of opaque ciphertext continues (§7.2).

3. **Each `KEY_ROTATE` op is self-contained and roster-blind.** The body is
   sealed under `epochKey_{N+1}` (NOT `epochKey_N`), the per-device lockbox is
   openable from its own committed row using only the device box secret key, the
   topic seed is **never transmitted** (derived locally from `epochKey_{N+1}`),
   and wrap `deviceId`s are blinded (B3, B10, B11). This dissolves the
   reorg/batch-ordering fragility *and* denies the revoked device the roster and
   the next rendezvous it previously leaked into.

**Why this approach (unchanged rationale):**

- **Forward secrecy of content is the maximum achievable guarantee.** The
  revoked device already holds, on its own disk, the plaintext (or old-epoch
  ciphertext + old keys) of everything synced before revoke. No protocol can
  claw that back (SECURITY.md §4.4). The honest, deliverable property is:
  *cannot decrypt content created after revoke.* That requires fresh entropy the
  revoked device never had — a fresh-random epoch key sealed only to survivors.

- **Fresh-random, NOT phrase-derived, is mandatory.** A revoked device was an
  admin: it holds `deviceAdminSeed` and can re-derive *anything* deterministic
  from `rootSeed`/`vaultKey` (`identity.js:100-103`, RECOVERY_DESIGN.md §3.1). So
  the epoch key cannot be `HKDF(vaultKey, "epoch:"+N)` — the ex-admin would
  recompute it. It MUST be `randomBytes(32)` distributed only by sealing to
  survivor box pubkeys. **The red-team confirms the KDF cannot be run forward to
  exclude-then-include; rejecting the ratchet alternative was correct.**

- **Reuses an already-present, already-audited mechanism.** Per-recipient
  sealed-box key wrapping is exactly `sealBootstrap` (`pairing.js` ->
  `identity.js:132-137`). Every surviving device's `boxPubkey` is *already
  durably sealed in the view* (`putDevice`). Only the in-memory projection drops
  it (the one-line gap fixed in §5.1).

- **Lazy migration = zero re-encryption of history.** Defining `epochKey_0 ==
  vaultKey` makes every existing object's `itemKey` byte-identical, so existing
  vaults need no rewrite (§6). New epochs only key *future* writes. **Caveat
  from B4:** the durability reconciler must NOT pull pre-revoke content forward
  under the new epoch (it manufactures a known-plaintext correlate for R); it
  re-materializes under the row's *original* epoch (§3.9).

### 1.2 Alternatives surveyed and why they were rejected

| Approach | What it is | Why rejected here |
|---|---|---|
| **Phrase-derived epoch key** `HKDF(vaultKey,"epoch:"+N)` | Deterministic rotation, no distribution | **Broken.** Revoked ex-admin holds `deviceAdminSeed`/`vaultKey` and re-derives every future epoch key. (All lenses + Researchers 1,3,4.) |
| **One-way KDF ratchet** `epochKey_{N+1}=KDF(epochKey_N)` | Time-based FS by hashing forward | A *removed* member holding `epochKey_N` runs the chain forward to all future keys. Excluding a member needs entropy it never had. (CRYPTO lens confirms.) |
| **MLS / RFC 9420 TreeKEM** | Group key agreement w/ FS + PCS | Over-engineered at 2–6 personal devices; assumes reliable in-order delivery (Autobase forks/truncates); PCS needs members online regularly. |
| **Signal Sender Keys** | Group messaging key distribution | Needs pairwise authenticated channels PearPaste lacks between devices. |
| **Writer eviction alone** (`removeWriter`) | Drop the device's writer seat | Stops *writes* only; reads/decryption untouched. Eviction is defense-in-depth — **except** it is *load-bearing* against lamport backdating (B12, §3.11). |
| **Bulk re-encryption of all history** | Re-seal every row under the new key | Theater with a downside: the revoked device already has the old bytes, and re-encrypting data it holds in plaintext manufactures a known-plaintext oracle (B4). |
| **Rotate the Autobase core key on revoke (new base + full log migration)** | Deny the revoked device replication at the root | The cleanest way to actually stop replication, but a far larger change (full log migration, re-seed only survivors, breaks offline-good-device catch-up). **Not attempted in v1**; its absence is exactly why B2 is a residual. Flagged as the v2 path. |

**Chosen approach = "removal-rekey" (RFC 9420 §3.2; cf. WhatsApp Sender-Key
re-sampling, eprint 2023/1385) specialized to a tiny decentralized group with
sealed-box distribution**, content-addressed by `epochTag`. The rigorous
decentralized analogue is Kleppmann DCGKA; we implement the minimal slice it
justifies (fresh group key sealed to survivors) without the full DCGKA
machinery.

### 1.3 Correction to the docs: `addWriter`/`removeWriter` are NOT a no-op

SECURITY.md §4.2, THREAT_MODEL.md §2.3, PAIRING.md §5, and
`test/security/sec-auth.test.js` claim the pinned Autobase exposes no
`addWriter`/`removeWriter` and call eviction "a documented no-op." This is
**stale**. Autobase `^7.28.1` implements both, and the code already calls
`host.addWriter(..., {indexer:true})` (`autobase-sync.js:508-510`) and
`host.removeWriter(...)` (`autobase-sync.js:575-576`). Eviction stops the revoked
device's *writes* at the Autobase layer but does nothing about *reads* — exactly
why content-key rotation is required. **Fix these doc/test claims (§8, Phase 6).**
One caveat: `removeWriter` throws "Not allowed to remove the last indexer";
`_applyDeviceRevoke` swallows that in a try/catch (`autobase-sync.js:576`), so a
last-indexer revoke silently leaves the device a writer member — handled (and
hardened against a linearization wedge) in §3.6.

---

## 2. The new key model

### 2.1 Key hierarchy (additions in **bold**)

```
recovery phrase (24 words) + passphrase
        │ Argon2id (INTERACTIVE)            identity.js:85-89
        ▼
   rootSeed (32B)
        │ HKDF (keyed-BLAKE2b PRF)          crypto-envelope.js:142-148
        ├── vaultKey         (per-vault KEK; == epochKey_0)   ◄── lazy-migration anchor
        ├── indexKey         (blind ids / view row keys)
        └── deviceAdminSeed  (vaultId, ROOT identity keypair) ◄── B1: phrase ⇒ root authority
                              identity.rootIdentityKeyPair, identity.js:100-103

per device (identity.js:107-128):
        ├── Ed25519 signing keypair  (op signatures / writer authz)
        ├── Curve25519 box keypair   (sealed-box key wrapping)  ◄── rotation distribution channel
        │     boxSeed = hash("box:"+signSeed)  (identity.js:113) — derives its OWN key only
        └── deviceId = hash("device:"+signingPubkey)  (identity.js:116) ◄── B1: fresh on re-pair

** per epoch e ≥ 1 (NEW):
        epochKey_e = randomBytes(32)     // minted by revoking admin, NEVER derived
        epochKey_0 ≡ vaultKey            // definitional, for legacy compatibility
        epochTag_e = hash(opId_of_KEY_ROTATE || prevEpochTag)   // collision-safe identity (§3.5)
        followSeed = randomBytes(32)     // long-lived, sealed to each device at pairing (§4)
**
```

### 2.2 Per-item content key, now epoch-indexed, with an **epoch-bound `keyId`** `[RT-FIX B4]`

```
itemKey(epochKey_e, objectId) = HKDF(epochKey_e, "item:" + objectId, 32)      // unchanged fn
keyId(epochTag_e, objectId)   = hash("keyid:" + epochTag_e + ":" + objectId)  // ◄── NOW epoch-bound
```

`itemKey` is the function at `crypto-envelope.js:151-153`; only its first
argument changes from the static `vaultKey` to the selected epoch key. Because
`epochKey_0 ≡ vaultKey`, **every legacy object's item key is byte-identical**, so
no history is rewritten.

`keyId` **changes**. Today it is `hash("keyid:" + objectId)`
(`crypto-envelope.js:194`) — **epoch-independent**, so the same object sealed in
two different epochs carries the *same* `keyId`. The red-team (B4) showed this
lets a revoked device that holds an old object's plaintext **link** a new-epoch
re-materialized ciphertext of that object to the plaintext it already has,
defeating post-revoke write unlinkability. The fix is to bind the epoch into the
`keyId`. For epoch 0, `keyId(epochTag_0, objectId)` is defined to equal the
legacy `hash("keyid:"+objectId)` (we special-case `epochTag_0 == ""` to preserve
byte-compatibility for existing rows — see §6).

### 2.3 What each device stores

**Local-only (`local-device.json`, never replicated):**
- existing: `signSeed`, `boxSecretKey`, and `vault{ vaultKey, indexKey,
  deviceAdminSeed }`.
- **NEW: `epochKeys`** — a hex map keyed **by `epochTag`** `{ "<tag1>": <key1>,
  ... }` of every epoch key this device is entitled to, plus the active
  `epochTag` and the integer it maps to. (`vaultKey` is epoch 0 / tag `""`,
  already present.) `[RT-FIX B5]`
- **NEW: `followSeed`** (§4), delivered at pairing, never rotated.

**Replicated (sealed in the materialized view) — the reorg-safe source of truth:**
- existing sealed device records carrying each device's `boxPubkey`.
- **NEW: a `epochkeys!` sealed-row family** (§2.4). For each epoch, one row per
  *entitled* device holding `crypto_box_seal(epochKey, device.boxPubkey)`, keyed
  by **`epochTag`** (§5.6). This lets an offline/rebooted/late device recover its
  epoch keys deterministically from the committed view after any truncation, and
  lets two concurrent rotations coexist without colliding. `[RT-FIX B5]`
- existing `vault-state` row, extended with `activeEpoch` (int) **and
  `activeEpochTag`** (the content-addressing winner).
- **NEW: `tombstone!` sealed-row family** (§3.9) so a cross-device delete is
  durable and the durability reconciler cannot resurrect it. `[RT-FIX B9]`

### 2.4 How `epochKey_{N+1}` is sealed to each remaining device

At rotation the revoking admin, for each **surviving** device `d` (every device
in the committed device set whose `revokedAtLamport == null`, EXCLUDING the one
being revoked, plus the root identity):

```
sealedForD = identity.sealToDevice(d.boxPubkey, epochKey_{N+1})   // crypto_box_seal
```

`crypto_box_seal` is anonymous-sender: only the holder of `d`'s box **secret**
key (which lives only in `d`'s local `local-device.json`, never replicated) can
`crypto_box_seal_open` it (`identity.js:139-146`). The revoked device's
`boxPubkey` is simply not in the loop, so it gets no lockbox.

These lockboxes are persisted as replicated sealed `epochkeys!` rows keyed by
`epochTag` (so an offline survivor receives its lockbox when it returns and
replicates the log, and so concurrent rotations do not collide — B5). A copy
also travels in the `KEY_ROTATE` op body for the fast online path, **but the body
is now sealed under `epochKey_{N+1}` (§3.3), so the revoked device cannot read it
at all** — closing the roster/next-rendezvous leak (B3, B10).

> **Sealed-box FS is sender-side only.** A survivor's box secret key opens its
> own lockboxes; the box keypair is static (`identity.js:113`). This gives
> forward secrecy *against the revoked device* but NOT post-compromise security
> against a *separately compromised surviving device* whose box key leaks. Out of
> scope here (the lost/stolen-survivor case, SECURITY.md §4.4); a future v2 can
> rotate survivor box keypairs on each epoch. Stated honestly in §7.

---

## 3. The protocol, step by step

Trigger: admin invokes `DEVICE_REVOKE { deviceId: R }` (dispatcher,
`autobase-sync.js:1480-1509`).

### 3.1 Admin authorization + mint
1. Authorize the caller (root or `admin` role) — unchanged.
2. **`[RT-FIX B8]` Pre-flight indexer liveness (ship-blocker precondition).**
   Before appending anything: ensure the revoking admin's own writer core is an
   indexer and has recently acked (is live); and **if `R` is an indexer, confirm
   ≥1 *other* live indexer exists and has finalized the indexer-set, BEFORE
   attempting `removeWriter(R)`** (§3.6). If no other live indexer can be
   confirmed, proceed with the rotation anyway (it is independent of eviction,
   §3.6) but flag the eviction as deferred.
3. Compute the surviving entitled set `S = { d ∈ committed devices :
   d.revokedAtLamport == null and d.deviceId ≠ R }` plus the root identity. Read
   each `d.boxPubkey` from the (now boxPubkey-carrying) auth cache (§5.1).
4. `epochKey_{N+1} = crypto.randomBytes(32)` where `N = engine.activeEpoch`.
5. Compute `epochTag_{N+1} = hash(opId_of_this_KEY_ROTATE || prevEpochTag)`
   (collision-safe, §3.5). Persist the active epoch as a **number** for ordering
   AND the `epochTag` for content-addressing.

### 3.2 Seal to each surviving boxPubkey
6. For each `d ∈ S`: `wraps.push({ blindId: blindId(indexKey,
   "epochwrap:"+epochTag+":"+d.deviceId), sealed: identity.sealToDevice(
   d.boxPubkey, epochKey_{N+1}) })`. Omit `R`. **`[RT-FIX B10]` the wrap is keyed
   by a blinded id, not the plaintext `deviceId`, so even a reader of the body
   cannot enumerate the roster.**
7. **`[RT-FIX B3]` Do NOT compute or carry a topic seed in the op.** The topic
   seed is derived locally by each survivor *after* it unwraps its lockbox:
   `topicSeed_{N+1} = topicSeedFromEpochKey(epochKey_{N+1})` (§5.7). Nothing
   about `topicSeed_{N+1}` is transmitted, so only a holder of `epochKey_{N+1}`
   can compute `topic_{N+1}`.

### 3.3 Append `DEVICE_REVOKE` then `KEY_ROTATE` `[RT-FIX B3, B10, B11]`
8. Append `DEVICE_REVOKE { deviceId: R }` (existing op). `_applyDeviceRevoke`
   sets `revokedAtLamport` and best-effort `removeWriter` (§3.6).
9. Append the new-format `KEY_ROTATE`. **The body is sealed under the NEW epoch
   key `epochKey_{N+1}` (changed from `epochKey_N`).** This denies the revoked
   device — which holds `epochKey_N` but not `epochKey_{N+1}` — any ability to
   read the body (roster, prev-chain, reason). Each survivor opens its **own
   lockbox directly from the public per-device wrap using only its box secret
   key** (no dependency on any epoch key), obtains `epochKey_{N+1}`, and *then*
   opens the body. Body and header:

```jsonc
// PUBLIC header (adds two fields: epoch (int, ordering), epochTag (content id))
header: { version, opId, vaultId, deviceId, type:"KEY_ROTATE",
          objectBlindId, lamport, createdAtBucket,
          epoch: "N+1",                 // ◄── ordering hint only
          epochTag: "<hex>" }           // ◄── NEW: content-addressed key id (§5.5)

// PUBLIC per-device wraps (NOT inside the encrypted body) — each entry is itself
// an opaque crypto_box_seal; only the target device's box secret key opens it.
// Keyed by blindId so the roster is not enumerable (B10). Self-contained so a
// single op reconstructs this device's key after any reorg (B11).
wraps: [ { blindId:"<hex>", sealed:"<crypto_box_seal hex of epochKey_{N+1}>" }, ... ]

// ENCRYPTED body (sealed under epochKey_{N+1}, openable ONLY by a survivor that
// already unwrapped its lockbox above):
{
  epoch:       N+1,
  epochTag:    "<hex>",
  prevEpoch:   N,
  prevEpochTag:"<hex>",
  revokedDeviceId: "R",
  reason:      "device-revoke"
  // NOTE: no topicSeed here (B3); survivors derive it locally from epochKey_{N+1}.
  // NOTE: wraps moved OUT of the body into the public, individually-sealed region (B11).
}
```

The append pair goes through the existing serialized `_append` chain so REVOKE +
ROTATE never interleave with another append.

### 3.4 Reducer applies (`KEY_ROTATE` branch rewrite) `[RT-FIX B11]`
On every apply pass the reducer first runs `_rebuildAuthFromView` which now also
rebuilds `engine.epochKeys` (keyed by `epochTag`) and `engine.activeEpochTag`
from the committed `epochkeys!` rows + `vault-state` (§5.2). Then per
`KEY_ROTATE` node:

1. Verify the signer is an authorized admin (keep `_signerAuthorized` adminOnly
   gate).
2. **Find and open THIS device's lockbox from the public `wraps` using ONLY the
   box secret key** — no dependency on `epochKey_{N-1}`:
   `entry = wraps.find(w => w.blindId == blindId(indexKey,
   "epochwrap:"+header.epochTag+":"+myDeviceId))`.
   - If present: `epochKey_{N+1} = identity.openSealedToDevice(myBoxPubkey,
     myBoxSecretKey, entry.sealed)`; `engine.epochKeys.set(header.epochTag,
     epochKey_{N+1})`; persist (§5.4). **This is the entire dependency** — a
     single committed op reconstructs this device's key regardless of whether any
     prior epoch's rows survived a truncation (closes B11).
   - If **absent** (this device is `R`, or genuinely not entitled): record a
     **pending-gap** marker for this `epochTag` (consumed by the catch-up
     mechanism §3.10) and skip applying the body. *Do not* treat a missing wrap
     as a permanent silent dead-end (B7).
3. With `epochKey_{N+1}` in hand, decrypt the body (sealed under it) for the
   prev-chain/reason metadata. Derive `topicSeed_{N+1}` locally (§3.7).
4. Persist reorg-safely, **addressed by `epochTag`**:
   - `view.putVaultState(batch, { rootPubkey, keyEpoch: max(keyEpoch, N+1),
     activeEpoch: max(activeEpoch, N+1), activeEpochTag: winnerTag(§3.5) })`.
   - For each `w ∈ wraps`, `view.putEpochKeyWrap(batch, { epochTag, epoch: N+1,
     blindId: w.blindId, sealed: w.sealed })` keyed by `epochTag` (§5.6), so
     offline survivors and future reboots reconstruct the chain and concurrent
     rotations do not collide (B5).
5. Set `engine.activeEpoch = max(activeEpoch, N+1)` and
   `engine.activeEpochTag = winnerTag` (§3.5).
6. Schedule the swarm topic swap, relay re-seed, and follow-topic announce
   (§3.7) — reconciled from committed state, never fired imperatively from inside
   the reducer (the reducer must stay pure).

### 3.5 Concurrent rotations — content-addressing by `epochTag`, never integer `[RT-FIX B5]`
Two admins each mint `KEY_ROTATE` with `epoch = N+1` but *different* random keys
and *different* `epochTag`s. **The integer is the same; everything that selects
or stores a key uses `epochTag`.** Concretely:

- **Storage** (`epochkeys!` rows) and the **in-memory `epochKeys` map** are keyed
  by `epochTag`, so both lineages' keys **coexist** in the committed view; no row
  overwrites another (this is the fix for the CRITICAL collision — previously
  rows keyed by integer `N+1` per device overwrote each other with stream-order,
  not Lamport-order, winner).
- **Selection.** The reducer deterministically picks the **winner per
  `prevEpochTag`** by `Lamport.beats` (lamport, then `deviceId` tie-break,
  `shared-ops.js:97-103`) and stores it in `vault-state.activeEpochTag`. New
  content seals under the **winning** `epochTag`.
- **Content open.** `_body` selects the key by `header.epochTag` (not integer),
  so a row authored under *either* lineage opens on every device that holds that
  tag's key — and every survivor holds **both** (both wrap rows are committed and
  openable). No survivor is wedged by applying the two rotations in opposite
  order, because the map key is the tag, not the integer (this is the fix for the
  Map.set stream-order bug).
- **Active number** is `max`-merged (order-insensitive); the **active tag**
  follows the Lamport winner.

#### 3.5.1 Concurrent revoke of *different* devices — re-validate the winning wrap set `[RT-FIX B6]`
Admin A revokes X (mints `ROTATE_A`/`keyA`, computing S **before** it learns of
B's revoke, so `keyA`'s wraps **include** Y). Admin B concurrently revokes Y
(`ROTATE_B`/`keyB`, correctly excluding Y). If `ROTATE_A` wins by Lamport, the
active key `keyA` was sealed **to Y** — forward secrecy against Y is defeated,
and the losing rotation that correctly excluded Y is discarded.

**Fix:** after winner-selection, the reducer **validates the winning rotation's
wrap set against EVERY device revoked in the committed view at the winner's
lamport**. If the winning rotation sealed `keyA` to any now-committed-revoked
device (Y here), the rotation is **insufficient**: the reducer marks
`activeEpochTag` as *provisional* and the originating admin (or any admin that
observes the condition) **chains a fresh rotation N+1 → N+2** that re-mints a key
excluding all committed-revoked devices. Until the chained rotation lands, new
content still seals under the provisional winner (Y can read it — this is the
bounded exposure), but the follow-up rotation closes it. **Equivalently and
preferred: serialize REVOKE+ROTATE for concurrent admin actions so the second
revoke always chains on top of the first rather than racing it.** A decisive test
asserts that after two concurrent revokes of X and Y, **neither X nor Y holds the
final `activeEpochTag` key** (§8 Phase 2).

### 3.6 Revoked device was the last indexer — do not wedge linearization `[RT-FIX B8]`
All writers are added `{ indexer:true }` (`autobase-sync.js:510`).
`removeWriter` throws on the last indexer (swallowed at `autobase-sync.js:576`).
The red-team showed that removing the *last live* indexer can stall finalization
of the very ops that perform the revoke+rotate (the indexer-set change is itself
an indexed operation needing acks), wedging the vault at epoch N with R
un-revoked at the Autobase layer — and that the documented "promote another
indexer first" precondition was **never implemented**.

**Locked handling:**
- **Rotation is independent of eviction.** The forward-secrecy mechanism (reducer
  signer+epoch gate + content-key rotation) does NOT depend on `removeWriter`
  succeeding. The dispatcher appends REVOKE + ROTATE and the reducer applies them
  whether or not the writer seat is ever removed. So even a wedged eviction
  cannot block the key rotation from taking effect on any device that linearizes
  the ops.
- **Implement the precondition (§3.1 step 2).** Before `removeWriter(R)`: ensure
  the revoking admin is a live indexer; if R is an indexer, **promote/confirm
  another live indexer and wait for it to finalize the indexer-set change**
  before attempting `removeWriter(R)`. For a 2→1 device revoke where the lone
  survivor remains sole indexer, Autobase permits a single indexer — but
  **open-question #1 (does single-indexer linearization continue after a
  last-indexer `removeWriter` when R is OFFLINE?) is a SHIP BLOCKER**, proven on
  a real `@hyperswarm/testnet` before merge (§8).
- **Fallback.** If Autobase cannot finalize a particular eviction, leave R a
  writer member; the reducer gate (and §3.11) still excludes its writes, and
  content rotation still excludes its reads of new content.

### 3.7 Discovery topic, relay seed, and replication — what actually excludes the revoked device `[RT-FIX B2]`

> **Demotion (load-bearing honesty).** Topic rotation is a **discovery
> convenience, not a security control.** Confidentiality of post-revoke content
> rests **entirely** on the content key. The two facts below are what keep a
> revoked device from *replicating* the log; topic rotation alone never could,
> because the immutable core key is a second, epoch-independent rendezvous and
> Corestore replication is unauthenticated.

#### 3.7.1 Topic rotation (discovery convenience)
- `vaultDiscoveryTopic` becomes epoch-aware: `vaultDiscoveryTopic(topicSeed) =
  HMAC(topicSeed, "swarm-topic-v1")` where `topicSeed_{activeEpoch} =
  topicSeedFromEpochKey(epochKey_{activeEpoch})`, **derived locally, never
  transmitted (B3)**. For epoch 0 (legacy), `topicSeed_0 = vaultKey` so the
  legacy topic is unchanged (no flag-day).
- `joinVault` stops being fire-once; it reconciles the *set* of joined topics
  from committed state. On each applied `KEY_ROTATE` the engine emits
  `epoch-rotated`; the index layer joins `topic_{N+1}` immediately and leaves
  `topic_N` after the grace window (§4). Hyperswarm 4.17.0 supports simultaneous
  multi-topic join, so the single-swarm contract is preserved.
- The revoked device, lacking `epochKey_{N+1}`, **cannot compute `topic_{N+1}`**
  (`topicSeed_{N+1}` is never on the wire). But this only denies it the *new HMAC
  rendezvous* — not the core-key rendezvous below.

#### 3.7.2 The core-key channel — relay re-seed + replication firewall (the real control)
**Confirmed in code:** relays seed by `discoveryKey(autobaseKey)`
(`relay-service.js:827-853` -> `p2p-hiverelay-client/index.js:635`), the core key
never rotates, and `backend/index.js:78` `store.replicate(conn)` is
unconditional. So absent the two changes below, **a revoked device replicates the
entire post-revoke encrypted log forever via the relay/core-key channel** (B2,
and SWARM-lens breaks #1/#2). Mitigations, in priority order:

1. **Replication firewall (load-bearing).** In the swarm `connection` handler
   (`backend/index.js:76-78`), gate `store.replicate(conn)` on the peer
   authenticating as a **current, non-revoked device** in the committed device
   set (the reducer already knows every device's swarm/signing identity). Use the
   Hypercore/Corestore `onauthenticate`/allow hook keyed to that set. A revoked
   peer (or an unknown peer) is refused replication. *This is the only thing that
   actually denies the bytes on a direct dial.*
2. **Epoch-bound relay seed + unseed.** On `KEY_ROTATE`, re-seed the log at every
   survivor's relay under an **epoch-bound discovery key**: call
   `client.seed(autobaseKey, { discoveryKey: HMAC(topicSeed_{N+1},
   "log-disco-v1") })` (the client already accepts an explicit
   `opts.discoveryKey`, `p2p-hiverelay-client/index.js:633`) **and `unseed` the
   old core/discovery key**. Verify `revocable:true`
   (`relay-service.js:351`) actually evicts a named peer/core, not merely stops
   fresh seeds. Survivors recompute the epoch-bound discovery key from
   `epochKey_{N+1}`; the revoked device cannot.
3. **Tie "finalize" to (1)+(2), not to `swarm.leave(topic_N)` (B13/grace).**
   The "force-finalize now" affordance must state it stops further log delivery
   only once the firewall + re-seed land. `swarm.leave(topic_N)` alone closes a
   door the revoked device does not use.

**`[RT-RESIDUAL B2]`** Where a survivor cannot enforce the firewall (e.g. a
third-party relay outside the user's control that still seeds the old core key,
or a peer that dialed before the firewall deployed), the revoked device **can
still replicate the opaque post-revoke ciphertext and traffic-analyze it
(op cadence, sizes, timing, peer set) indefinitely.** It cannot decrypt it.
Truly denying replication requires rotating the Autobase core identity (v2,
§1.2). This is stated in §7.2.

After rotation: new `NOTE_UPSERT`/`CLIP_ADD` ops carry `header.epoch = N+1`,
`header.epochTag`, and seal under `epochKey_{N+1}` with an epoch-bound `keyId`
(§2.2, §5.5). The revoked device cannot decrypt epoch-(N+1) ciphertext even if it
obtains the bytes, and cannot link a new-epoch row to an old object by `keyId`
(B4).

### 3.8 Re-pairing / re-admission — selective-chain by default + admit policy `[RT-FIX B1]`
The deepest break: a revoked device still holds the 24-word phrase (or
`local-device.json`). `RESTORE_VAULT` re-derives `rootSeed`→`vaultKey`/`indexKey`/
`deviceAdminSeed` and, when `local-device.json` is absent, mints a **brand-new
device identity** (`identity.createDeviceIdentity`, fresh `signingPubkey`/
`boxPubkey`/`deviceId` — `identity.js:107-128`). That new `deviceId` has no
`revokedAtLamport`, so the reducer/verifier revoke gate does not apply to it. It
can run the normal pairing hello and an honest admin **cannot cryptographically
distinguish "new laptop" from "re-imaged revoked laptop"** — both present a fresh
box pubkey. The current `approvePairRequest` (`autobase-sync.js:1294-1316`) builds
the bootstrap with **no epoch filtering** and (per the prior design) full-chain
by default, handing the ex-attacker `epochKey_{N+1}` and every future key.
Worse, anyone with the phrase is **root** (`identity.js:100-103`) and can
self-sign `DEVICE_ADD` to self-admit.

**Locked policy (inverts the unsafe default):**
1. **Selective-chain is the DEFAULT for every pairing.** A newly paired device
   receives **only the current `activeEpoch` key** (and epoch 0 == `vaultKey`
   only if the user explicitly opts into history). It does **not** receive the
   full chain. Full historical access is a **separate, explicitly-confirmed
   grant** ("grant full history"). This makes re-admitting a previously-revoked
   device equivalent to admitting a fresh device with no retroactive access — the
   safe default.
2. **Admit policy (N-of-M co-sign).** A lone phrase-holder must not be able to
   self-admit a device. Add a per-vault `admit-policy` requiring **N-of-M
   existing (non-revoked) admins to co-sign `DEVICE_ADD`** for any new device.
   Default N=1 for single-admin vaults (documented exposure), N=2 recommended
   once ≥2 admin devices exist.
3. **"Looks like a previously-revoked device" heuristic.** Although `deviceId` is
   fresh, surface a loud warning at admit time if the joiner's box/sign pubkey or
   self-declared label/platform matches any record ever associated with a revoked
   device; require an explicit out-of-band human confirmation.
4. **Bind re-admission to a fresh out-of-band decision.** Re-pair never
   auto-delivers historical epoch keys.

**`[RT-RESIDUAL B1]`** None of this survives **recovery-phrase compromise**. A
party holding the 24 words is root and can mint identities and (with single-admin
N=1) self-admit. **A truly hostile device that knows the phrase requires phrase
rotation = new vault + re-key (the cryptographic-erasure path), not device
revocation.** Stated in §7.2.

### 3.9 Durability reconciler — epoch-faithful re-append + durable tombstones `[RT-FIX B4, B9]`
The reconciler re-appends additive rows via `_makeOp`. The prior design stamped
`header.epoch = activeEpoch` on re-append, pulling pre-rotation content **forward
into the new epoch**. The red-team showed two problems:

- **B4 (known-plaintext correlate).** Re-sealing an old object under
  `epochKey_{N+1}` right after revoke, while `keyId` was epoch-independent, hands
  the revoked device (still replicating via the core-key channel) a ciphertext it
  can **link to plaintext it already holds**, by matching the epoch-free `keyId`.
- **B9 (resurrection).** A remote device's reconciler can re-materialize a row
  that a *different* device deleted, because the delete-supersede check is
  **device-local** — resurrecting deleted content under the new epoch.

**Locked handling:**
1. **Re-append epoch-FAITHFULLY.** The pending-durable entry carries the row's
   **original `epochTag`**; `_makeOp` re-seals under that original key (survivors
   already hold every epoch key, so they open it — pulling forward gives them
   nothing). This removes the B4 correlate entirely and keeps LWW/tombstone
   ordering intact.
2. **Epoch-bound `keyId` (§2.2).** Even for any row that legitimately changes
   epoch, the same object in different epochs is now **unlinkable** to anyone
   lacking the epoch key.
3. **Durable cross-device tombstones.** A delete writes a persistent `tombstone!`
   sealed row. `_rowPresentFor` treats a tombstoned object as "present" so the
   reconciler **retires** its pending entry and never re-materializes it; the
   reducer checks the tombstone before applying any `*_UPSERT`. This makes delete
   cross-device-durable (closes B9).
4. **Suppress re-append during the post-revoke migration window** for objects
   whose creation epoch ≤ the just-revoked epoch, as belt-and-suspenders.

The verifier keeps its **strict** epoch-binding ("`header.epochTag` binds to the
key the body was sealed under"); re-append is epoch-faithful, so the prior
"tolerate `header.epoch` > creation epoch" relaxation (old open-q #3) is **no
longer needed and is dropped** — closing a verifier hole the red-team flagged.

### 3.10 Offline survivor missing a rotation — catch-up re-wrap, never a silent dead-end `[RT-FIX B7]`
`S` is snapshotted at rotation time from the then-committed device set, which is
reorg-sensitive. If a transient truncation dropped a *good* offline device D from
the committed view at the instant an intermediate rotation sampled `S`, D is
omitted from that epoch's wraps and the prior design's "skip silently if absent"
turned this into a **permanent dead-end** (D walks `e-1` fine, finds no wrap at
`e`, and can never recover except by full re-pair).

**Locked handling:**
- The reducer's missing-wrap branch records a **pending-gap** marker (§3.4 step
  2), it does not silently and permanently skip.
- When any online admin/survivor observes that a non-revoked device D unwrapped
  `epochKey_{e-1}` but has a pending-gap at `epochTag_e`, it appends a small
  **catch-up re-wrap op** sealing `epochKey_e` to D's `boxPubkey`, keyed by
  `(epochTag_e, blindId(D))`. D consumes it on next sync.
- Membership is computed as the **union of devices seen non-revoked across a
  stable window** rather than a single committed-view snapshot, and every
  rotation re-seals **all still-entitled epoch keys** the survivor is missing —
  so a missing wrap self-heals and is never a permanent skip for a non-revoked
  device.

### 3.11 Revoke/rotation lamport race — reject committed-revoked signers outright `[RT-FIX B12]`
The reducer gate is `opLamport >= dev.revokedAtLamport`
(`autobase-sync.js:471`); the verifier mirrors `opEpoch >= revokedEpoch`
(`verifier.js:170`). Because lamport is the device's **own** monotonic counter, a
malicious revoked device can **backdate** a content op to
`lamport = revokedAtLamport - 1` to slip it *under* the threshold; the signature
is valid (its signing key is still its own) and survivors accept it as legitimate
epoch-N content "authored just before revoke" — a bounded **write-injection**.

**Locked handling:**
- **`removeWriter` is load-bearing here** (not merely defense-in-depth): the
  Autobase writer-seat removal is the real defense against lamport backdating;
  ensure it linearizes (§3.6) before fully trusting the gate.
- **For newly-arriving ops, gate on "revoked at all," not on the lamport
  inequality.** Once a `DEVICE_REVOKE` for a device is in the committed view,
  reject **any** content op from that signer regardless of its claimed lamport;
  keep the `>=` lamport rule only for **already-linearized history** (so genuine
  pre-revoke ops that were already accepted stay valid). This denies the backdate
  window for anything arriving after the revoke is committed.
- **Bound acceptable lamport skew** so a device cannot stamp ops arbitrarily far
  below the current frontier.

---

## 4. The discovery-topic chicken/egg solution + grace window `[RT-FIX B13]`

**Problem.** A *surviving* device that was OFFLINE during the rotation can only
derive `topic_N` (from `epochKey_N`, the newest key it holds). If survivors have
already left `topic_N`, the offline-good device joins a swarm nobody is on and
never receives the `KEY_ROTATE` that carries its `epochKey_{N+1}` lockbox — it is
stranded. Meanwhile the *revoked* device can also still compute `topic_N`.

**Primary solution — per-device follow-topic, DEFAULT-ON (changed from opt-in).**
Derive a stable per-device catch-up topic `followTopic(deviceId) =
HMAC(followSeed, "follow:" + deviceId)`, where `followSeed` is a dedicated
long-lived secret sealed to each device at pairing (NOT epoch-rotated, so a
device can always find it). Every survivor announces, for each OTHER **surviving**
device, that device's `followTopic` for a window after a rotation. An
offline-good device always joins its OWN `followTopic` on boot and finds a
survivor regardless of which content epoch it is on. **The revoked device's
`followTopic` is dropped on revoke**, so it gets no rendezvous from this channel —
and the grace window on `topic_N` can then be **zero**. Cost: N−1 extra announced
topics per survivor during the window — trivial for 2–6 devices.

**Secondary — bounded dual-join grace window on `topic_N`.** Retained only as a
fallback for vaults that disable follow-topics. Survivors keep `topic_N` joined
for a bounded per-vault window. **`[RT-FIX B13]` The default for a STOLEN-device
revoke is grace = 0** (follow-topic carries the good offline devices); a longer
window is offered only when the user asserts the device is merely retired/
trusted-offline, not compromised.

**Multi-rotation walk-forward.** A long-offline survivor walks `N -> N+1 -> N+2`:
each `KEY_ROTATE` carries that device's own **public, self-contained** lockbox
(§3.3), so it unwraps each `epochKey` using only its box secret key, in any
order, robust to reorgs (B11). If it missed an intermediate wrap due to a
transient reorg, the catch-up re-wrap (§3.10) repairs it.

**`[RT-RESIDUAL B2/B13]` What the revoked device gains regardless of the window.**
Because relays seed by the immutable core key (§3.7.2), leaving `topic_N` does
**not** stop the revoked device from replicating the post-revoke encrypted log
and harvesting metadata via the core-key channel. The follow-topic + grace=0
removes the *topic_N* metadata exposure, and the firewall + relay re-seed (§3.7.2)
are what actually cut off the core-key channel where the user controls the
relays. **Where the user does not control a seeding relay, replication of opaque
ciphertext continues indefinitely.** Honest residual, §7.2.

---

## 5. Exact file-level changes

> Integration anchors below are line numbers as of this writing; treat them as
> hints, not contracts.

### 5.1 `backend/autobase-sync.js` — thread `boxPubkey` into the rebuilt device rec (one-line gap fix)
In `_rebuildAuthFromView` (`~:328-336`), add `boxPubkey` to the rebuilt `rec`:
```js
const rec = {
  deviceId: plain.deviceId,
  signingPubkey: plain.signingPubkey,
  boxPubkey: plain.boxPubkey,          // ◄── ADD: already sealed at putDevice, needed to seal epoch keys
  writerKey: plain.writerKey,
  roles: plain.roles || ['writer'],
  revokedAtLamport: ...,
  addedAtLamport: ...,
  isRoot: !!plain.isRoot
}
```
No new persistence: `boxPubkey` is already in the sealed device record and
resolvable via `listDevicesSealed` -> `resolveObjMeta` -> `openRecord`. Purely a
projection fix.

### 5.2 `backend/autobase-sync.js` — epoch-key state keyed by `epochTag`, a pure function of the committed view `[RT-FIX B5]`
Add engine fields `this.epochKeys = new Map()` (**`epochTag` -> Buffer**, plus a
reserved entry `"" -> vaultKey` for epoch 0), `this.activeEpoch = 0`,
`this.activeEpochTag = ""`. In `_rebuildAuthFromView`, AFTER reading
`vault-state`:
```js
this.activeEpoch    = Math.max(Number(vs?.activeEpoch || 0), this.activeEpoch || 0)
this.activeEpochTag = vs?.activeEpochTag || this.activeEpochTag || ""
this.epochKeys.set("", this.vaultKey)              // epoch 0 ≡ vaultKey (legacy anchor)
for (const { epochTag, sealed } of await this.view.listEpochKeyWrapsFor(this.myDeviceId)) {
  try {
    const k = ctx.identity.openSealedToDevice(this.myBoxPubkey, this.myBoxSecretKey, sealed)
    this.epochKeys.set(epochTag, k)                // ◄── keyed by TAG, never the integer (B5)
  } catch (_) { /* not our wrap / not entitled — record pending-gap (§3.10) */ }
}
```
This makes the epoch-key map a deterministic rebuild from the committed
(truncation-aware) view. Because the map and the rows are keyed by `epochTag`,
two concurrent rotations coexist and the Map.set stream-order bug is gone. The
in-batch incremental `epochKeys.set(tag, ...)` inside the `KEY_ROTATE` branch
exists only so later ops in the same batch can seal/open — but per §3.4/B11 a
device opens its lockbox from the op's own public wrap using only its box secret
key, so a single rotation is self-contained and replay across batch boundaries
cannot wedge it.

> `listEpochKeyWrapsFor(deviceId)` filters the `epochkeys!` family to rows whose
> wrap `blindId == blindId(indexKey, "epochwrap:"+epochTag+":"+deviceId)`, so the
> device locates its own without scanning and without revealing the roster (B10).

### 5.3 `backend/autobase-sync.js` — rewrite the `KEY_ROTATE` reducer branch
Replace the counter bump with the §3.4 logic: admin-verify -> open this device's
lockbox from the public `wraps` using only the box secret key (record pending-gap
if absent, §3.10) -> `epochKeys.set(epochTag, key)` -> decrypt body (sealed under
the NEW key) -> winner-select by `epochTag` (§3.5) -> re-validate winning wrap set
vs committed revocations (§3.5.1) -> `putVaultState({ ..., activeEpoch,
activeEpochTag })` -> `putEpochKeyWrap` per wrap (keyed by `epochTag`) -> set
`activeEpoch`/`activeEpochTag` -> emit `epoch-rotated`. Keep the
`_signerAuthorized adminOnly` gate.

### 5.4 `backend/autobase-sync.js` — `_makeOp` and `_body` are `epochTag`-aware
- `_makeOp` (`~:174-215`): stamp `header.epoch = String(this.activeEpoch)` **and
  `header.epochTag = this.activeEpochTag`**, seal under the active epoch key and
  the epoch-bound `keyId`:
  ```js
  const envelope = crypto.seal({
    epochKey: this.epochKeys.get(this.activeEpochTag),   // ◄── was: vaultKey; keyed by TAG
    epochTag: this.activeEpochTag,                        // ◄── for epoch-bound keyId (§2.2)
    objectId: this._opBodyObjectId(objectBlindId),
    objectBlindId, opType: type, schema, vaultId, plaintext
  })
  ```
- `_body` (`~:453-460`): select the key from the op header **by tag**:
  ```js
  const tag = String(op.header?.epochTag || "")
  return crypto.openWithObjectId({
    epochKey: this.epochKeys.get(tag) || this.vaultKey,  // tag "" falls back to vaultKey
    epochTag: tag,
    objectId: this._opBodyObjectId(op.header?.objectBlindId),
    envelope: op.envelope
  })
  ```
- **Durability re-append (B4):** `_makeOp` used by `_reconcileDurability` must use
  the **pending entry's original `epochTag`**, not `activeEpochTag` (§3.9).

### 5.5 `backend/autobase-sync.js` + `shared-ops.js` + `verifier.js` — `epoch`/`epochTag` as public header fields; epoch in AAD
- `shared-ops.js`: add `'epoch'` and `'epochTag'` to `HEADER_PUBLIC_FIELDS`
  (`~:41-44`). Without this, `assertHeaderPublicOnly` throws on every op carrying
  them.
- `verifier.js`: the per-field header loop reuses `classifyHeaderField`, so the
  public set picks up `epoch`/`epochTag` automatically. Keep the **strict**
  epoch-binding check (§3.9) — drop the prior "tolerate header.epoch > creation
  epoch" relaxation. Update VERIFIER_SPEC.md §C5.
- **`crypto-envelope.js` AAD `[RT-FIX]`:** the AAD today is
  `{ vaultId, objectBlindId, opType, schema }` (`crypto-envelope.js:197-202`) —
  it does **NOT** contain the epoch. **Add `epochTag` to the sealed AAD** so a
  cross-epoch ciphertext splice / wrong-epoch decrypt fails closed under
  XChaCha20-Poly1305 (decrypt with the wrong epoch key -> AEAD failure, not
  silent acceptance). This is the §5.5 guarantee the prior design *claimed* but
  the code did not yet implement.

### 5.6 `backend/materialized-view.js` — `epochkeys!` + `tombstone!` families keyed by `epochTag`; `vault-state` extension `[RT-FIX B5, B9]`
- New `PREFIX.EPOCHKEYS = 'epochkeys!'`. **Key per wrap by `epochTag`, never the
  integer:** `epochKeysKey(epochTag, blindId) = 'epochkeys!' +
  blindId("epochkey:"+epochTag+":"+wrapBlindId)`. (This is the direct fix for the
  CRITICAL integer-collision: previously `'epochkey:'+epoch+':'+deviceId` used the
  integer, so two concurrent rotations at integer N+1 overwrote each other per
  device.)
- `putEpochKeyWrap(target, { epochTag, epoch, blindId, sealed })` — seals the
  record under the current view key (contents at-rest-encrypted; `sealed` is
  itself a `crypto_box_seal` only the target opens). Mirrors `putDevice`. Also
  write a sealed objmeta row.
- `listEpochKeyWrapsFor(deviceId)` — read-stream the family, open each, return
  `[{ epochTag, epoch, sealed }]` for rows whose wrap `blindId` matches this
  device.
- New `PREFIX.TOMBSTONE = 'tombstone!'`; `putTombstone(target, { objectBlindId,
  lamport })` and `isTombstoned(objectBlindId)` for the durable cross-device
  delete (§3.9, B9).
- `getVaultState`/`putVaultState` already round-trip an arbitrary `value`, so
  `activeEpoch`/`activeEpochTag` ride along with no schema change — include them
  in the value the reducer writes.

### 5.7 `backend/crypto-envelope.js` — epoch-key params, epoch-bound `keyId`, topic-seed helper `[RT-FIX B4]`
- Rename the `vaultKey` parameter of `seal`/`open`/`openWithObjectId` to
  `epochKey` (the 32-byte AEAD root for the selected epoch). `itemKey` is
  unchanged but now called with the epoch key.
- **Change `keyId` to be epoch-bound (§2.2):**
  `keyId(epochTag, objectId) = hash("keyid:" + epochTag + ":" + objectId)`, with
  the special case `epochTag === "" => hash("keyid:" + objectId)` to preserve
  byte-compatibility for legacy epoch-0 rows. Add `epochTag` to the `seal`/`open`
  signatures so the function can compute it.
- **Add `epochTag` to the AEAD AAD** (§5.5).
- Add `topicSeedFromEpochKey(epochKey) = hkdf(epochKey, "swarm-topic-seed-v1",
  32)` (used locally; **never** put on the wire — B3).

### 5.8 `backend/pairing.js` — epoch-aware topic; selective-chain-by-default bootstrap `[RT-FIX B1]`
- `vaultDiscoveryTopic(topicSeed) = hmac(topicSeed, "swarm-topic-v1")`. Epoch 0
  callers pass `vaultKey` (legacy topic unchanged); epoch ≥ 1 callers pass
  `topicSeedFromEpochKey(epochKey_e)`.
- `sealBootstrap`/bootstrap payload (`approvePairRequest`,
  `autobase-sync.js:1294-1316`) currently seals `vaultKey`/`indexKey`/
  `deviceAdminSeed` with **no epoch filtering**. Change to **selective-chain by
  default**:
  - Always include `activeEpoch`/`activeEpochTag` and the **single
    `epochKeys: { "<activeEpochTag>": <hex> }`** entry — the current key only.
  - Include `followSeed` (§4) so the new device can be found while offline.
  - Add an explicit, separately-confirmed `grantHistory` flag; only when set does
    the bootstrap include older epoch keys / `vaultKey` for history. Default off.
  - Enforce the **admit-policy** (§3.8 step 2): `DEVICE_ADD` requires N-of-M admin
    co-signatures; reject a lone self-admit when policy N>1.

### 5.9 `backend/vault-store.js` — persist the `epochTag`-keyed chain + `followSeed`
- `saveLocalDevice`: add an optional `epochKeys` hex map **keyed by `epochTag`**
  and `followSeed` to the `vaultSecrets` argument; serialize into
  `plaintext.vault`.
- `loadLocalDevice`: parse them back; the active tag maps to the active integer.
  Epoch 0 (tag `""`) is the already-stored `vaultKey`.
- `saveVaultSecrets`: pass `epochKeys`/`followSeed` through. Called at rotation
  (persist a newly-unwrapped key under its tag) and at pairing (persist the
  delivered current key).

### 5.10 `backend/index.js` — replication firewall + topic membership from committed epoch state `[RT-FIX B2]`
- **Replication firewall (load-bearing).** Change the `connection` handler
  (`backend/index.js:76-78`) so `store.replicate(conn)` runs **only** after the
  peer authenticates as a committed, non-revoked device (Corestore/Hypercore
  `onauthenticate`/allow hook keyed to the reducer's device set). Refuse revoked
  or unknown peers. *Pairing connections* keep their existing dedicated path.
- `joinVault`: parameterize by active epoch; reconcile the joined topic SET from
  committed state (replace single `state.joinedTopic` with `state.joinedTopics`
  Set). Subscribe to `epoch-rotated`: join `topic_{N+1}` immediately; schedule
  `swarm.leave(topic_N)` after the grace window (default 0 for stolen-device,
  §4); announce survivors' follow-topics for the window.
- `lock`/`leaveVault`: leave ALL joined topics; wipe in-memory `epochKeys` and
  `followSeed` alongside `vaultKeys`.
- Fresh-vault/unlock/restore: set `activeEpoch=0`, `activeEpochTag=""`; on unlock
  the engine rebuilds `epochKeys` from view + local blob.

### 5.11 `backend/relay-service.js` — epoch-bound seed + unseed on rotation `[RT-FIX B2]`
- On `epoch-rotated` (today the handler only stamps a cosmetic timestamp,
  `relay-service.js:860-863`): call `seedVault(autobaseKey, { discoveryKey:
  HMAC(topicSeed_{N+1}, "log-disco-v1") })` to re-seed under the epoch-bound
  discovery key, **and `unseed` the previous discovery key**. Survivors recompute
  the new discovery key from `epochKey_{N+1}`; the revoked device cannot.
- Verify `seedOpts.revocable` (`relay-service.js:351`) and the client `unseed`
  (`p2p-hiverelay-client/index.js:999`) actually **evict** a named core/peer, not
  merely stop fresh seeds (open-q #2, ship-blocker for the firewall story).

### 5.12 Compatibility with the reorg-safe device cache + durability reconciler `[RT-FIX B4, B9, B11]`
- **Reorg-safe cache.** All new state (`activeEpoch`, `activeEpochTag`,
  `epochKeys` keyed by tag) is rebuilt from the committed view in
  `_rebuildAuthFromView` (§5.2). A reorg that truncates+replays a `KEY_ROTATE`
  recomputes identical epoch state from the post-truncation `vault-state` +
  `epochkeys!` rows. Because a device opens its lockbox from the op's own public
  wrap using only its box secret key (§3.4), a **single** rotation op is
  self-contained and replay across batch boundaries cannot wedge it (closes B11).
- **Durability reconciler.** `_reconcileDurability` re-appends additive rows via
  `_makeOp`, but now **epoch-faithfully**: the pending entry carries the row's
  original `epochTag` and re-append re-seals under *that* key, not the active one
  (closes B4). Cross-device deletes are honored via the durable `tombstone!`
  family: `_rowPresentFor` treats a tombstoned object as present, retiring its
  pending entry; the reducer checks `isTombstoned` before applying any
  `*_UPSERT` (closes B9). The fresh-writer migration window
  (`_lastWriterAddedAt`) is the same trigger a rotation-driven
  `addWriter`/`removeWriter` fires; suppress re-append for objects whose creation
  epoch ≤ the just-revoked epoch during that window (§3.9 step 4).

---

## 6. Migration for existing vaults

**Definition: `epochKey_0 ≡ vaultKey`, `epochTag_0 = "" `, `activeEpoch = 0`,
`topicSeed_0 = vaultKey`, `keyId(epochTag_0, objectId) = hash("keyid:"+objectId)`.**

- Existing objects were sealed via `itemKey(vaultKey, objectId)` with
  `keyId = hash("keyid:"+objectId)`. With `epochKey_0 == vaultKey` and the
  `epochTag_0 == ""` special case in `keyId`, **every legacy row opens unchanged**
  with zero re-encryption and the same `keyId`/AAD bytes (the AAD gains
  `epochTag:""`, which canonicalizes to the legacy value — see Phase 0 test).
- Ops authored before this change have no `header.epoch`/`header.epochTag`.
  `_body` treats a missing tag as `""` and opens under `vaultKey`. Old ops open
  transparently.
- The existing discovery topic is `HMAC(vaultKey, "swarm-topic-v1")`; with
  `topicSeed_0 = vaultKey`, the epoch-0 topic is identical — no flag-day.
- `vault-state` rows without `activeEpoch`/`activeEpochTag` default to `0`/`""`.
  The first real `KEY_ROTATE` (a device revoke) takes the vault from epoch 0 to
  epoch 1 and begins forward secrecy from that point on.
- Local-device blobs without `epochKeys`/`followSeed` are fine: epoch 0 is the
  already-present `vaultKey`; `followSeed` is delivered/derived on next pairing or
  generated and sealed to existing devices on first rotation.

> **AAD-compat caveat (must be tested, Phase 0).** Adding `epochTag` to the AAD
> changes the AAD object for *new* ops; for *legacy* rows it must canonicalize to
> the exact pre-change bytes (omit the field when `epochTag === ""`, or include
> `epochTag:""` only if the canonicalizer already would have — the Phase-0 test
> asserts a legacy envelope still opens). If byte-compat cannot be preserved,
> gate the AAD change behind an envelope-version bump and keep v-current rows on
> the old AAD.

No data migration, no rewrite, no re-pair required for existing vaults.

---

## 7. Security analysis + the honest guarantee statement

### 7.1 What the design guarantees
- **Forward secrecy of CONTENT against the revoked device (the deliverable
  property — UNCHANGED and red-team-confirmed).** After `DEVICE_REVOKE { R }` and
  its `KEY_ROTATE` to `epochTag_{N+1}`, device R cannot **decrypt** any content
  created under `epochTag_{N+1}` or later. Proof sketch: such content is sealed
  under `itemKey(epochKey_{N+1}, ·)`; `epochKey_{N+1}` is fresh random,
  distributed ONLY by `crypto_box_seal` to surviving box pubkeys; R's `boxPubkey`
  is omitted; `crypto_box_seal` is opaque without the recipient box secret key;
  R's box key (derived from its own `signSeed`) opens only its own (absent)
  lockbox. The AAD now binds `epochTag`, so a wrong-epoch decrypt fails closed.
  **The red-team verified R cannot derive or unwrap `epochKey_{N+1}` from any
  retained material; this is the load-bearing guarantee and it holds.**
- **R cannot compute the epoch-(N+1) HMAC topic** (`topicSeed_{N+1}` is derived
  locally from `epochKey_{N+1}` and never transmitted — B3). *This denies the new
  discovery rendezvous, NOT replication via the core key (see §7.2).*
- **Post-revoke writes are excluded** by the reducer signer gate, the
  "reject committed-revoked signer" rule for newly-arriving ops (B12), the
  verifier C6 rule, and `removeWriter` where linearization permits (§3.6, §3.11).
- **Post-revoke rows are unlinkable to old objects** by the epoch-bound `keyId`
  (B4).
- **Concurrent rotations converge** (content-addressed by `epochTag`, winner
  re-validated against committed revocations — B5, B6).
- **Good offline survivors are never permanently stranded** (catch-up re-wrap,
  follow-topic — B7).
- **Reorg safety.** Epoch state is a pure function of the committed view; each
  rotation op is self-contained (B11), so forks/truncations cannot silently
  revert a rotation or wedge a device.
- **No resurrection of cross-device deletes** (durable tombstones — B9).
- **At-rest / relay blindness preserved.** Lockboxes, tombstones, and
  `vault-state` ride inside sealed rows; relays/disk see only ciphertext. The
  only new *public* header fields are `epoch` (a small monotone counter) and
  `epochTag` (an opaque hash) — they leak that a rotation count exists, no
  content, no identity, no roster.

### 7.2 What the design does NOT guarantee — the HONEST limits (expanded post-red-team)

> **(L0) Revocation provides FORWARD secrecy of CONTENT, NOT past-erasure and NOT
> exclusion from REPLICATION.** A revoked device keeps everything it already had,
> and — absent a user-controlled replication firewall/relay re-seed — keeps
> **replicating the opaque post-revoke log** indefinitely.

- **(L1) Past content is unrecoverable by design.** R still holds `vaultKey`
  (= `epochKey_0`) and every epoch key it was entitled to before revoke, in its
  local `local-device.json` and (for `vaultKey`) re-derivable from the 24 words.
  Revoke neither deletes that file nor rotates the phrase. R can STILL read all
  content created at epoch ≤ N. Unavoidable: the bytes and keys are physically on
  its disk.

- **(L2) `[RT-RESIDUAL B2]` The revoked device keeps REPLICATING post-revoke
  ciphertext and metadata.** Relays seed by the immutable Autobase core key and
  `store.replicate` is unauthenticated by default. Our **replication firewall +
  epoch-bound relay re-seed (§3.7.2)** cut this off **only where the survivors
  control the relays and have deployed the firewall**. Against a third-party
  relay still seeding the old core key, or a peer that dialed before the firewall
  shipped, **R continues to replicate the encrypted log and traffic-analyze it
  (op cadence, sizes, timing, peer set) forever — it simply cannot decrypt it.**
  The only way to actually deny replication is to rotate the Autobase core
  identity (new base + full log migration), which v1 does not attempt (§1.2, v2).
  *Topic rotation is a discovery convenience and does not bound this.*

- **(L3) `[RT-RESIDUAL B1]` The recovery phrase and root material are
  un-revocable.** Anyone with the 24 words re-derives `vaultKey`/`indexKey`/
  `deviceAdminSeed`, **is root** (`identity.js:100-103`), can mint fresh device
  identities (fresh `deviceId`, invisible to the revoke gate — `identity.js:116`),
  and — under a single-admin (N=1) admit policy — can **self-admit**. Selective-
  chain-by-default and the N-of-M admit policy (§3.8) make a *normal* re-pair
  retroactively harmless and stop lone self-admit when ≥2 admins exist, but **none
  of it survives phrase compromise.** A truly hostile party that knows the phrase
  requires **phrase rotation = new vault + re-key (cryptographic erasure)**, not
  device revocation. This is the threat-model boundary: device revocation assumes
  the *device* is hostile, not that the *phrase* is in enemy hands.

- **(L4) Metadata exposure during catch-up.** Follow-topic default-on + grace=0
  removes the `topic_N` exposure for stolen-device revokes, but see L2: the
  core-key channel exposes post-revoke metadata regardless where the user does
  not control the relays.

- **(L5) Sealed-box FS is sender-side only.** Forward secrecy holds against the
  revoked device, not against a *separately compromised surviving device* whose
  static box secret key leaks. Out of scope for v1 (v2: rotate survivor box
  keypairs per epoch).

- **(L6) Concurrent-revoke transient exposure.** Under a concurrent revoke of two
  different devices, the provisionally-winning rotation may briefly seal the
  active key to a device the other admin revoked; the chained follow-up rotation
  (§3.5.1) closes it, but content written in the gap is readable by that device
  until the chain lands. Bounded, self-healing, documented.

- **(L7) Last-indexer eviction is best-effort.** Rotation takes effect
  independently of `removeWriter` (§3.6), but the writer-seat removal itself may
  be deferred on a last-indexer/offline-target case until another indexer
  finalizes; write exclusion then rests on the reducer "reject committed-revoked
  signer" rule (B12) until eviction completes. Open-q #1 (single-indexer
  linearization after last-indexer `removeWriter`) is a **ship blocker**.

- **(L8) Docs to correct (§1.3).** The "removeWriter is a no-op" claim and the
  over-strong "cannot rejoin the rendezvous"/"cannot obtain the bytes"/"bounded
  14-day exposure" wording in SECURITY.md §4.2 / THREAT_MODEL.md §2.3 /
  PAIRING.md §5 must be rewritten to the implemented guarantee: *writes are
  stopped by the reducer gate AND (best-effort) writer eviction; reads of NEW
  content are stopped by content-key rotation; the revoked device can still
  replicate opaque post-revoke ciphertext where relays are not firewalled; reads
  of content already decrypted while trusted are NOT retroactively protected.*

The honest one-line promise: **"Revoke a device" means that device can no longer
DECRYPT anything you create AFTER you revoke it, and can no longer write to the
vault. It does NOT make the device forget what it already had, does NOT by itself
stop it from replicating the (unreadable) future log, and does NOT help if your
recovery phrase is compromised — that needs a new vault.**

---

## 8. Phased implementation plan + test strategy

Each phase is independently mergeable and green-before-next. **The decisive test
(Phase 2) and the two ship-blocker testnet checks (open-q #1, #2) gate merge of
the revocation feature.**

### Phase 0 — Crypto core (no behavior change yet)
**Files:** `crypto-envelope.js`, `shared-ops.js`, VERIFIER_SPEC.md.
- Rename `vaultKey` -> `epochKey` param in `seal`/`open`/`openWithObjectId`.
- **Make `keyId` epoch-bound** (`hash("keyid:"+epochTag+":"+objectId)`, with the
  `epochTag===""` legacy special case) `[B4]`.
- **Add `epochTag` to the AEAD AAD** (fail-closed cross-epoch splice) `[§5.5]`.
- Add `topicSeedFromEpochKey` (local-only) `[B3]`.
- Add `'epoch'`,`'epochTag'` to `HEADER_PUBLIC_FIELDS`; update VERIFIER_SPEC §C5;
  **keep strict epoch-binding (drop the prior tolerate-newer-epoch relaxation).**
- **Tests:** existing crypto/seal round-trips pass with `epochKey == vaultKey` and
  `epochTag === ""` (proves byte-compat — esp. the AAD-compat caveat in §6);
  sealing under key A / opening under key B fails AEAD (cross-epoch splice);
  **same object sealed under two different `epochTag`s yields DIFFERENT `keyId`s**
  (B4 unlinkability); a legacy envelope (no `epochTag`) still opens unchanged;
  header with `epoch`/`epochTag` passes `assertHeaderPublicOnly`, a forbidden
  field still throws.

### Phase 1 — Epoch plumbing keyed by `epochTag`, lazy migration (epoch 0 only)
**Files:** `autobase-sync.js`, `materialized-view.js`, `vault-store.js`.
- Add `engine.epochKeys` (Map keyed by `epochTag`, `"" -> vaultKey`),
  `activeEpoch=0`, `activeEpochTag=""`; `_makeOp` stamps `epoch="0"`,
  `epochTag=""` and seals under epoch 0; `_body` selects by `header.epochTag`
  (defaults to `""`); fix the `boxPubkey` projection (§5.1).
- `materialized-view.js`: `epochkeys!` family **keyed by `epochTag`** +
  `listEpochKeyWrapsFor` + `vault-state` `activeEpoch`/`activeEpochTag`
  round-trip (additive; epoch-0 vaults write `0`/`""`); add `tombstone!` family
  skeleton.
- **Tests:** existing vault round-trips and the multiwriter convergence test
  (Task #10) pass unchanged (lazy migration is byte-compatible); a pre-change
  vault opens post-change; reorg test: truncate+replay rebuilds
  `activeEpoch=0`/`epochKeys{""}` deterministically.

### Phase 2 — `KEY_ROTATE` rewrite + `DEVICE_REVOKE` wiring (content-key rotation) — **THE DECISIVE PHASE**
**Files:** `autobase-sync.js` (reducer branch + dispatcher), `materialized-view.js`,
`vault-store.js`.
- Rewrite the `KEY_ROTATE` reducer branch (§5.3): open lockbox from public
  `wraps` via box secret key only (B11); body sealed under the NEW key (B3/B10);
  wraps blinded by `blindId` (B10); persist `epochkeys!` rows keyed by `epochTag`
  (B5); winner-select by `epochTag` + **re-validate winning wrap set vs committed
  revocations + chain a fresh rotation if it sealed to a revoked device** (B6);
  last-indexer precondition (B8, §3.6); reject-committed-revoked-signer rule for
  new ops (B12, §3.11); `saveVaultSecrets` persists the unwrapped key under its
  tag.
- Dispatcher mints fresh `epochKey_{N+1}`, computes `epochTag`, seals to
  survivors, appends REVOKE + ROTATE (§3.1–3.3).
- **Tests:**
  - **DECISIVE TEST — "a revoked device provably CANNOT decrypt content created
    after its revoke."** 3-device vault (A=admin, B, C) on a local
    `@hyperswarm/testnet`. A creates `n0` (epoch 0); all three converge and open
    `n0`. A revokes C (`DEVICE_REVOKE {C}` -> `KEY_ROTATE` to `epochTag_1`). A
    creates `n1` *after* the rotation. Drive convergence. **Assertions:** (1) B
    opens `n1` (its lockbox unwrapped `epochKey_1`); (2) C's engine has NO epoch-1
    key — `C.engine.epochKeys.has(epochTag_1) === false`; (3) reconstruct C's full
    retained key material (its `vaultKey` + every epoch key in its local blob) and
    attempt `crypto.openWithObjectId` on `n1`'s envelope with EACH key (and with
    the wrong-`epochTag` AAD) — **ALL throw `AEAD_FAIL`** (forward secrecy holds
    even against a C that tries every key it ever had); (4) `n1`'s header carries
    `epoch:"1"` and a non-empty `epochTag`; (5) C still opens `n0` (epoch 0 —
    forward, not retroactive); (6) **C's `keyId` for `n1` cannot be linked: re-seal
    `n0`'s object under `epochTag_1` and assert its `keyId` differs from the
    epoch-0 `keyId` C holds (B4)**. *This is the single test that proves the
    design; it must be green before merge.*
  - C's lockbox is absent from the `KEY_ROTATE` `wraps`; **and the wrap list is
    roster-blind** — assert C cannot enumerate survivor `deviceId`s from anything
    it can read (B10), and cannot open the body at all (B3).
  - C's writes after revoke are rejected (reducer + verifier C6); **backdated**
    write attempt (`lamport = revokedAtLamport-1`) is rejected once the revoke is
    committed (B12).
  - **Concurrent revoke of DIFFERENT devices:** two admins revoke X and Y
    concurrently; assert **NEITHER X nor Y holds the final `activeEpochTag` key**
    (B6), both survivors converge to the SAME `activeEpochTag` and SAME live key,
    **including when each survivor applied the two rotations in OPPOSITE order**
    (forces the Map-by-tag fix, B5).

### Phase 3 — Discovery-topic rotation + relay re-seed + replication firewall + follow-topic
**Files:** `pairing.js`, `index.js`, `relay-service.js`.
- Epoch-aware `vaultDiscoveryTopic` (§5.8); `joinVault` reconciles a topic SET
  (§5.10); `epoch-rotated` -> join new topic immediately, leave old after grace
  (default **0** for stolen-device, §4); **follow-topic default-on** (§4);
  **replication firewall** on the `connection` handler (§5.10, B2); **relay
  epoch-bound re-seed + unseed** (§5.11, B2).
- **Tests:** after rotation, survivors are joined on `topic_1`; the revoked device
  given only its retained keys derives `topic_0` but **provably cannot derive
  `topic_1`** (assert `topicSeed_1` is not reconstructible from C's keys — B3); an
  offline survivor that missed the rotation joins via its **follow-topic**,
  replicates the `KEY_ROTATE`, unwraps `epochKey_1`, joins `topic_1`
  (chicken/egg); multi-rotation walk-forward (N->N+1->N+2) using self-contained
  lockboxes; **replication firewall test: a revoked-device peer is REFUSED
  `store.replicate`** (B2); **relay test (ship-blocker open-q #2): after rotation
  the old discovery key is `unseed`ed and a peer seeded only on the old key gets
  nothing new** — and, honestly, a peer on a non-firewalled relay STILL replicates
  ciphertext it cannot decrypt (assert the residual L2 explicitly).

### Phase 4 — Pairing bootstrap: selective-chain-by-default + admit policy `[B1]`
**Files:** `autobase-sync.js` (`approvePairRequest`), `pairing.js`,
`vault-store.js`.
- Bootstrap carries **only the current `activeEpochTag` key** + `followSeed` +
  `activeEpoch`/`activeEpochTag` by default (§5.8); `grantHistory` flag for older
  keys; **admit-policy N-of-M co-sign** enforced on `DEVICE_ADD`.
- **Tests:** a freshly paired device reads post-rotation content but **NOT**
  pre-rotation content unless `grantHistory` was set (selective-chain default); a
  **re-paired previously-revoked device (fresh identity) gets ONLY the current
  key — it cannot read content created during its revoked interval** (the B1
  decisive pairing test); a lone self-admit is **rejected** under policy N=2;
  the "looks like a previously-revoked device" warning fires when box/sign pubkey
  matches a revoked record.

### Phase 5 — Durability reconciler (epoch-faithful) + tombstones + reorg interaction `[B4, B9]`
**Files:** `autobase-sync.js`, `materialized-view.js`.
- `_reconcileDurability` re-appends under the pending entry's **original
  `epochTag`** (B4); durable `tombstone!` honored by `_rowPresentFor` and the
  reducer (B9); suppress re-append for epoch ≤ revoked-epoch during the migration
  window.
- **Tests:** force a fresh-writer migration rollback after a rotation; the
  reconciler re-appends the orphaned row under its **original** epoch (NOT the new
  one) and a survivor opens it; **cross-device delete is NOT resurrected** by a
  remote reconciler (B9); a row re-appended after rotation **does not** acquire a
  linkable `keyId` (B4); a reorg that truncates the `KEY_ROTATE` tail recomputes
  identical epoch state (no key divergence, no wedge — B11).

### Phase 6 — Docs + honesty pass
**Files:** SECURITY.md §4.2, THREAT_MODEL.md §2.3, PAIRING.md §5,
`test/security/sec-auth.test.js`, VERIFIER_SPEC.md.
- Rewrite to the implemented guarantee (L8): forward-decrypt-only; **replication
  is NOT stopped where relays are not firewalled**; phrase compromise needs a new
  vault; correct the `removeWriter` "no-op" claim and the stale `sec-auth.test.js`
  assertion; add the grace/relay/phrase residuals (L2/L3/L4).
- **Tests:** a doc-lint asserting no doc still claims "bumps the content-key
  epoch" as the only effect, nor "revoked device cannot rejoin/obtain the bytes";
  the `removeWriter`-no-op test is removed or inverted.

### Ship-blocker open questions (must resolve BEFORE merge)
1. **(B8) Does Autobase 7.28.1 continue single-indexer linearization after a
   last-indexer `removeWriter` when the revoked device is OFFLINE?** Prove a 2→1
   last-indexer revoke still linearizes on a real testnet. If it cannot, rely on
   the rotation-independent-of-eviction path (§3.6) and the reject-committed-
   revoked-signer rule (§3.11). **Ship blocker.**
2. **(B2) Does `relay-service.js`/`p2p-hiverelay-client` `unseed` + `revocable`
   actually EVICT a named core/peer, or only stop fresh seeds?** The replication-
   firewall + epoch-bound-reseed story depends on real eviction. Prove on testnet
   that after `unseed(oldKey)` + re-seed under the epoch-bound key, a peer holding
   only the old core key receives no new blocks. **Ship blocker** (and if eviction
   is not real, document L2 as fully unmitigated for third-party relays).

### Non-blocking open questions
3. Verifier strictness: confirm the strict epoch-binding check (now that
   re-append is epoch-faithful, §3.9) rejects any row whose `header.epochTag` does
   not match the key the body decrypts under.
4. Grace-window default per vault and whether follow-topic-default-on materially
   helps metadata posture beyond L2 (it removes `topic_N` exposure but not the
   core-key channel).
5. Epoch-key chain pruning policy: never auto-prune (pruning makes old content
   unreadable even to survivors); expose only as an explicit destructive action
   tied to the cryptographic-erasure deletion model (SECURITY.md §4.4).
6. **(v2) Autobase core-identity rotation** as the real fix for L2 (deny
   replication at the root): new base + full log migration + re-seed only
   survivors. Scope and cost to be assessed separately.
7. **(v2) Per-epoch survivor box-keypair rotation** for post-compromise security
   against a leaked survivor box key (L5).
