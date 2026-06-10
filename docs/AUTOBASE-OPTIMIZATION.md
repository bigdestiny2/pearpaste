# Autobase Optimization Notes (PearPaste)

Date: 2026-06-10

PearPaste's sync core is **already** an Autobase + Hyperbee application
(`backend/autobase-sync.js`: `new Autobase(store, key, { open: beeFromCore(view), apply: reducer })`).
That "Autobase with a Hyperbee view merged by a deterministic `apply`" is
*exactly* the abstraction the upstream `autobee` package packages. So the
opportunity here is **not** to adopt a new dependency — it is to leverage the
fast-forward / wakeup / anchor / optimistic capabilities that already ship in
the `autobase@7.28.1` PearPaste depends on but does not yet use.

Companion read: PearBrowser's `docs/AUTOBEE-RESEARCH.md` (which evaluates
*adopting* Autobee for a project that has no Autobase yet — the opposite
situation from PearPaste).

## Sources

- Autobase repo: <https://github.com/holepunchto/autobase>
- Autobee repo (capability map): <https://github.com/holepunchto/autobee>
- Installed: `autobase@7.28.1`, `hyperbee@2.27.3`, `hypercore@11.30.2`, `corestore@7.9.2`
- PearPaste sync engine: `backend/autobase-sync.js`
- Materialized view + search: `backend/materialized-view.js`
- Crypto envelope (op-level seal invariant): `backend/crypto-envelope.js`
- Replication firewall: `backend/replication-firewall.js`
- Lifecycle/scope: `backend/lifecycle-scope.js`

## Why Not Adopt the `autobee` Package

- **Experimental.** `autobee@1.0.8` is marked "heavy development, expected
  breaking changes." PearPaste is a security-critical app at the 0.1.0 release
  cusp; swapping the sync core for an unstable dependency trades a mature,
  test-covered reducer for risk.
- **The reducer is the value, and it is deeply custom.** PearPaste's `apply`
  does revoked-device write exclusion (the RT-FIX B12 backdated-lamport gate),
  epoch key rotation, reorg-safe auth-cache rebuild (`_rebuildAuthFromView`),
  and blind-indexed device records. A generic merge engine does not give any of
  this away.
- **Different encryption layer.** `autobee-encryption` encrypts at the
  core/bee level. PearPaste seals at the **op body** level (XChaCha20-Poly1305
  via `crypto-envelope.js`), which is the load-bearing "relay sees only
  ciphertext" invariant. These are not interchangeable; op-level seal stays.
- **`hyperbee2` vs `hyperbee`.** Autobee uses `hyperbee2`; PearPaste uses
  `hyperbee@2.27.3` throughout (view + local search). Migrating is churn with no
  user-visible payoff.

**Conclusion:** mine the techniques, keep the dependency. Everything below uses
the autobase PearPaste already has.

## What PearPaste Uses Today vs What Is Available

Native autobase API surface confirmed present on `autobase@7.28.1`:

```
forceFastForward, isFastForwarding   ← cold catch-up (NOT used)
hintWakeup, setWakeup                 ← replication-driven wakeup (NOT used)
setUserData, getUserData             ← checkpoint persistence (NOT used)
recouple, repair, pause, resume      ← maintenance (NOT used)
waitForWritable                      ← (used indirectly; see _awaitWritable)
batch, append, update, ack, flush    ← batch used in the reducer flush only
```

Today the engine uses `view.batch()` in the reducer flush and a manual
event+heartbeat converge loop. The advanced machinery is unused.

## Local Fit (ranked by payoff)

### 1. Fast-forward for cold catch-up — highest payoff

**Pain:** a freshly paired device, an offline device reconnecting, and mobile
cold-start all **replay the op log** to rebuild state. The offline-survivor
follow-topic path (`test/integration/revocation-network.test.js`) and the
durability reconciler are replay-bound; catch-up grows with vault history
(every note edit, every clip).

**Lever:** `autobase.forceFastForward` / native fast-forward jumps a behind
device to a recent **signed checkpoint** instead of replaying from zero. Fastest
win for: pairing bootstrap time, offline reconnect, mobile cold-start.

**Care:** fast-forward must not bypass the security reducer's guarantees — the
auth-cache rebuild and epoch state must be re-derived at/after the fast-forward
target (PearPaste already rebuilds auth as a pure function of the committed view
each apply, which composes well with jumping forward). Verify revoked-device
exclusion still holds across a fast-forward boundary.

### 2. Native wakeup — finish the event-driven sync

**Pain:** the converge loop is event-driven on the autobase `update` event but
still keeps a ~10s idle heartbeat fallback (added in the perf pass).

**Lever:** `hintWakeup` / `setWakeup` is replication-driven — a remote append
wakes the peer directly, retiring the residual heartbeat and tightening
remote-change latency to near-zero without polling. This is what
`autobee-wakeup` formalizes; the primitive is already in autobase.

### 3. Checkpoint anchors via `setUserData` — faster restart

**Pain:** every `open()` runs `_rebuildAuthFromView` and re-materializes from
the full committed view. Restart cost grows with history.

**Lever:** persist a checkpoint (last-applied epoch/auth snapshot, last indexed
length) via `setUserData`/anchors so restart hydration is O(recent) not
O(whole log). **This is the same optimization class as HiveRelay v0.8.26's
"`SeedingRegistry` Hyperbee indexed-views sidecar"** (restart hydration
O(N·M) → O(M)) — a proven pattern in this stack.

**Care:** the checkpoint is a *cache of derived state*; the multi-writer log
stays canonical. On any fork/reorg the checkpoint must be invalidated and
rebuilt (PearPaste's reducer already treats the committed view as source of
truth, so this is a natural fit).

### 4. Optimistic mode — lower write latency (later)

**Pain:** `_awaitWritable` + the durability-confirm loop add latency to the
first write on a fresh/just-paired device.

**Lever:** optimistic append lets the local view reflect a write before full
linearization, for snappier note typing.

**Care:** highest interaction risk — optimistic writes must still pass the
signer-authorization gate before they are trusted/committed, and must not let a
revoked or unauthorized op appear "applied" locally. Design carefully; do not
spike before 1–3 land.

## Product / UX Wins These Enable

- Near-instant device pairing (fast-forward instead of full replay).
- Fast mobile cold-start (fast-forward + checkpoint).
- Lower battery/CPU on idle (wakeup retires the heartbeat).
- Snappier note capture (optimistic, later).
- A "Sync Diagnostics" panel: writers, peers, last update, indexed vs signed
  length, fast-forwarding state, local writable — most of which autobase already
  exposes (`signedLength`, `indexedLength`, `isFastForwarding`, `writable`,
  `heads`).

## Security / Threat-Model Questions (PearPaste-specific)

PearPaste already answers the generic Autobee threat-model questions (admin-gated
`DEVICE_ADD`/`DEVICE_REVOKE`; revoke-wins via RT-FIX B12; deterministic apply
under reorder/rollback/fast-forward via pure-function rebuild; lamport-not-
wall-clock ordering). The optimization-specific questions to answer:

- Does fast-forwarding to a checkpoint preserve **revoked-device exclusion**?
  (A device revoked before the fast-forward target must remain excluded.)
- Can a malicious peer push a **forged or stale fast-forward target** to make a
  victim skip a revocation or rotation? (Anchor must be signed/validated by the
  same authority the reducer trusts.)
- Are `setUserData` checkpoints **integrity-protected** so a tampered local
  checkpoint can't resurrect rolled-back auth/epoch state?
- Does wakeup leak **timing/metadata** about local activity to relays/peers
  beyond what replication already reveals?
- Does optimistic mode ever surface an **unauthorized op as applied** in the
  local view before the auth gate rejects it?

## Design Constraints

- Keep the op-level XChaCha20 seal invariant (`crypto-envelope.js`) — do **not**
  move to core-level encryption.
- Keep `apply` deterministic and free of wall-clock; auth/epoch state stays a
  pure function of the committed view.
- Treat any checkpoint/anchor as a derived cache; the log is canonical and a
  reorg invalidates the cache.
- Pin the exact autobase version during each spike; these are 7.x behaviors.
- Wrap new capabilities behind the existing `SyncEngine` interface; never expose
  autobase objects to the RPC/renderer boundary.
- Every change re-runs `test:unit`, `test:security`, and the
  `revocation-network` integration test (revocation + offline catch-up are the
  blast radius).

## Proposed Prototype (Phase 1: fast-forward spike)

Local, no UI, behind no flag (engine-internal):

1. On `open()`, after the base is ready, attempt a fast-forward toward the
   latest signed anchor when the local indexed length lags the signed length by
   more than a threshold.
2. After fast-forward, run `_rebuildAuthFromView` and assert the auth/epoch
   state matches a full-replay rebuild (equivalence check in the spike).
3. Measure cold catch-up time: fresh-paired device joining a vault with N
   pre-existing notes, with vs without fast-forward.
4. Adversarial check: a device revoked before the fast-forward target stays
   excluded; an op signed by it after the target is rejected.

## Acceptance Criteria

- A fresh-paired device converges to the identical materialized view via
  fast-forward as via full replay (byte-identical device/note/epoch state).
- Restart with a checkpoint reproduces the same view as restart without one.
- Revoked-device exclusion and epoch rotation are preserved across fast-forward
  and checkpoint boundaries (adversarial tests pass).
- Measurable cold-catch-up improvement on a history-heavy vault.
- No plaintext at rest (existing `sec-storage` sentinel scan still passes).

## Rollout Plan

- **Phase 0:** this doc + capability confirmation (done — capabilities verified
  present on 7.28.1).
- **Phase 1:** fast-forward spike for cold catch-up, with the equivalence +
  adversarial tests above. Highest user-visible payoff.
- **Phase 2:** native wakeup; retire the converge-loop heartbeat.
- **Phase 3:** checkpoint anchors via `setUserData` for faster restart.
- **Phase 4:** Sync Diagnostics panel (read-only surface of autobase metrics).
- **Phase 5:** optimistic mode, only after 1–3 are stable and well-tested.

## Do Not Do Yet

- Do not adopt the `autobee` package while its breaking-change warning stands.
- Do not move to `autobee-encryption` / core-level encryption — op-level seal is
  the security invariant.
- Do not migrate `hyperbee` → `hyperbee2`.
- Do not ship any sync-core change in a 0.1.x patch without the full security +
  revocation + offline-catch-up suite green.
- Do not let a checkpoint or fast-forward target be trusted without the same
  signature/authority validation the reducer applies to ops.

## Notes For Future Work

- Confirm Pear/Bare runtime behavior of `forceFastForward` and wakeup under the
  mobile worklet bundle, not just desktop.
- Quantify current cold-catch-up time on a representative vault to set a Phase-1
  baseline.
- Consider exposing `signedLength`/`indexedLength`/`isFastForwarding` through a
  redacted RPC for the diagnostics panel.
- Cross-reference HiveRelay v0.8.26 (indexed-views sidecar) and v0.8.21
  (persistent download ranges / self-heal) as prior art for the
  checkpoint + replication-completeness work.
