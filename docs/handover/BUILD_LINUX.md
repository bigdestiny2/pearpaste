# Handover: build the PearPaste Linux packages (AppImage / Flatpak / Snap)

Run this on a **Linux x64** box (Ubuntu 22.04+ / Debian 12+). `npm run make`
produces, under `out/make/`: an **`.AppImage`**, a **Flatpak staging tarball**
(`*_flatpak.tar.gz`), and a **`.snap`**, each built by the corresponding
`pear-electron-forge-maker-*` maker configured in `forge.config.js`.

> **Build model: Electron Forge + pear-runtime.** Paste is now a standard
> Electron app that embeds `pear-runtime` and is packaged with **Electron
> Forge**. The build command is `npm run make` (`electron-forge make`). The old
> `scripts/package-linux.mjs` (`.deb`/AppImage launcher) and
> `scripts/build-flatpak.mjs` paths are the **deprecated legacy pear-electron
> path**, retained for dual-boot until the Phase 5 cutover — see the bottom of
> this file. For deeper Flatpak details on the new path see
> [`BUILD_FLATPAK.md`](BUILD_FLATPAK.md).

See `docs/handover/README.md` for the overall chain and box provisioning.

## 0. Prerequisites (one-time, on the box)
- **Ubuntu 22.04+ / Debian 12+ x64**, **glibc ≥ 2.32** (`ldd --version`) — the
  sodium-native prebuild + bundled Electron need it.
- **Node.js 22 LTS** → `node -v` shows `v22.x`.
- **Git**.

Per-maker native prerequisites (the pear makers are deliberately lightweight):

| Maker | Output | Native prereq at `make` time |
|---|---|---|
| `pear-electron-forge-maker-appimage` | `*.AppImage` | **None** beyond npm deps. Builds via `app-builder-lib`'s bundled binary — **no `libfuse2`, no system `appimagetool`** needed at build time. (libFUSE is only needed to *run* an AppImage, not to write one.) |
| `pear-electron-forge-maker-flatpak` | `*_flatpak.tar.gz` (staging tarball, **not** a finished `.flatpak`) | **`tar` only** (preinstalled). The maker does **not** invoke `flatpak`/`flatpak-builder` — it tars a staged bundle. To turn the tarball into a distributable `.flatpak`, do a downstream finishing step (see `BUILD_FLATPAK.md`). |
| `pear-electron-forge-maker-snap` | `*.snap` | **`snapcraft` + `lxd`** (snapcraft builds via LXD). Install: `sudo snap install snapcraft --classic`, `sudo snap install lxd`, `sudo usermod -a -G lxd $USER`, `sudo lxd init --auto`. (CI installs these automatically — see §4.) |

> `npm ci` pulls the linux-x64 `sodium-native` prebuild (the only native addon).
> No C++ toolchain required for the app itself.

## 1. Get the code
```sh
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag-the-maintainer-gives-you>
npm ci
```

## 2. (Optional) Confirm the app boots before packaging
```sh
npm start
```
Launches the Electron host, spawns the two Bare workers, opens to the unlock
screen. Close it once confirmed.

## 3. Build the package(s)
```sh
npm run make
```
`electron-forge make` runs every linux maker whose `platforms` include `linux`.
Output under `out/make/`:
- `**/Paste-*.AppImage`
- `**/*_flatpak.tar.gz` (Flatpak staging tarball)
- `**/*.snap`

There is **no separate signed/unsigned command** on Linux: AppImage and the
Flatpak tarball are unsigned by nature; Snap signing/review is a Snap Store-side
step done at upload, not at `make`. To build a single maker only, use
`npm run make -- --targets <maker-name>` (e.g. `pear-electron-forge-maker-appimage`).

> **The Flatpak output is a staging tarball, not a `.flatpak`.** The maker emits
> `*_flatpak.tar.gz`. Producing an installable `.flatpak`/`.flatpakref` requires
> a downstream finishing step (install `flatpak` + `flatpak-builder`, add the
> flathub remote, install the `org.freedesktop.Platform//Sdk` +
> `org.electronjs.Electron2.BaseApp` runtimes, build from the tarball) — see
> `BUILD_FLATPAK.md`.

## 4. CI is the recommended path
For repeatable builds prefer the GitHub-hosted CI workflow
(`.github/workflows/build-release.yml`) — see **`docs/handover/README.md` → CI
section**. It runs `npm run make` directly on `ubuntu-latest` + `ubuntu-24.04-arm`:
AppImage + the Flatpak tarball are built as the required step (no native deps),
and `.snap` runs as a separate **best-effort** step that does
`sudo snap install snapcraft --classic` first (so a snap failure never blocks the
AppImage/Flatpak artifacts). Local `npm run make` is the manual fallback; for a
local snap you likewise need `snapcraft` (+ `lxd` if it builds in a container).

## 5. Sanity-check before sending back
- **AppImage:** `chmod +x` it and run it → confirm it opens to the unlock screen
  and you can create + unlock a vault.
  ```sh
  chmod +x out/make/**/Paste-*.AppImage
  ./out/make/**/Paste-*.AppImage
  ```
- Independent storage check on a throwaway vault:
  ```sh
  node scripts/verify-encryption.js <a-test-vault-dir>   # exit 0 = clean
  ```
  Exit **`0`** = no plaintext at rest, AEAD-only. Non-zero = leak, **report it**.

## 6. Output → send back
The artifacts under `out/make/` (`.AppImage`, `*_flatpak.tar.gz`, `.snap`) and a
`.sha256` for each (`sha256sum <file> > <file>.sha256`).

## Troubleshooting
- **Snap `make` fails** → snapcraft/LXD not set up: run the four commands in §0,
  then re-run. Snapcraft needs LXD (not multipass).
- **Snap won't run after install (`command not found`)** → known issue:
  `build/snapcraft.yaml` `command: Paste` doesn't match the staged path (the
  `dump` plugin keeps the binary under `Paste-linux-x64/`). Fix the `command:` to
  the real staged path (e.g. `Paste-linux-x64/Paste --no-sandbox`). Flagged in
  the config audit.
- **Snap app id shows as `hellopear`** → un-renamed boilerplate in
  `build/snapcraft.yaml` (part/app key `hellopear`); rename to `paste`. Flagged
  in the audit.
- **AppImage won't run on an old distro** → glibc floor (≥ 2.32). For older
  hosts use the Flatpak path (its sandbox ships its own glibc) — see
  `BUILD_FLATPAK.md`.

---

## Legacy path (deprecated — do not use for the Forge build)
`npm run build:linux` / `build:linux:unsigned` / `release:linux` still run
`scripts/package-linux.mjs` (the old `.deb` + AppImage + tarball *launcher* flow
that runs `pear run pear://<link>`), and `node scripts/build-flatpak.mjs` is the
old hand-rolled Flatpak. These are the **legacy pear-electron path**, retained
only for dual-boot until the Phase 5 cutover. New packages use `npm run make`
(above). See `docs/PEAR_RUNTIME_MIGRATION.md` for the cutover plan.
