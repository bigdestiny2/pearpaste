# PearPaste — Expert P2P Team Review

**Date:** 2026-06-08
**Scope:** Full-stack review by 5 area specialists (P2P core, Crypto/Security, Desktop, Mobile, Build/Release/Docs) plus a dedicated relay specialist who verified and applied fixes.
**Repo:** `/Users/localllm/Downloads/pearpaste`

---

## 1. Executive Summary

**Overall health: strong core, not yet release-ready.** PearPaste is a genuinely well-architected E2E-encrypted P2P notes/clipboard app. The cryptographic core, the relay-blindness design, and the single-Corestore/single-Hyperswarm sync discipline are all real, correct, and well-tested. The encryption marketing claims are backed by code (real XChaCha20-Poly1305 AEAD, real BIP-39 24-word recovery, no telemetry, blind relay export scanning). The relay layer was independently verified end-to-end and is in excellent shape after fixes.

**Shippable as a private beta? Yes, with conditions — and NOT as a public release.** The single-device happy path, encryption-at-rest invariants, and local-first behavior are solid enough for a controlled private beta where the operator understands the limits. But genuine multi-device/multiwriter behavior has correctness defects with no integration-test coverage, two documented security guarantees (key rotation / revocation forward secrecy) are not actually implemented, a prominent desktop feature (clipboard monitor) is silently dead, the mobile variant story is inverted (the build-verified shell can't run the current app), and there is no working signed release path or real download target. A private beta is defensible **if** the do-now items below are fixed and the doc/marketing overclaims are corrected first; a public launch is not.

### Top 5 Risks

1. **Multiwriter authorization state corrupts on concurrent writes (P2P, Critical).** The in-memory device/authorization set is mutated incrementally inside Autobase `apply()` and never reset before a re-apply, so an Autobase reorg/undo leaves device/root/epoch/revocation state reflecting rolled-back-plus-re-applied state rather than a pure function of the final log. Risk: device-set divergence, forks, rejection of legitimate ops (data loss). No two-instance test exists to catch it.
2. **Newly paired device silently drops its first writes (P2P, Critical).** `appendOp()` calls `base.append()` before the new writer seat linearizes; Autobase throws "Not writable" and the note/clip is lost (not queued). Directly hits the core onboarding flow.
3. **Documented forward-secrecy / revocation guarantees are not implemented (Crypto + P2P, High).** `KEY_ROTATE` only bumps a counter that is never read on the content path and never feeds key derivation; a revoked device retains `vaultKey`/`indexKey` and full read access to all past and future content. SECURITY.md / PAIRING.md / THREAT_MODEL.md overstate this. Either implement real epoch-bound rotation or correct the docs before shipping copy that claims post-rotation secrecy.
4. **Mobile variant strategy is inverted and unverified (Mobile, High).** The shared `mobile/app` hard-imports Expo modules, so only `pearpaste-expo` can render it — but every verified-build claim in BUILD.md is about `PearPaste­Mobile` (RN-CLI), which would redbox at module load. The Expo iOS Podfile has no bare-link hook (native addons crash at runtime) and there is no Expo bundle-regen step, so the committed worklet bundles are stale (missing `NETWORK_STATUS`). Neither shippable shell is actually release-verified as committed.
5. **No working signed release path and no real download (Build/Release, High).** Windows signing targets a wrong/nonexistent exe name+path; `release-prod.sh` invokes `pear init --wrapper`, which the repo itself documents as removed; the CI "unsigned-artifact" gate early-exits on an empty `dist/` and never inspects anything; and the website badges macOS "Available" with a dead `#get` button and no `pear://` link, .dmg, or installer anywhere.

---

## 2. Relay Verdict

**Final status: `working-great`** (verification status was `working-with-caveats`; all recommended fixes were then applied and the status was upgraded).

The relay specialist reviewed `backend/relay-service.js` (~880 lines), the empty-by-default config layer, the pin/probe scripts, all three relay integration tests + harness, `docs/RELAY_CUSTODY.md`, and the **real installed `p2p-hiverelay-client@0.9.2` source**. The relay layer holds end to end.

**What was verified:**

- **Config resolution (end-to-end):** Three-tier `loadFleetConfig()` — bundled `config/fleet-relays.js` (priority 3) → `<storage>/fleet-relays.json` (priority 2) → `PEARPASTE_RELAYS` env (priority 1, `knownRelays`/WSS-bridge pinning only). Each layer independently try/caught. Env override and file override both confirmed working; malformed per-install JSON logs `fleet-config-storage-bad` and continues. `foundationPubkeys` validated as 64-hex + deduped. Bundled config is empty across all three fields → pure HyperDHT auto-discovery. Local-first use is never blocked by config.
- **Silent fallback:** Three independent degrade paths (absent optional dep, import failure, `client.start()` failure) each set `degradedReason` and return `{ok:false, local:true}` no-ops. No relay path throws. Confirmed by integration tests AND by a real backend boot that auto-discovered and connected to a **live 8-relay fleet with empty config** and completed `relay-seed-done`.
- **Blindness (rigorous):** The only two outbound app-payload calls — `client.seed()` and `client.publishCustodyIntent()` — are BOTH preceded by `assertCiphertextOnly()` + `recordRelayExport()`, unconditionally, before the client check (so even the degraded path proves the payload was clean). `assertCiphertextOnly()` recursively walks nested objects/arrays and scans serialized JSON for the plaintext sentinel. Other client calls send only public identifiers. PVSS `splitForCustody`/`publish` are never used by the app. Live-fleet blindness tests (#24/#25) pass.
- **Real 0.9.2 API match:** Advanced-mode constructor sets `_ownsSwarm=_ownsStore=false`; `destroy()` only tears down owned resources (so the shared Hyperswarm/Corestore survive) and removes only its own `connection` listener — the teardown contract is honored. All method signatures and event payloads match relay-service usage.
- **Custody receipts:** TTL/expiry and ciphertext-root binding are correct; `getCustodyStatus()` compares the relay's reported root to ours and flags `receiptsMatchRoot=false` on mismatch (never silently trusts). Quorum failure keeps the clip local.
- **Tests:** `test:integration` 12/12 (90/90 asserts, then 96/96 after new assertions). `test:unit` 34/34 (166/166). Security suite 23/25 — **the 2 failures are in the notes/reducer layer, not relay**, and are NOT sandbox/EPERM issues (proven pre-existing by stash-and-rerun on baseline).

**What was fixed (4 changes, all low-risk, nothing skipped; left in working tree on `main`, not committed):**

1. **(Medium) Hardened `RELAY_FORBIDDEN_KEY_RE`** (`backend/relay-service.js:36`) — the blindness guard was an enumerated deny-list, so generically-named fields (`secretKey`, `secret`, `seed`, `password`, `privateKey`, `masterKey`) and user-content names (`tag`/`tags`/`content`) would have passed. Added those as standalone tokens. Mechanically verified against the full allow-list and forbidden-list: zero regressions — `appKey`/`discoveryKey`/`keyHex`/`ciphertextRoot`/`replicas`/`privacyTier`/`retainUntil` etc. still pass (the `/i` flag's `[^a-z]` boundaries exclude A–Z, so `key`/`seed`/`content` don't match inside compounds). Note: the original recommendation's claim that adding `seed` would newly flag `seedTimeoutMs` was **wrong** — verified it is not matched.
2. **(Low) `seeded` event field fix** (`~line 307`) — log now reads `e && (e.appKey || e.key)`; the real client emits `{key,...}`, so the diagnostic previously logged `appKey:undefined`.
3. **(Low) Bootstrap observability** (`config/fleet-relays.example.json` + `~line 207`) — `bootstrap[]` is silently ignored in advanced mode (only consumed when the client owns the swarm). Added a `_bootstrapNote` to the example and a `relay-fleet-bootstrap-ignored` warn gated on `fleet.bootstrap.length > 0`.
4. **(Low) Paired unit coverage** (`test/integration/relay-seed.test.js`) — extended the blindness test with rejection cases for `{secretKey}`, `{secret}`, `{password}`, nested `{note:{tags:['a']}}`, `{content}`, plus a positive case asserting safe identifiers still pass.

**Tests after fixes:** `test:integration` 12/12 (96/96), `test:unit` 34/34 (166/166), `node --check` + JSON validation + `standard` lint all clean. Hard invariants preserved: empty-default DHT auto-discovery untouched, silent degradation untouched, blindness strengthened (purely additive) and never weakened.

**Residual caveats:**

- `RELAY_FORBIDDEN_KEY_RE` is now broader but still fundamentally an enumerated deny-list, not a structural guarantee. The real defense remains the upstream envelope discipline (everything outbound is already ciphertext) + the sentinel scan + the export-mirror verifier. No current payload uses any forbidden field; this is hardening against future refactors.
- `bootstrap[]` remains a no-op in Pear-native advanced mode by design (the swarm is owned by the Pear-end); it is now annotated and logged rather than wired in.
- `publishTemporaryCustody` (Atomic Blind Custody) is complete, correct, blindness-guarded, and fully tested, but has **no production caller yet** — staged on `ctx.relay` for future clipboard-custody wiring. When wired, write-custody endpoints need a Bearer `apiKey` on relays ≥0.9.1 (reads are permissionless); `publishTemporaryCustody` already threads `opts.apiKey`.

---

## 3. All Findings by Severity

**Severity counts:** Critical: **2** · High: **8** · Medium: **7** · Low: **12** · (Info: 5)
*Relay findings below reflect post-fix state: the 1 Medium and the actioned Lows were fixed; remaining relay items are info-only.*

### Critical (2)

| Area | Title | Location | Recommendation |
|---|---|---|---|
| P2P core | In-memory device/authorization set is never reset before an Autobase re-apply, so concurrent writes (reorg/undo) corrupt authorization state | `backend/autobase-sync.js:42-48, 199-280, 304-387` | Make authorization state a pure function of the linearized log each `_apply` pass: rebuild `devices`/`writerToDevice`/`rootPubkey`/`keyEpoch` from scratch by scanning the view's own sealed device records (which roll back with the view), or persist device/epoch state INTO the Autobase view so truncation rolls it back. Add a two-instance concurrent-write convergence test. |
| P2P core | Newly paired device loses its first writes: `appendOp()` calls `base.append()` before the device writer seat has linearized | `backend/autobase-sync.js:496-501, 191-193`; `notes-service.js:219,228,293,404` | Await writability with a bounded poll (`base.writable` + `base.update()`/`scope.sleep`) or use `base.append(op, {optimistic:true})` for the device's own ops until confirmed writable; surface a typed retryable error instead of raw "Not writable". Add a paired-device test doing `NOTE_UPSERT` right after `PAIR_ACCEPT`. |

### High (8)

| Area | Title | Location | Recommendation |
|---|---|---|---|
| P2P core | Device revocation does not rotate keys or enforce the epoch, so a revoked device retains full read access to all past and future content | `backend/autobase-sync.js:244-250, 293-302, 1147-1159`; `backend/crypto-envelope.js:142-153` | Implement real rotation (new content key per epoch, key `itemKey` by epoch, re-key new writes under the new epoch sealed only to authorized devices), OR downgrade the documented/UI guarantee to "prevents future writes / removes writer seat". At minimum enforce `keyEpoch` on content ops and document that historical content is not protected from a previously-trusted device. |
| P2P core | Clipboard contents are never cryptographically erased: `CLIP_DELETE` is implemented in the reducer but no RPC ever emits it | `backend/autobase-sync.js:267-269, 453-458`; `backend/notes-service.js:233-321`; `backend/rpc.js:30-34` | Add a clip sweeper mirroring `sweepExpiredNotes` that appends `CLIP_DELETE` (with the correct bucket) for clips past `expiresAt`, plus a `CLIP_DELETE` RPC for explicit deletion. Enforce `expiresAt` in `CLIP_OPEN`/`CLIP_COPY` so an expired clip cannot be reopened. |
| Crypto/Security | `KEY_ROTATE` epoch is cryptographically inert — documented forward-secrecy / post-rotation guarantees overstate the implementation | `backend/autobase-sync.js:46,244-256`; `backend/crypto-envelope.js:142-153`; `docs/SECURITY.md:181-198`; `docs/PAIRING.md:186-200` | Either (a) fold `keyEpoch` into content-key derivation + header epoch + reducer epoch gate so post-rotation writes genuinely cannot be produced/decrypted, or (b) correct SECURITY.md §1.2/§4.2, PAIRING.md §5, THREAT_MODEL.md §2.3 to state the load-bearing control is the reducer lamport gate. Do not ship copy claiming post-rotation content secrecy until (a) lands. |
| Desktop | Backend `backgrounded` plaintext-clear + clipboard-monitor pause never fire in the real desktop runtime (bridge contract drift) | `backend/desktop-bridge.js:59-62`; `ui/desktop/app.js:177-184`; `backend/desktop-worker.mjs:50-76`; `test/security/sec-access.test.js:138-150` | Make visibility a first-class wire message: add a reserved `__visibility` verb alongside `__clipboard` and have `app.js` call it over the pipe on blur/focus/visibilitychange so the worker emits `ctx.emit('backgrounded'|'foregrounded')`. Add an e2e test that drives the clear THROUGH the worker pipe. Fix the misleading `sec-access.test.js` comment. |
| Desktop | Clipboard "Monitor" mode is non-functional on desktop — worker always resolves the headless in-memory backend | `backend/clipboard.js:56-71, 198-205`; `backend/desktop-worker.mjs:45`; `backend/index.js:67`; `ui/desktop/app.js:1163-1167` | Either implement monitor mode in the renderer (where `navigator.clipboard` exists) and drive backend settings from there, or inject an OS clipboard backend into the worker's `ctx`. Until then, hide/disable the "Monitor clipboard" option so the UI doesn't promise a dead capability. |
| Mobile | Committed worklet bundles are stale (missing `NETWORK_STATUS`); the canonical Expo build ships them unregenerated | `mobile/backend/app.bundle.js`, `app.ios.bundle.js`, `app.android.bundle.js` (all 2026-05-22) vs `backend/rpc.js` (2026-05-24); `pearpaste-expo/android/app/build.gradle` | Add a bare-pack worklet-regeneration step to the Expo build (mirror RN-CLI's `pearpasteBundleBareWorklet` for Android + an Xcode build phase for iOS), OR add CI that fails if `app*.bundle.js` is older than any file in the worklet import graph. Regenerate and recommit the three bundles now. |
| Mobile | Variant strategy inverted: the build-verified shell (RN-CLI) cannot run the current shared app, and the app-capable shell (Expo) is not release-verified | `mobile/app/screens/PairScreen.js:19`, `mobile/app/App.js:20`, `mobile/app/lib/ui.js:16`; `pearpaste-expo/ios/Podfile`; `mobile/BUILD.md` | Pick ONE canonical variant (Expo, since it matches `app/`) and delete/deprecate `PearPasteMobile`. Rewrite BUILD.md against it, including the currently-missing Expo iOS bare-link addon hook. If RN-CLI must stay, gate the `expo-*` imports behind a platform/feature shim. |
| Build/Release | Windows signing targets a wrong/nonexistent exe name and path — Tier 2 signed release will fail | `scripts/build-windows.mjs:188-192` | Derive the exe path from the actual Pear app name (or add a `productName` override), and point signtool at the real `bin\<App>-app\<App>.exe` produced by `pear stage --win32-x64-app`. Add a smoke test that globs for the staged binary rather than hardcoding the name. |
| Build/Release | `release-prod.sh` native-wrapper steps use `pear init --wrapper`, which the repo itself documents as removed | `scripts/release-prod.sh:209-222` | Rewrite the macOS/Windows sections to the current Pear flow (stage the channel to get the `pear://` link, then `pear stage <link> --darwin-… / --win32-x64-app <wrapper>`); correct the app-bundle/exe names. Or delete the stale heredoc and point to `docs/RELEASE.md §3` as the single source of truth. |
| Build/Release | Website has no real download/install target and badges macOS "Available" with a dead button | `website/index.html:274,331,368,61-62` | Populate `#get` with the real install path (install Pear runtime + `pear run pear://<key>`, with the actual production link) and downgrade macOS to a "Pear runtime" badge until a notarized `.app` exists, or gate the site behind "coming soon". |

### Medium (7)

| Area | Title | Location | Recommendation |
|---|---|---|---|
| P2P core | Local search index is mutated inside the reducer but lives on a separate (non-Autobase) core, so it is not rolled back on reorg and drifts from the view | `backend/autobase-sync.js:86-100, 409-436`; `backend/materialized-view.js:269-303` | Rebuild the search index from the view after each flush (treat it as a derived cache off the converged view), or move indexing into a post-update reconciliation pass so undo is reflected. |
| P2P core | Note search does not index the `label` field, so users cannot find notes by the name they assigned | `backend/autobase-sync.js:414`; `backend/notes-service.js:204` | Index `label`: `texts = body.deletedAt ? [] : [body.label, body.title, body.body, ...(body.tags||[])]`. Backfill on next upsert; consider a one-time reindex on open for legacy vaults. |
| P2P core | Per-write search reindex scans the entire search keyspace inside the reducer — O(total tokens) per op, O(N²) on sync catch-up | `backend/materialized-view.js:274-302` | Maintain a reverse index (e.g. `objtok!objectBlindId!tokenBlindId -> 1`) so clearing an object's pointers is O(tokens-for-that-object). Keep this work off the linearizer if possible. |
| Crypto/Security | Reducer rethrows on a malformed replicated op, halting the apply batch (sync-wedge by an authorized writer) | `backend/autobase-sync.js:205-220, 273-279` | Validate op shape before use and `continue` (drop) instead of throwing: guard that `op.envelope` is an object with string `ciphertext`/`nonce` and `op.aadHash`/`op.signature`/`op.signerPubkey` are present; log `op-rejected: malformed`. Keep the batch-level catch only for genuinely unexpected errors. |
| Crypto/Security | Root-seed / passphrase-wrap KDF uses Argon2id INTERACTIVE (64 MB) while the threat model claims "moderate" | `backend/crypto-envelope.js:121-122,102-104`; `backend/vault-store.js:102,150-151`; `docs/THREAT_MODEL.md:84-88,170` | Decouple the two uses: keep INTERACTIVE for the mnemonic→rootSeed path (entropy makes it irrelevant), but raise the local-device passphrase wrap to MODERATE/tuned cost on desktop, storing the chosen opslimit/memlimit in the v2 kdf record. At minimum correct THREAT_MODEL.md §2.4 to say "interactive (64 MB)". |
| Mobile | RPC test validates a transport the device never uses; the real wire format + worklet boot-gate error paths are untested | `mobile/test/worklet-rpc.test.js:45-56` vs `mobile/app/lib/MobilePearEnd.js:56-142`, `mobile/backend/worklet.mjs:29,49-55` | Either unify the device onto `rpc-commands.mjs` `createRpcServer`/`createRpcClient` (one framing) so the test covers production, or add a Node-runnable test driving the real `WorkletRPC`/`PearRPC` framing + worklet boot-gate handlers and delete the unused `bare-rpc`/`COMMAND_IDS` machinery. Fix the BUILD.md coverage claim. |
| Mobile | Lock-state desync: the backend `locked` event never flips the UI gate back to locked, and `lockOnBackground` is never enabled | `mobile/app/App.js:94-99`, `mobile/app/lib/usePearPasteRpc.js:35-44,69-76` | Surface a `locked` flag from the backend `locked`/`unlocked` events in `usePearPasteRpc` and reset the `App.js` gate when the backend reports locked; wire a real `lockOnBackground` option + idle timeout if lock-on-background is a product promise. |
| Mobile | `expo-camera` is a static unguarded import, contradicting the documented graceful-degrade-to-manual-entry claim | `mobile/app/screens/PairScreen.js:19`; metro `OPTIONAL_STUBS` (both configs); `mobile/BUILD.md:108,227` | Guard the camera import like QRCode (lazy `require` + try/catch, render manual-entry fallback when absent), or drop the graceful-degrade claim and make `expo-camera` a hard documented requirement; update stale camera-kit comments and metro stubs. |
| Build/Release | CI "unsigned release artifact" guard never inspects artifacts on a real release (early-exits on empty `dist/`) | `.github/workflows/ci.yml:299-303,321-322` | Wire a real release job that runs the platform build, uploads to a known artifact dir, and runs the signature check against THAT dir (not an always-empty default). At minimum remove the misleading `RELEASE_ARTIFACTS: ""` and document that the gate is inert unless a release workflow populates artifacts. |
| Build/Release | Android-critical patches are root-only with no mobile/CI coverage that they reach the shipped bundle | `patches/device-file+2.3.1.patch`, `patches/fs-native-extensions+1.5.0.patch` | Add a CI lane (or a step in `mobile-app`) that runs root `npm ci` (triggering patch-package) before the bare-link/bundle step and asserts the patched lines are present in the linked addon, or vendor the patches into the mobile build. Document the root-install prerequisite in `mobile/BUILD.md`. |
| Relay *(fixed)* | `RELAY_FORBIDDEN_KEY_RE` was an enumerated deny-list, not a structural guarantee — generic secret field names would not be caught | `backend/relay-service.js:35-36` | **FIXED:** added `seed`/`secret`/`privatekey`/`secretkey`/`masterkey`/`password`/`passwd` + `tag`/`tags`/`content` tokens, mechanically verified zero allow-list regressions, paired with new unit coverage. |

### Low (12)

| Area | Title | Location | Recommendation |
|---|---|---|---|
| P2P core | Reducer stamps replicated metadata (`deletedAt`/`createdAt`/`revokedAt`) with local `Date.now()` rather than op-authoritative time, causing cross-device metadata drift | `backend/autobase-sync.js:433, 355, 383` | Carry authoritative timestamps in the op body (or derive from `h.createdAtBucket`/`lamport`) and store those, so every device materializes identical records. Never let `Date.now()` in the reducer land in a replicated/sealed value. |
| P2P core | Lock-to-unlock race: `engine.close()` is fire-and-forget on scope while `openEngine()` may run concurrently without awaiting the pending close | `backend/autobase-sync.js:626-631, 598-623` | Track the close promise on the engine and have `openEngine()` await any pending close before opening (serialize open/close through one mutex/queue). |
| P2P core | Clip update under a changed time bucket leaves a stale duplicate row in the old bucket (no LWW/dedup for clips) | `backend/autobase-sync.js:439-451`; `backend/materialized-view.js:150-160` | If clip updates are possible, look up any existing row for the obid across buckets and delete the stale one, or store the canonical bucket in `objmeta`. Otherwise document clips as immutable add-only and assert `clipId` uniqueness. |
| Crypto/Security | Pairing confirmation phrase is ~20 bits and derived solely from the joiner's hello; MITM safety rests entirely on the user comparing 6 digits | `backend/pairing.js:198-206`; `backend/autobase-sync.js:778-782,1019-1045` | Keep the SAS design but consider widening to ~30+ bits (8 digits or a word pair); ensure the UI hard-blocks bootstrap acceptance until the user affirmatively confirms a match; optionally bind the inviter's identity into the SAS. Defense-in-depth. |
| Crypto/Security | Fixed application-wide KDF salt for the root seed (no per-vault salt) | `backend/crypto-envelope.js:102-104`; `backend/identity.js:26,85-89` | No code change required (determinism constraint + 256-bit mnemonic entropy). Document in SECURITY.md §4.1 / THREAT_MODEL.md that the root-seed Argon2id salt is a fixed app-wide constant by design and security rests on the mnemonic's entropy, not the salt. |
| Desktop | Worker logs serialized response byte-length for every RPC, leaking plaintext size for `CLIP_COPY`/`NOTE_OPEN` | `backend/desktop-worker.mjs:73` | Drop the `bytes` field for content commands, or gate the `rpc-res` log behind a debug flag that is off in release builds. |
| Desktop | Renderer ignores the `backend-crash` event the bridge emits — a dead worker leaves no recoverable UI state | `ui/shared/bridge-client.js:88-98`; `ui/desktop/app.js:153-173` | Add a `backend-crash` branch in `app.js` `onEvent` that sets a recoverable state (banner + reconnect/relaunch affordance), mirroring the existing `NO_BRIDGE` fallback. |
| Mobile | Unused all-host bundle and `PearPasteMobile/App.tsx` template are dead release artifacts | `mobile/scripts/bundle-bare.mjs:11-14`; `mobile/PearPasteMobile/App.tsx` | Drop `app.bundle.js` from `bundle-bare.mjs` and from git (keep only the two platform bundles actually resolved); delete or replace `App.tsx` to avoid confusion about the real entry point. |
| Mobile | iOS background plaintext-drop relies on an unverified bare-kit suspend assumption with no JS fallback | `mobile/backend/worklet.mjs:99`; `mobile/app/lib/usePearPasteRpc.js:63-68` | Add a JS `AppState` backstop: on transition to background/inactive send an explicit RPC (close-all-open or a dedicated `DROP_OPEN`) so plaintext is dropped even if the native suspend event is missed; at minimum document this as a verified-on-device assumption. |
| Mobile | BUILD.md has drifted from the actual metro config | `mobile/BUILD.md:106,221` vs both `metro.config.js` | Refresh BUILD.md against the chosen canonical variant: correct the `watchFolders` description, document the Expo build path, align test-coverage and graceful-degrade claims with the code. |
| Build/Release | Stale marketing stats on the website undercut the "audit it yourself" positioning | `website/index.html:124-125` | Remove hardcoded counts or generate them from the tree at build time; fix the fake clone URL to the real repository path. |
| Build/Release | "View/Read the source" links point to a GitHub user profile, not the repository | `website/index.html:115,333,360` | Point all source links at the actual repository URL and make the demo clone URL match. |
| Build/Release | Duplicate Pear config (`pear.json` vs `package.json#pear`) drifts — two sources of truth | `pear.json:27-33` vs `package.json:36-48` | Keep a single Pear manifest. Pear reads `package.json#pear` when present; remove `pear.json` (or vice-versa) and update `scripts/release-prod.sh:99` which copies `pear.json` into the staged mirror. |
| Build/Release | `engines.node >=20` conflicts with the documented/CI-pinned Node 22 | `package.json:101-102` | Raise `engines` to `>=22` to match what is tested/shipped, or add a Node 20 CI matrix entry so the declared floor is actually exercised. |
| Relay *(fixed)* | `seeded` event handler reads `e.appKey` but the real 0.9.2 client emits `{key,...}` | `backend/relay-service.js:294` | **FIXED:** now reads `e && (e.appKey || e.key)`. |
| Relay *(fixed)* | `bootstrap[]` fleet-config field is silently ignored in Pear-native (advanced) mode | `backend/relay-service.js:273` | **FIXED:** annotated the example JSON and added a `relay-fleet-bootstrap-ignored` warn when `bootstrap[]` is set. |

### Info (5, non-blocking)

| Area | Title | Location |
|---|---|---|
| Crypto/Security | Dead `open()` stub and per-op `aadHash` recomputation — minor hygiene/perf, not security | `backend/crypto-envelope.js:218-228`; `backend/autobase-sync.js:226` |
| Desktop | Top-level `await import('pear-electron')` at renderer module scope is a single point of load failure (currently handled defensively) | `ui/desktop/app.js:29` |
| Build/Release | Website proof screen implies a default log scan the bundled verifier does not perform unless `--log` is passed | `website/index.html:236`; `scripts/verify-encryption.js:150-161` |
| Relay | Two security-suite tests fail, both OUTSIDE the relay layer and NOT sandbox-related | `test/security/sec-auth.test.js:286` (#10), sealed-list test (#2) |
| Relay | `publishTemporaryCustody` (Atomic Blind Custody) has no production caller yet (staged for future clipboard custody) | `backend/relay-service.js:382` |

---

## 4. Per-Area Findings

### 4.1 P2P data/sync core
*(Autobase multiwriter, Corestore/Hyperbee, materialized view, lifecycle/teardown)*

**Summary:** The sync core is well structured — one Corestore + one Hyperswarm owned by `index.js`, a namespaced `VaultStore`, a single crypto-envelope source of truth, sealed-at-rest Hyperbee views, and a `LifecycleScope` that drains loops before closing resources. The single-writer happy path is coherent and the encryption invariants (public-only headers, AAD binding, blind IDs, no plaintext at rest) are enforced. But genuine multi-device/multiwriter behavior has several correctness and safety defects not covered by any test (no test replicates two real Autobase instances).

**Key strengths:**
- Single-Corestore / single-Hyperswarm discipline correctly enforced; replication wired once via swarm connection → `vaultStore.store.replicate` (`index.js:76-79`) and Autobase rides the corestore.
- Encryption-at-rest invariant centralized: view values go through `crypto.seal`, headers gated by `assertHeaderPublicOnly` before append (`autobase-sync.js:154`), AAD binds `vaultId`/`objectBlindId`/`opType`/`schema`, op signatures cover `header,ciphertext,nonce,aadHash` with an anti-splice `aadHash` recheck in the reducer.
- Deterministic genesis-root resolution: first `DEVICE_ADD` carries `rootPubkey` replayed identically on every device.
- `LifecycleScope` is a solid cancellation primitive (cooperative sleep, abort-signal, drain-then-dispose LIFO) with a Bare-compatible `AbortController` shim.
- Lock teardown wipes vault keys, clears open-item timers/plaintext, and `engine.close()` nulls `base`/`view`/`search` with `_opened` flipped first to fence the convergence loop.
- Tap-to-decrypt lifecycle correctly scoped: list handlers never return body/title; open handlers cache one item with a visibility timer cleared on lock/close/background.

**Findings:** 2 Critical, 2 High, 3 Medium, 3 Low (see severity tables above). The two Criticals (authorization-state-not-reset-on-reorg, paired-device-first-write-loss) and the two Highs (inert revocation key rotation, never-emitted `CLIP_DELETE`) are the headline multiwriter/lifecycle defects.

### 4.2 Cryptography & Security
*(crypto-envelope, identity, verifier, pairing, BIP39, vault-store key handling, security tests, threat model)*

**Summary:** The cryptographic core is well-built and mostly correct. AEAD choice (XChaCha20-Poly1305-IETF with 24-byte random nonces — no nonce-reuse risk at the birthday bound), HKDF-over-keyed-BLAKE2b KDF, Argon2id PW-KDF, Ed25519 signing, libsodium sealed-box pairing bootstrap, AAD domain separation, and the anti-splice `aadHash` check are all sound and well domain-separated. The BIP39 wordlist is the exact canonical English list (sha256 `2f5eed53…` verified). The local-device secret blob is AEAD-wrapped with a random per-file Argon2id salt (v2). The single most important gap between docs and implementation is `KEY_ROTATE`: the epoch counter is tracked but cryptographically inert.

**Key strengths:**
- AEAD discipline correct: fresh 24-byte CSPRNG nonce per `seal()`; verified two seals of identical plaintext produce distinct nonces/ciphertext.
- Strong domain separation: distinct HKDF info labels per key; `itemKey` binds `item:`+itemId; verified `vaultKey != indexKey`.
- AAD binds each envelope to `{vaultId, objectBlindId, opType, schema}` and the reducer independently recomputes and compares before trusting an op (AAD splice fails both the AEAD tag and the signature preimage).
- Op signatures genuinely cover replay-relevant fields; `canonicalize()` is a deterministic recursively-sorted JSON encoder.
- BIP39 correct and canonical (verified hash, 256-bit entropy + checksum, NFKD).
- Pairing bootstrap secrecy is real: vault keys sealed to the joiner's Curve25519 box pubkey via `crypto_box_seal`, released only after a signed `pp-pair-hello` verifies AND a local human approval fires; the signed hello binds `writerKey`/`boxPubkey`/`signingPubkey`.
- Invite expiry enforced at the single decode chokepoint and again on the responder; fast-fails <5s.
- Relay-blindness verifier is structurally honest: assumption-free byte-grep for the sentinel over storage + relay-export mirror + logs, plus a "looks-encrypted" anti-smuggling check; never fabricates a pass and always emits the "does not prove physical deletion" limit line.
- Local-device wrapper hardened to v2 with a random per-file Argon2id salt; high-security restore correctly does not persist keys, unlock, or join the topic.

**Findings:** 1 High (inert `KEY_ROTATE` / overstated docs — the load-bearing revoked-device reducer gate IS real and well-tested), 2 Medium (malformed-op sync-wedge; Argon2id INTERACTIVE vs documented "moderate"), 2 Low (~20-bit SAS confirmation; fixed app-wide root-seed salt), plus 1 Info (dead `open()` stub).

### 4.3 Relay / availability layer
*(HiveRelay encrypted availability + Atomic Blind Custody + DHT auto-discovery)*

**Summary:** See Section 2 for the full verdict. The relay layer is well-built; config resolution, silent fallback, and blindness all hold, verified against the real `p2p-hiverelay-client@0.9.2` source and a live 8-relay fleet. **Final status `working-great`** after 4 low-risk fixes.

**Key strengths:** Three-tier config with independent try/catch per layer; empty-default pure-DHT auto-discovery; three independent no-op degrade paths that never throw; both outbound app-payload calls unconditionally guarded by `assertCiphertextOnly()` + `recordRelayExport()` before the client check; recursive nested-field scanning; real-client teardown contract honored (shared swarm/store preserved); custody receipts bind to our ciphertext root and flag mismatches; quorum failure keeps clips local.

**Findings (post-fix):** the 1 Medium (enumerated deny-list) and the 2 actioned Lows (`seeded` field, `bootstrap[]` no-op) were fixed; 2 Info items remain (out-of-scope notes/reducer test failures routed to that owner; `publishTemporaryCustody` has no caller yet — expected per the phased design).

### 4.4 Pear/Electron desktop app
*(root entry, renderer↔worker bridge, RPC surface, clipboard, sealed-row rendering, lifecycle/CSP)*

**Summary:** Security-critical surfaces are mostly sound: CSP locked to local-only assets (zero remote calls); the RPC boundary is schema-validated, lock-gated, and guarded by `assertRendererSafe` (no key/secret/mnemonic egress); sealed list rows never render bodies and the single decrypted item is rendered via `createTextNode` (no XSS even from a malicious paired-device note); lock clears plaintext on both backend and renderer; worker logs never include params or plaintext. But there is a real teardown/contract-drift gap and a non-functional feature, both from the same architectural fact: under Pear the renderer reaches the Bare worker only through `bridge.request()` plus the `__clipboard` verb, so anything exposed as a plain method (`setVisibility`) or expected to be injected on `ctx` (`osClipboard`) doesn't exist in the real runtime.

**Key strengths:**
- CSP correctly hardened (`default-src 'none'`; `script-src 'self'`; `connect-src 'self'`; `img-src 'self' data:`); fonts/QR/noise all local/inline.
- Sealed rows render only metadata; the decrypted item is inserted via `createTextNode`; body `innerHTML` is never used for content.
- `assertRendererSafe` recursively blocks key/seed/secret/passphrase/mnemonic from crossing to the UI, with a deliberate one-time mnemonic exception only at `CREATE_VAULT`.
- Lock path correct end-to-end: `LOCK_VAULT → lock() → ctx.emit('locked')` clears backend `openItems` AND renderer state.
- Worker wire protocol logs only command name/id/ok/error-code/byte-length, never params or result bodies.
- `copyClip` returns plaintext for OS-clipboard only, nulls its local reference immediately, and schedules a 60s auto-clear that only clears if unchanged.
- QR generation safe: `qrcode-svg` never echoes the invite string into markup.

**Findings:** 2 High (the `backgrounded` clear never fires in production — partially mitigated by the renderer's blur handler closing the one open item; the clipboard Monitor mode is silently dead), 2 Low (response byte-length leak; ignored `backend-crash` event), 1 Info (top-level await import).

### 4.5 Mobile
*(RN-CLI `PearPasteMobile` + Expo `pearpaste-expo`; shared `mobile/app` + `mobile/backend` worklet)*

**Summary:** No crypto/sync drift — the Bare worklet imports the SAME desktop `backend/index.js` and re-exports `COMMANDS` from `backend/rpc.js`, so the on-device Pear-end IS the desktop core and command parity is structural. Clipboard honesty is correct and plaintext-drop discipline is sound. But the two-variant strategy has diverged badly: shared `mobile/app` hard-imports Expo modules, so only `pearpaste-expo` can render it, yet BUILD.md documents only `PearPasteMobile`. The committed `app*.bundle.js` artifacts are stale, the Expo build has no bundle-regen step, and the Expo iOS Podfile has no Pear-end bare-link hook. Net: `pearpaste-expo` is canonical for the UI but is not release-verified as committed; `PearPasteMobile` is the only build-verified shell but cannot run the current app.

**Key strengths:**
- No crypto/sync drift: worklet calls `createPearEnd` from the SHARED `backend/index.js`; all 28 commands, `assertRendererSafe`, lock gating, schema validation, the pairing handshake, and relay-blindness live in the single shared core.
- Clipboard honesty correct: verbatim statement that iOS forbids background clipboard sync and Android does not promise it, shown as a persistent warn banner; capture is foreground + user-initiated only (no poll loop).
- Plaintext-drop sound end to end: opened plaintext lives only in transient React state, dropped on close/blur; backend drops `openItems` on the `backgrounded` event from the worklet Bare suspend hook (`backgrounded` token present in the committed bundle).
- Sealed-row handling matches desktop: `FlatList` keys on the always-present `objectBlindId`; decrypt/delete gated on `!!item.id`.
- Worklet crash recovery genuinely wired: 45s boot-timeout, real boot error stack forwarded into a recoverable crash, `WorkletErrorBoundary` retry restarts without re-deriving keys; the swallowed-`start()` infinite-splash root cause is fixed.
- Single-worklet singleton (one Hyperswarm/Corestore per process); per-platform bundle shims avoid double-including ~3.5MB.

**Findings:** 2 High (stale committed bundles missing `NETWORK_STATUS`; inverted/unverified variant strategy + missing Expo iOS bare-link hook), 3 Medium (RPC test covers a transport the device never uses; lock-state desync + dead `lockOnBackground`; unguarded `expo-camera` import vs graceful-degrade claim), 3 Low (dead all-host bundle + template `App.tsx`; unverified iOS suspend assumption with no JS fallback; BUILD.md metro drift).

### 4.6 Build, Release, CI, Website & Docs
*(PearPaste / "Paste")*

**Summary:** The desktop Pear build config, supply-chain hygiene (pinned lockfile, exact-version patches, npm-audit/sentinel/verifier CI gates), and the relay-blindness/crypto claims are genuinely solid and well-backed. However, the cross-platform native packaging and release path are NOT release-ready and contain concrete, verified blockers: Windows signing signs a wrong exe path/name; the macOS+Windows wrapper steps invoke a removed Pear subcommand; there is no working signed/notarized macOS path despite the site badging macOS "Available"; and the CI "unsigned-artifact" gate never inspects anything because it early-exits on an empty `dist/`. The marketing site has no actual download target, points "view source" at a user profile, and ships stale stats.

**Key strengths:**
- Supply-chain hygiene strong and real: `package-lock.json` committed, `npm ci` everywhere, optional deps + both patched packages pinned; CI fails on missing lockfile and high/critical audit advisories (prod deps).
- `patch-package` patches minimal, well-commented, match installed versions EXACTLY — no dead/stale patches.
- Encryption marketing claims backed by code (real XChaCha20-Poly1305 24-byte nonce/16-byte MAC, correct BIP-39, no telemetry/analytics/remote fetch).
- Relay-blindness claim substantiated: docs + `RelayBlindnessError` pre-call assertion + relay-export sentinel scanning; `verify-encryption.js` independently asserts every stored Hyperbee value is an AEAD envelope.
- `sentinel-guard`/`release-guard` CI prove the verifier has teeth via a planted-leak negative test.
- Windows build preflight (`build-windows.mjs`) is thoughtful (verifies sodium-native prebuild, no other native node-gyp deps, `%%HOST%%` per-arch fetch, greps for unguarded Bare-incompatible globals).
- `release-prod.sh` appropriately conservative (every publishing step gated behind `confirm()`/`--yes`, `--dry-run` prints the plan, release notes explicit about what the proof does and does NOT prove).
- Desktop CSP tight; marketing site genuinely dependency-free with no remote/network calls.

**Findings:** 3 High (wrong Windows signing target; removed `pear init --wrapper`; no real download target + dead macOS badge), 2 Medium (inert CI signing gate; Android patches with no mobile/CI coverage), 4 Low (stale website stats + fake clone URL; source links to a profile; duplicate Pear config; `engines.node` floor), 1 Info (proof-screen log-scan presentation drift).

---

## 5. Cross-Cutting Themes

**A. Desktop ↔ mobile parity & bridge-contract drift.** The same architectural truth bites on both shells: the renderer/worklet reaches the backend only through a narrow request channel, so anything exposed as a plain bridge method or expected to be injected on `ctx` is absent in the real runtime. Desktop: `backgrounded` visibility events and the OS-clipboard backend never reach the worker (monitor mode is dead; the background-clear is only mitigated by the renderer's blur handler). Mobile: the same `backgrounded`-driven plaintext-drop relies on an unverified native suspend with no JS fallback. **Theme: make visibility/lifecycle a first-class wire message on both shells, and add a JS `AppState`/blur backstop, rather than relying on injected-`ctx` assumptions that hold only in-process tests.** Conversely, the crypto/sync core parity is excellent (mobile imports the desktop backend verbatim).

**B. Lifecycle / teardown.** Strong primitives (`LifecycleScope`, fenced convergence loop, key-wipe on lock, honored relay teardown contract) coexist with a cluster of gaps: open/close serialization race on fast lock-toggle (P2P Low), mobile lock-state desync where the UI never returns to locked (Mobile Medium), ignored `backend-crash` event leaving no recoverable UI (Desktop Low), and the visibility-event drift above. The building blocks are right; the edges (rapid transitions, crash recovery, background) need tightening.

**C. Tests assert behavior the production code path doesn't exercise.** A recurring pattern: the desktop security test emits `backgrounded` directly on `ctx` (bypassing the transport the shell doesn't drive), and the mobile RPC test drives a `createRpcServer`/`createRpcClient` envelope the device never uses (the device uses `WorkletRPC`/`PearRPC`). Both make a passing test mask an uncovered or dead production path. **Theme: route lifecycle/transport tests THROUGH the real wire, and the still-missing two-instance Autobase integration test would catch the two P2P Criticals.**

**D. Doc / marketing drift vs implementation.** The most security-relevant: `KEY_ROTATE`/revocation forward-secrecy is documented as a cryptographic guarantee but is only a counter (the real control is the reducer lamport gate). Threat model claims Argon2id "moderate" but the code uses "interactive." The website badges macOS "Available" with no installer, links "view source" to a user profile, shows a fake clone URL, and prints stale LOC/test counts — all corrosive to an "audit it yourself" product. BUILD.md documents the wrong mobile variant and a stale metro config. **Theme: either raise the implementation to the claim (preferred for `KEY_ROTATE`) or lower the claim to the implementation — do not ship copy that overstates security or availability.**

**E. Release / signing / packaging gaps.** No cross-platform path is actually release-ready: wrong Windows signing target, a removed Pear subcommand in the release script, an inert CI signing gate, no notarized macOS `.app`, and root-only Android patches unverified to reach the mobile bundle. The single-source-of-truth problems (duplicate `pear.json` vs `package.json#pear`, `engines.node` floor below the tested Node 22) compound it. **Theme: pick one canonical Pear manifest, one canonical mobile variant, and wire a real release job whose artifacts the signing gate actually inspects.**

---

## 6. Prioritized Roadmap

### Do now (private-beta blockers / correctness & honesty)
1. **Fix the two P2P Criticals.** Make authorization state a pure function of the linearized log on every apply; guard `appendOp()` for writability (bounded poll or `optimistic:true`) so paired-device first writes aren't lost. **Add a two-instance Autobase integration test** — this is the single highest-leverage gap.
2. **Resolve `KEY_ROTATE` (High).** Decide: implement epoch-bound content-key derivation + reducer epoch gate, OR correct SECURITY.md / PAIRING.md / THREAT_MODEL.md to state the load-bearing control is the reducer lamport gate. Do not ship copy claiming post-rotation secrecy until the code lands.
3. **Erase clip contents (High).** Add a clip sweeper that emits `CLIP_DELETE` and a `CLIP_DELETE` RPC; enforce `expiresAt` on `CLIP_OPEN`/`CLIP_COPY`. (Passwords/tokens currently persist encrypted-at-rest forever despite a 24h TTL.)
4. **Pick the canonical mobile variant (High).** Commit to `pearpaste-expo`, regenerate + recommit the stale bundles, add the Expo iOS bare-link hook and an Expo bundle-regen build step, rewrite BUILD.md. Delete/deprecate `PearPasteMobile` or shim the `expo-*` imports.
5. **Harden the malformed-op path (Medium).** Validate op shape and drop-and-log instead of rethrowing, so one authorized writer can't wedge cross-device sync for everyone.
6. **Stop overstating in the threat model (Medium/Low).** Correct "moderate"→"interactive (64 MB)" and document the fixed app-wide root-seed salt rationale.

### Before public beta (release-readiness & polish)
1. **Fix the desktop visibility/monitor gap (High×2).** Add a `__visibility` wire verb so `backgrounded` actually fires; either implement clipboard monitor in the renderer or inject an OS backend, or hide the dead "Monitor" option. Add an e2e test driven through the worker pipe.
2. **Make the release path real (High×3 + Medium).** Fix the Windows signtool target (derive from the Pear app name / `productName`), rewrite the macOS/Windows wrapper steps to current Pear (remove `pear init --wrapper`), wire a CI release job whose artifacts the signing gate inspects, and add CI coverage that the Android patches reach the mobile bundle.
3. **Ship a real download (High).** Populate `#get` with the actual `pear run pear://<key>` path (and the real production link), downgrade the macOS badge until a notarized `.app` exists.
4. **Raise the local-device passphrase wrap to Argon2id MODERATE on desktop (Medium)**, storing cost in the v2 kdf record.
5. **Wire mobile lock-state + background backstop (Medium/Low).** Map backend `locked` → UI gate; add a JS `AppState` plaintext-drop backstop; enable `lockOnBackground` if it's a product promise.
6. **Fix the marketing-credibility items (Low).** Real repo URLs everywhere, generated (or removed) stats, real clone URL.
7. **Search correctness (Medium).** Index `label`; rebuild the search index from the converged view after flush (fix reorg drift); add the reverse index to kill the O(N²) catch-up.
8. **De-dupe sources of truth (Low).** One Pear manifest; raise `engines.node` to `>=22` or add a Node 20 CI lane.

### Later (hardening, defense-in-depth, hygiene)
1. Widen the pairing SAS to ~30+ bits and confirm the UI hard-blocks bootstrap until the user affirms the codes match.
2. Carry op-authoritative timestamps so replicated metadata is byte-identical across devices.
3. Serialize open/close through one mutex to close the lock-toggle race.
4. Handle `backend-crash` in the desktop renderer with a reconnect affordance.
5. Drop response byte-length logging for content commands in release builds.
6. Remove the dead `open()` stub, the unused all-host mobile bundle, the template `App.tsx`, and the unused `bare-rpc`/`COMMAND_IDS` machinery.
7. Clip dedup/immutability decision (LWW across buckets, or document add-only + assert `clipId` uniqueness).
8. Wire a default `--log` path into verify/release (or adjust the proof-screen copy) so the demonstrated log scan matches default behavior.

---

## 7. Open Questions for the Maintainer

**Highest-impact (gate fix-vs-doc decisions):**
1. **`KEY_ROTATE` direction:** Is making the epoch cryptographically real (epoch-bound `itemKey` + header epoch + reducer epoch gate) in scope for this milestone, or should the docs be corrected to the current counter-only behavior? Determines whether the headline security finding is a code fix or a doc fix.
2. **Canonical mobile variant:** `pearpaste-expo` or `PearPasteMobile`? The code points to Expo (`app/` uses `expo-camera`/`expo-linear-gradient`) but every verified-build claim in BUILD.md is about `PearPasteMobile`. Determines whether the missing Expo iOS bare-link hook + missing bundle-regen step are release blockers.
3. **macOS release shape:** Is a notarized `.app` planned for v1, or is the ship strictly `pear run pear://<key>`? The "macOS Available" badge and platform matrix depend on the answer; no signed/notarized macOS path exists today.
4. **Production identifiers:** What are the real production `pear://` link and the canonical public repo URL? Both are placeholders/profile links across the site, release notes, and docs — the site cannot ship a working install path until these exist.
5. **Binary brand name:** Should the Windows/macOS wrapper binary be "Paste"/"PearPaste" (display brand) rather than the lowercase Pear app name `pearpaste`? Encode as a `productName` override rather than hardcoding in the build scripts.

**Correctness / coverage:**
6. **Is concurrent multi-device editing exercised anywhere?** No test wires two real Corestore/Autobase instances and replicates (`sync-reducer.test.js` drives a degenerate single-instance path). The reorg/divergence and paired-writer Criticals are reasoned from Autobase 7.28.1 source; a two-node integration test would confirm severity.
7. **Root identity:** Is "root" intended to be the first device signing key (current genesis-`DEVICE_ADD` behavior) rather than the BIP-39-derived `rootIdentityKeyPair`? If a user restores from mnemonic on a brand-new device with no local history, that device self-roots a NEW genesis with a different `rootPubkey` — does that fork the device set until logs merge, and is that intended?
8. **Teardown unit:** Is `attach()` guaranteed to run once per process (so the persistent swarm-connection listener and `ctx.on` listeners are process-lifetime), with `engine.open/close` per unlock? Confirm no path re-runs `attach()` (which would double-register the replicate handler and pairing responder).

**Security boundaries:**
9. **Does the desktop/mobile pairing UI hard-block bootstrap acceptance until the user affirmatively confirms the 6-digit phrase matches on both screens?** The backend returns the confirmation but the human-compare step is the entire MITM defense; only `backend/` was reviewed, not the shells.
10. **Is there a size/shape bound on inbound replicated ops before they reach the reducer** (in the replication/wire layer), or is `_apply` the first validation point? Affects how exploitable the malformed-op sync-wedge is in practice.
11. **Is raising Argon2id cost on desktop-only acceptable** given cross-device unlock expectations? The local-device blob is never replicated, so per-platform cost (stored in the kdf record) should be safe — confirming the product constraint settles the fix.

**Mobile runtime:**
12. **Does `react-native-bare-kit` reliably emit Bare `suspend` on iOS background/lock on a real device** (not just a simulator boot)? The background plaintext-drop guarantee depends on it with no JS fallback today.
13. **Was the iOS "Successfully launched" verification in BUILD.md performed before `app/` migrated to `expo-camera`/`expo-linear-gradient`?** If so it no longer reflects a runnable RN-CLI build.

---

*Severity totals (excluding the now-fixed relay items and 5 Info): 2 Critical · 8 High · 7 Medium · 12 Low. The relay layer was verified independently and finalized at `working-great` after 4 applied fixes.*
