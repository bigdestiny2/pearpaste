# RFC: Migrate Paste to the `pear-runtime` + Electron-Forge boilerplate

**Status:** DRAFT — for review. **No code changes in this PR.** This document only proposes a plan.
**Author:** (migration planning) · **Date:** 2026-06-12 · **Branch:** `docs/pear-runtime-migration-plan`

---

## 1. Why this exists

Holepunch shipped a re-architected desktop boilerplate ([Hello Pear
Electron](https://github.com/holepunchto/hello-pear-electron), announced at
[pears.com/news/hello-pear-boilerplates](https://pears.com/news/hello-pear-boilerplates/)).
It replaces the `pear-electron` *UI-library* model Paste uses today with a model
where a **standard Electron app embeds `pear-runtime` as a library** and is
packaged with **Electron Forge**.

**Paste's current line is NOT broken or deprecated.** We are pinned to the
**latest** of everything on that line:

| Package | Paste pins | Latest published | Last shipped |
|---|---|---|---|
| `pear-electron` | `~1.7.28` ✅ latest | `1.7.28` | 2026-02-09 |
| `pear-bridge` | `^1.2.5` ✅ latest | `1.2.5` | 2026-01-13 |

But the **direction of travel is the new stack**: `pear-runtime` was created the
same day as pear-electron's last release and shipped again **2026-05-21**, while
pear-electron has not shipped since February. New official tooling
(electron-forge makers, `pear build --package`, `pear.json` multisig) targets the
new model. Staying on pear-electron is fine for now; *new conventions* live in
the new stack.

**This RFC plans the migration. It does not perform it.** Approve the plan (or a
subset of phases) before any code is written.

---

## 2. TL;DR recommendation

- **Do it as a dedicated, phased effort on its own branch — not an inline sweep.**
- **Sequence it behind a working fallback:** keep the pear-electron entrypoint
  runnable until the Forge build is validated on all three platforms.
- **The single biggest cost is the build/release layer** (~1,440 lines of custom
  `scripts/build-*.mjs` + `release-prod.sh` are replaced by Electron Forge
  config + makers). The app/runtime code change is comparatively small.
- **Highest-risk, Paste-specific items:** the Bare worker IPC swap
  (`pear-pipe`/`bare-rpc` → `Bare.IPC`), `sodium-native` prebuild handling under
  Forge, the two `patch-package` patches, code-signing parity, and **preserving
  the encryption-at-rest invariants** the security suite guards.

---

## 3. Current architecture (the "from")

```
index.js (94 LOC)                 ← Pear entrypoint = pear-electron LAUNCHER only
  ├─ resolveStoragePath()         ← Pear.config.storage  (pear-electron)
  └─ startLauncher()              ← new Runtime() + new Bridge(); runtime.start({bridge})
                                     renderer is served by pear-bridge
ui/desktop/app.js (1357 LOC)      ← renderer; imports `pear-electron` for app.tray() etc.
backend/desktop-worker.mjs (64)   ← Bare worker; renderer spawns it via Pear.worker.run
                                     → pear-pipe → bare-rpc (newline-JSON) → createPearEnd()
backend/index.js                  ← createPearEnd(): the runtime-agnostic Pear-end (vault,
                                     swarm, autobase, relay) — NOT coupled to pear-electron
package.json "pear" {}            ← type:desktop, pre:pear-electron/pre, gui{}, stage{ignore}
scripts/build-windows.mjs (334)   ┐
scripts/build-macos.mjs   (312)   ├ custom build/sign/package per platform
scripts/package-linux.mjs (418)   ┘  (+ pear build --<platform>-app, codesign, notarize, NSIS,
scripts/release-prod.sh   (379)   ← stage → verify → seed → pin → (provision/multisig notes)
```

Native / runtime specifics that constrain the migration:
- **Bare runtime** in the worker: `imports` map (`fs→bare-fs`, `path→bare-path`),
  `bare-rpc`, `bare-fs`, `bare-path`.
- **`sodium-native@^5`** — the only C++ addon (win32/mac/linux prebuilds).
- **`patch-package`** patches: `device-file+2.3.1`, `fs-native-extensions+1.5.0`
  (hypercore-storage layer — **architecture-independent**, they carry over as-is).
- **`p2p-hiverelay-client`** (optionalDependency) — relay fleet; takes the shared
  swarm + corestore, unaffected by the UI shell.

---

## 4. Target architecture (the "to")

Per the new boilerplate:

```
electron/main.js                  ← standard Electron main process
  ├─ const pear = new (require('pear-runtime'))()
  ├─ pear.storage                 ← storage path (replaces Pear.config.storage)
  ├─ pear.run('./workers/main.js', [pear.storage])  ← Bare worker via Bare.IPC
  ├─ pear.updater.on('updating'|'updated', …)        ← OTA update lifecycle
  └─ BrowserWindow + pear-bridge  ← renderer IPC bridge (bridge.applyUpdate(), etc.)
workers/main.js                   ← Bare worker entry (Bare.IPC, Bare.argv) → createPearEnd()
package.json                      ← "upgrade":"pear://…", "version" drives OTA; electron-forge
pear.json                         ← { multisig: { publicKeys[], namespace, quorum } }
build/                            ← entitlements.mac.plist, AppxManifest.xml, icons
                                     (Forge maker inputs, replaces custom scripts)
```

Build & release pipeline (replaces the custom scripts):
```
electron-forge make               → per-platform distributables (dmg/msix/deb/rpm/appimage/…)
pear build --package=package.json --<plat>-app … --target out/build
pear stage [--dry-run] <link> ./out/build         (dev/staging/rc)
pear provision <stage-verlink> <prod> <prod-verlink>   (strip history)
pear multisig keys|link|request|sign|verify|commit     (production quorum)
```

Dependencies added: `pear-runtime`, `pear-interface`, `@electron-forge/cli` +
makers (`maker-dmg`/`maker-msix`/`maker-deb`/`maker-rpm`/`maker-zip`,
`pear-electron-forge-maker-appimage`/`-flatpak`/`-snap`), `electron`,
`electron-forge-plugin-prune-prebuilds`, `electron-forge-plugin-universal-prebuilds`.
Dependencies retired: `pear-electron`, `pear.pre`, and most of `scripts/build-*`.

> ⚠️ **Convention conflict to resolve:** the boilerplate `package.json` is
> `"type": "commonjs"` with `electron/main.js`; Paste is `"type": "module"`
> (ESM) throughout (`index.js`, `backend/`, `ui/`). We do **not** want to convert
> the whole codebase to CJS. Decision needed (see §8 Q1): keep ESM and adapt the
> Forge main, or isolate a small CJS `electron/main.js` shim.

---

## 5. Component-by-component migration map

| Area | Today (pear-electron) | Target (pear-runtime + Forge) | Effort | Risk |
|---|---|---|---|---|
| Storage path | `Pear.config.storage` | `pear.storage` | XS | Low |
| Entry/launcher | `index.js` `runtime.start({bridge})` | `electron/main.js` `new Pear()` + BrowserWindow | M | Med |
| Worker spawn + IPC | `Pear.worker.run` → `pear-pipe` → `bare-rpc` | `pear.run('workers/main.js')` → `Bare.IPC` | **L** | **High** |
| Renderer | `ui/desktop/app.js` imports `pear-electron` (`app.tray()`) | Electron renderer + `pear-bridge`; tray via Electron `Tray` | M | Med |
| `createPearEnd()` backend | unchanged | unchanged | — | Low |
| Window/GUI config | `pear.gui{}` block | Forge/BrowserWindow opts + `pear.json`/package fields | S | Low |
| Native addon | `sodium-native` prebuild via Pear fetch | Forge prune/universal-prebuild plugins | M | **High** |
| `patch-package` | 2 storage-layer patches | carry over unchanged | XS | Low |
| Build: Windows | `build-windows.mjs` (NSIS/Authenticode) | `maker-msix` + `WINDOWS_CERTIFICATE_*` | **L** | **High** |
| Build: macOS | `build-macos.mjs` (codesign/notarytool) | `maker-dmg` + entitlements + `APPLE_*` env | **L** | **High** |
| Build: Linux | `package-linux.mjs` (appimage/flatpak) | `pear-electron-forge-maker-appimage`/`-flatpak`/`-snap` | **L** | Med |
| Release/OTA | `release-prod.sh` (stage→seed→pin) | `upgrade` field + `pear build`+stage+provision+multisig | **L** | **High** |
| Multisig prod | ad-hoc in `release-prod.sh` notes | declared in `pear.json` | S | Low |
| Update mechanism | client tracks staged length | `pear.updater` events + `bridge.applyUpdate()` + version bump | M | Med |

Effort key: XS<½d, S≈1d, M≈2-3d, L≈1wk+. **Net: a multi-week effort dominated by
the four "L/High" build+release rows.**

---

## 6. Paste-specific risks & invariants (do NOT regress)

1. **Encryption-at-rest invariant.** `test/security/sec-storage.test.js` +
   `scripts/verify-encryption.js` assert no plaintext sentinel ever lands on
   disk. The storage path provider changes (`Pear.config.storage` → `pear.storage`);
   the verifier must run **0** against a real Forge build on every platform.
2. **Bare worker IPC parity.** The worker protocol (newline-JSON over
   `bare-rpc`/`pear-pipe`) is what every integration test exercises in-process.
   Swapping to `Bare.IPC` must preserve framing/back-pressure or risk the
   "dropped write" / "Not writable" classes we already hardened against.
3. **`sodium-native` across Forge.** Universal-prebuild + prune plugins must ship
   the correct arch prebuild; a wrong/missing prebuild bricks crypto silently.
   Gate with a smoke test that opens a vault on each packaged artifact.
4. **Code-signing parity.** Current scripts encode hard-won macOS notarytool /
   Windows Authenticode / Linux flatpak knowledge. The Forge makers take
   different env vars; signing must be re-validated end-to-end (incl. SmartScreen
   reputation note for the unsigned-first Windows build).
5. **ESM vs CJS** (see §4 conflict).
6. **`pear-interface` vs current renderer.** We have a 1,357-LOC bespoke renderer;
   the boilerplate assumes `pear-interface`. We likely keep our renderer and only
   re-wire its host bridge — confirm `app.tray()` and any other pear-electron
   renderer APIs have Electron equivalents.
7. **Relay client.** `p2p-hiverelay-client` consumes the shared swarm+corestore;
   verify it still receives them under the new main-process wiring.
8. **The handoff/E2E docs** (`docs/handover/*`, `docs/E2E_TEST_PLAN.md`,
   `scripts/release-prod.sh`) all reference the current pipeline and must be
   rewritten in lockstep — they are part of the deliverable, not an afterthought.

---

## 7. Phased plan (each phase independently reviewable & revertible)

**Phase 0 — Spike (1–2 days, throwaway branch).**
Stand up the bare boilerplate (`hello-pear-electron`) unmodified; build+run it on
this Mac; confirm the Forge→`pear build`→`pear stage`→run loop works locally
before touching Paste. De-risks the toolchain in isolation.

**Phase 1 — Dual-boot entry (keep pear-electron working).**
Add `electron/main.js` + `workers/main.js` that boot `createPearEnd()` via
`pear-runtime`, *behind a flag/secondary script*, while `index.js` (pear-electron)
stays the default. Prove the worker IPC swap with the existing unit/integration
suites pointed at the new worker glue. **Gate: all suites green on both paths.**

**Phase 2 — Renderer re-wire.**
Point `ui/desktop/app.js` at the new host bridge; replace `app.tray()` and any
pear-electron renderer calls with Electron equivalents. Manual GUI parity pass
(create/restore/pair/lock/unlock/notes/clips/relay-status).

**Phase 3 — Build layer (the big one).**
Author `forge.config.*` + makers; wire `pear build --package`. Replace
`build-windows/macos/linux` script-by-script, **validating each platform's
artifact with `verify-encryption.js` + a vault smoke test** before deleting the
old script. Add `pear.json` (multisig) + `upgrade` + version-bump discipline.

**Phase 4 — Release pipeline + OTA.**
Re-implement `release-prod.sh` as stage→provision→multisig; wire
`pear.updater`/`bridge.applyUpdate()`; do a real cross-version OTA update test
(install vN, ship vN+1, confirm auto-update).

**Phase 5 — Docs + cutover.**
Rewrite `docs/RELEASE.md`, `docs/handover/*`, `E2E_TEST_PLAN.md`; flip the default
entry to `electron/main.js`; remove `pear-electron`/`pre`; delete superseded
scripts. Tag the last pear-electron commit for rollback.

---

## 8. Open decisions (need answers before Phase 1)

1. **ESM vs CJS** for `electron/main.js` — keep the repo ESM with an ESM Forge
   main, or carve a minimal CJS shim? (Recommend: stay ESM.)
2. **Renderer** — keep the bespoke `ui/desktop/app.js` (recommended) or adopt
   `pear-interface`? Keeping ours minimizes churn.
3. **Production link strategy** — reuse the existing `pear://u6oyh38…` production
   link (and re-stage onto it), or mint a fresh multisig line and migrate users
   via `upgrade`? Affects existing installs.
4. **Multisig quorum** — who are the signers / what `namespace` / what quorum for
   `pear.json`? (Maintainer-owned; blocks the production release phase only.)
5. **Mobile** — `mobile/` is a separate React-Native track; the announcement
   mentions a forthcoming RN boilerplate. Out of scope here, flag for later.

---

## 9. Validation matrix (exit criteria)

A phase is "done" only when, for the code it touches:

| Gate | Where |
|---|---|
| `npm run test:all` green (unit 45 · integration 41 · e2e 3 · security 27 · mobile 4) | every phase |
| `verify-encryption.js` exits 0 on a **packaged** artifact | Phase 3, per platform |
| Vault create/unlock smoke on packaged artifact | Phase 3, per platform |
| GUI parity pass (create/restore/pair/revoke/notes/clips/relay) | Phase 2 |
| Cross-device pair + sync (Mac↔Win) on packaged builds | Phase 4 |
| Cross-version OTA auto-update works | Phase 4 |
| macOS notarized · Windows signed (or SmartScreen noted) · Linux appimage/flatpak | Phase 3/4 |

---

## 10. Rollback

Each phase is a separate PR. The pear-electron entry (`index.js` + `pear.pre`)
remains the default through Phase 4, so any phase can be reverted without losing
a shippable app. Tag `pre-pear-runtime-migration` on the last pear-electron commit
before the Phase 5 cutover.

---

## 11. Effort estimate

| Phase | Est. |
|---|---|
| 0 Spike | 1–2 d |
| 1 Dual-boot entry + worker IPC | 3–4 d |
| 2 Renderer re-wire | 2–3 d |
| 3 Build layer (all platforms) | 1–2 wk |
| 4 Release + OTA | 4–5 d |
| 5 Docs + cutover | 2–3 d |
| **Total** | **~4–6 weeks**, one engineer, with all three build environments available |

The long pole is **Phase 3** and it **cannot be fully validated from a single
machine** — Windows and Linux packaging/signing need their own environments (the
existing `docs/handover/*` boxes).
