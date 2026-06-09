# Paste — Desktop Shipping Checklist

A living production-readiness checklist for shipping **Paste** on the desktop.
Paste is a **Pear / Holepunch** app on the **Bare** runtime (not Electron-as-a-product),
so its distribution story is different from a normal desktop app: the primary
deliverable is a `pear://` link, and native installers are thin wrappers that
embed the Pear runtime and resolve that link.

Companion docs: **RELEASE.md** (the build/verify/seed flow + CI gates),
**SECURITY.md**, **VERIFIER_SPEC.md**, **TESTING_MATRIX.md**. The scripts this
checklist references are the source of truth: `scripts/release-prod.sh`,
`scripts/build-windows.mjs`, `scripts/package-linux.mjs`, and the CI gates in
`.github/workflows/ci.yml`.

> Verified against **Pear v0.3243**. `pear init` and `pear release` were
> **removed**; the current commands are `pear touch`, `pear stage`, `pear seed`,
> `pear build --<platform>-app`, `pear provision`, and `pear multisig`.

---

## 1. The three distribution channels

| | Channel | What ships | Signing/notarization | When |
|---|---|---|---|---|
| **A** | **Pear-native `pear://` link** | A versioned `pear://<fork>.<length>.<z32-key>` link; user installs the Pear runtime once and runs `pear run pear://…` | None required (P2P, content-addressed, Pear-trust prompt) | **Phase 1 — now** |
| **B** | **Signed installers on our own site** | `.dmg` (macOS), `Setup.exe` (Windows), `.tar.gz`/`.AppImage` (Linux), each embedding the runtime + resolving the link | Required: Developer ID + notarization (macOS), Authenticode (Windows); Linux GPG/minisign | **Phase 2** |
| **C** | **OS app stores** (Mac App Store / Microsoft Store) | Store-packaged app | Store signing **plus** entitlements review | **Phase 3 — caveated, may be infeasible** |

### Channel C caveat — App Sandbox vs P2P (read before committing to stores)

The Mac App Store (App Sandbox) and Microsoft Store (AppContainer/MSIX) impose
a sandbox that **directly conflicts with how Paste works**:

- **Raw UDP / UDX / HyperDHT.** Paste's transport (Hyperswarm over UDX, DHT
  hole-punching) needs unrestricted outbound **UDP** and direct socket access.
  MAS App-Sandbox permits client networking but **NAT hole-punching, arbitrary
  inbound, and the DHT behavior are routinely rejected or broken**; MSIX
  AppContainer requires explicit loopback/network capabilities and blocks
  arbitrary inbound by default.
- **Spawning the Bare runtime.** Pear apps launch the **Bare** runtime as a
  child process and fetch/exec runtime + native prebuilds (`sodium-native`).
  App-Sandbox/AppContainer forbid spawning unsigned/unbundled executables and
  JIT/dynamic code paths — a hard conflict with Pear's P2P auto-update path.

**Consequence:** Channel C is **not a near-term target**. If pursued, it likely
requires a feature-reduced, store-specific build (e.g. relay-only transport, no
DHT, runtime fully bundled and statically launched) and explicit entitlement
justifications. Treat it as research, not a release lane. **Channels A and B
preserve the full P2P + auto-update behavior; the stores do not.**

---

## 2. Per-platform accounts, certs, and cost

All figures are list-price ballparks (annual unless noted) and change over time;
confirm with each vendor before budgeting.

### macOS
- **Apple Developer Program** — **$99/yr** (required for any signing/notarization).
- **Developer ID Application** certificate (issued via your Developer account) —
  for a **notarized `.dmg`** distributed outside the App Store (Channel B).
- **Notarization** is free with the program; done via `notarytool` + `stapler`.
- **Mac App Store (Channel C)** uses different certs (Apple Distribution / Mac
  App Distribution) and App-Sandbox entitlements — see the §1 caveat.

### Windows
- **No platform account needed for Channel B**, but you need a code-signing cert:
  - **OV (Authenticode)** — **~$200–400/yr**. Works, but **SmartScreen
    reputation builds slowly** (new cert ⇒ "unknown publisher" warnings until
    enough installs accrue).
  - **EV (Authenticode)** — **~$300–700/yr**, ships on a **hardware token /
    HSM**, and grants **instant SmartScreen reputation**.
  - **All code-signing certificates now require hardware/HSM key storage**
    (CA/Browser Forum baseline since 2023) — OV and EV alike. Budget for a
    FIPS-140 token or a cloud HSM signing service.
- **Microsoft Store (Channel C)** — Partner Center registration + MSIX
  packaging; see the §1 caveat.

### Linux
- **No mandatory signing.** Distribute a `.tar.gz` and/or `.AppImage`.
- Provide integrity/authenticity via **GPG** or **minisign** detached
  signatures (the CI `release-guard` + `release:linux` both require a
  `.sig/.asc/.minisig/.p7s` sidecar).
- Optional distro packaging (`.deb`/`.rpm`) uses distro-native signing.

---

## 3. The build → sign → notarize commands (referencing the fixed scripts)

These are the **actual** commands the repo scripts run. Cert/identity-dependent
steps **fail closed** when their env vars are unset.

### One-time: mint and stage the link (any OS)

```sh
pear touch                          # prints a fresh pear://<z32-key>  (replaces `pear init`)
pear stage --json production        # syncs to the link; emits `link` + `verlink`
```

The **`verlink`** (`pear://<fork>.<length>.<z32-key>`, z-base-32 key) is the
immutable production link to publish. The end-to-end flow (stage → verify →
seed → pin → notes) is automated:

```sh
scripts/release-prod.sh --dry-run            # print the whole plan, no side effects
scripts/release-prod.sh --channel production # real run (confirms each step; --yes to skip prompts)
```

`release-prod.sh` **refuses to publish if `--skip-verify`** bypassed the
encryption gate, and seeds the link with `pear seed`. A *signed* production link
(quorum cosign) uses `pear provision` + `pear multisig` (needs quorum keys; out
of repo scope).

### macOS — Developer ID + hardened runtime + notarize (Channel B)

Required env (fail closed without them):

```sh
export PEARPASTE_MAC_IDENTITY="Developer ID Application: <Name> (<TEAMID>)"
# notarytool auth — EITHER a stored keychain profile:
export PEARPASTE_NOTARY_PROFILE="<profile from: xcrun notarytool store-credentials>"
# OR the Apple-ID triple:
export APPLE_ID="you@example.com" APPLE_TEAM_ID="<TEAMID>" APP_SPECIFIC_PASSWORD="<app-specific-pw>"
export PEARPASTE_MAC_APP="dist/macos/by-arch/darwin-arm64/app/Paste.app"
```

What `release-prod.sh`'s `mac_sign_notarize()` runs (after `pear build`):

```sh
pear build --darwin-arm64-app <path-to/Paste.app> --target dist/macos
codesign --deep --force --options runtime --timestamp --sign "$PEARPASTE_MAC_IDENTITY" <Paste.app>
codesign --verify --deep --strict --verbose=2 <Paste.app>
hdiutil create -volname Paste -srcfolder <Paste.app> -ov -format UDZO dist/Paste-<version>.dmg
codesign --force --timestamp --sign "$PEARPASTE_MAC_IDENTITY" dist/Paste-<version>.dmg
xcrun notarytool submit dist/Paste-<version>.dmg --keychain-profile "$PEARPASTE_NOTARY_PROFILE" --wait
xcrun stapler staple dist/Paste-<version>.dmg
```

> `pear build` enforces that the app-dir basename equals `package.json`
> `productName` (pinned to **`Paste`**), so the `.app`/dir must be named `Paste`.

### Windows — Authenticode (Channel B)

Required env (fail closed without the cert):

```powershell
$env:PEARPASTE_LINK          = "pear://<verlink>"
$env:PEARPASTE_WIN_WRAPPER   = "<prebuilt win32-x64 app dir; basename must be 'Paste'>"
$env:PEARPASTE_WIN_CERT      = "C:\path\to\authenticode.pfx"   # or HSM/token-backed
$env:PEARPASTE_WIN_CERT_PASS = "<pfx password>"
npm run release:win
```

What `scripts/build-windows.mjs` does:

```text
pear build --win32-x64-app <dir> --target dist/win32
# locate the binary by GLOBBING bin\*-app\*.exe (never a hardcoded name)
signtool sign /f <cert> /fd SHA256 /tr <RFC3161 TSA> /td SHA256 <Paste.exe>
# then wrap with NSIS/WiX and signtool the resulting Setup.exe with the same flags
```

TSA URL overridable via `PEARPASTE_WIN_TSA` (default `http://timestamp.digicert.com`).
Signing only runs on a Windows host; on other OSes the step is skipped (Tier-1
link remains the cross-platform deliverable).

### Linux — tarball (+ optional AppImage) + detached signature

```sh
npm run preflight:linux                                   # readiness (any OS)
PEARPASTE_LINK=pear://<verlink> npm run build:linux       # tarball + .sha256 (+ AppImage if appimagetool present)
minisign -Sm dist/linux/pearpaste-<version>-linux-<arch>.tar.gz   # -> .minisig sidecar
npm run release:linux                                     # requires the sidecar(s); fails closed otherwise
```

`build:linux` emits `dist/linux/pearpaste-<version>-linux-<arch>.tar.gz` + a
`.sha256`. When `appimagetool` is on PATH it **additionally** emits a
`…​.AppImage` + `.sha256`; absent the tool it is skipped gracefully. `release:linux`
requires a detached signature sidecar (`.sig/.asc/.minisig/.p7s`) for the
tarball and for any AppImage.

---

## 4. Cross-cutting gates (before public beta)

| Gate | Status (this repo) | Action |
|---|---|---|
| **External security audit** | **OPEN** (RELEASE.md §5 / SECURITY.md) | Engage a qualified third party before public beta; do not self-attest. |
| **Encryption export classification** | Not filed | Self-classify the crypto. Paste uses standard XChaCha20-Poly1305 in a mass-market app → **likely ECCN 5D992** (mass-market, License Exception ENC). A **BIS self-report / annual self-classification report** may be required (and re-export rules apply). Confirm with counsel before distributing internationally. |
| **Privacy policy + ToS** | Not present | Publish both before any public download (also a store prerequisite for Channel C). |
| **Verifier-gated release** | **Done** | `release-prod.sh` step 2 + CI `release-guard`; `verify-encryption.js` must exit 0. |
| **Signed-artifact gate** | **Wired, inert until release** | CI `release-guard` blocks unsigned `dist/` artifacts; inert on PR CI (no job populates `dist/`). See RELEASE.md §6. |
| **Supply chain** | **Done (CI)** | Committed lockfile + `npm audit` (`supply-chain`). Add SBOM/provenance before beta. |
| **Reproducible build** | Interim | Pinned lockfile + Node 22 + `npm ci`; full attestation is an M6 task. |

> **Crypto-export note is guidance, not legal advice.** ECCN 5D992 / ENC
> self-classification and BIS reporting obligations depend on specifics; get a
> sign-off from counsel.

---

## 5. Recommended phased rollout

1. **Phase 1 — Pear-native (Channel A).** Ship the versioned `pear://` verlink.
   No certs. Users install the Pear runtime once. This is the lowest-friction,
   highest-fidelity path and exercises the full P2P + auto-update behavior.
   Gate: `release-prod.sh` green (verifier exits 0), link seeded + pinned.
2. **Phase 2 — Signed installers (Channel B).** Add notarized macOS `.dmg`,
   Authenticode Windows `Setup.exe`, signed Linux `.tar.gz`/`.AppImage`, hosted
   on our own site. Gate: real Developer ID + notarization, Authenticode cert on
   hardware/HSM, GPG/minisign keys; CI `release-guard` enforces signatures.
   Pre-req: external security audit complete, privacy policy + ToS live.
3. **Phase 3 — Mobile + (maybe) stores.** Mobile app stores (TestFlight →
   App Store, internal track → Play) per RELEASE.md §4. Desktop OS stores
   (Channel C) only if a sandbox-compatible, feature-reduced build is justified
   — see the §1 caveat; the raw-UDP/DHT + Bare-spawn conflicts may make it
   infeasible without dropping P2P.

---

## 6. Quick pre-ship checklist

- [ ] `npm run lint && npm run test:all` green on Node 22.
- [ ] `node scripts/verify-encryption.js <fresh-vault>` exits 0.
- [ ] `scripts/release-prod.sh --dry-run` prints the expected plan.
- [ ] Versioned `verlink` recorded (`pear://<fork>.<length>.<z32-key>`).
- [ ] (Phase 2) Developer ID + notarytool auth set; `.dmg` notarized + stapled.
- [ ] (Phase 2) Authenticode cert (HSM/token) set; `Setup.exe` signed + timestamped.
- [ ] (Phase 2) Linux tarball/AppImage signed (minisign/GPG sidecar present).
- [ ] External security audit complete; privacy policy + ToS published.
- [ ] Crypto export self-classification on file (ECCN check); counsel sign-off.
- [ ] Release notes state what the verifier proof does and does **not** prove.
