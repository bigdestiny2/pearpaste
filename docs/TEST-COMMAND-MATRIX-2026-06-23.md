# Pearpaste Test Command Matrix

Generated: 2026-06-23
Loop candidate: `pearpaste-test-matrix`
Source root: `/Users/localllm/Projects/pear-ecosystem/02-apps/pearpaste`
Evidence pass: Level 0/1/2 local proof pass for the compounding agent loop

## Executive Result

Pearpaste has a broad, source-backed local proof surface. In this pass, the
root lint, unit, security, worklet-mobile, integration, e2e, and platform
preflight gates all passed after the integration suite was rerun outside the
sandbox for UDX/HyperDHT socket binding.

The strongest claim this pass supports is: Pearpaste's encrypted storage,
sealed list/search surfaces, explicit decrypt model, revocation forward
secrecy, pairing admission, relay blindness, mobile worklet bridge, and
desktop backend acceptance paths are all covered by executable local tests.

The important caveat is: this is not a public-release proof. Native signing,
notarization, real installer builds, app-store/mobile-device execution, GUI
manual smoke, staged `pear://` release verification, and retained release
artifacts remain separate gates.

The source worktree was dirty before this pass. This matrix intentionally does
not normalize or revert those unrelated changes.

## Commands Run

| Command | Layer | Result | Notes |
|---|---:|---|---|
| `npm run lint` | L0 | PASS | Root `standard backend scripts test`. |
| `npm run test:unit` | L1 | PASS | 7 files, 46 tests, 246 assertions. Covers crypto envelopes, identity, clipboard, sealed notes/search, sync reducer, and self-hosted web bridge. |
| `npm run test:security` | L1 | PASS | 7 files, 27 tests, 185 assertions. Covers access boundary, AEAD/header auth, doc-claim lint, local auth, pairing, platform-release security claims, storage/relay/log sentinel scans. |
| `npm run test:mobile` | L1/L2 | PASS | 1 worklet file, 4 tests, 36 assertions. Covers worklet RPC note lifecycle, pairing bridge, clip copy, and crash recovery. |
| `npm run test:integration` | L2 | PASS after socket escalation | First sandbox run failed with `UDXSocket.bind` `EPERM`. Rerun with real socket permission completed with exit 0 across 18 integration test files. 2026-06-24 follow-up removed `--success-idle-ms`; full lane still exits naturally. |
| `npm run test:e2e` | L1 | PASS | 1 file, 3 tests, 43 assertions. Covers sealed list, tap-to-decrypt, lock clearing, clip round trip, bridge key-leak checks, locked-event clearing, and local QR generation. |
| `npm run preflight:win` | Release preflight | PASS with warning | Confirms win32 sodium prebuilds, Pear runtime asset link, `pear-electron/pre`, no unguarded Node globals, Pear runtime on PATH. Warns to verify `fs-xattr` and `macos-alias` native deps on Windows. |
| `npm run preflight:mac` | Release preflight | PASS | Confirms icon, production `pear://` link shape, Pear runtime, host/platform tools, `hdiutil`, `codesign`, and `xcrun`. |
| `npm run preflight:linux` | Release preflight | PASS with warnings | Confirms lockfile, stage entrypoints, Pear desktop/pre config, Linux sodium prebuilds, Pear runtime, tar, icons. Warns that `desktop-file-validate`, `dpkg-deb`, `rpmbuild`, and `appimagetool` are unavailable locally and that package mode should run on Linux. |
| `mobile/PearPasteMobile: npm run lint` | Mobile shell | INCONCLUSIVE | Process stayed silent for multiple intervals and was killed. Treat as a focused follow-up, not a pass/fail product signal. |

## 2026-06-24 Mobile Shell Follow-up

Root cause: `mobile/PearPasteMobile` used `eslint .`, which made ESLint crawl the whole generated RN-CLI project before reporting anything useful. On this checkout it eventually surfaced `globalThis`/codec globals from the RN polyfill and shared app, but the unbounded native-tree crawl explains the earlier silent hang on a heavier checkout.

Fix applied: the legacy shell lint command now runs a bounded helper over `mobile/PearPasteMobile` and `mobile/app`, prints its target set immediately, ignores native/vendor trees, and uses the host ESLint config for shared app files. The Jest smoke now renders the actual shared `mobile/app/App` shell with local native-module mocks instead of the generated sample `App.tsx`, so edits like `mobile/app/lib/copy.js` and `mobile/app/screens/DevicesScreen.js` are inside the local shell proof lane.

Focused commands:

| Command | Layer | Result | Notes |
|---|---:|---|---|
| `mobile/PearPasteMobile: npm run lint` | Mobile shell | PASS | Prints `eslint: bounded mobile shell source (., ../app)` immediately; no hang. |
| `mobile/PearPasteMobile: npm test -- --runInBand` | Mobile shell | PASS | 1 Jest smoke renders shared `mobile/app/App` with local native mocks. |
| `mobile/PearPasteMobile: npm run bundle:bare` | Mobile worklet bundle | PASS | Rewrote Android and iOS committed worklet bundles with RPC surface `8e97bf549b2815ac6a11ec28fc751bd9d9ed8607ea85771af6b16a774818066f`. |
| `npm --prefix mobile/pearpaste-expo run bundle:bare:check` | Canonical mobile bundle guard | PASS | Temporary regeneration matched committed platform bundles. |

Still needs real device/simulator proof: RN-CLI or Expo native app launch, real Bare worklet boot through `react-native-bare-kit`, native addon loading/linking, camera QR scan/permission UX, OS clipboard behavior, pair-create/pair-accept over real networking, device revoke from the current-device-protected UI, background/suspend plaintext clearing, and Android/iOS install/signing/build hooks.

## Integration Notes

The integration suite is the main Level 2 signal. The escalated run proved
behavior across:

- vault-switch hygiene and restored-vault stamping
- Lamport restart high-water mark behavior
- multiwriter convergence, same-tick writes, revoke convergence, and first-write pairing
- offline/raw-row rematerialization, pending repair, search backfill, and cold reopen
- pairing first sync, phantom joiner cleanup, short-code lookup, and pairing-window note materialization
- relay custody, relay fallback, relay seed payload blindness, relay-export verifier mirrors
- revocation durability, revocation pairing/selective history, rematerialization, rotation, and offline-target base safety
- search reverse-index migration and stale-pointer cleanup
- payload-free `view-changed` live refresh

2026-06-24 integration lifetime follow-up resolved the earlier
`run-brittle-suite.mjs --success-idle-ms 15000` dependency. The three
`createPearEnd` pairing/live-refresh files leaked the losing side of
`Promise.race([gotApproval, sleep(90000)])`; after the approval arrived, the
plain 90s timeout stayed ref'ed and kept Brittle open until it fired. The tests
now clear that timeout when the approval wins. A focused no-crutch rerun also
confirmed `revocation-network.test.js`, including the follow-topic case, exits
naturally; no maintained-code revocation teardown leak reproduced.

- `test/integration/pairing-first-sync.test.js`
- `test/integration/pairing-window-note.test.js`
- `test/integration/revocation-network.test.js`
- `test/integration/view-changed-live-refresh.test.js`

Evidence:

| Command | Result | Notes |
|---|---|---|
| `node scripts/run-brittle-suite.mjs test/integration/revocation-network.test.js test/integration/pairing-first-sync.test.js test/integration/pairing-window-note.test.js test/integration/view-changed-live-refresh.test.js` | PASS | No `--success-idle-ms`; all four files printed final `# ok` naturally. Focused times: revocation network 10.997s, pairing first sync 2.531s, pairing-window note 2.526s, view-changed live refresh 10.589s. |
| `npm run test:integration` | PASS | Uses `node scripts/run-brittle-suite.mjs test/integration/*.test.js`; no success-idle flag. Completed all 18 integration files with exit 0. |
| `npm run lint` | PASS | Root `standard backend scripts test`. |

## Proof Boundaries

### Proven locally in this pass

- Encrypted envelopes round-trip and fail closed on wrong keys, wrong AAD,
  ciphertext mutation, truncation, and header/signature tampering.
- Sealed list/search rows do not expose note bodies, clip text, tags, or legacy
  title fields; explicit open/copy is the plaintext boundary.
- Lock, close, background, timeout, and crash/retry paths clear or avoid
  plaintext retention where the tests inspect it.
- Revocation rotates to a fresh epoch key; revoked devices may replicate opaque
  post-revoke ciphertext but cannot decrypt it.
- Selective-chain re-pairing withholds revoked-interval keys unless
  `grantHistory` is explicit.
- Relay/custody payloads are checked for ciphertext-only material, mirrored for
  the verifier, and degrade local-first on quorum or availability failure.
- Pairing expiry, signed hello, source-side approval, short-code rendezvous,
  phantom cleanup, and N-of-M admission policies have local executable tests.
- Mobile worklet RPC and desktop backend acceptance paths are covered.
- Platform preflight scripts are wired and fail closed or warn honestly when
  local platform/tooling cannot prove a release claim.

### Not proven by this pass

- Real GUI launch via `pear run --dev .`, Electron Forge `start`, visual
  renderer smoke, or manual UX acceptance.
- Production `pear stage`, `pear seed`, HiveRelay pinning, release notes, and
  staged artifact verifier proof.
- Signed/notarized macOS `.dmg`, Authenticode Windows installer, Linux detached
  signature sidecars, or real Linux `.deb`/AppImage build on a Linux host.
- Android/iOS emulator or device install, Gradle/Xcode signing, store-specific
  entitlements, or Expo runtime lanes.
- Standalone `scripts/verify-encryption.js <fresh-vault-dir>` against a
  retained release sample vault. The verifier is exercised by security and
  integration tests, but a release-evidence run should keep the sample path and
  output.
- React Native bare shell lint/Jest/bundle proof. `npm run lint` in
  `mobile/PearPasteMobile` hung silently in this pass and was stopped.

## Recommended Next Edges

1. Completed 2026-06-24: the four success-idle integration files now exit
   naturally without `--success-idle-ms`; the full integration lane also passes
   without the flag.
2. Run a focused React Native shell lane: diagnose `mobile/PearPasteMobile`
   `eslint .` hang, then run `npm test`, `npm run bundle:bare`, and the Expo
   `bundle:bare:check` lane if applicable.
3. Launch the desktop app and capture a GUI/bridge smoke: create vault, create
   note, list sealed row, open note, lock, confirm renderer clears plaintext,
   and inspect logs for secret leakage.
4. Build a release-evidence artifact around a retained fresh vault: run the
   standalone verifier CLI, capture JSON/text output, and only then move toward
   `pear stage`/seed/pin proof.
5. Run true platform release lanes on their native hosts: Linux package on
   `linux-latest`, Windows packaging/signing on Windows, macOS notarization on
   macOS with real credentials.

## Brain Update

Pearpaste should be treated as a high-signal P2P encrypted app with strong
local security/system coverage and honest release gaps. Future loops should not
spend energy rediscovering whether basic crypto, relay blindness, revocation,
pairing, mobile worklet, or desktop backend acceptance tests exist; they do.
The compounding edge is now cleanup depth, native/mobile release proof, GUI
evidence, and retained verifier/staging artifacts.
