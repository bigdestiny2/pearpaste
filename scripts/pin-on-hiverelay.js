#!/usr/bin/env node
// Paste — pin the app package / encrypted vault log on HiveRelay.
//
//   node scripts/pin-on-hiverelay.js --app <dir>       [--storage <path>] [--replicas N]
//   node scripts/pin-on-hiverelay.js --key  <hexKey>   [--storage <path>] [--replicas N]
//
// Two modes (spec §17 "pin app package on HiveRelay", §11):
//
//   --app <dir>   Publish a directory of app files to a Hyperdrive and request
//                 relay seeding. Used at release time to keep the Paste
//                 app package available over HiveRelay. App files are public
//                 distribution assets, NOT vault content.
//
//   --key <hex>   Seed an existing PUBLIC core/drive key (e.g. the already-
//                 encrypted vault operation log). The key is an identifier,
//                 never key material; the relay receives ciphertext only.
//
// This script creates its OWN Corestore/Hyperswarm (it is a standalone release
// tool, not the Pear-end — the "one swarm/one store" rule applies to the
// Pear-end process, §10/§22). It degrades cleanly if the optional client
// dependency is missing.

import fs from 'fs'
import path from 'path'
import os from 'os'

function parseArgs (argv) {
  const a = { app: null, key: null, storage: null, replicas: 5, durability: 1, timeout: 20000, json: false }
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]
    if (x === '--app') a.app = argv[++i]
    else if (x === '--key') a.key = argv[++i]
    else if (x === '--storage') a.storage = argv[++i]
    else if (x === '--replicas') a.replicas = parseInt(argv[++i], 10)
    else if (x === '--durability') a.durability = argv[++i]
    else if (x === '--timeout') a.timeout = parseInt(argv[++i], 10)
    else if (x === '--json') a.json = true
    else if (x === '-h' || x === '--help') a.help = true
  }
  return a
}

function usage () {
  process.stdout.write(
    'Usage:\n' +
    '  node scripts/pin-on-hiverelay.js --app <dir> [--replicas N] [--storage <path>]\n' +
    '  node scripts/pin-on-hiverelay.js --key <hexKey> [--replicas N] [--storage <path>]\n\n' +
    '  --app <dir>      publish + pin a directory of app files (release distribution)\n' +
    '  --key <hex>      seed an existing public core/drive key (encrypted vault log)\n' +
    '  --replicas N     target relay replicas (default 5)\n' +
    '  --durability D   0=standard, 1/archive=durable fleet (default 1)\n' +
    '  --storage <path> client storage dir (default: a temp dir)\n' +
    '  --timeout MS     seed wait timeout (default 20000)\n' +
    '  --json           machine-readable output\n')
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || (!args.app && !args.key)) {
    usage()
    process.exit(args.help ? 0 : 2)
  }
  if (args.app && args.key) {
    process.stderr.write('error: pass exactly one of --app or --key\n')
    process.exit(2)
  }

  let HiveRelayClient
  try {
    ;({ HiveRelayClient } = await import('p2p-hiverelay-client'))
  } catch (err) {
    process.stderr.write('p2p-hiverelay-client not available: ' +
      String((err && err.message) || err) + '\n' +
      'Install the optional dependency to pin on HiveRelay. ' +
      'The app remains usable local-first / direct-P2P without it (spec §11).\n')
    process.exit(4)
  }

  const storage = args.storage
    ? path.resolve(args.storage)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pearpaste-pin-'))

  const client = new HiveRelayClient(storage, {
    autoDiscover: true,
    maxRelays: 10
  })

  const out = { mode: args.app ? 'app' : 'key', storage }
  let exitCode = 0
  try {
    await client.start()

    if (args.app) {
      const dir = path.resolve(args.app)
      if (!fs.existsSync(dir)) {
        process.stderr.write('error: app dir not found: ' + dir + '\n')
        process.exit(2)
      }
      process.stdout.write('publishing app package from ' + dir + ' …\n')
      const drive = await client.publish(dir, {
        appId: 'pearpaste',
        seed: true,
        replicas: args.replicas,
        timeout: args.timeout
      })
      const keyHex = drive.key ? drive.key.toString('hex') : null
      await client.seed(keyHex, {
        replicas: args.replicas,
        durability: args.durability,
        timeout: args.timeout
      })
      const seedStatus = client.getSeedStatus(keyHex)
      const durable = client.getDurableStatus(keyHex)
      out.driveKey = keyHex
      out.acceptances = seedStatus ? seedStatus.acceptances : 0
      out.durable = durable.durable
      process.stdout.write('app drive key: ' + keyHex + '\n')
      process.stdout.write('relay acceptances: ' + out.acceptances + '/' + args.replicas + '\n')
      process.stdout.write('durable: ' + out.durable + '\n')
      if (out.acceptances === 0) {
        process.stderr.write('warning: no relay accepted the seed request (no relays reachable?)\n')
        exitCode = 5
      }
    } else {
      // Seed an existing PUBLIC key. Validate it looks like a 32-byte hex key.
      const keyHex = String(args.key).toLowerCase()
      if (!/^[0-9a-f]{64}$/.test(keyHex)) {
        process.stderr.write('error: --key must be 64 hex chars (a public core/drive key)\n')
        process.exit(2)
      }
      process.stdout.write('seeding existing key ' + keyHex.slice(0, 16) + '… (ciphertext only)\n')
      const acceptances = await client.seed(keyHex, {
        replicas: args.replicas,
        durability: args.durability,
        timeout: args.timeout,
        revocable: true
      })
      out.key = keyHex
      out.acceptances = Array.isArray(acceptances) ? acceptances.length : 0
      process.stdout.write('relay acceptances: ' + out.acceptances + '/' + args.replicas + '\n')
      if (out.acceptances === 0) {
        process.stderr.write('warning: no relay accepted the seed request\n')
        exitCode = 5
      }
    }
  } catch (err) {
    process.stderr.write('pin failed: ' + String((err && err.message) || err) + '\n')
    out.error = String((err && err.message) || err)
    exitCode = 1
  } finally {
    try { await client.destroy() } catch (_) {}
  }

  if (args.json) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  process.exit(exitCode)
}

main().catch((err) => {
  process.stderr.write('pin-on-hiverelay crashed: ' + ((err && err.stack) || err) + '\n')
  process.exit(3)
})
