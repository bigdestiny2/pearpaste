# PearPaste — Linux Box Handoff (build + E2E)

**Date:** 2026-06-14 · **Repo:** `bigdestiny2/pearpaste` · **Your role:** produce the Linux package(s) via the Electron Forge path and run the Linux + cross-device E2E, then report back.

> **Build model: Electron Forge + pear-runtime.** Paste is now a standard Electron app that embeds `pear-runtime`, packaged with **Electron Forge**. Build with `npm ci` then `npm run make` → `out/make/`: `Paste-*.AppImage`, `*_flatpak.tar.gz` (Flatpak staging tarball), `*.snap`. The old `npm run build:linux` / `scripts/package-linux.mjs` (`.deb`/AppImage launcher) and `scripts/build-flatpak.mjs` are the **deprecated legacy pear-electron path**, kept only for dual-boot until cutover.

Self-contained. Deep build internals: [`BUILD_LINUX.md`](BUILD_LINUX.md) (AppImage/Flatpak tarball/Snap) and [`BUILD_FLATPAK.md`](BUILD_FLATPAK.md) (finishing the Flatpak). CI (recommended build path): [`README.md`](README.md). Full scenario catalog: [`../E2E_TEST_PLAN.md`](../E2E_TEST_PLAN.md). Your **pairing partner** for the multi-device scenarios is the maintainer's **macOS / M3 Ultra** box on the same testnet/LAN.

---

## 0. What you're testing (current state)
`main` is green across the board — **unit 45 · integration 41 · e2e 3 · security 27 · mobile 4** (Node 22). Recently shipped and worth exercising on real Linux:
- **Real device revocation + forward secrecy** — a revoked device cannot decrypt content created after its revoke.
- **Pairing-window data-loss fixes** (I-15 conn-teardown + I-16 receiver re-materialization) — a note written *right after pairing* now reliably appears on the new device. **This is the #1 thing to confirm cross-device with the Mac.**
- **Offline-window content heal** (raw-op re-materializer + read fallback) — a device that was OFFLINE across a device-revocation key rotation can now READ the notes/clips written while it was away (in-session and after an app restart), and they show up in search. Cross-device check: revoke a third device from the Mac while the Linux box is closed, write a note on the Mac, reopen the Linux box → the note must appear readable.
- **Live cross-device refresh** (I-9) — remote changes appear without a manual Refresh.
- **Search/write perf** (I-14/I-8) — large vaults stay fast.

## 1. Box prereqs (one-time)
- **Ubuntu 22.04+ / Debian 12+ x64**, **glibc ≥ 2.32** (`ldd --version`) — the sodium-native prebuild + bundled Electron need it; older distros (e.g. Ubuntu 20.04 / glibc 2.31) need the Flatpak path instead.
- **Node.js 22 LTS**.
- Git.
- Per-maker native prereqs:
  - **AppImage** (`pear-electron-forge-maker-appimage`): **nothing** beyond npm deps — no `libfuse2`/`appimagetool` at build time.
  - **Flatpak** (`pear-electron-forge-maker-flatpak`): **`tar` only**; `make` emits a `*_flatpak.tar.gz` staging tarball, **not** a finished `.flatpak`. Finishing it needs `flatpak` + `flatpak-builder` + runtimes — see `BUILD_FLATPAK.md`.
  - **Snap** (`pear-electron-forge-maker-snap`): **`snapcraft` + `lxd`** — `sudo snap install snapcraft --classic`, `sudo snap install lxd`, `sudo usermod -a -G lxd $USER`, `sudo lxd init --auto`. (CI installs these automatically.)

## 2. Get the code
```sh
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag>
npm ci
```
`npm ci` pulls the linux-x64 `sodium-native` prebuild (the only native addon) — no C++ toolchain required for the app.

## 3. Confirm the app boots (optional, before packaging)
```sh
npm start
```
`electron-forge start -- --no-updates` launches the Electron host, spawns the two Bare workers (`workers/main.js` updater + `workers/paste.js` vault over FramedStream(Bare.IPC)), and opens to the **unlock screen**. If it fails to spawn the workers or open the store, **STOP and report**. Close it once confirmed.

## 4. Run the automated gate (proves the core works on Linux)
```sh
npm run test:all
```
Node 22, outside any socket sandbox (an `EPERM` at UDX bind is a sandbox artifact — rerun, don't treat as a failure). Expect **unit 45 · integration 41 · e2e 3 · security 27 · mobile 4**.
> If `follow-topic: an OFFLINE survivor catches up…` (in `revocation-network`) times out, **re-run it** — it's a DHT-reconnect timing test (hardened, but a constrained box can still need a retry). A real failure **anywhere else** = capture the output and report.

## 5. Build the package(s)
```sh
npm run make
```
`electron-forge make` runs every linux maker → under `out/make/`:
- `**/Paste-*.AppImage`
- `**/*_flatpak.tar.gz` (Flatpak **staging tarball** — finish into a `.flatpak` per `BUILD_FLATPAK.md`)
- `**/*.snap`

To build one maker only: `npm run make -- --targets pear-electron-forge-maker-appimage`. AppImage and the Flatpak tarball are unsigned by nature; Snap signing/review is a Snap-Store-side step at upload, not at `make`.

> **Recommended: build in CI instead.** The CI building block installs snapcraft + LXD automatically and needs no apt/flatpak/appimage setup. See [`README.md`](README.md) → "CI: the recommended build path". Local `npm run make` is the fallback.

## 6. Smoke test the package
1. Run the AppImage:
   ```sh
   chmod +x out/make/**/Paste-*.AppImage
   ./out/make/**/Paste-*.AppImage
   ```
   → opens to the **unlock screen**. (Snap: `sudo snap install --dangerous out/make/**/*.snap` then run; Flatpak: finish the tarball first per `BUILD_FLATPAK.md`.)
2. **Create a vault** (24-word phrase shown **exactly once** — record it), write a note, **lock**, **unlock**, re-open (plaintext returns).
3. Independent storage check:
   ```sh
   node scripts/verify-encryption.js <a-test-vault-dir>
   ```
   Exit **`0`** = no plaintext at rest, AEAD-only. Non-zero = leak, **report it**.

## 7. E2E scenarios (Linux-specific + cross-device with the Mac)
From `E2E_TEST_PLAN.md`. Single-box items you can do alone; **MULTI** items need the Mac on the same `@hyperswarm/testnet` bootstrap or an isolated LAN DHT.

**Linux platform gate (§5 Linux):**
- [ ] `npm run make` produces the AppImage / Flatpak tarball / Snap; the **AppImage launches** on the target distro (and Snap/finished Flatpak if you exercised them).
- [ ] **Clipboard backend behaves on BOTH X11 and Wayland** — this is the Linux-specific risk. Test copy/paste + the 60s auto-clear under each session type.
- [ ] Tray / global paste (if enabled).

**Cross-device with the Mac (the important ones — these exercise what just shipped):**
- [ ] **S3 pairing** (desktop↔desktop): Mac `PAIR_CREATE_INVITE` → Linux joins via the short code → **compare the 6-digit confirmation on both screens** → Mac approves → `NOTE_LIST` converges. (Confirm the UI does **not** auto-accept without the human confirm.)
- [ ] **S4 concurrent edits**: Mac + Linux edit the **same** note id concurrently → both converge to the **same** LWW winner; distinct notes Y (Mac) and Z (Linux) both survive on both.
- [ ] **S5 pairing-window note** *(the I-15/I-16 fix — verify explicitly)*: pair Linux **fresh**, have the Mac write a note **immediately** after pairing → it appears in the **Linux `NOTE_LIST`** with **no manual reconnect**.
- [ ] **S8 revoke**: Mac `DEVICE_REVOKE` the Linux device → Linux's later writes are **rejected** fleet-wide; confirm forward secrecy — content the Mac creates **after** the revoke does **not** decrypt on Linux.
- [ ] `verify-encryption.js` exits 0 on the Linux store throughout.

## 8. Report back
- The `out/make/` artifacts (`.AppImage`, `*_flatpak.tar.gz`, `.snap`, and the finished `.flatpak` if you built it) each with a `.sha256` (`sha256sum <file> > <file>.sha256`).
- The `npm run test:all` tallies + any non-flaky failure (full output).
- The §7 checklist with **P/F + notes** per item (note the X11 vs Wayland clipboard result explicitly).
- Any worker-log error (especially `Not writable`, an unhandled reducer exception, or a wedge where one bad op halts a batch).
