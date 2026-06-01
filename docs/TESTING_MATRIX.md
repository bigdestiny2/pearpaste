# Paste Testing Matrix

Status from the May 18, 2026 local audit:

- `npm run test:all` passes on Node 22 when run with normal socket permissions.
- Sandbox-only runs can fail at Hyperswarm/UDX socket bind with `EPERM`; rerun outside the sandbox before treating that as an app failure.
- CI runs the mobile worklet smoke suite in addition to unit, integration, e2e, and security tests.
- CI also runs Linux packaging preflight/dry-run coverage and a React Native mobile app lane (`npm ci`, ESLint, Jest, mobile lockfile checks).
- `npm run lint` is blocking. Current StandardJS debt is no longer masked; failures should be fixed by the owning code lanes before a green release.

## Gates

| Layer | Command / gate | Covers | Current gap |
|---|---|---|---|
| Lint | `npm run lint` | StandardJS over backend/scripts/test | Existing style debt is exposed instead of hidden |
| Unit | `npm run test:unit` | crypto envelope, identity, notes, clipboard, reducer/search | No renderer DOM assertions |
| Integration | `npm run test:integration` | relay fallback/custody/seed, verifier behavior | Uses harnesses/stubs for relays where appropriate |
| E2E headless | `npm run test:e2e` | desktop bridge contract, sealed rows, tap-to-decrypt, lock clear, clip round-trip | No real Pear window automation yet |
| Security | `npm run test:security` | no bulk decrypt, plaintext clearing, tamper/replay/revoke, pairing expiry, storage sentinel scan | Needs periodic external security review before public beta |
| Mobile smoke | `npm run test:mobile` | shared Pear-end over mobile RPC contract, pairing decode, clip copy, crash recovery | Does not replace native iOS/Android builds |
| Mobile app | CI `mobile-app` | React Native `npm ci`, ESLint, Jest, package/Gem/Pod lockfile presence | Does not run Xcode or Gradle native builds |
| Verifier | `node scripts/verify-encryption.js <vault>` | independent local storage and relay-export plaintext scan | Should be run against staged/release vault fixtures too |
| Supply chain | CI `supply-chain` | lockfile and prod dependency audit | Add SBOM/provenance before public beta |
| Linux package | `npm run preflight:linux`; CI `linux-package` | Linux prebuilds, Pear entrypoints, package tool readiness, dry-run packaging plan | AppImage/.deb/.rpm wrapping and distro signing remain maintainer tasks |
| Release guard | CI `release-guard` | verifier has teeth, unsigned artifacts rejected when present | Real signing certs and notarization are still manual/TODO |

## Platform Matrix

| Platform | Minimum automated gate | Manual/platform gate before release |
|---|---|---|
| macOS Pear desktop | `npm run test:all`; `pear run --dev .` smoke | Create/restore vault, note edit, clip monitor, lock/background clear, pair invite QR, verifier proof, signed/notarized wrapper |
| Linux Pear desktop | `npm run test:all`; `npm run preflight:linux`; CI `linux-package`; `pear run --dev .` smoke | Clipboard backend behavior, package wrapper launch, tray/global paste if enabled, distro-specific package policy/signing |
| Windows Pear desktop | Node 22 CI plus wrapper build job | Clipboard read/write, path/storage behavior, Authenticode signature, Defender/SmartScreen install check |
| iOS | `npm run test:mobile`; CI `mobile-app` lockfile/install/lint/Jest | Xcode simulator build, physical device TestFlight, background/foreground plaintext clear, manual paste/share-sheet capture, no background clipboard claim |
| Android | `npm run test:mobile`; CI `mobile-app` lockfile/install/lint/Jest | Gradle emulator build, physical APK/internal track, foreground clipboard capture, background limitation copy, process death/retry |

## Improvement Plan

1. Add a desktop Pear smoke harness that launches `pear run --dev .`, creates a worker through `Pear.worker.run`, and asserts the renderer bridge can unlock/create/list/lock.
2. Add a small browser/DOM harness for `ui/desktop/app.js` so sealed rows, note open/close, clipboard controls, and banner states are tested without a full OS package.
3. Add native CI lanes outside this repo's Node-only workflow: macOS wrapper build/sign/notarize, Windows wrapper build/sign, AppImage/.deb/.rpm smoke, iOS simulator build, Android Gradle build.
4. Add artifact-level release checks: generated SBOM, checksums, detached signatures, verifier output bundled with release notes, and a planted-leak negative test for staged files.
5. Add cross-device soak tests on a private testnet: two desktops plus one mobile worklet, concurrent note edits, revoke/re-pair, relay unavailable/reavailable, and long-running clipboard monitor pause/resume.
