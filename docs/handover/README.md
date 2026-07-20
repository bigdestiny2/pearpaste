# Build handover — Windows `.msix`, Linux (AppImage/Flatpak/Snap), macOS `.dmg`

Operational runbooks for producing the native desktop installers via the
**Electron Forge + pear-runtime** path. Pair these with `docs/SHIPPING.md`
(channels, certs, policy) and `docs/RELEASE.md` (release gates).

> **Build model (current).** Paste is a standard Electron app that embeds
> `pear-runtime`, packaged with **Electron Forge**. The build command on every
> OS is `npm ci` then `npm run make` (`electron-forge make`), which writes
> artifacts under **`out/make/`**:
> - **Windows:** `Paste.msix`
> - **Linux:** `Paste-*.AppImage`, `*_flatpak.tar.gz` (Flatpak staging tarball); `.snap` is opt-in/out-of-band
> - **macOS:** `Paste-*.dmg` (+ `.zip`)
>
> The old `npm run build:win` / `build:linux` / `build:mac` scripts
> (`scripts/build-windows.mjs`, `scripts/package-linux.mjs`,
> `scripts/build-macos.mjs`, `scripts/build-flatpak.mjs`) are the **deprecated
> legacy pear-electron path**, kept only for dual-boot until the Phase 5 cutover
> (`docs/PEAR_RUNTIME_MIGRATION.md`). Do not use them for the Forge build.

- [`BUILD_WINDOWS.md`](BUILD_WINDOWS.md) — produce `Paste.msix`
- [`BUILD_LINUX.md`](BUILD_LINUX.md) — produce `.AppImage` / Flatpak tarball / `.snap`
- [`BUILD_FLATPAK.md`](BUILD_FLATPAK.md) — finish the Flatpak tarball into a `.flatpak`

## CI: the recommended build path
The **recommended** way to produce installers is the GitHub-hosted CI workflow at
`.github/workflows/build-release.yml`. Each job runs `npm ci` + `npm run make`
(= `electron-forge make`) directly on a native runner and uploads `out/make/**`,
so it produces **UNSIGNED** artifacts with no certs and signs automatically once
the signing env/secrets are set:

| Runner | Produces |
|---|---|
| `windows-latest` | `Paste.msix` (Windows SDK is preinstalled on the runner) |
| `macos-latest` | `Paste.dmg` + `.zip` arm64 |
| `macos-13` | `Paste.dmg` + `.zip` x64 (Intel) |
| `ubuntu-latest` | `.AppImage` + Flatpak staging tarball (x64) |
| `ubuntu-24.04-arm` | `.AppImage` + Flatpak staging tarball (arm64; **public repos only** — fails on private repos) |

> We call `npm run make` directly rather than `holepunchto/actions/make-pear-app@v1`
> because that composite action **hard-fails** macOS/Windows when signing
> credentials are absent — it cannot produce the unsigned dev/CI builds we need
> today. Snap is not built in CI by default: it needs `snapcraft` + LXD and is
> gated behind `PEARPASTE_BUILD_SNAP=1` for an out-of-band Linux box or
> snapcraft.io remote build.

## CI artifact smoke proof
After each `npm run make`, CI runs:

```sh
node scripts/smoke-packaged-artifacts.mjs
```

That step is the Phase 3 packaged-artifact smoke gate. It runs on the same
native runner that produced the artifact, fails the job if a required artifact is
missing or malformed, and writes `.sha256` sidecars beside every uploaded file.

| Runner family | Required artifacts | Automated proof |
|---|---|---|
| macOS | `.dmg`, `.zip` | `hdiutil verify`, mount the DMG, `unzip -t`, extract the ZIP, then inspect `Paste.app` for its executable, `package.json`, Electron main/preload, Bare workers, and the `darwin-universal` `sodium-native` Bare prebuild. |
| Windows | `.msix` | `makeappx unpack`, then inspect the unpacked package for `AppxManifest.xml`, `Paste.exe`, Electron main/preload, Bare workers, and the `win32-x64` `sodium-native` Bare prebuild. |
| Linux | `.AppImage`, `*_flatpak.tar.gz` | AppImage `--appimage-extract`, Flatpak tarball `tar -tzf`, then inspect each payload for Electron main/preload, Bare workers, and the runner-arch `sodium-native` Bare prebuild. |

**Proof boundary:** CI now proves that Forge emitted the expected native
containers, that each container can be opened by the platform-native tooling, and
that the packaged payload still contains the files needed to boot the Electron
host and Bare vault worker. It also proves checksum sidecars are generated before
upload. CI does **not** prove installability on a user machine, GUI launch,
vault create/unlock, `verify-encryption.js` against a real runtime store,
notarization, Authenticode/SmartScreen reputation, Snap Store review, finished
Flatpak installation, cross-device sync, or OTA update behavior; those remain the
manual handoff gates below and in `E2E_TEST_PLAN.md`.

> Local `npm run make` on your own Windows/Linux/Mac box is the **manual
> fallback / signing path** when you can't use CI (e.g. signing with a cert that
> can't go in CI secrets).

## Signed vs unsigned
Signing is opt-in via environment / CI secrets; **omitting them yields an
UNSIGNED artifact** that still builds cleanly (locally AND in this CI).

| OS | Sign by setting… | Unsigned when omitted |
|---|---|---|
| macOS | `MAC_CODESIGN_IDENTITY` + `KEYCHAIN_PROFILE` (a stored `notarytool` keychain profile). forge.config skips `osxSign`/`osxNotarize` entirely when the identity is unset. | unsigned `.app`/`.dmg`/`.zip` (boots locally; Gatekeeper-quarantined on other Macs) |
| Windows | `WINDOWS_SIGN_HOOK` (path to a signtool hook module). forge.config omits `windowsSignOptions` when unset. | unsigned `.msix` (installable only with a trusted dev/sideload cert) |
| Linux | n/a — AppImage + Flatpak tarball are unsigned by nature; Snap is signed/reviewed Snap-Store-side at upload, not at `make`. | always "unsigned" locally |

> Full notarization (macOS) and Authenticode (Windows) in CI need extra
> cert-import + `notarytool`/`signtool` setup steps that are **not yet wired** —
> the CI builds unsigned today; add those steps (or a separate signed-release
> job) when real certs exist.

> Keep `package.json#upgrade` a valid `pear://` link or supply CI `upgrade_key`
> — the `readPackageJson` hook in `forge.config.js` throws otherwise.

## Per-OS native prerequisites (local builds)
- **Windows:** Windows SDK / Windows Kits 10 (`makeappx.exe`; `signtool.exe` for
  signing). Preinstalled on `windows-latest`. See `BUILD_WINDOWS.md §0`.
- **Linux AppImage:** none beyond npm deps (no `libfuse2`/`appimagetool` at build time).
- **Linux Flatpak (`make`):** `tar` only (emits a staging tarball). Finishing it
  into a `.flatpak` needs `flatpak` + `flatpak-builder` + the runtimes — see
  `BUILD_FLATPAK.md`.
- **Linux Snap:** `snapcraft` + `lxd` for out-of-band builds with `PEARPASTE_BUILD_SNAP=1`.
- **All OSes:** Node 22 LTS, Git, `npm ci` (pulls the platform `sodium-native`
  prebuild — the only native addon; no C++ toolchain needed for the app).

## What you'll send back
- Windows: `out/make/.../Paste.msix` + `.sha256`
- Linux: `out/make/.../Paste-*.AppImage`, `*_flatpak.tar.gz` (+ out-of-band `*.snap` when built) + `.sha256` each
- macOS: `out/make/.../Paste-*.dmg` (+ `.zip`) + `.sha256`
