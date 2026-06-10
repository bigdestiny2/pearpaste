const { createRunOncePlugin, withAppBuildGradle, withPodfile } = require('@expo/config-plugins')

const pluginPackage = require('../package.json')

const ANDROID_START = '// <pearpaste-bare-worklet>'
const ANDROID_END = '// </pearpaste-bare-worklet>'
const POD_HELPERS_START = '# <pearpaste-bare-worklet-helpers>'
const POD_HELPERS_END = '# </pearpaste-bare-worklet-helpers>'
const POD_PHASES_START = '  # <pearpaste-bare-worklet-phases>'
const POD_PHASES_END = '  # </pearpaste-bare-worklet-phases>'

function withPearPasteBareWorklet (config) {
  config = withAppBuildGradle(config, (mod) => {
    mod.modResults.contents = upsertBlock(
      mod.modResults.contents,
      ANDROID_START,
      ANDROID_END,
      androidBlock()
    )
    return mod
  })

  config = withPodfile(config, (mod) => {
    let contents = upsertPodHelpers(mod.modResults.contents)
    contents = upsertPodPhases(contents)
    mod.modResults.contents = contents
    return mod
  })

  return config
}

function upsertBlock (contents, start, end, block) {
  const re = new RegExp(`${escapeRegExp(start)}[\\s\\S]*?${escapeRegExp(end)}`)
  if (re.test(contents)) return contents.replace(re, block)
  return `${contents.trimEnd()}\n\n${block}\n`
}

function upsertPodHelpers (contents) {
  const block = podHelpersBlock()
  const re = new RegExp(`${escapeRegExp(POD_HELPERS_START)}[\\s\\S]*?${escapeRegExp(POD_HELPERS_END)}`)
  if (re.test(contents)) return contents.replace(re, block)
  const needle = 'prepare_react_native_project!\n'
  if (contents.includes(needle)) return contents.replace(needle, `${needle}\n${block}\n`)
  return `${block}\n\n${contents}`
}

function upsertPodPhases (contents) {
  const block = podPhasesBlock()
  const re = new RegExp(`${escapeRegExp(POD_PHASES_START)}[\\s\\S]*?${escapeRegExp(POD_PHASES_END)}`)
  if (re.test(contents)) return contents.replace(re, block)
  const needle = '\n  post_install do |installer|'
  if (contents.includes(needle)) return contents.replace(needle, `\n${block}\n${needle}`)
  return contents.replace(/\nend\s*$/, `\n${block}\nend\n`)
}

function androidBlock () {
  return `${ANDROID_START}
// PearPaste: regenerate the Bare worklet bundle and link the repo-root native
// addons into react-native-bare-kit before every native Android build. The
// shared worklet imports ../../backend/rpc.js, so this keeps the shipped bundle
// aligned with the current backend RPC surface.
def ppRepoRoot = rootProject.projectDir.parentFile.parentFile.parentFile // android -> pearpaste-expo -> mobile -> repo
def ppBareKitAddons = new File(rootProject.projectDir, "../node_modules/react-native-bare-kit/android/src/main/addons")
def ppBareLink = new File(rootProject.projectDir, "../node_modules/.bin/bare-link")
def ppBarePack = new File(rootProject.projectDir, "../node_modules/.bin/bare-pack")
def ppBundleBareScript = new File(ppRepoRoot, "mobile/scripts/bundle-bare.mjs")
def ppNode = System.getenv("NODE_BINARY") ?: "node"

tasks.register("pearpasteBundleBareWorklet", Exec) {
    description = "Bundle the PearPaste Bare worklet with the Expo host's local bare-pack binary"
    workingDir ppRepoRoot
    doFirst {
        if (!ppBarePack.exists()) {
            throw new GradleException("bare-pack not found at \${ppBarePack}. Run npm install --legacy-peer-deps in mobile/pearpaste-expo first.")
        }
        if (!ppBundleBareScript.exists()) {
            throw new GradleException("PearPaste Bare worklet bundler not found at \${ppBundleBareScript}.")
        }
    }
    // Always run: backend/rpc.js and native addon graph changes live outside
    // Gradle's normal project inputs.
    commandLine ppNode, ppBundleBareScript.absolutePath, "--platform", "android"
}

tasks.register("pearpasteLinkBareAddons", Exec) {
    description = "Link PearPaste Pear-end Bare native addons (repo root) into react-native-bare-kit"
    workingDir ppRepoRoot
    doFirst {
        if (!ppBareLink.exists()) {
            throw new GradleException("bare-link not found at \${ppBareLink}. Run npm install --legacy-peer-deps in mobile/pearpaste-expo first.")
        }
    }
    commandLine ppBareLink.absolutePath, ".",
        "--host", "android-arm64",
        "--host", "android-arm",
        "--host", "android-ia32",
        "--host", "android-x64",
        "--out", ppBareKitAddons.absolutePath
}

preBuild.dependsOn "pearpasteBundleBareWorklet", "pearpasteLinkBareAddons"
${ANDROID_END}`
}

function podHelpersBlock () {
  return `${POD_HELPERS_START}
PEARPASTE_IOS_BARE_HOSTS = %w[
  ios-arm64
  ios-arm64-simulator
  ios-x64-simulator
].freeze

def pearpaste_repo_root
  File.expand_path('../../..', __dir__)
end

def pearpaste_node_binary
  node_binary = ENV['NODE_BINARY'].to_s
  node_binary.empty? ? 'node' : node_binary
end

def pearpaste_bundle_bare_worklet!
  script = File.join(pearpaste_repo_root, 'mobile/scripts/bundle-bare.mjs')
  unless File.exist?(script)
    raise "PearPaste Bare worklet bundler not found at #{script}"
  end
  Pod::UI.puts "[PearPaste] Bundling iOS Bare worklet from #{pearpaste_repo_root}".green
  Pod::Executable.execute_command(pearpaste_node_binary, [script, '--platform', 'ios'])
end

def pearpaste_link_bare_addons!
  repo_root = pearpaste_repo_root
  bare_link = File.expand_path('../node_modules/.bin/bare-link', __dir__)
  addons_dir = File.expand_path('../node_modules/react-native-bare-kit/ios/addons', __dir__)
  unless File.executable?(bare_link)
    raise "bare-link not found at #{bare_link}; run npm install --legacy-peer-deps in mobile/pearpaste-expo first"
  end
  Pod::UI.puts "[PearPaste] Linking Pear-end Bare iOS addons from #{repo_root}".green
  Pod::Executable.execute_command(pearpaste_node_binary, [
    bare_link,
    repo_root,
    *PEARPASTE_IOS_BARE_HOSTS.flat_map { |host| ['--host', host] },
    '--out', addons_dir
  ])
end

pre_install do |_installer|
  pearpaste_bundle_bare_worklet!
  pearpaste_link_bare_addons!
end
${POD_HELPERS_END}`
}

function podPhasesBlock () {
  return `${POD_PHASES_START}
  script_phase :name => 'PearPaste Bundle Bare Worklet (iOS)',
    :execution_position => :before_compile,
    :script => <<-SH
      set -e

      REPO_ROOT="$SRCROOT/../../.."
      BUNDLE_SCRIPT="$REPO_ROOT/mobile/scripts/bundle-bare.mjs"
      NODE="\${NODE_BINARY:-}"

      if [ -z "$NODE" ]; then
        NODE="$(command -v node || true)"
      fi
      if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
        echo "node not found; set NODE_BINARY or add node to PATH" >&2
        exit 1
      fi
      if [ ! -f "$BUNDLE_SCRIPT" ]; then
        echo "PearPaste Bare worklet bundler not found at $BUNDLE_SCRIPT" >&2
        exit 1
      fi

      cd "$REPO_ROOT"
      "$NODE" "$BUNDLE_SCRIPT" --platform ios
    SH

  script_phase :name => 'PearPaste Link Bare Addons (repo root)',
    :execution_position => :before_compile,
    :script => <<-SH
      set -e

      REPO_ROOT="$SRCROOT/../../.."
      BK_ADDONS="$SRCROOT/../node_modules/react-native-bare-kit/ios/addons"
      BARE_LINK="$SRCROOT/../node_modules/.bin/bare-link"
      NODE="\${NODE_BINARY:-}"

      if [ -z "$NODE" ]; then
        NODE="$(command -v node || true)"
      fi
      if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
        echo "node not found; set NODE_BINARY or add node to PATH" >&2
        exit 1
      fi
      if [ ! -x "$BARE_LINK" ]; then
        echo "bare-link not found at $BARE_LINK; run npm install --legacy-peer-deps in mobile/pearpaste-expo first" >&2
        exit 1
      fi

      cd "$REPO_ROOT"
      "$NODE" "$BARE_LINK" . --host ios-arm64 --host ios-arm64-simulator --host ios-x64-simulator --out "$BK_ADDONS"
    SH
${POD_PHASES_END}`
}

function escapeRegExp (value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = createRunOncePlugin(
  withPearPasteBareWorklet,
  'pearpaste-bare-worklet',
  pluginPackage.version || '1.0.0'
)
