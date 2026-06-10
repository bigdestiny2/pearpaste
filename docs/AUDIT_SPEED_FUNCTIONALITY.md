# PearPaste — Speed & Functionality Audit

**Date:** 2026-06-10
**Scope:** Full-product speed + functionality audit synthesizing 6 area reports (engine hot-path, crypto/storage, network/swarm/relay, desktop UX, mobile parity, product/release/website). Every finding below was independently re-derived and adversarially verified; numbers carry their measurement method.
**Platform for all benchmarks:** M3 Ultra (Mac Studio), Node 22.22, `sodium-native`, sandbox OFF, unless noted. Networked numbers use `@hyperswarm/testnet`.
**Method note:** This document only synthesizes prior measurement + verification work. It is the single file created by this pass; no source was modified.

---

## 1. Executive Summary

PearPaste's cryptographic core, steady-state networking, and append pipeline are healthy and frequently excellent. Seal/open run at micro-scale (14µs/8.6µs at 1 KB), the replication firewall costs ~1 ms per connection, single-note cross-device sync lands in ~25 ms on LAN, `_rebuildAuthFromView` is ~0.15–0.5 ms/pass, and append serialization is not a bottleneck. The audit's verifiers actively tried and **failed** to refute the core security model under load.

The real problems cluster in **four** places, and they are concentrated, not diffuse:

1. **One write-path hot spot dominates everything at scale.** `LocalSearchIndex.indexObject` re-scans the *entire* local `search!` family on every note write. This is the single most-cited finding across three independent area reports, all converging on the same fix (a per-object reverse-pointer row). It is responsible for NOTE_UPSERT latency degrading from ~4 ms/op to 43–55 ms/op as a vault grows to 1–2 k notes, and it is ~85–94% of write cost. The store is local-only, so the fix is **security-neutral** and was prototyped at 45–70× faster with byte-identical output.

2. **Two silent data-loss functionality bugs** that the green test suites structurally cannot see because they all edit/replicate within one process lifetime or bypass the production pairing path:
   - **Lamport clock restart** → the first edit of any existing note after an app restart is silently dropped against its own LWW history.
   - **Pairing-window divergence** → a stale pairing connection starves replication indefinitely, and the durability reconciler retires on *local* view presence, so a note written during the pairing window is permanently missing on the new device.

3. **A perceived-latency gap:** the engine syncs remote ops in ~25 ms but emits no UI-consumable event, so multi-device sync "requires manual refresh" on both desktop and mobile.

4. **Clips never get swept** — expired clip ciphertext persists and replicates forever, and the 24 h retention promise never performs real cryptographic erasure even though the Phase 5 tombstone path is fully wired and idle.

Several "scary" findings were **refuted on re-derivation** and are demoted to the rejected appendix (§9): the mobile bundles are *not* stale (the auditor measured a dead generic bundle, not the shipping per-platform ones), the Expo/RN variant split is *not* inverted (the canonical wiring already exists), the desktop visibility/background-clear path *is* wired in production, and the README *already* states the security model correctly. Three quick wins were also found **already applied** in the working tree (`/mobile` is in the stage ignore list, the `'unlocked'` relay auto-seed already has its dedup guard).

**Net recommendation:** ship the indexObject reverse-index, the Lamport high-water restore, the pairing-conn teardown + durability-retirement fix, and the `view-changed` UI event before mobile ships or any vault grows past a few hundred notes. Commit the already-green working-tree perf WIP. Resolve the recovery-path gap (EXPORT/IMPORT backup is declared, documented, and has no handler). Do **not** reach for the tempting batch/compaction/relay optimizations flagged in §8 — each one quietly breaks a security or correctness invariant.

---

## 2. Measured Benchmarks (every number with its method)

### 2.1 Engine hot-path

| Metric | Measured | Method |
|---|---|---|
| 200 sequential appendOps | 8.6 ms/op (p50 8.1 / p95 13.0 / p99 14.1) | 2-device testnet, ~100-note vault; 8.5 ms inside serialized `base.append`, `_makeOp` 0.07 ms |
| 50-burst concurrent appendOps | 14.7 ms/op effective, 50/50 rows present, remote +176 ms | 2-device testnet — chain serialization is not the bottleneck |
| 2000 sequential appendOps (single device, no net) | 28.8 ms/op avg; first-200 4.5 → last-200 54.7 ms/op (12×) | `_apply` avg 27 ms/pass |
| apply-path split @1250–1500 notes | `indexObject` 38.36 ms of 40.93 ms/op (**94%**); appendOp 2.57 ms with indexObject stubbed (16×) | search family = 11,990 rows at 1.5 k notes |
| unlock→ready, prebuilt 1 k-op vault | 11.3 ms, 1 apply pass | `base.length` grew 2003→2005 across reopen (redundant genesis DEVICE_ADD + ack) |
| NOTE_LIST @1 k notes (limit 200) | 71.6 ms cold / 32.8 ms warm | scanNotes 3.0 + resolveObjMeta 21.6 (66%) + openRecord 6.4; all 1000 decrypted regardless of limit |
| `_rebuildAuthFromView` per pass | 0.31 ms @1 device; 0.15→0.39 ms @3 devices/0→3 rotations | +~0.08 ms per rotation forever; ~310 passes / 150 ms in a ~400-op session (1–2% of append wall time) |
| `_appliedOps` after 2 k-op session | 2001 snapshots = 3.49 MB JSON / ~4.1 MB heap (~2 KB/op) | mirrored on receiving replica (253/253) |
| `_reconcileDurability` | 2.83 ms/pass over 50 pending; retire needs 6 present passes (~1.8 s) | blocked during 30 s fresh-writer window |
| Lamport-restart probe | stored `__lww.lamport=62`; post-restart edit minted lamport 2 and was silently dropped | reconciler cannot rescue |
| CLIP_LIST over 1000 all-expired clips | 47.1 ms scanning+decrypting 1000 sealed rows to return 0 | no clip sweeper exists |

### 2.2 Crypto + storage

| Metric | Measured | Method |
|---|---|---|
| seal 1 KB / open 1 KB | 14.1 µs (70.9 k/s) / 8.6 µs (116.6 k/s) | warmed, 2–5 k iters |
| seal 100 KB / open 100 KB | 576 µs / 318 µs | as above |
| signOp / verifyOp 1 KB | 31.3 µs / 45.9 µs (100 KB: 1.34 ms / 1.07 ms) | preimage re-canonicalizes hex string |
| seal-1KB decomposition | canonicalize(pt) 38%, AEAD 17%, nonce 15%, itemKey HKDF 9% | itemKey LRU would save ~2 µs — **not worth it** |
| hyperbee write pattern | 50 individual put = 0.47 ms/row vs batch+flush = 0.10 ms/row (4.8×) | corestore on disk; apply pass already batches correctly |
| engine end-to-end appendOp (1 KB) | 10.74 ms/op with indexing vs 1.67 ms/op with indexObject no-op'd | search index = **85%** of write cost at ~200 notes |
| indexObject scaling (35 tok/note) | 1.72 ms @10 → 58.9 ms @500 → 130.5 ms @1000 notes; reverse-index variant 1.37 ms @1 k (56×) | 35,177 rows @1 k notes, on disk |
| search WIP vs committed (1 k-note idx) | dup×4 terms 2.37 vs 10.12 ms (**4.3×**); missing-first 3.17 vs 0.03 ms (regression); WIP+peek 0.04 ms both orders | result-set equality true on all 14 case runs |
| storage rows (1 KB note) | notes 2686 B, objmeta 421 B, tombstone 583 B, epochkeys wrap 964 B, search 136 B key + **424 B value** | envelope = 2.0× plaintext @≥10 KB |
| search core size | 2.99 MB for 205 × 1 KB notes (~14.6 KB/note) | →4.7 KB/note (4×) with a 1-byte marker value |
| `listEpochKeyWrapsFor` @250 rows | 6.63 ms/call as-implemented vs 2.29 ms using stream value (2.9×) | double-read per row; paid per apply pass |
| `pwhashWithSalt` (argon2id 64 MB) | 76 ms/call synchronous | runs inside `_applyKeyRotate` on every KEY_ROTATE apply |

### 2.3 Network / swarm / relay

| Metric | Measured | Method |
|---|---|---|
| Firewall handshake ON | first-conn 1.8 ms, reconnect median 0.7–0.9 ms (max 1.4) | 2-device testnet, 5 destroy/redial; OFF = 0.0 ms |
| Per-connection crypto | sign 14.4 µs + verify 33.4 µs | N=2000; destroyPeer sweep 0.58 ms over 1000 conns |
| 50-note batch A→B | 50/50 visible on B 298 ms after first append; 4.8 ms/op local | testnet, production 2 s converge loop; 100 ms pump = 266 ms (cadence is not the bottleneck) |
| Single-note A→B visible latency | 23–34 ms (median 24, n=5) | replication-driven apply is already event-driven at engine layer |
| Production startup | createPearEnd boot 57–86 ms; CREATE_VAULT 169–189 ms; PAIR_ACCEPT e2e 110 ms; offline-note-after-unlock visible 135 ms | 2-device testnet, relays disabled; UNLOCK argon2id INTERACTIVE alone 81 ms |
| **Post-pair replication stall** | `store.replicate` 0/0 both sides for **45 s+**; forced `conn.destroy` → catch-up immediate (len 0→14), post-settle note 53 ms | production pairing path; the green suites bypass it |
| Idle converge pump cost | `refresh()`/`base.update()` 0.06 ms/op | ~30 µs/s of CPU |

### 2.4 Desktop

| Metric | Measured | Method |
|---|---|---|
| NOTE_UPSERT vs vault size | 4.1 ms/op @≤100 → 15.6 @500 → **42.9 @1000** notes (linear) | in-proc engine, swarm/relays disabled |
| NOTE_LIST @1000 (returns 200) | 38–47 ms/call | full scan + decrypt, 3 runs |
| NOTE_OPEN (tap-to-decrypt) | median <0.1 ms, p95 0.1 ms (n=20) | direct bee get — **not** a desktop bottleneck |
| SEARCH @1000 | 50-hit 44.9 ms cold, 1-hit 0.2 ms | — |
| CLIP_CAPTURE ×200 / CLIP_LIST @200 / CLIP_COPY | 2.1 ms/op / 8.1 ms / median 0.5 ms | scanClips+find per copy |
| EXPORT/IMPORT_ENCRYPTED_BACKUP | Error: "no handler registered" | via bridge.request |

### 2.5 Mobile

| Metric | Measured | Method |
|---|---|---|
| createPearEnd boot / CREATE_VAULT | 136.7 ms / 165.1 ms | in-process micro-bench |
| RELAY_STATUS round-trip | direct 0.010 / rpc-commands 0.021 / worklet-rpc 0.018 ms/op | 200 ops |
| NOTE_UPSERT / NOTE_LIST(50) / SEARCH | 3.7 / 1.79 / 2.23 ms/op | — |
| **`pearEnd.close()` after one write** | 2.0 s (create-only) → **20.0 s** (swarm off) / 21.3 s (live) | sole pending task = `relay-autoseed-syncopen` for full 20 s |
| Mobile test suite (4 tests) | 69.4 s live fleet / 61.1 s swarm-off | ~3 vault tests × ~20 s, dominated by the close hang |
| Committed per-platform bundle freshness | epochTag 113, grantHistory 9, admitPolicy 9, NETWORK_STATUS 7, tombstone 25 (**current**) | RPC-surface sha256 matches current `rpc.js`; see §9 |

### 2.6 Website (paste.global)

| Metric | Measured | Method |
|---|---|---|
| Critical path transfer | / = 9,350 B, styles.css = 5,422 B, app.js = 2,065 B (~17 KB) | live Vercel, brotli; no fonts, no third-party |
| og.png | 130,064 B → 51,711 B (−60%) at 256-color | PIL adaptive palette |
| WCAG contrast `--faint` #6b7682 | 4.31:1 on bg, 4.03:1 on surface (AA needs 4.5:1) | `--muted` 8.04:1 passes |
| Source repo link | `github.com/bigdestiny2/pearpaste` → HTTP 404 (5 site surfaces link it) | unauthenticated curl |
| Production pear link | resolves; release = "Unreleased" (mutable tip) | `pear info pear://u6oyh38g…` |

---

## 3. Prioritized Improvement Plan (Impact × Effort)

Numbered `I-n` for reference. Effort: **S** = hours, **M** = a day or few, **L** = multi-day. "Verifier verdict" is shown where a verifier examined the finding; items with no verifier note were `confidence: measured`/`code-derived` and accepted as-reported.

### 3.1 QUICK WINS (high/medium impact, S effort) — do these first

#### I-1 — Restore the Lamport high-water mark on reopen (fixes silent edit loss)
- **Impact:** HIGH · **Effort:** S · **Kind:** functionality
- **Where:** `backend/index.js:133` (`lamport: new ops.Lamport(0)`, constructed once, never re-seeded); only re-raise is `ctx.state.lamport.observe(h.lamport)` at `backend/autobase-sync.js:844`, which never runs on a fully-indexed reopen; `backend/autobase-sync.js:112–173` (`engine.open`) restores nothing; `backend/vault-store.js` persists epochKeys but no lamport.
- **Recommendation:** In `engine.open()` after `base.update()`, observe the max `header.lamport` across each writer core's tail node (O(#writers) reads) and/or persist the watermark with the local vault secrets. Add a build→close→reopen→edit→assert-body regression test (currently missing).
- **Verifier verdict (CONFIRMED, high):** Reproduced the linchpin with a real autobase 7.x reopen harness — apply does **not** re-run over already-indexed nodes, so `observe()` never fires and the clock stays at 0. `lamport` is in the public-header allowlist (`shared-ops.js:47`), so observing it reads no secret bytes; `observe()` is a max-merge → monotonic and reorg-safe. *Correction:* the claim that the durability reconciler "re-appends tick 3,4,… and keeps losing / lingers in `_pendingDurable`" is wrong — `_rowPresentFor` checks row *presence*, so the reconciler **retires** the entry after ~6 passes; net effect is the same or slightly worse (no retry safety net at all). Precondition is mundane: the clock is global per process, so a single note's stored lamport reaches the dozens trivially.

#### I-2 — Commit the already-green working-tree perf WIP
- **Impact:** MEDIUM (latency) · **Effort:** S · **Kind:** speed
- **Where:** event-driven `_awaitWritable` / `base.waitForWritable` (`backend/autobase-sync.js:651–672`), coalesced `refresh()` (`:1657–1681`), concurrent search-term scans (`materialized-view.js`).
- **Recommendation:** Run a normal suite + lint, then commit. The committed HEAD `_awaitWritable` polls at 150 ms (mean ~75 ms extra first-write latency on a freshly paired device); the working tree already replaces it event-driven. All exercised green under every benchmark in this audit.
- **Verifier verdict:** None (measured). Note: the crypto-storage report observes this `search()` optimization is **already committed** (git `0969316`), not WIP — substance unaffected; just commit anything still dirty.

#### I-3 — Add a `bee.peek` existence probe per term in `LocalSearchIndex.search`
- **Impact:** MEDIUM · **Effort:** S · **Kind:** speed
- **Where:** `backend/materialized-view.js:498–525` (WIP search). hyperbee exposes `peek` (`node_modules/hyperbee/index.js:499`).
- **Recommendation:** Before the full per-term scans, `Promise.all` a `this.bee.peek({gte: prefix, lt: prefix+'~'})` per term; if any term has zero rows, return `[]`. Restores no-hit queries to **0.04 ms in both term orders** (beats committed, which only early-exits when the missing term is first) while keeping the 4.3× dup-term win. This is the companion to the §6 "keep the WIP search diff" verdict.
- **Verifier verdict:** None (measured); correctness of the WIP diff itself was result-set-equality verified on 14 query shapes.

#### I-4 — Use the read-stream value in the epochkeys scanners (stop double-reading)
- **Impact:** MEDIUM · **Effort:** S · **Kind:** speed
- **Where:** `backend/materialized-view.js:302–306` (`listEpochKeyWrapsFor`) and `:334–339` (`listEpochKeyWrapBlindIds`) — both `for await (const { key } of …)` then `await this.getSealedRaw(key)`, re-getting a row the stream already delivered.
- **Recommendation:** Destructure `{ key, value }` and use `value` directly. Halves that family's bee reads per apply pass: **6.63 → 2.29 ms** at 50 rotations × 5 devices, identical results. Zero risk. (Confirmed present at the cited lines during this synthesis.)
- **Verifier verdict:** None (measured).

#### I-5 — Memoize `blindId → objectId` in RAM for NOTE_LIST/CLIP_LIST/SEARCH
- **Impact:** MEDIUM · **Effort:** S · **Kind:** speed
- **Where:** `backend/notes-service.js:90–143` (per-row awaited `resolveObjMeta` → `materialized-view.js:135–143`).
- **Recommendation:** Memoize the immutable objmeta mapping while unlocked, wiped on lock exactly like `openItems`/`devices`/the auth cache. Removes **66%** of warm NOTE_LIST cost (21.6 ms of 32.8 ms at 1 k notes). Optionally key derived list metadata by `envelope.nonce` so unchanged rows skip re-decrypt → warm NOTE_LIST ~3–6 ms. Cache lifetime = the existing in-memory auth cache, so spec §9.4 "no decrypted cache **at rest**" holds.
- **Verifier verdict:** None (measured).

#### I-6 — Guard the genesis self-add in `open()` with a one-shot `_rebuildAuthFromView()`
- **Impact:** MEDIUM · **Effort:** S · **Kind:** functionality
- **Where:** `backend/autobase-sync.js:165–169` — gates genesis on `devices.size===0`, but the auth cache is only populated by `_rebuildAuthFromView` inside `_apply`; on a fully-indexed reopen no apply pass has run, so it self-appends genesis every unlock. Knock-ons: `_lastWriterAddedAt=now` → 30 s fresh-writer window reopens **every** unlock (blocks durability retirement, holds the 300 ms cadence); firewall classifies all peers "unknown" until the first apply (`replication-firewall.js:114`).
- **Recommendation:** After `base.update()`, run `_rebuildAuthFromView()` once and gate the genesis append on the rebuilt committed device set; only bump `_lastWriterAddedAt` when `addWriter` admits a writer not already in `writerToDevice`. Kills the log spam (`base.length` 2003→2005 per reopen), the per-unlock 30 s window, and the firewall blink. Pure-local; reorg semantics untouched.
- **Verifier verdict:** None (measured).

#### I-7 — Move the synchronous 76 ms Argon2id out of the KEY_ROTATE reducer
- **Impact:** MEDIUM · **Effort:** S · **Kind:** speed
- **Where:** `_applyKeyRotate` → `_persistEpochKeyLocal` (`backend/autobase-sync.js:1212`) → `saveVaultSecrets` (`:1321`) → `vault-store.js:212–214` → `saveLocalDevice` → `pwhashWithSalt` (`vault-store.js:102`, fresh random salt per save).
- **Recommendation:** Defer the local-blob persist out of `_apply` onto the existing post-apply `epoch-rotated`/`key-rotated` signal path (committed `epochkeys!` rows remain the durable source per the code's own comment at `autobase-sync.js:1329`). Removes a synchronous 76 ms / 64 MB Argon2id from every KEY_ROTATE apply — materially worse on the 2 GB-phone Bare worklet the INTERACTIVE downgrade was introduced for.
- **Verifier verdict:** None (measured).

#### I-8 — Replace the never-read 424 B search-row envelope with a marker
- **Impact:** HIGH (storage) · **Effort:** S · **Kind:** functionality
- **Where:** `backend/materialized-view.js:469–479` seals `{objectId,type}` per token; the only `search()` consumer (`notes-service.js:331–373`) destructures `objectBlindId` only and resolves via objmeta. The same plaintext is already sealed in the **replicated** `objmeta!` row written in the same batch.
- **Recommendation:** Store a 1-byte marker (or one shared per-object envelope) as the search-row value. Cuts the dominant storage family **~4×** (14.6 → 4.7 KB/note) and removes ~35 `seal()` calls/note. Keep the hardcoded `sealed:true` flag (independent of value) so `test/unit/search.test.js:61` still passes.
- **Verifier verdict (CONFIRMED, high):** The envelope value is never opened by any caller across backend/ui/mobile/scripts (both mobile bundles use the identical `for (const { objectBlindId } of hits)`). Value is 75.2% of logical row bytes (validates ~70% headline). Local-only store → zero E2E/relay/forward-secrecy/reorg/firewall impact. *Correction:* the seal()-time saving is overstated (~0.4 ms claimed vs measured `indexObject` ~13 ms/note total) — the real win is **storage**, so impact stays HIGH on storage grounds. Best landed together with I-9.

#### I-9 — Emit a debounced `view-changed` event so the UI live-refreshes on sync
- **Impact:** HIGH · **Effort:** S · **Kind:** functionality
- **Where:** engine syncs single-note A→B in ~25 ms but emits no content event; `_apply` emits only `auth-cache-rebuilt` (`autobase-sync.js:915`). `ui/desktop/app.js` `onEvent` handles only locked/unlocked/pair-*/clip-captured; `refreshNotes` runs only on tab switch + manual Refresh. Mobile `NotesScreen.js`/`ClipsScreen.js` have no subscription either.
- **Recommendation:** Emit a debounced, payload-less `view-changed` ctx event from the converge loop after `engine.refresh()`; forward it via the existing `desktop-bridge.js` / `worklet.mjs` allowlists; UI re-runs `refreshNotes`/`refreshClips` for the active tab. Turns a ~25 ms engine sync into a ~25 ms user-visible sync.
- **Verifier verdict (CONFIRMED, high):** Instrumented B during a remote apply — the only events fired were `sync-open` + `auth-cache-rebuilt`, zero UI-consumable content events while the note materialized in ~9 ms (no DHT hop). Carries no plaintext; does not touch the security model or conflict with the firewall's `auth-cache-rebuilt` consumer. *Corrections:* production is **event-driven** (250 ms debounce, not a "2 s cadence" — that was a test knob); `clip-captured` fires only from the local OS-clipboard monitor, so remote clip arrival shares the gap; the consume side already exists on mobile (`DevicesScreen.js:55`, `ClipsScreen.js:56`), so the fix is backend-emit + 2 allowlist entries + ~1 UI line each.

#### I-10 — Make the relay auto-seed cancellation-aware (fixes the ~20 s shutdown hang)
- **Impact:** HIGH · **Effort:** S · **Kind:** speed
- **Where:** `backend/relay-service.js:877–884` spawns `seedVault` on `sync-open` without racing `scope.signal`; `client.seed` waits out `seedTimeoutMs=15_000` (`relay-service.js:91`) + a 5 s relay-connected wait (`p2p-hiverelay-client/index.js:745–794`); `backend/lifecycle-scope.js:71–86` `close()` awaits `Promise.allSettled(tasks)` **before** disposers run.
- **Recommendation:** Race the autoseed against `scope.signal` (resolve immediately on abort), or register the relay-client destroy as an abort listener rather than an `onClose` disposer. `seedVault` already try/catches a closing store, so seeding stays best-effort. Turns every post-write shutdown from ~20 s to ~2 s and cuts the mobile suite from ~61 s to ~8 s.
- **Verifier verdict (CONFIRMED, high):** Re-measured ~17 s residual close cost; the un-cancellable seed pins shutdown. *Correction (broader than claimed):* the trigger is **not** "any content write" — `sync-open` fires after *any* unlock/CREATE_VAULT, so a zero-write session that lives >~2 s hangs identically. Blast radius: desktop quit, mobile worklet teardown, and the mobile suite (≈5 tests × ~17–20 s). Most `test/integration/*` are immune (they inject a fast/false relay factory). Security-neutral — purely teardown ordering; seed request bytes unchanged.

#### I-11 — Flatten `previouslyRevokedMatch` to scalars so the re-pair warning survives the bridge sanitizer
- **Impact:** HIGH · **Effort:** S · **Kind:** functionality
- **Where:** `backend/autobase-sync.js:2317` computes `engine.matchesRevokedDevice(...)` (returns an object) and includes it in the `pair-approval-needed` payload (`:2327`, `:2335`); `backend/desktop-bridge.js:110` `sanitizeEvent` drops **all** object-valued fields (`if (typeof v === 'object') continue`), so the flag never crosses to the renderer; `ui/desktop/app.js` `pairApprovalPanel` has no rendering for it.
- **Recommendation:** Emit scalar `previouslyRevokedDeviceId` / `previouslyRevokedVia` fields (sanitizer-safe) and render a red warning block in `pairApprovalPanel` ("This device's keys match revoked device X — approve only if you re-imaged it yourself"). RT-FIX B1's "LOUD warning / explicit human decision" is currently a backend log line only. (Object-stripping sanitizer + computation site confirmed during this synthesis.)
- **Verifier verdict:** None (code-derived).

#### I-12 — Extend the sweeper to hard-delete expired clips (real erasure)
- **Impact:** HIGH · **Effort:** M (borderline-S, reuse-only) · **Kind:** functionality
- *(Effort is M because of the bucket-threading correction below; the mechanism is pure reuse of the Phase 5 path.)*
- **Where:** `backend/notes-service.js:384–414` sweeper handles **notes only**; CLIP_LIST lazily filters `expiresAt` (`:245`) but nothing emits CLIP_DELETE, so expired clip ciphertext outlives the §7.4 24 h default indefinitely (storage + replication + relay custody). Reducer side is fully wired and idle: `_applyClipDelete` (`autobase-sync.js:1444`), classified as tombstoning at `:1552`. CLIP_OPEN (`notes-service.js:265`) / CLIP_COPY (`:313`) do full `scanClips()`+find to open one clip.
- **Recommendation:** Add a clips branch to the sweeper emitting hard CLIP_DELETE past `expiresAt`; add a CLIP_DELETE RPC command + schema + bridge helper + per-row trash button reusing `deleteConfirmModal`. Store the bucket in clip objmeta so CLIP_OPEN/COPY become direct `clipsKey(bucket, blindId)` lookups. This also makes the short-retention privacy promise real cryptographic erasure.
- **Verifier verdict (CONFIRMED, high):** No producer of CLIP_DELETE exists anywhere in the repo (only CLIP_ADD); confirmed dead-code reducer. CLIP_DELETE rides the identical signed, revocation-gated, firewalled content-op path as NOTE_DELETE → safe; no E2E/relay/forward-secrecy/reorg/firewall change. **Correction (changes the fix, not the verdict):** the op body must include `bucket = ops.timeBucket(capturedAt)` — `_applyClipDelete` erases via `clipsKey(body.bucket, obid)` and is a silent no-op without it, so it is not quite "pure reuse." The "8.1 ms @200" figure is plausible but ~9× the pure-decrypt floor; not load-bearing.

#### I-13 — Website honesty + accessibility one-liners
- **Impact:** MEDIUM (trust) / LOW (a11y) · **Effort:** S · **Kind:** functionality
- **Where / recommendations (each independent):**
  - **No-JS blank page:** add `<noscript><style>.reveal{opacity:1;transform:none}</style></noscript>` to the site `index.html` — without JS everything below the hero (`styles.css:315` `.reveal{opacity:0}`) is invisible.
  - **WCAG fail on install text:** lighten `--faint` #6b7682 → ~#7d8894 (`styles.css:13`) so the SmartScreen-bypass + SHA-256 verification lines pass AA (4.31:1 → ~5.2:1).
  - **og.png:** quantize to 256 colors → 130 KB → 52 KB, visually identical dark card.
  - **`llms.txt` claims discipline:** mobile "iOS and Android" → "in development"; align open-beta wording to the decided posture; "zero-knowledge" → "blind" (every repo doc deliberately uses "blind").
  - **Add the forward-secrecy bullet** to the site security section ("revoking a device rotates content keys — it cannot read anything created after") — newly true since `5b7ebf5` and the strongest differentiator.
- **Verifier verdict:** None (measured/code-derived).

> **Already done in the working tree (was a proposed quick win):** add `/mobile` to `pear.stage.ignore`. Confirmed present at `package.json:51` (also `/website`, `/dist`, `/flatpak`). This removes the ~16 GB mobile tree from the desktop stage payload. No action needed.

### 3.2 PROJECTS (high/medium impact, M–L effort)

#### I-14 — Reverse-pointer index for `indexObject`/`removeObject` (THE write-path fix)
- **Impact:** HIGH · **Effort:** M · **Kind:** speed
- **Where:** `backend/materialized-view.js:463–467` (`indexObject` clears stale tokens by streaming the **entire** `search!` family and string-matching `key.endsWith('!'+objectBlindId)`); same in `removeObject` `:486–489`. Call sites: `autobase-sync.js:1378` (`_applyNoteUpsert`), `:1382` (soft-delete-via-upsert with `texts:[]` still scans), `:1402` / `:1411` (`_applyNoteDelete`).
- **Recommendation:** Maintain a per-object reverse row (e.g. `searchrev!<objectBlindId>` / `searchobj!<objectBlindId>` listing that object's `tokenBlindIds`) in the same local-only bee. `indexObject` becomes: read 1 reverse row, `del` its k stale pointers, put k new pointers + 1 reverse row → O(tokens), not O(index). Seal one pointer envelope per object and reuse it for every token row (the plaintext is identical per object). Migrate by version-prefixing the family (`local-search-v1` is already version-named) or lazy rebuild on first open. Restores flat ~3–9 ms appendOp at any vault size and collapses the 50-burst tail.
- **Verifier verdict (CONFIRMED, high — re-derivation *strengthens* it):** Could not refute across all three area reports.
  - The full-family scan is the **sole** clearing mechanism (grep found no alternate path); it is ~98–99% of `indexObject` at scale (stubbing the scan drops 1500-note cost 44.45 → 0.58 ms/op).
  - Reverse-pointer prototype stays **flat at ~0.63 ms/op @1500** (≈70× faster, widening with vault size) and is **byte-identical** to the full-scan `search!` state across inserts, shrunk/changed token re-indexes (the stale-pointer case), and deletes.
  - **Security intact:** search core is `store.namespace(NAMESPACES.SEARCH='pearpaste:search').get({name:'local-search-v1'})` — a separate namespace, never passed to `store.replicate()`, never relayed (verified against `replication-firewall.js` / `relay-service.js`). The reverse row holds only blinded token IDs; no plaintext, no new sealed values, no keys.
  - **Correction (impact *understated*, not weakened):** the reducer re-runs `indexObject` for every historical NOTE_UPSERT during linearization, so a fresh device pairing into a 10 k-note vault pays **O(N²)** total scanning at initial sync, not just steady-state write cost.
  - *Note:* this is the same finding as I-8's storage win and is best delivered as one change (reverse row + marker/shared-envelope value).

#### I-15 — Destroy / hand-off the pairing connection after the bootstrap exchange
- **Impact:** HIGH · **Effort:** M · **Kind:** functionality
- **Where:** `backend/index.js:122–125` runs `if (isPairingConnection(info)) return` **before** `firewall.handleConnection`, so pairing conns never reach `store.replicate`; the conn stays classified pairing for the whole window (`index.js:148–168`). Joiner (`autobase-sync.js` ~`:2017`/`:2086–2145`) and approver (`approvePairRequest`, `:2208`) never `destroy()`/`end()` the conn (grep found none in the pairing flow). Hyperswarm 4.17 dedups on `remotePublicKey`, so the vault-topic join never produces a second replicating connection while the raw pairing conn lives.
- **Recommendation:** End/destroy the pairing conn once the bootstrap exchange flushes (joiner after `openBootstrap`+`saveLocalDevice`; source after the bootstrap write flushes / on peer close). Hyperswarm immediately redials via the vault topic and the firewall admits the peer in ~1 ms. Add an integration test that drives pairing through `createPearEnd` and asserts a post-pair note arrives **without** any manual reconnect.
- **Verifier verdict (CONFIRMED, high):** Reproduced the deadlock (`store.replicate` 0 both sides 32 s+, B `writable=false`) and the cure (forced destroy → B `store.replicate` 0→1, `base.length` 0→16, devices 0→2). Firewall returns `bootstrap`=admit for a fresh joiner, so the redial re-authenticates — security model unchanged. Suites miss it *more* than stated: `revocation-rotation.test.js:60–63`, `revocation-network.test.js:97`, and `multiwriter-convergence.test.js:60` all wire `swarm.on('connection')→store.replicate` directly (one even *comments* it is "the exact wiring index.js uses" — it is **not**); the only DHT pairing test stops at shortcode lookup. **Correction:** after the forced reconnect the base + device set fully converged but NOTE_LIST stayed 0 in the harness — a *separate* view/epoch-key materialization gap for a freshly-paired joiner (overlaps I-16); it does not weaken this finding. Mobile shares the bug (`worklet.mjs:21`).

#### I-16 — Gate durability retirement on durable indexing / heal receivers (pairing-window note loss)
- **Impact:** HIGH · **Effort:** M · **Kind:** functionality
- **Where:** `backend/autobase-sync.js:1598–1660` (`_reconcileDurability`; retire at `:1615–1616` once `presentStreak>=6` and past the 30 s window) with `_rowPresentFor` (`:1558–1576`) reading **only** the local committed view. `_pendingDurable` is populated only in `appendOp` (the local writer's path), so a receiver that never called `appendOp` has nothing to re-append.
- **Recommendation:** Keep the writer's pending entry alive until the row is observed on a checkpoint that reflects the **new indexer's acks** — *not* just N local presence passes — **or** adopt a receiver-side log-vs-view diff (any device re-appends rows present in its log but absent from its view).
- **Verifier verdict (CONFIRMED, high):** Reproduced — d1 appends right after pairing, both devices converge to identical `len` **and** identical `indexedLength`, yet only d1 has the note; d1 retires `_pendingDurable` to 0; **permanent** (survives a B engine restart); repairable one-shot (re-upsert heals B in ~29 ms). **Two corrections that change *how* to fix, not whether:**
  1. The finding's *primary* predicate — "gate on `base.indexedLength`" — is **insufficient**: in the repro the op was *within* both devices' `indexedLength` yet B still diverged. The fix must key on a checkpoint reflecting the new indexer's acks.
  2. The receiver-side alternative is the more robust shape but is **not trivially security-safe**: it must reuse the existing tombstone guard (`_rowPresentFor` treats tombstoned as present; the upsert reducer drops non-tombstone-beating ops) to avoid resurrecting deletes, **and** skip ops whose original signer is committed-revoked (else it bypasses the `_signerAuthorized` exclusion and breaches forward secrecy / the firewall). I-15 widens this hazard window from milliseconds to the lifetime of the stale pairing conn, so **fix I-15 first**.

#### I-17 — Implement (or remove) EXPORT/IMPORT_ENCRYPTED_BACKUP + add fresh-device restore test
- **Impact:** HIGH · **Effort:** M · **Kind:** functionality
- **Where:** `backend/rpc.js:40–41` + `:112–113` declare both commands + schemas; spec §15 (`PEARPASTE_TECHNICAL_SPEC.md:774–775`) and `PAIRING.md:165–166` promise them as the no-peer restore fallback; **no handler exists** (measured: 26/28 commands registered; calling either throws "no handler registered"). No bridge/UI method exists. RESTORE_VAULT has **zero** integration-test coverage over a network.
- **Recommendation:** Either implement the pair (sealed vault snapshot under a `rootSeed`-derived key mirroring the vault-store blob format) behind a Settings button, **or** delete the commands from `rpc.js` + the docs so the product stops promising a dead path. Add a 2-device testnet fresh-device-restore integration test (crib `revocation-rotation.test.js`). Total-device-loss recovery is the least-proven critical journey.
- **Verifier verdict (CONFIRMED, high):** 28 declared / 26 registered; the only two missing are the backup pair. Whole-repo grep finds the strings only in `rpc.js` + docs + the embedded mobile copies of `rpc.js` (no handler). `NAMESPACES.BACKUP='pearpaste:backup'` exists in `vault-store.js` but is referenced **nowhere** — an unused stub that reinforces the gap. Not redundant with mnemonic restore (mnemonic locates the vault but must **sync** content from a live peer/relay). EXPORT correctly stays out of `UNLOCKED_NOT_REQUIRED`; a sealed snapshot under a `rootSeed`-derived key preserves E2E + relay-blindness + forward secrecy. **Implementer note:** IMPORT is also `VAULT_LOCKED`-gated, so fresh-device restore must unlock-then-import (UX sequencing).

#### I-18 — Bound `_appliedOps` (unbounded full-op RAM mirror)
- **Impact:** MEDIUM · **Effort:** M · **Kind:** speed
- **Where:** `backend/autobase-sync.js:68` (Map), `:587–591` (`_rememberOp` stores `{...op}`), called for every node at `:841` and per accepted branch `:868–907`; only consumer is the verifier via `listReplicatedOps` (`:1700–1701`, `verifier.js:403–418`). Measured: 2001 entries = 3.49 MB / ~4.1 MB heap (~2 KB/op), mirrored on the receiver; a 50 k-op session ⇒ ~100 MB — material on Bare/mobile.
- **Recommendation:** Bound the map (LRU of the last 1–2 k content ops + always retain lifecycle ops); for full verifier coverage, have `listReplicatedOps` stream ops back out of the autobase log cores on demand (they are already durable there). Document the coverage semantics in the proof report.
- **Verifier verdict:** None (measured).

#### I-19 — Cache `_rebuildAuthFromView` on `(fork, version, auth-dirty)`
- **Impact:** LOW (desktop today) · **Effort:** M · **Kind:** speed
- **Where:** `backend/autobase-sync.js:834` runs at the start of **every** apply pass; `:686–816` full re-read (devices, vault-state, epoch-key wraps + per-own-wrap `crypto_box_seal_open`). Cost grows with devices and unpruned rotations forever (+~0.08 ms per rotation).
- **Recommendation:** Cache the rebuilt auth state keyed on `(view bee core fork, bee version-at-rebuild, an auth-family-dirty bit set when a lifecycle reducer wrote `devices!`/`vault-state`/`epochkeys!`, local-epoch-keys token)`. Any fork change, version regression, or dirty bit forces a full rebuild, so the reorg-safety contract (pure function of the committed truncation-aware view) is bit-for-bit preserved; content-only passes (the majority) skip it. Not urgent on desktop; do it before mobile ships or fleets accumulate rotations. (Subsumes I-4's free win.)
- **Verifier verdict:** None (measured).

#### I-20 — Maintenance "rebuild search index" for the local search core (the only safely compactable store)
- **Impact:** MEDIUM (storage) · **Effort:** M · **Kind:** functionality
- **Where:** projected 10 k-note vault ~220 MB, of which ~150 MB is the local search core (dominant); hyperbee blocks are append-only so every note edit churns ~16 KB of search rows.
- **Recommendation:** Add a maintenance op that truncates / new-generations the local search core and re-indexes from `scanNotes` — it is derived data, so this reclaims all churn without touching the reorg-safe rebuild or replication. **Do NOT** compact the replicated view/oplog (late joiners need full ops) — see §8. Land I-14 + I-8 first; they are the storage story (total drops to ~75 MB).
- **Verifier verdict:** None (measured).

#### I-21 — Pairing/admit-policy/restore product surface (engine-only features)
- **Impact:** MEDIUM · **Effort:** M · **Kind:** functionality
- **Where:** engine supports `setAdmitPolicy` (`autobase-sync.js:417`), `cosignDeviceAdd`/`cosignAdmitPolicy` (`:398–412`), `PAIR_APPROVE` accepting `{grantHistory, cosigs}` (`:2173`), and RESTORE_VAULT `highSecurity` (`index.js:359`) — but `rpc.js:96` declares `requestId` only, `bridge-client.js:165` passes `requestId` only, no ADMIT_POLICY RPC exists, and the desktop restore form never sends `highSecurity`. Under N≥2 the desktop UI could never complete an approval (no cosig path), and the SECURITY.md/PAIRING.md "explicit grantHistory" / "choose high-security" steps are impossible from any shipped UI.
- **Recommendation:** Either ship the surface (grant-history checkbox default-off, ADMIT_POLICY_GET/SET RPCs + Devices control, high-security restore toggle, cosig collection later) **or** annotate SECURITY.md §4.2 / PAIRING.md §4.1+§5 that these are engine-level controls without UI in 0.1.0. The Phase 6 docs honesty pass missed this reachability gap.
- **Verifier verdict:** None (code-derived).

#### I-22 — Revocation outcome legibility + self-revoke guard
- **Impact:** MEDIUM · **Effort:** S–M · **Kind:** functionality
- **Where:** DEVICE_REVOKE returns `{epoch, epochTag, evicted, evictionDeferred}` (`autobase-sync.js:2470`) but `performRevokeDevice` (`app.js:591–603`) ignores it; DEVICE_LIST (`:2358–2391`) carries no epoch/`isSelf`, so `devicesScreen` renders Revoke on the user's own row and the handler has no self-check — a self-revoke on a single-device vault rotates to `survivors=[]` and write-bricks it behind the B12 gate.
- **Recommendation:** Backend `NOT_AUTHORIZED` on `deviceId===self` (or require a second admin); DEVICE_LIST adds `isSelf` + current epoch; revoke banner differentiates "evicted" vs "eviction deferred until the device reconnects" and shows the new epoch.
- **Verifier verdict:** None (code-derived). *(The "show rotation outcome in banner" and "hide Revoke on self row" quick wins from the desktop report are folded in here.)*

#### I-23 — Mobile capture, parity, and test-transport gaps (grouped)
- **Impact:** MEDIUM · **Effort:** M (share-extension subtask L) · **Kind:** functionality
- **Where / recommendations:**
  - **Live-refresh:** `NotesScreen.js`/`ClipsScreen.js` have no event subscription — subscribe to `view-changed`/`sync-ready` exactly as `DevicesScreen.js:50–58` (delivered by I-9).
  - **Search + clip preview:** add a SEARCH field to NotesScreen (backend 2.2 ms/op) and tap-to-preview via CLIP_OPEN/CLIP_CLOSE.
  - **Share-sheet capture is a false promise:** `ClipsScreen.js:5` claims an OS share extension routes to CLIP_CAPTURE, but no share-extension target / `ACTION_SEND` intent-filter exists. Highest-value: Android `ACTION_SEND` text intent → CLIP_CAPTURE; then deep-link pairing (`pearpaste://pair?invite=…`, the `pairingInvite` path is already built but `App.js:94` passes no opts); iOS share extension via app-group later. Fix the comment regardless.
  - **Test transport mismatch:** `mobile/test/worklet-rpc.test.js` drives `mobile/rpc-commands.mjs` framing, but the device path is `worklet-rpc.mjs` + the PearRPC client (8-hex length-prefixed `{id,cmd,data}`) — the shipping framing (chunk reassembly, `sanitize()` at `worklet.mjs:57–66`) is untested; add a transport-faithful test and revoke/pair-over-bridge scenarios. Set `PEARPASTE_DISABLE_SWARM=1` in `test:mobile` for hermeticity (verified working).
  - **Housekeeping:** drop the unused `app.bundle.js` output from `bundle-bare.mjs` and delete the file (3.6 MB, imported by nothing); delete the self-labelled TEMP `console.log` blocks (`MobilePearEnd.js:222–233`, `:275`); fix three stale claims (`worklet-rpc.test.js:10–18`, `ClipsScreen.js:5`, `BUILD.md`).
- **Verifier verdict:** None (mixed code-derived/measured). *(The cancellable-autoseed item I-10 is the big mobile speed win; the bundle-staleness and variant-split alarms are refuted — see §9.)*

#### I-24 — Public-source-link + release-posture truth (launch blockers)
- **Impact:** HIGH (trust) · **Effort:** S (links) / M (Windows binary) · **Kind:** functionality
- **Where / recommendations:**
  - **Dead source links:** `github.com/bigdestiny2/pearpaste` → 404 while downloads are public; the live site links it from 5 surfaces and the hero copy is "Don't trust us. Read the code." Make the repo public before advertising downloads (land the README/docs honesty pass first), or change copy to "source opening at public beta" and drop the dead links. An auditability-positioned product with 404 source links is worse than one promising source later.
  - **Out-of-repo Windows binary:** the public `PearPaste-Setup.exe` is an unsigned, unauditable .NET launcher self-identifying as v1.0.0 (app is 0.1.0), served from the site repo, bypassing the repo's own release-guard CI (which only inspects `dist/`). Commit the launcher source, build it in `release.yml`, publish with at least a minisign signature; fix the embedded version; add a provenance note ("runs `pear run <link>`"). Verifier (CONFIRMED, high): RELEASE.md §3 marks unsigned native installers "internal/dev only" and the guard "fails closed"; the z32 key on the page matches this repo's production verlink; this repo's *own* `website/index.html` is the honest counterpart (no `.exe`, "Runs on Pear"). The fix is orthogonal to the cryptographic model.
  - **Mutable unreleased channel:** `pear info` shows release "Unreleased"; the site distributes the unversioned link, so every `pear stage production` instantly changes what all users run. Mark a Pear release (or distribute the versioned verlink) to pin v0.1.0; regenerate `RELEASE_NOTES_0.1.0.txt` (currently committed with unfilled `pear://<production-key>` placeholders) from a real `release-prod.sh` run.
- **Verifier verdict:** Windows-binary sub-item CONFIRMED high (binary fingerprints measured in the site repo, outside the audit root — taken on trust but internally consistent). Source-link/posture sub-items measured/code-derived.

#### I-25 — Verify, or rewrite, the `--verify-encryption` proof command
- **Impact:** LOW · **Effort:** S · **Kind:** functionality
- **Where:** the flag `paste --verify-encryption` is shown in the site proof mock, `SECURITY.md §3.2`, and the in-app proof screen (`app.js:1139`), but **no code parses it** (zero hits outside docs/UI).
- **Recommendation:** Either wire it in `index.js`, or change all three surfaces to the real `node scripts/verify-encryption.js <storage>` (the `npm run verify` script already exists at `package.json:70`).
- **Verifier verdict:** None (code-derived).

#### I-26 — Spec §12/M4 global-hotkey paste palette (currently absent)
- **Impact:** MEDIUM · **Effort:** M · **Kind:** functionality
- **Where:** spec `:641–642` + `:950–954` promise a global hotkey + paste palette; `ui/desktop/app.js:1285–1306` `setupTray` is explicitly "decorative"; no OS-global shortcut is registered anywhere.
- **Recommendation:** This is the marquee interaction for a clipboard manager (copy → hotkey → palette). If `pear-electron` exposes `globalShortcut`, wire a minimal palette (recent clips + enter-to-copy); otherwise record the platform limitation in the README TODO so the spec promise is tracked, and ship tray-menu quick actions as the interim.
- **Verifier verdict:** None (code-derived).

#### I-27 — Investigate superlinear note ingest before claiming "10,000 notes"
- **Impact:** LOW · **Effort:** M · **Kind:** speed
- **Where:** 1,000 sequential NOTE_UPSERTs = 15.8 ms/op; a 10,000-op ingest was still inserting at ~12.5 min when terminated — superlinear ingest growth (the site stat band states the spec §3 target as fact). Largely the same root cause as I-14 (indexObject) plus autobase linearization.
- **Recommendation:** Land I-14 first, then re-measure; build a 10 k fixture once offline and commit the real number, or soften the site stat to "instant local search." Note the §8 caveat against coalescing appendOps into one batch as a shortcut.
- **Verifier verdict:** None (measured).

---

## 4. Speed Section

**The headline:** local write throughput is gated by exactly one thing — the `indexObject` full-family scan (**I-14**) — and everything else is either healthy or a small constant.

- **Dominant:** I-14 (indexObject O(total search rows) per note write; 85–94% of write cost; O(N²) at cold sync). Every other write cost is dwarfed by it at scale. Three independent area reports converged on this and the same reverse-pointer fix; verifiers prototyped it at 45–70× with byte-identical output.
- **Per-apply-pass constants worth trimming** once I-14 lands: epochkeys double-read (**I-4**, 2.9×), reducer Argon2id (**I-7**, 76 ms off KEY_ROTATE), `_rebuildAuthFromView` caching (**I-19**), redundant genesis re-add (**I-6**).
- **Read-path:** NOTE_LIST re-decrypts all rows regardless of limit (**I-5**, −66% warm); tap-to-decrypt is already <0.1 ms — leave it.
- **RAM:** `_appliedOps` grows unbounded (**I-18**) — material only on long-lived mobile sessions.
- **Shutdown:** the relay auto-seed hang (**I-10**) is the single biggest teardown cost (~20 s) and dominates the mobile suite.
- **Already healthy — do not touch beyond committing the WIP:** seal/open (micro-scale; itemKey LRU explicitly **not worth it**), append serialization / wait-for-writable (commit the event-driven WIP, **I-2**), apply-pass view batching (verified 4.8× — keep as-is), the replication firewall (~1 ms — keep it on; publish the numbers so nobody reaches for the kill-switch), the idle converge pump (~30 µs/s), steady-state topic set (2 topics/device, churn-free), canonicalize (best alternative only 1.2× and risks signature-byte divergence).

Networking is event-driven at the engine layer; the *perceived* slowness is purely the missing UI event (**I-9**), the stale pairing conn (**I-15**), and PAIR_CREATE_INVITE serializing 5–8 s of relay warm-up before the DHT announce (run the swarm join concurrently — a quick win folded into the network work).

---

## 5. Functionality Section

**Two silent data-loss bugs are the most important functionality findings**, both invisible to the green suites:

- **I-1 (Lamport restart):** first edit of any existing note after an app restart is silently dropped against its own LWW history. Tests stay green because they edit within one process lifetime.
- **I-16 + I-15 (pairing-window loss):** a note written during the pairing window is permanently missing on the new device — compounded by the stale pairing conn (I-15) that starves first sync entirely. Suites stay green because they wire `store.replicate` directly, bypassing the production pairing path.

**Promised-but-dead paths:**
- **I-17:** EXPORT/IMPORT_ENCRYPTED_BACKUP — declared, documented, schema'd, **no handler**; the only documented no-network recovery route throws.
- **I-12:** clip sweeper never runs → 24 h erasure promise is unfulfilled; Phase 5 tombstone path is wired and idle.
- **I-21:** grantHistory / N-of-M admit policy / high-security restore are engine-only, presented as user capabilities.
- **I-25:** `--verify-encryption` flag is shown in three places, parsed nowhere.
- **I-26:** spec's global-hotkey paste palette is absent (tray is decorative).

**UX correctness:**
- **I-9:** no live refresh on sync (desktop + mobile).
- **I-11:** re-pair revoked-device warning is computed then stripped by the bridge sanitizer.
- **I-22:** revoke outcome invisible; no self-revoke guard (can write-brick a single-device vault).
- Note-editor / search-box lose in-progress input on any global re-render (`render()` rebuilds the tree; editor keeps state in closure locals only). Write edits through to `S.open.data` on input and gate the `onEvent` render to the current view. Also make id-less sealed rows non-clickable with a "Cannot decrypt on this device" hint instead of falling into the new-note editor. *(Desktop report, code-derived; bundle into the I-9 UI work.)*
- **I-13 / I-24:** website honesty (no-JS fallback, WCAG, dead source links, mutable release channel, out-of-repo Windows binary).

---

## 6. Verdict on the uncommitted `LocalSearchIndex.search` WIP diff

**KEEP — with the `bee.peek` probe (I-3).**

- **Correctness is verified:** result-set equality on 14 query shapes (dup terms, missing terms both orders, rare+common, single-term). Dedupe is AND-idempotent-safe; `terms.length>=1` guarantees `perTerm[0]`; intersection is commutative so smallest-first is result-identical; the sole caller (`notes-service.js:333–337`) ignores `row.envelope` and order, so the WIP's different envelope source and ordering are inert (only nuance: with >limit matches a different arbitrary 50 may be returned).
- **Performance:** dup×4 terms 2.37 ms vs 10.12 ms committed (**4.3×**); hit-cases ~1×.
- **The one regression:** first-term-missing query 3.17 ms WIP vs 0.03 ms committed — it loses the committed early-exit (grows ~linearly, ~30 ms at 10 k notes).
- **The fix (I-3):** a `bee.peek` existence probe per term before the scans restores **0.04 ms no-hit queries in both term orders** (beats committed, which only early-exits when the missing term is first) while keeping every WIP win.

Per the crypto-storage auditor + verifier: the change is correct and security-neutral (local-only bee, tokens stay blinded). **Verdict: KEEP the diff, ADD the peek probe (I-3), then commit.** *(Crypto-storage note: this `search()` optimization may already be committed at git `0969316` — if so, only I-3 remains.)*

---

## 7. Do-NOT-Do (optimizations that would endanger the security model)

- **Do NOT compact or truncate the replicated view/oplog cores.** Late joiners need the full op history to reconstruct the authz/epoch state and to satisfy the verifier's signature-preimage coverage. Only the **local, never-replicated** search core is safely compactable (**I-20**). (Crypto-storage finding.)
- **Do NOT prune `epochkeys!` or `tombstone!` rows.** They are correctness anchors (forward-secrecy wrap set re-validation per `materialized-view.js:324–353`; delete-resurrection guards) and are tiny (~0.24 MB / ~0.6 KB each). Keep them forever.
- **Do NOT coalesce same-tick appendOps into one `base.append` batch as a shortcut** for the ingest problem (I-27/I-2). The append serialization is a *proven concurrent-append-drop fix*; only evaluate batching after I-14, and only if Autobase's array-append contract is verified against that fix's assumptions.
- **Do NOT make the durability reconciler heal receivers naively (I-16).** A receiver-side "re-append rows in my log but not my view" loop **must** reuse the tombstone-present guard (or it resurrects deletes) **and** skip ops whose original signer is committed-revoked (or it bypasses `_signerAuthorized` and breaches forward secrecy / the firewall).
- **Do NOT turn off the replication firewall for performance.** It costs ~1 ms/connection (µs-level crypto); publish the numbers instead. (Network finding — explicit.)
- **Do NOT add the itemKey LRU "for speed."** It saves ~2 µs/op (invisible against the 10.7 ms write) and adds a key-lifetime surface for no benefit; the one genuine repeat-derivation hotspot disappears with I-14's seal-once-per-object.
- **Do NOT widen the bridge event sanitizer to pass objects (I-11).** Flatten to scalars instead — the object-stripping at `desktop-bridge.js:110` is a renderer-safety boundary, not a bug to relax.
- **Do NOT switch ciphertext from hex to base64/raw without a versioned op/envelope gate.** The hex string is inside the **signed preimage** (`crypto-envelope.js:332–334`); changing it unversioned breaks signature verification of all existing ops. Only as a deliberate format-versioning exercise (with legacy-open retained).
- **When deferring the local epoch-key blob persist out of the reducer (I-7), keep per-save salt randomization unless deliberately chosen otherwise.** A fixed per-device salt is exactly the legacy scheme — acceptable, but make it a decision, not a side effect.

---

## 8. (Reserved — merged into §7 above.)

---

## 9. Rejected / Refuted Appendix (verifier killed these — `isReal=false` or `worthIt=false`)

These were demoted to keep the plan honest. Each is followed by the refutation.

### R-1 — "Mobile worklet bundles predate the security build → a mobile build ships without forward secrecy" — **REFUTED (isReal=false, impact none)**
The auditor measured the wrong file. `mobile/backend/` has **three** bundles: a generic `app.bundle.js` (May 22, dead) and `app.ios.bundle.js` + `app.android.bundle.js` (**Jun 10, current**). The shipping per-platform bundles carry epochTag 113 / grantHistory 9 / admitPolicy 9 / NETWORK_STATUS 7 / tombstone 25 / DEVICE_REVOKE 21 / KEY_ROTATE 17. The runtime loads only the per-platform bundles (`MobilePearEnd.js:33` → platform shim → `app.ios/android.bundle`); the `/app.bundle` string at `:202` is just the virtual path label. The committed iOS bundle's RPC-surface sha256 matches the current `rpc.js`. The "symptoms" (RelayProofScreen showing 0/0; pre-epoch DEVICE_REVOKE) are false because NETWORK_STATUS and the epoch rotation are present. *Residual (cosmetic):* a byte-level `--check` flags the bundles "stale" due to bare-pack non-determinism, with all security content identical — regenerate to silence the guard if desired. **Drop the "ship-without-forward-secrecy" alarm.**

### R-2 — "Variant split is inverted; all build automation lives in the dead RN-CLI variant" — **REFUTED (isReal=false, worthIt=false)**
The repo is already wired the way the finding *recommends*. `mobile/pearpaste-expo/package.json` has `bundle:bare` + `bundle:bare:check` + `preandroid`/`preios`; `scripts/bundle-bare.mjs:72–86` prefers the Expo bare-pack. The Expo config plugin `pearpaste-expo/plugins/pearpaste-bare-worklet.js` (registered in `app.json:39`) injects the iOS `pre_install` bare-link hook (lines 148–151) **and** Android `pearpasteBundleBareWorklet` wired to `preBuild`. `BUILD.md:3` declares Expo canonical and demotes PearPasteMobile to "legacy/reference host." The cited stale `ios/Podfile`/`android/` are generated, git-ignored output (`.gitignore:4–5`), regenerated by `expo prebuild`. The finding's cited `bundle-bare.mjs:7` is an import line, not the resolver. *Residual:* tidy-up only (demoted-but-present PearPasteMobile tree, a stale local generated Podfile) — no build-blocking gap, no security impact.

### R-3 — "Bridge shell-integration contract dead; backgrounded-clear never fires; Monitor no-op; writeToOS lies" (as a HIGH finding) — **REFUTED on its central claim (isReal=false; impact LOW)**
The visibility/background-clear chain **is** wired in production: wire verb exists (`desktop-worker.mjs:57` → `desktop-worker-protocol.js:16–17` → `bridge.setVisibility`), renderer exposes it (`bridge-client.js`), and `app.js:178–199` calls `bridge.setVisibility` on blur/focus/visibilitychange. The cited security test drives the **real** protocol handler (not a `ctx.emit` shortcut) and passes 6/6; `clipboard.test.js` 10/10. The finding misread its own cited `app.js` lines. *What survives, but only LOW:* (2) desktop Monitor clipboard mode is a genuine silent no-op (no prod code sets `ctx.osClipboard`; `startMonitor` early-returns) — a no-op settings toggle, nothing leaks; and (3) the headless `writeToOS` returns `ok:true` in the rare fallback when `navigator.clipboard.writeText` is absent (Chromium renderer normally has it). **Kept as honest-UX polish, folded into the I-13/desktop quick wins ("disable Monitor when headless; headless writeToOS → ok:false"); the spec §9.4 background-clear path provably works.** *Correction to that polish: the recommendation's claim that the UI already receives `_backendHeadless` is wrong — it is excluded from the settings getter, so a headless flag must first be surfaced through status.*

### R-4 — "README misstates the just-shipped security model (no forward secrecy / no two-instance test)" — **REFUTED (isReal=false, worthIt=false)**
Built on a stale snapshot. The cited strings exist **nowhere** in the current tree. The README's "Forward-looking revocation" section (lines 109–111) already states the correct thing ("Revocation rotates future content keys…"), authored ~14.5 h *after* the revocation build. README was edited by three post-build Jun 10 commits. `website/` is **not** removed (it exists, untracked). The one true sub-claim — `sec-doc-claims.test.js` doesn't lint README — is low-value defense-in-depth, not a HIGH problem, since the README already states the model correctly (nothing stale for a lint to catch). **Drop the "flip the false caveats" work; optionally add README to the doc-lint as cheap insurance.**

### R-5 — Quick wins already applied in the working tree (no action)
- **`'unlocked'` relay auto-seed lacks the `seeded.has` guard** → already guarded at `relay-service.js:856` (`if (rstate.seeded.has(vaultLogKey)) return`). Confirmed during synthesis.
- **Add `/mobile` to `pear.stage.ignore`** → already present at `package.json:51` (with `/website`, `/dist`, `/flatpak`). Removes ~16 GB from the desktop stage payload. Confirmed.

---

## 10. Cross-Reference Index

| ID | Title | Impact | Effort | Kind |
|---|---|---|---|---|
| I-1 | Lamport high-water restore on reopen | HIGH | S | func |
| I-2 | Commit event-driven perf WIP | MED | S | speed |
| I-3 | `bee.peek` probe in search | MED | S | speed |
| I-4 | Epochkeys scanner stream-value | MED | S | speed |
| I-5 | RAM memo blindId→objectId for lists | MED | S | speed |
| I-6 | One-shot rebuild before genesis self-add | MED | S | func |
| I-7 | Argon2id out of KEY_ROTATE reducer | MED | S | speed |
| I-8 | Marker value for search rows (−4× storage) | HIGH | S | func |
| I-9 | `view-changed` UI event | HIGH | S | func |
| I-10 | Cancellable relay auto-seed | HIGH | S | speed |
| I-11 | Scalar re-pair revoked warning | HIGH | S | func |
| I-12 | Clip sweeper hard-delete | HIGH | M | func |
| I-13 | Website honesty + a11y one-liners | MED/LOW | S | func |
| I-14 | **Reverse-pointer search index** | HIGH | M | speed |
| I-15 | Pairing-conn teardown | HIGH | M | func |
| I-16 | Durability retirement gate / receiver heal | HIGH | M | func |
| I-17 | EXPORT/IMPORT backup + restore test | HIGH | M | func |
| I-18 | Bound `_appliedOps` | MED | M | speed |
| I-19 | Cache `_rebuildAuthFromView` | LOW | M | speed |
| I-20 | Rebuild-search-index maintenance | MED | M | func |
| I-21 | Admit-policy/grantHistory/restore surface | MED | M | func |
| I-22 | Revoke legibility + self-revoke guard | MED | S–M | func |
| I-23 | Mobile capture/parity/test-transport | MED | M | func |
| I-24 | Public source link + release posture + Win binary | HIGH | S/M | func |
| I-25 | `--verify-encryption` wire-or-rewrite | LOW | S | func |
| I-26 | Global-hotkey paste palette | MED | M | func |
| I-27 | Superlinear ingest investigation | LOW | M | speed |

**Suggested execution order:** I-1 → I-15 → I-16 (the data-loss trio, I-15 before I-16) → I-9 → I-14+I-8 (the write/storage fix) → I-10 → remaining quick wins (I-2..I-7, I-11..I-13) → I-17 → projects.
