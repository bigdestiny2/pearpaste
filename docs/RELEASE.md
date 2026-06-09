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

Driven by `scripts/release-prod.sh` (Agent 3). Reworked for the **current Pear
CLI** — `pear init` and `pear release` were **removed** (verified against Pear
v0.3243). The §17 sequence:

1. **Stage** the app (`pear stage --json <channel>`), mirroring staged files to
   a local dir and capturing the `link` (`pear://<z32-key>`) and the
   **`verlink`** — the versioned, immutable production link
   `pear://<fork>.<length>.<z32-key>` (Pear keys are z-base-32).
2. **Run the verifier against the staged files** — `scripts/
   verify-encryption.js` must exit 0 (no sentinel, all values AEAD
   envelopes). A non-zero exit aborts the release. This is the
   **verifier-gated release** requirement (§17, §21).
3. **Publish + seed the versioned link** only after (2): the `verlink` from (1)
   is the production link; `pear seed <link>` keeps it reachable. (`pear
   release` no longer exists.) A *signed* production link uses the quorum-cosign
   flow `pear provision` + `pear multisig` (needs quorum keys, out of repo
   scope).
4. **Pin the app package on HiveRelay** — `scripts/pin-on-hiverelay.js`
   (Agent 2), blind / p2p-only, so installs stay reachable.
5. **Publish release notes** documenting exactly what the proof does and does
   not prove (link VERIFIER_SPEC.md, SECURITY.md §4, RELAY_CUSTODY.md §6).

`release-prod.sh` is conservative: every publishing step is gated by an
explicit confirmation or `--yes`, and `--dry-run` prints the plan without
staging/seeding. A real run **refuses to publish if `--skip-verify` bypassed
the gate**. Pear's P2P update path means the production link updates without
rebuilding native wrappers. The full desktop production-readiness checklist
(accounts, certs, costs, phased rollout) lives in **docs/SHIPPING.md**.

---

## 3. Native desktop wrappers

Per spec §12/§17:

- Build each platform app dir with **`pear build --<platform>-app <dir>`**
  (current Pear; `pear init --wrapper` was removed). `pear build` packages an
  **already-built** platform app directory into the deployment folder and
  enforces that the app dir basename equals `package.json` `productName ?? name`
  — we pin `productName: "Paste"`, so the expected basename is `Paste`.
- **Sign macOS and Windows artifacts.** Linux packages stay unsigned or
  distro-appropriate.
- Preserve the Pear P2P update path so the wrapper rarely needs a rebuild.

> **Signing TODO (real certificates are out of scope of this repository).**
> The signing steps in `scripts/release-prod.sh`, `scripts/build-macos.mjs`, and
> `scripts/build-windows.mjs` are wired but **fail closed** without credentials.
> Before public beta a maintainer must provide: an Apple Developer ID Application
> identity + notarization credentials (macOS, `codesign` + `notarytool` +
> `stapler`), an Authenticode certificate (Windows, `signtool`), and the chosen
> Linux signing convention (GPG/minisign). Until then, native installers are
> **internal/dev only** and the CI `release-guard` job blocks any unsigned
> artifact from being treated as a release (see §6). Accounts, certificate
> types, and costs are tabulated in **docs/SHIPPING.md**.

> **Unsigned / dev mode (before certs are bought).** Each platform script can
> emit a **clearly-marked UNSIGNED** artifact so dev/CI can produce installers
> before certificates exist — **without** weakening the fail-closed `--release`
> path:
>
> | Platform | Unsigned (dev/CI) | Signed release (fails closed) |
> |---|---|---|
> | macOS | `npm run build:mac` → `Paste-<ver>-unsigned.dmg` | `npm run release:mac` (needs `PEARPASTE_MAC_IDENTITY` + notary auth) |
> | Windows | `npm run build:win:unsigned` (packs the app dir, skips `signtool`) | `npm run release:win` (needs `PEARPASTE_WIN_CERT`) |
> | Linux | `npm run build:linux:unsigned` (`.deb`/AppImage/tarball, no sidecar required) | `npm run release:linux` (requires a `.sig/.asc/.minisig/.p7s` sidecar per artifact) |
>
> `--unsigned` is rejected in combination with `--release` (a signed release must
> not silently become unsigned). Unsigned artifacts still trip the CI
> `release-guard` signature gate if dropped into `dist/`, so they are never
> mistaken for a release.

The whole matrix is also driven by the `release.yml` GitHub Actions workflow
(§3.4): `workflow_dispatch` (with a `signed` boolean) or a `v*` tag builds all
three installers, signing only when the relevant secret exists, else emitting
the unsigned artifact.

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
# one-time: generate the project link (`pear init` was removed in current
# Pear). `pear touch` mints a fresh pear:// link; record it. Then stage to it.
pear touch                      # prints a new pear:// link
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
$env:PEARPASTE_WIN_WRAPPER = "<prebuilt win32-x64 app dir; basename must be 'Paste'>"
$env:PEARPASTE_WIN_CERT  = "C:\path\to\authenticode.pfx"
$env:PEARPASTE_WIN_CERT_PASS = "<pfx password>"
npm run release:win        # pear build --win32-x64-app + signtool
```

`release:win` runs **`pear build --win32-x64-app <dir> --target dist/win32`**
(the produced app dir basename must equal the product name `Paste`), then locates
the binary by globbing `bin\*-app\*.exe` (never a hardcoded name) and runs
`signtool sign /fd SHA256 /tr <RFC3161 TSA> /td SHA256`. Wrap the signed app dir
with your installer (NSIS/WiX), then `signtool` the resulting `Setup.exe` too
with the same flags. With no `PEARPASTE_WIN_CERT` the script **fails closed**,
and the `release-guard` CI job blocks any unsigned artifact (§6). The TSA URL is
overridable via `PEARPASTE_WIN_TSA`. Real certs remain out of repo scope (spec
§17): a maintainer supplies the Authenticode cert before public beta — note all
code-signing certs now require hardware/HSM storage (see docs/SHIPPING.md).

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
The tarball is a distro-neutral launcher for the production `pear://` link.

**Native `.deb` (when `dpkg-deb` is on PATH).** `build:linux`/`release:linux`
**additionally** build a proper Debian package
`dist/linux/paste_<version>_amd64.deb` + `.sha256` via `maybeBuildDeb()`:

- `DEBIAN/control` — `Package: pearpaste`, `Maintainer`, `Architecture: amd64`
  (Node `x64` → Debian `amd64`), `Priority: optional`, `Section`,
  `Installed-Size`, `Recommends: pear`, multi-line `Description`.
- A launcher at `/usr/lib/pearpaste/pearpaste` that runs `pear run
  "$PEARPASTE_LINK"` (the production link, override-able), a `/usr/bin/pearpaste`
  symlink to it, a `/usr/share/applications/pearpaste.desktop` entry, and a
  `/usr/share/icons/hicolor/512x512/apps/pearpaste.png` icon.
- Built with `dpkg-deb --root-owner-group --build` (deterministic root:root
  ownership, no `fakeroot`).

The Pear runtime is **not** an apt package, so it is a `Recommends` note (the
launcher needs `pear` on PATH; install from <https://pears.com>) rather than a
hard `Depends`. **`maybeBuildDeb()` is never fatal:** absent `dpkg-deb` it logs a
graceful skip and the tarball remains the primary artifact (same contract as
the AppImage path).

**AppImage (when `appimagetool` is on PATH).** Also emitted alongside the
tarball + `.deb`; `…​.AppImage` + `.sha256` (skipped gracefully otherwise).

`release:linux` requires a detached signature sidecar (`.sig/.asc/.minisig/.p7s`)
for the tarball **and** for any `.deb` **and** for any AppImage produced,
matching the CI release-artifact gate. `build:linux:unsigned` (or
`build:linux -- --unsigned`) produces the same artifacts for dev/CI **without**
the sidecar requirement; `--unsigned` cannot be combined with `--release`.

### 3.3 macOS (darwin-arm64)

Orchestrated by `scripts/build-macos.mjs` (npm: `preflight:mac`, `build:mac`,
`build:mac:dry`, `release:mac`), the macOS sibling of `build-windows.mjs`. It is
the **single source of truth** for the macOS chain — `release-prod.sh`'s
`mac_sign_notarize()` now **delegates to `npm run release:mac`** (it previously
inlined `codesign`/`hdiutil` and **skipped `pear build`**; that drift is fixed).

**Readiness (any OS):**

```sh
npm run preflight:mac
```

Asserts macOS-capability: `sodium-native` ships a `darwin-arm64` prebuild (the
only native addon), `pear-electron`'s `pear.assets.ui` resolves the darwin
runtime via `/by-arch/%%HOST%%`, `assets/Paste.icns` is present, `pear.pre =
pear-electron/pre`, no unguarded Node-only globals remain (Bare-safe), and — on
darwin — `hdiutil`/`codesign`/`xcrun` are available.

**Unsigned `.dmg` (dev/CI, no Developer ID):**

```sh
npm run build:mac     # pear build --darwin-arm64-app + hdiutil -> Paste-<ver>-unsigned.dmg
```

Runs **`pear build --darwin-arm64-app <Paste.app> --target dist/macos`** (the
app-dir basename must equal the product name `Paste`), then `hdiutil create …
-format UDZO` to produce `dist/macos/Paste-<ver>-unsigned.dmg` + `.sha256`. The
build is unsigned, so **Gatekeeper quarantines it** — internal/dev only; a
console warning makes this explicit.

**Signed + notarized `.dmg` (Channel B):**

Must run on **macOS** (or CI `macos-latest`) with a real Apple Developer ID
identity + notarization credentials:

```sh
export PEARPASTE_MAC_APP="<prebuilt darwin-arm64 app dir; basename must be 'Paste'>"
export PEARPASTE_MAC_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# notarytool auth — EITHER a stored keychain profile:
export PEARPASTE_NOTARY_PROFILE="<profile from: xcrun notarytool store-credentials>"
# OR the Apple-ID triple:
export APPLE_ID="you@example.com" APPLE_TEAM_ID="<TEAMID>" APP_SPECIFIC_PASSWORD="<app-specific-pw>"
npm run release:mac
```

`release:mac` runs `pear build --darwin-arm64-app`, then `codesign --deep
--force --options runtime --timestamp` (hardened runtime) + `codesign --verify`,
`hdiutil create` the `.dmg`, `codesign` the `.dmg`, `xcrun notarytool submit
--wait`, and `xcrun stapler staple`, emitting `dist/macos/Paste-<ver>.dmg` +
`.sha256`. With **no `PEARPASTE_MAC_IDENTITY`** (or no notary auth) it **fails
closed**. `--arch darwin-x64` / `PEARPASTE_MAC_ARCH=darwin-x64` targets Intel
Macs (one-flag change). A notarized `.dmg` is still subject to the CI
`release-guard` signature-sidecar gate, so produce a `.sig/.asc/.minisig/.p7s`
in the release lane.

> One `# TODO(verify pear)` remains in `build-macos.mjs`: whether `pear build
> --darwin-arm64-app` can synthesize the `.app` from the staged project alone or
> always requires a pre-built pear-electron app dir as the path argument. Until
> verified, the script **requires `PEARPASTE_MAC_APP`** so it never invents a
> flag/behaviour.

### 3.4 CI release workflow (`.github/workflows/release.yml`)

A dedicated workflow builds all three installers (separate from the always-on
`ci.yml`). Triggers:

- **`workflow_dispatch`** — manual, inputs: **`pear_link`** (required string —
  the `pear://` link the wrappers resolve) and **`signed`** (boolean, default
  `false`).
- **`push: tags: ['v*']`** — tagging a release builds all three, **signs by
  default**, and attaches the installers to a **GitHub Release** (via
  `softprops/action-gh-release@v2`). A tag push has no inputs, so the link comes
  from the **`PEARPASTE_LINK`** repo variable/secret.

Three jobs, each `actions/checkout@v4` → `actions/setup-node@v4` (Node 22) →
`npm ci` → `npm i -g pear` → the platform script with `PEARPASTE_LINK` →
`actions/upload-artifact@v4`:

| Job | Runner | Script | Artifact(s) |
|---|---|---|---|
| `macos-dmg` | `macos-latest` | `release:mac` / `build:mac` | `.dmg` + `.sha256` |
| `windows-exe` | `windows-latest` | `release:win` / `build:win:unsigned` | `.exe` + `.sha256` |
| `linux-deb` | `ubuntu-latest` | `release:linux` / `build:linux:unsigned` | `.deb` + AppImage + tarball (+ `.sha256`) |

Each job **signs only when `signed` (or a tag) is set AND the relevant secret
exists**; otherwise it builds the **unsigned** artifact (it does not fail the
run). The `linux-deb` job `apt-get install`s `dpkg-dev` and fetches
`appimagetool` so both wrappers are exercised.

**Required repo secrets / variables** (referenced by name; signing is skipped
when absent):

| Name | Kind | Purpose |
|---|---|---|
| `PEARPASTE_LINK` | variable or secret | production `pear://` link for **tag** builds (dispatch uses the `pear_link` input) |
| `APPLE_DEV_ID` | secret | `Developer ID Application: <Name> (<TEAM>)` (macOS signing) |
| `APPLE_NOTARY_PROFILE` | secret | stored notarytool keychain profile (macOS) — OR the triple below |
| `APPLE_NOTARY_APPLE_ID` / `APPLE_NOTARY_TEAM_ID` / `APPLE_NOTARY_PASSWORD` | secrets | Apple-ID notarization triple (macOS) |
| `PEARPASTE_MAC_APP` | secret | path to the prebuilt darwin app dir on the runner (macOS) |
| `WIN_CERT_BASE64` | secret | base64-encoded Authenticode `.pfx` (Windows) |
| `WIN_CERT_PASS` | secret | `.pfx` password (Windows) |
| `PEARPASTE_WIN_WRAPPER` | secret | path to the prebuilt win32 app dir on the runner (Windows) |
| `LINUX_MINISIGN_KEY` | secret | Linux signing key (enables the signed Linux lane) |

> **The Pear runtime + `pear build` platform-asset fetch in CI is UNVERIFIED
> until the first real run.** Those steps carry `# TODO(verify on first CI run)`
> markers in `release.yml` (Pear CLI install, runtime fetch, `pear build` asset
> resolution, the `appimagetool` download URL). Without signing certs the jobs
> emit **unsigned** artifacts and the tag-release path should be treated as a dry
> run.

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
  artifacts with no signature **fail the build**. **INERT BY DESIGN on PR CI:**
  no job in `ci.yml` populates `dist/`, so on a normal push/PR the signature
  check finds no artifacts and is a no-op. It becomes live only when a release
  workflow (tag- or `workflow_dispatch`-triggered) builds + signs artifacts
  into `dist/`. → *CI fails on unsigned release artifact (once one exists).*

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
- **Pinned runtime:** Node 22 in CI; `engines.node >= 22` (matches CI).
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
