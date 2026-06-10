# Device hygiene — phantom / stale device records

**Status:** 3 of 3 addressed (liveness surfacing + pairing-phantom cleanup + vault-switch storage reset). Fix A landed as **A2** (explicit reset on replacement, never a namespace change) covering `CREATE_VAULT`/`RESTORE_VAULT`; known residuals for both Fix A and Fix B are tracked in their sections below.

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
   them). → **FIXED (A2) — see Fix A.**

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

## FIXED (A2) — Fix A: vault-scoped storage isolation

**Goal:** a new/restored vault on an install can never surface a prior vault's
device records.

**Implemented as A2** (`backend/index.js` `maybeSwitchVaultStorage` +
`backend/vault-store.js` `resetReplicatedStorage`): on `CREATE_VAULT` /
`RESTORE_VAULT` where the new `vaultId` differs from the header's stored one,
the prior vault is locked, the sync engine torn down (waiting out the in-flight
close), and the Corestore is closed → reopened → `storage.clear()`ed before any
core opens — verified to wipe every core while named-core keys stay stable
(`corestore` caches cores past session close, and `hypercore` 11's
`core.purge()` is non-functional, so this is the only robust path). The
namespaces are untouched, so a vault that is NOT replaced keeps its committed
`writerKey` — no breaking migration. Vault-lifecycle commands are serialized
through one promise chain so a concurrent `UNLOCK_VAULT` cannot interleave into
a half-finished switch, and the new vault's id is stamped into the header
immediately after the wipe so a crash mid-switch stays detectable. Both
`CREATE_VAULT` and `RESTORE_VAULT` always record `vaultId` in the header
(merge-write), closing the restore-onto-fresh-install detection hole.
Regression-guarded by `test/integration/device-hygiene-vault-switch.test.js`.

**KNOWN RESIDUALS (reviewed, deliberate):**
- **`PAIR_ACCEPT` is a third vault-switch entry point** and does NOT reset
  storage: it adopts the inviter's `vaultId`/header directly, so a prior
  vault's cores survive that path (and the header overwrite makes the leak
  invisible to later switch detection). The fix must run BEFORE the pairing
  hello derives the joiner `writerKey` (the committed writer must match
  post-wipe storage) and needs same-vault re-pair semantics decided — do not
  bolt it on without that design.
- **`local-device.json` is not vault-scoped.** Restoring a DIFFERENT vault with
  the SAME non-empty passphrase resurrects the prior vault's device identity,
  epoch keys, and follow seed from the local blob (no `vaultId` check on the
  decrypted blob). Empty-passphrase installs are safe (the wrap secret is the
  mnemonic, which differs per vault).

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

**KNOWN CAVEATS (code review, 2026-06-11 — confirmed against the committed
code, follow-ups for this fix):**
- **Locking the vault during the window suppresses the cleanup.** The confirm
  loop reads `engine.devices` — which `engine.close()` clears on every lock —
  and treats an absent device as "confirmed", emitting a spurious
  `pair-join-confirmed` and never revoking. The loop needs an
  `engine._opened` guard distinguishing "engine closed" from "device gone".
- **No durable re-arm.** The confirm task is in-memory only; quit/restart
  inside the window leaves the phantom permanently authorized. The pending
  confirmation should be persisted (or re-derived from committed state) and
  re-armed at engine open.
- **The no-rotation premise fails for bootstrap-holding joiners.** The sealed
  bootstrap (vaultKey + active epoch key + autobaseKey) is delivered BEFORE the
  window starts, so a joiner that received it and then went silent is revoked
  WITHOUT rotation while holding the current epoch key — and third-party relays
  serve post-revoke ciphertext (the documented L2 residual). The premise
  "pulled zero ciphertext" only holds for joiners that never got the bootstrap.
- **`_writerHasNode` has no baseline.** Any pre-existing writer-core history
  (e.g. a revoked device re-pairing from the same install, which presents the
  same deterministic `writerKey`) counts as a fresh join confirmation; capture
  the core length at approve time and confirm only on growth.

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
