import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('self-hosted packaging metadata is aligned for Umbrel and StartOS', (t) => {
  const config = readJson('release/container-image.json')
  const rootPackage = readJson('package.json')
  const startOsPackage = readJson('platforms/startos/package.json')
  t.is(config.webPort, 3000, 'container web service keeps the internal HTTP port')
  t.ok(config.umbrelPort !== config.webPort, 'Umbrel launch port is not the internal service port')
  t.ok(config.startOsPort !== config.webPort, 'StartOS preferred launch port is not the internal service port')

  const officialManifest = read('platforms/umbrel/pearpaste/umbrel-app.yml')
  const officialCompose = read('platforms/umbrel/pearpaste/docker-compose.yml')
  const communityManifest = read('platforms/umbrel/hiverelay-pearpaste/umbrel-app.yml')
  const communityCompose = read('platforms/umbrel/hiverelay-pearpaste/docker-compose.yml')

  t.ok(officialManifest.includes('id: pearpaste'), 'official Umbrel package keeps the canonical app id')
  t.ok(officialManifest.includes(`port: ${config.umbrelPort}`), 'official Umbrel package uses the launch port')
  t.ok(communityManifest.includes('id: hiverelay-pearpaste'), 'community package uses the HiveRelay store-prefixed app id')
  t.ok(communityManifest.includes(`port: ${config.umbrelPort}`), 'community package uses the launch port')
  t.ok(communityManifest.includes('blindspark-umbrel-store@main/hiverelay-pearpaste/icon.svg'), 'community package points at the shared store icon path')

  assertUmbrelCompose(t, officialCompose, 'pearpaste_web_1')
  assertUmbrelCompose(t, communityCompose, 'hiverelay-pearpaste_web_1')
  t.ok(exists('platforms/umbrel/pearpaste/data/.gitkeep'), 'official app data scaffold exists')
  t.ok(exists('platforms/umbrel/hiverelay-pearpaste/data/.gitkeep'), 'community app data scaffold exists')

  const startOsUtils = read('platforms/startos/startos/utils.ts')
  const startOsMain = read('platforms/startos/startos/main.ts')
  const startOsInterfaces = read('platforms/startos/startos/interfaces.ts')
  const startOsGitignore = read('platforms/startos/.gitignore')
  const startOsVerifier = read('platforms/startos/scripts/verify-package.mjs')
  const startOsArtifactVerifier = read('platforms/startos/scripts/verify-artifacts.mjs')
  t.ok(startOsUtils.includes('export const webPort'), 'StartOS exports the internal web port')
  t.ok(startOsUtils.includes('export const startOsPort'), 'StartOS exports the preferred external port')
  t.ok(startOsMain.includes('PEARPASTE_PORT: String(webPort)'), 'StartOS daemon listens on the internal web port')
  t.ok(startOsInterfaces.includes('preferredExternalPort: startOsPort'), 'StartOS interface uses the preferred external port')
  t.ok(startOsGitignore.includes('javascript/'), 'StartOS generated javascript bundle is ignored')
  t.ok(startOsGitignore.includes('*.s9pk'), 'StartOS package archives are ignored')
  t.is(rootPackage.scripts['startos:verify'], 'npm run --prefix platforms/startos verify', 'root script runs the StartOS package verifier')
  t.is(rootPackage.scripts['startos:verify-artifacts'], 'npm run --prefix platforms/startos verify:artifacts', 'root script runs the StartOS artifact verifier')
  t.is(rootPackage.scripts['container:sync-store'], 'node scripts/container-release.mjs sync-store', 'root script syncs the community-store package')
  t.is(rootPackage.scripts['container:check-store'], 'node scripts/container-release.mjs check-store', 'root script checks the community-store package')
  t.is(startOsPackage.scripts.verify, 'npm run build && node scripts/verify-package.mjs', 'StartOS package exposes a build-and-verify script')
  t.is(startOsPackage.scripts['verify:artifacts'], 'node scripts/verify-artifacts.mjs', 'StartOS package exposes an artifact verifier')
  t.ok(startOsVerifier.includes('manifest.images.pearpaste'), 'StartOS verifier checks the compiled manifest image')
  t.ok(startOsVerifier.includes('imageConfig.startOsArches'), 'StartOS verifier checks configured arches')
  t.ok(startOsVerifier.includes('process.env.PEARPASTE_IMAGE'), 'StartOS verifier honors image override builds')
  t.ok(startOsArtifactVerifier.includes('sha256'), 'StartOS artifact verifier reports checksums')
  t.ok(startOsArtifactVerifier.includes('HOME: tempHome'), 'StartOS artifact verifier isolates start-cli HOME')
  t.ok(startOsArtifactVerifier.includes('hardwareRequirements'), 'StartOS artifact verifier checks package arch requirements')

  const dockerfile = read('Dockerfile')
  const normalizer = read('scripts/prepare-container-package.mjs')
  const releaseHelper = read('scripts/container-release.mjs')
  t.ok(exists('scripts/prepare-container-package.mjs'), 'container package normalizer exists')
  t.ok(dockerfile.includes('node scripts/prepare-container-package.mjs'), 'container build normalizes local optional deps before npm ci')
  t.ok(dockerfile.includes('npm ci --omit=optional'), 'container build omits workspace-only optional dependencies')
  t.ok(dockerfile.includes('npm prune --omit=dev --omit=optional'), 'container image is pruned for production without optional deps')
  t.ok(dockerfile.includes('USER node'), 'container runs as uid 1000 for app-data compatibility')
  t.ok(dockerfile.includes('HOME=/data'), 'container home lives on the persistent data volume')
  t.ok(normalizer.includes("pkgPath.slice('node_modules/'.length)"), 'normalizer derives names from package-lock symlink rows')
  t.ok(normalizer.includes("pkgPath.startsWith('..')"), 'normalizer removes top-level package-lock file links outside the build context')
  t.ok(releaseHelper.includes('syncCommunityStore'), 'release helper can sync the community-store package')
  t.ok(releaseHelper.includes('checkCommunityStore'), 'release helper can check the community-store package')
  t.ok(releaseHelper.includes('umbrel-app-store.yml'), 'release helper validates the target Umbrel store before mirroring')
})

function assertUmbrelCompose (t, compose, appHost) {
  t.ok(compose.includes(`APP_HOST: ${appHost}`), `${appHost} is the app_proxy target`)
  t.ok(compose.includes('APP_PORT: $' + '{APP_PEARPASTE_WEB_PORT}'), `${appHost} proxies the internal web port`)
  t.ok(compose.includes('image: $' + '{APP_PEARPASTE_IMAGE}'), `${appHost} consumes generated image ref`)
  t.ok(compose.includes('user: "1000:1000"'), `${appHost} runs as Umbrel app-data uid/gid`)
  t.ok(compose.includes('- $' + '{APP_DATA_DIR}/data:/data'), `${appHost} persists /data`)
  t.absent(/^\s*ports:\s*$/m.test(compose), `${appHost} does not publish raw host ports`)
}

function read (rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8')
}

function readJson (rel) {
  return JSON.parse(read(rel))
}

function exists (rel) {
  return fs.existsSync(path.join(root, rel))
}
