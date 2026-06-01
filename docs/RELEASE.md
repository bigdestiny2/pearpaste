# Paste Release & Distribution

How Paste is built, verified, and shipped — dev, production Pear release,
native desktop wrappers, mobile bundle — plus the §17 supply-chain pre-beta
checklist. The release is **verifier-gated** and **signature-gated** in CI.

Spec references: §12 (desktop packaging), §13 (mobile packaging), §17
(release & supply-chain), §21 Agent 5 acceptance. Companions: SECURITY.md,
VERIFIER_SPEC.md. Scripts referenced here are owned by Agent 3
(`scripts/release-prod.sh`) and Agent 2 (`scripts/pin-on-hiverelay.js`,
`scripts/verify-encryption.js`); this doc describes the process and the gates.

---

## 1. Development

```sh
npm install
pear run --dev .
```

Headless (no GUI) backend + bridge boots automatically for tests/harness; the
dev vault lives under `~/.pearpaste-dev/store` (or `$PEARPASTE_STORAGE`).

Before any release, the full local gate must pass:

```sh
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
npm run test:security
npm run test:mobile
npm run preflight:linux
node scripts/verify-encryption.js <a-fresh-vault-dir>   # exit 0 required
```

CI runs these gates plus the React Native app install/lint/Jest lane under
`mobile/PearPasteMobile`.

---

## 2. Production Pear release

Driven by `scripts/release-prod.sh` (Agent 3). The §17 sequence:

1. **Stage** the app (`pear stage`), mirroring staged files to a local dir.
2. **Run the verifier against the staged files** — `scripts/
   verify-encryption.js` must exit 0 (no sentinel, all values AEAD
   envelopes). A non-zero exit aborts the release. This is the
   **verifier-gated release** requirement (§17, §21).
3. **Release** the production Pear link (`pear release`) only after (2).
4. **Pin the app package on HiveRelay** — `scripts/pin-on-hiverelay.js`
   (Agent 2), blind / p2p-only, so installs stay reachable.
5. **Publish release notes** documenting exactly what the proof does and does
   not prove (link VERIFIER_SPEC.md, SECURITY.md §4, RELAY_CUSTODY.md §6).

`release-prod.sh` is conservative: every publishing step is gated by an
explicit confirmation or `--yes`, and `--dry-run` prints the plan without
staging/releasing. Pear's P2P update path means the production link updates
without rebuilding native wrappers.

---

## 3. Native desktop wrappers

Per spec §12/§17:

- Build via the Pear binary-wrapper path for macOS, Linux, Windows.
- **Sign macOS and Windows artifacts.** Linux packages stay unsigned or
  distro-appropriate.
- Preserve the Pear P2P update path so the wrapper rarely needs a rebuild.

> **Signing TODO (real certificates are out of scope of this repository).**
> The signing steps are stubbed/TODO in `scripts/release-prod.sh`. Before
> public beta a maintainer must provide: an Apple Developer ID + notarization
> credentials (macOS, `codesign` + `notarytool`), an Authenticode certificate
> (Windows, `signtool`), and the chosen Linux signing convention. Until then,
> native installers are **internal/dev only** and the CI `release-guard` job
> blocks any unsigned artifact from being treated as a release (see §6).

### 3.1 Windows (win32-x64)

Paste is a Pear app, so Windows has two distribution tiers. Orchestrated
by `scripts/build-windows.mjs` (npm: `preflight:win`, `build:win`,
`build:win:dry`, `release:win`); CI job `windows-build` (windows-latest)
exercises it every push.

**Readiness (any OS, incl. macOS):**

```sh
npm run preflight:win
```

Asserts the app is win32-capable: `sodium-native` ships a `win32-x64`
prebuild (the only native addon — everything else is pure-JS + Bare),
`pear-electron`'s `pear.assets.ui` resolves the win32 runtime via
`/by-arch/%%HOST%%`, `pear.pre = pear-electron/pre`, and no unguarded
Node-only globals (`process`/`AbortController`/`Buffer`) remain in
worker-reachable code — those break on the **Bare** runtime that Pear uses.
The gate fails the build on any win32 incompatibility.

**Tier 1 — P2P link (recommended v1; produced from any OS):**

```sh
# one-time: bootstrap the project link (interactive trust prompt;
# `pear init` was removed in current Pear, so the link is created by the
# first stage). Record the printed pear:// key.
pear stage <channel>            # e.g. pear stage production
PEARPASTE_LINK=pear://<key> npm run build:win   # or: build:win:dry
```

A Windows user installs the Pear runtime once and runs
`pear run pear://<key>`. Pear automatically fetches the win32-x64 runtime
binary **and** the win32-x64 native prebuilds for that machine — no
cross-compile, no per-release Windows rebuild (the P2P update path carries
new versions).

**Tier 2 — standalone signed `PearPaste-Setup.exe` (v1.5):**

Must run on a **Windows host** (or CI `windows-latest`) with a real
Authenticode certificate:

```powershell
$env:PEARPASTE_LINK      = "pear://<key>"
$env:PEARPASTE_WIN_WRAPPER = "<staged win32-x64 app dir>"
$env:PEARPASTE_WIN_CERT  = "C:\path\to\authenticode.pfx"
$env:PEARPASTE_WIN_CERT_PASS = "<pfx password>"
npm run release:win        # pear stage --win32-x64-app + signtool
```

`release:win` stages with `--win32-x64-app`, then `signtool sign /fd SHA256
/tr <RFC3161 timestamp> /td SHA256`. Wrap the signed app dir with your
installer (NSIS/WiX), then `signtool` the resulting `Setup.exe` too. With no
`PEARPASTE_WIN_CERT` the script **fails closed**, and the `release-guard` CI
job blocks any unsigned artifact (§6). Real certs remain out of repo scope
(spec §17): a maintainer supplies the Authenticode cert before public beta.

### 3.2 Linux

Linux now has a concrete preflight/package helper:

```sh
npm run preflight:linux
PEARPASTE_LINK=pear://<key> npm run build:linux
```

`scripts/package-linux.mjs` verifies the root lockfile, Pear stage
entrypoints, `pear-electron/pre`, Linux `sodium-native` prebuilds, `tar`, and
optional distro tooling (`desktop-file-validate`, `dpkg-deb`, `rpmbuild`,
`appimagetool`). `build:linux` must run on Linux and emits
`dist/linux/pearpaste-<version>-linux-<arch>.tar.gz` plus a `.sha256` file.
The tarball is a distro-neutral launcher for the production `pear://` link and
can be wrapped into AppImage/.deb/.rpm by a maintainer. `release:linux`
requires a detached signature sidecar (`.sig/.asc/.minisig/.p7s`) to match the
CI release-artifact gate.

---

## 4. Mobile

Per spec §13:

- The React Native app lives in `mobile/PearPasteMobile`.
- CI runs `npm ci`, ESLint, and Jest from
  `mobile/PearPasteMobile/package-lock.json`.
- CI checks the mobile JS, Ruby, and CocoaPods lockfiles:
  `package-lock.json`, `Gemfile.lock`, and `ios/Podfile.lock`.
- Platform-native CI (Xcode / Gradle) still belongs outside this Node-only
  workflow.
- Android release builds must use a private signing keystore supplied through
  `PEARPASTE_ANDROID_KEYSTORE`, `PEARPASTE_ANDROID_KEYSTORE_PASSWORD`,
  `PEARPASTE_ANDROID_KEY_ALIAS`, and `PEARPASTE_ANDROID_KEY_PASSWORD`;
  Gradle fails closed if these are missing, and release builds do not use the
  checked-in debug keystore.
- Publish internal test builds first (TestFlight / internal APK), store
  builds later.
- The same encryption invariant applies: the mobile Pear-end uses the same
  `backend/` crypto; the verifier reasoning is identical.

---

## 5. Supply-chain pre-beta checklist (§17)

Required before public beta. Status reflects this repository.

| Item | Status | Where / how |
|---|---|---|
| Lockfile committed | Done | `package-lock.json` present; CI `supply-chain` fails if absent; `npm ci` everywhere |
| Mobile lockfiles committed | Done (CI) | CI `mobile-app` checks `mobile/PearPasteMobile/package-lock.json`, `Gemfile.lock`, and `ios/Podfile.lock` |
| Dependency audit | Done (CI) | `npm audit --omit=dev --audit-level=high` in CI `supply-chain`; fails on high/critical in shipped deps |
| Reproducible build notes | Documented (§7) | Pinned lockfile + pinned Node 22 + `npm ci`; full attestation is an M6 task |
| Signed releases | Gated, certs TODO | CI `release-guard` blocks unsigned artifacts; real certs out of scope (§3) |
| Public verifier CLI | Done | `scripts/verify-encryption.js`, runnable from source, no keys/network; VERIFIER_SPEC.md |
| Independent verifier impl | Spec provided | VERIFIER_SPEC.md is the independent-implementation guide (§17 "if feasible") |
| Verifier-gated release | Done | `release-prod.sh` step 2 + CI `release-guard` |
| External security review | Open (M6) | Engage a third party before public beta (SECURITY.md §5) |

---

## 6. The CI release gates (`.github/workflows/ci.yml`)

Two jobs enforce §21 Agent 5 release acceptance:

- **`sentinel-guard`** — builds a fresh vault through the real Pear-end with
  sentinel-laden notes/clips, runs `scripts/verify-encryption.js` (non-zero
  exit on any leak fails the build), and greps committed source/artifacts for
  a leaked sentinel. → *CI fails on plaintext sentinel leak.*
- **`release-guard`** — asserts the verifier passes a clean built vault **and
  fails a planted leak** (proving the gate has teeth), then enforces that
  every file in the release-artifact dir (`$RELEASE_ARTIFACTS`, default
  `dist/`) has a detached signature sidecar (`.sig/.asc/.minisig/.p7s`);
  artifacts with no signature **fail the build**. With no artifacts present
  (normal PR/CI) the gate is documented and passes; it activates on release
  builds. → *CI fails on unsigned release artifact.*

`supply-chain` enforces the lockfile + dependency audit. `test` runs lint and
all desktop/shared test suites on Node 22. `linux-package` runs the Linux
packaging preflight and dry-run package plan. `mobile-app` installs the React
Native app from its lockfile, runs mobile ESLint, and runs mobile Jest.

To exercise the signing gate locally before a real release:

```sh
mkdir -p dist
# place built artifacts in dist/, then for each:
#   minisign -Sm dist/pearpaste-macos.zip      # -> dist/pearpaste-macos.zip.minisig
RELEASE_ARTIFACTS=dist  # (the job reads this; default is dist/)
```

Any artifact in `dist/` without a `.sig/.asc/.minisig/.p7s` neighbor fails
`release-guard`.

---

## 7. Reproducible build notes (interim)

Full byte-for-byte reproducibility attestation is an M6 task. The interim
guarantees that materially reduce supply-chain trust:

- **Pinned dependencies:** `package-lock.json` is committed; every CI/release
  install is `npm ci` (lockfile-exact, no resolution drift).
- **Pinned runtime:** Node 22 in CI; `engines.node >= 20`.
- **No build-time codegen** of backend logic; the Pear-end is plain ESM.
- **Independent re-derivation of the security claim:** anyone can clone at a
  tag, `npm ci`, create a vault, and run `scripts/verify-encryption.js` to
  confirm the storage is sentinel-free and AEAD-only — the central security
  property does not depend on trusting the maintainer's machine
  (VERIFIER_SPEC.md). A second, independent verifier implementation can be
  built from VERIFIER_SPEC.md for defense in depth.

Before public beta, add: a pinned toolchain manifest, a documented
deterministic stage/pack procedure with expected digests, and a published
signed build attestation.
