// One-shot probe: does the running HiveRelay fleet expose the circuit
// channel (used by client.connectViaRelay) server-side?
//
// Background: pearpaste's pairing-rendezvous fallback in backend/relay-service.js
// calls client.connectViaRelay(target, relayPub) when DHT/UDX hole-punch
// fails. That call requires the connected relay to advertise the circuit
// protocol — getRelays() reports `hasCircuitProtocol` per relay. The
// 2026-05-19 fleet status doc covers seed/custody health but not whether
// circuit was enabled in v0.8.14. This script answers that.
//
// Run from the pearpaste repo root:
//   node scripts/probe-circuit.mjs
//
// Exits 0 in all cases; the report is the value.

import Hyperswarm from 'hyperswarm'
import Corestore from 'corestore'
import os from 'os'
import path from 'path'
import fs from 'fs'
import { HiveRelayClient } from 'p2p-hiverelay-client'

const WAIT_MS = Number(process.env.WAIT_MS || 20_000)
const tmpDir = path.join(os.tmpdir(), 'paste-probe-circuit-' + Date.now())
fs.mkdirSync(tmpDir, { recursive: true })

console.log('probe: scratch storage', tmpDir)

const swarm = new Hyperswarm()
const store = new Corestore(tmpDir)
await store.ready()

const client = new HiveRelayClient({ swarm, store, autoDiscover: true, maxRelays: 10 })
const seen = new Set()
client.on('relay-connected', (e) => {
  if (!e || !e.pubkey) return
  seen.add(e.pubkey)
  console.log('relay-connected', e.pubkey.slice(0, 16) + '…')
})
client.on('relay-disconnected', (e) => {
  if (e && e.pubkey) console.log('relay-disconnected', e.pubkey.slice(0, 16) + '…')
})

await client.start()

// Wait up to WAIT_MS for the first relay; keep waiting a bit longer after to
// catch more candidates.
const t0 = Date.now()
while (seen.size === 0 && Date.now() - t0 < WAIT_MS) {
  await new Promise(resolve => setTimeout(resolve, 500))
}
// Give 4 more seconds to collect any additional connections.
await new Promise(resolve => setTimeout(resolve, 4000))

console.log('\n=== probe result ===')
const relays = client.getRelays() || []
if (!relays.length) {
  console.log('NO RELAYS CONNECTED in ' + WAIT_MS + 'ms')
  console.log('That means this host can\'t reach the fleet at all — separate from the circuit-channel question.')
} else {
  let circuit = 0
  let seed = 0
  let service = 0
  for (const r of relays) {
    console.log(JSON.stringify({
      pubkey: r.pubkey.slice(0, 16) + '…',
      hasSeedProtocol: !!r.hasSeedProtocol,
      hasCircuitProtocol: !!r.hasCircuitProtocol,
      hasServiceProtocol: !!r.hasServiceProtocol,
      connectedAt: r.connectedAt
    }))
    if (r.hasCircuitProtocol) circuit++
    if (r.hasSeedProtocol) seed++
    if (r.hasServiceProtocol) service++
  }
  console.log('\nrelays: ' + relays.length)
  console.log('circuit-protocol exposed: ' + circuit + ' / ' + relays.length)
  console.log('seed-protocol exposed:    ' + seed + ' / ' + relays.length)
  console.log('service-protocol exposed: ' + service + ' / ' + relays.length)
  if (circuit === 0) {
    console.log('\nVERDICT: circuit channel is NOT advertised by any reached relay.')
    console.log('  → Our pair-circuit-fallback will return all-circuits-failed.')
    console.log('  → Upstream ask: enable circuit channel server-side on v0.8.14.')
  } else if (circuit < relays.length) {
    console.log('\nVERDICT: PARTIAL — some relays advertise circuit, some don\'t.')
    console.log('  → Fallback works if it lands on a circuit-capable relay; flaky otherwise.')
  } else {
    console.log('\nVERDICT: circuit channel is ADVERTISED on every reached relay.')
    console.log('  → Pair-circuit-fallback should work in production.')
  }
}

// Best-effort cleanup.
try { await client.destroy() } catch (_) {}
try { await swarm.destroy() } catch (_) {}
try { await store.close() } catch (_) {}
try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch (_) {}
process.exit(0)
