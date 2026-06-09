# Paste

**One notepad. Every device you own.** — a private clipboard and note sync that
is encrypted on-device.

Paste is a personal, end-to-end encrypted note and clipboard sync app built on
the Pear / Holepunch peer-to-peer stack. You copy on one device and paste on
another, save snippets as private notes, and search them locally — with no
account, no server, and no cloud. Everything is encrypted locally before it
enters the P2P network. The optional availability relays are **blind**: they
only ever hold ciphertext, public core keys, and content-free commitments —
never note/clip plaintext and never key material.

> The display name is **Paste**. `pearpaste` is the package / app-key / repo
> identifier and stays as-is — it is infrastructure, not branding.

---

## Status & version

- **Version:** `0.1.0` — **private, pre-beta.** Not yet released to the public.
- **License:** Apache-2.0.
- **No telemetry, ever.** The app and its website make zero remote calls and
  never phone home.

This README is honest about what is built versus what is still in progress. The
encryption invariant — *no plaintext at rest, anywhere* — is the foundation and
is real and tested from day one.

### What works today

- Create a local vault from a 24-word BIP-39 recovery phrase; unlock / lock.
- Encrypted notes (create / edit / soft-delete) stored only as AEAD envelopes
  in Hyperbee; local full-text search over a blinded token index.
- Tap-to-decrypt: list rows are sealed; exactly one opened item is decrypted in
  memory and cleared on close / lock / background / timeout.
- Clipboard capture (manual / user-initiated) and copy, with a 24h clip TTL and
  a 60s OS-clipboard auto-clear after copy.
- Device pairing via QR / short code with a libsodium sealed-box bootstrap, a
  short-authenticated-string confirmation phrase, and explicit human approval.
- The blind HiveRelay availability layer with pure-DHT auto-discovery, silent
  local-first degradation when no relay is reachable, and a relay-blindness
  guard on every outbound payload.
- An independent encryption verifier you can run from source (no keys, no
  network).
- Desktop runs under `pear run --dev .`; the mobile Pear-end (the same shared
  backend core) boots in a Bare worklet; an Android debug APK builds.

### What is still TODO / in progress

- **Multi-device convergence is implemented but not yet hardened.** The
  single-writer path is solid; genuine concurrent multi-writer editing has
  known correctness gaps that are not yet covered by a two-instance test (see
  `backend/autobase-sync.js`). Treat multi-device as experimental in `0.1.0`.
- **Key rotation is a counter, not yet a cryptographic boundary.**
  `DEVICE_REVOKE` removes a device's ability to *land new operations* (the
  reducer authorization gate is the real, tested control), but the
  `KEY_ROTATE` epoch does not yet re-key content, so it does **not** provide
  forward secrecy against a previously-trusted device. See
  [docs/SECURITY.md](docs/SECURITY.md) §4.2 and
  [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) §2.3.
- **Desktop "Monitor clipboard" mode is not functional yet** — manual capture
  works; the background monitor on desktop is a no-op pending a clipboard
  backend.
- **Two mobile shells have diverged** (see the platform matrix below); only one
  build path is currently verified end-to-end.
- **No signed/notarized installers and no public download yet.** The v1 install
  path is `pear run pear://<key>` after installing the Pear runtime. Code
  signing and a published reproducible-build attestation are pre-beta (M6)
  items — see [docs/RELEASE.md](docs/RELEASE.md).

---

## Platforms & targets

| Target | Stack | Location | Status |
|---|---|---|---|
| **Pear desktop** | `pear-electron` shell + Bare Pear-end | repo root (`index.js`, `index.html`, `ui/`, `backend/`) | macOS / Windows / Linux (Linux requires glibc 2.32+, i.e. Ubuntu 22.04+). Runs via `pear run --dev .`; Win/Linux packaging scripts present. |
| **Mobile — RN-CLI** | React Native 0.81 + `react-native-bare-kit` | `mobile/PearPasteMobile/` | Build-verified shell (Android debug APK builds; iOS Simulator launch documented). |
| **Mobile — Expo** | Expo + `react-native-bare-kit` | `mobile/pearpaste-expo/` | Renders the shared `mobile/app/` UI; not release-verified as committed. |
| **Shared mobile worklet** | Bare worklet re-exporting the desktop backend | `mobile/app/`, `mobile/backend/` | One UI + one Pear-end shared by both shells — no crypto/sync divergence. |
| **Website** | Static, dependency-free marketing site | `website/` | No build step, no remote assets, no network calls. |

Both mobile shells share `mobile/app/` (UI) and a Bare worklet that imports the
**same** `backend/index.js` as desktop, so command parity and the crypto/sync
core are structural, not duplicated. See [mobile/BUILD.md](mobile/BUILD.md) for
the full build guide and the honest per-platform clipboard reality.

---

## Architecture

One shared **Pear-end** (Bare runtime backend in `backend/`) is reused across
desktop and mobile. Platform UI shells talk to it over a local schema-validated
RPC bridge; the backend owns all secrets, the UI only displays.

```
Desktop UI (pear-electron)        Mobile UI (React Native)
            \                          /
             \   IPC / RPC bridge     /
              v                      v
        ┌──────────────────────────────────┐
        │  Paste Pear-end (Bare, backend/)  │
        │   identity · crypto-envelope      │
        │   pairing · vault-store           │
        │   notes-service · clipboard       │
        │   autobase-sync (multiwriter log) │
        │   materialized-view (sealed)      │
        │   relay-service (blind HiveRelay) │
        │   verifier · lifecycle-scope      │
        └──────────────────────────────────┘
                        |
                        v
   Hyperswarm + HyperDHT  ·  Hypercore/Corestore replication
                        |
                        v
   HiveRelay blind availability (ciphertext + metadata only)
```

Built on the Holepunch stack:

- **Hypercore / Corestore** — append-only logs; exactly one Corestore root per
  vault, namespaced per subsystem; one shared replication stream per peer.
- **Autobase** — multi-writer cross-device operation log (one writer core per
  authorized device) with a deterministic reducer.
- **Hyperbee** — encrypted materialized views (current state) and the local
  blinded search index. Every stored value is a `CryptoEnvelope`.
- **Hyperswarm / HyperDHT** — exactly one Hyperswarm instance per Pear-end for
  topic discovery and connection; replication wired once on connection.
- **sodium-native** — XChaCha20-Poly1305-IETF AEAD, Argon2id, BLAKE2b; Ed25519
  via hypercore-crypto.

A **LifecycleScope** cancellation primitive drains async loops before any
Corestore/Hyperswarm teardown, so locking/closing never leaves stale
references. The **blind HiveRelay availability layer** is an *optional* add-on
(it is an `optionalDependency`): it keeps the encrypted op log reachable while
all your devices are asleep, but the app is fully usable local-first without it.

---

## Security model

Paste's precise, testable guarantees (each maps to enforcement code and a test
in `test/security/`) are documented in **[docs/SECURITY.md](docs/SECURITY.md)**;
the adversary analysis and residual risks are in
**[docs/THREAT_MODEL.md](docs/THREAT_MODEL.md)**.

**Key hierarchy** (from a 24-word BIP-39 phrase + optional passphrase):

```
rootSeed   = Argon2id(mnemonic + passphrase, salt = "pearpaste-root-v1")
vaultKey   = HKDF(rootSeed, "pearpaste-vault-key-v1")
indexKey   = HKDF(rootSeed, "pearpaste-index-key-v1")
deviceAdmin= HKDF(rootSeed, "pearpaste-device-admin-v1")
itemKey    = HKDF(vaultKey, "item:" + itemId)
```

- **Confidentiality:** note titles/bodies/tags and clipboard text are encrypted
  with per-item keys *before* entering any replicated structure or relay.
  Object identifiers in headers are blinded (`keyed-BLAKE2b(indexKey, objectId)`)
  — the raw id never travels.
- **Authenticity:** every replicated op is Ed25519-signed over
  `canonical(header || ciphertext || nonce || aadHash)`; the reducer rejects
  unsigned/unauthorized ops before applying. The AEAD additional-data binds each
  envelope to `{vaultId, objectBlindId, opType, schema}`, so a ciphertext cannot
  be spliced onto a different object/op.
- **Relay blindness (not anonymity):** relays receive only ciphertext, public
  core keys, content-free roots, and signed receipts. A deep-scanning guard
  (`assertCiphertextOnly`) throws before any payload leaves the process, and
  every relay payload is mirrored to `<storage>/relay-exports/` for the verifier
  to audit. Relays and network observers still learn metadata (timing, sizes,
  IPs, that a vault exists) — Paste is **not anonymous**; Tor/VPN-style
  transport is the user's responsibility.
- **Recovery:** the vault is recoverable only from the 24-word BIP-39 phrase
  (+ optional passphrase). The phrase is shown exactly once at creation, never
  persisted, never logged, never sent to the UI again. Lose it (and all
  devices) and the data is cryptographically unrecoverable by design.
- **Deletion is cryptographic** (destroy key material). Paste **cannot** prove
  physical deletion from third-party disks — append-only history and relay
  replicas may retain old ciphertext. This limit is stated, never softened.

**Honest caveat:** device revocation today removes the writer's ability to land
new operations (the reducer gate) but does **not** re-key content, so a
previously-trusted device retains read access to history it already replicated.
See [docs/SECURITY.md](docs/SECURITY.md) §4.2.

---

## Relay & config model

Paste is a Pear-native app, so the Pear runtime gives it real UDP sockets and
HyperDHT. The relay client discovers availability relays **automatically** over
the DHT — **no operator config is required** to pair, sync, or use
store-and-forward.

- **Empty by default.** The bundled [config/fleet-relays.js](config/fleet-relays.js)
  ships with `foundationPubkeys`, `knownRelays`, and `bootstrap` all empty →
  pure HyperDHT auto-discovery over the client's relay-discovery topic. If no
  relay is reachable, the app stays fully local-first and direct-P2P.
- **Optional pinning** (only for advanced operators who want to trust a private
  fleet), resolved in priority order:
  1. `PEARPASTE_RELAYS` environment variable — highest priority; comma-separated
     `wss://host=hexpubkey` pairs (WSS-bridge pinning; relevant to browser/mobile
     clients, not Pear-native desktop).
  2. A `fleet-relays.json` dropped into the app's `Pear.config.storage` dir
     (printed on boot as `storagePath`). See
     [config/fleet-relays.example.json](config/fleet-relays.example.json) for
     the shape.
  3. The bundled `config/fleet-relays.js` defaults.

Missing, empty, or malformed config degrades silently to pure DHT
auto-discovery — config never blocks local use. Full custody model and what
relay receipts do and do **not** prove:
**[docs/RELAY_CUSTODY.md](docs/RELAY_CUSTODY.md)**.

---

## Quick start

```sh
npm install
npm run dev        # = pear run --dev .
```

`npm run dev` launches the desktop app via `pear run --dev .` (requires the
[Pear runtime](https://docs.pears.com/)). The dev vault lives under
`~/.pearpaste-dev/store` (or `$PEARPASTE_STORAGE`).

Verify the encryption invariant yourself, from source, with no keys and no
network:

```sh
npm run verify     # = node scripts/verify-encryption.js <storage-path>
```

---

## Build & release per platform

Driven by the scripts in `scripts/` (full process and CI gates in
[docs/RELEASE.md](docs/RELEASE.md)). The release is **verifier-gated** and
**signature-gated** in CI.

| Command | What it does |
|---|---|
| `npm run preflight:win` | Assert the app is win32-x64-capable (Bare-compatible, prebuilds resolve). |
| `npm run build:win` | Stage a Windows build against `PEARPASTE_LINK=pear://<key>`. |
| `npm run build:win:dry` | Print the Windows build plan without staging. |
| `npm run release:win` | Stage `--win32-x64-app` + Authenticode `signtool` (fails closed without a cert). |
| `npm run preflight:linux` | Verify Linux prebuilds, Pear entrypoints, packaging tool readiness. |
| `npm run build:linux` | Emit `dist/linux/pearpaste-<version>-linux-<arch>.tar.gz` + `.sha256`. |
| `npm run release:linux` | Linux package + required detached signature sidecar. |
| `npm run release` | `bash scripts/release-prod.sh` — conservative, confirmation/`--yes`/`--dry-run` gated production Pear release. |

Real code-signing certificates / notarization are out of scope of this repo and
are pre-beta (M6) tasks; until then native installers are internal/dev only and
the CI `release-guard` job blocks unsigned artifacts. The **v1 user install
path** is the Pear P2P link: install the Pear runtime once, then
`pear run pear://<key>`.

Mobile builds (Android APK, iOS Simulator) are documented separately in
[mobile/BUILD.md](mobile/BUILD.md).

---

## Testing

```sh
npm run test:all   # unit + integration + e2e + security + mobile
```

Run on Node 22 with normal socket permissions. Individual layers:

| Command | Layer | Covers |
|---|---|---|
| `npm run test:unit` | Unit | crypto envelope, identity/BIP-39, notes, clipboard, reducer/search |
| `npm run test:integration` | Integration | relay fallback / custody / seed, verifier behavior |
| `npm run test:e2e` | E2E (headless) | desktop bridge contract, sealed rows, tap-to-decrypt, lock clear, clip round-trip |
| `npm run test:security` | Security | no bulk decrypt, plaintext clearing, tamper/replay/revoke, pairing-expiry, storage sentinel scan |
| `npm run test:mobile` | Mobile smoke | shared Pear-end over the mobile RPC contract, pairing decode, clip copy, crash recovery |
| `npm run lint` | Lint | StandardJS over `backend/`, `scripts/`, `test/` |

Full matrix and known gaps: [docs/TESTING_MATRIX.md](docs/TESTING_MATRIX.md).
Sandbox-only runs can fail at Hyperswarm/UDX socket bind with `EPERM`; rerun
outside the sandbox before treating that as an app failure.

---

## Repository map

```
pearpaste/
  index.js / index.html   Pear desktop entry + renderer host
  pear.json               Pear app manifest (mirrors package.json#pear)
  backend/                shared Pear-end (Bare) — crypto, sync, pairing, relay, verifier
  ui/                     desktop renderer (ui/desktop) + shared UI (ui/shared)
  mobile/                 RN-CLI shell, Expo shell, shared app/, Bare worklet (see BUILD.md)
  config/                 fleet-relays.js (empty default) + fleet-relays.example.json
  scripts/                verify-encryption, inspect-store, release-prod, build-windows, package-linux, …
  test/                   unit / integration / e2e / security suites
  website/                static, dependency-free marketing site
  assets/                 app icons (Paste.icns / .ico / png)
  patches/                patch-package patches (Android-critical native lock fixes)
  docs/                   specs + security/threat/relay/release/testing docs (index below)
  LICENSE                 Apache-2.0
```

### Docs index

- [docs/PEARPASTE_TECHNICAL_SPEC.md](docs/PEARPASTE_TECHNICAL_SPEC.md) —
  canonical technical specification (architecture, data model, crypto, API).
- [docs/SECURITY.md](docs/SECURITY.md) — precise guarantees, copy rules, how to
  run the verifier, deletion limits.
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — assets, adversaries, what is
  enforced vs residual risk.
- [docs/PAIRING.md](docs/PAIRING.md) — device pairing and recovery flows.
- [docs/RECOVERY_DESIGN.md](docs/RECOVERY_DESIGN.md) — recovery-phrase design.
- [docs/RELAY_CUSTODY.md](docs/RELAY_CUSTODY.md) — blind HiveRelay availability;
  what receipts do and do not prove.
- [docs/VERIFIER_SPEC.md](docs/VERIFIER_SPEC.md) — verifier spec for an
  independent implementation.
- [docs/RELEASE.md](docs/RELEASE.md) — build, release, CI gates, supply-chain
  checklist.
- [docs/TESTING_MATRIX.md](docs/TESTING_MATRIX.md) — test gates and platform
  matrix.
- [docs/DESIGN_SPEC.md](docs/DESIGN_SPEC.md) — visual design tokens (desktop CSS
  + mobile theme).
- [mobile/BUILD.md](mobile/BUILD.md) — mobile build & run guide.

---

## License

[Apache-2.0](LICENSE).
