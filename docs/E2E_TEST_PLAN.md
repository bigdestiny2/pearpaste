# PearPaste End-to-End Test Plan (All Devices)

Status: 2026-06-08. Operationalizes [TESTING_MATRIX.md](./TESTING_MATRIX.md) into concrete,
runnable end-to-end (E2E) scenarios across every supported device.

This document does **not** restate the automated gate table — that lives in
[TESTING_MATRIX.md](./TESTING_MATRIX.md) (`Gates` and `Platform Matrix`). Treat the matrix as
the source of truth for *which command proves what*; treat this plan as the source of truth for
*how a human or CI driver actually exercises a full vault across real devices*. Where a scenario
maps to an existing gate, that gate is named inline (e.g. "extends `test:e2e`").

Several scenarios below are written specifically to cover correctness/safety defects called out
in the 2026-06 review digest that **no current automated test reaches** — most importantly that
no test today wires *two real Autobase instances and replicates between them*. Those are flagged
`[GAP]` so the maintainer knows they are net-new coverage, not a re-run of green tests.

---

## 0. How to read this plan

- **Device set tags** appear on every scenario: `DESKTOP`, `MOBILE`, `MULTI` (≥2 physical devices
  + 1 desktop), `RELAY`, `ALL`.
- **Mode**: `AUTO` (scriptable headless / CI), `SEMI` (script drives backend, human confirms one
  UI step), `MANUAL` (requires a real GUI / OS clipboard / camera / signed build).
- **Pass/fail** criteria are explicit and observable. "Converge" always means: after
  `base.update()` settles on every node, `NOTE_LIST` / `CLIP_LIST` / `DEVICE_LIST` return byte-
  identical sealed metadata and identical decrypted plaintext on every node, with no error.
- True multi-writer behavior (concurrent edits, merge, revoke) **cannot** be proven on one
  machine. Those scenarios require **at least 2 physical devices + 1 desktop** on the same
  private testnet. Single-machine multi-instance runs (two `createPearEnd` over a
  `@hyperswarm/testnet` bootstrap) are an acceptable *automatable proxy* and are marked
  `AUTO [GAP]`; they do not replace the physical-device gate.

---

## 1. Device matrix

| # | Device / shell | Min OS | Build/runtime | Role in multi-writer tests | Notes |
|---|---|---|---|---|---|
| D1 | macOS desktop (Apple Silicon) | macOS 13 Ventura+ | `pear run --dev .`; release = `pear run pear://<key>` | Primary desktop writer | Maintainer reference: **M3 Ultra Mac Studio (arm64)**. Signed/notarized `.app` is a release gate, see §10. |
| D2 | Windows desktop | Windows 10 64-bit+ | `pear run`; wrapper via `npm run build:win` | Second desktop writer (soak) | Authenticode + SmartScreen gate, §10. |
| D3 | Linux desktop | glibc 2.31+ (Ubuntu 20.04+) | `pear run`; AppImage/.deb/.rpm via `npm run build:linux` | Second desktop writer (soak) | Clipboard backend (X11/Wayland) is the platform risk. |
| M1 | iOS — **PearPasteMobile** (RN-CLI) | iOS 15.1+ | Xcode 26.x, `react-native-bare-kit@0.14.0` | Physical writer #1 | `min_ios_version_supported`. **See variant caveat below.** |
| M2 | iOS — **pearpaste-expo** (Expo) | iOS 15.1+ (`ios.deploymentTarget 15.1`) | Expo SDK / `react-native-bare-kit@^0.13.3` | Physical writer #1 (alt) | Canonical UI variant. **iOS bare-link hook + bundle-regen are release blockers, §10.** |
| M3 | Android — **PearPasteMobile** (RN-CLI) | Android 10 (API 29, `minSdkVersion=29`) | Gradle `:app:assembleDebug` | Physical writer #2 | Build-verified shell. |
| M4 | Android — **pearpaste-expo** (Expo) | Android 10 (API 29, `minSdkVersion=29`) | Expo prebuild + Gradle | Physical writer #2 (alt) | Canonical UI variant; needs Expo bundle-regen, §10. |

**Mobile variant caveat (from digest — must be settled before mobile release sign-off):** the
shared `mobile/app/` statically imports Expo modules (`expo-camera`, `expo-linear-gradient`), so
as committed **only pearpaste-expo (M2/M4) can render the current UI**; PearPasteMobile (M1/M3)
redboxes at module load. Conversely PearPasteMobile is the only **build-verified** shell, and the
Expo iOS Podfile currently lacks the Pear-end bare-link hook (sodium/udx/rocksdb), so the Expo iOS
worklet links JS but crashes loading native addons. **Run the full mobile scenario set against
whichever variant is declared canonical, and run at minimum the boot + pairing + plaintext-clear
subset against the other** to keep the second shell honest. Note both shells share the SAME backend
(`mobile/backend/worklet.mjs` imports desktop `backend/index.js`), so crypto/sync parity is
structural — divergence risk is in the shell, not the core.

**Multi-writer reality check:** scenarios tagged `MULTI` need a minimum bench of **D1 (desktop) +
M-iOS (one physical phone) + M-Android (one physical phone)**. Two of those three must perform
*concurrent* writes for the Autobase-merge and revoke scenarios to mean anything.

---

## 2. Preconditions & tooling

### 2.1 Repo + runtime
- Node 22 (matches CI and `docs/RELEASE.md`; `engines.node` says `>=20` but only 22 is tested).
- `npm ci` at repo root (runs `postinstall: patch-package` — the device-file / fs-native-extensions
  patches are Android-critical and only land via the **root** install; mobile bare-link pulls from
  root `node_modules`).
- `pear` CLI installed for any desktop GUI scenario (`npm i -g pear` / Holepunch instructions).

### 2.2 Private Hyperswarm testnet (`@hyperswarm/testnet`)
A hermetic DHT so device discovery never touches the public network and runs are deterministic.
Pattern already used by `test/integration/_relay-harness.js`:

```js
import createTestnet from '@hyperswarm/testnet'
const testnet = await createTestnet(3)          // 3 bootstrap nodes
// pass testnet.bootstrap to every node under test:
const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
const pearEnd = await createPearEnd({ storagePath: dir, swarm })  // inject the testnet swarm
// ... at teardown:
await testnet.destroy()
```

`createPearEnd({ storagePath, swarm })` accepts an injected swarm (`backend/index.js:67`), which is
the seam that lets two in-process instances meet on the testnet without the public DHT. For
**physical** devices that cannot share an in-process testnet object, stand up the bootstrap on a
LAN-reachable host and point each device's swarm at it (or run the public DHT on an isolated test
vault — acceptable for `MULTI` scenarios, slower and less deterministic).

### 2.3 Test HiveRelay + helpers
- **Hermetic relay (CI / AUTO):** use the in-process fake from `test/integration/_relay-harness.js`
  (`startFakeRelay`, `makeFakeRelayClientFactory`) — implements the HTTP custody surface
  (`/api/custody/intent`, `/status`, `/commit`) and a captured seed path on **real ciphertext
  bytes**, injected via `createPearEnd({ relayClientFactory })`. This is what proves blindness
  without a live fleet.
- **Live relay (SEMI / MANUAL):** point at a real test fleet two ways —
  - `PEARPASTE_RELAYS="wss://host=<64hex-pubkey>,..."` env (WSS-bridge pinning, highest-priority
    config layer), or
  - `<storagePath>/fleet-relays.json` (`config/fleet-relays.example.json` shape:
    `foundationPubkeys[]`, `knownRelays{}`, `bootstrap[]`).
  - With **empty** config the client falls back to pure HyperDHT auto-discovery (verified to reach
    a live 8-relay fleet in the digest). Leave config empty to test the default path.
- **`scripts/probe-circuit.mjs`** — one-shot: does the reachable fleet advertise the **circuit**
  channel (`hasCircuitProtocol`) that `connectViaRelay` (pairing-rendezvous fallback) needs? Run
  this **before** any MITM/pairing-over-relay scenario. `WAIT_MS` env tunes the discovery window.
  Exits 0 always; the printed verdict (`ADVERTISED` / `PARTIAL` / `NOT advertised`) is the result.
- **`scripts/pin-on-hiverelay.js`** — seed a public key (the already-encrypted vault op-log) on the
  fleet: `node scripts/pin-on-hiverelay.js --key <64hex> --replicas N [--json]`. Used to stage the
  store-and-forward scenarios (§3, S9) and to confirm relays receive **ciphertext only** (`--app`
  mode is for the public app package, not vault content). `acceptances/replicas` is the success
  signal; exit 5 = no relay accepted.

### 2.4 Blind-storage verifier (`scripts/verify-encryption.js`)
Independent, no-keys byte scan + structural envelope check of a storage tree:

```
node scripts/verify-encryption.js <storagePath> [--json] [--log <logfile>]
```

- Exit **0 = PASS** (no plaintext sentinel anywhere; every parseable Hyperbee value is an AEAD
  `CryptoEnvelope` that actually looks encrypted), **1 = FAIL/leak**, 2 = bad args, 3 = crash.
- It scans: the whole storage tree, the `relay-exports/` mirror (what relay-service handed relays),
  and (only with `--log`) a log file. **The log scan is a no-op unless `--log` is passed** — pass
  it explicitly in any scenario that asserts logs are clean.
- The plaintext sentinel is `PEARPASTE_PLAINTEXT_SENTINEL_` (`backend/shared-ops.js`,
  `SENTINEL_PREFIX`). **Every scenario seeds note/clip bodies with this prefix** so the verifier (and
  the `relay-exports` scan) can prove the body never landed at rest. Example body:
  `PEARPASTE_PLAINTEXT_SENTINEL_S5_BODY`.
- `npm run verify` is the same script; `npm run inspect` (`scripts/inspect-store.js`) is a
  human-readable store dump for debugging a failed assertion.

### 2.5 Wiping vault storage between runs
Storage location per device — **delete the whole directory between independent runs** (a stale
Corestore/Autobase will cross-contaminate convergence assertions):

| Device | Storage path | Wipe command |
|---|---|---|
| Desktop dev/test | `$PEARPASTE_STORAGE` else `~/.pearpaste-dev/store` (`index.js resolveStoragePath`) | `rm -rf "${PEARPASTE_STORAGE:-$HOME/.pearpaste-dev/store}"` |
| Desktop (Pear runtime) | `Pear.config.storage` (per-app sandbox dir) | `pear data` to locate; remove that app's storage dir |
| AUTO harness | `fs.mkdtempSync(os.tmpdir()+'/pp-e2e-…')` per test | `fs.rmSync(dir,{recursive:true,force:true})` in `t.teardown` |
| iOS | app `DocumentDirectoryPath` (RNFS) | Delete & reinstall the app, or Simulator → Erase All Content |
| Android | app document dir (RNFS) | `adb shell pm clear <appId>`, or uninstall/reinstall |

**Discipline:** every scenario starts from a wiped store unless it explicitly says "reuse the store
from S#" (e.g. recovery/restore, relay-on-wake). Set a per-run `PEARPASTE_STORAGE` per device so
parallel devices never share a path.

### 2.6 Standard harness skeleton (AUTO)
The existing `test/e2e/desktop-vault.test.js` is the template: boot `createPearEnd({storagePath})`,
wrap with the `recordingBridge` that **fails the test if any bridge response ever contains key
material** (`SECRET_KEY_RE`), drive `{id, command, params}`. New multi-instance scenarios add a
second `createPearEnd` sharing `testnet.bootstrap`. Keep the secret-scan proxy on **every** node.

---

## 3. E2E scenarios

> Convention: each step is an RPC command (`COMMAND { params }`) or a UI/OS action. Commands and
> their schemas are in `backend/rpc.js`. The bridge envelope is `{id, command, params}` →
> `{id, ok|error, result}`.

### S1 — Vault create + lock/unlock `[DESKTOP] [MOBILE] AUTO` (extends `test:e2e`)
**Goal:** a fresh vault is creatable, the recovery phrase is shown exactly once, lock clears
plaintext, unlock restores access.
**Steps:**
1. Wipe store. `CREATE_VAULT { label, platform, passphrase }`.
2. `NOTE_UPSERT { note:{ label:'n1', body:'PEARPASTE_PLAINTEXT_SENTINEL_S1' } }` → capture `noteId`.
3. `NOTE_OPEN { noteId }` → body returned in plaintext.
4. `LOCK_VAULT`.
5. `NOTE_OPEN { noteId }` again, and any content command.
6. `UNLOCK_VAULT { passphrase }`; `NOTE_OPEN { noteId }`.
7. `node scripts/verify-encryption.js <store> --log <worker.log>`.
**Pass:** (1) `CREATE_VAULT` returns a 24-word `mnemonic` **exactly once** (assert via recording
bridge counter); (2) no other response ever contains `mnemonic`/key material; (3) step 5 returns
`VAULT_LOCKED`; (4) step 6 returns the same plaintext as step 3; (5) verifier exits 0.
**Fail:** mnemonic appears twice or in any non-`CREATE_VAULT` response; step 5 returns plaintext;
verifier exits non-zero.

### S2 — BIP39 recovery/restore onto a **fresh** device `[DESKTOP] [MOBILE] AUTO + MANUAL`
**Goal:** the 24-word phrase reconstructs the vault on a clean install with no surviving device.
**Steps:**
1. From S1, record the `mnemonic`. Create ≥2 notes (sentinel bodies). Note their plaintext.
2. **Fresh** node, **separate wiped store**. `RESTORE_VAULT { mnemonic, passphrase }`.
3. Unlock if required; `NOTE_LIST`; `NOTE_OPEN` each.
4. Repeat step 2 with `RESTORE_VAULT { mnemonic, passphrase, highSecurity:true }`.
5. **MANUAL (mobile):** install the app fresh on a wiped phone, enter the 24 words, confirm notes
   appear after sync.
**Pass:** restored device derives the same `vaultId` and decrypts the original note bodies; the
high-security restore (step 4) **does not persist keys to the local-device blob** and requires
unlock each launch (per `RECOVERY_DESIGN.md` / sec-local-auth).
**Fail:** restore yields an empty/different vault, or wrong plaintext, or high-security mode writes
a persistent local-device secret.
**`[GAP]` note:** the digest open-question — does a from-mnemonic restore on a brand-new device
*self-root a new genesis* (different `rootPubkey`) and fork the device set until logs merge? **Add
an explicit assertion:** after step 2, bring the original device online on the testnet and confirm
`DEVICE_LIST` converges to a single consistent device set (no permanent fork). If it forks, that is
a **FAIL** to be filed against `backend/autobase-sync.js` genesis-root resolution.

### S3 — Pairing via QR, desktop↔mobile and mobile↔mobile `[MULTI] SEMI`
**Goal:** a new device joins an existing vault via QR invite + 6-digit confirmation; expired invites
and MITM are rejected.
**Pre:** run `scripts/probe-circuit.mjs` first if pairing must traverse a relay circuit.
**Steps (happy path, desktop↔mobile):**
1. Inviter (D1): `PAIR_CREATE_INVITE { ttlMs }` (default 5 min) → render invite blob as QR +
   8-char short code.
2. Joiner (M-phone): scan QR (camera) **or** type the short code → `PAIR_LOOKUP_SHORTCODE` then
   `PAIR_ACCEPT { invite, label, platform, unlockSecret }`.
3. Both screens display a **6-digit confirmation phrase**. Human compares; if equal, inviter
   `PAIR_APPROVE { requestId }`.
4. Joiner receives sealed bootstrap, unlocks, `NOTE_LIST` converges with the inviter.
5. Repeat for **mobile↔mobile** (M-iOS invites M-Android).
**Invite-expiry sub-test `AUTO`:** `PAIR_CREATE_INVITE { ttlMs: 1 }`; wait >1ms; `PAIR_ACCEPT` →
must fast-fail `PAIRING_EXPIRED` (<5s, before any DHT work). Also assert a stale short code returns
`SHORTCODE_NOT_FOUND`.
**MITM-reject sub-test `SEMI`:** simulate a relay/peer forwarding the hello but substituting its own
`boxPubkey` → the two confirmation phrases **must differ**; the human (or test harness comparing the
two returned phrases) **must reject** and the joiner must NOT receive vault keys.
**Pass:** happy path converges after `PAIR_APPROVE`; expiry returns `PAIRING_EXPIRED`; mismatched
confirmation phrase blocks bootstrap (no key material crosses).
**Fail:** bootstrap completes without an affirmative confirm-match; expired invite still pairs;
confirmation phrases match across a substituted-key channel.
**Hard-block check (digest open-question):** verify the **UI does not auto-accept** the bootstrap —
acceptance must require the human to confirm the codes match on both screens. If the shell
auto-accepts, that is a FAIL even though the backend returns the correct phrase.

### S4 — Multi-device note CRUD convergence (concurrent edits) `[MULTI] AUTO [GAP]`
**Goal:** concurrent edits from ≥2 writers converge via Autobase LWW with **no data loss and no
fork**. This is the single most important uncovered path in the digest.
**Setup:** 2 nodes (proxy: two `createPearEnd` on one `@hyperswarm/testnet`; real: D1 + 1 phone),
both paired into one vault (S3), both `base.writable`.
**Steps:**
1. Node A `NOTE_UPSERT { note:{ id:X, label:'A', body:'PEARPASTE_PLAINTEXT_SENTINEL_S4_A' } }`
   **and** Node B `NOTE_UPSERT { note:{ id:X, label:'B', body:'…_S4_B' } }` **without** syncing
   between (true concurrent write on the same object id).
2. Let both `base.update()` settle.
3. On **both** nodes: `NOTE_LIST`, `NOTE_OPEN { noteId:X }`, `DEVICE_LIST`.
4. Create distinct notes Y (A only) and Z (B only) concurrently; settle; list on both.
5. `node scripts/verify-encryption.js` on **both** stores.
**Pass:** (1) both nodes resolve X to the **same** LWW winner (deterministic by op `lamport` +
`deviceId`) — identical sealed record and identical decrypted body on both; (2) Y and Z both survive
on both nodes (no lost write); (3) `DEVICE_LIST` is **byte-identical** on both nodes; (4) verifier
exits 0 on both.
**Fail (these are the digest's predicted defects — capture them precisely):**
- Nodes disagree on the X winner, or on the device set after a reorg → **authorization-state-not-
  reset corruption** (`autobase-sync.js:42-48,199-280`). File against that finding.
- A note exists on one node but not the other after settle → lost write / fork.
- Search drift: `SEARCH { query }` for a rolled-back revision returns a stale hit on one node only
  (search index not rolled back on reorg, `autobase-sync.js`/`materialized-view.js`).

### S5 — Edit-while-offline → reconnect → Autobase merge `[MULTI] AUTO [GAP]`
**Goal:** a device that writes while partitioned merges cleanly on reconnect with no data loss or
fork. Also covers the **newly-paired-device-first-write** defect.
**Steps:**
1. Pair Node B (fresh) into the vault (S3). **Immediately** — before B's writer seat is confirmed
   `writable` — issue `NOTE_UPSERT` on B.
2. Partition B from the testnet (drop the swarm / stop bootstrap reachability).
3. While offline: B does 3× `NOTE_UPSERT` (sentinel bodies) and A does 3× different `NOTE_UPSERT`.
4. Reconnect B; let both settle.
5. `NOTE_LIST` / `NOTE_OPEN` on both; verifier on both.
**Pass:** the immediate post-pair write (step 1) is **not silently dropped** — it either lands or
returns a typed retryable error and is retried, and ultimately appears on both nodes; all 6
offline-era notes converge on both nodes; no fork.
**Fail:** step-1 write throws raw `Not writable` and is lost with no retry (digest critical
`autobase-sync.js:496-501` — `appendOp()` before writer linearizes); or offline writes are lost on
merge; or the two nodes fork.

### S6 — Clipboard round-trip + plaintext clear on lock/background `[DESKTOP] [MOBILE] SEMI + MANUAL`
**Goal:** capture → list (sealed) → copy (plaintext to OS clipboard) → auto-clear; and decrypted
clip plaintext is dropped on lock/background, honoring iOS/Android background-clipboard limits.
**Steps (desktop, SEMI):**
1. `CLIP_CAPTURE { … body:'PEARPASTE_PLAINTEXT_SENTINEL_S6' }` (manual capture path — renderer
   reads `navigator.clipboard`).
2. `CLIP_LIST` → row is **sealed** (no body).
3. `CLIP_COPY { clipId }` → returns plaintext for the OS clipboard; reference nulled immediately;
   60s auto-clear scheduled (clears only if clipboard value unchanged).
4. `LOCK_VAULT` (or window blur) → backend `openItems` cleared; `CLIP_OPEN` after lock fails.
5. Verifier on store + `--log`.
**Steps (mobile, MANUAL):** capture is **foreground + user-initiated only** (no poll loop). Confirm
the persistent banner states iOS forbids background clipboard sync / Android does not promise it.
Background the app → reopen → previously-opened clip body must NOT be visible without re-open.
**Pass:** clip body never in `CLIP_LIST`; `CLIP_COPY` returns it once; OS clipboard auto-clears at
60s if unchanged; after lock/background no decrypted clip plaintext is retrievable without unlock +
re-open; verifier exits 0.
**Fail / known defects to watch:**
- **Desktop "Monitor clipboard" mode (digest high):** selecting Monitor must actually sample the OS
  clipboard. If it silently does nothing (worker uses headless in-memory backend), that is a FAIL —
  the option should be hidden/disabled until wired.
- **Background clear not firing on desktop (digest high):** the backend `backgrounded` broadcast is
  not emitted over the real Pear transport; only the renderer blur→`NOTE_CLOSE/CLIP_CLOSE` for the
  *one open item* mitigates it. Assert that backgrounding with an item open drops its plaintext;
  if a backend-held item not mirrored by the single open-item survives background, FAIL.
- **iOS suspend assumption:** the mobile plaintext-drop relies on bare-kit firing `suspend` on
  background, with **no JS fallback**. Verify on a **real device** (not just Simulator) that
  backgrounding drops open plaintext; if not, FAIL against the missing AppState backstop.
- **Clip TTL never erased (digest high):** clips get a 24h `expiresAt` but **no sweeper emits
  `CLIP_DELETE`**, so the encrypted clip persists at rest forever. Add an assertion: after a clip's
  `expiresAt` passes, the encrypted row must be **gone** from the materialized view (run verifier /
  inspect-store and grep for the obid). Today this is expected to **FAIL** — file against
  `notes-service.js` (missing clip sweeper) and confirm `CLIP_OPEN/CLIP_COPY` reject an expired clip.

### S7 — Relay store-and-forward / Atomic Blind Custody while all devices offline `[RELAY] AUTO + MANUAL`
**Goal:** when **all** personal devices are offline, an encrypted item is held by relays and
delivered on wake; covers relay-unavailable→reavailable and TTL expiry.
**Steps (AUTO, hermetic):** use `startFakeRelay` + `makeFakeRelayClientFactory({mode:'quorum'})`.
1. Node seeds the encrypted vault log / publishes custody intent on real ciphertext bytes.
2. Assert seed reaches quorum (`acceptances >= requiredReplicas`) and the relay's reported
   `ciphertextRoot` **matches OUR root** (`receiptsMatchRoot` true).
3. Take the only writer offline; a second device (or the same store re-opened later) comes online
   and pulls the held data.
4. `RELAY_STATUS` reflects custody state; `NETWORK_STATUS` shows relay vs DHT path classification.
**Relay-unavailable → reavailable sub-test:** start with `relayClientFactory:false` (absent dep /
relay down) → seed/custody must be a **local-first no-op** (`{ok:false, local:true}`, never throws);
then bring the relay up and confirm seeding succeeds. Item must remain local and intact throughout.
**TTL-expiry sub-test:** publish custody with a short `retainUntil`/`deadline`; after expiry the
relay no longer serves it; the writer's local copy is unaffected.
**Quorum-failure sub-test:** `mode:'custody-fail'` (HTTP 503) → `publishTemporaryCustody` fails
softly and the clip **stays local** (no data loss, no throw).
**Steps (MANUAL, live fleet):** `node scripts/pin-on-hiverelay.js --key <vault-log-pubkey>
--replicas 5 --json`; confirm `acceptances`; take all devices offline; later bring a fresh device
online and confirm it converges from the relay-held log.
**Pass:** quorum reached with root-binding; offline→wake delivery converges; unavailable path is a
clean local-first no-op; TTL expiry stops relay serving without touching local data; quorum failure
keeps the clip local.
**Fail:** any relay path throws; data lost when relay unavailable; delivered root doesn't match;
expired item still served.

### S8 — Device revoke + re-pair `[MULTI] SEMI [GAP]`
**Goal:** a revoked device loses its writer seat (its future ops are rejected fleet-wide), and the
same device can re-pair cleanly afterward.
**Steps:**
1. Pair B into the vault (S3). Confirm convergence.
2. On A: `DEVICE_LIST` → find B's `deviceId`; `DEVICE_REVOKE { deviceId }`.
3. Let all nodes settle. B attempts `NOTE_UPSERT`.
4. On a third node C, list devices and verify B is revoked consistently.
5. Re-pair B fresh (new writer key) via S3; confirm it converges again and is a distinct device
   record.
**Pass:** after revoke, B's new ops are **not applied** by other nodes (`revokedAtLamport` gate);
`DEVICE_LIST` shows B revoked **identically on every node**; re-pair produces a new authorized
device and converges.
**Fail:** B's post-revoke ops still apply on some node; device set disagrees across nodes (ties back
to the S4 authorization-reset defect); re-pair forks the device set.
**Confidentiality caveat (digest high — assert and document, do not silently pass):** revocation
does **not** rotate keys or enforce the epoch — `KEY_ROTATE` is currently cosmetic, so a revoked
device that retains `vaultKey` can still **decrypt past and any still-received content**.
**Explicitly record** in the result template that this scenario proves *"future writes rejected /
writer seat removed"* and **does NOT** prove forward secrecy. If the UI/docs claim a revoked device
"cannot read", that copy is a **FAIL** until epoch-bound key derivation lands.

### S9 — Relay-blindness negative test (relay persisted == ciphertext only) `[RELAY] AUTO`
(extends `test:integration` #24/#25, `test:security`)
**Goal:** prove a relay only ever holds ciphertext — inspect what was actually handed to / persisted
by the relay.
**Steps:**
1. Run S7's seed/custody path with sentinel-bearing bodies through the **real** relay-service code
   path (fake relay captures every request body).
2. Inspect `received[]` raw bodies on the fake relay AND `<storagePath>/relay-exports/` mirror.
3. `node scripts/verify-encryption.js <storagePath> --json` — assert `relayExportHits == []`.
4. **Negative control:** plant a record containing `PEARPASTE_PLAINTEXT_SENTINEL_` into the export
   mirror and re-run the verifier → it **must FAIL** (proves the verifier has teeth).
5. Confirm `assertCiphertextOnly` rejects a deliberately mis-built payload with a secret-ish field
   (e.g. `{secretKey:'x'}`, `{tags:['a']}`, nested `{intent:{clipBody}}`).
**Pass:** no sentinel in any relay-bound byte or export; verifier exits 0 on the clean store and
exits 1 on the planted-leak control; the deny-list/guard rejects the mis-built payloads.
**Fail:** any plaintext sentinel in `received[]`/`relay-exports`; verifier passes a planted leak; a
secret-named field passes the blindness guard.

---

## 4. Cross-device soak test (2 desktops + 1 mobile, long-running) `[MULTI] SEMI/MANUAL [GAP]`

**Bench:** D1 (macOS / M3 Ultra) + a second desktop (D2 Windows **or** D3 Linux) + one physical
phone (M-iOS or M-Android), all on the same private testnet (or isolated public DHT), all paired
into one vault. Duration: **≥4 hours** (overnight preferred).

**Workload loop (script the desktops; drive the phone manually at intervals):**
1. Each desktop runs a randomized loop: `NOTE_UPSERT` (new + edits to shared ids), `NOTE_DELETE`,
   `CLIP_CAPTURE`, `SEARCH`, on a 5–30s jitter. Bodies carry a per-op sentinel +
   monotonically-increasing counter so loss/duplication is detectable.
2. Phone performs periodic foreground captures and note edits, and is **backgrounded/foregrounded**
   repeatedly (exercise plaintext-drop and the desktop monitor pause/resume).
3. Inject churn: every ~30 min, **lock/unlock** one desktop; every ~60 min, take the phone offline
   for 5–10 min then reconnect (exercise S5 merge under load).
4. Once mid-run, **revoke and re-pair** the phone (S8).
5. Toggle the relay: `RELAY_SET_ENABLED` off/on, and simulate relay-unavailable→reavailable while a
   device is offline (S7).

**Continuous assertions (sampled every ~10 min and at the end):**
- `NOTE_LIST`/`CLIP_LIST`/`DEVICE_LIST` converge byte-identically across all three nodes once writes
  quiesce.
- The per-op counter sequence has **no gaps and no duplicates** in the converged view (no lost
  writes, no resurrected deletes).
- `node scripts/verify-encryption.js <store> --log <log>` exits 0 on **every** node.
- No `Not writable` / unhandled reducer exception in any worker log (watch for the malformed-op
  reducer-wedge — one bad op must be **dropped**, never halt the batch).
- Memory/handle growth is bounded (no leak from per-write O(N) search reindex over a long run —
  digest medium; capture apply latency as the log grows).

**Pass:** end-state convergence is exact on all three nodes; counter sequence intact; verifier 0
everywhere; no wedge; bounded resource growth.
**Fail:** any divergence that does not heal after quiesce; any gap/dup in the counter; any verifier
leak; a single malformed op halts sync; unbounded growth or apply stall.

---

## 5. Per-platform manual release gates

These are **manual** and gate a public release. They pull the platform rows from
[TESTING_MATRIX.md `Platform Matrix`](./TESTING_MATRIX.md). Run after §3–§4 pass.

### macOS (D1, Apple Silicon)
- [ ] Signed **and notarized** `.app` wrapper; Gatekeeper opens it without an "unidentified
      developer" warning. (No working signed/notarized path exists in scripts yet — digest blocker.)
- [ ] App name/path correct (`pear stage` derives the wrapper binary from the Pear app `name`
      `pearpaste`; if branding wants `Paste`/`PearPaste`, encode a `productName` override — do not
      hardcode in build scripts).
- [ ] Clipboard read/write + 60s auto-clear behave on real macOS.
- [ ] Tray / global paste palette (if enabled) works.
- [ ] `pear run pear://<production-key>` is the documented install path and actually launches.

### Windows (D2)
- [ ] Wrapper built via `npm run build:win`; **Authenticode** signature valid (`signtool` targets
      the **real** staged `bin\<App>-app\<App>.exe`, not a hardcoded `PearPaste.exe` — digest
      blocker, `scripts/build-windows.mjs:188-192`).
- [ ] Defender / **SmartScreen** install check: note whether SmartScreen warns; document the
      reputation state.
- [ ] Clipboard read/write and path/storage behavior on real Windows.
- [ ] `npm run preflight:win` passes (sodium win32 prebuild present, `%%HOST%%` runtime fetch, no
      stray native gyp deps).

### Linux (D3)
- [ ] `npm run preflight:linux` passes; AppImage/.deb/.rpm wrap and **launch** on a target distro.
- [ ] Clipboard backend behaves on **both X11 and Wayland** (the platform-specific risk).
- [ ] Tray / global paste (if enabled).
- [ ] Distro package policy / signing per target (maintainer task).

### iOS (M-iOS — run against the **canonical** variant; smoke the other)
- [ ] Xcode Simulator build + launch (verified on Xcode 26.x / iOS 26.x Simulator for RN-CLI).
- [ ] **Physical device** via TestFlight (Simulator boot is **not** sufficient — the bare-kit
      `suspend` plaintext-drop must be confirmed on real hardware).
- [ ] Background/foreground plaintext clear (S6) on device.
- [ ] Manual paste / share-sheet capture works; **no background clipboard claim** in copy.
- [ ] **Expo iOS only:** the Pear-end **bare-link hook** (sodium/udx/rocksdb) exists in the Podfile
      and the worklet **bundle is regenerated** at build time — both currently **missing** (digest
      release blockers). Without them the Expo iOS worklet crashes loading native addons.

### Android (M-Android — canonical variant; smoke the other)
- [ ] Gradle `:app:assembleDebug` (and signed release) build; APK / internal-track install.
- [ ] `lib/arm64-v8a/` contains the full Bare runtime; the **root** `patch-package` fixes
      (device-file reinstall crash, fs-native-extensions armv7 EINVAL) are present in the linked
      addon (build mobile **after** a root `npm ci`).
- [ ] Foreground clipboard capture; background-limitation copy shown.
- [ ] **Process death / retry:** kill the app process, relaunch → worklet boots and the vault
      unlocks (45s boot-timeout → recoverable crash, not infinite splash).
- [ ] **Expo Android only:** worklet bundle regenerated in the Expo build (no `pearpasteBundle…`
      task in the Expo Gradle today — digest blocker; the stale committed bundle is missing
      `NETWORK_STATUS`, so `RelayProofScreen` silently renders empty).

---

## 6. Execution sequence & checklist

Run in this order; a failing earlier stage blocks the later ones for the same release.

1. **Static / unit / hermetic (CI, AUTO):** `npm run lint` → `npm run test:all`
   (`test:unit` → `test:integration` → `test:e2e` → `test:security` → `test:mobile`). On Node 22,
   outside any socket sandbox (an `EPERM` at UDX bind is a sandbox artifact — rerun, don't treat as
   app failure).
2. **Verifier teeth (AUTO):** run S9 (clean PASS + planted-leak FAIL) and `verify-encryption.js`
   against a staged vault fixture.
3. **Single-device E2E (AUTO/SEMI):** S1, S2, S6 on D1; repeat S1/S2/S6 on the canonical mobile
   variant.
4. **Two-instance multi-writer proxy (AUTO `[GAP]`):** S4, S5, S8 via two `createPearEnd` on a
   `@hyperswarm/testnet`. These are the net-new digest-coverage tests — expect S4/S5/S8 to surface
   the predicted Autobase defects; record them.
5. **Relay (AUTO + live):** S7, S9 hermetic; then S7/S9 against a live test fleet after
   `scripts/probe-circuit.mjs` confirms reachability/circuit.
6. **Physical multi-device (MULTI, MANUAL):** S3 (QR pairing, both directions), then real-hardware
   S4/S5/S8 with **D1 + 2 phones** (or D1 + 1 phone + a second desktop). Mandatory before mobile
   release.
7. **Soak (§4):** ≥4h, 2 desktops + 1 phone.
8. **Per-platform release gates (§5):** macOS, Windows, Linux, iOS, Android.
9. **Sign-off:** all gates green or each red item has a filed issue + an explicit ship/no-ship
   decision recorded in the results template.

**Pre-flight checklist (before each run):**
- [ ] Storage wiped per device (§2.5); unique `PEARPASTE_STORAGE` per device.
- [ ] `@hyperswarm/testnet` bootstrap up (AUTO) **or** LAN/isolated DHT reachable (MULTI).
- [ ] Relay mode chosen: hermetic fake / `PEARPASTE_RELAYS` env / `fleet-relays.json` / empty (DHT
      auto-discovery).
- [ ] `scripts/probe-circuit.mjs` run if any pairing/relay-circuit scenario is in scope.
- [ ] All note/clip bodies carry the `PEARPASTE_PLAINTEXT_SENTINEL_` prefix.
- [ ] Worker log path captured for `verify-encryption.js --log`.

---

## 7. Results-capture template

One row per scenario per run. Keep raw verifier output and worker logs as artifacts.

```
PearPaste E2E run
  Run ID:            <date>-<git-sha>-<bench>
  Date / tester:     2026-__-__  / <name>
  Build under test:  desktop pear://<key> | win wrapper <ver> | linux <pkg> |
                     ios <variant> <build> | android <variant> <build>
  Bench devices:     D1 macOS(M3 Ultra) [..] | D2 win [..] | D3 linux [..] |
                     M-iOS <model/OS> [..] | M-Android <model/OS> [..]
  Testnet:           @hyperswarm/testnet (N bootstrap) | LAN DHT | public(isolated)
  Relay mode:        fake | PEARPASTE_RELAYS | fleet-relays.json | empty(DHT-auto)
  probe-circuit:     ADVERTISED | PARTIAL | NOT-advertised | n/a

| Scenario | Devices | Mode | Result | Verifier exit | Notes / defect ref |
|----------|---------|------|--------|---------------|--------------------|
| S1 vault create+lock      |        |      | P/F | 0/1 |  |
| S2 BIP39 restore (fresh)  |        |      | P/F | 0/1 | genesis-fork check: __ |
| S3 pairing QR + expiry/MITM|       |      | P/F |  -  | confirm hard-block: __ |
| S4 concurrent CRUD merge  |        |      | P/F | 0/1 | winner agree? devset id? |
| S5 offline edit -> merge  |        |      | P/F | 0/1 | post-pair 1st write: __ |
| S6 clip round-trip+clear  |        |      | P/F | 0/1 | monitor? bg-clear? TTL? |
| S7 relay store&forward    |        |      | P/F | 0/1 | quorum/root/TTL/unavail |
| S8 revoke + re-pair       |        |      | P/F | 0/1 | read-after-revoke=EXPECTED|
| S9 relay-blindness (neg)  |        |      | P/F | 0/1 | planted-leak FAILs? __ |
| Soak (§4, __h)            |        |      | P/F | 0/1 | counter gaps/dups: __ |

  Per-platform release gates (§5):
    macOS  sign/notarize [ ] clipboard [ ] palette [ ] launch [ ]
    Win    authenticode  [ ] smartscreen [ ] clipboard [ ] preflight [ ]
    Linux  preflight [ ] pkg-launch [ ] clipboard X11/Wayland [ ]
    iOS    simulator [ ] device/TestFlight [ ] bg-clear(device) [ ] expo-barelink [ ]
    Android gradle [ ] install [ ] patches-present [ ] process-death [ ] expo-bundle [ ]

  Open defects filed (link issues):
    - <id> <severity> <title>  (e.g. authorization-state-not-reset on reorg)
  Ship decision: SHIP | NO-SHIP | SHIP-WITH-CAVEATS  (rationale: ____)
```

---

## 8. Coverage notes vs. the matrix

- This plan **adds** the multi-writer / convergence coverage the matrix flags as missing
  (`No real Pear window automation yet`; improvement-plan items 1, 3, 5). S4/S5/S8 are the
  two-real-Autobase-instance tests the digest says do not exist today.
- It **does not** replace native CI lanes (matrix improvement items 2–4) — Xcode/Gradle/AppImage
  builds and signing remain the per-platform manual gates in §5.
- Where a scenario is expected to **FAIL on current code** (clip TTL erase S6; read-after-revoke S8;
  possibly authorization-reset S4 and first-write-after-pair S5), the plan says so explicitly and
  routes the failure to the owning `backend/` finding rather than masking it as green.
