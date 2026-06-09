# Handover: build the PearPaste Windows installer (`.exe`)

Run this on a **Windows 10/11 x64** box. Produces a Windows wrapper of the
PearPaste Pear app under `dist\win32\` — `Paste.exe`, optionally
Authenticode-signed, optionally wrapped into `PearPaste-Setup.exe`.

See `docs/handover/README.md` for the overall chain and box provisioning.

## 0. Prerequisites (one-time, on the box)
- Node.js 22 LTS → `node -v` shows `v22.x`
- Git
- Pear CLI → `npm i -g pear` then `pear -v`
- *(signed build only)* Authenticode cert `.pfx` + password
- *(installer only)* NSIS or WiX

## 1. Get the code
The maintainer will give you the branch/commit. From the box:
```bat
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag-the-maintainer-gives-you>
npm ci
```
`npm ci` pulls the win32-x64 `sodium-native` prebuild (the only native addon —
everything else is pure-JS / Bare), so **no C++ toolchain is required**.

## 2. Confirm Windows-capability
```bat
npm run preflight:win
```
Must end with `PREFLIGHT PASS — app is Windows-capable`. If it flags an
unguarded Node-only global (`process`/`Buffer`/`AbortController`) in
worker-reachable code, stop and report it — that breaks the Bare runtime.

## 3. Point at the production link
The maintainer stages production on the Mac (`pear stage production`) and hands
you the **versioned** link. Set it for the build:
```bat
set PEARPASTE_LINK=pear://<fork>.<length>.<key>
:: PowerShell:  $env:PEARPASTE_LINK = "pear://<fork>.<length>.<key>"
```

## 4. Build the `.exe`

**Unsigned (no cert — recommended first build)**
```bat
npm run build:win:unsigned
```
Packages the win32-x64 app via `pear build --win32-x64-app` and skips signing →
an unsigned `dist\win32\...\Paste.exe`. (SmartScreen warns until it's signed.)

**Signed (Authenticode)**
```bat
set PEARPASTE_WIN_CERT=C:\path\to\authenticode.pfx
set PEARPASTE_WIN_CERT_PASS=<pfx password>
set PEARPASTE_WIN_TSA=http://timestamp.digicert.com   :: optional override
npm run release:win
```
`release:win` runs `pear build --win32-x64-app <Paste app dir> --target dist\win32`
then `signtool sign /fd SHA256 /tr <TSA> /td SHA256` over the produced
`bin\*-app\*.exe`. It **fails closed** without `PEARPASTE_WIN_CERT`.

> ⚠️ **`pear build` needs the Pear runtime materialized first** — it's a *fetched*
> Pear app, not in node_modules. Do this once on the box, before step 4:
> ```bat
> :: 1. get pear-electron's runtime link
> node -e "console.log(require('pear-electron/package.json').pear.ui.link)"
> ::    -> pear://0.940.cktxzeti...
> :: 2. dump it locally (~450 MB once; carries by-arch slices for all platforms)
> pear dump --force <that-link> .\pear-runtime
> :: 3. point the build at the win32-x64 slice (it holds the runtime app):
> set PEARPASTE_WIN_WRAPPER=%CD%\pear-runtime\by-arch\win32-x64
> ```
> The precise `pear build --win32-x64-app <path>` arg form was still being pinned
> at handover (it printed usage in my testing — a parser quirk, not a path
> error). If `build:win` prints `pear build` usage instead of building, try
> `PEARPASTE_WIN_WRAPPER` = the `by-arch\win32-x64` dir, then the runtime
> `.exe`/app dir *inside* it, and adding `--package package.json`. **Report which
> form builds** and I'll lock it into `scripts/build-windows.mjs` for everyone.

## 5. (Optional) Installer
Wrap the signed app dir with NSIS or WiX → `PearPaste-Setup.exe`, then
`signtool` the `Setup.exe` with the same `/fd SHA256 /tr <TSA> /td SHA256` flags.

## 6. Sanity-check before sending back
- Launch the `.exe`; confirm it opens to the unlock screen and you can create/unlock a vault.
- Optional independent check on a throwaway vault:
  ```bat
  node scripts\verify-encryption.js <a-test-vault-dir>
  ```
  Exit `0` = storage is sentinel-free and AEAD-only.

## 7. Output → send back
`dist\win32\Paste.exe` (+ `PearPaste-Setup.exe` if wrapped), plus a `.sha256`
for each if you can generate them (`certutil -hashfile <file> SHA256`).

## Troubleshooting
- `pear` not found → `npm i -g pear`, reopen the shell.
- `no bin\*-app\*.exe found under <wrapper>` → `pear build --win32-x64-app`
  didn't emit the app dir; verify the app-dir basename is exactly `Paste`.
- `release requires an Authenticode certificate` → you're in `--release` with no
  cert; use the unsigned path (step 4) or set the cert env vars.
- SmartScreen "unknown publisher" on an unsigned or fresh-OV build → expected;
  resolved by an **EV** cert (instant reputation) or accrued OV reputation
  (see `docs/SHIPPING.md`).
