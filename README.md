# Paste

[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
![Local-first](https://img.shields.io/badge/architecture-local--first-2f6f4e)
![End-to-end encrypted](https://img.shields.io/badge/security-E2EE-7a3cff)
![Open source](https://img.shields.io/badge/source-open%20and%20verifiable-111111)
![Mobile: Expo](https://img.shields.io/badge/mobile-Expo-000020)

Private notes and clipboard sync for your own devices.

Paste is a local-first, end-to-end encrypted notepad and clipboard companion built on Pear, Holepunch, Hypercore, Hyperbee, Autobase, Corestore, and Hyperswarm. It is designed for people who want a fast personal scratchpad across desktop and mobile without handing plaintext to a cloud account.

No account. No hosted database. No plaintext replicated storage. The source, build path, RPC boundary, crypto model, and committed mobile worklet bundles are all inspectable from this repository.

**Tags:** `local-first`, `end-to-end-encryption`, `private-notes`, `clipboard-sync`, `p2p`, `Pear`, `Holepunch`, `Hypercore`, `Hyperbee`, `Autobase`, `Hyperswarm`, `Expo`, `React Native`, `open-source`, `verifiable-security`

## Why Paste Exists

Modern clipboards and quick notes are useful because they disappear into the background. They are also risky because the things people paste are often sensitive: access codes, links, recovery hints, fragments of messages, addresses, private drafts, and operational notes.

Paste treats that everyday scratch space like private infrastructure:

- Your local devices are the trust boundary.
- Plaintext is encrypted before it enters replicated storage.
- Peers exchange encrypted records and signed operations.
- The optional relay is blind to note contents.
- Mobile ships through the Expo app path, with the bare worklet bundles committed and checked for drift.

The goal is simple: the convenience of a shared clipboard and quick note stream, with security properties that can be read, tested, and challenged in public.

## What Paste Does

Paste is currently a private pre-beta application at `0.1.0`. The core product loop is already in place:

- Capture private notes from a desktop tray app or mobile client.
- Copy, search, pin, and delete notes across your own devices.
- Tap to decrypt sealed rows instead of rendering every secret by default.
- Pair devices with a recovery phrase and explicit device identities.
- Replicate encrypted state over Pear/Holepunch networking.
- Use an optional relay for reachability without giving the relay plaintext.
- Run a local development server for the Expo mobile app.
- Verify that committed mobile worklet bundles match the backend RPC surface.

The current UI is intentionally utility-first: it is a personal tool for repeated daily use, not a marketing shell.

## Open Source And Verifiable

Paste is meant to be inspected. The project keeps implementation, docs, tests, mobile build notes, and security notes in the same repository so claims can be checked against code.

Useful verification entry points:

```sh
npm install
npm run test:all
npm run verify
npm --prefix mobile/pearpaste-expo run bundle:bare:check
```

What those checks cover:

- Unit and integration tests for the backend, desktop bridge, crypto flows, storage, relay behavior, and mobile RPC contract.
- A verifier that exercises repository-level security assumptions.
- A mobile bundle guard that fails when committed worklet bundles no longer match the current backend RPC surface.
- Expo/mobile build metadata that documents the path used for the app that actually ships.

For deeper review, start with:

- [Security model](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Recovery design](docs/RECOVERY_DESIGN.md)
- [Revocation design](docs/REVOCATION_DESIGN.md)
- [Shipping notes](docs/SHIPPING.md)
- [Mobile build notes](mobile/BUILD.md)

## Security Model

Paste is built around the idea that syncing should not require trusting infrastructure with plaintext.

### On-device encryption

Notes are encrypted locally before they are written into replicated storage. Replication moves encrypted records and signed operations, not plaintext note bodies.

The backend keeps note state in Hyperbee/Corestore-backed storage and uses an Autobase-style operation log for multi-device history. Materialized views can be rebuilt from the signed operation stream.

### Tap-to-decrypt rows

The UI can present sealed rows without immediately decrypting every note body. This keeps sensitive content from appearing on screen just because the app opened or synced.

### Signed operations

Device writes are represented as signed operations. That makes the replicated log auditable and gives the app a way to distinguish valid device activity from malformed or unauthorized writes.

### Device pairing

Pairing is explicit. A device joins using a recovery phrase and device identity flow rather than a hosted account login. Device state, capabilities, and revocation behavior are part of the local security model.

### Forward-looking revocation

Revocation rotates future content keys and prevents a removed device from making new trusted writes. Like any replicated end-to-end encrypted system, revocation cannot erase data a device already had while it was trusted.

### Blind relay

The relay exists for connectivity, not custody. It forwards encrypted envelopes and replication traffic while staying outside the plaintext trust boundary.

The intended posture is:

- The relay can observe metadata needed to move traffic.
- The relay should not learn note contents.
- Clients remain responsible for authentication, encryption, and authorization.

### Recovery phrase boundaries

The recovery phrase is powerful. If it is compromised, the safe response is to create a new vault and re-pair trusted devices. Paste documents this boundary plainly instead of pretending recovery secrets are harmless.

### Open threat model

Paste does not claim magic security. The threat model calls out what is protected, what is not protected, and where future hardening remains. That includes metadata exposure, endpoint compromise, clipboard OS behavior, supply-chain trust, and the limits of deleting data from devices that may already have received it.

Read the full model in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Architecture

Paste is split into a small number of intentionally inspectable surfaces:

```text
Desktop UI / Tray
        |
        v
Desktop bridge RPC
        |
        v
Backend worker
  - crypto
  - storage
  - materialized views
  - replication
  - device policy
        |
        v
Pear / Holepunch networking
        |
        v
Other trusted devices

Expo mobile app
        |
        v
Committed bare worklet bundles
        |
        v
Backend RPC surface
```

The desktop app and Expo app talk to the backend through an explicit RPC layer. That boundary is tested because it is the place where UI convenience meets private data handling.

## Platforms

| Platform | Path | Status |
| --- | --- | --- |
| Desktop Pear app | `index.html`, `main.js`, `tray.js`, `backend/` | Primary desktop path |
| Mobile app | `mobile/pearpaste-expo/` | Canonical mobile path |
| Mobile worklet bundles | `mobile/backend/app.ios.bundle.js`, `mobile/backend/app.android.bundle.js` | Committed and guarded against staleness |
| Legacy React Native shell | `mobile/PearPasteMobile/` | Historical reference only |
| Marketing assets | `assets/marketing/` | Social previews, launch graphics, and editable brand source |

The Expo app is the mobile implementation that should be built, tested, documented, and shipped. See [mobile/BUILD.md](mobile/BUILD.md) for the current mobile build flow.

## Quick Start

Install dependencies:

```sh
npm install
```

Run the desktop development app:

```sh
npm run dev
```

Run the focused mobile contract tests:

```sh
npm run test:mobile
```

Check the committed mobile worklet bundles:

```sh
npm --prefix mobile/pearpaste-expo run bundle:bare:check
```

Run the broader test suite:

```sh
npm run test:all
```

Run repository verification:

```sh
npm run verify
```

## Mobile Development

The mobile app lives in [mobile/pearpaste-expo](mobile/pearpaste-expo). It owns the Expo configuration, package metadata, plugin wiring, and bare bundle guard.

Common commands:

```sh
npm --prefix mobile/pearpaste-expo install --legacy-peer-deps
npm --prefix mobile/pearpaste-expo run start
npm --prefix mobile/pearpaste-expo run bundle:bare
npm --prefix mobile/pearpaste-expo run bundle:bare:check
npm --prefix mobile/pearpaste-expo run android
npm --prefix mobile/pearpaste-expo run ios
```

The generated bare worklet bundles are committed because native mobile builds consume them. The build-step guard makes drift visible before a stale RPC bundle can ship.

When native projects need to be regenerated, follow the full flow in [mobile/BUILD.md](mobile/BUILD.md), including `npx expo prebuild --clean`.

## Functionality

Paste is centered on a few daily workflows:

- **Capture:** create quick notes and clipboard entries with minimal friction.
- **Find:** search local note history without sending queries to a hosted service.
- **Reuse:** copy a previous note or clipboard item back into the OS clipboard.
- **Protect:** keep rows sealed until the user intentionally reveals them.
- **Sync:** replicate encrypted state between trusted devices.
- **Pair:** add devices through a phrase-backed flow.
- **Recover:** restore access with the recovery phrase when appropriate.
- **Revoke:** remove device trust for future writes and future content keys.

The application is designed so those workflows stay available even as the transport layer changes. Pear/Holepunch provides the peer-to-peer foundation; the app-level crypto and RPC contract remain explicit in this repository.

## Repository Map

| Path | Purpose |
| --- | --- |
| `backend/` | Core worker, storage, crypto, RPC, replication, and relay-facing logic |
| `test/` | Backend, bridge, mobile contract, relay, and integration tests |
| `mobile/pearpaste-expo/` | Canonical Expo mobile app |
| `mobile/backend/` | Committed mobile worklet bundles consumed by native builds |
| `docs/` | Security, threat model, shipping, and project documentation |
| `scripts/` | Verification, release, and helper scripts |
| `assets/marketing/` | Launch graphics, social images, and editable brand source |

## Project Status

Paste is not yet a general-audience stable release. Current status:

- Version: `0.1.0`
- Desktop app: active development
- Expo mobile app: canonical mobile path
- Mobile worklet bundles: committed and guarded
- Relay: optional infrastructure component
- Installers: shipping path documented, public release hardening still ongoing

Notable pre-beta caveats:

- Clipboard capture can be constrained by operating-system permissions and platform behavior.
- Endpoint compromise remains out of scope for any local-first encrypted app; if a device is compromised while plaintext is visible, encryption cannot undo that.
- Revocation is forward-looking and cannot erase data already received by a previously trusted device.
- Public binary distribution still needs the usual release hardening, signing, and reproducible-build polish before broad adoption.

## Development Principles

Paste tries to keep security and usability in the same conversation:

- Prefer local control over account dependency.
- Prefer encrypted replicated data over plaintext cloud state.
- Prefer explicit device trust over invisible session sprawl.
- Prefer auditable code paths over hidden services.
- Prefer honest caveats over inflated claims.

That is the standard the project should be held to as it grows.

## Documentation

- [Security model](docs/SECURITY.md)
- [Threat model](docs/THREAT_MODEL.md)
- [Recovery design](docs/RECOVERY_DESIGN.md)
- [Revocation design](docs/REVOCATION_DESIGN.md)
- [Shipping notes](docs/SHIPPING.md)
- [Mobile build notes](mobile/BUILD.md)
- [Relay custody notes](docs/RELAY_CUSTODY.md)
- [Release checklist](docs/RELEASE.md)

## License

Paste is open source under the [Apache License 2.0](LICENSE).
