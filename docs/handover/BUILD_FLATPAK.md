# Handover: build the PearPaste Flatpak (the wide-Linux-reach path)

This is the Linux packaging model that runs **below the glibc floor** — i.e. on
Ubuntu 20.04 (glibc 2.31) and older. The AppImage and the bundled-Electron app
inherit the **host** glibc, so they need ≥ 2.32 (Ubuntu 22.04+). A Flatpak runs
against the **Freedesktop runtime**, which ships its *own* glibc inside the
sandbox — so the same artifact runs everywhere, old hosts included.

> Build the Flatpak **only if you need to reach 20.04 / old-glibc users.** For
> 22.04+ the AppImage from [`BUILD_LINUX.md`](BUILD_LINUX.md) is simpler.

## Build model: Forge maker emits a staging tarball, then a finishing step
On the **Electron Forge path** the Flatpak is produced in two stages:

1. **`npm run make`** runs `pear-electron-forge-maker-flatpak`, which is
   deliberately lightweight: it writes the `.desktop` / metainfo / icon /
   entrypoint files and `tar`s the staged app into
   `out/make/**/*_flatpak.tar.gz`. **It does not invoke `flatpak` or
   `flatpak-builder`** — so `make` itself needs only `tar`. (This is exactly
   how Keet ships: the tarball is the maker artifact, finished elsewhere.)
2. **A downstream finishing step** turns that tarball into a distributable
   `.flatpak` using the real Flatpak toolchain (below).

The maker is configured in `forge.config.js` (`pear-electron-forge-maker-flatpak`):
`appId: global.paste.Paste`, `metainfo: build/metainfo.xml`,
`entrypoint: build/entrypoint.sh`, `categories: ['Utility']`, icon `build/icon.png`.

## Why a Flatpak (and why the others have the floor)
A bundled-Electron desktop app embeds Chromium, compiled against glibc ≥ 2.32 —
that is the floor (Electron's, not Bare's or sodium-native's). Flatpak sidesteps
it by providing `org.freedesktop.Platform` (newer glibc) +
`org.electronjs.Electron2.BaseApp` (Chromium's system deps + `zypak`, the sandbox
shim Chromium needs inside Flatpak), independent of the host. The in-sandbox
launcher is `build/entrypoint.sh` (`zypak-wrapper /app/lib/<FLATPAK_ID>/Paste`).

## 0. Stage 1 — produce the staging tarball
On any Linux x64 box with Node 22 + `tar`:
```sh
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste && git checkout <branch-or-tag> && npm ci
npm run make -- --targets pear-electron-forge-maker-flatpak
```
→ `out/make/**/Paste_<version>_<arch>_flatpak.tar.gz`.

## 1. Stage 2 — finishing toolchain (one-time, for the `.flatpak`)
This stage is **not** part of `make` and **not** installed by the CI building
block — add it yourself when you actually want an installable `.flatpak`:
```sh
sudo apt-get install -y flatpak flatpak-builder
flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub \
  org.freedesktop.Platform//24.08 \
  org.freedesktop.Sdk//24.08 \
  org.electronjs.Electron2.BaseApp//24.08
```
The runtimes are **host-glibc-independent** — installing them on 22.04 is fine;
the resulting bundle still runs on 20.04.

## 2. Stage 2 — build the `.flatpak` from the tarball
Unpack the staging tarball into a build context and run `flatpak-builder` against
the Freedesktop runtime + Electron base app, exporting to a local OSTree repo and
bundling a single-file `.flatpak`. The staged tree already carries the
`entrypoint.sh` launcher, the `metainfo.xml`, the `.desktop`, and the icon that
the maker emitted, so the manifest's `finish-args` need only:
- `--share=network` (P2P is non-negotiable — peers won't connect without it),
- access to the per-app data dir for the vault store,
- the standard GUI sockets (`--socket=wayland`, `--socket=fallback-x11`,
  `--device=dri`).

> **Tip:** keep the `appId` consistent — `global.paste.Paste` (matches
> `forge.config.js` and `build/metainfo.xml`). Confirm the in-sandbox binary is
> named `Paste` (the entrypoint execs `/app/lib/<FLATPAK_ID>/Paste`).

## 3. Test (ideally ON a 20.04 box — that's the whole point)
```sh
flatpak install --user ./Paste.flatpak
flatpak run global.paste.Paste
```
Confirm it opens to the unlock screen, you can create/unlock a vault, and — the
decisive check — that it **syncs** (if peers never connect, verify the manifest's
`--share=network`). Independent storage check:
```sh
node scripts/verify-encryption.js <a-test-vault-dir>   # exit 0 = clean
```

## 4. Distribute
- **Single file:** ship `Paste.flatpak`; users `flatpak install --user ./Paste.flatpak`.
  No store account, no review — good for a beta.
- **Flathub (later):** submit to flathub/flathub for `flatpak install flathub
  global.paste.Paste`. Requires their review + an AppStream pass
  (`build/metainfo.xml` is the starting point) and reproducible, network-free
  build sources — the bundled-payload tarball will likely need reworking into
  declared sources for Flathub's offline builder.

## Known config issues to fix before a real Flatpak release (from the audit)
- **`build/metainfo.xml` homepage** is `https://www.paste.global`, which
  contradicts every other config (`github.com/bigdestiny2/pearpaste`) and will
  fail AppStream validation. Change it to the GitHub URL (or the real site).
- **Stale metainfo fields:** `<provides><binary>paste</binary>` (lowercase) vs
  the actual binary `Paste`; `<categories>Utility, Office</categories>` vs
  `forge.config.js` `categories: ['Utility']`; a "spike" release block whose
  version is **not** auto-stamped (the maker copies metainfo verbatim, so bump
  `<release version>` by hand each release).

## Files (Forge path)
- `forge.config.js` — `pear-electron-forge-maker-flatpak` config block
- `build/metainfo.xml` — AppStream metadata (copied verbatim into the bundle)
- `build/entrypoint.sh` — the in-sandbox zypak launcher
- `build/icon.png` (+ `build/icon/*.png`) — icons

---

## Legacy path (deprecated — do not use for the Forge build)
`node scripts/build-flatpak.mjs` (with `flatpak/global.paste.Paste.yml`,
`flatpak/paste-launcher.sh`, etc.) is the old hand-rolled pear-electron Flatpak,
retained only for dual-boot until the Phase 5 cutover. The new path is the maker
tarball + finishing step above. See `docs/PEAR_RUNTIME_MIGRATION.md`.
