import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('HiveRelay customer path uses npm latest defaults', async (t) => {
  const pkg = readJson('package.json')
  t.is(pkg.optionalDependencies['p2p-hiverelay'], 'latest')
  t.is(pkg.optionalDependencies['p2p-hiverelay-client'], 'latest')

  const relayService = fs.readFileSync(path.join(root, 'backend/relay-service.js'), 'utf8')
  const pinScript = fs.readFileSync(path.join(root, 'scripts/pin-on-hiverelay.js'), 'utf8')
  t.ok(relayService.includes("await import('p2p-hiverelay-client')"), 'runtime loads the split client lazily')
  t.ok(pinScript.includes("await import('p2p-hiverelay-client')"), 'release pin script loads the split client lazily')

  const client = await import('p2p-hiverelay-client')
  t.is(typeof client.HiveRelayClient, 'function')
})

function readJson (rel) {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'))
}
