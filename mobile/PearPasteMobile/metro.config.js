const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

// The real PearPaste mobile source lives OUTSIDE this generated host project:
//   ../app                  RN screens / lib
//   ../rpc-commands.mjs      shared RPC framing (also bundled into the worklet)
//   ../backend/app*.bundle.js bare-pack output (CJS modules exporting bundles)
// rpc-commands.mjs also imports ../../backend/rpc.js (pearpaste/backend).
// All RN/native deps resolve from THIS project's node_modules.
const projectRoot = __dirname;
const repoRoot = path.resolve(__dirname, '..', '..'); // pearpaste
// Watch ONLY the dirs we actually need. Watching the whole repo root makes
// Metro's file crawl drown in non-source trees (root node_modules, the
// ~441 MB android build output, ios/Pods, ios/build, .git, .planning) and the
// bundle hangs at "BUNDLE ./index.js 0% (0/1)". These two cover mobile/app,
// mobile/rpc-commands.mjs, mobile/backend/app*.bundle.js and pearpaste/backend.
const mobileDir = path.resolve(__dirname, '..'); // pearpaste/mobile
const backendDir = path.resolve(repoRoot, 'backend'); // pearpaste/backend

// Optional pairing UI libs are referenced via `try { require('x') } catch {}`
// (graceful degrade to manual short-code entry, spec §13). Metro resolves
// requires statically and would fail the build if they are absent, so map only
// missing optionals to an empty module. Installed native packages stay live.
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

// Exclude heavy native-build / VCS / planning trees from Metro's crawl so the
// bundle can actually complete. (Defensive even though watchFolders is narrow.)
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const R = esc(repoRoot);
const blockList = new RegExp(
  [
    `${R}/node_modules/.*`,
    `${R}/(\\.git|\\.planning|docs|test|pear-storage|artifacts)/.*`,
    `${R}/mobile/PearPasteMobile/(android|vendor)/.*`,
    `${R}/mobile/PearPasteMobile/ios/(Pods|build|.*\\.xcworkspace|.*\\.xcodeproj)/.*`,
  ].join('|'),
);

const config = {
  projectRoot,
  watchFolders: [mobileDir, backendDir],
  resolver: {
    nodeModulesPaths: [path.resolve(projectRoot, 'node_modules')],
    // rpc-commands.mjs is ESM with an .mjs extension.
    sourceExts: ['js', 'mjs', 'cjs', 'jsx', 'json', 'ts', 'tsx'],
    blockList,
    resolveRequest: (context, moduleName, platform) => {
      if (missingOptionalStubs.has(moduleName)) {
        return { type: 'sourceFile', filePath: emptyModule };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
