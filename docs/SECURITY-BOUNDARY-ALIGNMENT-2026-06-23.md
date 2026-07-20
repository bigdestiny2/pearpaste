# Pearpaste Security Boundary Alignment

Generated: 2026-06-23
Loop candidate: `pearpaste-security-crosscheck`
Autonomy level: Level 1 security/threat documentation artifact
Source root: `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste`

## Executive Status

Pearpaste already has unusually strong security documentation in
`docs/SECURITY.md` and `docs/THREAT_MODEL.md`: the current docs distinguish
mathematically enforced confidentiality/integrity/authenticity from residual
metadata, endpoint, relay, deletion, revocation, and supply-chain risks. This
alignment note does not replace those files. It pins the current boundary map
to implementation files and focused tests so future agent loops do not confuse
release gaps with crypto/security gaps.

The strongest current source-backed claim is: user content is sealed before it
enters replicated storage or relays, replicated operations are public-header
plus encrypted-envelope records, relays receive ciphertext/roots/receipts only,
and revocation provides forward secrecy for content created after revocation.

The strongest current caveat is equally important: Pearpaste is not anonymous,
does not erase plaintext already seen by a previously trusted device, does not
prove physical deletion from third-party disks, and cannot protect data while a
local endpoint is compromised or unlocked.

## Current Boundary Map

### Crypto envelope and replicated headers

Current source: `backend/crypto-envelope.js`, `backend/shared-ops.js`,
`backend/materialized-view.js`, `backend/autobase-sync.js`.

- `seal()` is the content-encryption gate for replicated user content.
  Plaintext is serialized through canonical JSON and sealed with
  XChaCha20-Poly1305-IETF.
- Per-item keys derive from the selected epoch key with
  `itemKey = HKDF(epochKey, "item:" + itemId)`.
- Object identifiers in replicated headers are blinded with keyed BLAKE2b so
  raw note/clip IDs do not cross the replicated boundary.
- AEAD additional-data binds each envelope to
  `{ vaultId, objectBlindId, opType, schema }`, and non-legacy epochs also bind
  `epochTag`, so cross-object and cross-epoch splices fail closed.
- `assertHeaderPublicOnly()` restricts replicated headers to public fields and
  rejects forbidden fields such as mnemonic, passphrase, root seed, vault key,
  item key, device secret keys, plaintext, note body, and clip body.
- Epoch `0` remains byte-compatible with legacy vault data: empty `epochTag`
  omits epoch from AAD and maps to the vault key anchor.

### Operation authenticity and reducer authorization

Current source: `backend/crypto-envelope.js`, `backend/autobase-sync.js`,
`backend/shared-ops.js`.

- Replicated operations are signed with Ed25519 over the canonical operation
  parts.
- The reducer rejects unsigned, mis-signed, unknown-signer, and revoked-signer
  operations before applying them.
- A committed-revoked signer is rejected for new operations even if it attempts
  a backdated Lamport value.
- Lamport ordering is deterministic with device-id tie-breaks.
- Reducer state rebuilds auth and epoch state from the committed view, which
  keeps revocation and epoch handling reorg-safe.

### Recovery, local secret storage, and renderer boundary

Current source: `backend/identity.js`, `backend/vault-store.js`,
`backend/rpc.js`, `backend/desktop-bridge.js`, `mobile/backend/worklet-rpc.mjs`.

- The 24-word recovery phrase is the root of recovery and is intentionally
  returned once at vault creation. It is not persisted by Pearpaste.
- Routine unlock uses a local wrapped device blob under the unlock secret or OS
  keychain-provided secret.
- `RpcDispatcher.call()` runs `assertRendererSafe()` before a response reaches
  the renderer. Secret key material and passphrases are never allowed across
  that boundary; mnemonic is allowed only for `CREATE_VAULT`.
- Clipboard and selected-item plaintext are application/runtime surfaces, not
  replicated surfaces. They must be treated as local endpoint risk and cleared
  on lock/background/close paths.

### Relay blindness and custody

Current source: `backend/relay-service.js`, `backend/verifier.js`,
`docs/RELAY_CUSTODY.md`.

- Relay calls are optional availability, not trust. Failure degrades to
  local-first/direct-P2P behavior rather than blocking local use.
- `assertCiphertextOnly()` deep-scans relay payloads and throws
  `RelayBlindnessError` when forbidden key names or the plaintext sentinel are
  present.
- Every relay payload is mirrored to `<storage>/relay-exports` so the verifier
  can inspect the exact bytes sent to relays.
- `privacyTier: "p2p-only"` and content-free custody roots keep relays blind to
  note/clip plaintext and data keys.
- Relay blindness is not anonymity: relays and observers can still learn sizes,
  timing, public log keys, and peer/network metadata.

### Revocation and replication firewall

Current source: `backend/autobase-sync.js`,
`backend/replication-firewall.js`, `backend/relay-service.js`,
`backend/pairing.js`, `docs/REVOCATION_HANDOFF.md`.

- Device revocation appends `DEVICE_REVOKE` and performs a real `KEY_ROTATE`
  to a fresh random epoch key sealed only to surviving devices.
- Reads of newly-created post-revocation content are stopped by cryptography:
  the revoked device does not receive the new epoch key.
- Writes are stopped by the reducer's committed-revoked-signer gate, with
  host-side writer eviction as defense in depth.
- The replication firewall is the load-bearing network control where the user
  controls the edge: peers must authenticate with a session-bound signed
  `pp-repl-auth` credential before `store.replicate(conn)`, and live streams
  for a revoked device are actively destroyed.
- Topic rotation and relay re-seed are discovery/availability controls, not
  proof of exclusion from opaque ciphertext bytes.
- Selective-chain pairing gives a re-paired device only the current epoch key
  by default. Full history is explicit through `grantHistory`.

### Pairing, admission, and mobile/worklet parity

Current source: `backend/pairing.js`, `backend/autobase-sync.js`,
`mobile/backend/worklet-rpc.mjs`, `mobile/test/worklet-rpc.test.js`.

- Pairing invites have expiry and signed hello/approval checks.
- Admission can require N-of-M admin co-signing so a lone key-holder cannot
  quietly self-admit once a second admin exists.
- Pairing bootstrap releases sync metadata and selected keys only after local
  approval.
- The mobile worklet RPC suite exercises the same create/unlock/list/open/lock,
  pairing decode, clip copy, and crash recovery contract over the mobile
  bridge path.

### Verifier and proof surface

Current source: `backend/verifier.js`, `scripts/verify-encryption.js`,
`docs/VERIFIER_SPEC.md`.

- The verifier checks that stored values are CryptoEnvelope-shaped AEAD
  records, scans storage bytes and relay-export mirrors for the plaintext
  sentinel, checks operation signatures, and includes revocation and custody
  lines when samples are available.
- The verifier's required honest line remains: it does not prove physical
  deletion from third-party disks.
- A passing verifier proves structural and sentinel claims for scanned bytes; it
  does not prove the absence of a side-channel or a compromised build that
  preserves envelope shape while exfiltrating keys.

### Release and platform security gates

Current source: `docs/RELEASE.md`, `docs/SHIPPING.md`,
`docs/TESTING_MATRIX.md`, `scripts/release-prod.sh`,
`scripts/build-macos.mjs`, `scripts/build-windows.mjs`,
`scripts/package-linux.mjs`, `test/security/sec-platform-release.test.js`.

- The release path is verifier-gated: publishing refuses to proceed if the
  encryption verifier is skipped or fails.
- Native wrapper signing paths fail closed when signing credentials are absent.
- Android release build configuration disables cleartext traffic in release.
- Linux release expects detached signature sidecars for release artifacts.
- Public beta still requires real platform signing/notarization proof, external
  security review, legal/privacy policy work, SBOM/provenance, and manual
  platform smoke.

## Open Security Caveats

1. Pearpaste is not anonymous. Network peers and relays can observe metadata:
   timing, sizes, public log keys, DHT participation, and peer/network shape.
2. Revocation is forward secrecy, not past erasure. A previously trusted device
   keeps anything it already replicated, decrypted, or had keys for.
3. Third-party non-firewalled relays or peers can continue serving opaque
   post-revocation ciphertext to a revoked device. Confidentiality rests on the
   post-revocation epoch key remaining unavailable to that device.
4. A compromised recovery phrase is a root compromise and requires a new vault,
   not device revocation.
5. A compromised local endpoint while unlocked can read content in memory or on
   the OS clipboard. Local OS hygiene remains out of scope for the app.
6. The verifier is structural and sentinel-based. It is necessary release proof,
   but it is not a substitute for dependency review, reproducible-build
   attestation, external audit, or runtime side-channel review.
7. Public release security is not done until real signing, notarization,
   platform package smoke, privacy/legal docs, and artifact provenance are
   captured.

## Focused Test Coverage To Preserve

- `test/unit/crypto-envelope.test.js` for AEAD sealing/opening, epoch AAD,
  key IDs, signature checks, and forbidden header fields.
- `test/unit/sync-reducer.test.js` for revoked-signer rejection, real
  `DEVICE_REVOKE` key rotation, epoch state, and public headers.
- `test/security/sec-storage.test.js` for storage, relay-export, and log
  sentinel scans.
- `test/security/sec-access.test.js` and `test/security/sec-auth.test.js` for
  access and authenticity boundaries.
- `test/security/sec-doc-claims.test.js` for preventing stale revocation
  overclaims from returning to `SECURITY.md`, `THREAT_MODEL.md`, and
  `PAIRING.md`.
- `test/integration/relay-custody.test.js` for relay blindness and verifier
  bad-record detection.
- `test/integration/revocation-rotation.test.js`,
  `test/integration/revocation-network.test.js`,
  `test/integration/revocation-pairing.test.js`, and
  `test/integration/revocation-durability.test.js` for revocation forward
  secrecy, firewall behavior, pairing selectivity, and durable tombstones.
- `test/e2e/desktop-vault.test.js` and `mobile/test/worklet-rpc.test.js` for
  sealed lists, tap-to-decrypt, lock clearing, clipboard behavior, and mobile
  RPC parity.
- `test/security/sec-platform-release.test.js` for platform release security
  claims such as signing and cleartext-traffic release defaults.

## Recommended Next Level 1/2 Step

Run a release-readiness evidence pass:

- Run feasible local gates from `docs/CURRENT_STATUS_AUDIT_2026-06-23.md` and
  `docs/TESTING_MATRIX.md`.
- Capture outputs in a dated release-evidence artifact.
- Keep environment-blocked gates separate from failing gates.
- Do not mark public beta ready until signing, notarization, external audit,
  legal/privacy, platform smoke, and artifact provenance are proven.

## Source Evidence

- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/crypto-envelope.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/shared-ops.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/autobase-sync.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/vault-store.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/rpc.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/relay-service.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/replication-firewall.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/pairing.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/backend/verifier.js`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/SECURITY.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/THREAT_MODEL.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/REVOCATION_HANDOFF.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/RELEASE.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/SHIPPING.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/TESTING_MATRIX.md`
- `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste/docs/CURRENT_STATUS_AUDIT_2026-06-23.md`
