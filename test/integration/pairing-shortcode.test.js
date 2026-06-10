// Integration: short-code rendezvous over REAL Hyperswarm (spec §14, §10).
//
// REGRESSION (2026-06-10): the inviter's rendezvous responder filtered inbound
// connections by `info.topics` — but real server-side Hyperswarm connections
// are NEVER topic-tagged (PeerInfo.topics is only populated by the dialer's
// own lookups), so the invite was never served and every cross-device
// short-code lookup timed out with SHORTCODE_NOT_FOUND. The in-memory test
// swarm fabricated `info.topics` on both sides, masking the bug. This test
// drives the full lookup over a real @hyperswarm/testnet DHT so the
// server-side empty-topics semantics are exercised for real:
//   joiner  -> dials shortCodeRendezvousTopic, sends {v:1, want, topic}
//   inviter -> sees a topic-less conn, validates the request, serves the
//              invite as {v:1, invite}
// The companion firewall behavior (lookup conns stay RAW during the window —
// no protomux credential frames poisoning the JSON exchange) is exercised by
// the same flow, since both ends boot the full Pear-end with the replication
// firewall attached.
//
// Run: npx brittle test/integration/pairing-shortcode.test.js

import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import Hyperswarm from 'hyperswarm'
import createTestnet from '@hyperswarm/testnet'
import { createPearEnd } from '../../backend/index.js'

function tmp (tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pp-shortcode-' + tag + '-'))
}

test('short-code lookup resolves the invite over a real DHT (server-side conns carry no topics)', { timeout: 120000 }, async (t) => {
  const testnet = await createTestnet(3)
  const dirA = tmp('inviter')
  const dirB = tmp('joiner')

  const A = await createPearEnd({
    storagePath: dirA,
    relayClientFactory: false,
    swarm: new Hyperswarm({ bootstrap: testnet.bootstrap })
  })
  const B = await createPearEnd({
    storagePath: dirB,
    relayClientFactory: false,
    swarm: new Hyperswarm({ bootstrap: testnet.bootstrap })
  })
  t.teardown(async () => {
    try { await A.close() } catch (_) {}
    try { await B.close() } catch (_) {}
    try { fs.rmSync(dirA, { recursive: true, force: true }) } catch (_) {}
    try { fs.rmSync(dirB, { recursive: true, force: true }) } catch (_) {}
    try { await testnet.destroy() } catch (_) {}
  })

  // Inviter: unlocked vault + pending invite announcing the rendezvous topic.
  await A.call('CREATE_VAULT', { label: 'inviter', platform: 'test', passphrase: 'pw' })
  const inv = await A.call('PAIR_CREATE_INVITE', { ttlMs: 110000 })
  t.ok(inv && typeof inv.invite === 'string' && inv.invite.length > 0, 'inviter produced an invite payload')
  t.ok(inv && typeof inv.shortCode === 'string' && /^[0-9A-F]{4}-[0-9A-F]{4}$/.test(inv.shortCode), 'inviter produced a displayable short code')

  // Joiner: locked, fresh device — resolves the code over the DHT alone.
  const res = await B.call('PAIR_LOOKUP_SHORTCODE', { shortCode: inv.shortCode, timeoutMs: 90000 })
  t.ok(res && typeof res.invite === 'string', 'lookup returned an invite payload')
  t.is(res.invite, inv.invite, 'resolved invite is byte-identical to the inviter\'s payload')
})
