# Paste Verifier Specification

A formal, implementation-independent specification of what
`scripts/verify-encryption.js` (the standalone CLI) and `backend/verifier.js`
(the in-app proof) check, the exact pass/fail rules, and — stated plainly —
what they do **not** prove. This document is sufficient to build an
**independent** verifier from scratch with no Paste code (spec §17 "at
least one independent storage verifier implementation if feasible", §21).

Spec references: §4 (security promise), §8.2 (envelope), §8.4 (provably
encrypted), §16 (security tests), §17 (supply-chain). Companions:
SECURITY.md, RELAY_CUSTODY.md, THREAT_MODEL.md.

---

## 1. Scope

The verifier answers one question with evidence: **does any user plaintext
exist outside the in-memory/clipboard/explicit-export surfaces, and is every
stored content value real AEAD ciphertext signed by an authorized device?**

It is **structural and assumption-free first**: the load-bearing check is a
raw byte scan of the storage tree. Parsing Hyperbee/Hypercore is a secondary,
best-effort corroboration. The verifier never needs vault keys, never touches
the network, and never decrypts user content for the report.

Inputs:

- `storagePath` — a Paste Corestore storage directory.
- optional `--log <file>` — an app log file to also scan.
- (in-app) the live device set + relay status, if available.

Output: a deterministic report (lines + booleans + counts) and a process exit
code. **Exit code is non-zero iff any check below fails.** CI and the release
gate depend solely on this exit code.

---

## 2. Definitions (normative)

### 2.1 Plaintext sentinel

`SENTINEL_PREFIX = "PEARPASTE_PLAINTEXT_SENTINEL_"` (ASCII). Any occurrence of
this exact substring in scanned bytes is a hard failure. Security tests write
notes/clips whose title/body/tags embed `SENTINEL_PREFIX + random`; a correct
implementation seals them so the prefix never appears at rest.

### 2.2 CryptoEnvelope (spec §8.2)

A JSON object is a structurally valid envelope iff **all** hold:

- `v === 1`
- `alg === "XCHACHA20-POLY1305"`
- `keyId` is a non-empty string
- `nonce` is a non-empty string
- `aad` is an object with string `aad.vaultId` and string `aad.objectBlindId`
- `ciphertext` is a non-empty string

### 2.3 "Looks encrypted" (anti-smuggling)

An envelope's `ciphertext` is AEAD-shaped iff **all** hold:

- it is even-length lowercase/uppercase hex
- decoded length ≥ 16 bytes (one AEAD tag)
- the decoded bytes, interpreted as UTF-8, do **not** contain the sentinel
- the decoded bytes do **not** parse as JSON (i.e. plaintext was not stored
  in the clear and merely labeled `ciphertext`)

This catches the "bad record" attack: a value that claims to be an envelope
but whose `ciphertext` is actually readable plaintext or the sentinel.

### 2.4 Content-free exceptions

These stored values are **expected not** to be envelopes and are skipped:

- the vault header at key `header` in the `pearpaste:meta` namespace
  (content-free public metadata per spec §7.1).

Any other non-envelope value that contains the sentinel **or** carries a
user-content-shaped key (`/^(body|title|text|note|clip|plaintext)$/i`) is a
failure.

---

## 3. Checks (the exact pass/fail rules)

A conformant verifier MUST implement all of these. Each maps to a proof line.

### C1 — Storage byte scan (assumption-free; load-bearing)

Recursively walk every file under `storagePath` (skip `.git`, `node_modules`).
Read each file's raw bytes (cap very large files at a fixed bound, e.g. 64
MiB). **FAIL** if the sentinel substring appears in any file.
Proof line: `Storage scan: no plaintext found.` / `... FAILED ...`.

### C2 — Structural envelope check (best-effort corroboration)

Open the Corestore read-only; for known namespaces
(`pearpaste:views|search|autobase|meta`) and well-known core names
(`view, notes, clips, devices, index, autobase, vault-header`), open each as a
JSON Hyperbee and enumerate values. For each value (excluding the §2.4
exceptions): **FAIL** if it is not a valid CryptoEnvelope **and** it contains
the sentinel or a user-content-shaped key; **FAIL** if it is an envelope but
not AEAD-shaped (§2.3). If Corestore/Hyperbee cannot be opened, this check is
**skipped** (not failed) — C1 is the assumption-free backstop.
Proof line: `Local encryption: passed.` / `... FAILED — ...`.

### C3 — Relay-export scan

If `<storagePath>/relay-exports/` exists, byte-scan it exactly as C1. Every
payload Paste hands (or would hand) a relay is mirrored there. **FAIL** on
any sentinel. Absence of the directory is **not** a failure (local-first /
relay-disabled).
Proof line: `Relay payload scan: no plaintext found.` / `... FAILED ...`.

### C4 — Log scan

If a log file is provided (CLI `--log`, or in-app `PEARPASTE_LOG_FILE`),
byte-scan it. **FAIL** on any sentinel. No log file → reported as 0 scanned,
not a failure.
Proof line: `Log scan: no plaintext found.` / `... FAILED ...`.

### C5 — Operation signatures (in-app / when an op list is available)

For each replicated op record visible to the verifier: the header must carry
**only** public fields (`version, opId, vaultId, deviceId, type,
objectBlindId, lamport, createdAtBucket`, and the optional epoch ride-along
`epoch, epochTag`); the body must be a valid AEAD envelope; the op must be
signed; the signer must be in the active device set; the Ed25519 signature over
`canonical(header || ciphertext || nonce || aadHash)` must verify. **FAIL**
counts any bad/unsigned/unknown-signer op. If no op list is exposed, report
`0 checked` — **never fabricate a pass**.
Proof line: `Operation signatures: N checked, all valid ...`.

`epoch` (a small monotone ordering counter) and `epochTag` (an opaque
content-addressing hash) are **public-only** ride-along fields on `KEY_ROTATE`
and on post-rotation content ops (design §5.5). They leak only that a rotation
count exists — never content, identity, or roster — and are validated exactly
like the other public fields by the shared classifier. Legacy / epoch-0 ops
omit both (epoch 0 ≡ `epochTag === ""`), so a pre-change envelope's keyId and
AEAD AAD are byte-identical to before this change and verify unchanged.

### C6 — Revoked-device rejection (STRICT epoch-binding)

A signature from a device revoked at or before an op's epoch
(`lamport >= revokedEpoch`) that was nonetheless **accepted** is a leak.
**FAIL** if any such accepted op exists.
Proof line: `Revoked-device check: revoked signatures rejected ...`.

Epoch-binding is **strict**: there is no "tolerate a `header.epoch` newer than
the row's creation epoch" relaxation (an earlier draft contemplated one; the
locked design drops it because re-append is epoch-faithful — design §3.9). The
content key itself enforces the binding cryptographically: an op's `epochTag`
selects the item key, and `epochTag` is folded into both the epoch-bound `keyId`
(`hash("keyid:" + epochTag + ":" + objectId)`, with the `epochTag === ""`
legacy special case) and the AEAD AAD. A ciphertext authored under one epoch
therefore **cannot** be opened under a different epoch's key — a wrong-epoch
decrypt fails closed (AEAD failure), and the same object under two epochs
carries two distinct `keyId`s, so it is unlinkable to a party lacking the epoch
key. The verifier need not hold any epoch key to rely on this: it is a property
of the seal, asserted by the Phase-0 crypto unit tests.

### C7 — Relay custody binding (when relay receipts exist)

If custody receipts are present, the relay's reported ciphertext root MUST
equal our ciphertext root. A mismatch (`receiptsMatchRoot === false`) **FAILS**
the custody line. No receipts → reported as local-first, not a failure.
Proof line: `Relay custody: M relay(s) accepted ciphertext root <hash>.` /
`... FAILED — receipts did not match ...`.

### Overall result

The standalone CLI exits **non-zero** iff: C1 has hits, **or** C3 has hits,
**or** C4 has hits, **or** C2 ran and failed. The in-app `passed` boolean is
the AND of C1–C7 (with C5/C6/C7 vacuously true when no data is available).
The required limit line (§5) is always emitted regardless of pass/fail.

---

## 4. Independent implementation guide

A minimal independent verifier needs **no Paste code** and can be written
in any language. Sufficient algorithm:

1. Recursively read every file under `storagePath` as bytes; fail if any
   contains the ASCII string `PEARPASTE_PLAINTEXT_SENTINEL_` (this alone is
   the strongest, assumption-free check — it is C1 + C3 + C4).
2. (Optional, stronger) Use a Hypercore/Hyperbee reader for the platform to
   enumerate stored values and apply the §2.2/§2.3 envelope rules and the
   §2.4 exceptions; fail on a non-envelope content-shaped value or a
   non-AEAD-shaped envelope.
3. (Optional, with the active device pubkey set) Re-derive the signing
   preimage `canonical({header, ciphertext, nonce, aadHash})` (RFC-8785-style
   deterministic JSON: object keys sorted recursively, standard JSON scalar
   encoding) and Ed25519-verify each op; apply the revoked-epoch rule (C6).
4. Exit non-zero on any failure.

Canonicalization, for cross-implementation signature agreement: arrays in
order; object keys sorted ascending by code unit; strings/numbers/booleans/
null encoded as standard JSON; no insignificant whitespace. (This matches
`backend/crypto-envelope.js canonicalize()`.) AEAD is
XChaCha20-Poly1305-IETF; the per-item key is
`HKDF(epochKey, "item:"+objectId)` with keyed-BLAKE2b as the HKDF PRF, where
`epochKey` is the selected epoch's content key (epoch 0 ≡ the per-vault
`vaultKey`, `epochTag === ""`; higher epochs use a fresh-random key sealed only
to surviving devices) — but note an independent verifier does **not** need keys
for C1–C4, which are the load-bearing privacy checks.

A reference independent verifier exists in-tree: `scripts/verify-encryption.js`
deliberately performs C1/C3/C4 with a self-contained byte scan and only
*optionally* uses Corestore for C2, so it still produces a meaningful verdict
even if the Hyperbee internals change.

---

## 5. What the verifier explicitly does NOT prove

Stated plainly; this wording is mirrored on the proof screen and must never be
softened (spec §4, §8.4, §2 non-goals):

- **It does not prove physical deletion from third-party disks.** It scans
  *this* storage path and *this* relay-export mirror at *this* moment. A relay
  operator may have snapshotted ciphertext earlier. Paste's deletion model
  is cryptographic erasure (destroy keys → ciphertext undecryptable), not
  provable remote deletion. The line *"Limit: this does not prove physical
  deletion from third-party disks."* is always emitted.
- **It does not prove confidentiality against a future cryptanalytic break**
  of XChaCha20-Poly1305 / Argon2id / BLAKE2b / Ed25519. It proves data is
  *encrypted with those primitives*, not that they are unbreakable forever.
- **It does not prove the key derivation chain is sound** — it does not
  re-derive `vaultKey` from a phrase or check Argon2id parameters; that is
  covered by unit tests, not the verifier.
- **It does not detect a key-exfiltration backdoor** that preserves the
  envelope shape (e.g. a tampered build that correctly seals data but also
  leaks keys via a covert channel). The defense for that is the supply-chain
  controls — committed lockfile, dependency audit, reproducible builds,
  external review, signed releases (RELEASE.md §5/§7), not the sentinel scan.
- **It does not prove anonymity or absence of metadata leakage.** It says
  nothing about IPs, timing, sizes, or that a vault exists. Paste must not
  claim "no metadata leakage" / "anonymous" (THREAT_MODEL.md §2.1/§2.2).
- **It does not prove availability.** A passing scan says nothing about
  whether relays will keep serving (RELAY_CUSTODY.md §6).
- **It does not prove the in-memory / OS-clipboard / explicit-export
  surfaces are leak-free** by themselves — those are *allowed* plaintext
  locations (spec §8.3). The clearing of selected-item plaintext on
  close/background/timeout/lock is proven by `test/security/sec-access.test.js`,
  not by this scan.
- **Absence of content is not proof of correctness.** An empty store trivially
  has no sentinel. The security tests therefore *write* sentinel-laden content
  first, then scan — a conformant verifier should be exercised the same way
  (the CI `sentinel-guard` job does exactly this).

A green verifier means: *no known-plaintext marker is at rest in the scanned
locations and all inspected stored content is AEAD ciphertext signed by an
authorized device, right now, on this machine.* It is necessary evidence for
the §4 promise — not a universal proof of security.
