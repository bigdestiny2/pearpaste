// Paste — Electron Forge configuration (pear-runtime + Forge path).
// Ported from holepunchto/hello-pear-electron; ESM because the repo is
// `"type": "module"` (Forge on Node ≥22 loads ESM configs).
//
// Replaces the legacy custom packagers (scripts/build-{windows,macos}.mjs,
// scripts/package-linux.mjs) once the Phase 5 cutover lands — until then both
// paths coexist (docs/PEAR_RUNTIME_MIGRATION.md).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import plink from 'pear-link'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name

function getWindowsKitVersion () {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true,
  // Paste-specific addition to the boilerplate config: the repo carries large
  // non-app trees (mobile/ RN project, dist/ legacy build outputs, .pear-stage
  // mirror, docs/tests). Without these ignores the packaged .app swept in
  // ~18 GB. Runtime needs ONLY: index.js, electron/, workers/, backend/, ui/,
  // index.html, assets/, build/, pear.json + pruned production node_modules.
  ignore: [
    /^\/(out|dist|mobile|website|docs|test|scripts|flatpak|patches|coverage|artifacts)(\/|$)/,
    /^\/\.(git|github|claude|planning|pear-stage|vscode|idea)(\/|$)/,
    /^\/\.(gitignore|gitattributes|npmrc|prettierrc|nvmrc|DS_Store)$/,
    /^\/\.env(\.|$)/,
    /^\/[^/]*\.(log|md|txt)$/
  ]
}

// macOS signing/notarization — fail open in dev (unsigned), exactly like the
// boilerplate: set MAC_CODESIGN_IDENTITY (+ KEYCHAIN_PROFILE) to sign.
if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      tool: 'notarytool',
      keychainProfile: process.env.KEYCHAIN_PROFILE
    }
  }
}

export default {
  packagerConfig,

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
        windowsKitVersion: getWindowsKitVersion(),
        ...(process.env.WINDOWS_SIGN_HOOK
          ? {
              windowsSignOptions: {
                hookModulePath: process.env.WINDOWS_SIGN_HOOK
              }
            }
          : {})
      }
    },
    {
      name: 'pear-electron-forge-maker-appimage',
      platforms: ['linux'],
      config: {
        icons: [
          { file: 'build/icon/icon-16x16.png', size: 16 },
          { file: 'build/icon/icon-32x32.png', size: 32 },
          { file: 'build/icon/icon-64x64.png', size: 64 },
          { file: 'build/icon/icon-128x128.png', size: 128 },
          { file: 'build/icon/icon-256x256.png', size: 256 }
        ]
      }
    },
    {
      name: 'pear-electron-forge-maker-flatpak',
      platforms: ['linux'],
      config: {
        appId: 'global.paste.Paste',
        icon: `${packagerConfig.icon}.png`,
        metainfo: 'build/metainfo.xml',
        entrypoint: 'build/entrypoint.sh',
        comment: 'Private, end-to-end encrypted note + clipboard sync over P2P',
        categories: ['Utility']
      }
    },
    {
      name: 'pear-electron-forge-maker-snap',
      platforms: ['linux'],
      config: {
        snapcraftYamlPath: 'build/snapcraft.yaml',
        summary: 'Private, end-to-end encrypted note + clipboard sync over P2P',
        description:
          'Personal, end-to-end encrypted note and clipboard sync over the Pear / Holepunch P2P stack. No accounts, no servers — your devices hold the keys.',
        contact: 'defidon@protonmail.com',
        license: 'Apache-2.0',
        issues: 'https://github.com/bigdestiny2/pearpaste/issues',
        website: 'https://github.com/bigdestiny2/pearpaste',
        icon: `${packagerConfig.icon}.png`
      }
    }
  ],

  hooks: {
    readPackageJson: async (forgeConfig, packageJson) => {
      if (process.env.UPGRADE_KEY) {
        packageJson.upgrade = process.env.UPGRADE_KEY
      }

      try {
        plink.parse(packageJson.upgrade)
      } catch {
        throw new Error('Use `pear touch` to get a valid upgrade key for package.json#upgrade')
      }

      return packageJson
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0')
      const xml = fs.readFileSync(manifest, 'utf-8')
      fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          fs.mkdirSync(path.dirname(artifact), { recursive: true })
          fs.copyFileSync(dest, artifact)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
    }
  },

  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {}
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ]
}
