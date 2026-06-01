# Paste Mobile — Build & Run Guide

Status: this directory contains the **complete mobile source** (Bare worklet,
RPC bridge, React Native screens, smoke test) **and** a generated, wired React
Native host project at `mobile/PearPasteMobile/`.

**Android: a debug APK builds successfully and reproducibly** on macOS with the
toolchain below, with the *entire* Pear-end native stack
(`libsodium-native`, `librocksdb-native`, `libudx-native`,
`libquickbit/rabin/crc/simdle-native`, `libbare-crypto`, …) packaged into the
APK. Installing/running it on a device or emulator, and producing a *signed
release* for the Play Store, need hardware / a keystore / a Play account and
are the only genuinely out-of-scope steps (called out below).

**iOS: the host project is wired and CocoaPods installs cleanly.** The Pear-end
Bare addons are linked from the repo root during `pod install` and again during
Xcode builds. Simulator/device builds still require a working Xcode simulator
or physical-device signing environment.

---

## What runs with no phone / no native toolchain

```sh
node mobile/test/worklet-rpc.test.js     # or: npx brittle mobile/test/worklet-rpc.test.js
```

Boots the **real** `createPearEnd()` Pear-end and drives the real RPC
server/client loop from `mobile/rpc-commands.mjs` over an in-process pipe — the
same code path the device uses, only the byte transport differs (`BareKit.IPC`
on device vs an in-memory pipe here). Proves worklet boot, `CREATE_VAULT →
NOTE_UPSERT → NOTE_LIST (sealed) → NOTE_OPEN (plaintext) → LOCK`,
`PAIR_CREATE_INVITE` + invite wire/expiry, clip capture+copy, and a
worklet-crash → recoverable-error path. **4/4 tests, 34/34 asserts pass.**

---

## Prerequisites (macOS, verified)

```sh
brew install openjdk@17
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"

# Android SDK (android-commandlinetools is a brew cask; sdkmanager needs JDK 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "cmdline-tools;latest" \
  "platforms;android-35" "platforms;android-36" \
  "build-tools;35.0.0" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

`bare-pack` is pinned as a local RN host dev dependency and `bare-link` comes
from `react-native-bare-kit`; native builds invoke both through
`mobile/PearPasteMobile/node_modules/.bin/*`. Run
`npm install --legacy-peer-deps` in `mobile/PearPasteMobile/` to materialize
those binaries. Use the pinned local packer for repeatable Android builds.

---

## Step 1 — Bundle the Pear-end (`bare-pack`, no phone)

From the **repo root**:

```sh
npm --prefix mobile/PearPasteMobile run bundle:bare
```

Notes (corrects earlier drafts):

- The flag is `--host <triple>` (repeatable), **not** `--target`. Passing the
  Android + iOS hosts makes `--linked` resolve each native addon's per-host
  prebuild (the bundle then carries `linked:` refs for both `.so` and
  `.framework`).
- The script expands to the pinned local binary at
  `mobile/PearPasteMobile/node_modules/.bin/bare-pack`; it never fetches a CLI
  with `npx`.
- Outputs are CJS modules: `app.bundle.js` for the legacy all-host bundle plus
  `app.android.bundle.js` / `app.ios.bundle.js` for Metro's platform-resolved
  `mobile/backend/worklet-bundle` shim. See `mobile/bare-pack.config`.

---

## Step 2 — React Native host project

Already generated and wired at `mobile/PearPasteMobile/` (RN **0.81.4**, app
name `PearPaste`). To regenerate from scratch:

```sh
npx @react-native-community/cli@latest init PearPaste \
  --version 0.81.4 --skip-install --directory mobile/PearPasteMobile
cd mobile/PearPasteMobile && npm install
npm install --legacy-peer-deps \
  react-native-bare-kit@0.14.0 bare-rpc @dr.pogodin/react-native-fs \
  @react-native-clipboard/clipboard react-native-svg \
  react-native-qrcode-svg react-native-camera-kit
```

Wiring already committed in this repo:

- `mobile/PearPasteMobile/index.js` registers the shared `../app/App` under the
  native name `PearPaste` (matches `app.json`).
- `mobile/PearPasteMobile/metro.config.js`: `watchFolders` = **repo root** (so
  `mobile/app`, `mobile/rpc-commands.mjs`, `mobile/backend/app*.bundle.js` and
  the shared `backend/rpc.js` all resolve); `sourceExts` adds `mjs`/`cjs`;
  optional pairing libs are mapped to `metro.empty.js` only when missing, so QR
  rendering/scanning works when the native packages are installed and degrades
  to manual-entry fallback when they are not.
- `mobile/PearPasteMobile/android/build.gradle`: `minSdkVersion = 29`
  (react-native-bare-kit requires ≥ 29; the RN template's default 24 fails the
  manifest merge).
- `android/local.properties`: `sdk.dir=$ANDROID_HOME`.

---

## Step 2.5 — Link the Pear-end Bare native addons (the critical step)

react-native-bare-kit's stock `link.mjs` runs `bare-link` graph-rooted at the
RN host project, so it only finds bare-kit's *own* core addons. Paste's
Pear-end native deps (`sodium-native`, `rocksdb-native`, `udx-native`,
`quickbit/rabin/crc/simdle-native`, `bare-crypto`, `fs-native-extensions`, …)
live in the **repo-root** `node_modules` and are only referenced as `linked:`
specifiers inside the bare-pack bundle. Without linking them the APK builds but the
worklet crashes at runtime loading sodium/rocksdb/udx.

**This is now automated**: `mobile/PearPasteMobile/android/app/build.gradle`
defines `pearpasteLinkBareAddons` (a `preBuild` dependency) which runs:

```sh
# equivalent manual command (run from repo root):
mobile/PearPasteMobile/node_modules/.bin/bare-link . \
  --host android-arm64 --host android-arm --host android-ia32 --host android-x64 \
  --out mobile/PearPasteMobile/node_modules/react-native-bare-kit/android/src/main/addons
```

Android Gradle also runs `pearpasteBundleBareWorklet` before `preBuild`, using
the same local `bare-pack` binary to regenerate
`mobile/backend/app.android.bundle.js` without `npx`. `bare-link` merges into
bare-kit's `jniLibs` source dir, so it composes with bare-kit's own link step
and is re-run on every Gradle build (durable across `npm install`, which wipes
`node_modules`).

---

## Step 3 — Build the Android APK (verified)

```sh
cd mobile/PearPasteMobile/android
JAVA_HOME=… ANDROID_HOME=… ./gradlew :app:assembleDebug
# => app/build/outputs/apk/debug/app-debug.apk  (~441 MB debug, 4 ABIs)
```

Verified: `BUILD SUCCESSFUL`; `lib/arm64-v8a/` contains the full Bare runtime
plus `libsodium-native.5.1.0.so`, `librocksdb-native.so`, `libudx-native.so`,
`libquickbit/rabin/crc/simdle-native.so`, `libbare-crypto.so` (45 `.so`). The
debug APK loads JS from Metro (`npm --prefix mobile/PearPasteMobile run start`)
at runtime.

### Genuinely out of scope (need hardware / accounts)

- **Run it**: `npm --prefix mobile/PearPasteMobile run android`
  (emulator/device) — needs a
  connected device or an AVD + a running Metro server. Not executed here (no
  device/emulator attached in the build environment).
- **Release / Play Store**: `./gradlew :app:assembleRelease` (or
  `bundleRelease` for an `.aab`) now fails closed unless release signing is
  configured with a private keystore. Generate a keystore with
  `keytool -genkeypair -v -keystore pearpaste-release.keystore -alias pearpaste
  -keyalg RSA -keysize 2048 -validity 10000`, keep it out of git, then provide
  these Gradle properties or environment variables:
  `PEARPASTE_ANDROID_KEYSTORE`, `PEARPASTE_ANDROID_KEYSTORE_PASSWORD`,
  `PEARPASTE_ANDROID_KEY_ALIAS`, and `PEARPASTE_ANDROID_KEY_PASSWORD`.
  The checked-in `debug.keystore` is accepted for debug builds only and is
  explicitly rejected for release signing.

---

## iOS (VERIFIED — builds, installs & launches on the Simulator)

Host: the same `mobile/PearPasteMobile/` (RN **0.81.4**, app name `PearPaste`,
`ios/` project present). Verified on Xcode 26.4.1 + iOS 26.4 Simulator
(iPhone 17): `npx react-native run-ios` → app installed and `Successfully
launched`; Metro bundles all 999 modules (App + the 3.5 MB platform Bare
bundle + screens + `rpc-commands.mjs`) with no resolve/redbox errors.

Procedure (from `mobile/PearPasteMobile/`):

```sh
# 1. Bundle the Pear-end (repo root) — CJS module Metro can import:
npm --prefix mobile/PearPasteMobile run bundle:bare
# 2. Host deps (RN 0.85 deep-dep peers require legacy-peer-deps):
npm install --legacy-peer-deps
# 3. Pods (CocoaPods needs a UTF-8 locale on system Ruby):
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 bundle exec pod install && cd ..
# 4. Build + run on Simulator (also starts Metro):
LANG=en_US.UTF-8 npx react-native run-ios --simulator="iPhone 17"
#    If Metro didn't auto-start: `npx react-native start` in another shell.
```

Non-obvious gotchas resolved (all encoded in the repo so the steps above just
work):

- **`bare-link` iOS addons (critical).** `ios/Podfile` has a `pre_install`
  hook (`pearpaste_link_bare_addons!`) that runs `bare-link <repoRoot> --host
  ios-arm64 --host ios-arm64-simulator --host ios-x64-simulator --out
  node_modules/react-native-bare-kit/ios/addons`. Mirrors the Android
  `pearpasteLinkBareAddons` gradle task — bare-kit's stock `link.mjs` is
  graph-rooted at the host and misses the repo-root Pear-end native deps
  (sodium/udx/rocksdb/quickbit/bare-crypto/…). Without it the app links but the
  worklet crashes at runtime. (29 iOS xcframeworks after linking.)
- **fmt vs Xcode 26 clang.** RN's vendored `fmt` uses `consteval` format-string
  checks that Xcode 26.4 clang rejects (`call to consteval function … is not a
  constant expression`). `ios/Podfile` `post_install` patches
  `Pods/fmt/include/fmt/base.h` (`FMT_CONSTEVAL` → `constexpr`; runtime
  equivalent) — fmt's `base.h` has no `#ifndef` guard so a `-D` define alone is
  ignored.
- **Duplicate `RNFS*` symbols.** Only `@dr.pogodin/react-native-fs` (new-arch
  fork) may be installed — the legacy `react-native-fs` must NOT be a dep, or
  both autolink and produce ~45 duplicate Objective-C symbols at link.
- **Metro outside-root sources.** `metro.config.js` sets
  `watchFolders:[repoRoot]`, `resolver.nodeModulesPaths` to the host's
  `node_modules`, adds `mjs` to `sourceExts` (for `rpc-commands.mjs`), and a
  `resolveRequest` stub mapping only missing optional pairing libs
  (`react-native-qrcode-svg`/`-svg`/`-camera-kit`) to an empty module. Installed
  QR/camera packages stay live; the pairing screen feature-detects and falls
  back to manual entry only when they are absent or permission is denied.
- The host `index.js` registers `../app/App` (the real source lives outside the
  generated project) under the `app.json` name `PearPaste`.
- **Release/device signing fails closed.** The app target now uses checked-in
  xcconfig wrappers at `ios/Config/PearPaste.Debug.xcconfig`,
  `ios/Config/PearPaste.Release.xcconfig`, and
  `ios/Config/PearPaste.Shared.xcconfig`. Debug keeps a non-secret development
  bundle identifier for simulator work; Release deliberately has no checked-in
  bundle identifier, Apple team, certificate, or provisioning profile. For a
  real device/TestFlight archive, copy `ios/Config/Signing.example.xcconfig` to
  `ios/Config/Signing.local.xcconfig` (ignored by `ios/.gitignore`) and replace
  the placeholders, or pass the same `PEARPASTE_*` values as `xcodebuild`
  build-setting overrides. The
  `PearPaste Validate Release Signing` Xcode phase rejects Release `iphoneos`
  builds if those values are missing or still placeholders. Automatic signing
  can leave `PEARPASTE_PROVISIONING_PROFILE_SPECIFIER` blank; manual signing
  must provide it.

Not done here: a real device / TestFlight build (needs an Apple Developer
signing cert + provisioning) and driving the on-device UI for an interactive
vault-create smoke. The worklet↔RN RPC path itself is the same code covered by
`mobile/test/worklet-rpc.test.js` (4/4) and the working desktop worker.

---

## Storage & lifecycle (spec §9.1, §9.4, §10)

- RN passes `RNFS.DocumentDirectoryPath` as `Bare.argv[0]`; the worklet creates
  the Corestore at `<docDir>/pearpaste-corestore`. Exactly one Hyperswarm + one
  Corestore (inside the single `createPearEnd`).
- App backgrounded → the worklet's Bare `suspend` hook emits `backgrounded`,
  dropping decrypted item plaintext while keeping sync warm. Worklet teardown
  drains the `LifecycleScope` before Corestore/Hyperswarm close.

## Mobile clipboard reality (spec §13 — stated honestly in-app)

- **iOS**: no background clipboard monitoring. Capture = paste into Paste,
  copy from Paste, or the share sheet. The Clips screen says this verbatim.
- **Android**: foreground capture while the app is open; background sync is
  **not promised**. The Clips screen says this verbatim.
- No invisible background clipboard sync is claimed on any mobile OS.
