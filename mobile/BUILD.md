# Paste Mobile - Expo Build & Run Guide

Status: **`mobile/pearpaste-expo/` is the canonical mobile app.** It renders the
shared React Native UI from `mobile/app/` and starts the shared Pear-end from
`mobile/backend/` in a Bare worklet via `react-native-bare-kit`.

The older `mobile/PearPasteMobile/` RN-CLI project remains in the tree as a
legacy/reference host. Do not use it as the release path unless the mobile
strategy changes again.

---

## What Ships

| Piece | Location | Notes |
|---|---|---|
| Expo host | `mobile/pearpaste-expo/` | The app users should build and run. |
| Shared mobile UI | `mobile/app/` | Screens and bridge client used by Expo. |
| Bare worklet source | `mobile/backend/worklet.mjs` | Imports the same `backend/index.js` Pear-end as desktop. |
| Committed worklet bundles | `mobile/backend/app.android.bundle.js`, `mobile/backend/app.ios.bundle.js` | Platform bundles consumed by Metro shims. |
| Platform shims | `mobile/backend/worklet-bundle.android.js`, `mobile/backend/worklet-bundle.ios.js` | Metro picks the matching bundle for the native platform. |

The legacy all-host bundle `mobile/backend/app.bundle.js` is not part of the
shipping path and remains ignored.

---

## Fast Checks Without A Phone

From the repo root:

```sh
npm run test:mobile
npm --prefix mobile/pearpaste-expo run bundle:bare:check
```

`test:mobile` boots a real `createPearEnd()` backend under Node and exercises the
transport-agnostic mobile RPC helper over an in-process pipe. It proves the
backend dispatcher, schema validation, lock gate, sealed rows, pairing invite
wire format, clip copy, and recoverable error frames.

`bundle:bare:check` regenerates the Android and iOS Bare worklet bundles into a
temporary directory and compares them byte-for-byte with the committed platform
bundles. It fails if `backend/rpc.js` or any imported backend/worklet source has
made the checked-in bundles stale.

---

## Install Dependencies

Run the root install first so `patch-package` applies the repo-root native
patches used by the shared Pear-end:

```sh
npm install
```

Then install the Expo host dependencies:

```sh
cd mobile/pearpaste-expo
npm install --legacy-peer-deps
```

The Expo host owns the pinned local `bare-pack` binary used by the bundler. The
shared script deliberately prefers:

```txt
mobile/pearpaste-expo/node_modules/.bin/bare-pack
```

---

## Worklet Bundle Guard

Regenerate the committed platform bundles from the repo root:

```sh
npm --prefix mobile/pearpaste-expo run bundle:bare
```

Check them without rewriting:

```sh
npm --prefix mobile/pearpaste-expo run bundle:bare:check
```

The generated files include a deterministic RPC-surface stamp derived from
`backend/rpc.js` (`COMMANDS`, `SCHEMAS`, and `UNLOCKED_NOT_REQUIRED`). Today the
surface includes `NETWORK_STATUS`; stale bundles from the old path did not.

The guard is wired into the canonical build path in three places:

| Guard | Where | Purpose |
|---|---|---|
| npm lifecycle | `mobile/pearpaste-expo/package.json` `preandroid` / `preios` | `npm run android` and `npm run ios` regenerate bundles first. |
| Expo config plugin | `mobile/pearpaste-expo/plugins/pearpaste-bare-worklet.js` | Re-applies native Gradle/Podfile hooks whenever Expo prebuilds native projects. |
| Native build hooks | generated Android `preBuild`, generated iOS Podfile script phases | Direct native builds regenerate the platform worklet and link Bare addons. |

The config plugin also runs `bare-link` against the repo root so
`sodium-native`, `rocksdb-native`, `udx-native`, `quickbit`/`rabin`/`crc`,
`simdle-native`, `bare-crypto`, and the other Pear-end native addons are linked
into `react-native-bare-kit`. Without that step the app can build but the
worklet crashes when it loads a native addon.

---

## Android

Prerequisites on macOS:

```sh
brew install openjdk@17
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"

export ANDROID_HOME="$HOME/Library/Android/sdk"
yes | sdkmanager --sdk_root="$ANDROID_HOME" --licenses
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platform-tools" "cmdline-tools;latest" \
  "platforms;android-35" "platforms;android-36" \
  "build-tools;35.0.0" "build-tools;36.0.0" \
  "ndk;27.1.12297006" "cmake;3.22.1"
```

Build and run through Expo:

```sh
cd mobile/pearpaste-expo
npm run android
```

If `android/` is absent, Expo prebuilds it and applies
`./plugins/pearpaste-bare-worklet`. If `android/` already exists, the npm
`preandroid` hook still regenerates the committed worklet bundles before
`expo run:android` invokes Gradle.

For a direct native build after prebuild:

```sh
cd mobile/pearpaste-expo/android
./gradlew :app:assembleDebug
```

The generated Gradle hook makes `preBuild` depend on:

```txt
pearpasteBundleBareWorklet
pearpasteLinkBareAddons
```

Release signing is not configured in this repo. Use a private keystore and keep
it out of git before producing Play Store artifacts.

---

## iOS

Prerequisites:

- Xcode with a simulator or an Apple Developer signing setup for device builds.
- CocoaPods available through the Ruby environment used by Expo/React Native.
- UTF-8 locale when running CocoaPods on system Ruby:

```sh
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
```

Build and run through Expo:

```sh
cd mobile/pearpaste-expo
npm run ios
```

If `ios/` is absent, Expo prebuilds it and applies
`./plugins/pearpaste-bare-worklet`. The generated Podfile runs the iOS worklet
bundle and Bare addon link steps during `pod install`, and the generated Xcode
script phases repeat them before compile so a backend/RPC change cannot ship
with a stale worklet.

For a direct native path after prebuild:

```sh
cd mobile/pearpaste-expo/ios
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install
open PearPaste.xcworkspace
```

Real device/TestFlight builds need a private Apple team, signing certificate,
and provisioning profile. Those secrets are intentionally not checked in.

---

## Native Project Regeneration

The Expo native projects are generated output and are ignored:

```txt
mobile/pearpaste-expo/android/
mobile/pearpaste-expo/ios/
```

Regenerate them from tracked config:

```sh
cd mobile/pearpaste-expo
npx expo prebuild --clean
```

After prebuild, confirm the worklet guard:

```sh
npm run bundle:bare:check
```

---

## Legacy RN-CLI Host

`mobile/PearPasteMobile/` still contains useful historical wiring for
`react-native-bare-kit`, Android signing guards, and iOS Podfile workarounds.
It is not the canonical mobile app because the current shared UI imports Expo
modules and the shipping build hooks now live under `mobile/pearpaste-expo/`.

Keep changes to the legacy host narrowly scoped unless there is an explicit
decision to revive it.

---

## Mobile Clipboard Reality

- **iOS:** no background clipboard monitoring. Capture means paste into Paste,
  copy from Paste, or use the share sheet.
- **Android:** foreground capture while the app is open; background clipboard
  sync is not promised.
- No invisible background clipboard sync is claimed on any mobile OS.
