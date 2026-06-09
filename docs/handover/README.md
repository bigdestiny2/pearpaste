# Build handover — Windows `.exe` & Linux `.deb`

Operational runbooks for producing the native desktop installers on your own
Windows and Linux boxes (macOS `.dmg` is built on the Mac). Pair these with
`docs/SHIPPING.md` (channels, certs, policy) and `docs/RELEASE.md` (release gates).

- [`BUILD_WINDOWS.md`](BUILD_WINDOWS.md) — produce `Paste.exe` (+ optional `Setup.exe`)
- [`BUILD_LINUX.md`](BUILD_LINUX.md) — produce `paste_<ver>_amd64.deb` (+ AppImage, tarball)

> ⚠️ The exact **build command** in each runbook is being finalized by the
> packaging pipeline (it adds the `.deb` builder, an unsigned/no-cert build
> path, and a macOS build script). Those lines are marked **⏳ PENDING** and
> will be locked when the pipeline lands. Everything else below is stable —
> provision the boxes now.

## The handover chain (who does what)

| # | Step | Owner | Status |
|---|------|-------|--------|
| 1 | Land the multiwriter durability fix | maintainer (in progress) | ⏳ agent running |
| 2 | Land the packaging pipeline (`.deb`, unsigned mode, `build-macos`, `release.yml`) | maintainer (in progress) | ⏳ agent running |
| 3 | Push the build branch to GitHub so the boxes can `git clone`/checkout it | maintainer | ⏳ after 1–2 (will confirm repo visibility / whether to exclude internal `REVIEW.md`) |
| 4 | Stage production on the Mac → versioned `pear://` link | maintainer | ⏳ after 1 (so the shipped app includes the fix) |
| 5 | Hand off the build branch + the `pear://` link + the runbooks | maintainer | ⏳ |
| 6 | Run the runbook on each box → **unsigned** `.exe` / `.deb`; send artifacts back | **you (boxes)** | blocked on 3–5 |
| 7 | Buy certs → signed/notarized rebuild | **you** + maintainer | later |

## Provision the boxes NOW (parallel, no dependencies)

**Windows box**
- Windows 10/11 **x64**
- Node.js **22 LTS** (`node -v` → `v22.x`)
- Git
- Pear CLI: `npm i -g pear` (`pear -v`)
- *(signed builds, later)* an Authenticode code-signing cert as `.pfx` + password — **EV recommended** (instant SmartScreen reputation). Not needed for the first **unsigned** build.
- *(optional)* NSIS or WiX (to wrap the app into `Setup.exe`)

**Linux box**
- Ubuntu 22.04+ / Debian 12+ **x64**
- Node.js **22 LTS**
- Git
- Pear CLI: `npm i -g pear`
- `dpkg-deb` (from the `dpkg` package — usually preinstalled) for the `.deb`
- *(optional)* `appimagetool` (to also emit an `.AppImage`), and `minisign` or `gpg` (to sign the `.deb` for the release gate)

**Both** will receive from the maintainer: the build branch/commit, and the production `pear://<fork>.<length>.<key>` link.

## What you'll send back
- Windows: `dist/win32/Paste.exe` (+ `Setup.exe` if wrapped) + `.sha256`
- Linux: `dist/linux/paste_<ver>_amd64.deb` (+ `.AppImage`, tarball) + `.sha256` (+ detached `.sig`/`.minisig` if you sign)
