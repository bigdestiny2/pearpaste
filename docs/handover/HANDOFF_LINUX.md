# PearPaste — Linux Box Handoff (build + E2E)

**Date:** 2026-06-11 · **Repo:** `bigdestiny2/pearpaste` (branch `main`) · **Your role:** produce the Linux package(s) and run the Linux + cross-device E2E, then report back.

Self-contained. Deep build internals: [`BUILD_LINUX.md`](BUILD_LINUX.md) (`.deb`/AppImage/tarball) and [`BUILD_FLATPAK.md`](BUILD_FLATPAK.md). Full scenario catalog: [`../E2E_TEST_PLAN.md`](../E2E_TEST_PLAN.md). Your **pairing partner** for the multi-device scenarios is the maintainer's **macOS / M3 Ultra** box on the same testnet/LAN.

---

## 0. What you're testing (current state)
`main` is green across the board — **unit 45 · integration 37 · e2e 3 · security 27 · mobile 4** (Node 22). Recently shipped and worth exercising on real Linux:
- **Real device revocation + forward secrecy** — a revoked device cannot decrypt content created after its revoke.
- **Pairing-window data-loss fixes** (I-15 conn-teardown + I-16 receiver re-materialization) — a note written *right after pairing* now reliably appears on the new device. **This is the #1 thing to confirm cross-device with the Mac.**
- **Live cross-device refresh** (I-9) — remote changes appear without a manual Refresh.
- **Search/write perf** (I-14/I-8) — large vaults stay fast.

## 1. Box prereqs (one-time)
- **Ubuntu 22.04+ / Debian 12+ x64**, **glibc ≥ 2.32** (`ldd --version`) — the sodium-native prebuild + Pear runtime need it; older distros (e.g. Ubuntu 20.04 / glibc 2.31) will not launch the runtime.
- **Node.js 22 LTS**.
- Git.
- Pear CLI: `npm i -g pear` (`pear -v`).
- `dpkg-deb` (from `dpkg`, usually preinstalled) — for the `.deb`.
- *(optional)* `appimagetool` on `PATH` — to also emit an `.AppImage`.
- *(Flatpak path)* `flatpak` + `flatpak-builder` + the Freedesktop runtime/SDK — see `BUILD_FLATPAK.md`.
- *(release/signing)* `minisign` or `gpg` — the release gate requires a detached signature.

## 2. Get the code
```sh
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout main
npm ci
```
`npm ci` pulls the linux-x64 `sodium-native` prebuild (the only native addon).

## 3. Preflight (must pass before building)
```sh
npm run preflight:linux
```
Checks the lockfile, Pear stage entrypoints, `pear-electron/pre`, the linux `sodium-native` prebuild, `tar`, and optional distro tooling (`dpkg-deb`, `appimagetool`, `rpmbuild`, `desktop-file-validate`).

## 4. Run the automated gate (proves the core works on Linux)
```sh
npm run test:all
```
Node 22, outside any socket sandbox (an `EPERM` at UDX bind is a sandbox artifact — rerun, don't treat as a failure). Expect **unit 45 · integration 37 · e2e 3 · security 27 · mobile 4**.
> If `follow-topic: an OFFLINE survivor catches up…` (in `revocation-network`) times out, **re-run it** — it's a DHT-reconnect timing test (hardened, but a constrained box can still need a retry). A real failure **anywhere else** = capture the output and report.

## 5. Build the package(s)
The maintainer hands you the current production link:
```sh
export PEARPASTE_LINK="pear://<fork>.<length>.<key>"
```
**`.deb` + tarball (+ AppImage if `appimagetool` is present):**
```sh
npm run build:linux        # or build:linux:unsigned to force the unsigned dev path
```
→ `dist/linux/paste_<version>_amd64.deb` (gated on `dpkg-deb`; skips gracefully if absent), `pearpaste-<version>-linux-x64.tar.gz` (+ `.sha256`), and an `.AppImage` when tooling is present.

**Flatpak (alternative, wide-distro reach below the glibc floor):** follow `BUILD_FLATPAK.md` (`node scripts/build-flatpak.mjs`).

> Note: the `.deb`/tarball are **launchers** — they run `pear run pear://<link>` through the Pear runtime, so the target box needs the Pear runtime **and** the production link must be staged+seeded by the maintainer. They *build* fine regardless, but only *launch* once the link is live.

## 6. Smoke test the package
1. Install + launch:
   ```sh
   npm i -g pear                                   # target needs the Pear runtime
   sudo dpkg -i dist/linux/paste_<version>_amd64.deb
   paste                                            # or the .desktop entry
   ```
   → opens to the **unlock screen**.
2. **Create a vault** (24-word phrase shown **exactly once** — record it), write a note, **lock**, **unlock**, re-open (plaintext returns).
3. Independent storage check:
   ```sh
   node scripts/verify-encryption.js <a-test-vault-dir>
   ```
   Exit **`0`** = no plaintext at rest, AEAD-only. Non-zero = leak, **report it**.

## 7. E2E scenarios (Linux-specific + cross-device with the Mac)
From `E2E_TEST_PLAN.md`. Single-box items you can do alone; **MULTI** items need the Mac on the same `@hyperswarm/testnet` bootstrap or an isolated LAN DHT.

**Linux platform gate (§5 Linux):**
- [ ] `npm run preflight:linux` passes; the `.deb`/AppImage/Flatpak **wrap and launch** on the target distro.
- [ ] **Clipboard backend behaves on BOTH X11 and Wayland** — this is the Linux-specific risk. Test copy/paste + the 60s auto-clear under each session type.
- [ ] Tray / global paste (if enabled).

**Cross-device with the Mac (the important ones — these exercise what just shipped):**
- [ ] **S3 pairing** (desktop↔desktop): Mac `PAIR_CREATE_INVITE` → Linux joins via the short code → **compare the 6-digit confirmation on both screens** → Mac approves → `NOTE_LIST` converges. (Confirm the UI does **not** auto-accept without the human confirm.)
- [ ] **S4 concurrent edits**: Mac + Linux edit the **same** note id concurrently → both converge to the **same** LWW winner; distinct notes Y (Mac) and Z (Linux) both survive on both.
- [ ] **S5 pairing-window note** *(the I-15/I-16 fix — verify explicitly)*: pair Linux **fresh**, have the Mac write a note **immediately** after pairing → it appears in the **Linux `NOTE_LIST`** with **no manual reconnect**.
- [ ] **S8 revoke**: Mac `DEVICE_REVOKE` the Linux device → Linux's later writes are **rejected** fleet-wide; confirm forward secrecy — content the Mac creates **after** the revoke does **not** decrypt on Linux.
- [ ] `verify-encryption.js` exits 0 on the Linux store throughout.

## 8. Report back
- `dist/linux/paste_<version>_amd64.deb` (+ `.AppImage`, `.tar.gz`, and Flatpak if built) and the `.sha256` (+ `.minisig`/`.sig` if you signed).
- The `npm run test:all` tallies + any non-flaky failure (full output).
- The §7 checklist with **P/F + notes** per item (note the X11 vs Wayland clipboard result explicitly).
- Any worker-log error (especially `Not writable`, an unhandled reducer exception, or a wedge where one bad op halts a batch).
