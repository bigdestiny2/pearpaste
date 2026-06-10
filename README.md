# Paste

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Local-first](https://img.shields.io/badge/architecture-local--first-2f6f4e)
![End-to-end encrypted](https://img.shields.io/badge/security-E2EE-7a3cff)
![Open source](https://img.shields.io/badge/source-open%20and%20verifiable-111111)
![Pear / Holepunch](https://img.shields.io/badge/network-Pear%20%2F%20Holepunch-f4c542)

Private notes and clipboard sync for your own devices.

Paste is a local-first, end-to-end encrypted notepad and clipboard companion built on the Pear / Holepunch peer-to-peer stack. It is designed for people who want a fast personal scratchpad across desktop and mobile without handing plaintext to a cloud account.

No account. No hosted database. No plaintext replicated storage. The security model, threat model, verifier, relay custody notes, pairing flow, and mobile build path are all inspectable from this repository.

**Tags:** `local-first`, `end-to-end-encryption`, `private-notes`, `clipboard-sync`, `p2p`, `Pear`, `Holepunch`, `Hypercore`, `Hyperbee`, `Autobase`, `Hyperswarm`, `React Native`, `Expo`, `open-source`, `verifiable-security`

## Why Paste Exists

Clipboards and quick notes are useful because they disappear into the background. They are also risky because the things people paste are often sensitive: access codes, links, recovery hints, message drafts, addresses, operational notes, and private fragments that were never meant to live in a cloud document.

Paste treats that everyday scratch space like private infrastructure:

- Your local devices are the trust boundary.
- Plaintext is encrypted before it enters replicated storage.
- Peers exchange encrypted records and signed operations.
- The optional relay is blind to note and clipboard contents.
- The repository includes tests and an independent verifier so the claims can be checked from source.

The goal is simple: the convenience of a shared clipboard and quick note stream, with security properties that are documented, testable, and open to public review.

## What Paste Does

Paste is currently a private pre-beta application at `0.1.0`. The core product loop is in place:

- Create encrypted notes and clipboard entries.
- Search local note history without a hosted search service.
- Open sealed rows only when the user intentionally decrypts them.
- Copy previous notes or clips back to the operating-system clipboard.
- Pair trusted devices through an explicit device flow.
- Restore access with a recovery phrase when appropriate.
- Replicate encrypted state through Pear / Holepunch networking.
- Use an optional blind relay for availability without giving the relay plaintext.

The application is intentionally utility-first. It is meant to be a personal tool for repeated daily use, not a marketing shell.

## Open Source And Verifiable

Paste is open source under Apache-2.0 and is built so security claims can be inspected rather than merely trusted.

Useful verification entry points:

```sh
npm install
npm run test:all
node scripts/verify-encryption.js <storage-path>
```

What those checks cover:

- Unit, integration, e2e, security, and mobile smoke tests.
- Crypto-envelope behavior and storage invariants.
- Signed operation handling and authorization gates.
- Relay blindness and relay-export scanning.
- Mobile RPC behavior over the same backend command surface used by the app.
- A standalone verifier that scans local stores and relay exports for plaintext sentinel leaks.

The verifier does not need network access or secret keys. It reads local storage bytes and validates the repository's encryption invariant from source.

For deeper review, start with:

- [Security model](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Technical specification](docs/PEARPASTE_TECHNICAL_SPEC.md)
- [Verifier specification](docs/VERIFIER_SPEC.md)
- [Pairing flow](docs/PAIRING.md)
- [Recovery design](docs/RECOVERY_DESIGN.md)
- [Relay custody notes](docs/RELAY_CUSTODY.md)
- [Testing matrix](docs/TESTING_MATRIX.md)
- [Mobile build guide](mobile/BUILD.md)

## Security Model

Paste is built around a direct rule: syncing should not require trusting infrastructure with plaintext.

### On-device encryption

Note titles, note bodies, tags, and clipboard text are encrypted locally before they enter Hypercore, Autobase, Hyperbee, or any relay-facing path. Stored values are represented as AEAD crypto envelopes, and object identifiers in replicated headers are blinded.

### Signed operations

Replicated operations are signed by authorized device keys. Receivers reject unsigned, mis-signed, malformed, or unauthorized operations before applying them to the materialized view.

### Sealed rows

The app can render list rows without decrypting every secret on screen. Plaintext is only opened for deliberate user actions and is cleared on lock or lifecycle transitions.

### Pairing and recovery

Paste uses explicit device pairing rather than invisible account sessions. Recovery is phrase-based. The recovery phrase is powerful, so the docs describe the boundaries plainly: if the phrase is compromised, the safe response is to create a new vault and re-pair trusted devices.

### Blind relay

The relay exists for availability, not custody. It should see ciphertext, public core keys, content-free commitments, and receipts, but not note bodies, clipboard text, or key material. Relay payloads are mirrored locally for verifier inspection.

This is relay blindness, not anonymity. A relay or network observer can still learn metadata such as timing, sizes, IPs, and the fact that a vault exists.

### Deletion and revocation limits

Paste documents its limits instead of smoothing them over. Deletion is cryptographic, by removing access to key material. Paste cannot prove physical deletion from third-party disks or devices that already received ciphertext. Revocation blocks future trusted writes from removed devices, but historical data already replicated to a previously trusted device cannot be clawed back.

Read the full model in [docs/SECURITY.md](docs/SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Architecture

Paste uses one shared backend core for desktop and mobile-oriented paths. UI shells talk to it through an explicit RPC boundary; the backend owns secrets, storage, sync, device policy, and verification.

```text
Desktop UI / Tray
        |
        v
Desktop bridge RPC
        |
        v
Paste backend
  - identity and recovery
  - crypto envelopes
  - notes and clipboard services
  - materialized views
  - device authorization
  - replication and relay logic
        |
        v
Pear / Holepunch networking
        |
        v
Trusted devices

Mobile UI
        |
        v
Bare worklet RPC
        |
        v
Same backend command surface
```

Core technologies:

- **Pear / Holepunch:** desktop runtime and peer-to-peer application foundation.
- **Hypercore / Corestore:** append-only logs and local replicated storage.
- **Autobase:** multi-writer operation history.
- **Hyperbee:** local materialized views and indexes.
- **Hyperswarm / HyperDHT:** peer discovery and connection.
- **sodium-native:** cryptographic primitives used by the backend.
- **React Native / Expo:** mobile host surfaces and shared mobile UI.

## Platforms

| Platform | Path | Status |
| --- | --- | --- |
| Desktop Pear app | `index.js`, `index.html`, `ui/`, `backend/` | Primary desktop path |
| React Native mobile host | `mobile/PearPasteMobile/` | Verified host project documented in `mobile/BUILD.md` |
| Expo mobile host | `mobile/pearpaste-expo/` | Expo host source present for the mobile path |
| Shared mobile UI | `mobile/app/` | Screens and bridge client shared by mobile hosts |
| Mobile backend worklet | `mobile/backend/` | Bare worklet and generated platform bundles |
| Docs and specs | `docs/` | Security, threat, verifier, pairing, recovery, release, and testing docs |

See [mobile/BUILD.md](mobile/BUILD.md) for the current mobile build and run guide.

## Quick Start

Install dependencies:

```sh
npm install
```

Run the desktop development app:

```sh
npm run dev
```

Run the full test suite:

```sh
npm run test:all
```

Run the standalone encryption verifier against a Paste storage directory:

```sh
node scripts/verify-encryption.js <storage-path>
```

## Mobile Development

Run the mobile RPC smoke tests from the repo root:

```sh
npm run test:mobile
```

Bundle the Pear-end for the committed React Native host:

```sh
npm --prefix mobile/PearPasteMobile install --legacy-peer-deps
npm --prefix mobile/PearPasteMobile run bundle:bare
```

Start the React Native host:

```sh
npm --prefix mobile/PearPasteMobile run start
npm --prefix mobile/PearPasteMobile run android
npm --prefix mobile/PearPasteMobile run ios
```

Expo host commands are also available:

```sh
npm --prefix mobile/pearpaste-expo install
npm --prefix mobile/pearpaste-expo run start
npm --prefix mobile/pearpaste-expo run android
npm --prefix mobile/pearpaste-expo run ios
```

The mobile build guide calls out which steps are verified without a phone, which steps need native tooling, and which release steps require private signing credentials.

## Repository Map

| Path | Purpose |
| --- | --- |
| `backend/` | Core worker, storage, crypto, RPC, replication, pairing, relay, and verifier logic |
| `ui/` | Desktop UI and shared copy rules |
| `mobile/` | React Native host, Expo host, shared mobile UI, worklet code, and mobile tests |
| `test/` | Unit, integration, e2e, security, and mobile contract tests |
| `docs/` | Technical spec, security model, threat model, verifier, pairing, recovery, relay, release, and testing docs |
| `scripts/` | Verifier, store inspection, build, release, and packaging helpers |
| `config/` | Relay configuration defaults and example fleet config |
| `assets/` | App icons and platform assets |

## Project Status

Paste is not yet a general-audience stable release.

- Version: `0.1.0`
- License: Apache-2.0
- Desktop app: active development
- Mobile app: active development
- Relay: optional availability component
- Public binary distribution: release hardening and signing still ongoing

Pre-beta caveats:

- Clipboard behavior depends on operating-system permissions and platform constraints.
- Endpoint compromise remains out of scope for any local-first encrypted app; if a device is compromised while plaintext is visible, encryption cannot undo that.
- Relay blindness does not provide network anonymity.
- Revocation and deletion are forward-looking security controls; they cannot erase data already received by a previously trusted device.
- Public installers still need the usual signing, notarization, and release-hardening work before broad adoption.

## Documentation

- [Technical specification](docs/PEARPASTE_TECHNICAL_SPEC.md)
- [Security model](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Verifier specification](docs/VERIFIER_SPEC.md)
- [Pairing flow](docs/PAIRING.md)
- [Recovery design](docs/RECOVERY_DESIGN.md)
- [Relay custody notes](docs/RELAY_CUSTODY.md)
- [Testing matrix](docs/TESTING_MATRIX.md)
- [Design spec](docs/DESIGN_SPEC.md)
- [Release notes and checklist](docs/RELEASE.md)
- [Mobile build guide](mobile/BUILD.md)

## License

Paste is open source under the [Apache License 2.0](LICENSE).

