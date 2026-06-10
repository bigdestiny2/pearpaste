# Device hygiene — phantom / stale device records

**Status:** 2 of 3 fixed (liveness surfacing + pairing-phantom cleanup). The remaining root-cause fix (Fix A) stays deferred because it is a breaking storage migration that must be designed for, not rushed into the append-only multi-writer core.

**Reported:** a Devices list showing several "Sealed — tap to decrypt" records plus a revoked device, after repeated vault creation + abandoned pairing attempts on one install — read as "random devices connected."

---

## Diagnosis (what's actually happening)

All launches of the production link share **one** per-link storage dir
(`app-storage/by-dkey/<dkey>/`): one corestore, one `local-device.json`, one
`vault-header`. Three distinct effects stack up:

1. **Liveness was never surfaced.** `DEVICE_LIST` returned every *authorized*
   device record with no indication of whether a peer is actually connected. An
   authorized-but-never-connected device looks identical to a live one. → **FIXED**
   (see below).

2. **Pairing phantoms.** `approvePairRequest` (`backend/autobase-sync.js`)
   commits `_appendDeviceAdd` the instant the user clicks **Approve**, then
   delivers the sealed bootstrap. If the joiner never completes (disconnect,
   abandon, crash), the device is permanently authorized but never connects. →
   **FIXED — see Fix B.**

3. **Stale cross-vault records.** Re-creating/restoring a vault on an install
   that already had one can leave device records from a prior vault key visible
   as unresolvable `{ sealed: true }` rows (the current vault key can't open
   them). → **DEFERRED — see Fix A.**

Confirmed NOT a confidentiality breach: vaults are isolated by a per-vault
autobase key, a vault-key-derived discovery topic, and the signed replication
firewall. The records decrypt (or fail to) under *this install's* keys — never a
remote party's.

---

## FIXED — liveness in `DEVICE_LIST`

`DEVICE_LIST` now joins each record against
`ctx.replicationFirewall.authenticatedPeers()` (the set of deviceIds with a
*currently authenticated* replication stream) and the local device id, returning
`self` and `connected` per device. The UI can now show "added but never
connected" vs a live peer, which is the literal "phantom connected devices"
confusion. Read-only, additive; regression-guarded by a unit test in
`test/unit/sync-reducer.test.js` ("DEVICE_LIST reports liveness…").

Recommended UI follow-up: render `connected` (e.g. a dot), label
`!connected && !self` devices as "never connected," and offer an explicit
**Remove** action (which is a user-initiated `DEVICE_REVOKE`).

---

## DEFERRED — Fix A: vault-scoped storage isolation

**Goal:** a new/restored vault on an install can never surface a prior vault's
device records.

**Why not a one-line namespace change.** The obvious fix —
`namespace(NAMESPACES.AUTOBASE + ':' + vaultId)` — also changes the *derived
writer keypair* for the device (corestore namespaces seed keypairs). That
invalidates the `writerKey` already committed in every existing device record,
so existing paired vaults would lose write access. It is a **breaking storage
migration**, not a refactor.

**Safe approaches (pick one, with a migration):**
- **A1 — vaultId-scoped namespace + migration.** Scope autobase + search by
  vaultId; on upgrade, migrate the existing single vault's cores into its
  vaultId namespace (or accept a forced re-pair for pre-beta installs, since
  data is throwaway). Strongest isolation.
- **A2 — explicit reset on vault replacement.** On `CREATE_VAULT`/`RESTORE_VAULT`
  where the new `vaultId` differs from the stored one, tear down and delete the
  prior autobase + search storage before opening the new base. Smaller blast
  radius; needs a clean corestore-namespace deletion path.

**Acceptance:** create vault A, add a device, create vault B on the same
install → `DEVICE_LIST` for B returns exactly B's genesis device; zero
`{ sealed: true }` rows; A's cores are gone from disk.

---

## FIXED — Fix B: pairing-phantom cleanup

Implemented in `backend/autobase-sync.js` exactly along the join-confirmation
path below, with one deliberate deviation forced by the multi-writer core:

- **Joiner half (PAIR_ACCEPT).** After opening the bootstrap, persisting keys,
  and bringing the engine up, the joiner spawns a scoped task that waits for its
  writer seat to linearize, appends its **genesis-tail `DEVICE_ADD`** (an
  idempotent self-confirmation — a new `_applyDeviceAdd` branch accepts a
  present, non-revoked device re-asserting its own already-committed record
  silently, so it mutates nothing but makes the joiner's writer core produce a
  node), then sends `pp-pair-joined { deviceId, confirmation }` back on the
  pairing conn.
- **Inviter half (`approvePairRequest`).** Returns success immediately, then
  spawns a `ctx.scope` confirm task (`spawnJoinConfirm`) that confirms via
  **either** the `pp-pair-joined` ack (a fresh data listener with its own
  buffer, so the earlier hello frame can't corrupt parsing) **or**
  `_writerHasNode(writerKey)` (the joiner's writer produced a node — conn
  independent). Only if **neither** appears within `engine.pairJoinConfirmMs`
  (default 15 min; overridable, e.g. tests use ~1 s) does it append a
  compensating revoke via `revokePhantomDevice`.
- **Deviation — the compensating revoke does NOT rotate the epoch key.** A
  phantom was admitted as an *indexer* writer that never connected, so its
  writer core never replicated; appending the usual `KEY_ROTATE` drives an
  indexer-set advance that can never checkpoint against that permanently-offline
  indexer and the linearizer interrupts the base (the GATE SB1 freeze —
  reproduced directly while building this fix). A *plain* `DEVICE_REVOKE`
  linearizes cleanly. Rotation's forward-secrecy is moot here regardless: a
  phantom never established replication, so it pulled zero ciphertext, and once
  the revoke commits the B12 reject-committed-revoked gate denies its writes
  while the replication firewall (SB2) refuses it any future stream — it can
  never obtain content sealed under the current key, held or not.

Regression-guarded by `test/integration/pairing-phantom.test.js` (both
acceptance cases, configurable short window); the happy-path approval flow in
`test/security/sec-pairing.test.js` passes unchanged (the generous default
window never fires within a test's lifetime).

---

## DESIGN — Fix B: pairing-phantom cleanup

**Goal:** an approval whose peer never finishes joining does not leave a
permanently-authorized device.

**Why not a naive auto-revoke.** You must authorize the writer (`DEVICE_ADD`)
*before* it can join, and the only way to un-authorize is `DEVICE_REVOKE`, which
triggers a **disruptive epoch key rotation**. An over-eager timeout (e.g. ack
lost on a slow but legitimate join) would revoke a real device and rotate keys —
strictly worse than a phantom.

**Safe approach — join-confirmation with a conservative compensating revoke:**
1. Joiner, after successfully opening the bootstrap *and* writing its
   genesis-tail `DEVICE_ADD` (so it is a live writer), sends `pp-pair-joined`
   `{ deviceId, confirmation }` back to the inviter.
2. `approvePairRequest` returns success immediately (responsive UX) but spawns a
   scoped task that confirms via **either** the `pp-pair-joined` ack **or**
   observing the new `writerKey` produce a node in the base.
3. Only if **neither** signal appears within a generous window (and the device
   never became a live writer) does it append a compensating `DEVICE_REVOKE`.
   Bias hard toward *not* revoking: a phantom is cheap, a wrongful revoke is not.

**Acceptance:** approve a pairing whose joiner is killed before it joins →
after the window, the device is revoked and no longer listed as active; approve
a pairing whose joiner is merely slow → the device is **never** revoked.

Tests must use a configurable (short) window; the happy-path networked pairing
test must still pass unchanged.
