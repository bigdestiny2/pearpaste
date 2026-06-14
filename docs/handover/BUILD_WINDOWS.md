# Handover: build the PearPaste Windows installer (`.msix`)

Run this on a **Windows 10/11 x64** box. Produces an MSIX package of Paste under
`out/make/` (and a copy under `out/Paste-win32-x64/`), optionally signed.

> **Build model: Electron Forge + pear-runtime.** Paste is now a standard
> Electron app that embeds `pear-runtime` and is packaged with **Electron
> Forge**. The build command is `npm run make` (`electron-forge make`). The old
> `pear build --win32-x64-app` / `scripts/build-windows.mjs` path is the
> **deprecated legacy pear-electron path**, retained for dual-boot until the
> Phase 5 cutover — do not use it for the Forge build (see the bottom of this
> file).

See `docs/handover/README.md` for the overall chain and box provisioning.

## 0. Prerequisites (one-time, on the box)
- **Node.js 22 LTS** → `node -v` shows `v22.x`.
- **Git**.
- **Windows SDK / Windows Kits 10** — provides `makeappx.exe` (always needed by
  the MSIX maker) and `signtool.exe` (only needed when signing). This is
  **preinstalled on the `windows-latest` GitHub runner**; on a local box install
  it via the [Windows SDK installer](https://developer.microsoft.com/windows/downloads/windows-sdk/)
  or the "Desktop development with C++" workload in Visual Studio Installer. The
  maker auto-detects it: `getWindowsKitVersion()` in `forge.config.js` walks
  `%PROGRAMFILES(X86)%\Windows Kits\10\bin\<dotted-quad>` and returns the highest.
- *(signed build only)* an Authenticode code-signing cert (PFX) **or** a cert
  thumbprint (SHA1) already in the machine store — **EV recommended** for instant
  SmartScreen reputation. Not needed for the first **unsigned** build.

> **No C++ toolchain is required for the app itself.** `npm ci` pulls the
> win32-x64 `sodium-native` prebuild (the only native addon); everything else is
> pure-JS / Bare. The Windows SDK is needed only by the MSIX *maker*, not to
> compile the app.

## 1. Get the code
```bat
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag-the-maintainer-gives-you>
npm ci
```

## 2. (Optional) Confirm the app boots before packaging
```bat
npm start
```
`electron-forge start -- --no-updates` launches the Electron host, spawns the two
Bare workers (`workers/main.js` updater + `workers/paste.js` vault), and opens to
the **unlock screen**. Close it once you've confirmed it boots.

## 3. Build the `.msix`

**Unsigned (no cert — recommended first build)**
```bat
npm run make
```
`electron-forge make` packages the win32 app and runs the MSIX maker
(`@electron-forge/maker-msix`). Output:
- `out/make/...\Paste.msix` — the package.
- `out/Paste-win32-x64\Paste.msix` — a copy the `postMake` hook relocates to the
  standard per-arch directory.

An **unsigned** MSIX builds cleanly but installs only on a machine that trusts a
sideload/dev cert; the maker auto-generates a self-signed dev cert (derived from
the manifest `Publisher`) so the package is well-formed. For distribution you
must sign it (below).

**Signed (Authenticode)**

Signing is gated on the `WINDOWS_SIGN_HOOK` env var. When it is set,
`forge.config.js` passes `windowsSignOptions.hookModulePath` to the maker:
```bat
set WINDOWS_SIGN_HOOK=C:\path\to\sign-hook.js
npm run make
```
The hook module performs the actual `signtool` call (PFX path or SHA1-thumbprint
path) per `electron-windows-msix` conventions. When `WINDOWS_SIGN_HOOK` is unset
the maker omits `windowsSignOptions` and emits an **unsigned** package — there is
no separate `release` command; signed vs unsigned is purely whether the env var
is present.

> **Production note (manifest must match the cert).** `build/AppxManifest.xml`
> ships `Publisher="CN=Paste"`, a placeholder that matches the auto-generated dev
> cert. For a real signed release the manifest `Publisher` must be **byte-identical**
> to the signing cert's subject (e.g. `CN=...,O=...,C=...`) or `signtool` rejects
> the signature. Update `Publisher` before a production sign.

> **Version stamping is automatic.** The `preMake` hook rewrites the manifest
> `Version="..."` from `package.json#version` (e.g. `0.1.0` → `0.1.0.0`), so you
> do not edit it by hand per release.

## 4. CI is the recommended path
For repeatable, signed builds prefer the GitHub-hosted CI workflow rather than a
local box — see **`docs/handover/README.md` → "CI: the recommended build path"**.
The `windows-latest` runner already carries the Windows SDK, so MSIX `make` works
there with no extra setup; pass the Windows signing secrets to sign, or omit them
for an unsigned artifact. Local `npm run make` is the manual fallback.

## 5. Sanity-check before sending back
- Install the `.msix` (a signed/trusted one, or enable sideloading for the dev
  cert) and launch Paste → confirm it opens to the unlock screen and you can
  create + unlock a vault.
- Independent storage check on a throwaway vault (proves nothing landed in
  plaintext):
  ```bat
  node scripts\verify-encryption.js <a-test-vault-dir>
  ```
  Exit **`0`** = storage is sentinel-free and AEAD-only. Non-zero = leak, **report it**.

## 6. Output → send back
`out\make\...\Paste.msix` (and/or `out\Paste-win32-x64\Paste.msix`), plus a
`.sha256` for each (`certutil -hashfile <file> SHA256`).

## Troubleshooting
- **`make` fails looking for `makeappx.exe`** → the Windows SDK / Windows Kits 10
  isn't installed (or `getWindowsKitVersion()` returned nothing). Install the SDK;
  confirm `%PROGRAMFILES(X86)%\Windows Kits\10\bin\<ver>\x64\makeappx.exe` exists.
- **MSIX logo / tile assets missing or `make` errors on the logo** → known asset-path
  issue: `build/AppxManifest.xml` references `build\icon.png`, but the maker stages
  the app under an `app\` subfolder, so assets land at `app\build\icon.png`. Fix by
  pointing the manifest `<Logo>` / `Square*Logo` at `app\build\icon.png` (or adding
  matching `packageAssets`). Flagged in the config audit.
- **Won't install ("untrusted publisher")** → an unsigned/dev-signed MSIX needs
  the dev cert trusted or sideloading enabled; sign with a real cert for normal
  install.
- **`MinVersion`/install-gate too high** → `build/AppxManifest.xml` pins
  `MinVersion="10.0.19045.0"`, which excludes older Win10. Lower it (e.g.
  `10.0.17763.0`) if you need broader reach. Flagged in the audit.

---

## Legacy path (deprecated — do not use for the Forge build)
`npm run build:win` / `build:win:unsigned` / `release:win` still run
`scripts/build-windows.mjs` (the old `pear build --win32-x64-app` + NSIS/WiX +
`signtool` flow). This is the **legacy pear-electron path**, retained only for
dual-boot until the Phase 5 cutover. New `.msix` builds use `npm run make`
(above). See `docs/PEAR_RUNTIME_MIGRATION.md` for the cutover plan.
