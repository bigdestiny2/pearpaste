# Handover: build the PearPaste Linux package (`.deb`)

Run this on an **Ubuntu 22.04+ / Debian 12+ x64** box. Produces, under
`dist/linux/`: a `.deb` (primary), an optional `.AppImage`, and a distro-neutral
`.tar.gz` launcher — each a thin wrapper that runs the production `pear://` link
through the Pear runtime.

See `docs/handover/README.md` for the overall chain and box provisioning.

## 0. Prerequisites (one-time, on the box)
- Node.js 22 LTS → `node -v` shows `v22.x`
- Git
- Pear CLI → `npm i -g pear` then `pear -v`
- `dpkg-deb` (`dpkg --version`) — for the `.deb`
- *(optional)* `appimagetool` on `PATH` — to also emit an `.AppImage`
- *(release/signing)* `minisign` or `gpg` — the release gate requires a detached signature

## 1. Get the code
```sh
git clone https://github.com/bigdestiny2/pearpaste.git
cd pearpaste
git checkout <branch-or-tag-the-maintainer-gives-you>
npm ci
```
`npm ci` pulls the linux-x64 `sodium-native` prebuild (the only native addon).

## 2. Confirm Linux-capability
```sh
npm run preflight:linux
```
Checks the root lockfile, Pear stage entrypoints, `pear-electron/pre`, the linux
`sodium-native` prebuild, `tar`, and optional distro tooling (`dpkg-deb`,
`appimagetool`, `rpmbuild`, `desktop-file-validate`).

## 3. Point at the production link
The maintainer stages production on the Mac and hands you the versioned link:
```sh
export PEARPASTE_LINK="pear://<fork>.<length>.<key>"
```

## 4. Build the package(s)

**Unsigned (no signature — recommended first build)**
```sh
npm run build:linux
```
Produces `dist/linux/pearpaste-<version>-linux-x64.tar.gz` (+ `.sha256`), and —
when `appimagetool` is present — an `.AppImage` (+ `.sha256`).

`npm run build:linux` also emits `dist/linux/paste_<version>_amd64.deb` (gated
on `dpkg-deb`; skips gracefully if it's missing), alongside the tarball and the
optional AppImage. Use `npm run build:linux:unsigned` to force the unsigned path
explicitly. (The `.deb`'s arch follows the box: `amd64` on an x64 runner.)

**Release (signed + checksummed)**
```sh
# first create a detached signature next to each artifact, e.g.:
minisign -Sm dist/linux/<artifact>          # -> <artifact>.minisig
npm run release:linux
```
`release:linux` requires a detached signature sidecar (`.sig` / `.asc` /
`.minisig` / `.p7s`) beside every artifact, matching the CI release gate, and
**fails closed** if one is missing.

## 5. Sanity-check before sending back
- Install + launch — note the `.deb` is a **launcher** (it runs `pear run
  pear://<link>`), so the target box needs the Pear runtime **and** the
  production link must be staged+seeded, which is currently **held**. Until then
  the `.deb` *builds* fine but won't *launch*:
  ```sh
  npm i -g pear                                      # target needs the Pear runtime
  sudo dpkg -i dist/linux/paste_<version>_amd64.deb
  paste        # or the .desktop entry — confirm it opens to the unlock screen
  ```
- Optional independent check on a throwaway vault:
  ```sh
  node scripts/verify-encryption.js <a-test-vault-dir>   # exit 0 = clean
  ```

## 6. Output → send back
`dist/linux/paste_<version>_amd64.deb` (+ `.AppImage`, `.tar.gz`) and the
`.sha256` (+ `.minisig`/`.sig` if you signed).

## Troubleshooting
- `pear` not found → `npm i -g pear`, reopen the shell.
- `.deb` not produced → ensure `dpkg-deb` is installed (`sudo apt-get install dpkg-dev`); the builder skips gracefully if it's absent.
- `release:linux` aborts on a missing signature → that's the gate; sign each artifact (step 4) or use `build:linux` for an unsigned dev build.
- Cannot build from macOS — these wrappers must be built **on Linux** (no cross-build).
