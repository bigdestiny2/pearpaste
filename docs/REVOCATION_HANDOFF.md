# Revocation Implementation — HANDOFF

**Date:** 2026-06-09 · **Branch:** `total-review-followups` · **Repo:** `bigdestiny2/pearpaste` (private)
**Status:** Phases 0–3 DONE + verified + pushed. **Phase 4 (pairing selective-chain + admit policy) is the immediate next step.**

> Read this first, then `docs/REVOCATION_DESIGN.md` (the full design + 7-phase plan + adversarial red-team findings). Continue the per-phase loop below.

---

## 1. Mission
Make device revocation REAL: a revoked device must lose READ access to content created **after** its revoke (forward secrecy). Originally `KEY_ROTATE` was a cosmetic counter — a revoked device kept the vault key + replicated history + the unchanged discovery topic, so it could read past AND future content. The fix: **per-epoch content keys**, freshly minted on revoke, sealed (`crypto_box_seal`) only to the **surviving** devices.

**Honest scope (already proven, keep it honest in docs):** forward secrecy YES. Past-erasure NO (the revoked device keeps what it already replicated). Replication-denial only where the user controls the relays (see SB2). Survives recovery-phrase compromise NO (phrase = root → new vault needed).

## 2. Current state
| Phase | What | Status | Commit |
|---|---|---|---|
| 0 | Crypto core: epoch-bound keyId/AAD, `topicSeedFromEpochKey`, byte-compat | ✅ green | `02d154a` |
| 1 | Epoch plumbing (epochTag-keyed), lazy migration (epoch-0 = vaultKey), reorg-safe rebuild | ✅ green | `d9076e6` |
| GATE | 2 ship-blocker testnet probes | ✅ both failed-as-designed; fixes folded into P2/P3 | — |
| 2 | KEY_ROTATE rewrite + DEVICE_REVOKE — **real rotation + forward secrecy** | ✅ green (decisive test 3×) | `5b7ebf5` |
| 3 | Discovery-topic rotation + REPLICATION FIREWALL + relay re-seed + follow-topic | ✅ green (SB2 incorporated) | `aa6a72f` |
| **4** | **Pairing: selective-chain-by-default + N-of-M admit** | ⏭️ **NEXT (not started)** | — |
| 5 | Durability reconciler (epoch-faithful) + tombstones | ⬜ pending | — |
| 6 | Docs honesty pass (SECURITY/THREAT_MODEL/PAIRING) + fold in GATE findings | ⬜ pending | — |

**Green baseline (sandbox OFF, Node 22):** unit 44/44 · integration 21/21 (×2) · e2e 3/3 · security 25/25 · mobile 4/4 · lint clean.
**Current HEAD:** `aa6a72f` (P3) → `07f0fe9` (handoff doc) → `e136187` (lint) → `5b7ebf5` (P2) → `f2df0c2` (build-box Flatpak spike) → `d9076e6` (P1) → `02d154a` (P0).

**Phase 3 outcome (what the next phases build on):**
- **NEW `backend/replication-firewall.js`** — the SB2 load-bearing control. `store.replicate(conn)` is gated on a signed `pp-repl-auth` protomux credential (session-bound: device records carry NO swarm pubkeys, so the design's "onauthenticate keyed to the device set" was impossible — a signed handshake was the forced deviation). On DEVICE_REVOKE it actively `conn.destroy()`s live streams to the revoked device. Bootstrap allowance (empty committed set = fresh joiner), relay allowance (honest L2 ciphertext channel), `PEARPASTE_REPL_FIREWALL=off` kill-switch.
- `index.js` reconciles a topic SET: epoch-aware vault topic (epoch 0 byte-compat), own follow-topic always joined, surviving peers' follow-topics announced for 24h after a rotation (never the revoked device's), grace 0. `state.joinedTopic` kept as a mirror for the sec-local-auth test.
- `followSeed` fallback until Phase 4 delivers a real one at pairing: `hkdf(vaultKey,'follow-seed-v1')` (`index.js followSeedCurrent`) — Phase 4 MUST put the random `followSeed` in the bootstrap and keep this fallback for legacy.
- Reducer emits `device-revoked` from `_applyDeviceRevoke` (signal-only, like `epoch-rotated`) so EVERY survivor's firewall destroys streams; engine gained `isDeviceAllowed(deviceId, signingPubkey)`.
- `relay-service.js`: `epoch-rotated` → unseed + re-seed under `HMAC(topicSeed,'log-disco-v1')`, SB2-commented as cosmetic vs connected peers; `isRelayPeer()`; `seedVault` passes `discoveryKey` through.
- Tests: `test/integration/revocation-network.test.js` (testnet, 2 tests / 23 asserts) — topic_1 underivable, destroy-existing + refuse-new, follow-topic catch-up, honest L2.

## 3. Per-phase workflow — FOLLOW EXACTLY
1. Spawn a focused **opus** subagent (background) with the phase brief; design doc as spec.
2. When it lands, **independently re-run the FULL suite yourself** (sandbox OFF). Do NOT trust the agent's report alone — a subagent's final message can be lost to a transient rate-limit; verify from the working tree (`git status`, `git diff`, lint, full suite).
3. **Review the diff** — especially `autobase-sync.js` and any off-brief file touches (confirm deviations are justified; Phase 2's `index.js` touch was a legitimate epoch-key-persistence need).
4. **Commit.** Author MUST be `bigdestiny2 <33146784+bigdestiny2@users.noreply.github.com>`. `git config user.email` is set to it — but **VERIFY it before every commit** (a denied Bash once swallowed the `git config` and produced a stray `defidon@protonmail.com` commit that needed an amend+force-push).
5. **Rebase onto origin + FAST-FORWARD push:** `git fetch origin total-review-followups && git rebase origin/total-review-followups && git push origin total-review-followups`. **NEVER force-push** — the Windows/Linux **build boxes share this branch** (they push glibc docs, the Flatpak spike, etc.). Their files are disjoint from the backend code, so rebases are clean. Update task state.

## 4. Verification — CRITICAL
- **Sandbox OFF** on every test / git-push Bash: `dangerouslyDisableSandbox: true`. The engine binds UDX sockets; the sandbox EPERMs on socket bind so tests never reach the assertions.
- **Node 22.** Commands: `npm run test:unit | test:integration | test:e2e | test:security | test:mobile`, `npm run lint`.
- For engine/network phases, run **integration 2–3×** to confirm determinism. New tests MUST use the deterministic **`@hyperswarm/testnet`** harness (`createTestnet`), NOT the live DHT — live-DHT multi-device convergence is flaky (it bit the decisive test until switched to the testnet).

## 5. GATE findings (empirical: real `@hyperswarm/testnet` + live HiveRelay, Autobase 7.28.1)
Both auxiliary controls FAILED as the design first wrote them; **the core forward-secrecy guarantee is UNAFFECTED** (it rests entirely on content-key rotation).
- **SB1 — DONE (folded into Phase 2):** `removeWriter` on an **OFFLINE** indexer deterministically FREEZES the base's `indexedLength` (the durable checkpoint); the "ensure another live indexer first" mitigation is insufficient (the *removed* device must be online to ack the indexer-set migration). FIX: eviction DECOUPLED from rotation — `removeWriter` is host-side best-effort gated on `_isWriterLive`, skipped+deferred when offline; the reducer **reject-committed-revoked-signer (B12)** is the load-bearing primary write-exclusion (gate on "revoked at all", closing the backdated-lamport hole). ✅ SB1-regression test green.
- **SB2 — for Phase 3:** relay `unseed`/`revocable` is **COSMETIC** against an already-connected peer (Hypercore replication streams persist through `swarm.leave`; `p2p-hiverelay-client.unseed()` only broadcasts a msg, never closes a stream). The per-connection **REPLICATION FIREWALL is the SOLE real control**, and it MUST **actively `conn.destroy()` existing streams to revoked peers on DEVICE_REVOKE**, not just refuse new ones. Topic rotation is a discovery convenience, not an exclusion barrier (a revoked device can still dial the immutable Autobase core key). Honest residual **L2**: a third-party non-firewalled relay keeps serving the OPAQUE post-revoke ciphertext — decrypt stays blocked by rotation.

## 6. NEXT — Phase 4 agent brief (see §3 workflow + the subagent-write gotcha in §9)
> Implement PHASE 4 (pairing bootstrap: selective-chain-by-default + admit policy — RT-FIX B1). Phases 0–3 are committed: rotation gives forward secrecy, the replication firewall + epoch topics + follow-topics handle the network layer. Phase 4 closes the RE-ADMISSION hole: today `approvePairRequest` hands a new device the FULL key chain, so a re-paired previously-revoked device (fresh identity, same phrase) regains everything.
>
> READ FIRST: `docs/REVOCATION_DESIGN.md` §3.8 + §5.8 + Phase 4 plan (§8). Then `backend/autobase-sync.js` (`approvePairRequest` ~:1294-1316 region, `_appendDeviceAdd`, the committed device cache), `backend/pairing.js` (`sealBootstrap`/`openBootstrap`), `backend/vault-store.js` (`saveLocalDevice` epochKeys/followSeed pass-through, §5.9), `backend/index.js` (`followSeedCurrent` fallback — Phase 4 must DELIVER a real random `followSeed` in the bootstrap and keep the fallback for legacy vaults), `docs/REVOCATION_HANDOFF.md` §2 Phase 3 outcome.
>
> IMPLEMENT: (1) SELECTIVE-CHAIN BY DEFAULT — the bootstrap carries ONLY the current `activeEpochTag` key (+ `activeEpoch`/`activeEpochTag` + `followSeed`); `vaultKey`/older epoch keys ride ONLY behind an explicit, separately-confirmed `grantHistory` flag (default OFF). NB: `vaultKey` is also `indexKey`-adjacent material the joiner NEEDS to operate (blind ids) — check what the bootstrap minimally requires and keep the design's intent: no RETROACTIVE CONTENT access without `grantHistory` (epoch-0 content key == vaultKey, so if vaultKey must ship for indexKey/ops reasons, gate epoch-0 CONTENT another way and say so honestly). (2) ADMIT POLICY — per-vault N-of-M admin co-sign on `DEVICE_ADD`; lone self-admit rejected when policy N≥2; default N=1 single-admin (documented exposure). (3) "Looks-like-previously-revoked" warning when the joiner's box/sign pubkey matches any revoked record. (4) Deliver random `followSeed` at pairing; persist via `saveVaultSecrets`.
>
> TESTS (deterministic `@hyperswarm/testnet`, template `test/integration/revocation-rotation.test.js`): fresh device reads post-rotation but NOT pre-rotation content unless `grantHistory`; a re-paired previously-revoked device (fresh identity) cannot read content from its revoked interval (B1 decisive); lone self-admit rejected under N=2; warning fires on pubkey match.
>
> VERIFY (sandbox OFF, Node 22): FULL suite green + lint; integration 2×. Don't regress pairing e2e, the firewall, relay-blindness.
>
> CONSTRAINTS: edit `backend/autobase-sync.js`, `backend/pairing.js`, `backend/vault-store.js`, minimally `backend/index.js`. Do NOT touch crypto-envelope.js/shared-ops.js. Do NOT implement Phase 5. Do NOT git commit. RETURN: per-change summary with file:line, the bootstrap payload before/after, how `grantHistory` gates history, the admit-policy enforcement point, FULL per-suite tallies (integration 2×), deviations.

## 7. Phases 4–6 (specs from the design's implementation plan)
- **Phase 4 — Pairing selective-chain-by-default + admit policy (RT-FIX B1):** invert the unsafe full-chain default in `approvePairRequest` (autobase-sync.js) — a new/re-paired device gets ONLY the current `activeEpoch` key; full history is an explicit `grantHistory`; N-of-M admin co-sign on DEVICE_ADD; "looks-like-previously-revoked" warning. Tests: fresh device reads post-rotation but NOT pre-rotation unless `grantHistory`; a re-paired previously-revoked device (fresh identity) can't read its revoked-interval content; lone self-admit rejected under N≥2. Files: `autobase-sync.js`, `pairing.js`, `vault-store.js`.
- **Phase 5 — Durability reconciler (epoch-faithful) + tombstones (B4, B9):** `_reconcileDurability` re-appends under the entry's ORIGINAL `epochTag` (not `activeEpoch`); durable `tombstone!` family (the Phase-1 skeleton) honored by `_rowPresentFor` + the reducer (no resurrection of deletes); suppress re-append for epoch ≤ revoked during the migration window. Tests: fresh-writer rollback re-appends under the original epoch; cross-device delete not resurrected; re-appended row has no linkable keyId; reorg truncating the KEY_ROTATE tail recomputes identical epoch state. Files: `autobase-sync.js`, `materialized-view.js`.
- **Phase 6 — Docs honesty pass:** rewrite `SECURITY.md` §4.2 / `THREAT_MODEL.md` §2.3 / `PAIRING.md` §5 to the IMPLEMENTED guarantee (forward-decrypt-only; replication NOT stopped where relays aren't firewalled; phrase compromise needs a new vault); correct the `removeWriter` "no-op" claim; add residuals L1–L7. Fold the GATE findings into `docs/REVOCATION_DESIGN.md`. Files: `docs/`.

## 8. Key technical context
- **Epoch model:** `engine.epochKeys` = Map keyed by **epochTag** (`''`→vaultKey is the epoch-0 lazy-migration anchor); `engine.activeEpoch` (monotone int, max-merge) + `engine.activeEpochTag`. ALL rebuilt from the committed view each `_apply` pass in `_rebuildAuthFromView` (reorg-safe, alongside the device cache). Keys are addressed by **epochTag, NEVER the integer epoch** (integer collides under concurrent rotations — RT-FIX B5).
- **`_bodyOrNull(op)`** (autobase-sync.js): reducer-safe decrypt wrapper. A device lacking an op's epoch key (the revoked one permanently; any device transiently behind) stores the SEALED row + skips the local plaintext index instead of throwing `AEAD_FAIL` out of `_apply` (which crashed the Autobase drain). ALL content + lifecycle `_apply*` handlers use it; READ paths (`NOTE_OPEN`) still throw `AEAD_FAIL` to their own caller.
- **Decisive test:** `test/integration/revocation-rotation.test.js` — the 6-assertion forward-secrecy test + the SB1 regression test. Template for network/rotation tests (testnet-based, deterministic).
- **Byte-compatibility is the hard gate:** every EXISTING vault is epoch 0 / epochTag `''` / epochKey == vaultKey; existing tests passing UNCHANGED is the compat proof.
- **Key engine symbols:** `_apply`, `_makeOp`, `_body`/`_bodyOrNull`, `_rebuildAuthFromView`, `_applyDeviceRevoke`, `_makeKeyRotateOp`, `_signerAuthorized`, `_isWriterLive`. **Crypto:** `seal`/`open`/`openWithObjectId({epochKey,epochTag})`, `keyIdFor`, `topicSeedFromEpochKey`. **View:** `epochkeys!` family by epochTag, `listEpochKeyWrapsFor`, `tombstone!` skeleton. **Identity:** `sealToDevice` (crypto_box_seal).

## 9. Gotchas / lessons
- **BACKGROUND subagents cannot WRITE in this environment** — their Edit/Write permission prompts auto-deny (proven on the first Phase 3 attempt: the agent did all the analysis, then was blocked on every write). Either run the phase in the MAIN session (Phase 3 was done this way, worked fine) or spawn the agent in FOREGROUND so permission prompts reach the user.
- Verify `git config user.email` = the noreply before EVERY commit.
- Never force-push (shared branch) — rebase + fast-forward.
- Subagent reports can vanish to rate-limits → verify from the working tree.
- New tests use the testnet, not the live DHT.
- Review agent deviations (off-brief file touches); the decisive test exposed a REAL bug (`_bodyOrNull`) that the agent fixed — running the full suite per phase is what caught it.
- Untracked files from other sessions/boxes appear (`docs/launch/LAUNCH_KIT.md`, `scripts/build-flatpak.mjs`) — don't bundle them into phase commits.

## 10. Parked non-revocation threads (context only)
- **Going-public A/B decision** — the revocation work UNBLOCKS the confidentiality blocker.
- **Desktop installers** `.dmg`/`.exe`/`.deb` — build boxes active (Flatpak spike, glibc 2.32+ docs); exact `pear build --<platform>-app` arg still finicky.
- **Production link** `pear://u6oyh38gcn3ouk6wnzpoetzpeg7gs1w5s9f5aw5quocr1eubsoiy` staged + seeding (this Mac is the seeder).
- **Website** live on **www.paste.global** (separate repo `bigdestiny2/paste-site`; Vercel; SEO/LLMSEO done). paste-site commits NEED the noreply email or Vercel silently won't deploy.
