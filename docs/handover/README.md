# Build handover — Windows `.msix`, Linux (AppImage/Flatpak/Snap), macOS `.dmg`

Operational runbooks for producing the native desktop installers via the
**Electron Forge + pear-runtime** path. Pair these with `docs/SHIPPING.md`
(channels, certs, policy) and `docs/RELEASE.md` (release gates).

> **Build model (current).** Paste is a standard Electron app that embeds
> `pear-runtime`, packaged with **Electron Forge**. The build command on every
> OS is `npm ci` then `npm run make` (`electron-forge make`), which writes
> artifacts under **`out/make/`**:
> - **Windows:** `Paste.msix`
> - **Linux:** `Paste-*.AppImage`, `*_flatpak.tar.gz` (Flatpak staging tarball), `*.snap`
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
| `ubuntu-latest` | `.AppImage` + Flatpak tarball (x64); `.snap` best-effort |
| `ubuntu-24.04-arm` | same (arm64; **public repos only** — fails on private repos) |

> We call `npm run make` directly rather than `holepunchto/actions/make-pear-app@v1`
> because that composite action **hard-fails** macOS/Windows when signing
> credentials are absent — it cannot produce the unsigned dev/CI builds we need
> today. The Linux `.snap` runs as a `continue-on-error` step (it needs
> `snapcraft`) so a snap hiccup never blocks the AppImage/Flatpak artifacts.

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
- **Linux Snap:** `snapcraft` + `lxd` (CI installs these automatically).
- **All OSes:** Node 22 LTS, Git, `npm ci` (pulls the platform `sodium-native`
  prebuild — the only native addon; no C++ toolchain needed for the app).

## What you'll send back
- Windows: `out/make/.../Paste.msix` + `.sha256`
- Linux: `out/make/.../Paste-*.AppImage`, `*_flatpak.tar.gz`, `*.snap` + `.sha256` each
- macOS: `out/make/.../Paste-*.dmg` (+ `.zip`) + `.sha256`
