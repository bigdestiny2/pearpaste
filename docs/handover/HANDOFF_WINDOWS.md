# PearPaste — Windows Box Handoff (build + E2E)

**Date:** 2026-06-14 · **Repo:** `bigdestiny2/pearpaste` · **Your role:** produce the Windows `.msix` via the Electron Forge path and run the Windows + cross-device E2E, then report back.

> **Build model: Electron Forge + pear-runtime.** Paste is now a standard Electron app that embeds `pear-runtime`, packaged with **Electron Forge**. Build with `npm ci` then `npm run make` → `out/make/.../Paste.msix`. The old `npm run build:win` / `scripts/build-windows.mjs` (pear build + NSIS) is the **deprecated legacy pear-electron path**, kept only for dual-boot until cutover.

Self-contained. Deep build internals: [`BUILD_WINDOWS.md`](BUILD_WINDOWS.md). CI (recommended build path): [`README.md`](README.md). Full scenario catalog: [`../E2E_TEST_PLAN.md`](../E2E_TEST_PLAN.md). Your **pairing partner** for the multi-device scenarios is the maintainer's **macOS / M3 Ultra** box on the same testnet/LAN.

---

## 0. What you're testing (current state)
`main` is green across the board — **unit 45 · integration 41 · e2e 3 · security 27 · mobile 4** (Node 22). Recently shipped and worth exercising on real Windows:
- **Real device revocation + forward secrecy** — a revoked device cannot decrypt content created after its revoke.
- **Pairing-window data-loss fixes** (I-15 conn-teardown + I-16 receiver re-materialization) — a note written *right after pairing* now reliably appears on the new device. **This is the #1 thing to confirm cross-device with the Mac.**
- **Offline-window content heal** (raw-op re-materializer + read fallback) — a device that was OFFLINE across a device-revocation key rotation can now READ the notes/clips written while it was away (in-session and after an app restart), and they show up in search. Cross-device check: revoke a third device from the Mac while the Windows box is closed, write a note on the Mac, reopen the Windows box → the note must appear readable.
- **Live cross-device refresh** (I-9) — remote changes appear without a manual Refresh.
- **Search/write perf** (I-14/I-8) — large vaults stay fast.

## 1. Box prereqs (one-time)
- Windows 10/11 **x64**.
- **Node.js 22 LTS** (`node -v` → `v22.x`).
- Git.
- **Windows SDK / Windows Kits 10** — provides `makeappx.exe` (always needed by the MSIX maker) and `signtool.exe` (signing only). The maker auto-detects it via `getWindowsKitVersion()` in `forge.config.js`. Preinstalled on `windows-latest` CI runners.
- *(signed build, later)* an Authenticode cert (PFX or thumbprint) — **EV recommended** (instant SmartScreen reputation). Not needed for the first **unsigned** build.

## 2. Get the code
```bat
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag>
npm ci
```
`npm ci` pulls the win32-x64 `sodium-native` prebuild (the only native addon) — **no C++ toolchain required** for the app (the Windows SDK is needed only by the MSIX maker).

## 3. Confirm the app boots (optional, before packaging)
```bat
npm start
```
`electron-forge start -- --no-updates` launches the Electron host, spawns the two Bare workers (`workers/main.js` updater + `workers/paste.js` vault over FramedStream(Bare.IPC)), and opens to the **unlock screen**. If it fails to spawn the workers or open the store, **STOP and report**. Close it once confirmed.

## 4. Run the automated gate (proves the core works on Windows)
```bat
npm run test:all
```
Node 22, outside any socket sandbox (an `EPERM` at UDX bind is a sandbox artifact — rerun, don't treat as a failure). Expect **unit 45 · integration 41 · e2e 3 · security 27 · mobile 4**.
> If `follow-topic: an OFFLINE survivor catches up…` (in `revocation-network`) times out, **re-run it** — it's a DHT-reconnect timing test (hardened, but a constrained box can still need a retry). A real failure **anywhere else** = capture the output and report.

## 5. Build the `.msix`

**Unsigned (recommended first build):**
```bat
npm run make
```
`electron-forge make` packages the win32 app and runs `@electron-forge/maker-msix` → `out\make\...\Paste.msix` (and a copy at `out\Paste-win32-x64\Paste.msix` via the `postMake` hook). Version is stamped from `package.json` automatically. An unsigned MSIX builds cleanly but installs only with a trusted dev/sideload cert.

**Signed (Authenticode):** set `WINDOWS_SIGN_HOOK` to your sign-hook module path, then `npm run make`. There is no separate `release` command — signed vs unsigned is purely whether `WINDOWS_SIGN_HOOK` is set. For a real signed release, also update `build/AppxManifest.xml` `Publisher` to **byte-match** the cert subject. Details in `BUILD_WINDOWS.md §3`.

> **Recommended: build in CI instead.** The `windows-latest` runner ships the Windows SDK, so MSIX `make` works there with no setup. See [`README.md`](README.md) → "CI: the recommended build path". Local `npm run make` is the fallback.

## 6. Smoke test the installer
1. Install the `.msix` (trusted/sideload) and launch Paste → opens to the **unlock screen**.
2. **Create a vault** (the 24-word recovery phrase is shown **exactly once** — record it), write a note, **lock**, **unlock**, re-open the note (plaintext returns).
3. Independent storage check (proves nothing landed in plaintext):
   ```bat
   node scripts\verify-encryption.js <a-test-vault-dir>
   ```
   Exit **`0`** = no plaintext sentinel anywhere, AEAD-only. Non-zero = leak, **report it**.

## 7. E2E scenarios (Windows-specific + cross-device with the Mac)
From `E2E_TEST_PLAN.md`. Single-box items you can do alone; **MULTI** items need the Mac on the same `@hyperswarm/testnet` bootstrap or an isolated LAN DHT.

**Windows platform gate (§5 Windows):**
- [ ] `.msix` built via `npm run make` (signed run: Authenticode valid via `signtool`; note the **SmartScreen** reputation state).
- [ ] Clipboard read/write + **60s auto-clear** behave on real Windows.
- [ ] `npm start` boots the Electron host + both Bare workers + opens the vault store.

**Cross-device with the Mac (the important ones — these exercise what just shipped):**
- [ ] **S3 pairing** (desktop↔desktop): Mac `PAIR_CREATE_INVITE` → Windows joins via the short code → **compare the 6-digit confirmation on both screens** → Mac approves → `NOTE_LIST` converges. (Confirm the UI does **not** auto-accept without the human confirm.)
- [ ] **S4 concurrent edits**: Mac + Windows edit the **same** note id concurrently → both converge to the **same** LWW winner; distinct notes Y (Mac) and Z (Win) both survive on both.
- [ ] **S5 pairing-window note** *(the I-15/I-16 fix — verify explicitly)*: pair Windows **fresh**, have the Mac write a note **immediately** after pairing → it appears in the **Windows `NOTE_LIST`** with **no manual reconnect**.
- [ ] **S8 revoke**: Mac `DEVICE_REVOKE` the Windows device → Windows's later writes are **rejected** fleet-wide; confirm forward secrecy — content the Mac creates **after** the revoke does **not** decrypt on Windows.
- [ ] `verify-encryption.js` exits 0 on the Windows store throughout.

## 8. Report back
- `out\make\...\Paste.msix` (and/or `out\Paste-win32-x64\Paste.msix`) and a `.sha256` (`certutil -hashfile <file> SHA256`).
- The `npm run test:all` tallies + any non-flaky failure (full output).
- The §7 checklist with **P/F + notes** per item.
- Any worker-log error (especially `Not writable`, an unhandled reducer exception, or a wedge where one bad op halts a batch).
