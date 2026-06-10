# PearPaste Expo Mobile

Canonical PearPaste mobile host. It renders the shared React Native app from
`mobile/app/` and starts the shared Pear-end from `mobile/backend/` in a Bare
worklet via `react-native-bare-kit`.

## Usage

```sh
npm install --legacy-peer-deps
npm run bundle:bare
```

`npm run android` and `npm run ios` both run `bundle:bare` first, so the
platform worklet bundles stay aligned with the current backend RPC surface.
Use `npm run bundle:bare:check` in CI to fail if the committed bundles are
stale.

### iOS

```sh
npm run ios
```

### Android

```sh
npm run android
```

## License

Apache-2.0
