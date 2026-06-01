import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const barePack = resolve(repoRoot, 'mobile/PearPasteMobile/node_modules/.bin/bare-pack')
const entry = 'mobile/backend/worklet.mjs'

const bundles = [
  {
    out: 'mobile/backend/app.bundle.js',
    hosts: ['android-arm64', 'android-arm', 'android-ia32', 'android-x64', 'ios-arm64', 'ios-arm64-simulator']
  },
  {
    out: 'mobile/backend/app.android.bundle.js',
    hosts: ['android-arm64', 'android-arm', 'android-ia32', 'android-x64']
  },
  {
    out: 'mobile/backend/app.ios.bundle.js',
    hosts: ['ios-arm64', 'ios-arm64-simulator']
  }
]

for (const bundle of bundles) {
  const hostArgs = bundle.hosts.flatMap(host => ['--host', host])
  const args = ['--linked', ...hostArgs, '--out', bundle.out, entry]
  const result = spawnSync(barePack, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status || 1)
}
