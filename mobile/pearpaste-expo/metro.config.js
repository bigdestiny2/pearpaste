// Expo Metro config + PearPaste shared-source wiring.
//
// The PearPaste app source lives OUTSIDE this Expo host:
//   ../app                   RN screens / lib (mobile/app)
//   ../rpc-commands.mjs       shared RPC framing (also bundled into the worklet)
//   ../backend/app*.bundle.js  bare-pack output (CJS modules exporting bundles)
//   ../../backend/*           shared Pear-end source imported by rpc-commands.mjs
// Watch only mobile/ + repo backend/ (NOT the whole repo — watching it makes
// Metro drown in node_modules / native build trees and hang at 0%).
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(__dirname, '..', '..'); // pearpaste
const mobileDir = path.resolve(__dirname, '..'); // pearpaste/mobile
const backendDir = path.resolve(repoRoot, 'backend'); // pearpaste/backend

// Optional pairing UI libs are referenced via `try { require('x') } catch {}`
// (graceful degrade to manual entry, spec §13). Metro resolves requires
// statically; map only MISSING optionals to an empty module.
const OPTIONAL_STUBS = new Set([
  'react-native-qrcode-svg',
  'react-native-svg',
  'react-native-camera-kit',
]);
const emptyModule = path.resolve(__dirname, 'metro.empty.js');
const missingOptionalStubs = new Set(
  [...OPTIONAL_STUBS].filter((name) => {
    try {
      require.resolve(name, { paths: [projectRoot] });
      return false;
    } catch (_) {
      return true;
    }
  }),
);

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const R = esc(repoRoot);
const blockList = [
  new RegExp(`${R}/node_modules/.*`),
  new RegExp(`${R}/(\\.git|\\.planning|docs|test|pear-storage|artifacts)/.*`),
  new RegExp(`${R}/mobile/PearPasteMobile/.*`),
  new RegExp(`${R}/mobile/pearpaste-expo/(android|ios|\\.expo)/.*`),
];

const config = getDefaultConfig(projectRoot);
config.watchFolders = [mobileDir, backendDir];
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, 'node_modules')];
config.resolver.sourceExts = [...new Set([...config.resolver.sourceExts, 'mjs', 'cjs'])];
config.resolver.blockList = blockList;
const _origResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (missingOptionalStubs.has(moduleName)) {
    return { type: 'sourceFile', filePath: emptyModule };
  }
  return _origResolveRequest
    ? _origResolveRequest(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
