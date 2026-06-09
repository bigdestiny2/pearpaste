# Handover: build the PearPaste Flatpak (the wide-Linux-reach path)

**Status: SPIKE.** This is the *only* Linux packaging model that runs **below the
glibc floor** — i.e. on Ubuntu 20.04 (glibc 2.31) and older. The `.deb`, the
AppImage, and the `pear run` launcher all inherit the **host** glibc, so they need
≥ 2.32 (Ubuntu 22.04+). A Flatpak builds against the **Freedesktop runtime**,
which ships its *own* glibc inside the sandbox — so the same artifact runs
everywhere, old hosts included.

> Build this **only if you need to reach 20.04 / old-glibc users.** For 22.04+
> (glibc 2.35) the `.deb`/AppImage from `docs/handover/BUILD_LINUX.md` are simpler
> and lighter. The industry glibc floor is *rising* (Electron is moving to a 2.35
> base), and 20.04 hit end-of-standard-support in April 2025 — so a documented
> "22.04+ baseline" is a perfectly reasonable line, with this Flatpak as the
> escape hatch for the long tail.

## Why it works (and why the others don't)
A pear-electron desktop app **embeds Electron/Chromium**, which is compiled
against glibc ≥ 2.32. That's the entire floor — it's Electron's, not Bare's or
sodium-native's. Flatpak sidesteps it by providing `org.freedesktop.Platform`
(glibc ~2.39) + `org.electronjs.Electron2.BaseApp` (Chromium's system deps +
`zypak`, the sandbox shim Chromium needs inside Flatpak) in the sandbox,
independent of the host.

## 0. Prerequisites (one-time, on a Linux x64 box)
```sh
sudo apt-get install -y flatpak flatpak-builder
flatpak remote-add --if-not-exists --user flathub https://flathub.org/repo/flathub.flatpakrepo
flatpak install --user flathub \
  org.freedesktop.Platform//24.08 \
  org.freedesktop.Sdk//24.08 \
  org.electronjs.Electron2.BaseApp//24.08
node -v   # v22.x; npm ci first so node_modules/pear-electron is present
npm i -g pear   # for the materialize step (or skip via PEARPASTE_PAYLOAD_DIR, below)
```
The runtimes are **host-glibc-independent** — installing them on 22.04 is fine;
the resulting bundle still runs on 20.04.

## 1. Preflight (safe on any OS)
```sh
node scripts/build-flatpak.mjs --preflight
```
Reports the manifest/support files, the icon, `flatpak`/`flatpak-builder`, the
three Flatpak refs, and the materialize inputs.

## 2. Build
```sh
export PEARPASTE_LINK="pear://<fork>.<length>.<key>"   # the production link
node scripts/build-flatpak.mjs --build
```
This (1) materializes a self-contained linux-x64 pear-electron app into
`dist/flatpak/payload`, (2) assembles a build context in `dist/flatpak/context`,
(3) runs `flatpak-builder` into a local OSTree repo, and (4) emits a single-file
**`dist/flatpak/Paste.flatpak`** (+ `.sha256`).

### ⚠️ The one first-build unknown — the materialize step
`pear build --linux-x64-app` is the **same arg form that printed usage** while
pinning the `.exe`/`.dmg` builders (a parser quirk, not a path error). If the
materialize step fails, **build the linux-x64 app by hand once** and hand the
result straight to the Flatpak, skipping `pear build`:
```sh
# materialize the pear-electron runtime slice by hand
pear dump --force "$(node -e "console.log(require('pear-electron/package.json').pear.ui.link)")" ./pear-runtime
#   -> ./pear-runtime/by-arch/linux-x64  holds the Electron runtime app
# ...produce the standalone app dir however pear build wants it, then:
PEARPASTE_PAYLOAD_DIR="$PWD/pear-runtime/by-arch/linux-x64" \
  node scripts/build-flatpak.mjs --build
```
`PEARPASTE_PAYLOAD_DIR` makes the script copy that directory in verbatim as the
payload — bypassing `pear build` entirely. **Report which form materializes a
runnable app dir** and I'll lock it into `scripts/build-flatpak.mjs`.

The launcher (`flatpak/paste-launcher.sh`) execs `zypak-wrapper /app/paste/Paste`.
If the Electron binary in your payload isn't named `Paste`, the build script
symlinks the largest executable to `Paste` automatically — verify it picked the
right one on the first build (`flatpak run` will crash loudly if not).

## 3. Test (ideally ON a 20.04 box — that's the whole point)
```sh
flatpak install --user ./dist/flatpak/Paste.flatpak
flatpak run global.paste.Paste
```
Confirm it opens to the unlock screen, you can create/unlock a vault, and — the
decisive check — that it **syncs** (P2P needs `--share=network`, which the manifest
grants; if peers never connect, that permission is the first thing to check).

## 4. Distribute
- **Single file:** ship `Paste.flatpak`; users `flatpak install --user ./Paste.flatpak`. No store account, no review — good for a beta.
- **Flathub (later):** submit the manifest to flathub/flathub for `flatpak install flathub global.paste.Paste`. Requires their review + an AppStream pass (`flatpak/global.paste.Paste.metainfo.xml` is the starting point) and reproducible, network-free build sources — the bundled-payload approach here will likely need reworking into declared sources for Flathub's offline builder.

## What's verified vs. spike
- ✅ **Sound + standard:** the Flatpak shape (Freedesktop runtime + Electron base app + zypak), the P2P-critical `--share=network`, vault storage in the per-app data dir, the AppStream/desktop metadata.
- 🟡 **Needs first-build shakeout on the box:** the `pear build --linux-x64-app` materialize arg (escape hatch: `PEARPASTE_PAYLOAD_DIR`); the exact Electron binary name in the payload; and whether the production app's self-update-over-P2P behaves under the sandbox.
- 🔴 **Not attempted:** Flathub submission (offline/declared-source build), arm64.

## Files
- `flatpak/global.paste.Paste.yml` — the manifest
- `flatpak/paste-launcher.sh` — the in-sandbox zypak launcher
- `flatpak/global.paste.Paste.desktop` — desktop entry
- `flatpak/global.paste.Paste.metainfo.xml` — AppStream metadata
- `scripts/build-flatpak.mjs` — preflight + materialize + build orchestration
